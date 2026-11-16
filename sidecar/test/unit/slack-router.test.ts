import { describe, it, expect, afterEach } from 'vitest'
import { ErrorCode, type WebAPIPlatformError } from '@slack/web-api'
import { WriteError } from '../../src/core/write'
import { SlackError, type SlackMethods } from '../../src/api/slack/router'
import { ALICE, GENERAL, ME, message, startSlack, type SlackHarness } from '../support/slack-world'

// The Slack layer's router (PLANO-AGENTES §0.3.12): the order (revoked → Bearer → method), the bodies
// (form, JSON, GET query), `team_id`, the 200-with-`ok` answers, the 429 with `Retry-After` that the
// real @slack/web-api retries without duplicating, and both edges. A test-only method table.

let h: SlackHarness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

let limited = 0
const TEST_METHODS: SlackMethods = {
  'test.echo': (args) => Promise.resolve({ args }),
  // Rate-limited once, then the effect (counted) goes through.
  'test.limit': async (_args, ctx) => {
    await ctx.write.react(GENERAL.id, '1730000100.000100', '🎉')
    limited++
    return {}
  },
  'test.leak': () => Promise.resolve({ user: '@alice:server.example' }),
  'test.vocab': () => Promise.resolve({ room_id: 'x' }),
  'test.allowed': () => Promise.resolve({ event_id: 'Ev06ABCDEF' }),
  'test.native': (_args, ctx) => Promise.resolve({ m: ctx.native(message({ id: '1.000000', text: 'oi @bob:server.example' }), 'test') }),
  'test.content': () => Promise.resolve({ message: { type: 'message', ts: '1.000000', user: ALICE.id, text: 'pode verificar o cofre?' } }),
  'test.crash': () => Promise.reject(new Error('boom @alice:server.example')),
  'test.fail': () => Promise.reject(new SlackError('channel_not_found')),
}

const start = async (): Promise<SlackHarness> => (h = await startSlack({ methods: [TEST_METHODS] }))
const platformError = (err: unknown): string => (err as WebAPIPlatformError).data.error

describe('Slack layer — order and auth', () => {
  it('the real WebClient calls a method (form body) and gets { ok: true, … }', async () => {
    const s = await start()
    const res = (await s.client().apiCall('test.echo', { a: '1', nested: { b: [1, 2] } })) as unknown as Record<string, unknown>
    expect(res.ok).toBe(true)
    // @slack/web-api sends every method as form-urlencoded, nested fields as JSON strings (§0.3.12).
    expect(res.args).toEqual({ a: '1', nested: '{"b":[1,2]}' })
  })

  it('a JSON body and a GET query are accepted too', async () => {
    const s = await start()
    const json = await s.raw('test.echo', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ a: 1, nested: { b: true } }) })
    expect(json).toMatchObject({ status: 200, body: { ok: true, args: { a: 1, nested: { b: true } } } })
    const get = await s.raw('test.echo', { method: 'GET', query: { a: 'x' } })
    expect(get.body).toEqual({ ok: true, args: { a: 'x' } })
  })

  it('no token → not_authed; a wrong one → invalid_auth (HTTP 200, as Slack)', async () => {
    const s = await start()
    const none = await fetch(`${s.url}/slack/api/test.echo`, { method: 'POST' })
    expect(none.status).toBe(200)
    expect(await none.json()).toEqual({ ok: false, error: 'not_authed' })
    await expect(s.client({}, 'tal_wrong').apiCall('test.echo')).rejects.toSatisfy((e) => platformError(e) === 'invalid_auth')
  })

  it('team_id: this workspace passes; another one → invalid_auth', async () => {
    const s = await start()
    expect((await s.client({ teamId: ME.workspace }).apiCall('test.echo')).ok).toBe(true)
    await expect(s.client({ teamId: 'TOTHERAAAAA' }).apiCall('test.echo')).rejects.toSatisfy((e) => platformError(e) === 'invalid_auth')
  })

  it('unknown method → unknown_method; a Slack refusal → its code; a crash → internal_error with no message logged', async () => {
    const s = await start()
    await expect(s.client().apiCall('test.nothing')).rejects.toSatisfy((e) => platformError(e) === 'unknown_method')
    await expect(s.client().apiCall('constructor')).rejects.toSatisfy((e) => platformError(e) === 'unknown_method')
    await expect(s.client().apiCall('test.fail')).rejects.toSatisfy((e) => platformError(e) === 'channel_not_found')
    await expect(s.client().apiCall('test.crash')).rejects.toSatisfy((e) => platformError(e) === 'internal_error')
    expect(s.logs).toContainEqual({ evt: 'api-error', where: 'slack test.crash', name: 'Error' })
    expect(JSON.stringify(s.logs)).not.toContain('@alice')
  })

  it('a multipart body on a method route → invalid_arguments', async () => {
    const s = await start()
    const form = new FormData()
    form.append('a', '1')
    const res = await s.raw('test.echo', { body: form })
    expect(res.body).toEqual({ ok: false, error: 'invalid_arguments' })
  })

  it('Host and Origin stay the native refusals (before the layer); a revocation → token_revoked', async () => {
    const s = await start()
    const origin = await s.raw('test.echo', { headers: { origin: 'https://evil.example' } })
    expect(origin.status).toBe(403)
    await s.api.revoke(10, 0)
    expect((await s.raw('test.echo')).body).toEqual({ ok: false, error: 'token_revoked' })
  })
})

