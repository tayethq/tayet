import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createAcl } from '../../src/acl'
import type { Acl, AclTelemetry, DomainEvent, ChannelId, MessageId } from '../../src/acl'
import { findProtocolLeaks } from '@tayet/shared/leak-scan'
import {
  HOMESERVER,
  synapseReachable,
  whoami,
  createRoom,
  invite,
  join,
  sendText,
  sendThreadReply,
  getRelations,
  getEvent,
} from '../support/synapse'
import { freshUsers } from '../support/fresh-users'

// P1 gate #1 for threads (PLANO-FASE-1-THREADS §5): drive real thread relations and assert the
// domain stream/getters emit clean branded events — including message.received for thread replies
// (threadParent populated) and thread scrollback — with NO protocol relation (m.thread/rel_type)
// crossing the barrel. The leak scanner skips the opaque threadParent id (ADR-008 residual) but
// would catch a leaked relation envelope.

const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }

async function until<T>(get: () => T | undefined, timeoutMs = 150_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = get()
    if (v !== undefined) return v
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 50))
  }
}

async function asyncUntil<T>(get: () => Promise<T | undefined>, timeoutMs = 150_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await get()
    if (v !== undefined) return v
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 120))
  }
}

describe.skipIf(!SYNAPSE)('ACL thread stream + scrollback (integration)', () => {
  let acl: Acl
  let token: string
  const events: DomainEvent[] = []

  beforeAll(async () => {
    const [user] = await freshUsers(['tha'])
    token = user.token
    acl = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await acl.connect(token as Parameters<Acl['connect']>[0])
    acl.subscribe((e) => events.push(e))
  }, 180_000)

  afterAll(async () => {
    await acl?.disconnect()
  })

  it('emits message.received for a thread reply with threadParent populated (clean)', async () => {
    const name = `tayet-thread-${process.pid}-${Math.floor(Math.random() * 1e6)}`
    const roomId = await createRoom(token, { name })

    // The room becomes known via sync.
    const channelId = await until<ChannelId>(() => {
      const ev = events.find(
        (e): e is Extract<DomainEvent, { t: 'channel.changed' }> =>
          e.t === 'channel.changed' && e.channel.name === `#${name}`,
      )
      return ev?.channel.id
    })

    // Root message on the MAIN timeline (no threadParent). Match is scoped to THIS run's channel:
    // a per-run fresh user starts with zero prior rooms, so this scope is exact by construction
    // (no stale room with the same text can exist across runs).
    const rootEventId = await sendText(token, roomId, 'thread root')
    const root = await until(() =>
      events.find(
        (e) =>
          e.t === 'message.received' &&
          e.channelId === channelId &&
          e.message.body.kind === 'text' &&
          e.message.body.text === 'thread root',
      ),
    )
    expect(root.t).toBe('message.received')
    if (root.t === 'message.received') {
      expect(root.message.threadParent).toBeUndefined() // root lives on the main timeline
      expect(findProtocolLeaks(root.message)).toEqual([])
    }

    // A reply with an m.thread relation → must surface via the thread stream with threadParent.
    await sendThreadReply(token, roomId, rootEventId, 'thread reply one')
    const reply = await until(() =>
      events.find(
        (e) =>
          e.t === 'message.received' &&
          e.channelId === channelId &&
          e.message.body.kind === 'text' &&
          e.message.body.text === 'thread reply one',
      ),
    )
    expect(reply.t).toBe('message.received')
    if (reply.t === 'message.received') {
      expect(reply.channelId).toBe(channelId)
      // threadParent is the stable id of the root (== root event id for a received message).
      expect(reply.message.threadParent).toBe(root.t === 'message.received' ? root.message.id : undefined)
      // No protocol relation (m.thread / rel_type) leaked into the domain object.
      expect(findProtocolLeaks(reply.message)).toEqual([])
    }
  }, 180_000)

  it('sends into a thread via SendOpts and scrolls the thread back (clean)', async () => {
    const name = `tayet-thread2-${process.pid}-${Math.floor(Math.random() * 1e6)}`
    const roomId = await createRoom(token, { name })
    const channelId = await until<ChannelId>(() => {
      const ev = events.find(
        (e): e is Extract<DomainEvent, { t: 'channel.changed' }> =>
          e.t === 'channel.changed' && e.channel.name === `#${name}`,
      )
      return ev?.channel.id
    })

    const rootEventId = await sendText(token, roomId, 'root for send')
    const rootMessageId = rootEventId as unknown as MessageId

    // Our OWN threaded send through the barrel (ADR-011). The relation is translated inside the
    // ACL; we pass only the stable root MessageId.
    await acl.sendMessage(channelId, { kind: 'text', text: 'my threaded reply' }, { thread: rootMessageId })

    const reply = await until(() =>
      events.find(
        (e) =>
          e.t === 'message.received' &&
          e.channelId === channelId &&
          e.message.body.kind === 'text' &&
          e.message.body.text === 'my threaded reply',
      ),
    )
    if (reply.t === 'message.received') {
      expect(reply.message.threadParent).toBe(rootMessageId)
      expect(findProtocolLeaks(reply.message)).toEqual([])
    }

    // Scrollback: getTimeline({thread}) returns the thread's replies (clean, threadParent set).
    // Poll the relations backfill until it reflects the reply (server-side propagation delay).
    let page = await acl.getTimeline(channelId, { thread: rootMessageId })
    const start = Date.now()
    while (
      !page.items.some((m) => m.body.kind === 'text' && m.body.text === 'my threaded reply') &&
      Date.now() - start < 60_000
    ) {
      await new Promise((r) => setTimeout(r, 500))
      page = await acl.getTimeline(channelId, { thread: rootMessageId })
    }
    expect(page.items.length).toBeGreaterThan(0)
    for (const m of page.items) {
      expect(m.threadParent).toBe(rootMessageId)
      expect(findProtocolLeaks(m)).toEqual([])
    }

    // Fail-closed guard (PLANO-FASE-1-THREADS §9): read the ACTUAL sent event back from the server
    // and assert a CLEAN m.thread relation — EXACTLY { rel_type, event_id }, with NO is_falling_back
    // and NO m.in_reply_to. The rich-reply fallback is DEFERRED (ADR-011); the ACL builds the
    // relation manually so the SDK's addThreadRelationIfNeeded stays a no-op (rel_type present). This
    // assertion turns red if a future matrix-js-sdk bump reintroduces the fallback on this path.
    const children = await getRelations(token, roomId, rootEventId, 'm.thread')
    const sent = children.find((e) => (e.content as { body?: string }).body === 'my threaded reply')
    expect(sent, 'sent thread reply not found among m.thread relations').toBeTruthy()
    expect(sent!.content['m.relates_to']).toEqual({ rel_type: 'm.thread', event_id: rootEventId })
  }, 180_000)
})

