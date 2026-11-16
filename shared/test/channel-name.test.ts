import { describe, it, expect } from 'vitest'
import type { Room } from 'matrix-js-sdk'
import { roomToChannel } from '../src/internal'
import type { AclTelemetry } from '../src'
import type { Ctx } from '../src/internal'
import { findProtocolLeaks } from '../src/leak-scan'

// Unit do sintoma (PLANO-PRESENCA §8.5/§8.6 item 5): no ÚLTIMO fallback de nome de uma DM
// (sem outro membro joined, sem member do peer), o sigilo `@` e o `:server` não podem vazar pro
// Channel.name. O caminho não-DM ('#' + name) fica intacto.
//
// ADR-094 dec. 4 / PLANO-CONVERSAS §0.3.1 item 5: uma sala sem nome autorado nunca usa o nome que o SDK
// calcula (`room.name`, em inglês e com o id quando falta perfil); deriva das pessoas em join/invite, sem a
// própria sessão, a custódia e a conta de sistema. Sem mais ninguém: nome vazio.

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const ME = '@me:server'
const CUSTODIAN = '@cofre:server'
const SYSTEM = '@system:server'
const MARKER = 'io.tayet.conversation'

interface FakeMember {
  userId: string
  rawDisplayName?: string
  membership: string
  getMxcAvatarUrl?: () => string | undefined
}

function fakeRoom(opts: {
  name?: string
  authored?: string
  members?: FakeMember[]
  marker?: unknown
  joinRule?: string
  alias?: string | null
}): Room {
  const members = opts.members ?? []
  const state: Record<string, unknown> = {}
  if (opts.authored !== undefined) state['m.room.name'] = { getContent: () => ({ name: opts.authored }) }
  if (opts.marker !== undefined) state[MARKER] = { getContent: () => opts.marker }
  return {
    roomId: '!r:server',
    name: opts.name ?? 'Empty room',
    myUserId: ME,
    getJoinRule: () => opts.joinRule ?? 'invite',
    getCanonicalAlias: () => opts.alias ?? null,
    getMembers: () => members,
    getJoinedMembers: () => members.filter((m) => m.membership === 'join'),
    getMember: (id: string) => members.find((m) => m.userId === id) ?? null,
    getJoinedMemberCount: () => members.filter((m) => m.membership === 'join').length,
    hasEncryptionStateEvent: () => false,
    currentState: { getStateEvents: (type: string, key: string) => (key === '' ? (state[type] ?? null) : null) },
  } as unknown as Room
}

function ctx(isDm: boolean, extra: Partial<Ctx> = {}): Ctx {
  return { mode: 'strict', telemetry: noopTelemetry, isDm: () => isDm, ...extra }
}

const infra: Partial<Ctx> = { custodian: CUSTODIAN, systemAccount: SYSTEM, orgChannelAlias: '#all:server' }
const member = (userId: string, rawDisplayName: string, membership = 'join'): FakeMember => ({
  userId,
  rawDisplayName,
  membership,
  getMxcAvatarUrl: () => undefined,
})
const me = member(ME, 'Eu')
const people = (n: number): FakeMember[] =>
  Array.from({ length: n }, (_, i) => member(`@p${i}:server`, `Pessoa ${String.fromCharCode(72 - i)}`))

describe('roomToChannel — nome no último fallback de DM (§8.6 item 5)', () => {
  it('DM sem outro membro nem par conhecido → nome vazio, sem `@` nem `:server` (nunca o nome do SDK)', () => {
    const c = roomToChannel(fakeRoom({ name: '@user:server', members: [me] }), ctx(true))
    expect(c.name).toBe('')
    expect(findProtocolLeaks(c)).toEqual([])
  })

  it("não-DM com nome autorado segue '#' + nome limpo, intacto", () => {
    expect(roomToChannel(fakeRoom({ authored: 'general' }), ctx(false)).name).toBe('#general')
    expect(roomToChannel(fakeRoom({ authored: '#general' }), ctx(false)).name).toBe('#general')
  })
})

describe('roomToChannel — sala sem nome autorado (ADR-094 dec. 4; PLANO-CONVERSAS §0.3.1 item 5)', () => {
  it('sem custódia no ctx: não usa o nome calculado pelo SDK, deriva das pessoas', () => {
    const room = fakeRoom({ name: 'Bob and 2 others', members: [me, member('@bob:server', 'Bob'), member('@ana:server', 'Ana', 'invite')] })
    expect(roomToChannel(room, ctx(false)).name).toBe('#Ana, Bob')
  })

  it('a custódia e a conta de sistema ficam fora, mesmo sem registro de membro da custódia', () => {
    const room = fakeRoom({ members: [me, member('@bob:server', 'Bob'), member(SYSTEM, 'system')] })
    expect(roomToChannel(room, ctx(false, infra)).name).toBe('#Bob')
  })

  it('sozinho na sala → nome vazio', () => {
    expect(roomToChannel(fakeRoom({ name: 'Empty room', members: [me] }), ctx(false)).name).toBe('#')
  })
})

