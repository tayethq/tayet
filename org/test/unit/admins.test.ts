import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createOrgServer } from '../../src/server.ts'
import { jsonlAudit } from '../../src/audit.ts'
import { masAdmin } from '../../src/mas-admin.ts'
import { createAgents } from '../../src/agents.ts'
import { createPeople, systemWriter } from '../../src/people.ts'
import { adminLock, createAdmins, type Admins } from '../../src/admins.ts'
import { runCli } from '../../src/cli.ts'
import { homeserver } from '../../src/synapse.ts'
import { fakeFetch, fakeIntrospector, ME, PROVIDER, SERVER, seed, type Fake } from '../support/fake-org.ts'

// The admin role: promote, demote, the access read, the last-admin guard and the operator command.

let dir: string
let server: Server
let base: string
let fake: Fake
let calls: string[]
let admins: Admins

const mxid = (username: string): string => `@${username}:${SERVER}`
const member = (username: string, content: Record<string, unknown>): void => {
  fake.state.set(`${ME}|${username}:${SERVER}`, content)
}

async function start(): Promise<void> {
  const inner = fakeFetch(fake)
  const fetchFn = ((input: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${decodeURIComponent(new URL(input).pathname)}`)
    return inner(input, init)
  }) as typeof fetch
  const admin = masAdmin({ url: 'http://mas:8081', tokenUrl: 'http://mas:8080/oauth2/token', clientId: 'id', clientSecret: 's', fetchFn })
  const synapse = homeserver({ url: 'http://synapse:8008', fetchFn, sleep: () => Promise.resolve() })
  const audit = jsonlAudit(join(dir, 'audit.jsonl'))
  const asSystem = systemWriter({ masAdmin: admin, synapse, serverName: SERVER })
  const serialize = adminLock()
  const common = { masAdmin: admin, synapse, audit, asSystem, serverName: SERVER, custodyUsername: 'cofre', serialize }
  admins = createAdmins(common)
  server = createOrgServer({
    introspector: fakeIntrospector(fake),
    audit,
    people: createPeople({ ...common, randomId: () => 'r1', providerId: PROVIDER }),
    agents: createAgents({ ...common, randomId: () => 'agentlocalaaa' }),
    admins,
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const role = (method: 'PUT' | 'DELETE', token: string | undefined, target: string, body?: string): Promise<Response> =>
  fetch(`${base}/v1/people/${encodeURIComponent(target)}/admin`, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    ...(body !== undefined ? { body } : {}),
  })
const promote = (token: string | undefined, target: string): Promise<Response> => role('PUT', token, target)
const demote = (token: string | undefined, target: string): Promise<Response> => role('DELETE', token, target)
const access = (token: string | undefined): Promise<Response> =>
  fetch(`${base}/v1/org/access`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
const removePerson = (token: string, target: string): Promise<Response> =>
  fetch(`${base}/v1/people/${encodeURIComponent(target)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })

const audit = async (): Promise<Array<Record<string, unknown>>> =>
  (await readFile(join(dir, 'audit.jsonl'), 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)

const isAdmin = (username: string): boolean => fake.users.find((u) => u.username === username)?.admin === true
const setAdminCalls = (): string[] => calls.filter((c) => c.endsWith('/set-admin'))

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'org-admins-'))
  fake = seed()
  calls = []
  member('alice', { kind: 'member', name: 'Alice', email: 'alice@x.test' })
  member('bob', { kind: 'member', name: 'Bob', email: 'bob@x.test' })
  await start()
})

afterEach(async () => {
  expect(fake.filterViolations).toEqual([])
  await new Promise((r) => server.close(r))
  await rm(dir, { recursive: true, force: true })
})

