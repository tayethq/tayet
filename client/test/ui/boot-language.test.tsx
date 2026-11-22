// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, cleanup, screen, waitFor } from '@testing-library/react'

vi.mock('../../src/ui/oidc', () => ({
  isCallback: vi.fn(() => false),
  beginLogin: vi.fn(async () => {}),
  completeLogin: vi.fn(async () => 'OIDC_BLOB' as unknown),
  scrubCallback: vi.fn(),
  isErrorCallback: vi.fn(() => false),
}))
vi.mock('../../src/ui/session-store', () => ({
  resolveBootSession: vi.fn(() => null),
  saveSession: vi.fn(),
  clearSession: vi.fn(),
}))

import { Boot } from '../../src/ui/components/Boot'
import { isCallback, scrubCallback } from '../../src/ui/oidc'
import { saveSession } from '../../src/ui/session-store'
import { applyLocale } from '../../src/ui/i18n'
import { LANGUAGE_READ_TIMEOUT_MS, reconcileLanguage } from '../../src/ui/language'
import type { Acl, AccountPreferences, AclTelemetry, OpaqueSession } from '../../src/acl'
import type { TabLock } from '../../src/ui/tab-lock'

// The language reconciliation right after connecting: the account's language against this device's
// copy (tayet.locale). The copy follows the account; the page reloads once when the language it is in
// is not the target, and only after the copy reads back as written.

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const READY = 'STUB_READY_SURFACE'
const base = { serverUrl: 'http://x', clientId: 'TAYET', ssoLabel: 'Dex (local)', telemetry: noopTelemetry }

function browser(languages: readonly string[]) {
  vi.spyOn(navigator, 'languages', 'get').mockReturnValue(languages)
  vi.spyOn(navigator, 'language', 'get').mockReturnValue(languages[0]!)
}

function aclWith(read: (opts?: { fresh?: boolean }) => Promise<AccountPreferences>) {
  const getAccountPreferences = vi.fn(read)
  const acl = { connect: vi.fn(async () => {}), getAccountPreferences } as unknown as Acl
  return { acl, getAccountPreferences }
}

function heldLock(events: string[]): TabLock {
  return {
    acquire: async () => 'held',
    release: () => events.push('release'),
    takeOver: () => ({ granted: Promise.resolve(true), cancel: () => {} }),
    consumeYielded: () => false,
    watch: () => () => {},
  }
}

function boot(acl: Acl, reload: () => void, tabLock?: TabLock) {
  return render(
    <Boot
      {...base}
      envToken="mct_ok"
      makeAcl={() => acl}
      resolve={(t) => (t ? (t as unknown as OpaqueSession) : null)}
      renderReady={() => <div>{READY}</div>}
      reload={reload}
      tabLock={tabLock}
    />,
  )
}

beforeEach(() => {
  localStorage.clear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.restoreAllMocks()
  vi.mocked(isCallback).mockReturnValue(false)
  vi.mocked(scrubCallback).mockClear()
  vi.mocked(saveSession).mockClear()
  applyLocale('pt-BR')
})

