// The `trigger_id`s of the Slack layer: one per payload of a click (`block_actions`) or of a `/` command
// (`slash_commands`), minted when the payload is built. Each one remembers where it came from (the origin: the
// conversation, the card answered and the person; or the conversation and the command's message) and opens at most
// one form.
//
// - It is valid for 30 s from the moment it is minted (the redeliveries carry the same payload, so the same id).
// - It is born expired when the answer to the card, or the command's message, is more than 60 s old at that moment.
// - One use per origin: a redelivery over HTTP mints another id for the same click; an open that succeeds with any
//   of them spends them all. An open that fails spends nothing; an open in flight holds the origin.
// - Memory only, with an injectable clock; never in a log, a file or an answer other than the payload.
import { randomBytes } from 'node:crypto'
import { SlackError } from './errors'

export const TRIGGER_TTL_MS = 30_000
export const TRIGGER_SOURCE_MAX_AGE_MS = 60_000
export const TRIGGERS_MAX = 1_000
const TRIGGER = /^[0-9a-f]{32}$/

export type TriggerOrigin = { kind: 'card'; conversation: string; card: string; person: string } | { kind: 'command'; conversation: string; message: string; person: string }

interface Entry {
  origin: TriggerOrigin
  key: string
  expires: number
}

const keyOf = (o: TriggerOrigin): string => (o.kind === 'card' ? `card ${o.conversation} ${o.card} ${o.person}` : `command ${o.conversation} ${o.message}`)

export class TriggerTable {
  private readonly table = new Map<string, Entry>()
  // Origins already used (until their last id would have expired) and origins with an open in flight.
  private readonly used = new Map<string, number>()
  private readonly busy = new Set<string>()

  constructor(
    private readonly now: () => number,
    private readonly ttlMs = TRIGGER_TTL_MS,
    private readonly sourceMaxAgeMs = TRIGGER_SOURCE_MAX_AGE_MS,
    private readonly max = TRIGGERS_MAX,
  ) {}

  // A new id for `origin`; `sourceAt` is the instant of the answer or of the command's message.
  issue(origin: TriggerOrigin, sourceAt: number): string {
    this.sweep()
    const now = this.now()
    const id = randomBytes(16).toString('hex')
    this.table.set(id, { origin: { ...origin }, key: keyOf(origin), expires: now - sourceAt > this.sourceMaxAgeMs ? now : now + this.ttlMs })
    while (this.table.size > this.max) this.table.delete(this.table.keys().next().value as string)
    return id
  }

  // Starts an open: the origin, held until `settle`. Slack's codes otherwise (nothing is spent).
  begin(id: string): { origin: TriggerOrigin; settle(opened: boolean): void } {
    if (!TRIGGER.test(id)) throw new SlackError('invalid_trigger_id')
    const e = this.table.get(id)
    if (e !== undefined && (this.used.has(e.key) || this.busy.has(e.key))) throw new SlackError('exchanged_trigger_id')
    if (e === undefined || this.now() >= e.expires) throw new SlackError('expired_trigger_id')
    this.busy.add(e.key)
    let done = false
    return {
      origin: { ...e.origin },
      settle: (opened) => {
        if (done) return
        done = true
        this.busy.delete(e.key)
        if (opened) this.used.set(e.key, this.now() + this.ttlMs)
      },
    }
  }

  // Revocation and shutdown: nothing opens any more.
  clear(): void {
    this.table.clear()
    this.used.clear()
    this.busy.clear()
  }

  get size(): number {
    return this.table.size
  }

  private sweep(): void {
    const now = this.now()
    for (const [k, e] of this.table) if (now >= e.expires + this.ttlMs) this.table.delete(k)
    for (const [k, until] of this.used) if (now >= until + this.ttlMs) this.used.delete(k)
  }
}
