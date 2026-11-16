import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { MatrixGateway } from '../../src/acl/internal/matrix-client'
import type { Acl, AclTelemetry, ChannelId, DomainEvent, Message, MessageId, UserId } from '../../src/acl'
import { HOMESERVER, synapseReachable, whoami, mintToken, sendText } from '../support/synapse'
import { adminScopeReachable, mintAdminToken, liftMessageRatelimit, killSessions, PROBE_USER } from '../support/synapse-admin'
import { freshUsers } from '../support/fresh-users'
import { until } from '../support/until'

// ADR-067 against the stack: per-thread unread is a boolean derived from the user's receipts, and it
// behaves THE SAME in an encrypted DM and in a cleartext public channel (PLANO §8.28). Before it, the
// SDK's per-thread count stayed 0 in an encrypted room for a user with no threaded receipt there
// (Thread.hasUserReadEvent → beforeFirstThreadedReceipt), so the marker never rose in a DM.
// Each kind runs the same steps:
//  1. a reply with NO prior threaded receipt of the reader → unread (the regression);
//  2. markRead on the thread → not unread;
//  3. a new reply, then a threaded receipt from the reader's OTHER device (REST) → not unread by
//     sync, and a channel.changed wakes the UI while the verb already reads the new receipt (dec. 3);
//  4. a root pushed out of a reloaded session's initial window: the aggregation path, unread for an
//     unread thread and not for one read on the other device — with no request for those roots.

const SYNAPSE = synapseReachable()
const ADMIN = SYNAPSE && adminScopeReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const KINDS = ['dm', 'public'] as const

async function withRetry<T>(fn: () => Promise<T>, attempts = 20): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      const retryAfter = (err as { data?: { retry_after_ms?: number } }).data?.retry_after_ms
      if (retryAfter === undefined || attempt >= attempts) throw err
      await new Promise((r) => setTimeout(r, retryAfter + 200))
    }
  }
}

