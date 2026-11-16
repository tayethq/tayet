import { describe, it, expect } from 'vitest'
import { MatrixEvent, type IEvent } from 'matrix-js-sdk'
import {
  APPROVAL_BLOCK,
  APPROVAL_MSGTYPE,
  APPROVAL_RESPONSE_BLOCK,
  APPROVAL_RESPONSE_MSGTYPE,
  PANEL_MSGTYPE,
  PANEL_REL_TYPE,
  RESPONSE_REL_TYPE,
  editToMessage,
  eventToMessage,
  readApprovalOptions,
  resolveApproval,
  type ApprovalAnswer,
  type Ctx,
} from '../src/internal'
import { UntranslatableConceptError, type ApprovalOption } from '../src'

// ADR-091 (Proposto), A3-1: the approval card on the shared translator — the defensive read of the
// block, the answer and the panel folding to null (read or not), and the one rule that decides which
// answer resolves a card.

const AGENT = '@a-abcdefghijkm:tayet.local'
const ALICE = '@alice:tayet.local'
const BOB = '@bob:tayet.local'
const CUSTODY = '@tayet-custody:tayet.local'
const SYSTEM = '@tayet-system:tayet.local'
const ROOM_ID = '!room:tayet.local'

const strict: Ctx = { mode: 'strict', telemetry: { untranslated: () => {} }, isDm: () => false, myUserId: ALICE }
const lenient = (seen: unknown[] = []): Ctx => ({
  mode: 'lenient',
  telemetry: { untranslated: (e) => seen.push(e) },
  isDm: () => false,
  myUserId: ALICE,
})

const OPTIONS = [
  { id: 'approve', label: 'Aprovar', style: 'primary' },
  { id: 'reject', label: 'Rejeitar', style: 'danger' },
]

const cardContent = (block: unknown = { options: OPTIONS }, extra: Record<string, unknown> = {}) => ({
  msgtype: APPROVAL_MSGTYPE,
  body: 'Publicar a versão 2.4?',
  format: 'org.matrix.custom.html',
  formatted_body: '<p>Publicar a versão <strong>2.4</strong>?</p>',
  [APPROVAL_BLOCK]: block,
  ...extra,
})

const card = (content: Record<string, unknown> = cardContent(), extra: Partial<IEvent> = {}): MatrixEvent =>
  new MatrixEvent({ event_id: '$card', room_id: ROOM_ID, sender: AGENT, type: 'm.room.message', origin_server_ts: 1000, content, ...extra })

const responseEvent = (extra: Partial<IEvent> = {}): MatrixEvent =>
  new MatrixEvent({
    event_id: '$resp',
    room_id: ROOM_ID,
    sender: BOB,
    type: 'm.room.message',
    origin_server_ts: 2000,
    content: {
      msgtype: APPROVAL_RESPONSE_MSGTYPE,
      body: 'Aprovar',
      [APPROVAL_RESPONSE_BLOCK]: { option: 'approve' },
      'm.relates_to': { rel_type: RESPONSE_REL_TYPE, event_id: '$card' },
    },
    ...extra,
  })

// An encrypted event that will not decrypt: the SDK's settled-failure stub keeps the wire content (with
// its relation in clear) and reports isDecryptionFailure().
const undecryptable = (relType: string, extra: Partial<IEvent> = {}): MatrixEvent => {
  const ev = new MatrixEvent({
    event_id: '$utd',
    room_id: ROOM_ID,
    sender: BOB,
    type: 'm.room.encrypted',
    origin_server_ts: 2000,
    content: { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'x', session_id: 's', 'm.relates_to': { rel_type: relType, event_id: '$card' } },
    ...extra,
  })
  Object.defineProperty(ev, 'isDecryptionFailure', { value: () => true })
  return ev
}

