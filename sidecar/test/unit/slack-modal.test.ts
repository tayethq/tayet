import { describe, it, expect } from 'vitest'
import type { FormField } from '@tayet/shared'
import { blocksOf, compose, formOfModal, idsOf, split, stateValuesOf, viewOf } from '../../src/api/slack/modal'
import type { BlockResolve } from '../../src/api/slack/blocks'
import { SlackError } from '../../src/api/slack/errors'

// A Slack modal ↔ an agent's form: the translation block by block with each refusal and its code, the limits, the
// composed field id, the rebuilt blocks and the shape of `state.values` per element.

const resolve: BlockResolve = { person: (id) => (id === 'UALICEAAAAA' ? 'Alice' : undefined), conversation: () => undefined, emoji: () => undefined }
const t = (text: string) => ({ type: 'plain_text', text })
const modal = (blocks: unknown[], over: Record<string, unknown> = {}) => ({ type: 'modal', title: t('Editar'), submit: t('Salvar'), blocks, ...over })
const input = (element: Record<string, unknown>, over: Record<string, unknown> = {}) => ({ type: 'input', block_id: 'b', label: t('Rótulo'), element: { action_id: 'a', ...element }, ...over })

const run = (view: unknown) => {
  const dropped: string[] = []
  return { form: formOfModal(view, resolve, (k) => dropped.push(k)), dropped }
}
const codeOf = (view: unknown): string => {
  try {
    run(view)
    return 'ok'
  } catch (err) {
    return err instanceof SlackError ? err.code : String(err)
  }
}

describe('the composed field id', () => {
  it('block_id and action_id with a length prefix, no escape; back again', () => {
    expect(compose('release', 'why')).toBe('7:releasewhy')
    expect(split('7:releasewhy')).toEqual(['release', 'why'])
    expect(split(compose('a:b"c', '9:x'))).toEqual(['a:b"c', '9:x'])
    expect(split(compose('ção', 'é'))).toEqual(['ção', 'é'])
    expect(split('no-prefix')).toBeUndefined()
    expect(split('9:short')).toBeUndefined()
    expect(idsOf(compose('', 'x'))).toEqual(['', 'x'])
  })

  it('an absent block_id or action_id is positional; ids that do not fit in 255 → invalid_blocks', () => {
    const { form } = run(modal([{ type: 'section', text: t('Leia') }, { type: 'input', label: t('A'), element: { type: 'plain_text_input' } }, input({ type: 'plain_text_input' })]))
    expect(form.fields.map((f) => (f.kind === 'context' ? 'context' : idsOf(f.id)))).toEqual(['context', ['b1', 'a1'], ['b', 'a']])
    expect(codeOf(modal([input({ type: 'plain_text_input', action_id: 'x'.repeat(200) }, { block_id: 'y'.repeat(60) })]))).toBe('invalid_blocks')
    expect(codeOf(modal([input({ type: 'plain_text_input', action_id: 'x'.repeat(200) }, { block_id: 'y'.repeat(50) })]))).toBe('ok')
  })
})

