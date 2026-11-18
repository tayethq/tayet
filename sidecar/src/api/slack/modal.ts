// A Slack modal ↔ an agent's form in the product's schema (views.open, view_submission; slack/views.ts).
//
// - Inputs: `input` blocks with `plain_text_input` (`multiline` → long text), `number_input`,
//   `email_text_input`, `url_text_input`, `static_select`, `multi_static_select`, `radio_buttons`, `checkboxes`
//   and `datepicker`. Option texts in mrkdwn are flattened to plain text.
// - Texts: `section` (`text` and `fields`), `context`, `header`, `rich_text`, `markdown` and `image` (as
//   `[imagem: alt]`) become read-only text through the message path (slack/blocks.ts); neighbouring texts join
//   into one field. `divider` is dropped.
// - Refused with `invalid_blocks`: any other element or block type, `dispatch_action` on an input, a `section`
//   with an accessory, a repeated `block_id`, more than 100 blocks, more than 25 fields after the texts join, a
//   `block_id` + `action_id` longer than the field id holds.
// - Refused with `invalid_arguments`: a `type` other than `modal`; a `title` absent or outside 1–24; a `submit`
//   absent or outside 1–24; a `close` over 24; a `private_metadata` over 3,000 or a `callback_id` over 255.
// - Dropped with one line each (no content): `notify_on_close`, `clear_on_close`, `external_id`,
//   `focus_on_load`, `divider`. A valid `close` is dropped with no line.
// - A field's id is its `block_id` and `action_id` in one text, with a length prefix and no escape
//   ("<n>:<block_id><action_id>", n in code points). An absent id is positional (`b<n>`, `a<n>`, n the field's
//   place in the form), so the definition alone gives it back. The agent's state is `private_metadata` and
//   `callback_id` the same way.
// - Back to Slack: the blocks are rebuilt from the form, and the values take the shape Slack gives each element
//   in `state.values`; an optional field left empty comes as Slack sends it (a null value, an empty list).
import { createHash } from 'node:crypto'
import type { FormChoices, FormField, FormOption, FormValues } from '@tayet/shared'
import { FORM_FIELDS_MAX, FORM_FIELD_ID_MAX, FORM_SUBMIT_LABEL_MAX, FORM_TEXT_MAX, FORM_TITLE_MAX } from '../../core/form-limits'
import { flattenBlocks, type BlockResolve } from './blocks'
import { SlackError } from './errors'
import { mrkdwnToRich, richToMrkdwn } from './mrkdwn'

export const MODAL_BLOCKS_MAX = 100
export const MODAL_CLOSE_MAX = 24
export const PRIVATE_METADATA_MAX = 3_000
export const CALLBACK_ID_MAX = 255

type Obj = Record<string, unknown>
type Input = Exclude<FormField, { kind: 'context' }>

const obj = (v: unknown): Obj | undefined => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined)
const points = (s: string): string[] => [...s]
const blocks = (): never => {
  throw new SlackError('invalid_blocks')
}
const args = (): never => {
  throw new SlackError('invalid_arguments')
}

// ── Composed texts ───────────────────────────────────────────────────────────────────────────────────────────

export const compose = (first: string, second: string): string => `${points(first).length}:${first}${second}`

export function split(text: string): [string, string] | undefined {
  const m = /^(\d{1,4}):/.exec(text)
  if (m === null) return undefined
  const rest = points(text.slice(m[0].length))
  const n = Number(m[1])
  return n <= rest.length ? [rest.slice(0, n).join(''), rest.slice(n).join('')] : undefined
}

// ── Modal → form ─────────────────────────────────────────────────────────────────────────────────────────────

export interface ModalForm {
  title: string
  submitLabel: string
  fields: FormField[]
  privateMetadata: string
  callbackId: string
}

// The text of a `plain_text` object (undefined when absent).
function plain(v: unknown, bad: () => never): string | undefined {
  if (v === undefined) return undefined
  const t = obj(v)
  if (t === undefined || t.type !== 'plain_text' || typeof t.text !== 'string') return bad()
  return t.text
}

// A text object as plain text: mrkdwn flattened.
function flat(v: unknown, resolve: BlockResolve): string | undefined {
  const t = obj(v)
  if (t === undefined) return v === undefined ? undefined : blocks()
  if (typeof t.text !== 'string') return blocks()
  return t.type === 'mrkdwn' ? mrkdwnToRich(t.text, resolve).text : t.text
}

const str = (v: unknown): string | undefined => (v === undefined ? undefined : typeof v === 'string' ? v : typeof v === 'number' ? String(v) : blocks())
const int = (v: unknown): number | undefined => (v === undefined ? undefined : typeof v === 'number' && Number.isInteger(v) ? v : blocks())

