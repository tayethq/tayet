// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'

vi.mock('../../src/ui/oidc', () => ({
  isCallback: vi.fn(() => false),
  beginLogin: vi.fn(async () => {}),
  completeLogin: vi.fn(async () => 'OIDC_BLOB' as unknown),
  scrubCallback: vi.fn(),
  isErrorCallback: vi.fn(() => false),
}))

import { Boot } from '../../src/ui/components/Boot'
import { PUSH_STOP_BOUND_MS } from '../../src/ui/device-notifications'
import type { Acl, AclTelemetry, OpaqueSession } from '../../src/acl'

// Sign-out and this device's notifications (ADR-117, addendum of 26/Nov/2026, F5): the local stop (the browser's
// subscription, the pending click target, the preference) comes before the ACL's signOut. The voluntary sign-out
// waits for it at most PUSH_STOP_BOUND_MS; the lost session does not wait, and its screen order does not change.

const telemetry: AclTelemetry = { untranslated: () => {} }
const base = { serverUrl: 'http://x', clientId: 'TAYET', ssoLabel: 'Dex (local)', telemetry, envToken: undefined }
const session = () => 'PERSISTED_BLOB' as unknown as OpaqueSession
const REVOKED = 'Seu acesso foi encerrado'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function boot(stopNotifications: () => Promise<void>, log: string[]) {
  let signOutHere: () => void = () => {}
  let fireLost: () => void = () => {}
  const acl = {
    connect: vi.fn(async () => {}),
    signOut: vi.fn(async () => {
      log.push('acl.signOut')
    }),
  } as unknown as Acl
  render(
    <Boot
      {...base}
      resolve={session}
      makeAcl={(_s, _t, _r, onLost) => {
        fireLost = onLost
        return acl
      }}
      renderReady={(_acl, onSignOut) => {
        signOutHere = onSignOut
        return <div>READY</div>
      }}
      stopNotifications={stopNotifications}
    />,
  )
  return { acl, signOut: () => signOutHere(), lose: () => fireLost() }
}

describe('voluntary sign-out', () => {
  it('the local stop first, awaited, then the ACL', async () => {
    const log: string[] = []
    const b = boot(async () => {
      log.push('stop')
    }, log)
    await waitFor(() => expect(screen.getByText('READY')).toBeTruthy())
    act(() => b.signOut())
    await waitFor(() => expect(screen.getByText(REVOKED)).toBeTruthy())
    expect(log).toEqual(['stop', 'acl.signOut'])
  })

  it('a stop that hangs: the ACL signOut runs at the bound, not before', async () => {
    const log: string[] = []
    const b = boot(() => new Promise<void>(() => {}), log)
    await waitFor(() => expect(screen.getByText('READY')).toBeTruthy())
    vi.useFakeTimers()
    act(() => b.signOut())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PUSH_STOP_BOUND_MS - 1)
    })
    expect(b.acl.signOut).not.toHaveBeenCalled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(b.acl.signOut).toHaveBeenCalledTimes(1)
    expect(PUSH_STOP_BOUND_MS).toBe(2_000)
  })

  it('a stop that fails does not hold the sign-out', async () => {
    const log: string[] = []
    const b = boot(async () => {
      throw new Error('refused')
    }, log)
    await waitFor(() => expect(screen.getByText('READY')).toBeTruthy())
    act(() => b.signOut())
    await waitFor(() => expect(screen.getByText(REVOKED)).toBeTruthy())
    expect(log).toEqual(['acl.signOut'])
  })
})

describe('lost session', () => {
  it('the stop starts first but is not awaited: the screen is revoked at once and the ACL signOut runs', async () => {
    const log: string[] = []
    const stop = vi.fn(() => {
      log.push('stop')
      return new Promise<void>(() => {})
    })
    const b = boot(stop, log)
    await waitFor(() => expect(screen.getByText('READY')).toBeTruthy())
    act(() => b.lose())
    expect(screen.getByText(REVOKED)).toBeTruthy()
    await waitFor(() => expect(b.acl.signOut).toHaveBeenCalledTimes(1))
    expect(log).toEqual(['stop', 'acl.signOut'])
  })
})
