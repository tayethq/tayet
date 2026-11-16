import { describe, it, expect } from 'vitest'
import type { RichDoc } from '@tayet/shared'
import { mrkdwnToRich, richToMrkdwn, type MrkdwnResolve } from '../../src/api/slack/mrkdwn'

// mrkdwn ↔ rich (PLANO-AGENTES §0.3.12 item 4): a table of cases, both ways.

const AGENT = 'UAGENTAAAAA'
const ALICE = 'UALICEAAAAA'
const resolve: MrkdwnResolve = {
  person: (id) => ({ [AGENT]: 'Relatórios', [ALICE]: 'Alice Souza', UNONAMEAAAA: '' })[id],
  conversation: (id) => (id === 'CGENERALAAA' ? 'geral' : undefined),
}
const p = (...children: RichDoc[number] extends infer B ? (B extends { t: 'p'; children: infer C } ? C : never) : never): RichDoc => [{ t: 'p', children }]

describe('mrkdwn → rich', () => {
  it.each<[string, string, { text: string; rich?: RichDoc; mentions?: string[] }]>([
    ['plain text stays plain (no rich)', 'bom dia', { text: 'bom dia' }],
    ['escapes', 'a &amp; b &lt;c&gt;', { text: 'a & b <c>' }],
    ['bold', 'é *urgente* hoje', { text: 'é urgente hoje', rich: p({ t: 'text', text: 'é ' }, { t: 'strong', children: [{ t: 'text', text: 'urgente' }] }, { t: 'text', text: ' hoje' }) }],
    ['italic and strike', '_já_ ~não~', { text: 'já não', rich: p({ t: 'em', children: [{ t: 'text', text: 'já' }] }, { t: 'text', text: ' ' }, { t: 'strike', children: [{ t: 'text', text: 'não' }] }) }],
    ['nested', '*a _b_*', { text: 'a b', rich: p({ t: 'strong', children: [{ t: 'text', text: 'a ' }, { t: 'em', children: [{ t: 'text', text: 'b' }] }] }) }],
    ['no emphasis inside a word', 'snake_case_name', { text: 'snake_case_name' }],
    ['an unclosed marker is text', '*sozinho', { text: '*sozinho' }],
    ['inline code keeps its markers', 'rode `npm run *build*`', { text: 'rode npm run *build*', rich: p({ t: 'text', text: 'rode ' }, { t: 'code', text: 'npm run *build*' }) }],
    ['a link with a label', 'veja <https://ex.com/a?b=1&amp;c=2|o painel>', { text: 'veja o painel', rich: p({ t: 'text', text: 'veja ' }, { t: 'link', href: 'https://ex.com/a?b=1&c=2', children: [{ t: 'text', text: 'o painel' }] }) }],
    ['a bare link', '<https://ex.com>', { text: 'https://ex.com', rich: p({ t: 'link', href: 'https://ex.com', children: [{ t: 'text', text: 'https://ex.com' }] }) }],
    ['another scheme is text', '<javascript:alert(1)|clique>', { text: 'clique' }],
    ['a mention: the name in the body, the token in mentions', 'oi <@UALICEAAAAA>, tudo?', { text: 'oi @Alice Souza, tudo?', mentions: [ALICE] }],
    ['a mention with a label and no name', '<@UNONAMEAAAA|fulano>', { text: '@fulano', mentions: ['UNONAMEAAAA'] }],
    ['an unknown person is text, not a mention', '<@UNOBODYAAAA|ninguém>', { text: '@ninguém', mentions: [] }],
    ['a conversation', 'em <#CGENERALAAA>', { text: 'em #geral' }],
    ['a conversation with a label', 'em <#COTHERAAAAA|outra>', { text: 'em #outra' }],
    ['special mentions', '<!here> e <!channel>', { text: '@here e @channel' }],
    ['a date with a fallback', '<!date^1730000000^{date}|ontem>', { text: 'ontem' }],
    ['two paragraphs; a newline stays inside', 'a\nb\n\nc', { text: 'a\nb\n\nc', rich: [{ t: 'p', children: [{ t: 'text', text: 'a\nb' }] }, { t: 'p', children: [{ t: 'text', text: 'c' }] }] }],
    ['a code block', '```\nconst x = 1 *2*\n```', { text: 'const x = 1 *2*', rich: [{ t: 'codeblock', text: 'const x = 1 *2*' }] }],
    ['a one-line code block', '```ls -la```', { text: 'ls -la', rich: [{ t: 'codeblock', text: 'ls -la' }] }],
    ['a quote (escaped or not)', '&gt; citado\n> também\ndepois', { text: '> citado\n> também\n\ndepois', rich: [{ t: 'quote', children: [{ t: 'p', children: [{ t: 'text', text: 'citado\ntambém' }] }] }, { t: 'p', children: [{ t: 'text', text: 'depois' }] }] }],
  ])('%s', (_what, source, expected) => {
    const parsed = mrkdwnToRich(source, resolve)
    expect(parsed.text).toBe(expected.text)
    expect(parsed.rich).toEqual(expected.rich)
    expect(parsed.mentions).toEqual(expected.mentions ?? [])
  })
})

