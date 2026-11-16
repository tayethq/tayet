// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { generateJSON, getSchema } from '@tiptap/core'
import { parseCompose } from '@tayet/shared'
import { docToRichDoc } from '../../src/ui/composer/doc-to-rich'
import { richExtensions } from '../../src/ui/composer/rich-schema'

// The outbound seam is proved headless: HTML → editor schema (generateJSON) → docToRichDoc → RichDoc.
// generateJSON needs a DOM (DOMParser), hence jsdom. For every case with a markdown equivalent, the
// serializer's output must MATCH parseCompose(markdown).rich — the two authoring surfaces converge on
// the same RichDoc.
const richOf = (html: string) => docToRichDoc(generateJSON(html, richExtensions))

describe('docToRichDoc — parity with parseCompose', () => {
  const cases: Array<{ name: string; html: string; md: string }> = [
    { name: 'bold', html: '<p><strong>bold</strong></p>', md: '**bold**' },
    { name: 'italic', html: '<p><em>italic</em></p>', md: '*italic*' },
    { name: 'strike', html: '<p><s>struck</s></p>', md: '~~struck~~' },
    { name: 'inline code', html: '<p><code>code</code></p>', md: '`code`' },
    { name: 'link', html: '<p><a href="https://example.com">text</a></p>', md: '[text](https://example.com)' },
    { name: 'unordered list', html: '<ul><li><p>a</p></li><li><p>b</p></li></ul>', md: '- a\n- b' },
    { name: 'ordered list', html: '<ol><li><p>one</p></li><li><p>two</p></li></ol>', md: '1. one\n2. two' },
    { name: 'blockquote', html: '<blockquote><p>quoted</p></blockquote>', md: '> quoted' },
    { name: 'code block', html: '<pre><code>l1\nl2</code></pre>', md: '```\nl1\nl2\n```' },
    { name: 'mixed inline', html: '<p>plain <strong>bold</strong> tail</p>', md: 'plain **bold** tail' },
  ]

  for (const { name, html, md } of cases) {
    it(name, () => {
      expect(richOf(html)).toEqual(parseCompose(md).rich)
    })
  }
})

describe('docToRichDoc — direct shape', () => {
  it('code block carries a language hint', () => {
    expect(richOf('<pre><code class="language-ts">const x = 1</code></pre>')).toEqual([
      { t: 'codeblock', text: 'const x = 1', lang: 'ts' },
    ])
  })

  it('omits lang when the code block has none', () => {
    expect(richOf('<pre><code>bare</code></pre>')).toEqual([{ t: 'codeblock', text: 'bare' }])
  })

  // Mention (RichComposer-local node, ADR-051 PR-5): degrades to plain "@label" text; the opaque
  // UserId NEVER enters the rich (it leaves via collectMentions → m.mentions.user_ids). Fed as raw
  // JSONContent — the mention node is local to the island, not in richExtensions/generateJSON.
  it('maps a mention node to plain "@label" text and keeps the UserId out of the rich', () => {
    const json = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'oi ' },
            { type: 'mention', attrs: { id: '@alice:tayet.local', label: 'Alice' } },
          ],
        },
      ],
    }
    expect(docToRichDoc(json)).toEqual([
      { t: 'p', children: [{ t: 'text', text: 'oi ' }, { t: 'text', text: '@Alice' }] },
    ])
    expect(JSON.stringify(docToRichDoc(json))).not.toContain('@alice:tayet.local')
  })

  it('nests overlapping marks deterministically (link outermost, strike innermost)', () => {
    expect(richOf('<p><a href="https://ex.com"><strong><s>x</s></strong></a></p>')).toEqual([
      {
        t: 'p',
        children: [
          {
            t: 'link',
            href: 'https://ex.com',
            children: [{ t: 'strong', children: [{ t: 'strike', children: [{ t: 'text', text: 'x' }] }] }],
          },
        ],
      },
    ])
  })
})

describe('richExtensions — schema IS the RichDoc allowlist', () => {
  it('exposes exactly the RichDoc nodes and marks (heading/hr/hardBreak/underline off)', () => {
    const schema = getSchema(richExtensions)
    expect(Object.keys(schema.nodes).sort()).toEqual(
      ['blockquote', 'bulletList', 'codeBlock', 'doc', 'listItem', 'orderedList', 'paragraph', 'text'].sort(),
    )
    expect(Object.keys(schema.marks).sort()).toEqual(['bold', 'code', 'italic', 'link', 'strike'].sort())
  })
})
