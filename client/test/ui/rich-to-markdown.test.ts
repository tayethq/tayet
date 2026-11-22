import { describe, it, expect } from 'vitest'
import type { RichDoc, RichInline } from '../../src/acl'
import { richDocToMarkdown } from '../../src/ui/composer/rich-to-markdown'

// The node table of PLANO-MOBILE §0.12.2 R5, node by node; no escaping of the text (N2 b).
const p = (...children: RichInline[]): RichDoc[number] => ({ t: 'p', children })
const tx = (text: string): RichInline => ({ t: 'text', text })

describe('richDocToMarkdown — node by node', () => {
  it('text as it is, with no escaping of Markdown characters (N2 b)', () => {
    expect(richDocToMarkdown([p(tx('2 * 3 = _seis_ [x]'))])).toBe('2 * 3 = _seis_ [x]')
  })

  it('strong, em and strike, nested', () => {
    const doc: RichDoc = [
      p(
        { t: 'strong', children: [tx('negrito')] },
        tx(' '),
        { t: 'em', children: [tx('itálico')] },
        tx(' '),
        { t: 'strike', children: [tx('riscado')] },
        tx(' '),
        { t: 'strong', children: [{ t: 'em', children: [tx('ambos')] }] },
      ),
    ]
    expect(richDocToMarkdown(doc)).toBe('**negrito** *itálico* ~~riscado~~ ***ambos***')
  })

  it('paragraphs are separated by a blank line', () => {
    expect(richDocToMarkdown([p(tx('um')), p(tx('dois'))])).toBe('um\n\ndois')
  })

  it('inline code: a fence longer than the longest run of backticks inside', () => {
    expect(richDocToMarkdown([p({ t: 'code', text: 'x = 1' })])).toBe('`x = 1`')
    expect(richDocToMarkdown([p({ t: 'code', text: 'a `b` c' })])).toBe('``a `b` c``')
    expect(richDocToMarkdown([p({ t: 'code', text: 'a ``b`` c' })])).toBe('```a ``b`` c```')
  })

  it('inline code that starts or ends with a backtick gets a space against the fence', () => {
    expect(richDocToMarkdown([p({ t: 'code', text: '`x' })])).toBe('`` `x ``')
  })

  it('a safe link as [text](href); an unsafe one as its text only', () => {
    expect(richDocToMarkdown([p({ t: 'link', href: 'https://example.com/a', children: [tx('docs')] })])).toBe(
      '[docs](https://example.com/a)',
    )
    expect(richDocToMarkdown([p({ t: 'link', href: 'javascript:alert(1)', children: [tx('clique')] })])).toBe('clique')
    expect(richDocToMarkdown([p({ t: 'link', href: 'data:text/html,x', children: [{ t: 'strong', children: [tx('b')] }] })])).toBe('**b**')
  })

  it('a mention leaves as the "@nome" already in the text', () => {
    expect(richDocToMarkdown([p(tx('oi '), tx('@Alice Anderson'), tx(', tudo bem?'))])).toBe('oi @Alice Anderson, tudo bem?')
  })

  it('ul: "- " per item', () => {
    expect(richDocToMarkdown([{ t: 'ul', items: [[p(tx('a'))], [p(tx('b'))]] }])).toBe('- a\n- b')
  })

  it('ol: "1. ", "2. " per item', () => {
    expect(richDocToMarkdown([{ t: 'ol', items: [[p(tx('a'))], [p(tx('b'))]] }])).toBe('1. a\n2. b')
  })

  it('nested lists: the inner list indented under its marker, tight', () => {
    const doc: RichDoc = [
      {
        t: 'ul',
        items: [[p(tx('a')), { t: 'ol', items: [[p(tx('a1'))], [p(tx('a2'))]] }], [p(tx('b'))]],
      },
    ]
    expect(richDocToMarkdown(doc)).toBe('- a\n  1. a1\n  2. a2\n- b')
  })

  it('an item with two paragraphs keeps the blank line, indented', () => {
    expect(richDocToMarkdown([{ t: 'ol', items: [[p(tx('um')), p(tx('dois'))]] }])).toBe('1. um\n\n   dois')
  })

  it('quote: "> " at the start of every line of its blocks', () => {
    expect(richDocToMarkdown([{ t: 'quote', children: [p(tx('um')), p(tx('dois'))] }])).toBe('> um\n>\n> dois')
  })

  it('a list inside a quote, and a quote inside a list', () => {
    expect(richDocToMarkdown([{ t: 'quote', children: [{ t: 'ul', items: [[p(tx('a'))], [p(tx('b'))]] }] }])).toBe('> - a\n> - b')
    expect(richDocToMarkdown([{ t: 'ul', items: [[{ t: 'quote', children: [p(tx('q'))] }]] }])).toBe('- > q')
  })

  it('codeblock: a fence of three backticks with the lang; longer when the text has three', () => {
    expect(richDocToMarkdown([{ t: 'codeblock', text: 'const a = 1\nconst b = 2', lang: 'ts' }])).toBe(
      '```ts\nconst a = 1\nconst b = 2\n```',
    )
    expect(richDocToMarkdown([{ t: 'codeblock', text: 'x' }])).toBe('```\nx\n```')
    expect(richDocToMarkdown([{ t: 'codeblock', text: 'a\n```\nb' }])).toBe('````\na\n```\nb\n````')
  })

  it('a codeblock inside a list item keeps its lines indented', () => {
    expect(richDocToMarkdown([{ t: 'ul', items: [[p(tx('veja')), { t: 'codeblock', text: 'a\nb' }]] }])).toBe(
      '- veja\n\n  ```\n  a\n  b\n  ```',
    )
  })
})
