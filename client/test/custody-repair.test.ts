import { describe, it, expect, afterEach } from 'vitest'
import { MatrixError } from 'matrix-js-sdk'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import type { AclTelemetry, ChannelId, UserId } from '../src/acl'

// ADR-112 (Proposto), unit side: the custody invite does not depend on the DM map, and opening an
// encrypted conversation without the custody repairs it. Fake-client idiom of custody-birth.test.ts,
// with a membership that moves the way /sync moves it: the room state first, then RoomState.members.
//
// A negative case ("nothing happens") always carries a control room that IS repaired, so none of them
// can pass just because the repair is absent.

const ME = '@me:tayet.local'
const PEER = '@peer:tayet.local'
const PEER2 = '@peer2:tayet.local'
const COFRE = '@cofre:tayet.local'
const ROOM = '!room:tayet.local'
const CONTROL = '!control:tayet.local'
const ORG = '!org:tayet.local'
const ORG_ALIAS = '#all:tayet.local'

const FAILED = 'io.tayet.custody.invite-failed'
const DEFERRED = 'io.tayet.custody.invite-deferred'

// The two refusals as the local Synapse 1.163 answers them: the same status and errcode.
const alreadyInRoom = (): MatrixError =>
  new MatrixError({ errcode: 'M_FORBIDDEN', error: `${COFRE} is already in the room.` }, 403)
const notAllowed = (): MatrixError =>
  new MatrixError({ errcode: 'M_FORBIDDEN', error: "You don't have permission to invite users" }, 403)
const limited = (): MatrixError =>
  new MatrixError({ errcode: 'M_LIMIT_EXCEEDED', error: 'Too Many Requests', retry_after_ms: 50 }, 429)

type Kind = 'dm' | 'group' | 'private' | 'public'
interface FakeRoom {
  id: string
  kind: Kind
  encrypted: boolean
  alias: string | null
  mine: string
  members: Map<string, string>
}

const gateways: MatrixGateway[] = []
afterEach(() => {
  for (const gateway of gateways.splice(0)) {
    const internals = gateway as unknown as { custodyInviteQueue: Map<string, unknown>; stopCustodyDrainIfIdle(): void }
    internals.custodyInviteQueue.clear()
    internals.stopCustodyDrainIfIdle()
  }
})

function harness() {
  const rooms = new Map<string, FakeRoom>()
  const serverMembership = new Map<string, string>()
  const accountData: { direct: Record<string, string[]> } = { direct: {} }
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>()
  // Every observable step, in order.
  const steps: string[] = []
  const signals: string[] = []
  const script = {
    invite: [] as Array<MatrixError | Promise<void>>,
    mapWrite: [] as Array<Error | Promise<void>>,
    created: ROOM,
  }
  let createRooms = 0

  const addRoom = (id: string, kind: Kind, over: Partial<FakeRoom> = {}): FakeRoom => {
    const room: FakeRoom = {
      id,
      kind,
      encrypted: kind !== 'public',
      alias: null,
      mine: 'join',
      members: new Map([
        [ME, 'join'],
        [PEER, 'join'],
      ]),
      ...over,
    }
    rooms.set(id, room)
    if (kind === 'dm') accountData.direct[PEER] = [...(accountData.direct[PEER] ?? []), id]
    return room
  }
  const syncCustody = (id: string, membership: string): void => {
    const room = rooms.get(id)
    if (!room) return
    room.members.set(COFRE, membership)
    steps.push(`seen ${id}`)
    const member = { roomId: id, userId: COFRE, membership, powerLevel: 0 }
    for (const h of handlers.get('RoomState.members') ?? []) h(undefined, undefined, member)
  }
  const sdkRoom = (room: FakeRoom) => ({
    roomId: room.id,
    getMyMembership: () => room.mine,
    getJoinRule: () => (room.kind === 'public' ? 'public' : 'invite'),
    getCanonicalAlias: () => room.alias,
    hasEncryptionStateEvent: () => room.encrypted,
    isSpaceRoom: () => false,
    getMember: (userId: string) =>
      room.members.has(userId) ? { userId, membership: room.members.get(userId), events: {} } : null,
    getMembers: () => [...room.members].map(([userId, membership]) => ({ userId, membership })),
    currentState: {
      getStateEvents: (type: string) =>
        room.kind === 'group' && type === 'io.tayet.conversation' ? { getContent: () => ({ kind: 'group' }) } : null,
    },
  })
  const fakeClient = {
    on: (event: unknown, h: (...args: unknown[]) => void) => {
      handlers.set(String(event), [...(handlers.get(String(event)) ?? []), h])
    },
    off: () => {},
    getUserId: () => ME,
    getRooms: () => [...rooms.values()].map(sdkRoom),
    getRoom: (id: string) => {
      const room = rooms.get(id)
      return room ? sdkRoom(room) : null
    },
    createRoom: (opts: { is_direct?: boolean }) => {
      createRooms++
      addRoom(script.created, opts.is_direct ? 'private' : 'group')
      return Promise.resolve({ room_id: script.created })
    },
    invite: async (id: string, userId: string) => {
      if (userId !== COFRE) return
      steps.push(`invite ${id}`)
      const outcome = script.invite.shift()
      if (outcome instanceof MatrixError) throw outcome
      await outcome
      serverMembership.set(id, 'invite')
      setTimeout(() => syncCustody(id, 'invite'), 5)
    },
    getStateEvent: async (id: string, _type: string, userId: string) => {
      const membership = userId === COFRE ? serverMembership.get(id) : undefined
      if (!membership) throw new MatrixError({ errcode: 'M_NOT_FOUND', error: 'Event not found.' }, 404)
      return { membership }
    },
    getAccountData: (type: string) => (type === 'm.direct' ? { getContent: () => accountData.direct } : undefined),
    setAccountData: async (_type: string, content: Record<string, string[]>) => {
      steps.push('map')
      const outcome = script.mapWrite.shift()
      if (outcome instanceof Error) throw outcome
      await outcome
      accountData.direct = content
    },
    getCrypto: () => ({
      forceDiscardSession: async (id: string) => {
        steps.push(`discard ${id}`)
      },
    }),
  }

  const telemetry: AclTelemetry = { untranslated: (e) => signals.push(e.shape.eventType) }
  const gateway = new MatrixGateway({ mode: 'strict', telemetry, serverUrl: 'http://x' })
  const internals = gateway as unknown as { client: unknown; live: boolean; wireEvents(client: unknown): void }
  internals.client = fakeClient
  internals.wireEvents(fakeClient)
  internals.live = true // the first sync has prepared
  gateways.push(gateway)

  return {
    gateway,
    steps,
    signals,
    script,
    accountData,
    addRoom,
    syncCustody,
    serverMembership,
    createRooms: () => createRooms,
    open: (id: string) => gateway.subscribeChannel(id as ChannelId, () => {}),
    invites: () => steps.filter((s) => s.startsWith('invite ')),
    discards: () => steps.filter((s) => s.startsWith('discard ')),
  }
}