describe('Slack layer — limit', () => {
  it('429 + numeric Retry-After + ratelimited; the WebClient retries after it and the effect happens once', async () => {
    const s = await start()
    limited = 0
    s.world.failNext.push(new WriteError('rate_limited', 400))
    const raw = await s.raw('test.limit')
    expect(raw.status).toBe(429)
    expect(raw.headers.get('retry-after')).toBe('1')
    expect(raw.body).toEqual({ ok: false, error: 'ratelimited' })
    expect(s.world.calls).toEqual([])

    s.world.failNext.push(new WriteError('rate_limited', 400))
    const t0 = Date.now()
    const res = await s.client({ retryConfig: { retries: 2, factor: 1, minTimeout: 10, maxTimeout: 10 } }).apiCall('test.limit')
    expect(res.ok).toBe(true)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900)
    expect(limited).toBe(1)
    expect(s.world.calls.filter((c) => c.op === 'react')).toHaveLength(1)
  })

  it('rejectRateLimitedCalls surfaces the limit as the SDK error', async () => {
    const s = await start()
    s.world.failNext.push(new WriteError('rate_limited', 2500))
    await expect(s.client({ rejectRateLimitedCalls: true }).apiCall('test.limit')).rejects.toMatchObject({ code: ErrorCode.RateLimitedError, retryAfter: 3 })
  })
})

describe('Slack layer — edges (§0.3.12 item 2)', () => {
  it('an id shape in a structural field → internal_error and leak-blocked (path, never the value)', async () => {
    const s = await start()
    await expect(s.client().apiCall('test.leak')).rejects.toSatisfy((e) => platformError(e) === 'internal_error')
    expect(s.logs).toContainEqual({ evt: 'leak-blocked', where: 'slack test.leak', path: '$.user', pattern: 'mxid' })
    expect(JSON.stringify(s.logs)).not.toContain('@alice')
  })

  it('a denied key → internal_error; the allowlisted `event_id` passes', async () => {
    const s = await start()
    await expect(s.client().apiCall('test.vocab')).rejects.toSatisfy((e) => platformError(e) === 'internal_error')
    expect(s.logs).toContainEqual({ evt: 'leak-blocked', where: 'slack test.vocab', path: '$.room_id', pattern: 'contract-vocabulary' })
    expect(((await s.client().apiCall('test.allowed')) as unknown as Record<string, unknown>).event_id).toBe('Ev06ABCDEF')
  })

  it('the native edge runs before the translation (an id in a message text)', async () => {
    const s = await start()
    await expect(s.client().apiCall('test.native')).rejects.toSatisfy((e) => platformError(e) === 'internal_error')
    expect(s.logs.find((l) => l.evt === 'leak-blocked')).toMatchObject({ where: 'slack test', pattern: 'mxid' })
  })

  it('user content of a Slack message gets the id shapes only (a person may write "cofre")', async () => {
    const s = await start()
    expect((((await s.client().apiCall('test.content')) as unknown as Record<string, unknown>).message as { text: string }).text).toBe('pode verificar o cofre?')
  })
})
