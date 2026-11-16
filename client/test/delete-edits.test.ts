import { describe, it, expect, vi, afterEach } from 'vitest'
import { MatrixError, MatrixEvent, RoomEvent, type IEvent } from 'matrix-js-sdk'
import { EDIT_REDACTION_FIELD } from '@tayet/shared/internal'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import type { AclTelemetry, DomainEvent, MessageId } from '../src/acl'

// ADR-075 addendum: deleting a message also redacts one's own edits. Order: list the edits on the server, redact the
// message, emit message.removed, redact each edit with EDIT_REDACTION_FIELD in the content (rate limit waited out up to
// 60 s per call). onRedaction emits nothing for a redaction carrying the field. No stack: the gateway gets a fake client.

type Handler = (...args: unknown[]) => void
const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const ROOM_ID = '!room:tayet.local'
const ME = '@me:tayet.local'
const OTHER = '@other:tayet.local'
const MSG = '$msg:tayet.local'
const MESSAGE_ID = MSG as unknown as MessageId

const edit = (id: string, sender = ME, redacted = false): Partial<IEvent> => ({
  event_id: id,
  sender,
  type: 'm.room.encrypted',
  content: { 'm.relates_to': { rel_type: 'm.replace', event_id: MSG } },
  ...(redacted && { unsigned: { redacted_because: { type: 'm.room.redaction' } } as IEvent['unsigned'] }),
})

const rateLimited = (ms: number): MatrixError =>
  new MatrixError({ errcode: 'M_LIMIT_EXCEEDED', error: 'Too Many Requests', retry_after_ms: ms }, 429)

function harness(pages: Partial<IEvent>[][]) {
  const calls: string[] = []
  const room = {
    roomId: ROOM_ID,
    getCanonicalAlias: () => null,
    getMyMembership: () => 'join',
    findEventById: (id: string) => (id === MSG ? { getId: () => MSG, getType: () => 'm.room.message' } : undefined),
    getThread: () => undefined,
    getLiveTimeline: () => ({ getEvents: () => [], getPaginationToken: () => null }),
    relations: { getChildEventsForEvent: () => undefined },
    hasEncryptionStateEvent: () => false,
    currentState: { getStateEvents: () => undefined },
    getMember: () => null,
  }
  const handlers = new Map<string, Handler[]>()
  const fetchRelations = vi.fn(async (_room: string, _event: string, _rel: string, _type: null, opts: { from?: string }) => {
    const index = opts.from === undefined ? 0 : Number(opts.from)
    calls.push(`list:${index}`)
    return { chunk: pages[index] ?? [], ...(index + 1 < pages.length && { next_batch: String(index + 1) }) }
  })
  const redactEvent = vi.fn(async (_room: string, eventId: string) => {
    calls.push(`redact:${eventId}`)
    return { event_id: '$r' }
  })
  const bodies: unknown[] = []
  const authedRequest = vi.fn(async (_method: string, path: string, _query: unknown, body: unknown) => {
    calls.push(`put:${decodeURIComponent(path.split('/')[4] ?? '')}`)
    bodies.push(body)
    return { event_id: '$r' }
  })
  let txn = 0
  const client = {
    getRooms: () => [room],
    getRoom: (id: string) => (id === ROOM_ID ? room : null),
    getCrypto: () => ({}),
    getUserId: () => ME,
    getAccountData: () => undefined,
    fetchRelations,
    redactEvent,
    makeTxnId: () => `txn${txn++}`,
    http: { authedRequest },
    on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
    off: () => {},
  }
  const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
  const g = gateway as unknown as { client: unknown; live: boolean; wireEvents(c: unknown): void }
  g.client = client
  g.wireEvents(client)
  g.live = true
  const events: DomainEvent[] = []
  gateway.subscribe((e) => {
    events.push(e)
    if (e.t === 'message.removed') calls.push('emit')
  })
  const fire = (name: string, ...args: unknown[]): void => {
    for (const h of handlers.get(name) ?? []) h(...args)
  }
  const redaction = (target: string, content: Record<string, unknown> = {}): void =>
    fire(
      RoomEvent.Redaction as string,
      new MatrixEvent({ type: 'm.room.redaction', redacts: target, content, room_id: ROOM_ID, sender: ME, event_id: `$red-${target}` }),
      room,
    )
  return { gateway, calls, bodies, events, fetchRelations, redactEvent, authedRequest, redaction }
}

const removed = (events: DomainEvent[]) => events.filter((e) => e.t === 'message.removed')

afterEach(() => {
  vi.useRealTimers()
})

