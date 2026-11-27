// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StrictMode, type ReactNode } from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'

// useCanInstall reads the user agent; the hook's hidden-by-install reason is driven here.
const install = vi.hoisted(() => ({ can: false }))
vi.mock('../../src/ui/install', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/ui/install')>()),
  useCanInstall: () => install.can,
}))

import { useDeviceNotifications } from '../../src/ui/useDeviceNotifications'
import {
  browserDeviceNotificationsEnv,
  pushPublicKey,
  stopDeviceNotifications,
  waitAtMost,
  type BrowserSubscription,
  type DeviceNotificationsEnv,
  type PermissionState,
} from '../../src/ui/device-notifications'
import { loadNotificationsPref, notificationsPromptDismissed } from '../../src/ui/notifications-pref'
import { browserNotifierEnv } from '../../src/ui/notifier'
import { savePendingTarget, saveWorkerLocale, takePendingTarget, workerLocale } from '../../src/sw/store'

// "Notifications on this device" (ADR-117 dec. 6 and its addendum of 26/Nov/2026; PR 5b forks F1 to F7): the hook
// that owns the list's prompt and the row of "Sua conta", the browser's side of the subscription, and the live tab's
// gate. A fake browser stands in for the Push API; a fake ACL records the order of the calls.

interface FakeSub extends BrowserSubscription {
  unsubscribe: ReturnType<typeof vi.fn<() => Promise<boolean>>>
}

function fakeBrowser() {
  const log: string[] = []
  const state = {
    supported: true,
    registered: true,
    permission: 'default' as PermissionState | undefined,
    answer: 'granted' as PermissionState,
    pendingAnswer: undefined as Promise<PermissionState> | undefined,
    subscribeFails: false,
    sub: null as FakeSub | null,
  }
  // The shape PushSubscription.toJSON gives (low-entropy stand-ins: nothing here is a real secret).
  const makeSub = (): FakeSub => {
    const sub: FakeSub = {
      toJSON: () => ({ endpoint: 'https://push.example/s', keys: { p256dh: 'A'.repeat(87), auth: 'B'.repeat(22) } }),
      unsubscribe: vi.fn(async () => {
        log.push('browser.unsubscribe')
        if (state.sub === sub) state.sub = null
        return true
      }),
    }
    return sub
  }
  const env: DeviceNotificationsEnv = {
    supported: () => state.supported,
    registration: async () =>
      state.registered
        ? {
            current: async () => state.sub,
            subscribe: async () => {
              log.push('browser.subscribe')
              if (state.subscribeFails) throw new Error('refused')
              state.sub ??= makeSub()
              return state.sub
            },
          }
        : undefined,
    permission: () => state.permission,
    requestPermission: () => {
      log.push('browser.request')
      if (state.pendingAnswer) return state.pendingAnswer
      state.permission = state.answer
      return Promise.resolve(state.answer)
    },
  }
  return { log, state, env, makeSub }
}

function fakeAcl(log: string[]) {
  return {
    enableDeviceNotifications: vi.fn(async (_sub: unknown) => {
      log.push('acl.enable')
    }),
    disableDeviceNotifications: vi.fn(async () => {
      log.push('acl.disable')
    }),
  }
}

function setup(prepare: (b: ReturnType<typeof fakeBrowser>) => void = () => {}, wrapper?: (p: { children: ReactNode }) => ReactNode) {
  const browser = fakeBrowser()
  prepare(browser)
  const acl = fakeAcl(browser.log)
  const hook = renderHook(() => useDeviceNotifications(acl, browser.env), { wrapper })
  return { ...browser, acl, hook }
}

// The opening's check (F2) has run when the registration has been read.
async function opened(hook: { result: { current: ReturnType<typeof useDeviceNotifications> } }, expected: string) {
  await waitFor(() => expect(hook.result.current.row.status).toBe(expected))
}

