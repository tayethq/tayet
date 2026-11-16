import { describe, it, expect } from 'vitest'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import type { AclTelemetry, ChannelId, MessageId, RichDoc } from '../src/acl'

// Envelope assert for the reply send (PLANO-FASE-1-REPLY §5.3, commit 2). The ACL builds the reply
// relation BY HAND (the deliberate extension of the manual builder — THREADS §9 option (b)): the
// sent content must carry EXACTLY { 'm.relates_to': { 'm.in_reply_to': { event_id } } } — no
// rel_type, no is_falling_back — and NO legacy fallback (no <mx-reply> in formatted_body, no '> '
// lines injected into body). This is a UNIT harness with a fake SDK client capturing sendMessage's
// args, so it runs in CI; the sibling read-back assert against a real Synapse lives in
// test/integration/acl-reply.test.ts (local gate). The only-thread envelope assert
// (test/integration/acl-threads.test.ts) remains untouched.

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const ME = '@me:tayet.local'
const ROOM_ID = '!room:tayet.local'
const CHANNEL = ROOM_ID as unknown as ChannelId
const TARGET_REAL_ID = '$target:tayet.local'
const OWN_TXN = 'txn-own-settled'
const OWN_REAL_ID = '$own:tayet.local'
const PENDING_TXN = 'txn-own-pending'

// Received message from someone else — its stable id IS the real event id (ADR-008 Opt 1).
const targetEvent = {
  getType: () => 'm.room.message',
  isRedacted: () => false,
  getContent: () => ({ msgtype: 'm.text', body: 'target' }),
  getId: () => TARGET_REAL_ID,
  getTxnId: () => undefined,
  status: null,
}
// Our OWN already-settled send — stable id is the txn (ADR-010); the envelope must carry the
// reconciled REAL event id, never the txn.
const ownSettledEvent = {
  getType: () => 'm.room.message',
  isRedacted: () => false,
  getContent: () => ({ msgtype: 'm.text', body: 'mine' }),
  getId: () => OWN_REAL_ID,
  getTxnId: () => OWN_TXN,
  status: null,
}
// Our OWN still-pending send — only the SDK's local "~" placeholder exists. Reply must fail loud.
const ownPendingEvent = {
  getType: () => 'm.room.message',
  isRedacted: () => false,
  getContent: () => ({ msgtype: 'm.text', body: 'in flight' }),
  getId: () => `~${ROOM_ID}:${PENDING_TXN}`,
  getTxnId: () => PENDING_TXN,
  status: 'sending',
}

const fakeRoom = {
  roomId: ROOM_ID,
  getMyMembership: () => 'join',
  findEventById: (eid: string) => (eid === TARGET_REAL_ID ? targetEvent : undefined),
  getLiveTimeline: () => ({ getEvents: () => [targetEvent, ownSettledEvent, ownPendingEvent] }),
  getThread: () => undefined,
  relations: { getChildEventsForEvent: () => undefined },
}

function harness(): { gateway: MatrixGateway; sends: () => unknown[][] } {
  const sends: unknown[][] = []
  const fakeClient = {
    getRooms: () => [fakeRoom],
    getRoom: () => fakeRoom,
    getUserId: () => ME,
    getAccountData: () => undefined,
    makeTxnId: () => 'txn-new',
    sendMessage: async (...args: unknown[]) => {
      sends.push(args)
      return { event_id: '$new:tayet.local' }
    },
    sendTextMessage: async (...args: unknown[]) => {
      sends.push(['sendTextMessage', ...args])
      return { event_id: '$new:tayet.local' }
    },
  }
  const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
  ;(gateway as unknown as { client: unknown }).client = fakeClient
  return { gateway, sends: () => sends }
}

const mid = (s: string): MessageId => s as unknown as MessageId

