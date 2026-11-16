import { describe, it, expect } from 'vitest'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import type { AclTelemetry, DomainEvent } from '../src/acl'

// #245, unit side — no Synapse. Fake-client idiom of dm-avatar-refresh.test.ts: wireEvents on a
// recording fake, then drive the captured RoomState.events handler directly. This is the
// discriminating proof: against the stack the topic also rides on the same sync's unread/receipt
// channel.changed, so acl-membership 4c passes with or without the listener; here only the
// m.room.topic branch can emit.

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const ME = '@me:server'
const ROOM = '!ch:server'

function stateEvent(type: string, content: Record<string, unknown>): unknown {
  return { getType: () => type, getContent: () => content, getRoomId: () => ROOM }
}

function harness(opts: { topic: string; archived?: boolean; membership?: string }): {
  fireState: (event: unknown) => void
  events: DomainEvent[]
} {
  const state: Record<string, unknown> = {
    'm.room.topic': stateEvent('m.room.topic', { topic: opts.topic }),
    ...(opts.archived ? { 'io.tayet.archived': stateEvent('io.tayet.archived', { active: true }) } : {}),
  }
  const room = {
    roomId: ROOM,
    name: 'geral',
    myUserId: ME,
    getMyMembership: () => opts.membership ?? 'join',
    isSpaceRoom: () => false,
    getJoinRule: () => 'invite',
    getCanonicalAlias: () => null,
    getMembers: () => [],
    getJoinedMembers: () => [],
    getMember: () => null,
    getJoinedMemberCount: () => 1,
    hasEncryptionStateEvent: () => false,
    currentState: { roomId: ROOM, getStateEvents: (type: string) => state[type] ?? null },
  }
  const handlers = new Map<string, (...args: unknown[]) => void>()
  const fakeClient = {
    on: (e: unknown, h: (...args: unknown[]) => void) => handlers.set(String(e), h),
    off: () => {},
    getUserId: () => ME,
    getAccountData: () => undefined,
    getRoom: (id: string) => (id === ROOM ? room : null),
  }
  const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
  ;(gateway as unknown as { client: unknown }).client = fakeClient
  ;(gateway as unknown as { wireEvents: (c: unknown) => void }).wireEvents(fakeClient)
  const onStateEvent = handlers.get('RoomState.events')
  if (!onStateEvent) throw new Error('state-events listener not wired')
  const events: DomainEvent[] = []
  const gw = gateway as unknown as { subscribe: (h: (e: DomainEvent) => void) => void }
  gw.subscribe((e) => events.push(e))
  // The SDK hands (event, state, prevEvent); the SDK already applied the event to currentState.
  const fireState = (event: unknown): void => onStateEvent(event, room.currentState, null)
  return { fireState, events }
}

describe('onStateEvent — topic-only change (#245, ADR-026 §1)', () => {
  it('m.room.topic → channel.changed carrying the new topic', () => {
    const { fireState, events } = harness({ topic: 'tópico novo' })
    fireState(stateEvent('m.room.topic', { topic: 'tópico novo' }))
    expect(events.map((e) => e.t)).toEqual(['channel.changed'])
    const changed = events[0] as Extract<DomainEvent, { t: 'channel.changed' }>
    expect(changed.channel.topic).toBe('tópico novo')
  })

  it('archived channel: a topic change does not re-surface it (emitChannelChanged guard)', () => {
    const { fireState, events } = harness({ topic: 'x', archived: true })
    fireState(stateEvent('m.room.topic', { topic: 'x' }))
    expect(events).toEqual([])
  })

  it('not joined: a topic change emits nothing', () => {
    const { fireState, events } = harness({ topic: 'x', membership: 'invite' })
    fireState(stateEvent('m.room.topic', { topic: 'x' }))
    expect(events).toEqual([])
  })

  it('other state types stay silent (only topic and io.tayet.archived are handled)', () => {
    const { fireState, events } = harness({ topic: 'x' })
    fireState(stateEvent('m.room.join_rules', { join_rule: 'invite' }))
    expect(events).toEqual([])
  })
})
