import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { createEscrowServer } from '../../src/server.ts'
import { importOrgKey } from '../../src/crypto.ts'
import { fileSessionStore } from '../../src/custody-store.ts'
import { fileStore } from '../../src/store.ts'
import { jsonlAudit } from '../../src/audit.ts'
import { masAdmin } from '../../src/mas-admin.ts'
import { createPeople, systemWriter } from '../../src/people.ts'
import { createAgents, keyedMutex, normalizeName, randomDeviceId } from '../../src/agents.ts'
import { homeserver } from '../../src/synapse.ts'
import { fakeFetch, fakeIntrospector, ME, PROVIDER, ROOM, SERVER, seed, type Fake } from '../support/fake-org.ts'

// POST/DELETE /v1/agents e /reissue (ADR-086) contra o MAS e o Synapse falsos de fake-org.ts.

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'
const AGENT = 'a-agentlocalab' // o primeiro localpart que o randomId do teste gera
const AGENT_MXID = `@${AGENT}:${SERVER}`
const AGENT_KEY = `${ME}|${AGENT}:${SERVER}`
const ALICE_KEY = `${ME}|alice:${SERVER}`

let dir: string
let server: Server
let base: string
let fake: Fake
let calls: string[]
let clock: number
let service: ReturnType<typeof createAgents>
// Gancho antes do mint de sessão de agente: simula outro caminho cunhando entre o kill e o mint.
let beforeMint: (() => void) | undefined

async function start(): Promise<void> {
  const inner = fakeFetch(fake)
  // Ordem das chamadas à admin API, para provar kill→mint.
  const fetchFn = ((input: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${decodeURIComponent(new URL(input).pathname)}`)
    if (init?.method === 'POST' && new URL(input).pathname === '/api/admin/v1/personal-sessions') beforeMint?.()
    return inner(input, init)
  }) as typeof fetch
  const admin = masAdmin({ url: 'http://mas:8081', tokenUrl: 'http://mas:8080/oauth2/token', clientId: 'id', clientSecret: 's', fetchFn })
  const synapse = homeserver({ url: 'http://synapse:8008', fetchFn, sleep: () => Promise.resolve() })
  const audit = jsonlAudit(join(dir, 'audit.jsonl'))
  const asSystem = systemWriter({ masAdmin: admin, synapse, serverName: SERVER })
  let n = 0
  let d = 0
  server = createEscrowServer({
    store: fileStore(dir),
    introspector: fakeIntrospector(fake),
    orgKey: await importOrgKey(Buffer.from(new Uint8Array(32).fill(7)).toString('base64')),
    audit,
    sessionStore: fileSessionStore(join(dir, 'sessions')),
    custodyUsername: 'cofre',
    accessAdmin: admin,
    people: createPeople({
      masAdmin: admin,
      synapse,
      audit,
      randomId: () => `r${(n += 1)}`,
      serverName: SERVER,
      providerId: PROVIDER,
      custodyUsername: 'cofre',
      asSystem,
    }),
    agents: (service = createAgents({
      masAdmin: admin,
      synapse,
      audit,
      randomId: () => `agentlocala${BASE32[(n += 1)]}`,
      randomDevice: () => `DEVICE${String((d += 1)).padStart(4, '0')}`,
      serverName: SERVER,
      asSystem,
      now: () => clock,
    })),
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const create = (token: string | undefined, body: unknown = { name: ' Relatórios ' }): Promise<Response> =>
  fetch(`${base}/v1/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })

const patch = (token: string, mxid: string, body: unknown): Promise<Response> =>
  fetch(`${base}/v1/agents/${encodeURIComponent(mxid)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })

const remove = (token: string, mxid: string): Promise<Response> =>
  fetch(`${base}/v1/agents/${encodeURIComponent(mxid)}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })

const reissue = (token: string, mxid: string): Promise<Response> =>
  fetch(`${base}/v1/agents/${encodeURIComponent(mxid)}/reissue`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })

const auditRaw = (): Promise<string> => readFile(join(dir, 'audit.jsonl'), 'utf8').catch(() => '')
const audit = async (): Promise<Array<Record<string, unknown>>> =>
  (await auditRaw())
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)

const agentSessions = (): Fake['sessions'] => fake.sessions.filter((s) => s.body.actor_user_id === `U-${AGENT}`)

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'escrow-agents-'))
  fake = seed()
  calls = []
  clock = 1_000_000
  beforeMint = undefined
  // alice é admin e `member` vivo em #all; bob é member sem o flag.
  fake.state.set(ALICE_KEY, { kind: 'member', name: 'Alice', email: 'alice@tayet.local' })
  fake.state.set(`${ME}|bob:${SERVER}`, { kind: 'member', name: 'Bob' })
})

afterEach(async () => {
  await new Promise((r) => server.close(r))
  await rm(dir, { recursive: true, force: true })
})

