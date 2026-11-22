// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('../../src/ui/oidc', () => ({
  isCallback: vi.fn(() => false),
  beginLogin: vi.fn(async () => {}),
  completeLogin: vi.fn(),
  scrubCallback: vi.fn(),
  isErrorCallback: vi.fn(() => false),
}))

import { Boot, type BootProps } from '../../src/ui/components/Boot'
import { BootMessage } from '../../src/ui/components/BootMessage'
import { isErrorCallback } from '../../src/ui/oidc'
import type { Acl, OpaqueSession } from '../../src/acl'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { copy, fill } from '../support/copy'
import { IPHONE_SAFARI_UA, fakeDevice } from '../support/device-fake'

// "Entrar" on the narrow window (login-onboarding.md §10.1; PLANO-MOBILE M7 I1, I2).

beforeEach(() => localStorage.clear())
afterEach(() => {
  cleanup()
  vi.mocked(isErrorCallback).mockReturnValue(false)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const iphone = () => fakeDevice({ coarse: true, ua: IPHONE_SAFARI_UA })
function boot(props: Partial<BootProps> = {}) {
  return render(
    <Boot serverUrl="http://x" envToken={undefined} clientId="TAYET" ssoLabel="Google" telemetry={{ untranslated: () => {} }} resolve={() => null} {...props} />,
  )
}
const provider = fill(copy.boot.continueWith, { provider: 'Google' })
const sheetOf = (v: ReturnType<typeof render>) => v.queryByRole('dialog', { name: copy.install.sheetLabel })

describe('the four failures', () => {
  const cases = [
    ['revoked', copy.boot.endedTitle, copy.boot.endedDetail, [copy.boot.signInAgain]],
    ['idp-denied', copy.boot.signInFailedTitle, fill(copy.boot.signInFailedDetail, { provider: 'Google' }), [copy.boot.tryAgain]],
    ['failed', copy.boot.startFailedTitle, copy.boot.startFailedDetail, [copy.boot.retry, copy.boot.signInAgain]],
    ['error', copy.boot.connectFailedTitle, copy.boot.connectFailedDetail, [copy.boot.retry]],
  ] as const

  it.each(cases)('%s: alert, title, detail, its buttons', (variant, title, detail, buttons) => {
    fakeDevice()
    const v = render(<BootMessage variant={variant} ssoLabel="Google" onRetry={() => {}} onSignIn={() => {}} onSignOut={() => {}} />)
    const alert = v.getByRole('alert')
    expect(alert.querySelector('.boot-message__title')!.textContent).toBe(title)
    expect(alert.querySelector('.boot-message__detail')!.textContent).toBe(detail)
    expect(alert.querySelector('svg')).toBeNull()
    expect([...alert.querySelectorAll('button')].map((b) => b.textContent)).toEqual(buttons)
  })

  it('the narrow CSS stacks their buttons across the card, and only theirs', () => {
    const css = readFileSync(join(__dirname, '..', '..', 'src', 'ui', 'styles.narrow.css'), 'utf8')
    expect(css).toMatch(/\.boot-message\[role='alert'\] > button,\s*\.boot-message\[role='alert'\] > \.boot-message__actions \{\s*align-self: stretch;/)
    expect(css).toMatch(/\.boot-message\[role='alert'\] > \.boot-message__actions \{\s*flex-direction: column;/)
  })
})

describe('the install sheet before the sign-in', () => {
  it('iPhone Safari, no session: the sheet over the entry', async () => {
    iphone()
    const v = boot()
    await waitFor(() => expect(sheetOf(v)).not.toBeNull())
    expect(v.getByText(provider)).toBeTruthy()
    expect(v.container.querySelector('.boot-surface > .ui-sheet')).not.toBeNull()
    expect(findProtocolLeaksInText(v.container.innerHTML)).toEqual([])
  })

  it('"Continuar no navegador": closes, the focus on the entry, and it does not come back on a reload', async () => {
    iphone()
    const v = boot()
    fireEvent.click(await v.findByRole('button', { name: copy.install.continueInBrowser }))
    expect(sheetOf(v)).toBeNull()
    expect(document.activeElement!.textContent).toBe(provider)
    v.unmount()
    const again = boot()
    await waitFor(() => expect(again.getByText(provider)).toBeTruthy())
    expect(sheetOf(again)).toBeNull()
  })

  it('the scrim closes for this visit only', async () => {
    iphone()
    const v = boot()
    await waitFor(() => expect(sheetOf(v)).not.toBeNull())
    fireEvent.click(v.container.querySelector('.ui-sheet__scrim')!)
    expect(sheetOf(v)).toBeNull()
    expect(localStorage.getItem('tayet.install-dismissed')).toBeNull()
    v.unmount()
    const again = boot()
    await waitFor(() => expect(sheetOf(again)).not.toBeNull())
  })

  it('signed in: never by itself, even without the flag', async () => {
    iphone()
    const v = boot({
      resolve: () => 'S' as unknown as OpaqueSession,
      makeAcl: () => ({ connect: async () => {} }) as unknown as Acl,
      renderReady: () => <div data-ready="" />,
    })
    await waitFor(() => expect(v.container.querySelector('[data-ready]')).not.toBeNull())
    expect(sheetOf(v)).toBeNull()
  })

  it('a failure phase has no sheet', async () => {
    iphone()
    vi.mocked(isErrorCallback).mockReturnValue(true)
    const v = boot()
    await waitFor(() => expect(v.getByText(copy.boot.signInFailedTitle)).toBeTruthy())
    expect(sheetOf(v)).toBeNull()
  })

  it.each([
    ['the installed app', { coarse: true, standalone: true, ua: IPHONE_SAFARI_UA }],
    ['another browser', { coarse: true }],
    ['on its side', { coarse: true, narrow: false, ua: IPHONE_SAFARI_UA }],
  ])('%s: no sheet', async (_, device) => {
    fakeDevice(device)
    const v = boot()
    await waitFor(() => expect(v.getByText(provider)).toBeTruthy())
    expect(sheetOf(v)).toBeNull()
  })
})
