import { describe, it, expect } from 'vitest'
import { EventStatus, MatrixEvent, ThreadEvent } from 'matrix-js-sdk'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import { eventToMessage, threadSummaryOf, type Ctx } from '@tayet/shared/internal'
import type { AclTelemetry, DomainEvent, Message } from '../src/acl'
import { findProtocolLeaks } from '@tayet/shared/leak-scan'

// ADR-066: Message.threadSummary derived in the ACL. Two sources (PLANO §8.27 §0 item 1):
//  - the server's aggregation bundled on the root — present on a root from /sync AND on the raw
//    event of a /messages page (`new MatrixEvent(raw)`), so a paginated root has its summary
//    without opening the thread;
//  - the SDK's Thread when the room has one — it stays live as replies arrive by sync.
// The live update rides message.edited of the root (no new DomainEvent). Nothing of the relation
// crosses: the summary is exactly { replyCount, latestReplyAt }.

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const ROOM_ID = '!room:tayet.local'
const ROOT_ID = '$root:tayet.local'
const ctx: Ctx = { mode: 'strict', telemetry: noopTelemetry, isDm: () => false, myUserId: '@me:tayet.local' }

// A root exactly as /messages returns it: the raw event with the bundled thread aggregation.
function rawRoot(bundled?: { count: number; latestTs: number }): MatrixEvent {
  return new MatrixEvent({
    type: 'm.room.message',
    event_id: ROOT_ID,
    room_id: ROOM_ID,
    sender: '@other:tayet.local',
    origin_server_ts: 1000,
    content: { msgtype: 'm.text', body: 'root' },
    unsigned: bundled
      ? {
          'm.relations': {
            'm.thread': {
              count: bundled.count,
              current_user_participated: false,
              latest_event: {
                type: 'm.room.message',
                event_id: '$latest:tayet.local',
                room_id: ROOM_ID,
                sender: '@third:tayet.local',
                origin_server_ts: bundled.latestTs,
                content: { msgtype: 'm.text', body: 'latest', 'm.relates_to': { rel_type: 'm.thread', event_id: ROOT_ID } },
              },
            },
          },
        }
      : {},
  })
}

function fakeThread(length: number, latestTs?: number, rootEvent?: MatrixEvent, room?: unknown) {
  return {
    id: ROOT_ID,
    length,
    replyToEvent: latestTs === undefined ? null : { getTs: () => latestTs },
    rootEvent,
    room,
  }
}

function expectClean(m: Message): void {
  expect(findProtocolLeaks(m)).toEqual([])
  if (m.threadSummary) {
    // Exactly the two product fields — no event id, no mxid, no relation vocabulary.
    expect(Object.keys(m.threadSummary).sort()).toEqual(['latestReplyAt', 'replyCount'])
    expect(typeof m.threadSummary.replyCount).toBe('number')
    expect(typeof m.threadSummary.latestReplyAt).toBe('number')
  }
  const json = JSON.stringify(m.threadSummary ?? {})
  expect(json).not.toMatch(/m\.thread|rel_type|\$latest|@third/)
}

describe('threadSummary — derivation (ADR-066 dec. 2)', () => {
  it('a paginated root (raw /messages event) carries the server aggregation, no thread opened', () => {
    const m = eventToMessage(rawRoot({ count: 2, latestTs: 5000 }), ctx)!
    expect(m.threadSummary).toEqual({ replyCount: 2, latestReplyAt: 5000 })
    expectClean(m)
  })

  it('no aggregation and no Thread → no summary (absent, not zero)', () => {
    const m = eventToMessage(rawRoot(), ctx)!
    expect(m.threadSummary).toBeUndefined()
    expect('threadSummary' in m && m.threadSummary !== undefined).toBe(false)
  })

  it("the SDK's Thread wins over the (stale) aggregation — it is the live source", () => {
    const thread = fakeThread(3, 9000)
    const live: Ctx = { ...ctx, threadFor: (id) => (id === ROOT_ID ? (thread as never) : undefined) }
    const m = eventToMessage(rawRoot({ count: 2, latestTs: 5000 }), live)!
    expect(m.threadSummary).toEqual({ replyCount: 3, latestReplyAt: 9000 })
    expectClean(m)
  })

  it('a Thread at zero (replies redacted) → no summary, even with a stale aggregation', () => {
    const live: Ctx = { ...ctx, threadFor: () => fakeThread(0) as never }
    expect(threadSummaryOf(rawRoot({ count: 2, latestTs: 5000 }), live)).toBeUndefined()
  })
})