function option(v: unknown, resolve: BlockResolve): FormOption {
  const o = obj(v) ?? blocks()
  const label = flat(o.text, resolve) ?? blocks()
  const value = str(o.value) ?? blocks()
  const description = flat(o.description, resolve)
  return { value, label, ...(description !== undefined && { description }) }
}

const options = (v: unknown, resolve: BlockResolve): FormOption[] => (Array.isArray(v) ? v.map((o) => option(o, resolve)) : blocks())

function choices(e: Obj, resolve: BlockResolve): FormChoices {
  if (e.options !== undefined && e.option_groups === undefined) return { options: options(e.options, resolve) }
  if (e.options !== undefined || !Array.isArray(e.option_groups)) return blocks()
  return { groups: e.option_groups.map((g) => ({ label: plain(obj(g)?.label, blocks) ?? blocks(), options: options(obj(g)?.options, resolve) })) }
}

const initialOne = (v: unknown): string | undefined => (v === undefined ? undefined : (str(obj(v)?.value) ?? blocks()))
const initialMany = (v: unknown): string[] | undefined => (v === undefined ? undefined : Array.isArray(v) ? v.map((o) => initialOne(o) as string) : blocks())

const ELEMENT_DROPS = ['focus_on_load'] as const

// One `input` block's field.
function input(block: Obj, id: string, resolve: BlockResolve, drop: (key: string) => void): Input {
  if (block.dispatch_action === true) return blocks()
  const e = obj(block.element) ?? blocks()
  for (const k of ELEMENT_DROPS) if (e[k] !== undefined) drop(k)
  if (block.optional !== undefined && typeof block.optional !== 'boolean') return blocks()
  const hint = plain(block.hint, blocks)
  const base = { id, label: plain(block.label, blocks) ?? blocks(), ...(hint !== undefined && { hint }), optional: block.optional === true }
  const placeholder = e.placeholder === undefined ? {} : { placeholder: plain(e.placeholder, blocks) as string }
  const initial = <T>(v: T | undefined) => (v === undefined ? {} : { initial: v })
  switch (e.type) {
    case 'plain_text_input':
      if (e.multiline !== undefined && typeof e.multiline !== 'boolean') return blocks()
      return { ...base, kind: e.multiline === true ? 'longText' : 'text', ...placeholder, minLength: int(e.min_length) ?? 0, maxLength: int(e.max_length) ?? FORM_TEXT_MAX, ...initial(str(e.initial_value)) }
    case 'number_input': {
      if (e.is_decimal_allowed !== undefined && typeof e.is_decimal_allowed !== 'boolean') return blocks()
      const [min, max] = [str(e.min_value), str(e.max_value)]
      return { ...base, kind: 'number', ...placeholder, decimal: e.is_decimal_allowed === true, ...(min !== undefined && { min }), ...(max !== undefined && { max }), ...initial(str(e.initial_value)) }
    }
    case 'email_text_input':
    case 'url_text_input':
      return { ...base, kind: e.type === 'email_text_input' ? 'email' : 'url', ...placeholder, ...initial(str(e.initial_value)) }
    case 'datepicker':
      return { ...base, kind: 'date', ...placeholder, ...initial(str(e.initial_date)) }
    case 'static_select':
      return { ...base, kind: 'select', ...placeholder, choices: choices(e, resolve), ...initial(initialOne(e.initial_option)) }
    case 'multi_static_select': {
      const maxSelected = int(e.max_selected_items)
      return { ...base, kind: 'multiSelect', ...placeholder, choices: choices(e, resolve), ...(maxSelected !== undefined && { maxSelected }), ...initial(initialMany(e.initial_options)) }
    }
    case 'radio_buttons':
      return { ...base, kind: 'radio', options: options(e.options, resolve), ...initial(initialOne(e.initial_option)) }
    case 'checkboxes':
      return { ...base, kind: 'checkboxes', options: options(e.options, resolve), ...initial(initialMany(e.initial_options)) }
    default:
      return blocks()
  }
}

const TEXT_BLOCKS = new Set(['section', 'context', 'header', 'rich_text', 'markdown', 'image'])
const DROPPED_VIEW_KEYS = ['notify_on_close', 'clear_on_close', 'external_id'] as const