describe('PUT /v1/people/:userId/admin', () => {
  it('a live member → 200 { userId, admin: true }; again → 200, no second write', async () => {
    const res = await promote('tok-alice', mxid('bob'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ userId: mxid('bob'), admin: true })
    expect(isAdmin('bob')).toBe(true)
    expect((await audit()).at(-1)).toMatchObject({ sub: 'sub-alice', actor: 'alice', verb: 'people.promote', outcome: 'promoted', target: mxid('bob') })

    const again = await promote('tok-alice', mxid('bob'))
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ userId: mxid('bob'), admin: true })
    expect(setAdminCalls()).toHaveLength(1)
    expect((await audit()).at(-1)).toMatchObject({ verb: 'people.promote', outcome: 'unchanged' })
  })

  it('a member with a pending invite to #all → 200', async () => {
    fake.state.set(`m.room.member|${mxid('bob')}`, { membership: 'invite' })
    expect((await promote('tok-alice', mxid('bob'))).status).toBe(200)
    expect(isAdmin('bob')).toBe(true)
  })

  it.each([
    ['a guest without a record', undefined],
    ['a guest record', { kind: 'guest', name: 'Bob', email: 'bob@x.test' }],
    ['a tombstone', { removed: true, kind: 'member' }],
    ['a legacy {} record', {}],
    ['an agent record', { kind: 'agent', name: 'Bot', operator: 'alice' }],
  ])('%s → 409 not_member, no write', async (_, content) => {
    if (content === undefined) fake.state.delete(`${ME}|bob:${SERVER}`)
    else member('bob', content)
    const res = await promote('tok-alice', mxid('bob'))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ reason: 'not_member', userId: mxid('bob') })
    expect(setAdminCalls()).toEqual([])
    expect((await audit()).at(-1)).toMatchObject({ verb: 'people.promote', outcome: 'conflict', reason: 'not_member' })
  })

  it.each([
    ['deactivated', { deactivated: true }],
    ['locked', { locked: true }],
  ])('a %s account → 409 not_member, read before any write (MAS would accept it)', async (_, flags) => {
    Object.assign(fake.users.find((u) => u.username === 'bob')!, flags)
    const res = await promote('tok-alice', mxid('bob'))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ reason: 'not_member', userId: mxid('bob') })
    expect(setAdminCalls()).toEqual([])
  })

  it('an agent → 409 is_agent, before any read of the target', async () => {
    const res = await promote('tok-alice', mxid('a-agentlocalaaa'))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ reason: 'is_agent', userId: mxid('a-agentlocalaaa'), kind: 'agent' })
    // Only the caller's admin check reached MAS.
    expect(calls.filter((c) => c.startsWith('GET /api/admin'))).toEqual(['GET /api/admin/v1/users/by-username/alice'])
    expect(calls.some((c) => c.includes('personal-sessions') || c.startsWith('GET /_matrix'))).toBe(false)
  })

  it('an account MAS does not have → 404 not_found', async () => {
    const res = await promote('tok-alice', mxid('nobody'))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })
  })

  it.each(['bob', '@bob', `@bob:other.test`, mxid('system'), mxid('cofre')])('%s → 400 bad_target', async (target) => {
    const res = await promote('tok-alice', target)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'bad_target' })
    expect(setAdminCalls()).toEqual([])
  })

  it('a body → 400 bad_request', async () => {
    expect((await role('PUT', 'tok-alice', mxid('bob'), '{}')).status).toBe(400)
  })
})

describe('DELETE /v1/people/:userId/admin', () => {
  beforeEach(() => {
    fake.users.push({ id: 'U-carol', username: 'carol', admin: true })
  })

  it('an admin → 200 { userId, admin: false }; again → 200, no second write; membership is not read', async () => {
    const res = await demote('tok-alice', mxid('carol'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ userId: mxid('carol'), admin: false })
    expect(isAdmin('carol')).toBe(false)
    expect((await audit()).at(-1)).toMatchObject({ actor: 'alice', verb: 'people.demote', outcome: 'demoted', target: mxid('carol') })

    const again = await demote('tok-alice', mxid('carol'))
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ userId: mxid('carol'), admin: false })
    expect(setAdminCalls()).toHaveLength(1)
    expect((await audit()).at(-1)).toMatchObject({ verb: 'people.demote', outcome: 'unchanged' })
    // carol has no record in #all: demotion never looks.
    expect(calls.some((c) => c.startsWith('GET /_matrix'))).toBe(false)
  })

  it('demoting oneself with another admin → 200; alone → 409 last_admin', async () => {
    expect((await demote('tok-alice', mxid('alice'))).status).toBe(200)
    expect(isAdmin('alice')).toBe(false)
    const res = await demote('tok-carol', mxid('carol'))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ reason: 'last_admin', userId: mxid('carol') })
    expect(isAdmin('carol')).toBe(true)
    expect((await audit()).at(-1)).toMatchObject({ verb: 'people.demote', outcome: 'conflict', reason: 'last_admin' })
  })

  it('a deactivated admin is not counted: demoting it leaves the active one', async () => {
    fake.users.find((u) => u.username === 'carol')!.deactivated = true
    expect((await demote('tok-alice', mxid('carol'))).status).toBe(200)
    expect((await demote('tok-alice', mxid('alice'))).status).toBe(409)
  })

  it.each(['bob', `@carol:other.test`, mxid('system'), mxid('cofre')])('%s → 400 bad_target', async (target) => {
    expect((await demote('tok-alice', target)).status).toBe(400)
  })

  it('an account MAS does not have → 404 not_found', async () => {
    expect((await demote('tok-alice', mxid('nobody'))).status).toBe(404)
  })

  it('race: two admins demote themselves at once → one 200, one 409 last_admin', async () => {
    // Without the lock both would count two admins before either write lands.
    fake.beforeSetAdmin = () => new Promise((r) => setTimeout(r, 20))
    const results = await Promise.all([demote('tok-alice', mxid('alice')), demote('tok-carol', mxid('carol'))])
    expect(results.map((r) => r.status).sort()).toEqual([200, 409])
    expect(fake.users.filter((u) => u.admin === true && !u.deactivated)).toHaveLength(1)
  })

  it('race: a demotion and the removal of the other admin never leave zero active admins', async () => {
    fake.beforeSetAdmin = () => new Promise((r) => setTimeout(r, 20))
    const [demoted, removed] = await Promise.all([
      demote('tok-alice', mxid('carol')),
      removePerson('tok-carol', mxid('alice')),
    ])
    const statuses = [demoted.status, removed.status]
    expect(statuses.filter((s) => s === 200)).toHaveLength(1)
    expect(statuses.filter((s) => s === 403 || s === 409)).toHaveLength(1)
    expect(fake.users.filter((u) => u.admin === true && !u.deactivated && !u.locked)).toHaveLength(1)
  })
})

