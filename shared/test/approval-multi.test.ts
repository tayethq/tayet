import { describe, it, expect } from 'vitest'
import { MatrixEvent } from 'matrix-js-sdk'
import {
  APPROVAL_BLOCK,
  APPROVAL_MSGTYPE,
  APPROVAL_NEEDED_MAX,
  APPROVAL_NEEDED_MIN,
  approvalSettled,
  eventToMessage,
  readApprovalNeeded,
  resolveMultiApproval,
  type ApprovalAnswer,
  type ApprovalCardFacts,
  type Ctx,
} from '../src/internal'
import { UntranslatableConceptError, type ApprovalOption } from '../src'

// A card that declares how many answers it asks for: the read of the declaration, the translation (a
// malformed declaration degrades the card like an unknown type; without the aggregator the card comes out
// with no answers) and the rule that picks the answers that count.

const AGENT = '@a-abcdefghijkm:tayet.local'
const ALICE = '@alice:tayet.local'
const BOB = '@bob:tayet.local'
const CAROL = '@carol:tayet.local'
const DAVE = '@dave:tayet.local'
const CUSTODY = '@tayet-custody:tayet.local'
const SYSTEM = '@tayet-system:tayet.local'
const ROOM_ID = '!room:tayet.local'

const strict: Ctx = { mode: 'strict', telemetry: { untranslated: () => {} }, isDm: () => false, myUserId: ALICE }
const lenient = (seen: unknown[] = []): Ctx => ({ mode: 'lenient', telemetry: { untranslated: (e) => seen.push(e) }, isDm: () => false, myUserId: ALICE })

const RAW_OPTIONS = [
  { id: 'approve', label: 'Aprovar', style: 'primary' },
  { id: 'reject', label: 'Recusar' },
]
const OPTIONS: ApprovalOption[] = [
  { id: 'approve', label: 'Aprovar', style: 'primary' },
  { id: 'reject', label: 'Recusar' },
]
const ACCOUNTS = { custodian: CUSTODY, systemAccount: SYSTEM }

const cardContent = (block: Record<string, unknown>) => ({ msgtype: APPROVAL_MSGTYPE, body: 'Publicar?', [APPROVAL_BLOCK]: block })
const card = (content: Record<string, unknown>): MatrixEvent =>
  new MatrixEvent({ event_id: '$card', room_id: ROOM_ID, sender: AGENT, type: 'm.room.message', origin_server_ts: 1000, content })

const ans = (sender: string, ts: number, option?: string, extra: Partial<ApprovalAnswer> = {}): ApprovalAnswer => ({
  sender,
  ts,
  decrypted: true,
  ...(option !== undefined && { option }),
  ...extra,
})
const multi = (answers: ApprovalAnswer[], needed = 2, closedAt?: number) => resolveMultiApproval(OPTIONS, answers, closedAt, ACCOUNTS, needed)
const line = (by: string, at: number, option?: string) => ({ by, at, ...(option !== undefined && { option }) })

describe('the declaration — reading it', () => {
  it('absent → undefined: the card is the single-answer one', () => {
    expect(readApprovalNeeded(cardContent({ options: RAW_OPTIONS }))).toBeUndefined()
  })

  it('an integer from 2 to 10 → that number', () => {
    expect(APPROVAL_NEEDED_MIN).toBe(2)
    expect(APPROVAL_NEEDED_MAX).toBe(10)
    for (const n of [2, 3, 10]) expect(readApprovalNeeded(cardContent({ options: RAW_OPTIONS, needed: n }))).toBe(n)
  })

  it('1, 11, a fraction, text, null → null (malformed)', () => {
    for (const bad of [1, 11, 2.5, '2', null, 0, -2, true, [2], { n: 2 }]) {
      expect(readApprovalNeeded(cardContent({ options: RAW_OPTIONS, needed: bad }))).toBeNull()
    }
  })
})

