// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MatrixGateway, NOTIFICATION_TARGET_READ_MS } from '../src/acl/internal/matrix-client'
import { notificationTarget } from '../src/acl/internal/device-notifications'
import type { AclTelemetry, Message } from '../src/acl'

// ADR-117 dec. 5 (PR 5a of the push track): resolveNotificationTarget turns a notification's target into a
// conversation the session is in and lists — or undefined, never a rejection. The room lookup is local; the only
// read (the thread reply) goes through getMessage within NOTIFICATION_TARGET_READ_MS. The client is a fake.

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const ROOM = '!room:example.test'

function fakeRoom(over: { membership?: string; space?: boolean; archived?: boolean } = {}) {
  return {
    roomId: ROOM,
    getMyMembership: () => over.membership ?? 'join',
    isSpaceRoom: () => over.space ?? false,
    currentState: {
      getStateEvents: (type: string) => (type === 'io.tayet.archived' && over.archived ? { getContent: () => ({ active: true }) } : null),
    },
  }
}

function gateway(room: ReturnType<typeof fakeRoom> | null) {
  const getRoom = vi.fn((id: string) => (id === ROOM ? room : null))
  const gw = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
  Object.assign(gw as unknown as Record<string, unknown>, { client: { getRoom }, live: true })
  const getMessage = vi.spyOn(gw, 'getMessage')
  return { gw, getRoom, getMessage }
}

const reply = { id: '$reply', threadParent: '$root' } as unknown as Message

afterEach(() => vi.useRealTimers())

describe('resolveNotificationTarget', () => {
  it('a joined, listed conversation resolves to its channel, with no read', async () => {
    const { gw, getMessage } = gateway(fakeRoom())
    expect(await gw.resolveNotificationTarget({ conversation: ROOM, message: '$m' })).toEqual({ channel: ROOM })
    expect(getMessage).not.toHaveBeenCalled()
  })

  it('unknown, left, invited, a space, archived: undefined', async () => {
    expect(await gateway(fakeRoom()).gw.resolveNotificationTarget({ conversation: '!other:example.test' })).toBeUndefined()
    for (const room of [fakeRoom({ membership: 'leave' }), fakeRoom({ membership: 'invite' }), fakeRoom({ space: true }), fakeRoom({ archived: true })]) {
      const { gw, getMessage } = gateway(room)
      expect(await gw.resolveNotificationTarget({ conversation: ROOM, message: '$m', thread: '$t' })).toBeUndefined()
      expect(getMessage).not.toHaveBeenCalled()
    }
  })

  it('malformed input: undefined, without a lookup and without throwing', async () => {
    const { gw, getRoom } = gateway(fakeRoom())
    const bad: unknown[] = [
      null,
      'x',
      {},
      { conversation: 7 },
      { conversation: '' },
      { conversation: 'x'.repeat(256) },
      { conversation: ROOM, message: 1 },
      { conversation: ROOM, thread: 'y'.repeat(256) },
    ]
    for (const input of bad) expect(await gw.resolveNotificationTarget(input as never)).toBeUndefined()
    expect(getRoom).not.toHaveBeenCalled()
  })

  it('not connected: undefined', async () => {
    const gw = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
    expect(await gw.resolveNotificationTarget({ conversation: ROOM })).toBeUndefined()
  })

  it('a thread reply: the message read through getMessage', async () => {
    const { gw, getMessage } = gateway(fakeRoom())
    getMessage.mockResolvedValue(reply)
    expect(await gw.resolveNotificationTarget({ conversation: ROOM, message: '$reply', thread: '$root' })).toEqual({ channel: ROOM, message: reply })
    expect(getMessage).toHaveBeenCalledWith(ROOM, '$reply')
  })

  it('a thread reply that is gone or fails to read: the channel alone', async () => {
    const { gw, getMessage } = gateway(fakeRoom())
    getMessage.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('network'))
    expect(await gw.resolveNotificationTarget({ conversation: ROOM, message: '$reply', thread: '$root' })).toEqual({ channel: ROOM })
    expect(await gw.resolveNotificationTarget({ conversation: ROOM, message: '$reply', thread: '$root' })).toEqual({ channel: ROOM })
  })

  it('no answer within 3 s: the channel alone', async () => {
    vi.useFakeTimers()
    const { gw, getMessage } = gateway(fakeRoom())
    getMessage.mockReturnValue(new Promise(() => {}))
    const result = gw.resolveNotificationTarget({ conversation: ROOM, message: '$reply', thread: '$root' })
    await vi.advanceTimersByTimeAsync(NOTIFICATION_TARGET_READ_MS - 1)
    let settled = false
    void result.then(() => (settled = true))
    await Promise.resolve()
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toEqual({ channel: ROOM })
    expect(NOTIFICATION_TARGET_READ_MS).toBe(3_000)
  })
})

describe('notificationTarget (the shape)', () => {
  it('keeps the three strings', () => {
    expect(notificationTarget({ conversation: 'c', message: 'm', thread: 't' })).toEqual({ conversation: 'c', message: 'm', thread: 't' })
    expect(notificationTarget({ conversation: 'c'.repeat(255) })).toEqual({ conversation: 'c'.repeat(255), message: undefined, thread: undefined })
  })
})
