import { describe, it, expect } from 'vitest'
import { parseCompose } from '../src/markdown'
import type { RichDoc } from '../src/domain'

// Commit 7 (ADR-012): the compose-side markdown → RichDoc parser. Plain text stays plain (no rich);
// formatting produces the bounded node set. Pure presentation — the ACL re-sanitizes on serialize.

describe('parseCompose — plain stays plain', () => {
  it('returns no rich for unformatted text (byte-for-byte plain path)', () => {
    expect(parseCompose('just text')).toEqual({ text: 'just text' })
    expect(parseCompose('hello world, no markers')).not.toHaveProperty('rich')
  })
})

describe('parseCompose — inline formatting', () => {
  it('parses bold/italic/strike/code/link', () => {
    const r = parseCompose('a **b** *i* ~~s~~ `c` [x](https://h)')
    expect(r.text).toBe('a **b** *i* ~~s~~ `c` [x](https://h)')
    expect(r.rich).toEqual<RichDoc>([
      {
        t: 'p',
        children: [
          { t: 'text', text: 'a ' },
          { t: 'strong', children: [{ t: 'text', text: 'b' }] },
          { t: 'text', text: ' ' },
          { t: 'em', children: [{ t: 'text', text: 'i' }] },
          { t: 'text', text: ' ' },
          { t: 'strike', children: [{ t: 'text', text: 's' }] },
          { t: 'text', text: ' ' },
          { t: 'code', text: 'c' },
          { t: 'text', text: ' ' },
          { t: 'link', href: 'https://h', children: [{ t: 'text', text: 'x' }] },
        ],
      },
    ])
  })

  it('drops a dangerous link scheme, keeping the visible text', () => {
    const r = parseCompose('[x](javascript:alert(1))')
    // javascript: is not a safe scheme → no link node; but formatting was attempted, so rich is set
    // only if something else made it rich. Here the only content is plain text → no rich.
    expect(r.rich).toBeUndefined()
    expect(r.text).toBe('[x](javascript:alert(1))')
  })
})

describe('parseCompose — block formatting', () => {
  it('parses fenced code blocks with a language', () => {
    const r = parseCompose('```ts\nconst x = 1\n```')
    expect(r.rich).toEqual<RichDoc>([{ t: 'codeblock', text: 'const x = 1', lang: 'ts' }])
  })

  it('parses bullet and numbered lists', () => {
    expect(parseCompose('- one\n- two').rich).toEqual<RichDoc>([
      {
        t: 'ul',
        items: [[{ t: 'p', children: [{ t: 'text', text: 'one' }] }], [{ t: 'p', children: [{ t: 'text', text: 'two' }] }]],
      },
    ])
    expect(parseCompose('1. a\n2. b').rich?.[0]?.t).toBe('ol')
  })

  it('parses a blockquote', () => {
    expect(parseCompose('> quoted').rich).toEqual<RichDoc>([
      { t: 'quote', children: [{ t: 'p', children: [{ t: 'text', text: 'quoted' }] }] },
    ])
  })
})

// PLANO-AGENTES §0.3.15 item 3: degradation with no new node, and hardening for agent (LLM) text.
const t = (text: string) => ({ t: 'text' as const, text })

describe('parseCompose — degradation (no new node)', () => {
  it('a heading #…###### at line start → a paragraph with one strong holding the text', () => {
    for (const h of ['#', '##', '###', '####', '#####', '######']) {
      expect(parseCompose(`${h} Título`).rich, h).toEqual<RichDoc>([{ t: 'p', children: [{ t: 'strong', children: [t('Título')] }] }])
    }
    expect(parseCompose('## Fecho ##').rich).toEqual<RichDoc>([{ t: 'p', children: [{ t: 'strong', children: [t('Fecho')] }] }])
  })

  it('the heading text is kept verbatim inside the one strong (no inline parse)', () => {
    expect(parseCompose('# um *dois* `três`').rich).toEqual<RichDoc>([{ t: 'p', children: [{ t: 'strong', children: [t('um *dois* `três`')] }] }])
  })

  it('not a heading: #hashtag, 7 hashes, a lone #', () => {
    expect(parseCompose('#hashtag').rich).toBeUndefined()
    expect(parseCompose('####### sete').rich).toBeUndefined()
    expect(parseCompose('#').rich).toBeUndefined()
  })

  it('a GFM table (header row + separator) → a code block without lang, rows verbatim', () => {
    const table = '| a | b |\n|---|:-:|\n| 1 | 2 |\n| 3 | 4 |'
    expect(parseCompose(table).rich).toEqual<RichDoc>([{ t: 'codeblock', text: table }])
    expect(parseCompose(`antes\n\n${table}\n\ndepois`).rich).toEqual<RichDoc>([
      { t: 'p', children: [t('antes')] },
      { t: 'codeblock', text: table },
      { t: 'p', children: [t('depois')] },
    ])
  })

  it('a pipe line without a separator row is not a table', () => {
    expect(parseCompose('a | b\nc | d').rich).toBeUndefined()
    expect(parseCompose('a | b\n---').rich).toBeUndefined()
  })
})

