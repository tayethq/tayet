import { CLICK_MESSAGE, clickTargetOf, type ClickTarget } from '../sw/store'

// ADR-117 dec. 5, the page's side of the service worker: registration in the production build (main.tsx), the
// registration the live tab notifies through (notifier.ts), and the click target the worker posts to an open window.

let registration: ServiceWorkerRegistration | undefined

// Silent on failure: without a worker the live tab notifies as before (new Notification).
export function registerServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return
  navigator.serviceWorker
    .register('/sw.js')
    .then(() => navigator.serviceWorker.ready)
    .then((ready) => {
      registration = ready
    })
    .catch(() => undefined)
}

export function activeRegistration(): ServiceWorkerRegistration | undefined {
  return registration?.active ? registration : undefined
}

// The worker's click, while the app is open. Returns the unsubscribe.
export function onNotificationClick(fn: (target: ClickTarget) => void): () => void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return () => {}
  const listener = (e: MessageEvent): void => {
    const data = e.data as { type?: unknown; target?: unknown } | null
    if (data?.type !== CLICK_MESSAGE) return
    const target = clickTargetOf(data.target)
    if (target) fn(target)
  }
  navigator.serviceWorker.addEventListener('message', listener)
  return () => navigator.serviceWorker.removeEventListener('message', listener)
}
