import { describe, it, expect } from 'vitest'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import type { AclTelemetry, DomainEvent } from '../src/acl'
import { findProtocolLeaks } from '@tayet/shared/leak-scan'

// ADR-094 (Proposto) dec. 5, unit side — no Synapse. Fake-client idiom of topic-channel-changed.test.ts and
// dm-avatar-refresh.test.ts: wireEvents on a recording fake, then drive the captured RoomState.events and
// RoomState.members handlers directly. Two new channel.changed triggers: the conversation marker changing,
// and a member event in a group room. A non-peer member event in an ordinary channel keeps the old contract.

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const ME = '@me:server'
const ROOM = '!g:server'
const MARKER = 'io.tayet.conversation'

function stateEvent(type: string, content: Record<string, unknown>): unknown {
  return { getType: () => type, getContent: () => content, getRoomId: () => ROOM }
}

interface FakeMember {
  userId: string
  rawDisplayName: string
  membership: string
  powerLevel: number
  getMxcAvatarUrl: () => undefined
}

const member = (userId: string, rawDisplayName: string, membership = 'join'): FakeMember => ({
  userId,
  rawDisplayName,
  membership,
  powerLevel: 0,
  getMxcAvatarUrl: () => undefined,
})

function harness(opts: { marker?: Record<string, unknown>; authored?: string }) {
  const members: FakeMember[] = [member(ME, 'Eu'), member('@bob:server', 'Bob'), member('@ana:server', 'Ana', 'invite')]
  const state: Record<string, unknown> = {}
  const setMarker = (content: Record<string, unknown> | undefined): void => {
    if (content === undefined) delete state[MARKER]
    else state[MARKER] = stateEvent(MARKER, content)
  }
  setMarker(opts.marker)
  const setName = (name: string): void => {
    state['m.room.name'] = stateEvent('m.room.name', { name })
  }
  if (opts.authored !== undefined) setName(opts.authored)
  const room = {
    roomId: ROOM,
    name: 'Bob and 1 other',
    myUserId: ME,
    getMyMembership: () => 'join',
    isSpaceRoom: () => false,
    getJoinRule: () => 'invite',
    getCanonicalAlias: () => null,
    getMembers: () => members,
    getJoinedMembers: () => members.filter((m) => m.membership === 'join'),
    getMember: (id: string) => members.find((m) => m.userId === id) ?? null,
    getJoinedMemberCount: () => members.filter((m) => m.membership === 'join').length,
    hasEncryptionStateEvent: () => false,
    currentState: { roomId: ROOM, getStateEvents: (type: string, key: string) => (key === '' ? (state[type] ?? null) : null) },
  }
  const handlers = new Map<string, (...args: unknown[]) => void>()
  const fakeClient = {
    on: (e: unknown, h: (...args: unknown[]) => void) => handlers.set(String(e), h),
    off: () => {},
    getUserId: () => ME,
    getRooms: () => [],
    getAccountData: () => undefined,
    getRoom: (id: string) => (id === ROOM ? room : null),
  }
  const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
  ;(gateway as unknown as { client: unknown }).client = fakeClient
  ;(gateway as unknown as { wireEvents: (c: unknown) => void }).wireEvents(fakeClient)
  const onStateEvent = handlers.get('RoomState.events')
  const onMembers = handlers.get('RoomState.members')
  if (!onStateEvent || !onMembers) throw new Error('listeners not wired')
  const events: DomainEvent[] = []
  const gw = gateway as unknown as { subscribe: (h: (e: DomainEvent) => void) => void }
  gw.subscribe((e) => {
    if (e.t === 'channel.changed' || e.t === 'member.changed') events.push(e)
  })
  // The SDK hands (event, state, prevEvent) after applying the event to currentState.
  const fireState = (event: unknown): void => onStateEvent(event, room.currentState, null)
  const fireMember = (userId: string, membership: string): void => {
    const m = members.find((x) => x.userId === userId)
    if (m) m.membership = membership
    else members.push(member(userId, userId.slice(1, userId.indexOf(':')), membership))
    onMembers(undefined, undefined, { roomId: ROOM, userId, membership, powerLevel: 0 })
  }
  return { fireState, fireMember, setMarker, setName, events }
}

const changed = (events: DomainEvent[]) =>
  events.filter((e): e is Extract<DomainEvent, { t: 'channel.changed' }> => e.t === 'channel.changed').map((e) => e.channel)

describe('onStateEvent — conversation marker (ADR-094 dec. 5)', () => {
  it('the marker turning into { kind: "channel" } → channel.changed, private, `#` name, no participants', () => {
    const h = harness({ marker: { kind: 'group' } })
    h.setMarker({ kind: 'channel' })
    h.setName('projeto')
    h.fireState(stateEvent(MARKER, { kind: 'channel' }))
    const [c] = changed(h.events)
    expect(changed(h.events)).toHaveLength(1)
    expect(c!.kind).toBe('private')
    expect(c!.name).toBe('#projeto')
    expect('participants' in c!).toBe(false)
  })

  it('the marker appearing with { kind: "group" } → channel.changed as a group', () => {
    const h = harness({})
    h.setMarker({ kind: 'group' })
    h.fireState(stateEvent(MARKER, { kind: 'group' }))
    const [c] = changed(h.events)
    expect(c).toMatchObject({ kind: 'group', name: 'Ana, Bob', participants: ['@ana:server', '@bob:server'] })
    expect(findProtocolLeaks(c)).toEqual([])
  })
})

describe('onMembers — group membership (ADR-094 dec. 5)', () => {
  it('a member event in a group room → member.changed, then channel.changed with the people updated', () => {
    const h = harness({ marker: { kind: 'group' } })
    h.fireMember('@ana:server', 'join')
    expect(h.events.map((e) => e.t)).toEqual(['member.changed', 'channel.changed'])
    h.events.length = 0
    h.fireMember('@bob:server', 'leave')
    const [c] = changed(h.events)
    expect(c).toMatchObject({ kind: 'group', name: 'Ana', participants: ['@ana:server'] })
  })

  it('custody churn in a group stays silent (guard above the triggers)', () => {
    const h = harness({ marker: { kind: 'group' } })
    h.fireMember('@cofre:server', 'join')
    expect(h.events).toEqual([])
  })

  it('a non-peer member event in an ordinary channel does not emit channel.changed (old contract)', () => {
    const h = harness({ authored: 'geral' })
    h.fireMember('@caio:server', 'join')
    expect(h.events.map((e) => e.t)).toEqual(['member.changed'])
  })

  it('a malformed marker is a channel: no channel.changed on member events', () => {
    const h = harness({ marker: { kind: 'Group' }, authored: 'geral' })
    h.fireMember('@caio:server', 'join')
    expect(h.events.map((e) => e.t)).toEqual(['member.changed'])
  })
})
