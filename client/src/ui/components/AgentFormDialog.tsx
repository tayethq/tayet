import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import type { AgentForm, FormField, FormId, FormIssue, FormOption, FormValues, User } from '@tayet/client'
import { Button, Dialog, Field, ScreenHeader, type FieldA11y } from '../primitives'
import { useCoveringScreen } from '../covering-screen'
import { AgentAvatar, agentColorOf } from './AgentAvatar'
import { RichText } from './RichText'
import { t } from '../i18n'

// ADR-103 (Proposto); workspace.md §25.5, §26 and §27. The agent's form. On a narrow window (`narrow`;
// §25.5 item 6, PLANO-MOBILE M8) a full screen of the stack: ✕, the avatar, the title and the agent in the
// header, the submit alone in a fixed footer under the status, and the screen opens with the focus on its ✕.
// The instance is the same in both widths, so what was filled, the errors and the sending survive a crossing
// (F3). On a wide window,
// the tier's Dialog with a width modifier (480, §26 item 1); the agent's avatar, the form's title and the
// agent's name in the `title` (§26 item 2, P6); the form's own scrolling body with --space-16 between the
// fields (§26 item 3); "Cancelar" and the agent's submit label in the footer. Closing (✕, "Cancelar", Esc)
// discards without asking (§25.5 item 8). The ACL validates and sends (submitForm); this only draws:
// - the validation codes become the copy of fork I1, per field, and nothing is sent;
// - 'sending' disables the submit with "Enviando…"; 'failed' and 'noAnswer' show "Não enviado" and
//   "{agente} não respondeu" in danger in the footer, the submit reading "Tentar de novo" (§25.5 item 7);
// - 'errors' shows the agent's message under each field; 'done' never reaches here (useAgentForm closes).
//   An 'errors' state with no id of an input field (fork R1) reads like 'failed': "Não enviado" in the
//   footer, the submit reading "Tentar de novo" and taking the focus; with one field id or more, only the
//   errors of fields that exist show.
// - a decimal number field sends a lone comma as a dot (fork R2); the box keeps what the person typed.
// A field's error goes away when the person changes that field; a refused submit moves the focus to the
// first field with an error (fork I3). Radio buttons, checkboxes and the checkbox list are local markup
// (§26 item 5, D4 — below the ADR-036 dec. 3 bar).

type InputField = Exclude<FormField, { kind: 'context' }>
type ListField = Extract<InputField, { kind: 'multiSelect' | 'checkboxes' }>

const submitOf = (form: HTMLFormElement | null): HTMLButtonElement | undefined =>
  form ? [...form.elements].find((el): el is HTMLButtonElement => el instanceof HTMLButtonElement && el.type === 'submit') : undefined

const isList = (f: InputField): f is ListField => f.kind === 'multiSelect' || f.kind === 'checkboxes'

// Fork R2: the values that go to submitForm. In a decimal number field, a text with exactly one comma and
// no dot sends the comma as a dot; anything else goes as typed (the ACL validates it).
export function valuesToSend(fields: readonly FormField[], values: FormValues): FormValues {
  const out: FormValues = { ...values }
  for (const f of fields) {
    if (f.kind !== 'number' || !f.decimal) continue
    const v = out[f.id]
    if (typeof v === 'string' && v.split(',').length === 2 && !v.includes('.')) out[f.id] = v.replace(',', '.')
  }
  return out
}

// The values the dialog starts with: the definition's initial values, else empty.
export function initialValues(fields: readonly FormField[]): FormValues {
  const out: FormValues = {}
  for (const f of fields) {
    if (f.kind === 'context') continue
    out[f.id] = isList(f) ? [...(f.initial ?? [])] : (f.initial ?? '')
  }
  return out
}

// Fork I1: a validation code of the ACL, as the person reads it.
export function issueText(field: InputField, issue: FormIssue): string {
  switch (issue.code) {
    case 'required':
      return t('form.issue.required')
    case 'minLength':
      return t('form.issue.minLength', { min: issue.min })
    case 'maxLength':
      return t('form.issue.maxLength', { max: issue.max })
    case 'email':
      return t('form.issue.email')
    case 'url':
      return t('form.issue.url')
    case 'number':
      return field.kind === 'number' && !field.decimal ? t('form.issue.integer') : t('form.issue.number')
    case 'range':
      if (issue.min !== undefined && issue.max !== undefined) return t('form.issue.between', { min: issue.min, max: issue.max })
      if (issue.min !== undefined) return t('form.issue.atLeast', { min: issue.min })
      return t('form.issue.atMost', { max: issue.max ?? '' })
    case 'date':
      return t('form.issue.date')
    case 'option':
      return t('form.issue.option')
  }
}

