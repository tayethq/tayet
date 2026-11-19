import { describe, it, expect, vi } from 'vitest'
import { EventStatus, MatrixEvent, RoomEvent, type IEvent } from 'matrix-js-sdk'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import { ApprovalAggregator, PendingAnswers, takesAnswer, type AnswerFact, type AnswerPage } from '../src/acl/internal/approval-state'
import {
  APPROVAL_BLOCK,
  APPROVAL_MSGTYPE,
  APPROVAL_RESPONSE_BLOCK,
  APPROVAL_RESPONSE_MSGTYPE,
  RESPONSE_REL_TYPE,
  type ApprovalCardFacts,
} from '@tayet/shared/internal'
import type { ApprovalState } from '@tayet/shared'
import type { AclTelemetry, DomainEvent, MessageId } from '../src/acl'

// A card that declares how many answers it asks for, in the client: the aggregator (it reads until the
// card holds all it asks for, a deleted answer reopens the read, live answers and late decrypts), the
// viewer's own pending answer folded per viewer, and the guard of the answer verb. No stack: fake ports,
// and a fake client and room over real SDK events for the verb.

const ME = '@me:tayet.local'
const AGENT = '@a-abcdefghijkm:tayet.local'
const BOB = '@bob:tayet.local'
const CAROL = '@carol:tayet.local'
const DAVE = '@dave:tayet.local'
const ROOM_ID = '!room:tayet.local'
const CARD_ID = '$card:tayet.local'
const CARD = CARD_ID as unknown as MessageId

const OPTIONS = [
  { id: 'approve', label: 'Aprovar', style: 'primary' as const },
  { id: 'reject', label: 'Recusar' },
]
const FACTS = (needed: number, closedAt?: number): ApprovalCardFacts => ({
  options: OPTIONS,
  author: AGENT,
  closedAt,
  bornClosedAt: closedAt,
  edited: false,
  needed,
})
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0))
}
const fact = (eventId: string, sender: string, ts: number, option?: string, decrypted = true): AnswerFact => ({
  eventId,
  sender,
  ts,
  decrypted,
  ...(option !== undefined && { option }),
})
const line = (by: string, at: number, option?: string) => ({ by, at, ...(option !== undefined && { option }) })

function aggregator(pages: Record<string, AnswerPage>) {
  const fetchPage = vi.fn(async (_room: string, _card: string, from: string | undefined) => {
    const page = pages[from ?? 'start']
    if (!page) throw new Error('no page')
    return page
  })
  const changed = vi.fn()
  const agg = new ApprovalAggregator({
    fetchPage,
    fetchEditPage: vi.fn(async () => ({ edits: [] })),
    accounts: () => ({ custodian: '@cofre:tayet.local', systemAccount: '@sistema:tayet.local' }),
    changed,
    detach: (work) => void work,
  })
  return { agg, fetchPage, changed }
}

