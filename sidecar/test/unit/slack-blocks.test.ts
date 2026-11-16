import { describe, it, expect } from 'vitest'
import { parseCompose } from '@tayet/shared'
import { flattenBlocks, type BlockResolve } from '../../src/api/slack/blocks'

// Block Kit → rich (PLANO-AGENTES §0.3.1 S4.3, §0.3.12 item 11): one function per block type.

const resolve: BlockResolve = {
  person: (id) => (id === 'UALICEAAAAA' ? 'Alice Souza' : undefined),
  conversation: (id) => (id === 'CGENERALAAA' ? 'geral' : undefined),
  emoji: (name) => (name === 'tada' ? '🎉' : undefined),
}

describe('flattenBlocks', () => {
  it('section text + fields (mrkdwn and plain_text)', () => {
    const out = flattenBlocks([{ type: 'section', text: { type: 'mrkdwn', text: '*Status*' }, fields: [{ type: 'plain_text', text: 'a *b*' }, { type: 'mrkdwn', text: '<@UALICEAAAAA>' }] }], resolve)
    expect(out.text).toBe('Status\na *b*\n@Alice Souza')
    expect(out.mentions).toEqual(['UALICEAAAAA'])
    expect(out.warnings).toEqual([])
  })

  it('header is strong; context joins texts and labels images; image is [imagem: alt] + its link', () => {
    const out = flattenBlocks(
      [
        { type: 'header', text: { type: 'plain_text', text: 'Título' } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: 'por _Alice_' }, { type: 'image', image_url: 'https://ex.com/a.png', alt_text: 'avatar' }] },
        { type: 'image', image_url: 'https://ex.com/grafico.png', alt_text: 'gráfico' },
      ],
      resolve,
    )
    expect(out.rich).toEqual([
      { t: 'p', children: [{ t: 'strong', children: [{ t: 'text', text: 'Título' }] }] },
      { t: 'p', children: [{ t: 'text', text: 'por ' }, { t: 'em', children: [{ t: 'text', text: 'Alice' }] }, { t: 'text', text: ' [imagem: avatar]' }] },
      { t: 'p', children: [{ t: 'text', text: '[imagem: gráfico] ' }, { t: 'link', href: 'https://ex.com/grafico.png', children: [{ t: 'text', text: 'https://ex.com/grafico.png' }] }] },
    ])
  })

  it('rich_text 1:1: styles, links, people, conversations, emoji, lists, preformatted, quote', () => {
    const out = flattenBlocks(
      [
        {
          type: 'rich_text',
          elements: [
            {
              type: 'rich_text_section',
              elements: [
                { type: 'text', text: 'oi ', style: { bold: true } },
                { type: 'user', user_id: 'UALICEAAAAA' },
                { type: 'text', text: ' em ' },
                { type: 'channel', channel_id: 'CGENERALAAA' },
                { type: 'emoji', name: 'tada' },
                { type: 'link', url: 'https://ex.com', text: 'aqui' },
                { type: 'text', text: 'x', style: { code: true } },
              ],
            },
            { type: 'rich_text_list', style: 'ordered', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'um' }] }] },
            { type: 'rich_text_preformatted', elements: [{ type: 'text', text: 'npm test' }] },
            { type: 'rich_text_quote', elements: [{ type: 'text', text: 'citado' }] },
          ],
        },
      ],
      resolve,
    )
    expect(out.rich).toEqual([
      {
        t: 'p',
        children: [
          { t: 'strong', children: [{ t: 'text', text: 'oi ' }] },
          { t: 'text', text: '@Alice Souza' },
          { t: 'text', text: ' em ' },
          { t: 'text', text: '#geral' },
          { t: 'text', text: '🎉' },
          { t: 'link', href: 'https://ex.com', children: [{ t: 'text', text: 'aqui' }] },
          { t: 'code', text: 'x' },
        ],
      },
      { t: 'ol', items: [[{ t: 'p', children: [{ t: 'text', text: 'um' }] }]] },
      { t: 'codeblock', text: 'npm test' },
      { t: 'quote', children: [{ t: 'p', children: [{ t: 'text', text: 'citado' }] }] },
    ])
    expect(out.mentions).toEqual(['UALICEAAAAA'])
  })

  it('divider dropped; actions, inputs, accessories and unknown types warned once each', () => {
    const out = flattenBlocks(
      [
        { type: 'divider' },
        { type: 'actions', elements: [] },
        { type: 'actions', elements: [] },
        { type: 'input', element: { type: 'plain_text_input' } },
        { type: 'section', text: { type: 'mrkdwn', text: 'escolha' }, accessory: { type: 'button' } },
        { type: 'video' },
      ],
      resolve,
    )
    expect(out.text).toBe('escolha')
    expect(out.rich).toBeUndefined()
    expect(out.warnings).toEqual(['blocks_unsupported:actions', 'blocks_unsupported:input', 'blocks_unsupported:button', 'blocks_unsupported:video'])
  })

  it('a prototype key is not a block function', () => {
    expect(flattenBlocks([{ type: 'constructor' }, { type: '__proto__' }], resolve).warnings).toEqual(['blocks_unsupported:constructor', 'blocks_unsupported:__proto__'])
  })
})

