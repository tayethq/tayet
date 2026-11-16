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
import { errorReason, jsonlAudit } from '../../src/audit.ts'
import { masAdmin } from '../../src/mas-admin.ts'
import { createPeople, randomLocalpart } from '../../src/people.ts'
import { homeserver } from '../../src/synapse.ts'
import { fakeFetch, fakeIntrospector, ME, PROVIDER, ROOM, SERVER, seed, type Fake } from '../support/fake-org.ts'

let dir: string
let server: Server
let base: string
let fake: Fake

async function start(opts: { mounted?: boolean } = {}): Promise<void> {
  const fetchFn = fakeFetch(fake)
  const admin = masAdmin({ url: 'http://mas:8081', tokenUrl: 'http://mas:8080/oauth2/token', clientId: 'id', clientSecret: 's', fetchFn })
  const audit = jsonlAudit(join(dir, 'audit.jsonl'))
  let n = 0
  server = createEscrowServer({
    store: fileStore(dir),
    introspector: fakeIntrospector(),
    orgKey: await importOrgKey(Buffer.from(new Uint8Array(32).fill(7)).toString('base64')),
    audit,
    sessionStore: fileSessionStore(join(dir, 'sessions')),
    custodyUsername: 'cofre',
    accessAdmin: admin,
    ...(opts.mounted === false
      ? {}
      : {
          people: createPeople({
            masAdmin: admin,
            synapse: homeserver({
              url: 'http://synapse:8008',
              fetchFn,
              sleep: (ms) => {
                fake.sleeps.push(ms)
                return Promise.resolve()
              },
            }),
            audit,
            randomId: () => `r${(n += 1)}`,
            serverName: SERVER,
            providerId: PROVIDER,
            custodyUsername: 'cofre',
          }),
        }),
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const invite = (token?: string, body: unknown = { email: 'Ana@Fora.com', name: ' Ana Lima ', kind: 'member' }): Promise<Response> =>
  fetch(`${base}/v1/people`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })

const remove = (token: string | undefined, mxid: string): Promise<Response> =>
  fetch(`${base}/v1/people/${encodeURIComponent(mxid)}`, {
    method: 'DELETE',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })

const audit = async (): Promise<Array<Record<string, unknown>>> =>
  (await readFile(join(dir, 'audit.jsonl'), 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)

const MXID = `@u-r1:${SERVER}`
const KEY = `${ME}|u-r1:${SERVER}`

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'escrow-people-'))
  fake = seed()
})

afterEach(async () => {
  await new Promise((r) => server.close(r))
  await rm(dir, { recursive: true, force: true })
})