describe('ApprovalAggregator — a card that asks for several answers', () => {
  it('born with no answers while the read runs; then the answers in the server order', async () => {
    const { agg, changed } = aggregator({ start: { answers: [fact('$r1', BOB, 2000, 'approve')] } })
    expect(agg.stateFor(ROOM_ID, CARD_ID, FACTS(2))).toEqual({ kind: 'multi', needed: 2, answers: [], closed: false })
    await flush()
    expect(changed).toHaveBeenCalledWith(ROOM_ID, CARD_ID)
    expect(agg.stateFor(ROOM_ID, CARD_ID, FACTS(2))).toEqual({ kind: 'multi', needed: 2, answers: [line(BOB, 2000, 'approve')], closed: false })
  })

  it('reads past the first answer, and stops once the card holds all it asks for', async () => {
    const { agg, fetchPage } = aggregator({
      start: { answers: [fact('$r1', BOB, 2000, 'approve')], next: 'p2' },
      p2: { answers: [fact('$r2', CAROL, 3000, 'reject')], next: 'p3' },
      p3: { answers: [fact('$r3', DAVE, 4000, 'approve')] },
    })
    agg.stateFor(ROOM_ID, CARD_ID, FACTS(2))
    await flush()
    expect(fetchPage.mock.calls.map((c) => c[2])).toEqual([undefined, 'p2'])
    expect(agg.stateFor(ROOM_ID, CARD_ID, FACTS(2))).toMatchObject({ answers: [line(BOB, 2000, 'approve'), line(CAROL, 3000, 'reject')] })
    // Settled: a second translation reads nothing more.
    await flush()
    expect(fetchPage).toHaveBeenCalledTimes(2)
  })

  it('a deleted answer that counted reopens the read: the next one comes in', async () => {
    const { agg, fetchPage, changed } = aggregator({
      start: { answers: [fact('$r1', BOB, 2000, 'approve'), fact('$r2', CAROL, 3000, 'reject')], next: 'p2' },
      p2: { answers: [fact('$r3', DAVE, 4000, 'approve')] },
    })
    agg.stateFor(ROOM_ID, CARD_ID, FACTS(2))
    await flush()
    expect(fetchPage).toHaveBeenCalledTimes(1)
    changed.mockClear()
    expect(agg.forgetAnswer('$r1')).toBe(true)
    await flush()
    expect(fetchPage.mock.calls.map((c) => c[2])).toEqual([undefined, 'p2'])
    expect(changed).toHaveBeenCalled()
    expect(agg.stateFor(ROOM_ID, CARD_ID, FACTS(2))).toMatchObject({ answers: [line(CAROL, 3000, 'reject'), line(DAVE, 4000, 'approve')] })
  })

  it('a live answer joins; an N+1-th live answer does not appear', async () => {
    const { agg, changed } = aggregator({ start: { answers: [] } })
    agg.stateFor(ROOM_ID, CARD_ID, FACTS(2))
    await flush()
    agg.noteAnswer(ROOM_ID, CARD_ID, fact('$r1', BOB, 2000, 'approve'))
    agg.noteAnswer(ROOM_ID, CARD_ID, fact('$r2', CAROL, 3000, 'reject'))
    changed.mockClear()
    agg.noteAnswer(ROOM_ID, CARD_ID, fact('$r3', DAVE, 4000, 'approve'))
    expect(changed).not.toHaveBeenCalled()
    expect(agg.stateFor(ROOM_ID, CARD_ID, FACTS(2))).toMatchObject({ answers: [line(BOB, 2000, 'approve'), line(CAROL, 3000, 'reject')] })
  })

  it('an answer not readable yet holds its line without the option; the late decrypt fills it in place', async () => {
    const { agg } = aggregator({ start: { answers: [fact('$r1', BOB, 2000, undefined, false)] } })
    agg.stateFor(ROOM_ID, CARD_ID, FACTS(3))
    await flush()
    agg.noteAnswer(ROOM_ID, CARD_ID, fact('$r2', CAROL, 3000, 'reject'))
    expect(agg.stateFor(ROOM_ID, CARD_ID, FACTS(3))).toMatchObject({ answers: [line(BOB, 2000), line(CAROL, 3000, 'reject')] })
    agg.noteAnswer(ROOM_ID, CARD_ID, fact('$r1', BOB, 2000, 'approve'))
    expect(agg.stateFor(ROOM_ID, CARD_ID, FACTS(3))).toMatchObject({ answers: [line(BOB, 2000, 'approve'), line(CAROL, 3000, 'reject')] })
  })

  it('a card without the declaration still stops on its first answer', async () => {
    const { agg, fetchPage } = aggregator({
      start: { answers: [fact('$r1', BOB, 2000, 'approve')], next: 'p2' },
      p2: { answers: [fact('$r2', CAROL, 3000, 'reject')] },
    })
    const { needed: _n, ...single } = FACTS(2)
    agg.stateFor(ROOM_ID, CARD_ID, single)
    await flush()
    expect(fetchPage).toHaveBeenCalledTimes(1)
    expect(agg.stateFor(ROOM_ID, CARD_ID, single)).toEqual({ kind: 'answered', by: BOB, at: 2000, option: 'approve' })
  })
})