describe('inputs', () => {
  it('each element type, with the attributes that pass', () => {
    const opts = [{ text: t('Um'), value: '1' }, { text: { type: 'mrkdwn', text: '*Dois*' }, value: '2', description: t('o segundo') }]
    const { form } = run(
      modal([
        input({ type: 'plain_text_input', placeholder: t('Escreva'), initial_value: 'oi', min_length: 2, max_length: 50 }, { block_id: 'b1', hint: t('Dica'), optional: true }),
        input({ type: 'plain_text_input', multiline: true }, { block_id: 'b2' }),
        input({ type: 'number_input', is_decimal_allowed: true, min_value: '0', max_value: '9.5', initial_value: '1.5' }, { block_id: 'b3' }),
        input({ type: 'email_text_input', initial_value: 'a@b.co' }, { block_id: 'b4' }),
        input({ type: 'url_text_input' }, { block_id: 'b5' }),
        input({ type: 'static_select', options: opts, initial_option: opts[0] }, { block_id: 'b6' }),
        input({ type: 'multi_static_select', option_groups: [{ label: t('G'), options: opts }], initial_options: [opts[1]], max_selected_items: 2 }, { block_id: 'b7' }),
        input({ type: 'radio_buttons', options: opts, initial_option: opts[1] }, { block_id: 'b8' }),
        input({ type: 'checkboxes', options: opts, initial_options: opts }, { block_id: 'b9' }),
        input({ type: 'datepicker', initial_date: '2026-11-17' }, { block_id: 'b10' }),
      ]),
    )
    const kinds = form.fields.map((f) => f.kind)
    expect(kinds).toEqual(['text', 'longText', 'number', 'email', 'url', 'select', 'multiSelect', 'radio', 'checkboxes', 'date'])
    expect(form.fields[0]).toEqual({ id: '2:b1a', label: 'Rótulo', hint: 'Dica', optional: true, kind: 'text', placeholder: 'Escreva', minLength: 2, maxLength: 50, initial: 'oi' })
    expect(form.fields[2]).toMatchObject({ kind: 'number', decimal: true, min: '0', max: '9.5', initial: '1.5' })
    expect(form.fields[5]).toMatchObject({ kind: 'select', choices: { options: [{ value: '1', label: 'Um' }, { value: '2', label: 'Dois', description: 'o segundo' }] }, initial: '1' })
    expect(form.fields[6]).toMatchObject({ kind: 'multiSelect', choices: { groups: [{ label: 'G' }] }, maxSelected: 2, initial: ['2'] })
    expect(form.fields[8]).toMatchObject({ kind: 'checkboxes', initial: ['1', '2'] })
    expect(form.fields[9]).toMatchObject({ kind: 'date', initial: '2026-11-17' })
  })

  it('refused with invalid_blocks: the elements of the cut, dispatch_action, other block types, a repeated block_id', () => {
    for (const type of ['users_select', 'multi_users_select', 'conversations_select', 'multi_conversations_select', 'channels_select', 'multi_channels_select', 'external_select', 'multi_external_select', 'timepicker', 'datetimepicker', 'rich_text_input', 'file_input', 'nope']) {
      expect([type, codeOf(modal([input({ type })]))]).toEqual([type, 'invalid_blocks'])
    }
    expect(codeOf(modal([input({ type: 'plain_text_input' }, { dispatch_action: true })]))).toBe('invalid_blocks')
    expect(codeOf(modal([{ type: 'actions', elements: [] }]))).toBe('invalid_blocks')
    expect(codeOf(modal([{ type: 'video' }]))).toBe('invalid_blocks')
    expect(codeOf(modal([{ type: 'section', text: t('x'), accessory: { type: 'button' } }]))).toBe('invalid_blocks')
    expect(codeOf(modal([input({ type: 'plain_text_input' }), input({ type: 'plain_text_input' })]))).toBe('invalid_blocks')
    expect(codeOf(modal([{ type: 'section', block_id: 'b', text: t('x') }, input({ type: 'plain_text_input' })]))).toBe('invalid_blocks')
    expect(codeOf(modal(Array.from({ length: 101 }, () => ({ type: 'divider' }))))).toBe('invalid_blocks')
  })

  it('more than 25 fields after neighbouring texts join → invalid_blocks; 30 texts and 5 inputs in a run fit', () => {
    const many = Array.from({ length: 26 }, (_, i) => input({ type: 'plain_text_input', action_id: `a${i}` }, { block_id: `b${i}` }))
    expect(codeOf(modal(many))).toBe('invalid_blocks')
    const texts = Array.from({ length: 30 }, (_, i) => ({ type: 'context', elements: [t(`t${i}`)] }))
    const { form } = run(modal([...texts, ...many.slice(0, 5)]))
    expect(form.fields).toHaveLength(6)
    expect(form.fields[0]).toMatchObject({ kind: 'context' })
  })
})

