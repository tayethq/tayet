// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { NewAccessBanner } from '../../src/ui/components/NewAccessBanner'
import { ResetAccessBanner, type ResetStatus } from '../../src/ui/components/ResetAccessBanner'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import type { AccessId } from '../../src/acl'

// A3-5 (PLANO-AGENTES §0.3.18 item 5; manifest workspace.md §14 items 1–2, §6.7, §16, §19.5 item 4): the
// fidelity of the two banners of the slot — one wrapper for "Novo acesso" (the region is the strip, the
// status only its text; the quiet action in the live "Restaurar" idiom) and the reset's states (danger
// only in idle/notDone, the Button primitive, the Sweep in pending).

const aid = (s: string): AccessId => s as unknown as AccessId

afterEach(cleanup)

describe('"Novo acesso" (§14 item 1)', () => {
  it.each([
    ['one', [{ access: aid('DEV1'), friendlyName: 'Laptop de Ana' }], 'Laptop de Ana'],
    ['many', [{ access: aid('DEV1') }, { access: aid('DEV2') }], '2 novos acessos à sua conta'],
  ])('%s: ONE wrapper — the region is the strip, the status only the text; the quiet Button', (_state, accesses, shown) => {
    const { container, getByRole } = render(<NewAccessBanner accesses={accesses} onDismiss={() => {}} />)
    const region = getByRole('region', { name: 'Avisos de segurança da conta' })
    expect(container.firstElementChild).toBe(region)
    expect(region.className).toBe('new-access-banner')
    const status = getByRole('status')
    expect(status.parentElement).toBe(region)
    expect(status.textContent).toContain(shown)
    const dismiss = getByRole('button', { name: 'Fui eu, dispensar' })
    expect(status.contains(dismiss)).toBe(false)
    expect(dismiss.className).toContain('ui-button')
    expect(dismiss.getAttribute('data-variant')).toBe('ghost')
    expect(dismiss.getAttribute('data-size')).toBe('gestao')
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })
})

describe('reset (§14 item 2)', () => {
  const view = (status: ResetStatus) => render(<ResetAccessBanner present status={status} onReset={() => {}} onSignOut={() => {}} />)

  it.each([
    ['idle', 'true', 'Redefinir o acesso', 'danger-fill'],
    ['notDone', 'true', 'Tentar de novo', 'danger-fill'],
    ['done', 'false', 'Entrar de novo', 'fill'],
  ] as const)('%s: danger=%s, the Button primitive (gestao) and no sweep', (status, danger, action, variant) => {
    const { container, getByRole } = view(status)
    const region = getByRole('region', { name: 'Ação necessária na conta' })
    expect(region.getAttribute('data-danger')).toBe(danger)
    const button = getByRole('button', { name: action })
    expect(button.getAttribute('data-variant')).toBe(variant)
    expect(button.getAttribute('data-size')).toBe('gestao')
    expect(container.querySelector('.sweep')).toBeNull()
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  it('pending: neutral, no button, the Sweep primitive in its 120 box, decorative', () => {
    const { container, getByRole, queryByRole } = view('pending')
    expect(getByRole('region', { name: 'Ação necessária na conta' }).getAttribute('data-danger')).toBe('false')
    expect(queryByRole('button')).toBeNull()
    const sweep = container.querySelector('.reset-access-banner__sweep > .sweep[aria-hidden="true"] > .sweep__bar')
    expect(sweep).not.toBeNull()
    expect(getByRole('status').textContent).toContain('Confirme na janela que abriu')
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })
})