describe.skipIf(!SYNAPSE)('ACL per-thread unread + markRead (integration)', () => {
  let acl: Acl
  let aliceToken: string
  let bobToken: string
  let bobId: string

  beforeAll(async () => {
    const [alice, bob] = await freshUsers(['t2a', 't2b'])
    aliceToken = alice.token
    bobToken = bob.token
    bobId = await whoami(bobToken)
    acl = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await acl.connect(aliceToken as Parameters<Acl['connect']>[0])
  }, 180_000)

  afterAll(async () => {
    await acl?.disconnect()
  })

  it('per-thread unread (ADR-067) is set by an unread reply; markRead on the thread clears it (channel inclusive)', async () => {
    const name = `tayet-thread-unread-${process.pid}-${Math.floor(Math.random() * 1e6)}`
    const roomId = await createRoom(aliceToken, { name })
    await invite(aliceToken, roomId, bobId)
    await join(bobToken, roomId)

    const rootEventId = await sendText(aliceToken, roomId, 'root for unread')
    const rootMessageId = rootEventId as unknown as MessageId
    // A thread reply from bob that alice has NOT read → alice's per-thread unread climbs.
    const replyEventId = await sendThreadReply(bobToken, roomId, rootEventId, 'unread thread reply')
    const replyMessageId = replyEventId as unknown as MessageId

    // The channel must be known to alice's sync first.
    const channelId = await asyncUntil(async () => {
      const ch = (await acl.getChannels()).find((c) => c.name === `#${name}`)
      return ch?.id
    })

    // Per-thread unread (ADR-067): derived from receipts, alice has none covering bob's reply.
    const unread = await asyncUntil(async () => {
      const u = await acl.getThreadUnread(channelId, rootMessageId)
      return u.unread ? u : undefined
    })
    expect(unread).toEqual({ unread: true })
    // Cleartext room: the channel count stays INCLUSIVE — it also reflects the thread activity.
    const chBefore = await acl.getChannel(channelId)
    expect(chBefore.unread.count).toBeGreaterThanOrEqual(1)

    // markRead with a thread reply's MessageId sends a THREADED receipt → clears the thread.
    await acl.markRead(channelId, replyMessageId)
    const cleared = await asyncUntil(async () => {
      const u = await acl.getThreadUnread(channelId, rootMessageId)
      return u.unread ? undefined : u
    })
    expect(cleared).toEqual({ unread: false })
  }, 180_000)
})

describe('ACL thread stream (availability)', () => {
  it(SYNAPSE ? 'stack reachable' : 'stack down — skipped', () => {
    expect(typeof SYNAPSE).toBe('boolean')
  })
})

