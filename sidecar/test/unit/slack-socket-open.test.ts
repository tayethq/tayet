import { describe, it, expect, afterEach } from 'vitest'
import { CONNECTION_METHODS, SOCKET_TICKET, SocketTickets, TICKET_TTL_MS } from '../../src/api/slack/connections'
import type { SlackCtx } from '../../src/api/slack/router'
import { call, refusal, startSlack, type SlackHarness } from '../support/slack-world'

// apps.connections.open (PLANO-AGENTES §0.3.12, S-f2): the local token as the app token, a `ws://` URL on
// this listener with a single-use ticket of 32 random bytes (base64url), valid 60 s.

let h: SlackHarness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

describe('apps.connections.open', () => {
  it('the real WebClient gets a ws:// URL on this listener with a ticket', async () => {
    h = await startSlack()
    const res = await call(h.client(), 'apps.connections.open')
    expect(res.ok).toBe(true)
    const url = new URL(res.url as string)
    expect(url.protocol).toBe('ws:')
    expect(url.host).toBe(new URL(h.url).host)
    expect(url.pathname).toBe('/slack/socket')
    expect(url.searchParams.get('ticket')).toMatch(SOCKET_TICKET)
    // A new ticket on every call.
    const again = await call(h.client(), 'apps.connections.open')
    expect(new URL(again.url as string).searchParams.get('ticket')).not.toBe(url.searchParams.get('ticket'))
  })

  it('the Bearer is the local token: another one → invalid_auth', async () => {
    h = await startSlack()
    expect(await refusal(h.client({}, 'xapp-other'), 'apps.connections.open')).toBe('invalid_auth')
  })

  it('no listener URL yet → internal_error', async () => {
    const ctx = { baseUrl: () => null, tickets: new SocketTickets() } as unknown as SlackCtx
    await expect((CONNECTION_METHODS['apps.connections.open'] as NonNullable<(typeof CONNECTION_METHODS)[string]>)({}, ctx)).rejects.toMatchObject({ code: 'internal_error' })
  })

  it('after the revocation → token_revoked', async () => {
    h = await startSlack()
    await h.api.revoke(10, 0)
    expect(await refusal(h.client(), 'apps.connections.open')).toBe('token_revoked')
  })
})

describe('SocketTickets', () => {
  it('a ticket opens once; a reused, unknown, malformed or absent one never', () => {
    const t = new SocketTickets()
    const ticket = t.issue()
    expect(ticket).toMatch(SOCKET_TICKET)
    expect(t.spend(ticket)).toBe(true)
    expect(t.spend(ticket)).toBe(false)
    expect(t.spend('A'.repeat(43))).toBe(false)
    expect(t.spend('../etc')).toBe(false)
    expect(t.spend(null)).toBe(false)
  })

  it('a ticket expires after 60 s (and is spent by the failed try)', () => {
    let now = 1_000
    const t = new SocketTickets(() => now)
    const late = t.issue()
    const live = t.issue()
    now += TICKET_TTL_MS - 1
    expect(t.spend(live)).toBe(true)
    now += 1
    expect(t.spend(late)).toBe(false)
  })
})
