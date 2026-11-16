import { describe, it, expect } from 'vitest'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import type { AclTelemetry, DomainEvent } from '../src/acl'
import { findProtocolLeaks } from '@tayet/shared/leak-scan'

// PLANO-PRESENCA §8.6 item 3, unit side — no Synapse. Fake-client idiom of §8.1
// (presence.test.ts): wireEvents on a recording fake, then drive the captured
// RoomState.members handler directly. The widening under test: a member event of a DM's
// PEER re-translates the channel (channel.changed with fresh peerAvatar/name). Narrow by
// design — non-peer churn in the same room and member events outside m.direct keep the
// old contract (member events never re-translate the channel).

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const ME = '@me:server'
const PEER = '@peer:server'
const DM_ROOM = '!dm:server'
const OTHER_ROOM = '!ch:server'

function fakeDmRoom(): unknown {
  const peerMember = {
    userId: PEER,
    rawDisplayName: 'Peer',
    powerLevel: 0,
    membership: 'join',
    getMxcAvatarUrl: () => 'mxc://server/fresh',
  }
  return {
    roomId: DM_ROOM,
    name: 'Peer',
    myUserId: ME,
    getMyMembership: () => 'join',
    isSpaceRoom: () => false,
    getJoinRule: () => 'invite',
    getCanonicalAlias: () => null,
    getJoinedMembers: () => [peerMember],
    getMember: (uid: string) => (uid === PEER ? peerMember : null),
    getJoinedMemberCount: () => 2,
    hasEncryptionStateEvent: () => false,
    currentState: { getStateEvents: () => null },
  }
}

function harness(): {
  fireMember: (roomId: string, userId: string) => void
  events: DomainEvent[]
} {
  const handlers = new Map<string, (...args: unknown[]) => void>()
  const fakeClient = {
    on: (e: unknown, h: (...args: unknown[]) => void) => handlers.set(String(e), h),
    off: () => {},
    getUserId: () => ME,
    getRooms: () => [],
    // m.direct: DM_ROOM is a DM with PEER; OTHER_ROOM is outside the map.
    getAccountData: () => ({ getContent: () => ({ [PEER]: [DM_ROOM] }) }),
    getRoom: (id: string) => (id === DM_ROOM ? fakeDmRoom() : null),
  }
  const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
  ;(gateway as unknown as { client: unknown }).client = fakeClient
  ;(gateway as unknown as { wireEvents: (c: unknown) => void }).wireEvents(fakeClient)
  const onMembers = handlers.get('RoomState.members')
  if (!onMembers) throw new Error('members listener not wired')
  const events: DomainEvent[] = []
  const gw = gateway as unknown as { subscribe: (h: (e: DomainEvent) => void) => void }
  gw.subscribe((e) => {
    if (e.t === 'member.changed' || e.t === 'channel.changed') events.push(e)
  })
  // The SDK hands (event, state, member); the handler only reads the member.
  const fireMember = (roomId: string, userId: string): void =>
    onMembers(undefined, undefined, { roomId, userId, membership: 'join', powerLevel: 0 })
  return { fireMember, events }
}

describe('onMembers — DM-peer widening (PLANO-PRESENCA §8.6 item 3)', () => {
  it('member event do PEER de sala em m.direct → channel.changed com o canal re-traduzido', () => {
    const { fireMember, events } = harness()
    fireMember(DM_ROOM, PEER)
    expect(events.map((e) => e.t)).toEqual(['member.changed', 'channel.changed'])
    const changed = events[1] as Extract<DomainEvent, { t: 'channel.changed' }>
    expect(changed.channel.kind).toBe('dm')
    expect(changed.channel.name).toBe('Peer')
    // Fresh re-translate carries the peer's photo as an opaque ref — present, never parsed.
    expect(changed.channel.peerAvatar).toBeDefined()
    for (const e of events) expect(findProtocolLeaks(e)).toEqual([])
  })

  it('member event de NÃO-peer na mesma sala → só member.changed (contrato antigo)', () => {
    const { fireMember, events } = harness()
    fireMember(DM_ROOM, ME)
    expect(events.map((e) => e.t)).toEqual(['member.changed'])
  })

  it('member event em sala fora do m.direct → só member.changed (contrato antigo)', () => {
    const { fireMember, events } = harness()
    fireMember(OTHER_ROOM, PEER)
    expect(events.map((e) => e.t)).toEqual(['member.changed'])
  })
})
