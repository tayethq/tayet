import { describe, it, expect } from 'vitest'
import { MatrixEvent, type IEvent } from 'matrix-js-sdk'
import {
  FORM_BLOCK,
  FORM_MAX_BYTES,
  FORM_MSGTYPE,
  FORM_REL_TYPE,
  FORM_RESULT_BLOCK,
  FORM_RESULT_MSGTYPE,
  FORM_SUBMISSION_BLOCK,
  FORM_SUBMISSION_MSGTYPE,
  buildFormSubmissionContent,
  eventToMessage,
  foldedKind,
  readFormDefinition,
  readFormResult,
  FORM_FIELDS_MAX,
  FORM_LABEL_MAX,
  FORM_OPTION_LABEL_MAX,
  FORM_OPTION_VALUE_MAX,
  readFormSubmission,
  resolveFormReply,
  submissionLabels,
  submittableValues,
  validateFormValues,
  type Ctx,
  type FormAnchor,
  type FormRelated,
} from '../src/internal'
import type { FormField } from '../src'

// An agent's form: the defensive read of the three messages at each limit, the check of a person's values
// and the rule that says who answered.

const AGENT = '@a-abcdefghijkm:tayet.local'
const OTHER_AGENT = '@a-mnopqrstuvwx:tayet.local'
const ALICE = '@alice:tayet.local'
const BOB = '@bob:tayet.local'

const s = (n: number, c = 'a'): string => c.repeat(n)
const def = (block: Record<string, unknown>): Record<string, unknown> => ({
  [FORM_BLOCK]: { trigger: '$t', title: 'Edit', submitLabel: 'Save', fields: [{ kind: 'text', id: 'a', label: 'A' }], ...block },
})
const withField = (field: Record<string, unknown>): Record<string, unknown> => def({ fields: [field] })
const read = (field: Record<string, unknown>): FormField | undefined => readFormDefinition(withField(field))?.fields[0]
const opts = (n: number): Array<{ value: string; label: string }> => Array.from({ length: n }, (_, i) => ({ value: `v${i}`, label: `L${i}` }))

