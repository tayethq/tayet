// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, fireEvent, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { AccountSettings } from '../../src/ui/components/AccountSettings'
import type { Person, UserId } from '../../src/acl'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { copy, fill } from '../support/copy'
import { noExport } from '../support/data-export-fake'

// "Sua conta" do admin e a sub-tela "Pessoas" (manifesto account-access.md §7 item 1, §9.1). Os ids de
// fixture têm shape de protocolo de propósito: cruzam como key e nunca chegam ao DOM.

const uid = (s: string): UserId => s as unknown as UserId
const person = (
  name: string,
  over: Partial<Pick<Person, 'email' | 'pending' | 'self'>> & { kind?: 'member' | 'guest' } = {},
): Person => ({
  user: { id: uid(`@u-abc234def567-${name}:tayet.local`), displayName: name, kind: over.kind ?? 'member' },
  email: over.email,
  pending: over.pending ?? false,
  self: over.self ?? false,
})

const everyone: Person[] = [
  person('Vera Campos', { email: 'vera@campos.com', kind: 'guest' }),
  person('Ana Costa', { email: 'ana@vega.com' }),
  person('Lúcia Ferraz', { email: 'lucia@vega.com', pending: true }),
  person('Marina Alves', { self: true }),
]

function open(props: Partial<ComponentProps<typeof AccountSettings>> = {}) {
  return render(
    <AccountSettings
      open
      accesses={[]}
      onLoadProfile={async () => ({ fullName: 'Marina' })}
      onSaveProfile={async () => {}}
      onSaveAvatar={async () => {}}
      onClearAvatar={async () => {}} onExportData={noExport}
      onReset={() => {}}
      onSignOut={() => {}}
      theme="light"
      onThemeChange={() => {}}
      onClose={() => {}}
      {...props}
    />
  )
}

afterEach(cleanup)

const enter = (ui: ReturnType<typeof open>) =>
  fireEvent.click(ui.getByRole('button', { name: new RegExp(copy.people.title) }))

describe('"Sua conta" — seção Organização', () => {
  it('não existe para quem não é admin', () => {
    const ui = open({ people: everyone })
    expect(ui.queryByText(copy.people.orgSection)).toBeNull()
    expect(ui.queryByRole('button', { name: new RegExp(copy.people.title) })).toBeNull()
  })

  it('admin: resumo com todas as pessoas e os convidados, com divisor antes e depois', () => {
    const ui = open({ orgAdmin: true, people: everyone })
    const section = ui.getByText(copy.people.orgSection).closest('section')!
    expect(section.querySelector('.account-settings__access-entry-summary')?.textContent).toBe(
      `${fill(copy.people.summaryPeople.other, { n: 4 })} · ${fill(copy.people.summaryGuests.one, { n: 1 })}`,
    )
    expect(section.previousElementSibling?.tagName).toBe('HR')
    expect(section.nextElementSibling?.tagName).toBe('HR')
    expect(findProtocolLeaksInText(ui.container.innerHTML)).toEqual([])
  })
})

describe('resumo da linha Pessoas: plural do catálogo (§9.2 c)', () => {
  const { summaryPeople, summaryGuests } = copy.people
  it.each([
    [1, 1, summaryPeople.one, summaryGuests.one],
    [2, 0, summaryPeople.other, summaryGuests.other],
    [12, 2, summaryPeople.other, summaryGuests.other],
  ])('%i pessoas, %i convidados', (n, m, peopleForm, guestsForm) => {
    const people = Array.from({ length: n }, (_, i) =>
      person(`Pessoa ${i}`, { kind: i < m ? 'guest' : 'member' }),
    )
    const ui = open({ orgAdmin: true, people })
    const summary = ui.container.querySelectorAll('.account-settings__access-entry-summary')
    expect(summary[summary.length - 1]?.textContent).toBe(`${fill(peopleForm, { n })} · ${fill(guestsForm, { n: m })}`)
  })
})

describe('sub-tela Pessoas', () => {
  it('lista plana por nome; meta com email e situação; sem email, só a situação', () => {
    const ui = open({ orgAdmin: true, people: everyone })
    enter(ui)
    const rows = within(ui.getByRole('list', { name: copy.people.title })).getAllByRole('listitem')
    expect(rows.map((r) => r.querySelector('.people__name')?.textContent)).toEqual([
      'Ana Costa',
      'Lúcia Ferraz',
      'Marina Alves',
      'Vera Campos',
    ])
    expect(rows[0]!.textContent).toContain(`ana@vega.com · ${copy.people.kindMember}`)
    expect(rows[1]!.textContent).toContain(`lucia@vega.com · ${copy.people.pending}`)
    expect(rows[2]!.querySelector('.people__meta')?.textContent).toBe(copy.people.kindMember)
    expect(rows[3]!.textContent).toContain(`vera@campos.com · ${copy.people.kindGuest}`)
  })

  it('"Remover" sempre visível, ausente em self; pendente com monograma tracejado e "Cancelar convite"', () => {
    const ui = open({ orgAdmin: true, people: everyone })
    enter(ui)
    expect(ui.getByRole('button', { name: fill(copy.people.removeLabel, { name: 'Ana Costa' }) }).textContent).toBe(
      copy.people.remove,
    )
    expect(ui.queryByRole('button', { name: fill(copy.people.removeLabel, { name: 'Marina Alves' }) })).toBeNull()
    const cancel = ui.getByRole('button', { name: fill(copy.people.cancelInviteTitle, { name: 'Lúcia Ferraz' }) })
    expect(cancel.textContent).toBe(copy.people.cancelInvite)
    expect(cancel.closest('li')!.querySelector('.people__mono-pending')).toBeTruthy()
    expect(cancel.closest('li')!.querySelector('.ui-avatar')).toBeNull()
  })

  it('filtro por nome ou email; ✕ só com termo; sem resultado', () => {
    const ui = open({ orgAdmin: true, people: everyone })
    enter(ui)
    const filter = ui.getByRole('textbox', { name: copy.people.filter })
    expect(ui.queryByRole('button', { name: copy.people.clearFilter })).toBeNull()

    fireEvent.change(filter, { target: { value: 'CAMPOS.com' } })
    expect(ui.getAllByRole('listitem')).toHaveLength(1)

    fireEvent.change(filter, { target: { value: 'joana' } })
    expect(ui.queryByRole('list')).toBeNull()
    expect(ui.getByText(fill(copy.people.noResults, { term: 'joana' }))).toBeTruthy()

    fireEvent.click(ui.getByRole('button', { name: copy.people.clearFilter }))
    expect(ui.getAllByRole('listitem')).toHaveLength(4)
  })

  it('vazia: a própria linha e "Só você por enquanto."', () => {
    const ui = open({ orgAdmin: true, people: [person('Marina Alves', { self: true })] })
    enter(ui)
    expect(ui.getAllByRole('listitem')).toHaveLength(1)
    expect(ui.getByText(copy.people.onlyYou)).toBeTruthy()
  })

  it('P1: nenhum id no DOM da sub-tela', () => {
    const ui = open({ orgAdmin: true, people: everyone })
    enter(ui)
    expect(findProtocolLeaksInText(ui.container.innerHTML)).toEqual([])
  })
})