describe('DELETE /v1/people/:userId and the last admin', () => {
  it('removing an admin with another one left → 200', async () => {
    fake.users.push({ id: 'U-carol', username: 'carol', admin: true })
    expect((await removePerson('tok-alice', mxid('carol'))).status).toBe(200)
  })

  it('removing the last active admin → 409 last_admin, nothing deactivated', async () => {
    // carol's token outlives her flag; alice is the only active admin.
    fake.users.push({ id: 'U-carol', username: 'carol', admin: true, deactivated: true })
    const res = await removePerson('tok-carol', mxid('alice'))
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ reason: 'last_admin', userId: mxid('alice') })
    expect(fake.users.find((u) => u.username === 'alice')!.deactivated).toBeUndefined()
    expect((await audit()).at(-1)).toMatchObject({ verb: 'people.remove', outcome: 'conflict', reason: 'last_admin' })
  })
})

describe('GET /v1/org/access', () => {
  beforeEach(() => {
    fake.users.push(
      { id: 'U-carol', username: 'carol', admin: true },
      { id: 'U-dan', username: 'dan' },
      { id: 'U-eve', username: 'eve', deactivated: true },
      { id: 'U-a-withsession', username: 'a-withsession' },
      { id: 'U-a-nosession', username: 'a-nosession' },
    )
    fake.oauth2Sessions.push(
      { id: 'o1', user_id: 'U-alice' },
      { id: 'o2', user_id: 'U-carol', finished: true },
      { id: 'o3', user_id: null },
    )
    fake.compatSessions.push({ id: 'c1', user_id: 'U-dan' })
    // An agent's personal session acts as the agent; its operator gets nothing from it.
    fake.sessions.push({ id: 'p1', body: { actor_user_id: 'U-a-withsession' } })
    fake.sessions.push({ id: 'p2', body: { actor_user_id: 'U-bob' } })
  })

  it('admins and accounts without an app session (OAuth2 or compat for people, personal for agents)', async () => {
    const res = await access('tok-alice')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      admins: [mxid('alice'), mxid('carol')],
      // bob has only a personal session, which does not count for a person; carol's OAuth2 session
      // is finished; the session with no user counts for nobody; system, cofre and eve are out.
      withoutAccess: [mxid('a-nosession'), mxid('bob'), mxid('carol')],
    })
    const last = (await audit()).at(-1)!
    expect(last).toMatchObject({ actor: 'alice', verb: 'org.access', outcome: 'ok' })
    expect(Object.keys(last).sort()).toEqual(['actor', 'outcome', 'sub', 'ts', 'verb'])
  })

  it('reads in bulk: page[first]=1000, active only, every page', async () => {
    for (let i = 0; i < 1200; i += 1) fake.users.push({ id: `U-p${String(i).padStart(4, '0')}`, username: `p${i}` })
    const body = (await (await access('tok-alice')).json()) as { withoutAccess: string[] }
    expect(body.withoutAccess).toHaveLength(1203)
    expect(calls.filter((c) => c === 'GET /api/admin/v1/users')).toHaveLength(3)
  })

  it('a MAS failure → 502 admin_unavailable', async () => {
    fake.failing.add('GET /api/admin/v1/compat-sessions')
    const res = await access('tok-alice')
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'admin_unavailable' })
  })
})