describe('readFormDefinition — the definition and its limits', () => {
  it('reads a definition with every kind', () => {
    const d = readFormDefinition(
      def({
        meta: 'state',
        fields: [
          { kind: 'context', text: 'Read *this*', format: 'org.matrix.custom.html', formatted_body: '<p>Read <em>this</em></p>' },
          { kind: 'text', id: 'field.title', label: 'Title', placeholder: 'x', initial: 'hi', minLength: 1, maxLength: 10 },
          { kind: 'longText', id: 'b', label: 'B', optional: true },
          { kind: 'email', id: 'c', label: 'C', initial: 'a@b.co' },
          { kind: 'url', id: 'd', label: 'D' },
          { kind: 'number', id: 'e', label: 'E', decimal: true, min: '0.5', max: '10', initial: '1.5' },
          { kind: 'date', id: 'f', label: 'F', initial: '2026-02-28' },
          { kind: 'select', id: 'g', label: 'G', groups: [{ label: 'One', options: opts(2) }], initial: 'v1' },
          { kind: 'multiSelect', id: 'h', label: 'H', options: opts(3), maxSelected: 2, initial: ['v0'] },
          { kind: 'radio', id: 'i', label: 'I', options: opts(2) },
          { kind: 'checkboxes', id: 'j', label: 'J', options: opts(2), initial: ['v1'] },
        ],
      }),
    )
    expect(d?.trigger).toBe('$t')
    expect(d?.fields).toHaveLength(11)
    expect(d?.fields[0]).toEqual({ kind: 'context', text: 'Read *this*', rich: [{ t: 'p', children: [{ t: 'text', text: 'Read ' }, { t: 'em', children: [{ t: 'text', text: 'this' }] }] }] })
    expect(d?.fields[1]).toEqual({ kind: 'text', id: 'field.title', label: 'Title', optional: false, placeholder: 'x', initial: 'hi', minLength: 1, maxLength: 10 })
    expect(d?.fields[2]).toMatchObject({ kind: 'longText', optional: true, minLength: 0, maxLength: 3000 })
    expect(d?.fields[7]).toMatchObject({ choices: { groups: [{ label: 'One' }] }, initial: 'v1' })
    expect(d).not.toHaveProperty('meta')
  })

  it.each([
    ['title', 24, 25],
    ['submitLabel', 24, 25],
  ])('%s: 1..%i characters', (key, ok, bad) => {
    expect(readFormDefinition(def({ [key]: s(ok) }))).toBeDefined()
    expect(readFormDefinition(def({ [key]: s(bad) }))).toBeUndefined()
    expect(readFormDefinition(def({ [key]: '' }))).toBeUndefined()
  })

  it('fields: 1..25, unique ids', () => {
    const field = (i: number) => ({ kind: 'text', id: `f${i}`, label: 'L' })
    expect(readFormDefinition(def({ fields: Array.from({ length: 25 }, (_, i) => field(i)) }))).toBeDefined()
    expect(readFormDefinition(def({ fields: Array.from({ length: 26 }, (_, i) => field(i)) }))).toBeUndefined()
    expect(readFormDefinition(def({ fields: [] }))).toBeUndefined()
    expect(readFormDefinition(def({ fields: [field(1), field(1)] }))).toBeUndefined()
  })

  it('meta: up to 4096 characters', () => {
    expect(readFormDefinition(def({ meta: s(4096) }))).toBeDefined()
    expect(readFormDefinition(def({ meta: s(4097) }))).toBeUndefined()
    expect(readFormDefinition(def({ meta: 3 }))).toBeUndefined()
  })

  it('the whole block: up to 32 KiB of UTF-8', () => {
    // Context fields of 3000 characters, the last one padded to the exact size.
    const fill = (bytes: number): Record<string, unknown> => {
      const fields: Array<{ kind: string; text: string }> = []
      const block = { trigger: '$t', title: 'Edit', submitLabel: 'Save', fields }
      const size = () => new TextEncoder().encode(JSON.stringify(block)).length
      while (bytes - size() > 3100) fields.push({ kind: 'context', text: s(3000) })
      const last = { kind: 'context', text: 'x' }
      fields.push(last)
      last.text = s(1 + bytes - size())
      return { [FORM_BLOCK]: block }
    }
    const exact = fill(FORM_MAX_BYTES)
    expect(new TextEncoder().encode(JSON.stringify(exact[FORM_BLOCK])).length).toBe(FORM_MAX_BYTES)
    expect(readFormDefinition(exact)).toBeDefined()
    const over = fill(FORM_MAX_BYTES + 1)
    expect(readFormDefinition(over)).toBeUndefined()
  })

  it('field id 1..255 (free text), label 1..2000, hint up to 2000, placeholder up to 150', () => {
    expect(read({ kind: 'text', id: s(255), label: 'L' })).toBeDefined()
    expect(read({ kind: 'text', id: s(256), label: 'L' })).toBeUndefined()
    expect(read({ kind: 'text', id: '', label: 'L' })).toBeUndefined()
    expect(read({ kind: 'text', id: 'a', label: s(2000) })).toBeDefined()
    expect(read({ kind: 'text', id: 'a', label: s(2001) })).toBeUndefined()
    expect(read({ kind: 'text', id: 'a', label: '' })).toBeUndefined()
    expect(read({ kind: 'text', id: 'a', label: 'L', hint: s(2000) })).toBeDefined()
    expect(read({ kind: 'text', id: 'a', label: 'L', hint: s(2001) })).toBeUndefined()
    expect(read({ kind: 'text', id: 'a', label: 'L', placeholder: s(150) })).toBeDefined()
    expect(read({ kind: 'text', id: 'a', label: 'L', placeholder: s(151) })).toBeUndefined()
    expect(read({ kind: 'text', id: 'a', label: 'L', optional: 'yes' })).toBeUndefined()
    expect(read({ kind: 'time', id: 'a', label: 'L' })).toBeUndefined()
  })

  it('text: minLength 0..3000, maxLength 1..3000, min <= max', () => {
    const t = (minLength: unknown, maxLength: unknown) => read({ kind: 'text', id: 'a', label: 'L', minLength, maxLength })
    expect(t(0, 1)).toBeDefined()
    expect(t(3000, 3000)).toBeDefined()
    expect(t(-1, 10)).toBeUndefined()
    expect(t(3001, 3000)).toBeUndefined()
    expect(t(0, 0)).toBeUndefined()
    expect(t(0, 3001)).toBeUndefined()
    expect(t(5, 4)).toBeUndefined()
    expect(t(1.5, 4)).toBeUndefined()
  })

  it('email, url, date and number: the initial keeps the format; number bounds min <= max', () => {
    expect(read({ kind: 'email', id: 'a', label: 'L', initial: 'no' })).toBeUndefined()
    expect(read({ kind: 'url', id: 'a', label: 'L', initial: 'ftp://x' })).toBeUndefined()
    expect(read({ kind: 'url', id: 'a', label: 'L', initial: 'https://x.co/a' })).toBeDefined()
    expect(read({ kind: 'date', id: 'a', label: 'L', initial: '2026-02-30' })).toBeUndefined()
    expect(read({ kind: 'number', id: 'a', label: 'L', min: '1.5' })).toBeUndefined()
    expect(read({ kind: 'number', id: 'a', label: 'L', min: '2', max: '1' })).toBeUndefined()
    expect(read({ kind: 'number', id: 'a', label: 'L', min: '1', max: '1' })).toBeDefined()
    expect(read({ kind: 'number', id: 'a', label: 'L', min: 1 })).toBeUndefined()
  })

  it('select and multiSelect: 1..100 options or 1..100 groups, never both; group label up to 75; values unique', () => {
    const sel = (extra: Record<string, unknown>) => read({ kind: 'select', id: 'a', label: 'L', ...extra })
    expect(sel({ options: opts(100) })).toBeDefined()
    expect(sel({ options: opts(101) })).toBeUndefined()
    expect(sel({ options: [] })).toBeUndefined()
    expect(sel({ groups: Array.from({ length: 100 }, (_, i) => ({ label: s(75), options: [{ value: `g${i}`, label: 'x' }] })) })).toBeDefined()
    expect(sel({ groups: Array.from({ length: 101 }, (_, i) => ({ label: 'g', options: [{ value: `g${i}`, label: 'x' }] })) })).toBeUndefined()
    expect(sel({ groups: [{ label: s(76), options: opts(1) }] })).toBeUndefined()
    expect(sel({ options: opts(2), groups: [{ label: 'g', options: opts(1) }] })).toBeUndefined()
    expect(sel({ groups: [{ label: 'a', options: opts(1) }, { label: 'b', options: opts(1) }] })).toBeUndefined()
    expect(sel({ options: opts(2), initial: 'nope' })).toBeUndefined()
    const multi = (extra: Record<string, unknown>) => read({ kind: 'multiSelect', id: 'a', label: 'L', options: opts(3), ...extra })
    expect(multi({ initial: ['v0', 'v0'] })).toBeUndefined()
    expect(multi({ maxSelected: 1, initial: ['v0', 'v1'] })).toBeUndefined()
    expect(multi({ maxSelected: 0 })).toBeUndefined()
  })

  it('radio and checkboxes: 1..10 options', () => {
    for (const kind of ['radio', 'checkboxes']) {
      expect(read({ kind, id: 'a', label: 'L', options: opts(10) })).toBeDefined()
      expect(read({ kind, id: 'a', label: 'L', options: opts(11) })).toBeUndefined()
      expect(read({ kind, id: 'a', label: 'L', options: [] })).toBeUndefined()
    }
  })

  it('radio: the initial is a value of its options', () => {
    expect(read({ kind: 'radio', id: 'a', label: 'L', options: opts(3), initial: 'v2' })).toMatchObject({ kind: 'radio', initial: 'v2' })
    expect(read({ kind: 'radio', id: 'a', label: 'L', options: opts(3), initial: 'v9' })).toBeUndefined()
    expect(read({ kind: 'radio', id: 'a', label: 'L', options: opts(3), initial: ['v0'] })).toBeUndefined()
    expect(read({ kind: 'radio', id: 'a', label: 'L', options: opts(3), initial: 1 })).toBeUndefined()
  })

  it('option: value 1..150, label 1..75, description up to 75, values unique', () => {
    const one = (o: Record<string, unknown>) => read({ kind: 'radio', id: 'a', label: 'L', options: [o] })
    expect(one({ value: s(150), label: s(75), description: s(75) })).toBeDefined()
    expect(one({ value: s(151), label: 'l' })).toBeUndefined()
    expect(one({ value: '', label: 'l' })).toBeUndefined()
    expect(one({ value: 'v', label: s(76) })).toBeUndefined()
    expect(one({ value: 'v', label: '' })).toBeUndefined()
    expect(one({ value: 'v', label: 'l', description: s(76) })).toBeUndefined()
    expect(read({ kind: 'radio', id: 'a', label: 'L', options: [{ value: 'v', label: 'a' }, { value: 'v', label: 'b' }] })).toBeUndefined()
  })

  it('context: text 1..3000, no id required, ignored in the id uniqueness', () => {
    expect(read({ kind: 'context', text: s(3000) })).toEqual({ kind: 'context', text: s(3000) })
    expect(read({ kind: 'context', text: s(3001) })).toBeUndefined()
    expect(read({ kind: 'context', text: '' })).toBeUndefined()
    expect(readFormDefinition(def({ fields: [{ kind: 'context', text: 'x', id: 'a' }, { kind: 'text', id: 'a', label: 'L' }] }))).toBeDefined()
  })

  it('the trigger is required; a block that is not an object is no definition', () => {
    expect(readFormDefinition(def({ trigger: undefined }))).toBeUndefined()
    expect(readFormDefinition({ [FORM_BLOCK]: 'x' })).toBeUndefined()
    expect(readFormDefinition({})).toBeUndefined()
  })
})

