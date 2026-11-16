import { describe, it, expect, vi, afterEach } from 'vitest'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import { brandUserId } from '@tayet/shared/internal'
import type { AclTelemetry, DomainEvent, UserId } from '../src/acl'

// ADR-094 (Proposto) dec. 3 — PR-2 round 2 (PLANO-CONVERSAS §0.3.2 item 9). For the session that opens a group,
// the first domain event of the channel is a channel.added with kind 'group' and the requested participants,
// with no channel.added/channel.changed of that id before it. The ACL holds the creator's channel.added by
// knowledge — an opening in flight, and its set — never by the order the sync happens to deliver: the join
// may land before or after createRoom answers, the marker and the invites in the same sync or later ones.
// Safety deadline 3 s from the join. A room joined during an opening's window waits at most until that
// createRoom settles. Fake-client idiom of group-channel-changed.test.ts: wireEvents on a recording fake,
// then drive the captured MyMembership / RoomState handlers in the order of each case.

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const D = 'tayet.local'
const ME = `@me:${D}`
const B = `@b:${D}`
const C = `@c:${D}`
const ROOM = `!g:${D}`
const ALIEN = `!other:${D}`
const MARKER = 'io.tayet.conversation'

interface FakeMember {
  userId: string
  rawDisplayName: string
  membership: string
  powerLevel: number
  getMxcAvatarUrl: () => undefined
}
const member = (userId: string, membership = 'join'): FakeMember => ({
  userId,
  rawDisplayName: userId.slice(1, userId.indexOf(':')).toUpperCase(),
  membership,
  powerLevel: 0,
  getMxcAvatarUrl: () => undefined,
})

function fakeRoom(roomId: string) {
  const members: FakeMember[] = []
  const state: Record<string, unknown> = {}
  let mine = 'leave'
  const room = {
    roomId,
    name: 'Empty room',
    myUserId: ME,
    getMyMembership: () => mine,
    isSpaceRoom: () => false,
    getJoinRule: () => 'invite',
    getCanonicalAlias: () => null,
    getMembers: () => members,
    getJoinedMembers: () => members.filter((m) => m.membership === 'join'),
    getMember: (id: string) => members.find((m) => m.userId === id) ?? null,
    getJoinedMemberCount: () => members.filter((m) => m.membership === 'join').length,
    hasEncryptionStateEvent: () => true,
    getThread: () => undefined,
    findEventById: () => undefined,
    getUnreadNotificationCount: () => 0,
    getUnfilteredTimelineSet: () => ({ getTimelines: () => [] }),
    getThreads: () => [],
    hasUserReadEvent: () => true,
    currentState: {
      roomId,
      getStateEvents: (type: string, key?: string) => (key === '' ? (state[type] ?? null) : key === undefined ? [] : null),
      maySendStateEvent: () => true,
    },
  }
  const setMember = (userId: string, membership: string): void => {
    const m = members.find((x) => x.userId === userId)
    if (m) m.membership = membership
    else members.push(member(userId, membership))
    if (userId === ME) mine = membership
  }
  const setMarker = (content: Record<string, unknown>): void => {
    state[MARKER] = { getType: () => MARKER, getContent: () => content, getRoomId: () => roomId }
  }
  return { room, setMember, setMarker }
}

type Fake = ReturnType<typeof fakeRoom>

