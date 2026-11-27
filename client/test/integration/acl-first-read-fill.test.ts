import { describe, it, expect, afterEach } from 'vitest'
import { MatrixGateway } from '../../src/acl/internal/matrix-client'
import type { ChannelId, UserId } from '../../src/acl'
import { HOMESERVER, join, synapseReachable, whoami } from '../support/synapse'
import { admitToOrg, orgSystemSession } from '../support/org-membership'
import { freshUsers } from '../support/fresh-users'
import { until } from '../support/until'

// Issue #421 (lote "Nova conversa"): a room joined after the first sync reaches its joiner by the join's sync,
// cut at the server's default of 10 timeline events. When this session saw the room's transition to join (after its
// first sync) and the live window does not hold the room's start, the first read fetches one page back. On the real
// stack:
// 1. a session born after its own join to the organization channel (CI run 45519024444): the initial sync's window
//    of a quiet room holds that join and not the start, and the first read makes no /messages request;
// 2. a new group, the invitee connected before the invite: its window lacks the creation; the first read reaches the
//    start;
// 3. a private channel with more than a page of history: the fetched page is from before the entry and does not
//    decrypt, so the invitee's first read drops it (PR #515 review): the live window only, and its cursor;
// 4. a public channel with more than a page of history: the page reads, so the first read carries it, every row
//    readable, and keeps a cursor.
// Fresh users per run (#32); auto-skip without the stack (issue #7).

const SYNAPSE = synapseReachable()
const gateways: MatrixGateway[] = []
function gateway(): MatrixGateway {
  const g = new MatrixGateway({ mode: 'strict', telemetry: { untranslated: () => {} }, serverUrl: HOMESERVER })
  gateways.push(g)
  return g
}
type LiveEvent = { getType(): string; getStateKey(): string | undefined; getContent(): { membership?: string } }
function liveWindow(g: MatrixGateway, roomId: string): LiveEvent[] {
  const client = (g as unknown as { client: { getRoom(id: string): { getLiveTimeline(): { getEvents(): LiveEvent[] } } } }).client
  return client.getRoom(roomId).getLiveTimeline().getEvents()
}

// The burst of sends drains the creator's message rate limit; the ACL answers the server's wait or its own
// RateLimitedError (no wait given): wait and try again.
async function withRateLimit<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await work()
    } catch (err) {
      const wait = (err as { data?: { retry_after_ms?: number } }).data?.retry_after_ms
      const limited = wait !== undefined || (err as Error).name === 'RateLimitedError'
      if (!limited || attempt > 30) throw err
      await new Promise((r) => setTimeout(r, wait ?? 2_000))
    }
  }
}