// ADR-066 (PLANO-RELEASE-PUBLICA §8.27 §0 item 1): Message.threadSummary on the ROOT, from both
// sources against the real Synapse + SDK 41.6.0:
//  (a) a root loaded by PAGINATION (raw /messages page, outside the initial sync window), without
//      opening the thread → the server's bundled aggregation;
//  (b) a new reply arriving by SYNC → the SDK's Thread → message.edited of the root, count bumped.
// Both for a root the SDK holds (live window) and for the paginated root it does not.
describe.skipIf(!SYNAPSE)('ACL thread summary on the root (integration, ADR-066)', () => {
  let acl: Acl
  let aToken: string
  let bToken: string
  let cToken: string
  const events: DomainEvent[] = []

  const rootEdit = (rootId: string, replyCount: number) =>
    until(() =>
      events.find(
        (e) =>
          e.t === 'message.edited' &&
          (e.message.id as unknown as string) === rootId &&
          e.message.threadSummary?.replyCount === replyCount,
      ),
    )

  function expectCleanSummary(m: { threadSummary?: unknown }): void {
    expect(findProtocolLeaks(m)).toEqual([])
    expect(Object.keys(m.threadSummary as object).sort()).toEqual(['latestReplyAt', 'replyCount'])
    expect(JSON.stringify(m.threadSummary)).not.toMatch(/m\.thread|rel_type|\$|@/)
  }

  beforeAll(async () => {
    const [a, b, c] = await freshUsers(['tsa', 'tsb', 'tsc'])
    aToken = a.token
    bToken = b.token
    cToken = c.token
  }, 180_000)

  afterAll(async () => {
    await acl?.disconnect()
  })

  it('a paginated root carries its summary without opening the thread; a reply by sync bumps it', async () => {
    const name = `tayet-thread-summary-${process.pid}-${Math.floor(Math.random() * 1e6)}`
    const roomId = await createRoom(aToken, { name })
    const [bId, cId] = [await whoami(bToken), await whoami(cToken)]
    await invite(aToken, roomId, bId)
    await invite(aToken, roomId, cId)
    await join(bToken, roomId)
    await join(cToken, roomId)

    // The root, two replies by b, then enough main-timeline traffic (split across three senders so
    // no one drains the rc_message bucket) to push the root out of the initial sync window (30).
    const rootId = await sendText(aToken, roomId, 'paginated root')
    await sendThreadReply(bToken, roomId, rootId, 'reply one')
    const lastReplyId = await sendThreadReply(bToken, roomId, rootId, 'reply two')
    const lastReplyTs = (await getEvent(bToken, roomId, lastReplyId)).origin_server_ts
    for (let i = 0; i < 12; i++) {
      await Promise.all([
        sendText(aToken, roomId, `filler a${i}`),
        sendText(bToken, roomId, `filler b${i}`),
        sendText(cToken, roomId, `filler c${i}`),
      ])
    }

    // A client that connects AFTER all of it: the root is not in its initial window.
    acl = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await acl.connect(aToken as Parameters<Acl['connect']>[0])
    acl.subscribe((e) => events.push(e))
    const channelId = await asyncUntil(async () => (await acl.getChannels()).find((c) => c.name === `#${name}`)?.id)

    let page = await acl.getTimeline(channelId)
    expect(page.items.some((m) => m.body.kind === 'text' && m.body.text === 'paginated root')).toBe(false)
    let root = undefined as (typeof page.items)[number] | undefined
    for (let n = 0; n < 5 && !root && page.nextCursor; n++) {
      page = await acl.getTimeline(channelId, { cursor: page.nextCursor })
      root = page.items.find((m) => m.body.kind === 'text' && m.body.text === 'paginated root')
    }
    expect(root, 'root not reached by pagination').toBeTruthy()
    expect(root!.threadSummary).toEqual({ replyCount: 2, latestReplyAt: lastReplyTs })
    expectCleanSummary(root!)

    // (b) on the paginated root: c replies → the SDK builds the Thread (fetching the root it never
    // held) → message.edited of the root with 3.
    await sendThreadReply(cToken, roomId, rootId, 'reply three')
    const bumped = await rootEdit(rootId, 3)
    if (bumped.t === 'message.edited') {
      expect(bumped.message.editedAt).toBeUndefined()
      expect(bumped.message.body).toEqual({ kind: 'text', text: 'paginated root' })
      expectCleanSummary(bumped.message)
    }

    // (b) on a root in the live window: first reply → 1, second → 2.
    const liveRootId = await sendText(aToken, roomId, 'live root')
    await until(() =>
      events.find((e) => e.t === 'message.received' && (e.message.id as unknown as string) === liveRootId),
    )
    await sendThreadReply(bToken, roomId, liveRootId, 'live reply one')
    const one = await rootEdit(liveRootId, 1)
    if (one.t === 'message.edited') expectCleanSummary(one.message)
    await sendThreadReply(cToken, roomId, liveRootId, 'live reply two')
    const two = await rootEdit(liveRootId, 2)
    if (two.t === 'message.edited') expectCleanSummary(two.message)

    // The initial page now carries the live root with its live count (the Thread is the source).
    const fresh = await acl.getTimeline(channelId)
    const liveRoot = fresh.items.find((m) => (m.id as unknown as string) === liveRootId)
    expect(liveRoot?.threadSummary?.replyCount).toBe(2)
  }, 300_000)
})