const settle = (ms = 80): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function until(probe: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const start = Date.now()
  while (!probe()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for: ${what}`)
    await settle(20)
  }
}

describe('DM birth: the custody invite does not depend on the DM map (ADR-112 dec. 1)', () => {
  it('1. map write rejects: the verb rejects and the custody was invited; the retry writes the map', async () => {
    const h = harness()
    h.script.mapWrite.push(new Error('map write failed'))
    await expect(h.gateway.openDirectMessage(PEER as UserId)).rejects.toThrow('map write failed')
    expect(h.invites()).toEqual([`invite ${ROOM}`])

    expect(String(await h.gateway.openDirectMessage(PEER as UserId))).toBe(ROOM)
    expect(h.createRooms()).toBe(1)
    expect(h.accountData.direct).toEqual({ [PEER]: [ROOM] })
    expect(h.invites()).toEqual([`invite ${ROOM}`])
    expect(h.signals).toEqual([])
  })

  it('1b. the invite leaves while the map write is pending, and the verb waits for both', async () => {
    const h = harness()
    let releaseMap!: () => void
    h.script.mapWrite.push(new Promise<void>((r) => (releaseMap = r)))
    let resolved = false
    const verb = h.gateway.openDirectMessage(PEER as UserId).then(() => (resolved = true))
    await settle()
    expect(h.invites()).toEqual([`invite ${ROOM}`])
    expect(resolved).toBe(false)
    releaseMap()
    await verb
  })

  it('1c. a map write that rejects first still waits for the invite before the verb rejects', async () => {
    const h = harness()
    let releaseInvite!: () => void
    h.script.mapWrite.push(new Error('map write failed'))
    h.script.invite.push(new Promise<void>((r) => (releaseInvite = r)))
    let failure: Error | undefined
    const verb = h.gateway.openDirectMessage(PEER as UserId).catch((e: Error) => (failure = e))
    await settle()
    expect(h.invites()).toEqual([`invite ${ROOM}`])
    expect(failure).toBeUndefined()
    releaseInvite()
    await verb
    expect(failure?.message).toBe('map write failed')
  })
})

describe('repair on open (ADR-112 dec. 2 and 3)', () => {
  it('2. DM without the custody: one invite, then the discard once it is seen; opening again: nothing', async () => {
    const h = harness()
    h.addRoom(ROOM, 'dm')
    h.open(ROOM)
    await settle()
    expect(h.steps).toEqual([`invite ${ROOM}`, `seen ${ROOM}`, `discard ${ROOM}`])

    h.open(ROOM)
    h.syncCustody(ROOM, 'join')
    await settle()
    expect(h.invites()).toHaveLength(1)
    expect(h.discards()).toHaveLength(1)
    expect(h.signals).toEqual([])
  })

  it.each(['invite', 'join'])('3. custody already in the conversation (%s): nothing', async (membership) => {
    const h = harness()
    h.addRoom(ROOM, 'dm').members.set(COFRE, membership)
    h.addRoom(CONTROL, 'private')
    h.open(ROOM)
    h.open(CONTROL)
    await settle()
    expect(h.invites()).toEqual([`invite ${CONTROL}`])
    expect(h.discards()).toEqual([`discard ${CONTROL}`])
    expect(h.signals).toEqual([])
  })

  it('4. public channels (clear, encrypted before ADR-045, the org channel) and non-joined rooms: nothing', async () => {
    const h = harness()
    h.addRoom(ROOM, 'public')
    h.addRoom('!legacy:tayet.local', 'public', { encrypted: true })
    h.addRoom(ORG, 'private', { alias: ORG_ALIAS })
    h.addRoom('!invited:tayet.local', 'private', { mine: 'invite' })
    h.addRoom('!clear:tayet.local', 'private', { encrypted: false })
    h.addRoom(CONTROL, 'private')
    for (const id of [ROOM, '!legacy:tayet.local', ORG, '!invited:tayet.local', '!clear:tayet.local', CONTROL])
      h.open(id)
    await settle()
    expect(h.invites()).toEqual([`invite ${CONTROL}`])
    expect(h.discards()).toEqual([`discard ${CONTROL}`])
    expect(h.signals).toEqual([])
  })

  it('5. refused invite: invite-failed, no discard, nothing thrown', async () => {
    const h = harness()
    h.addRoom(ROOM, 'dm')
    h.script.invite.push(notAllowed())
    expect(() => h.open(ROOM)).not.toThrow()
    await settle()
    h.open(ROOM)
    await settle()
    expect(h.invites()).toEqual([`invite ${ROOM}`])
    expect(h.signals).toEqual([FAILED])
    expect(h.discards()).toEqual([])
  })

  it('6. rate-limited invite: queued with invite-deferred, and the late entry still discards', async () => {
    const h = harness()
    h.addRoom(ROOM, 'dm')
    h.script.invite.push(limited())
    h.open(ROOM)
    await settle()
    h.open(ROOM)
    expect(h.signals).toEqual([DEFERRED])
    expect(h.invites()).toHaveLength(1)
    expect(h.discards()).toEqual([])

    await until(() => h.discards().length > 0, 'discard after the deferred invite')
    expect(h.steps).toEqual([`invite ${ROOM}`, `invite ${ROOM}`, `seen ${ROOM}`, `discard ${ROOM}`])
    expect(h.signals).toEqual([DEFERRED])
  })

  it.each(['group', 'private'] as const)('7. %s without the custody: the same as the DM', async (kind) => {
    const h = harness()
    h.addRoom(ROOM, kind)
    h.open(ROOM)
    await settle()
    h.open(ROOM)
    await settle()
    expect(h.steps).toEqual([`invite ${ROOM}`, `seen ${ROOM}`, `discard ${ROOM}`])
    expect(h.signals).toEqual([])
  })

  it.each([
    ['private channel', (g: MatrixGateway) => g.createChannel({ name: 'privado', kind: 'private' })],
    ['DM', (g: MatrixGateway) => g.openDirectMessage(PEER as UserId)],
    ['group', (g: MatrixGateway) => g.openGroupConversation([PEER, PEER2] as UserId[])],
  ] as const)('8. %s created and opened at once: one invite', async (_label, create) => {
    const h = harness()
    h.addRoom(CONTROL, 'private')
    let releaseInvite!: () => void
    h.script.invite.push(new Promise<void>((r) => (releaseInvite = r)))
    const verb = create(h.gateway)
    await until(() => h.invites().length > 0, 'birth invite')
    h.open(ROOM) // still in flight: the custody is not a member yet
    h.open(CONTROL)
    releaseInvite()
    await verb
    await settle()
    expect(h.invites()).toEqual([`invite ${ROOM}`, `invite ${CONTROL}`])
    // Birth changes nothing about the outbound session; only the repair discards.
    expect(h.discards()).toEqual([`discard ${CONTROL}`])
  })

  it('9. the server says the custody is already in: no signal, no discard', async () => {
    const h = harness()
    h.addRoom(ROOM, 'dm')
    h.serverMembership.set(ROOM, 'join')
    h.script.invite.push(alreadyInRoom())
    h.open(ROOM)
    await settle()
    expect(h.invites()).toEqual([`invite ${ROOM}`])
    h.syncCustody(ROOM, 'join') // the sync catches up with what the server already had
    await settle()
    expect(h.signals).toEqual([])
    expect(h.discards()).toEqual([])
  })

  it('9b. the same answer to a queued invite: no failure signal, no discard', async () => {
    const h = harness()
    h.addRoom(ROOM, 'dm')
    h.script.invite.push(limited(), alreadyInRoom())
    h.open(ROOM)
    await settle()
    h.serverMembership.set(ROOM, 'join')
    await until(() => h.invites().length === 2, 'queued invite')
    await settle()
    h.syncCustody(ROOM, 'join')
    await settle()
    expect(h.signals).toEqual([DEFERRED])
    expect(h.discards()).toEqual([])
  })
})
