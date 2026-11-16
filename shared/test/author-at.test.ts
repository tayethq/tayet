import { describe, it, expect } from 'vitest'
import { editToMessage, eventToMessage, type Ctx } from '../src/internal'
import { findProtocolLeaks } from '../src/leak-scan'
import type { AclTelemetry } from '../src'

// PLANO-AGENTES §0.3.11 (P6 / ADR-086 dec. 2): `Message.authorAt` — the author's portrait AT the event,
// read from the event's sentinel RoomMember (its explicit `displayname`, never the SDK's computed name),
// so a departed author (a person who left, a removed agent) keeps a name and the agent mark.

const ME = '@me:tayet.local'
const ALICE = '@alice:tayet.local'
const AGENT = '@a-abcdefghijkl:tayet.local'
const ROOM_ID = '!room:tayet.local'
const noopTelemetry: AclTelemetry = { untranslated: () => {} }
type SdkEvent = Parameters<typeof eventToMessage>[0]

const kindOf: NonNullable<Ctx['kindOf']> = (mxid) => (mxid.startsWith('@a-') ? 'agent' : 'member')
function ctxWith(extra: Partial<Ctx> = {}): Ctx {
  return { mode: 'strict', telemetry: noopTelemetry, isDm: () => false, myUserId: ME, kindOf, ...extra }
}

// The sentinel: `event.sender` is the RoomMember at that event; `events.member` its m.room.member.
function sentinel(memberContent: Record<string, unknown> | undefined): unknown {
  return { events: memberContent ? { member: { getContent: () => memberContent } } : {} }
}

function liveEvent(sender: string, memberContent: Record<string, unknown> | undefined): SdkEvent {
  const full = { msgtype: 'm.text', body: 'hi' }
  return {
    getType: () => 'm.room.message',
    isRedacted: () => false,
    isDecryptionFailure: () => false,
    getContent: () => full,
    getOriginalContent: () => full,
    getId: () => '$evt:tayet.local',
    getTxnId: () => undefined,
    getSender: () => sender,
    sender: sentinel(memberContent),
    getRoomId: () => ROOM_ID,
    getTs: () => 1000,
    replacingEventDate: () => undefined,
    getServerAggregatedRelation: () => undefined,
    status: null,
  } as unknown as SdkEvent
}

function utdEvent(sender: string, memberContent: Record<string, unknown>): SdkEvent {
  return {
    getType: () => 'm.room.message',
    isRedacted: () => false,
    isDecryptionFailure: () => true,
    decryptionFailureReason: null,
    getWireContent: () => ({ algorithm: 'm.megolm.v1.aes-sha2' }),
    getContent: () => ({ msgtype: 'm.bad.encrypted', body: '** Unable to decrypt **' }),
    getId: () => '$utd:tayet.local',
    getTxnId: () => undefined,
    getSender: () => sender,
    sender: sentinel(memberContent),
    getRoomId: () => ROOM_ID,
    getTs: () => 1000,
    getServerAggregatedRelation: () => undefined,
    status: null,
  } as unknown as SdkEvent
}

function editEvent(sender: string, memberContent: Record<string, unknown> | undefined): SdkEvent {
  const content = { 'm.new_content': { msgtype: 'm.text', body: 'oi' } }
  return {
    getContent: () => content,
    getSender: () => sender,
    sender: sentinel(memberContent),
    getRoomId: () => ROOM_ID,
    getTs: () => 2000,
  } as unknown as SdkEvent
}

// Every string of the message must be free of the sender's localpart (P1) — `author` is the opaque id
// and excluded; everything else (authorAt included) is walked.
function stringsOutsideAuthor(value: unknown, key = ''): string[] {
  if (key === 'author' || key === 'id' || key === 'channelId') return []
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap((v) => stringsOutsideAuthor(v))
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => stringsOutsideAuthor(v, k))
  }
  return []
}