beforeEach(() => {
  localStorage.clear()
  install.can = false
})
afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('hidden (F3): the four reasons', () => {
  it('no push in this browser or build (the synchronous support)', async () => {
    const { hook, acl } = setup((b) => {
      b.state.supported = false
      b.state.permission = 'granted'
    })
    await act(async () => {})
    expect(hook.result.current.row.status).toBe('hidden')
    expect(acl.enableDeviceNotifications).not.toHaveBeenCalled()
  })

  it('no worker registration', async () => {
    const { hook } = setup((b) => {
      b.state.registered = false
      b.state.permission = 'granted'
    })
    await act(async () => {})
    expect(hook.result.current.row.status).toBe('hidden')
  })

  it('where the install row stands in (useCanInstall)', async () => {
    install.can = true
    const { hook, acl } = setup((b) => {
      b.state.permission = 'granted'
      localStorage.setItem('tayet.notifications', 'on')
    })
    await act(async () => {})
    expect(hook.result.current.row.status).toBe('hidden')
    expect(acl.enableDeviceNotifications).not.toHaveBeenCalled()
  })

  it('the build without the key, the browser without PushManager or without workers: the browser env says no support', () => {
    const w = window as unknown as { PushManager?: unknown }
    const nav = navigator as unknown as { serviceWorker?: unknown }
    w.PushManager = function PushManager() {}
    Object.defineProperty(navigator, 'serviceWorker', { value: {}, configurable: true })
    ;(window as unknown as { Notification?: unknown }).Notification ??= { permission: 'default' }
    try {
      vi.stubEnv('VITE_PUSH_PUBLIC_KEY', 'BKey')
      expect(pushPublicKey()).toBe('BKey')
      expect(browserDeviceNotificationsEnv().supported()).toBe(true)
      vi.stubEnv('VITE_PUSH_PUBLIC_KEY', '  ')
      expect(pushPublicKey()).toBeUndefined()
      expect(browserDeviceNotificationsEnv().supported()).toBe(false)
      vi.stubEnv('VITE_PUSH_PUBLIC_KEY', 'BKey')
      delete w.PushManager
      expect(browserDeviceNotificationsEnv().supported()).toBe(false)
      w.PushManager = function PushManager() {}
      delete nav.serviceWorker
      expect(browserDeviceNotificationsEnv().supported()).toBe(false)
    } finally {
      delete w.PushManager
      delete nav.serviceWorker
    }
  })
})

describe('the states of the row (F1, F3, F6)', () => {
  it('off: granted, no preference, no subscription; the opening calls nothing', async () => {
    const { hook, acl, log } = setup((b) => (b.state.permission = 'granted'))
    await opened(hook, 'off')
    expect(acl.enableDeviceNotifications).not.toHaveBeenCalled()
    expect(log).toEqual([])
  })

  it('blocked: the permission denied, whatever the preference', async () => {
    const { hook } = setup((b) => {
      b.state.permission = 'denied'
      localStorage.setItem('tayet.notifications', 'on')
    })
    await opened(hook, 'blocked')
  })

  it('turning on: the permission asked from the click, enabling while it waits, then on with the preference on', async () => {
    let answer: (p: PermissionState) => void = () => {}
    const { hook, acl, log, state } = setup((b) => {
      b.state.pendingAnswer = new Promise((r) => (answer = r))
    })
    await opened(hook, 'off')
    act(() => hook.result.current.row.onEnable())
    expect(hook.result.current.row.status).toBe('enabling')
    expect(log).toEqual(['browser.request'])
    await act(async () => {
      state.permission = 'granted'
      answer('granted')
    })
    await opened(hook, 'on')
    expect(log).toEqual(['browser.request', 'browser.subscribe', 'acl.enable'])
    expect(acl.enableDeviceNotifications).toHaveBeenCalledWith({
      endpoint: 'https://push.example/s',
      keys: { p256dh: 'A'.repeat(87), auth: 'B'.repeat(22) },
    })
    expect(loadNotificationsPref()).toBe('on')
  })

  it('already granted: no new request; a second click while enabling does nothing', async () => {
    const { hook, acl, log } = setup((b) => (b.state.permission = 'granted'))
    await opened(hook, 'off')
    act(() => {
      hook.result.current.row.onEnable()
      hook.result.current.row.onEnable()
    })
    await opened(hook, 'on')
    expect(log).toEqual(['browser.subscribe', 'acl.enable'])
    expect(acl.enableDeviceNotifications).toHaveBeenCalledTimes(1)
  })

  it('failure in the subscribe: failed, no ACL call, the preference unchanged', async () => {
    const { hook, acl } = setup((b) => {
      b.state.permission = 'granted'
      b.state.subscribeFails = true
    })
    await opened(hook, 'off')
    act(() => hook.result.current.row.onEnable())
    await opened(hook, 'failed')
    expect(acl.enableDeviceNotifications).not.toHaveBeenCalled()
    expect(loadNotificationsPref()).toBeUndefined()
  })

  it('failure in the ACL: failed, the subscription cancelled in the browser, the preference unchanged', async () => {
    const { hook, acl, log, state } = setup((b) => {
      b.state.permission = 'granted'
      localStorage.setItem('tayet.notifications', 'off')
    })
    acl.enableDeviceNotifications.mockRejectedValueOnce(new Error('offline'))
    await opened(hook, 'off')
    act(() => hook.result.current.row.onEnable())
    await opened(hook, 'failed')
    expect(log).toEqual(['browser.subscribe', 'browser.unsubscribe'])
    expect(state.sub).toBeNull()
    expect(loadNotificationsPref()).toBe('off')
    // "Your account" closes: back from the failure.
    act(() => hook.result.current.row.onDismissFailure())
    expect(hook.result.current.row.status).toBe('off')
  })

  it('a denial on the click: blocked, the preference unchanged; a dismissed browser prompt stays off', async () => {
    const denied = setup((b) => (b.state.answer = 'denied'))
    await opened(denied.hook, 'off')
    act(() => denied.hook.result.current.row.onEnable())
    await opened(denied.hook, 'blocked')
    expect(loadNotificationsPref()).toBeUndefined()
    cleanup()
    const ignored = setup((b) => (b.state.answer = 'default'))
    await opened(ignored.hook, 'off')
    act(() => ignored.hook.result.current.row.onEnable())
    await opened(ignored.hook, 'off')
    expect(ignored.log).toEqual(['browser.request'])
  })

  it('on needs the preference on AND a subscription; "Your account" opening re-reads without the ACL', async () => {
    const { hook, acl, state, makeSub } = setup((b) => {
      b.state.permission = 'granted'
      localStorage.setItem('tayet.notifications', 'on')
    })
    await opened(hook, 'on')
    expect(acl.enableDeviceNotifications).toHaveBeenCalledTimes(1)
    // The subscription went (the browser dropped it): the next opening of "Your account" reads off.
    state.sub = null
    act(() => hook.result.current.row.onOpen())
    await opened(hook, 'off')
    // A subscription without the preference on is not on either.
    state.sub = makeSub()
    localStorage.setItem('tayet.notifications', 'off')
    act(() => hook.result.current.row.onOpen())
    await act(async () => {})
    expect(hook.result.current.row.status).toBe('off')
    // The permission revoked in the system: blocked, read on opening.
    state.permission = 'denied'
    act(() => hook.result.current.row.onOpen())
    expect(hook.result.current.row.status).toBe('blocked')
    expect(acl.enableDeviceNotifications).toHaveBeenCalledTimes(1)
  })
})

