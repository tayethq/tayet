// Send queue of the sidecar (ADR-087 dec. 7; ADR-086 dec. 9; PLANO-AGENTES §0.3.5 adj. 9) — the
// ONLY owner of the retry (the SDK's scheduler never retries: `new MatrixScheduler(() => -1)`).
//
// - One send in flight per agent (FIFO; the next starts when the previous settles).
// - Deadline of 30 s counted from the enqueue: a send blocks until the server accepts it, never
//   longer. No provisional id is ever handed out.
// - M_LIMIT_EXCEEDED: wait getRetryAfterMs() + 1 s (the limiter counts rejected attempts — arriving
//   early re-locks, as measured for joins in join-queue.ts) and try again, if that wait fits in the
//   deadline (a new transaction id per attempt — the SDK keeps a cancelled one in its room's map and
//   refuses it, and a 429 means the server stored nothing); otherwise fail `{ kind: 'rate-limited', retryAfterMs }`.
//   The server's window holds for the sends behind it too (no attempt inside it); a send whose
//   deadline passes while still in line fails the same way, with what is left of that window.
// - Every failed attempt cancels the SDK's local pending event (`cancel` → cancelPendingEvent).
// - M_UNKNOWN_TOKEN fails the whole queue with `revoked` (this send, the ones in line, and every
//   later one) and triggers the core's existing revoke() (ADR-087 dec. 8).
// - Any other error fails that send at once (no retry): only the server's limit is waited out.
//
// Every write effect is a job of this one queue (§0.3.7 item 4): the jobs are the discriminated union
// `WriteJob` of send.ts (text, edit, removal, reaction and its removal, the message of an attachment),
// and the semantics above hold for every kind (queue.test.ts proves them per kind).
//
// A HANDED-BACK job (the pinned panel's writes, ADR-091 dec. 13; core/panels.ts) keeps every rule above
// except the waiting: no 30 s deadline, and the server's limit (a 429, or a window still open) fails it at
// once `rate-limited` with the server's wait — its own scheduler keeps the version and comes back after it.
//
// Pure of the SDK: the attempt, the cancel and the classification are ports (core wiring); the unit
// tests drive it with fakes and fake timers.
import { NotMember, ReplyInThread } from './send'

export const SEND_DEADLINE_MS = 30_000
export const SEND_RETRY_MARGIN_MS = 1_000
// M_LIMIT_EXCEEDED without a retry hint (Synapse always sends one; defence): the join queue's wait.
export const SEND_DEFAULT_RETRY_MS = 5_000

export type SendFailure =
  | { kind: 'rate-limited'; retryAfterMs: number }
  | { kind: 'revoked' }
  | { kind: 'not-member' }
  | { kind: 'reply-in-thread' }
  // Another refusal or a transport error: the errcode/status only — never a message that could
  // echo content.
  | { kind: 'failed'; errcode: string | null; status: number | null }
  // The core is shutting down.
  | { kind: 'stopped' }

export type SendResult = { ok: true; messageId: string } | { ok: false; error: SendFailure }

export type AttemptVerdict =
  | { kind: 'rate-limited'; retryAfterMs: number | null }
  | { kind: 'revoked' }
  | { kind: 'final'; failure: SendFailure }

export interface QueuePorts<J> {
  attempt(job: J): Promise<string>
  cancel(job: J): void
  classify(err: unknown): AttemptVerdict
  onRevoked(): void
  log(line: Record<string, unknown>): void
  // A job its caller retries itself (header): no deadline, the server's limit handed back at once.
  handBack?(job: J): boolean
}

export interface SendQueue<J> {
  enqueue(job: J): Promise<SendResult>
  // Fails everything pending (in flight included) and every later enqueue. Idempotent.
  close(failure: SendFailure): void
  readonly size: number
}

// The SDK's error → verdict. MatrixError.getRetryAfterMs() reads the Retry-After header, then
// retry_after_ms (it throws on a malformed value — then the default wait).
export function classifySendError(err: unknown): AttemptVerdict {
  if (err instanceof NotMember) return { kind: 'final', failure: { kind: 'not-member' } }
  if (err instanceof ReplyInThread) return { kind: 'final', failure: { kind: 'reply-in-thread' } }
  const e = err as { errcode?: unknown; httpStatus?: unknown; getRetryAfterMs?: unknown }
  if (e.errcode === 'M_UNKNOWN_TOKEN') return { kind: 'revoked' }
  if (e.errcode === 'M_LIMIT_EXCEEDED') {
    let retryAfterMs: number | null = null
    try {
      if (typeof e.getRetryAfterMs === 'function') retryAfterMs = (e.getRetryAfterMs as () => number | null).call(err)
    } catch {
      retryAfterMs = null
    }
    return { kind: 'rate-limited', retryAfterMs }
  }
  return {
    kind: 'final',
    failure: {
      kind: 'failed',
      errcode: typeof e.errcode === 'string' ? e.errcode : null,
      status: typeof e.httpStatus === 'number' ? e.httpStatus : null,
    },
  }
}