describe('POST /v1/agents', () => {
  it('cria a conta a-, grava { kind: agent, name, operator } sem convite e devolve o token uma vez', async () => {
    await start()
    const res = await create('tok-alice')
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(typeof body.token).toBe('string')
    expect(body).toEqual({ userId: AGENT_MXID, name: 'Relatórios', color: 'areia', token: body.token, deviceId: 'DEVICE0001' })
    expect(AGENT).toMatch(/^a-[a-z2-7]{12}$/)

    expect(fake.users.at(-1)).toMatchObject({ username: AGENT, displayname: 'Relatórios' })
    expect(fake.emails).toEqual([])
    expect(fake.links).toEqual([])
    expect(fake.state.get(AGENT_KEY)).toEqual({ kind: 'agent', name: 'Relatórios', operator: 'alice', color: 'areia' })
    expect(fake.invites).toEqual([])

    const [session] = agentSessions()
    expect(session!.body).toEqual({
      actor_user_id: `U-${AGENT}`,
      human_name: 'tayet-agent',
      scope: 'urn:matrix:client:api:* urn:matrix:client:device:DEVICE0001',
    })
    expect(session!.body).not.toHaveProperty('expires_in')
    expect(session!.revoked).toBeUndefined()
    // As sessões do system (leitura de #all e escrita do evento) são revogadas ao fim.
    expect(fake.sessions.filter((s) => s.body.actor_user_id === 'U-sys').every((s) => s.revoked)).toBe(true)

    expect((await audit()).at(-1)).toMatchObject({
      sub: 'sub-alice',
      actor: 'alice',
      verb: 'agents.create',
      outcome: 'created',
      target: AGENT_MXID,
      kind: 'agent',
    })
  })

  it('o token nunca chega ao audit, nem o nome', async () => {
    await start()
    const { token } = (await (await create('tok-alice')).json()) as { token: string }
    const { token: again } = (await (await reissue('tok-alice', AGENT_MXID)).json()) as { token: string }
    const raw = await auditRaw()
    for (const leak of [token, again, 'Relatórios', 'DEVICE0001', 'DEVICE0002']) expect(raw).not.toContain(leak)
  })

  it.each(['Ana Souza', 'ana  souza', 'Ána Souza', ' ANA\tSOUZA '])(
    'nome que colide (caixa, acento, espaço) com um name de #all → 409 name_taken: %j',
    async (name) => {
      await start()
      fake.state.set(`${ME}|u-x:${SERVER}`, { kind: 'member', name: 'Ana Souza' })
      const res = await create('tok-alice', { name })
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ reason: 'name_taken' })
      expect(fake.users).toHaveLength(4)
      expect((await audit()).at(-1)).toMatchObject({ verb: 'agents.create', outcome: 'conflict', reason: 'name_taken' })
    },
  )

  it('colide também com o nome de outro agente e com lápide que carregue nome', async () => {
    await start()
    expect((await create('tok-alice', { name: 'Relatórios' })).status).toBe(201)
    expect((await create('tok-alice', { name: 'relatorios' })).status).toBe(409)
    fake.state.set(`${ME}|u-y:${SERVER}`, { removed: true, kind: 'guest', name: 'Bia' })
    expect((await create('tok-alice', { name: 'bia' })).status).toBe(409)
  })

  it('não-admin → 403 sem efeito', async () => {
    await start()
    const res = await create('tok-bob')
    expect(res.status).toBe(403)
    expect(fake.users).toHaveLength(4)
    expect(fake.sessions).toEqual([])
    expect((await audit()).at(-1)).toMatchObject({ actor: 'bob', verb: 'agents.create', outcome: 'forbidden' })
  })

  it.each([
    ['guest', { kind: 'guest', name: 'Alice' }],
    ['lápide', { removed: true, kind: 'member' }],
  ])('admin cujo evento em #all é %s → 403 (operador precisa ser member)', async (_, content) => {
    await start()
    fake.state.set(ALICE_KEY, content)
    const res = await create('tok-alice')
    expect(res.status).toBe(403)
    expect(fake.users).toHaveLength(4)
    expect((await audit()).at(-1)).toMatchObject({ verb: 'agents.create', outcome: 'forbidden', reason: 'operator_not_member' })
  })

  it('admin sem evento em #all → 403', async () => {
    await start()
    fake.state.delete(ALICE_KEY)
    expect((await create('tok-alice')).status).toBe(403)
  })

  it('mint falha → compensação: conta desativada, lápide de agente, 502 com o passo', async () => {
    await start()
    const realPush = fake.sessions.push.bind(fake.sessions)
    fake.sessions.push = (...items) => {
      if (items.some((s) => s.body.actor_user_id === `U-${AGENT}`)) throw new Error('boom')
      return realPush(...items)
    }
    const res = await create('tok-alice')
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'partial', step: 'session' })
    expect(fake.users.at(-1)).toMatchObject({ username: AGENT, deactivated: true })
    expect(fake.state.get(AGENT_KEY)).toEqual({ removed: true, kind: 'agent' })
    const entries = await audit()
    expect(entries.at(-2)).toMatchObject({ verb: 'agents.create.compensated', outcome: 'removed', target: AGENT_MXID })
    expect(entries.at(-1)).toMatchObject({ verb: 'agents.create', outcome: 'error', step: 'session', target: AGENT_MXID })
  })

  it('falha ao criar a conta → 502 user, nada a desfazer', async () => {
    await start()
    fake.failing.add('POST /api/admin/v1/users')
    const res = await create('tok-alice')
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'partial', step: 'user' })
    expect((await audit()).map((e) => e.verb)).not.toContain('agents.create.compensated')
  })

  it.each([{}, { name: '  ' }, { name: 3 }, { name: 'A', kind: 'agent' }, { name: 'A', operator: 'bob' }])(
    'corpo fora do shape exato { name } → 400: %j',
    async (body) => {
      await start()
      expect((await create('tok-alice', body)).status).toBe(400)
      expect(fake.users).toHaveLength(4)
    },
  )

  it('401 sem token válido; 503 com o IdP fora', async () => {
    await start()
    expect((await create(undefined)).status).toBe(401)
    expect((await create('tok-idp-down')).status).toBe(503)
  })
})

