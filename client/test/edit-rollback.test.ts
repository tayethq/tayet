import { describe, it, expect } from 'vitest'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import type { AclTelemetry, DomainEvent, MessageId } from '../src/acl'

// Rollback of a FAILED edit (plan-level, not an ADR). editMessage emits the optimistic message.edited
// BEFORE awaiting the send; if the send rejects, the gateway must re-emit the PRE-edit view under the
// SAME stable id and re-throw — otherwise the UI keeps content that never persisted (an edit has no
// status:'failed' the way a send does, ADR-010). This is a UNIT harness: we inject a fake SDK client
// whose sendMessage rejects, so no Synapse is needed (it runs in CI).

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const ME = '@me:tayet.local'
const REAL_ID = '$evt:tayet.local'
const ROOM_ID = '!room:tayet.local'

// Minimal fake MatrixEvent — only the surface eventToMessage/locate/ctx touch (the original, pre-edit
// message: plain text "before", never edited, authored by the session user).
const fakeEvent = {
  getType: () => 'm.room.message',
  isRedacted: () => false,
  isDecryptionFailure: () => false,
  getContent: () => ({ msgtype: 'm.text', body: 'before' }),
  getOriginalContent: () => ({ msgtype: 'm.text', body: 'before' }),
  getId: () => REAL_ID,
  getTxnId: () => undefined,
  getSender: () => ME,
  getRoomId: () => ROOM_ID,
  getTs: () => 1000,
  replacingEventDate: () => undefined,
  getServerAggregatedRelation: () => undefined,
  getRelation: () => null,
  status: undefined,
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

function gatewayWithFailingSend(): { gateway: MatrixGateway; sendCalls: () => number } {
  let sendCalls = 0
  const fakeClient = {
    getRooms: () => [fakeRoom],
    getRoom: () => fakeRoom,
    getUserId: () => ME,
    getAccountData: () => undefined,
    makeTxnId: () => 'txn-1',
    sendMessage: async () => {
      sendCalls++
      throw new Error('send rejected')
    },
  }
  const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
  ;(gateway as unknown as { client: unknown }).client = fakeClient
  return { gateway, sendCalls: () => sendCalls }
}

describe('editMessage rollback on terminal send failure', () => {
  it('emits optimistic-new, then rolls back to original, then rejects (in that order)', async () => {
    const { gateway } = gatewayWithFailingSend()
    const events: DomainEvent[] = []
    gateway.subscribe((e) => events.push(e))
    const messageId = REAL_ID as MessageId

    await expect(gateway.editMessage(messageId, { kind: 'text', text: 'after' })).rejects.toThrow(
      /send rejected/,
    )

    const edits = events.filter((e) => e.t === 'message.edited')
    expect(edits).toHaveLength(2)

    // (a) optimistic edit carries the NEW text under the stable id…
    const first = edits[0]!
    if (first.t !== 'message.edited') throw new Error('unreachable')
    expect(first.message.id).toBe(messageId)
    expect(first.message.body.kind).toBe('text')
    if (first.message.body.kind === 'text') expect(first.message.body.text).toBe('after')
    expect(first.message.editedAt).toBeDefined()

    // (b) after the rejection, the ORIGINAL text is re-emitted under the SAME id, with the original
    //     editedAt (undefined here → the "(edited)" badge would clear).
    const second = edits[1]!
    if (second.t !== 'message.edited') throw new Error('unreachable')
    expect(second.message.id).toBe(messageId)
    expect(second.message.body.kind).toBe('text')
    if (second.message.body.kind === 'text') expect(second.message.body.text).toBe('before')
    expect(second.message.editedAt).toBeUndefined()
  })
})
