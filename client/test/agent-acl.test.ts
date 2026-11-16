import { describe, it, expect, vi } from 'vitest'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import { createPeopleClient, type PeopleClient } from '../src/acl/internal/escrow-client'
import { brandChannelId, brandUserId } from '@tayet/shared/internal'
import { NameInUseError, PeopleUnavailableError } from '../src/acl'
import type { AclTelemetry } from '../src/acl'
import { findProtocolLeaks } from '@tayet/shared/leak-scan'

// Fatia 3 (ADR-086 Proposto dec. 1/3/6; PLANO-AGENTES §0.1 items 5 and 7): the agent's colour and
// operator read by the ACL, the guest fallback, the DM's peerAgent, the four verbs over the escrow
// client (shape on the wire) and the nickname refusal. Same fake-client idiom as agent-kind.test.ts:
// the state is what the sync would deliver; no read goes to the network.

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const ME = '@me:tayet.local'
const OPERATOR = '@u-operadorxyz2:tayet.local'
const AGENT = '@a-abcdefgh2345:tayet.local'
const ALIAS = '#all:tayet.local'
const ORG = '!org:tayet.local'
const CHANNEL = '!channel:tayet.local'
const DM = '!dm:tayet.local'

interface FakeMember {
  userId: string
  rawDisplayName: string
  membership: string
  powerLevel: number
  getMxcAvatarUrl: () => null
}
const member = (userId: string, rawDisplayName: string): FakeMember => ({
  userId,
  rawDisplayName,
  membership: 'join',
  powerLevel: 0,
  getMxcAvatarUrl: () => null,
})

function fakeRoom(opts: {
  roomId: string
  membership?: string
  alias?: string
  state?: Record<string, Record<string, unknown>>
  members?: FakeMember[]
}): unknown {
  const ev = (key: string, content: Record<string, unknown>) => ({ getStateKey: () => key, getContent: () => content })
  const members = opts.members ?? []
  return {
    roomId: opts.roomId,
    myUserId: ME,
    getMyMembership: () => opts.membership ?? 'join',
    getCanonicalAlias: () => opts.alias ?? null,
    getJoinRule: () => 'invite',
    isSpaceRoom: () => false,
    getMember: (id: string) => members.find((m) => m.userId === id) ?? null,
    getMembers: () => members,
    getJoinedMembers: () => members.filter((m) => m.membership === 'join'),
    getJoinedMemberCount: () => members.length,
    getUnfilteredTimelineSet: () => ({ getTimelines: () => [] }),
    getThreads: () => [],
    hasEncryptionStateEvent: () => false,
    getUnreadNotificationCount: () => 0,
    currentState: {
      getStateEvents: (type: string, key?: string) => {
        if (type !== 'io.tayet.member') return key === undefined ? [] : null
        const state = opts.state ?? {}
        if (key === undefined) return Object.entries(state).map(([k, c]) => ev(k, c))
        return state[key] ? ev(key, state[key]) : null
      },
    },
  }
}

function gatewayWith(rooms: unknown[], extra: Record<string, unknown> = {}) {
  const setDisplayName = vi.fn(async () => ({}))
  const setAccountData = vi.fn(async () => ({}))
  const client = {
    getUserId: () => ME,
    getRooms: () => rooms,
    getRoom: (id: string) => rooms.find((r) => (r as { roomId: string }).roomId === id) ?? null,
    getAccountData: () => undefined,
    getUser: () => ({ rawDisplayName: 'Eu' }),
    getProfileInfo: async () => ({ displayname: 'Eu' }),
    setAccountData,
    setDisplayName,
    ...extra,
  }
  const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
  ;(gateway as unknown as { client: unknown }).client = client
  return { gateway, setDisplayName, setAccountData }
}

const withPeople = (gateway: MatrixGateway, people: Partial<PeopleClient>): MatrixGateway => {
  ;(gateway as unknown as { people: Partial<PeopleClient> }).people = people
  return gateway
}

const org = (state: Record<string, Record<string, unknown>>, members: FakeMember[] = []) =>
  fakeRoom({ roomId: ORG, alias: ALIAS, state, members })

const AGENT_EVENT = { kind: 'agent', name: 'Relatórios', operator: 'u-operadorxyz2', color: 'malva' }