describe('cor do agente (fatia 3)', () => {
  it('cor válida vai para #all e para o 201', async () => {
    await start()
    const res = await create('tok-alice', { name: 'Relatórios', color: 'malva' })
    expect(res.status).toBe(201)
    expect(((await res.json()) as { color: string }).color).toBe('malva')
    expect(fake.state.get(AGENT_KEY)).toEqual({ kind: 'agent', name: 'Relatórios', operator: 'alice', color: 'malva' })
  })

  it('cor ausente → areia; cor desconhecida → 400 sem efeito', async () => {
    await start()
    for (const color of ['azul', '', 7, null]) {
      expect((await create('tok-alice', { name: 'Relatórios', color })).status).toBe(400)
    }
    expect(fake.users.some((u) => u.username.startsWith('a-'))).toBe(false)
    expect((await create('tok-alice', { name: 'Relatórios' })).status).toBe(201)
    expect(fake.state.get(AGENT_KEY)?.color).toBe('areia')
  })
})

describe('PATCH /v1/agents/:userId', () => {
  async function withAgent(): Promise<string> {
    await start()
    const { token } = (await (await create('tok-alice', { name: 'Relatórios', color: 'ocre' })).json()) as { token: string }
    return token
  }

  it('troca a cor sem tocar kind, operator, nome ou displayname', async () => {
    await withAgent()
    const res = await patch('tok-alice', AGENT_MXID, { color: 'ardosia' })
    expect(res.status).toBe(200)
    expect(fake.state.get(AGENT_KEY)).toEqual({ kind: 'agent', name: 'Relatórios', operator: 'alice', color: 'ardosia' })
    expect(fake.displaynames).toEqual([])
    expect((await audit()).at(-1)).toMatchObject({ verb: 'agents.update', outcome: 'updated', target: AGENT_MXID, fields: ['color'] })
  })

  it('renomeia: #all e o displayname da conta, por uma sessão curta do próprio agente, revogada só ela', async () => {
    const credential = await withAgent()
    const before = agentSessions().length
    const res = await patch('tok-alice', AGENT_MXID, { name: ' Resumos ', color: 'salvia' })
    expect(res.status).toBe(200)
    expect(fake.state.get(AGENT_KEY)).toEqual({ kind: 'agent', name: 'Resumos', operator: 'alice', color: 'salvia' })
    expect(fake.displaynames.map((d) => ({ mxid: d.mxid, displayname: d.displayname, actor: d.actor }))).toEqual([{ mxid: AGENT_MXID, displayname: 'Resumos', actor: `U-${AGENT}` }])

    // A sessão do rename: sem device, com TTL, revogada pelo id.
    const profile = fake.sessions.find((s) => s.id === fake.displaynames[0]!.session)!
    expect(profile.body).toEqual({ actor_user_id: `U-${AGENT}`, human_name: 'escrow agent profile', scope: 'urn:matrix:client:api:*', expires_in: 60 })
    expect(profile.revoked).toBe(true)
    expect(agentSessions().filter((s) => !s.revoked).length).toBe(before) // só a credencial segue ativa
    expect(calls.filter((c) => c.startsWith('GET /api/admin/v1/personal-sessions'))).toEqual([]) // nunca lista-e-revoga

    // A credencial em uso continua válida: a sessão segue ativa e o token ainda autentica.
    const [cred] = agentSessions()
    expect(cred!.body.scope).toBe('urn:matrix:client:api:* urn:matrix:client:device:DEVICE0001')
    expect(cred!.revoked).toBeUndefined()
    expect((await reissue(credential, AGENT_MXID)).status).toBe(201) // self: o token ainda introspecta como o agente

    const raw = await auditRaw()
    expect(raw).not.toContain('Resumos')
    expect((await audit()).find((e) => e.verb === 'agents.update')).toMatchObject({ outcome: 'updated', fields: ['color', 'name'] })
  })

  it('colisão no rename (normalizada) → 409, sem efeito; o próprio nome não colide', async () => {
    await withAgent()
    expect((await patch('tok-alice', AGENT_MXID, { name: 'ALICE' })).status).toBe(409)
    expect(fake.state.get(AGENT_KEY)?.name).toBe('Relatórios')
    expect(fake.displaynames).toEqual([])
    expect((await audit()).at(-1)).toMatchObject({ verb: 'agents.update', outcome: 'conflict', reason: 'name_taken' })
    // Mesmo nome com outra caixa/acento: é o próprio agente, não colide.
    expect((await patch('tok-alice', AGENT_MXID, { name: 'relatorios' })).status).toBe(200)
    expect(fake.state.get(AGENT_KEY)?.name).toBe('relatorios')
  })

  it('não-admin → 403 sem efeito', async () => {
    await withAgent()
    expect((await patch('tok-bob', AGENT_MXID, { color: 'malva' })).status).toBe(403)
    expect(fake.state.get(AGENT_KEY)?.color).toBe('ocre')
    expect((await audit()).at(-1)).toMatchObject({ actor: 'bob', verb: 'agents.update', outcome: 'forbidden' })
  })

  it('kind e operator não são editáveis: corpo com eles (ou vazio, ou cor desconhecida) → 400', async () => {
    await withAgent()
    for (const body of [{ kind: 'member' }, { operator: 'bob' }, { name: 'X', kind: 'member' }, {}, { color: 'azul' }, { name: '  ' }]) {
      expect((await patch('tok-alice', AGENT_MXID, body)).status).toBe(400)
    }
    expect(fake.state.get(AGENT_KEY)).toEqual({ kind: 'agent', name: 'Relatórios', operator: 'alice', color: 'ocre' })
  })

  it('alvo humano → 400 not_agent; agente removido → 404', async () => {
    await withAgent()
    expect((await patch('tok-alice', `@bob:${SERVER}`, { color: 'malva' })).status).toBe(400)
    expect((await remove('tok-alice', AGENT_MXID)).status).toBe(200)
    expect((await patch('tok-alice', AGENT_MXID, { color: 'malva' })).status).toBe(404)
    expect(fake.state.get(AGENT_KEY)).toEqual({ removed: true, kind: 'agent' })
  })

  it('falha no displayname → 502 displayname; a sessão curta é revogada; repetir conclui', async () => {
    await withAgent()
    fake.failing.add(`PUT /_matrix/client/v3/profile/${AGENT_MXID}/displayname`)
    const res = await patch('tok-alice', AGENT_MXID, { name: 'Resumos' })
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'partial', step: 'displayname' })
    expect(fake.sessions.filter((s) => s.body.human_name === 'escrow agent profile').every((s) => s.revoked)).toBe(true)
    fake.failing.clear()
    expect((await patch('tok-alice', AGENT_MXID, { name: 'Resumos' })).status).toBe(200)
    expect(fake.displaynames.map((d) => d.displayname)).toEqual(['Resumos'])
  })

  it('mintAgentProfileSession recusa conta que não é a-', async () => {
    const admin = masAdmin({ url: 'http://mas:8081', tokenUrl: 'http://mas:8080/oauth2/token', clientId: 'id', clientSecret: 's', fetchFn: fakeFetch(fake) })
    await expect(admin.mintAgentProfileSession('U-bob', 60)).rejects.toThrow('not an active agent')
  })
})

