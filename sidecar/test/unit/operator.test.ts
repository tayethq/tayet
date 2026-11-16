import { describe, it, expect } from 'vitest'
import { UnavailableError } from '../../src/http'
import { lookupOperator } from '../../src/operator'

// Step 3b (PLANO-AGENTES §0.3.10 item 4): the escrow's answer, classified. The process-level exits are
// in boot.test.ts; the unreachable escrow (retry until the deadline) is proven here, without 120 s.

const opts = { deadlineMs: 1_000, sleep: () => Promise.resolve() }
const ACCOUNT = 'https://chat.example/escrow'

function answering(res: () => Response, seen: string[] = []): typeof fetch {
  return (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    seen.push(`${url} ${new Headers(init?.headers).get('authorization') ?? ''}`)
    return Promise.resolve(res())
  }
}

describe('lookupOperator', () => {
  it('GET <account>/v1/people/me with the agent token → the operator', async () => {
    const seen: string[] = []
    const f = answering(() => Response.json({ admin: false, kind: 'agent', operator: '@op:example' }), seen)
    expect(await lookupOperator(ACCOUNT, 'tok', { ...opts, fetch: f })).toEqual({ kind: 'ok', operator: '@op:example' })
    expect(seen).toEqual(['https://chat.example/escrow/v1/people/me Bearer tok'])
  })

  it.each([
    ['no operator', { admin: false, kind: 'agent' }],
    ['operator not a string', { admin: false, kind: 'agent', operator: 7 }],
    ['operator not an mxid', { admin: false, kind: 'agent', operator: 'alice' }],
  ])('%s → unknown', async (_n, body) => {
    expect(await lookupOperator(ACCOUNT, 'tok', { ...opts, fetch: answering(() => Response.json(body)) })).toEqual({ kind: 'unknown' })
  })

  it.each([401, 403])('%i → refused', async (status) => {
    const f = answering(() => Response.json({ error: 'unauthorized' }, { status }))
    expect(await lookupOperator(ACCOUNT, 'tok', { ...opts, fetch: f })).toEqual({ kind: 'refused', status })
  })

  it.each([
    ['404', () => Response.json({}, { status: 404 })],
    ['html', () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } })],
    ['not an agent', () => Response.json({ admin: false })],
  ])('%s → bad-escrow', async (_n, res) => {
    expect((await lookupOperator(ACCOUNT, 'tok', { ...opts, fetch: answering(res) })).kind).toBe('bad-escrow')
  })

  it('unreachable (network error or 5xx until the deadline) → UnavailableError', async () => {
    const down = (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch
    await expect(lookupOperator(ACCOUNT, 'tok', { ...opts, fetch: down })).rejects.toBeInstanceOf(UnavailableError)
    const failing = answering(() => Response.json({ error: 'admin_unavailable' }, { status: 502 }))
    await expect(lookupOperator(ACCOUNT, 'tok', { ...opts, fetch: failing })).rejects.toBeInstanceOf(UnavailableError)
  })
})
