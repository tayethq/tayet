import type { RichDoc, RichBlock, RichInline } from '../domain'
import { safeHref } from '../href'

// ── Rich-text boundary (ADR-012, Opção C) — the ONE module that names the Matrix rich-content
// protocol vocabulary. `format` / `formatted_body` / `org.matrix.custom.html` appear ONLY here;
// nothing of this crosses the acl/index.ts barrel and none of it enters an exported name. The
// domain carries a structured RichDoc; this module owns the bidirectional translation
// formatted_body (HTML) ↔ RichDoc.
//
// INBOUND is fail-closed BY CONSTRUCTION: a hand-rolled, allowlist-driven parser maps a bounded
// set of tags to known nodes; everything else is dropped (dangerous subtrees like <script> wholesale,
// other unknown wrappers unwrapped to their safe text). There is NO HTML string in the output and
// NO dangerouslySetInnerHTML anywhere — XSS is structurally impossible. We do NOT use DOMParser:
// translateBody runs in Node (integration tests) as well as the browser, so the parser must be
// environment-agnostic.
//
// Tool-drift (matrix-js-sdk 41.x): the rich content lives in `format: org.matrix.custom.html` +
// `formatted_body` on the message content, and for an EDIT inside `m.new_content` (not the top-level
// content). translateBody is the single inbound entry point and is fed the right dict by the caller
// (the m.new_content dict for edits), so this module only ever sees "a content object" and reads the
// same two fields regardless.

const MATRIX_HTML_FORMAT = 'org.matrix.custom.html'

// Extract a RichDoc from a Matrix message-content object, or undefined when there is no rich
// content (then the domain carries only the plain `text`). The literals stay confined here.
export function richFromContent(content: Record<string, unknown>): RichDoc | undefined {
  if (content['format'] !== MATRIX_HTML_FORMAT) return undefined
  const formattedBody = content['formatted_body']
  if (typeof formattedBody !== 'string') return undefined
  return htmlToRichDoc(formattedBody)
}

// ── Tokenizer ───────────────────────────────────────────────────────────────────────────────
type Token =
  | { k: 'text'; text: string }
  | { k: 'start'; name: string; attrs: Record<string, string>; self: boolean }
  | { k: 'end'; name: string }

// Void elements never have children/closing tags.
const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'area', 'base', 'col', 'wbr'])

// Find the index of the '>' that closes the tag opening at `start` ('<'), respecting quoted
// attribute values so a `>` inside an attribute does not end the tag early (a known XSS trick).
function findTagEnd(html: string, start: number): number {
  let quote: string | undefined
  for (let i = start + 1; i < html.length; i++) {
    const c = html[i]
    if (quote) {
      if (c === quote) quote = undefined
    } else if (c === '"' || c === "'") {
      quote = c
    } else if (c === '>') {
      return i
    }
  }
  return -1
}

const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  let m: RegExpExecArray | null
  ATTR_RE.lastIndex = 0
  while ((m = ATTR_RE.exec(s)) !== null) {
    const name = m[1]!.toLowerCase()
    const value = m[2] ?? m[3] ?? m[4] ?? ''
    if (!(name in out)) out[name] = decodeEntities(value)
  }
  return out
}

function tokenize(html: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < html.length) {
    const lt = html.indexOf('<', i)
    if (lt === -1) {
      tokens.push({ k: 'text', text: html.slice(i) })
      break
    }
    if (lt > i) tokens.push({ k: 'text', text: html.slice(i, lt) })
    // Comment / CDATA / doctype — skipped entirely.
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4)
      i = end === -1 ? html.length : end + 3
      continue
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      const end = html.indexOf('>', lt)
      i = end === -1 ? html.length : end + 1
      continue
    }
    const gt = findTagEnd(html, lt)
    if (gt === -1) {
      tokens.push({ k: 'text', text: html.slice(lt) })
      break
    }
    let raw = html.slice(lt + 1, gt).trim()
    i = gt + 1
    if (raw.startsWith('/')) {
      tokens.push({ k: 'end', name: raw.slice(1).trim().toLowerCase() })
      continue
    }
    const self = raw.endsWith('/')
    if (self) raw = raw.slice(0, -1)
    // Hyphens are part of a tag name (custom elements): <mx-reply> must tokenize as ONE name so
    // its HARD_DROP entry matches — as "mx" + stray attr it would be unwrapped, duplicating the
    // quoted fallback (PLANO-FASE-1-REPLY §2.3).
    const nameMatch = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(raw)
    if (!nameMatch) continue
    const name = nameMatch[1]!.toLowerCase()
    const attrs = parseAttrs(raw.slice(nameMatch[1]!.length))
    tokens.push({ k: 'start', name, attrs, self: self || VOID.has(name) })
  }
  return tokens
}

