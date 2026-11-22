import { describe, it, expect, vi } from 'vitest'
import { EventStatus, MatrixEvent, RoomEvent, type IEvent } from 'matrix-js-sdk'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import { PendingAnswers } from '../src/acl/internal/approval-state'
import { APPROVAL_BLOCK, APPROVAL_MSGTYPE, APPROVAL_RESPONSE_BLOCK, APPROVAL_RESPONSE_MSGTYPE, RESPONSE_REL_TYPE } from '@tayet/shared/internal'
import type { ApprovalState } from '@tayet/shared'
import type { AclTelemetry, DomainEvent, Message, MessageId } from '../src/acl'

// ADR-091 (Proposto) dec. 14, A3-2 — answering a card from the client: the verb's refusals, the send,
// its failure and retry, the double click; the echo folded into the card (sending/failed, never a line);
// the precedence of the aggregated state over the local pending (another person first in the server's
// order; a close during the send); the pending cleared on disconnect. No stack: fake client and room
// over real SDK events, the shape of approval-state.test.ts's gateway harness.

const ME = '@me:tayet.local'
const AGENT = '@a-abcdefghijkm:tayet.local'
const BOB = '@bob:tayet.local'
const ROOM_ID = '!room:tayet.local'
const CARD_ID = '$card:tayet.local'
const TEXT_ID = '$text:tayet.local'
const CARD = CARD_ID as unknown as MessageId

const OPTIONS = [
  { id: 'approve', label: 'Aprovar', style: 'primary' as const },
  { id: 'reject', label: 'Rejeitar' },
]
const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0))
}

type Handler = (...args: never[]) => void
type Deferred = { resolve: (v: { event_id: string }) => void; reject: (e: unknown) => void }

const cardRaw = (closed = false): Partial<IEvent> => ({
  event_id: CARD_ID,
  room_id: ROOM_ID,
  sender: AGENT,
  type: 'm.room.message',
  origin_server_ts: 1000,
  content: { msgtype: APPROVAL_MSGTYPE, body: 'Publicar?', [APPROVAL_BLOCK]: { options: OPTIONS, ...(closed && { closed: true }) } },
})
const answerRaw = (id: string, sender: string, option: string, ts: number): Partial<IEvent> => ({
  event_id: id,
  room_id: ROOM_ID,
  sender,
  type: 'm.room.message',
  origin_server_ts: ts,
  content: { msgtype: APPROVAL_RESPONSE_MSGTYPE, body: option, [APPROVAL_RESPONSE_BLOCK]: { option }, 'm.relates_to': { rel_type: RESPONSE_REL_TYPE, event_id: CARD_ID } },
})
const closeRaw = (ts: number): Partial<IEvent> => ({
  event_id: `$close-${ts}`,
  room_id: ROOM_ID,
  sender: AGENT,
  type: 'm.room.message',
  origin_server_ts: ts,
  content: {
    msgtype: APPROVAL_MSGTYPE,
    body: '* Publicar?',
    'm.new_content': { msgtype: APPROVAL_MSGTYPE, body: 'Publicar?', [APPROVAL_BLOCK]: { options: OPTIONS, closed: true } },
    'm.relates_to': { rel_type: 'm.replace', event_id: CARD_ID },
  },
})