interface Entry<J> {
  job: J
  // Infinity for a handed-back job (header).
  deadline: number
  handBack: boolean
  settled: boolean
  resolve: (r: SendResult) => void
  timer: ReturnType<typeof setTimeout> | undefined
}

export function createSendQueue<J>(ports: QueuePorts<J>): SendQueue<J> {
  const line: Array<Entry<J>> = []
  let current: Entry<J> | null = null
  let closed: SendFailure | null = null
  // End of the server's last imposed wait (for the sends that expire in line).
  let blockedUntil = 0
  let wake: (() => void) | null = null

  const settle = (entry: Entry<J>, result: SendResult): void => {
    if (entry.settled) return
    entry.settled = true
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    if (!result.ok) {
      const e = result.error
      ports.log({ evt: 'send-failed', kind: e.kind, ...(e.kind === 'failed' && { errcode: e.errcode, status: e.status }) })
    }
    entry.resolve(result)
  }

  const cancel = (job: J): void => {
    try {
      ports.cancel(job)
    } catch (err) {
      ports.log({ evt: 'send-cancel-error', message: err instanceof Error ? err.name : 'unknown' })
    }
  }

  const close = (failure: SendFailure): void => {
    if (closed !== null) return
    closed = failure
    if (current !== null) settle(current, { ok: false, error: failure })
    for (const entry of line.splice(0)) settle(entry, { ok: false, error: failure })
    wake?.()
  }

  const pause = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const t = setTimeout(() => {
        wake = null
        resolve()
      }, ms)
      wake = () => {
        clearTimeout(t)
        wake = null
        resolve()
      }
    })

  const run = async (entry: Entry<J>): Promise<void> => {
    for (;;) {
      if (entry.settled) return
      // The server's window holds for every send, not just the one that got the 429: an attempt
      // inside it would only be rejected again (and rejected attempts count).
      const now = Date.now()
      if (blockedUntil > now) {
        const waitMs = blockedUntil - now + SEND_RETRY_MARGIN_MS
        if (entry.handBack || now + waitMs > entry.deadline) {
          settle(entry, { ok: false, error: { kind: 'rate-limited', retryAfterMs: blockedUntil - now } })
          return
        }
        await pause(waitMs)
        continue
      }
      let messageId: string
      try {
        messageId = await ports.attempt(entry.job)
      } catch (err) {
        cancel(entry.job)
        if (entry.settled) return
        const verdict = ports.classify(err)
        if (verdict.kind === 'revoked') {
          close({ kind: 'revoked' })
          ports.onRevoked()
          return
        }
        if (verdict.kind === 'final') {
          settle(entry, { ok: false, error: verdict.failure })
          return
        }
        const retryAfterMs = verdict.retryAfterMs ?? SEND_DEFAULT_RETRY_MS
        const at = Date.now()
        blockedUntil = Math.max(blockedUntil, at + retryAfterMs)
        // Decided here, with the server's own number: a wait that does not fit fails now.
        if (entry.handBack || at + retryAfterMs + SEND_RETRY_MARGIN_MS > entry.deadline) {
          settle(entry, { ok: false, error: { kind: 'rate-limited', retryAfterMs } })
          return
        }
        ports.log({ evt: 'send-ratelimited', retryAfterMs })
        continue
      }
      settle(entry, { ok: true, messageId })
      return
    }
  }

  let pumping = false
  const pump = async (): Promise<void> => {
    if (pumping) return
    pumping = true
    try {
      while (line.length > 0 && closed === null) {
        const entry = line.shift()!
        current = entry
        await run(entry)
        current = null
      }
    } finally {
      current = null
      pumping = false
    }
  }

  return {
    enqueue(job) {
      if (closed !== null) {
        const failure = closed
        ports.log({ evt: 'send-failed', kind: failure.kind })
        return Promise.resolve({ ok: false, error: failure })
      }
      return new Promise<SendResult>((resolve) => {
        const handBack = ports.handBack?.(job) === true
        const entry: Entry<J> = { job, deadline: handBack ? Infinity : Date.now() + SEND_DEADLINE_MS, handBack, settled: false, resolve, timer: undefined }
        // Expiry while still in line (the one in flight enforces its own deadline before waiting).
        if (!handBack) {
          entry.timer = setTimeout(() => {
            const i = line.indexOf(entry)
            if (i === -1) return
            line.splice(i, 1)
            settle(entry, { ok: false, error: { kind: 'rate-limited', retryAfterMs: Math.max(blockedUntil - Date.now(), 0) } })
          }, SEND_DEADLINE_MS)
        }
        line.push(entry)
        void pump()
      })
    },
    close,
    get size() {
      return line.length + (current !== null ? 1 : 0)
    },
  }
}
