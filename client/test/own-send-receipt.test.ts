import { describe, it, expect, vi } from 'vitest'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import type { AclTelemetry, ChannelId, MessageId } from '../src/acl'

// ADR-068 D7: after a successful send, the ACL sends a read receipt on the sent event itself, so the
// server stops counting what came before our own message. Measured before the fix (PLANO §8.32): an
// own thread reply left the server's per-thread count at 1, and an own main message left the room's at
// 1. The SDK picks the receipt's thread from the event, so the ACL only hands it the event. A thread
// reply has no findable local echo when the send resolves: its receipt waits for the remote echo. Unit harness
// with a fake SDK client (same shape as send-requires-known-channel); the server side lives in
// test/integration/acl-channel-count.test.ts.

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const ME = '@me:tayet.local'
const ROOM_ID = '!room:tayet.local'
const CH = ROOM_ID as unknown as ChannelId
const ROOT = '$root'

function harness(opts: { sentInRoom?: boolean; receiptFails?: boolean } = {}) {
  const sentEvent = { getId: () => '$sent' }
  const rootEvent = { getId: () => ROOT }
  const room = {
    roomId: ROOM_ID,
    getMyMembership: () => 'join',
    findEventById: (id: string) =>
      id === ROOT ? rootEvent : id === '$sent' && opts.sentInRoom !== false ? sentEvent : undefined,
    getLiveTimeline: () => ({ getEvents: () => [] }),
    getThread: () => ({ id: ROOT }),
    createThread: () => undefined,
    relations: { getChildEventsForEvent: () => undefined },
    hasEncryptionStateEvent: () => false,
  }
  const effects = {
    makeTxnId: vi.fn(() => 'txn-1'),
    getMediaConfig: vi.fn(async () => ({})),
    uploadContent: vi.fn(async () => ({ content_uri: 'mxc://x/y' })),
    sendMessage: vi.fn(async () => ({ event_id: '$sent' })),
    sendTextMessage: vi.fn(async () => ({ event_id: '$sent' })),
    sendReadReceipt: vi.fn(async () => (opts.receiptFails ? Promise.reject(new Error('receipt 500')) : {})),
  }
  const fakeClient = {
    getRooms: () => [room],
    getRoom: (id: string) => (id === ROOM_ID ? room : null),
    getUserId: () => ME,
    getAccountData: () => undefined,
    ...effects,
  }
  const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
  ;(gateway as unknown as { client: unknown }).client = fakeClient
  return { gateway, effects, sentEvent }
}

const attachment = () => ({
  kind: 'attachment' as const,
  file: new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' }),
})

describe('own send leaves the room read up to it (ADR-068 D7)', () => {
  it('a main-timeline text: receipt on the sent event, after the send', async () => {
    const { gateway, effects, sentEvent } = harness()
    await gateway.sendMessage(CH, { kind: 'text', text: 'hi' })
    expect(effects.sendReadReceipt).toHaveBeenCalledTimes(1)
    expect(effects.sendReadReceipt).toHaveBeenCalledWith(sentEvent)
    const sentOrder = effects.sendTextMessage.mock.invocationCallOrder[0]!
    const receiptOrder = effects.sendReadReceipt.mock.invocationCallOrder[0]!
    expect(receiptOrder).toBeGreaterThan(sentOrder)
  })

  it('a thread reply: receipt on the reply itself (the SDK makes it threaded from the event)', async () => {
    const { gateway, effects, sentEvent } = harness()
    await gateway.sendMessage(CH, { kind: 'text', text: 'in thread' }, { thread: ROOT as unknown as MessageId })
    expect(effects.sendMessage).toHaveBeenCalledTimes(1)
    expect(effects.sendReadReceipt).toHaveBeenCalledWith(sentEvent)
  })

  it('an attachment: receipt on the sent event', async () => {
    const { gateway, effects, sentEvent } = harness()
    await gateway.sendMessage(CH, attachment())
    expect(effects.sendReadReceipt).toHaveBeenCalledWith(sentEvent)
  })

  it('a failed receipt does not fail the send (best-effort)', async () => {
    const { gateway, effects } = harness({ receiptFails: true })
    await expect(gateway.sendMessage(CH, { kind: 'text', text: 'hi' })).resolves.toBe('txn-1')
    expect(effects.sendReadReceipt).toHaveBeenCalledTimes(1)
  })

  it('a failed send sends no receipt', async () => {
    const { gateway, effects } = harness()
    effects.sendTextMessage.mockRejectedValueOnce(new Error('send 500'))
    await expect(gateway.sendMessage(CH, { kind: 'text', text: 'hi' })).rejects.toThrow('send 500')
    expect(effects.sendReadReceipt).not.toHaveBeenCalled()
  })

  it('a sent event the room does not hold yet (a thread reply): the receipt goes with its remote echo, once', async () => {
    const { gateway, effects, sentEvent } = harness({ sentInRoom: false })
    await gateway.sendMessage(CH, { kind: 'text', text: 'in thread' }, { thread: ROOT as unknown as MessageId })
    expect(effects.sendReadReceipt).not.toHaveBeenCalled()
    // The remote echo arrives by sync (ThreadEvent.NewReply → onOwnEcho); any other event is ignored.
    const echo = (gateway as unknown as { onOwnEcho(e: unknown): void }).onOwnEcho.bind(gateway)
    echo({ getId: () => '$someone-else' })
    expect(effects.sendReadReceipt).not.toHaveBeenCalled()
    echo(sentEvent)
    echo(sentEvent)
    expect(effects.sendReadReceipt).toHaveBeenCalledTimes(1)
    expect(effects.sendReadReceipt).toHaveBeenCalledWith(sentEvent)
  })
})
