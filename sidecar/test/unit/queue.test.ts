import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  classifySendError,
  createSendQueue,
  SEND_DEADLINE_MS,
  SEND_DEFAULT_RETRY_MS,
  SEND_RETRY_MARGIN_MS,
  type AttemptVerdict,
  type QueuePorts,
  type SendResult,
} from '../../src/core/queue'
import { NotMember, ReplyInThread, type WriteGateway, type WriteJob } from '../../src/core/send'
import { createWriteQueue } from '../../src/core/write-queue'

// The send queue (ADR-087 dec. 7) with fakes and fake timers: one in flight, the 30 s deadline from
// the enqueue, retry_after + 1 s inside the deadline, cancelPendingEvent on every failed attempt,
// and `revoked` failing everything (and triggering the core's revoke once).

interface Job {
  n: number
}

type Step = ({ ok: string } | { err: AttemptVerdict }) & { delay?: number }

interface Fake {
  ports: QueuePorts<Job>
  attempts: Array<{ n: number; at: number }>
  cancels: number[]
  revokes: number
  inFlight: number
  maxInFlight: number
  logs: Array<Record<string, unknown>>
  // Per job: the outcomes of its successive attempts (10 ms each unless `delay`).
  plan: Map<number, Step[]>
}

function fake(): Fake {
  const f: Fake = {
    attempts: [],
    cancels: [],
    revokes: 0,
    inFlight: 0,
    maxInFlight: 0,
    logs: [],
    plan: new Map(),
    ports: undefined as unknown as QueuePorts<Job>,
  }
  f.ports = {
    attempt: async (job) => {
      f.attempts.push({ n: job.n, at: Date.now() })
      f.inFlight += 1
      f.maxInFlight = Math.max(f.maxInFlight, f.inFlight)
      try {
        const steps = f.plan.get(job.n) ?? []
        const step = steps.shift() ?? { ok: `$ok${job.n}` }
        await new Promise<void>((r) => {
          setTimeout(r, step.delay ?? 10)
        })
        if ('ok' in step) return step.ok
        throw Object.assign(new Error('fake attempt failure'), { verdict: step.err })
      } finally {
        f.inFlight -= 1
      }
    },
    cancel: (job) => f.cancels.push(job.n),
    // The fakes throw an error carrying the verdict; classify passes it through.
    classify: (err) => (err as { verdict: AttemptVerdict }).verdict,
    onRevoked: () => {
      f.revokes += 1
    },
    log: (line) => f.logs.push(line),
  }
  return f
}

