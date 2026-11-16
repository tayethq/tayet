import type { InputHTMLAttributes, ReactNode, Ref } from 'react'

// Field (leaf, ADR-036). The labeled form row: a caption stacked above a control. Two shapes:
//   - labeled input  — pass `htmlFor` (+ optional `inputProps`/`inputRef`). Field renders the
//     <input> and ties the <label htmlFor> to it for a11y (getByLabelText reaches the input).
//   - labeled control — pass `children` (a Segmented, a picker…). The caption renders as a <span>
//     since there is no single input to associate.
// Consumes only semantic tokens.

export function Field({
  label,
  htmlFor,
  inputRef,
  inputProps,
  children,
}: {
  label: string
  htmlFor?: string
  inputRef?: Ref<HTMLInputElement>
  inputProps?: InputHTMLAttributes<HTMLInputElement>
  children?: ReactNode
}) {
  return (
    <div className="ui-field">
      {htmlFor ? (
        <label className="ui-field__label" htmlFor={htmlFor}>
          {label}
        </label>
      ) : (
        <span className="ui-field__label">{label}</span>
      )}
      {children ?? <input id={htmlFor} ref={inputRef} className="ui-field__input" {...inputProps} />}
    </div>
  )
}
