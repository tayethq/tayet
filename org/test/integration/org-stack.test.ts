import { describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import { ESCROW_URL, mintOidcSession, registerUser, stackUp } from '../support/stack.ts'

// The org service in the dev-stack, behind the router: its own MAS clients work —
// the introspection client resolves a real token and the admin client reads the admin flag — and the
// router sends each path to its process. `alice` is the dev-stack's org admin (promote_org_admin).

const UP = stackUp()
const PASSWORD = 'orgpass123'

const me = (token?: string): Promise<Response> =>
  fetch(`${ESCROW_URL}/v1/people/me`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })

describe.skipIf(!UP)('org service against the dev-stack', () => {
  it('without a token, people/me and secret are both 401 (each from its own process)', async () => {
    const res = await me()
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
    expect((await fetch(`${ESCROW_URL}/v1/secret`)).status).toBe(401)
  })

  it('a new account: introspection by the org client, admin flag false by the org admin client', async () => {
    const username = `org-${randomBytes(4).toString('hex')}`
    registerUser(username, PASSWORD)
    const session = await mintOidcSession(username, PASSWORD)
    const res = await me(session.accessToken)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ admin: false })
  })

  it('the org admin reads admin: true', async () => {
    const session = await mintOidcSession('alice', 'alicepass123')
    const res = await me(session.accessToken)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ admin: true })
  })

  it('a path the router keeps for the escrow does not reach the org', async () => {
    const res = await fetch(`${ESCROW_URL}/v1/account/revoke-others`, { method: 'POST' })
    expect(res.status).toBe(401)
  })
})

// The admin role against the real MAS and #all. Only fresh accounts are targets: never alice nor the
// E2E admin accounts. The bulk read time goes to stdout for the run's record.
describe.skipIf(!UP)('admin role against the dev-stack', () => {
  const call = (token: string, method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${ESCROW_URL}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  const readAccess = async (token: string): Promise<{ admins: string[]; withoutAccess: string[] }> => {
    const started = performance.now()
    const res = await call(token, 'GET', '/v1/org/access')
    console.log(`org.access bulk read: ${Math.round(performance.now() - started)} ms`)
    expect(res.status).toBe(200)
    return (await res.json()) as { admins: string[]; withoutAccess: string[] }
  }
  const adminPath = (mxid: string): string => `/v1/people/${encodeURIComponent(mxid)}/admin`

  it('invite, access, promote, demote and remove fresh accounts', async () => {
    const { accessToken: token } = await mintOidcSession('alice', 'alicepass123')
    const tag = randomBytes(4).toString('hex')
    const invited: string[] = []
    try {
      const memberRes = await call(token, 'POST', '/v1/people', { email: `m-${tag}@org-gate.test`, name: `Member ${tag}`, kind: 'member' })
      expect(memberRes.status).toBe(201)
      const memberId = ((await memberRes.json()) as { userId: string }).userId
      invited.push(memberId)
      const guestRes = await call(token, 'POST', '/v1/people', { email: `g-${tag}@org-gate.test`, name: `Guest ${tag}`, kind: 'guest' })
      expect(guestRes.status).toBe(201)
      const guestId = ((await guestRes.json()) as { userId: string }).userId
      invited.push(guestId)
      const alice = memberId.replace(/^@[^:]+/, '@alice')

      const before = await readAccess(token)
      expect(before.withoutAccess).toEqual(expect.arrayContaining([memberId, guestId]))
      expect(before.admins).toContain(alice)
      expect(before.withoutAccess).not.toContain(alice)

      for (let i = 0; i < 2; i += 1) {
        const res = await call(token, 'PUT', adminPath(memberId))
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ userId: memberId, admin: true })
      }
      expect((await readAccess(token)).admins).toContain(memberId)

      const guest = await call(token, 'PUT', adminPath(guestId))
      expect(guest.status).toBe(409)
      expect(await guest.json()).toEqual({ reason: 'not_member', userId: guestId })

      for (let i = 0; i < 2; i += 1) {
        const res = await call(token, 'DELETE', adminPath(memberId))
        expect(res.status).toBe(200)
        expect(await res.json()).toEqual({ userId: memberId, admin: false })
      }
      expect((await readAccess(token)).admins).not.toContain(memberId)
    } finally {
      for (const id of invited) {
        expect((await call(token, 'DELETE', `/v1/people/${encodeURIComponent(id)}`)).status).toBe(200)
      }
    }
  }, 120_000)
})
