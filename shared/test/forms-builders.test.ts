import { describe, it, expect } from 'vitest'
import {
  FORM_BLOCK,
  FORM_ERROR_MAX,
  FORM_FIELDS_MAX,
  FORM_MAX_BYTES,
  FORM_META_MAX,
  FORM_MSGTYPE,
  FORM_REL_TYPE,
  FORM_RESULT_BLOCK,
  FORM_RESULT_MSGTYPE,
  FORM_SUBMIT_LABEL_MAX,
  FORM_TITLE_MAX,
  buildFormDefinitionContent,
  buildFormResultContent,
  formFieldWire,
  readFormDefinition,
  readFormMeta,
  readFormResult,
  richFromContent,
} from '../src/internal'
import type { FormField } from '../src'

// The agent's side of a form: the builders of the definition and the result read back by the readers the
// client uses, at the limits, and the reader of the agent's state.

const s = (n: number, c = 'a'): string => c.repeat(n)

const RICH = richFromContent({ format: 'org.matrix.custom.html', formatted_body: '<p>Read <em>this</em></p>' })!

const EVERY_KIND: FormField[] = [
  { kind: 'context', text: 'Read this', rich: RICH },
  { kind: 'context', text: 'Plain context' },
  { kind: 'text', id: 'title', label: 'Title', placeholder: 'x', optional: false, minLength: 1, maxLength: 10, initial: 'hi' },
  { kind: 'longText', id: 'why', label: 'Why', hint: 'Be brief', optional: true, minLength: 0, maxLength: 3000 },
  { kind: 'email', id: 'mail', label: 'Mail', optional: false, initial: 'a@b.co' },
  { kind: 'url', id: 'link', label: 'Link', optional: true },
  { kind: 'number', id: 'n', label: 'N', optional: false, decimal: true, min: '0.5', max: '10', initial: '1.5' },
  { kind: 'date', id: 'd', label: 'D', optional: false, initial: '2026-02-28' },
  { kind: 'select', id: 'sel', label: 'Sel', optional: false, choices: { options: [{ value: 'a', label: 'A', description: 'first' }, { value: 'b', label: 'B' }] }, initial: 'b' },
  {
    kind: 'multiSelect',
    id: 'multi',
    label: 'Multi',
    optional: true,
    choices: { groups: [{ label: 'G1', options: [{ value: 'x', label: 'X' }] }, { label: 'G2', options: [{ value: 'y', label: 'Y' }] }] },
    maxSelected: 2,
    initial: ['y'],
  },
  { kind: 'radio', id: 'r', label: 'R', optional: false, options: [{ value: 'r1', label: 'R1' }, { value: 'r2', label: 'R2' }], initial: 'r2' },
  { kind: 'checkboxes', id: 'c', label: 'C', optional: true, options: [{ value: 'c1', label: 'C1' }], initial: ['c1'] },
]

const one = (n: number): FormField[] => Array.from({ length: n }, (_, i) => ({ kind: 'text', id: `f${i}`, label: `F${i}`, optional: false, minLength: 0, maxLength: 3000 }))