// D2: the native list carries the description in the option's text.
const optionText = (o: FormOption): string => (o.description ? `${o.label} — ${o.description}` : o.label)

const CHECK = (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3.25 8.5 6.5 11.75 12.75 4.5" />
  </svg>
)

export function AgentFormDialog({
  form,
  agent,
  onSubmit,
  onClose,
  narrow = false,
}: {
  form: AgentForm
  agent: User | undefined
  onSubmit: (formId: FormId, values: FormValues) => Promise<{ ok: true } | { issues: Record<string, FormIssue> }>
  onClose: (formId: FormId) => void
  // Below the width breakpoint: a full screen of the stack.
  narrow?: boolean
}) {
  const base = useId()
  const formId = `${base}-form`
  const [values, setValues] = useState<FormValues>(() => initialValues(form.fields))
  // Validation codes from the last refused submit; a field's entry goes when the person changes it.
  const [issues, setIssues] = useState<Record<string, FormIssue>>({})
  // The agent's errors of the current 'errors' state the person has already changed (they go away).
  const [cleared, setCleared] = useState<ReadonlySet<string>>(new Set())
  const controls = useRef(new Map<string, HTMLElement>())
  // The submit sits in the footer, tied to the form by its `form` attribute (so it is in form.elements).
  const formRef = useRef<HTMLFormElement>(null)
  const fields = form.fields
  const state = form.state
  const agentErrors = state.kind === 'errors' ? state.errors : undefined
  // Fork R1: no error names an input field of this form.
  const orphan = agentErrors !== undefined && !fields.some((f) => f.kind !== 'context' && f.id in agentErrors)
  const agentName = agent?.displayName ?? t('timeline.someone')
  const color = agentColorOf(agent) ?? 'areia'

  const focusFirst = (bad: (id: string) => boolean): void => {
    for (const f of fields) {
      if (f.kind !== 'context' && bad(f.id)) {
        controls.current.get(f.id)?.focus()
        return
      }
    }
  }

  // A new set of agent errors: all of them show again, and the focus goes to the first one (I3) — or to
  // the submit when none names a field (R1).
  useEffect(() => {
    if (!agentErrors) return
    setCleared(new Set())
    if (orphan) submitOf(formRef.current)?.focus()
    else focusFirst((id) => id in agentErrors)
    // focusFirst reads the current fields; the effect follows only a new errors object.
  }, [agentErrors])

  const change = (id: string, value: string | string[]): void => {
    setValues((v) => ({ ...v, [id]: value }))
    setIssues((cur) => {
      if (!(id in cur)) return cur
      const next = { ...cur }
      delete next[id]
      return next
    })
    if (agentErrors && id in agentErrors) setCleared((cur) => new Set(cur).add(id))
  }

  const errorOf = (f: InputField): string | undefined => {
    const issue = issues[f.id]
    if (issue) return issueText(f, issue)
    return agentErrors && !cleared.has(f.id) ? agentErrors[f.id] : undefined
  }

  const sending = state.kind === 'sending'
  const submit = (e?: FormEvent): void => {
    e?.preventDefault()
    if (sending) return
    void onSubmit(form.id, valuesToSend(fields, values)).then(
      (out) => {
        if ('issues' in out) {
          setIssues(out.issues)
          focusFirst((id) => id in out.issues)
        } else setIssues({})
      },
      // 'failed' arrives by form.changed; nothing else to do here.
      () => {},
    )
  }

  const register = (id: string) => (el: HTMLElement | null) => {
    if (el) controls.current.set(id, el)
    else controls.current.delete(id)
  }
  const firstInput = fields.find((f) => f.kind !== 'context')

  const retry = state.kind === 'failed' || state.kind === 'noAnswer' || orphan
  const status = state.kind === 'failed' || orphan ? t('timeline.failed') : state.kind === 'noAnswer' ? t('form.noAnswer', { agent: agentName }) : undefined
  const submitLabel = sending ? t('timeline.sending') : retry ? t('timeline.retry') : form.submitLabel

  const statusLine = status && (
    <span className="agent-form__status" role="alert">
      {status}
    </span>
  )
  const submitButton = (
    <Button variant="fill" type="submit" form={formId} disabled={sending}>
      {submitLabel}
    </Button>
  )
  const body = (
    <form ref={formRef} id={formId} className="agent-form__body" onSubmit={submit} noValidate>
      {fields.map((f, i) =>
        f.kind === 'context' ? (
          <div key={`context-${i}`} className="agent-form__context">
            {f.rich ? <RichText doc={f.rich} /> : <p className="agent-form__context-text">{f.text}</p>}
          </div>
        ) : (
          <FieldControl
            key={`${i}-${f.id}`}
            field={f}
            domId={`${base}-f${i}`}
            value={values[f.id]}
            error={errorOf(f)}
            // A narrow screen opens on its ✕, as the others of the stack: no keyboard over a form not read yet.
            autoFocus={!narrow && f === firstInput}
            register={register(f.id)}
            onChange={(v) => change(f.id, v)}
          />
        ),
      )}
    </form>
  )

  if (narrow)
    return (
      <FormScreen
        title={form.title}
        agentName={agentName}
        avatar={<AgentAvatar color={color} />}
        onClose={() => onClose(form.id)}
        footer={
          <>
            {statusLine}
            {submitButton}
          </>
        }
      >
        {body}
      </FormScreen>
    )

  return (
    <Dialog
      className="agent-form"
      ariaLabel={form.title}
      title={
        <span className="agent-form__head">
          <AgentAvatar color={color} />
          <span className="agent-form__titles">
            <span className="agent-form__title">{form.title}</span>
            <span className="agent-form__agent">{agentName}</span>
          </span>
        </span>
      }
      onClose={() => onClose(form.id)}
      closeLabel={t('dialog.close')}
      footer={
        <>
          {statusLine}
          <Button variant="secondary" onClick={() => onClose(form.id)}>
            {t('form.cancel')}
          </Button>
          {submitButton}
        </>
      }
    >
      {body}
    </Dialog>
  )
}

