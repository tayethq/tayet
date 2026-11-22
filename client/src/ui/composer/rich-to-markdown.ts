import type { RichDoc, RichBlock, RichInline } from '@tayet/client'
import { isSafeHref } from './safe-href'

// RichDoc → Markdown, for "Copiar texto" (manifest workspace.md §25.1 item 4; PLANO-MOBILE §0.12.2 R5).
// The node table of R5, bounded to the RichDoc model (ADR-012), built structurally like rich-to-html.ts.
// No escaping of Markdown characters in the text (N2 b, owner 20/Nov/2026): a literal `*` stays a `*`.
// A link survives as `[text](href)` only for a safe scheme (isSafeHref, as the renderer and
// rich-to-html.ts); otherwise only its text. The rich carries no mention node: the composer flattens
// a chip to plain "@label" text (doc-to-rich.ts), so a mention leaves as the "@nome" already in a text run.

// The longest run of backticks in a string — a code fence must be longer than it.
function longestBacktickRun(s: string): number {
  let longest = 0
  for (const run of s.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  return longest
}

function inlineToMarkdown(node: RichInline): string {
  switch (node.t) {
    case 'text':
      return node.text
    case 'strong':
      return `**${node.children.map(inlineToMarkdown).join('')}**`
    case 'em':
      return `*${node.children.map(inlineToMarkdown).join('')}*`
    case 'strike':
      return `~~${node.children.map(inlineToMarkdown).join('')}~~`
    case 'code': {
      const fence = '`'.repeat(longestBacktickRun(node.text) + 1)
      // A code span that starts or ends with a backtick needs a space against the fence (CommonMark).
      const pad = node.text.startsWith('`') || node.text.endsWith('`') ? ' ' : ''
      return `${fence}${pad}${node.text}${pad}${fence}`
    }
    case 'link': {
      const inner = node.children.map(inlineToMarkdown).join('')
      return isSafeHref(node.href) ? `[${inner}](${node.href})` : inner
    }
  }
}

// Prefix every line of `text`: the first with `first`, the rest with `rest`. An empty line keeps only
// the prefix's non-space part, so no line ends in trailing spaces.
function prefixLines(text: string, first: string, rest: string): string {
  return text
    .split('\n')
    .map((line, i) => {
      const prefix = i === 0 ? first : rest
      return line === '' ? prefix.trimEnd() : `${prefix}${line}`
    })
    .join('\n')
}

const isList = (b: RichBlock): boolean => b.t === 'ul' || b.t === 'ol'

// Blocks are separated by a blank line; inside a list item, a list next to a paragraph hugs it, so a
// nested list stays tight.
function blocksToMarkdown(blocks: RichBlock[], inItem = false): string {
  let out = ''
  blocks.forEach((b, i) => {
    if (i > 0) out += inItem && (isList(b) || isList(blocks[i - 1]!)) ? '\n' : '\n\n'
    out += blockToMarkdown(b)
  })
  return out
}

// A list item: the marker on its first line, the item's other lines indented under it.
function itemToMarkdown(marker: string, item: RichBlock[]): string {
  return prefixLines(blocksToMarkdown(item, true), marker, ' '.repeat(marker.length))
}

function blockToMarkdown(block: RichBlock): string {
  switch (block.t) {
    case 'p':
      return block.children.map(inlineToMarkdown).join('')
    case 'quote':
      return prefixLines(blocksToMarkdown(block.children), '> ', '> ')
    case 'ul':
      return block.items.map((item) => itemToMarkdown('- ', item)).join('\n')
    case 'ol':
      return block.items.map((item, i) => itemToMarkdown(`${i + 1}. `, item)).join('\n')
    case 'codeblock': {
      const fence = '`'.repeat(Math.max(3, longestBacktickRun(block.text) + 1))
      return `${fence}${block.lang ?? ''}\n${block.text}\n${fence}`
    }
  }
}

export function richDocToMarkdown(rich: RichDoc): string {
  return blocksToMarkdown(rich)
}
