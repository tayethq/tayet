import { describe, it, expect, afterEach } from 'vitest'
import { get } from 'node:http'
import { TICKET_TTL_MS } from '../../src/api/slack/connections'
import { connect, isOpen, socketUrl } from '../support/slack-socket'
import { startSlack, type SlackHarness } from '../support/slack-world'

// The upgrade of `/slack/socket` (PLANO-AGENTES §0.3.12 item 5, S-f2): Host → Origin → revoked → ticket,
// each refusal a status line and a destroyed socket.

let h: SlackHarness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

const status = (r: Awaited<ReturnType<typeof connect>>): number => (isOpen(r) ? 101 : r.status)

describe('/slack/socket — the ticket', () => {
  it('a fresh ticket opens; the same ticket again → 401', async () => {
    h = await startSlack()
    const url = await socketUrl(h)
    const first = await connect(url)
    expect(status(first)).toBe(101)
    expect(status(await connect(url))).toBe(401)
    expect(h.logs).toContainEqual({ evt: 'socket-open', connections: 1 })
    if (isOpen(first)) first.ws.close()
  })

  it('absent, malformed or unknown ticket → 401', async () => {
    h = await startSlack()
    const base = (await socketUrl(h)).split('?')[0] as string
    expect(status(await connect(base))).toBe(401)
    expect(status(await connect(`${base}?ticket=../../x`))).toBe(401)
    expect(status(await connect(`${base}?ticket=${'A'.repeat(43)}`))).toBe(401)
  })

  it('an expired ticket → 401', async () => {
    let now = 1_000_000
    h = await startSlack({ now: () => now })
    const url = await socketUrl(h)
    now += TICKET_TTL_MS
    expect(status(await connect(url))).toBe(401)
  })

  it('another path → 404; after the revocation → 503', async () => {
    h = await startSlack()
    const url = await socketUrl(h)
    expect(status(await connect(url.replace('/slack/socket', '/slack/other')))).toBe(404)
    await h.api.revoke(10, 0)
    expect(status(await connect(url))).toBe(503)
  })
})

describe('/slack/socket — Host and Origin', () => {
  it('a Host with no port is accepted when it is the loopback hostname of the listener', async () => {
    h = await startSlack()
    const r = await connect(await socketUrl(h), { headers: { host: '127.0.0.1' } })
    expect(status(r)).toBe(101)
    if (isOpen(r)) r.ws.close()
  })

  it('another hostname, with or without a port → 421; a portless Host on another route → 421', async () => {
    h = await startSlack()
    const port = new URL(h.url).port
    expect(status(await connect(await socketUrl(h), { headers: { host: 'localhost' } }))).toBe(421)
    expect(status(await connect(await socketUrl(h), { headers: { host: `evil.example:${port}` } }))).toBe(421)
    expect(status(await connect(await socketUrl(h), { headers: { host: '127.0.0.1:1' } }))).toBe(421)
    const other = (await socketUrl(h)).replace('/slack/socket', '/v1/events')
    expect(status(await connect(other, { headers: { host: '127.0.0.1' } }))).toBe(421)
    // The HTTP routes keep the exact Host.
    const code = await new Promise<number>((resolve, reject) => {
      get(`${(h as SlackHarness).url}/v1/healthz`, { headers: { host: '127.0.0.1' } }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      }).on('error', reject)
    })
    expect(code).toBe(421)
  })

  it('an Origin → 403', async () => {
    h = await startSlack()
    expect(status(await connect(await socketUrl(h), { origin: 'http://127.0.0.1' }))).toBe(403)
  })

  it('the Host check comes before the ticket (the ticket is not spent)', async () => {
    h = await startSlack()
    const url = await socketUrl(h)
    expect(status(await connect(url, { headers: { host: 'evil.example' } }))).toBe(421)
    const r = await connect(url)
    expect(status(r)).toBe(101)
    if (isOpen(r)) r.ws.close()
  })
})
