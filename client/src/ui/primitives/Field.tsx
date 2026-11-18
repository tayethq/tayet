import { useId } from 'react'
import type { InputHTMLAttributes, ReactNode, Ref } from 'react'
import { t } from '../i18n'

// Field (leaf, ADR-036). The labeled form row: a caption stacked above a control. Two shapes:
//   - labeled input  — pass `htmlFor` (+ optional `inputProps`/`inputRef`). Field renders the
//     <input> and ties the <label htmlFor> to it for a11y (getByLabelText reaches the input).
//   - labeled control — pass `children` (a Segmented, a picker, a textarea…). With `htmlFor` the
//     caption is a <label> for the control that carries that id; without it, a <span>. `children` may
//     be a function: it receives the row's a11y wiring (the caption's id, the ids that describe the
//     control, the invalid flag) so a composite control (a radio group) can carry it.
// Additions adjudicated for the agent's form (workspace.md §26 item 4, §27 item 1; PLANO-AGENTES F9):
//   - `optional` — "(opcional)" after the caption.
//   - `error`    — the message under the control (role="alert"); the input gets aria-invalid, and the
//     general rule of the field (`.ui-field[data-error]`) draws the control's border in danger.
//   - `hint`     — a muted line under the control (and under the error, which comes first); it wraps.
//   Error and hint are tied to the control by aria-describedby. Without them nothing changes for the
//   current consumers (an `inputProps['aria-invalid']` of theirs is kept as it is).
// Consumes only semantic tokens.

export interface FieldA11y {
  labelId: string
  describedBy?: string
  invalid?: true
}

export function Field({
  label,
  htmlFor,
  inputRef,
  inputProps,
  optional = false,
  error,
  hint,
  children,
}: {
  label: string
  htmlFor?: string
  inputRef?: Ref<HTMLInputElement>
  inputProps?: InputHTMLAttributes<HTMLInputElement>
  optional?: boolean
  error?: string
  hint?: string
  children?: ReactNode | ((a11y: FieldA11y) => ReactNode)
}) {
  const base = useId()
  const labelId = `${base}-label`
  const errorId = error ? `${base}-error` : undefined
  const hintId = hint ? `${base}-hint` : undefined
  const describedBy = [errorId, hintId].filter(Boolean).join(' ') || undefined
  const a11y: FieldA11y = { labelId, ...(describedBy && { describedBy }), ...(error && { invalid: true as const }) }
  const caption = (
    <>
      {label}
      {optional && (
        <>
          {' '}
          <span className="ui-field__optional">{t('field.optional')}</span>
        </>
      )}
    </>
  )
  const ownDescribed = [inputProps?.['aria-describedby'], describedBy].filter(Boolean).join(' ') || undefined
  return (
    <div className="ui-field" data-error={error ? '' : undefined}>
      {htmlFor ? (
        <label className="ui-field__label" id={labelId} htmlFor={htmlFor}>
          {caption}
        </label>
      ) : (
        <span className="ui-field__label" id={labelId}>
          {caption}
        </span>
      )}
      {typeof children === 'function'
        ? children(a11y)
        : (children ?? (
            <input
              id={htmlFor}
              ref={inputRef}
              className="ui-field__input"
              {...inputProps}
              {...(error && { 'aria-invalid': true })}
              {...(ownDescribed && { 'aria-describedby': ownDescribed })}
            />
          ))}
      {error && (
        <span className="ui-field__error" id={errorId} role="alert">
          {error}
        </span>
      )}
      {hint && (
        <span className="ui-field__hint" id={hintId}>
          {hint}
        </span>
      )}
    </div>
  )
}
