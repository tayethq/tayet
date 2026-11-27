// The browser's Push API in the push E2E (ADR-117; PR 5b of the push track). Both are init scripts: they run in
// every page of a context, before the app, and replace methods of the PushManager prototype.
//
// The Playwright context is off the record, where Chrome refuses `pushManager.subscribe` and writes its own console
// error about it (Phase 0 of PR 5b; seen in the console ledger in round 2). The app's opening check subscribes when the
// device preference is on and the permission granted, so every context that grants notifications needs one of these.

// A context whose push subscription is not the subject: `subscribe` refuses as a browser without push service would
// (the app keeps the row off, F2), quietly, and there is never a subscription.
export function refusePushSubscription(): void {
  const proto = (window as unknown as { PushManager?: { prototype: Record<string, unknown> } }).PushManager?.prototype
  if (!proto) return
  proto['subscribe'] = async () => {
    throw new DOMException('Registration failed - no push service in this run', 'AbortError')
  }
  proto['getSubscription'] = async () => null
}

// A fabricated subscription (notifications-row.push.spec.ts): keys of the browser's shape and an endpoint the spec
// chooses (test/support/push-subscription.ts). It lives in the page's storage, so it survives a reload as a real one.
export const FAKE_PUSH_FLAG = '__e2e_push_subscribed'
export function fakePushManager(sub: { endpoint: string; keys: { p256dh: string; auth: string } }): void {
  const proto = (window as unknown as { PushManager?: { prototype: Record<string, unknown> } }).PushManager?.prototype
  if (!proto) return
  const flag = '__e2e_push_subscribed'
  const make = () => ({
    endpoint: sub.endpoint,
    expirationTime: null,
    options: { userVisibleOnly: true, applicationServerKey: null },
    getKey: () => null,
    toJSON: () => ({ endpoint: sub.endpoint, expirationTime: null, keys: sub.keys }),
    unsubscribe: async () => {
      localStorage.removeItem(flag)
      return true
    },
  })
  proto['subscribe'] = async () => {
    localStorage.setItem(flag, '1')
    return make()
  }
  proto['getSubscription'] = async () => (localStorage.getItem(flag) ? make() : null)
}