// ── Tree ───────────────────────────────────────────────────────────────────────────────────
type DomNode =
  | { type: 'text'; text: string }
  | { type: 'element'; tag: string; attrs: Record<string, string>; children: DomNode[] }

// A tag that cannot appear inside a <p> (would imply-close it). Keeps malformed input sane.
const BLOCKISH = new Set(['p', 'ul', 'ol', 'li', 'blockquote', 'pre', 'div'])

function buildTree(tokens: Token[]): DomNode[] {
  const root: { type: 'element'; tag: ''; attrs: Record<string, string>; children: DomNode[] } = {
    type: 'element',
    tag: '',
    attrs: {},
    children: [],
  }
  const stack: Array<typeof root | Extract<DomNode, { type: 'element' }>> = [root]
  const top = (): (typeof stack)[number] => stack[stack.length - 1]!

  for (const t of tokens) {
    if (t.k === 'text') {
      top().children.push({ type: 'text', text: t.text })
      continue
    }
    if (t.k === 'start') {
      // Imply-close an open <li> when a sibling <li> starts, and an open <p> when a block starts.
      while (
        stack.length > 1 &&
        ((t.name === 'li' && top().tag === 'li') || (BLOCKISH.has(t.name) && top().tag === 'p'))
      ) {
        stack.pop()
      }
      const el: Extract<DomNode, { type: 'element' }> = {
        type: 'element',
        tag: t.name,
        attrs: t.attrs,
        children: [],
      }
      top().children.push(el)
      if (!t.self) stack.push(el)
      continue
    }
    // end tag: close down to the nearest matching open element, if any.
    for (let j = stack.length - 1; j >= 1; j--) {
      if (stack[j]!.tag === t.name) {
        stack.length = j
        break
      }
    }
  }
  return root.children
}

// ── Entity decoding ──────────────────────────────────────────────────────────────────────────
const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      try {
        return Number.isFinite(code) ? String.fromCodePoint(code) : m
      } catch {
        return m
      }
    }
    return NAMED[e] ?? m
  })
}

// ── Allowlist mapping (HTML tree → RichDoc) ───────────────────────────────────────────────────
// Dangerous/active-content elements: drop the element AND its subtree (the text is code/markup, not
// content). Everything else that is not a known node is UNWRAPPED (its safe text/known descendants
// are kept; the tag and all its attributes are discarded) — fail-closed without gratuitous loss.
const HARD_DROP = new Set([
  'script',
  'style',
  'head',
  'title',
  'textarea',
  'iframe',
  'object',
  'embed',
  'template',
  'noscript',
  'svg',
  'math',
  'meta',
  'link',
  // The legacy reply fallback wrapper (PLANO-FASE-1-REPLY §2.3): the quoted block inside <mx-reply> is
  // REPRESENTATION of the reply relation, not content — same criterion as <script> (element AND
  // subtree discarded). The default unwrap would duplicate the quoted text inside the bubble;
  // the reply itself reaches the domain as Message.replyTo, minted from m.in_reply_to.
  'mx-reply',
])

const INLINE_TAGS = new Set(['strong', 'b', 'em', 'i', 'del', 's', 'strike', 'code', 'a', 'br', 'span', 'u'])

const MAX_DEPTH = 100

// Only http(s)/mailto links survive. javascript:/data:/vbscript:/file: (and anything else) are
// rejected — the <a> is unwrapped to its text, so no dangerous href ever reaches a node. This is
// the construction behind the XSS negative gate (PLANO §5.3). matrix.to is refused as well (P1,
// PLANO-AGENTES §0.3.15 item 4): the predicate is ../href.ts, shared with the parser.
function sanitizeHref(href: string | undefined): string | undefined {
  if (typeof href !== 'string') return undefined
  const h = href.trim()
  if (!h) return undefined
  if (safeHref(h)) return h
  return undefined
}

function whitespaceCollapse(s: string): string {
  return s.replace(/\s+/g, ' ')
}

function textToInline(raw: string): RichInline[] {
  const text = whitespaceCollapse(decodeEntities(raw))
  return text ? [{ t: 'text', text }] : []
}

// Verbatim text content for <code>/<pre> (no whitespace collapse; <br> → newline).
function rawText(nodes: DomNode[]): string {
  let out = ''
  for (const n of nodes) {
    if (n.type === 'text') out += decodeEntities(n.text)
    else if (n.tag === 'br') out += '\n'
    else if (!HARD_DROP.has(n.tag)) out += rawText(n.children)
  }
  return out
}