const limited = (ms: number | null): Step => ({ err: { kind: 'rate-limited', retryAfterMs: ms } })

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('send queue (ADR-087 dec. 7)', () => {
  it('serializes: one attempt in flight, FIFO', async () => {
    const f = fake()
    const q = createSendQueue(f.ports)
    const results = [1, 2, 3].map((n) => q.enqueue({ n }))
    await vi.runAllTimersAsync()
    expect(await Promise.all(results)).toEqual([
      { ok: true, messageId: '$ok1' },
      { ok: true, messageId: '$ok2' },
      { ok: true, messageId: '$ok3' },
    ])
    expect(f.attempts.map((a) => a.n)).toEqual([1, 2, 3])
    expect(f.maxInFlight).toBe(1)
    expect(f.cancels).toEqual([])
  })

  it('M_LIMIT_EXCEEDED inside the deadline: waits retry_after + 1 s, cancels the local event, retries', async () => {
    const f = fake()
    f.plan.set(1, [limited(2_000), { ok: '$late' }])
    const q = createSendQueue(f.ports)
    const r = q.enqueue({ n: 1 })
    await vi.runAllTimersAsync()
    expect(await r).toEqual({ ok: true, messageId: '$late' })
    expect(f.attempts).toHaveLength(2)
    const gap = f.attempts[1]!.at - f.attempts[0]!.at
    expect(gap).toBeGreaterThanOrEqual(2_000 + SEND_RETRY_MARGIN_MS)
    expect(f.cancels).toEqual([1])
    expect(f.logs).toContainEqual({ evt: 'send-ratelimited', retryAfterMs: 2_000 })
  })

  it('M_LIMIT_EXCEEDED that does not fit the deadline fails at once with retryAfterMs (no 2nd attempt)', async () => {
    const f = fake()
    f.plan.set(1, [limited(SEND_DEADLINE_MS)])
    const q = createSendQueue(f.ports)
    const r = q.enqueue({ n: 1 })
    await vi.advanceTimersByTimeAsync(50)
    expect(await r).toEqual({ ok: false, error: { kind: 'rate-limited', retryAfterMs: SEND_DEADLINE_MS } })
    expect(f.attempts).toHaveLength(1)
    expect(f.cancels).toEqual([1])
  })

  it('a 429 that does not fit reports the server value exactly, even if the clock moves meanwhile', async () => {
    // Regression: the decision used to be taken one step later with a fresh Date.now(), and the
    // process test saw 39999 for a 40000 hint. Here every log line costs 1 ms of clock.
    const f = fake()
    f.ports.log = (line) => {
      vi.setSystemTime(Date.now() + 1)
      f.logs.push(line)
    }
    f.plan.set(1, [limited(SEND_DEADLINE_MS)])
    const q = createSendQueue(f.ports)
    const r1 = q.enqueue({ n: 1 })
    await vi.advanceTimersByTimeAsync(50)
    expect(await r1).toEqual({ ok: false, error: { kind: 'rate-limited', retryAfterMs: SEND_DEADLINE_MS } })
  })

  it('the deadline counts from the enqueue: the retries stop when the next wait would cross 30 s', async () => {
    const f = fake()
    // 3 × (9 s + 1 s) = 30 s: the 3rd wait would end past the deadline (the attempts take 10 ms each).
    f.plan.set(1, [limited(9_000), limited(9_000), limited(9_000), { ok: '$never' }])
    const q = createSendQueue(f.ports)
    const t0 = Date.now()
    const r = q.enqueue({ n: 1 })
    await vi.runAllTimersAsync()
    expect(await r).toEqual({ ok: false, error: { kind: 'rate-limited', retryAfterMs: 9_000 } })
    expect(f.attempts).toHaveLength(3)
    expect(Date.now() - t0).toBeLessThanOrEqual(SEND_DEADLINE_MS)
    expect(f.cancels).toEqual([1, 1, 1])
  })

  it('the window of a 429 holds for the sends behind it: no attempt inside it', async () => {
    const f = fake()
    f.plan.set(1, [limited(60_000)])
    const q = createSendQueue(f.ports)
    const r1 = q.enqueue({ n: 1 })
    const r2 = q.enqueue({ n: 2 })
    await vi.advanceTimersByTimeAsync(50)
    expect(await r1).toEqual({ ok: false, error: { kind: 'rate-limited', retryAfterMs: 60_000 } })
    const second = await r2
    expect(second).toMatchObject({ ok: false, error: { kind: 'rate-limited' } })
    const left = (second as { error: { retryAfterMs: number } }).error.retryAfterMs
    expect(left).toBeGreaterThan(59_000)
    expect(left).toBeLessThanOrEqual(60_000)
    expect(f.attempts.map((a) => a.n)).toEqual([1])
    // A window that fits the deadline is waited out by the next send instead.
    await vi.advanceTimersByTimeAsync(60_000)
    f.plan.set(3, [limited(3_000)])
    const r3 = q.enqueue({ n: 3 })
    const r4 = q.enqueue({ n: 4 })
    await vi.runAllTimersAsync()
    expect(await r3).toEqual({ ok: true, messageId: '$ok3' })
    expect(await r4).toEqual({ ok: true, messageId: '$ok4' })
    expect(f.attempts.map((a) => a.n)).toEqual([1, 3, 3, 4])
  })

  it('a send whose deadline passes in line (behind a slow attempt) expires without an attempt', async () => {
    const f = fake()
    f.plan.set(1, [{ ok: '$1', delay: SEND_DEADLINE_MS + 1_000 }])
    const q = createSendQueue(f.ports)
    const r1 = q.enqueue({ n: 1 })
    const r2 = q.enqueue({ n: 2 })
    await vi.advanceTimersByTimeAsync(SEND_DEADLINE_MS)
    expect(await r2).toEqual({ ok: false, error: { kind: 'rate-limited', retryAfterMs: 0 } })
    expect(q.size).toBe(1)
    await vi.runAllTimersAsync()
    expect(await r1).toEqual({ ok: true, messageId: '$1' })
    expect(f.attempts.map((a) => a.n)).toEqual([1])
    expect(f.cancels).toEqual([])
  })

  it('M_LIMIT_EXCEEDED without a hint waits the default', async () => {
    const f = fake()
    f.plan.set(1, [limited(null), { ok: '$x' }])
    const q = createSendQueue(f.ports)
    const r = q.enqueue({ n: 1 })
    await vi.runAllTimersAsync()
    expect(await r).toEqual({ ok: true, messageId: '$x' })
    expect(f.attempts[1]!.at - f.attempts[0]!.at).toBeGreaterThanOrEqual(SEND_DEFAULT_RETRY_MS + SEND_RETRY_MARGIN_MS)
  })

  it('a final error fails that send at once (no retry), cancels its local event, and the next goes on', async () => {
    const f = fake()
    f.plan.set(1, [{ err: { kind: 'final', failure: { kind: 'failed', errcode: 'M_FORBIDDEN', status: 403 } } }])
    const q = createSendQueue(f.ports)
    const r1 = q.enqueue({ n: 1 })
    const r2 = q.enqueue({ n: 2 })
    await vi.runAllTimersAsync()
    expect(await r1).toEqual({ ok: false, error: { kind: 'failed', errcode: 'M_FORBIDDEN', status: 403 } })
    expect(await r2).toEqual({ ok: true, messageId: '$ok2' })
    expect(f.attempts.map((a) => a.n)).toEqual([1, 2])
    expect(f.cancels).toEqual([1])
  })

  it('M_UNKNOWN_TOKEN fails the whole queue `revoked`, triggers revoke once, and every later send', async () => {
    const f = fake()
    f.plan.set(2, [{ err: { kind: 'revoked' } }])
    const q = createSendQueue(f.ports)
    const rs = [1, 2, 3, 4].map((n) => q.enqueue({ n }))
    await vi.runAllTimersAsync()
    const results: SendResult[] = await Promise.all(rs)
    expect(results).toEqual([
      { ok: true, messageId: '$ok1' },
      { ok: false, error: { kind: 'revoked' } },
      { ok: false, error: { kind: 'revoked' } },
      { ok: false, error: { kind: 'revoked' } },
    ])
    expect(f.attempts.map((a) => a.n)).toEqual([1, 2])
    expect(f.cancels).toEqual([2])
    expect(f.revokes).toBe(1)
    expect(await q.enqueue({ n: 5 })).toEqual({ ok: false, error: { kind: 'revoked' } })
    expect(f.attempts).toHaveLength(2)
  })

  it('close(revoked) from the core (sync saw it) fails the one waiting out a limit and the line', async () => {
    const f = fake()
    f.plan.set(1, [limited(10_000), { ok: '$never' }])
    const q = createSendQueue(f.ports)
    const r1 = q.enqueue({ n: 1 })
    const r2 = q.enqueue({ n: 2 })
    await vi.advanceTimersByTimeAsync(1_000)
    q.close({ kind: 'revoked' })
    expect(await r1).toEqual({ ok: false, error: { kind: 'revoked' } })
    expect(await r2).toEqual({ ok: false, error: { kind: 'revoked' } })
    await vi.runAllTimersAsync()
    expect(f.attempts).toHaveLength(1)
    // The core triggered it: the queue does not call revoke back.
    expect(f.revokes).toBe(0)
  })

  it('close() while an attempt is in flight answers at once; the late failure still cancels the local event', async () => {
    const f = fake()
    f.plan.set(1, [{ err: { kind: 'revoked' } }])
    const q = createSendQueue(f.ports)
    const r1 = q.enqueue({ n: 1 })
    await vi.advanceTimersByTimeAsync(1)
    q.close({ kind: 'stopped' })
    expect(await r1).toEqual({ ok: false, error: { kind: 'stopped' } })
    await vi.runAllTimersAsync()
    expect(f.cancels).toEqual([1])
    expect(f.revokes).toBe(0)
  })
})