describe('readFormSubmission and readFormResult', () => {
  it('a submission names the form; values are strings or lists of strings', () => {
    expect(readFormSubmission({ [FORM_SUBMISSION_BLOCK]: { form: '$f', values: { a: 'x', b: ['y'] } } })).toEqual({ form: '$f', values: { a: 'x', b: ['y'] } })
    expect(readFormSubmission({ [FORM_SUBMISSION_BLOCK]: { form: '$f', values: { a: 1 } } })).toBeUndefined()
    expect(readFormSubmission({ [FORM_SUBMISSION_BLOCK]: { values: {} } })).toBeUndefined()
  })

  it('a result is ok: true, or 1+ errors of 1..300 characters — never both', () => {
    const r = (block: Record<string, unknown>) => readFormResult({ [FORM_RESULT_BLOCK]: { submission: '$s', ...block } })
    expect(r({ ok: true })).toEqual({ submission: '$s', ok: true })
    expect(r({ errors: { a: s(300) } })).toEqual({ submission: '$s', errors: { a: s(300) } })
    expect(r({ errors: { a: s(301) } })).toBeUndefined()
    expect(r({ errors: { a: '' } })).toBeUndefined()
    expect(r({ errors: {} })).toBeUndefined()
    expect(r({ ok: true, errors: { a: 'x' } })).toBeUndefined()
    expect(r({ ok: false })).toBeUndefined()
    expect(r({})).toBeUndefined()
  })

  it('the submission content: the title as body, never a value; the labels beside the values; the form relation to the anchor', () => {
    const labels = [
      { id: 'a', label: 'A' },
      { id: 's', label: 'S', options: [{ value: 'v1', label: 'L1' }] },
    ]
    expect(buildFormSubmissionContent('$anchor', '$form', 'Edit', { a: 'secret', s: 'v1' }, labels)).toEqual({
      msgtype: FORM_SUBMISSION_MSGTYPE,
      body: 'Edit',
      [FORM_SUBMISSION_BLOCK]: { form: '$form', values: { a: 'secret', s: 'v1' }, labels },
      'm.relates_to': { rel_type: FORM_REL_TYPE, event_id: '$anchor' },
    })
  })
})

