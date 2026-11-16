import type { RichDoc, RichBlock, RichInline } from '@tayet/client'
import type { Editor, JSONContent } from '@tiptap/core'
import type { ComposeResult } from '../compose'

// Outbound seam (PLANO-COMPOSER W2): TipTap editor doc JSON → RichDoc, the neutral document the
// ACL already consumes (OutgoingBody.rich). Each schema node/mark maps to its rich.ts counterpart
// VERBATIM (paragraph→p, bulletList→ul, orderedList→ol, blockquote→quote, codeBlock→codeblock;
// bold→strong, italic→em, strike, code, link→{href}). No href sanitization here — the ACL's
// outbound sanitizeHref stays the guard (unchanged). Nodes/marks outside the RichDoc cannot exist
// in the editor schema (rich-schema.ts is the allowlist); if one appears anyway, it is dropped.

// TipTap flattens overlapping marks onto a text node (marks: [bold, italic, …]); the RichDoc nests
// them. Wrap innermost→outermost in a fixed order so the shape is deterministic. `code` is verbatim
// (a leaf with no children) and wins over the others — mirroring inline code in the markdown parser.
const WRAPPERS: ReadonlyArray<{ mark: string; wrap: (children: RichInline[], attrs?: Record<string, unknown>) => RichInline }> = [
  { mark: 'strike', wrap: (children) => ({ t: 'strike', children }) },
  { mark: 'italic', wrap: (children) => ({ t: 'em', children }) },
  { mark: 'bold', wrap: (children) => ({ t: 'strong', children }) },
  { mark: 'link', wrap: (children, attrs) => ({ t: 'link', href: String(attrs?.href ?? ''), children }) },
]

function inlineFromText(node: JSONContent): RichInline[] {
  const text = node.text ?? ''
  const marks = node.marks ?? []
  if (marks.some((m) => m.type === 'code')) return [{ t: 'code', text }]
  let nodes: RichInline[] = [{ t: 'text', text }]
  for (const { mark, wrap } of WRAPPERS) {
    const m = marks.find((x) => x.type === mark)
    if (m) nodes = [wrap(nodes, m.attrs ?? undefined)]
  }
  return nodes
}

function inlineChildren(content: JSONContent[] | undefined): RichInline[] {
  const out: RichInline[] = []
  for (const node of content ?? []) {
    if (node.type === 'text') out.push(...inlineFromText(node))
    // Mention node (RichComposer-local, ADR-051): the opaque UserId NEVER enters the rich — it
    // leaves only via collectMentions → m.mentions.user_ids (P1). Here the chip degrades to its
    // product label as plain "@label" text, matching the textarea path (whose inserted text was
    // "@displayName") and the node's own renderText.
    // ADR-093 (Proposto): the command chip is the same node with `command` set — it flattens to "/nome"
    // (the agent rides SendOpts.command, never the rich).
    else if (node.type === 'mention' && node.attrs?.command) out.push({ t: 'text', text: `/${node.attrs.command}` })
    else if (node.type === 'mention') out.push({ t: 'text', text: `@${node.attrs?.label ?? ''}` })
    // Any other inline node is outside the RichDoc → dropped.
  }
  return out
}

function blockFromNode(node: JSONContent): RichBlock | undefined {
  switch (node.type) {
    case 'paragraph':
      return { t: 'p', children: inlineChildren(node.content) }
    case 'blockquote':
      return { t: 'quote', children: blocksFromContent(node.content) }
    case 'bulletList':
      return { t: 'ul', items: listItems(node.content) }
    case 'orderedList':
      return { t: 'ol', items: listItems(node.content) }
    case 'codeBlock': {
      const text = (node.content ?? []).map((c) => c.text ?? '').join('')
      const lang = (node.attrs?.language as string | undefined) || undefined
      return lang ? { t: 'codeblock', text, lang } : { t: 'codeblock', text }
    }
    default:
      return undefined // node outside the RichDoc → dropped
  }
}

function blocksFromContent(content: JSONContent[] | undefined): RichBlock[] {
  const out: RichBlock[] = []
  for (const node of content ?? []) {
    const block = blockFromNode(node)
    if (block) out.push(block)
  }
  return out
}

// A `listItem` holds blocks (usually a paragraph); each item of ul/ol is that block list.
function listItems(content: JSONContent[] | undefined): RichBlock[][] {
  return (content ?? [])
    .filter((node) => node.type === 'listItem')
    .map((item) => blocksFromContent(item.content))
}

export function docToRichDoc(json: JSONContent): RichDoc {
  return blocksFromContent(json.content)
}

// All-plain check, mirroring parseMarkdown's tail (markdown.ts): a doc with no formatting is NOT
// rich, so a plain send stays byte-for-byte plain (ADR-012 additive). "Plain" = empty, or a single
// paragraph whose inline children are all bare `text` nodes (no mark, no link — a degraded mention
// chip already collapsed to plain "@label" text by inlineChildren, so a mention-only message is
// plain too, its id riding collectMentions, never the rich).
function isPlain(rich: RichDoc): boolean {
  if (rich.length === 0) return true
  if (rich.length === 1 && rich[0]!.t === 'p') {
    return (rich[0] as Extract<RichBlock, { t: 'p' }>).children.every((c) => c.t === 'text')
  }
  return false
}

// Editor → ComposeResult (ADR-051 PR-5), the outbound contract the ACL already consumes. `text` is
// the PLAIN fallback (getText, one '\n' per block — mirrors the textarea's Shift+Enter break), NOT a
// markdown source. `rich` rides ONLY when the doc carries formatting — plain stays plain, exact
// parity with parseCompose (which returns no `rich` for an all-plain parse). Mentions are NOT here:
// collectMentions emits the opaque UserIds separately (P1).
export function editorToComposeResult(editor: Editor): ComposeResult {
  const text = editor.getText({ blockSeparator: '\n' }).trim()
  const rich = docToRichDoc(editor.getJSON())
  return isPlain(rich) ? { text } : { text, rich }
}
