import { describe, it, expect } from 'vitest'
import { masAdmin } from '../../src/mas-admin.ts'

// Paging guards of the MAS admin client (PLANO-RELEASE-PUBLICA §8, browser-session loop on reset).
// MAS 1.27.0 builds `links.next` of user-sessions from the OWNER's id while the query pages by the
// session's id: with `filter[user]`, the "next" page is the first one again, forever. listAll never
// trusts a cursor; here it is reached through linksOf.

const USER = 'U-ana'

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

// A scripted list endpoint for the listAll guards: each GET answers the next scripted page.
function scripted(pages: (n: number) => { data: Array<{ id: string; attributes: object }>; links: { next?: string } }) {
  let n = 0
  const route = (input: string): Response => {
    const url = new URL(input)
    if (url.pathname === '/oauth2/token') return json(200, { access_token: 'adm', expires_in: 3600 })
    return json(200, pages(n++))
  }
  const fetchFn = ((input: string) => Promise.resolve(route(input))) as typeof fetch
  return {
    gets: () => n,
    admin: masAdmin({ url: 'http://mas:8081', tokenUrl: 'http://mas:8080/oauth2/token', clientId: 'id', clientSecret: 's', fetchFn }),
  }
}

const link = (id: string) => ({ id, attributes: { provider_id: 'p', subject: id } })
const next = (after: string) => ({ next: `/api/admin/v1/upstream-oauth-links?filter[user]=${USER}&page[first]=100&page[after]=${after}` })

describe('listAll guards', () => {
  it('a repeated page[after] is an error', async () => {
    const mas = scripted((n) => ({ data: [link(`l-${n}`)], links: next('same') }))
    await expect(mas.admin.linksOf(USER)).rejects.toThrow(/repeated cursor/)
  })

  it('a row seen again under a new cursor is an error', async () => {
    const mas = scripted((n) => ({ data: [link('l-dup')], links: next(`c-${n}`) }))
    await expect(mas.admin.linksOf(USER)).rejects.toThrow(/repeated row/)
  })

  it('past the page ceiling is an error, never a truncated list', async () => {
    const mas = scripted((n) => ({ data: [link(`l-${n}`)], links: next(`c-${n}`) }))
    await expect(mas.admin.linksOf(USER)).rejects.toThrow(/page ceiling/)
    expect(mas.gets()).toBe(500)
  })

  it('guard errors carry no user id, cursor or row id', async () => {
    const cases = [
      scripted((n) => ({ data: [link(`l-${n}`)], links: next('cur-same') })),
      scripted((n) => ({ data: [link('l-dup')], links: next(`cur-${n}`) })),
    ]
    for (const mas of cases) {
      const err = (await mas.admin.linksOf(USER).catch((e: unknown) => e)) as Error
      for (const leak of [USER, 'cur-', 'l-dup', 'l-0']) expect(err.message).not.toContain(leak)
    }
  })

  it('a self-referencing cursor, as 1.27.0 builds on user-sessions, is an error, not a hang', async () => {
    const mas = scripted(() => ({ data: [link('l-1'), link('l-2')], links: next(USER) }))
    await expect(mas.admin.linksOf(USER)).rejects.toThrow(/repeated/)
    expect(mas.gets()).toBe(2)
  })

  it('a well-formed multi-page listing still comes back whole', async () => {
    const mas = scripted((n) => ({ data: [link(`l-${n}`)], links: n < 4 ? next(`c-${n}`) : {} }))
    expect((await mas.admin.linksOf(USER)).map((l) => l.id)).toEqual(['l-0', 'l-1', 'l-2', 'l-3', 'l-4'])
  })
})
