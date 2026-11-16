// Block Kit → the product's rich text (PLANO-AGENTES §0.3.1 S4.3, §0.3.12 item 11). `blocks` are read when
// the call has no `text`, or when they hold a `markdown` block (then the blocks win over the `text`); with
// `text` and no `markdown` block, the text wins (the `actions` block of a card is the exception, A3-4).
// Blocks are never returned on a read. One function per block type:
// - `section` (`text` and `fields`), `context` (texts; images as `[imagem: alt]`), `header` (strong),
//   `image` (`[imagem: alt]` + its link) and `rich_text` (1:1: sections, lists, preformatted, quotes);
// - `markdown`: its `text` as standard Markdown, rendered by the same converter as the local API's
//   `markdown: true` (headings and tables come out degraded, as there); `<@U…>` and `<#C…>` are resolved as
//   in mrkdwn, except inside code; `block_id` is ignored;
// - `divider` is dropped;
// - `actions` and the inputs are dropped with the warning `blocks_unsupported:<type>`; any other type too.
// `actions` is the approval card (A3-4): with the approval facade, chat.postMessage reads it BEFORE this
// flattening (slack/actions.ts) — even when the call has `text` — and only the other blocks come here; its
// click goes out as `block_actions` (slack/interactive.ts). Without the facade it is dropped, as above.
import { parseCompose, type RichBlock, type RichDoc, type RichInline } from '@tayet/shared'
import { mrkdwnToRich, personOrConversation, richToPlain, type MrkdwnResolve } from './mrkdwn'

export interface Flattened {
  text: string
  rich?: RichDoc
  mentions: string[]
  warnings: string[]
}

// What the rich_text `emoji` element becomes (the emoji table, slack/emoji.ts).
export interface BlockResolve extends MrkdwnResolve {
  emoji(name: string): string | undefined
}

type Obj = Record<string, unknown>
interface Piece {
  doc: RichBlock[]
  mentions: string[]
}

const obj = (v: unknown): Obj | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const string = (v: unknown): string => (typeof v === 'string' ? v : '')

function fromMrkdwn(source: string, resolve: BlockResolve): Piece {
  if (source.trim() === '') return { doc: [], mentions: [] }
  const parsed = mrkdwnToRich(source, resolve)
  return { doc: parsed.rich ?? [{ t: 'p', children: [{ t: 'text', text: parsed.text }] }], mentions: parsed.mentions }
}

const plainPiece = (text: string): Piece => ({ doc: text === '' ? [] : [{ t: 'p', children: [{ t: 'text', text }] }], mentions: [] })

// A text object: `mrkdwn` is parsed, `plain_text` is taken as is.
function textPiece(v: unknown, resolve: BlockResolve): Piece {
  const t = obj(v)
  if (t === undefined) return { doc: [], mentions: [] }
  return t.type === 'plain_text' ? plainPiece(string(t.text)) : fromMrkdwn(string(t.text), resolve)
}

// Pieces side by side: one paragraph joined by `sep` when each is a single paragraph, else the blocks in order.
function join(pieces: Piece[], sep: string): Piece {
  const parts = pieces.filter((p) => p.doc.length > 0)
  const mentions = [...new Set(parts.flatMap((p) => p.mentions))]
  if (parts.every((p) => p.doc.length === 1 && p.doc[0]?.t === 'p')) {
    const children: RichInline[] = []
    parts.forEach((p, i) => {
      if (i > 0) children.push({ t: 'text', text: sep })
      children.push(...(p.doc[0] as { children: RichInline[] }).children)
    })
    return { doc: children.length > 0 ? [{ t: 'p', children: merged(children) }] : [], mentions }
  }
  return { doc: parts.flatMap((p) => p.doc), mentions }
}

// Adjacent text nodes become one (the shape the parser produces).
function merged(nodes: RichInline[]): RichInline[] {
  const out: RichInline[] = []
  for (const n of nodes) {
    const last = out[out.length - 1]
    if (n.t === 'text' && last?.t === 'text') last.text += n.text
    else out.push(n.t === 'text' ? { ...n } : n)
  }
  return out
}

