import { describe, it, expect, vi } from 'vitest'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import { roleOf } from '@tayet/shared/internal'
import { brandChannelId, brandUserId } from '@tayet/shared/internal'
import type { AclTelemetry, UserKind } from '../src/acl'

// Unit harness do `kind: 'agent'` (ADR-086, Proposto, dec. 2/4/5): o prefixo reservado `a-` vence o
// state de #all e é lido por qualquer sessão, guest incluída. Mesmo idioma de client falso de
// org-membership.test.ts: o estado é o que o sync entregaria; nenhuma leitura vai à rede.

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const ME = '@me:tayet.local'
const PEER = '@peer:tayet.local'
const AGENT = '@a-abcdefgh2345:tayet.local'
const CUSTODIAN = '@cofre:tayet.local'
const SYSTEM = '@system:tayet.local'
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
  const stateEvent = (key: string, content: Record<string, unknown>): unknown => ({
    getStateKey: () => key,
    getContent: () => content,
  })
  return {
    roomId: opts.roomId,
    getMyMembership: () => opts.membership,
    getCanonicalAlias: () => opts.alias ?? null,
    getMember: () => null,
    getMembers: () => opts.members ?? [],
    currentState: {
      getStateEvents: (_type: string, key?: string) => {
        const kinds = opts.kinds ?? {}
        if (key === undefined) return Object.entries(kinds).map(([k, c]) => stateEvent(k, c))
        const content = kinds[key]
        return content ? stateEvent(key, content) : null
      },
    },
  }
}

function gatewayWith(rooms: unknown[]): {
  gateway: MatrixGateway
  kindOf: (mxid: string) => UserKind
  setPowerLevel: ReturnType<typeof vi.fn>
} {
  const setPowerLevel = vi.fn(async () => undefined)
  const fakeClient = {
    getUserId: () => ME,
    getRooms: () => rooms,
    getRoom: (id: string) => rooms.find((r) => (r as { roomId: string }).roomId === id) ?? null,
    getAccountData: () => undefined,
    setPowerLevel,
  }
  const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
  ;(gateway as unknown as { client: unknown }).client = fakeClient
  const internals = gateway as unknown as { kindOf: (mxid: string) => UserKind }
  return { gateway, kindOf: (mxid) => internals.kindOf(mxid), setPowerLevel }
}

const org = (kinds: Record<string, Record<string, unknown>>, members: unknown[] = []): unknown =>
  fakeRoom({ roomId: ORG, membership: 'join', alias: ALIAS, kinds, members })

describe('kindOf — prefixo reservado de agente (ADR-086 dec. 2)', () => {
  it('com #all: o prefixo vence o state, qualquer que seja o kind gravado', () => {
    const { kindOf } = gatewayWith([org({ 'a-abcdefgh2345:tayet.local': { kind: 'member' } })])
    expect(kindOf(AGENT)).toBe('agent')
  })

  it('com #all e sem state para o agente: agente, não guest', () => {
    const { kindOf } = gatewayWith([org({ 'peer:tayet.local': { kind: 'member' } })])
    expect(kindOf(AGENT)).toBe('agent')
    expect(kindOf(PEER)).toBe('member')
  })

  it('sessão guest (sem #all): o agente é agente; os outros seguem lidos como member', () => {
    const { kindOf } = gatewayWith([fakeRoom({ roomId: CHANNEL, membership: 'join' })])
    expect(kindOf(AGENT)).toBe('agent')
    expect(kindOf(PEER)).toBe('member')
    expect(kindOf(ME)).toBe('guest')
  })

  it.each([
    '@a-abcdefgh234:tayet.local', // 11
    '@a-abcdefgh23456:tayet.local', // 13
    '@a-abcdefgh2301:tayet.local', // 0/1 fora do base32
    '@A-ABCDEFGH2345:tayet.local', // maiúsculas
    '@xa-abcdefgh2345:tayet.local', // prefixo não ancorado
    '@u-abcdefgh2345:tayet.local', // provisionado (ADR-083)
  ])('não é agente: %s', (mxid) => {
    const { kindOf } = gatewayWith([fakeRoom({ roomId: CHANNEL, membership: 'join' })])
    expect(kindOf(mxid)).not.toBe('agent')
  })
})

