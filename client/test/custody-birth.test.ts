import { describe, it, expect } from 'vitest'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import { roomToChannel } from '@tayet/shared/internal'
import { CUSTODY_WAIT_MS } from '../src/acl/internal/custody'
import type { AclTelemetry, ChannelId, DomainEvent, UserId } from '../src/acl'
import type { Room } from 'matrix-js-sdk'

// Nascimento de sala com cobertura estrutural (PR-4 do track CRIPTO-COBERTURA; ADR-057 dec. 2/3,
// F1 fail-open, F3 `cofre`, F7 rotação pinada) — lado unitário, sem Synapse. Idioma de fake-client
// de open-direct-message/dm-avatar-refresh: injeta o client pelo cast e grava o que o verbo emite.
//
// O que este arquivo prova, em ordem: (1) o initial_state pinado nasce em canal privado e em DM e
// NÃO nasce em canal público; (2) o convite do cofre é chamada SEPARADA do createRoom (o desenho
// fail-open do F1 depende disso); (3) falha do convite E espera expirada viram sinal nomeado, sem
// erro cruzando o barrel; (4) o cofre não aparece em getMembers nem em member.changed; (5) um DM
// com o cofre dentro continua se chamando pelo humano e contando 2 membros.

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const ME = '@me:tayet.local'
const PEER = '@peer:tayet.local'
const COFRE = '@cofre:tayet.local'
const ROOM = '!room:tayet.local'

const ENCRYPTION = 'm.room.encryption'
const HISTORY = 'm.room.history_visibility'

interface InitialStateEvent {
  type: string
  state_key: string
  content: Record<string, unknown>
}
interface CreateRoomOpts {
  initial_state?: InitialStateEvent[]
  invite?: string[]
  is_direct?: boolean
}

interface Captured {
  createRoom: CreateRoomOpts[]
  invites: Array<{ roomId: string; userId: string }>
  signals: string[]
}

// `inviteOutcome` e `memberAppears` são os dois eixos de falha do F1: o servidor recusa o convite,
// ou aceita e a membership não chega ao estado local a tempo.
function harness(
  opts: { inviteOutcome?: 'ok' | 'reject'; memberAppears?: boolean } = {},
): { gateway: MatrixGateway; cap: Captured } {
  const { inviteOutcome = 'ok', memberAppears = true } = opts
  const cap: Captured = { createRoom: [], invites: [], signals: [] }
  const telemetry: AclTelemetry = {
    untranslated: (e) => cap.signals.push(e.shape.eventType),
  }
  const fakeClient = {
    getUserId: () => ME,
    getRooms: () => [],
    getRoom: () => ({
      roomId: ROOM,
      getMember: (uid: string) =>
        uid === COFRE && memberAppears ? { userId: COFRE, membership: 'invite' } : null,
    }),
    createRoom: (o: CreateRoomOpts) => {
      cap.createRoom.push(o)
      return Promise.resolve({ room_id: ROOM })
    },
    invite: (roomId: string, userId: string) => {
      cap.invites.push({ roomId, userId })
      return inviteOutcome === 'ok'
        ? Promise.resolve(undefined)
        : Promise.reject(new Error('M_FORBIDDEN'))
    },
    getAccountData: () => undefined,
    setAccountData: () => Promise.resolve(undefined),
  }
  const gateway = new MatrixGateway({ mode: 'strict', telemetry, serverUrl: 'http://x' })
  ;(gateway as unknown as { client: unknown }).client = fakeClient
  return { gateway, cap }
}

function stateOf(opts: CreateRoomOpts, type: string): InitialStateEvent | undefined {
  return opts.initial_state?.find((e) => e.type === type)
}