describe('roomToChannel — conversa em grupo (ADR-094 dec. 1 a 4)', () => {
  const group = { kind: 'group' }

  it('grupo com 2 pessoas: kind group, nome sem `#` separado por vírgula, participants da mesma lista', () => {
    const room = fakeRoom({ members: [me, member('@bob:server', 'Bob'), member('@ana:server', 'Ana')], marker: group })
    const c = roomToChannel(room, ctx(false, infra))
    expect(c.kind).toBe('group')
    expect(c.name).toBe('Ana, Bob')
    expect(c.participants).toEqual(['@ana:server', '@bob:server'])
    expect('peer' in c).toBe(false)
    expect(c.memberCount).toBe(3)
    expect(findProtocolLeaks(c)).toEqual([])
  })

  it('grupo com 8 pessoas: todas no nome e em participants, em ordem de nome', () => {
    const others = people(8)
    const c = roomToChannel(fakeRoom({ members: [me, ...others], marker: group }), ctx(false, infra))
    const sorted = [...others].sort((a, b) => a.rawDisplayName!.localeCompare(b.rawDisplayName!))
    expect(c.participants).toEqual(sorted.map((m) => m.userId))
    expect(c.name).toBe(sorted.map((m) => m.rawDisplayName).join(', '))
    expect(c.participants).toHaveLength(8)
  })

  it('quem está em invite entra no nome e em participants; memberCount conta só join', () => {
    const room = fakeRoom({ members: [me, member('@bob:server', 'Bob'), member('@caio:server', 'Caio', 'invite')], marker: group })
    const c = roomToChannel(room, ctx(false, infra))
    expect(c.name).toBe('Bob, Caio')
    expect(c.participants).toEqual(['@bob:server', '@caio:server'])
    expect(c.memberCount).toBe(2)
  })

  it('quem saiu fica fora', () => {
    const room = fakeRoom({ members: [me, member('@bob:server', 'Bob'), member('@caio:server', 'Caio', 'leave')], marker: group })
    expect(roomToChannel(room, ctx(false, infra)).participants).toEqual(['@bob:server'])
  })

  it('custódia e conta de sistema ficam fora do nome e de participants', () => {
    const room = fakeRoom({
      members: [me, member('@bob:server', 'Bob'), member(CUSTODIAN, 'cofre'), member(SYSTEM, 'system'), member('@ana:server', 'Ana', 'invite')],
      marker: group,
    })
    const c = roomToChannel(room, ctx(false, infra))
    expect(c.name).toBe('Ana, Bob')
    expect(c.participants).toEqual(['@ana:server', '@bob:server'])
  })

  it('ordem estável: sem caixa nem acento, e nome igual desempata pelo id', () => {
    const a = [me, member('@z:server', 'ana'), member('@b:server', 'Ána'), member('@c:server', 'Bruno')]
    const b = [a[3]!, a[1]!, me, a[2]!]
    const one = roomToChannel(fakeRoom({ members: a, marker: group }), ctx(false, infra))
    const two = roomToChannel(fakeRoom({ members: b, marker: group }), ctx(false, infra))
    expect(one.participants).toEqual(['@b:server', '@z:server', '@c:server'])
    expect(two.participants).toEqual(one.participants)
    expect(two.name).toBe(one.name)
  })

  it('grupo solitário: nome vazio e participants vazio (presente)', () => {
    const c = roomToChannel(fakeRoom({ name: 'Empty room', members: [me], marker: group }), ctx(false, infra))
    expect(c.kind).toBe('group')
    expect(c.name).toBe('')
    expect(c.participants).toEqual([])
  })

  it('nunca o nome da sala, nem o autorado', () => {
    const room = fakeRoom({ authored: 'antigo', members: [me, member('@bob:server', 'Bob')], marker: group })
    expect(roomToChannel(room, ctx(false, infra)).name).toBe('Bob')
  })

  it("marcador 'channel' classifica pela visibilidade, ganha `#` e não tem participants", () => {
    const room = fakeRoom({ authored: 'projeto', members: [me, member('@bob:server', 'Bob')], marker: { kind: 'channel' } })
    const c = roomToChannel(room, ctx(false, infra))
    expect(c.kind).toBe('private')
    expect(c.name).toBe('#projeto')
    expect('participants' in c).toBe(false)
  })

  it.each([
    ['malformado (string)', 'group'],
    ['malformado (sem kind)', {}],
    ['valor em caixa diferente', { kind: 'Group' }],
    ['kind não-string', { kind: 1 }],
  ])('marcador %s → canal pela visibilidade, com `#`', (_label, marker) => {
    const room = fakeRoom({ authored: 'aberto', joinRule: 'public', members: [me, member('@bob:server', 'Bob')], marker })
    const c = roomToChannel(room, ctx(false, infra))
    expect(c.kind).toBe('public')
    expect(c.name).toBe('#aberto')
    expect('participants' in c).toBe(false)
  })

  it('sala no mapa de DMs com o marcador continua DM', () => {
    const room = fakeRoom({ members: [me, member('@bob:server', 'Bob')], marker: group })
    const c = roomToChannel(room, ctx(true, { ...infra, dmPeerOf: () => '@bob:server' }))
    expect(c.kind).toBe('dm')
    expect(c.peer).toBe('@bob:server')
    expect('participants' in c).toBe(false)
  })

  it('o canal da organização nunca é grupo', () => {
    const room = fakeRoom({ authored: 'all', alias: '#all:server', members: [me, member('@bob:server', 'Bob')], marker: group })
    const c = roomToChannel(room, ctx(false, infra))
    expect(c.kind).toBe('public')
    expect(c.org).toBe(true)
    expect('participants' in c).toBe(false)
  })

  it('canal e DM sem marcador não ganham a chave participants', () => {
    expect('participants' in roomToChannel(fakeRoom({ authored: 'x', members: [me] }), ctx(false, infra))).toBe(false)
    expect('participants' in roomToChannel(fakeRoom({ members: [me, member('@bob:server', 'Bob')] }), ctx(true, infra))).toBe(false)
  })
})

