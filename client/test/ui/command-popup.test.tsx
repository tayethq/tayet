// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { act } from 'react'
import type { Editor } from '@tiptap/react'
import { EditorState } from '@tiptap/pm/state'
import type { AgentCommand, User, UserId } from '../../src/acl'
import { RichComposer } from '../../src/ui/composer/RichComposer'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { copy, fill } from '../support/copy'

// A4-4 (ADR-093 Proposto, PLANO-AGENTES §0.3.24, workspace.md §21): the composer's one suggestion popup with
// two contents — `/` commands and `@` mention — the command chip with its placeholder and Backspace, and the
// command handed to onSend as data. jsdom does not type into a contenteditable: content enters through the
// editor instance (onEditor), and the suggestion resolves asynchronously (flush a turn of the loop).

const uid = (s: string): UserId => s as unknown as UserId
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

const rafael: User = { id: uid('@rafael:tayet.local'), displayName: 'Rafael Souza', kind: 'member' }
const daily: User = { id: uid('@daily-bot:tayet.local'), displayName: 'Relatório diário', kind: 'agent', agentColor: 'argila' }
const publish: User = { id: uid('@publish-bot:tayet.local'), displayName: 'Publicação', kind: 'agent', agentColor: 'ardosia' }
const users = [rafael, daily, publish]

// As the ACL orders them (by command name, then agent name) — the UI never reorders.
const commands: AgentCommand[] = [
  { agent: daily.id, name: 'pendencias', description: 'Itens aguardando aprovação' },
  { agent: publish.id, name: 'publicar', description: 'Agenda um post', hint: 'texto do post' },
  { agent: daily.id, name: 'resumo', description: 'O que mudou desde ontem' },
  { agent: daily.id, name: 'status', description: 'Entregas da semana', hint: 'semana ou data' },
  { agent: publish.id, name: 'status', description: 'Fila de publicação' },
]

type Mounted = { editor: Editor; container: HTMLElement; spy: ReturnType<typeof vi.fn>; dom: HTMLElement }

function mount(props: Partial<Parameters<typeof RichComposer>[0]> = {}): Mounted {
  const spy = vi.fn()
  let editor: Editor | null = null
  const { container } = render(
    <RichComposer onSend={spy} users={users} commands={commands} onEditor={(e) => (editor = e)} {...props} />,
  )
  const dom = container.querySelector('[contenteditable]') as HTMLElement
  return { editor: editor!, container, spy, dom }
}

async function type(editor: Editor, text: string): Promise<void> {
  await act(async () => {
    editor.commands.focus()
    editor.commands.insertContent(text)
    await flush()
  })
}

async function key(dom: HTMLElement, k: string): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(dom, { key: k })
    await flush()
  })
}

const listbox = (c: HTMLElement): HTMLElement | null => c.querySelector('[role="listbox"]')
const rows = (c: HTMLElement): string[] =>
  [...c.querySelectorAll('[role="option"] .composer__suggest-command')].map(
    (r) => `${r.textContent} ${r.parentElement!.querySelector('.composer__suggest-agent')!.textContent}`,
  )
const active = (c: HTMLElement): HTMLElement | null => c.querySelector('[role="option"][aria-selected="true"]')
type JsonNode = { type?: string; attrs?: Record<string, unknown> }
const chip = (editor: Editor): JsonNode | undefined =>
  ((editor.getJSON().content?.[0]?.content ?? []) as JsonNode[]).find((n) => n.type === 'mention' && n.attrs?.command)

afterEach(cleanup)

describe('composer field (#178)', () => {
  it('is a multi-line textbox named "Mensagem"', () => {
    const { dom } = mount()
    expect(dom.getAttribute('role')).toBe('textbox')
    expect(dom.getAttribute('aria-multiline')).toBe('true')
    expect(dom.getAttribute('aria-label')).toBe(copy.composer.field)
  })
})