function mapInline(nodes: DomNode[], depth: number): RichInline[] {
  if (depth > MAX_DEPTH) return []
  const out: RichInline[] = []
  for (const n of nodes) {
    if (n.type === 'text') {
      out.push(...textToInline(n.text))
      continue
    }
    const tag = n.tag
    if (HARD_DROP.has(tag)) continue
    if (tag === 'br') {
      out.push({ t: 'text', text: '\n' })
    } else if (tag === 'strong' || tag === 'b') {
      out.push({ t: 'strong', children: mapInline(n.children, depth + 1) })
    } else if (tag === 'em' || tag === 'i') {
      out.push({ t: 'em', children: mapInline(n.children, depth + 1) })
    } else if (tag === 'del' || tag === 's' || tag === 'strike') {
      out.push({ t: 'strike', children: mapInline(n.children, depth + 1) })
    } else if (tag === 'code') {
      out.push({ t: 'code', text: rawText(n.children) })
    } else if (tag === 'a') {
      const href = sanitizeHref(n.attrs['href'])
      const children = mapInline(n.children, depth + 1)
      // Safe href → a link node; otherwise unwrap (keep the visible text, drop the href).
      if (href) out.push({ t: 'link', href, children })
      else out.push(...children)
    } else {
      // Unknown/neutral inline wrapper (span, u, …) → unwrap to its inline children.
      out.push(...mapInline(n.children, depth + 1))
    }
  }
  return out
}

function isInlineEmpty(inline: RichInline[]): boolean {
  return inline.every((n) => {
    if (n.t === 'text') return n.text.trim() === ''
    if (n.t === 'code') return n.text === ''
    if (n.t === 'link') return isInlineEmpty(n.children)
    return isInlineEmpty(n.children)
  })
}

function mapBlocks(nodes: DomNode[], depth: number): RichBlock[] {
  if (depth > MAX_DEPTH) return []
  const blocks: RichBlock[] = []
  let inlineRun: RichInline[] = []
  const flush = (): void => {
    if (inlineRun.length && !isInlineEmpty(inlineRun)) blocks.push({ t: 'p', children: inlineRun })
    inlineRun = []
  }

  const process = (list: DomNode[]): void => {
    for (const n of list) {
      if (n.type === 'text') {
        if (n.text.trim() !== '') inlineRun.push(...textToInline(n.text))
        continue
      }
      const tag = n.tag
      if (HARD_DROP.has(tag)) continue
      if (tag === 'p') {
        flush()
        const children = mapInline(n.children, depth + 1)
        if (!isInlineEmpty(children)) blocks.push({ t: 'p', children })
      } else if (tag === 'ul' || tag === 'ol') {
        flush()
        const list2 = mapList(n, tag, depth + 1)
        if (list2) blocks.push(list2)
      } else if (tag === 'blockquote') {
        flush()
        const inner = mapBlocks(n.children, depth + 1)
        if (inner.length) blocks.push({ t: 'quote', children: inner })
      } else if (tag === 'pre') {
        flush()
        const text = rawText(n.children).replace(/\n$/, '')
        const lang = codeLang(n)
        if (text) blocks.push(lang ? { t: 'codeblock', text, lang } : { t: 'codeblock', text })
      } else if (INLINE_TAGS.has(tag)) {
        inlineRun.push(...mapInline([n], depth + 1))
      } else {
        // Unknown block-ish wrapper (div, section, h1…): unwrap, keeping inline grouping.
        process(n.children)
      }
    }
  }

  process(nodes)
  flush()
  return blocks
}

// A <pre><code class="language-x"> hint, if present.
function codeLang(pre: Extract<DomNode, { type: 'element' }>): string | undefined {
  const code = pre.children.find(
    (c): c is Extract<DomNode, { type: 'element' }> => c.type === 'element' && c.tag === 'code',
  )
  const cls = code?.attrs['class'] ?? pre.attrs['class'] ?? ''
  const m = /language-([a-zA-Z0-9_+-]+)/.exec(cls)
  return m?.[1]
}

function mapList(
  node: Extract<DomNode, { type: 'element' }>,
  tag: 'ul' | 'ol',
  depth: number,
): RichBlock | undefined {
  const items: RichBlock[][] = []
  for (const child of node.children) {
    if (child.type !== 'element' || child.tag !== 'li') continue
    const blocks = mapBlocks(child.children, depth + 1)
    items.push(blocks)
  }
  if (items.length === 0) return undefined
  return { t: tag, items }
}

// Parse a Matrix formatted_body (HTML subset) into a RichDoc, or undefined when there is nothing
// renderable (so the renderer falls back to the plain `text`). Fail-closed: only known nodes survive.
export function htmlToRichDoc(html: string): RichDoc | undefined {
  if (typeof html !== 'string' || html.trim() === '') return undefined
  const tree = buildTree(tokenize(html))
  const doc = mapBlocks(tree, 0)
  return doc.length ? doc : undefined
}