describe('authorization', () => {
  it.each([
    ['PUT admin', () => promote('tok-bob', mxid('alice')), 'people.promote'],
    ['DELETE admin', () => demote('tok-bob', mxid('alice')), 'people.demote'],
    ['GET access', () => access('tok-bob'), 'org.access'],
  ])('%s by a non-admin → 403, no write', async (_, call, verb) => {
    const res = await call()
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'forbidden' })
    expect(setAdminCalls()).toEqual([])
    expect((await audit()).at(-1)).toMatchObject({ actor: 'bob', verb, outcome: 'forbidden' })
  })

  it('no token → 401 on all three', async () => {
    for (const res of [await promote(undefined, mxid('bob')), await demote(undefined, mxid('bob')), await access(undefined)]) {
      expect(res.status).toBe(401)
    }
  })
})

describe('cli.ts promote-admin', () => {
  const run = async (...argv: string[]): Promise<{ code: number; out: string[]; err: string[] }> => {
    const out: string[] = []
    const err: string[] = []
    const code = await runCli(argv, { admins: () => admins, out: (l) => out.push(l), err: (l) => err.push(l) })
    return { code, out, err }
  }
  const email = (username: string, address: string): void => {
    fake.emails.push({ user_id: fake.users.find((u) => u.username === username)!.id, email: address })
  }

  it('a live member → promoted, then idempotent; audited as deploy.sh without sub', async () => {
    email('bob', 'bob@x.test')
    expect(await run('promote-admin', 'Bob@X.test')).toEqual({ code: 0, out: ['bob: promoted'], err: [] })
    expect(isAdmin('bob')).toBe(true)
    expect(await run('promote-admin', 'bob@x.test')).toEqual({ code: 0, out: ['bob: already an admin'], err: [] })
    const [first, second] = (await audit()).slice(-2)
    expect(first).toMatchObject({ actor: 'deploy.sh', verb: 'people.promote', target: mxid('bob'), outcome: 'promoted' })
    expect(second).toMatchObject({ outcome: 'unchanged' })
    expect(first).not.toHaveProperty('sub')
  })

  it.each([
    ['no account', () => undefined, 'no account for this email'],
    ['a guest', () => fake.state.delete(`${ME}|bob:${SERVER}`), 'not a member'],
    ['a tombstone', () => member('bob', { removed: true, kind: 'member' }), 'not a member'],
    ['a legacy {}', () => member('bob', {}), 'not a member'],
    ['deactivated', () => (fake.users.find((u) => u.username === 'bob')!.deactivated = true), 'deactivated or locked'],
    ['locked', () => (fake.users.find((u) => u.username === 'bob')!.locked = true), 'deactivated or locked'],
  ])('%s → refused with a non-zero exit', async (name, arrange, line) => {
    if (name !== 'no account') email('bob', 'bob@x.test')
    arrange()
    const result = await run('promote-admin', 'bob@x.test')
    expect(result).toEqual({ code: 1, out: [], err: [`promote-admin: ${line}`] })
    expect(isAdmin('bob')).toBe(false)
  })

  it.each([
    ['system', 'reserved account'],
    ['cofre', 'reserved account'],
  ])('%s → reserved account', async (username, line) => {
    email(username, `${username}@x.test`)
    expect(await run('promote-admin', `${username}@x.test`)).toEqual({ code: 1, out: [], err: [`promote-admin: ${line}`] })
  })

  it('an agent → agent', async () => {
    fake.users.push({ id: 'U-a-agentlocalaaa', username: 'a-agentlocalaaa' })
    email('a-agentlocalaaa', 'bot@x.test')
    expect(await run('promote-admin', 'bot@x.test')).toEqual({ code: 1, out: [], err: ['promote-admin: agent'] })
  })

  it('MAS down → failed, non-zero, without the email in the line', async () => {
    fake.tokenStatus = 500
    const result = await run('promote-admin', 'bob@x.test')
    expect(result.code).toBe(1)
    expect(result.err).toEqual(['promote-admin: failed (admin token: 500)'])
  })

  it.each([[[]], [['promote-admin']], [['promote-admin', 'not-an-email']], [['demote-admin', 'a@b.c']], [['promote-admin', 'a@b.c', 'x']]])(
    'usage error %j → exit 2',
    async (argv) => {
      expect((await run(...argv)).code).toBe(2)
    },
  )
})