describe('the opening check (F2)', () => {
  it('preference on, granted, a subscription: handed to the ACL once per page (StrictMode runs the effect twice)', async () => {
    const { hook, acl, log } = setup(
      (b) => {
        b.state.permission = 'granted'
        b.state.sub = b.makeSub()
        localStorage.setItem('tayet.notifications', 'on')
      },
      ({ children }) => <StrictMode>{children}</StrictMode>,
    )
    await opened(hook, 'on')
    expect(log).toEqual(['acl.enable'])
    hook.rerender()
    await act(async () => {})
    expect(acl.enableDeviceNotifications).toHaveBeenCalledTimes(1)
  })

  it('no subscription yet: subscribe, then the ACL', async () => {
    const { hook, log } = setup((b) => {
      b.state.permission = 'granted'
      localStorage.setItem('tayet.notifications', 'on')
    })
    await opened(hook, 'on')
    expect(log).toEqual(['browser.subscribe', 'acl.enable'])
  })

  it('R1: the ACL fails with a subscription already there: nothing cancelled, the row on; the next opening tries again', async () => {
    const browser = fakeBrowser()
    browser.state.permission = 'granted'
    browser.state.sub = browser.makeSub()
    const existing = browser.state.sub
    localStorage.setItem('tayet.notifications', 'on')
    const acl = fakeAcl(browser.log)
    acl.enableDeviceNotifications.mockImplementationOnce(async () => {
      browser.log.push('acl.enable')
      throw new Error('offline')
    })
    const first = renderHook(() => useDeviceNotifications(acl, browser.env))
    await waitFor(() => expect(first.result.current.row.status).toBe('on'))
    expect(browser.log).toEqual(['acl.enable'])
    expect(existing.unsubscribe).not.toHaveBeenCalled()
    expect(browser.state.sub).toBe(existing)
    expect(loadNotificationsPref()).toBe('on')
    first.unmount()
    // The next opening (a new page): the same subscription goes to the ACL again.
    const next = renderHook(() => useDeviceNotifications(acl, browser.env))
    await waitFor(() => expect(acl.enableDeviceNotifications).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(next.result.current.row.status).toBe('on'))
    expect(browser.log).toEqual(['acl.enable', 'acl.enable'])
  })

  it('R1: the ACL fails with a subscription made in that call: it is cancelled, the row off, the preference kept', async () => {
    const { hook, acl, log, state } = setup((b) => {
      b.state.permission = 'granted'
      localStorage.setItem('tayet.notifications', 'on')
    })
    acl.enableDeviceNotifications.mockImplementationOnce(async () => {
      log.push('acl.enable')
      throw new Error('offline')
    })
    await waitFor(() => expect(log).toEqual(['browser.subscribe', 'acl.enable', 'browser.unsubscribe']))
    await opened(hook, 'off')
    expect(state.sub).toBeNull()
    expect(loadNotificationsPref()).toBe('on')
  })

  it('without the permission granted, or with the preference off, nothing is called', async () => {
    const off = setup((b) => {
      b.state.permission = 'granted'
      b.state.sub = b.makeSub()
      localStorage.setItem('tayet.notifications', 'off')
    })
    await opened(off.hook, 'off')
    expect(off.log).toEqual([])
    cleanup()
    localStorage.setItem('tayet.notifications', 'on')
    const asking = setup((b) => (b.state.permission = 'default'))
    await opened(asking.hook, 'off')
    expect(asking.log).toEqual([])
  })
})

