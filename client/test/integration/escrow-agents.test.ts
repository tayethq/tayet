// @vitest-environment jsdom
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createAcl } from '../../src/acl'
import type { Acl, AclTelemetry, ChannelId, DomainEvent } from '../../src/acl'
import { mintOidcSession } from '../support/mint-oidc'
import { orgMemberKey, orgSystemSession, ORG_MEMBER_EVENT } from '../support/org-membership'
import { ESCROW_URL } from '../support/stack-env'
import { createRoom, HOMESERVER, invite, join, synapseReachable } from '../support/synapse'
import { freshUsers, type FreshUser } from '../support/fresh-users'

// Gate de integração dos agentes (ADR-086, Proposto; fatias 2 e 3): o escrow de verdade cria o agente
// pela admin API do MAS, e a credencial devolvida é um device real — whoami, /devices, E2EE numa sala
// cifrada com uma pessoa que decifra —, o reissue troca o device (kill→mint) e o DELETE mata tudo e
// deixa a lápide em #all, sem membership. Mesmo regime do escrow-people.test.ts: `alice` é a fixture
// admin da org; o escrow é o do stack (a admin API do MAS só existe na rede do compose).
// Auto-skip sem a stack (issue #7); fileParallelism:false serializa os gates.

const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const rand = (): string => Math.random().toString(36).slice(2, 10)

async function until<T>(get: () => T | undefined | Promise<T | undefined>, timeoutMs = 120_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await get()
    if (v !== undefined) return v
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 100))
  }
}

async function client<T>(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${HOMESERVER}/_matrix/client/v3${path}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  })
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T }
}

const whoami = (token: string): Promise<{ status: number; body: { user_id?: string; device_id?: string } }> =>
  client(token, '/account/whoami')

const devicesOf = async (token: string): Promise<string[]> =>
  (await client<{ devices: Array<{ device_id: string }> }>(token, '/devices')).body.devices.map((d) => d.device_id)

// Os devices do agente com chave publicada, vistos por um terceiro (o token do agente já morreu).
const publishedDevices = async (observer: string, mxid: string): Promise<string[]> =>
  Object.keys(
    (await client<{ device_keys: Record<string, Record<string, unknown>> }>(observer, '/keys/query', {
      method: 'POST',
      body: { device_keys: { [mxid]: [] } },
    })).body.device_keys[mxid] ?? {},
  )