function harness(opts: { closedCard?: boolean } = {}) {
  const card = new MatrixEvent(cardRaw(opts.closedCard))
  const text = new MatrixEvent({ event_id: TEXT_ID, room_id: ROOM_ID, sender: AGENT, type: 'm.room.message', origin_server_ts: 900, content: { msgtype: 'm.text', body: 'oi' } })
  const echoes: MatrixEvent[] = []
  const room = {
    roomId: ROOM_ID,
    getCanonicalAlias: () => null,
    getMyMembership: () => 'join',
    findEventById: (id: string) => (id === CARD_ID ? card : id === TEXT_ID ? text : undefined),
    getThread: () => undefined,
    getThreads: () => [],
    getEventForTxnId: () => undefined,
    getLiveTimeline: () => ({ getEvents: () => [text, card, ...echoes], getPaginationToken: () => null }),
    relations: { getChildEventsForEvent: () => undefined },
    hasEncryptionStateEvent: () => false,
  }
  const handlers = new Map<string, Handler[]>()
  // The card's answers on the server, in the server's order (what a forward relation read returns).
  const onServer: Partial<IEvent>[] = []
  const fetchRelations = vi.fn(async (_room: string, _card: string, relType: string) => ({ chunk: relType === RESPONSE_REL_TYPE ? [...onServer] : [] }))
  const sends: Deferred[] = []
  const sendEvent = vi.fn(
    (_room: string, _type: string, _content: unknown, txnId: string) =>
      new Promise<{ event_id: string }>((resolve, reject) => {
        // The SDK's local echo of the send, with its "~" id until the server accepts it.
        const echo = new MatrixEvent({ event_id: `~${ROOM_ID}:${txnId}`, room_id: ROOM_ID, sender: ME, type: 'm.room.message', origin_server_ts: 5000, content: _content as Record<string, unknown> })
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
  const cancelPendingEvent = vi.fn((ev: MatrixEvent) => {
    const i = echoes.indexOf(ev)
    if (i >= 0) echoes.splice(i, 1)
  })
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
    fetchRoomEvent: vi.fn(async () => cardRaw(opts.closedCard)),
    makeTxnId: () => `txn${++txn}`,
    sendEvent,
    cancelPendingEvent,
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
  const localEcho = (ev: MatrixEvent, oldStatus: EventStatus | null): void => fire(RoomEvent.LocalEchoUpdated as string, ev, room, undefined, oldStatus)
  return { gateway, g, events, timeline, localEcho, card, onServer, sends, sendEvent, cancelPendingEvent, echoes }
}

const cardStates = (events: DomainEvent[]): ApprovalState[] =>
  events.flatMap((e) => (e.t === 'message.edited' && e.message.id === CARD && e.message.body.kind === 'approval' ? [e.message.body.state] : []))
const lastState = (events: DomainEvent[]): ApprovalState | undefined => cardStates(events).at(-1)
const lines = (events: DomainEvent[]): Message[] => events.flatMap((e) => (e.t === 'message.received' ? [e.message] : []))

// The card on screen, its first read settled (open, no answers).
async function shown(h: ReturnType<typeof harness>): Promise<void> {
  h.timeline(h.card)
  await flush()
}

describe('answerApproval — the refusals (before any effect)', () => {
  it('a message that is not a card', async () => {
    const h = harness()
    await shown(h)
    await expect(h.gateway.answerApproval(TEXT_ID as unknown as MessageId, 'approve')).rejects.toThrow('not an approval card')
    expect(h.sendEvent).not.toHaveBeenCalled()
  })

  it('an unknown message', async () => {
    const h = harness()
    await expect(h.gateway.answerApproval('$nope:tayet.local' as unknown as MessageId, 'approve')).rejects.toThrow('message not found')
    expect(h.sendEvent).not.toHaveBeenCalled()
  })

  it('an option that is not among the card’s', async () => {
    const h = harness()
    await shown(h)
    await expect(h.gateway.answerApproval(CARD, 'maybe')).rejects.toThrow('option not on the card')
    expect(h.sendEvent).not.toHaveBeenCalled()
    expect(cardStates(h.events)).toEqual([])
  })

  it('a card already answered (by another person)', async () => {
    const h = harness()
    await shown(h)
    h.timeline(new MatrixEvent(answerRaw('$bob', BOB, 'reject', 2000)))
    expect(lastState(h.events)).toMatchObject({ kind: 'answered', by: BOB })
    await expect(h.gateway.answerApproval(CARD, 'approve')).rejects.toThrow('approval card not open')
    expect(h.sendEvent).not.toHaveBeenCalled()
  })

  it('a closed card', async () => {
    const h = harness({ closedCard: true })
    await shown(h)
    await expect(h.gateway.answerApproval(CARD, 'approve')).rejects.toThrow('approval card not open')
    expect(h.sendEvent).not.toHaveBeenCalled()
  })
})

describe('answerApproval — the send folds into the card', () => {
  it('sending at once; the server accepts → the card resolves by the rule, answered by me; never a line or a status', async () => {
    const h = harness()
    await shown(h)
    const done = h.gateway.answerApproval(CARD, 'approve')
    expect(lastState(h.events)).toEqual({ kind: 'sending', option: 'approve' })
    expect(h.sendEvent).toHaveBeenCalledTimes(1)
    const [roomId, type, content, txnId] = h.sendEvent.mock.calls[0]!
    expect([roomId, type, txnId]).toEqual([ROOM_ID, 'm.room.message', 'txn1'])
    expect(JSON.stringify(content)).toBe(
      `{"msgtype":"${APPROVAL_RESPONSE_MSGTYPE}","body":"Aprovar","${APPROVAL_RESPONSE_BLOCK}":{"option":"approve"},"m.relates_to":{"rel_type":"${RESPONSE_REL_TYPE}","event_id":"${CARD_ID}"}}`,
    )
    // The SDK's local echo reaches the timeline: no line, no answer (the card stays sending).
    h.timeline(h.echoes[0])
    expect(lastState(h.events)).toEqual({ kind: 'sending', option: 'approve' })
    h.onServer.push(answerRaw('$mine', ME, 'approve', 3000))
    h.sends[0]!.resolve({ event_id: '$mine' })
    await done
    await flush()
    // The remote echo settles the local one: no message.status for it.
    h.localEcho(h.echoes[0]!, EventStatus.SENT)
    expect(lastState(h.events)).toEqual({ kind: 'answered', by: ME, at: 3000, option: 'approve' })
    expect(lines(h.events).map((m) => m.id)).toEqual([CARD])
    expect(h.events.some((e) => e.t === 'message.status')).toBe(false)
    // The aggregated state took over: no pending left.
    expect(h.g.pendingAnswers.get(ROOM_ID, CARD_ID)).toBeUndefined()
  })

  it('a sent answer stays sending until the aggregator resolves — the buttons never come back in between', async () => {
    const h = harness()
    await shown(h)
    const done = h.gateway.answerApproval(CARD, 'reject')
    h.sends[0]!.resolve({ event_id: '$mine' }) // the page does not have it yet
    await done
    expect(cardStates(h.events).every((s) => s.kind !== 'open')).toBe(true)
  })

  it('failure → failed (the promise rejects, the queued echo is cancelled); "Tentar de novo" sends again with the same option', async () => {
    const h = harness()
    await shown(h)
    const first = h.gateway.answerApproval(CARD, 'approve')
    h.sends[0]!.reject(new Error('offline'))
    await expect(first).rejects.toThrow('offline')
    expect(lastState(h.events)).toEqual({ kind: 'failed', option: 'approve' })
    expect(h.cancelPendingEvent).toHaveBeenCalledTimes(1)
    expect(h.echoes).toHaveLength(0)
    // The retry: the same verb, the same option.
    const again = h.gateway.answerApproval(CARD, 'approve')
    expect(lastState(h.events)).toEqual({ kind: 'sending', option: 'approve' })
    expect(h.sendEvent).toHaveBeenCalledTimes(2)
    h.onServer.push(answerRaw('$mine', ME, 'approve', 3000))
    h.sends[1]!.resolve({ event_id: '$mine' })
    await again
    await flush()
    expect(lastState(h.events)).toEqual({ kind: 'answered', by: ME, at: 3000, option: 'approve' })
    expect(lines(h.events)).toHaveLength(1)
  })

  it('a double click, or another option while sending, joins the send in flight: one send', async () => {
    const h = harness()
    await shown(h)
    const a = h.gateway.answerApproval(CARD, 'approve')
    const b = h.gateway.answerApproval(CARD, 'approve')
    const c = h.gateway.answerApproval(CARD, 'reject')
    expect(h.sendEvent).toHaveBeenCalledTimes(1)
    expect(lastState(h.events)).toEqual({ kind: 'sending', option: 'approve' })
    h.onServer.push(answerRaw('$mine', ME, 'approve', 3000))
    h.sends[0]!.resolve({ event_id: '$mine' })
    await Promise.all([a, b, c])
    expect(h.sendEvent).toHaveBeenCalledTimes(1)
  })
})

describe('answerApproval — the aggregated state wins over the pending', () => {
  it('another person’s answer arrives during my send: answered by them, the pending goes; my later answer changes nothing', async () => {
    const h = harness()
    await shown(h)
    const done = h.gateway.answerApproval(CARD, 'approve')
    h.onServer.push(answerRaw('$bob', BOB, 'reject', 2000))
    h.timeline(new MatrixEvent(answerRaw('$bob', BOB, 'reject', 2000)))
    expect(lastState(h.events)).toEqual({ kind: 'answered', by: BOB, at: 2000, option: 'reject' })
    expect(h.g.pendingAnswers.get(ROOM_ID, CARD_ID)).toBeUndefined()
    h.onServer.push(answerRaw('$mine', ME, 'approve', 3000))
    h.sends[0]!.resolve({ event_id: '$mine' })
    await done
    await flush()
    expect(lastState(h.events)).toEqual({ kind: 'answered', by: BOB, at: 2000, option: 'reject' })
  })

  it('mine is accepted before theirs reaches this client, but theirs is first on the server: the page decides — theirs', async () => {
    const h = harness()
    await shown(h)
    const done = h.gateway.answerApproval(CARD, 'approve')
    h.onServer.push(answerRaw('$bob', BOB, 'reject', 2000), answerRaw('$mine', ME, 'approve', 2001))
    h.sends[0]!.resolve({ event_id: '$mine' })
    await done
    await flush()
    expect(lastState(h.events)).toEqual({ kind: 'answered', by: BOB, at: 2000, option: 'reject' })
    // Theirs arrives live afterwards: still theirs.
    h.timeline(new MatrixEvent(answerRaw('$bob', BOB, 'reject', 2000)))
    expect(lastState(h.events)).toEqual({ kind: 'answered', by: BOB, at: 2000, option: 'reject' })
  })

  it('the author closes the card during my send: closed, the pending goes; my answer after the close does not count', async () => {
    const h = harness()
    await shown(h)
    const done = h.gateway.answerApproval(CARD, 'approve')
    h.timeline(new MatrixEvent(closeRaw(2500)))
    expect(lastState(h.events)).toEqual({ kind: 'closed' })
    expect(h.g.pendingAnswers.get(ROOM_ID, CARD_ID)).toBeUndefined()
    h.onServer.push(answerRaw('$mine', ME, 'approve', 3000))
    h.sends[0]!.resolve({ event_id: '$mine' })
    await done
    await flush()
    expect(lastState(h.events)).toEqual({ kind: 'closed' })
  })

  it('a failure after another person answered shows nothing of mine: the card stays answered', async () => {
    const h = harness()
    await shown(h)
    const done = h.gateway.answerApproval(CARD, 'approve')
    h.timeline(new MatrixEvent(answerRaw('$bob', BOB, 'reject', 2000)))
    h.sends[0]!.reject(new Error('offline'))
    await expect(done).rejects.toThrow('offline')
    expect(lastState(h.events)).toMatchObject({ kind: 'answered', by: BOB })
  })
})

describe('answerApproval — the pending is cleared', () => {
  it('disconnect clears it; a send that settles after it emits nothing', async () => {
    const h = harness()
    await shown(h)
    const failed = h.gateway.answerApproval(CARD, 'approve')
    h.sends[0]!.reject(new Error('offline'))
    await expect(failed).rejects.toThrow()
    const inFlight = h.gateway.answerApproval(CARD, 'approve')
    expect(h.g.pendingAnswers.get(ROOM_ID, CARD_ID)).toMatchObject({ status: 'sending' })
    await h.gateway.disconnect().catch(() => {})
    expect(h.g.pendingAnswers.get(ROOM_ID, CARD_ID)).toBeUndefined()
    const before = h.events.length
    h.sends[1]!.resolve({ event_id: '$mine' })
    await inFlight
    expect(h.events.length).toBe(before)
  })
})

describe('PendingAnswers.overlay', () => {
  const p = (status: 'sending' | 'sent' | 'failed') => ({ option: 'approve', status })
  it('folds into an open card: sending (and sent) → sending; failed → failed', () => {
    const pa = new PendingAnswers()
    pa.set(ROOM_ID, CARD_ID, p('sending'))
    expect(pa.overlay(ROOM_ID, CARD_ID, { kind: 'open' })).toEqual({ kind: 'sending', option: 'approve' })
    pa.set(ROOM_ID, CARD_ID, p('sent'))
    expect(pa.overlay(ROOM_ID, CARD_ID, { kind: 'open' })).toEqual({ kind: 'sending', option: 'approve' })
    pa.set(ROOM_ID, CARD_ID, p('failed'))
    expect(pa.overlay(ROOM_ID, CARD_ID, { kind: 'open' })).toEqual({ kind: 'failed', option: 'approve' })
  })

  it('answered or closed wins and drops the pending; another card is untouched', () => {
    const pa = new PendingAnswers()
    pa.set(ROOM_ID, CARD_ID, p('sending'))
    pa.set(ROOM_ID, '$other', p('failed'))
    const answered: ApprovalState = { kind: 'answered', by: BOB as never, at: 1 as never, option: 'reject' }
    expect(pa.overlay(ROOM_ID, CARD_ID, answered)).toBe(answered)
    expect(pa.get(ROOM_ID, CARD_ID)).toBeUndefined()
    expect(pa.overlay(ROOM_ID, '$other', { kind: 'closed' })).toEqual({ kind: 'closed' })
    expect(pa.get(ROOM_ID, '$other')).toBeUndefined()
  })

  it('a late result of a cleared or replaced attempt does not write', () => {
    const pa = new PendingAnswers()
    const first = p('sending')
    pa.set(ROOM_ID, CARD_ID, first)
    pa.clear()
    expect(pa.update(ROOM_ID, CARD_ID, first, { status: 'failed' })).toBe(false)
    expect(pa.get(ROOM_ID, CARD_ID)).toBeUndefined()
  })
})
