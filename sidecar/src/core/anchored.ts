// The agent's anchored messages in the sidecar: the pinned panel (core/panels.ts; ADR-091 dec. 13) and the
// commands manifest (core/commands.ts; ADR-093, Proposto). Both are one message of the agent per conversation,
// related to the conversation's creation event (the anchor) by a relation type of their own and updated by
// edits (PLANO-AGENTES §0.3.16 items 15–17, §0.3.19, §0.3.21 item 5, §0.3.22 items 5–6).
//
// - The reader: the agent's own message found through the anchor's relations of ONE relation type (the
//   parameter), read FORWARD and paged — the agent's own only; with more than one, the latest write wins —
//   and its content is the agent's own latest edit (or the original), decrypted. Only the found id is kept, in
//   memory, per conversation.
// - The scheduler: ONE budget for every anchored kind (§0.3.16 item 17, §0.3.22 item 6) — at most one write
//   every 10 s per agent, all kinds and conversations together. Each kind is a lane: the conversations with a
//   pending version, in rotation; the newest version of a conversation replaces the pending one. With more
//   than one lane pending, the turn alternates one by one in the lanes' order (the panel first); a scheduler
//   that drained starts again from the first lane. Messages first: a turn is taken only when the write queue is
//   empty, otherwise it looks again in 1 s and keeps its turn. The server's limit keeps the version pending
//   (at the front of its lane) and the next attempt waits the server's `retryAfterMs`. An agent no longer a
//   member drops the version (`<kind>-dropped`, no id). Another failure is tried again at later turns and
//   dropped after the last attempt. A revocation or a stop of the core stops every lane: what is pending is
//   lost.
// - The interval, the clock and the timer are options (the unit tests); no flag, no environment variable.
// - Nothing of the protocol and nothing of the content reaches a log line.
import type { MatrixClient, MatrixEvent, Room } from 'matrix-js-sdk'
import { EventType, RelationType } from 'matrix-js-sdk'
import { relationPage } from './approvals'

type Log = (line: Record<string, unknown>) => void

// §0.3.16 item 17: one anchored write every 10 s per agent.
export const ANCHORED_INTERVAL_MS = 10_000
// The write queue is busy (a message first): the scheduler looks again after this, keeping its turn.
export const ANCHORED_BUSY_RETRY_MS = 1_000
// A write that fails for another reason is tried again at its next turns; after this many, it is dropped.
export const ANCHORED_FAILED_ATTEMPTS = 3

export type AnchoredClient = Pick<MatrixClient, 'getRoom' | 'getUserId' | 'fetchRelations' | 'getEventMapper' | 'decryptEventIfNeeded' | 'fetchRoomEvent'>

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const decrypted = (ev: MatrixEvent): boolean => !ev.isDecryptionFailure() && !(ev.isEncrypted() && ev.getClearContent() === null)
export const anchorOf = (room: Room): string | undefined => room.currentState.getStateEvents(EventType.RoomCreate, '')?.getId() ?? undefined

// ── Reading the agent's own anchored message ─────────────────────────────────────────────────────────
export interface OwnAnchored {
  eventId: string
  // The server instant of the latest write (the agent's latest edit, else the original).
  writtenAt: number
  // The content the message shows and its server instant; absent when it does not decrypt.
  shown?: { content: Record<string, unknown>; at: number }
}

export interface AnchoredReader {
  // The agent's message of this relation type in the conversation, or null when there is none.
  find(roomId: string): Promise<OwnAnchored | null>
  // The id of a message this run just sent.
  remember(roomId: string, eventId: string): void
}