describe('approval card — reading the block', () => {
  it('a valid card translates to the approval body: fallback text, request RichDoc, original options, open', () => {
    const m = eventToMessage(card(), strict)
    expect(m?.body).toEqual({
      kind: 'approval',
      text: 'Publicar a versão 2.4?',
      request: expect.any(Array),
      options: [
        { id: 'approve', label: 'Aprovar', style: 'primary' },
        { id: 'reject', label: 'Rejeitar', style: 'danger' },
      ],
      state: { kind: 'open' },
    })
  })

  it('a malformed block falls into the unknown-type treatment: placeholder in lenient, throws in strict', () => {
    const malformed = [
      null,
      { options: [] },
      { options: 'approve' },
      { options: [{ id: 'Approve', label: 'x' }] }, // uppercase id
      { options: [{ id: 'a', label: '' }] },
      { options: [{ id: 'a', label: '   ' }] },
      { options: [{ id: 'a', label: 'x'.repeat(76) }] },
      { options: [{ id: 'a', label: 'x' }, { id: 'a', label: 'y' }] }, // duplicated id
      { options: [{ id: 'x'.repeat(33), label: 'x' }] },
      { options: [{ label: 'x' }] },
    ]
    for (const block of malformed) {
      const seen: unknown[] = []
      const m = eventToMessage(card(cardContent(block)), lenient(seen))
      expect(m?.body).toEqual({ kind: 'unsupported', shape: { msgtype: APPROVAL_MSGTYPE, eventType: 'm.room.message' } })
      expect(seen).toHaveLength(1)
      expect(() => eventToMessage(card(cardContent(block)), strict)).toThrow(UntranslatableConceptError)
    }
  })

  it('more than one primary: the first stays, the others become secondary; an unknown style is ignored', () => {
    const options = readApprovalOptions(
      cardContent({
        options: [
          { id: 'a', label: 'A', style: 'primary' },
          { id: 'b', label: 'B', style: 'primary' },
          { id: 'c', label: 'C', style: 'shiny' },
        ],
      }),
    )
    expect(options).toEqual([{ id: 'a', label: 'A', style: 'primary' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }])
  })

  it('25 options are accepted; 26 → malformed', () => {
    const many = Array.from({ length: 26 }, (_, i) => ({ id: `o${i + 1}`, label: `O${i + 1}` }))
    expect(readApprovalOptions(cardContent({ options: many }))).toBeUndefined()
    expect(readApprovalOptions(cardContent({ options: many.slice(0, 25) }))).toEqual(many.slice(0, 25))
  })

  it('a 75-character label is accepted (characters, not UTF-16 units)', () => {
    const label = '✅'.repeat(75)
    expect(readApprovalOptions(cardContent({ options: [{ id: 'ok', label }] }))).toEqual([{ id: 'ok', label }])
  })

  it('the author’s closing edit closes the card; the options stay the original ones', () => {
    const ev = card()
    const close = new MatrixEvent({
      event_id: '$close',
      room_id: ROOM_ID,
      sender: AGENT,
      type: 'm.room.message',
      origin_server_ts: 5000,
      content: {
        msgtype: APPROVAL_MSGTYPE,
        body: '* Publicar a versão 2.4?',
        'm.new_content': cardContent({ options: [{ id: 'other', label: 'Outra' }], closed: true }),
        'm.relates_to': { rel_type: 'm.replace', event_id: '$card' },
      },
    })
    ev.makeReplaced(close)
    const seen: Array<{ id: string; closedAt: number | undefined }> = []
    const ctx: Ctx = {
      ...strict,
      approvalStateFor: (id, facts) => {
        seen.push({ id, closedAt: facts.closedAt })
        expect(facts.options.map((o: ApprovalOption) => o.id)).toEqual(['approve', 'reject'])
        return { kind: 'closed' }
      },
    }
    const m = eventToMessage(ev, ctx)
    expect(m?.body.kind === 'approval' && m.body.options.map((o) => o.id)).toEqual(['approve', 'reject'])
    expect(m?.body.kind === 'approval' && m.body.state).toEqual({ kind: 'closed' })
    expect(seen).toEqual([{ id: '$card', closedAt: 5000 }])
    // The live path (editToMessage with the target) reads the same.
    const live = editToMessage(close, '$card', ctx, card())
    expect(live.body.kind === 'approval' && live.body.options.map((o) => o.id)).toEqual(['approve', 'reject'])
    expect(seen[1]).toEqual({ id: '$card', closedAt: 5000 })
    // Without the aggregator, a closed card reads closed; the edit event itself is no line.
    expect(eventToMessage(ev, strict)?.body).toMatchObject({ kind: 'approval', state: { kind: 'closed' } })
    expect(eventToMessage(close, strict)).toBeNull()
  })

  it('a closing edit by someone else does not close the card', () => {
    const ev = card()
    ev.makeReplaced(
      new MatrixEvent({
        event_id: '$forged',
        room_id: ROOM_ID,
        sender: BOB,
        type: 'm.room.message',
        origin_server_ts: 5000,
        content: { msgtype: APPROVAL_MSGTYPE, body: '* x', 'm.new_content': cardContent({ options: OPTIONS, closed: true }), 'm.relates_to': { rel_type: 'm.replace', event_id: '$card' } },
      }),
    )
    expect(eventToMessage(ev, strict)?.body).toMatchObject({ kind: 'approval', state: { kind: 'open' } })
  })
})

