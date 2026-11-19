// `wait_for_mention` (PLANO-AGENTES §0.3.13 item 6): a long-poll on the local API's event bus (api/bus.ts),
// the same sequence the SSE and the Slack socket read. The cursor is the bus id (opaque to the agent).
//
// 1. `since(after)`: the first `mention` already published after the cursor answers at once, with its own
//    id as the next cursor; an `agent.revoked` before it ends the wait.
// 2. Otherwise subscribe (in the same tick: nothing published in between is lost) and resolve on the
//    first `mention`, on `agent.revoked`, on the timeout, on the client giving up (signal) or on the
//    layer closing. The subscription ends in every case.
// 3. A cursor of another run, or older than the ring → `resync` with the bus head.
//
// `wait_for_approval` (A3-3b): the same long-poll over the same bus, for one card. It subscribes FIRST, then
// reads the card's state (`read`): a card no longer open answers at once. Then it resolves on the card's
// `approval.answered`, on an edit or removal of the card (read again: closed → answers), on
// `agent.revoked`, on the timeout, the client giving up or the layer closing. An answer that cannot be
// read yet (no `option`) is not an answer to the agent: the wait goes on until its event.
// A card that asks for several answers (`approval.needed`, ADR-104): each event of the card reads it again
// (one event per answer); the wait ends when the state read is `answered` (all the answers read) or
// `closed`; on the timeout it carries the last state read.
import type { BusEntry, EventBus } from '../bus'
import type { ApiApprovalStatus, ApiMessage } from '../contract'

export type WaitOutcome =
  | { kind: 'mention'; conversation: string; message: ApiMessage; cursor: string }
  | { kind: 'timedOut'; cursor: string }
  | { kind: 'resync'; cursor: string }
  | { kind: 'revoked' }
  | { kind: 'closed' }

// The clock of the wait (injectable for the unit): arms a timer, returns its cancel.
export type SetTimer = (fn: () => void, ms: number) => () => void

export const realTimer: SetTimer = (fn, ms) => {
  const t = setTimeout(fn, ms)
  return () => clearTimeout(t)
}

// `timedOut.status`: the last state read, when one was.
export type ApprovalWaitOutcome = { kind: 'settled'; status: ApiApprovalStatus } | { kind: 'timedOut'; status?: ApiApprovalStatus } | { kind: 'revoked' } | { kind: 'closed' }

export interface Waits {
  wait(after: string | undefined, timeoutMs: number, signal?: AbortSignal): Promise<WaitOutcome>
  // One card (`conversation` + `id` = its ts); `read` is the facade's state. A failing read rejects.
  approval(card: { conversation: string; id: string }, read: () => Promise<ApiApprovalStatus>, timeoutMs: number, signal?: AbortSignal): Promise<ApprovalWaitOutcome>
  // Resolves every pending wait with `closed` (the server shutting down).
  close(): void
}

// Settled = no longer open, and an answer only once its option can be read (a card with `needed` is
// `answered` only with all its answers read).
const settled = (s: ApiApprovalStatus): boolean =>
  s.approval.state === 'closed' || (s.approval.state === 'answered' && (s.approval.needed !== undefined || s.approval.answer?.option !== undefined))

const outcomeOf = (entry: BusEntry): WaitOutcome | null => {
  if (entry.event.type === 'mention') return { kind: 'mention', conversation: entry.event.conversation, message: entry.event.message, cursor: entry.id }
  if (entry.event.type === 'agent.revoked') return { kind: 'revoked' }
  return null
}

export function createWaits(bus: EventBus, setTimer: SetTimer = realTimer): Waits {
  const pending = new Set<() => void>()
  let closed = false

  return {
    wait(after, timeoutMs, signal) {
      if (closed) return Promise.resolve({ kind: 'closed' })
      const replay = bus.since(after)
      if (replay.kind === 'resync') return Promise.resolve({ kind: 'resync', cursor: replay.head })
      for (const entry of replay.entries) {
        const out = outcomeOf(entry)
        if (out !== null) return Promise.resolve(out)
      }
      return new Promise<WaitOutcome>((resolve) => {
        let done = false
        const finish = (out: WaitOutcome): void => {
          if (done) return
          done = true
          unsubscribe()
          cancelTimer()
          pending.delete(onClose)
          signal?.removeEventListener('abort', onAbort)
          resolve(out)
        }
        const unsubscribe = bus.subscribe((entry) => {
          const out = outcomeOf(entry)
          if (out !== null) finish(out)
        })
        // On a timeout the cursor moves to the bus head at that moment: every event up to it was seen
        // (replayed or delivered) and none was a mention.
        const cancelTimer = setTimer(() => finish({ kind: 'timedOut', cursor: bus.head }), timeoutMs)
        const onClose = (): void => finish({ kind: 'closed' })
        const onAbort = (): void => finish({ kind: 'closed' })
        pending.add(onClose)
        if (signal?.aborted === true) return onAbort()
        signal?.addEventListener('abort', onAbort, { once: true })
      })
    },
    approval(card, read, timeoutMs, signal) {
      if (closed) return Promise.resolve({ kind: 'closed' })
      return new Promise<ApprovalWaitOutcome>((resolve, reject) => {
        let done = false
        let known: ApiApprovalStatus | undefined
        let reading: Promise<void> = Promise.resolve()
        const finish = (out: ApprovalWaitOutcome | Error): void => {
          if (done) return
          done = true
          unsubscribe()
          cancelTimer()
          pending.delete(onClose)
          signal?.removeEventListener('abort', onAbort)
          if (out instanceof Error) reject(out)
          else resolve(out)
        }
        // Reads one after the other (an edit and an answer close together never race two reads).
        const check = (): void => {
          reading = reading.then(async () => {
            if (done) return
            try {
              const s = await read()
              known = s
              if (settled(s)) finish({ kind: 'settled', status: s })
            } catch (err) {
              finish(err instanceof Error ? err : new Error(String(err)))
            }
          })
        }
        const unsubscribe = bus.subscribe((entry) => {
          const e = entry.event
          if (e.type === 'agent.revoked') return finish({ kind: 'revoked' })
          if (e.type === 'approval.answered' && e.conversation === card.conversation && e.id === card.id) {
            // The event carries the decided answer; the options come from the state already read. A card
            // with `needed` is read again: one event is one answer of several.
            if (known !== undefined && known.approval.needed === undefined) {
              return finish({ kind: 'settled', status: { ...known, approval: { options: known.approval.options, state: 'answered', answer: { option: e.option, by: e.by, at: e.at } } } })
            }
            return check()
          }
          if ((e.type === 'message.edited' && e.conversation === card.conversation && e.message.id === card.id) || (e.type === 'message.removed' && e.conversation === card.conversation && e.id === card.id)) check()
        })
        const cancelTimer = setTimer(() => finish(known !== undefined ? { kind: 'timedOut', status: known } : { kind: 'timedOut' }), timeoutMs)
        const onClose = (): void => finish({ kind: 'closed' })
        const onAbort = (): void => finish({ kind: 'closed' })
        pending.add(onClose)
        if (signal?.aborted === true) return onAbort()
        signal?.addEventListener('abort', onAbort, { once: true })
        check()
      })
    },
    close() {
      closed = true
      for (const f of [...pending]) f()
    },
  }
}