describe('translator: Message.authorAt (PLANO-AGENTES §0.3.11)', () => {
  it('an explicit displayname → name', () => {
    const msg = eventToMessage(liveEvent(ALICE, { membership: 'join', displayname: 'Alice Souza' }), ctxWith())!
    expect(msg.authorAt).toEqual({ name: 'Alice Souza', agent: false })
  })

  it('a member with no displayname → no name, and the localpart appears in no field', () => {
    for (const content of [{ membership: 'join' }, { membership: 'join', displayname: '   ' }, undefined]) {
      const msg = eventToMessage(liveEvent(ALICE, content), ctxWith())!
      expect(msg.authorAt).toEqual({ agent: false })
      expect('name' in msg.authorAt!).toBe(false)
      expect(stringsOutsideAuthor(msg).some((s) => s.includes('alice'))).toBe(false)
    }
  })

  it('a displayname shaped like an mxid → no name', () => {
    const msg = eventToMessage(liveEvent(ALICE, { membership: 'join', displayname: '@alice:tayet.local' }), ctxWith())!
    expect(msg.authorAt).toEqual({ agent: false })
    expect(findProtocolLeaks(msg)).toEqual([])
  })

  it('the disambiguation suffix is stripped', () => {
    const msg = eventToMessage(
      liveEvent(ALICE, { membership: 'join', displayname: 'Alice (@alice:tayet.local)' }),
      ctxWith(),
    )!
    expect(msg.authorAt?.name).toBe('Alice')
    expect(findProtocolLeaks(msg)).toEqual([])
  })

  it('an a- sender → agent: true, with color when agentOf returns one', () => {
    const withColor = eventToMessage(
      liveEvent(AGENT, { membership: 'join', displayname: 'Revisor' }),
      ctxWith({ agentOf: () => ({ color: 'turquesa', operatorName: 'Alice' }) }),
    )!
    expect(withColor.authorAt).toEqual({ name: 'Revisor', agent: true, color: 'turquesa' })
    // No recorded colour (unreadable organization channel) → no color: the UI owns the 'areia' default.
    const noColor = eventToMessage(liveEvent(AGENT, { membership: 'join', displayname: 'Revisor' }), ctxWith())!
    expect(noColor.authorAt).toEqual({ name: 'Revisor', agent: true })
    expect(findProtocolLeaks(withColor)).toEqual([])
  })

  it('a person → agent: false, no color (agentOf is not asked)', () => {
    let asked = false
    const msg = eventToMessage(
      liveEvent(ALICE, { membership: 'join', displayname: 'Alice' }),
      ctxWith({ agentOf: () => ((asked = true), { color: 'turquesa' }) }),
    )!
    expect(msg.authorAt).toEqual({ name: 'Alice', agent: false })
    expect(asked).toBe(false)
  })

  it('an undecryptable message (unavailable) also carries authorAt', () => {
    const msg = eventToMessage(utdEvent(AGENT, { membership: 'join', displayname: 'Revisor' }), ctxWith())!
    expect(msg.body.kind).toBe('unavailable')
    expect(msg.authorAt).toEqual({ name: 'Revisor', agent: true })
  })

  it("an edit uses the original's sentinel; without the original, the edit's own", () => {
    const original = liveEvent(ALICE, { membership: 'join', displayname: 'Alice na época' })
    const edit = editEvent(ALICE, { membership: 'join', displayname: 'Alice depois' })
    expect(editToMessage(edit, 'stable', ctxWith(), original).authorAt).toEqual({ name: 'Alice na época', agent: false })
    expect(editToMessage(edit, 'stable', ctxWith()).authorAt).toEqual({ name: 'Alice depois', agent: false })
  })

  it('no sender → no authorAt (the key is absent)', () => {
    const msg = eventToMessage(liveEvent('', { membership: 'join', displayname: 'X' }), ctxWith())!
    expect('authorAt' in msg).toBe(false)
  })
})