describe('turning off (F5)', () => {
  it('the browser first, then the ACL, then the preference off; a failure of the ACL is not shown', async () => {
    const { hook, acl, log } = setup((b) => {
      b.state.permission = 'granted'
      b.state.sub = b.makeSub()
      localStorage.setItem('tayet.notifications', 'on')
    })
    await opened(hook, 'on')
    log.length = 0
    acl.disableDeviceNotifications.mockImplementationOnce(async () => {
      log.push('acl.disable')
      throw new Error('offline')
    })
    act(() => hook.result.current.row.onDisable())
    await opened(hook, 'off')
    expect(log).toEqual(['browser.unsubscribe', 'acl.disable'])
    expect(loadNotificationsPref()).toBe('off')
  })
})

describe('the list prompt (F4)', () => {
  it('shows with the permission default or granted, no preference and no dismissal', async () => {
    const asking = setup((b) => (b.state.permission = 'default'))
    await act(async () => {})
    expect(asking.hook.result.current.prompt).toBeDefined()
    cleanup()
    const granted = setup((b) => (b.state.permission = 'granted'))
    await act(async () => {})
    expect(granted.hook.result.current.prompt).toBeDefined()
  })

  it('does not show when denied, with a preference (on or off), or dismissed (also by the old key)', async () => {
    const cases: Array<() => void> = [
      () => localStorage.setItem('tayet.notifications', 'on'),
      () => localStorage.setItem('tayet.notifications', 'off'),
      () => localStorage.setItem('tayet.notifications-dismissed', '1'),
      () => localStorage.setItem('tayet.notifications', 'dismissed'),
    ]
    for (const prepare of cases) {
      localStorage.clear()
      prepare()
      const { hook } = setup((b) => (b.state.permission = 'granted'))
      await act(async () => {})
      expect(hook.result.current.prompt).toBeUndefined()
      cleanup()
    }
    localStorage.clear()
    const denied = setup((b) => (b.state.permission = 'denied'))
    await act(async () => {})
    expect(denied.hook.result.current.prompt).toBeUndefined()
  })

  it('"Ativar notificações" with push here: the permission from the click, the preference on, subscribe, the ACL', async () => {
    const { hook, log } = setup()
    await opened(hook, 'off')
    act(() => hook.result.current.prompt!.onEnable())
    await opened(hook, 'on')
    expect(log).toEqual(['browser.request', 'browser.subscribe', 'acl.enable'])
    expect(loadNotificationsPref()).toBe('on')
    expect(hook.result.current.prompt).toBeUndefined()
  })

  it('without push: only the preference on (the live tab notifies as before)', async () => {
    const { hook, log, acl } = setup((b) => (b.state.supported = false))
    await act(async () => {})
    act(() => hook.result.current.prompt!.onEnable())
    await waitFor(() => expect(loadNotificationsPref()).toBe('on'))
    expect(log).toEqual(['browser.request'])
    expect(acl.enableDeviceNotifications).not.toHaveBeenCalled()
    expect(hook.result.current.prompt).toBeUndefined()
  })

  it('denied from the prompt: no preference, the prompt goes; × dismisses for good under its own key', async () => {
    const denied = setup((b) => (b.state.answer = 'denied'))
    await act(async () => {})
    act(() => denied.hook.result.current.prompt!.onEnable())
    await waitFor(() => expect(denied.hook.result.current.prompt).toBeUndefined())
    expect(loadNotificationsPref()).toBeUndefined()
    cleanup()
    const dismissing = setup()
    await act(async () => {})
    act(() => dismissing.hook.result.current.prompt!.onDismiss())
    expect(dismissing.hook.result.current.prompt).toBeUndefined()
    expect(notificationsPromptDismissed()).toBe(true)
    expect(localStorage.getItem('tayet.notifications')).toBeNull()
  })
})

