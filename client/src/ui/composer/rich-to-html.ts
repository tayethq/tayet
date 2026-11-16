import type { RichDoc, RichBlock, RichInline } from '@tayet/client'
import { isSafeHref } from './safe-href'

// Inverse of docToRichDoc (composer/), bounded to the RichDoc model (ADR-012): the HTML string handed
// to the EDIT editor's setContent so re-editing a FORMATTED message re-opens WITH its formatting
// (ADR-051 PR-5b — closes the interim flatten-on-edit regression of PR-5). The tag map mirrors what
// docToRichDoc consumes, so rich → HTML → docToRichDoc is an identity on the model.
//
// Zero XSS by construction: the string is built STRUCTURALLY from the typed RichDoc union — every text
// run (and every href) is HTML-escaped before concatenation, and an unknown node cannot exist in the
// union. A link survives as a live <a> only for a safe scheme (isSafeHref — barrier 1, mirroring the
// RichText renderer and the compose dialog); a dangerous scheme degrades to its plain inner text, so a
// forbidden href can never re-enter the editor. The rich never carries a mention node (the compose
// path already flattened a chip to plain "@label" text), so there is no mention case here.

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function inlineToHTML(node: RichInline): string {
  switch (node.t) {
    case 'text':
      return escapeText(node.text)
    case 'strong':
      return `<strong>${node.children.map(inlineToHTML).join('')}</strong>`
    case 'em':
      return `<em>${node.children.map(inlineToHTML).join('')}</em>`
    case 'strike':
      return `<s>${node.children.map(inlineToHTML).join('')}</s>`
    case 'code':
      return `<code>${escapeText(node.text)}</code>`
    case 'link': {
      const inner = node.children.map(inlineToHTML).join('')
      if (!isSafeHref(node.href)) return inner
      return `<a href="${escapeText(node.href)}">${inner}</a>`
    }
  }
}

function blockToHTML(block: RichBlock): string {
  switch (block.t) {
    case 'p':
      return `<p>${block.children.map(inlineToHTML).join('')}</p>`
    case 'quote':
      return `<blockquote>${block.children.map(blockToHTML).join('')}</blockquote>`
    case 'ul':
      return `<ul>${block.items.map(itemToHTML).join('')}</ul>`
    case 'ol':
      return `<ol>${block.items.map(itemToHTML).join('')}</ol>`
    case 'codeblock': {
      // The lang hint rides `class="language-…"` — the exact attribute docToRichDoc reads back into
      // codeblock.lang, so a fenced language round-trips.
      const cls = block.lang ? ` class="language-${escapeText(block.lang)}"` : ''
      return `<pre><code${cls}>${escapeText(block.text)}</code></pre>`
    }
  }
}

// A ul/ol item is a list of blocks (usually a single paragraph) wrapped in <li>.
function itemToHTML(item: RichBlock[]): string {
  return `<li>${item.map(blockToHTML).join('')}</li>`
}

export function richDocToHTML(rich: RichDoc): string {
  return rich.map(blockToHTML).join('')
}

// Plain text (a message with NO rich) → a single escaped <p> for the edit editor's seed. Tayet's
// plain messages are single-block (a multi-block compose always carries rich), so one paragraph keeps
// a plain edit plain on re-save (editorToComposeResult sees a lone all-text paragraph → no rich).
// Escaped → no injection.
export function escapeToParagraph(text: string): string {
  return `<p>${escapeText(text)}</p>`
}
