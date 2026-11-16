import { describe, it, expect, vi } from 'vitest'
import type { Room } from 'matrix-js-sdk'
import { roomToChannel } from '@tayet/shared/internal'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import { brandChannelId, brandUserId } from '@tayet/shared/internal'
import type { AclTelemetry } from '../src/acl'
import { findProtocolLeaks } from '@tayet/shared/leak-scan'

// Unit harness do pertencimento à org (ADR-083), no idioma de client falso de auto-join-invite.test.ts:
// o estado do canal da org é o que o sync entregaria; nenhuma leitura vai à rede.

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const ME = '@me:tayet.local'
const PEER = '@peer:tayet.local'
const GUEST = '@guest:tayet.local'
const ALIAS = '#all:tayet.local'
const ORG = '!org:tayet.local'
const CHANNEL = '!channel:tayet.local'

function fakeMember(userId: string, powerLevel = 0): unknown {
  return { userId, rawDisplayName: userId.slice(1, 5), powerLevel, membership: 'join', getMxcAvatarUrl: () => null }
}

function fakeRoom(opts: {
  roomId: string
  membership: string
  alias?: string
  // state_key do io.tayet.member → conteúdo
  kinds?: Record<string, Record<string, unknown>>
  members?: unknown[]
}): unknown {
  return {
    roomId: opts.roomId,
    getMyMembership: () => opts.membership,
    getCanonicalAlias: () => opts.alias ?? null,
    getMember: () => undefined,
    getMembers: () => opts.members ?? [],
    currentState: {
      getStateEvents: (_type: string, key: string) => {
        const content = opts.kinds?.[key]
        return content ? { getContent: () => content } : null
      },
    },
  }
}

function gatewayWith(rooms: unknown[], extra: Record<string, unknown> = {}): {
  gateway: MatrixGateway
  internals: {
    joinOrgChannel: () => Promise<void>
    kindOf: (mxid: string) => string
  }
  joinRoom: ReturnType<typeof vi.fn>
  setPowerLevel: ReturnType<typeof vi.fn>
} {
  const joinRoom = vi.fn(async () => undefined)
  const setPowerLevel = vi.fn(async () => undefined)
  const fakeClient = {
    getUserId: () => ME,
    getRooms: () => rooms,
    getRoom: (id: string) => rooms.find((r) => (r as { roomId: string }).roomId === id) ?? null,
    getAccountData: () => undefined,
    joinRoom,
    setPowerLevel,
    ...extra,
  }
  const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
  ;(gateway as unknown as { client: unknown }).client = fakeClient
  return { gateway, internals: gateway as unknown as ReturnType<typeof gatewayWith>['internals'], joinRoom, setPowerLevel }
}

describe('joinOrgChannel — convite pendente (ADR-083 dec. 2)', () => {
  it('aceita o convite do canal da org, pelo id da sala e não pelo alias', async () => {
    const { internals, joinRoom } = gatewayWith([fakeRoom({ roomId: ORG, membership: 'invite', alias: ALIAS })])
    await internals.joinOrgChannel()
    expect(joinRoom).toHaveBeenCalledTimes(1)
    expect(joinRoom).toHaveBeenCalledWith(ORG)
  })

  it('sem convite não faz nada: é um guest', async () => {
    const { internals, joinRoom } = gatewayWith([fakeRoom({ roomId: CHANNEL, membership: 'join' })])
    await internals.joinOrgChannel()
    expect(joinRoom).not.toHaveBeenCalled()
  })

  it('convite de outro canal não é o canal da org', async () => {
    const { internals, joinRoom } = gatewayWith([fakeRoom({ roomId: CHANNEL, membership: 'invite' })])
    await internals.joinOrgChannel()
    expect(joinRoom).not.toHaveBeenCalled()
  })

  it('já no canal da org não há o que aceitar', async () => {
    const { internals, joinRoom } = gatewayWith([fakeRoom({ roomId: ORG, membership: 'join', alias: ALIAS })])
    await internals.joinOrgChannel()
    expect(joinRoom).not.toHaveBeenCalled()
  })
})

describe('roomToChannel — o canal da org segue público (ADR-083 dec. 2)', () => {
  it('join_rule invite + alias da org = public; sem o alias = private', () => {
    const room = (alias: string | null): unknown => ({
      ...(fakeRoom({ roomId: ORG, membership: 'join' }) as object),
      name: 'all',
      getJoinRule: () => 'invite',
      getCanonicalAlias: () => alias,
      getJoinedMemberCount: () => 1,
      getLiveTimeline: () => ({ getEvents: () => [] }),
      getUnreadNotificationCount: () => 0,
      getAvatarUrl: () => null,
      getRoomUnreadNotificationCount: () => 0,
      getLastActiveTimestamp: () => 0,
    })
    const ctx = { mode: 'strict', telemetry: noopTelemetry, isDm: () => false, orgChannelAlias: ALIAS } as const
    expect(roomToChannel(room(ALIAS) as Room, ctx).kind).toBe('public')
    expect(roomToChannel(room(null) as Room, ctx).kind).toBe('private')
    expect(roomToChannel(room(ALIAS) as Room, ctx).org).toBe(true)
    expect('org' in roomToChannel(room(null) as Room, ctx)).toBe(false)
  })
})