const multi = (answers: Array<ReturnType<typeof line>>, needed = 2, closed = false): ApprovalState =>
  ({ kind: 'multi', needed, answers, closed }) as ApprovalState

describe('PendingAnswers.overlay — a card that asks for several answers', () => {
  const p = (status: 'sending' | 'sent' | 'failed') => ({ option: 'approve', status })

  it('folds in as own while the viewer can still answer: sending and sent → sending; failed → failed', () => {
    const pa = new PendingAnswers()
    const state = multi([line(BOB, 2000, 'reject')])
    pa.set(ROOM_ID, CARD_ID, p('sending'))
    expect(pa.overlay(ROOM_ID, CARD_ID, state, ME)).toEqual({ ...state, own: { status: 'sending', option: 'approve' } })
    pa.set(ROOM_ID, CARD_ID, p('sent'))
    expect(pa.overlay(ROOM_ID, CARD_ID, state, ME)).toEqual({ ...state, own: { status: 'sending', option: 'approve' } })
    pa.set(ROOM_ID, CARD_ID, p('failed'))
    expect(pa.overlay(ROOM_ID, CARD_ID, state, ME)).toEqual({ ...state, own: { status: 'failed', option: 'approve' } })
  })

  it('the viewer’s answer counted, the card complete, or closed: the pending goes and the state comes back as it came', () => {
    for (const state of [multi([line(ME, 2000, 'approve')]), multi([line(BOB, 2000, 'approve'), line(CAROL, 3000, 'reject')]), multi([], 2, true)]) {
      const pa = new PendingAnswers()
      pa.set(ROOM_ID, CARD_ID, p('sending'))
      expect(pa.overlay(ROOM_ID, CARD_ID, state, ME)).toBe(state)
      expect(pa.get(ROOM_ID, CARD_ID)).toBeUndefined()
    }
  })

  it('another person’s line does not drop the viewer’s pending', () => {
    const pa = new PendingAnswers()
    pa.set(ROOM_ID, CARD_ID, p('sent'))
    pa.overlay(ROOM_ID, CARD_ID, multi([line(BOB, 2000, 'reject')], 3), ME)
    expect(pa.get(ROOM_ID, CARD_ID)).toBeDefined()
  })
})

describe('takesAnswer — a card that asks for several answers', () => {
  it('takes it: open, no line of the viewer, no own, or own failed', () => {
    expect(takesAnswer(multi([]), ME)).toBe(true)
    expect(takesAnswer(multi([line(BOB, 2000, 'approve')]), ME)).toBe(true)
    expect(takesAnswer({ ...(multi([]) as object), own: { status: 'failed', option: 'approve' } } as ApprovalState, ME)).toBe(true)
  })

  it('refuses it: closed, complete, the viewer already has a line, or own sending', () => {
    expect(takesAnswer(multi([], 2, true), ME)).toBe(false)
    expect(takesAnswer(multi([line(BOB, 2000, 'approve'), line(CAROL, 3000, 'reject')]), ME)).toBe(false)
    expect(takesAnswer(multi([line(ME, 2000, 'approve')]), ME)).toBe(false)
    expect(takesAnswer({ ...(multi([]) as object), own: { status: 'sending', option: 'approve' } } as ApprovalState, ME)).toBe(false)
  })
})

// ── The verb, through the gateway ─────────────────────────────────────────────────────────────

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
type Handler = (...args: never[]) => void
type Deferred = { resolve: (v: { event_id: string }) => void; reject: (e: unknown) => void }