describe('readFormSubmission — the copy of the labels', () => {
  const values = { a: 'x', s: 'v1', m: ['v2', 'v0'] }
  const [o2, o0] = [{ value: 'v2', label: 'L2' }, { value: 'v0', label: 'L0' }]
  const labels = [
    { id: 'a', label: 'A' },
    { id: 's', label: 'S', options: [{ value: 'v1', label: 'L1' }] },
    { id: 'm', label: 'M', options: [o2, o0] },
  ]
  const sub = (l: unknown, v: Record<string, unknown> = values) => readFormSubmission({ [FORM_SUBMISSION_BLOCK]: { form: '$f', values: v, labels: l } })
  const without = { form: '$f', values }

  it('a valid copy is read with the submission', () => {
    expect(sub(labels)).toEqual({ form: '$f', values, labels })
    expect(sub([])).toEqual(without)
    expect(sub([], {})).toEqual({ form: '$f', values: {}, labels: [] })
  })

  it('an absent copy leaves the submission valid, without labels', () => {
    expect(readFormSubmission({ [FORM_SUBMISSION_BLOCK]: { form: '$f', values } })).toEqual(without)
  })

  it.each<[string, unknown]>([
    ['not a list', { a: 'A' }],
    ['an entry that is not an object', ['A', labels[1], labels[2]]],
    ['a repeated id', [labels[0], labels[0], labels[2]]],
    ['an id missing from the values', [labels[0], labels[1]]],
    ['an id that is not in the values', [...labels, { id: 'z', label: 'Z' }]],
    ['an id that is not a string', [{ id: 1, label: 'A' }, labels[1], labels[2]]],
    ['an empty label', [{ id: 'a', label: '' }, labels[1], labels[2]]],
    ['a label over the limit', [{ id: 'a', label: s(FORM_LABEL_MAX + 1) }, labels[1], labels[2]]],
    ['options that are not a list', [labels[0], { id: 's', label: 'S', options: { value: 'v1', label: 'L1' } }, labels[2]]],
    ['an option value that differs from the one sent', [labels[0], { id: 's', label: 'S', options: [{ value: 'v0', label: 'L0' }] }, labels[2]]],
    ['options in another order than the values', [labels[0], labels[1], { id: 'm', label: 'M', options: [o0, o2] }]],
    ['fewer options than values', [labels[0], labels[1], { id: 'm', label: 'M', options: [o2] }]],
    ['an empty option label', [labels[0], { id: 's', label: 'S', options: [{ value: 'v1', label: '' }] }, labels[2]]],
    ['an option label over the limit', [labels[0], { id: 's', label: 'S', options: [{ value: 'v1', label: s(FORM_OPTION_LABEL_MAX + 1) }] }, labels[2]]],
  ])('%s → the submission without labels', (_, l) => {
    expect(sub(l)).toEqual(without)
  })

  it('an option value over the limit, or empty → the submission without labels', () => {
    const long = s(FORM_OPTION_VALUE_MAX + 1)
    expect(sub([{ id: 's', label: 'S', options: [{ value: long, label: 'L' }] }], { s: long })).toEqual({ form: '$f', values: { s: long } })
    expect(sub([{ id: 's', label: 'S', options: [{ value: '', label: 'L' }] }], { s: '' })).toEqual({ form: '$f', values: { s: '' } })
  })

  it('more entries than a definition has fields → the submission without labels', () => {
    const many = Object.fromEntries(Array.from({ length: FORM_FIELDS_MAX + 1 }, (_, i) => [`f${i}`, 'x']))
    const copy = Object.keys(many).map((id) => ({ id, label: 'L' }))
    expect(sub(copy, many)).toEqual({ form: '$f', values: many })
    expect(sub(copy.slice(1), Object.fromEntries(Object.entries(many).slice(1)))?.labels).toHaveLength(FORM_FIELDS_MAX)
  })
})