// PLANO-CONVERSAS §0.3.4 item 1: quantos participantes do grupo são agentes, pelo ctx.kindOf de cada um.
describe('roomToChannel — participantAgents do grupo (PLANO-CONVERSAS §0.3.4 item 1)', () => {
  const group = { kind: 'group' }
  const AGENT_A = '@agent-a:server'
  const AGENT_B = '@agent-b:server'
  const kindOf = (mxid: string) => (mxid === AGENT_A || mxid === AGENT_B ? ('agent' as const) : ('member' as const))
  const withAgents = (extra: FakeMember[]) =>
    fakeRoom({ members: [me, member('@bob:server', 'Bob'), member('@ana:server', 'Ana'), ...extra], marker: group })

  it('sem agente: 0, presente', () => {
    const c = roomToChannel(withAgents([]), ctx(false, { ...infra, kindOf }))
    expect(c.participantAgents).toBe(0)
    expect('participantAgents' in c).toBe(true)
    expect(findProtocolLeaks(c)).toEqual([])
  })

  it('um agente: 1', () => {
    const c = roomToChannel(withAgents([member(AGENT_A, 'Robô A')]), ctx(false, { ...infra, kindOf }))
    expect(c.participantAgents).toBe(1)
    expect(c.participants).toHaveLength(3)
    expect(findProtocolLeaks(c)).toEqual([])
  })

  it('dois agentes, um ainda em invite: 2', () => {
    const c = roomToChannel(
      withAgents([member(AGENT_A, 'Robô A'), member(AGENT_B, 'Robô B', 'invite')]),
      ctx(false, { ...infra, kindOf }),
    )
    expect(c.participantAgents).toBe(2)
    expect(findProtocolLeaks(c)).toEqual([])
  })

  it('grupo solitário: 0', () => {
    const c = roomToChannel(fakeRoom({ members: [me], marker: group }), ctx(false, { ...infra, kindOf }))
    expect(c.participantAgents).toBe(0)
  })

  it('chave ausente fora de grupo (canal, DM com agente, marcador channel)', () => {
    const channel = roomToChannel(fakeRoom({ authored: 'x', members: [me, member(AGENT_A, 'Robô A')] }), ctx(false, { ...infra, kindOf }))
    const dm = roomToChannel(
      fakeRoom({ members: [me, member(AGENT_A, 'Robô A')] }),
      ctx(true, { ...infra, kindOf, dmPeerOf: () => AGENT_A }),
    )
    const converted = roomToChannel(
      fakeRoom({ authored: 'p', members: [me, member(AGENT_A, 'Robô A')], marker: { kind: 'channel' } }),
      ctx(false, { ...infra, kindOf }),
    )
    for (const c of [channel, dm, converted]) {
      expect('participantAgents' in c).toBe(false)
      expect(findProtocolLeaks(c)).toEqual([])
    }
    expect(dm.peerAgent).toBeDefined()
  })
})
