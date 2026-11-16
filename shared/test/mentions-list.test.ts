import { describe, it, expect } from 'vitest'
import { editToMessage, eventToMessage, type Ctx } from '../src/internal'
import { findProtocolLeaks } from '../src/leak-scan'
import type { AclTelemetry } from '../src'

// ADR-089 dec. 3 (PLANO-AGENTES §0.3.7 item 9): `Message.mentions` — the people a message mentions,
// from the same source as `mentionsMe` — and the leak-scan's inherited opacity: a STRING element of
// an array inherits the array's key, so `mentions` (opaque) covers its ids, while an array of strings
// under a non-opaque key and an object inside an opaque array are still scanned. Both sides.

const ME = '@me:tayet.local'
const ALICE = '@alice:tayet.local'
const AGENT = '@a-abcdefghijkl:tayet.local'

describe('leak-scan: inherited opacity in arrays (ADR-089 dec. 3)', () => {
  it('(a) `mentions` with mxids → no finding', () => {
    expect(findProtocolLeaks({ mentions: [ALICE, AGENT] })).toEqual([])
    expect(findProtocolLeaks({ messages: [{ id: '$x', mentions: [ALICE] }] })).toEqual([])
  })

  it('(b) an array of strings under a NON-opaque key is still scanned', () => {
    const leaks = findProtocolLeaks({ names: ['@a:b'] })
    expect(leaks).toContainEqual(expect.objectContaining({ path: '$.names[0]', pattern: 'mxid' }))
    // The agent localpart under a non-opaque key, too.
    expect(findProtocolLeaks({ names: ['ok', AGENT] }).map((l) => l.path)).toContain('$.names[1]')
  })

  it('(c) an object inside an opaque array is walked with no key → its strings are scanned', () => {
    const leaks = findProtocolLeaks({ mentions: [{ name: '@a:b' }] })
    expect(leaks).toContainEqual(expect.objectContaining({ path: '$.mentions[0].name', pattern: 'mxid' }))
    // A nested array inside the opaque array is not exempt either.
    expect(findProtocolLeaks({ mentions: [['@a:b']] }).map((l) => l.path)).toContain('$.mentions[0][0]')
  })

  it('(d) the existing id arrays (`channels`, `members`, `failedChannels`) behave as before', () => {
    // Not opaque keys: a protocol id in them is still a finding, exactly as before this change.
    for (const key of ['channels', 'members', 'failedChannels']) {
      const leaks = findProtocolLeaks({ [key]: ['!room:tayet.local', ALICE] })
      expect(leaks.map((l) => l.path)).toEqual([`$.${key}[0]`, `$.${key}[1]`])
    }
    // Product names in them stay clean.
    expect(findProtocolLeaks({ channels: ['geral'], members: ['Alice'] })).toEqual([])
  })
})

// ── Translator ───────────────────────────────────────────────────────────────────────────────
const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const ROOM_ID = '!room:tayet.local'
const ctx: Ctx = { mode: 'strict', telemetry: noopTelemetry, isDm: () => false, myUserId: ME }
type SdkEvent = Parameters<typeof eventToMessage>[0]

function liveEvent(content: Record<string, unknown>): SdkEvent {
  const full = { msgtype: 'm.text', body: 'hi', ...content }
  return {
    getType: () => 'm.room.message',
    isRedacted: () => false,
    isDecryptionFailure: () => false,
    getContent: () => full,
    getOriginalContent: () => full,
    getId: () => '$evt:tayet.local',
    getTxnId: () => undefined,
    getSender: () => ALICE,
    getRoomId: () => ROOM_ID,
    getTs: () => 1000,
    replacingEventDate: () => undefined,
    getServerAggregatedRelation: () => undefined,
    status: null,
  } as unknown as SdkEvent
}

function editEvent(newContent: Record<string, unknown>, topLevel: Record<string, unknown>): SdkEvent {
  const content = { 'm.new_content': { msgtype: 'm.text', body: 'oi', ...newContent }, ...topLevel }
  return { getContent: () => content, getSender: () => ALICE, getRoomId: () => ROOM_ID, getTs: () => 1000 } as unknown as SdkEvent
}

function utdEvent(): SdkEvent {
  return {
    getType: () => 'm.room.message',
    isRedacted: () => false,
    isDecryptionFailure: () => true,
    decryptionFailureReason: null,
    getWireContent: () => ({ algorithm: 'm.megolm.v1.aes-sha2', 'm.mentions': { user_ids: [ME] } }),
    getContent: () => ({ msgtype: 'm.bad.encrypted', body: '** Unable to decrypt **' }),
    getId: () => '$utd:tayet.local',
    getTxnId: () => undefined,
    getSender: () => ALICE,
    getRoomId: () => ROOM_ID,
    getTs: () => 1000,
    getServerAggregatedRelation: () => undefined,
    status: null,
  } as unknown as SdkEvent
}

describe('translator: Message.mentions (ADR-089 dec. 3)', () => {
  it('(e1) a live mention → mentions with the ids, alongside mentionsMe', () => {
    const msg = eventToMessage(liveEvent({ 'm.mentions': { user_ids: [ME, AGENT, ME] } }), ctx)
    expect(msg?.mentionsMe).toBe(true)
    expect(msg?.mentions).toEqual([ME, AGENT])
  })

  it('(e1) no m.mentions, an empty list or non-strings → the field is ABSENT (no undefined key)', () => {
    for (const content of [{}, { 'm.mentions': {} }, { 'm.mentions': { user_ids: [] } }, { 'm.mentions': { user_ids: [42, null] } }]) {
      const msg = eventToMessage(liveEvent(content), ctx)!
      expect('mentions' in msg).toBe(false)
    }
  })

  it('(e2) an edit reads m.new_content, not the top-level notification set', () => {
    const msg = editToMessage(editEvent({ 'm.mentions': { user_ids: [AGENT] } }, { 'm.mentions': { user_ids: [] } }), 'stable', ctx)
    expect(msg.mentions).toEqual([AGENT])
    const none = editToMessage(editEvent({}, { 'm.mentions': { user_ids: [AGENT] } }), 'stable', ctx)
    expect('mentions' in none).toBe(false)
  })

  it('(e3) an undecryptable message carries no mentions (the wire envelope is never read for it)', () => {
    const msg = eventToMessage(utdEvent(), ctx)!
    expect(msg.body.kind).toBe('unavailable')
    expect(msg.mentionsMe).toBe(false)
    expect('mentions' in msg).toBe(false)
  })

  it('the translated message passes the default leak-scan (mentions opaque, like author)', () => {
    const msg = eventToMessage(liveEvent({ 'm.mentions': { user_ids: [ME, AGENT] } }), ctx)
    expect(findProtocolLeaks(msg)).toEqual([])
  })
})