describe('submissionLabels — the copy of what the person saw', () => {
  const fields = readFormDefinition(
    def({
      fields: [
        { kind: 'context', text: 'Read this first' },
        { kind: 'text', id: 't', label: 'Supplier' },
        { kind: 'number', id: 'n', label: 'Amount', decimal: true },
        { kind: 'date', id: 'dt', label: 'Due' },
        { kind: 'select', id: 's', label: 'Cost centre', options: opts(3) },
        {
          kind: 'select',
          id: 'g',
          label: 'Grouped',
          groups: [
            { label: 'G1', options: [{ value: 'a', label: 'Alpha', description: 'first' }] },
            { label: 'G2', options: [{ value: 'b', label: 'Beta' }] },
          ],
        },
        { kind: 'multiSelect', id: 'm', label: 'Items', options: opts(3) },
        { kind: 'radio', id: 'r', label: 'Urgency', options: opts(2) },
        { kind: 'checkboxes', id: 'c', label: 'Extras', options: opts(3) },
        { kind: 'text', id: 'o', label: 'Notes', optional: true },
      ],
    }),
  )!.fields

  it('one entry per field sent, in the definition order; options only for a choice, in the order of the values', () => {
    const values = submittableValues(fields, { c: ['v2', 'v0'], r: 'v1', m: ['v1'], g: 'b', s: 'v0', dt: '2026-11-12', n: '1.5', t: 'Porto', o: '' })
    expect(submissionLabels(fields, values)).toEqual([
      { id: 't', label: 'Supplier' },
      { id: 'n', label: 'Amount' },
      { id: 'dt', label: 'Due' },
      { id: 's', label: 'Cost centre', options: [{ value: 'v0', label: 'L0' }] },
      { id: 'g', label: 'Grouped', options: [{ value: 'b', label: 'Beta' }] },
      { id: 'm', label: 'Items', options: [{ value: 'v1', label: 'L1' }] },
      { id: 'r', label: 'Urgency', options: [{ value: 'v1', label: 'L1' }] },
      { id: 'c', label: 'Extras', options: [{ value: 'v2', label: 'L2' }, { value: 'v0', label: 'L0' }] },
    ])
  })

  it('an empty optional field is not listed; the copy reads back with the submission', () => {
    const values = submittableValues(fields, { t: 'Porto', o: '', m: ['v2', 'v0'] })
    const labels = submissionLabels(fields, values)
    expect(labels.map((l) => l.id)).toEqual(['t', 'm'])
    const content = buildFormSubmissionContent('$anchor', '$form', 'Edit', values, labels)
    expect(readFormSubmission(content)).toEqual({ form: '$form', values, labels })
  })
})

