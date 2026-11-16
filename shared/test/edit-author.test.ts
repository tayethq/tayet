import { describe, it, expect } from 'vitest'
import { MatrixEvent, type IEvent } from 'matrix-js-sdk'
import { displayedEdit, editAppliesTo, eventToMessage, type Ctx } from '../src/internal'
import type { AclTelemetry } from '../src'

// An edit applies only when it comes from the author of the message it targets (PLANO-AGENTES §8.30).
// editAppliesTo is the one check; displayedEdit is where the translator reads past a replacement the
// SDK or a page applied without checking.

const ALICE = '@alice:tayet.local'
const MALLORY = '@mallory:tayet.local'
const ROOM_ID = '!room:tayet.local'

const ctx: Ctx = { mode: 'strict', telemetry: { untranslated: () => {} } satisfies AclTelemetry, isDm: () => false, myUserId: '@me:tayet.local' }

const target = (extra: Partial<IEvent> = {}): MatrixEvent =>
  new MatrixEvent({ event_id: '$t', room_id: ROOM_ID, sender: ALICE, type: 'm.room.message', origin_server_ts: 500, content: { msgtype: 'm.text', body: 'original' }, ...extra })
const edit = (sender: string, body: string, ts = 2000): Partial<IEvent> => ({
  event_id: `$edit-${sender}-${ts}`,
  room_id: ROOM_ID,
  sender,
  type: 'm.room.message',
  origin_server_ts: ts,
  content: { msgtype: 'm.text', body: `* ${body}`, 'm.new_content': { msgtype: 'm.text', body }, 'm.relates_to': { rel_type: 'm.replace', event_id: '$t' } },
})

describe('editAppliesTo', () => {
  it('same sender → applies', () => {
    expect(editAppliesTo(ALICE, ALICE)).toBe(true)
  })

  it('another sender → does not apply', () => {
    expect(editAppliesTo(MALLORY, ALICE)).toBe(false)
  })

  it('target sender unknown (absent target) → does not apply', () => {
    expect(editAppliesTo(ALICE, undefined)).toBe(false)
    expect(editAppliesTo(ALICE, null)).toBe(false)
  })

  it('edit sender unknown or empty → does not apply, even against an empty target sender', () => {
    expect(editAppliesTo(undefined, undefined)).toBe(false)
    expect(editAppliesTo('', '')).toBe(false)
    expect(editAppliesTo(null, ALICE)).toBe(false)
  })
})

describe('displayedEdit — the translator reads past a replacement by someone else', () => {
  it('a replacement by another member (applied by the SDK) leaves the original and no edit date', () => {
    const ev = target()
    ev.makeReplaced(new MatrixEvent(edit(MALLORY, 'forged')))
    expect(displayedEdit(ev)).toEqual({ content: { msgtype: 'm.text', body: 'original' }, editedAt: undefined })
    const m = eventToMessage(ev, ctx)
    expect([m?.body, m?.editedAt, m?.author]).toEqual([{ kind: 'text', text: 'original' }, undefined, ALICE])
  })

  it('the author’s replacement shows, with its date', () => {
    const ev = target()
    ev.makeReplaced(new MatrixEvent(edit(ALICE, 'fixed')))
    const m = eventToMessage(ev, ctx)
    expect([m?.body, m?.editedAt]).toEqual([{ kind: 'text', text: 'fixed' }, 2000])
  })

  it('a forged server bundle never marks the message edited (replacingEventDate reads the bundle)', () => {
    const ev = target({ unsigned: { 'm.relations': { 'm.replace': edit(MALLORY, 'forged', 3000) } } as IEvent['unsigned'] })
    expect(ev.replacingEventDate()?.getTime()).toBe(3000) // the trap: the SDK dates it regardless of sender
    expect(eventToMessage(ev, ctx)?.editedAt).toBeUndefined()
  })

  it('the author’s server bundle keeps its date', () => {
    const ev = target({ unsigned: { 'm.relations': { 'm.replace': edit(ALICE, 'fixed', 3000) } } as IEvent['unsigned'] })
    ev.makeReplaced(new MatrixEvent(edit(ALICE, 'fixed', 3000)))
    expect(eventToMessage(ev, ctx)?.editedAt).toBe(3000)
  })

  it('a mention added by someone else’s edit does not mention me', () => {
    const ev = target()
    const forged = edit(MALLORY, 'hi @me')
    ;(forged.content as Record<string, unknown>)['m.new_content'] = { msgtype: 'm.text', body: 'hi', 'm.mentions': { user_ids: ['@me:tayet.local'] } }
    ev.makeReplaced(new MatrixEvent(forged))
    expect(eventToMessage(ev, ctx)?.mentionsMe).toBe(false)
  })
})