describe('POST /v1/people', () => {
  it('member: conta, email, vínculo por subject, evento e convite, nessa ordem de efeitos', async () => {
    await start()
    const res = await invite('tok-alice')
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ userId: MXID, kind: 'member' })
    expect(fake.users.at(-1)).toMatchObject({ username: 'u-r1' })
    expect(fake.emails).toEqual([{ user_id: 'U-u-r1', email: 'ana@fora.com' }])
    expect(fake.links).toMatchObject([{ user_id: 'U-u-r1', provider_id: PROVIDER, subject: 'ana@fora.com' }])
    expect(fake.state.get(KEY)).toEqual({ kind: 'member', name: 'Ana Lima', email: 'ana@fora.com' })
    expect(fake.invites).toEqual([MXID])
    expect((await audit()).at(-1)).toMatchObject({
      sub: 'sub-alice',
      actor: 'alice',
      verb: 'people.invite',
      outcome: 'created',
      target: MXID,
      kind: 'member',
    })
  })

  it('guest: evento sem convite de #all', async () => {
    await start()
    const res = await invite('tok-alice', { email: 'g@fora.com', name: 'Gil', kind: 'guest' })
    expect(res.status).toBe(201)
    expect(fake.state.get(KEY)).toEqual({ kind: 'guest', name: 'Gil', email: 'g@fora.com' })
    expect(fake.invites).toEqual([])
  })

  it('escopo da sessão: exatamente urn:matrix:client:api:*, ator system, TTL 60, revogada ao fim', async () => {
    await start()
    await invite('tok-alice')
    expect(fake.sessions).toHaveLength(1)
    expect(fake.sessions[0]!.body).toEqual({
      actor_user_id: 'U-sys',
      human_name: 'escrow people',
      scope: 'urn:matrix:client:api:*',
      expires_in: 60,
    })
    expect(JSON.stringify(fake.sessions[0]!.body)).not.toContain('urn:synapse:admin')
    expect(fake.sessions[0]!.revoked).toBe(true)
  })

  it('não-admin → 403 sem efeito nenhum, com o actor no audit', async () => {
    await start()
    const res = await invite('tok-bob')
    expect(res.status).toBe(403)
    expect(fake.users).toHaveLength(4)
    expect(fake.sessions).toEqual([])
    expect((await audit()).at(-1)).toMatchObject({ actor: 'bob', verb: 'people.invite', outcome: 'forbidden' })
  })

  it('email existente → 409 exists, sem conta nova, e completo vira no-op', async () => {
    await start()
    await invite('tok-alice')
    const again = await invite('tok-alice')
    expect(again.status).toBe(409)
    expect(await again.json()).toEqual({ reason: 'exists', userId: MXID, kind: 'member' })
    expect(fake.users).toHaveLength(5)
    expect(fake.links).toHaveLength(1)
    expect(fake.invites).toEqual([MXID])
  })

  it('reconvite com outro kind → 409 kind_immutable, sem escrita (ADR-086 dec. 4)', async () => {
    await start()
    await invite('tok-alice', { email: 'g@fora.com', name: 'Gil', kind: 'guest' })
    const links = fake.links.length
    const again = await invite('tok-alice', { email: 'g@fora.com', name: 'Gil', kind: 'member' })
    expect(again.status).toBe(409)
    expect(await again.json()).toEqual({ reason: 'kind_immutable', userId: MXID, kind: 'guest' })
    expect(fake.state.get(KEY)).toEqual({ kind: 'guest', name: 'Gil', email: 'g@fora.com' })
    expect(fake.links).toHaveLength(links)
    expect(fake.invites).toEqual([])
    expect((await audit()).at(-1)).toMatchObject({
      verb: 'people.invite',
      outcome: 'conflict',
      target: MXID,
      kind: 'guest',
      reason: 'kind_immutable',
    })
  })

  it('falha no vínculo → 502 com o passo e audit partial; reexecutar completa sem conta nova', async () => {
    await start()
    fake.failing.add('POST /api/admin/v1/upstream-oauth-links')
    const res = await invite('tok-alice')
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'partial', step: 'link' })
    expect((await audit()).at(-1)).toMatchObject({
      verb: 'people.invite.partial',
      outcome: 'error',
      step: 'link',
      target: MXID,
      reason: 'add link: 500',
    })

    fake.failing.clear()
    const again = await invite('tok-alice')
    expect(again.status).toBe(201)
    expect(await again.json()).toEqual({ userId: MXID, kind: 'member', completed: ['link', 'org'] })
    expect((await audit()).at(-1)).toMatchObject({
      verb: 'people.invite',
      outcome: 'completed',
      target: MXID,
      completed: ['link', 'org'],
    })
    expect(fake.users).toHaveLength(5)
    expect(fake.links).toHaveLength(1)
    expect(fake.state.get(KEY)).toMatchObject({ kind: 'member' })
    expect(fake.invites).toEqual([MXID])
  })

  it('reexecutar sem nada faltando depois de completar → 409', async () => {
    await start()
    fake.failing.add('POST /api/admin/v1/upstream-oauth-links')
    await invite('tok-alice')
    fake.failing.clear()
    expect((await invite('tok-alice')).status).toBe(201)
    expect((await invite('tok-alice')).status).toBe(409)
    expect((await audit()).at(-1)).toMatchObject({ verb: 'people.invite', outcome: 'exists', target: MXID })
  })

  it('evento sem email (allowlist): grava o email sem trocar nome nem kind → 201 completed', async () => {
    await start()
    await invite('tok-alice')
    fake.state.set(KEY, { kind: 'member', name: 'Nome Antigo' })
    const again = await invite('tok-alice')
    expect(again.status).toBe(201)
    expect(await again.json()).toEqual({ userId: MXID, kind: 'member', completed: ['email'] })
    expect(fake.state.get(KEY)).toEqual({ kind: 'member', name: 'Nome Antigo', email: 'ana@fora.com' })
  })

  it('falha no email → conta desativada e audit compensated; reexecutar cria conta nova', async () => {
    await start()
    fake.failing.add('POST /api/admin/v1/user-emails')
    const res = await invite('tok-alice')
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'partial', step: 'email' })
    expect(fake.users.at(-1)).toMatchObject({ username: 'u-r1', deactivated: true })
    const entries = await audit()
    expect(entries.at(-2)).toMatchObject({ verb: 'people.invite.compensated', actor: 'alice', target: MXID })
    expect(entries.at(-1)).toMatchObject({ verb: 'people.invite.partial', step: 'email', target: MXID })

    fake.failing.clear()
    expect((await invite('tok-alice')).status).toBe(201)
    expect(fake.users.at(-1)?.username).toBe('u-r2')
  })

  it('falha no email e na compensação → só o partial, e a conta fica', async () => {
    await start()
    fake.failing.add('POST /api/admin/v1/user-emails')
    fake.failing.add('POST /api/admin/v1/users/U-u-r1/deactivate')
    expect((await invite('tok-alice')).status).toBe(502)
    expect(fake.users.at(-1)?.deactivated).toBeUndefined()
    const verbs = (await audit()).map((e) => e.verb)
    expect(verbs).not.toContain('people.invite.compensated')
    expect(verbs.at(-1)).toBe('people.invite.partial')
  })

  it('falha no convite → partial, a sessão é revogada e reexecutar só convida', async () => {
    await start()
    fake.failing.add(`POST /_matrix/client/v3/rooms/${ROOM}/invite`)
    expect((await invite('tok-alice')).status).toBe(502)
    expect(fake.sessions.every((s) => s.revoked)).toBe(true)
    fake.failing.clear()
    const again = await invite('tok-alice')
    expect(again.status).toBe(201)
    expect(await again.json()).toMatchObject({ completed: ['org'] })
    expect(fake.invites).toEqual([MXID])
  })

  it('429 do Synapse: espera o retry_after e conclui', async () => {
    await start()
    fake.rateLimit = 2
    expect((await invite('tok-alice')).status).toBe(201)
    expect(fake.sleeps).toEqual([1000, 1000])
  })

  it('429 além do teto de espera → partial, sem insistir', async () => {
    await start()
    fake.rateLimit = 100
    const res = await invite('tok-alice')
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'partial', step: 'org' })
    expect(fake.sleeps).toHaveLength(20)
  })

  it('o alias de #all é resolvido uma vez por boot', async () => {
    await start()
    await invite('tok-alice')
    await invite('tok-alice', { email: 'g@fora.com', name: 'Gil', kind: 'guest' })
    expect(fake.aliasCalls).toBe(1)
  })

  it.each([
    [{ email: 'a@b.c', name: 'A' }],
    [{ email: 'a@b.c', name: 'A', kind: 'admin' }],
    [{ email: 'sem-arroba', name: 'A', kind: 'member' }],
    [{ email: 'a@b.c', name: '  ', kind: 'member' }],
    [{ email: 'a@b.c', name: 'A', kind: 'member', username: 'x' }],
  ])('corpo fora do shape exato → 400: %j', async (body) => {
    await start()
    expect((await invite('tok-alice', body)).status).toBe(400)
    expect(fake.users).toHaveLength(4)
  })

  it('401 indistinguível sem token válido; 503 com o IdP fora', async () => {
    await start()
    expect((await invite()).status).toBe(401)
    expect((await invite('tok-unknown')).status).toBe(401)
    expect((await invite('tok-idp-down')).status).toBe(503)
  })

  it('MAS fora na autorização → 502 admin_unavailable', async () => {
    await start()
    fake.failing.add('GET /api/admin/v1/users/by-username/alice')
    const res = await invite('tok-alice')
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'admin_unavailable' })
  })

  it('sem o client admin as rotas não existem', async () => {
    await start({ mounted: false })
    expect((await invite('tok-alice')).status).toBe(404)
  })

  it('o audit não carrega email nem nome', async () => {
    await start()
    await invite('tok-alice')
    const raw = await readFile(join(dir, 'audit.jsonl'), 'utf8')
    for (const leak of ['ana@fora.com', 'Ana Lima', 'mpt']) expect(raw).not.toContain(leak)
  })
})

