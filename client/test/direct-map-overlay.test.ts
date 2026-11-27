import { describe, it, expect } from 'vitest'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import type { AclTelemetry, DomainEvent, UserId } from '../src/acl'

// Issue #421, lote "Nova conversa" (F1): the direct-conversation map is written by a direct call, without
// waiting for the sync echo, and what this session wrote (or is writing) counts as "is a direct conversation"
// before the echo. Fake-client idiom of auto-join-invite.test.ts and group-channel-changed.test.ts. The SDK's
// setAccountData is faked as never settling (the echo held, or the sync stopped): nothing may wait on it.

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const ME = '@bob:server'
const PEER = '@alice:server'
const ROOM = '!room:server'
const never = (): Promise<never> => new Promise(() => {})
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

interface FakeMember {
  userId: string
  rawDisplayName: string
  membership: string
  powerLevel: number
  getMxcAvatarUrl: () => undefined
  events: { member?: unknown }
}

const member = (userId: string, rawDisplayName: string, membership: string, events: { member?: unknown } = {}): FakeMember => ({
  userId,
  rawDisplayName,
  membership,
  powerLevel: 0,
  getMxcAvatarUrl: () => undefined,
  events,
})

function harness() {
  const puts: Array<{ path: string; body: unknown }> = []
  const script = { put: [] as Array<Error | undefined> }
  const inviteEvent = { getContent: () => ({ is_direct: true }), getSender: () => PEER }
  const members: FakeMember[] = [member(ME, 'Bob', 'invite', { member: inviteEvent }), member(PEER, 'Alice', 'join')]
  let myMembership = 'invite'
  const room = {
    roomId: ROOM,
    name: 'Alice',
    myUserId: ME,
    getMyMembership: () => myMembership,
    isSpaceRoom: () => false,
    getJoinRule: () => 'invite',
    getCanonicalAlias: () => null,
    getMembers: () => members,
    getJoinedMembers: () => members.filter((m) => m.membership === 'join'),
    getMember: (id: string) => members.find((m) => m.userId === id) ?? null,
    getJoinedMemberCount: () => members.filter((m) => m.membership === 'join').length,
    hasEncryptionStateEvent: () => false,
    currentState: { roomId: ROOM, getStateEvents: () => null },
  }
  const handlers = new Map<string, (...args: unknown[]) => void>()
  const fakeClient = {
    on: (e: unknown, h: (...args: unknown[]) => void) => handlers.set(String(e), h),
    off: () => {},
    getUserId: () => ME,
    getRooms: () => [room],
    getRoom: (id: string) => (id === ROOM ? room : null),
    // The echo never lands: the synced map stays empty for the whole test.
    getAccountData: () => undefined,
    setAccountData: never,
    joinRoom: async () => {
      myMembership = 'join'
      members[0]!.membership = 'join'
      handlers.get('Room.myMembership')?.(room, 'join', 'invite')
      return room
    },
    sendReadReceipt: async () => {},
    http: {
      authedRequest: async (method: string, path: string, _query: unknown, body: unknown) => {
        if (method === 'PUT' && path.endsWith('/account_data/m.direct')) {
          puts.push({ path, body })
          const outcome = script.put.shift()
          if (outcome) throw outcome
          return {}
        }
        throw new Error(`unexpected request in fake: ${method} ${path}`)
      },
    },
  }
  const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
  const internals = gateway as unknown as { client: unknown; live: boolean; wireEvents: (c: unknown) => void }
  internals.client = fakeClient
  internals.wireEvents(fakeClient)
  internals.live = true
  const added: Extract<DomainEvent, { t: 'channel.added' }>['channel'][] = []
  gateway.subscribe((e) => {
    if (e.t === 'channel.added') added.push(e.channel)
  })
  return { gateway, handlers, room, added, puts, script }
}

describe('the direct map without the echo (F1)', () => {
  it('an invitee joins and its channel.added is a direct conversation with the echo held', async () => {
    const h = harness()
    h.handlers.get('Room.myMembership')?.(h.room, 'invite', undefined)
    for (let i = 0; i < 5 && h.added.length === 0; i++) await tick()
    expect(h.added).toHaveLength(1)
    expect(h.added[0]!.kind).toBe('dm')
    expect(String(h.added[0]!.peer)).toBe(PEER)
    expect(h.puts).toHaveLength(1)
    expect(h.puts[0]!.body).toEqual({ [PEER]: [ROOM] })
  })

  it('the retry through the memo, with the sync stopped, settles without waiting for the echo (#494)', async () => {
    const h = harness()
    const memo = (h.gateway as unknown as { directRoomByUser: Map<string, string> }).directRoomByUser
    // The first attempt created the room and its map write failed: the memo has it, the map does not.
    memo.set(PEER, ROOM)
    let settled = false
    const retry = h.gateway.openDirectMessage(PEER as UserId).then((id) => {
      settled = true
      return id
    })
    for (let i = 0; i < 5 && !settled; i++) await tick()
    expect(settled).toBe(true)
    expect(String(await retry)).toBe(ROOM)
    expect(h.puts.map((p) => p.body)).toEqual([{ [PEER]: [ROOM] }])
  })
})
