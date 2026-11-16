// The tickets of the response_url (PLANO-AGENTES §0.3.17 item 6, A3-4; §0.3.25 item 7, A4-3): one per click of an
// approval card (`block_actions`, a `card` ticket) and one per `/` command (`slash_commands`, a `command` ticket,
// bound to the conversation, the command's message and its thread), `<listener>/slack/response/<ticket>`. Both
// kinds keep the same rules. The ticket IS the credential — Bolt's respond()
// sends no Authorization header (context/create-respond.js) — so it is 32 random bytes, lives 30 min, serves
// at most 5 calls, and only in memory: never in a log, a file or an answer other than the payload that
// carries it. The clock is injectable (tests).
import { randomBytes } from 'node:crypto'

export const RESPONSE_TTL_MS = 30 * 60_000
export const RESPONSE_USES = 5
// Hex: no id shape and no word of the deny list can come out of it (the Slack edge scans the URL).
const TICKET = /^[0-9a-f]{64}$/

// An approval card: `id` is the card's ts.
export interface CardTarget {
  kind: 'card'
  conversation: string
  id: string
}

// A `/` command: `id` is the command's message, `thread` the thread its responses go to (the one it was sent in,
// or its own message).
export interface CommandTarget {
  kind: 'command'
  conversation: string
  id: string
  thread: string
}

export type ResponseTarget = CardTarget | CommandTarget

interface Entry {
  target: ResponseTarget
  expires: number
  uses: number
}

export class ResponseTickets {
  private readonly table = new Map<string, Entry>()

  constructor(
    private readonly now: () => number,
    private readonly ttlMs = RESPONSE_TTL_MS,
    private readonly maxUses = RESPONSE_USES,
  ) {}

  issue(target: ResponseTarget): string {
    this.sweep()
    const ticket = randomBytes(32).toString('hex')
    this.table.set(ticket, { target: { ...target }, expires: this.now() + this.ttlMs, uses: 0 })
    return ticket
  }

  // One use of the ticket: its target, or null (unknown, expired, spent).
  spend(ticket: string): ResponseTarget | null {
    if (!TICKET.test(ticket)) return null
    const e = this.table.get(ticket)
    if (e === undefined) return null
    if (this.now() >= e.expires || e.uses >= this.maxUses) {
      this.table.delete(ticket)
      return null
    }
    e.uses += 1
    if (e.uses >= this.maxUses) this.table.delete(ticket)
    return { ...e.target }
  }

  // Revocation and shutdown: no ticket is valid any more.
  clear(): void {
    this.table.clear()
  }

  get size(): number {
    return this.table.size
  }

  private sweep(): void {
    const now = this.now()
    for (const [k, e] of this.table) if (now >= e.expires) this.table.delete(k)
  }
}