describe('buildFormDefinitionContent — read back by readFormDefinition', () => {
  it('every kind: the type, the title as body, the block, the relation to the anchor; the fields read back as built', () => {
    const content = buildFormDefinitionContent('$anchor', '$trigger', 'Edit', 'Save', EVERY_KIND, '{"view":"edit"}')
    expect(content.msgtype).toBe(FORM_MSGTYPE)
    expect(content.body).toBe('Edit')
    expect(content['m.relates_to']).toEqual({ rel_type: FORM_REL_TYPE, event_id: '$anchor' })
    expect(Object.keys(content)).toEqual(['msgtype', 'body', FORM_BLOCK, 'm.relates_to'])
    const read = readFormDefinition(content)
    expect(read).toEqual({ trigger: '$trigger', title: 'Edit', submitLabel: 'Save', fields: EVERY_KIND })
  })

  it('a list carries its choices on the field; a context carries its formatted text as format and formatted body', () => {
    const select = formFieldWire(EVERY_KIND[8]!)
    expect(select).toMatchObject({ kind: 'select', options: [{ value: 'a' }, { value: 'b' }] })
    expect(select).not.toHaveProperty('choices')
    expect(formFieldWire(EVERY_KIND[9]!)).toMatchObject({ groups: [{ label: 'G1' }, { label: 'G2' }] })
    const context = formFieldWire(EVERY_KIND[0]!)
    expect(context).toMatchObject({ kind: 'context', text: 'Read this', format: 'org.matrix.custom.html' })
    expect(typeof context.formatted_body).toBe('string')
    expect(formFieldWire(EVERY_KIND[1]!)).toEqual({ kind: 'context', text: 'Plain context' })
  })

  it('no meta: the block carries none', () => {
    const content = buildFormDefinitionContent('$a', '$t', 'Edit', 'Save', one(1))
    expect(content[FORM_BLOCK]).not.toHaveProperty('meta')
    expect(readFormDefinition(content)?.fields).toHaveLength(1)
  })

  it('the limits hold on the built content: title and submit label, fields, meta, the whole block', () => {
    const ok = (title: string, submit: string, fields: FormField[], meta?: string) =>
      readFormDefinition(buildFormDefinitionContent('$a', '$t', title, submit, fields, meta)) !== undefined
    expect(ok(s(FORM_TITLE_MAX), s(FORM_SUBMIT_LABEL_MAX), one(1))).toBe(true)
    expect(ok(s(FORM_TITLE_MAX + 1), 'Save', one(1))).toBe(false)
    expect(ok('Edit', s(FORM_SUBMIT_LABEL_MAX + 1), one(1))).toBe(false)
    expect(ok('', 'Save', one(1))).toBe(false)
    expect(ok('Edit', 'Save', one(FORM_FIELDS_MAX))).toBe(true)
    expect(ok('Edit', 'Save', one(FORM_FIELDS_MAX + 1))).toBe(false)
    expect(ok('Edit', 'Save', [])).toBe(false)
    expect(ok('Edit', 'Save', one(1), s(FORM_META_MAX, '🙂'))).toBe(true)
    expect(ok('Edit', 'Save', one(1), s(FORM_META_MAX + 1))).toBe(false)
    const big: FormField[] = Array.from({ length: 20 }, (_, i) => ({ kind: 'longText', id: `f${i}`, label: s(2000), optional: false, minLength: 0, maxLength: 3000 }))
    const content = buildFormDefinitionContent('$a', '$t', 'Edit', 'Save', big)
    expect(new TextEncoder().encode(JSON.stringify(content[FORM_BLOCK])).length).toBeGreaterThan(FORM_MAX_BYTES)
    expect(readFormDefinition(content)).toBeUndefined()
  })
})

describe('readFormMeta — the agent state of a valid definition', () => {
  it('the meta of a valid definition; none when absent; none when the definition breaks a rule', () => {
    expect(readFormMeta(buildFormDefinitionContent('$a', '$t', 'Edit', 'Save', one(1), 'state'))).toBe('state')
    expect(readFormMeta(buildFormDefinitionContent('$a', '$t', 'Edit', 'Save', one(1), ''))).toBe('')
    expect(readFormMeta(buildFormDefinitionContent('$a', '$t', 'Edit', 'Save', one(1)))).toBeUndefined()
    expect(readFormMeta(buildFormDefinitionContent('$a', '$t', s(FORM_TITLE_MAX + 1), 'Save', one(1), 'state'))).toBeUndefined()
    expect(readFormMeta({})).toBeUndefined()
  })

  it('readFormDefinition still never carries the meta', () => {
    expect(readFormDefinition(buildFormDefinitionContent('$a', '$t', 'Edit', 'Save', one(1), 'state'))).not.toHaveProperty('meta')
  })
})

describe('buildFormResultContent — read back by readFormResult', () => {
  it('ok: the type, the block with ok, the relation to the anchor', () => {
    const content = buildFormResultContent('$anchor', '$sub', { ok: true })
    expect(content).toEqual({
      msgtype: FORM_RESULT_MSGTYPE,
      body: 'ok',
      [FORM_RESULT_BLOCK]: { submission: '$sub', ok: true },
      'm.relates_to': { rel_type: FORM_REL_TYPE, event_id: '$anchor' },
    })
    expect(readFormResult(content)).toEqual({ submission: '$sub', ok: true })
  })

  it('errors by field: read back as built; the limits of a message hold', () => {
    const errors = { why: 'Too short', title: s(FORM_ERROR_MAX, '🙂') }
    const content = buildFormResultContent('$anchor', '$sub', { errors })
    expect(content[FORM_RESULT_BLOCK]).toEqual({ submission: '$sub', errors })
    expect(readFormResult(content)).toEqual({ submission: '$sub', errors })
    expect(readFormResult(buildFormResultContent('$a', '$s', { errors: { x: s(FORM_ERROR_MAX + 1) } }))).toBeUndefined()
    expect(readFormResult(buildFormResultContent('$a', '$s', { errors: { x: '' } }))).toBeUndefined()
    expect(readFormResult(buildFormResultContent('$a', '$s', { errors: {} }))).toBeUndefined()
  })
})