describe('popup — commands mode (§21.1 items 1, 3, 5)', () => {
  it('"/" in an empty composer opens "Comandos" with every command, in the ACL order, first row active', async () => {
    const { editor, container, dom } = mount()
    await type(editor, '/')
    const list = listbox(container)!
    expect(list.getAttribute('aria-label')).toBe(copy.composer.commands)
    expect(rows(container)).toEqual([
      '/pendencias Relatório diário',
      '/publicar Publicação',
      '/resumo Relatório diário',
      '/status Relatório diário',
      '/status Publicação',
    ])
    const first = container.querySelector('[role="option"]')!
    expect(first.querySelector('.composer__suggest-description')?.textContent).toBe('Itens aguardando aprovação')
    expect(first.querySelector('[data-agent-color="argila"]')).toBeTruthy()
    expect(active(container)).toBe(first)
    // §0.3.24 item 8: the field points at the list and its active row.
    expect(dom.getAttribute('aria-controls')).toBe(list.id)
    expect(dom.getAttribute('aria-activedescendant')).toBe(first.id)
  })

  it('filters by prefix of the name and keeps the order; no result closes the popup and keeps the text', async () => {
    const { editor, container } = mount()
    await type(editor, '/st')
    expect(rows(container)).toEqual(['/status Relatório diário', '/status Publicação'])
    await type(editor, 'x')
    expect(listbox(container)).toBeNull()
    expect(editor.getText()).toBe('/stx')
  })

  it('a conversation without commands never opens the popup', async () => {
    const { editor, container } = mount({ commands: [] })
    await type(editor, '/')
    expect(listbox(container)).toBeNull()
  })

  it('opens only at the start of an empty composer — never in the middle, never in edit mode', async () => {
    const mid = mount()
    await type(mid.editor, 'oi /')
    expect(listbox(mid.container)).toBeNull()
    cleanup()

    // "/" typed before existing text: the document is not empty.
    const before = mount()
    await act(async () => {
      before.editor.commands.setContent('<p>texto</p>')
      before.editor.commands.focus('start')
      before.editor.commands.insertContent('/')
      await flush()
    })
    expect(listbox(before.container)).toBeNull()
    cleanup()

    const edit = mount({ onSave: () => {}, onCancel: () => {} })
    await type(edit.editor, '/')
    expect(listbox(edit.container)).toBeNull()
  })

  it('pasted text never becomes a command', async () => {
    const { editor, container } = mount()
    // A real paste event (jsdom has no ClipboardEvent), as composer-paste-html.test.tsx does.
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', {
      value: { getData: (t: string) => (t === 'text/plain' ? '/status' : ''), types: ['text/plain'], files: [], items: [] },
    })
    await act(async () => {
      editor.commands.focus()
      editor.view.dom.dispatchEvent(paste)
      await flush()
    })
    expect(editor.getText()).toBe('/status')
    expect(listbox(container)).toBeNull()
  })
})

describe('popup — keyboard (§21.1 item 6)', () => {
  it('arrows move without wrapping and the active row follows aria-activedescendant', async () => {
    const { editor, container, dom } = mount()
    await type(editor, '/')
    await key(dom, 'ArrowUp')
    expect(active(container)?.textContent).toContain('/pendencias')
    for (let i = 0; i < 6; i++) await key(dom, 'ArrowDown')
    const last = active(container)!
    expect(last.textContent).toContain('Fila de publicação')
    expect(dom.getAttribute('aria-activedescendant')).toBe(last.id)
  })

  it('Enter picks and never sends; Tab picks too', async () => {
    const enter = mount()
    await type(enter.editor, '/st')
    await key(enter.dom, 'ArrowDown')
    await key(enter.dom, 'Enter')
    expect(enter.spy).not.toHaveBeenCalled()
    expect(chip(enter.editor)?.attrs).toMatchObject({ id: publish.id, command: 'status' })
    expect(listbox(enter.container)).toBeNull()
    cleanup()

    const tab = mount()
    await type(tab.editor, '/re')
    await key(tab.dom, 'Tab')
    expect(tab.spy).not.toHaveBeenCalled()
    expect(chip(tab.editor)?.attrs).toMatchObject({ id: daily.id, command: 'resumo' })
  })

  it('Escape closes without picking and the typed text stays', async () => {
    const { editor, container, dom } = mount()
    await type(editor, '/pu')
    await key(dom, 'Escape')
    expect(listbox(container)).toBeNull()
    expect(chip(editor)).toBeUndefined()
    expect(editor.getText()).toBe('/pu')
    expect(dom.hasAttribute('aria-activedescendant')).toBe(false)
  })

  it('a click picks the row', async () => {
    const { editor, container } = mount()
    await type(editor, '/')
    await act(async () => {
      fireEvent.mouseDown(container.querySelectorAll('[role="option"]')[1]!)
      await flush()
    })
    expect(chip(editor)?.attrs).toMatchObject({ id: publish.id, command: 'publicar' })
  })
})