const imageLabel = (alt: unknown): string => `[imagem: ${string(alt) !== '' ? string(alt) : 'sem descrição'}]`

// ── rich_text, 1:1 ───────────────────────────────────────────────────────────────────────────────

function styled(node: RichInline, style: Obj | undefined): RichInline {
  let out = node
  if (style?.code === true && out.t === 'text') out = { t: 'code', text: out.text }
  if (style?.strike === true) out = { t: 'strike', children: [out] }
  if (style?.italic === true) out = { t: 'em', children: [out] }
  if (style?.bold === true) out = { t: 'strong', children: [out] }
  return out
}

function richInline(elements: unknown[], resolve: BlockResolve, mentions: string[]): RichInline[] {
  const out: RichInline[] = []
  for (const raw of elements) {
    const e = obj(raw)
    if (e === undefined) continue
    const style = obj(e.style)
    switch (e.type) {
      case 'text':
        out.push(styled({ t: 'text', text: string(e.text) }, style))
        break
      case 'link': {
        const href = string(e.url)
        const label = string(e.text) !== '' ? string(e.text) : href
        out.push(/^(?:https?:\/\/|mailto:)/i.test(href) ? styled({ t: 'link', href, children: [{ t: 'text', text: label }] }, style) : { t: 'text', text: label })
        break
      }
      case 'user': {
        const id = string(e.user_id)
        const name = resolve.person(id)
        if (name !== undefined && !mentions.includes(id)) mentions.push(id)
        out.push({ t: 'text', text: `@${name ?? id}` })
        break
      }
      case 'channel':
        out.push({ t: 'text', text: `#${resolve.conversation(string(e.channel_id)) ?? string(e.channel_id)}` })
        break
      case 'emoji': {
        // `skin_tone` 2–6 → `name::skin-tone-N` (slack/emoji.ts).
        const tone = typeof e.skin_tone === 'number' && e.skin_tone >= 2 && e.skin_tone <= 6 ? `::skin-tone-${e.skin_tone}` : ''
        const name = `${string(e.name)}${tone}`
        out.push({ t: 'text', text: resolve.emoji(name) ?? `:${name}:` })
        break
      }
      case 'broadcast':
        out.push({ t: 'text', text: `@${string(e.range)}` })
        break
    }
  }
  return out
}

function richText(block: Obj, resolve: BlockResolve): Piece {
  const mentions: string[] = []
  const doc: RichBlock[] = []
  const section = (e: Obj): RichBlock => ({ t: 'p', children: richInline(arr(e.elements), resolve, mentions) })
  for (const raw of arr(block.elements)) {
    const e = obj(raw)
    if (e === undefined) continue
    switch (e.type) {
      case 'rich_text_section':
        doc.push(section(e))
        break
      case 'rich_text_list': {
        const items = arr(e.elements).flatMap((x) => (obj(x) !== undefined ? [[section(obj(x) as Obj)]] : []))
        doc.push(e.style === 'ordered' ? { t: 'ol', items } : { t: 'ul', items })
        break
      }
      case 'rich_text_preformatted':
        doc.push({ t: 'codeblock', text: richInline(arr(e.elements), resolve, mentions).map((n) => (n.t === 'text' || n.t === 'code' ? n.text : richToPlain([{ t: 'p', children: [n] }]))).join('') })
        break
      case 'rich_text_quote':
        doc.push({ t: 'quote', children: [section(e)] })
        break
    }
  }
  return { doc, mentions }
}

// ── markdown ─────────────────────────────────────────────────────────────────────────────────────