describe('lápide (ADR-086 dec. 4) — `removed: true` é ausência', () => {
  it('kindOf: lápide de member lê guest', () => {
    const { kindOf } = gatewayWith([org({ 'peer:tayet.local': { removed: true, kind: 'member' } })])
    expect(kindOf(PEER)).toBe('guest')
  })

  it('listPeople: lápide não lista', () => {
    const { gateway } = gatewayWith([
      org({
        'peer:tayet.local': { removed: true, kind: 'member' },
        'a-abcdefgh2345:tayet.local': { removed: true, kind: 'agent' },
      }),
    ])
    expect(gateway.listPeople()).toEqual([])
  })
})

describe('roleOf — exaustivo (ADR-086 dec. 5)', () => {
  it.each<[UserKind, number, string]>([
    ['member', 0, 'member'],
    ['member', 50, 'admin'],
    ['guest', 100, 'guest'],
    ['agent', 0, 'member'],
    ['agent', 100, 'member'],
  ])('%s com PL %i → %s', (kind, pl, role) => {
    expect(roleOf(pl, kind)).toBe(role)
  })
})

describe('getMembers e setRole — agente nunca é admin (ADR-086 dec. 5)', () => {
  const rooms = (): unknown[] => [
    org({ 'me:tayet.local': { kind: 'member' }, 'peer:tayet.local': { kind: 'member' } }),
    fakeRoom({ roomId: CHANNEL, membership: 'join', members: [fakeMember(ME, 100), fakeMember(AGENT, 100)] }),
  ]

  it('no roster, agente com PL de dono é member e kind agent', () => {
    const { gateway } = gatewayWith(rooms())
    const agent = gateway.getMembers(brandChannelId(CHANNEL)).find((m) => String(m.user.id) === AGENT)
    expect(agent?.role).toBe('member')
    expect(agent?.user.kind).toBe('agent')
  })

  it('setRole recusa promover agente, sem tocar o servidor', async () => {
    const { gateway, setPowerLevel } = gatewayWith(rooms())
    await expect(gateway.setRole(brandChannelId(CHANNEL), brandUserId(AGENT), 'admin')).rejects.toThrow(
      'Cannot promote an agent',
    )
    expect(setPowerLevel).not.toHaveBeenCalled()
  })

  it('setRole rebaixar agente para member segue para o servidor', async () => {
    const { gateway, setPowerLevel } = gatewayWith(rooms())
    await gateway.setRole(brandChannelId(CHANNEL), brandUserId(AGENT), 'member')
    expect(setPowerLevel).toHaveBeenCalledWith(CHANNEL, AGENT, 0)
  })
})

describe('listPeople — inclui agente, exclui custodian e system (ADR-086 dec. 3)', () => {
  it('agente com io.tayet.member entra; cofre e system não, mesmo marcados', () => {
    const { gateway } = gatewayWith([
      org({
        'peer:tayet.local': { kind: 'member', name: 'Ana' },
        'a-abcdefgh2345:tayet.local': { kind: 'agent', name: 'Relatórios', operator: 'peer' },
        'cofre:tayet.local': { kind: 'member' },
        'system:tayet.local': { kind: 'agent' },
      }),
    ])
    const people = gateway.listPeople()
    const byId = new Map(people.map((p) => [String(p.user.id), p]))
    expect([...byId.keys()].sort()).toEqual([AGENT, PEER].sort())
    expect(byId.get(AGENT)?.user.kind).toBe('agent')
    expect(byId.get(AGENT)?.user.displayName).toBe('Relatórios')
    expect(byId.has(CUSTODIAN)).toBe(false)
    expect(byId.has(SYSTEM)).toBe(false)
  })

  it('o prefixo é a única fonte de agent: state member num `a-` lê agent; state agent fora do prefixo não lista', () => {
    const { gateway } = gatewayWith([
      org({
        'a-abcdefgh2345:tayet.local': { kind: 'member', name: 'Relatórios' },
        'peer:tayet.local': { kind: 'agent', name: 'Ana' },
      }),
    ])
    const people = gateway.listPeople()
    expect(people.map((p) => [String(p.user.id), p.user.kind])).toEqual([[AGENT, 'agent']])
  })
})
