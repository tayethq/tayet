import { describe, it, expect } from 'vitest'
import { htmlToRichDoc, richTextContent } from '../src/internal'
import { parseCompose, safeHref } from '../src'
import type { RichDoc, RichInline } from '../src'

// PLANO-AGENTES §0.3.15 item 4: matrix.to is unwrapped in both directions and by the parser — the
// link goes, the link text stays. Placeholders only (example.org). The four forms a Matrix client
// emits (user pill, room, alias, event permalink), each raw and percent-encoded.

const FORMS: Array<[string, string]> = [
  ['user, raw', 'https://matrix.to/#/@alice:example.org'],
  ['user, encoded', 'https://matrix.to/#/%40alice%3Aexample.org'],
  ['room, raw', 'https://matrix.to/#/!abcdef:example.org'],
  ['room, encoded', 'https://matrix.to/#/%21abcdef%3Aexample.org'],
  ['alias, raw', 'https://matrix.to/#/#general:example.org'],
  ['alias, encoded', 'https://matrix.to/#/%23general%3Aexample.org'],
  ['event permalink, raw', 'https://matrix.to/#/!abcdef:example.org/$evt123?via=example.org'],
  ['event permalink, encoded', 'https://matrix.to/#/%21abcdef%3Aexample.org/%24evt123?via=example.org'],
]

// The id the visible text would carry when the client renders the pill as its own id ("id text").
const idText = (href: string): string => decodeURIComponent(href.replace('https://matrix.to/#/', '').split(/[/?]/)[0]!)

const hasLink = (doc: RichDoc | undefined): boolean => JSON.stringify(doc ?? []).includes('"t":"link"')

describe('safeHref — the one href predicate', () => {
  it('http(s) and mailto pass; other schemes do not', () => {
    expect(safeHref('https://exemplo.com')).toBe(true)
    expect(safeHref('http://exemplo.com/a_(b)')).toBe(true)
    expect(safeHref('mailto:x@exemplo.com')).toBe(true)
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'vbscript:x', '', '/relative']) expect(safeHref(bad), bad).toBe(false)
  })

  it('matrix.to is refused: http and https, any case, userinfo, port, trailing dot, backslashes', () => {
    for (const h of [
      'https://matrix.to/#/@alice:example.org',
      'http://matrix.to/#/@alice:example.org',
      'HTTPS://MATRIX.TO/#/%40alice%3Aexample.org',
      'https://Matrix.To/',
      'https://user@matrix.to/#/@alice:example.org',
      'https://matrix.to:443/#/@alice:example.org',
      'https://matrix.to./#/@alice:example.org',
      'https:\\\\matrix.to\\#/@alice:example.org',
      '  https://matrix.to/#/@alice:example.org  ',
    ])
      expect(safeHref(h), h).toBe(false)
  })

  it('a host that only contains matrix.to is not matrix.to', () => {
    expect(safeHref('https://notmatrix.to/x')).toBe(true)
    expect(safeHref('https://matrix.to.exemplo.com/x')).toBe(true)
    expect(safeHref('https://exemplo.com/?u=https://matrix.to/#/@alice:example.org')).toBe(true)
  })
})

describe.each(FORMS)('matrix.to — %s', (_label, href) => {
  for (const [kind, text] of [
    ['name text', 'Alice'],
    ['id text', idText(href)],
  ] as const) {
    it(`reader: <a href> with ${kind} → only the text`, () => {
      const doc = htmlToRichDoc(`<p>oi <a href="${href}">${text}</a>!</p>`)
      expect(hasLink(doc)).toBe(false)
      expect(doc).toHaveLength(1)
      const p = doc![0] as Extract<RichDoc[number], { t: 'p' }>
      expect(p.children.every((c) => c.t === 'text')).toBe(true)
      expect(p.children.map((c) => (c.t === 'text' ? c.text : '')).join('')).toBe(`oi ${text}!`)
    })

    it(`serializer: a link node with ${kind} never emits <a href="https://matrix.to…`, () => {
      const link: RichInline = { t: 'link', href, children: [{ t: 'text', text }] }
      const c = richTextContent(`oi ${text}`, [{ t: 'p', children: [{ t: 'text', text: 'oi ' }, link] }])
      expect(c.formatted_body).not.toMatch(/<a\s/i)
      expect(c.formatted_body).not.toContain('matrix.to')
      expect(c.formatted_body).toContain(text.replace(/&/g, '&amp;').replace(/</g, '&lt;'))
    })

    it(`parser: [${kind}](matrix.to) creates no link node`, () => {
      const r = parseCompose(`oi [${text}](${href}) **x**`)
      expect(hasLink(r.rich)).toBe(false)
      expect(JSON.stringify(r.rich)).not.toContain('matrix.to')
    })
  }
})

describe('a plain href stays a link', () => {
  it('reader, serializer and parser keep https://exemplo.com', () => {
    expect(htmlToRichDoc('<p><a href="https://exemplo.com">site</a></p>')).toEqual<RichDoc>([
      { t: 'p', children: [{ t: 'link', href: 'https://exemplo.com', children: [{ t: 'text', text: 'site' }] }] },
    ])
    const doc: RichDoc = [{ t: 'p', children: [{ t: 'link', href: 'https://exemplo.com', children: [{ t: 'text', text: 'site' }] }] }]
    expect(richTextContent('site', doc).formatted_body).toBe('<p><a href="https://exemplo.com">site</a></p>')
    expect(parseCompose('[site](https://exemplo.com)').rich).toEqual(doc)
  })
})