describe('imutabilidade do kind (ADR-086 dec. 4)', () => {
  // Conta existente com email e lápide gravada: o caminho em que o reconvite encontra a lápide.
  async function tombstoned(kind: 'member' | 'guest'): Promise<void> {
    await invite('tok-alice', { email: 'g@fora.com', name: 'Gil', kind })
    fake.state.set(KEY, { removed: true, kind })
  }

  it('guest → guest depois da lápide: reescreve { kind, name, email } sem removed', async () => {
    await start()
    await tombstoned('guest')
    const again = await invite('tok-alice', { email: 'g@fora.com', name: 'Gil', kind: 'guest' })
    expect(again.status).toBe(201)
    expect(await again.json()).toEqual({ userId: MXID, kind: 'guest', completed: ['org'] })
    expect(fake.state.get(KEY)).toEqual({ kind: 'guest', name: 'Gil', email: 'g@fora.com' })
    expect(fake.invites).toEqual([])
  })

  it('member → guest depois da lápide → 409 kind_immutable, a lápide fica', async () => {
    await start()
    await tombstoned('member')
    const again = await invite('tok-alice', { email: 'g@fora.com', name: 'Gil', kind: 'guest' })
    expect(again.status).toBe(409)
    expect(await again.json()).toEqual({ reason: 'kind_immutable', userId: MXID, kind: 'member' })
    expect(fake.state.get(KEY)).toEqual({ removed: true, kind: 'member' })
  })

  it('member → guest vivo → 409 kind_immutable', async () => {
    await start()
    await invite('tok-alice')
    const again = await invite('tok-alice', { email: 'ana@fora.com', name: 'Ana', kind: 'guest' })
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({ reason: 'kind_immutable', kind: 'member' })
    expect(fake.state.get(KEY)).toMatchObject({ kind: 'member' })
  })

  it('kind agent gravado numa conta achada pelo email → 409 is_agent, sem escrita', async () => {
    await start()
    await invite('tok-alice')
    fake.state.set(KEY, { kind: 'agent', name: 'Robô', operator: 'alice' })
    const again = await invite('tok-alice')
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({ reason: 'is_agent', kind: 'agent' })
    expect(fake.state.get(KEY)).toEqual({ kind: 'agent', name: 'Robô', operator: 'alice' })
    expect((await audit()).at(-1)).toMatchObject({ verb: 'people.invite', outcome: 'conflict', reason: 'is_agent' })
  })

  it('POST /v1/people com kind agent → 400, sem efeito', async () => {
    await start()
    expect((await invite('tok-alice', { email: 'a@b.c', name: 'Robô', kind: 'agent' })).status).toBe(400)
    expect(fake.users).toHaveLength(4)
    expect(fake.sessions).toEqual([])
  })

  it('DELETE /v1/people de um agente → 409 is_agent, nada desativado', async () => {
    await start()
    const agent = `@a-abcdefghijkl:${SERVER}`
    fake.users.push({ id: 'U-agent', username: 'a-abcdefghijkl' })
    const res = await remove('tok-alice', agent)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ reason: 'is_agent', userId: agent, kind: 'agent' })
    expect(fake.users.at(-1)?.deactivated).toBeUndefined()
    expect((await audit()).at(-1)).toMatchObject({ verb: 'people.remove', outcome: 'conflict', reason: 'is_agent' })
  })

  it('remover de novo preserva o kind da lápide; sem kind gravado a lápide é { removed: true }', async () => {
    await start()
    await invite('tok-alice', { email: 'g@fora.com', name: 'Gil', kind: 'guest' })
    await remove('tok-alice', MXID)
    expect((await remove('tok-alice', MXID)).status).toBe(200)
    expect(fake.state.get(KEY)).toEqual({ removed: true, kind: 'guest' })

    fake.users.push({ id: 'U-legado', username: 'legado' })
    expect((await remove('tok-alice', `@legado:${SERVER}`)).status).toBe(200)
    expect(fake.state.get(`${ME}|legado:${SERVER}`)).toEqual({ removed: true })
  })
})

