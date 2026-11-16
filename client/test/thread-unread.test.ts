import { describe, it, expect } from 'vitest'
import { MatrixEvent, RoomEvent } from 'matrix-js-sdk'
import type { Room } from 'matrix-js-sdk'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import { threadUnreadOf, latestReplyFromAggregation, type LatestReply } from '../src/acl/internal/thread-unread'
import type { AclTelemetry } from '../src/acl'
import { findProtocolLeaks } from '@tayet/shared/leak-scan'

// ADR-067: per-thread unread is a boolean derived from the user's receipts, with one rule for
// encrypted and cleartext rooms (PLANO §8.28). It never reads the per-thread counts, and it never
// asks the SDK's Thread whether a reply was read: Thread.hasUserReadEvent / getEventReadUpTo treat
// every reply before the user's first threaded receipt in the room as read (oldestThreadedReceiptTs
// starts at Infinity), which is why the marker never rose in a DM.

const ME = '@me:tayet.local'
const OTHER = '@other:tayet.local'
const ROOT_ID = '$root:tayet.local'
const ROOM_ID = '!room:tayet.local'

type Cached = { eventId: string; receiptType: string; userId: string; receipt: { ts: number; thread_id?: string }; synthetic: boolean }

function reply(id: string, sender: string, ts: number) {
  return { getId: () => id, getSender: () => sender, getTs: () => ts }
}

function rootWithAggregation(latest?: { id: string; sender: string; ts: number }): MatrixEvent {
  return new MatrixEvent({
    type: 'm.room.message',
    event_id: ROOT_ID,
    room_id: ROOM_ID,
    sender: OTHER,
    origin_server_ts: 1000,
    content: { msgtype: 'm.text', body: 'root' },
    unsigned: latest
      ? {
          'm.relations': {
            'm.thread': {
              count: 1,
              current_user_participated: false,
              latest_event: { type: 'm.room.message', event_id: latest.id, room_id: ROOM_ID, sender: latest.sender, origin_server_ts: latest.ts, content: {} },
            },
          },
        }
      : {},
  })
}

// A Room as far as the rule reads it. The Thread, when present, ALSO answers the heuristic-laden
// questions (hasUserReadEvent / getEventReadUpTo) as the SDK does with no threaded receipt — "read" —
// so a rule that consulted them would fail these tests.
function fakeRoom(opts: {
  last?: ReturnType<typeof reply>
  threadRoot?: MatrixEvent
  thread?: boolean
  readByRoom?: string[]
  cached?: Cached[]
  unthreadedTs?: number
  rootInRoom?: MatrixEvent
}): Room {
  const thread =
    opts.thread === false
      ? null
      : opts.last || opts.threadRoot
        ? {
            lastReply: () => opts.last ?? null,
            rootEvent: opts.threadRoot,
            hasUserReadEvent: () => true,
            getEventReadUpTo: () => opts.last?.getId() ?? null,
          }
        : null
  return {
    getThread: (id: string) => (id === ROOT_ID ? thread : null),
    hasUserReadEvent: (_user: string, eventId: string) => (opts.readByRoom ?? []).includes(eventId),
    getOldestThreadedReceiptTs: () => Infinity,
    findEventById: (id: string) => (id === ROOT_ID ? opts.rootInRoom : undefined),
    cachedThreadReadReceipts: new Map(opts.cached ? [[ROOT_ID, opts.cached]] : []),
    getLastUnthreadedReceiptFor: () => (opts.unthreadedTs === undefined ? undefined : { ts: opts.unthreadedTs }),
  } as unknown as Room
}

const cached = (eventId: string, ts: number, userId = ME, receiptType = 'm.read'): Cached => ({
  eventId,
  receiptType,
  userId,
  receipt: { ts, thread_id: ROOT_ID },
  synthetic: false,
})

describe('threadUnreadOf — with the SDK Thread (ADR-067 dec. 2)', () => {
  it('REGRESSION: no threaded receipt at all → unread: true (the heuristic would say read)', () => {
    const room = fakeRoom({ last: reply('$r1', OTHER, 5000) })
    expect(room.getOldestThreadedReceiptTs()).toBe(Infinity)
    expect(threadUnreadOf(room, ROOT_ID, ME)).toEqual({ unread: true })
  })

  it("the room's receipts cover the latest reply → unread: false", () => {
    const room = fakeRoom({ last: reply('$r1', OTHER, 5000), readByRoom: ['$r1'] })
    expect(threadUnreadOf(room, ROOT_ID, ME)).toEqual({ unread: false })
  })

  it('the latest reply is mine → unread: false', () => {
    const room = fakeRoom({ last: reply('$r1', ME, 5000) })
    expect(threadUnreadOf(room, ROOT_ID, ME)).toEqual({ unread: false })
  })

  it('a Thread whose replies are not loaded yet falls back to the aggregation on its root', () => {
    const threadRoot = rootWithAggregation({ id: '$agg', sender: OTHER, ts: 7000 })
    expect(threadUnreadOf(fakeRoom({ threadRoot }), ROOT_ID, ME)).toEqual({ unread: true })
    expect(threadUnreadOf(fakeRoom({ threadRoot, unthreadedTs: 7000 }), ROOT_ID, ME)).toEqual({ unread: false })
  })
})

