// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyLocale } from '../../src/ui/i18n'
import { en } from '../../src/ui/i18n/en'
import type { AgentFormSlice } from '../../src/ui/useAgentForm'
import type { AgentForm, FormId, FormIssue, FormState, FormValues, MessageId } from '../../src/acl'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { copy, fill } from '../support/copy'
import { fakeDevice } from '../support/device-fake'
import { GROUP, ROBO, mountShell } from '../support/narrow-shell'

// The agent's form on the narrow window (workspace.md §25.5 item 6, §25.10 item 5, §27; PLANO-MOBILE M8 F1 to
// F4): the real Workspace over the stack.

const TITLE = 'Ajustar pagamento'
const SUBMIT = 'Enviar ajuste'
const formOf = (state: FormState = { kind: 'open' }): AgentForm => ({
  id: 'form-1' as FormId,
  channelId: GROUP.id,
  agent: ROBO.id,
  anchor: '$card:tayet.local' as unknown as MessageId,
  title: TITLE,
  submitLabel: SUBMIT,
  fields: [
    { kind: 'context', text: 'Mude o que precisar.' },
    { kind: 'text', id: 'desc', label: 'Descrição', optional: false, minLength: 0, maxLength: 3000, hint: 'Aparece no extrato.' },
    { kind: 'longText', id: 'note', label: 'Observação', optional: true, minLength: 0, maxLength: 3000 },
    { kind: 'radio', id: 'pay', label: 'Forma de pagamento', optional: false, options: [{ value: 'pix', label: 'Pix' }, { value: 'boleto', label: 'Boleto' }] },
    {
      kind: 'multiSelect',
      id: 'cost',
      label: 'Centros de custo',
      optional: true,
      maxSelected: 1,
      choices: { groups: [{ label: 'Operação', options: [{ value: 'g', label: 'Gráfica' }, { value: 'f', label: 'Frete' }] }] },
    },
  ],
  state,
})

function mountForm(state?: FormState, issues?: Record<string, FormIssue>) {
  const submit = vi.fn(async (_id: FormId, _values: FormValues) => (issues ? { issues } : ({ ok: true } as const)))
  const close = vi.fn()
  const slice = (s?: FormState): AgentFormSlice => ({
    form: formOf(s),
    agent: ROBO,
    submit,
    close: (id) => {
      close(id)
      v.setForm(undefined)
    },
  })
  const v = mountShell()
  const show = (s?: FormState) => act(() => v.setForm(slice(s)))
  v.more().focus()
  show(state)
  const c = v.container
  return {
    ...v,
    submit,
    close,
    show,
    screen: () => c.querySelector<HTMLElement>('.agent-form-screen'),
    field: (label: string) => v.getByLabelText(label, { exact: false }) as HTMLInputElement,
    button: () => c.querySelector<HTMLButtonElement>('.agent-form-screen__footer button, .ui-dialog__footer button[type="submit"]')!,
  }
}
type View = ReturnType<typeof mountForm>
const flush = () => act(async () => {})
function fillIn(v: View) {
  fireEvent.change(v.field('Descrição'), { target: { value: 'Folders' } })
  fireEvent.change(v.field('Observação'), { target: { value: 'Pagar em dezembro' } })
  fireEvent.click(v.getByRole('radio', { name: 'Pix' }))
  fireEvent.click(v.getByRole('checkbox', { name: 'Gráfica' }))
}
function expectFilled(v: View) {
  expect(v.field('Descrição').value).toBe('Folders')
  expect(v.field('Observação').value).toBe('Pagar em dezembro')
  expect((v.getByRole('radio', { name: 'Pix' }) as HTMLInputElement).checked).toBe(true)
  expect((v.getByRole('checkbox', { name: 'Gráfica' }) as HTMLInputElement).checked).toBe(true)
  expect((v.getByRole('checkbox', { name: 'Frete' }) as HTMLInputElement).disabled).toBe(true)
}

