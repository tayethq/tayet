// apps.connections.open (ADR-087 dec. 5; PLANO-AGENTES §0.3.12, S-f2; §0.3.3 item 6): the emulated Socket
// Mode's entry. A Slack SDK calls it with its app token in the header — the local token here, the same as
// the bot token — and gets a `ws://` URL on this listener with a ticket:
//   { ok: true, url: 'ws://<listener>/slack/socket?ticket=<ticket>' }
// - The ticket is 32 random bytes in base64url, single use (spent by the upgrade whatever the outcome),
//   valid 60 s, and checked against its shape before any lookup. One ticket = one connection; the SDK asks
//   a new one on every reconnect.
// - No listener URL yet (not announced) → `internal_error`. After a revocation the router answers
//   `token_revoked` before any method runs.
// The tickets live in memory only: none survives a restart, and none is ever logged.
import { randomBytes } from 'node:crypto'
import type { SlackConnectionsOpen } from './contract'
import { SlackError } from './errors'
import type { SlackMethods } from './router'

export const TICKET_TTL_MS = 60_000
export const SOCKET_TICKET = /^[A-Za-z0-9_-]{43}$/
export const SOCKET_PATH = '/slack/socket'

export class SocketTickets {
  private readonly tickets = new Map<string, number>()

  constructor(private readonly now: () => number = Date.now) {}

  issue(): string {
    this.sweep()
    const ticket = randomBytes(32).toString('base64url')
    this.tickets.set(ticket, this.now() + TICKET_TTL_MS)
    return ticket
  }

  // True once for a live ticket; the ticket is spent either way.
  spend(ticket: string | null): boolean {
    if (ticket === null || !SOCKET_TICKET.test(ticket)) return false
    const expires = this.tickets.get(ticket)
    if (expires === undefined) return false
    this.tickets.delete(ticket)
    return expires > this.now()
  }

  clear(): void {
    this.tickets.clear()
  }

  private sweep(): void {
    const now = this.now()
    for (const [ticket, expires] of this.tickets) if (expires <= now) this.tickets.delete(ticket)
  }
}

export const CONNECTION_METHODS: SlackMethods = {
  'apps.connections.open': (_args, ctx) => {
    const base = ctx.baseUrl()
    if (base === null) return Promise.reject(new SlackError('internal_error'))
    const out: Omit<SlackConnectionsOpen, 'ok'> = { url: `${base.replace(/^http:/, 'ws:')}${SOCKET_PATH}?ticket=${ctx.tickets.issue()}` }
    return Promise.resolve(out)
  },
}