describe('texts', () => {
  it('section (text and fields), context, header, rich_text, markdown and image join into one field; divider is dropped with a line', () => {
    const { form, dropped } = run(
      modal([
        { type: 'header', text: t('Título') },
        { type: 'section', text: { type: 'mrkdwn', text: 'Olá <@UALICEAAAAA>' }, fields: [t('f1')] },
        { type: 'divider' },
        { type: 'image', image_url: 'https://x.test/a.png', alt_text: 'gráfico' },
        input({ type: 'plain_text_input' }),
        { type: 'markdown', text: 'depois' },
      ]),
    )
    expect(dropped).toEqual(['divider'])
    expect(form.fields.map((f) => f.kind)).toEqual(['context', 'text', 'context'])
    const first = form.fields[0] as Extract<FormField, { kind: 'context' }>
    expect(first.text).toContain('Título')
    expect(first.text).toContain('Olá @Alice')
    expect(first.text).toContain('[imagem: gráfico]')
    expect(first.text).not.toContain('https://')
  })
})

describe('the view', () => {
  it('invalid_arguments: type, title, submit, close, private_metadata, callback_id', () => {
    const ok = [input({ type: 'plain_text_input' })]
    expect(codeOf(modal(ok, { type: 'home' }))).toBe('invalid_arguments')
    expect(codeOf(modal(ok, { title: undefined }))).toBe('invalid_arguments')
    expect(codeOf(modal(ok, { title: t('x'.repeat(25)) }))).toBe('invalid_arguments')
    expect(codeOf(modal(ok, { title: { type: 'mrkdwn', text: 'x' } }))).toBe('invalid_arguments')
    expect(codeOf(modal(ok, { submit: undefined }))).toBe('invalid_arguments')
    expect(codeOf(modal(ok, { submit: t('x'.repeat(25)) }))).toBe('invalid_arguments')
    expect(codeOf(modal(ok, { close: t('x'.repeat(25)) }))).toBe('invalid_arguments')
    expect(codeOf(modal(ok, { private_metadata: 'x'.repeat(3001) }))).toBe('invalid_arguments')
    expect(codeOf(modal(ok, { callback_id: 'x'.repeat(256) }))).toBe('invalid_arguments')
    expect(codeOf(modal(ok, { title: t('x'.repeat(24)), submit: t('y'.repeat(24)), close: t('z'.repeat(24)), private_metadata: 'p'.repeat(3000), callback_id: 'c'.repeat(255) }))).toBe('ok')
    expect(codeOf({ type: 'modal', title: t('a'), submit: t('b') })).toBe('invalid_arguments')
  })

  it('dropped with one line each, without content: notify_on_close, clear_on_close, external_id, focus_on_load; a valid close with none', () => {
    const { form, dropped } = run(modal([input({ type: 'plain_text_input', focus_on_load: true })], { notify_on_close: true, clear_on_close: true, external_id: 'ext-1', close: t('Fechar'), private_metadata: 'pm', callback_id: 'cb' }))
    expect(dropped.sort()).toEqual(['clear_on_close', 'external_id', 'focus_on_load', 'notify_on_close'])
    expect(form).toMatchObject({ title: 'Editar', submitLabel: 'Salvar', privateMetadata: 'pm', callbackId: 'cb' })
  })

  it('blocks rebuilt from the form, and id and hash derived from the conversation and the definition', () => {
    const { form } = run(modal([{ type: 'section', text: t('Leia') }, input({ type: 'static_select', options: [{ text: t('Um'), value: '1' }], initial_option: { text: t('Um'), value: '1' } }, { optional: true })]))
    const blocks = blocksOf(form.fields, resolve)
    expect(blocks[0]).toEqual({ type: 'section', text: { type: 'mrkdwn', text: 'Leia' } })
    expect(blocks[1]).toMatchObject({ type: 'input', block_id: 'b', optional: true, element: { type: 'static_select', action_id: 'a', options: [{ value: '1' }], initial_option: { value: '1' } } })
    const parts = { conversation: 'CGENERALAAA', form: '1732100001.000200', title: 'T', submitLabel: 'S', blocks, privateMetadata: 'p', callbackId: 'c', team: 'TWORKSPACEA', bot: 'BAGENTAAAAA' }
    const a = viewOf(parts)
    expect(viewOf(parts)).toEqual(a)
    expect(a.id).toMatch(/^V[0-9A-F]{10}$/)
    expect(a.hash).toMatch(/^1732100001\.[0-9a-f]{8}$/)
    expect(viewOf({ ...parts, form: '1732100002.000200' }).id).not.toBe(a.id)
    expect(a).toMatchObject({ type: 'modal', private_metadata: 'p', callback_id: 'c', state: { values: {} }, root_view_id: a.id, app_id: 'BAGENTAAAAA' })
  })
})