// A thread reply as the SDK holds it in the thread's timeline; `status` set = a local echo still sending.
function threadReply(id: string, ts: number, status: EventStatus | null = null): MatrixEvent {
  const ev = new MatrixEvent({
    type: 'm.room.message',
    event_id: id,
    room_id: ROOM_ID,
    sender: '@me:tayet.local',
    origin_server_ts: ts,
    content: { msgtype: 'm.text', body: 'reply', 'm.relates_to': { rel_type: 'm.thread', event_id: ROOT_ID } },
  })
  ev.status = status
  return ev
}

// A Thread whose timeline this session holds: `complete` = its first page was fetched and nothing
// older is left to paginate (the whole thread is in hand); otherwise more replies live on the server.
function loadedThread(length: number, events: MatrixEvent[], complete: boolean, latestTs = 7000) {
  return {
    ...fakeThread(length, latestTs),
    events,
    initialEventsFetched: true,
    liveTimeline: { getPaginationToken: () => (complete ? null : 'older') },
  }
}

describe('threadSummary — count of a thread held whole (each reply once)', () => {
  const liveWith = (thread: unknown): Ctx => ({ ...ctx, threadFor: (id) => (id === ROOT_ID ? (thread as never) : undefined) })

  // Measured in the browser: the root's server aggregate (already counting the reply) lands before
  // the reply reaches the thread's timeline; the reply's arrival then counts it again.
  it('one confirmed reply counted by the aggregate and again on arrival → 1', () => {
    const thread = loadedThread(2, [rawRoot(), threadReply('$r1:tayet.local', 7000)], true)
    expect(threadSummaryOf(rawRoot({ count: 1, latestTs: 7000 }), liveWith(thread))).toEqual({ replyCount: 1, latestReplyAt: 7000 })
  })

  it('a pending own reply counts once', () => {
    const thread = loadedThread(2, [rawRoot(), threadReply('~local1', 7000, EventStatus.SENDING)], true)
    expect(threadSummaryOf(rawRoot(), liveWith(thread))?.replyCount).toBe(1)
  })

  it('two replies, one confirmed and one pending → 2', () => {
    const thread = loadedThread(3, [rawRoot(), threadReply('$r1:tayet.local', 6000), threadReply('~local2', 7000, EventStatus.SENT)], true)
    expect(threadSummaryOf(rawRoot(), liveWith(thread))?.replyCount).toBe(2)
  })

  it('more replies on the server than held → the SDK count (server aggregate) stands', () => {
    const thread = loadedThread(7, [threadReply('$r6:tayet.local', 6000), threadReply('$r7:tayet.local', 7000)], false)
    expect(threadSummaryOf(rawRoot({ count: 7, latestTs: 7000 }), liveWith(thread))?.replyCount).toBe(7)
  })

  it('a thread held whole with every reply redacted → no summary', () => {
    const redacted = new MatrixEvent({ type: 'm.room.message', event_id: '$r1:tayet.local', room_id: ROOM_ID, sender: '@me:tayet.local', origin_server_ts: 7000, content: {} })
    const thread = loadedThread(0, [rawRoot(), redacted], true)
    expect(threadSummaryOf(rawRoot({ count: 1, latestTs: 7000 }), liveWith(thread))).toBeUndefined()
  })
})