describe.skipIf(!SYNAPSE)('gate dos agentes — escrow /v1/agents (ADR-086 fatia 2)', () => {
  let alice: string
  let person: FreshUser
  let system: { token: string; roomId: string }
  let agent: { userId: string; name: string; token: string; deviceId: string } | undefined
  let removed = false
  const acls: Acl[] = []

  const escrow = (method: string, path: string, token: string, body?: unknown): Promise<Response> =>
    fetch(`${ESCROW_URL}/v1/agents${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })

  async function orgState(type: string, stateKey: string): Promise<Record<string, unknown> | null> {
    const path = `/rooms/${encodeURIComponent(system.roomId)}/state/${type}/${encodeURIComponent(stateKey)}`
    const res = await client<Record<string, unknown>>(system.token, path)
    if (res.status === 404) return null
    if (res.status !== 200) throw new Error(`state ${type} -> ${res.status}`)
    return res.body
  }

  async function connect(token: string, events: DomainEvent[]): Promise<Acl> {
    const acl = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    acls.push(acl)
    acl.subscribe((e) => events.push(e))
    await acl.connect(token as Parameters<Acl['connect']>[0])
    return acl
  }

  beforeAll(async () => {
    alice = (await mintOidcSession('alice', 'alicepass123')).accessToken
    ;[person] = await freshUsers(['agp'])
    system = await orgSystemSession()
  }, 120_000)

  afterAll(async () => {
    for (const acl of acls) await acl.disconnect().catch(() => undefined)
    // Agente que sobrou de uma falha no meio sai aqui: conta `a-` viva poluiria a lista Pessoas.
    if (agent !== undefined && !removed) await escrow('DELETE', `/${encodeURIComponent(agent.userId)}`, alice)
  }, 60_000)

  it('admin cria: 201 com token e device; whoami e /devices batem; #all tem o evento e nenhuma membership', async () => {
    const name = `Agente Probe ${rand()}`
    const res = await escrow('POST', '', alice, { name })
    expect(res.status).toBe(201)
    agent = (await res.json()) as NonNullable<typeof agent>
    expect(agent.userId).toMatch(/^@a-[a-z2-7]{12}:/)
    expect(agent.name).toBe(name)
    expect(agent.deviceId).toMatch(/^[A-Z0-9]{10}$/)

    const me = await whoami(agent.token)
    expect(me.status).toBe(200)
    expect(me.body).toMatchObject({ user_id: agent.userId, device_id: agent.deviceId })
    expect(await devicesOf(agent.token)).toEqual([agent.deviceId])

    // Sem `color` no pedido: areia (fatia 3).
    expect(await orgState(ORG_MEMBER_EVENT, orgMemberKey(agent.userId))).toEqual({ kind: 'agent', name, operator: 'alice', color: 'areia' })
    expect(await orgState('m.room.member', agent.userId)).toBeNull()

    // O sidecar se reconhece pelo /v1/people/me com o próprio token e aprende o operador
    // (PLANO-AGENTES §0.3.10 item 3): o mxid de alice, do mesmo servidor do agente.
    const self = await fetch(`${ESCROW_URL}/v1/people/me`, { headers: { Authorization: `Bearer ${agent.token}` } })
    const server = agent.userId.slice(agent.userId.indexOf(':'))
    expect(await self.json()).toEqual({ admin: false, kind: 'agent', operator: `@alice${server}` })

    // O mesmo nome, normalizado, colide.
    expect((await escrow('POST', '', alice, { name: `  ${name.toUpperCase()} ` })).status).toBe(409)
  }, 60_000)

  it('o agente envia numa sala cifrada e a pessoa decifra', async () => {
    const a = agent!
    const roomId = await createRoom(person.token, {
      name: `agent-e2ee-${process.pid}-${rand()}`,
      initialState: [{ type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }],
    })
    await invite(person.token, roomId, a.userId)
    await join(a.token, roomId)

    const personEvents: DomainEvent[] = []
    await connect(person.token, personEvents)
    const agentAcl = await connect(a.token, [])
    const channelId = roomId as unknown as ChannelId
    await until(async () => ((await agentAcl.getChannels()).some((c) => c.id === channelId) ? true : undefined))

    const text = `olá do ${a.deviceId}`
    await agentAcl.sendMessage(channelId, { kind: 'text', text })
    // A pessoa recebe o texto decifrado (o `kind` do autor é da fatia 1, acl-agent-kind.test.ts).
    const received = await until(() =>
      personEvents.find(
        (e): e is Extract<DomainEvent, { t: 'message.received' }> =>
          e.t === 'message.received' && e.message.body.kind === 'text' && e.message.body.text === text,
      ),
    )
    expect(received.message.mine).toBe(false)

    // O wire é cifrado: a pessoa lê o evento cru como m.room.encrypted.
    const raw = await client<{ chunk: Array<{ type: string; sender: string }> }>(
      person.token,
      `/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=10`,
    )
    expect(raw.body.chunk.find((e) => e.sender === a.userId)?.type).toBe('m.room.encrypted')

    await agentAcl.disconnect()
  }, 240_000)

  it('reissue: o device antigo some, o novo aparece; o token velho morre', async () => {
    const a = agent!
    const res = await escrow('POST', `/${encodeURIComponent(a.userId)}/reissue`, a.token)
    expect(res.status).toBe(201)
    const next = (await res.json()) as { token: string; deviceId: string }
    expect(next.deviceId).not.toBe(a.deviceId)

    expect((await whoami(a.token)).status).toBe(401)
    expect((await whoami(next.token)).body).toMatchObject({ user_id: a.userId, device_id: next.deviceId })
    expect(await devicesOf(next.token)).toEqual([next.deviceId])
    expect(await publishedDevices(person.token, a.userId)).not.toContain(a.deviceId)
    agent = { ...a, ...next }
  }, 60_000)

  // ADR-087 dec. 9: dois self-reissue em paralelo com o mesmo token não deixam duas sessões. Agente
  // próprio (o de cima já gastou a janela de 60 s do self). A segunda chamada leva 429 (esperou o mutex
  // e viu o reissue recém-concluído) ou 401 (chegou com o token já revogado); nunca um segundo 201.
  it('reissue self em paralelo: uma sessão ativa, um device', async () => {
    const created = await escrow('POST', '', alice, { name: `Agente Paralelo ${rand()}` })
    expect(created.status).toBe(201)
    const twin = (await created.json()) as { userId: string; token: string; deviceId: string }
    try {
      const path = `/${encodeURIComponent(twin.userId)}/reissue`
      const results = await Promise.all([escrow('POST', path, twin.token), escrow('POST', path, twin.token)])
      const statuses = results.map((r) => r.status)
      expect(statuses.filter((s) => s === 201)).toHaveLength(1)
      expect([429, 401]).toContain(statuses.find((s) => s !== 201))
      const next = (await results.find((r) => r.status === 201)!.json()) as { token: string; deviceId: string }

      expect(await devicesOf(next.token)).toEqual([next.deviceId])
      expect((await whoami(next.token)).body).toMatchObject({ user_id: twin.userId, device_id: next.deviceId })
      // Token velho: 401 com teto (cache de introspecção < 1 s, ADR-086 dec. 8).
      await until(async () => ((await whoami(twin.token)).status === 401 ? true : undefined), 5_000)
    } finally {
      await escrow('DELETE', `/${encodeURIComponent(twin.userId)}`, alice)
    }
  }, 60_000)

  // Fatia 3: o PATCH troca cor e nome; o displayname da conta acompanha por uma sessão curta do próprio
  // agente (sem device), e a credencial em uso continua valendo — mesmo device, nenhum device novo.
  it('PATCH: cor e nome; o displayname acompanha; a credencial em uso segue válida', async () => {
    const a = agent!
    const name = `Agente Renomeado ${rand()}`
    const before = await devicesOf(a.token)
    const res = await escrow('PATCH', `/${encodeURIComponent(a.userId)}`, alice, { name, color: 'malva' })
    expect(res.status).toBe(200)
    expect(await orgState(ORG_MEMBER_EVENT, orgMemberKey(a.userId))).toEqual({ kind: 'agent', name, operator: 'alice', color: 'malva' })
    const profile = await client<{ displayname?: string }>(person.token, `/profile/${encodeURIComponent(a.userId)}/displayname`)
    expect(profile.body.displayname).toBe(name)

    expect((await whoami(a.token)).body).toMatchObject({ user_id: a.userId, device_id: a.deviceId })
    expect(await devicesOf(a.token)).toEqual(before)

    // kind/operator não entram; nome de outro colide; não-admin é 403.
    expect((await escrow('PATCH', `/${encodeURIComponent(a.userId)}`, alice, { kind: 'member' })).status).toBe(400)
    expect((await escrow('PATCH', `/${encodeURIComponent(a.userId)}`, person.token, { color: 'ocre' })).status).toBe(403)
    agent = { ...a, name }
  }, 60_000)

  it('DELETE: whoami 401, nenhum device, lápide em #all e nenhuma membership', async () => {
    const a = agent!
    const res = await escrow('DELETE', `/${encodeURIComponent(a.userId)}`, alice)
    expect(res.status).toBe(200)
    removed = true

    expect((await whoami(a.token)).status).toBe(401)
    expect(await publishedDevices(person.token, a.userId)).toEqual([])
    expect(await orgState(ORG_MEMBER_EVENT, orgMemberKey(a.userId))).toEqual({ removed: true, kind: 'agent' })
    expect(await orgState('m.room.member', a.userId)).toBeNull()
    expect((await escrow('POST', `/${encodeURIComponent(a.userId)}/reissue`, alice)).status).toBe(404)
  }, 60_000)
})
