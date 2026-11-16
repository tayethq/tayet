import { describe, it, expect } from 'vitest'
import { mentionsUser, eventToMessage, editToMessage, type Ctx } from '../src/internal'
import type { AclTelemetry } from '../src'
import type { MatrixEvent } from 'matrix-js-sdk'

// ADR-037 addendum (M1 inbound): menção = INTENÇÃO declarada em `m.mentions.user_ids` (espelho inbound
// do M2 outbound), NÃO o highlight amplo da push-rule (que casava display name como substring — "oi
// bob" destacava). mentionsUser lê o próprio conteúdo do evento; Message.mentionsMe NUNCA carrega
// mxid/m.mentions no domínio (P1) — é um booleano derivado por este helper.

const ME = '@me:tayet.local'
const OTHER = '@other:tayet.local'

function fakeContent(content: Record<string, unknown>): MatrixEvent {
  return { getContent: () => ({ msgtype: 'm.text', body: 'hi', ...content }) } as unknown as MatrixEvent
}

describe('mentionsUser (intentional m.mentions, ADR-037 addendum M1)', () => {
  it('m.mentions.user_ids includes me → true', () => {
    expect(mentionsUser(fakeContent({ 'm.mentions': { user_ids: [ME] } }), ME)).toBe(true)
  })

  it('m.mentions.user_ids only another id → false', () => {
    expect(mentionsUser(fakeContent({ 'm.mentions': { user_ids: [OTHER] } }), ME)).toBe(false)
  })

  it('body "oi bob" without m.mentions → false (a display-name substring never highlights)', () => {
    expect(mentionsUser(fakeContent({ body: 'oi bob' }), ME)).toBe(false)
  })

  it('no m.mentions at all → false', () => {
    expect(mentionsUser(fakeContent({}), ME)).toBe(false)
  })

  it('myUserId null (room-agnostic ctx) → false even with an m.mentions', () => {
    expect(mentionsUser(fakeContent({ 'm.mentions': { user_ids: [ME] } }), null)).toBe(false)
  })
})

// Wiring: eventToMessage derives Message.mentionsMe from the event's own m.mentions (not a ctx hook).
const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const ROOM_ID = '!room:tayet.local'
const baseCtx: Ctx = { mode: 'strict', telemetry: noopTelemetry, isDm: () => false, myUserId: ME }

type SdkEvent = Parameters<typeof eventToMessage>[0]

function fakeEvent(over: {
  sender?: string
  txnId?: string
  id?: string
  status?: string
  content?: Record<string, unknown>
}): SdkEvent {
  const content = { msgtype: 'm.text', body: 'hi', ...over.content }
  return {
    getType: () => 'm.room.message',
    isRedacted: () => false,
    isDecryptionFailure: () => false,
    getContent: () => content,
    getOriginalContent: () => content,
    getId: () => over.id ?? '$evt:tayet.local',
    getTxnId: () => over.txnId,
    getSender: () => over.sender ?? OTHER,
    getRoomId: () => ROOM_ID,
    getTs: () => 1000,
    replacingEventDate: () => undefined,
    getServerAggregatedRelation: () => undefined,
    status: over.status ?? null,
  } as unknown as SdkEvent
}

describe('eventToMessage wires mentionsMe from m.mentions (ADR-037 addendum M1)', () => {
  it('event carries m.mentions with my id → mentionsMe true', () => {
    const msg = eventToMessage(fakeEvent({ content: { 'm.mentions': { user_ids: [ME] } } }), baseCtx)
    expect(msg?.mentionsMe).toBe(true)
  })

  it('event with no m.mentions → mentionsMe false', () => {
    const msg = eventToMessage(fakeEvent({ content: { body: 'oi bob' } }), baseCtx)
    expect(msg?.mentionsMe).toBe(false)
  })

  it('an own send never self-highlights (own echo carries no self-mention → false)', () => {
    const msg = eventToMessage(
      fakeEvent({ sender: ME, txnId: 'txn-echo', id: `~${ROOM_ID}:txn-echo`, status: 'sending' }),
      baseCtx,
    )
    expect(msg?.mine).toBe(true)
    expect(msg?.mentionsMe).toBe(false)
  })
})

// Edit path: mentionsMe espelha o m.new_content (conjunto de display, mesma fonte do body), NÃO o
// m.mentions do top-level do evento de edição (conjunto de notificação — só menções recém-adicionadas).
function fakeEditEvent(newMentions: Record<string, unknown>, topLevelMentions: Record<string, unknown>): SdkEvent {
  const content: Record<string, unknown> = {
    'm.new_content': { msgtype: 'm.text', body: 'oi @bob', ...newMentions },
    ...topLevelMentions,
  }
  return {
    getContent: () => content,
    getSender: () => OTHER,
    getRoomId: () => ROOM_ID,
    getTs: () => 1000,
  } as unknown as SdkEvent
}

describe('editToMessage wires mentionsMe from m.new_content (ADR-037 addendum M1)', () => {
  it('m.new_content mentions me while the top-level is empty → mentionsMe true (reads new_content)', () => {
    const msg = editToMessage(
      fakeEditEvent({ 'm.mentions': { user_ids: [ME] } }, { 'm.mentions': { user_ids: [] } }),
      'stable-target',
      baseCtx,
    )
    expect(msg.mentionsMe).toBe(true)
  })

  it('m.new_content mentions only another id → mentionsMe false', () => {
    const msg = editToMessage(
      fakeEditEvent({ 'm.mentions': { user_ids: [OTHER] } }, {}),
      'stable-target',
      baseCtx,
    )
    expect(msg.mentionsMe).toBe(false)
  })
})