describe('GET /v1/people/me', () => {
  const me = (token?: string): Promise<Response> =>
    fetch(`${base}/v1/people/me`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })

  it('admin true para o flag, false para o resto, auditado sem alvo', async () => {
    await start()
    expect(await (await me('tok-alice')).json()).toEqual({ admin: true })
    expect(await (await me('tok-bob')).json()).toEqual({ admin: false })
    expect((await audit()).at(-1)).toMatchObject({ sub: 'sub-bob', actor: 'bob', verb: 'people.me', outcome: 'ok' })
    expect((await audit()).at(-1)).not.toHaveProperty('target')
  })

  it('401 sem token; 503 com o IdP fora; 502 com o MAS fora', async () => {
    await start()
    expect((await me()).status).toBe(401)
    expect((await me('tok-idp-down')).status).toBe(503)
    fake.failing.add('GET /api/admin/v1/users/by-username/alice')
    expect((await me('tok-alice')).status).toBe(502)
    expect((await audit()).at(-1)).toMatchObject({
      verb: 'people.me',
      outcome: 'error',
      reason: 'user lookup: 500',
    })
  })

  it('o audit do erro diz o motivo: token recusado e conexão recusada', async () => {
    await start()
    fake.tokenStatus = 403
    expect((await me('tok-alice')).status).toBe(502)
    expect((await audit()).at(-1)).toMatchObject({ verb: 'people.me', outcome: 'error', reason: 'admin token: 403' })

    fake.tokenStatus = 200
    fake.refused = true
    expect((await me('tok-alice')).status).toBe(502)
    expect((await audit()).at(-1)).toMatchObject({
      verb: 'people.me',
      outcome: 'error',
      reason: 'fetch failed: ECONNREFUSED',
    })
  })

  it('o motivo cabe em 200 caracteres', () => {
    expect(errorReason(new Error('x'.repeat(300)))).toHaveLength(200)
    expect(errorReason('sem Error')).toBe('sem Error')
  })

  it('sem o client admin a rota não existe', async () => {
    await start({ mounted: false })
    expect((await me('tok-alice')).status).toBe(404)
  })
})

