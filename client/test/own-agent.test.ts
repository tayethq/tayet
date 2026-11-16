import { describe, it, expect, vi } from 'vitest'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import { brandChannelId, brandUserId } from '@tayet/shared/internal'
import type { AclTelemetry } from '../src/acl'
import { findProtocolLeaks } from '@tayet/shared/leak-scan'

// Operador 2 (ADR-090 Proposto dec. 3/4; PLANO-AGENTES §0.3.10): the agents this session operates
// (listOwnAgents) and the ACL backstop on addMember / openDirectMessage / createChannel. Same
// fake-client idiom as agent-acl.test.ts: the state is what the sync would deliver.

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const ME = '@u-operadorxyz2:tayet.local'
const OTHER_OPERATOR = '@u-outraoperad2:tayet.local'
const PEER = '@peer:tayet.local'
const MINE = '@a-abcdefgh2345:tayet.local'
const MINE_2 = '@a-bbbbbbbb2345:tayet.local'
const THEIRS = '@a-zzzzzzzz2345:tayet.local'
const ALIAS = '#all:tayet.local'
const ORG = '!org:tayet.local'
const CHANNEL = '!channel:tayet.local'

const member = (userId: string, rawDisplayName: string) => ({
  userId,
  rawDisplayName,
  membership: 'join',
  powerLevel: 0,
  getMxcAvatarUrl: () => null,
})
type FakeMember = ReturnType<typeof member>

