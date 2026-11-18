// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, within, act, renderHook, waitFor } from '@testing-library/react'
import { AgentFormDialog, issueText } from '../../src/ui/components/AgentFormDialog'
import { useAgentForm } from '../../src/ui/useAgentForm'
import type { Acl, AgentForm, ChannelId, DomainEvent, FormField, FormId, FormIssue, FormState, FormValues, MessageId, User, UserId } from '../../src/acl'
import { validateFormValues } from '@tayet/shared/internal'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { copy, fill } from '../support/copy'

// ADR-103 (Proposto), workspace.md §25.5, §26 and §27 — the agent's form on the wide screen: every field kind
// (initial value, the value sent, description, groups, the checked ceiling), the copy of each validation code
// (fork I1), the states sending / failed / noAnswer / errors / done, fork I3 (a field's error goes when it
// changes; a refused submit focuses the first field with an error), closing, and no protocol on screen.

const uid = (s: string): UserId => s as unknown as UserId
const AGENT: User = { id: uid('@a-abcdefghijkl:tayet.local'), displayName: 'Publicação', kind: 'agent', agentColor: 'ardosia' }

const FIELDS: FormField[] = [
  { kind: 'context', text: 'Mude o que precisar.' },
  { kind: 'text', id: 'title', label: 'Título da página', hint: 'Aparece na aba do navegador.', optional: false, minLength: 3, maxLength: 40, initial: 'Boas-vindas' },
  { kind: 'number', id: 'days', label: 'Dias no ar', optional: false, decimal: false, min: '1', max: '90' },
  {
    kind: 'select',
    id: 'audience',
    label: 'Público',
    optional: false,
    placeholder: 'Escolha',
    choices: {
      groups: [
        { label: 'Pessoas', options: [{ value: 'all', label: 'Todos os membros', description: 'inclui convidados' }] },
        { label: 'Times', options: [{ value: 'product', label: 'Produto' }] },
      ],
    },
  },
  {
    kind: 'radio',
    id: 'when',
    label: 'Quando publicar',
    optional: false,
    options: [
      { value: 'now', label: 'Agora', description: 'Sai assim que aprovado' },
      { value: 'date', label: 'Na data escolhida' },
    ],
  },
  {
    kind: 'multiSelect',
    id: 'notify',
    label: 'Avisar em',
    optional: false,
    placeholder: 'ignored placeholder',
    maxSelected: 2,
    choices: {
      groups: [
        { label: 'Produto', options: [{ value: 'p1', label: 'Equipe Produto' }, { value: 'p2', label: 'design' }] },
        { label: 'Empresa', options: [{ value: 'e1', label: 'avisos' }] },
      ],
    },
  },
  { kind: 'checkboxes', id: 'flags', label: 'Opções', optional: true, options: [{ value: 'pin', label: 'Fixar', description: 'no topo do canal' }, { value: 'mute', label: 'Silenciar' }], initial: ['pin'] },
  { kind: 'longText', id: 'notes', label: 'Notas', optional: true, minLength: 0, maxLength: 3000 },
  { kind: 'date', id: 'due', label: 'Data', optional: true },
  { kind: 'email', id: 'mail', label: 'Email', optional: true },
  { kind: 'url', id: 'link', label: 'Link', optional: true },
]

const formOf = (state: FormState = { kind: 'open' }, fields: FormField[] = FIELDS): AgentForm => ({
  id: 'form-1' as FormId,
  channelId: '!r:tayet.local' as unknown as ChannelId,
  agent: AGENT.id,
  anchor: '$card' as unknown as MessageId,
  title: 'Ajustar publicação',
  submitLabel: 'Salvar',
  fields,
  state,
})

// The ACL's own rule: with issues nothing is sent; else the values go out.
function submitter() {
  const sent: FormValues[] = []
  const onSubmit = vi.fn(async (_id: FormId, values: FormValues): Promise<{ ok: true } | { issues: Record<string, FormIssue> }> => {
    const issues = validateFormValues(FIELDS, values)
    if (Object.keys(issues).length > 0) return { issues }
    sent.push(values)
    return { ok: true }
  })
  return { onSubmit, sent }
}

