// mrkdwn ↔ the product's rich text (PLANO-AGENTES §0.3.12 item 4). Pure; the caller resolves the
// tokens (a person's current name, a conversation's name).
//
// Inbound (chat.postMessage / chat.update): mrkdwn → { text, rich?, mentions }.
// - `<@U…>` / `<@U…|label>` → a mention: `@<name>` in the body and the `U…` in `mentions`;
// - `<#C…>` / `<#C…|label>` → `#<conversation name>`;
// - `<!here>`, `<!channel>`, `<!everyone>` → `@here`/`@channel`/`@everyone` as text; `<!…|fallback>` → the
//   fallback; `<url|text>` / `<url>` → a link (http, https, mailto; any other scheme stays text);
// - the escapes `&amp;`, `&lt;`, `&gt;`;
// - `*bold*`, `_italic_`, `~strike~`, `` `code` `` and ``` blocks ```, `>` quotes; a blank line separates
//   paragraphs, a single newline stays inside the paragraph.
// `rich` is set only when the text has formatting (a plain message stays a plain body).
//
// Outbound (reads): rich (or the plain text) → mrkdwn, escaped; then each person of `mentions` becomes
// `<@U…>` in place of the first `@<their current name>`, or is prefixed when the name is not found.
import type { RichBlock, RichDoc, RichInline } from '@tayet/shared'

export interface MrkdwnResolve {
  // A person's current name ('' or undefined when unknown).
  person(id: string): string | undefined
  // A conversation's name (undefined when unknown).
  conversation(id: string): string | undefined
}

export interface Parsed {
  text: string
  rich?: RichDoc
  mentions: string[]
}

const PERSON = /^U[A-Z2-7]{10}$/
const CONVERSATION = /^[CD][A-Z2-7]{10}$/
const LINK_SCHEME = /^(?:https?:\/\/|mailto:)/i

export const unescapeMrkdwn = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
export const escapeMrkdwn = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// ── Inbound ──────────────────────────────────────────────────────────────────────────────────────

const MARKS: Record<string, 'strong' | 'em' | 'strike'> = { '*': 'strong', _: 'em', '~': 'strike' }
const BOUNDARY = /[\s.,;:!?()[\]{}"'/\\-]/

function pushText(out: RichInline[], text: string): void {
  if (text === '') return
  const last = out[out.length - 1]
  if (last?.t === 'text') last.text += text
  else out.push({ t: 'text', text })
}

// The closing marker of an emphasis opened at `start` (Slack's rule: the opener follows a boundary and
// precedes a non-space; the closer follows a non-space and precedes a boundary), or -1.
function closerOf(s: string, start: number, mark: string): number {
  const next = s[start + 1]
  if (next === undefined || /\s/.test(next) || next === mark) return -1
  for (let j = start + 2; j < s.length; j++) {
    if (s[j] === '\n') return -1
    if (s[j] === '`') {
      const end = s.indexOf('`', j + 1)
      if (end === -1) return -1
      j = end
      continue
    }
    if (s[j] === mark && !/\s/.test(s[j - 1] as string)) {
      const after = s[j + 1]
      if (after === undefined || BOUNDARY.test(after)) return j
    }
  }
  return -1
}

// A person (`@U…`) or a conversation (`#C…`) token as the body shows it, the person added to `mentions`;
// undefined for any other target.
export function personOrConversation(target: string, label: string | undefined, resolve: MrkdwnResolve, mentions: string[]): string | undefined {
  if (target.startsWith('@')) {
    const id = target.slice(1)
    const name = PERSON.test(id) ? resolve.person(id) : undefined
    if (name === undefined) return `@${label ?? id}`
    if (!mentions.includes(id)) mentions.push(id)
    return `@${name !== '' ? name : (label ?? '')}`
  }
  if (target.startsWith('#')) {
    const id = target.slice(1)
    const name = CONVERSATION.test(id) ? resolve.conversation(id) : undefined
    return `#${name ?? label ?? id}`
  }
  return undefined
}

function entity(body: string, resolve: MrkdwnResolve, mentions: string[]): RichInline[] {
  const bar = body.indexOf('|')
  const target = bar === -1 ? body : body.slice(0, bar)
  const label = bar === -1 ? undefined : unescapeMrkdwn(body.slice(bar + 1))
  const token = personOrConversation(target, label, resolve, mentions)
  if (token !== undefined) return [{ t: 'text', text: token }]
  if (target.startsWith('!')) {
    const special = target.slice(1)
    if (special === 'here' || special === 'channel' || special === 'everyone') return [{ t: 'text', text: `@${special}` }]
    return [{ t: 'text', text: label ?? '' }]
  }
  const href = unescapeMrkdwn(target)
  if (!LINK_SCHEME.test(href)) return [{ t: 'text', text: label ?? href }]
  const shown = label ?? href.replace(/^mailto:/i, '')
  return [{ t: 'link', href, children: [{ t: 'text', text: shown }] }]
}

function inline(s: string, resolve: MrkdwnResolve, mentions: string[]): RichInline[] {
  const out: RichInline[] = []
  let text = ''
  const flush = (): void => {
    pushText(out, unescapeMrkdwn(text))
    text = ''
  }
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string
    if (c === '<') {
      const end = s.indexOf('>', i + 1)
      if (end !== -1 && !s.slice(i + 1, end).includes('\n')) {
        flush()
        for (const n of entity(s.slice(i + 1, end), resolve, mentions)) {
          if (n.t === 'text') pushText(out, n.text)
          else out.push(n)
        }
        i = end
        continue
      }
    }
    if (c === '`') {
      const end = s.indexOf('`', i + 1)
      if (end > i + 1 && !s.slice(i + 1, end).includes('\n')) {
        flush()
        out.push({ t: 'code', text: unescapeMrkdwn(s.slice(i + 1, end)) })
        i = end
        continue
      }
    }
    const mark = MARKS[c]
    if (mark !== undefined && (i === 0 || BOUNDARY.test(s[i - 1] as string))) {
      const end = closerOf(s, i, c)
      if (end !== -1) {
        flush()
        out.push({ t: mark, children: inline(s.slice(i + 1, end), resolve, mentions) })
        i = end
        continue
      }
    }
    text += c
  }
  flush()
  return out
}

