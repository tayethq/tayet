import { decide, parsePayload, workerLanguage } from './notification'
import { CLICK_MESSAGE, clickTargetOf, savePendingTarget, workerLocale } from './store'

// ADR-117 dec. 5: the service worker — push and click only. No fetch listener and no cache of pages or conversations;
// it does not decrypt and imports neither the SDK nor the ACL. Built on its own as /sw.js (vite.config.ts).

// The worker scope's types are not in the project's DOM lib; the few used here, structurally.
interface ExtendableEvent extends Event {
  waitUntil(p: Promise<unknown>): void
}
interface PushEvent extends ExtendableEvent {
  readonly data: { json(): unknown } | null
}
interface NotificationEvent extends ExtendableEvent {
  readonly notification: Notification
}
interface WindowClient {
  readonly focused: boolean
  readonly visibilityState: DocumentVisibilityState
  focus(): Promise<WindowClient>
  postMessage(message: unknown): void
}
interface WorkerScope {
  readonly registration: ServiceWorkerRegistration
  readonly clients: {
    matchAll(options: { type: 'window'; includeUncontrolled: boolean }): Promise<readonly WindowClient[]>
    claim(): Promise<void>
    openWindow(url: string): Promise<WindowClient | null>
  }
  skipWaiting(): Promise<void>
  addEventListener(type: 'install' | 'activate', fn: (e: ExtendableEvent) => void): void
  addEventListener(type: 'push', fn: (e: PushEvent) => void): void
  addEventListener(type: 'notificationclick', fn: (e: NotificationEvent) => void): void
}
declare const self: WorkerScope

// The generic notification (a push we cannot read) has no target; one tag keeps them to one on screen.
const GENERIC_TAG = 'tayet'

const appWindows = (): Promise<readonly WindowClient[]> => self.clients.matchAll({ type: 'window', includeUncontrolled: true })

async function onPush(e: PushEvent): Promise<void> {
  let raw: unknown
  try {
    raw = e.data?.json()
  } catch {
    raw = undefined
  }
  const payload = parsePayload(raw)
  const [windows, existing, stored] = await Promise.all([
    appWindows(),
    payload ? self.registration.getNotifications({ tag: payload.conversation }) : Promise.resolve([]),
    workerLocale(),
  ])
  const locale = workerLanguage(stored)
  const shown = decide(
    payload,
    windows.map((w) => ({ focused: w.focused, visible: w.visibilityState === 'visible' })),
    existing.map((n) => ({ title: n.title, body: n.body, data: n.data as unknown })),
    locale,
  )
  if (!shown) return
  await self.registration.showNotification(shown.title, { body: shown.body, tag: payload?.conversation ?? GENERIC_TAG, data: shown.data })
}

// Fork S6: an open window is focused and told where to go; with none, the target waits (5 minutes) and the app
// opens at its root. The target is never in the URL.
async function onClick(e: NotificationEvent): Promise<void> {
  e.notification.close()
  const target = clickTargetOf(e.notification.data)
  const windows = await appWindows()
  const win = windows.find((w) => w.focused) ?? windows.find((w) => w.visibilityState === 'visible') ?? windows[0]
  if (win) {
    await win.focus().catch(() => undefined)
    if (target) win.postMessage({ type: CLICK_MESSAGE, target })
    return
  }
  // Saved before opening: the target is there whether or not the browser lets the window open.
  if (target) await savePendingTarget(target, Date.now()).catch(() => undefined)
  await self.clients.openWindow('/').catch(() => null)
}

self.addEventListener('install', () => void self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
self.addEventListener('push', (e) => e.waitUntil(onPush(e)))
self.addEventListener('notificationclick', (e) => e.waitUntil(onClick(e)))