describe('command chip (§21.1 item 7)', () => {
  it('renders "/nome" at the start, with the agent id only in the node attr, and the hint placeholder', async () => {
    const { editor, container, dom } = mount()
    await type(editor, '/st')
    await key(dom, 'Enter')
    const chipEl = container.querySelector('.mention--command')!
    expect(chipEl.textContent).toBe('/status')
    expect(container.innerHTML).not.toContain(daily.id)
    const p = container.querySelector('p.composer__command-hinted')!
    expect(p.getAttribute('data-command-hint')).toBe(
      fill(copy.composer.commandHintFor, { hint: 'semana ou data', agent: 'Relatório diário' }),
    )
    // Text after the chip removes the placeholder.
    await type(editor, 'semana')
    expect(container.querySelector('p.composer__command-hinted')).toBeNull()
  })

  it('without a hint the placeholder is "para {agente}"', async () => {
    const { editor, container, dom } = mount()
    await type(editor, '/st')
    await key(dom, 'ArrowDown')
    await key(dom, 'Enter')
    expect(container.querySelector('p.composer__command-hinted')?.getAttribute('data-command-hint')).toBe(
      fill(copy.composer.commandFor, { agent: 'Publicação' }),
    )
  })

  it('Backspace right after the chip turns it back into "/nome" and reopens the popup filtered by it', async () => {
    const { editor, container, dom } = mount()
    await type(editor, '/res')
    await key(dom, 'Enter')
    // The pick leaves "chip + space" with the caret after the space; the first Backspace takes the space
    // (the browser's own deletion — jsdom has none, so the space goes by a command). The next one is ours.
    expect(editor.state.selection.anchor).toBe(3)
    await act(async () => {
      editor.commands.deleteRange({ from: 2, to: 3 })
      await flush()
    })
    expect(chip(editor)).toBeDefined()
    await key(dom, 'Backspace')
    expect(chip(editor)).toBeUndefined()
    expect(editor.getText()).toBe('/resumo')
    expect(rows(container)).toEqual(['/resumo Relatório diário'])
  })
})

describe('send with a command (ADR-093 dec. 7, §0.3.24 item 4)', () => {
  it('hands { agent, name } as data, the text "/nome args", and the mentions typed in the arguments', async () => {
    const { editor, container, dom, spy } = mount()
    await type(editor, '/st')
    await key(dom, 'ArrowDown')
    await key(dom, 'Enter')
    await type(editor, 'semana com @raf')
    expect(listbox(container)?.getAttribute('aria-label')).toBe(copy.composer.mention)
    await key(dom, 'Enter')
    await key(dom, 'Enter')
    expect(spy).toHaveBeenCalledTimes(1)
    const [body, mentions, command] = spy.mock.calls[0]!
    expect(body).toEqual({ text: '/status semana com @Rafael Souza' })
    expect(mentions).toEqual([rafael.id])
    expect(command).toEqual({ agent: publish.id, name: 'status' })
    expect(editor.isEmpty).toBe(true)
  })

  it('"/texto" sent without picking is plain text with no command', async () => {
    const { editor, dom, spy } = mount()
    await type(editor, '/status')
    await key(dom, 'Escape')
    await key(dom, 'Enter')
    const call = spy.mock.calls[0]!
    expect(call[0]).toEqual({ text: '/status' })
    expect(call[2]).toBeUndefined()
  })

  it('a formatted argument keeps the chip flattened to "/nome" in the rich', async () => {
    const { editor, dom, spy } = mount()
    await type(editor, '/pu')
    await key(dom, 'Enter')
    await act(async () => {
      editor.chain().focus().toggleBold().insertContent('hoje').run()
      await flush()
    })
    await key(dom, 'Enter')
    const [body, , command] = spy.mock.calls[0]!
    expect(body.text).toBe('/publicar hoje')
    expect(body.rich).toEqual([
      {
        t: 'p',
        children: [
          { t: 'text', text: '/publicar' },
          { t: 'text', text: ' ' },
          { t: 'strong', children: [{ t: 'text', text: 'hoje' }] },
        ],
      },
    ])
    expect(command).toEqual({ agent: publish.id, name: 'publicar' })
  })
})

