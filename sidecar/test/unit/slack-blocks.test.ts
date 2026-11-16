import { describe, it, expect } from 'vitest'
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