describe('nascimento pinado — initial_state (ADR-057 dec. 3 + sub-decisão do F7)', () => {
  it('canal privado: encryption com rotação pinada + history_visibility shared', async () => {
    const { gateway, cap } = harness()
    await gateway.createChannel({ name: 'privado', kind: 'private' })
    const [opts] = cap.createRoom
    expect(stateOf(opts!, ENCRYPTION)?.content).toEqual({
      algorithm: 'm.megolm.v1.aes-sha2',
      rotation_period_msgs: 100,
      rotation_period_ms: 604_800_000,
    })
    expect(stateOf(opts!, HISTORY)?.content).toEqual({ history_visibility: 'shared' })
  })

  it('DM: o MESMO shape do canal privado (a cobertura não depende do tipo de sala)', async () => {
    const { gateway, cap } = harness()
    await gateway.openDirectMessage(PEER as UserId)
    const [opts] = cap.createRoom
    expect(opts!.is_direct).toBe(true)
    expect(stateOf(opts!, ENCRYPTION)?.content).toEqual({
      algorithm: 'm.megolm.v1.aes-sha2',
      rotation_period_msgs: 100,
      rotation_period_ms: 604_800_000,
    })
    expect(stateOf(opts!, HISTORY)?.content).toEqual({ history_visibility: 'shared' })
  })

  // Negativo do par: canal público nasce em claro (ADR-045) — sem cifra, sem pinagem, e sem cofre,
  // porque não há sessão Megolm para custodiar.
  it('canal público: NADA disso — sem encryption, sem history_visibility, sem cofre', async () => {
    const { gateway, cap } = harness()
    await gateway.createChannel({ name: 'publico', kind: 'public' })
    const [opts] = cap.createRoom
    expect(stateOf(opts!, ENCRYPTION)).toBeUndefined()
    expect(stateOf(opts!, HISTORY)).toBeUndefined()
    expect(cap.invites).toEqual([])
    expect(cap.signals).toEqual([])
  })
})

describe('convite do cofre — chamada separada e fail-open (ADR-057 dec. 2, F1)', () => {
  // O ponto estrutural do F1: se o cofre entrasse no array `invite` do createRoom, uma recusa do
  // servidor derrubaria a criação inteira (fail-CLOSED). Ele tem que ser um invite à parte.
  it('canal privado: cofre NÃO vai no invite do createRoom, e sim num invite separado', async () => {
    const { gateway, cap } = harness()
    await gateway.createChannel({ name: 'privado', kind: 'private', members: [PEER as UserId] })
    expect(cap.createRoom[0]!.invite).toEqual([PEER])
    expect(cap.createRoom[0]!.invite).not.toContain(COFRE)
    expect(cap.invites).toEqual([{ roomId: ROOM, userId: COFRE }])
  })

  it('DM: idem — o createRoom convida só o par humano; o cofre vem depois', async () => {
    const { gateway, cap } = harness()
    await gateway.openDirectMessage(PEER as UserId)
    expect(cap.createRoom[0]!.invite).toEqual([PEER])
    expect(cap.invites).toEqual([{ roomId: ROOM, userId: COFRE }])
  })

  it('(a) invite recusado → verbo RESOLVE, sala existe, sinal invite-failed', async () => {
    const { gateway, cap } = harness({ inviteOutcome: 'reject' })
    const id = await gateway.createChannel({ name: 'privado', kind: 'private' })
    expect(String(id)).toBe(ROOM) // fail-OPEN: o usuário criou um canal com sucesso.
    expect(cap.signals).toEqual(['io.tayet.custody.invite-failed'])
  })

  it('(b) espera expirada → verbo RESOLVE, sinal wait-timeout', async () => {
    const { gateway, cap } = harness({ memberAppears: false })
    const started = Date.now()
    const id = await gateway.createChannel({ name: 'privado', kind: 'private' })
    expect(String(id)).toBe(ROOM)
    expect(cap.signals).toEqual(['io.tayet.custody.wait-timeout'])
    // A espera é LIMITADA — não é um await indefinido no serviço de custódia.
    expect(Date.now() - started).toBeGreaterThanOrEqual(CUSTODY_WAIT_MS)
    expect(Date.now() - started).toBeLessThan(CUSTODY_WAIT_MS * 3)
  })

  it('caminho feliz: nenhum sinal (o sinal é evidência de PERDA, não de passagem)', async () => {
    const { gateway, cap } = harness()
    await gateway.createChannel({ name: 'privado', kind: 'private' })
    expect(cap.signals).toEqual([])
  })
})