describe('DELETE /v1/people/:userId', () => {
  it('deactivate com skip_erase, vínculo removido, lápide com o kind, audit com actor e target', async () => {
    await start()
    await invite('tok-alice')
    const res = await remove('tok-alice', MXID)
    expect(res.status).toBe(200)
    expect(fake.users.at(-1)?.deactivated).toBe(true)
    expect(fake.links).toEqual([])
    expect(fake.state.get(KEY)).toEqual({ removed: true, kind: 'member' })
    expect(fake.sessions.every((s) => s.revoked)).toBe(true)
    expect((await audit()).at(-1)).toMatchObject({
      actor: 'alice',
      verb: 'people.remove',
      outcome: 'removed',
      target: MXID,
    })
  })

  it('reconvite depois da remoção cria conta nova', async () => {
    await start()
    await invite('tok-alice')
    await remove('tok-alice', MXID)
    expect((await invite('tok-alice')).status).toBe(201)
    expect(fake.users.at(-1)?.username).toBe('u-r2')
  })

  it('falhas do invite e do remove levam o motivo ao audit', async () => {
    await start()
    await invite('tok-alice')
    fake.refused = true
    expect((await invite('tok-alice', { email: 'b@fora.com', name: 'B', kind: 'member' })).status).toBe(502)
    expect((await audit()).at(-1)).toMatchObject({
      verb: 'people.invite',
      outcome: 'error',
      reason: 'fetch failed: ECONNREFUSED',
    })
    expect((await remove('tok-alice', MXID)).status).toBe(502)
    expect((await audit()).at(-1)).toMatchObject({
      verb: 'people.remove',
      outcome: 'error',
      reason: 'fetch failed: ECONNREFUSED',
    })

    fake.refused = false
    fake.failing.add('POST /api/admin/v1/users/U-u-r1/deactivate')
    expect((await remove('tok-alice', MXID)).status).toBe(502)
    expect((await audit()).at(-1)).toMatchObject({
      verb: 'people.remove',
      outcome: 'error',
      step: 'deactivate',
      reason: 'deactivate: 500',
    })
  })

  it('não-admin → 403', async () => {
    await start()
    await invite('tok-alice')
    expect((await remove('tok-bob', MXID)).status).toBe(403)
    expect(fake.users.at(-1)?.deactivated).toBeUndefined()
  })

  it.each([`@alice:${SERVER}`, `@system:${SERVER}`, `@cofre:${SERVER}`, '@u-r1:outro.server', 'u-r1'])(
    'alvo proibido → 400: %s',
    async (target) => {
      await start()
      expect((await remove('tok-alice', target)).status).toBe(400)
      expect(fake.users.some((u) => u.deactivated !== undefined)).toBe(false)
    },
  )

  it('alvo inexistente → 404', async () => {
    await start()
    expect((await remove('tok-alice', `@ninguem:${SERVER}`)).status).toBe(404)
  })

  it('falha depois do deactivate → 502 com o passo; repetir conclui', async () => {
    await start()
    await invite('tok-alice')
    fake.failing.add('DELETE /api/admin/v1/upstream-oauth-links/L0')
    const res = await remove('tok-alice', MXID)
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'partial', step: 'link' })
    fake.failing.clear()
    expect((await remove('tok-alice', MXID)).status).toBe(200)
    expect(fake.state.get(KEY)).toEqual({ removed: true, kind: 'member' })
  })
})