// F1: the ✕ and Esc discard without asking, as the system's back does (the Workspace's stack entry).
function FormScreen({
  title,
  agentName,
  avatar,
  onClose,
  footer,
  children,
}: {
  title: string
  agentName: string
  avatar: ReactNode
  onClose: () => void
  footer: ReactNode
  children: ReactNode
}) {
  const { backRef, screenProps } = useCoveringScreen(onClose)
  return (
    <section className="agent-form-screen" aria-label={title} {...screenProps}>
      <ScreenHeader
        className="agent-form-screen__header"
        glyph="close"
        backLabel={t('dialog.close')}
        onBack={onClose}
        backRef={backRef}
        leading={avatar}
        title={title}
        subtitle={agentName}
      />
      {children}
      <div className="agent-form-screen__footer">{footer}</div>
    </section>
  )
}

function FieldControl({
  field,
  domId,
  value,
  error,
  autoFocus,
  register,
  onChange,
}: {
  field: InputField
  domId: string
  value: string | string[] | undefined
  error: string | undefined
  autoFocus: boolean
  register: (el: HTMLElement | null) => void
  onChange: (value: string | string[]) => void
}) {
  const text = typeof value === 'string' ? value : ''
  const list = Array.isArray(value) ? value : []
  const common = { label: field.label, optional: field.optional, error, hint: field.hint }
  const aria = (a: FieldA11y) => ({
    ...(a.describedBy && { 'aria-describedby': a.describedBy }),
    ...(a.invalid && { 'aria-invalid': true as const }),
  })
  // A plain group takes no aria-invalid (ARIA); the error stays tied by aria-describedby.
  const described = (a: FieldA11y) => (a.describedBy ? { 'aria-describedby': a.describedBy } : {})
  switch (field.kind) {
    case 'text':
    case 'email':
    case 'url':
    case 'number':
    case 'date': {
      const mode =
        field.kind === 'email' ? 'email' : field.kind === 'url' ? 'url' : field.kind === 'number' ? (field.decimal ? 'decimal' : 'numeric') : undefined
      return (
        <Field {...common} htmlFor={domId}>
          {(a) => (
            <input
              id={domId}
              ref={register}
              className="ui-field__input"
              type={field.kind === 'date' ? 'date' : 'text'}
              {...(mode && { inputMode: mode })}
              {...(field.placeholder && { placeholder: field.placeholder })}
              autoComplete="off"
              autoFocus={autoFocus}
              value={text}
              onChange={(e) => onChange(e.target.value)}
              {...aria(a)}
            />
          )}
        </Field>
      )
    }
    case 'longText':
      return (
        <Field {...common} htmlFor={domId}>
          {(a) => (
            <textarea
              id={domId}
              ref={register}
              className="ui-field__input agent-form__long"
              {...(field.placeholder && { placeholder: field.placeholder })}
              autoFocus={autoFocus}
              value={text}
              onChange={(e) => onChange(e.target.value)}
              {...aria(a)}
            />
          )}
        </Field>
      )
    case 'select':
      return (
        <Field {...common} htmlFor={domId}>
          {(a) => (
            <select
              id={domId}
              ref={register}
              className="ui-field__input agent-form__select"
              autoFocus={autoFocus}
              value={text}
              onChange={(e) => onChange(e.target.value)}
              {...aria(a)}
            >
              <option value="">{field.placeholder ?? ''}</option>
              {'options' in field.choices
                ? field.choices.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {optionText(o)}
                    </option>
                  ))
                : field.choices.groups.map((g, gi) => (
                    <optgroup key={gi} label={g.label}>
                      {g.options.map((o) => (
                        <option key={o.value} value={o.value}>
                          {optionText(o)}
                        </option>
                      ))}
                    </optgroup>
                  ))}
            </select>
          )}
        </Field>
      )
    case 'radio':
      return (
        <Field {...common}>
          {(a) => (
            <div className="agent-form__opts" role="radiogroup" aria-labelledby={a.labelId} {...aria(a)}>
              {field.options.map((o, i) => (
                <Choice
                  key={o.value}
                  type="radio"
                  name={domId}
                  option={o}
                  checked={text === o.value}
                  autoFocus={autoFocus && i === 0}
                  inputRef={i === 0 ? register : undefined}
                  onChange={() => onChange(o.value)}
                />
              ))}
            </div>
          )}
        </Field>
      )
    case 'checkboxes':
      return (
        <Field {...common}>
          {(a) => (
            <div className="agent-form__opts" role="group" aria-labelledby={a.labelId} {...described(a)}>
              {field.options.map((o, i) => (
                <Choice
                  key={o.value}
                  type="checkbox"
                  option={o}
                  checked={list.includes(o.value)}
                  autoFocus={autoFocus && i === 0}
                  inputRef={i === 0 ? register : undefined}
                  onChange={(on) => onChange(toggle(list, o.value, on))}
                />
              ))}
            </div>
          )}
        </Field>
      )
    case 'multiSelect': {
      // D4: a scrolling list of checkboxes; at the maximum, the unchecked ones are disabled and "Até {n}"
      // shows under the list. The field's placeholder is ignored.
      const max = field.maxSelected
      const full = max !== undefined && list.length >= max
      const groups = 'options' in field.choices ? [{ label: undefined, options: field.choices.options }] : field.choices.groups
      let first = true
      return (
        <Field {...common}>
          {(a) => (
            <>
              <div className="agent-form__list" role="group" aria-labelledby={a.labelId} {...described(a)}>
                {groups.map((g, gi) => {
                  const rows = g.options.map((o) => {
                    const isFirst = first
                    first = false
                    const on = list.includes(o.value)
                    return (
                      <Choice
                        key={o.value}
                        type="checkbox"
                        option={o}
                        checked={on}
                        disabled={full && !on}
                        autoFocus={autoFocus && isFirst}
                        inputRef={isFirst ? register : undefined}
                        onChange={(next) => onChange(toggle(list, o.value, next))}
                      />
                    )
                  })
                  return g.label === undefined ? (
                    rows
                  ) : (
                    <div key={gi} role="group" aria-label={g.label}>
                      <div className="agent-form__group" aria-hidden="true">
                        {g.label}
                      </div>
                      {rows}
                    </div>
                  )
                })}
              </div>
              {full && <span className="agent-form__max">{t('form.upTo', { n: max })}</span>}
            </>
          )}
        </Field>
      )
    }
  }
}