export function createAnchoredReader(client: AnchoredClient, me: () => string, relType: string): AnchoredReader {
  // Conversation → the message's id. Memory only: never a file of the store.
  const ids = new Map<string, string>()

  // The agent's own latest edit of the message, read forward to the end (by server instant).
  const latestEdit = async (roomId: string, messageId: string): Promise<MatrixEvent | undefined> => {
    let from: string | undefined
    let latest: MatrixEvent | undefined
    for (;;) {
      const page = await relationPage(client, roomId, messageId, RelationType.Replace, from)
      for (const e of page.events) {
        if (e.getSender() !== me() || e.isRedacted()) continue
        if (latest === undefined || e.getTs() >= latest.getTs()) latest = e
      }
      if (page.next === undefined) return latest
      from = page.next
    }
  }

  const factOf = async (roomId: string, original: MatrixEvent, eventId: string): Promise<OwnAnchored> => {
    const edit = await latestEdit(roomId, eventId)
    if (edit !== undefined) {
      const next: unknown = decrypted(edit) ? edit.getContent()['m.new_content'] : undefined
      return { eventId, writtenAt: edit.getTs(), ...(isRecord(next) && { shown: { content: next, at: edit.getTs() } }) }
    }
    return {
      eventId,
      writtenAt: original.getTs(),
      ...(decrypted(original) && { shown: { content: original.getOriginalContent(), at: original.getTs() } }),
    }
  }

  const load = async (roomId: string, eventId: string): Promise<MatrixEvent | null> => {
    try {
      const ev = client.getEventMapper()(await client.fetchRoomEvent(roomId, eventId))
      await client.decryptEventIfNeeded(ev).catch(() => undefined)
      return ev
    } catch {
      return null
    }
  }

  return {
    async find(roomId) {
      const cached = ids.get(roomId)
      if (cached !== undefined) {
        const original = await load(roomId, cached)
        if (original !== null && !original.isRedacted()) return factOf(roomId, original, cached)
        ids.delete(roomId)
      }
      const room = client.getRoom(roomId)
      const anchor = room !== null ? anchorOf(room) : undefined
      if (anchor === undefined) return null
      let best: OwnAnchored | null = null
      let from: string | undefined
      for (;;) {
        const page = await relationPage(client, roomId, anchor, relType, from)
        for (const ev of page.events) {
          const eventId = ev.getId()
          if (eventId === undefined || ev.getSender() !== me() || ev.isRedacted()) continue
          const fact = await factOf(roomId, ev, eventId)
          if (best === null || fact.writtenAt >= best.writtenAt) best = fact
        }
        if (page.next === undefined) break
        from = page.next
      }
      if (best !== null) ids.set(roomId, best.eventId)
      return best
    },
    remember(roomId, eventId) {
      ids.set(roomId, eventId)
    },
  }
}

// ── The scheduler ────────────────────────────────────────────────────────────────────────────────────
export type AnchoredOutcome = { kind: 'ok' } | { kind: 'rate-limited'; retryAfterMs: number } | { kind: 'not-member' } | { kind: 'stop' } | { kind: 'failed' }

export type SetTimer = (fn: () => void, ms: number) => () => void
export const realTimer: SetTimer = (fn, ms) => {
  const t = setTimeout(fn, ms)
  return () => clearTimeout(t)
}

export interface AnchoredSchedulerPorts {
  // The write queue is empty (messages first).
  queueIdle(): boolean
  log: Log
  intervalMs?: number
  now?: () => number
  setTimer?: SetTimer
}

// One kind's conversations under the shared budget.
export interface AnchoredLane<V> {
  // The newest version of the conversation (replaces a pending one, keeping its place in the rotation).
  schedule: (roomId: string, version: V) => void
  // A version is pending or being written.
  pending: (roomId: string) => boolean
  // The conversations with a version pending or being written.
  count: () => number
  // Forgets the conversation's pending version (one being written is not called back).
  drop: (roomId: string) => void
}

export interface AnchoredScheduler {
  // The lane of a kind, once, with its writer. The kinds alternate in the order the scheduler was given.
  lane: <V>(kind: string, write: (roomId: string, version: V) => Promise<AnchoredOutcome>) => AnchoredLane<V>
  // Stops for good; what is pending in every lane is lost.
  stop: () => void
}

interface Lane {
  kind: string
  write: (roomId: string, version: unknown) => Promise<AnchoredOutcome>
  pending: Map<string, unknown>
  failures: Map<string, number>
}

