import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { MatrixGateway } from '../../src/acl/internal/matrix-client'
import type { Acl, AclTelemetry, ChannelId, DomainEvent, Message, MessageId, UserId } from '../../src/acl'
import { HOMESERVER, synapseReachable, whoami, mintToken } from '../support/synapse'
import { freshUsers } from '../support/fresh-users'
import { until } from '../support/until'

// Issue #421 (A): an OLD thread reply in an encrypted DM, already read, must not come
// out as message.received on a session booted from zero. The stream is the LIVE tail only (the `live`
// gate, matrix-client.ts); a reply the initial /sync brings seeds the SDK's Thread, and
// Thread.onEcho emits ThreadEvent.NewReply for it only after updateThreadMetadata resolves (root
// fetch + GET /relations) — after connect() has resolved.
// The new session is a NEW device of A (no key backup here): the reply may surface `unavailable`;
// either body is a message.received of an old reply, which is what the assertion forbids.

const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const COLLECT_MS = 15_000

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

describe.skipIf(!SYNAPSE)('an old, read thread reply is not a message.received on a fresh boot (#421 A)', () => {
  let A: MatrixGateway
  let B: MatrixGateway
  let A2: MatrixGateway | undefined
  let A3: MatrixGateway | undefined
  let aName: string
  let bId: UserId
  const aEvents: DomainEvent[] = []
  // Shared with the positive case: the DM, B's view of the thread root, and every thread
  // message.received from B that the new session of A carried.
  let dmId: ChannelId | undefined
  let rootOnBId: MessageId | undefined
  const fromBInThread: DomainEvent[] = []

  beforeAll(async () => {
    const [a, b] = await freshUsers(['ora', 'orb'])
    aName = a.name
    await whoami(a.token)
    bId = (await whoami(b.token)) as unknown as UserId
    A = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await A.connect(a.token as Parameters<Acl['connect']>[0])
    B = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await B.connect(b.token as Parameters<Acl['connect']>[0])
    A.subscribe((e) => aEvents.push(e))
  }, 240_000)

  afterAll(async () => {
    await A3?.disconnect()
    await A2?.disconnect()
    await A?.disconnect()
    await B?.disconnect()
  })

  function aReceived(text: string): Promise<Message> {
    return until(`A receives "${text}"`, () => {
      for (const e of aEvents)
        if (e.t === 'message.received' && e.message.body.kind === 'text' && e.message.body.text === text) return e.message
      return undefined
    })
  }

  it('A reads B\'s thread reply, boots a new session, and the stream carries no message.received for it', async () => {
    const ch: ChannelId = await withRetry(() => A.openDirectMessage(bId))
    dmId = ch
    await until('B knows the DM', async () => ((await B.getChannels()).some((c) => c.id === ch) ? true : undefined))
    expect((await A.getChannels()).find((c) => c.id === ch)?.kind).toBe('dm')

    await withRetry(() => A.sendMessage(ch, { kind: 'text', text: 'old root' }))
    const rootOnB = await until('B sees the root', async () => {
      const page = await B.getTimeline(ch, {})
      return page.items.find((m) => m.body.kind === 'text' && m.body.text === 'old root')
    })
    rootOnBId = rootOnB.id
    await withRetry(() => B.sendMessage(ch, { kind: 'text', text: 'old reply' }, { thread: rootOnB.id }))
    const reply = await aReceived('old reply')
    const root: MessageId | undefined = reply.threadParent
    expect(root).toBeDefined()
    await A.markRead(ch, reply.id)
    await until('A has read the thread', async () => ((await A.getThreadUnread(ch, root!)).unread ? undefined : true))
    await A.disconnect()

    // Boot from zero: a new session of A (new device, empty in-memory SDK state).
    const a2Token = await mintToken(aName)
    const seen: { at: number; kind: string; thread: boolean; mine: boolean }[] = []
    A2 = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    let t0 = 0
    A2.subscribe((e) => {
      if (e.t !== 'message.received') return
      seen.push({ at: Date.now() - t0, kind: e.message.body.kind, thread: e.message.threadParent !== undefined, mine: e.message.mine })
      // By channel + thread + author, not by root id: the root is A's own send, whose stable id in the
      // first session is its txn id (stableMessageId) and in the new session its event id. The DM
      // holds exactly one thread reply (B's), so any thread message.received not mine is it.
      if (e.channelId === ch && e.message.threadParent !== undefined && !e.message.mine) fromBInThread.push(e)
    })
    t0 = Date.now()
    await A2.connect(a2Token as Parameters<Acl['connect']>[0])
    const connectMs = Date.now() - t0
    await new Promise((r) => setTimeout(r, COLLECT_MS))

    // Diagnostic line: no ids, no content — when each message.received arrived and of what kind.
    console.info(`[#421-A] connect resolved at ${connectMs} ms; message.received after boot: ${JSON.stringify(seen)}`)
    expect(fromBInThread.map((e) => (e.t === 'message.received' ? e.message.body.kind : e.t))).toEqual([])
  }, 240_000)

  it('with the new session live, a NEW reply from B in the same thread is exactly one message.received', async () => {
    expect(A2).toBeDefined()
    expect(fromBInThread).toEqual([])
    await withRetry(() => B.sendMessage(dmId!, { kind: 'text', text: 'new reply' }, { thread: rootOnBId! }))
    await until('A2 receives the new reply', () => (fromBInThread.length > 0 ? true : undefined))
    // Room for a duplicate (both branches, or a late decrypt routed as a second receive) to show up.
    await new Promise((r) => setTimeout(r, 5_000))
    expect(fromBInThread).toHaveLength(1)
    const got = fromBInThread[0]!
    if (got.t !== 'message.received') throw new Error('unreachable')
    // A2 is a new device of A: B's send may not have reached its keys yet, which surfaces as
    // `unavailable` — still the one receive of the new reply; a decrypted body must be it.
    expect(['text', 'unavailable']).toContain(got.message.body.kind)
    if (got.message.body.kind === 'text') expect(got.message.body.text).toBe('new reply')
  }, 240_000)

  // #421 N6: a thread reply has one emission path (onThreadReply, ThreadEvent.NewReply); the timeline no
  // longer defers it to the decrypt. Each case proves the SDK fires NewReply for it, so nothing is lost.
  async function exactlyOne(got: DomainEvent[], text: string): Promise<void> {
    await until(`the new session receives "${text}"`, () => (got.length > 0 ? true : undefined))
    await new Promise((r) => setTimeout(r, 5_000))
    expect(got).toHaveLength(1)
    const only = got[0]!
    if (only.t !== 'message.received') throw new Error('unreachable')
    expect(['text', 'unavailable']).toContain(only.message.body.kind)
    if (only.message.body.kind === 'text') expect(only.message.body.text).toBe(text)
  }

  it('the FIRST reply to a root that has no thread yet is exactly one message.received (N6, case a)', async () => {
    expect(A2).toBeDefined()
    fromBInThread.length = 0
    await withRetry(() => A2!.sendMessage(dmId!, { kind: 'text', text: 'root two' }))
    const rootOnB = await until('B sees root two', async () => {
      const page = await B.getTimeline(dmId!, {})
      return page.items.find((m) => m.body.kind === 'text' && m.body.text === 'root two')
    })
    expect(rootOnB.threadSummary).toBeUndefined()
    await withRetry(() => B.sendMessage(dmId!, { kind: 'text', text: 'first reply two' }, { thread: rootOnB.id }))
    await exactlyOne(fromBInThread, 'first reply two')
  }, 240_000)

  it('a NEW reply in a thread whose root fell outside the initial sync window (no Thread in the session) is exactly one message.received (N6, case b)', async () => {
    expect(A2).toBeDefined()
    // An existing thread on the server: A2's root, B's reply.
    await withRetry(() => A2!.sendMessage(dmId!, { kind: 'text', text: 'root three' }))
    const rootOnB = await until('B sees root three', async () => {
      const page = await B.getTimeline(dmId!, {})
      return page.items.find((m) => m.body.kind === 'text' && m.body.text === 'root three')
    })
    await withRetry(() => B.sendMessage(dmId!, { kind: 'text', text: 'old reply three' }, { thread: rootOnB.id }))
    // More than the initial sync's 30 events after it, so a new session's window leaves the root out.
    const FILLERS = 35
    for (let i = 1; i <= FILLERS; i++) await withRetry(() => B.sendMessage(dmId!, { kind: 'text', text: `filler ${i}` }))
    await until('the server has the last filler', async () => {
      const page = await A2!.getTimeline(dmId!, {})
      return page.items.some((m) => m.body.kind === 'text' && m.body.text === `filler ${FILLERS}`) ? true : undefined
    })

    const got: DomainEvent[] = []
    A3 = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    A3.subscribe((e) => {
      if (e.t !== 'message.received') return
      if (e.channelId === dmId && e.message.threadParent !== undefined && !e.message.mine) got.push(e)
    })
    await A3.connect((await mintToken(aName)) as Parameters<Acl['connect']>[0])
    // The precondition, read on the SDK the gateway holds (test-only, never logged): the room is there,
    // the root and its Thread are not.
    const sdk = (A3 as unknown as { client: { getRoom(id: string): { findEventById(id: string): unknown; getThread(id: string): unknown } | null } }).client
    const room = sdk.getRoom(dmId as unknown as string)
    expect(room).not.toBeNull()
    expect(room!.findEventById(rootOnB.id as unknown as string)).toBeUndefined()
    expect(room!.getThread(rootOnB.id as unknown as string) ?? undefined).toBeUndefined()
    await new Promise((r) => setTimeout(r, 3_000))
    expect(got).toEqual([])

    await withRetry(() => B.sendMessage(dmId!, { kind: 'text', text: 'new reply three' }, { thread: rootOnB.id }))
    await exactlyOne(got, 'new reply three')
  }, 360_000)
})
