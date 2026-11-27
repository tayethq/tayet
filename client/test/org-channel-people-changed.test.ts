import { describe, it, expect } from 'vitest'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import type { AclTelemetry, DomainEvent } from '../src/acl'

// PLANO-ADMIN (27/Nov/2026): the Admin's people list read before the organization channel counts as joined
// stayed empty, because nothing emitted people.changed on the first sync. The order is the one the probe
// measured (issue #7, 7216535775): the io.tayet.member state lands while #all is not in the client yet,
// listPeople() answers [], MyMembership none→join fires while #all is still not among getRooms(), and only
// then is the room stored. Fake-client idiom of group-channel-changed.test.ts: wireEvents on a recording
// fake, then drive the captured handlers.

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const ME = '@iara:tayet.local'
const ORG = '!all:tayet.local'
const ORG_MEMBER = 'io.tayet.member'

function harness() {
  const people: Array<[string, Record<string, unknown>]> = [
    ['iara:tayet.local', { kind: 'member', name: 'Iara Inácio', email: 'iara@tayet.local' }],
    ['davi:tayet.local', { kind: 'member', name: 'Davi Dantas', email: 'davi@tayet.local' }],
  ]
  const members = [{ userId: ME, rawDisplayName: 'iara', membership: 'join', powerLevel: 0, getMxcAvatarUrl: () => undefined }]
  const stateEvents = people.map(([key, content]) => ({ getType: () => ORG_MEMBER, getStateKey: () => key, getContent: () => content, getRoomId: () => ORG }))
  const room = {
    roomId: ORG,
    name: 'all',
    on: () => {},
    off: () => {},
    myUserId: ME,
    getMyMembership: () => 'join',
    isSpaceRoom: () => false,
    getJoinRule: () => 'invite',
    getCanonicalAlias: () => '#all:tayet.local',
    getMembers: () => members,
    getJoinedMembers: () => members,
    getMember: (id: string) => members.find((m) => m.userId === id) ?? null,
    getJoinedMemberCount: () => members.length,
    hasEncryptionStateEvent: () => false,
    getUnreadNotificationCount: () => 0,
    getLiveTimeline: () => ({ getEvents: () => [] }),
    currentState: {
      roomId: ORG,
      getStateEvents: (type: string, key?: string) => {
        if (type !== ORG_MEMBER) return key === undefined ? [] : null
        return key === undefined ? stateEvents : (stateEvents.find((e) => e.getStateKey() === key) ?? null)
      },
    },
  }
  // #all is not in the client until `store()`: getRoom and getRooms do not see it before.
  let stored = false
  const handlers = new Map<string, (...args: unknown[]) => void>()
  const fakeClient = {
    on: (e: unknown, h: (...args: unknown[]) => void) => handlers.set(String(e), h),
    off: () => {},
    getUserId: () => ME,
    getRooms: () => (stored ? [room] : []),
    getRoom: (id: string) => (stored && id === ORG ? room : null),
    getAccountData: () => undefined,
  }
  const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
  ;(gateway as unknown as { client: unknown }).client = fakeClient
  ;(gateway as unknown as { wireEvents: (c: unknown) => void }).wireEvents(fakeClient)
  const handler = (name: string): ((...args: unknown[]) => void) => {
    const h = handlers.get(name)
    if (!h) throw new Error(`listener ${name} not wired`)
    return h
  }
  const changed: DomainEvent[] = []
  ;(gateway as unknown as { subscribe: (h: (e: DomainEvent) => void) => void }).subscribe((e) => {
    if (e.t === 'people.changed') changed.push(e)
  })
  return {
    gateway,
    changed,
    fireMemberState: () => handler('RoomState.events')(stateEvents[0], room.currentState, null),
    fireMyJoin: () => handler('Room.myMembership')(room, 'join', undefined),
    store: () => {
      stored = true
    },
    fireRoom: () => handler('Room')(room),
    fireSync: (state: string) => handler('sync')(state, null),
  }
}

describe('people.changed when the organization channel becomes available', () => {
  it('the probe order: an empty first read, then one people.changed once #all counts as joined, and the list', () => {
    const h = harness()
    h.fireMemberState()
    expect(h.gateway.listPeople()).toEqual([])
    h.fireMyJoin()
    expect(h.changed).toHaveLength(0)
    h.store()
    h.fireRoom()
    h.fireSync('PREPARED')
    h.fireSync('SYNCING')
    expect(h.changed).toHaveLength(1)
    // The second read has the list (the session's own line carries its member display name).
    expect(h.gateway.listPeople().map((p) => p.user.displayName)).toEqual(['iara', 'Davi Dantas'])
  })

  it('the sync alone also reports it (no new-room event), once', () => {
    const h = harness()
    expect(h.gateway.listPeople()).toEqual([])
    h.store()
    h.fireSync('PREPARED')
    h.fireSync('SYNCING')
    expect(h.changed).toHaveLength(1)
  })
})
