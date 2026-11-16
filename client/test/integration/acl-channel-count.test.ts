import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { MatrixGateway } from '../../src/acl/internal/matrix-client'
import type { Acl, AclTelemetry, ChannelId, DomainEvent, Message, MessageId, UnreadState, UserId } from '../../src/acl'
import { HOMESERVER, synapseReachable, whoami, mintToken } from '../support/synapse'
import { adminScopeReachable, mintAdminToken, liftMessageRatelimit, killSessions, PROBE_USER } from '../support/synapse-admin'
import { freshUsers } from '../support/fresh-users'
import { until } from '../support/until'

// ADR-068 against the stack: the channel count is the server's (room + Σ threads), read the same way
// in an encrypted DM and in a cleartext public channel. Before it, the DM's count left the thread
// replies out (the SDK drops the server's non-zero counts in an encrypted room, sync.ts:1293/:1322)
// and, after a reload, its main count stopped at the decrypted window. Each kind runs the same steps:
//  1. a thread reply with no threaded receipt of the reader counts; when the reader's other device
//     reads the thread, the new count reaches the stream through the capture's channel.changed (D3);
//  2. an own reply / own message leaves the room read (D7);
//  3. a mention inside the window: the server highlight in cleartext, the decrypted events in the DM;
//  4. a reloaded session after root + reply + mention + 31 messages offline: the same count in both,
//     out of the window included; the mention out of the window is seen only in cleartext (D6 a).
// In the public channel every reading is checked against room.getUnreadNotificationCount — the
// number the cleartext channel showed before ADR-068 (regression guard, mandatory). No /threads.
// Every reading is a gateway's incremental sync or a fresh session's initial sync: no raw since-less
// /sync, so Synapse's 2-minute response cache never answers (PLANO §8.32).

const SYNAPSE = synapseReachable()
const ADMIN = SYNAPSE && adminScopeReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const KINDS = ['dm', 'public'] as const
type Kind = (typeof KINDS)[number]

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

