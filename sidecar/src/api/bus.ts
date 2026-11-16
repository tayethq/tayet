// The event bus of the local API (PLANO-AGENTES §0.3.6 adj. 11): ONE sequence for every transport —
// the SSE of `GET /v1/events`, the Slack layer's emulated Socket Mode (S-f2), the MCP's long-polls.
//
// - Ids are `<epoch>-<seq>`: the epoch is this run (a restart starts another), the sequence grows by 1
//   per event. A reconnect sends the last id it saw (`Last-Event-ID`).
// - Ring in memory: the last 1000 events, none older than 10 min. An id of another epoch, or older than
//   the ring, gets `resync` (re-read through the listings with `oldest=`); nothing is persisted — the
//   history is already re-readable through the API.
// - Events enter already projected and already scanned at the edge (api/edge.ts).
// - Redelivery of the unheard (A3-3b; ADR-091 dec. 7): an `approval.answered` published while NO consumer
//   is open (the boot's recovery decides answers before any stream connects) is kept in memory — at most
//   200, the oldest leaving first with one line without id. The first consumer that opens WITHOUT a valid
//   cursor of this run (no id, or one that gets `resync`) receives them right after the `resync` (or first,
//   when there is none) and the list empties. A consumer with a cursor of this run gets the ring's replay;
//   whatever the replay carries leaves the list. A consumer is what `open` returns: the SSE stream, and the
//   Slack layer while at least one of its sockets is open (A3-4: it opens with no cursor on 0 → 1 sockets
//   and closes on → 0, api/slack/router.ts); a plain `subscribe` (wait_for_mention) does not count — it is
//   not someone listening for the answer. At least once, as before.
import { randomBytes } from 'node:crypto'
import type { ApiEvent } from './contract'

export const RING_MAX = 1_000
export const RING_MAX_AGE_MS = 10 * 60_000
export const UNHEARD_MAX = 200

// The event types kept for the next consumer when nobody is listening.
const KEPT_UNHEARD: ReadonlySet<ApiEvent['type']> = new Set(['approval.answered'])

export interface BusEntry {
  id: string
  seq: number
  at: number
  event: ApiEvent
}

export type Replay = { kind: 'events'; entries: BusEntry[] } | { kind: 'resync'; head: string }

// What a consumer gets when it opens: the replay of its cursor, then the unheard events (empty unless the
// consumer had no valid cursor of this run), then every publish until `close`.
export interface Opened {
  replay: Replay
  unheard: BusEntry[]
  close: () => void
}

export class EventBus {
  readonly epoch: string
  private seq = 0
  private readonly ring: BusEntry[] = []
  private readonly listeners = new Set<(entry: BusEntry) => void>()
  private readonly unheard: BusEntry[] = []
  private consumers = 0
  private readonly now: () => number
  private readonly max: number
  private readonly maxAgeMs: number
  private readonly unheardMax: number
  private readonly log: (line: Record<string, unknown>) => void

  constructor(opts: { now?: () => number; epoch?: string; max?: number; maxAgeMs?: number; unheardMax?: number; log?: (line: Record<string, unknown>) => void } = {}) {
    this.now = opts.now ?? Date.now
    this.epoch = opts.epoch ?? `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`
    this.max = opts.max ?? RING_MAX
    this.maxAgeMs = opts.maxAgeMs ?? RING_MAX_AGE_MS
    this.unheardMax = opts.unheardMax ?? UNHEARD_MAX
    this.log = opts.log ?? (() => {})
  }

  // The id of the last event published (the one a fresh subscriber is "at").
  get head(): string {
    return `${this.epoch}-${this.seq}`
  }

  publish(event: ApiEvent): BusEntry {
    this.seq += 1
    const entry: BusEntry = { id: `${this.epoch}-${this.seq}`, seq: this.seq, at: this.now(), event }
    this.ring.push(entry)
    this.trim()
    if (this.consumers === 0 && KEPT_UNHEARD.has(event.type)) {
      this.unheard.push(entry)
      if (this.unheard.length > this.unheardMax) {
        this.unheard.shift()
        this.log({ evt: 'unheard-dropped', type: event.type })
      }
    }
    for (const l of this.listeners) l(entry)
    return entry
  }

  // A consumer (someone listening: the SSE stream, the Slack layer with a socket open). The replay, the
  // unheard and the subscription are taken in one synchronous step: nothing is published in between.
  open(lastId: string | undefined, listener: (entry: BusEntry) => void): Opened {
    const replay = this.since(lastId)
    const fresh = lastId === undefined || lastId === '' || replay.kind === 'resync'
    let unheard: BusEntry[] = []
    if (fresh) unheard = this.unheard.splice(0)
    else if (replay.entries.length > 0) {
      const replayed = new Set(replay.entries.map((e) => e.seq))
      for (let i = this.unheard.length - 1; i >= 0; i--) if (replayed.has((this.unheard[i] as BusEntry).seq)) this.unheard.splice(i, 1)
    }
    this.consumers += 1
    const off = this.subscribe(listener)
    let closed = false
    return {
      replay,
      unheard,
      close: () => {
        if (closed) return
        closed = true
        this.consumers -= 1
        off()
      },
    }
  }

  // What a subscriber that last saw `lastId` missed. No id → nothing to replay (a fresh stream).
  since(lastId: string | undefined): Replay {
    if (lastId === undefined || lastId === '') return { kind: 'events', entries: [] }
    this.trim()
    const m = /^(.+)-(\d+)$/.exec(lastId)
    if (m === null || m[1] !== this.epoch) return { kind: 'resync', head: this.head }
    const last = Number(m[2])
    if (last > this.seq) return { kind: 'resync', head: this.head }
    if (last === this.seq) return { kind: 'events', entries: [] }
    const oldest = this.ring[0]
    // The next event the subscriber needs (last + 1) is no longer in the ring.
    if (oldest === undefined || oldest.seq > last + 1) return { kind: 'resync', head: this.head }
    return { kind: 'events', entries: this.ring.filter((e) => e.seq > last) }
  }

  subscribe(listener: (entry: BusEntry) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private trim(): void {
    const cutoff = this.now() - this.maxAgeMs
    while (this.ring.length > this.max || (this.ring[0] !== undefined && this.ring[0].at < cutoff)) this.ring.shift()
  }
}
