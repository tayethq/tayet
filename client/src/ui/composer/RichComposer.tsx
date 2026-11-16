import { useEffect, useId, useRef, useState, type ChangeEvent } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import { Extension, type Editor } from '@tiptap/core'
import { Plugin, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Placeholder } from '@tiptap/extensions'
import Mention from '@tiptap/extension-mention'
import type { SuggestionKeyDownProps, SuggestionOptions, SuggestionProps } from '@tiptap/suggestion'
import type { AgentColor, AgentCommand, User, UserId } from '@tayet/client'
import { PaperPlane, List, Plus, At, Link } from '../icons'
import { Avatar, Dialog, Field, Button } from '../primitives'
import { initialsOf } from '../author'
import { richExtensions } from './rich-schema'
import { editorToComposeResult } from './doc-to-rich'
import type { ComposeResult } from '../compose'
import { isSafeHref } from './safe-href'
import { t, GLYPH } from '../i18n'
import { AgentAvatar, agentColorOf } from '../components/AgentAvatar'

// Cap on the rendered candidate rows — the picker is a quick-pick, not a roster browser (mirrors the
// textarea Composer's MENTION_LIMIT).
const MENTION_LIMIT = 8

// A picked candidate: product vocabulary (displayName) plus the opaque UserId that rides the node
// attr, never the text nor the DOM (P1).
// `agent`: the agent's colour when the candidate is an agent (ADR-086) — the picker shows its avatar.
// Never an editor attribute: the command receives only id and label.
type MentionItem = { kind: 'mention'; id: UserId; label: string; agent?: AgentColor }
// ADR-093 (Proposto), workspace.md §21.1 item 3: one command row — the command, its description, and the
// agent that owns it (name + colour, from the conversation's members). `agent` is opaque and rides only the
// node attr once picked, never the DOM.
type CommandItem = {
  kind: 'command'
  agent: UserId
  name: string
  description: string
  hint?: string
  agentName: string
  agentColor: AgentColor
}
type SuggestItem = MentionItem | CommandItem
// The command the composer hands to onSend with the body (ADR-093 dec. 7): data, never parsed from text.
export type ComposerCommand = { agent: UserId; name: string }
// The attrs of the mention node (all model-only, never in the DOM). `command`/`hint` set = the command chip
// (§21.1 item 7): `id` is then the agent and `label` the agent's name.
type MentionAttrs = { id: UserId; label: string; command?: string; hint?: string }
// The popup state mirrored from the imperative suggestion plugins into React (workspace.md §21.1 item 1: one
// popup, two contents). null = closed.
type SuggestState = {
  mode: 'commands' | 'mention'
  items: SuggestItem[]
  command: (attrs: MentionAttrs) => void
  index: number
}

// Menção como nó atômico (ADR-051, PLANO-COMPOSER PR-3). O nó vive LOCAL à ilha, não em
// richExtensions (o allowlist do schema fica um node/mark set puro — a menção é acoplada com o
// picker, que é view/React, não parte do RichDoc allowlist).
//
// P1 (ADR-051 §3): o UserId opaco vive SÓ no attr do nó (modelo do doc, nunca no DOM — preserva
// m.mentions.user_ids no send). O default do TipTap grava data-id/data-label no DOM; sobrescrevemos
// os DOIS attrs pra não emitir atributo DOM algum, e o renderHTML do nó produz só o label. renderText
// dá "@label" (casa o getText do caminho textarea, cujo texto inserido é "@displayName").
//
// ADR-093 (Proposto), PLANO-AGENTES §0.3.24 item 3: o chip do comando é este mesmo nó com `command` (o nome,
// sem a barra) e `hint` (a dica do manifesto) — atributos só do modelo, como id/label. Renderiza "/nome" e
// achata em "/nome" no texto e no RichDoc; collectMentions não o conta como menção.
const TayetMention = Mention.extend({
  addAttributes() {
    return {
      id: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
      label: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
      command: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
      hint: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
    }
  },
}).configure({
  renderHTML: ({ node }) =>
    node.attrs.command
      ? ['span', { class: 'mention mention--command' }, `/${node.attrs.command}`]
      : ['span', { class: 'mention' }, `@${node.attrs.label ?? ''}`],
  renderText: ({ node }) => (node.attrs.command ? `/${node.attrs.command}` : `@${node.attrs.label ?? ''}`),
  // The `suggestion` (member picker) is layered in per-component below — it closes over the live
  // `users` prop and the React picker state, so it cannot be a module-level constant.
})