describe('cor e operador do agente (ADR-086 dec. 1/3)', () => {
  it('com #all: cor gravada e o nome vivo do operador; pessoa não ganha campos de agente', () => {
    const { gateway } = gatewayWith([
      org(
        { 'a-abcdefgh2345:tayet.local': AGENT_EVENT, 'u-operadorxyz2:tayet.local': { kind: 'member', name: 'Ana (digitado)' } },
        [member(ME, 'Eu'), member(OPERATOR, 'Ana Lima')],
      ),
      fakeRoom({ roomId: CHANNEL, members: [member(ME, 'Eu'), member(AGENT, 'Relatórios'), member(OPERATOR, 'Ana Lima')] }),
    ])
    const roster = gateway.getMembers(brandChannelId(CHANNEL))
    const agent = roster.find((m) => String(m.user.id) === AGENT)!.user
    expect(agent).toMatchObject({ kind: 'agent', agentColor: 'malva', operatorName: 'Ana Lima' })
    const person = roster.find((m) => String(m.user.id) === OPERATOR)!.user
    expect('agentColor' in person || 'operatorName' in person).toBe(false)
    const listed = gateway.listPeople().find((p) => String(p.user.id) === AGENT)!
    expect(listed.user).toMatchObject({ agentColor: 'malva', operatorName: 'Ana Lima' })
    expect(findProtocolLeaks(roster)).toEqual([])
  })

  it('operador sem membro vivo: o nome digitado; sem nome nenhum: ausente (nunca o localpart)', () => {
    const typed = gatewayWith([org({ 'a-abcdefgh2345:tayet.local': AGENT_EVENT, 'u-operadorxyz2:tayet.local': { kind: 'member', name: 'Ana Digitada' } })])
    expect(typed.gateway.listPeople()[0]!.user.operatorName).toBe('Ana Digitada')
    const none = gatewayWith([org({ 'a-abcdefgh2345:tayet.local': AGENT_EVENT })])
    const user = none.gateway.listPeople()[0]!.user
    expect(user.operatorName).toBeUndefined()
    expect(findProtocolLeaks(user)).toEqual([])
  })

  it('cor desconhecida ou ausente → areia', () => {
    for (const color of ['azul', undefined]) {
      const { gateway } = gatewayWith([org({ 'a-abcdefgh2345:tayet.local': { ...AGENT_EVENT, color } })])
      expect(gateway.listPeople()[0]!.user.agentColor).toBe('areia')
    }
  })

  it('sessão guest (sem #all): a marca segue, cor areia e operador ausente (§0.1 item 5)', () => {
    const { gateway } = gatewayWith([fakeRoom({ roomId: CHANNEL, members: [member(ME, 'Eu'), member(AGENT, 'Relatórios')] })])
    const agent = gateway.getMembers(brandChannelId(CHANNEL)).find((m) => String(m.user.id) === AGENT)!.user
    expect(agent).toMatchObject({ kind: 'agent', agentColor: 'areia' })
    expect(agent.operatorName).toBeUndefined()
  })

  it('DM com agente: Channel.peerAgent; DM com pessoa: sem o campo', () => {
    const rooms = [
      org({ 'a-abcdefgh2345:tayet.local': AGENT_EVENT }, [member(OPERATOR, 'Ana Lima')]),
      fakeRoom({ roomId: DM, members: [member(ME, 'Eu'), member(AGENT, 'Relatórios')] }),
      fakeRoom({ roomId: '!dm2:tayet.local', members: [member(ME, 'Eu'), member(OPERATOR, 'Ana Lima')] }),
    ]
    const direct = { [AGENT]: [DM], [OPERATOR]: ['!dm2:tayet.local'] }
    const { gateway } = gatewayWith(rooms, {
      getAccountData: (type: string) => (type === 'm.direct' ? { getContent: () => direct } : undefined),
    })
    const withAgent = gateway.getChannel(brandChannelId(DM))
    expect(withAgent.kind).toBe('dm')
    expect(withAgent.peerAgent).toEqual({ color: 'malva', operatorName: 'Ana Lima' })
    expect('peerAgent' in gateway.getChannel(brandChannelId('!dm2:tayet.local'))).toBe(false)
  })
})

