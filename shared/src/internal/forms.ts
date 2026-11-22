// An agent's form: the defensive read of the definition, the submission and the result, the check of a
// person's values against the definition, and the rule that says who answered a form opened from a
// message. Pure — no SDK, no network — so the client and the sidecar read the same shape. Any reader
// returns undefined on a violation, never throws. The limits follow the documented behaviour of the
// service the sidecar's compatibility layer imitates.
import type { FormChoices, FormField, FormIssue, FormOption, FormOptionGroup, FormValues, RichDoc } from '../domain'
import { FORM_BLOCK, FORM_RESULT_BLOCK, FORM_SUBMISSION_BLOCK } from './product-events'
import { richFromContent } from './rich-text'

export const FORM_TITLE_MAX = 24
export const FORM_SUBMIT_LABEL_MAX = 24
export const FORM_FIELDS_MAX = 25
export const FORM_META_MAX = 4096
export const FORM_MAX_BYTES = 32 * 1024
export const FORM_FIELD_ID_MAX = 255
export const FORM_LABEL_MAX = 2000
export const FORM_HINT_MAX = 2000
export const FORM_PLACEHOLDER_MAX = 150
export const FORM_TEXT_MAX = 3000
export const FORM_CONTEXT_MAX = 3000
export const FORM_OPTIONS_MAX = 100
export const FORM_GROUPS_MAX = 100
export const FORM_GROUP_LABEL_MAX = 75
export const FORM_RADIO_OPTIONS_MAX = 10
export const FORM_CHECKBOX_OPTIONS_MAX = 10
export const FORM_OPTION_VALUE_MAX = 150
export const FORM_OPTION_LABEL_MAX = 75
export const FORM_OPTION_DESCRIPTION_MAX = 75
export const FORM_ERROR_MAX = 300

// The definition as read: the trigger it names, and the fields in domain form. `meta` belongs to the
// agent's side and is dropped here.
export interface FormDefinition {
  trigger: string
  title: string
  submitLabel: string
  fields: FormField[]
}

// What the person saw, carried by the submission itself: for each field sent, in the definition's
// order, its id and label and, for a choice, the value and label of each option chosen.
export interface FormSubmissionLabel {
  id: string
  label: string
  options?: { value: string; label: string }[]
}

export interface FormSubmission {
  form: string
  values: FormValues
  // Absent when the submission carries none, or a copy that breaks a rule (the submission stays valid).
  labels?: FormSubmissionLabel[]
}

export type FormResult = { submission: string; ok: true } | { submission: string; errors: Record<string, string> }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const length = (s: string): number => [...s].length
const encoder = new TextEncoder()

// A string of `min` to `max` code points, else undefined.
function text(raw: unknown, min: number, max: number): string | undefined {
  if (typeof raw !== 'string') return undefined
  const n = length(raw)
  return n >= min && n <= max ? raw : undefined
}

// An optional string: absent → null (fine), present and valid → the string, else undefined.
function optionalText(raw: unknown, max: number): string | null | undefined {
  if (raw === undefined) return null
  return text(raw, 0, max)
}

const INTEGER = /^-?\d+$/
const DECIMAL = /^-?\d+(\.\d+)?$/
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/

// An address with no whitespace, exactly one `@`, a non-empty local part, and a dot inside the domain
// (neither its first nor its last character). Linear in the length: a single pattern for the whole shape
// backtracks over every dot of the domain.
export function isEmail(v: string): boolean {
  if (/\s/.test(v)) return false
  const at = v.indexOf('@')
  if (at < 1 || at !== v.lastIndexOf('@')) return false
  const dot = v.indexOf('.', at + 2)
  return dot !== -1 && dot <= v.length - 2
}