// Round 3 (owner, 10/Nov): only an agent sends a card — the same message from anyone else, or from an
// author the translation does not know, falls into the unknown-type treatment.
describe('approval card — only an agent sends it', () => {
  const unknownType = { kind: 'unsupported', shape: { msgtype: APPROVAL_MSGTYPE, eventType: 'm.room.message' } }

  it('from a person, the custody account or `system` → unknown type (placeholder in lenient, throws in strict)', () => {
    for (const sender of [ALICE, CUSTODY, SYSTEM]) {
      const seen: unknown[] = []
      expect(eventToMessage(card(cardContent(), { sender }), lenient(seen))?.body).toEqual(unknownType)
      expect(seen).toHaveLength(1)
      expect(() => eventToMessage(card(cardContent(), { sender }), strict)).toThrow(UntranslatableConceptError)
    }
  })

  it('from an agent → a card', () => {
    expect(eventToMessage(card(), strict)?.body.kind).toBe('approval')
  })

  it('the edit path: the author of the original decides; without the original, no card', () => {
    const closeBy = (sender: string) =>
      new MatrixEvent({
        event_id: '$close',
        room_id: ROOM_ID,
        sender,
        type: 'm.room.message',
        origin_server_ts: 5000,
        content: {
          msgtype: APPROVAL_MSGTYPE,
          body: '* x',
          'm.new_content': cardContent({ options: OPTIONS, closed: true }),
          'm.relates_to': { rel_type: 'm.replace', event_id: '$card' },
        },
      })
    expect(editToMessage(closeBy(AGENT), '$card', strict, card()).body.kind).toBe('approval')
    expect(editToMessage(closeBy(ALICE), '$card', lenient(), card(cardContent(), { sender: ALICE })).body).toEqual(unknownType)
    expect(editToMessage(closeBy(AGENT), '$card', lenient(), undefined).body).toEqual(unknownType)
  })
})

describe('answer and panel → null, read or not (§0.3.16 item 8)', () => {
  it('a decrypted answer is no line, in strict', () => {
    expect(eventToMessage(responseEvent(), strict)).toBeNull()
  })

  it('an answer that does not decrypt is no line (the relation in clear decides)', () => {
    expect(eventToMessage(undecryptable(RESPONSE_REL_TYPE), strict)).toBeNull()
  })

  it('a panel, decrypted or not, is no line and does not throw in strict', () => {
    const panel = new MatrixEvent({
      event_id: '$panel',
      room_id: ROOM_ID,
      sender: AGENT,
      type: 'm.room.message',
      origin_server_ts: 2000,
      content: { msgtype: PANEL_MSGTYPE, body: 'Quadro', 'm.relates_to': { rel_type: PANEL_REL_TYPE, event_id: '$create' } },
    })
    expect(eventToMessage(panel, strict)).toBeNull()
    expect(eventToMessage(undecryptable(PANEL_REL_TYPE), strict)).toBeNull()
    // The panel's update (an edit whose new content is a panel) is no line either.
    const update = new MatrixEvent({
      event_id: '$panel2',
      room_id: ROOM_ID,
      sender: AGENT,
      type: 'm.room.message',
      origin_server_ts: 3000,
      content: { msgtype: PANEL_MSGTYPE, body: '* Quadro', 'm.new_content': { msgtype: PANEL_MSGTYPE, body: 'Quadro 2' }, 'm.relates_to': { rel_type: 'm.replace', event_id: '$panel' } },
    })
    expect(eventToMessage(update, strict)).toBeNull()
  })

  it('an ordinary undecryptable message still becomes `unavailable` (unchanged)', () => {
    expect(eventToMessage(undecryptable('m.thread'), strict)?.body.kind).toBe('unavailable')
  })
})

