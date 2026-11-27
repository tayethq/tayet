// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { AccountSettings } from '../../src/ui/components/AccountSettings'
import type { Person, UserId } from '../../src/acl'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { copy, fill } from '../support/copy'
import { noExport } from '../support/data-export-fake'
import { idleLanguage } from '../support/language-fake'

// "Sua conta" do admin: a seção "Organização" com a linha "Administrar organização", que abre a Admin
// (organization-admin.md §2.1 item 5; C7 da fatia 1c). A lista de Pessoas mora na Admin (org-admin.test.tsx).
// Os ids de fixture têm shape de protocolo de propósito: cruzam como key e nunca chegam ao DOM.

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
      onThemeChange={() => {}} language={idleLanguage}
      onClose={() => {}}
      {...props}
    />
  )
}

afterEach(cleanup)

const entry = (ui: ReturnType<typeof open>) => ui.queryByRole('button', { name: new RegExp(`^${copy.admin.entry}`) })

describe('"Sua conta" — seção Organização', () => {
  it('não existe para quem não é admin', () => {
    const ui = open({ people: everyone, onOpenAdmin: () => {} })
    expect(ui.queryByText(copy.people.orgSection)).toBeNull()
    expect(entry(ui)).toBeNull()
  })

  it('não existe sem a Admin ligada', () => {
    const ui = open({ orgAdmin: true, people: everyone })
    expect(ui.queryByText(copy.people.orgSection)).toBeNull()
  })

  it('admin: "Administrar organização" com o resumo de pessoas e convidados, com divisor antes e depois', () => {
    const ui = open({ orgAdmin: true, people: everyone, onOpenAdmin: () => {} })
    const section = ui.getByText(copy.people.orgSection).closest('section')!
    expect(section.querySelector('.account-settings__access-entry-label')?.textContent).toBe(copy.admin.entry)
    expect(section.querySelector('.account-settings__access-entry-summary')?.textContent).toBe(
      `${fill(copy.people.summaryPeople.other, { n: 4 })} · ${fill(copy.people.summaryGuests.one, { n: 1 })}`,
    )
    expect(section.previousElementSibling?.tagName).toBe('HR')
    expect(section.nextElementSibling?.tagName).toBe('HR')
    expect(ui.queryByRole('button', { name: new RegExp(`^${copy.people.title}`) })).toBeNull()
    expect(findProtocolLeaksInText(ui.container.innerHTML)).toEqual([])
  })

  it('a linha fecha "Sua conta" e abre a Admin', () => {
    const onClose = vi.fn()
    const onOpenAdmin = vi.fn()
    const ui = open({ orgAdmin: true, people: everyone, onOpenAdmin, onClose })
    fireEvent.click(entry(ui)!)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onOpenAdmin).toHaveBeenCalledTimes(1)
  })

  it('na tela estreita a seção não aparece', () => {
    const ui = open({ orgAdmin: true, people: everyone, onOpenAdmin: () => {}, narrow: true })
    expect(entry(ui)).toBeNull()
  })
})

describe('resumo da linha: plural do catálogo (§9.2 c)', () => {
  const { summaryPeople, summaryGuests } = copy.people
  it.each([
    [1, 1, summaryPeople.one, summaryGuests.one],
    [2, 0, summaryPeople.other, summaryGuests.other],
    [12, 2, summaryPeople.other, summaryGuests.other],
  ])('%i pessoas, %i convidados', (n, m, peopleForm, guestsForm) => {
    const people = Array.from({ length: n }, (_, i) =>
      person(`Pessoa ${i}`, { kind: i < m ? 'guest' : 'member' }),
    )
    const ui = open({ orgAdmin: true, people, onOpenAdmin: () => {} })
    const summary = ui.container.querySelectorAll('.account-settings__access-entry-summary')
    expect(summary[summary.length - 1]?.textContent).toBe(`${fill(peopleForm, { n })} · ${fill(guestsForm, { n: m })}`)
  })
})
