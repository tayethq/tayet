import type { DeviceNotificationSubscription } from '@tayet/client'
import { clearPendingTarget } from '../sw/store'
import { clearNotificationsPref } from './notifications-pref'

// ADR-117 dec. 6 and its addendum of 26/Nov/2026: this browser's side of "notifications on this device" — whether the
// build and the browser can push, the permission, and the browser's own push subscription (read, made, cancelled).
// The ACL registers the subscription on the server; nothing here talks to it. Nothing of the subscription (endpoint,
// secrets) goes to a log, the telemetry, an error or the screen.

export type PermissionState = 'default' | 'granted' | 'denied'

// The browser's subscription, as much of it as the app uses.
export interface BrowserSubscription {
  toJSON(): unknown
  unsubscribe(): Promise<boolean>
}

// The worker's registration, once it is there.
export interface PushHandle {
  current(): Promise<BrowserSubscription | null>
  subscribe(): Promise<BrowserSubscription>
}

// Injected like NotifierEnv (notifier.ts): the unit tests drive a fake browser.
export interface DeviceNotificationsEnv {
  // The synchronous part of the support (F3): the Notification and Push APIs, a worker container and the build's key.
  supported(): boolean
  // The worker's registration, read from the browser (the page may get here before registerServiceWorker settles);
  // undefined without one.
  registration(): Promise<PushHandle | undefined>
  // undefined without the Notification API.
  permission(): PermissionState | undefined
  // Only from a click (a user gesture), never at boot (ADR-073 dec. 6).
  requestPermission(): Promise<PermissionState>
}

// F5: how long the voluntary sign-out waits for the local stop. It bounds the wait and aborts nothing, like the ACL's
// PUSH_OFF_BOUND_MS.
export const PUSH_STOP_BOUND_MS = 2_000

// The one place the build's key is read. Absent or empty: no push in this build.
export function pushPublicKey(): string | undefined {
  const value = import.meta.env.VITE_PUSH_PUBLIC_KEY?.trim()
  return value ? value : undefined
}

// Unpadded base64url (as deploy.sh writes it) → the raw bytes the Push API takes.
function decodeBase64url(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

// The browser's subscription in the ACL's shape; the ACL checks the shape before any request.
export function asDeviceSubscription(sub: BrowserSubscription): DeviceNotificationSubscription {
  return sub.toJSON() as DeviceNotificationSubscription
}

export function browserDeviceNotificationsEnv(): DeviceNotificationsEnv {
  const hasNotification = (): boolean => typeof window !== 'undefined' && 'Notification' in window
  const hasWorkers = (): boolean => typeof navigator !== 'undefined' && 'serviceWorker' in navigator
  return {
    supported: () => hasNotification() && 'PushManager' in window && hasWorkers() && pushPublicKey() !== undefined,
    registration: async () => {
      const encoded = pushPublicKey()
      if (!hasWorkers() || !encoded) return undefined
      const found = await navigator.serviceWorker.getRegistration()
      if (!found) return undefined
      const reg = found.active ? found : await navigator.serviceWorker.ready
      if (!reg.pushManager) return undefined
      const serverId = decodeBase64url(encoded)
      return {
        current: () => reg.pushManager.getSubscription(),
        subscribe: () => reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: serverId }),
      }
    },
    permission: () => (hasNotification() ? Notification.permission : undefined),
    requestPermission: () => Notification.requestPermission(),
  }
}

// The current subscription, cancelled in the browser. Best-effort: false when there was none or the browser refused.
export async function cancelLocalSubscription(env: DeviceNotificationsEnv): Promise<boolean> {
  try {
    const handle = await env.registration()
    const sub = handle ? await handle.current() : null
    return sub ? await sub.unsubscribe() : false
  } catch {
    return false
  }
}

// F5, sign-out: the preference is cleared, the browser's subscription is cancelled and only the pending click target
// goes (the worker's language stays). The ACL's signOut comes after it and removes the subscription on the server.
export async function stopDeviceNotifications(env: DeviceNotificationsEnv = browserDeviceNotificationsEnv()): Promise<void> {
  clearNotificationsPref()
  await Promise.all([cancelLocalSubscription(env), clearPendingTarget()])
}

// Waits for `work` at most `ms`; the work goes on after the bound (nothing is aborted) and its failure is swallowed.
export function waitAtMost(work: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    void work.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}