describe('validateFormValues — one code per field', () => {
  const fields = readFormDefinition(
    def({
      fields: [
        { kind: 'context', text: 'x' },
        { kind: 'text', id: 't', label: 'T', minLength: 2, maxLength: 4 },
        { kind: 'email', id: 'e', label: 'E', optional: true },
        { kind: 'url', id: 'u', label: 'U', optional: true },
        { kind: 'number', id: 'n', label: 'N', optional: true, min: '1', max: '9' },
        { kind: 'number', id: 'd', label: 'D', optional: true, decimal: true },
        { kind: 'date', id: 'dt', label: 'DT', optional: true },
        { kind: 'select', id: 's', label: 'S', optional: true, options: opts(2) },
        { kind: 'multiSelect', id: 'm', label: 'M', optional: true, options: opts(3), maxSelected: 2 },
        { kind: 'radio', id: 'r', label: 'R', optional: true, options: opts(2) },
        { kind: 'checkboxes', id: 'c', label: 'C', optional: true, options: opts(2) },
      ],
    }),
  )!.fields

  it('valid values have no issue', () => {
    expect(
      validateFormValues(fields, { t: 'abc', e: 'a@b.co', u: 'https://x.co', n: '5', d: '-1.25', dt: '2024-02-29', s: 'v1', m: ['v0', 'v2'], r: 'v0', c: ['v1'] }),
    ).toEqual({})
  })

  it.each([
    [{}, 't', { code: 'required' }],
    [{ t: '' }, 't', { code: 'required' }],
    [{ t: 'a' }, 't', { code: 'minLength', min: 2 }],
    [{ t: 'abcde' }, 't', { code: 'maxLength', max: 4 }],
    [{ t: 'ab', e: 'nope' }, 'e', { code: 'email' }],
    [{ t: 'ab', u: 'mailto:a' }, 'u', { code: 'url' }],
    [{ t: 'ab', n: '1.5' }, 'n', { code: 'number' }],
    [{ t: 'ab', n: '10' }, 'n', { code: 'range', min: '1', max: '9' }],
    [{ t: 'ab', n: '0' }, 'n', { code: 'range', min: '1', max: '9' }],
    [{ t: 'ab', d: '1e5' }, 'd', { code: 'number' }],
    [{ t: 'ab', dt: '2023-02-29' }, 'dt', { code: 'date' }],
    [{ t: 'ab', s: 'v9' }, 's', { code: 'option' }],
    [{ t: 'ab', m: ['v0', 'v1', 'v2'] }, 'm', { code: 'option' }],
    [{ t: 'ab', m: 'v0' }, 'm', { code: 'option' }],
    [{ t: 'ab', r: 'v9' }, 'r', { code: 'option' }],
    [{ t: 'ab', c: ['v1', 'v1'] }, 'c', { code: 'option' }],
  ])('%j → %s %j', (values, id, issue) => {
    expect(validateFormValues(fields, values as Record<string, string | string[]>)[id]).toEqual(issue)
  })

  it('only the input fields with a value are submitted', () => {
    expect(submittableValues(fields, { t: 'ab', e: '', m: [], x: 'unknown' })).toEqual({ t: 'ab' })
  })
})