afterEach(cleanup)

const dialogOf = (r: ReturnType<typeof render>) => r.getByRole('dialog', { name: 'Ajustar publicação' })
const submitButton = (r: ReturnType<typeof render>) => within(dialogOf(r)).getByRole('button', { name: 'Salvar' })
const flush = () => act(async () => {})

function fillValid(r: ReturnType<typeof render>): void {
  fireEvent.change(r.getByLabelText('Dias no ar'), { target: { value: '30' } })
  fireEvent.change(r.getByLabelText('Público'), { target: { value: 'all' } })
  fireEvent.click(r.getByRole('radio', { name: /Agora/ }))
  fireEvent.click(r.getByRole('checkbox', { name: 'Equipe Produto' }))
}

describe('AgentFormDialog — the shell', () => {
  it('480 modifier on the tier Dialog; the agent mark, the title and the agent name in the title; Cancelar and the agent label', () => {
    const r = render(<AgentFormDialog form={formOf()} agent={AGENT} onSubmit={vi.fn()} onClose={vi.fn()} />)
    const dialog = dialogOf(r)
    expect(dialog.classList.contains('ui-dialog')).toBe(true)
    expect(dialog.classList.contains('agent-form')).toBe(true)
    const title = dialog.querySelector('.ui-dialog__title')!
    expect(title.querySelector('[data-agent-avatar]')?.getAttribute('aria-label')).toBe(copy.agent.label)
    expect(title.querySelector('.ui-avatar')?.getAttribute('data-size')).toBe('cotidiano')
    expect(title.querySelector('.agent-form__title')?.textContent).toBe('Ajustar publicação')
    expect(title.querySelector('.agent-form__agent')?.textContent).toBe('Publicação')
    const buttons = within(dialog.querySelector('.ui-dialog__footer') as HTMLElement).getAllByRole('button')
    expect(buttons.map((b) => [b.textContent, b.getAttribute('data-variant')])).toEqual([
      [copy.form.cancel, 'secondary'],
      ['Salvar', 'fill'],
    ])
    expect(dialog.querySelector('.agent-form__body')?.tagName).toBe('FORM')
    expect(findProtocolLeaksInText(dialog.textContent ?? '')).toEqual([])
    expect(findProtocolLeaksInText(r.container.innerHTML)).toEqual([])
  })

  it('the context paragraph renders muted, with no control; the first control takes the focus', () => {
    const r = render(<AgentFormDialog form={formOf()} agent={AGENT} onSubmit={vi.fn()} onClose={vi.fn()} />)
    expect(dialogOf(r).querySelector('.agent-form__context')?.textContent).toBe('Mude o que precisar.')
    expect(document.activeElement).toBe(r.getByLabelText('Título da página'))
  })

  it('a rich context goes by the card body path (RichText)', () => {
    const fields: FormField[] = [
      { kind: 'context', text: 'Revise o título', rich: [{ t: 'p', children: [{ t: 'text', text: 'Revise o ' }, { t: 'strong', children: [{ t: 'text', text: 'título' }] }] }] },
      { kind: 'text', id: 't', label: 'T', optional: true, minLength: 0, maxLength: 10 },
    ]
    const r = render(<AgentFormDialog form={formOf({ kind: 'open' }, fields)} agent={AGENT} onSubmit={vi.fn()} onClose={vi.fn()} />)
    expect(dialogOf(r).querySelector('.agent-form__context strong')?.textContent).toBe('título')
  })

  it('✕, Cancelar and Esc close without asking', () => {
    for (const how of ['x', 'cancel', 'esc'] as const) {
      const onClose = vi.fn()
      const r = render(<AgentFormDialog form={formOf()} agent={AGENT} onSubmit={vi.fn()} onClose={onClose} />)
      if (how === 'x') fireEvent.click(r.getByRole('button', { name: copy.dialog.close }))
      if (how === 'cancel') fireEvent.click(r.getByRole('button', { name: copy.form.cancel }))
      if (how === 'esc') fireEvent.keyDown(r.getByLabelText('Título da página'), { key: 'Escape' })
      expect(onClose).toHaveBeenCalledWith('form-1')
      cleanup()
    }
  })

  it('the agent still loading: "Alguém" in the title and the fallback colour', () => {
    const r = render(<AgentFormDialog form={formOf()} agent={undefined} onSubmit={vi.fn()} onClose={vi.fn()} />)
    expect(dialogOf(r).querySelector('.agent-form__agent')?.textContent).toBe(copy.timeline.someone)
  })
})