// ── OUTBOUND: RichDoc → sanitized HTML + plain body ───────────────────────────────────────────
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function inlineToHtml(nodes: RichInline[]): string {
  let out = ''
  for (const n of nodes) {
    switch (n.t) {
      case 'text':
        // A modelled newline becomes a <br/>; the rest is escaped.
        out += escapeHtml(n.text).replace(/\n/g, '<br/>')
        break
      case 'strong':
        out += `<strong>${inlineToHtml(n.children)}</strong>`
        break
      case 'em':
        out += `<em>${inlineToHtml(n.children)}</em>`
        break
      case 'strike':
        out += `<del>${inlineToHtml(n.children)}</del>`
        break
      case 'code':
        out += `<code>${escapeHtml(n.text)}</code>`
        break
      case 'link': {
        // Re-sanitize on the way out too: a RichDoc built in the UI is not trusted more than one
        // parsed inbound. An unsafe href drops the anchor, keeping the visible text.
        const href = sanitizeHref(n.href)
        const inner = inlineToHtml(n.children)
        out += href ? `<a href="${escapeHtml(href)}">${inner}</a>` : inner
        break
      }
    }
  }
  return out
}

function blocksToHtml(blocks: RichBlock[]): string {
  let out = ''
  for (const b of blocks) {
    switch (b.t) {
      case 'p':
        out += `<p>${inlineToHtml(b.children)}</p>`
        break
      case 'ul':
        out += `<ul>${b.items.map((it) => `<li>${blocksToHtml(it)}</li>`).join('')}</ul>`
        break
      case 'ol':
        out += `<ol>${b.items.map((it) => `<li>${blocksToHtml(it)}</li>`).join('')}</ol>`
        break
      case 'quote':
        out += `<blockquote>${blocksToHtml(b.children)}</blockquote>`
        break
      case 'codeblock': {
        const cls = b.lang ? ` class="language-${escapeHtml(b.lang)}"` : ''
        out += `<pre><code${cls}>${escapeHtml(b.text)}</code></pre>`
        break
      }
    }
  }
  return out
}

function inlineToPlain(nodes: RichInline[]): string {
  let out = ''
  for (const n of nodes) {
    if (n.t === 'text') out += n.text
    else if (n.t === 'code') out += n.text
    else out += inlineToPlain(n.children)
  }
  return out
}

function blocksToPlain(blocks: RichBlock[]): string {
  const parts: string[] = []
  for (const b of blocks) {
    switch (b.t) {
      case 'p':
        parts.push(inlineToPlain(b.children))
        break
      case 'ul':
      case 'ol':
        parts.push(b.items.map((it) => `- ${blocksToPlain(it)}`).join('\n'))
        break
      case 'quote':
        parts.push(
          blocksToPlain(b.children)
            .split('\n')
            .map((l) => `> ${l}`)
            .join('\n'),
        )
        break
      case 'codeblock':
        parts.push(b.text)
        break
    }
  }
  return parts.join('\n\n')
}

// ── Legacy reply fallback strip (plain body) — PLANO-FASE-1-REPLY §2.3 ──────────────────────────────
// The spec's (deprecated) reply fallback prefixes the plain `body` with `> `-quoted lines up to
// the first blank line. Strip them — but ONLY when the caller signals the event is a genuine
// reply (m.in_reply_to present): a `> ` quote typed by a user in a non-reply is untouchable.
// The caller owns that signal; this function only does the mechanical strip.
export function stripReplyFallback(body: string): string {
  if (!body.startsWith('> ')) return body
  const lines = body.split('\n')
  let i = 0
  while (i < lines.length && /^>( |$)/.test(lines[i]!)) i++
  // The blank separator line(s) between the fallback and the real message.
  while (i < lines.length && lines[i]!.trim() === '') i++
  return lines.slice(i).join('\n')
}

// Serialize a text send/edit into the Matrix message-content fragment. Without `rich`, returns just
// `{ body }` — byte-for-byte the prior plain-text contract. With `rich`, returns the plain fallback
// (`body`, NEVER omitted — PLANO §6 "plain fallback obrigatório") PLUS the sanitized HTML in
// `formatted_body` with `format: org.matrix.custom.html`. The serializer NEVER emits only
// formatted_body. These three protocol literals are named ONLY in this module.
export function richTextContent(
  text: string,
  rich?: RichDoc,
): { body: string; format?: string; formatted_body?: string } {
  if (!rich || rich.length === 0) return { body: text }
  const formattedBody = blocksToHtml(rich)
  const plain = text && text.length > 0 ? text : blocksToPlain(rich)
  return { body: plain, format: MATRIX_HTML_FORMAT, formatted_body: formattedBody }
}