describe('POST /v1/agents/:userId/reissue', () => {
  it('admin: revoga o device antigo ANTES de cunhar o novo; token e device novos', async () => {
    await start()
    const first = (await (await create('tok-alice')).json()) as { token: string; deviceId: string }
    calls = []
    const res = await reissue('tok-alice', AGENT_MXID)
    expect(res.status).toBe(201)
    const body = (await res.json()) as { token: string; deviceId: string }
    expect(typeof body.token).toBe('string')
    expect(body).toEqual({ token: body.token, deviceId: 'DEVICE0002' })
    expect(body.token).not.toBe(first.token)

    const sessions = agentSessions()
    expect(sessions.map((s) => [s.body.scope, s.revoked === true])).toEqual([
      ['urn:matrix:client:api:* urn:matrix:client:device:DEVICE0001', true],
      ['urn:matrix:client:api:* urn:matrix:client:device:DEVICE0002', false],
    ])
    const revokeAt = calls.findIndex((c) => c.endsWith('/revoke'))
    const mintAt = calls.lastIndexOf('POST /api/admin/v1/personal-sessions')
    expect(revokeAt).toBeGreaterThanOrEqual(0)
    expect(revokeAt).toBeLessThan(mintAt)
    expect((await audit()).at(-1)).toMatchObject({ verb: 'agents.reissue', outcome: 'reissued', by: 'admin', target: AGENT_MXID })
  })

  it('self: o próprio token do agente reemite, e o token velho deixa de valer', async () => {
    await start()
    const { token } = (await (await create('tok-alice')).json()) as { token: string }
    const res = await reissue(token, AGENT_MXID)
    expect(res.status).toBe(201)
    expect((await audit()).at(-1)).toMatchObject({ verb: 'agents.reissue', outcome: 'reissued', by: 'self' })
    // Uma vez por device: o token velho foi revogado no kill.
    expect((await reissue(token, AGENT_MXID)).status).toBe(401)
  })

  it('self dentro da carência da introspecção → 429 reissue_too_soon e um único mint; depois dela → 401', async () => {
    // ADR-086 dec. 8: o MAS ainda vê o token revogado como ativo por < 1 s (medido ≤ 319 ms). O kill do
    // reissue e o limite de 60 s fecham "uma vez por device" sem código novo (PLANO-AGENTES §0.3.14 item 1).
    fake.introspectionGraceMs = 400
    fake.now = () => clock
    await start()
    const { token } = (await (await create('tok-alice')).json()) as { token: string }
    calls = []
    expect((await reissue(token, AGENT_MXID)).status).toBe(201)
    clock += 300
    const again = await reissue(token, AGENT_MXID)
    expect(again.status).toBe(429)
    expect(await again.json()).toEqual({ error: 'reissue_too_soon' })
    expect(calls.filter((c) => c === 'POST /api/admin/v1/personal-sessions')).toHaveLength(1)
    expect(agentSessions().filter((s) => !s.revoked)).toHaveLength(1)
    clock += 200
    expect((await reissue(token, AGENT_MXID)).status).toBe(401)
    expect(calls.filter((c) => c === 'POST /api/admin/v1/personal-sessions')).toHaveLength(1)
  })

  it('outro agente → 403', async () => {
    await start()
    const { token: first } = (await (await create('tok-alice', { name: 'Um' })).json()) as { token: string }
    const second = (await (await create('tok-alice', { name: 'Dois' })).json()) as { userId: string }
    expect(second.userId).not.toBe(AGENT_MXID)
    const res = await reissue(first, second.userId)
    expect(res.status).toBe(403)
    expect((await audit()).at(-1)).toMatchObject({ verb: 'agents.reissue', outcome: 'forbidden' })
  })

  it('não-admin humano → 403', async () => {
    await start()
    await create('tok-alice')
    expect((await reissue('tok-bob', AGENT_MXID)).status).toBe(403)
  })

  it('alvo que não é a- → 400 not_agent; agente inexistente ou removido → 404', async () => {
    await start()
    const notAgent = await reissue('tok-alice', `@bob:${SERVER}`)
    expect(notAgent.status).toBe(400)
    expect(await notAgent.json()).toEqual({ error: 'not_agent' })
    expect((await reissue('tok-alice', `@a-zzzzzzzzzzzz:${SERVER}`)).status).toBe(404)
    await create('tok-alice')
    await remove('tok-alice', AGENT_MXID)
    expect((await reissue('tok-alice', AGENT_MXID)).status).toBe(404)
  })

  it('mint falha depois do kill → 502 mint, sem credencial viva; repetir conclui', async () => {
    await start()
    await create('tok-alice')
    fake.failing.add('POST /api/admin/v1/personal-sessions')
    const res = await reissue('tok-alice', AGENT_MXID)
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'partial', step: 'mint' })
    expect(agentSessions().every((s) => s.revoked)).toBe(true)
    fake.failing.clear()
    expect((await reissue('tok-alice', AGENT_MXID)).status).toBe(201)
  })
})

