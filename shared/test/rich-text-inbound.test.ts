import { describe, it, expect } from 'vitest'
import { htmlToRichDoc, richFromContent } from '../src/internal'
import { findProtocolLeaks } from '../src/leak-scan'
import type { RichDoc } from '../src'

// Commit 5 (ADR-012): the INBOUND rich parser — formatted_body (HTML subset) → RichDoc, fail-closed
// by construction. The parser is hand-rolled (no DOMParser/lib) so it runs in Node and the browser
// alike. These tests prove (a) the allowlist mapping, (b) XSS fail-closed, and (c) no protocol
// envelope survives into the structured RichDoc.

describe('htmlToRichDoc — allowlist mapping', () => {
  it('maps inline formatting to known nodes', () => {
    const doc = htmlToRichDoc('<p>hello <strong>bold</strong> <em>it</em> <code>x=1</code></p>')
    expect(doc).toEqual<RichDoc>([
      {
        t: 'p',
        children: [
          { t: 'text', text: 'hello ' },
          { t: 'strong', children: [{ t: 'text', text: 'bold' }] },
          { t: 'text', text: ' ' },
          { t: 'em', children: [{ t: 'text', text: 'it' }] },
          { t: 'text', text: ' ' },
          { t: 'code', text: 'x=1' },
        ],
      },
    ])
  })

  it('maps <b>/<i>/<del>/<strike>/<s> to strong/em/strike', () => {
    expect(htmlToRichDoc('<b>a</b>')).toEqual([{ t: 'p', children: [{ t: 'strong', children: [{ t: 'text', text: 'a' }] }] }])
    expect(htmlToRichDoc('<i>a</i>')).toEqual([{ t: 'p', children: [{ t: 'em', children: [{ t: 'text', text: 'a' }] }] }])
    expect(htmlToRichDoc('<del>a</del>')).toEqual([{ t: 'p', children: [{ t: 'strike', children: [{ t: 'text', text: 'a' }] }] }])
    expect(htmlToRichDoc('<strike>a</strike>')).toEqual([{ t: 'p', children: [{ t: 'strike', children: [{ t: 'text', text: 'a' }] }] }])
  })

  it('maps lists (ul/ol/li) with block items', () => {
    const doc = htmlToRichDoc('<ul><li>one</li><li><strong>two</strong></li></ul>')
    expect(doc).toEqual<RichDoc>([
      {
        t: 'ul',
        items: [
          [{ t: 'p', children: [{ t: 'text', text: 'one' }] }],
          [{ t: 'p', children: [{ t: 'strong', children: [{ t: 'text', text: 'two' }] }] }],
        ],
      },
    ])
    const ol = htmlToRichDoc('<ol><li>a</li></ol>')
    expect(ol?.[0]?.t).toBe('ol')
  })

  it('maps blockquote and code block (with language hint)', () => {
    expect(htmlToRichDoc('<blockquote>quoted</blockquote>')).toEqual<RichDoc>([
      { t: 'quote', children: [{ t: 'p', children: [{ t: 'text', text: 'quoted' }] }] },
    ])
    expect(htmlToRichDoc('<pre><code class="language-ts">const x = 1\n</code></pre>')).toEqual<RichDoc>([
      { t: 'codeblock', text: 'const x = 1', lang: 'ts' },
    ])
  })

  it('keeps verbatim text in inline code (no entity loss, no collapse)', () => {
    expect(htmlToRichDoc('<code>a &lt; b  &amp;&amp;  c</code>')).toEqual<RichDoc>([
      { t: 'p', children: [{ t: 'code', text: 'a < b  &&  c' }] },
    ])
  })

  it('keeps only safe links; unwraps dangerous-href anchors to their text', () => {
    expect(htmlToRichDoc('<a href="https://tayet.example">site</a>')).toEqual<RichDoc>([
      { t: 'p', children: [{ t: 'link', href: 'https://tayet.example', children: [{ t: 'text', text: 'site' }] }] },
    ])
    // javascript:/data: href → no link node, text preserved.
    expect(htmlToRichDoc('<a href="javascript:alert(1)">click</a>')).toEqual<RichDoc>([
      { t: 'p', children: [{ t: 'text', text: 'click' }] },
    ])
    expect(htmlToRichDoc('<a href="data:text/html,<script>">x</a>')).toEqual<RichDoc>([
      { t: 'p', children: [{ t: 'text', text: 'x' }] },
    ])
  })

  it('unwraps unknown wrappers (span/div) keeping their text', () => {
    expect(htmlToRichDoc('<div><span>kept</span></div>')).toEqual<RichDoc>([
      { t: 'p', children: [{ t: 'text', text: 'kept' }] },
    ])
  })

  it('unwraps an unknown HYPHENATED tag (custom element) keeping its text', () => {
    // The tokenizer accepts hyphens in tag names (needed so <mx-reply> matches its HARD_DROP
    // entry). Every OTHER hyphenated tag must keep the safe default: unknown → unwrap, tag and
    // attributes discarded, text preserved — same destination it had before the tokenizer change
    // (when it mis-tokenized as name + stray attr and unwrapped anyway).
    expect(htmlToRichDoc('<p>a <foo-bar onclick="evil()">kept</foo-bar> b</p>')).toEqual<RichDoc>([
      {
        t: 'p',
        children: [{ t: 'text', text: 'a ' }, { t: 'text', text: 'kept' }, { t: 'text', text: ' b' }],
      },
    ])
    expect(htmlToRichDoc('<custom-quote>still here</custom-quote>')).toEqual<RichDoc>([
      { t: 'p', children: [{ t: 'text', text: 'still here' }] },
    ])
  })

  it('returns undefined for empty / unrenderable input (renderer falls back to plain text)', () => {
    expect(htmlToRichDoc('')).toBeUndefined()
    expect(htmlToRichDoc('   ')).toBeUndefined()
    expect(htmlToRichDoc('<script>evil()</script>')).toBeUndefined()
  })
})