describe('the space after the chip (review round, 12/Nov)', () => {
  it('pick, Backspace on the space, type the argument, Enter: sends the command with "/status semana"', async () => {
    const { editor, dom, spy } = mount()
    await type(editor, '/sta')
    await key(dom, 'Enter')
    // The first Backspace takes the space (the browser's own deletion — jsdom has none, so by a command).
    await act(async () => {
      editor.commands.deleteRange({ from: 2, to: 3 })
      await flush()
    })
    await type(editor, 'semana')
    await key(dom, 'Enter')
    expect(spy).toHaveBeenCalledTimes(1)
    const [body, , command] = spy.mock.calls[0]!
    expect(body).toEqual({ text: '/status semana' })
    expect(command).toEqual({ agent: daily.id, name: 'status' })
  })

  it('text pasted right after the chip gets the space in between; the hint shows only while it is blank', async () => {
    const { editor, dom, spy } = mount()
    await type(editor, '/sta')
    await key(dom, 'Enter')
    await act(async () => {
      editor.commands.deleteRange({ from: 2, to: 3 })
      await flush()
    })
    expect(dom.querySelector('p')?.getAttribute('data-command-hint')).toBe(
      fill(copy.composer.commandHintFor, { hint: 'semana ou data', agent: daily.displayName }),
    )
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', {
      value: { getData: (t: string) => (t === 'text/plain' ? 'semana' : ''), types: ['text/plain'], files: [], items: [] },
    })
    await act(async () => {
      editor.view.dom.dispatchEvent(paste)
      await flush()
    })
    expect(chip(editor)).toBeDefined()
    expect(editor.getText()).toBe('/status semana')
    expect(dom.querySelector('p')?.hasAttribute('data-command-hint')).toBe(false)
    await key(dom, 'Enter')
    expect(spy.mock.calls[0]![0]).toEqual({ text: '/status semana' })
    expect(spy.mock.calls[0]![2]).toEqual({ agent: daily.id, name: 'status' })
  })

  it('deleting the space before the arguments keeps it, the caret right after the chip; Backspace then undoes the chip', async () => {
    const { editor, container, dom } = mount()
    await type(editor, '/res')
    await key(dom, 'Enter')
    await type(editor, 'hoje')
    expect(editor.getText()).toBe('/resumo hoje')
    await act(async () => {
      editor.commands.setTextSelection(3)
      editor.commands.deleteRange({ from: 2, to: 3 })
      await flush()
    })
    expect(editor.getText()).toBe('/resumo hoje')
    expect(editor.state.selection.anchor).toBe(2)
    await key(dom, 'Backspace')
    expect(chip(editor)).toBeUndefined()
    expect(editor.getText()).toBe('/resumo hoje')
    expect(rows(container)).toEqual(['/resumo Relatório diário'])
  })

  it('the send-time belt: a document with the text glued to the chip goes as plain text, with no command', async () => {
    const { editor, dom, spy } = mount()
    // Built straight into the view (updateState runs no appendTransaction): the state the space keeper prevents.
    const doc = editor.schema.nodeFromJSON({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'mention', attrs: { id: daily.id, label: daily.displayName, command: 'status', hint: null } },
            { type: 'text', text: 'semana' },
          ],
        },
      ],
    })
    await act(async () => {
      editor.view.updateState(EditorState.create({ doc, plugins: editor.state.plugins }))
      await flush()
    })
    expect(editor.getText()).toBe('/statussemana')
    await key(dom, 'Enter')
    expect(spy).toHaveBeenCalledTimes(1)
    const [body, mentions, command] = spy.mock.calls[0]!
    expect(body).toEqual({ text: '/statussemana' })
    expect(mentions).toEqual([])
    expect(command).toBeUndefined()
    expect(spy.mock.calls[0]).toHaveLength(2)
  })
})

describe('popup — mention mode (§21.1 item 4)', () => {
  it('"Mencionar" with the person\'s Avatar monogram and the agent mark', async () => {
    const { editor, container } = mount()
    await type(editor, '@r')
    expect(listbox(container)?.getAttribute('aria-label')).toBe(copy.composer.mention)
    const [person, agent] = [...container.querySelectorAll('[role="option"]')]
    expect(person!.querySelector('.ui-avatar')?.textContent).toBe('RS')
    expect(person!.querySelector('.composer__suggest-name')?.textContent).toBe('Rafael Souza')
    expect(agent!.querySelector('[data-agent-color="argila"]')).toBeTruthy()
  })
})

describe('P1 on the popup and the chip', () => {
  it('no protocol shape in the DOM in either mode', async () => {
    const commandsMode = mount()
    await type(commandsMode.editor, '/')
    expect(findProtocolLeaksInText(commandsMode.container.innerHTML)).toEqual([])
    await key(commandsMode.dom, 'Enter')
    expect(findProtocolLeaksInText(commandsMode.container.innerHTML)).toEqual([])
    cleanup()

    const mentionMode = mount()
    await type(mentionMode.editor, '@')
    expect(findProtocolLeaksInText(mentionMode.container.innerHTML)).toEqual([])
  })
})