const isPlain = (doc: RichDoc): boolean => doc.length === 1 && doc[0]?.t === 'p' && doc[0].children.every((n) => n.t === 'text')

export function mrkdwnToRich(source: string, resolve: MrkdwnResolve): Parsed {
  const mentions: string[] = []
  const blocks: RichBlock[] = []
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  let para: string[] = []
  let quote: string[] = []
  const flushPara = (): void => {
    if (para.length > 0) blocks.push({ t: 'p', children: inline(para.join('\n'), resolve, mentions) })
    para = []
  }
  const flushQuote = (): void => {
    if (quote.length > 0) blocks.push({ t: 'quote', children: [{ t: 'p', children: inline(quote.join('\n'), resolve, mentions) }] })
    quote = []
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    if (line.trimStart().startsWith('```')) {
      // A code block: verbatim to the closing fence (or the end).
      flushPara()
      flushQuote()
      const first = line.trimStart().slice(3)
      const body: string[] = []
      let closed = first.endsWith('```') && first.length >= 3
      if (closed) body.push(first.slice(0, -3))
      else if (first !== '') body.push(first)
      while (!closed && ++i < lines.length) {
        const l = lines[i] as string
        if (l.trimEnd().endsWith('```')) {
          const rest = l.trimEnd().slice(0, -3)
          if (rest !== '') body.push(rest)
          closed = true
        } else body.push(l)
      }
      blocks.push({ t: 'codeblock', text: unescapeMrkdwn(body.join('\n')) })
      continue
    }
    const q = /^(?:&gt;|>) ?(.*)$/.exec(line)
    if (q !== null) {
      flushPara()
      quote.push(q[1] as string)
      continue
    }
    flushQuote()
    if (line.trim() === '') flushPara()
    else para.push(line)
  }
  flushPara()
  flushQuote()
  const text = richToPlain(blocks)
  return isPlain(blocks) || blocks.length === 0 ? { text, mentions } : { text, rich: blocks, mentions }
}

// The plain body of a parsed text (the fallback every send carries).
function inlinePlain(nodes: RichInline[]): string {
  return nodes.map((n) => (n.t === 'text' || n.t === 'code' ? n.text : inlinePlain(n.children))).join('')
}

export function richToPlain(blocks: RichBlock[]): string {
  return blocks
    .map((b) => {
      switch (b.t) {
        case 'p':
          return inlinePlain(b.children)
        case 'codeblock':
          return b.text
        case 'quote':
          return richToPlain(b.children)
            .split('\n')
            .map((l) => `> ${l}`)
            .join('\n')
        case 'ul':
        case 'ol':
          return b.items.map((it) => `- ${richToPlain(it)}`).join('\n')
      }
    })
    .join('\n\n')
}

// ── Outbound ─────────────────────────────────────────────────────────────────────────────────────

function inlineMrkdwn(nodes: RichInline[]): string {
  return nodes
    .map((n) => {
      switch (n.t) {
        case 'text':
          return escapeMrkdwn(n.text)
        case 'code':
          return `\`${escapeMrkdwn(n.text)}\``
        case 'strong':
          return `*${inlineMrkdwn(n.children)}*`
        case 'em':
          return `_${inlineMrkdwn(n.children)}_`
        case 'strike':
          return `~${inlineMrkdwn(n.children)}~`
        case 'link': {
          const label = inlinePlain(n.children)
          const href = escapeMrkdwn(n.href)
          return label === '' || label === n.href ? `<${href}>` : `<${href}|${escapeMrkdwn(label)}>`
        }
      }
    })
    .join('')
}

function blocksMrkdwn(blocks: RichBlock[]): string {
  return blocks
    .map((b) => {
      switch (b.t) {
        case 'p':
          return inlineMrkdwn(b.children)
        case 'codeblock':
          return `\`\`\`\n${escapeMrkdwn(b.text)}\n\`\`\``
        case 'quote':
          return blocksMrkdwn(b.children)
            .split('\n')
            .map((l) => `> ${l}`)
            .join('\n')
        case 'ul':
          return b.items.map((it) => `• ${blocksMrkdwn(it)}`).join('\n')
        case 'ol':
          return b.items.map((it, i) => `${i + 1}. ${blocksMrkdwn(it)}`).join('\n')
      }
    })
    .join('\n\n')
}

// A read: the rich doc (or the plain text) as mrkdwn, the mentions as `<@U…>`.
export function richToMrkdwn(text: string, rich: unknown, mentions: readonly string[], resolve: Pick<MrkdwnResolve, 'person'>): string {
  let out = Array.isArray(rich) && rich.length > 0 ? blocksMrkdwn(rich as RichDoc) : escapeMrkdwn(text)
  const prefixed: string[] = []
  for (const id of mentions) {
    const name = resolve.person(id)
    const needle = name !== undefined && name !== '' ? `@${escapeMrkdwn(name)}` : null
    const at = needle !== null ? out.indexOf(needle) : -1
    if (at === -1) prefixed.push(`<@${id}>`)
    else out = `${out.slice(0, at)}<@${id}>${out.slice(at + (needle as string).length)}`
  }
  return prefixed.length > 0 ? `${prefixed.join(' ')} ${out}` : out
}