describe('flattenBlocks — the markdown block', () => {
  const md = (text: unknown, over: Record<string, unknown> = {}) => ({ type: 'markdown', text, ...over })
  const BOLD_LIST = [
    { t: 'p', children: [{ t: 'strong', children: [{ t: 'text', text: 'bold' }] }, { t: 'text', text: ' and' }] },
    { t: 'ul', items: [[{ t: 'p', children: [{ t: 'text', text: 'one' }] }], [{ t: 'p', children: [{ t: 'text', text: 'two' }] }]] },
  ]

  it('standard Markdown: bold and a list, with no warning; block_id is ignored', () => {
    const out = flattenBlocks([md('**bold** and\n- one\n- two', { block_id: 'b1' })], resolve)
    expect(out.rich).toEqual(BOLD_LIST)
    expect(out.text).toBe('bold and\n\n- one\n- two')
    expect(out.warnings).toEqual([])
  })

  it('a mrkdwn section then a markdown block: both, in order', () => {
    const out = flattenBlocks([{ type: 'section', text: { type: 'mrkdwn', text: '*first*' } }, md('**second**')], resolve)
    expect(out.rich).toEqual([
      { t: 'p', children: [{ t: 'strong', children: [{ t: 'text', text: 'first' }] }] },
      { t: 'p', children: [{ t: 'strong', children: [{ t: 'text', text: 'second' }] }] },
    ])
    expect(out.text).toBe('first\n\nsecond')
  })

  it('<@U…> and <#C…> outside code are resolved as in mrkdwn; inside a code span or a fenced block they stay literal', () => {
    const out = flattenBlocks([md('hi <@UALICEAAAAA> in <#CGENERALAAA|x>, not `<@UALICEAAAAA>`\n```\n<#CGENERALAAA>\n```\n<@UNOBODYAAAA|someone>')], resolve)
    expect(out.rich).toEqual([
      { t: 'p', children: [{ t: 'text', text: 'hi @Alice Souza in #geral, not ' }, { t: 'code', text: '<@UALICEAAAAA>' }] },
      { t: 'codeblock', text: '<#CGENERALAAA>' },
      { t: 'p', children: [{ t: 'text', text: '@someone' }] },
    ])
    expect(out.mentions).toEqual(['UALICEAAAAA'])
  })

  it('plain Markdown (no formatting) is a plain body with its mention', () => {
    const out = flattenBlocks([md('oi <@UALICEAAAAA>')], resolve)
    expect(out).toEqual({ text: 'oi @Alice Souza', mentions: ['UALICEAAAAA'], warnings: [] })
  })

  it('a heading and a table come out as parseCompose renders them (strong line, code block)', () => {
    const source = '# Report\n\n| a | b |\n|---|---|\n| 1 | 2 |'
    const out = flattenBlocks([md(source)], resolve)
    expect(out.rich).toEqual(parseCompose(source).rich)
    expect(out.rich).toEqual([
      { t: 'p', children: [{ t: 'strong', children: [{ t: 'text', text: 'Report' }] }] },
      { t: 'codeblock', text: '| a | b |\n|---|---|\n| 1 | 2 |' },
    ])
  })

  it('a missing, non-string or blank text contributes nothing and warns nothing', () => {
    expect(flattenBlocks([md(undefined), md(42), md('  \n ')], resolve)).toEqual({ text: '', mentions: [], warnings: [] })
  })
})