// ── Ocultação nos dois choke points (ADR-057 dec. 2 — P1 estendido a "infra invisível") ────────
const roster = [
  { userId: ME, rawDisplayName: 'Eu', powerLevel: 100, membership: 'join', getMxcAvatarUrl: () => null },
  { userId: PEER, rawDisplayName: 'Par', powerLevel: 0, membership: 'join', getMxcAvatarUrl: () => null },
  { userId: COFRE, rawDisplayName: 'cofre', powerLevel: 0, membership: 'join', getMxcAvatarUrl: () => null },
]

describe('getMembers — o cofre nunca cruza o barrel', () => {
  function gatewayWithRoster(): MatrixGateway {
    const fakeClient = {
      getUserId: () => ME,
      getRooms: () => [],
      getRoom: () => ({ roomId: ROOM, getMembers: () => roster }),
      getAccountData: () => undefined,
    }
    const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
    ;(gateway as unknown as { client: unknown }).client = fakeClient
    return gateway
  }

  it('positivo: os humanos passam; negativo: o cofre não', () => {
    const members = gatewayWithRoster().getMembers(ROOM as ChannelId)
    expect(members.map((m) => String(m.user.id))).toEqual([ME, PEER])
    expect(members.map((m) => String(m.user.id))).not.toContain(COFRE)
    // Nem por displayName — o localpart não pode aparecer por nenhuma via.
    expect(JSON.stringify(members)).not.toMatch(/cofre/i)
  })
})

describe('member.changed — o cofre não emite', () => {
  function harnessStream(): { fire: (userId: string) => void; events: DomainEvent[] } {
    const handlers = new Map<string, (...args: unknown[]) => void>()
    const fakeClient = {
      on: (e: unknown, h: (...args: unknown[]) => void) => handlers.set(String(e), h),
      off: () => {},
      getUserId: () => ME,
      getRooms: () => [],
      getAccountData: () => ({ getContent: () => ({}) }),
      getRoom: () => null,
    }
    const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
    ;(gateway as unknown as { client: unknown }).client = fakeClient
    ;(gateway as unknown as { wireEvents: (c: unknown) => void }).wireEvents(fakeClient)
    const onMembers = handlers.get('RoomState.members')
    if (!onMembers) throw new Error('members listener not wired')
    const events: DomainEvent[] = []
    ;(gateway as unknown as { subscribe: (h: (e: DomainEvent) => void) => void }).subscribe((e) => {
      if (e.t === 'member.changed') events.push(e)
    })
    return {
      fire: (userId) => onMembers(undefined, undefined, { roomId: ROOM, userId, membership: 'join', powerLevel: 0 }),
      events,
    }
  }

  it('positivo: um humano emite; negativo: o cofre é engolido', () => {
    const { fire, events } = harnessStream()
    fire(PEER)
    expect(events).toHaveLength(1)
    fire(COFRE)
    expect(events).toHaveLength(1) // inalterado — o cofre não gerou evento.
    expect(events.map((e) => String((e as { user: UserId }).user))).toEqual([PEER])
  })
})

// ── RIPPLE do DM de 3 membros (a regressão que a dec. 2 introduziria sem tratamento) ───────────
describe('roomToChannel — DM com o cofre dentro continua sendo o DM do humano', () => {
  // Ordem deliberada: o cofre vem ANTES do par em getJoinedMembers. Sem o filtro, o `find` do
  // nome pegaria o cofre — é exatamente esse o modo de falha.
  const joined = [
    { userId: COFRE, rawDisplayName: 'cofre', membership: 'join', getMxcAvatarUrl: () => null },
    { userId: ME, rawDisplayName: 'Eu', membership: 'join', getMxcAvatarUrl: () => null },
    { userId: PEER, rawDisplayName: 'Par', membership: 'join', getMxcAvatarUrl: () => null },
  ]
  const room = {
    roomId: ROOM,
    name: 'sala',
    myUserId: ME,
    getJoinRule: () => 'invite',
    getCanonicalAlias: () => null,
    getJoinedMembers: () => joined,
    getMember: (uid: string) => joined.find((m) => m.userId === uid) ?? null,
    getJoinedMemberCount: () => 3,
    hasEncryptionStateEvent: () => false,
    currentState: { getStateEvents: () => null },
  } as unknown as Room

  const ctx = {
    mode: 'strict' as const,
    telemetry: noopTelemetry,
    isDm: () => true,
    dmPeerOf: () => PEER,
    myUserId: ME,
    custodian: COFRE,
  }

  it('nome é o do par humano, não o do cofre', () => {
    expect(roomToChannel(room, ctx).name).toBe('Par')
  })

  it('memberCount desconta o cofre: 3 no protocolo, 2 no produto', () => {
    expect(roomToChannel(room, ctx).memberCount).toBe(2)
  })

  it('peer segue sendo o humano (m.direct nunca lista o cofre)', () => {
    expect(String(roomToChannel(room, ctx).peer)).toBe(PEER)
  })

  // Sem custodian no ctx (fakes antigos, ctx sem identidade) nada é subtraído — a mudança é aditiva.
  it('ctx sem custodian: comportamento pré-PR-4 preservado', () => {
    const ch = roomToChannel(room, { ...ctx, custodian: null })
    expect(ch.memberCount).toBe(3)
  })
})

