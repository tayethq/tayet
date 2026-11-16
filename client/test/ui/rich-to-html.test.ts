// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { generateJSON } from '@tiptap/core'
import type { RichDoc } from '../../src/acl'
import { richDocToHTML, escapeToParagraph } from '../../src/ui/composer/rich-to-html'
import { docToRichDoc } from '../../src/ui/composer/doc-to-rich'
import { richExtensions } from '../../src/ui/composer/rich-schema'

// richDocToHTML is the INVERSE of the outbound docToRichDoc seam (ADR-051 PR-5b): it feeds the edit
// editor's setContent. The contract is a round-trip identity on the model —
//   rich → richDocToHTML → editor schema (generateJSON, == setContent) → docToRichDoc == rich
// for every node and mark the RichDoc allows. generateJSON needs a DOM (DOMParser), hence jsdom.
const roundTrip = (rich: RichDoc): RichDoc =>
  docToRichDoc(generateJSON(richDocToHTML(rich), richExtensions))

describe('richDocToHTML — round-trips every node/mark through the editor schema', () => {
  const cases: Array<{ name: string; rich: RichDoc }> = [
    { name: 'plain paragraph', rich: [{ t: 'p', children: [{ t: 'text', text: 'plain' }] }] },
    { name: 'bold', rich: [{ t: 'p', children: [{ t: 'strong', children: [{ t: 'text', text: 'bold' }] }] }] },
    { name: 'italic', rich: [{ t: 'p', children: [{ t: 'em', children: [{ t: 'text', text: 'it' }] }] }] },
    { name: 'strike', rich: [{ t: 'p', children: [{ t: 'strike', children: [{ t: 'text', text: 'st' }] }] }] },
    { name: 'inline code', rich: [{ t: 'p', children: [{ t: 'code', text: 'x = 1' }] }] },
    {
      name: 'safe link',
      rich: [
        {
          t: 'p',
          children: [{ t: 'link', href: 'https://example.com/docs', children: [{ t: 'text', text: 'docs' }] }],
        },
      ],
    },
    {
      name: 'mixed inline',
      rich: [
        {
          t: 'p',
          children: [
            { t: 'text', text: 'a ' },
            { t: 'strong', children: [{ t: 'text', text: 'b' }] },
            { t: 'text', text: ' c' },
          ],
        },
      ],
    },
    {
      name: 'nested marks (link > strong > strike)',
      rich: [
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
      ],
    },
    {
      name: 'unordered list',
      rich: [
        {
          t: 'ul',
          items: [[{ t: 'p', children: [{ t: 'text', text: 'a' }] }], [{ t: 'p', children: [{ t: 'text', text: 'b' }] }]],
        },
      ],
    },
    {
      name: 'ordered list',
      rich: [
        {
          t: 'ol',
          items: [[{ t: 'p', children: [{ t: 'text', text: 'one' }] }], [{ t: 'p', children: [{ t: 'text', text: 'two' }] }]],
        },
      ],
    },
    { name: 'blockquote', rich: [{ t: 'quote', children: [{ t: 'p', children: [{ t: 'text', text: 'quoted' }] }] }] },
    { name: 'code block (no lang)', rich: [{ t: 'codeblock', text: 'l1\nl2' }] },
    { name: 'code block (lang)', rich: [{ t: 'codeblock', text: 'const x = 1', lang: 'ts' }] },
    {
      name: 'multi-paragraph rich',
      rich: [
        { t: 'p', children: [{ t: 'strong', children: [{ t: 'text', text: 'one' }] }] },
        { t: 'p', children: [{ t: 'em', children: [{ t: 'text', text: 'two' }] }] },
      ],
    },
  ]

  for (const { name, rich } of cases) {
    it(name, () => {
      expect(roundTrip(rich)).toEqual(rich)
    })
  }
})

describe('richDocToHTML — safety', () => {
  it('an unsafe-scheme link degrades to plain text (no <a> survives the round-trip)', () => {
    const rich: RichDoc = [
      { t: 'p', children: [{ t: 'link', href: 'javascript:alert(1)', children: [{ t: 'text', text: 'click' }] }] },
    ]
    const html = richDocToHTML(rich)
    expect(html).not.toContain('<a')
    expect(html).not.toContain('javascript:')
    // Round-trips to the bare text — the dangerous href never re-enters the model.
    expect(roundTrip(rich)).toEqual([{ t: 'p', children: [{ t: 'text', text: 'click' }] }])
  })

  it('escapes &, <, > and " in text so injected markup is inert', () => {
    const rich: RichDoc = [{ t: 'p', children: [{ t: 'text', text: '<script>alert("x") & y' }] }]
    const html = richDocToHTML(rich)
    expect(html).not.toContain('<script')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&amp;')
    expect(html).toContain('&quot;')
    // The literal text survives the round-trip verbatim.
    expect(roundTrip(rich)).toEqual(rich)
  })

  it('escapes verbatim inline code and code-block text', () => {
    expect(richDocToHTML([{ t: 'p', children: [{ t: 'code', text: 'a < b && c' }] }])).toContain(
      '<code>a &lt; b &amp;&amp; c</code>',
    )
    expect(richDocToHTML([{ t: 'codeblock', text: '<tag>' }])).toContain('<pre><code>&lt;tag&gt;</code></pre>')
  })
})

describe('escapeToParagraph — plain-text seed for the edit editor', () => {
  it('wraps plain text in a single escaped paragraph', () => {
    expect(escapeToParagraph('hello & <world>')).toBe('<p>hello &amp; &lt;world&gt;</p>')
  })

  it('a plain seed stays plain on the round trip (no rich synthesized)', () => {
    // docToRichDoc keeps the lone all-text paragraph; editorToComposeResult would drop it as "plain".
    expect(docToRichDoc(generateJSON(escapeToParagraph('just text'), richExtensions))).toEqual([
      { t: 'p', children: [{ t: 'text', text: 'just text' }] },
    ])
  })
})