describe('reply send envelope (PLANO-FASE-1-REPLY §5.3)', () => {
  it('carries EXACTLY m.in_reply_to.event_id — no rel_type, no is_falling_back, no fallback', async () => {
    const { gateway, sends } = harness()
    await gateway.sendMessage(CHANNEL, { kind: 'text', text: 'a reply' }, { replyTo: mid(TARGET_REAL_ID) })

    expect(sends()).toHaveLength(1)
    const [roomId, content, txnId] = sends()[0]! as [string, Record<string, unknown>, string]
    // No threadId arg between roomId and content: the SDK's addThreadRelationIfNeeded must stay a
    // no-op (it only acts when a threadId is passed — drift-verified on 41.6.0).
    expect(roomId).toBe(ROOM_ID)
    expect(txnId).toBe('txn-new')
    expect(content['m.relates_to']).toEqual({ 'm.in_reply_to': { event_id: TARGET_REAL_ID } })
    // Nothing else on the envelope or content: no rel_type/is_falling_back anywhere…
    const wire = JSON.stringify(content)
    expect(wire).not.toContain('rel_type')
    expect(wire).not.toContain('is_falling_back')
    // …and no legacy fallback injected into the content (PLANO-FASE-1-REPLY §0.3).
    expect(content['body']).toBe('a reply')
    expect(wire).not.toContain('mx-reply')
    expect(Object.keys(content).sort()).toEqual(['body', 'm.relates_to', 'msgtype'])
  })

  it('rich reply: same clean relation; formatted_body has no <mx-reply>, body has no "> " lines', async () => {
    const { gateway, sends } = harness()
    const rich: RichDoc = [{ t: 'p', children: [{ t: 'strong', children: [{ t: 'text', text: 'hi' }] }] }]
    await gateway.sendMessage(
      CHANNEL,
      { kind: 'text', text: '**hi**', rich },
      { replyTo: mid(TARGET_REAL_ID) },
    )

    const [, content] = sends()[0]! as [string, Record<string, unknown>]
    expect(content['m.relates_to']).toEqual({ 'm.in_reply_to': { event_id: TARGET_REAL_ID } })
    expect(String(content['formatted_body'])).not.toContain('mx-reply')
    expect(/^> /m.test(String(content['body']))).toBe(false)
    const wire = JSON.stringify(content)
    expect(wire).not.toContain('rel_type')
    expect(wire).not.toContain('is_falling_back')
  })

  it('resolves a reply to our OWN settled message (stable id = txn) to its REAL event id', async () => {
    const { gateway, sends } = harness()
    await gateway.sendMessage(CHANNEL, { kind: 'text', text: 'self-reply' }, { replyTo: mid(OWN_TXN) })

    const [, content] = sends()[0]! as [string, Record<string, unknown>]
    expect(content['m.relates_to']).toEqual({ 'm.in_reply_to': { event_id: OWN_REAL_ID } })
  })

  it('rejects thread + replyTo combined (reply-in-thread is deferred) without sending', async () => {
    const { gateway, sends } = harness()
    await expect(
      gateway.sendMessage(
        CHANNEL,
        { kind: 'text', text: 'x' },
        { thread: mid(TARGET_REAL_ID), replyTo: mid(TARGET_REAL_ID) },
      ),
    ).rejects.toThrow(/cannot reply inside a thread/)
    expect(sends()).toHaveLength(0)
  })

  it('rejects a reply to a still-pending target (no real event id yet) without sending', async () => {
    const { gateway, sends } = harness()
    await expect(
      gateway.sendMessage(CHANNEL, { kind: 'text', text: 'x' }, { replyTo: mid(PENDING_TXN) }),
    ).rejects.toThrow(/not found or not yet delivered/)
    expect(sends()).toHaveLength(0)
  })

  it('rejects a reply to an unknown target without sending', async () => {
    const { gateway, sends } = harness()
    await expect(
      gateway.sendMessage(CHANNEL, { kind: 'text', text: 'x' }, { replyTo: mid('$nope:tayet.local') }),
    ).rejects.toThrow(/not found/)
    expect(sends()).toHaveLength(0)
  })

  it('rejects replying with an attachment (text path only this slice) without sending', async () => {
    const { gateway, sends } = harness()
    await expect(
      gateway.sendMessage(
        CHANNEL,
        { kind: 'attachment', file: new Blob(['x']) },
        { replyTo: mid(TARGET_REAL_ID) },
      ),
    ).rejects.toThrow(/not supported/)
    expect(sends()).toHaveLength(0)
  })

  it('a plain send (no opts) still uses the prior sendTextMessage path, byte-for-byte', async () => {
    const { gateway, sends } = harness()
    await gateway.sendMessage(CHANNEL, { kind: 'text', text: 'plain' })
    expect(sends()).toEqual([['sendTextMessage', ROOM_ID, 'plain', 'txn-new']])
  })
})