describe('AgentFormDialog — the fields', () => {
  it('text: initial value, hint under the control, the value typed is sent exactly', async () => {
    const { onSubmit, sent } = submitter()
    const r = render(<AgentFormDialog form={formOf()} agent={AGENT} onSubmit={onSubmit} onClose={vi.fn()} />)
    const input = r.getByLabelText('Título da página') as HTMLInputElement
    expect(input.value).toBe('Boas-vindas')
    const hint = input.closest('.ui-field')!.querySelector('.ui-field__hint')!
    expect(hint.textContent).toBe('Aparece na aba do navegador.')
    expect(input.getAttribute('aria-describedby')).toBe(hint.id)
    fireEvent.change(input, { target: { value: '  Olá, mundo  ' } })
    fillValid(r)
    fireEvent.click(submitButton(r))
    await flush()
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ title: '  Olá, mundo  ', days: '30', audience: 'all', when: 'now', notify: ['p1'], flags: ['pin'] })
  })

  it('number: a text box with the numeric keyboard (decimal for a decimal field)', () => {
    const fields: FormField[] = [
      { kind: 'number', id: 'n', label: 'Inteiro', optional: false, decimal: false },
      { kind: 'number', id: 'd', label: 'Decimal', optional: false, decimal: true },
    ]
    const r = render(<AgentFormDialog form={formOf({ kind: 'open' }, fields)} agent={AGENT} onSubmit={vi.fn()} onClose={vi.fn()} />)
    expect(r.getByLabelText('Inteiro').getAttribute('type')).toBe('text')
    expect(r.getByLabelText('Inteiro').getAttribute('inputmode')).toBe('numeric')
    expect(r.getByLabelText('Decimal').getAttribute('inputmode')).toBe('decimal')
  })

  it('select: native, the first option empty with the placeholder; groups as optgroup; "rótulo — descrição"', () => {
    const r = render(<AgentFormDialog form={formOf()} agent={AGENT} onSubmit={vi.fn()} onClose={vi.fn()} />)
    const select = r.getByLabelText('Público') as HTMLSelectElement
    expect(select.tagName).toBe('SELECT')
    expect(select.options[0]!.value).toBe('')
    expect(select.options[0]!.textContent).toBe('Escolha')
    expect(select.value).toBe('')
    const groups = [...select.querySelectorAll('optgroup')].map((g) => [g.label, [...g.querySelectorAll('option')].map((o) => o.textContent)])
    expect(groups).toEqual([
      ['Pessoas', ['Todos os membros — inclui convidados']],
      ['Times', ['Produto']],
    ])
  })

  it('date: the native date control with its initial value', () => {
    const fields: FormField[] = [{ kind: 'date', id: 'due', label: 'Data', optional: true, initial: '2026-11-18' }]
    const r = render(<AgentFormDialog form={formOf({ kind: 'open' }, fields)} agent={AGENT} onSubmit={vi.fn()} onClose={vi.fn()} />)
    const input = r.getByLabelText(`Data ${copy.field.optional}`) as HTMLInputElement
    expect(input.type).toBe('date')
    expect(input.value).toBe('2026-11-18')
  })

  it('longText: a textarea, optional, initial', () => {
    const fields: FormField[] = [{ kind: 'longText', id: 'n', label: 'Notas', optional: true, minLength: 0, maxLength: 100, initial: 'linha 1\nlinha 2' }]
    const r = render(<AgentFormDialog form={formOf({ kind: 'open' }, fields)} agent={AGENT} onSubmit={vi.fn()} onClose={vi.fn()} />)
    const area = r.getByLabelText(`Notas ${copy.field.optional}`) as HTMLTextAreaElement
    expect(area.tagName).toBe('TEXTAREA')
    expect(area.value).toBe('linha 1\nlinha 2')
  })

  it('radio: a radiogroup named by the label; the description is a second line; initial checked', () => {
    const fields: FormField[] = [
      { kind: 'radio', id: 'w', label: 'Quando', optional: false, initial: 'b', options: [{ value: 'a', label: 'Agora', description: 'Sai já' }, { value: 'b', label: 'Depois' }] },
    ]
    const r = render(<AgentFormDialog form={formOf({ kind: 'open' }, fields)} agent={AGENT} onSubmit={vi.fn()} onClose={vi.fn()} />)
    const group = r.getByRole('radiogroup', { name: 'Quando' })
    const radios = within(group).getAllByRole('radio') as HTMLInputElement[]
    expect(radios.map((x) => x.checked)).toEqual([false, true])
    const row = radios[0]!.closest('.agent-form__opt')!
    expect(row.hasAttribute('data-desc')).toBe(true)
    expect(row.querySelector('.agent-form__opt-desc')?.textContent).toBe('Sai já')
    expect(radios[1]!.closest('.agent-form__opt')!.hasAttribute('data-desc')).toBe(false)
  })

  it('checkboxes: initial list, toggling, the description line', async () => {
    const r = render(<AgentFormDialog form={formOf()} agent={AGENT} onSubmit={vi.fn()} onClose={vi.fn()} />)
    const group = r.getByRole('group', { name: `Opções ${copy.field.optional}` })
    const boxes = within(group).getAllByRole('checkbox') as HTMLInputElement[]
    expect(boxes.map((b) => b.checked)).toEqual([true, false])
    expect(boxes[0]!.closest('.agent-form__opt')!.querySelector('.agent-form__opt-desc')?.textContent).toBe('no topo do canal')
    fireEvent.click(boxes[1]!)
    expect(boxes[1]!.checked).toBe(true)
  })

  it('multiSelect (D4): a list with group titles; at the maximum the unchecked are disabled and "Até {n}" shows; the placeholder is ignored', () => {
    const r = render(<AgentFormDialog form={formOf()} agent={AGENT} onSubmit={vi.fn()} onClose={vi.fn()} />)
    const list = r.getByRole('group', { name: 'Avisar em' })
    expect(list.classList.contains('agent-form__list')).toBe(true)
    expect([...list.querySelectorAll('.agent-form__group')].map((g) => g.textContent)).toEqual(['Produto', 'Empresa'])
    expect(within(list).getByRole('group', { name: 'Empresa' })).toBeTruthy()
    expect(r.container.textContent).not.toContain('ignored placeholder')
    const field = list.closest('.ui-field')!
    expect(field.querySelector('.agent-form__max')).toBeNull()
    fireEvent.click(r.getByRole('checkbox', { name: 'Equipe Produto' }))
    fireEvent.click(r.getByRole('checkbox', { name: 'avisos' }))
    const design = r.getByRole('checkbox', { name: 'design' }) as HTMLInputElement
    expect(design.disabled).toBe(true)
    expect(design.closest('.agent-form__opt')!.hasAttribute('data-off')).toBe(true)
    expect(field.querySelector('.agent-form__max')?.textContent).toBe(fill(copy.form.upTo, { n: 2 }))
    // Unchecking one frees the rest.
    fireEvent.click(r.getByRole('checkbox', { name: 'avisos' }))
    expect(design.disabled).toBe(false)
    expect(field.querySelector('.agent-form__max')).toBeNull()
  })
})