// ADR-087 dec. 9: reissue serializado por agente, uma sessão ativa depois dele, self ≤ 1/60 s.
describe('reissue serializado (ADR-087 dec. 9)', () => {
  const live = (): Fake['sessions'] => agentSessions().filter((s) => !s.revoked)

  it('duas chamadas self concorrentes com o mesmo token → uma 201, uma 429, UMA sessão ativa', async () => {
    await start()
    await create('tok-alice')
    // No serviço, direto: as duas entram no mutex no mesmo tick, antes de a primeira revogar o token
    // (pelo HTTP, a segunda poderia chegar já com o token morto e levar 401 em vez de esperar). O ator
    // é o que a introspecção do mesmo token devolve.
    const self = { sub: `sub-U-${AGENT}`, username: AGENT }
    const [a, b] = await Promise.all([service.reissueAgent(AGENT_MXID, self), service.reissueAgent(AGENT_MXID, self)])
    expect([a.status, b.status]).toEqual([201, 429])
    expect(b.headers).toEqual({ 'Retry-After': '60' })
    const won = a.body as { token: string; deviceId: string }
    expect(live().map((s) => s.body.scope)).toEqual([`urn:matrix:client:api:* urn:matrix:client:device:${won.deviceId}`])
    const rows = (await audit()).filter((e) => e.verb === 'agents.reissue')
    expect(rows).toHaveLength(2)
    expect(rows.filter((e) => e.concurrent === true)).toHaveLength(1)
    expect(rows.find((e) => e.concurrent === true)).toMatchObject({ outcome: 'rate_limited', by: 'self', reason: 'reissue_too_soon' })
    expect(rows.find((e) => e.concurrent === undefined)).toMatchObject({ outcome: 'reissued', by: 'self' })
  })

  it('duas chamadas admin concorrentes → ambas 201 (admin sem limite), UMA sessão ativa = a da segunda', async () => {
    await start()
    await create('tok-alice')
    const admin = { sub: 'sub-alice', username: 'alice' }
    const [a, b] = await Promise.all([service.reissueAgent(AGENT_MXID, admin), service.reissueAgent(AGENT_MXID, admin)])
    expect([a.status, b.status]).toEqual([201, 201])
    expect(live()).toHaveLength(1)
    expect(live()[0]!.body.scope).toBe('urn:matrix:client:api:* urn:matrix:client:device:DEVICE0003')
    expect((await audit()).filter((e) => e.verb === 'agents.reissue').map((e) => e.concurrent)).toEqual([undefined, true])
  })

  it('segundo self-reissue em < 60 s → 429 reissue_too_soon com Retry-After; aos 60 s volta a valer', async () => {
    await start()
    const { token } = (await (await create('tok-alice')).json()) as { token: string }
    const first = (await (await reissue(token, AGENT_MXID)).json()) as { token: string }
    clock += 15_500
    const early = await reissue(first.token, AGENT_MXID)
    expect(early.status).toBe(429)
    expect(early.headers.get('retry-after')).toBe('45')
    expect(await early.json()).toEqual({ error: 'reissue_too_soon' })
    // Nada tocado: a credencial de quem levou 429 segue sendo a única viva.
    expect(live()).toHaveLength(1)
    clock += 44_500
    expect((await reissue(first.token, AGENT_MXID)).status).toBe(201)
  })

  it('admin não é limitado, nem depois de um self-reissue', async () => {
    await start()
    const { token } = (await (await create('tok-alice')).json()) as { token: string }
    expect((await reissue(token, AGENT_MXID)).status).toBe(201)
    for (let i = 0; i < 3; i++) expect((await reissue('tok-alice', AGENT_MXID)).status).toBe(201)
    expect(live()).toHaveLength(1)
  })

  it('kill→mint mantido, e o varrido pós-mint derruba sessão cunhada entre o kill e o mint', async () => {
    await start()
    await create('tok-alice')
    calls = []
    let injected = false
    beforeMint = () => {
      if (injected) return
      injected = true
      fake.sessions.push({ id: 'sess-of-rogue', body: { actor_user_id: `U-${AGENT}`, scope: 'rogue' } })
    }
    const res = await reissue('tok-alice', AGENT_MXID)
    expect(res.status).toBe(201)
    const { deviceId } = (await res.json()) as { deviceId: string }
    expect(fake.sessions.find((s) => s.id === 'sess-of-rogue')?.revoked).toBe(true)
    expect(live().map((s) => s.body.scope)).toEqual([`urn:matrix:client:api:* urn:matrix:client:device:${deviceId}`])
    const firstRevoke = calls.findIndex((c) => c.endsWith('/revoke'))
    const mintAt = calls.indexOf('POST /api/admin/v1/personal-sessions')
    const sweepRevoke = calls.findLastIndex((c) => c.endsWith('/revoke'))
    expect(firstRevoke).toBeLessThan(mintAt)
    expect(sweepRevoke).toBeGreaterThan(mintAt)
  })

  it('varrido falha → 502 sweep e a sessão recém-cunhada também cai (ninguém a recebeu)', async () => {
    await start()
    await create('tok-alice')
    let lists = 0
    beforeMint = () => {
      // Depois do mint, a próxima listagem (o varrido) falha.
      fake.failing.add('GET /api/admin/v1/personal-sessions')
      lists += 1
    }
    const res = await reissue('tok-alice', AGENT_MXID)
    expect(lists).toBe(1)
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'partial', step: 'sweep' })
    expect(live()).toHaveLength(0)
  })

  it('remove concorrente com reissue: serializados, nenhuma sessão viva no fim', async () => {
    await start()
    await create('tok-alice')
    const admin = { sub: 'sub-alice', username: 'alice' }
    const [r, d] = await Promise.all([service.reissueAgent(AGENT_MXID, admin), service.removeAgent(AGENT_MXID, admin)])
    expect(r.status).toBe(201)
    expect(d.status).toBe(200)
    expect(live()).toHaveLength(0)
  })
})