describe.skipIf(!SYNAPSE)('first read of a room joined after the first sync: ACL ↔ real stack', () => {
  afterEach(async () => {
    for (const g of gateways.splice(0)) await g.disconnect().catch(() => {})
  })

  // PR #515, CI run 45519024444: a session born after its own join gets that join in the initial sync's window
  // when the room is quiet (the organization channel of a stack born clean), without the room's start. The entry
  // is old news for this session: its first read fetches nothing.
  it('a session born after its own join to the organization channel: the first read makes no /messages request', async () => {
    const [u] = await freshUsers(['ffo'])
    const mxid = await whoami(u.token)
    const { roomId } = await orgSystemSession()
    await admitToOrg(u.token)
    await join(u.token, roomId)
    const g = gateway()
    await g.connect(u.token as never)
    const id = roomId as ChannelId
    await until('the org channel', async () => ((await g.getChannels()).some((ch) => ch.id === id) ? true : undefined))
    const window = liveWindow(g, roomId)
    const http = (g as unknown as { client: { http: { authedRequest: (...a: unknown[]) => Promise<unknown> } } }).client.http
    const original = http.authedRequest.bind(http)
    // The search backfill also asks this room for history, in the background; only the read's requests count.
    const messages: string[] = []
    http.authedRequest = (...a: unknown[]) => {
      if (String(a[1]).includes('/messages') && new Error().stack?.includes('timelinePage')) messages.push(String(a[1]))
      return original(...a)
    }
    await g.getTimeline(id)
    // The state of the CI's clean stack: the entry is in the window, the room's start is not.
    expect(window.some((e) => e.getType() === 'm.room.member' && e.getStateKey() === mxid && e.getContent().membership === 'join')).toBe(true)
    expect(window.some((e) => e.getType() === 'm.room.create')).toBe(false)
    expect(messages).toEqual([])
  }, 180_000)

  it('a new group, the invitee connected before the invite: its window lacks the start; the first read has no cursor', async () => {
    const [a, b, c] = await freshUsers(['ffa', 'ffb', 'ffc'])
    const mxidB = await whoami(b.token)
    const mxidC = await whoami(c.token)
    const alice = gateway()
    const bob = gateway()
    await alice.connect(a.token as never)
    await bob.connect(b.token as never)
    const id = await alice.openGroupConversation([mxidB as UserId, mxidC as UserId])
    await until('B has the group', async () => ((await bob.getChannels()).some((ch) => ch.id === id) ? true : undefined))
    const window = liveWindow(bob, String(id))
    expect(window.some((e) => e.getType() === 'm.room.create')).toBe(false)
    expect((await bob.getTimeline(id)).nextCursor).toBeUndefined()
  }, 180_000)

  // A channel of this kind with more than a page of history (45 messages: the window of 10 and a page of 30 do not
  // reach the start); B is added after its first sync. The live window's ids, and B's first read.
  async function joinedLate(kind: 'private' | 'public', prefix: [string, string]) {
    const [a, b] = await freshUsers(prefix)
    const mxidB = await whoami(b.token)
    const alice = gateway()
    await alice.connect(a.token as never)
    const id: ChannelId = await alice.createChannel({ name: `fill-${kind}-${Date.now()}`, kind })
    const TOTAL = 45
    for (let i = 1; i <= TOTAL; i++) await withRateLimit(() => alice.sendMessage(id, { kind: 'text', text: `m${i}` }))
    const bob = gateway()
    await bob.connect(b.token as never)
    await withRateLimit(() => alice.addMember(id, mxidB as UserId))
    await until('B has the channel', async () => ((await bob.getChannels()).some((ch) => ch.id === id) ? true : undefined))
    const window = liveWindow(bob, String(id))
    const liveIds = new Set(window.map((e) => (e as unknown as { getId(): string }).getId()))
    const page = await bob.getTimeline(id)
    // Rows the live window did not have came from the fetched page; the id is what tells them apart.
    return { page, fetched: page.items.filter((m) => !liveIds.has(String(m.id))) }
  }

  it('a private channel with more than a page of history: the page does not decrypt, the first read is the live window and a cursor', async () => {
    const { page, fetched } = await joinedLate('private', ['ffd', 'ffe'])
    // Messages from before the entry do not decrypt on this encrypted channel (ADR-057 norma 1): the page is dropped.
    expect(fetched).toEqual([])
    expect(page.nextCursor).toBeDefined()
  }, 300_000)

  it('a public channel with more than a page of history: the first read carries the fetched page, all readable, and a cursor', async () => {
    const { page, fetched } = await joinedLate('public', ['fff', 'ffg'])
    expect(fetched.length).toBeGreaterThan(0)
    for (const m of fetched) expect(m.body.kind).not.toBe('unavailable')
    expect(fetched.some((m) => m.body.kind === 'text')).toBe(true)
    expect(page.nextCursor).toBeDefined()
  }, 300_000)
})

describe('first read fill (availability)', () => {
  it(SYNAPSE ? 'stack reachable' : 'stack down — skipped', () => {
    expect(typeof SYNAPSE).toBe('boolean')
  })
})