describe('state.values', () => {
  const opt = (v: string) => ({ value: v, label: v.toUpperCase() })
  const fields: FormField[] = [
    { kind: 'context', text: 'x' },
    { kind: 'text', id: compose('b1', 'a'), label: 'L', optional: true, minLength: 0, maxLength: 3000 },
    { kind: 'longText', id: compose('b2', 'a'), label: 'L', optional: true, minLength: 0, maxLength: 3000 },
    { kind: 'number', id: compose('b3', 'a'), label: 'L', optional: true, decimal: false },
    { kind: 'email', id: compose('b4', 'a'), label: 'L', optional: true },
    { kind: 'url', id: compose('b5', 'a'), label: 'L', optional: true },
    { kind: 'date', id: compose('b6', 'a'), label: 'L', optional: true },
    { kind: 'select', id: compose('b7', 'a'), label: 'L', optional: true, choices: { groups: [{ label: 'G', options: [opt('x'), opt('y')] }] } },
    { kind: 'multiSelect', id: compose('b8', 'a'), label: 'L', optional: true, choices: { options: [opt('x'), opt('y')] } },
    { kind: 'radio', id: compose('b9', 'a'), label: 'L', optional: true, options: [opt('x')] },
    { kind: 'checkboxes', id: compose('b10', 'a'), label: 'L', optional: true, options: [opt('x'), opt('y')] },
  ]
  const sel = (v: string) => ({ text: { type: 'plain_text', text: v.toUpperCase(), emoji: true }, value: v })

  it('each element in the shape Slack gives it', () => {
    const values = stateValuesOf(fields, { [compose('b1', 'a')]: 'oi', [compose('b2', 'a')]: 'longo', [compose('b3', 'a')]: '7', [compose('b4', 'a')]: 'a@b.co', [compose('b5', 'a')]: 'https://x.test', [compose('b6', 'a')]: '2026-11-17', [compose('b7', 'a')]: 'y', [compose('b8', 'a')]: ['x', 'y'], [compose('b9', 'a')]: 'x', [compose('b10', 'a')]: ['y'] })
    expect(values).toEqual({
      b1: { a: { type: 'plain_text_input', value: 'oi' } },
      b2: { a: { type: 'plain_text_input', value: 'longo' } },
      b3: { a: { type: 'number_input', value: '7' } },
      b4: { a: { type: 'email_text_input', value: 'a@b.co' } },
      b5: { a: { type: 'url_text_input', value: 'https://x.test' } },
      b6: { a: { type: 'datepicker', selected_date: '2026-11-17' } },
      b7: { a: { type: 'static_select', selected_option: sel('y') } },
      b8: { a: { type: 'multi_static_select', selected_options: [sel('x'), sel('y')] } },
      b9: { a: { type: 'radio_buttons', selected_option: sel('x') } },
      b10: { a: { type: 'checkboxes', selected_options: [sel('y')] } },
    })
  })

  it('an optional field left empty, as Slack sends it', () => {
    const values = stateValuesOf(fields, {})
    expect(values.b1).toEqual({ a: { type: 'plain_text_input', value: null } })
    expect(values.b3).toEqual({ a: { type: 'number_input', value: null } })
    expect(values.b6).toEqual({ a: { type: 'datepicker', selected_date: null } })
    expect(values.b7).toEqual({ a: { type: 'static_select', selected_option: null } })
    expect(values.b8).toEqual({ a: { type: 'multi_static_select', selected_options: [] } })
    expect(values.b9).toEqual({ a: { type: 'radio_buttons', selected_option: null } })
    expect(values.b10).toEqual({ a: { type: 'checkboxes', selected_options: [] } })
  })
})