describe('classifySendError', () => {
  const matrixError = (errcode: string, httpStatus: number, retry: number | null | 'throw'): unknown => ({
    errcode,
    httpStatus,
    getRetryAfterMs(): number | null {
      if (retry === 'throw') throw new Error('retry_after_ms is not an integer')
      return retry
    },
  })

  it('maps the SDK errors and the gateway refusals', () => {
    expect(classifySendError(new NotMember())).toEqual({ kind: 'final', failure: { kind: 'not-member' } })
    expect(classifySendError(new ReplyInThread())).toEqual({ kind: 'final', failure: { kind: 'reply-in-thread' } })
    expect(classifySendError(matrixError('M_UNKNOWN_TOKEN', 401, null))).toEqual({ kind: 'revoked' })
    expect(classifySendError(matrixError('M_LIMIT_EXCEEDED', 429, 1234))).toEqual({ kind: 'rate-limited', retryAfterMs: 1234 })
    expect(classifySendError(matrixError('M_LIMIT_EXCEEDED', 429, 'throw'))).toEqual({ kind: 'rate-limited', retryAfterMs: null })
    expect(classifySendError(matrixError('M_FORBIDDEN', 403, null))).toEqual({
      kind: 'final',
      failure: { kind: 'failed', errcode: 'M_FORBIDDEN', status: 403 },
    })
    expect(classifySendError(new TypeError('fetch failed'))).toEqual({
      kind: 'final',
      failure: { kind: 'failed', errcode: null, status: null },
    })
  })
})

