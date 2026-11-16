import { describe, it, expect, vi } from 'vitest'
import { Direction, MatrixEvent, MatrixEventEvent, RoomEvent, type IEvent } from 'matrix-js-sdk'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import { ApprovalAggregator, fetchAnswerPage, fetchEditPage, type AnswerFact, type AnswerPage, type EditPage } from '../src/acl/internal/approval-state'
import {
  APPROVAL_BLOCK,
  APPROVAL_MSGTYPE,
  APPROVAL_RESPONSE_BLOCK,
  APPROVAL_RESPONSE_MSGTYPE,
  PANEL_MSGTYPE,
  PANEL_REL_TYPE,
  RESPONSE_REL_TYPE,
  type ApprovalCardFacts,
} from '@tayet/shared/internal'
import type { AclTelemetry, DomainEvent, Message } from '../src/acl'

// ADR-091 (Proposto), A3-1 — the client's aggregator of approval-card state (PLANO-AGENTES §0.3.16 items
// 3, 4, 7, 8): the direction asked of the server, the paging, the cache, the live answers, the late
// decrypt and the deletion; then the gateway routing an answer into its card (message.edited of the
// card, never message.received of the answer). No stack: fake client and room over real SDK events.

const ME = '@me:tayet.local'
const AGENT = '@a-abcdefghijkm:tayet.local'
const BOB = '@bob:tayet.local'
const CAROL = '@carol:tayet.local'
const ROOM_ID = '!room:tayet.local'
const CARD_ID = '$card:tayet.local'

const OPTIONS = [
  { id: 'approve', label: 'Aprovar', style: 'primary' as const },
  { id: 'reject', label: 'Rejeitar' },
]
const OPEN: ApprovalCardFacts = { options: OPTIONS, author: AGENT, closedAt: undefined, bornClosedAt: undefined, edited: false }
// An edited card: `closedAt` is the provisional displayed close (the latest author edit with the mark).
const EDITED = (closedAt?: number): ApprovalCardFacts => ({ ...OPEN, edited: true, closedAt })
const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
}

const fact = (eventId: string, sender: string, ts: number, option?: string, decrypted = true): AnswerFact => ({
  eventId,
  sender,
  ts,
  decrypted,
  ...(option !== undefined && { option }),
})

function aggregator(pages: Record<string, AnswerPage>, editPages: Record<string, EditPage> = { start: { edits: [] } }) {
  const fetchPage = vi.fn(async (_room: string, _card: string, from: string | undefined) => {
    const page = pages[from ?? 'start']
    if (!page) throw new Error('no page')
    return page
  })
  const fetchEditPage = vi.fn(async (_room: string, _card: string, from: string | undefined) => {
    const page = editPages[from ?? 'start']
    if (!page) throw new Error('no page')
    return page
  })
  const changed = vi.fn()
  const agg = new ApprovalAggregator({
    fetchPage,
    fetchEditPage,
    accounts: () => ({ custodian: '@cofre:tayet.local', systemAccount: '@sistema:tayet.local' }),
    changed,
    detach: (work) => void work,
  })
  return { agg, fetchPage, fetchEditPage, changed }
}