describe('reapExpiredSystemSessions', () => {
  it('encerra as vencidas de system, filtrando por ator, status e data; repetir é no-op', async () => {
    await start()
    fake.sessions.push({ id: 'expired-1', body: { actor_user_id: 'U-sys' } }, { id: 'expired-2', body: { actor_user_id: 'U-sys' } })
    const calls: string[] = []
    const fetchFn = fakeFetch(fake)
    const spied = ((input: string, init?: RequestInit) => {
      calls.push(decodeURIComponent(String(input)))
      return fetchFn(input, init)
    }) as typeof fetch
    const admin = masAdmin({
      url: 'http://mas:8081',
      tokenUrl: 'http://mas:8080/oauth2/token',
      clientId: 'id',
      clientSecret: 's',
      fetchFn: spied,
      now: () => new Date('2026-11-02T12:00:00.000Z'),
    })
    expect(await admin.reapExpiredSystemSessions()).toBe(2)
    expect(calls.find((c) => c.includes('personal-sessions?'))).toContain(
      'filter[actor_user]=U-sys&filter[status]=active&filter[expires_before]=2026-11-02T12:00:00.000Z',
    )
    expect(fake.sessions.every((s) => s.revoked)).toBe(true)
    expect(await admin.reapExpiredSystemSessions()).toBe(0)
  })

  it('sem a conta system não há o que recolher', async () => {
    await start()
    fake.users = fake.users.filter((u) => u.username !== 'system')
    const admin = masAdmin({ url: 'http://mas:8081', tokenUrl: 'http://mas:8080/oauth2/token', clientId: 'id', clientSecret: 's', fetchFn: fakeFetch(fake) })
    expect(await admin.reapExpiredSystemSessions()).toBe(0)
  })
})

describe('randomLocalpart', () => {
  it('12 caracteres base32 minúsculos', () => {
    expect(randomLocalpart()).toMatch(/^[a-z2-7]{12}$/)
  })
})
