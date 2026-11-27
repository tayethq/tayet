import { useCallback, useEffect, useRef, useState } from 'react'
import type { Acl } from '@tayet/client'
import { useCanInstall } from './install'
import {
  asDeviceSubscription,
  browserDeviceNotificationsEnv,
  cancelLocalSubscription,
  type BrowserSubscription,
  type DeviceNotificationsEnv,
  type PermissionState,
  type PushHandle,
} from './device-notifications'
import {
  dismissNotificationsPrompt,
  loadNotificationsPref,
  notificationsPromptDismissed,
  saveNotificationsPref,
  type NotificationsPref,
} from './notifications-pref'

// "Notifications on this device" (ADR-117 dec. 6 and its addendum of 26/Nov/2026, forks F1 to F6 of PR 5b): one owner
// for the list's prompt (ADR-073 dec. 6) and for the row of "Your account". It lives in App, which mounts only in
// the live tab (ADR-065) once the session is ready.
//
// - F2, the check on opening: with the preference on, the permission granted and push here, the browser's
//   subscription (or a new one) is handed to the ACL once per page. The screen never calls the ACL when it opens.
// - F3: hidden without push here or where the install row stands in (useCanInstall); blocked when denied; on needs
//   the preference on and a subscription; "Your account" re-reads the permission and the subscription when it opens.
// - F6: a failure keeps the preference, cancels a subscription made for it and says so; a denial reads as blocked.
//   On opening (R1), a subscription that was already there is never cancelled: the row follows the browser.

export type DeviceNotificationsStatus = 'hidden' | 'off' | 'enabling' | 'on' | 'failed' | 'blocked'

// The row of "Your account" (account-access.md §16).
export interface DeviceNotificationsRow {
  status: DeviceNotificationsStatus
  onEnable: () => void
  onDisable: () => void
  // "Your account" opened: the permission, the preference and the subscription are read again.
  onOpen: () => void
  // Back from a failure; "Your account" calls it when it closes.
  onDismissFailure: () => void
}

export interface DeviceNotifications {
  row: DeviceNotificationsRow
  // The list's prompt, while it is due.
  prompt?: { onEnable: () => void; onDismiss: () => void }
}

type Verbs = Pick<Acl, 'enableDeviceNotifications' | 'disableDeviceNotifications'>

