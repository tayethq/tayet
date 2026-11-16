// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, fireEvent, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { AccountSettings } from '../../src/ui/components/AccountSettings'
import { ptBR } from '../../src/ui/i18n/pt-BR'
import { noExport } from '../support/data-export-fake'

// "Seus dados" in "Sua conta" (manifesto account-access.md §12.1 item 1; ADR-096 dec. 9): every person
// sees the section, member or guest; for the admin it sits before "Organização". The entry opens the
// export dialog, whose ✕ goes back to "Sua conta" (PLANO-EXPORT-DADOS §0.3.6 item 1).

const copy = ptBR.dataExport

afterEach(cleanup)

describe('"Seus dados" in "Sua conta" (account-access.md §12.1 item 1)', () => {
  function account(props: Partial<ComponentProps<typeof AccountSettings>> = {}) {
    return render(
      <AccountSettings
        open
        accesses={[]}
        onLoadProfile={async () => ({ fullName: 'Marina' })}
        onSaveProfile={async () => {}}
        onSaveAvatar={async () => {}}
        onClearAvatar={async () => {}}
        onExportData={noExport}
        onReset={() => {}}
        onSignOut={() => {}}
        theme="light"
        onThemeChange={() => {}}
        onClose={() => {}}
        {...props}
      />,
    )
  }
  const sections = (root: HTMLElement) =>
    [...root.querySelectorAll('.account-settings__section-title')].map((h) => h.textContent)

  it('a member or a guest (no admin) sees it after "Acesso"', () => {
    const view = account()
    expect(sections(view.container)).toEqual([ptBR.account.accessSection, copy.section])
    const entry = view.getByRole('button', { name: (n) => n.startsWith(copy.entry) && n.endsWith(copy.entrySummary) })
    expect(entry).toBeTruthy()
  })

  it('the admin sees it before "Organização"', () => {
    const view = account({ orgAdmin: true, people: [] })
    expect(sections(view.container)).toEqual([ptBR.account.accessSection, copy.section, ptBR.people.orgSection])
  })

  it('the entry opens the dialog; ✕ goes back to "Sua conta"', () => {
    const view = account()
    fireEvent.click(view.getByRole('button', { name: (n) => n.startsWith(copy.entry) && n.endsWith(copy.entrySummary) }))
    const dialog = view.getByRole('dialog', { name: copy.title })
    fireEvent.click(within(dialog).getByRole('button', { name: ptBR.dialog.close }))
    expect(view.getByRole('dialog', { name: ptBR.account.title })).toBeTruthy()
  })
})