describe('mx-reply — legacy reply fallback is HARD_DROP (PLANO-FASE-1-REPLY §2.3/§5.2)', () => {
  it('drops the Element-format <mx-reply> wrapper AND its subtree, keeping only the real content', () => {
    const doc = htmlToRichDoc(
      '<mx-reply><blockquote><a href="https://matrix.to/#/!room:server/$evt">In reply to</a>' +
        '<a href="https://matrix.to/#/@alice:server">@alice:server</a><br/>' +
        'the quoted original</blockquote></mx-reply>the actual answer',
    )
    expect(doc).toEqual<RichDoc>([{ t: 'p', children: [{ t: 'text', text: 'the actual answer' }] }])
    const flat = JSON.stringify(doc)
    expect(flat).not.toContain('quoted original') // unwrap would have duplicated this
    expect(flat).not.toContain('mx-reply')
    expect(flat).not.toContain('@alice')
  })

  it('drops it around rich real content too (the reply body stays rich)', () => {
    const doc = htmlToRichDoc(
      '<mx-reply><blockquote>quoted</blockquote></mx-reply><p>answer with <strong>bold</strong></p>',
    )
    expect(doc).toEqual<RichDoc>([
      {
        t: 'p',
        children: [
          { t: 'text', text: 'answer with ' },
          { t: 'strong', children: [{ t: 'text', text: 'bold' }] },
        ],
      },
    ])
  })

  it('a fallback-only formatted_body yields undefined (renderer falls back to the stripped plain)', () => {
    expect(htmlToRichDoc('<mx-reply><blockquote>only the quote</blockquote></mx-reply>')).toBeUndefined()
  })

  it('a GENUINE <blockquote> outside mx-reply still survives (only the wrapper is fallback)', () => {
    expect(htmlToRichDoc('<blockquote>real quote</blockquote>')).toEqual<RichDoc>([
      { t: 'quote', children: [{ t: 'p', children: [{ t: 'text', text: 'real quote' }] }] },
    ])
  })
})

describe('XSS — fail-closed by construction (PLANO §5.3)', () => {
  it('drops <script> entirely (subtree, not just the tag)', () => {
    const doc = htmlToRichDoc('<p>before<script>steal()</script>after</p>')
    // The <script> subtree is gone; the surrounding text survives (as separate adjacent nodes).
    expect(doc).toEqual<RichDoc>([
      { t: 'p', children: [{ t: 'text', text: 'before' }, { t: 'text', text: 'after' }] },
    ])
    expect(JSON.stringify(doc)).not.toContain('steal')
  })

  it('strips event-handler attributes (onerror, onclick) — no attribute survives parsing', () => {
    const doc = htmlToRichDoc('<p onclick="evil()">hi <strong onmouseover="x()">there</strong></p>')
    expect(JSON.stringify(doc)).not.toContain('evil')
    expect(JSON.stringify(doc)).not.toContain('onclick')
    expect(JSON.stringify(doc)).not.toContain('onmouseover')
  })

  it('drops <img onerror=...> (img is void + not a node) with no surviving handler', () => {
    const doc = htmlToRichDoc('<p>x<img src=z onerror="alert(1)">y</p>')
    expect(JSON.stringify(doc ?? [])).not.toContain('onerror')
    expect(JSON.stringify(doc ?? [])).not.toContain('alert')
  })

  it('a `>` inside a quoted attribute does not break out of the tag', () => {
    const doc = htmlToRichDoc('<a href="https://ok" title="a > b">link</a>')
    expect(doc).toEqual<RichDoc>([
      { t: 'p', children: [{ t: 'link', href: 'https://ok', children: [{ t: 'text', text: 'link' }] }] },
    ])
  })

  it('does not stack-overflow on deeply nested input (depth guard)', () => {
    const deep = '<em>'.repeat(5000) + 'x' + '</em>'.repeat(5000)
    expect(() => htmlToRichDoc(deep)).not.toThrow()
  })
})

describe('richFromContent — only fires on org.matrix.custom.html', () => {
  it('returns undefined without the format marker', () => {
    expect(richFromContent({ msgtype: 'm.text', body: 'plain', formatted_body: '<b>x</b>' })).toBeUndefined()
  })
  it('parses formatted_body when format is org.matrix.custom.html', () => {
    const rich = richFromContent({
      msgtype: 'm.text',
      body: '*bold*',
      format: 'org.matrix.custom.html',
      formatted_body: '<strong>bold</strong>',
    })
    expect(rich).toEqual<RichDoc>([{ t: 'p', children: [{ t: 'strong', children: [{ t: 'text', text: 'bold' }] }] }])
  })
})

describe('RichDoc leak-scan (PLANO §5.1) — no protocol envelope survives', () => {
  it('an adversarial formatted_body yields a RichDoc free of envelope vocabulary', () => {
    const rich = htmlToRichDoc(
      '<p>see <a href="https://x">link</a></p>' +
        '<blockquote><code>const x = 1</code></blockquote>' +
        '<script>var formatted_body = "leak"; var u = "@a:b"</script>',
    )
    // The dropped <script> text (which literally contains `formatted_body` AND an mxid shape) must
    // not survive. The recursive leak-scan walks every node, value AND key.
    expect(findProtocolLeaks(rich)).toEqual([])
  })
})