describe('keyedMutex', () => {
  it('mesma chave em série (com waited), chaves distintas em paralelo; a chave é liberada', async () => {
    const run = keyedMutex()
    const log: string[] = []
    let open!: () => void
    const gate = new Promise<void>((r) => (open = r))
    const a = run('k', async (waited) => {
      log.push(`a:start:${waited}`)
      await gate
      log.push('a:end')
    })
    const b = run('k', (waited) => {
      log.push(`b:start:${waited}`)
      return Promise.resolve()
    })
    const c = run('other', (waited) => {
      log.push(`c:start:${waited}`)
      return Promise.resolve()
    })
    await c
    open()
    await Promise.all([a, b])
    expect(log).toEqual(['a:start:false', 'c:start:false', 'a:end', 'b:start:true'])
    let again: boolean | undefined
    await run('k', (waited) => {
      again = waited
      return Promise.resolve()
    })
    expect(again).toBe(false)
  })

  it('erro numa chamada não trava a próxima', async () => {
    const run = keyedMutex()
    const failed = run('k', () => Promise.reject(new Error('x')))
    const next = run('k', (waited) => Promise.resolve(waited))
    await expect(failed).rejects.toThrow('x')
    await expect(next).resolves.toBe(true)
  })
})

describe('DELETE /v1/agents/:userId', () => {
  it('revoga as sessões, desativa com skip_erase e grava a lápide de agente', async () => {
    await start()
    const { token } = (await (await create('tok-alice')).json()) as { token: string }
    calls = []
    const res = await remove('tok-alice', AGENT_MXID)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ removed: true })
    expect(agentSessions().every((s) => s.revoked)).toBe(true)
    expect(fake.users.at(-1)).toMatchObject({ username: AGENT, deactivated: true })
    expect(fake.state.get(AGENT_KEY)).toEqual({ removed: true, kind: 'agent' })
    expect(calls.findIndex((c) => c.endsWith('/revoke'))).toBeLessThan(calls.findIndex((c) => c.endsWith('/deactivate')))
    expect((await audit()).at(-1)).toMatchObject({ verb: 'agents.remove', outcome: 'removed', target: AGENT_MXID })
    expect((await reissue(token, AGENT_MXID)).status).toBe(401)
  })

  it('não-admin → 403; alvo humano → 400 not_agent; inexistente → 404', async () => {
    await start()
    await create('tok-alice')
    expect((await remove('tok-bob', AGENT_MXID)).status).toBe(403)
    const human = await remove('tok-alice', `@bob:${SERVER}`)
    expect(human.status).toBe(400)
    expect(await human.json()).toEqual({ error: 'not_agent' })
    expect((await remove('tok-alice', `@a-zzzzzzzzzzzz:${SERVER}`)).status).toBe(404)
    expect((await remove('tok-alice', `@${AGENT}:outro.server`)).status).toBe(400)
    expect(fake.users.at(-1)?.deactivated).toBeUndefined()
  })

  it('falha no deactivate → 502 com o passo; repetir conclui', async () => {
    await start()
    await create('tok-alice')
    fake.failing.add(`POST /api/admin/v1/users/U-${AGENT}/deactivate`)
    const res = await remove('tok-alice', AGENT_MXID)
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'partial', step: 'deactivate' })
    fake.failing.clear()
    expect((await remove('tok-alice', AGENT_MXID)).status).toBe(200)
    expect(fake.state.get(AGENT_KEY)).toEqual({ removed: true, kind: 'agent' })
  })
})