function harness() {
  const rooms = new Map<string, Fake>()
  const handlers = new Map<string, (...args: unknown[]) => void>()
  let answer: { resolve: (v: { room_id: string }) => void; reject: (e: unknown) => void } | undefined
  const createRoom = vi.fn(
    () =>
      new Promise<{ room_id: string }>((resolve, reject) => {
        answer = { resolve, reject }
      }),
  )
  const fakeClient = {
    on: (e: unknown, h: (...args: unknown[]) => void) => handlers.set(String(e), h),
    off: () => {},
    getUserId: () => ME,
    getRooms: () => [...rooms.values()].map((r) => r.room),
    getAccountData: () => undefined,
    getRoom: (id: string) => rooms.get(id)?.room ?? null,
    createRoom,
    stopClient: () => {},
    removeAllListeners: () => {},
  }
  const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
  ;(gateway as unknown as { client: unknown }).client = fakeClient
  ;(gateway as unknown as { inviteCustodian: () => Promise<void> }).inviteCustodian = async () => {}
  ;(gateway as unknown as { wireEvents: (c: unknown) => void }).wireEvents(fakeClient)
  const onMy = handlers.get('Room.myMembership')
  const onState = handlers.get('RoomState.events')
  const onMembers = handlers.get('RoomState.members')
  if (!onMy || !onState || !onMembers) throw new Error('listeners not wired')
  const events: DomainEvent[] = []
  ;(gateway as unknown as { subscribe: (h: (e: DomainEvent) => void) => void }).subscribe((e) => events.push(e))

  const room = (id: string): Fake => {
    let r = rooms.get(id)
    if (!r) {
      r = fakeRoom(id)
      rooms.set(id, r)
    }
    return r
  }
  const join = (id: string): void => {
    const r = room(id)
    r.setMember(ME, 'join')
    onMy(r.room, 'join', 'invite')
  }
  const marker = (id: string): void => {
    const r = room(id)
    r.setMarker({ kind: 'group' })
    onState({ getType: () => MARKER, getContent: () => ({ kind: 'group' }), getRoomId: () => id }, r.room.currentState, null)
  }
  const invite = (id: string, userId: string): void => {
    room(id).setMember(userId, 'invite')
    onMembers(undefined, undefined, { roomId: id, userId, membership: 'invite', powerLevel: 0 })
  }
  const open = () => gateway.openGroupConversation([brandUserId(B), brandUserId(C)] as UserId[])
  const respond = async (id: string): Promise<void> => {
    answer!.resolve({ room_id: id })
    await flush()
  }
  const fail = async (err: unknown): Promise<void> => {
    answer!.reject(err)
    await flush()
  }
  // Only the channel lifecycle events of one id (member.changed does not change, contract §1).
  const channelEvents = (id: string) =>
    events.filter(
      (e): e is Extract<DomainEvent, { t: 'channel.added' | 'channel.changed' }> =>
        (e.t === 'channel.added' || e.t === 'channel.changed') && String(e.channel.id) === id,
    )
  return { gateway, join, marker, invite, open, respond, fail, channelEvents }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

// The contract on the creator's side: the first lifecycle event of the id is channel.added, a whole group.
function expectWholeFirst(events: { t: string; channel: { kind: string; participants?: unknown } }[]): void {
  expect(events.length).toBeGreaterThan(0)
  expect(events[0]!.t).toBe('channel.added')
  expect(events[0]!.channel.kind).toBe('group')
  expect(new Set(events[0]!.channel.participants as string[])).toEqual(new Set([B, C]))
}

afterEach(() => {
  vi.useRealTimers()
})

describe("the creator's channel.added waits for the whole group (ADR-094 dec. 3, round 2)", () => {
  it('join before the marker: nothing until marker and both invites are in; then channel.added, group', async () => {
    const h = harness()
    const opened = h.open()
    await h.respond(ROOM)
    h.join(ROOM)
    expect(h.channelEvents(ROOM)).toEqual([])
    h.marker(ROOM)
    h.invite(ROOM, B)
    expect(h.channelEvents(ROOM)).toEqual([])
    h.invite(ROOM, C)
    expectWholeFirst(h.channelEvents(ROOM))
    await opened
  })

  it('join before createRoom answers (room already whole): held, released when the answer lands', async () => {
    const h = harness()
    const opened = h.open()
    await flush()
    h.marker(ROOM)
    h.invite(ROOM, B)
    h.invite(ROOM, C)
    h.join(ROOM)
    expect(h.channelEvents(ROOM)).toEqual([])
    await h.respond(ROOM)
    expectWholeFirst(h.channelEvents(ROOM))
    expect(String(await opened)).toBe(ROOM)
  })

  it('join after the answer, room whole by then: channel.added at once, group', async () => {
    const h = harness()
    const opened = h.open()
    await h.respond(ROOM)
    h.marker(ROOM)
    h.invite(ROOM, B)
    h.invite(ROOM, C)
    expect(h.channelEvents(ROOM)).toEqual([])
    h.join(ROOM)
    expectWholeFirst(h.channelEvents(ROOM))
    await opened
  })

  it('marker present, invites arriving one by one: released only with the last one', async () => {
    const h = harness()
    const opened = h.open()
    await h.respond(ROOM)
    h.marker(ROOM)
    h.join(ROOM)
    expect(h.channelEvents(ROOM)).toEqual([])
    h.invite(ROOM, B)
    expect(h.channelEvents(ROOM)).toEqual([])
    h.invite(ROOM, C)
    expectWholeFirst(h.channelEvents(ROOM))
    expect(h.channelEvents(ROOM).filter((e) => e.t === 'channel.added')).toHaveLength(1)
    await opened
  })

  it('3 s deadline: the channel.added goes with what the store has; later triggers carry on', async () => {
    vi.useFakeTimers()
    const h = harness()
    const opened = h.open()
    await h.respond(ROOM)
    h.join(ROOM)
    vi.advanceTimersByTime(2999)
    expect(h.channelEvents(ROOM)).toEqual([])
    vi.advanceTimersByTime(1)
    expect(h.channelEvents(ROOM).map((e) => e.t)).toEqual(['channel.added'])
    expect(h.channelEvents(ROOM)[0]!.channel.kind).toBe('private')
    h.marker(ROOM)
    expect(h.channelEvents(ROOM).map((e) => `${e.t}:${e.channel.kind}`)).toEqual(['channel.added:private', 'channel.changed:group'])
    await opened
    expect(vi.getTimerCount()).toBe(0)
  })

  it('createRoom rejected: nothing stays held, no timer left', async () => {
    vi.useFakeTimers()
    const h = harness()
    const opened = h.open().catch((e: unknown) => e)
    await flush()
    h.join(ALIEN)
    expect(h.channelEvents(ALIEN)).toEqual([])
    const boom = new Error('createRoom refused')
    await h.fail(boom)
    expect(await opened).toBe(boom)
    expect(h.channelEvents(ALIEN).map((e) => e.t)).toEqual(['channel.added'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('another room joined during the window is released when that createRoom answers', async () => {
    const h = harness()
    const opened = h.open()
    await flush()
    h.join(ALIEN)
    expect(h.channelEvents(ALIEN)).toEqual([])
    await h.respond(ROOM)
    expect(h.channelEvents(ALIEN).map((e) => e.t)).toEqual(['channel.added'])
    await opened
  })

  it('a room joined with no opening in flight is not held (channel.added at once)', () => {
    const h = harness()
    h.join(ALIEN)
    expect(h.channelEvents(ALIEN).map((e) => e.t)).toEqual(['channel.added'])
  })

  it('disconnect with a held room: timer cleared, nothing emitted after', async () => {
    vi.useFakeTimers()
    const h = harness()
    const opened = h.open()
    await h.respond(ROOM)
    await opened
    h.join(ROOM)
    expect(vi.getTimerCount()).toBeGreaterThan(0)
    await h.gateway.disconnect()
    expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(5000)
    expect(h.channelEvents(ROOM)).toEqual([])
  })
})
