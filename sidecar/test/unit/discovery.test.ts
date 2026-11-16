import { describe, it, expect, afterEach } from 'vitest'
import { discover, DiscoveryError } from '../../src/discovery'
import { UnavailableError, fetchSettled } from '../../src/http'
import { startFakeServer, type FakeServer } from '../support/fake-server'

// Discovery by the product URL (ADR-087 dec. 2, §0.3.5 adj. 5).

let fake: FakeServer | undefined
afterEach(async () => {
  await fake?.close()
  fake = undefined
})
const opts = { deadlineMs: 1_000, sleep: () => Promise.resolve() }

function fakeFetch(routes: Record<string, () => Response>): typeof fetch {
  return ((input: string | URL | Request) => {
    const path = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname
    const route = routes[path]
    return Promise.resolve(route !== undefined ? route() : new Response('nope', { status: 404 }))
  })
}

describe('discover', () => {
  it('application/json with a server string → that server (trailing slash trimmed), account resolved', async () => {
    const f = fakeFetch({
      '/.well-known/tayet/agent': () => Response.json({ server: 'https://matrix.example/', account: '/escrow' }),
    })
    expect(await discover('https://chat.example', { ...opts, fetch: f })).toEqual({
      server: 'https://matrix.example', account: 'https://chat.example/escrow', via: 'well-known',
    })
  })

  // PLANO-AGENTES §0.3.10 item 4: the escrow is where the operator is learned.
  it.each([
    ['relative, against the product URL', '/escrow', 'https://chat.example/escrow'],
    ['relative with a trailing slash', '/escrow/', 'https://chat.example/escrow'],
    ['absolute, as is', 'https://account.example/escrow/', 'https://account.example/escrow'],
    ['absent', undefined, undefined],
    ['not a string', 42, undefined],
    ['empty', '', undefined],
    ['not http(s)', 'ftp://account.example', undefined],
  ])('account %s', async (_n, account, expected) => {
    const f = fakeFetch({
      '/.well-known/tayet/agent': () => Response.json({ server: 'https://matrix.example', ...(account !== undefined ? { account } : {}) }),
    })
    expect((await discover('https://chat.example/app', { ...opts, fetch: f })).account).toBe(expected)
  })

  it('200 text/html (the SPA fallback) on a non-loopback URL → error, never the dev fallback', async () => {
    let versionsAsked = false
    const f = fakeFetch({
      '/.well-known/tayet/agent': () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }),
      '/_matrix/client/versions': () => {
        versionsAsked = true
        return Response.json({ versions: ['v1.11'] })
      },
    })
    await expect(discover('https://chat.example', { ...opts, fetch: f })).rejects.toBeInstanceOf(DiscoveryError)
    expect(versionsAsked).toBe(false)
  })

  it.each([
    ['no server', { account: '/escrow' }],
    ['server not a string', { server: 42 }],
    ['server not a URL', { server: 'matrix' }],
    ['server not http(s)', { server: 'ftp://matrix.example' }],
  ])('JSON with %s → error', async (_n, body) => {
    const f = fakeFetch({ '/.well-known/tayet/agent': () => Response.json(body) })
    await expect(discover('https://chat.example', { ...opts, fetch: f })).rejects.toBeInstanceOf(DiscoveryError)
  })

  it('loopback with a document → well-known; with none but a live server → direct', async () => {
    fake = await startFakeServer()
    expect(await discover(fake.url, opts)).toMatchObject({ server: fake.url, via: 'well-known' })
    fake.set({ wellKnown: 'html' })
    expect(await discover(fake.url, opts)).toMatchObject({ server: fake.url, via: 'direct' })
  })

  it('loopback with neither → error', async () => {
    fake = await startFakeServer({ wellKnown: 'none', versions: false })
    await expect(discover(fake.url, opts)).rejects.toBeInstanceOf(DiscoveryError)
  })

  it('unreachable until the deadline → DiscoveryError (exit 69 in the boot)', async () => {
    const f = (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch
    await expect(discover('https://chat.example', { ...opts, fetch: f })).rejects.toThrow(/unreachable/)
  })
})

describe('fetchSettled', () => {
  it('429 honours retry_after_ms, 5xx retries, a 4xx returns at once', async () => {
    const statuses = [429, 503, 404]
    const waits: number[] = []
    const f = (() => {
      const status = statuses.shift()!
      return Promise.resolve(Response.json(status === 429 ? { retry_after_ms: 250 } : {}, { status }))
    }) as typeof fetch
    const res = await fetchSettled('https://x/y', {}, { deadlineMs: 60_000, fetch: f, sleep: (ms) => {
      waits.push(ms)
      return Promise.resolve()
    } })
    expect(res.status).toBe(404)
    expect(waits).toEqual([350, 2_000])
  })

  it('gives up with UnavailableError when the next wait passes the deadline', async () => {
    const f = (() => Promise.resolve(new Response('', { status: 502 }))) as typeof fetch
    await expect(fetchSettled('https://x/y', {}, { deadlineMs: 0, fetch: f })).rejects.toBeInstanceOf(UnavailableError)
  })
})
