import { describe, it, expect, vi } from 'vitest'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import type { AclTelemetry, ChannelId, DomainEvent, MessageId } from '../src/acl'

// ADR-058 / PLANO-GATES §8.14: sendMessage only works for a channel the session KNOWS.
// For an unknown channel it rejects with the same 'channel not found' as the read verbs, BEFORE any
// effect — no pending echo, no media-config read, no upload, no send. Unit harness with a fake SDK
// client (same shape as reply-envelope / decrypt-cycle), so the contract runs in CI without a stack;
// the integration side lives in test/integration/acl-send-unknown-channel.test.ts.

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const ME = '@me:tayet.local'
const KNOWN_ROOM_ID = '!known:tayet.local'
const INVITED_ROOM_ID = '!invited:tayet.local'
const LEFT_ROOM_ID = '!left:tayet.local'
const UNKNOWN = '!unknown:tayet.local' as unknown as ChannelId
const KNOWN = KNOWN_ROOM_ID as unknown as ChannelId
const INVITED = INVITED_ROOM_ID as unknown as ChannelId
const LEFT = LEFT_ROOM_ID as unknown as ChannelId

const roomWith = (roomId: string, membership: string) => ({
  roomId,
  getMyMembership: () => membership,
  findEventById: () => undefined,
  getLiveTimeline: () => ({ getEvents: () => [] }),
  getThread: () => undefined,
  createThread: () => undefined,
  relations: { getChildEventsForEvent: () => undefined },
  hasEncryptionStateEvent: () => false,
})
const knownRoom = roomWith(KNOWN_ROOM_ID, 'join')
// In the store but the session is NOT a member: a pending invite, or a channel it left and has
// not forgotten. Not "known" for sending (ADR-058 dec. 1).
const invitedRoom = roomWith(INVITED_ROOM_ID, 'invite')
const leftRoom = roomWith(LEFT_ROOM_ID, 'leave')
const storeRooms = new Map([
  [KNOWN_ROOM_ID, knownRoom],
  [INVITED_ROOM_ID, invitedRoom],
  [LEFT_ROOM_ID, leftRoom],
])

function harness() {
  const effects = {
    makeTxnId: vi.fn(() => 'txn-1'),
    getMediaConfig: vi.fn(async () => ({})),
    uploadContent: vi.fn(async () => ({ content_uri: 'mxc://x/y' })),
    sendMessage: vi.fn(async () => ({ event_id: '$sent' })),
    sendTextMessage: vi.fn(async () => ({ event_id: '$sent' })),
  }
  const fakeClient = {
    getRooms: () => [...storeRooms.values()],
    getRoom: (id: string) => storeRooms.get(id) ?? null,
    getUserId: () => ME,
    getAccountData: () => undefined,
    ...effects,
  }
  const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
  ;(gateway as unknown as { client: unknown }).client = fakeClient
  const events: DomainEvent[] = []
  gateway.subscribe((e) => events.push(e))
  const noEffect = (): void => {
    for (const [name, fn] of Object.entries(effects)) expect(fn, `${name} called`).not.toHaveBeenCalled()
    expect(events, 'events emitted').toEqual([])
  }
  return { gateway, effects, events, noEffect }
}

const attachment = () => ({
  kind: 'attachment' as const,
  file: new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' }),
})

describe('sendMessage requires a known channel (ADR-058, fail-closed)', () => {
  it('control: a known channel reaches the send (the fake sees effects)', async () => {
    const { gateway, effects, events } = harness()
    await gateway.sendMessage(KNOWN, { kind: 'text', text: 'hi' })
    await gateway.sendMessage(KNOWN, attachment())
    expect(effects.sendTextMessage).toHaveBeenCalledTimes(1)
    expect(effects.uploadContent).toHaveBeenCalledTimes(1)
    expect(effects.sendMessage).toHaveBeenCalledTimes(1)
    expect(events.some((e) => e.t === 'message.received' && e.message.status === 'pending')).toBe(true)
  })

  it('text to an unknown channel rejects before any effect', async () => {
    const { gateway, noEffect } = harness()
    await expect(gateway.sendMessage(UNKNOWN, { kind: 'text', text: 'hi' })).rejects.toThrow('channel not found')
    noEffect()
  })

  it('text in a thread to an unknown channel rejects (the thread intent is never dropped)', async () => {
    const { gateway, noEffect } = harness()
    await expect(
      gateway.sendMessage(UNKNOWN, { kind: 'text', text: 'hi' }, { thread: '$root' as unknown as MessageId }),
    ).rejects.toThrow('channel not found')
    noEffect()
  })

  it('attachment to an unknown channel rejects before pending, media config or upload', async () => {
    const { gateway, noEffect } = harness()
    await expect(gateway.sendMessage(UNKNOWN, attachment())).rejects.toThrow('channel not found')
    noEffect()
  })

  for (const [label, channel] of [
    ['a pending invite', INVITED],
    ['a channel the session left', LEFT],
  ] as const) {
    it(`text to ${label} (in the store, not a member) rejects before any effect`, async () => {
      const { gateway, noEffect } = harness()
      await expect(gateway.sendMessage(channel, { kind: 'text', text: 'hi' })).rejects.toThrow('channel not found')
      noEffect()
    })

    it(`attachment to ${label} (in the store, not a member) rejects before any effect`, async () => {
      const { gateway, noEffect } = harness()
      await expect(gateway.sendMessage(channel, attachment())).rejects.toThrow('channel not found')
      noEffect()
    })
  }
})
