// The envelope dispatcher of the emulated Socket Mode (PLANO-AGENTES §0.3.12 items 10, 11; S-f2). ONE ack
// table, keyed by `envelope_id`, whatever the envelope's type: the transport does not know what it carries.
//
// - Kinds: `events_api` (S-f2, the bus events); `interactive` (A3-4: the approval card's `block_actions`,
//   slack/interactive.ts; a response payload in its ack is ignored there); `slash_commands` (A4-3: a person's `/`
//   command, slack/commands.ts; a response payload in its ack is the reply in the command's thread). A new kind is
//   one `register` call: the dispatcher is never reopened for it.
// - The frame is Slack's: `{ envelope_id, type, payload, accepts_response_payload, retry_attempt,
//   retry_reason }`; the client acks with `{ envelope_id, payload? }` (the payload is the response of an
//   envelope that accepts one).
// - Redelivery (item 10): no ack in 3 s → the same envelope again with `retry_attempt` 1, 2, 3 and
//   `retry_reason: 'timeout'`; no ack after the third → dropped with one line. A connection that closes
//   drops what it still owes. The clock is injectable (unit tests).
// - An ack nobody waits for (unknown, already acked, malformed) is ignored with one `ack-unknown` line.
//   Lines carry the `envelope_id` (opaque, minted here) and never the client's text.
import { randomUUID } from 'node:crypto'
import type { SlackEnvelope } from './contract'

type Log = (line: Record<string, unknown>) => void

export const ACK_TIMEOUT_MS = 3_000
export const MAX_RETRIES = 3

export interface EnvelopeKind {
  // Slack's `accepts_response_payload`: whether the ack may carry a response.
  acceptsResponsePayload: boolean
}

// The kinds known on day one, each with its emitter: `events_api` (slack/events.ts), `interactive`
// (slack/interactive.ts) and `slash_commands` (slack/commands.ts).
export const ENVELOPE_KINDS: Readonly<Record<string, EnvelopeKind>> = {
  events_api: { acceptsResponsePayload: false },
  interactive: { acceptsResponsePayload: true },
  slash_commands: { acceptsResponsePayload: true },
}

// Where an envelope goes: one connection. `send` is false when the frame did not leave (closed, edge).
export interface EnvelopeTarget {
  send(frame: SlackEnvelope): boolean
}

export type AckOutcome = { acked: true; payload?: Record<string, unknown> } | { acked: false; reason: 'timeout' | 'closed' | 'unsent' }

export interface EnvelopeTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface EnvelopeTiming {
  ackTimeoutMs: number
  maxRetries: number
}

export interface EnvelopeDispatcherOptions {
  log: Log
  timers: EnvelopeTimers
  ackTimeoutMs?: number
  maxRetries?: number
}

export interface EnvelopeDispatcher {
  // A new kind (A3: `interactive` with its own response handling).
  register(type: string, kind: EnvelopeKind): void
  readonly kinds: readonly string[]
  // One envelope to one connection; the outcome settles on its ack, its drop or its connection's close. `timing`
  // overrides the ack timeout and the redeliveries of this envelope (a form's submission: one attempt, 10 s).
  dispatch(target: EnvelopeTarget, type: string, payload: Record<string, unknown>, timing?: EnvelopeTiming): { id: string; outcome: Promise<AckOutcome> }
  // A frame from a client (already parsed, or the raw text): resolves the matching entry.
  ack(frame: unknown): void
  // The connection closed: what it still owes is dropped.
  drop(target: EnvelopeTarget): void
  readonly pending: number
}

interface Entry {
  id: string
  target: EnvelopeTarget
  type: string
  payload: Record<string, unknown>
  kind: EnvelopeKind
  attempt: number
  timer: unknown
  timing: EnvelopeTiming
  settle: (o: AckOutcome) => void
}

const ENVELOPE_ID = /^[0-9a-f-]{36}$/

export function createEnvelopeDispatcher(opts: EnvelopeDispatcherOptions): EnvelopeDispatcher {
  const { log, timers } = opts
  const ackTimeoutMs = opts.ackTimeoutMs ?? ACK_TIMEOUT_MS
  const maxRetries = opts.maxRetries ?? MAX_RETRIES
  const kinds = new Map<string, EnvelopeKind>(Object.entries(ENVELOPE_KINDS))
  const table = new Map<string, Entry>()

  const finish = (e: Entry, outcome: AckOutcome): void => {
    if (!table.delete(e.id)) return
    timers.clearTimeout(e.timer)
    e.settle(outcome)
  }

  const send = (e: Entry): void => {
    const frame: SlackEnvelope = {
      envelope_id: e.id,
      type: e.type,
      payload: e.payload,
      accepts_response_payload: e.kind.acceptsResponsePayload,
      retry_attempt: e.attempt,
      retry_reason: e.attempt === 0 ? '' : 'timeout',
    }
    if (!e.target.send(frame)) {
      log({ evt: 'envelope-dropped', envelope_id: e.id, type: e.type, reason: 'unsent' })
      return finish(e, { acked: false, reason: 'unsent' })
    }
    e.timer = timers.setTimeout(() => {
      if (!table.has(e.id)) return
      if (e.attempt >= e.timing.maxRetries) {
        log({ evt: 'envelope-dropped', envelope_id: e.id, type: e.type, reason: 'timeout' })
        return finish(e, { acked: false, reason: 'timeout' })
      }
      e.attempt += 1
      log({ evt: 'envelope-redelivered', envelope_id: e.id, type: e.type, attempt: e.attempt })
      send(e)
    }, e.timing.ackTimeoutMs)
  }

  const parse = (frame: unknown): Record<string, unknown> | null => {
    let v = frame
    if (typeof v === 'string') {
      try {
        v = JSON.parse(v) as unknown
      } catch {
        return null
      }
    }
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  }

  return {
    register(type, kind) {
      kinds.set(type, kind)
    },
    get kinds() {
      return [...kinds.keys()]
    },
    get pending() {
      return table.size
    },

    dispatch(target, type, payload, timing = { ackTimeoutMs, maxRetries }) {
      const kind = kinds.get(type)
      if (kind === undefined) throw new Error(`unknown envelope kind: ${type}`)
      const id = randomUUID()
      let settle: (o: AckOutcome) => void = () => {}
      const outcome = new Promise<AckOutcome>((r) => (settle = r))
      const e: Entry = { id, target, type, payload, kind, attempt: 0, timer: undefined, timing, settle }
      table.set(id, e)
      send(e)
      return { id, outcome }
    },

    ack(frame) {
      const msg = parse(frame)
      const id = msg?.envelope_id
      const e = typeof id === 'string' && ENVELOPE_ID.test(id) ? table.get(id) : undefined
      if (msg === null || e === undefined) {
        log({ evt: 'ack-unknown' })
        return
      }
      const payload = msg.payload
      const response = e.kind.acceptsResponsePayload && payload !== null && typeof payload === 'object' && !Array.isArray(payload) && Object.keys(payload).length > 0
      finish(e, response ? { acked: true, payload: payload as Record<string, unknown> } : { acked: true })
    },

    drop(target) {
      for (const e of [...table.values()]) if (e.target === target) finish(e, { acked: false, reason: 'closed' })
    },
  }
}