describe('ApprovalAggregator', () => {
  it('a card is born open while the read runs; the resolution arrives as a change, then from the cache', async () => {
    const { agg, fetchPage, changed } = aggregator({ start: { answers: [fact('$r1', BOB, 2000, 'approve')] } })
    expect(agg.stateFor(ROOM_ID, CARD_ID, OPEN)).toEqual({ kind: 'open' })
    await flush()
    expect(changed).toHaveBeenCalledWith(ROOM_ID, CARD_ID)
    expect(agg.stateFor(ROOM_ID, CARD_ID, OPEN)).toEqual({ kind: 'answered', by: BOB, at: 2000, option: 'approve' })
    // Cache: a second translation reads nothing.
    agg.stateFor(ROOM_ID, CARD_ID, OPEN)
    expect(fetchPage).toHaveBeenCalledTimes(1)
  })

  it('no answer: no change is emitted (the card already shows open)', async () => {
    const { agg, changed } = aggregator({ start: { answers: [] } })
    agg.stateFor(ROOM_ID, CARD_ID, OPEN)
    await flush()
    expect(changed).not.toHaveBeenCalled()
  })

  it('paging: forward until the first valid answer, not past it', async () => {
    const { agg, fetchPage } = aggregator({
      start: { answers: [fact('$r1', AGENT, 1500, 'approve')], next: 'p2' },
      p2: { answers: [fact('$r2', BOB, 2000, 'reject')], next: 'p3' },
      p3: { answers: [fact('$r3', CAROL, 3000, 'approve')] },
    })
    agg.stateFor(ROOM_ID, CARD_ID, OPEN)
    await flush()
    expect(fetchPage.mock.calls.map((c) => c[2])).toEqual([undefined, 'p2'])
    expect(agg.stateFor(ROOM_ID, CARD_ID, OPEN)).toMatchObject({ by: BOB, option: 'reject' })
  })

  it('paging: to the end when no answer is valid', async () => {
    const { agg, fetchPage } = aggregator({
      start: { answers: [fact('$r1', AGENT, 1500, 'approve')], next: 'p2' },
      p2: { answers: [fact('$r2', BOB, 2000, 'nope')] },
    })
    agg.stateFor(ROOM_ID, CARD_ID, OPEN)
    await flush()
    expect(fetchPage).toHaveBeenCalledTimes(2)
    expect(agg.stateFor(ROOM_ID, CARD_ID, OPEN)).toEqual({ kind: 'open' })
  })

  it('live: an answer of a person resolves the card and re-emits it; a later one changes nothing', async () => {
    const { agg, changed } = aggregator({ start: { answers: [] } })
    agg.stateFor(ROOM_ID, CARD_ID, OPEN)
    await flush()
    agg.noteAnswer(ROOM_ID, CARD_ID, fact('$r1', BOB, 2000, 'approve'))
    expect(changed).toHaveBeenCalledTimes(1)
    expect(agg.stateFor(ROOM_ID, CARD_ID, OPEN)).toMatchObject({ by: BOB, option: 'approve' })
    agg.noteAnswer(ROOM_ID, CARD_ID, fact('$r2', CAROL, 3000, 'reject'))
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('live: an agent’s answer is ignored', async () => {
    const { agg, changed } = aggregator({ start: { answers: [] } })
    agg.stateFor(ROOM_ID, CARD_ID, OPEN)
    await flush()
    agg.noteAnswer(ROOM_ID, CARD_ID, fact('$r1', AGENT, 2000, 'approve'))
    expect(changed).not.toHaveBeenCalled()
    expect(agg.stateFor(ROOM_ID, CARD_ID, OPEN)).toEqual({ kind: 'open' })
  })

  it('late decrypt: answered without option, then with it (each a change)', async () => {
    const { agg, changed } = aggregator({ start: { answers: [fact('$r1', BOB, 2000, undefined, false)] } })
    agg.stateFor(ROOM_ID, CARD_ID, OPEN)
    await flush()
    expect(agg.stateFor(ROOM_ID, CARD_ID, OPEN)).toEqual({ kind: 'answered', by: BOB, at: 2000 })
    agg.noteAnswer(ROOM_ID, CARD_ID, fact('$r1', BOB, 2000, 'approve'))
    expect(changed).toHaveBeenCalledTimes(2)
    expect(agg.stateFor(ROOM_ID, CARD_ID, OPEN)).toMatchObject({ option: 'approve' })
  })

  it('late decrypt to an option the card lacks: the read continues past where it stopped', async () => {
    const { agg, fetchPage } = aggregator({
      start: { answers: [fact('$r1', BOB, 2000, undefined, false)], next: 'p2' },
      p2: { answers: [fact('$r2', CAROL, 3000, 'reject')] },
    })
    agg.stateFor(ROOM_ID, CARD_ID, OPEN)
    await flush()
    expect(fetchPage).toHaveBeenCalledTimes(1)
    agg.noteAnswer(ROOM_ID, CARD_ID, fact('$r1', BOB, 2000, 'nope'))
    await flush()
    expect(fetchPage.mock.calls.map((c) => c[2])).toEqual([undefined, 'p2'])
    expect(agg.stateFor(ROOM_ID, CARD_ID, OPEN)).toMatchObject({ by: CAROL, option: 'reject' })
  })

  it('deletion: the deleted answer leaves and the next valid one takes over', async () => {
    const { agg, changed } = aggregator({ start: { answers: [fact('$r1', BOB, 2000, 'approve'), fact('$r2', CAROL, 3000, 'reject')] } })
    agg.stateFor(ROOM_ID, CARD_ID, OPEN)
    await flush()
    expect(agg.forgetAnswer('$r1')).toBe(true)
    expect(agg.stateFor(ROOM_ID, CARD_ID, OPEN)).toMatchObject({ by: CAROL, option: 'reject' })
    expect(changed).toHaveBeenCalledTimes(2)
    expect(agg.forgetAnswer('$unknown')).toBe(false)
  })

  it('close: answered before the close stays answered; with none, closed', async () => {
    const before = aggregator({ start: { answers: [fact('$r1', BOB, 2000, 'approve')] } }, { start: { edits: [{ sender: AGENT, ts: 5000, closed: true }] } })
    before.agg.stateFor(ROOM_ID, CARD_ID, EDITED(5000))
    await flush()
    expect(before.agg.stateFor(ROOM_ID, CARD_ID, EDITED(5000))).toMatchObject({ kind: 'answered', by: BOB })
    const after = aggregator({ start: { answers: [fact('$r1', BOB, 2000, 'approve')] } }, { start: { edits: [{ sender: AGENT, ts: 1000, closed: true }] } })
    after.agg.stateFor(ROOM_ID, CARD_ID, EDITED(1000))
    await flush()
    expect(after.agg.stateFor(ROOM_ID, CARD_ID, EDITED(1000))).toEqual({ kind: 'closed' })
  })

  // ADR-091 dec. 7 (round 2): the close is the author's FIRST closing edit and it is permanent.
  it('close → late answer → another author edit: the close instant is the first one, the card stays closed', async () => {
    const edits = { start: { edits: [{ sender: AGENT, ts: 3000, closed: true }], next: 'e2' }, e2: { edits: [{ sender: AGENT, ts: 6000, closed: true }] } }
    const { agg, fetchEditPage } = aggregator({ start: { answers: [fact('$late', BOB, 4000, 'approve')] } }, edits)
    // Displayed content: the latest author edit (6000), after the late answer (4000).
    expect(agg.stateFor(ROOM_ID, CARD_ID, EDITED(6000))).toEqual({ kind: 'closed' })
    await flush()
    expect(agg.stateFor(ROOM_ID, CARD_ID, EDITED(6000))).toEqual({ kind: 'closed' })
    // The read stops at the first closing edit of the author.
    expect(fetchEditPage.mock.calls.map((c) => c[2])).toEqual([undefined])
  })

  it('close → an author edit without the mark: still closed', async () => {
    const edits = { start: { edits: [{ sender: AGENT, ts: 3000, closed: true }, { sender: AGENT, ts: 5000, closed: false }] } }
    const { agg } = aggregator({ start: { answers: [fact('$late', BOB, 4000, 'approve')] } }, edits)
    // The displayed content (the latest edit) carries no mark.
    agg.stateFor(ROOM_ID, CARD_ID, EDITED(undefined))
    await flush()
    expect(agg.stateFor(ROOM_ID, CARD_ID, EDITED(undefined))).toEqual({ kind: 'closed' })
  })

  it('an answer before the first close + a later author edit: still answered, the same answer', async () => {
    const edits = { start: { edits: [{ sender: AGENT, ts: 3000, closed: true }, { sender: AGENT, ts: 7000, closed: false }] } }
    const { agg } = aggregator({ start: { answers: [fact('$r1', BOB, 2000, 'reject'), fact('$r2', CAROL, 5000, 'approve')] } }, edits)
    agg.stateFor(ROOM_ID, CARD_ID, EDITED(undefined))
    await flush()
    expect(agg.stateFor(ROOM_ID, CARD_ID, EDITED(undefined))).toEqual({ kind: 'answered', by: BOB, at: 2000, option: 'reject' })
  })

  it('a closing edit by someone else is no close; live, the first close seen fixes the instant', async () => {
    const edits = { start: { edits: [{ sender: BOB, ts: 1500, closed: true }] } }
    const { agg } = aggregator({ start: { answers: [fact('$r1', BOB, 2000, 'approve')] } }, edits)
    agg.stateFor(ROOM_ID, CARD_ID, EDITED(undefined))
    await flush()
    expect(agg.stateFor(ROOM_ID, CARD_ID, EDITED(undefined))).toMatchObject({ kind: 'answered', by: BOB })
    agg.noteEdit(ROOM_ID, CARD_ID, { sender: AGENT, ts: 3000, closed: true })
    agg.noteEdit(ROOM_ID, CARD_ID, { sender: AGENT, ts: 8000, closed: true })
    agg.noteAnswer(ROOM_ID, CARD_ID, fact('$r0', CAROL, 2500, 'reject'))
    // A later answer does not count after the close (3000), and the second close does not move it.
    agg.forgetAnswer('$r1')
    expect(agg.stateFor(ROOM_ID, CARD_ID, EDITED(8000))).toEqual({ kind: 'answered', by: CAROL, at: 2500, option: 'reject' })
    agg.forgetAnswer('$r0')
    agg.noteAnswer(ROOM_ID, CARD_ID, fact('$r9', CAROL, 5000, 'approve'))
    expect(agg.stateFor(ROOM_ID, CARD_ID, EDITED(8000))).toEqual({ kind: 'closed' })
  })

  it('a failed read leaves the card as it shows and retries on the next translation', async () => {
    const { agg, fetchPage } = aggregator({})
    expect(agg.stateFor(ROOM_ID, CARD_ID, OPEN)).toEqual({ kind: 'open' })
    await flush()
    agg.stateFor(ROOM_ID, CARD_ID, OPEN)
    expect(fetchPage).toHaveBeenCalledTimes(2)
  })
})

// Round 3: the order of the pages read forward is the authority. A live answer that arrives while the
// read is pending must not jump ahead of the older answers the page brings.
describe('ApprovalAggregator — the server’s order beats the order of arrival', () => {
  function deferredAggregator() {
    const pending = new Map<string, (page: AnswerPage) => void>()
    const fetchPage = vi.fn(
      (_room: string, _card: string, from: string | undefined) => new Promise<AnswerPage>((resolve) => pending.set(from ?? 'start', resolve)),
    )
    const changed = vi.fn()
    const agg = new ApprovalAggregator({
      fetchPage,
      fetchEditPage: async () => ({ edits: [] }),
      accounts: () => ({ custodian: '@cofre:tayet.local', systemAccount: '@sistema:tayet.local' }),
      changed,
      detach: (work) => void work,
    })
    const answerPage = async (from: string, page: AnswerPage): Promise<void> => {
      await flush()
      pending.get(from)!(page)
      await flush()
    }
    return { agg, fetchPage, answerPage, changed }
  }
  const A = fact('$A', BOB, 1000, 'approve')
  const B = fact('$B', CAROL, 1100, 'reject')
  const C = fact('$C', ME, 1200, 'reject')

  it('A and B on the server, the read pending, C arrives live, the page brings [A, B, C] → answered by A', async () => {
    const { agg, answerPage } = deferredAggregator()
    agg.stateFor(ROOM_ID, CARD_ID, OPEN)
    agg.noteAnswer(ROOM_ID, CARD_ID, C)
    await answerPage('start', { answers: [A, B, C] })
    expect(agg.stateFor(ROOM_ID, CARD_ID, OPEN)).toEqual({ kind: 'answered', by: BOB, at: 1000, option: 'approve' })
  })

  it('a read in two pages with a live answer between them: the pages’ order, the live one after', async () => {
    const { agg, answerPage } = deferredAggregator()
    const invalid = fact('$X', BOB, 900, 'nope')
    agg.stateFor(ROOM_ID, CARD_ID, OPEN)
    await answerPage('start', { answers: [invalid], next: 'p2' })
    agg.noteAnswer(ROOM_ID, CARD_ID, C)
    await answerPage('p2', { answers: [A] })
    expect(agg.stateFor(ROOM_ID, CARD_ID, OPEN)).toMatchObject({ kind: 'answered', by: BOB, option: 'approve' })
  })

  it('a live answer not yet in any page stays after the paged ones; when a page brings it, it takes the page’s place', async () => {
    const { agg, answerPage } = deferredAggregator()
    const invalidA = fact('$A', BOB, 1000, 'nope')
    agg.stateFor(ROOM_ID, CARD_ID, OPEN)
    agg.noteAnswer(ROOM_ID, CARD_ID, C)
    await answerPage('start', { answers: [invalidA, B], next: 'p2' })
    // [A(invalid), B, C(live)] — B is the first valid; the read stopped there.
    expect(agg.stateFor(ROOM_ID, CARD_ID, OPEN)).toMatchObject({ by: CAROL })
  })

  it('a late decrypt keeps the answer in its paged position', async () => {
    const { agg, answerPage } = deferredAggregator()
    const utdA = fact('$A', BOB, 1000, undefined, false)
    agg.stateFor(ROOM_ID, CARD_ID, OPEN)
    agg.noteAnswer(ROOM_ID, CARD_ID, C)
    await answerPage('start', { answers: [utdA, B, C] })
    expect(agg.stateFor(ROOM_ID, CARD_ID, OPEN)).toEqual({ kind: 'answered', by: BOB, at: 1000 })
    agg.noteAnswer(ROOM_ID, CARD_ID, A)
    expect(agg.stateFor(ROOM_ID, CARD_ID, OPEN)).toEqual({ kind: 'answered', by: BOB, at: 1000, option: 'approve' })
  })
})

describe('fetchAnswerPage — the server’s order', () => {
  it('asks the relations of the card filtered by the answer’s relation type, explicitly FORWARD', async () => {
    const chunk = [
      {
        event_id: '$r1',
        room_id: ROOM_ID,
        sender: BOB,
        type: 'm.room.message',
        origin_server_ts: 2000,
        content: { msgtype: APPROVAL_RESPONSE_MSGTYPE, body: 'Aprovar', [APPROVAL_RESPONSE_BLOCK]: { option: 'approve' }, 'm.relates_to': { rel_type: RESPONSE_REL_TYPE, event_id: CARD_ID } },
      },
    ]
    const fetchRelations = vi.fn(async () => ({ chunk, next_batch: 'n2' }))
    const client = {
      fetchRelations,
      getEventMapper: () => (raw: Partial<IEvent>) => new MatrixEvent(raw),
      decryptEventIfNeeded: vi.fn(async () => {}),
    }
    const page = await fetchAnswerPage(client as never, ROOM_ID, CARD_ID, undefined)
    expect(fetchRelations).toHaveBeenCalledWith(ROOM_ID, CARD_ID, RESPONSE_REL_TYPE, null, { dir: Direction.Forward })
    expect(Direction.Forward).toBe('f')
    expect(page).toEqual({ answers: [{ eventId: '$r1', sender: BOB, ts: 2000, decrypted: true, option: 'approve' }], next: 'n2' })
    expect(client.decryptEventIfNeeded).toHaveBeenCalledTimes(1)
    await fetchAnswerPage(client as never, ROOM_ID, CARD_ID, 'n2')
    expect(fetchRelations).toHaveBeenLastCalledWith(ROOM_ID, CARD_ID, RESPONSE_REL_TYPE, null, { dir: Direction.Forward, from: 'n2' })
  })
})

describe('fetchEditPage — the card’s edits in the server’s order', () => {
  it('asks the edit relations of the card, explicitly FORWARD, and reads the closing mark of the new content', async () => {
    const chunk = [
      { event_id: '$e1', room_id: ROOM_ID, sender: AGENT, type: 'm.room.message', origin_server_ts: 3000, content: { msgtype: APPROVAL_MSGTYPE, body: '* x', 'm.new_content': { msgtype: APPROVAL_MSGTYPE, body: 'x', [APPROVAL_BLOCK]: { options: OPTIONS, closed: true } }, 'm.relates_to': { rel_type: 'm.replace', event_id: CARD_ID } } },
      { event_id: '$e2', room_id: ROOM_ID, sender: AGENT, type: 'm.room.message', origin_server_ts: 4000, content: { msgtype: APPROVAL_MSGTYPE, body: '* y', 'm.new_content': { msgtype: APPROVAL_MSGTYPE, body: 'y', [APPROVAL_BLOCK]: { options: OPTIONS } }, 'm.relates_to': { rel_type: 'm.replace', event_id: CARD_ID } } },
    ]
    const fetchRelations = vi.fn(async () => ({ chunk }))
    const client = { fetchRelations, getEventMapper: () => (raw: Partial<IEvent>) => new MatrixEvent(raw), decryptEventIfNeeded: vi.fn(async () => {}) }
    const page = await fetchEditPage(client as never, ROOM_ID, CARD_ID, undefined)
    expect(fetchRelations).toHaveBeenCalledWith(ROOM_ID, CARD_ID, 'm.replace', null, { dir: Direction.Forward })
    expect(page).toEqual({ edits: [{ sender: AGENT, ts: 3000, closed: true }, { sender: AGENT, ts: 4000, closed: false }] })
  })
})

// ── The gateway: routing answers into their card ──────────────────────────────────────────────
type Handler = (...args: never[]) => void
const noopTelemetry: AclTelemetry = { untranslated: () => {} }

const cardRaw = (): Partial<IEvent> => ({
  event_id: CARD_ID,
  room_id: ROOM_ID,
  sender: AGENT,
  type: 'm.room.message',
  origin_server_ts: 1000,
  content: { msgtype: APPROVAL_MSGTYPE, body: 'Publicar?', [APPROVAL_BLOCK]: { options: OPTIONS } },
})
let n = 0
const answerRaw = (sender: string, option: string, extra: Partial<IEvent> = {}): Partial<IEvent> => {
  n += 1
  return {
    event_id: `$ans${n}:tayet.local`,
    room_id: ROOM_ID,
    sender,
    type: 'm.room.message',
    origin_server_ts: 2000 + n,
    content: { msgtype: APPROVAL_RESPONSE_MSGTYPE, body: option, [APPROVAL_RESPONSE_BLOCK]: { option }, 'm.relates_to': { rel_type: RESPONSE_REL_TYPE, event_id: CARD_ID } },
    ...extra,
  }
}

// An encrypted answer walking the decrypt lifecycle: the relation is on the wire from the start.
function encryptedAnswer(id: string, sender: string, option: string) {
  let phase: 'decrypting' | 'failed' | 'clear' = 'decrypting'
  const relates = { rel_type: RESPONSE_REL_TYPE, event_id: CARD_ID }
  const wire = { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'x', session_id: 's', 'm.relates_to': relates }
  const clear = { msgtype: APPROVAL_RESPONSE_MSGTYPE, body: option, [APPROVAL_RESPONSE_BLOCK]: { option }, 'm.relates_to': relates }
  const content = (): Record<string, unknown> => (phase === 'clear' ? clear : phase === 'failed' ? { msgtype: 'm.bad.encrypted', body: '**' } : wire)
  const ev = {
    isEncrypted: () => true,
    isBeingDecrypted: () => phase === 'decrypting',
    shouldAttemptDecryption: () => false,
    isDecryptionFailure: () => phase === 'failed',
    decryptionFailureReason: null,
    getWireContent: () => wire,
    getClearContent: () => (phase === 'clear' ? clear : null),
    getType: () => (phase === 'decrypting' ? 'm.room.encrypted' : 'm.room.message'),
    getContent: content,
    getOriginalContent: content,
    isRedacted: () => false,
    getId: () => id,
    getTxnId: () => undefined,
    getSender: () => sender,
    getRoomId: () => ROOM_ID,
    getTs: () => 2500,
    status: null,
  }
  return { ev, fail: () => (phase = 'failed'), clear: () => (phase = 'clear') }
}

function harness() {
  const card = new MatrixEvent(cardRaw())
  const room = {
    roomId: ROOM_ID,
    getCanonicalAlias: () => null,
    getMyMembership: () => 'join',
    findEventById: (id: string) => (id === CARD_ID ? card : undefined),
    getThread: () => undefined,
    getLiveTimeline: () => ({ getEvents: () => [card], getPaginationToken: () => null }),
    relations: { getChildEventsForEvent: () => undefined },
    hasEncryptionStateEvent: () => false,
  }
  const handlers = new Map<string, Handler[]>()
  const fetchRelations = vi.fn(async () => ({ chunk: [] as Partial<IEvent>[] }))
  const client = {
    getRooms: () => [room],
    getRoom: () => room,
    getCrypto: () => ({}),
    getUserId: () => ME,
    getAccountData: () => undefined,
    fetchRelations,
    getEventMapper: () => (raw: Partial<IEvent>) => new MatrixEvent(raw),
    decryptEventIfNeeded: vi.fn(async () => {}),
    fetchRoomEvent: vi.fn(async () => cardRaw()),
    on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
    off: () => {},
  }
  const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
  const g = gateway as unknown as { client: unknown; live: boolean; wireEvents(c: unknown): void }
  g.client = client
  g.wireEvents(client)
  g.live = true
  const events: DomainEvent[] = []
  gateway.subscribe((e) => events.push(e))
  const fire = (name: string, ...args: unknown[]): void => {
    for (const h of handlers.get(name) ?? []) (h as (...a: unknown[]) => void)(...args)
  }
  const timeline = (ev: unknown): void => fire(RoomEvent.Timeline as string, ev, room, false, false, { liveEvent: true })
  const decrypted = (ev: unknown): void => fire(MatrixEventEvent.Decrypted as string, ev)
  const redaction = (target: string): void =>
    fire(RoomEvent.Redaction as string, new MatrixEvent({ type: 'm.room.redaction', redacts: target, room_id: ROOM_ID, sender: BOB, event_id: `$red-${target}` }), room)
  return { gateway, events, timeline, decrypted, redaction, fetchRelations, card }
}

const cardEdits = (events: DomainEvent[]): Message[] => events.flatMap((e) => (e.t === 'message.edited' && e.message.id === CARD_ID ? [e.message] : []))
const stateOf = (m: Message | undefined) => (m?.body.kind === 'approval' ? m.body.state : undefined)

describe('gateway — an answer folds into its card', () => {
  it('the card arrives open; a person’s answer re-emits the card answered — never a message.received of the answer', async () => {
    const { events, timeline, card } = harness()
    timeline(card)
    expect(events.map((e) => e.t)).toEqual(['message.received'])
    expect(stateOf((events[0] as { message: Message }).message)).toEqual({ kind: 'open' })
    await new Promise((r) => setTimeout(r, 0))
    const answer = new MatrixEvent(answerRaw(BOB, 'approve'))
    timeline(answer)
    expect(events.filter((e) => e.t === 'message.received')).toHaveLength(1)
    expect(stateOf(cardEdits(events).at(-1))).toMatchObject({ kind: 'answered', by: BOB, option: 'approve' })
  })

  it('an agent’s answer changes nothing', async () => {
    const { events, timeline, card } = harness()
    timeline(card)
    await new Promise((r) => setTimeout(r, 0))
    timeline(new MatrixEvent(answerRaw(AGENT, 'approve')))
    expect(cardEdits(events)).toEqual([])
    expect(events).toHaveLength(1)
  })

  it('an encrypted answer: no line; on a failed decrypt the card resolves without the option, then gains it', async () => {
    const { events, timeline, decrypted, card } = harness()
    timeline(card)
    await new Promise((r) => setTimeout(r, 0))
    const enc = encryptedAnswer('$enc:tayet.local', BOB, 'reject')
    timeline(enc.ev)
    enc.fail()
    decrypted(enc.ev)
    expect(stateOf(cardEdits(events).at(-1))).toEqual({ kind: 'answered', by: BOB, at: 2500 })
    enc.clear()
    decrypted(enc.ev)
    expect(stateOf(cardEdits(events).at(-1))).toEqual({ kind: 'answered', by: BOB, at: 2500, option: 'reject' })
    expect(events.filter((e) => e.t === 'message.received')).toHaveLength(1)
  })

  it('a deleted answer: no message.removed; the card returns to open', async () => {
    const { events, timeline, redaction, card } = harness()
    timeline(card)
    await new Promise((r) => setTimeout(r, 0))
    const answer = new MatrixEvent(answerRaw(BOB, 'approve'))
    timeline(answer)
    redaction(answer.getId()!)
    expect(events.some((e) => e.t === 'message.removed')).toBe(false)
    expect(stateOf(cardEdits(events).at(-1))).toEqual({ kind: 'open' })
  })

  it('the close: by another member ignored; by the author, the card closes', async () => {
    const { events, timeline, card } = harness()
    timeline(card)
    await new Promise((r) => setTimeout(r, 0))
    const close = (sender: string): MatrixEvent =>
      new MatrixEvent({
        event_id: `$close-${sender}`,
        room_id: ROOM_ID,
        sender,
        type: 'm.room.message',
        origin_server_ts: 9000,
        content: {
          msgtype: APPROVAL_MSGTYPE,
          body: '* Publicar?',
          'm.new_content': { msgtype: APPROVAL_MSGTYPE, body: 'Publicar?', [APPROVAL_BLOCK]: { options: OPTIONS, closed: true } },
          'm.relates_to': { rel_type: 'm.replace', event_id: CARD_ID },
        },
      })
    timeline(close(BOB))
    expect(cardEdits(events)).toEqual([])
    timeline(close(AGENT))
    expect(stateOf(cardEdits(events).at(-1))).toEqual({ kind: 'closed' })
  })

  it('a panel (and its update) never reaches the stream, in strict', () => {
    const { events, timeline } = harness()
    timeline(
      new MatrixEvent({
        event_id: '$panel',
        room_id: ROOM_ID,
        sender: AGENT,
        type: 'm.room.message',
        origin_server_ts: 3000,
        content: { msgtype: PANEL_MSGTYPE, body: 'Quadro', 'm.relates_to': { rel_type: PANEL_REL_TYPE, event_id: '$create' } },
      }),
    )
    timeline(
      new MatrixEvent({
        event_id: '$panel2',
        room_id: ROOM_ID,
        sender: AGENT,
        type: 'm.room.message',
        origin_server_ts: 4000,
        content: { msgtype: PANEL_MSGTYPE, body: '* Quadro', 'm.new_content': { msgtype: PANEL_MSGTYPE, body: 'Quadro 2' }, 'm.relates_to': { rel_type: 'm.replace', event_id: '$panel' } },
      }),
    )
    expect(events).toEqual([])
  })
})

describe('gateway — the close is the author’s first closing edit and it never reopens (ADR-091 dec. 7)', () => {
  const edit = (sender: string, ts: number, closed: boolean): MatrixEvent =>
    new MatrixEvent({
      event_id: `$edit-${ts}`,
      room_id: ROOM_ID,
      sender,
      type: 'm.room.message',
      origin_server_ts: ts,
      content: {
        msgtype: APPROVAL_MSGTYPE,
        body: '* Publicar?',
        'm.new_content': { msgtype: APPROVAL_MSGTYPE, body: closed ? 'Publicar? (encerrado)' : 'Publicar? (texto novo)', [APPROVAL_BLOCK]: { options: OPTIONS, ...(closed && { closed: true }) } },
        'm.relates_to': { rel_type: 'm.replace', event_id: CARD_ID },
      },
    })
  const answerAt = (sender: string, option: string, ts: number): MatrixEvent => new MatrixEvent(answerRaw(sender, option, { origin_server_ts: ts }))

  it('close → late answer → a new author edit: the card stays closed', async () => {
    const { events, timeline, card } = harness()
    timeline(card)
    await new Promise((r) => setTimeout(r, 0))
    timeline(edit(AGENT, 3000, true))
    timeline(answerAt(BOB, 'approve', 4000))
    timeline(edit(AGENT, 6000, true))
    const states = cardEdits(events).map(stateOf)
    expect(states.at(-1)).toEqual({ kind: 'closed' })
    expect(states.some((s) => s?.kind === 'answered')).toBe(false)
  })

  it('close → an author edit without the mark: still closed (the text changes)', async () => {
    const { events, timeline, card } = harness()
    timeline(card)
    await new Promise((r) => setTimeout(r, 0))
    timeline(edit(AGENT, 3000, true))
    timeline(edit(AGENT, 5000, false))
    const last = cardEdits(events).at(-1)
    expect(stateOf(last)).toEqual({ kind: 'closed' })
    expect(last?.body.kind === 'approval' && last.body.text).toBe('Publicar? (texto novo)')
  })

  it('an answer before the first close + a later author edit: still answered, the same answer', async () => {
    const { events, timeline, card } = harness()
    timeline(card)
    await new Promise((r) => setTimeout(r, 0))
    timeline(answerAt(BOB, 'reject', 2500))
    timeline(edit(AGENT, 3000, true))
    timeline(answerAt(CAROL, 'approve', 3500))
    timeline(edit(AGENT, 7000, false))
    expect(stateOf(cardEdits(events).at(-1))).toEqual({ kind: 'answered', by: BOB, at: 2500, option: 'reject' })
  })
})
