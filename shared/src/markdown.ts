import type { RichDoc, RichBlock, RichInline } from './domain'
import { safeHref } from './href'

// Compose-side markdown → RichDoc. This is pure PRESENTATION (no protocol vocabulary): it turns
// markdown text into the neutral structured document. Consumers (PLANO-AGENTES §0.3.15): the sidecar,
// for agent text, and the client's composer parity tests (the human composer is TipTap and builds the
// RichDoc itself). The serializer (internal/rich-text.ts) ALWAYS re-sanitizes hrefs, so this parser is
// not a trust boundary — it only needs to be faithful to the author's intent.
//
// Supported (bounded, mirrors the RichDoc node set): **bold**/__bold__, *italic*/_italic_,
// ~~strike~~, `code`, [text](url), fenced ``` code blocks (indented up to 3 spaces), `> ` quotes,
// `- `/`* ` bullet lists, `1.` numbered lists. Degraded, no new node (PLANO-AGENTES §0.3.15 item 3):
// a `#` heading → a paragraph with one strong; a GFM table → a code block with the rows verbatim.
// Literal: intraword `_`/`__` (snake_case, a `__init__` dunder, URLs), `*` surrounded by spaces,
// `![alt](url)` images, an empty `` `` ``. Anything else is plain text.

export interface ComposeResult {
  text: string
  rich?: RichDoc
}

// Parse what the user typed. Returns the raw text as the plain fallback, plus a RichDoc when any
// formatting was detected. A plain message (no formatting) returns NO rich, so plain sends stay
// byte-for-byte plain (ADR-012 additive).
export function parseCompose(input: string): ComposeResult {
  const doc = parseMarkdown(input)
  return doc ? { text: input, rich: doc } : { text: input }
}

const WORD = /[\p{L}\p{N}]/u
const isWord = (c: string | undefined): boolean => c !== undefined && WORD.test(c)
const isSpace = (c: string | undefined): boolean => c === undefined || /\s/.test(c)

// A bare URL is copied verbatim: no emphasis inside it (`_`/`*` in paths and queries stay literal).
const BARE_URL = /^https?:\/\/\S+/i

// `[text](href)` with balanced parentheses in the href (`A_(b)` is not truncated); no whitespace in
// the href. Returns the text, the href and the length consumed, or undefined.
function linkAt(s: string, i: number): { text: string; href: string; len: number } | undefined {
  const m = /^\[([^\]]*)\]\(/.exec(s.slice(i))
  if (!m) return undefined
  let j = i + m[0].length
  const hrefStart = j
  let depth = 0
  for (; j < s.length; j++) {
    const c = s[j]!
    if (/\s/.test(c)) return undefined
    if (c === '(') depth++
    else if (c === ')') {
      if (depth === 0) break
      depth--
    }
  }
  if (j >= s.length || j === hrefStart) return undefined
  return { text: m[1]!, href: s.slice(hrefStart, j), len: j + 1 - i }
}

// Emphasis delimiters (`*`, `_`, `**`, `__`). An opener is followed by a non-space; a closer is
// preceded by a non-space (`2 * 3 * 4` stays literal). For `_`/`__` an opener preceded by a word
// character, or a closer followed by one, is intraword and does not count (`snake_case`, `a_b_c`).
function canOpen(s: string, i: number, delim: string): boolean {
  if (isSpace(s[i + delim.length])) return false
  if (delim[0] === '_' && isWord(s[i - 1])) return false
  return true
}
function closerOf(s: string, from: number, delim: string): number {
  for (let k = s.indexOf(delim, from); k !== -1; k = s.indexOf(delim, k + 1)) {
    if (isSpace(s[k - 1])) continue
    if (delim[0] === '_' && isWord(s[k + delim.length])) continue
    return k
  }
  return -1
}

function parseInline(s: string): RichInline[] {
  const out: RichInline[] = []
  let buf = ''
  let i = 0
  const flush = (): void => {
    if (buf) out.push({ t: 'text', text: buf })
    buf = ''
  }
  while (i < s.length) {
    const rest = s.slice(i)
    // inline code (verbatim, wins over everything); never an empty code node — "``" is literal.
    if (s[i] === '`') {
      const end = s.indexOf('`', i + 1)
      if (end > i + 1) {
        flush()
        out.push({ t: 'code', text: s.slice(i + 1, end) })
        i = end + 1
        continue
      }
      if (end === i + 1) {
        buf += '``'
        i += 2
        continue
      }
    }
    // bare URL: literal, emphasis markers inside it are not markers.
    if ((i === 0 || !isWord(s[i - 1])) && BARE_URL.test(rest)) {
      const url = BARE_URL.exec(rest)![0]
      buf += url
      i += url.length
      continue
    }
    // image ![alt](url): literal text, never a link to the image.
    if (s[i] === '!' && s[i + 1] === '[') {
      const img = linkAt(s, i + 1)
      if (img) {
        buf += s.slice(i, i + 1 + img.len)
        i += 1 + img.len
        continue
      }
    }
    // link [text](url) — only a safe href (./href.ts: http(s)/mailto, never matrix.to) becomes a
    // link; otherwise the link text is kept.
    const link = s[i] === '[' ? linkAt(s, i) : undefined
    if (link) {
      flush()
      const href = link.href.trim()
      if (safeHref(href)) out.push({ t: 'link', href, children: parseInline(link.text) })
      else out.push({ t: 'text', text: link.text })
      i += link.len
      continue
    }
    // strong ** or __ (a `__word__` dunder, e.g. `__init__`, stays literal)
    if (rest.startsWith('**') || rest.startsWith('__')) {
      const delim = rest.slice(0, 2)
      const dunder = delim === '__' && /^__\w+?__(?![\p{L}\p{N}_])/u.exec(rest)
      if (dunder && !dunder[0].slice(2, -2).includes(' ')) {
        buf += dunder[0]
        i += dunder[0].length
        continue
      }
      if (canOpen(s, i, delim)) {
        const end = closerOf(s, i + 2, delim)
        if (end > i + 2) {
          flush()
          out.push({ t: 'strong', children: parseInline(s.slice(i + 2, end)) })
          i = end + 2
          continue
        }
      }
      // not a strong: both characters are literal (a lone `__`/`**` never re-opens as em)
      buf += delim
      i += 2
      continue
    }
    // strike ~~
    if (rest.startsWith('~~')) {
      const end = s.indexOf('~~', i + 2)
      if (end > i + 2) {
        flush()
        out.push({ t: 'strike', children: parseInline(s.slice(i + 2, end)) })
        i = end + 2
        continue
      }
    }
    // em * or _
    if ((s[i] === '*' || s[i] === '_') && canOpen(s, i, s[i]!)) {
      const ch = s[i]!
      const end = closerOf(s, i + 1, ch)
      if (end > i + 1) {
        flush()
        out.push({ t: 'em', children: parseInline(s.slice(i + 1, end)) })
        i = end + 1
        continue
      }
    }
    buf += s[i]
    i++
  }
  flush()
  return out
}