describe('resolveFormReply — who answered', () => {
  const definition = readFormDefinition(def({}))!
  const card: FormAnchor = { id: '$card', agent: AGENT, kind: 'card', sender: AGENT }
  const owners = new Map([['$t', ALICE]])
  const rel = (r: Partial<FormRelated> & Pick<FormRelated, 'id' | 'kind'>): FormRelated => ({ sender: AGENT, ts: 1, ...r }) as FormRelated
  const flow = (over: { defSender?: string; subSender?: string; resSender?: string; trigger?: string } = {}): FormRelated[] => [
    rel({ id: '$d', kind: 'definition', sender: over.defSender ?? AGENT, definition: { ...definition, trigger: over.trigger ?? '$t' } }),
    rel({ id: '$s1', kind: 'submission', sender: over.subSender ?? ALICE, ts: 10, submission: { form: '$d', values: {} } }),
    rel({ id: '$r1', kind: 'result', sender: over.resSender ?? AGENT, result: { submission: '$s1', errors: { a: 'bad' } } }),
    rel({ id: '$s2', kind: 'submission', sender: over.subSender ?? ALICE, ts: 20, submission: { form: '$d', values: {} } }),
    rel({ id: '$r2', kind: 'result', sender: over.resSender ?? AGENT, result: { submission: '$s2', ok: true } }),
  ]

  it('the first ok result, dated by the submission it accepted; a rejected one counts for nothing', () => {
    expect(resolveFormReply(card, flow(), (t) => owners.get(t))).toEqual({ by: ALICE, at: 20 })
  })

  it('forged senders are ignored', () => {
    expect(resolveFormReply(card, flow({ defSender: OTHER_AGENT }), (t) => owners.get(t))).toBeUndefined()
    expect(resolveFormReply(card, flow({ resSender: BOB }), (t) => owners.get(t))).toBeUndefined()
    expect(resolveFormReply(card, flow({ subSender: BOB }), (t) => owners.get(t))).toBeUndefined()
  })

  it('a command anchor: the trigger is the anchor itself, its author the owner', () => {
    const command: FormAnchor = { id: '$cmd', agent: AGENT, kind: 'command', sender: ALICE }
    expect(resolveFormReply(command, flow({ trigger: '$cmd' }), () => undefined)).toEqual({ by: ALICE, at: 20 })
    expect(resolveFormReply(command, flow({ trigger: '$other' }), () => ALICE)).toBeUndefined()
  })
})

describe('the translator folds the three messages', () => {
  const ctx: Ctx = { mode: 'strict', telemetry: { untranslated: () => {} }, isDm: () => false }
  const ev = (content: Record<string, unknown>): MatrixEvent =>
    new MatrixEvent({ type: 'm.room.message', event_id: '$e', room_id: '!r:tayet.local', sender: AGENT, origin_server_ts: 1, content } as Partial<IEvent>)

  it.each([FORM_MSGTYPE, FORM_SUBMISSION_MSGTYPE, FORM_RESULT_MSGTYPE])('%s is folded, by type or by relation, and never a line', (msgtype) => {
    expect(foldedKind(ev({ msgtype, body: 'x' }))).toBe('form')
    expect(foldedKind(ev({ msgtype: 'm.text', body: 'x', 'm.relates_to': { rel_type: FORM_REL_TYPE, event_id: '$a' } }))).toBe('form')
    expect(eventToMessage(ev({ msgtype, body: 'x' }), ctx)).toBeNull()
  })

  it('a card asks for its reply; a plain text message does not', () => {
    const asked: string[] = []
    const withReply: Ctx = { ...ctx, formReplyFor: (id, anchor) => (asked.push(`${id}:${anchor.kind}`), { by: ALICE, at: 5 }) }
    const plain = eventToMessage(ev({ msgtype: 'm.text', body: 'hi' }), withReply)
    expect(plain?.formReply).toBeUndefined()
    const cardMsg = eventToMessage(ev({ msgtype: 'io.tayet.approval', body: 'q', 'io.tayet.approval': { options: [{ id: 'ok', label: 'OK' }] } }), withReply)
    expect(cardMsg?.formReply).toEqual({ by: ALICE, at: 5 })
    expect(asked).toEqual(['$e:card'])
  })
})