// §0.3.7 item 4: every write effect is a job of the ONE queue. The S-b2 semantics, per job kind,
// through the real wiring (createWriteQueue: attemptJob + classifySendError + cancel in the job's
// channel with that attempt's transaction id) over a fake gateway.
const ROOM = '!room:test.local'
const KINDS: Array<[WriteJob['kind'], WriteJob]> = [
  ['text', { kind: 'text', req: { channel: ROOM, text: 'oi' } }],
  ['edit', { kind: 'edit', channel: ROOM, target: '$t', text: 'oi2' }],
  ['redact', { kind: 'redact', channel: ROOM, target: '$t' }],
  ['react', { kind: 'react', channel: ROOM, target: '$t', key: '👍' }],
  ['unreact', { kind: 'unreact', channel: ROOM, reaction: '$r' }],
  ['attachment', { kind: 'attachment', channel: ROOM, content: { msgtype: 'm.file' } }],
]

const sdkLimit = (ms: number): Error => Object.assign(new Error('limit'), { errcode: 'M_LIMIT_EXCEEDED', httpStatus: 429, getRetryAfterMs: () => ms })
const sdkRevoked = (): Error => Object.assign(new Error('revoked'), { errcode: 'M_UNKNOWN_TOKEN', httpStatus: 401 })

