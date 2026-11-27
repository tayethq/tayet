import { describe, it, expect, afterEach, vi } from 'vitest'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import type { AclTelemetry, DomainEvent, UserId } from '../src/acl'

// ADR-116 dec. 10, unit side: while an openDirectMessage of this session is in flight, the creator's
// channel.added of a room that arrives is held, in the group's mould (ADR-094 dec. 3). Released when the opening's
// room is whole (the `'direct'` marker and the peer in the store), when the createRoom answer shows the held room is
// not the opening's, or at the 3 s safety deadline. One channel.added per room. The room comes in pieces, as the
// local Synapse delivers it to its creator: the creation and the join first, then the marker, then the peer.

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const ME = '@ana:server'
const PEER = '@bia:server'
const PEER2 = '@caio:server'
const MARKER = 'io.tayet.conversation'

interface FakeMember {
  userId: string
  rawDisplayName: string
  membership: string
  powerLevel: number
  getMxcAvatarUrl: () => undefined
  events: Record<string, unknown>
}
const member = (userId: string, membership: string): FakeMember => ({
  userId,
  rawDisplayName: userId.slice(1, userId.indexOf(':')),
  membership,
  powerLevel: 0,
  getMxcAvatarUrl: () => undefined,
  events: {},
})

function harness() {
  const rooms = new Map<string, { members: FakeMember[]; marker?: string; room: unknown }>()
  const handlers = new Map<string, (...args: unknown[]) => void>()
  const answers: Array<(roomId: string) => void> = []
  const makeRoom = (id: string) => {
    const entry: { members: FakeMember[]; marker?: string; room: unknown } = { members: [member(ME, 'join')], room: undefined }
    entry.room = {
      roomId: id,
      name: 'Empty room',
      myUserId: ME,
      getMyMembership: () => 'join',
      isSpaceRoom: () => false,
      getJoinRule: () => 'invite',
      getCanonicalAlias: () => null,
      getMembers: () => entry.members,
      getJoinedMembers: () => entry.members.filter((m) => m.membership === 'join'),
      getMember: (u: string) => entry.members.find((m) => m.userId === u) ?? null,
      getJoinedMemberCount: () => entry.members.filter((m) => m.membership === 'join').length,
      hasEncryptionStateEvent: () => false,
      currentState: {
        roomId: id,
        // The creation comes first, with the join: this session is the room's creator from the start.
        getStateEvents: (type: string, key: string) => {
          if (type === 'm.room.create' && key === '') return { getSender: () => ME, getType: () => type }
          return type === MARKER && key === '' && entry.marker ? { getContent: () => ({ kind: entry.marker }), getType: () => MARKER } : null
        },
      },
    }
    rooms.set(id, entry)
    return entry
  }
  const fakeClient = {
    on: (e: unknown, h: (...args: unknown[]) => void) => handlers.set(String(e), h),
    off: () => {},
    getUserId: () => ME,
    getRooms: () => [...rooms.values()].map((r) => r.room),
    getRoom: (id: string) => rooms.get(id)?.room ?? null,
    getAccountData: () => undefined,
    createRoom: () => new Promise<{ room_id: string }>((resolve) => answers.push((room_id) => resolve({ room_id }))),
    http: { authedRequest: async () => ({}) },
  }
  const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
  const internals = gateway as unknown as { client: unknown; live: boolean; wireEvents: (c: unknown) => void }
  internals.client = fakeClient
  ;(gateway as unknown as { sendEntryReceipt: () => void }).sendEntryReceipt = () => {}
  internals.wireEvents(fakeClient)
  internals.live = true
  const events: DomainEvent[] = []
  gateway.subscribe((e) => {
    if (e.t === 'channel.added' || e.t === 'channel.changed') events.push(e)
  })
  const seen = (id: string) =>
    events
      .filter((e) => (e.t === 'channel.added' || e.t === 'channel.changed') && String(e.channel.id) === id)
      .map((e) => (e.t === 'channel.added' || e.t === 'channel.changed' ? `${e.t}:${e.channel.kind}:${String(e.channel.peer ?? '')}` : ''))
  return {
    gateway,
    seen,
    // The creator's sync: the creation and the join.
    join: (id: string) => handlers.get('Room.myMembership')!(makeRoom(id).room, 'join', undefined),
    // A later sync: the marker.
    marker: (id: string) => {
      const entry = rooms.get(id)!
      entry.marker = 'direct'
      const state = (entry.room as { currentState: unknown }).currentState
      handlers.get('RoomState.events')!({ getType: () => MARKER, getContent: () => ({ kind: 'direct' }), getRoomId: () => id }, state, null)
    },
    // A later sync: the peer's invite.
    invite: (id: string, userId: string) => {
      rooms.get(id)!.members.push(member(userId, 'invite'))
      handlers.get('RoomState.members')!(undefined, undefined, { roomId: id, userId, membership: 'invite', powerLevel: 0 })
    },
    // The createRoom answer of the n-th opening.
    answer: async (n: number, roomId: string) => {
      answers[n]!(roomId)
      await vi.advanceTimersByTimeAsync(0)
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe("the creator's channel.added during an openDirectMessage (ADR-116 dec. 10)", () => {
  it('the room in pieces: one channel.added, direct with the peer, once whole; no channel.changed after it', async () => {
    vi.useFakeTimers()
    const h = harness()
    void h.gateway.openDirectMessage(PEER as UserId).catch(() => {})
    h.join('!a:server')
    expect(h.seen('!a:server')).toEqual([])
    h.marker('!a:server')
    expect(h.seen('!a:server')).toEqual([])
    h.invite('!a:server', PEER)
    expect(h.seen('!a:server')).toEqual([`channel.added:dm:${PEER}`])
    await h.answer(0, '!a:server')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(h.seen('!a:server')).toEqual([`channel.added:dm:${PEER}`])
  })

  it('the 3 s deadline releases one channel.added; the peer after it is a channel.changed, not a second added', async () => {
    vi.useFakeTimers()
    const h = harness()
    void h.gateway.openDirectMessage(PEER as UserId).catch(() => {})
    h.join('!a:server')
    await h.answer(0, '!a:server')
    await vi.advanceTimersByTimeAsync(2_999)
    expect(h.seen('!a:server')).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    // At the deadline the room goes as what it reads: after the answer this session's map write classifies it.
    expect(h.seen('!a:server')).toEqual([`channel.added:dm:${PEER}`])
    h.marker('!a:server')
    h.invite('!a:server', PEER)
    expect(h.seen('!a:server').filter((e) => e.startsWith('channel.added'))).toHaveLength(1)
  })

  it('the deadline with the opening still unanswered: one channel.added as the room reads (a private channel)', async () => {
    vi.useFakeTimers()
    const h = harness()
    void h.gateway.openDirectMessage(PEER as UserId).catch(() => {})
    h.join('!a:server')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(h.seen('!a:server')).toEqual(['channel.added:private:'])
    h.marker('!a:server')
    h.invite('!a:server', PEER)
    expect(h.seen('!a:server').filter((e) => e.startsWith('channel.added'))).toHaveLength(1)
    expect(h.seen('!a:server').at(-1)).toBe(`channel.changed:dm:${PEER}`)
  })

  it("a room that arrives during the opening and is not its own goes out at the createRoom answer", async () => {
    vi.useFakeTimers()
    const h = harness()
    void h.gateway.openDirectMessage(PEER as UserId).catch(() => {})
    h.join('!other:server')
    expect(h.seen('!other:server')).toEqual([])
    await h.answer(0, '!a:server')
    expect(h.seen('!other:server')).toEqual(['channel.added:private:'])
  })

  it("two openings at once: one's answer does not release the other's room", async () => {
    vi.useFakeTimers()
    const h = harness()
    void h.gateway.openDirectMessage(PEER as UserId).catch(() => {})
    void h.gateway.openDirectMessage(PEER2 as UserId).catch(() => {})
    h.join('!a:server')
    h.join('!b:server')
    await h.answer(1, '!b:server')
    expect(h.seen('!a:server')).toEqual([])
    expect(h.seen('!b:server')).toEqual([])
    await h.answer(0, '!a:server')
    expect(h.seen('!a:server')).toEqual([])
    h.marker('!a:server')
    h.invite('!a:server', PEER)
    h.marker('!b:server')
    h.invite('!b:server', PEER2)
    expect(h.seen('!a:server')).toEqual([`channel.added:dm:${PEER}`])
    expect(h.seen('!b:server')).toEqual([`channel.added:dm:${PEER2}`])
  })

  it('no opening in flight: nothing is held', () => {
    const h = harness()
    h.join('!a:server')
    expect(h.seen('!a:server')).toEqual(['channel.added:private:'])
  })
})