describe('threadSummary — live update via message.edited of the root (ADR-066 dec. 3)', () => {
  type Handler = (...args: unknown[]) => void

  function harness(root: MatrixEvent) {
    let thread = fakeThread(0)
    const roomHandlers = new Map<string, Handler[]>()
    const fakeRoom = {
      getMyMembership: () => 'join',
      // PLANO-AGENTES §0.3.11: the translator asks kindOf for every author; the gateway looks for the
      // organization channel by alias — this room is not it.
      getCanonicalAlias: () => null,
      roomId: ROOM_ID,
      findEventById: (id: string) => (id === ROOT_ID ? root : undefined),
      getThread: (id: string) => (id === ROOT_ID ? thread : undefined),
      getLiveTimeline: () => ({ getEvents: () => [root] }),
      relations: { getChildEventsForEvent: () => undefined },
      on: (name: string, h: Handler) => roomHandlers.set(name, [...(roomHandlers.get(name) ?? []), h]),
      off: () => {},
    }
    const fakeClient = {
      getRooms: () => [fakeRoom],
      getRoom: () => fakeRoom,
      getUserId: () => '@me:tayet.local',
      getAccountData: () => undefined,
      getCrypto: () => undefined,
      stopClient: () => {},
      on: () => {},
      off: () => {},
    }
    const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
    const g = gateway as unknown as { client: unknown; live: boolean; attachRoom(r: unknown): void }
    g.client = fakeClient
    g.live = true
    g.attachRoom(fakeRoom)
    const events: DomainEvent[] = []
    gateway.subscribe((e) => events.push(e))
    const fire = (name: string, length: number, latestTs: number, reply?: MatrixEvent): void => {
      thread = fakeThread(length, latestTs, root, fakeRoom)
      for (const h of roomHandlers.get(name) ?? []) h(thread, reply)
    }
    return { events, fire }
  }

  const rootEdits = (events: DomainEvent[]) =>
    events.filter((e): e is Extract<DomainEvent, { t: 'message.edited' }> => e.t === 'message.edited')

  it('a new reply re-emits the root with the new count; an unchanged Update does not', () => {
    const { events, fire } = harness(rawRoot())
    fire(ThreadEvent.Update, 1, 2000)
    fire(ThreadEvent.Update, 1, 2000) // same summary → deduped
    fire(ThreadEvent.Update, 2, 3000)

    const edits = rootEdits(events)
    expect(edits.map((e) => e.message.threadSummary)).toEqual([
      { replyCount: 1, latestReplyAt: 2000 },
      { replyCount: 2, latestReplyAt: 3000 },
    ])
    for (const e of edits) {
      expect(e.message.id).toBe(ROOT_ID) // the root's stable id — updated in place, never re-keyed
      expect(e.message.editedAt).toBeUndefined() // not an edit: no "(edited)"
      expect(e.message.threadParent).toBeUndefined()
      expectClean(e.message)
    }
  })

  it('a reply arriving through NewReply refreshes the root too', () => {
    const { events, fire } = harness(rawRoot())
    const reply = new MatrixEvent({
      type: 'm.room.message',
      event_id: '$reply:tayet.local',
      room_id: ROOM_ID,
      sender: '@other:tayet.local',
      origin_server_ts: 4000,
      content: { msgtype: 'm.text', body: 'reply', 'm.relates_to': { rel_type: 'm.thread', event_id: ROOT_ID } },
    })
    fire(ThreadEvent.NewReply, 1, 4000, reply)
    // The reply itself still surfaces (thread tail, threadParent set) — then the root refresh.
    expect(events.some((e) => e.t === 'message.received' && e.message.threadParent === ROOT_ID)).toBe(true)
    expect(rootEdits(events).map((e) => e.message.threadSummary)).toEqual([{ replyCount: 1, latestReplyAt: 4000 }])
  })
})