describe('AgentFormDialog — validation codes (fork I1)', () => {
  const text = { kind: 'text', id: 't', label: 'T', optional: false, minLength: 3, maxLength: 5 } as const
  const integer = { kind: 'number', id: 'n', label: 'N', optional: false, decimal: false } as const
  const decimal = { kind: 'number', id: 'd', label: 'D', optional: false, decimal: true } as const
  const cases: Array<[FormField & { kind: Exclude<FormField['kind'], 'context'> }, FormIssue, string]> = [
    [text, { code: 'required' }, copy.form.issue.required],
    [text, { code: 'minLength', min: 3 }, fill(copy.form.issue.minLength, { min: 3 })],
    [text, { code: 'maxLength', max: 5 }, fill(copy.form.issue.maxLength, { max: 5 })],
    [text, { code: 'email' }, copy.form.issue.email],
    [text, { code: 'url' }, copy.form.issue.url],
    [decimal, { code: 'number' }, copy.form.issue.number],
    [integer, { code: 'number' }, copy.form.issue.integer],
    [integer, { code: 'range', min: '1', max: '9' }, fill(copy.form.issue.between, { min: '1', max: '9' })],
    [integer, { code: 'range', min: '1' }, fill(copy.form.issue.atLeast, { min: '1' })],
    [integer, { code: 'range', max: '9' }, fill(copy.form.issue.atMost, { max: '9' })],
    [text, { code: 'date' }, copy.form.issue.date],
    [text, { code: 'option' }, copy.form.issue.option],
  ]
  it.each(cases)('%#: %j → the copy', (field, issue, expected) => {
    expect(issueText(field, issue)).toBe(expected)
  })
  it('the copy is the ratified text', () => {
    expect(copy.form.issue).toEqual({
      required: 'Campo obrigatório',
      minLength: 'Use pelo menos {min} caracteres',
      maxLength: 'Use no máximo {max} caracteres',
      email: 'Use um email válido',
      url: 'Use um endereço completo, como https://exemplo.com',
      number: 'Use um número',
      integer: 'Use um número inteiro',
      between: 'Use um valor entre {min} e {max}',
      atLeast: 'Use um valor de {min} ou mais',
      atMost: 'Use um valor de até {max}',
      date: 'Use uma data válida',
      option: 'Escolha uma das opções',
    })
  })

  it('a refused submit: the copy per field, nothing sent, the focus on the first field with an error (I3)', async () => {
    const { onSubmit, sent } = submitter()
    const r = render(<AgentFormDialog form={formOf()} agent={AGENT} onSubmit={onSubmit} onClose={vi.fn()} />)
    fireEvent.change(r.getByLabelText('Título da página'), { target: { value: 'ab' } })
    fireEvent.change(r.getByLabelText('Dias no ar'), { target: { value: '120' } })
    fireEvent.click(submitButton(r))
    await flush()
    expect(sent).toHaveLength(0)
    const errorOf = (label: string) => r.getByText(label, { selector: '.ui-field__label' }).closest('.ui-field')!.querySelector('[role="alert"]')?.textContent
    expect(errorOf('Título da página')).toBe(fill(copy.form.issue.minLength, { min: 3 }))
    expect(errorOf('Dias no ar')).toBe(fill(copy.form.issue.between, { min: '1', max: '90' }))
    expect(errorOf('Público')).toBe(copy.form.issue.required)
    expect(errorOf('Quando publicar')).toBe(copy.form.issue.required)
    expect(errorOf('Avisar em')).toBe(copy.form.issue.required)
    expect(document.activeElement).toBe(r.getByLabelText('Título da página'))
    // The hint stays, under the error.
    const field = r.getByLabelText('Título da página').closest('.ui-field')!
    expect([...field.children].map((c) => c.className)).toEqual(['ui-field__label', 'ui-field__input', 'ui-field__error', 'ui-field__hint'])
    expect(r.getByLabelText('Título da página').getAttribute('aria-invalid')).toBe('true')
  })

  it('I3: a field\'s error goes when the person changes that field, the others stay', async () => {
    const { onSubmit } = submitter()
    const r = render(<AgentFormDialog form={formOf()} agent={AGENT} onSubmit={onSubmit} onClose={vi.fn()} />)
    fireEvent.change(r.getByLabelText('Título da página'), { target: { value: '' } })
    fireEvent.click(submitButton(r))
    await flush()
    const titleField = r.getByLabelText('Título da página').closest('.ui-field')!
    expect(titleField.querySelector('[role="alert"]')).not.toBeNull()
    fireEvent.change(r.getByLabelText('Título da página'), { target: { value: 'x' } })
    expect(titleField.querySelector('[role="alert"]')).toBeNull()
    expect(r.getByLabelText('Dias no ar').closest('.ui-field')!.querySelector('[role="alert"]')).not.toBeNull()
  })
})

