import { describe, it, expect } from 'vitest'
import { eventToMessage, genuineReplyTarget, type Ctx } from '../src/internal'
import type { AclTelemetry } from '../src'

// Commit 3 (PLANO-FASE-1-REPLY §2.2): Message.replyTo inbound — the exact mirror of threadParent.
// eventToMessage reads the GENUINE m.in_reply_to (never the thread rich-reply fallback) and
// resolves the target's real event id to its STABLE domain id (own target → txn, ADR-010).
// The optimistic echo needs no new path: the SDK's pending event carries the sent m.relates_to
// (drift-verified on 41.6.0), so translating it here births the bubble with replyTo set.

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const ME = '@me:tayet.local'
const ROOM_ID = '!room:tayet.local'
const TARGET_REAL_ID = '$target:tayet.local'
const OWN_TARGET_TXN = 'txn-own-target'

// Own messages' stable id is the txn; the gateway binds this lookup to the room.
const ctx: Ctx = {
  mode: 'strict',
  telemetry: noopTelemetry,
  isDm: () => false,
  myUserId: ME,
  stableIdFor: (realEventId) => (realEventId === TARGET_REAL_ID ? OWN_TARGET_TXN : realEventId),
}

type SdkEvent = Parameters<typeof eventToMessage>[0]

function fakeEvent(over: {
  content: Record<string, unknown>
  sender?: string
  txnId?: string
  id?: string
  status?: string
}): SdkEvent {
  return {
    getType: () => 'm.room.message',
    isRedacted: () => false,
    isDecryptionFailure: () => false,
    getContent: () => over.content,
    getOriginalContent: () => over.content,
    getId: () => over.id ?? '$evt:tayet.local',
    getTxnId: () => over.txnId,
    getSender: () => over.sender ?? '@other:tayet.local',
    getRoomId: () => ROOM_ID,
    getTs: () => 1000,
    replacingEventDate: () => undefined,
    getServerAggregatedRelation: () => undefined,
    status: over.status ?? null,
  } as unknown as SdkEvent
}

describe('Message.replyTo inbound (mirror of threadParent)', () => {
  it('populates replyTo from a bare m.in_reply_to, resolved to the stable id', () => {
    const msg = eventToMessage(
      fakeEvent({
        content: {
          msgtype: 'm.text',
          body: 'a reply',
          'm.relates_to': { 'm.in_reply_to': { event_id: TARGET_REAL_ID } },
        },
      }),
      ctx,
    )
    expect(msg?.replyTo).toBe(OWN_TARGET_TXN) // own target → its stable id (the txn), never the wire id
    expect(msg?.threadParent).toBeUndefined()
  })

  it('uses the real id as-is when the ctx has no room-bound resolver', () => {
    const msg = eventToMessage(
      fakeEvent({
        content: {
          msgtype: 'm.text',
          body: 'a reply',
          'm.relates_to': { 'm.in_reply_to': { event_id: '$other:tayet.local' } },
        },
      }),
      { ...ctx, stableIdFor: undefined },
    )
    expect(msg?.replyTo).toBe('$other:tayet.local')
  })

  it('our own optimistic reply echo is BORN with replyTo (pending, stable id = txn)', () => {
    const msg = eventToMessage(
      fakeEvent({
        content: {
          msgtype: 'm.text',
          body: 'my reply',
          'm.relates_to': { 'm.in_reply_to': { event_id: TARGET_REAL_ID } },
        },
        sender: ME,
        txnId: 'txn-echo',
        id: `~${ROOM_ID}:txn-echo`,
        status: 'sending',
      }),
      ctx,
    )
    expect(msg?.status).toBe('pending')
    expect(msg?.id).toBe('txn-echo')
    expect(msg?.replyTo).toBe(OWN_TARGET_TXN)
    expect(msg?.mine).toBe(true)
  })

  it('does NOT mint replyTo from the thread rich-reply FALLBACK (is_falling_back true)', () => {
    const msg = eventToMessage(
      fakeEvent({
        content: {
          msgtype: 'm.text',
          body: 'thread reply',
          'm.relates_to': {
            rel_type: 'm.thread',
            event_id: '$root:tayet.local',
            is_falling_back: true,
            'm.in_reply_to': { event_id: '$last:tayet.local' },
          },
        },
      }),
      ctx,
    )
    expect(msg?.threadParent).toBe('$root:tayet.local')
    expect(msg?.replyTo).toBeUndefined() // fallback is representation, not a reply
  })

  it('a GENUINE reply inside a thread (is_falling_back false) carries both relations inbound', () => {
    // Outbound reply-in-thread is deferred (PLANO-FASE-1-REPLY §0.7), but another client may send one;
    // the inbound translation is additive and loses nothing.
    const msg = eventToMessage(
      fakeEvent({
        content: {
          msgtype: 'm.text',
          body: 'genuine in-thread reply',
          'm.relates_to': {
            rel_type: 'm.thread',
            event_id: '$root:tayet.local',
            is_falling_back: false,
            'm.in_reply_to': { event_id: '$sibling:tayet.local' },
          },
        },
      }),
      ctx,
    )
    expect(msg?.threadParent).toBe('$root:tayet.local')
    expect(msg?.replyTo).toBe('$sibling:tayet.local')
  })

  it('a plain message has no replyTo', () => {
    const msg = eventToMessage(fakeEvent({ content: { msgtype: 'm.text', body: 'hi' } }), ctx)
    expect(msg?.replyTo).toBeUndefined()
  })
})

describe('genuineReplyTarget', () => {
  it('reads only the genuine reply relation', () => {
    expect(genuineReplyTarget({ 'm.relates_to': { 'm.in_reply_to': { event_id: '$a' } } })).toBe('$a')
    expect(genuineReplyTarget({})).toBeUndefined()
    expect(
      genuineReplyTarget({
        'm.relates_to': { rel_type: 'm.thread', event_id: '$r', 'm.in_reply_to': { event_id: '$a' } },
      }),
    ).toBeUndefined() // absent is_falling_back under m.thread → conservative: fallback
  })
})
