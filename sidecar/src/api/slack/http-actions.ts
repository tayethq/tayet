// The approval card's click delivered over HTTP, as Slack delivers interactivity to an app's Request URL. With
// `--slack-actions-url`, each `approval.answered` becomes one signed POST of the `block_actions` payload
// (slack/interactive.ts `blockActionsOf`, the same fields as the socket's) to that URL, and no socket gets an
// `interactive` envelope. Events and `/` commands stay on the emulated Socket Mode.
//
// - The request is Slack's: `application/x-www-form-urlencoded` with one field, `payload=<JSON>` (Bolt 5.1.0
//   compares the media type exactly: no parameter is added); `X-Slack-Request-Timestamp` (seconds) and
//   `X-Slack-Signature: v0=<hex>`, the HMAC-SHA256 of `v0:<timestamp>:<body>` keyed by the local token.
//   node:http, so no redirect is followed and no proxy of the environment is used.
// - Any 2xx is the ack: the card's entry leaves the layer's file (the socket ack's effect). The response body
//   is read and ignored.
// - No 2xx within 3 s (an error status, a timeout, a refused connection): the same payload again, up to 3
//   times, each with a fresh timestamp and signature and Slack's retry headers (`X-Slack-Retry-Num` 1–3,
//   `X-Slack-Retry-Reason`: `http_timeout`, `http_error` or `connection_failed`).
// - After the retries the click is kept in memory (at most 200, the oldest leaving first with one line) and
//   delivered again every 30 s, in order; a failure stops the round. A kept click the app refuses in 3 rounds (an
//   error status or no answer within the timeout; a refused connection does not count, nor do the immediate
//   retries) is dropped on the 3rd with `slack-action-dropped` (`reason: 'unaccepted'`), its card entry left in
//   place, and the round goes on with the next click. Each of these deliveries rebuilds the payload (a fresh
//   response_url ticket), with no retry headers. While clicks are kept, a new click joins the end of the list
//   instead of going out ahead of them.
// - Deliveries run one after the other, in the order the clicks came.
// - Every payload passes the Slack edge before it leaves: a finding → not sent, `leak-blocked`, and the click is
//   dropped.
// - Lines: `slack-action-delivered`, `slack-action-retried`, `slack-action-kept`, `slack-action-dropped` (`reason`:
//   `full`, `unaccepted` or `leak`); never
//   the token, the signature, the body, the response_url or an id. The clock is injectable (unit tests).
// At least once: an app that answered 2xx late, or after a retry it also answered, sees the click twice (the
// same `container.message_ts`).
import { createHmac } from 'node:crypto'
import { request } from 'node:http'
import { UNHEARD_MAX } from '../bus'
import { logLeaks } from '../edge'
import { scanSlack } from './edge'
import { ACK_TIMEOUT_MS, MAX_RETRIES } from './envelopes'
import { SYSTEM_CLOCK, type SocketClock } from './socket'

type Log = (line: Record<string, unknown>) => void

export const REDELIVERY_MS = 30_000
export const KEPT_MAX = UNHEARD_MAX
export const USER_AGENT = 'tayet-agent'
// Periodic rounds in which the app answered without a 2xx (or not within the timeout) before a kept click is dropped.
export const UNACCEPTED_ROUNDS = 3

export type RetryReason = 'http_timeout' | 'http_error' | 'connection_failed'

// One click: how to build its payload (again, for the periodic redelivery) and what its ack does.
export interface HttpClick {
  build(): Promise<Record<string, unknown>>
  acked(): Promise<void>
}

export interface HttpActionsOptions {
  url: string
  // The signing secret: the local token.
  secret: string
  log: Log
  clock?: SocketClock
  ackTimeoutMs?: number
  maxRetries?: number
  redeliveryMs?: number
  keptMax?: number
  unacceptedRounds?: number
}

export interface HttpActions {
  // One click; returns once the payload is built and queued.
  deliver(click: HttpClick): Promise<void>
  // Revocation and shutdown: nothing more goes out; what is kept is forgotten.
  stop(): void
  readonly kept: number
}

// Slack's signature of one request.
export function slackSignature(secret: string, timestamp: number, body: string): string {
  return `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`
}