describe('AgentFormDialog — states', () => {
  it('sending: the submit disabled, reading "Enviando…"', () => {
    const r = render(<AgentFormDialog form={formOf({ kind: 'sending' })} agent={AGENT} onSubmit={vi.fn()} onClose={vi.fn()} />)
    const button = within(dialogOf(r)).getByRole('button', { name: copy.timeline.sending }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(dialogOf(r).querySelector('.agent-form__status')).toBeNull()
  })

  it('failed: "Não enviado" in danger in the footer; the submit reads "Tentar de novo" and sends again', async () => {
    const onSubmit = vi.fn(async () => ({ ok: true as const }))
    const r = render(<AgentFormDialog form={formOf({ kind: 'failed' })} agent={AGENT} onSubmit={onSubmit} onClose={vi.fn()} />)
    const status = dialogOf(r).querySelector('.ui-dialog__footer .agent-form__status')!
    expect(status.textContent).toBe(copy.timeline.failed)
    expect(status.getAttribute('role')).toBe('alert')
    fireEvent.click(within(dialogOf(r)).getByRole('button', { name: copy.timeline.retry }))
    await flush()
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('noAnswer: "{agente} não respondeu" and "Tentar de novo"', () => {
    const r = render(<AgentFormDialog form={formOf({ kind: 'noAnswer' })} agent={AGENT} onSubmit={vi.fn()} onClose={vi.fn()} />)
    expect(dialogOf(r).querySelector('.agent-form__status')?.textContent).toBe(fill(copy.form.noAnswer, { agent: 'Publicação' }))
    expect(within(dialogOf(r)).getByRole('button', { name: copy.timeline.retry })).toBeTruthy()
  })

  it('errors: the agent\'s message under the field, the hint stays, the focus goes to it; changing it clears it (I3)', () => {
    const r = render(<AgentFormDialog form={formOf({ kind: 'open' })} agent={AGENT} onSubmit={vi.fn()} onClose={vi.fn()} />)
    r.rerender(<AgentFormDialog form={formOf({ kind: 'errors', errors: { title: 'Esse título já existe' } })} agent={AGENT} onSubmit={vi.fn()} onClose={vi.fn()} />)
    const input = r.getByLabelText('Título da página')
    const field = input.closest('.ui-field')!
    expect(field.querySelector('[role="alert"]')?.textContent).toBe('Esse título já existe')
    expect(field.querySelector('.ui-field__hint')?.textContent).toBe('Aparece na aba do navegador.')
    expect(document.activeElement).toBe(input)
    // The submit keeps the agent's label; no footer status.
    expect(within(dialogOf(r)).getByRole('button', { name: 'Salvar' })).toBeTruthy()
    expect(dialogOf(r).querySelector('.agent-form__status')).toBeNull()
    fireEvent.change(input, { target: { value: 'Outro' } })
    expect(field.querySelector('[role="alert"]')).toBeNull()
  })

  it('errors with no field id (R1): "Não enviado" in the footer, the submit reads "Tentar de novo", takes the focus and sends again', async () => {
    const onSubmit = vi.fn(async () => ({ ok: true as const }))
    const r = render(<AgentFormDialog form={formOf({ kind: 'open' })} agent={AGENT} onSubmit={onSubmit} onClose={vi.fn()} />)
    r.rerender(<AgentFormDialog form={formOf({ kind: 'errors', errors: { ghost: 'Campo sumiu', other: 'Também' } })} agent={AGENT} onSubmit={onSubmit} onClose={vi.fn()} />)
    const status = dialogOf(r).querySelector('.ui-dialog__footer .agent-form__status')!
    expect(status.textContent).toBe(copy.timeline.failed)
    expect(status.getAttribute('role')).toBe('alert')
    const button = within(dialogOf(r)).getByRole('button', { name: copy.timeline.retry })
    expect(document.activeElement).toBe(button)
    expect(within(dialogOf(r)).queryByText('Campo sumiu')).toBeNull()
    expect(within(dialogOf(r)).queryByRole('button', { name: 'Salvar' })).toBeNull()
    fireEvent.click(button)
    await flush()
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it('errors with field and unknown ids mixed (R1): only the field that exists shows its error, no footer status', () => {
    const r = render(<AgentFormDialog form={formOf({ kind: 'open' })} agent={AGENT} onSubmit={vi.fn()} onClose={vi.fn()} />)
    r.rerender(<AgentFormDialog form={formOf({ kind: 'errors', errors: { ghost: 'Campo sumiu', title: 'Esse título já existe' } })} agent={AGENT} onSubmit={vi.fn()} onClose={vi.fn()} />)
    const input = r.getByLabelText('Título da página')
    expect(input.closest('.ui-field')!.querySelector('[role="alert"]')?.textContent).toBe('Esse título já existe')
    expect(within(dialogOf(r)).queryByText('Campo sumiu')).toBeNull()
    expect(dialogOf(r).querySelector('.agent-form__status')).toBeNull()
    expect(within(dialogOf(r)).getByRole('button', { name: 'Salvar' })).toBeTruthy()
    expect(document.activeElement).toBe(input)
  })

  it('the values typed survive the state moves (sending → errors)', () => {
    const r = render(<AgentFormDialog form={formOf({ kind: 'open' })} agent={AGENT} onSubmit={vi.fn()} onClose={vi.fn()} />)
    fireEvent.change(r.getByLabelText('Dias no ar'), { target: { value: '42' } })
    r.rerender(<AgentFormDialog form={formOf({ kind: 'sending' })} agent={AGENT} onSubmit={vi.fn()} onClose={vi.fn()} />)
    r.rerender(<AgentFormDialog form={formOf({ kind: 'errors', errors: { days: 'Não' } })} agent={AGENT} onSubmit={vi.fn()} onClose={vi.fn()} />)
    expect((r.getByLabelText('Dias no ar') as HTMLInputElement).value).toBe('42')
  })
})

describe('AgentFormDialog — decimal comma (fork R2)', () => {
  const NUMS: FormField[] = [
    { kind: 'number', id: 'd', label: 'Decimal', optional: false, decimal: true },
    { kind: 'number', id: 'n', label: 'Inteiro', optional: true, decimal: false },
  ]
  function numSubmitter() {
    const sent: FormValues[] = []
    const onSubmit = vi.fn(async (_id: FormId, values: FormValues): Promise<{ ok: true } | { issues: Record<string, FormIssue> }> => {
      const issues = validateFormValues(NUMS, values)
      if (Object.keys(issues).length > 0) return { issues }
      sent.push(values)
      return { ok: true }
    })
    return { onSubmit, sent }
  }
  const errorUnder = (el: HTMLElement) => el.closest('.ui-field')!.querySelector('[role="alert"]')?.textContent

  it('a decimal field sends "12,5" as "12.5"; the box keeps "12,5"', async () => {
    const { onSubmit, sent } = numSubmitter()
    const r = render(<AgentFormDialog form={formOf({ kind: 'open' }, NUMS)} agent={AGENT} onSubmit={onSubmit} onClose={vi.fn()} />)
    const input = r.getByLabelText('Decimal') as HTMLInputElement
    fireEvent.change(input, { target: { value: '12,5' } })
    fireEvent.click(submitButton(r))
    await flush()
    expect(onSubmit.mock.calls[0]![1]).toMatchObject({ d: '12.5' })
    expect(sent).toEqual([{ d: '12.5', n: '' }])
    expect(input.value).toBe('12,5')
  })

  it('"1.234,5" goes as typed and is refused with the usual copy', async () => {
    const { onSubmit, sent } = numSubmitter()
    const r = render(<AgentFormDialog form={formOf({ kind: 'open' }, NUMS)} agent={AGENT} onSubmit={onSubmit} onClose={vi.fn()} />)
    const input = r.getByLabelText('Decimal') as HTMLInputElement
    fireEvent.change(input, { target: { value: '1.234,5' } })
    fireEvent.click(submitButton(r))
    await flush()
    expect(onSubmit.mock.calls[0]![1]).toMatchObject({ d: '1.234,5' })
    expect(sent).toHaveLength(0)
    expect(errorUnder(input)).toBe(copy.form.issue.number)
    expect(input.value).toBe('1.234,5')
  })

  it('an integer field gets "12,5" as typed, refused with "Use um número inteiro"', async () => {
    const { onSubmit, sent } = numSubmitter()
    const r = render(<AgentFormDialog form={formOf({ kind: 'open' }, NUMS)} agent={AGENT} onSubmit={onSubmit} onClose={vi.fn()} />)
    fireEvent.change(r.getByLabelText('Decimal'), { target: { value: '3' } })
    const input = r.getByLabelText(/Inteiro/) as HTMLInputElement
    fireEvent.change(input, { target: { value: '12,5' } })
    fireEvent.click(submitButton(r))
    await flush()
    expect(onSubmit.mock.calls[0]![1]).toMatchObject({ d: '3', n: '12,5' })
    expect(sent).toHaveLength(0)
    expect(errorUnder(input)).toBe(copy.form.issue.integer)
    expect(copy.form.issue.integer).toBe('Use um número inteiro')
    expect(input.value).toBe('12,5')
  })
})

describe('useAgentForm', () => {
  function fakeAcl() {
    const handlers = new Set<(e: DomainEvent) => void>()
    const closed: FormId[] = []
    const acl = {
      subscribe: (h: (e: DomainEvent) => void) => {
        handlers.add(h)
        return () => handlers.delete(h)
      },
      getMembers: async () => [{ user: AGENT, role: 'member', state: 'joined', self: false }],
      submitForm: vi.fn(async () => ({ ok: true as const })),
      closeForm: (id: FormId) => closed.push(id),
    } as unknown as Acl
    return { acl, closed, emit: (e: DomainEvent) => act(() => handlers.forEach((h) => h(e))) }
  }

  it('opens on form.opened, follows form.changed, and done closes it (I4); the agent is read from the conversation', async () => {
    const { acl, emit } = fakeAcl()
    const { result } = renderHook(() => useAgentForm(acl))
    const form = formOf()
    emit({ t: 'form.opened', channelId: form.channelId, form })
    expect(result.current.form?.id).toBe(form.id)
    await waitFor(() => expect(result.current.agent?.displayName).toBe('Publicação'))
    emit({ t: 'form.changed', channelId: form.channelId, form: { ...form, state: { kind: 'sending' } } })
    expect(result.current.form?.state.kind).toBe('sending')
    emit({ t: 'form.changed', channelId: form.channelId, form: { ...form, state: { kind: 'done' } } })
    expect(result.current.form).toBeUndefined()
  })

  it('close discards here and in the ACL; a change of another form is ignored', () => {
    const { acl, emit, closed } = fakeAcl()
    const { result } = renderHook(() => useAgentForm(acl))
    const form = formOf()
    emit({ t: 'form.opened', channelId: form.channelId, form })
    emit({ t: 'form.changed', channelId: form.channelId, form: { ...form, id: 'other' as FormId, state: { kind: 'done' } } })
    expect(result.current.form?.id).toBe(form.id)
    act(() => result.current.close(form.id))
    expect(closed).toEqual([form.id])
    expect(result.current.form).toBeUndefined()
  })
})