// The fences and code spans the converter reads verbatim (its rules: a fence indented up to 3 spaces; a
// span from one backtick to the next on the line, never empty).
const FENCE_OPEN = /^ {0,3}```\w*\s*$/
const FENCE_CLOSE = /^ {0,3}```\s*$/
const TOKEN = /<([@#][^|>\s]+)(?:\|([^>\n]*))?>/g

// `<@U…>`, `<@U…|label>`, `<#C…>` and `<#C…|label>` outside code → the body's `@name` / `#name`.
function markdownTokens(source: string, resolve: BlockResolve, mentions: string[]): string {
  const outside = (s: string): string => s.replace(TOKEN, (whole, target: string, label: string | undefined) => personOrConversation(target, label, resolve, mentions) ?? whole)
  let fenced = false
  return source
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => {
      if (fenced) {
        if (FENCE_CLOSE.test(line)) fenced = false
        return line
      }
      if (FENCE_OPEN.test(line)) {
        fenced = true
        return line
      }
      let out = ''
      let from = 0
      for (let i = line.indexOf('`'); i !== -1; i = line.indexOf('`', from)) {
        const end = line.indexOf('`', i + 1)
        if (end === -1) break
        out += outside(line.slice(from, i)) + line.slice(i, end + 1)
        from = end + 1
      }
      return out + outside(line.slice(from))
    })
    .join('\n')
}

function markdownBlock(block: Obj, resolve: BlockResolve): Piece {
  const source = string(block.text)
  if (source.trim() === '') return { doc: [], mentions: [] }
  const mentions: string[] = []
  const text = markdownTokens(source, resolve, mentions)
  return { doc: parseCompose(text).rich ?? [{ t: 'p', children: [{ t: 'text', text }] }], mentions }
}

// ── The block functions ──────────────────────────────────────────────────────────────────────────

type BlockFn = (block: Obj, resolve: BlockResolve, warn: (type: string) => void) => Piece

const BLOCKS: Readonly<Record<string, BlockFn>> = {
  section: (b, resolve, warn) => {
    const accessory = obj(b.accessory)
    if (accessory !== undefined) warn(string(accessory.type) || 'accessory')
    return join([textPiece(b.text, resolve), ...arr(b.fields).map((f) => textPiece(f, resolve))], '\n')
  },
  header: (b) => {
    const text = string(obj(b.text)?.text)
    return { doc: text === '' ? [] : [{ t: 'p', children: [{ t: 'strong', children: [{ t: 'text', text }] }] }], mentions: [] }
  },
  context: (b, resolve) =>
    join(
      arr(b.elements).map((raw) => {
        const e = obj(raw)
        return e?.type === 'image' ? plainPiece(imageLabel(e.alt_text)) : textPiece(e, resolve)
      }),
      ' ',
    ),
  image: (b) => {
    const url = string(b.image_url)
    const label = imageLabel(b.alt_text)
    const children: RichInline[] = /^https?:\/\//i.test(url) ? [{ t: 'text', text: `${label} ` }, { t: 'link', href: url, children: [{ t: 'text', text: url }] }] : [{ t: 'text', text: label }]
    return { doc: [{ t: 'p', children }], mentions: [] }
  },
  rich_text: (b, resolve) => richText(b, resolve),
  markdown: (b, resolve) => markdownBlock(b, resolve),
  divider: () => ({ doc: [], mentions: [] }),
}

export function flattenBlocks(blocks: unknown, resolve: BlockResolve): Flattened {
  const warnings: string[] = []
  const warn = (type: string): void => {
    const w = `blocks_unsupported:${type}`
    if (!warnings.includes(w)) warnings.push(w)
  }
  const doc: RichBlock[] = []
  const mentions: string[] = []
  for (const raw of arr(blocks)) {
    const block = obj(raw)
    if (block === undefined) continue
    const type = string(block.type)
    const fn = Object.hasOwn(BLOCKS, type) ? BLOCKS[type] : undefined
    if (fn === undefined) {
      warn(type || 'unknown')
      continue
    }
    const piece = fn(block, resolve, warn)
    doc.push(...piece.doc)
    for (const m of piece.mentions) if (!mentions.includes(m)) mentions.push(m)
  }
  const text = richToPlain(doc)
  const plain = doc.length === 1 && doc[0]?.t === 'p' && doc[0].children.every((n) => n.t === 'text')
  return { text, ...(doc.length > 0 && !plain && { rich: doc }), mentions, warnings }
}