// The form of a modal; Slack's codes otherwise. `drop` gets the name of each key dropped with a line.
export function formOfModal(raw: unknown, resolve: BlockResolve, drop: (key: string) => void): ModalForm {
  const view = obj(raw) ?? args()
  if (view.type !== 'modal') return args()
  const length = (s: string | undefined) => (s === undefined ? 0 : points(s).length)
  const title = plain(view.title, args)
  if (title === undefined || length(title) < 1 || length(title) > FORM_TITLE_MAX) return args()
  const submit = plain(view.submit, args)
  if (submit === undefined || length(submit) < 1 || length(submit) > FORM_SUBMIT_LABEL_MAX) return args()
  if (length(plain(view.close, args)) > MODAL_CLOSE_MAX) return args()
  const privateMetadata = view.private_metadata === undefined ? '' : typeof view.private_metadata === 'string' ? view.private_metadata : args()
  const callbackId = view.callback_id === undefined ? '' : typeof view.callback_id === 'string' ? view.callback_id : args()
  if (length(privateMetadata) > PRIVATE_METADATA_MAX || length(callbackId) > CALLBACK_ID_MAX) return args()
  for (const k of DROPPED_VIEW_KEYS) if (view[k] !== undefined) drop(k)
  if (!Array.isArray(view.blocks)) return args()
  if (view.blocks.length > MODAL_BLOCKS_MAX) return blocks()

  const fields: FormField[] = []
  const ids = new Set<string>()
  const claim = (id: string): void => {
    if (ids.has(id)) blocks()
    ids.add(id)
  }
  let run: unknown[] = []
  const flush = (): void => {
    if (run.length === 0) return
    const { text, rich } = flattenBlocks(run, resolve)
    run = []
    if (text !== '') fields.push({ kind: 'context', text, ...(rich !== undefined && { rich }) })
  }
  for (const item of view.blocks) {
    const block = obj(item) ?? blocks()
    if (block.block_id !== undefined) claim(typeof block.block_id === 'string' && block.block_id !== '' ? block.block_id : blocks())
    if (block.type === 'divider') {
      drop('divider')
      continue
    }
    if (typeof block.type === 'string' && TEXT_BLOCKS.has(block.type)) {
      if (block.type === 'section' && block.accessory !== undefined) return blocks()
      run.push(block.type === 'image' ? { type: 'context', elements: [{ type: 'image', alt_text: block.alt_text }] } : block)
      continue
    }
    if (block.type !== 'input') return blocks()
    flush()
    const n = fields.length
    const blockId = typeof block.block_id === 'string' ? block.block_id : `b${n}`
    if (block.block_id === undefined) claim(blockId)
    const actionId = obj(block.element)?.action_id
    if (actionId !== undefined && (typeof actionId !== 'string' || actionId === '')) return blocks()
    const id = compose(blockId, actionId ?? `a${n}`)
    if (points(id).length > FORM_FIELD_ID_MAX) return blocks()
    fields.push(input(block, id, resolve, drop))
  }
  flush()
  if (fields.length > FORM_FIELDS_MAX) return blocks()
  return { title, submitLabel: submit, fields, privateMetadata, callbackId }
}

// ── Form → Slack ─────────────────────────────────────────────────────────────────────────────────────────────

const text = (t: string) => ({ type: 'plain_text', text: t, emoji: true })
const optionOut = (o: FormOption) => ({ text: text(o.label), value: o.value, ...(o.description !== undefined && { description: text(o.description) }) })
const flatOptions = (f: Input): FormOption[] => (f.kind === 'radio' || f.kind === 'checkboxes' ? f.options : f.kind === 'select' || f.kind === 'multiSelect' ? ('options' in f.choices ? f.choices.options : f.choices.groups.flatMap((g) => g.options)) : [])
const chosen = (f: Input, value: string) => flatOptions(f).find((o) => o.value === value)
const listOut = (c: FormChoices) => ('options' in c ? { options: c.options.map(optionOut) } : { option_groups: c.groups.map((g) => ({ label: text(g.label), options: g.options.map(optionOut) })) })

// The `block_id` and `action_id` of a field id (a valid id always splits).
export const idsOf = (id: string): [string, string] => split(id) ?? [id, id]