describe('resolveApproval — the valid answer (§0.3.16 item 5)', () => {
  const options: ApprovalOption[] = [
    { id: 'approve', label: 'Aprovar', style: 'primary' },
    { id: 'reject', label: 'Rejeitar' },
  ]
  const accounts = { custodian: CUSTODY, systemAccount: SYSTEM }
  const ans = (sender: string, ts: number, option?: string, decrypted = true): ApprovalAnswer => ({
    sender,
    ts,
    decrypted,
    ...(option !== undefined && { option }),
  })

  it('no answer → open; closed with no answer → closed', () => {
    expect(resolveApproval(options, [], undefined, accounts)).toEqual({ kind: 'open' })
    expect(resolveApproval(options, [], 9000, accounts)).toEqual({ kind: 'closed' })
  })

  it('a person’s answer resolves with author, instant and option', () => {
    expect(resolveApproval(options, [ans(BOB, 2000, 'approve')], undefined, accounts)).toEqual({
      kind: 'answered',
      by: BOB,
      at: 2000,
      option: 'approve',
    })
  })

  it('an agent, the custody account and `system` never answer', () => {
    for (const who of [AGENT, CUSTODY, SYSTEM, '']) {
      expect(resolveApproval(options, [ans(who, 2000, 'approve')], undefined, accounts)).toEqual({ kind: 'open' })
    }
    expect(resolveApproval(options, [ans(AGENT, 1500, 'approve'), ans(BOB, 2000, 'reject')], undefined, accounts)).toMatchObject({
      by: BOB,
      option: 'reject',
    })
  })

  it('an option the card does not have is skipped (the original options only)', () => {
    expect(resolveApproval(options, [ans(ALICE, 1500, 'other'), ans(BOB, 2000, 'reject')], undefined, accounts)).toMatchObject({
      by: BOB,
      option: 'reject',
    })
    expect(resolveApproval(options, [ans(ALICE, 1500)], undefined, accounts)).toEqual({ kind: 'open' })
  })

  it('only the first counts: a second answer changes nothing', () => {
    expect(resolveApproval(options, [ans(ALICE, 1500, 'approve'), ans(BOB, 2000, 'reject')], undefined, accounts)).toMatchObject({
      by: ALICE,
      option: 'approve',
    })
  })

  it('an answer after the close does not count; one before it does; one at the very instant counts', () => {
    expect(resolveApproval(options, [ans(BOB, 6000, 'approve')], 5000, accounts)).toEqual({ kind: 'closed' })
    expect(resolveApproval(options, [ans(BOB, 4000, 'approve')], 5000, accounts)).toMatchObject({ kind: 'answered', by: BOB })
    expect(resolveApproval(options, [ans(BOB, 5000, 'approve')], 5000, accounts)).toMatchObject({ kind: 'answered', by: BOB })
  })

  it('a deleted answer leaves: the next valid one takes over, until the close', () => {
    const first = { ...ans(ALICE, 1500, 'approve'), redacted: true }
    expect(resolveApproval(options, [first, ans(BOB, 2000, 'reject')], undefined, accounts)).toMatchObject({ by: BOB, option: 'reject' })
    expect(resolveApproval(options, [ans(BOB, 2000, 'reject')], undefined, accounts)).toMatchObject({ by: BOB, option: 'reject' })
    expect(resolveApproval(options, [first, ans(BOB, 6000, 'reject')], 5000, accounts)).toEqual({ kind: 'closed' })
  })

  it('an answer that does not decrypt, from a person, resolves without the option — and gains it on decrypt', () => {
    expect(resolveApproval(options, [ans(BOB, 2000, undefined, false)], undefined, accounts)).toEqual({ kind: 'answered', by: BOB, at: 2000 })
    expect(resolveApproval(options, [ans(BOB, 2000, 'approve')], undefined, accounts)).toMatchObject({ option: 'approve' })
    // From an agent it never counts, read or not.
    expect(resolveApproval(options, [ans(AGENT, 2000, undefined, false)], undefined, accounts)).toEqual({ kind: 'open' })
    // It decrypts to an option the card lacks: the next one takes over.
    expect(resolveApproval(options, [ans(BOB, 2000, 'nope'), ans(ALICE, 3000, 'approve')], undefined, accounts)).toMatchObject({ by: ALICE })
  })
})