export function useDeviceNotifications(acl: Verbs, injected?: DeviceNotificationsEnv): DeviceNotifications {
  const [env] = useState<DeviceNotificationsEnv>(() => injected ?? browserDeviceNotificationsEnv())
  const installable = useCanInstall()
  const [supported] = useState(() => env.supported())
  // Whether the worker's registration is there; undefined until read.
  const [registered, setRegistered] = useState<boolean | undefined>(undefined)
  const [permission, setPermission] = useState<PermissionState | undefined>(() => env.permission())
  const [pref, setPref] = useState<NotificationsPref>(loadNotificationsPref)
  const [subscribed, setSubscribed] = useState(false)
  const [enabling, setEnabling] = useState(false)
  const [failed, setFailed] = useState(false)
  const [dismissed, setDismissed] = useState(notificationsPromptDismissed)
  const busy = useRef(false)
  const checked = useRef(false)

  const pushHere = supported && registered === true && !installable

  const handle = useCallback(async (): Promise<PushHandle | undefined> => {
    try {
      return await env.registration()
    } catch {
      return undefined
    }
  }, [env])

  // A subscription the browser holds (`existing`) or makes now, handed to the ACL. When the ACL fails, only a
  // subscription made in this call is cancelled in the browser (F6); one that was already there stays (round 1b, R1:
  // a passing failure must not kill a working subscription that Safari may not recreate without a gesture).
  const turnOn = useCallback(
    async (h: PushHandle | undefined, existing: BrowserSubscription | null = null): Promise<boolean> => {
      if (!h) return false
      let sub = existing
      try {
        sub ??= await h.subscribe()
      } catch {
        return false
      }
      try {
        await acl.enableDeviceNotifications(asDeviceSubscription(sub))
        return true
      } catch {
        if (sub !== existing) await sub.unsubscribe().catch(() => false)
        return false
      }
    },
    [acl],
  )

  // F2: once per page, when the session is ready (App mounts then). StrictMode runs the effect twice; the ref keeps
  // the ACL call to one, and a state set after the first run's cleanup is harmless.
  useEffect(() => {
    if (checked.current) return
    checked.current = true
    void (async () => {
      const h = supported ? await handle() : undefined
      setRegistered(h !== undefined)
      if (!h) return
      const existing = await h.current().catch(() => null)
      if (loadNotificationsPref() !== 'on' || env.permission() !== 'granted' || installable) {
        setSubscribed(existing !== null)
        return
      }
      // A failure keeps a subscription that was there, and the row follows the browser; the next opening tries the
      // ACL again.
      const confirmed = await turnOn(h, existing)
      setSubscribed(confirmed || existing !== null)
    })()
    // Mount only: this is the opening's check, not a reaction to state.
  }, [])

  const onOpen = useCallback(() => {
    setPermission(env.permission())
    setPref(loadNotificationsPref())
    if (!supported) return
    void (async () => {
      const h = await handle()
      setRegistered(h !== undefined)
      const sub = h ? await h.current().catch(() => null) : null
      setSubscribed(sub !== null)
    })()
  }, [env, supported, handle])

  // The row's "Turn on". The permission is asked first, still inside the click.
  const onEnable = useCallback(() => {
    if (busy.current) return
    busy.current = true
    setFailed(false)
    setEnabling(true)
    const current = env.permission()
    const asked = current === 'granted' ? Promise.resolve(current) : env.requestPermission()
    void (async () => {
      try {
        const granted = await asked.catch(() => env.permission())
        setPermission(granted)
        if (granted !== 'granted') return
        if (await turnOn(await handle())) {
          saveNotificationsPref('on')
          setPref('on')
          setSubscribed(true)
        } else setFailed(true)
      } finally {
        busy.current = false
        setEnabling(false)
      }
    })()
  }, [env, handle, turnOn])

  // F5, "Turn off": the browser's subscription goes first, then the server's, then the preference. No failure shows.
  const onDisable = useCallback(() => {
    if (busy.current) return
    busy.current = true
    void (async () => {
      try {
        await cancelLocalSubscription(env)
        await acl.disableDeviceNotifications().catch(() => undefined)
      } finally {
        saveNotificationsPref('off')
        setPref('off')
        setSubscribed(false)
        setFailed(false)
        busy.current = false
      }
    })()
  }, [env, acl])

  const onDismissFailure = useCallback(() => setFailed(false), [])

  // F4, the list's prompt: "Ativar notificações" asks the permission from the click. Granted, the preference is on
  // and, with push here, the device subscribes; without push the live tab notifies as before.
  const promptEnable = useCallback(() => {
    if (busy.current) return
    busy.current = true
    const asked = env.requestPermission()
    void (async () => {
      try {
        const granted = await asked.catch(() => env.permission())
        setPermission(granted)
        if (granted !== 'granted') return
        saveNotificationsPref('on')
        setPref('on')
        if (!pushHere) return
        setEnabling(true)
        setSubscribed(await turnOn(await handle()))
      } finally {
        busy.current = false
        setEnabling(false)
      }
    })()
  }, [env, pushHere, handle, turnOn])

  const promptDismiss = useCallback(() => {
    dismissNotificationsPrompt()
    setDismissed(true)
  }, [])

  const status: DeviceNotificationsStatus = !pushHere
    ? 'hidden'
    : permission === 'denied'
      ? 'blocked'
      : enabling
        ? 'enabling'
        : failed
          ? 'failed'
          : pref === 'on' && permission === 'granted' && subscribed
            ? 'on'
            : 'off'

  // F4: the prompt comes back with the permission granted, no preference and no dismissal; never when denied.
  const due = permission !== undefined && permission !== 'denied' && pref === undefined && !dismissed

  return {
    row: { status, onEnable, onDisable, onOpen, onDismissFailure },
    prompt: due ? { onEnable: promptEnable, onDismiss: promptDismiss } : undefined,
  }
}