describe('verbos de agente sobre o escrow (shape no fio)', () => {
  const answering = (status: number, body: unknown = {}) => {
    const seen: Array<{ url: string; method: string; body?: unknown }> = []
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen.push({ url, method: init.method!, ...(init.body ? { body: JSON.parse(init.body as string) as unknown } : {}) })
      return new Response(JSON.stringify(body), { status })
    }) as typeof fetch
    return { client: createPeopleClient({ baseUrl: 'http://escrow.test/', token: 'tok', fetchFn }), seen }
  }

  it('createAgent: POST /v1/agents { name, color } → { userId, token }', async () => {
    const { client, seen } = answering(201, { userId: AGENT, name: 'R', color: 'ocre', token: 'mpt_x', deviceId: 'D' })
    const { gateway } = gatewayWith([])
    const made = await withPeople(gateway, client).createAgent('R', 'ocre')
    expect(seen).toEqual([{ url: 'http://escrow.test/v1/agents', method: 'POST', body: { name: 'R', color: 'ocre' } }])
    expect(made).toEqual({ userId: brandUserId(AGENT), token: 'mpt_x' })
  })

  it('createAgent: 409 → NameInUseError; 502 → PeopleUnavailableError; sem escrow → indisponível', async () => {
    await expect(withPeople(gatewayWith([]).gateway, answering(409).client).createAgent('R', 'areia')).rejects.toBeInstanceOf(NameInUseError)
    await expect(withPeople(gatewayWith([]).gateway, answering(502).client).createAgent('R', 'areia')).rejects.toBeInstanceOf(
      PeopleUnavailableError,
    )
    await expect(gatewayWith([]).gateway.createAgent('R', 'areia')).rejects.toBeInstanceOf(PeopleUnavailableError)
  })

  it('updateAgent: PATCH com o id codificado e só o patch; 409 → NameInUseError', async () => {
    const { client, seen } = answering(200)
    await withPeople(gatewayWith([]).gateway, client).updateAgent(brandUserId(AGENT), { color: 'barro' })
    expect(seen).toEqual([{ url: `http://escrow.test/v1/agents/${encodeURIComponent(AGENT)}`, method: 'PATCH', body: { color: 'barro' } }])
    await expect(withPeople(gatewayWith([]).gateway, answering(409).client).updateAgent(brandUserId(AGENT), { name: 'X' })).rejects.toBeInstanceOf(
      NameInUseError,
    )
  })

  it('reissueAgent: POST …/reissue sem corpo → { token }; removeAgent: DELETE', async () => {
    const reissue = answering(201, { token: 'mpt_y', deviceId: 'E' })
    expect(await withPeople(gatewayWith([]).gateway, reissue.client).reissueAgent(brandUserId(AGENT))).toEqual({ token: 'mpt_y' })
    expect(reissue.seen).toEqual([{ url: `http://escrow.test/v1/agents/${encodeURIComponent(AGENT)}/reissue`, method: 'POST' }])
    const remove = answering(200, { removed: true })
    await withPeople(gatewayWith([]).gateway, remove.client).removeAgent(brandUserId(AGENT))
    expect(remove.seen).toEqual([{ url: `http://escrow.test/v1/agents/${encodeURIComponent(AGENT)}`, method: 'DELETE' }])
    await expect(withPeople(gatewayWith([]).gateway, answering(502).client).removeAgent(brandUserId(AGENT))).rejects.toBeInstanceOf(
      PeopleUnavailableError,
    )
  })

  it('201 sem token é indisponível (o token nunca é inventado)', async () => {
    await expect(withPeople(gatewayWith([]).gateway, answering(201, { userId: AGENT }).client).createAgent('R', 'areia')).rejects.toBeInstanceOf(
      PeopleUnavailableError,
    )
  })
})

describe('updateMyProfile recusa apelido de agente (ADR-086 dec. 6, UX)', () => {
  const rooms = () => [
    org({ 'a-abcdefgh2345:tayet.local': AGENT_EVENT, 'a-zzzzzzzzzzzz:tayet.local': { removed: true, kind: 'agent', name: 'Antigo' } }),
    fakeRoom({ roomId: CHANNEL, members: [member(ME, 'Eu'), member('@a-qqqqqqqqqqqq:tayet.local', 'Ajudante')] }),
  ]

  it.each(['Relatórios', '  relatorios ', 'RELATÓRIOS', 'Ajudante'])('"%s" → NameInUseError antes de qualquer escrita', async (nickname) => {
    const { gateway, setDisplayName, setAccountData } = gatewayWith(rooms())
    await expect(gateway.updateMyProfile({ nickname })).rejects.toBeInstanceOf(NameInUseError)
    expect(setDisplayName).not.toHaveBeenCalled()
    expect(setAccountData).not.toHaveBeenCalled()
  })

  it('nome de lápide, nome de pessoa e limpar o apelido passam', async () => {
    for (const nickname of ['Antigo', 'Eu', '']) {
      const { gateway, setDisplayName } = gatewayWith(rooms())
      await gateway.updateMyProfile({ nickname })
      expect(setDisplayName).toHaveBeenCalled()
    }
  })
})