describe('GET /v1/people/me com token de agente', () => {
  const me = (t: string): Promise<unknown> =>
    fetch(`${base}/v1/people/me`, { headers: { Authorization: `Bearer ${t}` } }).then((r) => r.json())

  // PLANO-AGENTES §0.3.10 item 3: o operador vem do `system` de #all, como mxid deste servidor.
  it('devolve kind: agent e o operador gravado; pessoa não leva kind nem operator', async () => {
    await start()
    const { token } = (await (await create('tok-alice')).json()) as { token: string }
    expect(await me(token)).toEqual({ admin: false, kind: 'agent', operator: `@alice:${SERVER}` })
    expect(await me('tok-bob')).toEqual({ admin: false })
    expect(await me('tok-alice')).toEqual({ admin: true })
  })

  it('lápide → sem operator (o sidecar trata como operator-unknown)', async () => {
    await start()
    const { token } = (await (await create('tok-alice')).json()) as { token: string }
    fake.state.set(AGENT_KEY, { removed: true, kind: 'agent', operator: 'alice' })
    expect(await me(token)).toEqual({ admin: false, kind: 'agent' })
  })

  it('registro ausente, sem operator ou com operator inválido → sem operator', async () => {
    await start()
    const { token } = (await (await create('tok-alice')).json()) as { token: string }
    fake.state.set(AGENT_KEY, { kind: 'agent', name: 'Relatórios', color: 'areia' })
    expect(await me(token)).toEqual({ admin: false, kind: 'agent' })
    fake.state.set(AGENT_KEY, { kind: 'agent', name: 'Relatórios', operator: '@alice:outro.server' })
    expect(await me(token)).toEqual({ admin: false, kind: 'agent' })
    fake.state.delete(AGENT_KEY)
    expect(await me(token)).toEqual({ admin: false, kind: 'agent' })
  })

  it('falha ao ler #all → 502 admin_unavailable (o sidecar trata como inalcançável)', async () => {
    await start()
    const { token } = (await (await create('tok-alice')).json()) as { token: string }
    fake.failing.add(`GET /_matrix/client/v3/rooms/${ROOM}/state/${ME}/${AGENT}:${SERVER}`)
    const res = await fetch(`${base}/v1/people/me`, { headers: { Authorization: `Bearer ${token}` } })
    expect(res.status).toBe(502)
  })

  it('o agente não altera o próprio operador por nenhuma rota do escrow', async () => {
    await start()
    const { token } = (await (await create('tok-alice')).json()) as { token: string }
    // PATCH com o token do agente: não é admin.
    expect((await patch(token, AGENT_MXID, { name: 'Outro' })).status).toBe(403)
    // PATCH com `operator` no corpo: recusado mesmo para o admin (só nome e cor).
    expect((await patch('tok-alice', AGENT_MXID, { operator: 'bob' })).status).toBe(400)
    expect((await patch(token, AGENT_MXID, { operator: 'bob' })).status).toBe(400) // corpo validado antes do ator
    // Os demais verbos com o token do agente: só admin, ou não tocam em #all.
    expect((await create(token, { name: 'Outro agente' })).status).toBe(403)
    expect((await remove(token, AGENT_MXID)).status).toBe(403)
    const people = await fetch(`${base}/v1/people`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ email: 'x@tayet.local', name: 'X', kind: 'member' }),
    })
    expect(people.status).toBe(403)
    const reissued = (await (await reissue(token, AGENT_MXID)).json()) as { token: string }
    // O PATCH legítimo do admin preserva o operador gravado.
    expect((await patch('tok-alice', AGENT_MXID, { name: 'Renomeado' })).status).toBe(200)
    expect(fake.state.get(AGENT_KEY)).toMatchObject({ kind: 'agent', operator: 'alice', name: 'Renomeado' })
    expect(await me(reissued.token)).toEqual({ admin: false, kind: 'agent', operator: `@alice:${SERVER}` })
  })
})