export const formBody = (payload: Record<string, unknown>): string => new URLSearchParams({ payload: JSON.stringify(payload) }).toString()

type Attempt = { ok: true; status: number } | { ok: false; reason: RetryReason }

// The answer to one POST of a form's submission: the status line and the body as text (up to `bodyMax` bytes;
// a longer body reads as a refused one), a refused connection, or no answer in time.
export type PostAnswer = { kind: 'answer'; status: number; body: string } | { kind: 'refused' } | { kind: 'timeout' }

// One signed POST of a payload, as a click is sent, but on its own: no retry, no queue, and the body of the answer
// is read. The payload has passed the Slack edge (the caller's).
export function postOnce(opts: { url: string; secret: string; clock?: SocketClock; timeoutMs: number; bodyMax: number }, payload: Record<string, unknown>): Promise<PostAnswer> {
  const clock = opts.clock ?? SYSTEM_CLOCK
  const body = formBody(payload)
  return new Promise((resolve) => {
    const timestamp = Math.floor(clock.now() / 1000)
    let settled = false
    const req = request(opts.url, {
      method: 'POST',
      agent: false,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': String(Buffer.byteLength(body)),
        'user-agent': USER_AGENT,
        'x-slack-request-timestamp': String(timestamp),
        'x-slack-signature': slackSignature(opts.secret, timestamp, body),
      },
    })
    const settle = (a: PostAnswer): void => {
      if (settled) return
      settled = true
      clock.clearTimeout(handle)
      resolve(a)
    }
    const handle = clock.setTimeout(() => {
      settle({ kind: 'timeout' })
      req.destroy()
    }, opts.timeoutMs)
    req.on('response', (res) => {
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (c: Buffer) => {
        size += c.length
        if (size > opts.bodyMax) {
          settle({ kind: 'refused' })
          req.destroy()
        } else chunks.push(c)
      })
      res.on('end', () => settle({ kind: 'answer', status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
      res.on('error', () => settle({ kind: 'refused' }))
    })
    req.on('error', () => settle({ kind: 'refused' }))
    req.end(body)
  })
}

export function createHttpActions(opts: HttpActionsOptions): HttpActions {
  const { log, url, secret } = opts
  const clock = opts.clock ?? SYSTEM_CLOCK
  const ackTimeoutMs = opts.ackTimeoutMs ?? ACK_TIMEOUT_MS
  const maxRetries = opts.maxRetries ?? MAX_RETRIES
  const redeliveryMs = opts.redeliveryMs ?? REDELIVERY_MS
  const keptMax = opts.keptMax ?? KEPT_MAX
  const unacceptedRounds = opts.unacceptedRounds ?? UNACCEPTED_ROUNDS
  // A kept click and the periodic rounds in which the app refused it (an error status or no answer in time).
  const kept: Array<{ click: HttpClick; unaccepted: number }> = []
  const inflight = new Set<() => void>()
  let timer: unknown
  let chain = Promise.resolve()
  let stopped = false

  // One POST; settles on the status line, the timeout or a transport error.
  const attempt = (body: string, retry: { num: number; reason: RetryReason } | null): Promise<Attempt> =>
    new Promise((resolve) => {
      if (stopped) return resolve({ ok: false, reason: 'connection_failed' })
      const timestamp = Math.floor(clock.now() / 1000)
      let settled = false
      const req = request(url, {
        method: 'POST',
        agent: false,
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'content-length': String(Buffer.byteLength(body)),
          'user-agent': USER_AGENT,
          'x-slack-request-timestamp': String(timestamp),
          'x-slack-signature': slackSignature(secret, timestamp, body),
          ...(retry !== null && { 'x-slack-retry-num': String(retry.num), 'x-slack-retry-reason': retry.reason }),
        },
      })
      const abort = (): void => void req.destroy()
      const settle = (a: Attempt): void => {
        if (settled) return
        settled = true
        clock.clearTimeout(handle)
        inflight.delete(abort)
        resolve(a)
      }
      inflight.add(abort)
      const handle = clock.setTimeout(() => {
        settle({ ok: false, reason: 'http_timeout' })
        req.destroy()
      }, ackTimeoutMs)
      req.on('response', (res) => {
        res.on('error', () => {})
        res.resume()
        const status = res.statusCode ?? 0
        settle(status >= 200 && status < 300 ? { ok: true, status } : { ok: false, reason: 'http_error' })
      })
      req.on('error', () => settle({ ok: false, reason: 'connection_failed' }))
      req.end(body)
    })

  // The payload through the Slack edge, then the form body; null when the edge withheld it.
  const bodyOf = (payload: Record<string, unknown>): string | null => {
    const leaks = scanSlack(payload)
    if (leaks.length > 0) {
      logLeaks(log, 'slack actions', leaks)
      log({ evt: 'slack-action-dropped', reason: 'leak' })
      return null
    }
    return formBody(payload)
  }

  const acked = async (click: HttpClick): Promise<void> => {
    try {
      await click.acked()
    } catch (err) {
      log({ evt: 'api-error', where: 'slack actions ack', name: err instanceof Error ? err.name : typeof err })
    }
  }

  const keep = (click: HttpClick): void => {
    kept.push({ click, unaccepted: 0 })
    if (kept.length > keptMax) {
      kept.shift()
      log({ evt: 'slack-action-dropped', reason: 'full' })
    }
    log({ evt: 'slack-action-kept', kept: kept.length })
    arm()
  }

  const arm = (): void => {
    if (stopped || timer !== undefined || kept.length === 0) return
    timer = clock.setTimeout(() => {
      timer = undefined
      chain = chain.then(redeliver, () => {})
    }, redeliveryMs)
  }

  // A live click: the first attempt and its retries; the click is kept when they all fail.
  const live = async (click: HttpClick, payload: Record<string, unknown>): Promise<void> => {
    if (stopped) return
    if (kept.length > 0) return keep(click)
    const body = bodyOf(payload)
    if (body === null) return
    let retry: { num: number; reason: RetryReason } | null = null
    for (;;) {
      const a = await attempt(body, retry)
      if (stopped) return
      if (a.ok) {
        log({ evt: 'slack-action-delivered', status: a.status, ...(retry !== null && { attempt: retry.num }) })
        return acked(click)
      }
      const num: number = (retry?.num ?? 0) + 1
      if (num > maxRetries) return keep(click)
      log({ evt: 'slack-action-retried', attempt: num, reason: a.reason })
      retry = { num, reason: a.reason }
    }
  }

  // The kept clicks, in order, one attempt each. A failure stops the round — except the round in which the app
  // refuses a click for the third time (an error status or no answer in time; a refused connection does not
  // count): that click is dropped and the round goes on with the next one.
  const redeliver = async (): Promise<void> => {
    while (!stopped && kept.length > 0) {
      const head = kept[0] as { click: HttpClick; unaccepted: number }
      const click = head.click
      let body: string | null
      try {
        body = bodyOf(await click.build())
      } catch (err) {
        log({ evt: 'api-error', where: 'slack actions', name: err instanceof Error ? err.name : typeof err })
        break
      }
      if (stopped) return
      if (body === null) {
        kept.shift()
        continue
      }
      const a = await attempt(body, null)
      if (stopped) return
      if (!a.ok) {
        if (a.reason === 'connection_failed') break
        head.unaccepted += 1
        if (head.unaccepted < unacceptedRounds) break
        kept.shift()
        log({ evt: 'slack-action-dropped', reason: 'unaccepted' })
        continue
      }
      kept.shift()
      log({ evt: 'slack-action-delivered', status: a.status, redelivered: true })
      await acked(click)
    }
    arm()
  }

  return {
    get kept() {
      return kept.length
    },
    async deliver(click) {
      if (stopped) return
      const payload = await click.build()
      chain = chain.then(() => live(click, payload)).catch((err: unknown) => {
        log({ evt: 'api-error', where: 'slack actions', name: err instanceof Error ? err.name : typeof err })
      })
    },
    stop() {
      stopped = true
      clock.clearTimeout(timer)
      timer = undefined
      kept.length = 0
      for (const abort of [...inflight]) abort()
    },
  }
}