function fakeGateway(plan: Error[]) {
  const calls: Array<{ method: string; txnId: string; at: number }> = []
  const cancels: Array<[string, string]> = []
  let inFlight = 0
  let maxInFlight = 0
  const attempt = async (method: string, txnId: string): Promise<string> => {
    calls.push({ method, txnId, at: Date.now() })
    inFlight += 1
    maxInFlight = Math.max(maxInFlight, inFlight)
    try {
      await new Promise<void>((r) => {
        setTimeout(r, 10)
      })
      const next = plan.shift()
      if (next !== undefined) throw next
      return `$ok-${method}`
    } finally {
      inFlight -= 1
    }
  }
  const gateway: WriteGateway = {
    sendText: (_r, t) => attempt('sendText', t),
    editText: (_c, _g, _x, t) => attempt('editText', t),
    redact: (_c, _g, t) => attempt('redact', t),
    react: (_c, _g, _k, t) => attempt('react', t),
    sendAttachment: (_c, _x, _h, t) => attempt('sendAttachment', t),
    cancelLocal: (channel, txnId) => cancels.push([channel, txnId]),
  }
  return { gateway, calls, cancels, maxInFlight: () => maxInFlight }
}

describe.each(KINDS)('write queue, job kind %s (§0.3.7 item 4)', (_kind, job) => {
  let txn = 0
  const opts = (gateway: WriteGateway, revokes: { n: number }, logs: unknown[] = []) => ({
    gateway,
    makeTxnId: () => `txn${++txn}`,
    onRevoked: () => {
      revokes.n += 1
    },
    log: (l: Record<string, unknown>) => logs.push(l),
  })

  it('429 inside the deadline: cancels that attempt in the job channel, waits retry_after + 1 s, retries with a NEW txn', async () => {
    const g = fakeGateway([sdkLimit(2_000)])
    const q = createWriteQueue(opts(g.gateway, { n: 0 }))
    const r = q.enqueue(job)
    await vi.runAllTimersAsync()
    expect((await r).ok).toBe(true)
    expect(g.calls).toHaveLength(2)
    expect(g.calls[1]!.txnId).not.toBe(g.calls[0]!.txnId)
    expect(g.calls[1]!.at - g.calls[0]!.at).toBeGreaterThanOrEqual(2_000 + SEND_RETRY_MARGIN_MS)
    expect(g.cancels).toEqual([[ROOM, g.calls[0]!.txnId]])
  })

  it('429 beyond the deadline fails at once `rate-limited` with the server value (one attempt)', async () => {
    const g = fakeGateway([sdkLimit(40_000)])
    const q = createWriteQueue(opts(g.gateway, { n: 0 }))
    const r = q.enqueue(job)
    await vi.advanceTimersByTimeAsync(50)
    expect(await r).toEqual({ ok: false, error: { kind: 'rate-limited', retryAfterMs: 40_000 } })
    expect(g.calls).toHaveLength(1)
  })

  it('the window of a 429 holds for the next job of the same kind; one in flight', async () => {
    const g = fakeGateway([sdkLimit(3_000)])
    const q = createWriteQueue(opts(g.gateway, { n: 0 }))
    const rs = [q.enqueue(job), q.enqueue(job)]
    await vi.runAllTimersAsync()
    expect((await Promise.all(rs)).every((r) => r.ok)).toBe(true)
    expect(g.calls).toHaveLength(3)
    // The second job's first attempt waited the window out too.
    expect(g.calls[2]!.at - g.calls[0]!.at).toBeGreaterThanOrEqual(3_000 + SEND_RETRY_MARGIN_MS)
    expect(g.maxInFlight()).toBe(1)
  })

  it('M_UNKNOWN_TOKEN fails it and the line `revoked`, triggers the revoke once, and every later job', async () => {
    const g = fakeGateway([sdkRevoked()])
    const revokes = { n: 0 }
    const q = createWriteQueue(opts(g.gateway, revokes))
    const rs = [q.enqueue(job), q.enqueue(job)]
    await vi.runAllTimersAsync()
    expect(await Promise.all(rs)).toEqual([
      { ok: false, error: { kind: 'revoked' } },
      { ok: false, error: { kind: 'revoked' } },
    ])
    expect(revokes.n).toBe(1)
    expect(await q.enqueue(job)).toEqual({ ok: false, error: { kind: 'revoked' } })
    expect(g.calls).toHaveLength(1)
  })

  it('another refusal fails it at once with errcode/status (logged, never a message)', async () => {
    const g = fakeGateway([Object.assign(new Error('secret text'), { errcode: 'M_FORBIDDEN', httpStatus: 403 })])
    const logs: Array<Record<string, unknown>> = []
    const q = createWriteQueue(opts(g.gateway, { n: 0 }, logs))
    const r = q.enqueue(job)
    await vi.runAllTimersAsync()
    expect(await r).toEqual({ ok: false, error: { kind: 'failed', errcode: 'M_FORBIDDEN', status: 403 } })
    expect(logs).toContainEqual({ evt: 'send-failed', kind: 'failed', errcode: 'M_FORBIDDEN', status: 403 })
    expect(JSON.stringify(logs)).not.toContain('secret text')
  })
})