describe('the declaration — the translation', () => {
  it('a valid declaration: the card comes out as several answers, none yet, without the aggregator', () => {
    for (const n of [2, 10]) {
      const m = eventToMessage(card(cardContent({ options: RAW_OPTIONS, needed: n })), strict)
      expect(m?.body).toMatchObject({ kind: 'approval', options: OPTIONS, state: { kind: 'multi', needed: n, answers: [], closed: false } })
    }
  })

  it('closed at birth without the aggregator: closed, no answers', () => {
    const m = eventToMessage(card(cardContent({ options: RAW_OPTIONS, needed: 2, closed: true })), strict)
    expect(m?.body).toMatchObject({ state: { kind: 'multi', needed: 2, answers: [], closed: true } })
  })

  it('an invalid declaration falls into the unknown-type treatment: placeholder in lenient, throws in strict', () => {
    for (const bad of [1, 11, 2.5, 'dois', null]) {
      const seen: unknown[] = []
      const m = eventToMessage(card(cardContent({ options: RAW_OPTIONS, needed: bad })), lenient(seen))
      expect(m?.body).toEqual({ kind: 'unsupported', shape: { msgtype: APPROVAL_MSGTYPE, eventType: 'm.room.message' } })
      expect(seen).toHaveLength(1)
      expect(() => eventToMessage(card(cardContent({ options: RAW_OPTIONS, needed: bad })), strict)).toThrow(UntranslatableConceptError)
    }
  })

  it('the aggregator receives the declaration in the facts; the card without it gets none', () => {
    const seen: ApprovalCardFacts[] = []
    const ctx: Ctx = { ...strict, approvalStateFor: (_id, facts) => (seen.push(facts), undefined as never) }
    eventToMessage(card(cardContent({ options: RAW_OPTIONS, needed: 3 })), ctx)
    eventToMessage(card(cardContent({ options: RAW_OPTIONS })), ctx)
    expect(seen[0]?.needed).toBe(3)
    expect(seen[1]).not.toHaveProperty('needed')
  })

  it('the declaration is read from the original content: an edit that changes it does not change N', () => {
    const original = card(cardContent({ options: RAW_OPTIONS, needed: 2 }))
    const edit = new MatrixEvent({
      event_id: '$edit',
      room_id: ROOM_ID,
      sender: AGENT,
      type: 'm.room.message',
      origin_server_ts: 1500,
      content: {
        msgtype: APPROVAL_MSGTYPE,
        body: '* Publicar?',
        'm.new_content': cardContent({ options: RAW_OPTIONS, needed: 5 }),
        'm.relates_to': { rel_type: 'm.replace', event_id: '$card' },
      },
    })
    original.makeReplaced(edit)
    const m = eventToMessage(original, strict)
    expect(m?.body).toMatchObject({ state: { kind: 'multi', needed: 2 } })
  })
})