describe('the live tab gate (F4): granted AND the preference on', () => {
  const stubNotification = (permission: NotificationPermission) => {
    ;(window as unknown as { Notification: unknown }).Notification = { permission }
  }
  afterEach(() => {
    delete (window as unknown as { Notification?: unknown }).Notification
  })

  it('granted with on notifies; with off or empty it does not; denied stays denied', () => {
    stubNotification('granted')
    localStorage.setItem('tayet.notifications', 'on')
    expect(browserNotifierEnv().permission()).toBe('granted')
    localStorage.setItem('tayet.notifications', 'off')
    expect(browserNotifierEnv().permission()).not.toBe('granted')
    localStorage.removeItem('tayet.notifications')
    expect(browserNotifierEnv().permission()).not.toBe('granted')
    stubNotification('denied')
    localStorage.setItem('tayet.notifications', 'on')
    expect(browserNotifierEnv().permission()).toBe('denied')
  })

  it('read at each notification: the row takes effect on the same notifier env', () => {
    stubNotification('granted')
    const env = browserNotifierEnv()
    expect(env.permission()).not.toBe('granted')
    localStorage.setItem('tayet.notifications', 'on')
    expect(env.permission()).toBe('granted')
  })
})

describe('the local stop on sign-out (F5)', () => {
  class FakeCache {
    readonly entries = new Map<string, string>()
    async put(key: string, res: Response): Promise<void> {
      this.entries.set(key, await res.text())
    }
    async match(key: string): Promise<Response | undefined> {
      const v = this.entries.get(key)
      return v === undefined ? undefined : new Response(v)
    }
    async delete(key: string): Promise<boolean> {
      return this.entries.delete(key)
    }
  }
  beforeEach(() => {
    const cache = new FakeCache()
    ;(globalThis as { caches?: unknown }).caches = { open: async () => cache }
  })
  afterEach(() => {
    delete (globalThis as { caches?: unknown }).caches
  })

  it('cancels the browser subscription, clears the preference and only the pending target (language and dismissal stay)', async () => {
    const { env, state, makeSub, log } = fakeBrowser()
    state.sub = makeSub()
    localStorage.setItem('tayet.notifications', 'on')
    localStorage.setItem('tayet.notifications-dismissed', '1')
    await saveWorkerLocale('en')
    await savePendingTarget({ conversation: 'c' }, Date.now())
    await stopDeviceNotifications(env)
    expect(log).toEqual(['browser.unsubscribe'])
    expect(loadNotificationsPref()).toBeUndefined()
    expect(notificationsPromptDismissed()).toBe(true)
    expect(await workerLocale()).toBe('en')
    expect(await takePendingTarget(Date.now())).toBeUndefined()
  })

  it('without a registration or a subscription it settles quietly', async () => {
    const { env, state } = fakeBrowser()
    state.registered = false
    await expect(stopDeviceNotifications(env)).resolves.toBeUndefined()
    state.registered = true
    await expect(stopDeviceNotifications(env)).resolves.toBeUndefined()
  })

  it('waitAtMost: settles at the bound without aborting the work, or earlier with it; a failure is swallowed', async () => {
    vi.useFakeTimers()
    let finished = false
    const slow = new Promise<void>((r) => setTimeout(() => ((finished = true), r()), 5_000))
    let waited = false
    void waitAtMost(slow, 2_000).then(() => (waited = true))
    await vi.advanceTimersByTimeAsync(1_999)
    expect(waited).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(waited).toBe(true)
    expect(finished).toBe(false)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(finished).toBe(true)
    await expect(waitAtMost(Promise.reject(new Error('x')), 2_000)).resolves.toBeUndefined()
  })
})
