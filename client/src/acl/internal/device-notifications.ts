import { Method, type IPusher, type MatrixClient } from 'matrix-js-sdk'
import type { DeviceNotificationSubscription, NotificationTarget } from '../types'

// ADR-117 dec. 6 and the PR 3 forks (A1 to A3): this access's Web Push subscription, registered on the server as an
// HTTP pusher that the server hands to the push service of the installation (dec. 1). Turning it on is idempotent:
// the account's subscriptions are read and this one is written only when it is missing or differs. There is no read
// verb: the screen calls enable on every opening in which the device is on.
//
// Nothing of the subscription (endpoint, keys) goes to a log, the telemetry, an error or a report.

export const PUSH_APP_ID = 'io.tayet.web'
// A3: the push service as the server reaches it, on the installation's own network (ADR-117 dec. 7).
export const PUSH_SERVICE_URL = 'http://push:8095/_matrix/push/v1/notify'
const DISPLAY_NAME = 'Tayet'
const LANG = 'en'
const MAX_ENDPOINT = 2048

// Unpadded base64url of exactly `bytes` bytes (the form the browser's PushSubscription.toJSON gives).
function isB64url(s: unknown, bytes: number): s is string {
  return typeof s === 'string' && s.length === Math.ceil((bytes * 4) / 3) && /^[A-Za-z0-9_-]+$/.test(s)
}

// Fork 5: only the shape is checked here; the list of push destinations lives in the push service (dec. 7). The
// error never carries the value.
export function assertSubscription(s: unknown): asserts s is DeviceNotificationSubscription {
  const sub = s as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null
  const endpoint = sub?.endpoint
  let ok = typeof endpoint === 'string' && endpoint.length <= MAX_ENDPOINT
  if (ok) {
    try {
      const url = new URL(endpoint as string)
      ok = url.protocol === 'https:' || url.protocol === 'http:'
    } catch {
      ok = false
    }
  }
  if (!ok || !isB64url(sub?.keys?.p256dh, 65) || !isB64url(sub?.keys?.auth, 16)) {
    throw new Error('invalid device notification subscription')
  }
}

export type PusherClient = Pick<MatrixClient, 'setPusher' | 'removePusher'> & {
  http: Pick<MatrixClient['http'], 'authedRequest'>
}

function sameSubscription(p: IPusher, sub: DeviceNotificationSubscription): boolean {
  const data = p.data as { endpoint?: unknown; auth?: unknown }
  const { p256dh, auth } = sub.keys
  return p.app_id === PUSH_APP_ID && p.pushkey === p256dh && data.endpoint === sub.endpoint && data.auth === auth
}

// The read goes straight to GET /pushers: the SDK's getPushers also asks whether the server supports an unstable
// feature, a second request this check does not need.
export async function registerSubscription(client: PusherClient, sub: DeviceNotificationSubscription): Promise<void> {
  const { pushers } = await client.http.authedRequest<{ pushers: IPusher[] }>(Method.Get, '/pushers')
  if ((pushers ?? []).some((p) => sameSubscription(p, sub))) return
  await client.setPusher({
    kind: 'http',
    app_id: PUSH_APP_ID,
    pushkey: sub.keys.p256dh,
    app_display_name: DISPLAY_NAME,
    device_display_name: DISPLAY_NAME,
    lang: LANG,
    data: { url: PUSH_SERVICE_URL, endpoint: sub.endpoint, auth: sub.keys.auth } as IPusher['data'],
    // A subscription is one browser's: the same key under another account goes (the server removes it there).
    append: false,
  })
}

export async function unregisterSubscription(client: PusherClient, pushKey: string): Promise<void> {
  await client.removePusher(pushKey, PUSH_APP_ID)
}

// ADR-117 dec. 5: a notification's click target as it came (from the push or the live tab), or undefined when it is
// not one: strings of at most 255 characters, `conversation` required. Nothing here says the conversation exists.
const MAX_TARGET_ID = 255
export function notificationTarget(t: unknown): NotificationTarget | undefined {
  if (typeof t !== 'object' || t === null) return undefined
  const { conversation, message, thread } = t as Record<string, unknown>
  const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_TARGET_ID
  const optional = (v: unknown): boolean => v === undefined || id(v)
  if (!id(conversation) || !optional(message) || !optional(thread)) return undefined
  return { conversation, message: message as string | undefined, thread: thread as string | undefined }
}
