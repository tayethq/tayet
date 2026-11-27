import { describe, it, expect } from 'vitest'
import { masAdmin } from '../../src/mas-admin.ts'

// Paging guards of the MAS admin client (PLANO-RELEASE-PUBLICA §8, browser-session loop on reset).
// MAS 1.27.0 builds `links.next` of user-sessions from the OWNER's id while the query pages by the
// session's id: with `filter[user]`, the "next" page is the first one again, forever. The fake below
// reproduces that on user-sessions and pages correctly on the other kinds.

const DEVICE_SCOPE = 'urn:matrix:org.matrix.msc2967.client:device:'
const USER = 'U-ana'

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

interface Row {
  id: string
  kind: 'oauth2-sessions' | 'compat-sessions' | 'user-sessions'
  scope?: string
  device_id?: string
  user_session_id?: string | null
  finished?: boolean
}

const pad = (n: number): string => String(n).padStart(4, '0')

function seed(browserCount: number, originAt: number): Row[] {
  const rows: Row[] = [
    { id: 'oa-origin', kind: 'oauth2-sessions', scope: `openid ${DEVICE_SCOPE}ORIGIN`, user_session_id: `br-${pad(originAt)}` },
    { id: 'oa-other-1', kind: 'oauth2-sessions', scope: `openid ${DEVICE_SCOPE}O1`, user_session_id: 'br-0000' },
    { id: 'oa-other-2', kind: 'oauth2-sessions', scope: `openid ${DEVICE_SCOPE}O2`, user_session_id: 'br-0001' },
    { id: 'co-other', kind: 'compat-sessions', device_id: 'COMPAT', user_session_id: null },
  ]
  for (let i = 0; i < browserCount; i++) rows.push({ id: `br-${pad(i)}`, kind: 'user-sessions' })
  return rows
}

// A MAS 1.27.0 lookalike. `finish` options: `stubborn` answers 200 without leaving the active list;
// `raceOn` is a session another sweep finished first (400, already gone from the active list).
function fakeMas127(rows: Row[], opts: { stubborn?: boolean; raceOn?: string } = {}) {
  const calls: string[] = []
  const route = (input: string, init?: RequestInit): Response => {
    const url = new URL(input)
    const method = init?.method ?? 'GET'
    calls.push(`${method} ${url.pathname}`)
    if (url.pathname === '/oauth2/token') return json(200, { access_token: 'adm', expires_in: 3600 })
    if (url.pathname === '/api/admin/v1/users/by-username/ana') return json(200, { data: { id: USER } })

    const finish = /^\/api\/admin\/v1\/([a-z0-9-]+)\/([^/]+)\/finish$/.exec(url.pathname)
    if (finish) {
      const row = rows.find((r) => r.id === finish[2])
      if (!row) return json(404, {})
      if (finish[2] === opts.raceOn) {
        row.finished = true
        return json(400, {})
      }
      if (row.finished) return json(400, {})
      if (!opts.stubborn) row.finished = true
      return json(200, {})
    }

    const list = /^\/api\/admin\/v1\/([a-z0-9-]+)$/.exec(url.pathname)
    if (list) {
      expect(url.searchParams.get('filter[user]')).toBe(USER)
      const size = Number(url.searchParams.get('page[first]'))
      const active = rows.filter((r) => r.kind === list[1] && !r.finished).sort((a, b) => a.id.localeCompare(b.id))
      const after = url.searchParams.get('page[after]')
      // 1.27.0 bug: on user-sessions the cursor is the owner's id, which matches no session, so the
      // query starts over from the first row. The other kinds page by the last row's id.
      const start = list[1] === 'user-sessions' || after === null ? 0 : active.findIndex((r) => r.id === after) + 1
      const page = active.slice(start, start + size)
      const more = start + size < active.length
      const cursor = list[1] === 'user-sessions' ? USER : page.at(-1)?.id
      return json(200, {
        data: page.map((r) => ({
          id: r.id,
          attributes: { scope: r.scope, device_id: r.device_id, user_session_id: r.user_session_id },
        })),
        links: more
          ? { next: `${url.pathname}?filter[user]=${USER}&filter[status]=active&page[first]=${size}&page[after]=${cursor}` }
          : {},
      })
    }
    return json(404, {})
  }
  const fetchFn = ((input: string, init?: RequestInit) => Promise.resolve(route(input, init))) as typeof fetch
  return {
    calls,
    admin: masAdmin({ url: 'http://mas:8081', tokenUrl: 'http://mas:8080/oauth2/token', clientId: 'id', clientSecret: 's', fetchFn }),
  }
}

// A scripted oauth2-sessions listing for the listAll guards, reached through revokeOthers: each GET of
// it answers the next scripted page; the other listings are empty and every finish succeeds.
function scripted(pages: (n: number) => { data: Array<{ id: string; attributes: object }>; links: { next?: string } }) {
  let n = 0
  const route = (input: string): Response => {
    const url = new URL(input)
    if (url.pathname === '/oauth2/token') return json(200, { access_token: 'adm', expires_in: 3600 })
    if (url.pathname === '/api/admin/v1/users/by-username/ana') return json(200, { data: { id: USER } })
    if (url.pathname === '/api/admin/v1/oauth2-sessions') return json(200, pages(n++))
    if (url.pathname.endsWith('/finish')) return json(200, {})
    return json(200, { data: [], links: {} })
  }
  const fetchFn = ((input: string) => Promise.resolve(route(input))) as typeof fetch
  return {
    gets: () => n,
    admin: masAdmin({ url: 'http://mas:8081', tokenUrl: 'http://mas:8080/oauth2/token', clientId: 'id', clientSecret: 's', fetchFn }),
  }
}