describe('roomToChannel — nome calculado nunca inclui o cofre (fecho do ripple)', () => {
  // O modo de falha PROVADO VIVO no fecho da PR-4: sala privada SEM m.room.name autorado (criada
  // fora do produto; ADR-044 auto-join a traz pra dentro) tem room.name CALCULADO pelo SDK a
  // partir dos heroes — e o cofre é hero de toda sala cifrada sem nome ("#bob and cofre" no
  // render-scan sobre dados reais). O recompute é na FONTE (membros humanos), nunca sanitização
  // da string pronta.
  const members = [
    { userId: COFRE, rawDisplayName: 'cofre', membership: 'join', getMxcAvatarUrl: () => null },
    { userId: ME, rawDisplayName: 'Eu', membership: 'join', getMxcAvatarUrl: () => null },
    { userId: PEER, rawDisplayName: 'Par', membership: 'invite', getMxcAvatarUrl: () => null },
  ]
  function namelessRoom(sdkCalculatedName: string, roster = members): Room {
    return {
      roomId: ROOM,
      name: sdkCalculatedName,
      myUserId: ME,
      getJoinRule: () => 'invite',
      getCanonicalAlias: () => null,
      getMembers: () => roster,
      getJoinedMembers: () => roster.filter((m) => m.membership === 'join'),
      getMember: (uid: string) => roster.find((m) => m.userId === uid) ?? null,
      getJoinedMemberCount: () => roster.filter((m) => m.membership === 'join').length,
      hasEncryptionStateEvent: () => false,
      currentState: { getStateEvents: () => null },
    } as unknown as Room
  }
  const ctx = {
    mode: 'strict' as const,
    telemetry: noopTelemetry,
    isDm: () => false,
    myUserId: ME,
    custodian: COFRE,
  }

  it('sala sem nome autorado + cofre dentro: nome recomputado só dos humanos (join E invite)', () => {
    expect(roomToChannel(namelessRoom('Par and cofre'), ctx).name).toBe('#Par')
  })

  it('nome AUTORADO passa verbatim — "cofre" é palavra legítima de humano', () => {
    const room = namelessRoom('irrelevante')
    ;(room as unknown as { currentState: unknown }).currentState = {
      getStateEvents: (t: string) => (t === 'm.room.name' ? { getContent: () => ({ name: 'sala do cofre' }) } : null),
    }
    expect(roomToChannel(room, ctx).name).toBe('#sala do cofre')
  })

  it('sem o cofre na sala, o nome calculado do SDK segue valendo (pré-PR-4)', () => {
    const humans = members.filter((m) => m.userId !== COFRE)
    expect(roomToChannel(namelessRoom('Par', humans), ctx).name).toBe('#Par')
  })

  it('sala morta (eu + cofre): nome vazio, nunca o localpart', () => {
    const dead = members.filter((m) => m.userId !== PEER)
    const ch = roomToChannel(namelessRoom('cofre', dead), ctx)
    expect(ch.name).not.toMatch(/cofre/i)
  })
})