describe('rich → mrkdwn (reads)', () => {
  it.each<[string, string, RichDoc | undefined, string[], string]>([
    ['plain text is escaped', 'a & <b>', undefined, [], 'a &amp; &lt;b&gt;'],
    ['formatting', 'x', p({ t: 'strong', children: [{ t: 'text', text: 'a' }] }, { t: 'text', text: ' ' }, { t: 'em', children: [{ t: 'text', text: 'b' }] }, { t: 'text', text: ' ' }, { t: 'strike', children: [{ t: 'text', text: 'c' }] }, { t: 'text', text: ' ' }, { t: 'code', text: 'd' }), [], '*a* _b_ ~c~ `d`'],
    ['links', 'x', p({ t: 'link', href: 'https://ex.com', children: [{ t: 'text', text: 'site' }] }, { t: 'text', text: ' ' }, { t: 'link', href: 'https://ex.com', children: [{ t: 'text', text: 'https://ex.com' }] }), [], '<https://ex.com|site> <https://ex.com>'],
    ['lists, quote, code block', 'x', [{ t: 'ul', items: [[{ t: 'p', children: [{ t: 'text', text: 'um' }] }], [{ t: 'p', children: [{ t: 'text', text: 'dois' }] }]] }, { t: 'ol', items: [[{ t: 'p', children: [{ t: 'text', text: 'três' }] }]] }, { t: 'quote', children: [{ t: 'p', children: [{ t: 'text', text: 'q' }] }] }, { t: 'codeblock', text: 'c' }], [], '• um\n• dois\n\n1. três\n\n> q\n\n```\nc\n```'],
    ['a mention replaces the first @name', 'oi @Alice Souza e @Alice Souza', undefined, [ALICE], 'oi <@UALICEAAAAA> e @Alice Souza'],
    ['the agent mentioned → <@U_agent>', '@Relatórios pode ver?', undefined, [AGENT], '<@UAGENTAAAAA> pode ver?'],
    ['a name not in the body → prefixed', 'olá', undefined, [ALICE], '<@UALICEAAAAA> olá'],
    ['no current name → prefixed', '@fulano oi', undefined, ['UNONAMEAAAA'], '<@UNONAMEAAAA> @fulano oi'],
  ])('%s', (_what, text, rich, mentions, expected) => {
    expect(richToMrkdwn(text, rich, mentions, resolve)).toBe(expected)
  })
})

describe('round trip', () => {
  it.each(['é *urgente* hoje', '_já_ ~não~ `x`', 'veja <https://ex.com/a|o painel>', 'oi <@UALICEAAAAA>, tudo?', 'a &amp; b', '```\ncode\n```', '&gt; citado'])('%s', (source) => {
    const parsed = mrkdwnToRich(source, resolve)
    const back = richToMrkdwn(parsed.text, parsed.rich, parsed.mentions, resolve)
    expect(mrkdwnToRich(back, resolve)).toEqual(parsed)
  })
})