describe('kindOf — estado do canal da org (ADR-083 dec. 3)', () => {
  const org = (kinds: Record<string, Record<string, unknown>>): unknown =>
    fakeRoom({ roomId: ORG, membership: 'join', alias: ALIAS, kinds })

  it('lê pelo mxid sem o sigilo', () => {
    const { internals } = gatewayWith([org({ 'peer:tayet.local': { kind: 'member' } })])
    expect(internals.kindOf(PEER)).toBe('member')
  })

  it('ausência do evento = guest', () => {
    const { internals } = gatewayWith([org({ 'peer:tayet.local': { kind: 'member' } })])
    expect(internals.kindOf(GUEST)).toBe('guest')
  })

  it('evento de conteúdo vazio (remoção) = guest', () => {
    const { internals } = gatewayWith([org({ 'peer:tayet.local': {} })])
    expect(internals.kindOf(PEER)).toBe('guest')
  })

  it('fora do canal da org o operador só sabe de si: ele é guest, os outros não ganham rótulo', () => {
    const { internals } = gatewayWith([fakeRoom({ roomId: CHANNEL, membership: 'join' })])
    expect(internals.kindOf(ME)).toBe('guest')
    expect(internals.kindOf(PEER)).toBe('member')
  })

  it('convite pendente ainda não dá leitura da lista', () => {
    const { internals } = gatewayWith([
      fakeRoom({ roomId: ORG, membership: 'invite', alias: ALIAS, kinds: { 'peer:tayet.local': { kind: 'member' } } }),
    ])
    expect(internals.kindOf(ME)).toBe('guest')
    expect(internals.kindOf(PEER)).toBe('member')
  })
})

describe('getMembers — Role por kind e conta de sistema (ADR-083 dec. 4/5)', () => {
  const rooms = (): unknown[] => [
    fakeRoom({
      roomId: ORG,
      membership: 'join',
      alias: ALIAS,
      kinds: { 'me:tayet.local': { kind: 'member' }, 'peer:tayet.local': { kind: 'member' } },
      members: [fakeMember(ME), fakeMember('@system:tayet.local', 100), fakeMember('@cofre:tayet.local')],
    }),
    fakeRoom({
      roomId: CHANNEL,
      membership: 'join',
      members: [fakeMember(ME, 100), fakeMember(PEER), fakeMember(GUEST, 50)],
    }),
  ]

  it('a conta de sistema não cruza o barrel, como o cofre', () => {
    const { gateway } = gatewayWith(rooms())
    const ids = gateway.getMembers(brandChannelId(ORG)).map((m) => String(m.user.id))
    expect(ids).toEqual([ME])
  })

  it('guest é guest mesmo com power level de admin; membro segue o power level', () => {
    const { gateway } = gatewayWith(rooms())
    const roster = gateway.getMembers(brandChannelId(CHANNEL))
    const byId = new Map(roster.map((m) => [String(m.user.id), m]))
    expect(byId.get(ME)?.role).toBe('admin')
    expect(byId.get(PEER)?.role).toBe('member')
    expect(byId.get(GUEST)?.role).toBe('guest')
    expect(byId.get(GUEST)?.user.kind).toBe('guest')
  })

  it('setRole recusa promover guest, sem tocar o servidor', async () => {
    const { gateway, setPowerLevel } = gatewayWith(rooms())
    await expect(gateway.setRole(brandChannelId(CHANNEL), brandUserId(GUEST), 'admin')).rejects.toThrow()
    expect(setPowerLevel).not.toHaveBeenCalled()
  })

  it('setRole de membro segue para o servidor', async () => {
    const { gateway, setPowerLevel } = gatewayWith(rooms())
    await gateway.setRole(brandChannelId(CHANNEL), brandUserId(PEER), 'admin')
    expect(setPowerLevel).toHaveBeenCalledWith(CHANNEL, PEER, 50)
  })
})

describe('getUserProfile fora de sala comum (ADR-083 dec. 6)', () => {
  it('403 do perfil estendido resolve com o nome e sem org, sem rejeitar', async () => {
    const { gateway } = gatewayWith([], {
      getExtendedProfile: async () => {
        throw Object.assign(new Error('forbidden'), { httpStatus: 403, errcode: 'M_FORBIDDEN' })
      },
      getUser: () => ({ rawDisplayName: 'Bob Stone' }),
    })
    const profile = await gateway.getUserProfile(brandUserId(PEER))
    expect(profile.displayName).toBe('Bob Stone')
    expect(profile.org).toBeUndefined()
    expect(profile.kind).toBe('member')
    expect(findProtocolLeaks(profile)).toEqual([])
  })
})