function element(f: Input, action: string): Obj {
  const placeholder = 'placeholder' in f && f.placeholder !== undefined ? { placeholder: text(f.placeholder) } : {}
  const one = (v: string | undefined) => (v !== undefined && chosen(f, v) !== undefined ? { initial_option: optionOut(chosen(f, v) as FormOption) } : {})
  const many = (v: string[] | undefined) => (v !== undefined ? { initial_options: v.flatMap((x) => (chosen(f, x) !== undefined ? [optionOut(chosen(f, x) as FormOption)] : [])) } : {})
  switch (f.kind) {
    case 'text':
    case 'longText':
      return { type: 'plain_text_input', action_id: action, multiline: f.kind === 'longText', ...placeholder, ...(f.minLength > 0 && { min_length: f.minLength }), ...(f.maxLength < FORM_TEXT_MAX && { max_length: f.maxLength }), ...(f.initial !== undefined && { initial_value: f.initial }) }
    case 'number':
      return { type: 'number_input', action_id: action, is_decimal_allowed: f.decimal, ...placeholder, ...(f.min !== undefined && { min_value: f.min }), ...(f.max !== undefined && { max_value: f.max }), ...(f.initial !== undefined && { initial_value: f.initial }) }
    case 'email':
    case 'url':
      return { type: f.kind === 'email' ? 'email_text_input' : 'url_text_input', action_id: action, ...placeholder, ...(f.initial !== undefined && { initial_value: f.initial }) }
    case 'date':
      return { type: 'datepicker', action_id: action, ...placeholder, ...(f.initial !== undefined && { initial_date: f.initial }) }
    case 'select':
      return { type: 'static_select', action_id: action, ...placeholder, ...listOut(f.choices), ...one(f.initial) }
    case 'multiSelect':
      return { type: 'multi_static_select', action_id: action, ...placeholder, ...listOut(f.choices), ...(f.maxSelected !== undefined && { max_selected_items: f.maxSelected }), ...many(f.initial) }
    case 'radio':
      return { type: 'radio_buttons', action_id: action, options: f.options.map(optionOut), ...one(f.initial) }
    case 'checkboxes':
      return { type: 'checkboxes', action_id: action, options: f.options.map(optionOut), ...many(f.initial) }
  }
}

// The modal's blocks, rebuilt from the form.
export function blocksOf(fields: readonly FormField[], resolve: Pick<BlockResolve, 'person'>): Obj[] {
  return fields.map((f) => {
    if (f.kind === 'context') return { type: 'section', text: { type: 'mrkdwn', text: richToMrkdwn(f.text, f.rich, [], resolve) } }
    const [block, action] = idsOf(f.id)
    return { type: 'input', block_id: block, label: text(f.label), optional: f.optional, ...(f.hint !== undefined && { hint: text(f.hint) }), dispatch_action: false, element: element(f, action) }
  })
}

const TYPE: Record<Input['kind'], string> = {
  text: 'plain_text_input',
  longText: 'plain_text_input',
  number: 'number_input',
  email: 'email_text_input',
  url: 'url_text_input',
  date: 'datepicker',
  select: 'static_select',
  multiSelect: 'multi_static_select',
  radio: 'radio_buttons',
  checkboxes: 'checkboxes',
}

// `state.values[block_id][action_id]` of a submission, in the shape Slack gives each element.
export function stateValuesOf(fields: readonly FormField[], values: FormValues): Record<string, Record<string, Obj>> {
  const out: Record<string, Record<string, Obj>> = {}
  for (const f of fields) {
    if (f.kind === 'context') continue
    const [block, action] = idsOf(f.id)
    const v = Object.hasOwn(values, f.id) ? values[f.id] : undefined
    const one = typeof v === 'string' ? v : undefined
    const many = Array.isArray(v) ? v : []
    const pick = (x: string) => (chosen(f, x) !== undefined ? [optionOut(chosen(f, x) as FormOption)] : [])
    const state =
      f.kind === 'date'
        ? { selected_date: one ?? null }
        : f.kind === 'select' || f.kind === 'radio'
          ? { selected_option: one !== undefined ? (pick(one)[0] ?? null) : null }
          : f.kind === 'multiSelect' || f.kind === 'checkboxes'
            ? { selected_options: many.flatMap(pick) }
            : { value: one ?? null }
    out[block] = { [action]: { type: TYPE[f.kind], ...state } }
  }
  return out
}

export interface ViewParts {
  conversation: string
  // The definition's ts.
  form: string
  title: string
  submitLabel: string
  blocks: Obj[]
  privateMetadata: string
  callbackId: string
  team: string
  bot: string
  values?: Record<string, Record<string, Obj>>
}

// A view as Slack answers it: `id` and `hash` derived from the conversation and the definition's ts.
export function viewOf(p: ViewParts): Obj {
  const digest = createHash('sha256').update(`${p.conversation} ${p.form}`).digest('hex')
  const id = `V${digest.slice(0, 10).toUpperCase()}`
  return {
    id,
    team_id: p.team,
    type: 'modal',
    title: text(p.title),
    submit: text(p.submitLabel),
    close: null,
    blocks: p.blocks,
    private_metadata: p.privateMetadata,
    callback_id: p.callbackId,
    external_id: '',
    state: { values: p.values ?? {} },
    hash: `${p.form.split('.')[0] ?? '0'}.${digest.slice(10, 18)}`,
    clear_on_close: false,
    notify_on_close: false,
    root_view_id: id,
    previous_view_id: null,
    app_id: p.bot,
    app_installed_team_id: p.team,
    bot_id: p.bot,
  }
}