// Percorre o doc juntando os UserId opacos dos nós de menção, dedupados. Alimenta o mentions do
// onSend — a única saída do UserId (nunca via texto nem DOM).
function collectMentions(editor: Editor): UserId[] {
  const ids = new Set<UserId>()
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'mention' && node.attrs.id && !node.attrs.command) ids.add(node.attrs.id as UserId)
  })
  return [...ids]
}

// The command chip, when the document starts with one (§21.1 item 7: one per message, only at the start).
function chipOf(doc: PMNode): PMNode | undefined {
  const first = doc.firstChild
  const chip = first?.type.name === 'paragraph' ? first.firstChild : null
  return chip && chip.type.name === 'mention' && chip.attrs.command ? chip : undefined
}

function commandOf(editor: Editor): ComposerCommand | undefined {
  const chip = chipOf(editor.state.doc)
  return chip ? { agent: chip.attrs.id as UserId, name: chip.attrs.command as string } : undefined
}

// §21.1 item 7: with nothing but blanks after the chip, the field hints "{dica} · para {agente}" (or "para
// {agente}"). A decoration of its own — the live Placeholder only decorates an empty document — drawn by the
// same visual rule (muted, one line, ellipsis) through a data attribute on the paragraph.
function commandHint(doc: PMNode): DecorationSet | null {
  const chip = chipOf(doc)
  const first = doc.firstChild
  if (!chip || !first || doc.childCount !== 1) return null
  if (first.textBetween(chip.nodeSize, first.content.size).trim() !== '') return null
  const agent = String(chip.attrs.label ?? '')
  const hint = chip.attrs.hint ? String(chip.attrs.hint) : ''
  const text = hint ? t('composer.commandHintFor', { hint, agent }) : t('composer.commandFor', { agent })
  return DecorationSet.create(doc, [
    Decoration.node(0, first.nodeSize, { class: 'composer__command-hinted', 'data-command-hint': text }),
  ])
}

// Review round (12/Nov, workspace.md §21.5 item 9): the chip is always followed by a blank. When what
// comes right after it — typed, pasted, or left there by deleting the space — is not a blank, a space goes
// in between; without it the text would not start with "/nome" apart from the arguments (ADR-093 dec. 7).
// A caret sitting right after the chip stays there, so the next Backspace still undoes the pick.
function keepSpaceAfterChip(state: EditorState): Transaction | null {
  const chip = chipOf(state.doc)
  if (!chip) return null
  const at = 1 + chip.nodeSize
  const next = state.doc.firstChild!.childAfter(chip.nodeSize).node
  if (!next || (next.isText && /^\s/.test(next.text ?? ''))) return null
  const { selection } = state
  const tr = state.tr.insertText(' ', at)
  if (selection.empty && selection.from === at) tr.setSelection(TextSelection.create(tr.doc, at))
  return tr
}

// The send-time belt (ADR-093 dec. 7): the ACL refuses a command whose text does not start with "/nome"
// followed by nothing or a blank. Should the document ever reach the send that way, it goes as plain text.
function commandTextSeparated(text: string, name: string): boolean {
  const rest = text.slice(name.length + 1)
  return text.startsWith(`/${name}`) && (rest === '' || /^\s/.test(rest))
}

// Shift+Enter: em lista, cria o PRÓXIMO item (splitListItem); fora, novo bloco (splitBlock). O
// RichDoc não modela quebra-leve (hardBreak fora do schema por design, ADR-051) — daí "novo bloco",
// não <br>. Retorna true (sempre trata a tecla).
export function shiftEnterSplit(editor: Editor): boolean {
  if (editor.can().splitListItem('listItem')) {
    return editor.commands.splitListItem('listItem')
  }
  return editor.commands.splitBlock()
}