// `s-0` is the origin; every other session is finished.
const session = (id: string) => ({ id, attributes: { scope: `openid ${DEVICE_SCOPE}${id === 's-0' ? 'ORIGIN' : id}` } })
const next = (after: string) => ({
  next: `/api/admin/v1/oauth2-sessions?filter[user]=${USER}&filter[status]=active&page[first]=100&page[after]=${after}`,
})

describe('revokeOthers on MAS 1.27.0 (browser sessions drained, not paged)', () => {
  it('250 active browser sessions with the origin in the middle: ends, finishes 249, keeps the origin, OAuth and compat first', async () => {
    const rows = seed(250, 125)
    const mas = fakeMas127(rows)
    const revoked = await mas.admin.revokeOthers('ana', 'ORIGIN')

    expect(revoked).toEqual({ oauth: 2, compat: 1, browser: 249 })
    expect(rows.filter((r) => !r.finished).map((r) => r.id)).toEqual(['oa-origin', 'br-0125'])

    const finishes = mas.calls.filter((c) => c.endsWith('/finish'))
    const firstBrowser = finishes.findIndex((c) => c.includes('/user-sessions/'))
    const lastOther = finishes.findLastIndex((c) => !c.includes('/user-sessions/'))
    expect(lastOther).toBeLessThan(firstBrowser)
    expect(finishes.filter((c) => !c.includes('/user-sessions/'))).toHaveLength(3)
  })

  it('a finish that never leaves the active list fails at the read ceiling instead of looping', async () => {
    const rows = seed(3, 1)
    const mas = fakeMas127(rows, { stubborn: true })
    await expect(mas.admin.revokeOthers('ana', 'ORIGIN')).rejects.toThrow(/read ceiling/)
    const reads = mas.calls.filter((c) => c === 'GET /api/admin/v1/user-sessions')
    expect(reads).toHaveLength(200)
  })

  it('a 400 mid-drain (finished by another sweep) is not counted and the drain goes on', async () => {
    const rows = seed(150, 10)
    const mas = fakeMas127(rows, { raceOn: 'br-0120' })
    const revoked = await mas.admin.revokeOthers('ana', 'ORIGIN')
    expect(revoked.browser).toBe(148)
    expect(rows.filter((r) => !r.finished).map((r) => r.id)).toEqual(['oa-origin', 'br-0010'])
  })

  it('the old path is caught too: a self-referencing cursor, as 1.27.0 builds on user-sessions, is an error, not a hang', async () => {
    const mas = scripted(() => ({ data: [session('s-1'), session('s-2')], links: next(USER) }))
    await expect(mas.admin.revokeOthers('ana', 'ORIGIN')).rejects.toThrow(/repeated/)
    expect(mas.gets()).toBe(2)
  })
})

describe('listAll guards', () => {
  it('a repeated page[after] is an error', async () => {
    const mas = scripted((n) => ({ data: [session(`s-${n}`)], links: next('same') }))
    await expect(mas.admin.revokeOthers('ana', 'ORIGIN')).rejects.toThrow(/repeated cursor/)
  })

  it('a row seen again under a new cursor is an error', async () => {
    const mas = scripted((n) => ({ data: [session('s-dup')], links: next(`c-${n}`) }))
    await expect(mas.admin.revokeOthers('ana', 'ORIGIN')).rejects.toThrow(/repeated row/)
  })

  it('past the page ceiling is an error, never a truncated list', async () => {
    const mas = scripted((n) => ({ data: [session(`s-${n}`)], links: next(`c-${n}`) }))
    await expect(mas.admin.revokeOthers('ana', 'ORIGIN')).rejects.toThrow(/page ceiling/)
    expect(mas.gets()).toBe(500)
  })

  it('guard errors carry no user id, cursor or row id', async () => {
    const cases = [
      scripted((n) => ({ data: [session(`s-${n}`)], links: next('cur-same') })),
      scripted((n) => ({ data: [session('s-dup')], links: next(`cur-${n}`) })),
    ]
    for (const mas of cases) {
      const err = (await mas.admin.revokeOthers('ana', 'ORIGIN').catch((e: unknown) => e)) as Error
      for (const leak of [USER, 'cur-', 's-dup', 's-0']) expect(err.message).not.toContain(leak)
    }
  })

  it('a well-formed multi-page listing still comes back whole', async () => {
    const mas = scripted((n) => ({ data: [session(`s-${n}`)], links: n < 4 ? next(`c-${n}`) : {} }))
    expect((await mas.admin.revokeOthers('ana', 'ORIGIN')).oauth).toBe(4)
    expect(mas.gets()).toBe(5)
  })
})
