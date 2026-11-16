import { describe, it, expect } from 'vitest'
import { richTextContent, htmlToRichDoc } from '../src/internal'
import type { RichDoc } from '../src'

// Commit 6 (ADR-012): the OUTBOUND serializer — RichDoc → formatted_body (sanitized HTML) + plain
// body. Proves (a) plain sends stay byte-identical (no rich → just {body}); (b) a rich send always
// carries a plain body fallback (never only formatted_body); (c) round-trip stability through the
// inbound parser; and (d) outbound re-sanitization of a dangerous href crafted in the UI.

describe('richTextContent — plain fallback (PLANO §6)', () => {
  it('without rich returns ONLY a plain body (byte-for-byte the prior contract)', () => {
    expect(richTextContent('hello')).toEqual({ body: 'hello' })
    // No format / formatted_body keys at all when plain.
    expect(richTextContent('hello')).not.toHaveProperty('format')
    expect(richTextContent('hello')).not.toHaveProperty('formatted_body')
  })

  it('with rich ALWAYS carries a plain body (never only formatted_body)', () => {
    const doc: RichDoc = [{ t: 'p', children: [{ t: 'strong', children: [{ t: 'text', text: 'hi' }] }] }]
    const c = richTextContent('hi', doc)
    expect(c.body).toBe('hi') // caller's plain fallback preserved
    expect(c.format).toBe('org.matrix.custom.html')
    expect(c.formatted_body).toBe('<p><strong>hi</strong></p>')
  })

  it('derives a plain body from the RichDoc when the caller gave none', () => {
    const doc: RichDoc = [{ t: 'p', children: [{ t: 'em', children: [{ t: 'text', text: 'derived' }] }] }]
    expect(richTextContent('', doc).body).toBe('derived')
  })
})

describe('richDocToHtml — sanitized serialization', () => {
  it('escapes text and serializes the node set', () => {
    const doc: RichDoc = [
      { t: 'p', children: [{ t: 'text', text: 'a < b & "c"' }] },
      { t: 'ul', items: [[{ t: 'p', children: [{ t: 'text', text: 'one' }] }]] },
      { t: 'quote', children: [{ t: 'p', children: [{ t: 'text', text: 'q' }] }] },
      { t: 'codeblock', text: 'const x = 1', lang: 'ts' },
    ]
    expect(richTextContent('x', doc).formatted_body).toBe(
      '<p>a &lt; b &amp; &quot;c&quot;</p>' +
        '<ul><li><p>one</p></li></ul>' +
        '<blockquote><p>q</p></blockquote>' +
        '<pre><code class="language-ts">const x = 1</code></pre>',
    )
  })

  it('re-sanitizes an unsafe href crafted in the domain (drops the anchor, keeps text)', () => {
    const doc: RichDoc = [
      { t: 'p', children: [{ t: 'link', href: 'javascript:alert(1)', children: [{ t: 'text', text: 'x' }] }] },
    ]
    const html = richTextContent('x', doc).formatted_body!
    expect(html).toBe('<p>x</p>')
    expect(html).not.toContain('javascript')
  })
})

describe('round-trip: RichDoc → formatted_body → RichDoc is stable', () => {
  it('survives a serialize→parse cycle', () => {
    const doc: RichDoc = [
      { t: 'p', children: [
        { t: 'text', text: 'see ' },
        { t: 'link', href: 'https://tayet.example', children: [{ t: 'text', text: 'site' }] },
        { t: 'text', text: ' ' },
        { t: 'code', text: 'x=1' },
      ] },
      { t: 'ul', items: [
        [{ t: 'p', children: [{ t: 'text', text: 'one' }] }],
        [{ t: 'p', children: [{ t: 'strong', children: [{ t: 'text', text: 'two' }] }] }],
      ] },
    ]
    const html = richTextContent('', doc).formatted_body!
    expect(htmlToRichDoc(html)).toEqual(doc)
  })
})