describe('mas-admin: a exceção escopada e o reaper', () => {
  const admin = (): ReturnType<typeof masAdmin> =>
    masAdmin({
      url: 'http://mas:8081',
      tokenUrl: 'http://mas:8080/oauth2/token',
      clientId: 'id',
      clientSecret: 's',
      fetchFn: fakeFetch(fake),
      now: () => new Date('2026-11-04T12:00:00.000Z'),
    })

  it('mintAgentSession recusa conta que não é a- e agente desativado', async () => {
    await start()
    await expect(admin().mintAgentSession('U-bob', 'DEVICE0001')).rejects.toThrow('not an active agent')
    fake.users.push({ id: 'U-a-deadagentxyz', username: 'a-deadagentxyz', deactivated: true })
    await expect(admin().mintAgentSession('U-a-deadagentxyz', 'DEVICE0001')).rejects.toThrow('not an active agent')
    expect(fake.sessions).toEqual([])
  })

  it('o reaper do system não lista nem revoga sessão de ator ≠ system (ADR-086 dec. 8)', async () => {
    await start()
    await create('tok-alice')
    fake.sessions.push({ id: 'expired-sys', body: { actor_user_id: 'U-sys' } })
    expect(await admin().reapExpiredSystemSessions()).toBe(1)
    expect(fake.sessions.find((s) => s.id === 'expired-sys')?.revoked).toBe(true)
    expect(agentSessions().map((s) => s.revoked)).toEqual([undefined])
  })
})

describe('normalizeName e randomDeviceId', () => {
  it('caixa, acento e espaço não distinguem', () => {
    expect(normalizeName('  Ána\t  SOUZA ')).toBe('ana souza')
    expect(normalizeName('Relatórios')).toBe(normalizeName('relatorios'))
    expect(normalizeName('Ana Souza')).not.toBe(normalizeName('Ana Souzas'))
  })

  it('10 caracteres [A-Z0-9]', () => {
    for (let i = 0; i < 50; i++) expect(randomDeviceId()).toMatch(/^[A-Z0-9]{10}$/)
  })
})