describe('Boot: the account language against the device copy', () => {
  it('the account chose en, this device has no copy and is in pt-BR: copy en, one reload, no app', async () => {
    browser(['pt-BR'])
    applyLocale('pt-BR')
    const reload = vi.fn()
    const { acl, getAccountPreferences } = aclWith(async () => ({ language: 'en' }))
    boot(acl, reload)
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    expect(getAccountPreferences).toHaveBeenCalledWith({ fresh: false })
    expect(localStorage.getItem('tayet.locale')).toBe('en')
    expect(screen.queryByText(READY)).toBeNull()
  })

  it('Automatic with a copy en on a pt-BR device: asks the server, removes the copy, reloads', async () => {
    browser(['pt-BR'])
    localStorage.setItem('tayet.locale', 'en')
    applyLocale('en')
    const reload = vi.fn()
    const { acl, getAccountPreferences } = aclWith(async () => ({}))
    boot(acl, reload)
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    expect(getAccountPreferences).toHaveBeenCalledWith({ fresh: true })
    expect(localStorage.getItem('tayet.locale')).toBeNull()
  })

  it('the account matches the language applied: the copy is written, no reload, the app comes up', async () => {
    browser(['pt-BR'])
    applyLocale('en')
    const reload = vi.fn()
    const { acl } = aclWith(async () => ({ language: 'en' }))
    boot(acl, reload)
    await waitFor(() => expect(screen.getByText(READY)).toBeTruthy())
    expect(reload).not.toHaveBeenCalled()
    expect(localStorage.getItem('tayet.locale')).toBe('en')
  })

  it('a language we do not have counts as Automatic: copy removed, the device language (en) wins', async () => {
    browser(['es', 'en-US'])
    localStorage.setItem('tayet.locale', 'pt-BR')
    applyLocale('pt-BR')
    const reload = vi.fn()
    const { acl } = aclWith(async () => ({ language: 'fr' }))
    boot(acl, reload)
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    expect(localStorage.getItem('tayet.locale')).toBeNull()
  })

  it('a failed read: the app comes up in the language applied, the copy untouched', async () => {
    browser(['pt-BR'])
    localStorage.setItem('tayet.locale', 'en')
    applyLocale('en')
    const reload = vi.fn()
    const { acl } = aclWith(async () => {
      throw new Error('network')
    })
    boot(acl, reload)
    await waitFor(() => expect(screen.getByText(READY)).toBeTruthy())
    expect(reload).not.toHaveBeenCalled()
    expect(localStorage.getItem('tayet.locale')).toBe('en')
  })

  it('a copy that does not take: no reload, the app comes up', async () => {
    browser(['pt-BR'])
    applyLocale('pt-BR')
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const reload = vi.fn()
    const { acl } = aclWith(async () => ({ language: 'en' }))
    boot(acl, reload)
    await waitFor(() => expect(screen.getByText(READY)).toBeTruthy())
    expect(reload).not.toHaveBeenCalled()
  })

  it('the reload happens with the tab lock held', async () => {
    browser(['pt-BR'])
    applyLocale('pt-BR')
    const events: string[] = []
    const reload = vi.fn(() => events.push('reload'))
    const { acl } = aclWith(async () => ({ language: 'en' }))
    boot(acl, reload, heldLock(events))
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    expect(events).toEqual(['reload'])
  })

  it('back from the provider: the reload comes after the callback is scrubbed and the session saved', async () => {
    browser(['pt-BR'])
    applyLocale('pt-BR')
    vi.mocked(isCallback).mockReturnValue(true)
    const order: string[] = []
    vi.mocked(scrubCallback).mockImplementation(() => order.push('scrub'))
    vi.mocked(saveSession).mockImplementation(() => order.push('save'))
    const reload = vi.fn(() => order.push('reload'))
    const { acl } = aclWith(async () => ({ language: 'en' }))
    render(
      <Boot {...base} envToken={undefined} makeAcl={() => acl} renderReady={() => <div>{READY}</div>} reload={reload} />,
    )
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    expect(order).toEqual(['scrub', 'save', 'reload'])
  })
})

describe('reconcileLanguage: the read ceiling', () => {
  it('a read past the ceiling carries on in the language applied, without touching the copy', async () => {
    vi.useFakeTimers()
    try {
      browser(['pt-BR'])
      localStorage.setItem('tayet.locale', 'en')
      applyLocale('en')
      const reload = vi.fn()
      const pending = reconcileLanguage({ getAccountPreferences: () => new Promise<AccountPreferences>(() => {}) }, reload)
      await vi.advanceTimersByTimeAsync(LANGUAGE_READ_TIMEOUT_MS)
      expect(await pending).toBe(false)
      expect(reload).not.toHaveBeenCalled()
      expect(localStorage.getItem('tayet.locale')).toBe('en')
    } finally {
      vi.useRealTimers()
    }
  })
})