function fakeRoom(opts: { roomId: string; alias?: string; state?: Record<string, Record<string, unknown>>; members?: FakeMember[] }): unknown {
  const ev = (key: string, content: Record<string, unknown>) => ({ getStateKey: () => key, getContent: () => content })
  const members = opts.members ?? []
  return {
    roomId: opts.roomId,
    myUserId: ME,
    getMyMembership: () => 'join',
    getCanonicalAlias: () => opts.alias ?? null,
    getMember: (id: string) => members.find((m) => m.userId === id) ?? null,
    getMembers: () => members,
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

function gatewayWith(rooms: unknown[]) {
  const invite = vi.fn(async () => ({}))
  const createRoom = vi.fn(async () => ({ room_id: '!new:tayet.local' }))
  const client = {
    getUserId: () => ME,
    getRooms: () => rooms,
    getRoom: (id: string) => rooms.find((r) => (r as { roomId: string }).roomId === id) ?? null,
    getAccountData: () => undefined,
    setAccountData: vi.fn(async () => ({})),
    invite,
    createRoom,
  }
  const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
  ;(gateway as unknown as { client: unknown }).client = client
  // The structural recipient (ADR-057) is infra; stub it so createRoom/invite counts are about the target.
  ;(gateway as unknown as { inviteCustodian: () => Promise<void> }).inviteCustodian = async () => {}
  return { gateway, invite, createRoom }
}

const agentEvent = (name: string, operator: string, extra: Record<string, unknown> = {}) => ({
  kind: 'agent',
  name,
  operator,
  color: 'ardosia',
  ...extra,
})

const ORG_STATE = {
  'a-abcdefgh2345:tayet.local': agentEvent('Relatórios', 'u-operadorxyz2'),
  'a-bbbbbbbb2345:tayet.local': agentEvent('Agenda', 'u-operadorxyz2'),
  'a-zzzzzzzz2345:tayet.local': agentEvent('Alheio', 'u-outraoperad2'),
  'u-operadorxyz2:tayet.local': { kind: 'member', name: 'Rae' },
  'u-outraoperad2:tayet.local': { kind: 'member', name: 'Outra' },
  'peer:tayet.local': { kind: 'member', name: 'Peer' },
}
const org = (state: Record<string, Record<string, unknown>> = ORG_STATE) =>
  fakeRoom({ roomId: ORG, alias: ALIAS, state, members: [member(ME, 'Rae'), member(OTHER_OPERATOR, 'Outra')] })

describe('listOwnAgents (ADR-090 dec. 3)', () => {
  it('meus agentes: listados como agente, com cor e operatorName, ordenados por nome', () => {
    const { gateway } = gatewayWith([org()])
    const own = gateway.listOwnAgents()
    expect(own.map((u) => u.id)).toEqual([brandUserId(MINE_2), brandUserId(MINE)])
    expect(own[1]).toMatchObject({ displayName: 'Relatórios', kind: 'agent', agentColor: 'ardosia', operatorName: 'Rae' })
  })

  it('agente de outro operador e pessoas: fora', () => {
    const ids = gatewayWith([org()]).gateway.listOwnAgents().map((u) => u.id)
    expect(ids).not.toContain(brandUserId(THEIRS))
    expect(ids).not.toContain(brandUserId(PEER))
  })

  it('lápide: fora', () => {
    const { gateway } = gatewayWith([
      org({ ...ORG_STATE, 'a-abcdefgh2345:tayet.local': agentEvent('Relatórios', 'u-operadorxyz2', { removed: true }) }),
    ])
    expect(gateway.listOwnAgents().map((u) => u.id)).toEqual([brandUserId(MINE_2)])
  })

  it('sem #all (convidado): [] — fail-closed', () => {
    const { gateway } = gatewayWith([fakeRoom({ roomId: CHANNEL, members: [member(ME, 'Rae'), member(MINE, 'Relatórios')] })])
    expect(gateway.listOwnAgents()).toEqual([])
  })

  it('o localpart do operador não cruza: nenhum campo com ele, leak-scan limpo', () => {
    const own = gatewayWith([org()]).gateway.listOwnAgents()
    expect(JSON.stringify(own)).not.toContain('u-operadorxyz2')
    expect(findProtocolLeaks(own)).toEqual([])
    const allowed = new Set(['id', 'displayName', 'kind', 'agentColor', 'operatorName', 'avatar'])
    for (const u of own) for (const k of Object.keys(u)) expect(allowed.has(k)).toBe(true)
  })
})

describe('backstop da ACL (ADR-090 dec. 4)', () => {
  const channel = brandChannelId(CHANNEL)

  it('addMember: agente alheio → throw, invite não chamado; meu agente e pessoa → passam', async () => {
    const { gateway, invite } = gatewayWith([org()])
    await expect(gateway.addMember(channel, brandUserId(THEIRS))).rejects.toThrow(/operator/)
    expect(invite).not.toHaveBeenCalled()
    await gateway.addMember(channel, brandUserId(MINE))
    await gateway.addMember(channel, brandUserId(PEER))
    expect(invite).toHaveBeenCalledTimes(2)
  })

  it('openDirectMessage: agente alheio → throw, createRoom não chamado; meu agente e pessoa → passam', async () => {
    const { gateway, createRoom } = gatewayWith([org()])
    await expect(gateway.openDirectMessage(brandUserId(THEIRS))).rejects.toThrow(/operator/)
    expect(createRoom).not.toHaveBeenCalled()
    await gateway.openDirectMessage(brandUserId(MINE))
    await gateway.openDirectMessage(brandUserId(PEER))
    expect(createRoom).toHaveBeenCalledTimes(2)
  })

  it('createChannel: qualquer membro agente alheio → throw ANTES do createRoom; meu agente e pessoa → passam', async () => {
    const { gateway, createRoom } = gatewayWith([org()])
    await expect(
      gateway.createChannel({ name: 'x', kind: 'private', members: [brandUserId(PEER), brandUserId(THEIRS)] }),
    ).rejects.toThrow(/operator/)
    expect(createRoom).not.toHaveBeenCalled()
    await gateway.createChannel({ name: 'y', kind: 'private', members: [brandUserId(PEER), brandUserId(MINE)] })
    expect(createRoom).toHaveBeenCalledTimes(1)
  })

  it('sem #all (convidado): todo agente é alheio; pessoa passa', async () => {
    const { gateway, invite } = gatewayWith([fakeRoom({ roomId: CHANNEL })])
    await expect(gateway.addMember(channel, brandUserId(MINE))).rejects.toThrow(/operator/)
    await gateway.addMember(channel, brandUserId(PEER))
    expect(invite).toHaveBeenCalledTimes(1)
  })
})
