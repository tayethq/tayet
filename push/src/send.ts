// One Web Push delivery: subscription check, encryption, headers, and what the push service's answer
// means for the homeserver.
import { createHmac } from 'node:crypto'
import { allowedEndpoint, parseAllowed } from './endpoints.ts'
import { encrypt, fromB64url, type VapidCache } from './crypto.ts'

export interface Subscription {
  endpoint: URL
  p256dh: Buffer
  auth: Buffer
}

// pushkey is the subscription's p256dh key; data carries endpoint and auth (the homeserver keeps
// `url` for itself and forwards the rest). Undefined when malformed or the endpoint is not allowed.
export function subscriptionOf(rules: ReturnType<typeof parseAllowed>, pushkey: unknown, data: unknown): Subscription | undefined {
  if (typeof pushkey !== 'string' || typeof data !== 'object' || data === null) return undefined
  const { endpoint, auth } = data as Record<string, unknown>
  if (typeof endpoint !== 'string' || typeof auth !== 'string') return undefined
  const p256dh = fromB64url(pushkey)
  const authBytes = fromB64url(auth)
  if (!p256dh || p256dh.length !== 65 || p256dh[0] !== 4) return undefined
  if (!authBytes || authBytes.length !== 16) return undefined
  const url = allowedEndpoint(rules, endpoint)
  return url ? { endpoint: url, p256dh, auth: authBytes } : undefined
}

// Seconds the push service keeps an undelivered message.
export const TTL_S = 259_200
export const SEND_TIMEOUT_MS = 10_000

// The Topic header: one pending message per conversation replaces the previous one while the device
// is offline. HMAC-SHA-256 of the conversation keyed with the subscription's auth secret, so the push
// service cannot tie two subscriptions to the same conversation; base64url, cut to the 32 characters
// RFC 8030 allows.
export const topicOf = (auth: Buffer, conversation: string): string =>
  createHmac('sha256', auth).update(conversation).digest('base64url').slice(0, 32)

export type Outcome = 'ok' | 'gone' | 'retry' | 'invalid'

export interface SendDeps {
  vapid: VapidCache
  fetch?: typeof fetch
  log?: (line: string) => void
}

export async function deliver(
  deps: SendDeps,
  sub: Subscription,
  payload: Buffer,
  opts: { urgent: boolean; conversation: string },
): Promise<Outcome> {
  let body: Buffer
  try {
    body = encrypt(payload, sub.p256dh, sub.auth)
  } catch {
    // A p256dh that is 65 bytes but not a point on the curve.
    return 'invalid'
  }
  const log = deps.log ?? ((l: string) => console.error(l))
  const host = sub.endpoint.hostname
  let status: number
  try {
    const res = await (deps.fetch ?? fetch)(sub.endpoint, {
      method: 'POST',
      // Never follow a redirect: it could lead outside the allowed list.
      redirect: 'manual',
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      headers: {
        'content-type': 'application/octet-stream',
        'content-encoding': 'aes128gcm',
        ttl: String(TTL_S),
        urgency: opts.urgent ? 'high' : 'normal',
        topic: topicOf(sub.auth, opts.conversation),
        authorization: deps.vapid.header(sub.endpoint.origin),
      },
      body,
    })
    status = res.status
    await res.body?.cancel()
  } catch {
    log(JSON.stringify({ evt: 'push-send-failed', host, reason: 'network or timeout' }))
    return 'retry'
  }
  if (status >= 200 && status < 300) return 'ok'
  if (status === 404 || status === 410) return 'gone'
  if (status === 429 || status >= 500) {
    log(JSON.stringify({ evt: 'push-send-failed', host, status }))
    return 'retry'
  }
  log(JSON.stringify({ evt: 'push-send-error', host, status }))
  return 'ok'
}