// Ilha WYSIWYG (ADR-051). Desde o PR-5 é O composer (sem flag): substitui o BLOCO de input inteiro
// (toolbar+editor+action row) no canal e na thread. O send emite o fio RICH — editorToComposeResult
// (getText como fallback plano + RichDoc quando há formatação) pelo contrato onSend(body, mentions);
// o parseCompose saiu dos call-sites de send/thread (edit segue no caminho inline até o PR-5b).
// Input-rules do StarterKit ativas: **x**, "- ", "1. " formatam AO VIVO. O attachment (+) reusa o
// mesmo file-picker; o @ dispara o picker de menção (nó atômico + UserId opaco no attr) — o botão só
// insere o "@" que abre o suggestion. O banner de reply (full) espelha o caminho textarea.
export function RichComposer({
  onSend,
  onSendAttachment,
  users,
  commands,
  replyingTo,
  onCancelReply,
  disabled,
  variant = 'full',
  placeholder,
  onEditor,
  initialHTML,
  onSave,
  onCancel,
}: {
  // `command`: the picked `/` command (ADR-093 dec. 7), handed as data with the body — absent otherwise.
  onSend: (body: ComposeResult, mentions: UserId[], command?: ComposerCommand) => void
  // Attachment: mesma assinatura do Composer. Ausente = sem botão de anexo (espelha o textarea, que
  // só mostra o + quando o call-site passa o handler). A UI nunca nomeia o msgtype (P1 — a ACL infere).
  onSendAttachment?: (file: File) => void
  // Membros do canal, pro picker de menção (mesma prop do Composer textarea). Ausente = o @ não abre
  // picker (paridade com o textarea). A UI carrega só User/UserId opaco — nunca um mxid (P1).
  users?: User[]
  // ADR-093 (Proposto), PLANO-AGENTES §0.3.24 item 1: the open conversation's commands, as the ACL orders
  // them (listCommands, then commands.changed). The popup filters by prefix and never reorders. Absent or
  // empty → `/` never opens the popup (§21.1 item 10).
  commands?: AgentCommand[]
  // Reply mode (PLANO-FASE-1-REPLY §4): a clean-domain indicator of the reply target (display name +
  // excerpt, protocol-free) plus a cancel affordance. Rendered only in the full variant, above the
  // toolbar — mirrors the textarea Composer. The composer never carries an id (the parent owns it).
  replyingTo?: { author: string; authorAgent?: AgentColor; excerpt: string }
  onCancelReply?: () => void
  disabled?: boolean
  variant?: 'full' | 'compact'
  // Empty-state hint shown in the contenteditable (Placeholder extension). Default per variant —
  // "Mensagem" (full) / "Responder na thread" (compact); an explicit prop overrides.
  placeholder?: string
  // Test-seam: captura a instância pra testes headless (jsdom não digita de verdade).
  onEditor?: (editor: ReturnType<typeof useEditor>) => void
  // ── EDIT MODE (ADR-051 PR-5b). Presence of onSave/onCancel switches the island into an in-place
  //    editor: the footer becomes Save/Cancel (no send/action-row), the +/@ action-row and the reply
  //    banner are hidden, and there is NO mention picker (editMessage carries no mentions). The
  //    toolbar (B/I/S/list/code/link) stays. `initialHTML` seeds the editor (richDocToHTML of the
  //    message's rich, or escapeToParagraph of its plain text) so a FORMATTED message re-opens WITH
  //    its formatting. Enter saves, Shift+Enter breaks, Esc cancels.
  initialHTML?: string
  onSave?: (body: ComposeResult) => void
  onCancel?: () => void
}) {
  const compact = variant === 'compact'
  const editing = onSave !== undefined
  const resolvedPlaceholder = placeholder ?? (compact ? t('composer.placeholderThread') : t('composer.placeholder'))
  // The extensions are built once and the composer outlives a change of conversation, so the
  // Placeholder reads the live value through a ref (same stale-closure guard as sendRef).
  const placeholderRef = useRef(resolvedPlaceholder)
  placeholderRef.current = resolvedPlaceholder
  // O keymap é criado UMA vez (na criação do editor) e captura o que estiver no ref — o ref é
  // reatribuído a cada render, então Enter sempre vê o submit corrente (send OU save; sem stale
  // closure). `cancelRef` guarda o onCancel só no modo edit (undefined no send → Esc segue default).
  const sendRef = useRef<() => void>(() => {})
  const cancelRef = useRef<(() => void) | undefined>(undefined)
  // The open popup (commands or mention), mirrored from the suggestion plugins. Two copies: React state
  // drives the popup render; a ref gives the suggestion's onKeyDown (a closure created once) the CURRENT
  // value without a stale read (same pattern as sendRef).
  const [suggest, setSuggest] = useState<SuggestState | null>(null)
  const suggestRef = useRef<SuggestState | null>(null)
  const setPicker = (next: SuggestState | null): void => {
    suggestRef.current = next
    setSuggest(next)
  }
  // `users`/`commands` are props; the suggestion `items()` closures below are created once, so they read
  // the live value through a ref (same stale-closure guard as sendRef).
  const usersRef = useRef<User[] | undefined>(users)
  usersRef.current = users
  const commandsRef = useRef<AgentCommand[] | undefined>(commands)
  commandsRef.current = commands
  // §0.3.24 item 2: `/` opens the popup only as the first character of an empty composer in send mode, and
  // pasted text never becomes a command. `pasted` marks a paste until the field is empty again; `reopen`
  // lets the Backspace that undoes a chip (§21.1 item 7) reopen the popup over the text that follows.
  const pastedRef = useRef(false)
  const reopenRef = useRef(false)
  // The listbox and its rows are named by a React id (never a protocol id), for aria-controls and
  // aria-activedescendant on the field (§0.3.24 item 8).
  const listId = useId()
  const optionId = (i: number): string => `${listId}-option-${i}`

  // Link dialog (PR-4, ADR-051 §4). null = closed. `text` seeds the "Texto" field (the current
  // selection, or empty for an insert); `url` seeds "URL" (the current href when editing an existing
  // link); `editing` marks the caret-inside-a-link case (offers Remover, wraps the whole link on
  // submit). `linkError` drives the inline invalid-scheme message on the URL field.
  const [linkDialog, setLinkDialog] = useState<{ text: string; url: string; editing: boolean } | null>(
    null,
  )
  const [linkError, setLinkError] = useState(false)

  // One renderer per trigger, both feeding the one popup (§21.1 item 1) with the live @-picker's keyboard
  // (§21.1 item 6): the first row starts active; arrows move without wrapping; Enter or Tab picks and never
  // sends; Escape closes and the typed text stays. An empty list closes the popup (§21.1 item 10), and the
  // key then falls through (Enter sends the text as typed).
  const popupRenderer = (mode: SuggestState['mode']) => {
    const open = (props: SuggestionProps<SuggestItem>, index: number): void => {
      const items = props.items
      if (!items.length) return setPicker(null)
      setPicker({ mode, items, command: props.command as SuggestState['command'], index: Math.min(index, items.length - 1) })
    }
    return {
      onStart: (props: SuggestionProps<SuggestItem>) => open(props, 0),
      onUpdate: (props: SuggestionProps<SuggestItem>) => {
        const prev = suggestRef.current
        open(props, prev?.mode === mode ? prev.index : 0)
      },
      onKeyDown: ({ event }: SuggestionKeyDownProps): boolean => {
        const state = suggestRef.current
        if (!state || state.mode !== mode) return false
        if (event.key === 'ArrowDown') {
          setPicker({ ...state, index: Math.min(state.index + 1, state.items.length - 1) })
          return true
        }
        if (event.key === 'ArrowUp') {
          setPicker({ ...state, index: Math.max(state.index - 1, 0) })
          return true
        }
        // Enter/Tab select the highlighted row — and return true, so this intercepts the key
        // BEFORE sendOnEnter (selecting a suggestion must never send).
        if (event.key === 'Enter' || event.key === 'Tab') {
          pick(state, state.items[state.index]!)
          return true
        }
        if (event.key === 'Escape') {
          setPicker(null)
          return true
        }
        return false
      },
      onExit: () => {
        reopenRef.current = false
        if (suggestRef.current?.mode === mode) setPicker(null)
      },
    }
  }

  // Insert the picked row as the node: a person or agent mention (id + label), or the command chip (the agent
  // + its name, the command and the hint — all model-only attrs).
  const pick = (state: SuggestState, item: SuggestItem): void => {
    reopenRef.current = false
    if (item.kind === 'mention') state.command({ id: item.id, label: item.label })
    else
      state.command({
        id: item.agent,
        label: item.agentName,
        command: item.name,
        ...(item.hint !== undefined && { hint: item.hint }),
      })
  }

  // Enter envia/salva; Shift+Enter quebra (parágrafo novo — hardBreak está fora do schema por
  // design). Esc só faz algo no modo edit (cancelRef setado) — cancela; no send devolve a tecla.
  const [extensions] = useState(() => [
    ...richExtensions,
    Extension.create({
      name: 'sendOnEnter',
      addKeyboardShortcuts() {
        return {
          Enter: () => {
            sendRef.current()
            return true
          },
          'Shift-Enter': () => shiftEnterSplit(this.editor),
          Escape: () => {
            if (!cancelRef.current) return false
            cancelRef.current()
            return true
          },
        }
      },
    }),
    // Placeholder lives LOCAL to the island, not in richExtensions (the P1 schema allowlist stays a
    // pure node/mark set — the placeholder is a view decoration, not a document node).
    Placeholder.configure({ placeholder: () => placeholderRef.current }),
    // Menção (nó atômico, ADR-051 PR-3): também LOCAL — o UserId opaco fica no attr do nó, nunca no
    // DOM (override P1 acima). O `suggestion` (picker de membros) espelha seu estado imperativo pro
    // React (setPicker) pra reusar o markup do picker do textarea. Sem `users` → items vazio → picker
    // fechado (paridade com o textarea).
    TayetMention.configure({
      suggestions: [
        {
          char: '@',
          items: ({ query }): MentionItem[] =>
            (usersRef.current ?? [])
              .filter((u) => u.displayName.toLowerCase().includes(query.toLowerCase()))
              .slice(0, MENTION_LIMIT)
              .map((u) => {
                const agent = agentColorOf(u)
                return agent !== undefined
                  ? { kind: 'mention', id: u.id, label: u.displayName, agent }
                  : { kind: 'mention', id: u.id, label: u.displayName }
              }),
          render: () => popupRenderer('mention'),
        },
        {
          // ADR-093 (Proposto), workspace.md §21.1 items 2, 3 and 10: `/` at the very start of an otherwise
          // empty document, in send mode, typed (never pasted). Filter by prefix of the name; the order is the
          // ACL's; no cap (the box scrolls). A command whose agent is not among the loaded members has no
          // name to show and is left out.
          char: '/',
          allow: ({ state, range }) => {
            if (editing || pastedRef.current || range.from !== 1) return false
            return reopenRef.current || state.doc.textBetween(range.to, state.doc.content.size) === ''
          },
          items: ({ query }): CommandItem[] => {
            const prefix = query.toLowerCase()
            const members = usersRef.current ?? []
            return (commandsRef.current ?? []).flatMap((c): CommandItem[] => {
              if (!c.name.startsWith(prefix)) return []
              const agent = members.find((u) => u.id === c.agent)
              if (!agent) return []
              return [
                {
                  kind: 'command',
                  agent: c.agent,
                  name: c.name,
                  description: c.description,
                  ...(c.hint !== undefined && { hint: c.hint }),
                  agentName: agent.displayName,
                  agentColor: agentColorOf(agent) ?? 'areia',
                },
              ]
            })
          },
          render: () => popupRenderer('commands'),
        },
      ] as Array<Omit<SuggestionOptions<SuggestItem>, 'editor'>>,
    }),
    // §21.1 item 7: Backspace right after the chip undoes the pick — the chip goes back to the text
    // "/nome", and the popup reopens filtered by it. A person mention keeps the node's own Backspace.
    Extension.create({
      name: 'commandChipBackspace',
      priority: 1000,
      addKeyboardShortcuts() {
        return {
          Backspace: () => {
            const { state } = this.editor
            const { empty, anchor } = state.selection
            if (!empty || anchor < 2) return false
            const before = state.doc.resolve(anchor).nodeBefore
            if (!before || before.type.name !== 'mention' || !before.attrs.command) return false
            reopenRef.current = true
            this.editor.view.dispatch(
              state.tr.insertText(`/${String(before.attrs.command)}`, anchor - before.nodeSize, anchor),
            )
            return true
          },
        }
      },
    }),
    Extension.create({
      name: 'commandHint',
      addProseMirrorPlugins() {
        return [
          new Plugin({
            props: { decorations: (state) => commandHint(state.doc) },
            appendTransaction: (trs, _old, state) => (trs.some((tr) => tr.docChanged) ? keepSpaceAfterChip(state) : null),
          }),
        ]
      },
    }),
  ])
  const editor = useEditor({
    extensions,
    // Edit mode seeds the editor with the message's HTML (richDocToHTML / escapeToParagraph); send
    // mode mounts empty. Read once on creation — startEdit remounts a fresh island per edit session.
    content: initialHTML ?? '',
    editable: !disabled,
    // O aria-label vai no próprio contenteditable — o mesmo "Message" do textarea que este bloco
    // substitui, então os seletores por label continuam encontrando o input. #178 (§0.3.24 item 8): o
    // campo se anuncia como caixa de texto de várias linhas.
    editorProps: {
      attributes: { role: 'textbox', 'aria-multiline': 'true', 'aria-label': t('composer.field') },
      // §0.3.24 item 2: pasted text never becomes a command — marked until the field is empty again.
      handlePaste: () => {
        pastedRef.current = true
        return false
      },
    },
    onUpdate: ({ editor: e }) => {
      if (e.isEmpty) pastedRef.current = false
    },
    // useEditor (TipTap 3) NÃO re-renderiza por transação por default; a toolbar espelha isActive
    // via aria-pressed, então precisa re-render a cada transação pra refletir marca/lista/seleção.
    shouldRerenderOnTransaction: true,
  })

  // Submit the RICH body (ADR-051 PR-5): editorToComposeResult carries the plain fallback (getText,
  // one '\n' per block — the textarea's Shift+Enter contract) plus a RichDoc when formatted. Empty →
  // no-op (both modes). In EDIT mode it hands the body to onSave (editMessage carries no mentions, so
  // collectMentions is skipped); otherwise it sends and clears — the opaque mention UserIds ride
  // collectMentions, never the body (P1).
  const submit = (): void => {
    if (!editor) return
    const body = editorToComposeResult(editor)
    if (!body.text) return
    if (editing) {
      onSave(body)
      return
    }
    // ADR-093 dec. 7: the chip leaves as data — `{ agent, name }` beside the body, whose text starts with
    // "/nome"; mentions typed in the arguments stay mentions.
    const command = commandOf(editor)
    if (command && commandTextSeparated(body.text, command.name)) onSend(body, collectMentions(editor), command)
    else onSend(body, collectMentions(editor))
    editor.commands.clearContent()
    pastedRef.current = false
  }
  useEffect(() => {
    sendRef.current = submit
    cancelRef.current = editing ? onCancel : undefined
  })

  // Open the link dialog, pre-filled from the current editor state: a selection seeds "Texto"; a
  // caret inside an existing link seeds "URL" with its href and flags `editing`. The editor's
  // selection persists in ProseMirror while focus moves to the dialog input, so submit re-reads it.
  const openLinkDialog = (): void => {
    if (!editor) return
    const { from, to, empty } = editor.state.selection
    const editing = editor.isActive('link')
    const text = empty ? '' : editor.state.doc.textBetween(from, to)
    const url = editing ? String(editor.getAttributes('link').href ?? '') : ''
    setLinkError(false)
    setLinkDialog({ text, url, editing })
  }

  const closeLinkDialog = (): void => {
    setLinkDialog(null)
    setLinkError(false)
    editor?.commands.focus()
  }

  // Barrier 1 (UI): only http/https/mailto survive creation — a rejected scheme shows the inline
  // error and creates NO link (never reaches barrier 1b in the schema, nor barrier 2 in the ACL). On
  // a selection or an existing link we wrap/replace the whole mark range (href only); on an empty
  // caret we insert the typed text (or the URL itself) carrying the link mark.
  const submitLink = (): void => {
    if (!editor || !linkDialog) return
    const href = linkDialog.url.trim()
    if (!isSafeHref(href)) {
      setLinkError(true)
      return
    }
    const { empty } = editor.state.selection
    if (linkDialog.editing || !empty) {
      editor.chain().focus().extendMarkRange('link').setLink({ href }).run()
    } else {
      const label = linkDialog.text.trim() || href
      editor
        .chain()
        .focus()
        .insertContent({ type: 'text', text: label, marks: [{ type: 'link', attrs: { href } }] })
        .run()
    }
    setLinkDialog(null)
    setLinkError(false)
  }

  const removeLink = (): void => {
    editor?.chain().focus().extendMarkRange('link').unsetLink().run()
    setLinkDialog(null)
    setLinkError(false)
  }

  useEffect(() => {
    editor?.setEditable(!disabled)
  }, [editor, disabled])

  useEffect(() => {
    onEditor?.(editor)
  }, [editor, onEditor])

  // §0.3.24 item 8: with the popup open the field points at the list and its active row, and the active row
  // scrolls into view. Set on the contenteditable itself (attributes ProseMirror does not manage).
  const activeIndex = suggest ? suggest.index : -1
  useEffect(() => {
    if (!editor || editor.isDestroyed) return
    const dom = editor.view.dom
    if (activeIndex < 0) {
      dom.removeAttribute('aria-controls')
      dom.removeAttribute('aria-activedescendant')
      return
    }
    dom.setAttribute('aria-controls', listId)
    dom.setAttribute('aria-activedescendant', `${listId}-option-${activeIndex}`)
    document.getElementById(`${listId}-option-${activeIndex}`)?.scrollIntoView?.({ block: 'nearest' })
  }, [editor, activeIndex, suggest, listId])

  // The decoration only re-reads the placeholder on a transaction: an empty field must show the new
  // conversation's name right away, not on the first keystroke.
  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.view.dispatch(editor.state.tr)
  }, [editor, resolvedPlaceholder])

  // Attachment picker: mesmo handler do textarea — passa o File cru pro call-site, que deixa a ACL
  // inferir o msgtype (P1). Reseta o value pra permitir re-escolher o mesmo arquivo.
  const pickFile = (e: ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0]
    if (file) onSendAttachment?.(file)
    e.target.value = ''
  }

  // As classes do Composer, espelhadas, pro visual bater: card (full) ou linha (compact), editor
  // no lugar do textarea, send primário à direita. --rich só ajusta o contenteditable interno.
  // workspace.md §21.1 items 1, 3–5: one popup for both triggers (anchored on the card, .composer, opening
  // upward over the timeline), one listbox named by its mode. A command row: "/nome" · description ·
  // agent avatar · agent name. A mention row: the person's Avatar or the AgentAvatar + the name. Local
  // markup of the composer, not a primitive (§0.3.24, scope item 9).
  const popup = (
    <>
      {suggest && suggest.items.length > 0 && (
        <ul
          id={listId}
          className="composer__suggest"
          role="listbox"
          aria-label={suggest.mode === 'commands' ? t('composer.commands') : t('composer.mention')}
        >
          {suggest.items.map((item, i) => (
            <li
              key={item.kind === 'command' ? `${item.agent} ${item.name}` : item.id}
              id={optionId(i)}
              role="option"
              aria-selected={i === suggest.index}
              className={'composer__suggest-option' + (i === suggest.index ? ' composer__suggest-option--active' : '')}
              // onMouseDown (não onClick): dispara antes do blur do editor, pra o insert/foco assentar.
              onMouseDown={(e) => {
                e.preventDefault()
                pick(suggest, item)
              }}
            >
              {item.kind === 'command' ? (
                <>
                  <span className="composer__suggest-command">/{item.name}</span>
                  <span className="composer__suggest-description">{item.description}</span>
                  <AgentAvatar color={item.agentColor} size="gestao" />
                  <span className="composer__suggest-agent">{item.agentName}</span>
                </>
              ) : (
                <>
                  {item.agent !== undefined ? (
                    <AgentAvatar color={item.agent} size="gestao" />
                  ) : (
                    <Avatar size="gestao" label={initialsOf(item.label)} />
                  )}
                  <span className="composer__suggest-name">{item.label}</span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  )

  const input = (
    <div className="composer__field">
      <EditorContent editor={editor} className="composer__input composer__input--rich" />
    </div>
  )

  // Formatting toolbar (ADR-051, PLANO-COMPOSER PR-2): espelha o idioma do composer__toolbar do
  // caminho textarea, mas os botões chamam os comandos do TipTap (toggle no lugar, sem parse de
  // markdown) e refletem isActive via aria-pressed. onMouseDown preventDefault preserva a seleção do
  // editor no clique (senão o mousedown tira o foco e o toggle não acha seleção). Acima do editor em
  // ambos os variants.
  const toolbar = (
    <div className="composer__toolbar" role="toolbar" aria-label={t('composer.formatting')}>
      <button
        type="button"
        aria-label={t('composer.bold')}
        title={t('composer.bold')}
        aria-pressed={!!editor?.isActive('bold')}
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => editor?.chain().focus().toggleBold().run()}
      >
        <b>{GLYPH.bold}</b>
      </button>
      <button
        type="button"
        aria-label={t('composer.italic')}
        title={t('composer.italic')}
        aria-pressed={!!editor?.isActive('italic')}
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => editor?.chain().focus().toggleItalic().run()}
      >
        <i>{GLYPH.italic}</i>
      </button>
      <button
        type="button"
        aria-label={t('composer.strike')}
        title={t('composer.strike')}
        aria-pressed={!!editor?.isActive('strike')}
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => editor?.chain().focus().toggleStrike().run()}
      >
        <s>{GLYPH.strike}</s>
      </button>
      <span className="composer__toolbar-sep" role="separator" aria-orientation="vertical" />
      <button
        type="button"
        aria-label={t('composer.link')}
        title={t('composer.link')}
        aria-pressed={!!editor?.isActive('link')}
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={openLinkDialog}
      >
        <Link />
      </button>
      <button
        type="button"
        aria-label={t('composer.bulletList')}
        title={t('composer.bulletList')}
        aria-pressed={!!editor?.isActive('bulletList')}
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => editor?.chain().focus().toggleBulletList().run()}
      >
        <List />
      </button>
      <button
        type="button"
        aria-label={t('composer.code')}
        title={t('composer.code')}
        aria-pressed={!!editor?.isActive('code')}
        disabled={disabled}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => editor?.chain().focus().toggleCode().run()}
      >
        {'<>'}
      </button>
    </div>
  )

  // Action-row espelhando o Composer textarea: à esquerda o + (anexo, só com onSendAttachment) e o @
  // (menção); à direita o send. O @ insere o caractere "@", que o suggestion detecta e abre o picker
  // (com `users` wired) — teclado e botão unificados. O send é o Button do tier (workspace.md §4.11),
  // desabilitado com o campo vazio; full = rótulo + ícone à direita; compact = só o ícone.
  const actions = (
    <div className="composer__actions">
      <div className="composer__actions-left">
        {onSendAttachment && (
          <label className="composer__attach" aria-label={t('composer.attach')} title={t('composer.attach')}>
            <Plus />
            <input type="file" className="composer__file" onChange={pickFile} disabled={disabled} />
          </label>
        )}
        <button
          type="button"
          className="composer__mention"
          aria-label={t('composer.mention')}
          title={t('composer.mention')}
          disabled={disabled}
          onClick={() => editor?.chain().focus().insertContent('@').run()}
        >
          <At />
        </button>
      </div>
      <Button
        variant="fill"
        size="cotidiano"
        className="composer__send"
        onClick={submit}
        disabled={disabled || !editor?.getText().trim()}
        aria-label={compact ? t('composer.send') : undefined}
        title={t('composer.send')}
      >
        {!compact && t('composer.send')}
        <PaperPlane />
      </Button>
    </div>
  )

  // Edit footer (ADR-051 PR-5b): replaces the send/action-row in edit mode. Reuses the message-row
  // edit button classes (message__edit-save/-cancel) so the inline styling carries over. Save runs
  // submit (Enter's action too); Cancel drops the edit (Esc's action too).
  const editActions = (
    <div className="composer__actions composer__actions--edit">
      <button type="button" className="message__edit-cancel" onClick={onCancel} disabled={disabled}>
        {t('composer.editCancel')}
      </button>
      <button type="button" className="message__edit-save" onClick={submit} disabled={disabled}>
        {t('composer.editSave')}
      </button>
    </div>
  )

  // Link dialog (PR-4): composes the shared Dialog (scrim + focus trap + Esc→onClose), mounted like
  // the other consumers — a conditional child under a positioned ancestor (the .workspace). Two Fields
  // (Texto/URL); footer Cancelar + Inserir/Salvar, plus Remover when editing. Barrier 1 (isSafeHref)
  // runs on submit: an invalid scheme shows the inline error and creates no link. Initial focus is the
  // caller's (Dialog does not decide): URL when a text is seeded, else Texto — via autoFocus, which
  // fires once on the freshly-mounted input.
  const linkDialogEl = linkDialog && (
    <Dialog
      title={linkDialog.editing ? t('composer.linkEdit') : t('composer.linkInsert')}
      onClose={closeLinkDialog}
      footer={
        <>
          {linkDialog.editing && (
            <Button variant="danger" onClick={removeLink}>
              {t('composer.linkRemove')}
            </Button>
          )}
          <Button variant="secondary" onClick={closeLinkDialog}>
            {t('composer.linkCancel')}
          </Button>
          <Button variant="fill" onClick={submitLink}>
            {linkDialog.editing ? t('composer.linkSave') : t('composer.linkInsertAction')}
          </Button>
        </>
      }
    >
      <form
        className="composer__link-form"
        onSubmit={(e) => {
          e.preventDefault()
          submitLink()
        }}
      >
        <Field
          label={t('composer.linkText')}
          htmlFor="link-text"
          inputProps={{
            value: linkDialog.text,
            autoFocus: linkDialog.text === '',
            onChange: (e) => setLinkDialog({ ...linkDialog, text: e.target.value }),
          }}
        />
        <Field
          label={t('composer.linkUrl')}
          htmlFor="link-url"
          inputProps={{
            value: linkDialog.url,
            autoFocus: linkDialog.text !== '',
            'aria-invalid': linkError,
            onChange: (e) => {
              setLinkDialog({ ...linkDialog, url: e.target.value })
              setLinkError(false)
            },
          }}
        />
        {linkError && (
          <p className="compose-dialog__error" role="alert">
            {t('composer.linkInvalid')}
          </p>
        )}
      </form>
    </Dialog>
  )

  // Reply banner (full only): the clean-domain target indicator + cancel, mirroring the textarea
  // Composer. The thread (compact) never replies, so it never receives replyingTo.
  const replyBanner = !compact && replyingTo && (
    <div className="composer__reply" role="status">
      <span className="composer__reply-label">
        {t('composer.replyingTo')}{' '}
        {replyingTo.authorAgent !== undefined && <AgentAvatar color={replyingTo.authorAgent} size="gestao" />}
        <strong>{replyingTo.author}</strong>
      </span>
      <span className="composer__reply-excerpt">{replyingTo.excerpt}</span>
      <button
        type="button"
        className="composer__reply-cancel"
        onClick={onCancelReply}
        aria-label={t('composer.cancelReply')}
      >
        {GLYPH.close}
      </button>
    </div>
  )

  // Edit mode (ADR-051 PR-5b): toolbar + editor + Save/Cancel, no action-row, no reply banner, no
  // mention picker (the row never passes `users`). The link dialog stays — the toolbar keeps Link.
  if (editing) {
    return (
      <div className="composer composer--edit">
        {toolbar}
        {input}
        {editActions}
        {linkDialogEl}
      </div>
    )
  }

  // Ambos os variants: MESMA estrutura (reply banner / toolbar / input / action-row). O compact
  // (thread, workspace.md §12 item 6) difere no placeholder e no send icon-only.
  return (
    <div className={compact ? 'composer composer--compact' : 'composer'}>
      {popup}
      {replyBanner}
      {toolbar}
      {input}
      {actions}
      {linkDialogEl}
    </div>
  )
}
