import { describe, it, expect } from 'vitest'
import { editToMessage, type Ctx } from '@tayet/shared/internal'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import type { AclTelemetry, DomainEvent, MessageId } from '../src/acl'

// Regression for the pre-existing fresta fixed in this slice (PLANO-FASE-1-REPLY §0.6): editToMessage
// hardcoded threadParent: undefined, so the SYNCED m.replace path (onTimeline → editToMessage)
// zeroed the target's relation — and with Message.replyTo entering, it would zero TWO relations.
// The fix derives both from the TARGET event's ORIGINAL content (getContent() of an already-
// replaced event returns the edit's m.new_content, which carries no relation), keeping the synced
// path symmetric with the optimistic edit echo.

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const ME = '@me:tayet.local'
const ROOM_ID = '!room:tayet.local'
const ROOT_ID = '$root:tayet.local'
const REPLY_TARGET_ID = '$target:tayet.local'

const ctx: Ctx = {
  mode: 'strict',
  telemetry: noopTelemetry,
  isDm: () => false,
  myUserId: ME,
}

type EditArgs = Parameters<typeof editToMessage>

function fakeEdit(newText: string, targetEventId: string): EditArgs[0] {
  return {
    getContent: () => ({
      msgtype: 'm.text',
      body: `* ${newText}`,
      'm.new_content': { msgtype: 'm.text', body: newText },
      'm.relates_to': { rel_type: 'm.replace', event_id: targetEventId },
    }),
    getSender: () => ME,
    getRoomId: () => ROOM_ID,
    getTs: () => 2000,
  } as unknown as EditArgs[0]
}

// A target event whose ORIGINAL content carries a relation; `replaced` simulates a previously
// edited target (getContent returns the prior edit's m.new_content — relation absent).
function fakeTarget(
  relates: Record<string, unknown> | undefined,
  opts?: { replaced?: boolean },
): NonNullable<EditArgs[3]> {
  const original: Record<string, unknown> = { msgtype: 'm.text', body: 'original' }
  if (relates) original['m.relates_to'] = relates
  const current = opts?.replaced ? { msgtype: 'm.text', body: 'first edit' } : original
  return {
    getContent: () => current,
    getOriginalContent: () => original,
    getId: () => '$edited:tayet.local',
    getTxnId: () => undefined,
    getTs: () => 1000,
    getServerAggregatedRelation: () => undefined,
  } as unknown as NonNullable<EditArgs[3]>
}

describe('editToMessage preserves the TARGET relations (synced m.replace path)', () => {
  it('a synced edit of a THREAD REPLY keeps threadParent', () => {
    const target = fakeTarget({ rel_type: 'm.thread', event_id: ROOT_ID, is_falling_back: true })
    const msg = editToMessage(fakeEdit('new text', '$edited:tayet.local'), '$edited:tayet.local', ctx, target)
    expect(msg.threadParent).toBe(ROOT_ID)
    expect(msg.replyTo).toBeUndefined() // the thread fallback in_reply_to never mints a replyTo
    expect(msg.body).toEqual({ kind: 'text', text: 'new text' })
    expect(msg.sentAt).toBe(1000) // original timestamp stays truthful
    expect(msg.editedAt).toBe(2000)
  })

  it('a synced edit of a REPLY keeps replyTo', () => {
    const target = fakeTarget({ 'm.in_reply_to': { event_id: REPLY_TARGET_ID } })
    const msg = editToMessage(fakeEdit('new text', '$edited:tayet.local'), '$edited:tayet.local', ctx, target)
    expect(msg.replyTo).toBe(REPLY_TARGET_ID)
    expect(msg.threadParent).toBeUndefined()
  })

  it('a SECOND edit still keeps the relation (read off the ORIGINAL content, not the replaced one)', () => {
    const target = fakeTarget({ 'm.in_reply_to': { event_id: REPLY_TARGET_ID } }, { replaced: true })
    expect((target.getContent() as Record<string, unknown>)['m.relates_to']).toBeUndefined() // the trap
    const msg = editToMessage(fakeEdit('second edit', '$edited:tayet.local'), '$edited:tayet.local', ctx, target)
    expect(msg.replyTo).toBe(REPLY_TARGET_ID)
  })

  it('without the original in hand, relations stay absent (never invented)', () => {
    const msg = editToMessage(fakeEdit('new text', '$gone:tayet.local'), '$gone:tayet.local', ctx, undefined)
    expect(msg.threadParent).toBeUndefined()
    expect(msg.replyTo).toBeUndefined()
  })
})

// The OPTIMISTIC edit echo (gateway) must stay symmetric with the synced path above.
describe('optimistic edit echo preserves the TARGET relations', () => {
  it("editing one's own reply emits message.edited still carrying replyTo", async () => {
    const REAL_ID = '$mine:tayet.local'
    const fakeEvent = {
      getType: () => 'm.room.message',
      isRedacted: () => false,
      isDecryptionFailure: () => false,
      getContent: () => ({
        msgtype: 'm.text',
        body: 'before',
        'm.relates_to': { 'm.in_reply_to': { event_id: REPLY_TARGET_ID } },
      }),
      getOriginalContent: () => ({
        msgtype: 'm.text',
        body: 'before',
        'm.relates_to': { 'm.in_reply_to': { event_id: REPLY_TARGET_ID } },
      }),
      getId: () => REAL_ID,
      getTxnId: () => undefined,
      getSender: () => ME,
      getRoomId: () => ROOM_ID,
      getTs: () => 1000,
      replacingEventDate: () => undefined,
      getServerAggregatedRelation: () => undefined,
      status: null,
    }
    const fakeRoom = {
      getMyMembership: () => 'join',
      // PLANO-AGENTES §0.3.11: the translator asks kindOf for every author; the gateway looks for the
      // organization channel by alias — this room is not it.
      getCanonicalAlias: () => null,
      roomId: ROOM_ID,
      findEventById: (id: string) => (id === REAL_ID ? fakeEvent : undefined),
      getThread: () => undefined,
      getLiveTimeline: () => ({ getEvents: () => [fakeEvent] }),
      relations: { getChildEventsForEvent: () => undefined },
    }
    const fakeClient = {
      getRooms: () => [fakeRoom],
      getRoom: () => fakeRoom,
      getUserId: () => ME,
      getAccountData: () => undefined,
      makeTxnId: () => 'txn-1',
      sendMessage: async () => ({ event_id: '$edit:tayet.local' }),
    }
    const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
    ;(gateway as unknown as { client: unknown }).client = fakeClient

    const events: DomainEvent[] = []
    gateway.subscribe((e) => events.push(e))
    await gateway.editMessage(REAL_ID as MessageId, { kind: 'text', text: 'after' })

    const edited = events.find((e) => e.t === 'message.edited')
    expect(edited).toBeTruthy()
    if (edited?.t === 'message.edited') {
      expect(edited.message.replyTo).toBe(REPLY_TARGET_ID)
      expect(edited.message.threadParent).toBeUndefined()
      if (edited.message.body.kind === 'text') expect(edited.message.body.text).toBe('after')
    }
  })
})