describe('resolveMultiApproval', () => {
  it('no answer: none, open; the server order is kept', () => {
    expect(multi([])).toEqual({ kind: 'multi', needed: 2, answers: [], closed: false })
    expect(multi([ans(CAROL, 2000, 'reject'), ans(BOB, 3000, 'approve')]).answers).toEqual([line(CAROL, 2000, 'reject'), line(BOB, 3000, 'approve')])
  })

  it('one per person: a second answer of the same author is ignored', () => {
    const s = multi([ans(BOB, 2000, 'approve'), ans(BOB, 2500, 'reject'), ans(CAROL, 3000, 'reject')], 3)
    expect(s.answers).toEqual([line(BOB, 2000, 'approve'), line(CAROL, 3000, 'reject')])
  })

  it('cut at N: the answer after the N-th that counts is left out', () => {
    const s = multi([ans(BOB, 2000, 'approve'), ans(CAROL, 3000, 'reject'), ans(DAVE, 4000, 'approve')], 2)
    expect(s.answers).toEqual([line(BOB, 2000, 'approve'), line(CAROL, 3000, 'reject')])
    expect(approvalSettled(s)).toBe(true)
  })

  it('an answer after the close does not count; one at the very instant does', () => {
    const s = multi([ans(BOB, 5000, 'approve'), ans(CAROL, 5001, 'reject')], 2, 5000)
    expect(s).toEqual({ kind: 'multi', needed: 2, answers: [line(BOB, 5000, 'approve')], closed: true })
  })

  it('an agent, the custody account and `system` never count', () => {
    const s = multi([ans(AGENT, 2000, 'approve'), ans(CUSTODY, 2100, 'approve'), ans(SYSTEM, 2200, 'approve'), ans(BOB, 3000, 'reject')])
    expect(s.answers).toEqual([line(BOB, 3000, 'reject')])
  })

  it('an option the card does not have does not count, and the same author’s next answer takes over', () => {
    const s = multi([ans(BOB, 2000, 'maybe'), ans(BOB, 2500, 'reject')])
    expect(s.answers).toEqual([line(BOB, 2500, 'reject')])
  })

  it('an answer not readable yet counts without the option; on decrypt with no valid option, the next of the same author takes over', () => {
    const before = multi([ans(BOB, 2000, undefined, { decrypted: false }), ans(BOB, 2500, 'reject'), ans(CAROL, 3000, 'approve')], 3)
    expect(before.answers).toEqual([line(BOB, 2000), line(CAROL, 3000, 'approve')])
    const after = multi([ans(BOB, 2000, 'nope'), ans(BOB, 2500, 'reject'), ans(CAROL, 3000, 'approve')], 3)
    expect(after.answers).toEqual([line(BOB, 2500, 'reject'), line(CAROL, 3000, 'approve')])
  })

  it('an answer not readable yet that later names an option keeps its place and gains the option', () => {
    const before = multi([ans(BOB, 2000, undefined, { decrypted: false }), ans(CAROL, 3000, 'reject')])
    const after = multi([ans(BOB, 2000, 'approve'), ans(CAROL, 3000, 'reject')])
    expect(before.answers).toEqual([line(BOB, 2000), line(CAROL, 3000, 'reject')])
    expect(after.answers).toEqual([line(BOB, 2000, 'approve'), line(CAROL, 3000, 'reject')])
  })

  it('a deleted answer leaves the count, and the same author’s second answer takes over', () => {
    const s = multi([ans(BOB, 2000, 'approve', { redacted: true }), ans(CAROL, 3000, 'reject'), ans(BOB, 4000, 'reject')], 2)
    expect(s.answers).toEqual([line(CAROL, 3000, 'reject'), line(BOB, 4000, 'reject')])
  })

  it('a deleted answer makes room under the cut: the N+1-th comes in', () => {
    const answers = [ans(BOB, 2000, 'approve'), ans(CAROL, 3000, 'reject'), ans(DAVE, 4000, 'approve')]
    expect(multi(answers).answers.map((a) => a.by)).toEqual([BOB, CAROL])
    answers[0] = { ...answers[0]!, redacted: true }
    expect(multi(answers).answers.map((a) => a.by)).toEqual([CAROL, DAVE])
  })

  it('closed with fewer than N: the answers before the close, closed, not settled', () => {
    const s = multi([ans(BOB, 2000, 'approve')], 3, 2500)
    expect(s).toEqual({ kind: 'multi', needed: 3, answers: [line(BOB, 2000, 'approve')], closed: true })
    expect(approvalSettled(s)).toBe(false)
  })

  it('settled: answered, or several answers with all it asks for', () => {
    expect(approvalSettled({ kind: 'open' })).toBe(false)
    expect(approvalSettled({ kind: 'closed' })).toBe(false)
    expect(approvalSettled(multi([ans(BOB, 2000, 'approve')]))).toBe(false)
  })
})