const toggle = (list: string[], value: string, on: boolean): string[] =>
  on ? (list.includes(value) ? list : [...list, value]) : list.filter((v) => v !== value)

// One radio button or checkbox row (28 high, a 16 mark with a 1.5 border); the description is a second
// muted line in meta, the mark aligned with the first line (D2, §27 item 2). The native input stays
// for keyboard and screen reader; the mark beside it is what shows.
function Choice({
  type,
  name,
  option,
  checked,
  disabled = false,
  autoFocus,
  inputRef,
  onChange,
}: {
  type: 'radio' | 'checkbox'
  name?: string
  option: FormOption
  checked: boolean
  disabled?: boolean
  autoFocus: boolean
  inputRef?: (el: HTMLElement | null) => void
  onChange: (checked: boolean) => void
}): ReactNode {
  return (
    <label className="agent-form__opt" data-desc={option.description ? '' : undefined} data-off={disabled ? '' : undefined}>
      <input
        ref={inputRef}
        className="agent-form__native"
        type={type}
        {...(name && { name })}
        value={option.value}
        checked={checked}
        disabled={disabled}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="agent-form__mark" data-kind={type} aria-hidden="true">
        {type === 'checkbox' && CHECK}
      </span>
      <span className="agent-form__opt-text">
        {option.label}
        {option.description && <span className="agent-form__opt-desc">{option.description}</span>}
      </span>
    </label>
  )
}