// A read receipt sent by ANOTHER device of the reader (another browser), straight to the server.
async function threadedReceipt(token: string, roomId: string, eventId: string, rootId: string): Promise<void> {
  const res = await fetch(
    `${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/receipt/m.read/${encodeURIComponent(eventId)}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ thread_id: rootId }),
    },
  )
  if (!res.ok) throw new Error(`receipt -> ${res.status} ${await res.text()}`)
}

// Request ledger (paths only): proves the paginated roots cost no request of their own.
const requested: string[] = []
const realFetch = globalThis.fetch

describe.skipIf(!SYNAPSE)('ACL per-thread unread from receipts — DM × public channel (ADR-067)', () => {
  let A: MatrixGateway
  let B: MatrixGateway
  let aId: string
  let aToken: string
  let bId: UserId
  let bName: string
  let b2Token: string
  const bEvents: DomainEvent[] = []

  beforeAll(async () => {
    const [a, b] = await freshUsers(['tua', 'tub'])
    aId = await whoami(a.token)
    aToken = a.token
    bId = (await whoami(b.token)) as unknown as UserId
    bName = b.name
    A = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await A.connect(a.token as Parameters<Acl['connect']>[0])
    B = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await B.connect(b.token as Parameters<Acl['connect']>[0])
    B.subscribe((e) => bEvents.push(e))
    // The reader's other device: only ever sends receipts.
    b2Token = await mintToken(bName)
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      requested.push(decodeURIComponent(new URL(url).pathname))
      return realFetch(input as RequestInfo, init)
    }) as typeof fetch
  }, 240_000)

  afterAll(async () => {
    globalThis.fetch = realFetch
    await A?.disconnect()
    await B?.disconnect()
  })

  const channels = new Map<string, ChannelId>()

  async function channelFor(kind: (typeof KINDS)[number]): Promise<ChannelId> {
    const known = channels.get(kind)
    if (known) return known
    const id =
      kind === 'dm'
        ? await withRetry(() => A.openDirectMessage(bId))
        : await withRetry(() => A.createChannel({ name: `tu-pub-${process.pid}-${Date.now()}`, kind: 'public', members: [bId] }))
    // ADR-044: B auto-joins; wait until B knows the channel and A can send to it.
    await until(`B knows the ${kind} channel`, async () => ((await B.getChannels()).some((c) => c.id === id) ? true : undefined))
    channels.set(kind, id)
    return id
  }

  async function aSends(ch: ChannelId, text: string, thread?: MessageId): Promise<Message> {
    await withRetry(() => A.sendMessage(ch, { kind: 'text', text }, thread ? { thread } : undefined))
    return until(`B receives "${text}"`, () => {
      for (const e of bEvents)
        if (e.t === 'message.received' && e.message.body.kind === 'text' && e.message.body.text === text) return e.message
      return undefined
    })
  }

  const unreadOf = (ch: ChannelId, root: MessageId) => B.getThreadUnread(ch, root).unread

  // The ADR-067 state of the reader, for a timeout (PLANO-RELEASE-PUBLICA §8.37): the verb, the rule's
  // input (room.hasUserReadEvent on the thread's last reply) and the reader's receipts. SDK internals
  // reached structurally, test-only.
  type ProbeEvent = { getId(): string | undefined }
  type ProbeRoom = {
    findEventById(id: string): ProbeEvent | undefined
    getThread(id: string): {
      lastReply(): ProbeEvent | undefined
      getReadReceiptForUserId(user: string, ignoreSynthesized: boolean): { eventId: string } | null
    } | null
    hasUserReadEvent(user: string, id: string): boolean
    getReadReceiptForUserId(user: string, ignoreSynthesized: boolean): { eventId: string } | null
  }
  function readState(ch: ChannelId, root: MessageId, reply: MessageId): unknown {
    const client = (B as unknown as { client?: { getRoom(id: string): ProbeRoom | null } }).client
    const room = client?.getRoom(ch as unknown as string)
    const me = bId as unknown as string
    const thread = room?.getThread(root as unknown as string)
    const lastReply = thread?.lastReply()?.getId()
    return {
      threadUnread: B.getThreadUnread(ch, root),
      reply,
      replyInRoom: !!room?.findEventById(reply as unknown as string),
      lastReply,
      hasUserReadEvent: lastReply ? room?.hasUserReadEvent(me, lastReply) : null,
      threadExists: !!thread,
      threadedReceipt: thread?.getReadReceiptForUserId(me, true)?.eventId ?? null,
      roomReceipt: room?.getReadReceiptForUserId(me, true)?.eventId ?? null,
    }
  }

  it.each(KINDS)('%s: an unread reply sets it with no prior threaded receipt; reading clears it', async (kind) => {
    const ch = await channelFor(kind)
    const root = await aSends(ch, `${kind} root 1`)
    // Reading the channel sends a MAIN receipt — it does not move the SDK's threaded-receipt marker.
    await B.markRead(ch)
    expect(unreadOf(ch, root.id)).toBe(false) // no reply yet

    const reply = await aSends(ch, `${kind} reply 1`, root.id)
    await until(`${kind}: unread after the first reply`, () => (unreadOf(ch, root.id) ? true : undefined), {
      snapshot: () => JSON.stringify(B.getThreadUnread(ch, root.id)),
    })

    // The ThreadPanel's markRead: a threaded receipt on the reply.
    await B.markRead(ch, reply.id)
    await until(`${kind}: cleared after markRead on the thread`, () => (unreadOf(ch, root.id) ? undefined : true), {
      snapshot: () => JSON.stringify(readState(ch, root.id, reply.id)),
    })
  })

  it.each(KINDS)('%s: a read on the other device clears it by sync and wakes the UI via channel.changed', async (kind) => {
    const ch = await channelFor(kind)
    const root = await aSends(ch, `${kind} root 2`)
    const reply = await aSends(ch, `${kind} reply 2`, root.id)
    await until(`${kind}: unread before the other device reads`, () => (unreadOf(ch, root.id) ? true : undefined))

    // What the UI would read on each channel.changed of this channel, at that very tick (dec. 3).
    const seen: boolean[] = []
    const unsub = B.subscribe((e) => {
      if (e.t === 'channel.changed' && e.channel.id === ch) seen.push(unreadOf(ch, root.id))
    })
    try {
      await threadedReceipt(b2Token, ch as unknown as string, reply.id as unknown as string, root.id as unknown as string)
      await until(`${kind}: a channel.changed carries the cleared state`, () => (seen.includes(false) ? true : undefined), {
        snapshot: () => `seen=${JSON.stringify(seen)} now=${String(unreadOf(ch, root.id))}`,
      })
    } finally {
      unsub()
    }
    expect(unreadOf(ch, root.id)).toBe(false)
  })

  it.skipIf(!ADMIN).each(KINDS)('%s: a root outside the reloaded window uses the aggregation, with no request for it', async (kind) => {
    const ch = await channelFor(kind)
    const roomId = ch as unknown as string
    const unreadRoot = await aSends(ch, `${kind} paged root unread`)
    await aSends(ch, `${kind} paged reply unread`, unreadRoot.id)
    const readRoot = await aSends(ch, `${kind} paged root read`)
    const readReply = await aSends(ch, `${kind} paged reply read`, readRoot.id)
    await threadedReceipt(b2Token, roomId, readReply.id as unknown as string, readRoot.id as unknown as string)

    // More main-timeline events than the initial sync window holds (the gateway syncs 30), so a
    // reloaded session never has these roots in the room nor an SDK Thread for them.
    const admin = mintAdminToken(PROBE_USER)
    try {
      await liftMessageRatelimit(admin, aId)
    } finally {
      killSessions(PROBE_USER)
    }
    for (let i = 0; i < 31; i++) await sendText(aToken, roomId, `${kind} filler ${i}`)

    // Reload: a brand-new session of the reader (no persistent sync store — reload = initial sync).
    const R = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await R.connect((await mintToken(bName)) as Parameters<Acl['connect']>[0])
    try {
      await until(`R knows the ${kind} channel`, async () => ((await R.getChannels()).some((c) => c.id === ch) ? true : undefined))
      requested.length = 0
      let page = await R.getTimeline(ch)
      const ids = new Set(page.items.map((m) => m.id as string))
      while (page.nextCursor && !(ids.has(unreadRoot.id as string) && ids.has(readRoot.id as string))) {
        page = await R.getTimeline(ch, { cursor: page.nextCursor })
        for (const m of page.items) ids.add(m.id as string)
      }
      expect(ids.has(unreadRoot.id as string) && ids.has(readRoot.id as string)).toBe(true)
      expect(R.getThreadUnread(ch, unreadRoot.id)).toEqual({ unread: true })
      expect(R.getThreadUnread(ch, readRoot.id)).toEqual({ unread: false })
      // No request named either root: neither the thread (relations) nor the root (event) was fetched.
      const perRoot = requested.filter((p) => p.includes(unreadRoot.id as string) || p.includes(readRoot.id as string))
      expect(perRoot).toEqual([])
    } finally {
      await R.disconnect()
    }
  })
})

describe('ACL per-thread unread (availability)', () => {
  it(SYNAPSE ? 'stack reachable' : 'stack down — skipped', () => {
    expect(typeof SYNAPSE).toBe('boolean')
  })
})
