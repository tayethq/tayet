// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { Field } from '../../src/ui/primitives'
import { copy } from '../support/copy'

// The Field primitive's additions for the agent's form (workspace.md §26 item 4, §27 item 1; PLANO-AGENTES F9
// and fork D1): the error (aria-invalid, role="alert", the row's data-error that draws the danger border),
// "(opcional)" after the caption, and the hint under the control — the error first. Error and hint describe
// the control. Without them, the current shapes render exactly as before.

afterEach(cleanup)

describe('Field — error, optional, hint', () => {
  it('labeled input: the error and the hint describe the input, error first; aria-invalid; data-error', () => {
    const { getByLabelText, getByRole, container } = render(
      <Field label="Dias no ar" htmlFor="days" error="No máximo 90 dias" hint="Quantos dias a página fica publicada." />,
    )
    const input = getByLabelText('Dias no ar') as HTMLInputElement
    expect(input.getAttribute('aria-invalid')).toBe('true')
    const alert = getByRole('alert')
    expect(alert.textContent).toBe('No máximo 90 dias')
    const hint = container.querySelector('.ui-field__hint')!
    expect(hint.textContent).toBe('Quantos dias a página fica publicada.')
    expect(input.getAttribute('aria-describedby')).toBe(`${alert.id} ${hint.id}`)
    // The error comes first, the hint stays under it.
    expect(alert.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(container.querySelector('.ui-field')!.hasAttribute('data-error')).toBe(true)
  })

  it('a hint alone: described by the hint, not invalid, no alert, no data-error', () => {
    const { getByLabelText, queryByRole, container } = render(<Field label="Título" htmlFor="title" hint="Aparece na aba." />)
    const input = getByLabelText('Título')
    expect(input.hasAttribute('aria-invalid')).toBe(false)
    expect(queryByRole('alert')).toBeNull()
    expect(input.getAttribute('aria-describedby')).toBe(container.querySelector('.ui-field__hint')!.id)
    expect(container.querySelector('.ui-field')!.hasAttribute('data-error')).toBe(false)
  })

  it('"(opcional)" after the caption, inside the label (the accessible name carries it)', () => {
    const { getByLabelText, container } = render(<Field label="Notas" htmlFor="notes" optional />)
    expect(container.querySelector('.ui-field__label')!.textContent).toBe(`Notas ${copy.field.optional}`)
    expect(getByLabelText(`Notas ${copy.field.optional}`)).toBeTruthy()
  })

  it('children as a function receive the caption id and the describing ids', () => {
    const { getByRole } = render(
      <Field label="Prioridade" error="Campo obrigatório" hint="Escolha uma">
        {(a) => <div role="radiogroup" aria-labelledby={a.labelId} aria-describedby={a.describedBy} aria-invalid={a.invalid} />}
      </Field>,
    )
    const group = getByRole('radiogroup', { name: 'Prioridade' })
    expect(group.getAttribute('aria-invalid')).toBe('true')
    expect(group.getAttribute('aria-describedby')!.split(' ')).toHaveLength(2)
  })

  it('current consumers: no error, no hint, not optional — no extra node or attribute; their own aria is kept', () => {
    const { getByLabelText, container } = render(
      <Field label="Email" htmlFor="email" inputProps={{ 'aria-invalid': true, 'aria-describedby': 'own-error', value: '', onChange: () => {} }} />,
    )
    const input = getByLabelText('Email')
    expect(input.getAttribute('aria-invalid')).toBe('true')
    expect(input.getAttribute('aria-describedby')).toBe('own-error')
    expect(input.className).toBe('ui-field__input')
    expect(container.querySelector('.ui-field__error, .ui-field__hint, .ui-field__optional')).toBeNull()
    // The danger border rides data-error, which an own aria-invalid does not set (the look stays).
    expect(container.querySelector('.ui-field')!.hasAttribute('data-error')).toBe(false)
    expect(container.querySelector('.ui-field__label')!.textContent).toBe('Email')
  })

  it('labeled control with children (no function): unchanged shape', () => {
    const { container } = render(
      <Field label="Tipo">
        <span data-testid="ctl">x</span>
      </Field>,
    )
    expect(container.querySelector('span.ui-field__label')!.textContent).toBe('Tipo')
    expect(container.querySelectorAll('.ui-field > *')).toHaveLength(2)
  })
})