// `|---|:--:|` — at least one `|` and only dashes/colons/spaces per cell.
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/

function parseMarkdown(input: string): RichDoc | undefined {
  const lines = input.replace(/\r\n?/g, '\n').split('\n')
  const blocks: RichBlock[] = []
  let para: string[] = []
  const flushPara = (): void => {
    if (para.length === 0) return
    const children: RichInline[] = []
    para.forEach((line, idx) => {
      if (idx > 0) children.push({ t: 'text', text: '\n' })
      children.push(...parseInline(line))
    })
    blocks.push({ t: 'p', children })
    para = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    // fenced code block (the fence may be indented up to 3 spaces; that indent is removed from the body)
    const fence = /^( {0,3})```(\w*)\s*$/.exec(line)
    if (fence) {
      flushPara()
      const indent = fence[1]!.length
      const lang = fence[2] || undefined
      const body: string[] = []
      i++
      while (i < lines.length && !/^ {0,3}```\s*$/.test(lines[i]!)) {
        body.push(lines[i]!.replace(new RegExp(`^ {0,${indent}}`), ''))
        i++
      }
      const text = body.join('\n')
      blocks.push(lang ? { t: 'codeblock', text, lang } : { t: 'codeblock', text })
      continue
    }
    // heading → no heading node: a paragraph with one strong holding the text (§0.3.15 item 3)
    const heading = /^ {0,3}#{1,6}\s+(.*?)(?:\s+#+)?\s*$/.exec(line)
    if (heading && heading[1]!.trim() !== '') {
      flushPara()
      blocks.push({ t: 'p', children: [{ t: 'strong', children: [{ t: 'text', text: heading[1]!.trim() }] }] })
      continue
    }
    // GFM table (header row with `|` + separator row) → no table node: a code block, rows verbatim
    if (line.includes('|') && i + 1 < lines.length && lines[i + 1]!.includes('|') && TABLE_SEP.test(lines[i + 1]!)) {
      flushPara()
      const rows: string[] = [line, lines[i + 1]!]
      i += 2
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim() !== '') {
        rows.push(lines[i]!)
        i++
      }
      i--
      blocks.push({ t: 'codeblock', text: rows.join('\n') })
      continue
    }
    // quote (consecutive `> ` lines)
    if (/^>\s?/.test(line)) {
      flushPara()
      const quoteLines: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i]!)) {
        quoteLines.push(lines[i]!.replace(/^>\s?/, ''))
        i++
      }
      i--
      blocks.push({ t: 'quote', children: [{ t: 'p', children: parseInline(quoteLines.join('\n')) }] })
      continue
    }
    // bullet / numbered list (consecutive item lines)
    const bullet = /^[-*]\s+(.*)$/.exec(line)
    const numbered = /^\d+\.\s+(.*)$/.exec(line)
    if (bullet || numbered) {
      flushPara()
      const ordered = !!numbered
      const items: RichBlock[][] = []
      while (i < lines.length) {
        const m = ordered ? /^\d+\.\s+(.*)$/.exec(lines[i]!) : /^[-*]\s+(.*)$/.exec(lines[i]!)
        if (!m) break
        items.push([{ t: 'p', children: parseInline(m[1]!) }])
        i++
      }
      i--
      blocks.push({ t: ordered ? 'ol' : 'ul', items })
      continue
    }
    // blank line → paragraph boundary
    if (line.trim() === '') {
      flushPara()
      continue
    }
    para.push(line)
  }
  flushPara()

  if (blocks.length === 0) return undefined
  // A single paragraph that ended up all-plain-text (no inline node survived) is NOT rich — keep the
  // plain path plain so unformatted (or dropped-formatting) messages stay byte-for-byte plain.
  if (blocks.length === 1 && blocks[0]!.t === 'p') {
    const p = blocks[0] as Extract<RichBlock, { t: 'p' }>
    if (p.children.every((c) => c.t === 'text')) return undefined
  }
  return blocks
}