describe('threadUnreadOf — without a Thread (paginated root)', () => {
  const paged: LatestReply = { id: '$latest', sender: OTHER, ts: 6000 }

  it('no receipt → unread: true', () => {
    expect(threadUnreadOf(fakeRoom({ thread: false }), ROOT_ID, ME, paged)).toEqual({ unread: true })
  })

  it('my threaded receipt points at the latest reply → unread: false', () => {
    const room = fakeRoom({ thread: false, cached: [cached('$latest', 1)] })
    expect(threadUnreadOf(room, ROOT_ID, ME, paged)).toEqual({ unread: false })
  })

  it('my threaded receipt on an earlier reply: covered only at or after the latest timestamp', () => {
    expect(threadUnreadOf(fakeRoom({ thread: false, cached: [cached('$older', 5999)] }), ROOT_ID, ME, paged)).toEqual({ unread: true })
    expect(threadUnreadOf(fakeRoom({ thread: false, cached: [cached('$older', 6000)] }), ROOT_ID, ME, paged)).toEqual({ unread: false })
  })

  it('a private read receipt counts; another user’s receipt and other receipt types do not', () => {
    expect(threadUnreadOf(fakeRoom({ thread: false, cached: [cached('$latest', 1, ME, 'm.read.private')] }), ROOT_ID, ME, paged)).toEqual({ unread: false })
    expect(threadUnreadOf(fakeRoom({ thread: false, cached: [cached('$latest', 9999, OTHER)] }), ROOT_ID, ME, paged)).toEqual({ unread: true })
    expect(threadUnreadOf(fakeRoom({ thread: false, cached: [cached('$latest', 9999, ME, 'm.fully_read')] }), ROOT_ID, ME, paged)).toEqual({ unread: true })
  })

  it('my unthreaded receipt at or after the latest timestamp covers it', () => {
    expect(threadUnreadOf(fakeRoom({ thread: false, unthreadedTs: 5999 }), ROOT_ID, ME, paged)).toEqual({ unread: true })
    expect(threadUnreadOf(fakeRoom({ thread: false, unthreadedTs: 6000 }), ROOT_ID, ME, paged)).toEqual({ unread: false })
  })

  it('the latest reply is mine → unread: false', () => {
    expect(threadUnreadOf(fakeRoom({ thread: false }), ROOT_ID, ME, { ...paged, sender: ME })).toEqual({ unread: false })
  })

  it('the aggregation on a root the room holds wins over the page registry', () => {
    const rootInRoom = rootWithAggregation({ id: '$agg', sender: ME, ts: 8000 })
    expect(threadUnreadOf(fakeRoom({ thread: false, rootInRoom }), ROOT_ID, ME, paged)).toEqual({ unread: false })
  })

  it('no reply anywhere → unread: false', () => {
    expect(threadUnreadOf(fakeRoom({ thread: false }), ROOT_ID, ME)).toEqual({ unread: false })
  })
})

describe('latestReplyFromAggregation', () => {
  it('reads latest_event of the bundled m.thread relation; absent or malformed → undefined', () => {
    expect(latestReplyFromAggregation(rootWithAggregation({ id: '$l', sender: OTHER, ts: 42 }))).toEqual({ id: '$l', sender: OTHER, ts: 42 })
    expect(latestReplyFromAggregation(rootWithAggregation())).toBeUndefined()
    expect(latestReplyFromAggregation(undefined)).toBeUndefined()
  })
})

describe('ThreadUnread shape (P1)', () => {
  it('exactly { unread: boolean } — no id, no count, no protocol vocabulary', () => {
    const r = threadUnreadOf(fakeRoom({ last: reply('$r1', OTHER, 5000) }), ROOT_ID, ME)
    expect(Object.keys(r)).toEqual(['unread'])
    expect(typeof r.unread).toBe('boolean')
    expect(findProtocolLeaks(r)).toEqual([])
  })
})

describe('receipt of mine → channel.changed (ADR-067 dec. 3)', () => {
  type Handler = (...args: unknown[]) => void
  const noopTelemetry: AclTelemetry = { untranslated: () => {} }

  function harness() {
    const roomHandlers = new Map<string, Handler[]>()
    const fakeRoom = {
      roomId: ROOM_ID,
      on: (name: string, h: Handler) => roomHandlers.set(name, [...(roomHandlers.get(name) ?? []), h]),
      off: () => {},
    }
    const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
    const g = gateway as unknown as {
      client: unknown
      attachRoom(r: unknown): void
      emitChannelChanged(r: unknown): void
    }
    g.client = { getUserId: () => ME }
    const changed: unknown[] = []
    g.emitChannelChanged = (r: unknown) => changed.push(r)
    g.attachRoom(fakeRoom)
    const receipt = (users: string[]) =>
      new MatrixEvent({
        type: 'm.receipt',
        room_id: ROOM_ID,
        content: { $r1: { 'm.read': Object.fromEntries(users.map((u) => [u, { ts: 1, thread_id: ROOT_ID }])) } },
      })
    const fire = (users: string[]) => {
      for (const h of roomHandlers.get(RoomEvent.Receipt) ?? []) h(receipt(users), fakeRoom)
    }
    return { changed, fire, fakeRoom }
  }

  it('a receipt carrying my user emits channel.changed for that room', () => {
    const { changed, fire, fakeRoom } = harness()
    fire([ME])
    expect(changed).toEqual([fakeRoom])
  })

  it("another user's receipt does not", () => {
    const { changed, fire } = harness()
    fire([OTHER])
    expect(changed).toEqual([])
  })
})