afterEach(() => {
  cleanup()
  applyLocale('pt-BR')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('the screen (§25.5 items 2 and 6, F4)', () => {
  beforeEach(() => void fakeDevice())

  it('✕, the agent mark, the title and the agent, in that order; one entry; what is under is inert', () => {
    const v = mountForm()
    expect(v.getByRole('region', { name: TITLE })).toBe(v.screen())
    const header = v.screen()!.querySelector('.ui-screen-header')!
    const [close, mark, heading] = [...header.children]
    expect(close!.getAttribute('aria-label')).toBe(copy.dialog.close)
    expect(close!.querySelector('.ui-screen-header__back-glyph')).toBeNull()
    expect(mark!.getAttribute('aria-label')).toBe(copy.agent.label)
    expect(heading!.querySelector('.ui-screen-header__title')!.textContent).toBe(TITLE)
    expect(heading!.querySelector('.ui-screen-header__subtitle')!.textContent).toBe(ROBO.displayName)
    expect(v.h.screens()).toEqual(['chat', 'dialog'])
    expect(v.container.querySelector('.main')!.hasAttribute('inert')).toBe(true)
    expect(v.container.querySelector('.ui-dialog')).toBeNull()
  })

  it('opens with the focus on the ✕, not on a field', () => {
    const v = mountForm()
    expect(document.activeElement).toBe(within(v.screen()!).getByRole('button', { name: copy.dialog.close }))
  })

  it('F4: the title and the agent are one line each, cut with an ellipsis', () => {
    const css = readFileSync(join(__dirname, '..', '..', 'src', 'ui', 'styles.css'), 'utf8')
    const rule = css.split('.ui-screen-header__title,\n.ui-screen-header__subtitle {')[1]!.split('}')[0]!
    for (const line of ['overflow: hidden', 'text-overflow: ellipsis', 'white-space: nowrap']) expect(rule).toContain(line)
  })

  it('F1: no "Cancelar": the footer has the submit alone, tied to the form', () => {
    const v = mountForm()
    expect(within(v.screen()!).queryByRole('button', { name: copy.form.cancel })).toBeNull()
    const buttons = v.screen()!.querySelectorAll<HTMLButtonElement>('.agent-form-screen__footer button')
    expect([...buttons].map((b) => b.textContent)).toEqual([SUBMIT])
    expect(buttons[0]!.form).toBe(v.screen()!.querySelector('form'))
  })
})

describe('F1: closing discards without asking', () => {
  beforeEach(() => void fakeDevice())

  it.each(['✕', 'Esc', 'system back'] as const)('%s', (how) => {
    const v = mountForm()
    fillIn(v)
    if (how === '✕') fireEvent.click(within(v.screen()!).getByRole('button', { name: copy.dialog.close }))
    if (how === 'Esc') fireEvent.keyDown(v.field('Descrição'), { key: 'Escape' })
    if (how === 'system back') v.h.back()
    v.h.land()
    expect(v.close).toHaveBeenCalledTimes(1)
    expect(v.screen()).toBeNull()
    expect(v.queryByRole('alertdialog')).toBeNull()
    expect(v.submit).not.toHaveBeenCalled()
    expect(v.h.screens()).toEqual(['chat'])
    expect(document.activeElement).toBe(v.more())
  })

  it('while it sends, the back is not held', () => {
    const v = mountForm({ kind: 'sending' })
    v.h.back()
    expect(v.screen()).toBeNull()
  })
})

describe('the states of sending (§25.5 item 7)', () => {
  beforeEach(() => void fakeDevice())

  it('open: the agent label, enabled, no status', () => {
    const v = mountForm()
    expect(v.button().textContent).toBe(SUBMIT)
    expect(v.button().disabled).toBe(false)
    expect(v.screen()!.querySelector('.agent-form__status')).toBeNull()
  })

  it('sending: disabled with "Enviando…", and nothing is sent again', () => {
    const v = mountForm({ kind: 'sending' })
    expect(v.button().textContent).toBe(copy.timeline.sending)
    expect(v.button().disabled).toBe(true)
    fireEvent.submit(v.screen()!.querySelector('form')!)
    expect(v.submit).not.toHaveBeenCalled()
  })

  it.each([
    ['failed', { kind: 'failed' }, copy.timeline.failed],
    ['noAnswer', { kind: 'noAnswer' }, fill(copy.form.noAnswer, { agent: ROBO.displayName })],
    ['errors that name no field', { kind: 'errors', errors: { gone: 'x' } }, copy.timeline.failed],
  ] as const)('%s: the text over the button, which reads "Tentar de novo"', (_, state, text) => {
    const v = mountForm(state as FormState)
    const status = v.screen()!.querySelector('.agent-form-screen__footer [role="alert"]')!
    expect(status.textContent).toBe(text)
    expect(status.nextElementSibling).toBe(v.button())
    expect(v.button().textContent).toBe(copy.timeline.retry)
    expect(v.button().disabled).toBe(false)
  })

  it('the submit sends what was typed; a refused one shows per field and focuses the first', async () => {
    const v = mountForm(undefined, { desc: { code: 'required' } })
    fireEvent.change(v.field('Observação'), { target: { value: 'x' } })
    fireEvent.click(v.button())
    await flush()
    expect(v.submit.mock.calls[0]![1]).toMatchObject({ note: 'x' })
    expect(within(v.screen()!).getByRole('alert').textContent).toBe(copy.form.issue.required)
    expect(document.activeElement).toBe(v.field('Descrição'))
  })

  it("the agent's error takes the focus and keeps the hint", () => {
    const v = mountForm()
    v.show({ kind: 'errors', errors: { desc: 'Já existe' } })
    expect(within(v.screen()!).getByRole('alert').textContent).toBe('Já existe')
    expect(v.screen()!.querySelector('.ui-field__hint')!.textContent).toBe('Aparece no extrato.')
    expect(document.activeElement).toBe(v.field('Descrição'))
  })
})

describe('F3: crossing 728 keeps what was filled, the errors and the sending', () => {
  it.each([
    ['narrow → wide → narrow', true],
    ['wide → narrow → wide', false],
  ] as const)('what was filled (%s)', (_, narrow) => {
    const device = fakeDevice({ narrow })
    const v = mountForm()
    fillIn(v)
    for (const to of [!narrow, narrow]) {
      device.setNarrow(to)
      v.h.land()
      expect(Boolean(v.screen())).toBe(to)
      expect(Boolean(v.queryByRole('dialog', { name: TITLE }))).toBe(!to)
      expectFilled(v)
      expect(v.h.depth()).toBe(to ? 2 : 0)
    }
    expect(v.close).not.toHaveBeenCalled()
  })

  it.each([true, false])('the validation errors (from narrow=%s)', async (narrow) => {
    const device = fakeDevice({ narrow })
    const v = mountForm(undefined, { pay: { code: 'required' } })
    fireEvent.click(v.button())
    await flush()
    for (const to of [!narrow, narrow]) {
      device.setNarrow(to)
      v.h.land()
      expect(v.getByRole('alert').textContent).toBe(copy.form.issue.required)
    }
  })

  it.each([true, false])("the agent's errors, less the one already changed (from narrow=%s)", (narrow) => {
    const device = fakeDevice({ narrow })
    const v = mountForm({ kind: 'errors', errors: { desc: 'Já existe', note: 'Curta demais' } })
    fireEvent.change(v.field('Observação'), { target: { value: 'mudei' } })
    for (const to of [!narrow, narrow]) {
      device.setNarrow(to)
      v.h.land()
      expect(v.getAllByRole('alert').map((a) => a.textContent)).toEqual(['Já existe'])
      expect(v.field('Observação').value).toBe('mudei')
    }
  })

  it.each([true, false])('the sending, and the failure after it (from narrow=%s)', (narrow) => {
    const device = fakeDevice({ narrow })
    const v = mountForm()
    fillIn(v)
    v.show({ kind: 'sending' })
    device.setNarrow(!narrow)
    v.h.land()
    expect(v.button().textContent).toBe(copy.timeline.sending)
    expect(v.button().disabled).toBe(true)
    v.show({ kind: 'failed' })
    device.setNarrow(narrow)
    v.h.land()
    expect(v.button().textContent).toBe(copy.timeline.retry)
    expect(v.getByRole('alert').textContent).toBe(copy.timeline.failed)
    expectFilled(v)
  })
})

describe('the order of the stack', () => {
  it('over the details and a profile: the form first, then the profile, then the details', async () => {
    fakeDevice()
    const v = mountShell()
    v.press(v.more())
    v.press(v.rows()[1]!)
    await flush()
    act(() => v.setForm({ form: formOf(), agent: ROBO, submit: async () => ({ ok: true }), close: () => v.setForm(undefined) }))
    expect(v.h.depth()).toBe(4)
    expect(v.profile()!.hasAttribute('inert')).toBe(true)
    expect(v.details()!.hasAttribute('inert')).toBe(true)
    v.h.back()
    expect(v.container.querySelector('.agent-form-screen')).toBeNull()
    expect(v.profile()!.hasAttribute('inert')).toBe(false)
    v.h.back()
    expect(v.profile()).toBeNull()
    expect(v.details()!.hasAttribute('inert')).toBe(false)
  })
})

describe('P1', () => {
  it.each([
    ['pt-BR', copy],
    ['en', en],
  ] as const)('on the screen (%s)', (locale, words) => {
    fakeDevice()
    applyLocale(locale)
    const v = mountForm({ kind: 'noAnswer' })
    expect(within(v.screen()!).getByRole('button', { name: words.dialog.close })).toBeTruthy()
    expect(findProtocolLeaksInText(v.container.innerHTML)).toEqual([])
  })
})