export function createAnchoredScheduler(kinds: readonly string[], ports: AnchoredSchedulerPorts): AnchoredScheduler {
  const interval = ports.intervalMs ?? ANCHORED_INTERVAL_MS
  const now = ports.now ?? Date.now
  const setTimer = ports.setTimer ?? realTimer
  const lanes = new Map<string, Lane>()
  let inFlight: { lane: Lane; roomId: string } | null = null
  // The kind of the last turn taken while more than one lane was pending (the alternation); reset when a
  // single lane is pending or nothing is.
  let alternating: string | undefined
  let lastAttempt = -Infinity
  let blockedUntil = -Infinity
  let cancel: (() => void) | undefined
  let stopped = false

  const ordered = (): Lane[] => kinds.flatMap((k) => lanes.get(k) ?? [])
  const total = (): number => ordered().reduce((n, l) => n + l.pending.size, 0)

  const arm = (ms: number): void => {
    cancel = setTimer(
      () => {
        cancel = undefined
        void turn()
      },
      Math.max(ms, 0),
    )
  }

  const kick = (): void => {
    if (stopped || inFlight !== null || cancel !== undefined) return
    if (total() === 0) {
      alternating = undefined
      return
    }
    arm(Math.max(lastAttempt + interval, blockedUntil) - now())
  }

  const stop = (): void => {
    stopped = true
    cancel?.()
    cancel = undefined
    for (const l of lanes.values()) {
      l.pending.clear()
      l.failures.clear()
    }
  }

  // A version handed back: still pending, unless a newer one arrived meanwhile (it wins). `front` keeps the
  // conversation's turn (the server's limit); otherwise it goes to the end of its lane.
  const keep = (lane: Lane, roomId: string, version: unknown, front: boolean): void => {
    if (lane.pending.has(roomId)) return
    if (!front) {
      lane.pending.set(roomId, version)
      return
    }
    const rest = [...lane.pending]
    lane.pending.clear()
    lane.pending.set(roomId, version)
    for (const [k, v] of rest) lane.pending.set(k, v)
  }

  // The lane whose turn it is: alone, the one pending; otherwise the next after the last alternation's.
  const pick = (): Lane | undefined => {
    const ready = ordered().filter((l) => l.pending.size > 0)
    if (ready.length <= 1) {
      alternating = undefined
      return ready[0]
    }
    const all = ordered()
    const from = alternating === undefined ? -1 : all.findIndex((l) => l.kind === alternating)
    for (let i = 1; i <= all.length; i++) {
      const l = all[(from + i) % all.length] as Lane
      if (l.pending.size > 0) {
        alternating = l.kind
        return l
      }
    }
    return undefined
  }

  const turn = async (): Promise<void> => {
    if (stopped || total() === 0) return
    if (!ports.queueIdle()) {
      arm(ANCHORED_BUSY_RETRY_MS)
      return
    }
    if (now() < Math.max(lastAttempt + interval, blockedUntil)) return kick()
    const lane = pick()
    if (lane === undefined) return
    const [roomId, version] = lane.pending.entries().next().value as [string, unknown]
    lane.pending.delete(roomId)
    inFlight = { lane, roomId }
    lastAttempt = now()
    let out: AnchoredOutcome
    try {
      out = await lane.write(roomId, version)
    } catch {
      out = { kind: 'failed' }
    }
    inFlight = null
    if (stopped) return
    switch (out.kind) {
      case 'ok':
        lane.failures.delete(roomId)
        break
      case 'rate-limited':
        blockedUntil = now() + out.retryAfterMs
        ports.log({ evt: `${lane.kind}-ratelimited`, retryAfterMs: out.retryAfterMs })
        keep(lane, roomId, version, true)
        break
      case 'not-member':
        lane.failures.delete(roomId)
        ports.log({ evt: `${lane.kind}-dropped`, reason: 'not-member' })
        break
      case 'stop':
        stop()
        return
      case 'failed': {
        const n = (lane.failures.get(roomId) ?? 0) + 1
        if (n >= ANCHORED_FAILED_ATTEMPTS) {
          lane.failures.delete(roomId)
          ports.log({ evt: `${lane.kind}-dropped`, reason: 'failed' })
        } else {
          lane.failures.set(roomId, n)
          keep(lane, roomId, version, false)
        }
        break
      }
    }
    kick()
  }

  return {
    lane<V>(kind: string, write: (roomId: string, version: V) => Promise<AnchoredOutcome>): AnchoredLane<V> {
      if (!kinds.includes(kind) || lanes.has(kind)) throw new Error(`anchored lane: ${kind}`)
      const lane: Lane = { kind, write: write as Lane['write'], pending: new Map(), failures: new Map() }
      lanes.set(kind, lane)
      const flying = (roomId: string): boolean => inFlight !== null && inFlight.lane === lane && inFlight.roomId === roomId
      return {
        schedule: (roomId, version) => {
          if (stopped) return
          lane.pending.set(roomId, version)
          kick()
        },
        pending: (roomId) => lane.pending.has(roomId) || flying(roomId),
        count: () => lane.pending.size + (inFlight !== null && inFlight.lane === lane && !lane.pending.has(inFlight.roomId) ? 1 : 0),
        drop: (roomId) => {
          lane.pending.delete(roomId)
          lane.failures.delete(roomId)
        },
      }
    },
    stop,
  }
}