describe('parseCompose — hardening', () => {
  it('intraword _ / __ neither opens nor closes emphasis', () => {
    for (const s of ['snake_case', 'a_b_c', 'my_var_name here', '__init__', 'call __init__ now', 'foo__bar__baz'])
      expect(parseCompose(s), s).toEqual({ text: s })
  })

  it('a URL with _ (bare or as link text) stays literal', () => {
    expect(parseCompose('veja https://exemplo.com/a_b_c/_x_ ok')).toEqual({ text: 'veja https://exemplo.com/a_b_c/_x_ ok' })
    expect(parseCompose('em https://exemplo.com/*a*').rich).toBeUndefined()
  })

  it('_italic_ and __two words__ still work at word boundaries', () => {
    expect(parseCompose('um _itálico_ aqui').rich).toEqual<RichDoc>([{ t: 'p', children: [t('um '), { t: 'em', children: [t('itálico')] }, t(' aqui')] }])
    expect(parseCompose('__duas palavras__').rich).toEqual<RichDoc>([{ t: 'p', children: [{ t: 'strong', children: [t('duas palavras')] }] }])
  })

  it('* surrounded by spaces does not open emphasis', () => {
    expect(parseCompose('2 * 3 * 4')).toEqual({ text: '2 * 3 * 4' })
    expect(parseCompose('a ** b ** c')).toEqual({ text: 'a ** b ** c' })
    expect(parseCompose('x *y*').rich).toEqual<RichDoc>([{ t: 'p', children: [t('x '), { t: 'em', children: [t('y')] }] }])
  })

  it('never an empty code node', () => {
    expect(parseCompose('a `` b')).toEqual({ text: 'a `` b' })
    expect(JSON.stringify(parseCompose('x `` `y`').rich)).not.toContain('"text":""')
    expect(parseCompose('x `` `y`').rich).toEqual<RichDoc>([{ t: 'p', children: [t('x `` '), { t: 'code', text: 'y' }] }])
  })

  it('an indented fence (up to 3 spaces) is a code block', () => {
    expect(parseCompose('   ```js\n   const a = 1\n   ```').rich).toEqual<RichDoc>([{ t: 'codeblock', text: 'const a = 1', lang: 'js' }])
    expect(parseCompose('  ```\n  x\n```').rich).toEqual<RichDoc>([{ t: 'codeblock', text: 'x' }])
  })

  it('an image ![alt](url) stays literal text, no link to the image', () => {
    expect(parseCompose('![gato](https://exemplo.com/g.png)')).toEqual({ text: '![gato](https://exemplo.com/g.png)' })
    expect(parseCompose('veja ![a](https://exemplo.com/a.png) e **b**').rich).toEqual<RichDoc>([
      { t: 'p', children: [t('veja ![a](https://exemplo.com/a.png) e '), { t: 'strong', children: [t('b')] }] },
    ])
  })

  it('balanced parentheses in a link href are kept (A_(b) is not truncated)', () => {
    expect(parseCompose('[wiki](https://exemplo.com/wiki/A_(b)) fim').rich).toEqual<RichDoc>([
      { t: 'p', children: [{ t: 'link', href: 'https://exemplo.com/wiki/A_(b)', children: [t('wiki')] }, t(' fim')] },
    ])
  })

  it('unchanged: task list, bare autolink, <url>, inline HTML, a single line break', () => {
    expect(parseCompose('- [ ] tarefa').rich).toEqual<RichDoc>([{ t: 'ul', items: [[{ t: 'p', children: [t('[ ] tarefa')] }]] }])
    expect(parseCompose('https://exemplo.com')).toEqual({ text: 'https://exemplo.com' })
    expect(parseCompose('<https://exemplo.com>')).toEqual({ text: '<https://exemplo.com>' })
    expect(parseCompose('a <b>x</b>')).toEqual({ text: 'a <b>x</b>' })
    expect(parseCompose('linha 1\n**linha 2**').rich).toEqual<RichDoc>([
      { t: 'p', children: [t('linha 1'), t('\n'), { t: 'strong', children: [t('linha 2')] }] },
    ])
  })
})

describe('parseCompose — a typical LLM answer', () => {
  it('heading, list, table and code degrade into the bounded node set', () => {
    const md = [
      '## Resumo',
      '',
      'O deploy de **hoje** tem três passos:',
      '',
      '1. rodar `npm ci`',
      '2. checar o `snake_case_flag`',
      '3. publicar',
      '',
      '| passo | tempo |',
      '|-------|------:|',
      '| build | 2 min |',
      '',
      '```bash',
      'npm run build',
      '```',
    ].join('\n')
    expect(parseCompose(md).rich).toEqual<RichDoc>([
      { t: 'p', children: [{ t: 'strong', children: [t('Resumo')] }] },
      { t: 'p', children: [t('O deploy de '), { t: 'strong', children: [t('hoje')] }, t(' tem três passos:')] },
      {
        t: 'ol',
        items: [
          [{ t: 'p', children: [t('rodar '), { t: 'code', text: 'npm ci' }] }],
          [{ t: 'p', children: [t('checar o '), { t: 'code', text: 'snake_case_flag' }] }],
          [{ t: 'p', children: [t('publicar')] }],
        ],
      },
      { t: 'codeblock', text: '| passo | tempo |\n|-------|------:|\n| build | 2 min |' },
      { t: 'codeblock', text: 'npm run build', lang: 'bash' },
    ])
  })
})