describe('write queue: mixed kinds share one line', () => {
  it('FIFO across kinds, one in flight', async () => {
    const g = fakeGateway([])
    const q = createWriteQueue({ gateway: g.gateway, makeTxnId: () => 't', onRevoked: () => {}, log: () => {} })
    const rs = KINDS.map(([, job]) => q.enqueue(job))
    await vi.runAllTimersAsync()
    expect((await Promise.all(rs)).every((r) => r.ok)).toBe(true)
    expect(g.calls.map((c) => c.method)).toEqual(['sendText', 'editText', 'redact', 'react', 'redact', 'sendAttachment'])
    expect(g.maxInFlight()).toBe(1)
  })
})

// ADR-091 dec. 13 (A3-6): the panel's writes are handed back — no 30 s deadline, the server's limit returned
// at once (its scheduler keeps the version, core/panels.ts).
describe('write queue: the panel job is handed back', () => {
  const job: WriteJob = { kind: 'panel', channel: ROOM, content: { msgtype: 'io.tayet.panel' } }
  const queueOf = (g: ReturnType<typeof fakeGateway>) => createWriteQueue({ gateway: g.gateway, makeTxnId: () => `t${Math.random()}`, onRevoked: () => {}, log: () => {} })

  it('a 429 → `rate-limited` at once with the server’s wait (one attempt, cancelled), even inside the deadline', async () => {
    const g = fakeGateway([sdkLimit(2_000)])
    const r = queueOf(g).enqueue(job)
    await vi.advanceTimersByTimeAsync(50)
    expect(await r).toEqual({ ok: false, error: { kind: 'rate-limited', retryAfterMs: 2_000 } })
    expect(g.calls.map((c) => c.method)).toEqual(['sendAttachment'])
    expect(g.cancels).toHaveLength(1)
  })

  it('inside the window of an earlier 429 it is handed back without an attempt, with what is left of it', async () => {
    const g = fakeGateway([sdkLimit(40_000)])
    const q = queueOf(g)
    expect(await (async () => {
      const r = q.enqueue(KINDS[0]![1])
      await vi.advanceTimersByTimeAsync(50)
      return r
    })()).toEqual({ ok: false, error: { kind: 'rate-limited', retryAfterMs: 40_000 } })
    const panel = q.enqueue(job)
    await vi.advanceTimersByTimeAsync(0)
    const p = await panel
    expect(p.ok).toBe(false)
    expect(!p.ok && p.error.kind === 'rate-limited' && p.error.retryAfterMs > 39_000).toBe(true)
    expect(g.calls.map((c) => c.method)).toEqual(['sendText'])
  })

  it('no deadline: behind a long line it is never failed by the 30 s expiry', async () => {
    const g = fakeGateway([])
    const q = queueOf(g)
    const r = q.enqueue(job)
    await vi.runAllTimersAsync()
    expect(await r).toEqual({ ok: true, messageId: '$ok-sendAttachment' })
  })
})
