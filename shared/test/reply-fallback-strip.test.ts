import { describe, it, expect } from 'vitest'
import { stripReplyFallback } from '../src/internal'
import { eventToMessage, type Ctx } from '../src/internal'
import { findProtocolLeaks } from '../src/leak-scan'
import type { AclTelemetry } from '../src'

// Commit 5 (PLANO-FASE-1-REPLY §2.3/§5.2 — the novel variable, isolated): inbound strip of the legacy
// PLAIN reply fallback ('> '-prefixed lines up to the first blank line). The strip is CONDITIONED
// on the event carrying a genuine m.in_reply_to — the caller passes the signal; the SAME body
// without the relation is untouchable (a user's genuine quote). The <mx-reply> counterpart is
// covered in rich-text-inbound.test.ts (HARD_DROP).

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const ctx: Ctx = { mode: 'strict', telemetry: noopTelemetry, isDm: () => false, myUserId: '@me:x' }

const FALLBACK_BODY = '> <@alice:tayet.local> the quoted original\n> second quoted line\n\nthe actual answer'

type SdkEvent = Parameters<typeof eventToMessage>[0]
function fakeEvent(content: Record<string, unknown>): SdkEvent {
  return {
    getType: () => 'm.room.message',
    isRedacted: () => false,
    isDecryptionFailure: () => false,
    getContent: () => content,
    getOriginalContent: () => content,
    getId: () => '$evt:tayet.local',
    getTxnId: () => undefined,
    getSender: () => '@other:tayet.local',
    getRoomId: () => '!room:tayet.local',
    getTs: () => 1000,
    replacingEventDate: () => undefined,
    getServerAggregatedRelation: () => undefined,
    status: null,
  } as unknown as SdkEvent
}

describe('stripReplyFallback (mechanical strip)', () => {
  it('strips leading "> " lines up to the first blank line', () => {
    expect(stripReplyFallback(FALLBACK_BODY)).toBe('the actual answer')
  })
  it('keeps a multi-line real message intact after the fallback', () => {
    expect(stripReplyFallback('> quoted\n\nline one\n\nline two')).toBe('line one\n\nline two')
  })
  it('handles a bare ">" continuation line inside the fallback', () => {
    expect(stripReplyFallback('> quoted\n>\n> more\n\nanswer')).toBe('answer')
  })
  it('does not touch a body that does not start with "> "', () => {
    expect(stripReplyFallback('plain\n> quote later')).toBe('plain\n> quote later')
  })
  it('a fallback-only body strips to empty (relation still carries the reply)', () => {
    expect(stripReplyFallback('> only the quote')).toBe('')
  })
})

describe('translate-level strip — conditioned on m.in_reply_to (never without the signal)', () => {
  it('a legacy reply (m.in_reply_to present) reaches the domain without the quoted lines', () => {
    const msg = eventToMessage(
      fakeEvent({
        msgtype: 'm.text',
        body: FALLBACK_BODY,
        'm.relates_to': { 'm.in_reply_to': { event_id: '$target:tayet.local' } },
      }),
      ctx,
    )
    expect(msg?.body).toEqual({ kind: 'text', text: 'the actual answer' })
    expect(msg?.replyTo).toBe('$target:tayet.local')
    // The fallback carried an mxid — after the strip, nothing protocol-shaped survives.
    expect(findProtocolLeaks(msg)).toEqual([])
  })

  it('the SAME body WITHOUT m.in_reply_to is untouched (genuine user quote)', () => {
    const msg = eventToMessage(fakeEvent({ msgtype: 'm.text', body: '> a genuine quote\n\nmy comment' }), ctx)
    expect(msg?.body).toEqual({ kind: 'text', text: '> a genuine quote\n\nmy comment' })
    expect(msg?.replyTo).toBeUndefined()
  })

  it('the thread rich-reply FALLBACK does not trigger the strip either (not a genuine reply)', () => {
    const msg = eventToMessage(
      fakeEvent({
        msgtype: 'm.text',
        body: '> looks quoted\n\nthread message',
        'm.relates_to': {
          rel_type: 'm.thread',
          event_id: '$root:tayet.local',
          is_falling_back: true,
          'm.in_reply_to': { event_id: '$last:tayet.local' },
        },
      }),
      ctx,
    )
    expect(msg?.body).toEqual({ kind: 'text', text: '> looks quoted\n\nthread message' })
  })

  it('full legacy reply (fallback in BOTH representations) → clean text AND clean rich', () => {
    const msg = eventToMessage(
      fakeEvent({
        msgtype: 'm.text',
        body: FALLBACK_BODY,
        format: 'org.matrix.custom.html',
        formatted_body:
          '<mx-reply><blockquote><a href="https://matrix.to/#/@alice:tayet.local">@alice:tayet.local</a>' +
          '<br/>the quoted original</blockquote></mx-reply>the actual <strong>answer</strong>',
        'm.relates_to': { 'm.in_reply_to': { event_id: '$target:tayet.local' } },
      }),
      ctx,
    )
    expect(msg?.body.kind).toBe('text')
    if (msg?.body.kind === 'text') {
      expect(msg.body.text).toBe('the actual answer')
      expect(msg.body.rich).toEqual([
        {
          t: 'p',
          children: [
            { t: 'text', text: 'the actual ' },
            { t: 'strong', children: [{ t: 'text', text: 'answer' }] },
          ],
        },
      ])
    }
    expect(findProtocolLeaks(msg)).toEqual([]) // no duplication, no mxid, no envelope key
  })
})