// The SDK's own channel count — what the ACL read before ADR-068. In cleartext it must not move.
function sdkTotal(gw: MatrixGateway, ch: ChannelId): number {
  const client = (gw as unknown as { client: { getRoom(id: string): { getUnreadNotificationCount(): number } | null } }).client
  return client.getRoom(ch as unknown as string)?.getUnreadNotificationCount() ?? -1
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

// Diagnosis only (timeout snapshots): the captured server counts behind the channel's number.
function serverBreakdown(gw: MatrixGateway, ch: ChannelId): unknown {
  const store = (gw as unknown as { serverUnread?: { get(id: string): { room: unknown; threads: Map<string, unknown> } | undefined } }).serverUnread
  const v = store?.get(ch as unknown as string)
  return v ? { room: v.room, threads: Object.fromEntries(v.threads) } : null
}

const requested: string[] = []
const realFetch = globalThis.fetch

describe.skipIf(!SYNAPSE)('ACL channel count from the server — DM × public channel (ADR-068)', () => {
  let A: MatrixGateway
  let B: MatrixGateway
  let aId: string
  let bId: UserId
  let bName: string
  let b2Token: string
  const bEvents: DomainEvent[] = []

  beforeAll(async () => {
    const [a, b] = await freshUsers(['cca', 'ccb'])
    aId = await whoami(a.token)
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

  const channels = new Map<Kind, ChannelId>()

  async function channelFor(kind: Kind): Promise<ChannelId> {
    const known = channels.get(kind)
    if (known) return known
    const id =
      kind === 'dm'
        ? await withRetry(() => A.openDirectMessage(bId))
        : await withRetry(() => A.createChannel({ name: `cc-pub-${process.pid}-${Date.now()}`, kind: 'public', members: [bId] }))
    await until(`B knows the ${kind} channel`, async () => ((await B.getChannels()).some((c) => c.id === id) ? true : undefined))
    channels.set(kind, id)
    return id
  }

  async function aSends(ch: ChannelId, text: string, opts: { thread?: MessageId; mention?: boolean } = {}): Promise<Message> {
    await withRetry(() =>
      A.sendMessage(ch, { kind: 'text', text }, { ...(opts.thread ? { thread: opts.thread } : {}), ...(opts.mention ? { mentions: [bId] } : {}) }),
    )
    return until(`B receives "${text}"`, () => {
      for (const e of bEvents)
        if (e.t === 'message.received' && e.message.body.kind === 'text' && e.message.body.text === text) return e.message
      return undefined
    })
  }

  async function unreadOf(gw: MatrixGateway, ch: ChannelId): Promise<UnreadState> {
    return (await gw.getChannel(ch)).unread
  }

  // Wait for the reader's channel to settle on `want`, then (public) hold it to the SDK's number.
  async function expectUnread(kind: Kind, gw: MatrixGateway, ch: ChannelId, want: Partial<UnreadState>, label: string): Promise<UnreadState> {
    const got = await until(
      `${kind}: ${label}`,
      async () => {
        const u = await unreadOf(gw, ch)
        const ok = (want.count === undefined || u.count === want.count) && (want.mentions === undefined || u.mentions === want.mentions)
        return ok ? u : undefined
      },
      { snapshot: async () => JSON.stringify({ acl: await unreadOf(gw, ch), sdk: sdkTotal(gw, ch), server: serverBreakdown(gw, ch) }) },
    )
    if (kind === 'public') expect(got.count, `${label}: cleartext count = room.getUnreadNotificationCount`).toBe(sdkTotal(gw, ch))
    return got
  }

  it.each(KINDS)('%s: a thread reply with no threaded receipt counts; a read on the other device reaches the stream (D3)', async (kind) => {
    const ch = await channelFor(kind)
    const root = await aSends(ch, `${kind} root 1`)
    await B.markRead(ch)
    await expectUnread(kind, B, ch, { count: 0 }, 'zero after reading the channel')

    const reply = await aSends(ch, `${kind} reply 1`, { thread: root.id })
    await expectUnread(kind, B, ch, { count: 1 }, 'the thread reply counts')

    // D3, the order. The reader reads the thread on ANOTHER device (a threaded receipt straight to the
    // server). In that sync cycle the SDK adds the receipt (RoomEvent.Receipt → the ACL's onReceipt)
    // and emits UnreadNotifications inside processSyncResponse, both before store.setSyncData
    // (sync.ts:906): those channel.changed still carry 1. Nothing else happens in the room, so only the
    // capture's own emission brings the 0 (mutation without it: the 0 never arrives on the stream).
    const seen: number[] = []
    const unsub = B.subscribe((e) => {
      if (e.t === 'channel.changed' && e.channel.id === ch) seen.push(e.channel.unread.count)
    })
    try {
      await threadedReceipt(b2Token, ch as unknown as string, reply.id as unknown as string, root.id as unknown as string)
      await until(`${kind}: a channel.changed carries the read thread`, () => (seen.includes(0) ? true : undefined), {
        snapshot: async () => `seen=${JSON.stringify(seen)} now=${JSON.stringify(await unreadOf(B, ch))}`,
      })
    } finally {
      unsub()
    }
    await expectUnread(kind, B, ch, { count: 0 }, 'zero after the other device read the thread')
  })

  it.each(KINDS)('%s: an own reply and an own message leave the room read (D7)', async (kind) => {
    const ch = await channelFor(kind)
    const root = await aSends(ch, `${kind} root 2`)
    await B.markRead(ch)
    await expectUnread(kind, B, ch, { count: 0 }, 'zero after reading the channel')
    await aSends(ch, `${kind} reply 2`, { thread: root.id })
    await expectUnread(kind, B, ch, { count: 1 }, 'the thread reply counts')
    await withRetry(() => B.sendMessage(ch, { kind: 'text', text: `${kind} own reply` }, { thread: root.id }))
    await expectUnread(kind, B, ch, { count: 0 }, 'zero after an own reply in the thread')
    await aSends(ch, `${kind} main 2`)
    await expectUnread(kind, B, ch, { count: 1 }, 'the main message counts')
    await withRetry(() => B.sendMessage(ch, { kind: 'text', text: `${kind} own main` }))
    await expectUnread(kind, B, ch, { count: 0 }, 'zero after an own main message')
  })

  it.each(KINDS)('%s: a mention inside the window is a mention in both kinds; reading clears it', async (kind) => {
    const ch = await channelFor(kind)
    await B.markRead(ch)
    await expectUnread(kind, B, ch, { count: 0, mentions: 0 }, 'zero before the mention')
    const root = await aSends(ch, `${kind} root 3`)
    await aSends(ch, `${kind} mention in thread`, { thread: root.id, mention: true })
    await aSends(ch, `${kind} mention in main`, { mention: true })
    await expectUnread(kind, B, ch, { count: 3, mentions: 2 }, 'two mentions, main and thread')
    await B.markRead(ch)
    await expectUnread(kind, B, ch, { count: 1, mentions: 1 }, 'the main read, the thread mention left')
    const reply = bEvents.find((e) => e.t === 'message.received' && e.message.body.kind === 'text' && e.message.body.text === `${kind} mention in thread`)
    await B.markRead(ch, (reply as { message: Message }).message.id)
    await expectUnread(kind, B, ch, { count: 0, mentions: 0 }, 'zero after reading the thread')
  })

  it.skipIf(!ADMIN).each(KINDS)('%s: a reloaded session counts what came offline, out of the window included', async (kind) => {
    const ch = await channelFor(kind)
    await B.markRead(ch)
    await expectUnread(kind, B, ch, { count: 0 }, 'zero before going offline')
    const admin = mintAdminToken(PROBE_USER)
    try {
      await liftMessageRatelimit(admin, aId)
    } finally {
      killSessions(PROBE_USER)
    }
    // Root + thread reply + a mention, then more main messages than the gateway's window (30), so a
    // reloaded session holds neither the thread nor the mention in memory.
    const root = await aSends(ch, `${kind} offline root`)
    await aSends(ch, `${kind} offline reply`, { thread: root.id })
    await aSends(ch, `${kind} offline mention`, { mention: true })
    for (let i = 0; i < 31; i++) await withRetry(() => A.sendMessage(ch, { kind: 'text', text: `${kind} filler ${i}` }))

    // Reload: a brand-new session of the reader (no persistent sync store — reload = initial sync).
    const R = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await R.connect((await mintToken(bName)) as Parameters<Acl['connect']>[0])
    try {
      await until(`R knows the ${kind} channel`, async () => ((await R.getChannels()).some((c) => c.id === ch) ? true : undefined))
      // 1 root + 1 mention + 31 in the main timeline, + 1 thread reply.
      const got = await expectUnread(kind, R, ch, { count: 34 }, 'the same count in both kinds after reload')
      // D6 a: the server sees the mention only in cleartext; in the DM it is out of what was decrypted.
      expect(got.mentions).toBe(kind === 'public' ? 1 : 0)
    } finally {
      await R.disconnect()
    }
  })

  it('no request lists the threads (D5)', () => {
    expect(requested.length).toBeGreaterThan(0)
    expect(requested.filter((p) => p.endsWith('/threads'))).toEqual([])
  })
})

describe('ACL channel count (availability)', () => {
  it(SYNAPSE ? 'stack reachable' : 'stack down — skipped', () => {
    expect(typeof SYNAPSE).toBe('boolean')
  })
})