const cardRaw = (needed: number, closed = false): Partial<IEvent> => ({
  event_id: CARD_ID,
  room_id: ROOM_ID,
  sender: AGENT,
  type: 'm.room.message',
  origin_server_ts: 1000,
  content: { msgtype: APPROVAL_MSGTYPE, body: 'Publicar?', [APPROVAL_BLOCK]: { options: OPTIONS, needed, ...(closed && { closed: true }) } },
})
const answerRaw = (id: string, sender: string, option: string, ts: number): Partial<IEvent> => ({
  event_id: id,
  room_id: ROOM_ID,
  sender,
  type: 'm.room.message',
  origin_server_ts: ts,
  content: { msgtype: APPROVAL_RESPONSE_MSGTYPE, body: option, [APPROVAL_RESPONSE_BLOCK]: { option }, 'm.relates_to': { rel_type: RESPONSE_REL_TYPE, event_id: CARD_ID } },
})

function harness(needed: number, closed = false) {
  const card = new MatrixEvent(cardRaw(needed, closed))
  const echoes: MatrixEvent[] = []
  const room = {
    roomId: ROOM_ID,
    getCanonicalAlias: () => null,
    getMyMembership: () => 'join',
    findEventById: (id: string) => (id === CARD_ID ? card : undefined),
    getThread: () => undefined,
    getLiveTimeline: () => ({ getEvents: () => [card, ...echoes], getPaginationToken: () => null }),
    relations: { getChildEventsForEvent: () => undefined },
    hasEncryptionStateEvent: () => false,
  }
  const handlers = new Map<string, Handler[]>()
  const onServer: Partial<IEvent>[] = []
  const fetchRelations = vi.fn(async (_room: string, _card: string, relType: string) => ({ chunk: relType === RESPONSE_REL_TYPE ? [...onServer] : [] }))
  const sends: Deferred[] = []
  const sendEvent = vi.fn(
    (_room: string, _type: string, content: unknown, txnId: string) =>
      new Promise<{ event_id: string }>((resolve, reject) => {
        const echo = new MatrixEvent({ event_id: `~${ROOM_ID}:${txnId}`, room_id: ROOM_ID, sender: ME, type: 'm.room.message', origin_server_ts: 5000, content: content as Record<string, unknown> })
        echo.setTxnId(txnId)
        echo.setStatus(EventStatus.SENDING)
        echoes.push(echo)
        sends.push({
          resolve,
          reject: (e) => {
            echo.setStatus(EventStatus.NOT_SENT)
            reject(e)
          },
        })
      }),
  )
  let txn = 0
  const client = {
    getRooms: () => [room],
    getRoom: () => room,
    getCrypto: () => ({}),
    getUserId: () => ME,
    getAccountData: () => undefined,
    fetchRelations,
    getEventMapper: () => (raw: Partial<IEvent>) => new MatrixEvent(raw),
    decryptEventIfNeeded: vi.fn(async () => {}),
    fetchRoomEvent: vi.fn(async () => cardRaw(needed, closed)),
    makeTxnId: () => `txn${++txn}`,
    sendEvent,
    cancelPendingEvent: vi.fn((ev: MatrixEvent) => {
      const i = echoes.indexOf(ev)
      if (i >= 0) echoes.splice(i, 1)
    }),
    on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
    off: () => {},
  }
  const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
  const g = gateway as unknown as { client: unknown; live: boolean; wireEvents(c: unknown): void; pendingAnswers: PendingAnswers }
  g.client = client
  g.wireEvents(client)
  g.live = true
  const events: DomainEvent[] = []
  gateway.subscribe((e) => events.push(e))
  const fire = (name: string, ...args: unknown[]): void => {
    for (const h of handlers.get(name) ?? []) (h as (...a: unknown[]) => void)(...args)
  }
  const timeline = (ev: unknown): void => fire(RoomEvent.Timeline as string, ev, room, false, false, { liveEvent: true })
  return { gateway, g, events, timeline, card, onServer, sends, sendEvent }
}