describe('deleteMessage redacts one’s own edits (ADR-075 addendum)', () => {
  it('lists, redacts the message, emits, then redacts each edit — the field only on the edits', async () => {
    const h = harness([[edit('$e1'), edit('$e2')]])
    await h.gateway.deleteMessage(MESSAGE_ID)
    expect(h.calls).toEqual(['list:0', `redact:${MSG}`, 'emit', 'put:$e1', 'put:$e2'])
    expect(h.redactEvent).toHaveBeenCalledWith(ROOM_ID, MSG)
    expect(h.bodies).toEqual([{ [EDIT_REDACTION_FIELD]: true }, { [EDIT_REDACTION_FIELD]: true }])
    expect(removed(h.events)).toEqual([{ t: 'message.removed', channelId: ROOM_ID, messageId: MESSAGE_ID }])
    // Each edit's redaction under its own transaction id.
    const txns = h.authedRequest.mock.calls.map(([, path]) => path.split('/').pop())
    expect(new Set(txns).size).toBe(2)
  })

  it('leaves out another person’s edit and an already redacted one', async () => {
    const h = harness([[edit('$e1'), edit('$theirs', OTHER), edit('$gone', ME, true), edit('$e2')]])
    await h.gateway.deleteMessage(MESSAGE_ID)
    expect(h.calls).toEqual(['list:0', `redact:${MSG}`, 'emit', 'put:$e1', 'put:$e2'])
  })

  it('follows the listing across pages', async () => {
    const h = harness([[edit('$e1')], [edit('$e2')]])
    await h.gateway.deleteMessage(MESSAGE_ID)
    expect(h.calls).toEqual(['list:0', 'list:1', `redact:${MSG}`, 'emit', 'put:$e1', 'put:$e2'])
    expect(h.fetchRelations.mock.calls[1]?.[4]).toMatchObject({ from: '1' })
  })

  it('a message without edits keeps today’s behaviour', async () => {
    const h = harness([[]])
    await h.gateway.deleteMessage(MESSAGE_ID)
    expect(h.calls).toEqual(['list:0', `redact:${MSG}`, 'emit'])
    expect(h.authedRequest).not.toHaveBeenCalled()
  })

  it('a failing listing rejects with nothing redacted and nothing emitted', async () => {
    const h = harness([[edit('$e1')]])
    h.fetchRelations.mockRejectedValueOnce(new Error('listing failed'))
    await expect(h.gateway.deleteMessage(MESSAGE_ID)).rejects.toThrow('listing failed')
    expect(h.redactEvent).not.toHaveBeenCalled()
    expect(h.authedRequest).not.toHaveBeenCalled()
    expect(removed(h.events)).toEqual([])
  })

  it('a failing redaction of the message rejects with nothing emitted and no edit touched', async () => {
    const h = harness([[edit('$e1')]])
    h.redactEvent.mockRejectedValueOnce(new Error('redaction failed'))
    await expect(h.gateway.deleteMessage(MESSAGE_ID)).rejects.toThrow('redaction failed')
    expect(h.authedRequest).not.toHaveBeenCalled()
    expect(removed(h.events)).toEqual([])
  })

  it('a failing redaction of an edit rejects after the one emit; the remaining edits stay', async () => {
    const h = harness([[edit('$e1'), edit('$e2'), edit('$e3')]])
    h.authedRequest.mockImplementationOnce(async () => ({ event_id: '$r' })).mockRejectedValueOnce(new Error('edit failed'))
    await expect(h.gateway.deleteMessage(MESSAGE_ID)).rejects.toThrow('edit failed')
    expect(removed(h.events)).toHaveLength(1)
    expect(h.authedRequest).toHaveBeenCalledTimes(2)
  })

  it('M_LIMIT_EXCEEDED on an edit waits the time the server gave and repeats', async () => {
    vi.useFakeTimers()
    const h = harness([[edit('$e1'), edit('$e2')]])
    h.authedRequest.mockRejectedValueOnce(rateLimited(5_000))
    const done = h.gateway.deleteMessage(MESSAGE_ID)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(h.authedRequest).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await done
    expect(h.authedRequest).toHaveBeenCalledTimes(3)
    const paths = h.authedRequest.mock.calls.map(([, path]) => path)
    expect(paths[1]).toBe(paths[0]) // the repeat reuses the transaction id
    expect(removed(h.events)).toHaveLength(1)
  })

  it('past 60 s of summed waiting the verb rejects', async () => {
    vi.useFakeTimers()
    const h = harness([[edit('$e1'), edit('$e2')]])
    h.authedRequest
      .mockRejectedValueOnce(rateLimited(25_000))
      .mockImplementationOnce(async () => ({ event_id: '$r' }))
      .mockRejectedValueOnce(rateLimited(25_000))
      .mockRejectedValueOnce(rateLimited(25_000))
    const done = h.gateway.deleteMessage(MESSAGE_ID)
    const outcome = expect(done).rejects.toMatchObject({ errcode: 'M_LIMIT_EXCEEDED' })
    await vi.advanceTimersByTimeAsync(50_000)
    await outcome
    expect(h.authedRequest).toHaveBeenCalledTimes(4)
    expect(removed(h.events)).toHaveLength(1)
  })

  it('a zero wait repeated forever still waits at least 250 ms per repeat and rejects at the cap', async () => {
    vi.useFakeTimers()
    const start = Date.now()
    const h = harness([[edit('$e1')]])
    h.authedRequest.mockRejectedValue(rateLimited(0))
    let rejectedAt = Number.NaN
    const done = h.gateway.deleteMessage(MESSAGE_ID)
    done.catch(() => (rejectedAt = Date.now()))
    const outcome = expect(done).rejects.toMatchObject({ errcode: 'M_LIMIT_EXCEEDED' })
    await vi.advanceTimersByTimeAsync(249)
    expect(h.authedRequest).toHaveBeenCalledTimes(1) // no repeat before the minimum wait
    await vi.advanceTimersByTimeAsync(60_000)
    await outcome
    // 60 s / 250 ms = 240 waits, so 241 attempts; the summed wait never passes the cap.
    expect(h.authedRequest).toHaveBeenCalledTimes(241)
    expect(rejectedAt - start).toBe(60_000)
    expect(removed(h.events)).toHaveLength(1)
  })
})

describe('onRedaction and the edit-redaction field (ADR-075 addendum)', () => {
  it('a redaction carrying the field emits nothing', () => {
    const h = harness([])
    h.redaction('$e1', { [EDIT_REDACTION_FIELD]: true })
    expect(h.events).toEqual([])
  })

  it('a redaction without the field still removes the message', () => {
    const h = harness([])
    h.redaction(MSG)
    expect(removed(h.events)).toEqual([{ t: 'message.removed', channelId: ROOM_ID, messageId: MSG }])
  })
})