function isDate(v: string): boolean {
  const m = DATE.exec(v)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = new Date(Date.UTC(y, mo - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d
}

function isUrl(v: string): boolean {
  try {
    const url = new URL(v)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

const isNumber = (v: string, decimal: boolean): boolean => (decimal ? DECIMAL : INTEGER).test(v)

function readOption(raw: unknown): FormOption | undefined {
  if (!isRecord(raw)) return undefined
  const value = text(raw.value, 1, FORM_OPTION_VALUE_MAX)
  const label = text(raw.label, 1, FORM_OPTION_LABEL_MAX)
  const description = optionalText(raw.description, FORM_OPTION_DESCRIPTION_MAX)
  if (value === undefined || label === undefined || description === undefined) return undefined
  return { value, label, ...(description !== null && { description }) }
}

function readOptions(raw: unknown, max: number, seen: Set<string>): FormOption[] | undefined {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > max) return undefined
  const out: FormOption[] = []
  for (const item of raw) {
    const option = readOption(item)
    if (!option || seen.has(option.value)) return undefined
    seen.add(option.value)
    out.push(option)
  }
  return out
}

function readChoices(field: Record<string, unknown>): { choices: FormChoices; values: Set<string> } | undefined {
  const values = new Set<string>()
  if (field.options !== undefined && field.groups !== undefined) return undefined
  if (field.options !== undefined) {
    const options = readOptions(field.options, FORM_OPTIONS_MAX, values)
    return options ? { choices: { options }, values } : undefined
  }
  if (!Array.isArray(field.groups) || field.groups.length < 1 || field.groups.length > FORM_GROUPS_MAX) return undefined
  const groups: FormOptionGroup[] = []
  for (const raw of field.groups) {
    if (!isRecord(raw)) return undefined
    const label = text(raw.label, 1, FORM_GROUP_LABEL_MAX)
    const options = readOptions(raw.options, FORM_OPTIONS_MAX, values)
    if (label === undefined || !options) return undefined
    groups.push({ label, options })
  }
  return { choices: { groups }, values }
}

// A list of existing values with no repeat, or undefined.
function readValueList(raw: unknown, values: Set<string>, max?: number): string[] | undefined {
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string' || !values.has(v))) return undefined
  if (new Set(raw).size !== raw.length || (max !== undefined && raw.length > max)) return undefined
  return raw as string[]
}

function readContext(field: Record<string, unknown>): FormField | undefined {
  const body = text(field.text, 1, FORM_CONTEXT_MAX)
  if (body === undefined) return undefined
  const rich: RichDoc | undefined = richFromContent(field)
  return { kind: 'context', text: body, ...(rich && { rich }) }
}

// One field, or undefined when it breaks a rule.
function readField(raw: unknown): FormField | undefined {
  if (!isRecord(raw)) return undefined
  if (raw.kind === 'context') return readContext(raw)
  const id = text(raw.id, 1, FORM_FIELD_ID_MAX)
  const label = text(raw.label, 1, FORM_LABEL_MAX)
  const hint = optionalText(raw.hint, FORM_HINT_MAX)
  const placeholder = optionalText(raw.placeholder, FORM_PLACEHOLDER_MAX)
  if (id === undefined || label === undefined || hint === undefined || placeholder === undefined) return undefined
  if (raw.optional !== undefined && typeof raw.optional !== 'boolean') return undefined
  const base = { id, label, ...(hint !== null && { hint }), optional: raw.optional === true }
  const box = placeholder !== null ? { placeholder } : {}
  const initial = raw.initial
  switch (raw.kind) {
    case 'text':
    case 'longText': {
      const minLength = raw.minLength ?? 0
      const maxLength = raw.maxLength ?? FORM_TEXT_MAX
      if (!Number.isInteger(minLength) || !Number.isInteger(maxLength)) return undefined
      const [min, max] = [minLength as number, maxLength as number]
      if (min < 0 || min > FORM_TEXT_MAX || max < 1 || max > FORM_TEXT_MAX || min > max) return undefined
      const init = optionalText(initial, max)
      if (init === undefined) return undefined
      return { ...base, kind: raw.kind, ...box, minLength: min, maxLength: max, ...(init !== null && { initial: init }) }
    }
    case 'email':
    case 'url': {
      const ok = raw.kind === 'email' ? isEmail : isUrl
      if (initial !== undefined && (typeof initial !== 'string' || !ok(initial))) return undefined
      return { ...base, kind: raw.kind, ...box, ...(initial !== undefined && { initial: initial as string }) }
    }
    case 'number': {
      if (raw.decimal !== undefined && typeof raw.decimal !== 'boolean') return undefined
      const decimal = raw.decimal === true
      const bound = (v: unknown): string | null | undefined => (v === undefined ? null : typeof v === 'string' && isNumber(v, decimal) ? v : undefined)
      const [min, max, init] = [bound(raw.min), bound(raw.max), bound(initial)]
      if (min === undefined || max === undefined || init === undefined) return undefined
      if (min !== null && max !== null && Number(min) > Number(max)) return undefined
      return {
        ...base,
        kind: 'number',
        ...box,
        decimal,
        ...(min !== null && { min }),
        ...(max !== null && { max }),
        ...(init !== null && { initial: init }),
      }
    }
    case 'date':
      if (initial !== undefined && (typeof initial !== 'string' || !isDate(initial))) return undefined
      return { ...base, kind: 'date', ...box, ...(initial !== undefined && { initial: initial as string }) }
    case 'select': {
      const read = readChoices(raw)
      if (!read) return undefined
      if (initial !== undefined && (typeof initial !== 'string' || !read.values.has(initial))) return undefined
      return { ...base, kind: 'select', ...box, choices: read.choices, ...(initial !== undefined && { initial: initial as string }) }
    }
    case 'multiSelect': {
      const read = readChoices(raw)
      if (!read) return undefined
      const maxSelected = raw.maxSelected
      if (maxSelected !== undefined && (!Number.isInteger(maxSelected) || (maxSelected as number) < 1)) return undefined
      const init = initial === undefined ? null : readValueList(initial, read.values, maxSelected as number | undefined)
      if (init === undefined) return undefined
      return {
        ...base,
        kind: 'multiSelect',
        ...box,
        choices: read.choices,
        ...(maxSelected !== undefined && { maxSelected: maxSelected as number }),
        ...(init !== null && { initial: init }),
      }
    }
    case 'radio': {
      const values = new Set<string>()
      const options = readOptions(raw.options, FORM_RADIO_OPTIONS_MAX, values)
      if (!options) return undefined
      if (initial !== undefined && (typeof initial !== 'string' || !values.has(initial))) return undefined
      return { ...base, kind: 'radio', options, ...(initial !== undefined && { initial: initial as string }) }
    }
    case 'checkboxes': {
      const values = new Set<string>()
      const options = readOptions(raw.options, FORM_CHECKBOX_OPTIONS_MAX, values)
      if (!options) return undefined
      const init = initial === undefined ? null : readValueList(initial, values)
      if (init === undefined) return undefined
      return { ...base, kind: 'checkboxes', options, ...(init !== null && { initial: init }) }
    }
    default:
      return undefined
  }
}

// The definition carried by a message's content, or undefined when it breaks any rule.
export function readFormDefinition(content: Record<string, unknown>): FormDefinition | undefined {
  const block = content[FORM_BLOCK]
  if (!isRecord(block)) return undefined
  if (encoder.encode(JSON.stringify(block)).length > FORM_MAX_BYTES) return undefined
  const trigger = text(block.trigger, 1, Infinity)
  const title = text(block.title, 1, FORM_TITLE_MAX)
  const submitLabel = text(block.submitLabel, 1, FORM_SUBMIT_LABEL_MAX)
  if (trigger === undefined || title === undefined || submitLabel === undefined) return undefined
  if (optionalText(block.meta, FORM_META_MAX) === undefined) return undefined
  if (!Array.isArray(block.fields) || block.fields.length < 1 || block.fields.length > FORM_FIELDS_MAX) return undefined
  const fields: FormField[] = []
  const ids = new Set<string>()
  for (const raw of block.fields) {
    const field = readField(raw)
    if (!field) return undefined
    if (field.kind !== 'context') {
      if (ids.has(field.id)) return undefined
      ids.add(field.id)
    }
    fields.push(field)
  }
  return { trigger, title, submitLabel, fields }
}

// The agent's state a valid definition carries: the string, or undefined when it has none or the
// definition breaks any rule. Kept apart from readFormDefinition, whose shape never carries it.
export function readFormMeta(content: Record<string, unknown>): string | undefined {
  if (readFormDefinition(content) === undefined) return undefined
  const meta = (content[FORM_BLOCK] as Record<string, unknown>).meta
  return typeof meta === 'string' ? meta : undefined
}

// The submission carried by a message's content, or undefined. A list value only as a list of strings.
export function readFormSubmission(content: Record<string, unknown>): FormSubmission | undefined {
  const block = content[FORM_SUBMISSION_BLOCK]
  if (!isRecord(block) || !isRecord(block.values)) return undefined
  const form = text(block.form, 1, Infinity)
  if (form === undefined) return undefined
  const values: FormValues = {}
  for (const [id, v] of Object.entries(block.values)) {
    if (typeof v === 'string' || (Array.isArray(v) && v.every((x) => typeof x === 'string'))) values[id] = v as string | string[]
    else return undefined
  }
  const labels = readSubmissionLabels(block.labels, values)
  return { form, values, ...(labels && { labels }) }
}

// The copy of the labels, or undefined when it breaks any rule: at most one entry per field, ids that are
// exactly the values' keys, and, where present, options whose values are the values sent, in order.
function readSubmissionLabels(raw: unknown, values: FormValues): FormSubmissionLabel[] | undefined {
  if (!Array.isArray(raw) || raw.length > FORM_FIELDS_MAX) return undefined
  const keys = Object.keys(values)
  if (raw.length !== keys.length) return undefined
  const seen = new Set<string>()
  const out: FormSubmissionLabel[] = []
  for (const entry of raw) {
    if (!isRecord(entry)) return undefined
    const id = typeof entry.id === 'string' ? entry.id : undefined
    const label = text(entry.label, 1, FORM_LABEL_MAX)
    if (id === undefined || label === undefined || seen.has(id) || !Object.hasOwn(values, id)) return undefined
    seen.add(id)
    if (entry.options === undefined) {
      out.push({ id, label })
      continue
    }
    const sent = values[id]
    const expected = Array.isArray(sent) ? sent : [sent]
    if (!Array.isArray(entry.options) || entry.options.length !== expected.length) return undefined
    const options: { value: string; label: string }[] = []
    for (const [i, o] of entry.options.entries()) {
      if (!isRecord(o)) return undefined
      const value = text(o.value, 1, FORM_OPTION_VALUE_MAX)
      const optionLabel = text(o.label, 1, FORM_OPTION_LABEL_MAX)
      if (value === undefined || optionLabel === undefined || value !== expected[i]) return undefined
      options.push({ value, label: optionLabel })
    }
    out.push({ id, label, options })
  }
  return out
}

// The result carried by a message's content, or undefined: exactly `ok: true`, or at least one error of
// 1 to 300 characters per field id — never both.
export function readFormResult(content: Record<string, unknown>): FormResult | undefined {
  const block = content[FORM_RESULT_BLOCK]
  if (!isRecord(block)) return undefined
  const submission = text(block.submission, 1, Infinity)
  if (submission === undefined) return undefined
  if (block.ok === true && block.errors === undefined) return { submission, ok: true }
  if (block.ok !== undefined || !isRecord(block.errors)) return undefined
  const entries = Object.entries(block.errors)
  if (entries.length < 1) return undefined
  const errors: Record<string, string> = {}
  for (const [id, message] of entries) {
    const m = text(message, 1, FORM_ERROR_MAX)
    if (m === undefined) return undefined
    errors[id] = m
  }
  return { submission, errors }
}

const isEmpty = (v: string | string[] | undefined): boolean => v === undefined || v.length === 0

function choiceValues(choices: FormChoices): Set<string> {
  const options = 'options' in choices ? choices.options : choices.groups.flatMap((g) => g.options)
  return new Set(options.map((o) => o.value))
}

// The issue of one value against its field, or undefined when it is fine.
function issueOf(field: Exclude<FormField, { kind: 'context' }>, raw: string | string[] | undefined): FormIssue | undefined {
  const list = field.kind === 'multiSelect' || field.kind === 'checkboxes'
  if (list ? raw !== undefined && !Array.isArray(raw) : Array.isArray(raw)) return list ? { code: 'option' } : { code: 'required' }
  if (isEmpty(raw)) return field.optional ? undefined : { code: 'required' }
  switch (field.kind) {
    case 'text':
    case 'longText': {
      const n = length(raw as string)
      if (n < field.minLength) return { code: 'minLength', min: field.minLength }
      if (n > field.maxLength) return { code: 'maxLength', max: field.maxLength }
      return undefined
    }
    case 'email':
      // String(): a value that is not a string at run time fails the check instead of throwing.
      return isEmail(String(raw)) ? undefined : { code: 'email' }
    case 'url':
      return isUrl(raw as string) ? undefined : { code: 'url' }
    case 'number': {
      const v = raw as string
      if (!isNumber(v, field.decimal)) return { code: 'number' }
      const below = field.min !== undefined && Number(v) < Number(field.min)
      const above = field.max !== undefined && Number(v) > Number(field.max)
      return below || above ? { code: 'range', ...(field.min !== undefined && { min: field.min }), ...(field.max !== undefined && { max: field.max }) } : undefined
    }
    case 'date':
      return isDate(raw as string) ? undefined : { code: 'date' }
    case 'select':
      return choiceValues(field.choices).has(raw as string) ? undefined : { code: 'option' }
    case 'radio':
      return field.options.some((o) => o.value === raw) ? undefined : { code: 'option' }
    case 'multiSelect':
    case 'checkboxes': {
      const allowed = field.kind === 'multiSelect' ? choiceValues(field.choices) : new Set(field.options.map((o) => o.value))
      const values = raw as string[]
      const max = field.kind === 'multiSelect' ? field.maxSelected : undefined
      if (new Set(values).size !== values.length || values.some((v) => !allowed.has(v))) return { code: 'option' }
      return max !== undefined && values.length > max ? { code: 'option' } : undefined
    }
  }
}

// The issues of a person's values against the definition, by field id; empty when they can be sent.
export function validateFormValues(fields: readonly FormField[], values: FormValues): Record<string, FormIssue> {
  const issues: Record<string, FormIssue> = {}
  for (const field of fields) {
    if (field.kind === 'context') continue
    const issue = issueOf(field, Object.hasOwn(values, field.id) ? values[field.id] : undefined)
    if (issue) issues[field.id] = issue
  }
  return issues
}

// The values a submission carries: only the definition's input fields, empty ones dropped.
export function submittableValues(fields: readonly FormField[], values: FormValues): FormValues {
  const out: FormValues = {}
  for (const field of fields) {
    if (field.kind === 'context' || !Object.hasOwn(values, field.id)) continue
    const v = values[field.id]
    if (v !== undefined && !isEmpty(v)) out[field.id] = v
  }
  return out
}

// The copy of the labels a submission carries, from the definition and the values already filtered by
// submittableValues: one entry per field sent, in the definition's order; for a choice, one option per
// value chosen, in the values' order, options in groups flattened.
export function submissionLabels(fields: readonly FormField[], values: FormValues): FormSubmissionLabel[] {
  const out: FormSubmissionLabel[] = []
  for (const field of fields) {
    if (field.kind === 'context' || !Object.hasOwn(values, field.id)) continue
    const v = values[field.id]
    if (v === undefined) continue
    const choices =
      field.kind === 'select' || field.kind === 'multiSelect'
        ? 'options' in field.choices
          ? field.choices.options
          : field.choices.groups.flatMap((g) => g.options)
        : field.kind === 'radio' || field.kind === 'checkboxes'
          ? field.options
          : undefined
    if (!choices) {
      out.push({ id: field.id, label: field.label })
      continue
    }
    const byValue = new Map(choices.map((o) => [o.value, o.label]))
    const options = (Array.isArray(v) ? v : [v]).flatMap((value) => {
      const label = byValue.get(value)
      return label === undefined ? [] : [{ value, label }]
    })
    out.push({ id: field.id, label: field.label, options })
  }
  return out
}

// One message related to an anchor by the form relation, as the reply rule reads it: author and server
// instant in clear, and what its content says when it could be read.
export type FormRelated =
  | { id: string; sender: string; ts: number; kind: 'definition'; definition: FormDefinition }
  | { id: string; sender: string; ts: number; kind: 'submission'; submission: FormSubmission }
  | { id: string; sender: string; ts: number; kind: 'result'; result: FormResult }

// Who may open a form from the anchor, and who sent the trigger. For a command, the trigger is the
// anchor itself; for a card, it is an answer to it, whose author `triggerSender` knows.
export interface FormAnchor {
  id: string
  agent: string
  kind: 'card' | 'command'
  sender: string
}

// The first accepted answer to a form opened from the anchor, in the server's order: a result `ok` from
// the definition's author, for a submission from the trigger's author, for a definition from the agent
// the anchor allows. The instant is the submission's. Undefined when there is none.
export function resolveFormReply(
  anchor: FormAnchor,
  related: readonly FormRelated[],
  triggerSender: (triggerId: string) => string | undefined,
): { by: string; at: number } | undefined {
  const byId = new Map(related.map((r) => [r.id, r]))
  for (const r of related) {
    if (r.kind !== 'result' || !('ok' in r.result)) continue
    const submission = byId.get(r.result.submission)
    if (submission?.kind !== 'submission') continue
    const definition = byId.get(submission.submission.form)
    if (definition?.kind !== 'definition') continue
    if (definition.sender !== anchor.agent || r.sender !== definition.sender) continue
    const trigger = definition.definition.trigger
    const owner = anchor.kind === 'command' ? (trigger === anchor.id ? anchor.sender : undefined) : triggerSender(trigger)
    if (owner === undefined || submission.sender !== owner) continue
    return { by: submission.sender, at: submission.ts }
  }
  return undefined
}