const lastState = (events: DomainEvent[]): ApprovalState | undefined =>
  events.flatMap((e) => (e.t === 'message.edited' && e.message.id === CARD && e.message.body.kind === 'approval' ? [e.message.body.state] : [])).at(-1)

async function shown(h: ReturnType<typeof harness>): Promise<void> {
  h.timeline(h.card)
  await flush()
}

describe('answerApproval — a card that asks for several answers', () => {
  it('another person answered first: the viewer still answers; sending shows as own; then the viewer’s line', async () => {
    const h = harness(2)
    await shown(h)
    h.timeline(new MatrixEvent(answerRaw('$bob', BOB, 'reject', 2000)))
    expect(lastState(h.events)).toEqual({ kind: 'multi', needed: 2, answers: [line(BOB, 2000, 'reject')], closed: false })
    const done = h.gateway.answerApproval(CARD, 'approve')
    expect(h.sendEvent).toHaveBeenCalledTimes(1)
    expect(lastState(h.events)).toMatchObject({ answers: [line(BOB, 2000, 'reject')], own: { status: 'sending', option: 'approve' } })
    // A second click while it runs joins the send.
    void h.gateway.answerApproval(CARD, 'reject')
    expect(h.sendEvent).toHaveBeenCalledTimes(1)
    h.onServer.push(answerRaw('$bob', BOB, 'reject', 2000), answerRaw('$mine', ME, 'approve', 3000))
    h.sends[0]!.resolve({ event_id: '$mine' })
    await done
    await flush()
    expect(lastState(h.events)).toEqual({ kind: 'multi', needed: 2, answers: [line(BOB, 2000, 'reject'), line(ME, 3000, 'approve')], closed: false })
    expect(h.g.pendingAnswers.get(ROOM_ID, CARD_ID)).toBeUndefined()
  })

  it('refused: the viewer already has a line', async () => {
    const h = harness(3)
    await shown(h)
    h.timeline(new MatrixEvent(answerRaw('$mine', ME, 'approve', 2000)))
    await expect(h.gateway.answerApproval(CARD, 'reject')).rejects.toThrow('approval card not open')
    expect(h.sendEvent).not.toHaveBeenCalled()
  })

  it('refused: the card is complete', async () => {
    const h = harness(2)
    await shown(h)
    h.timeline(new MatrixEvent(answerRaw('$bob', BOB, 'approve', 2000)))
    h.timeline(new MatrixEvent(answerRaw('$carol', CAROL, 'reject', 3000)))
    await expect(h.gateway.answerApproval(CARD, 'approve')).rejects.toThrow('approval card not open')
    expect(h.sendEvent).not.toHaveBeenCalled()
  })

  it('refused: the card is closed', async () => {
    const h = harness(2, true)
    await shown(h)
    await expect(h.gateway.answerApproval(CARD, 'approve')).rejects.toThrow('approval card not open')
    expect(h.sendEvent).not.toHaveBeenCalled()
  })

  it('a failed answer retries; once sent, the viewer’s line shows at once and a second answer is refused', async () => {
    const h = harness(2)
    await shown(h)
    const first = h.gateway.answerApproval(CARD, 'approve')
    h.sends[0]!.reject(new Error('offline'))
    await expect(first).rejects.toThrow('offline')
    expect(lastState(h.events)).toMatchObject({ own: { status: 'failed', option: 'approve' } })
    const again = h.gateway.answerApproval(CARD, 'approve')
    expect(h.sendEvent).toHaveBeenCalledTimes(2)
    h.sends[1]!.resolve({ event_id: '$mine' }) // the page does not have it yet
    await again
    await flush()
    const after = lastState(h.events)
    expect(after).toMatchObject({ kind: 'multi', answers: [{ by: ME, option: 'approve' }] })
    expect(after).not.toHaveProperty('own')
    await expect(h.gateway.answerApproval(CARD, 'reject')).rejects.toThrow('approval card not open')
    expect(h.sendEvent).toHaveBeenCalledTimes(2)
  })
})
