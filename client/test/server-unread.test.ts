import { describe, it, expect, vi, afterEach } from 'vitest'
import { MemoryStore, type ISyncResponse } from 'matrix-js-sdk'
import { ServerUnreadStore } from '../src/acl/internal/server-unread'
import { roomToChannel, encryptedUnreadMentions, type Ctx } from '@tayet/shared/internal'

// ADR-068: the channel count is the server's (room + Σ threads), captured from /sync by a MemoryStore
// subclass (the createClient's public `store` option) and read the same way in encrypted and cleartext
// rooms. In an encrypted room the SDK drops the server's non-zero counts (sync.ts:1293/:1322), so its
// getters say 0 where the server says N — the fake room below reproduces that and the count must
// still be the server's (mutation: reading room.getUnreadNotificationCount fails the encrypted case).

const ME = '@me:tayet.local'
const OTHER = '@other:tayet.local'
const ROOM = '!r:tayet.local'

type Counts = { notification_count: number; highlight_count: number }
function sync(rooms: Record<string, { n?: Counts; t?: Record<string, Counts> }>, leave: string[] = []): ISyncResponse {
  const join: Record<string, unknown> = {}
  for (const [id, r] of Object.entries(rooms)) {
    join[id] = {
      timeline: { events: [] },
      ...(r.n ? { unread_notifications: r.n } : {}),
      ...(r.t ? { unread_thread_notifications: r.t } : {}),
    }
  }
  return {
    next_batch: 's',
    rooms: { join, invite: {}, leave: Object.fromEntries(leave.map((id) => [id, {}])), knock: {} },
  } as unknown as ISyncResponse
}
const c = (notification_count: number, highlight_count = 0): Counts => ({ notification_count, highlight_count })

afterEach(() => vi.restoreAllMocks())

describe('ServerUnreadStore (ADR-068 D2/D3)', () => {
  it('captures the room and per-thread counts, and always calls super.setSyncData', async () => {
    const superSet = vi.spyOn(MemoryStore.prototype, 'setSyncData')
    const store = new ServerUnreadStore({}, () => {})
    const data = sync({ [ROOM]: { n: c(2, 1), t: { $a: c(1), $b: c(3, 1) } } })
    await store.setSyncData(data)
    expect(superSet).toHaveBeenCalledWith(data)
    const got = store.get(ROOM)!
    expect(got.room).toEqual({ total: 2, highlight: 1 })
    expect([...got.threads.entries()]).toEqual([
      ['$a', { total: 1, highlight: 0 }],
      ['$b', { total: 3, highlight: 1 }],
    ])
  })

  it('a room absent from an incremental sync keeps its value; a thread absent from the map is 0', async () => {
    const store = new ServerUnreadStore({}, () => {})
    await store.setSyncData(sync({ [ROOM]: { n: c(2), t: { $a: c(1), $b: c(1) } } }))
    await store.setSyncData(sync({ '!other:tayet.local': { n: c(5), t: {} } }))
    expect(store.get(ROOM)!.room.total).toBe(2)
    expect(store.get(ROOM)!.threads.size).toBe(2)
    // The room comes back with $b gone from its map: $b is 0 now (read on another device).
    await store.setSyncData(sync({ [ROOM]: { n: c(0), t: { $a: c(1) } } }))
    expect([...store.get(ROOM)!.threads.keys()]).toEqual(['$a'])
    // The room comes back with no map at all — Synapse omits it when no thread has a count: all 0.
    await store.setSyncData(sync({ [ROOM]: { n: c(0) } }))
    expect(store.get(ROOM)!.threads.size).toBe(0)
  })

  it('a left room is dropped; deleteAllData clears and calls super', async () => {
    const superDelete = vi.spyOn(MemoryStore.prototype, 'deleteAllData')
    const store = new ServerUnreadStore({}, () => {})
    await store.setSyncData(sync({ [ROOM]: { n: c(2), t: {} }, '!k:tayet.local': { n: c(1), t: {} } }))
    await store.setSyncData(sync({}, [ROOM]))
    expect(store.get(ROOM)).toBeUndefined()
    await store.deleteAllData()
    expect(superDelete).toHaveBeenCalledTimes(1)
    expect(store.get('!k:tayet.local')).toBeUndefined()
  })

  it('onChanged runs AFTER the capture, only with the rooms whose value changed', async () => {
    const seen: Array<{ ids: string[]; total: number | undefined }> = []
    const store: ServerUnreadStore = new ServerUnreadStore({}, (ids) =>
      seen.push({ ids, total: store.get(ROOM)?.room.total }),
    )
    await store.setSyncData(sync({ [ROOM]: { n: c(1), t: {} } }))
    await store.setSyncData(sync({ [ROOM]: { n: c(1), t: {} } })) // same value → no callback
    await store.setSyncData(sync({ [ROOM]: { n: c(1), t: { $a: c(1) } } }))
    expect(seen).toEqual([
      { ids: [ROOM], total: 1 },
      { ids: [ROOM], total: 1 },
    ])
    expect(store.get(ROOM)!.threads.get('$a')).toEqual({ total: 1, highlight: 0 })
  })
})

// ── unreadOf through roomToChannel ──────────────────────────────────────────────────────────────

type FakeEvent = {
  getId: () => string
  getSender: () => string
  isRedacted: () => boolean
  isDecryptionFailure: () => boolean
  getType: () => string
  isRelation: (t?: string) => boolean
  getContent: () => Record<string, unknown>
}
function ev(id: string, o: { sender?: string; mention?: boolean; type?: string; edit?: boolean; utd?: boolean } = {}): FakeEvent {
  return {
    getId: () => id,
    getSender: () => o.sender ?? OTHER,
    isRedacted: () => false,
    isDecryptionFailure: () => !!o.utd,
    getType: () => o.type ?? 'm.room.message',
    isRelation: (t) => !!o.edit && t === 'm.replace',
    getContent: () => ({ msgtype: 'm.text', body: 'x', ...(o.mention ? { 'm.mentions': { user_ids: [ME] } } : {}) }),
  }
}

function fakeRoom(opts: { encrypted: boolean; main?: FakeEvent[]; thread?: FakeEvent[]; read?: string[] }) {
  return {
    roomId: ROOM,
    name: 'room',
    myUserId: ME,
    getJoinRule: () => 'public',
    getCanonicalAlias: () => null,
    getMembers: () => [],
    getJoinedMembers: () => [],
    getMember: () => null,
    getJoinedMemberCount: () => 2,
    currentState: { getStateEvents: () => null },
    getLiveTimeline: () => ({ getEvents: () => opts.main ?? [] }),
    hasEncryptionStateEvent: () => opts.encrypted,
    // What the SDK would answer in an encrypted room: the server's non-zero counts were dropped.
    getUnreadNotificationCount: () => 0,
    getUnfilteredTimelineSet: () => ({ getTimelines: () => [{ getEvents: () => opts.main ?? [] }] }),
    getThreads: () => [{ events: opts.thread ?? [] }],
    hasUserReadEvent: (_me: string, id: string) => (opts.read ?? []).includes(id),
  }
}

function ctxWith(server: Parameters<NonNullable<Ctx['serverUnread']>>[0] extends string ? ReturnType<NonNullable<Ctx['serverUnread']>> : never): Ctx {
  return {
    mode: 'strict',
    telemetry: { untranslated: () => {} },
    isDm: () => false,
    myUserId: ME,
    serverUnread: () => server,
  }
}
const serverCounts = (total: number, highlight: number, threads: Array<[string, number, number]>) => ({
  room: { total, highlight },
  threads: new Map(threads.map(([id, t, h]) => [id, { total: t, highlight: h }])),
})

describe('channel count from the server, same rule in both kinds of room (ADR-068 D1/D4)', () => {
  it('count = room + Σ threads, identical for an encrypted and a cleartext room with the same server counts', () => {
    const server = serverCounts(2, 0, [
      ['$a', 1, 0],
      ['$b', 3, 0],
    ])
    for (const encrypted of [true, false]) {
      const room = fakeRoom({ encrypted })
      const ch = roomToChannel(room as never, ctxWith(server))
      expect(ch.unread.count, `encrypted=${encrypted}`).toBe(6)
    }
  })

  it('a room never seen in a sync counts 0; a ctx with no server source counts 0', () => {
    const room = fakeRoom({ encrypted: false })
    expect(roomToChannel(room as never, ctxWith(undefined)).unread).toEqual({ count: 0, mentions: 0 })
    const { serverUnread: _drop, ...noSource } = ctxWith(serverCounts(4, 1, []))
    expect(roomToChannel(room as never, noSource).unread).toEqual({ count: 0, mentions: 0 })
  })

  it('cleartext mentions = the server highlight (room + threads)', () => {
    const room = fakeRoom({ encrypted: false, main: [ev('$m', { mention: true })] })
    const server = serverCounts(1, 1, [['$a', 2, 1]])
    expect(roomToChannel(room as never, ctxWith(server)).unread.mentions).toBe(2)
  })

  it('encrypted mentions ignore the server highlight (always 0 there) and count the decrypted events in memory', () => {
    const room = fakeRoom({
      encrypted: true,
      main: [ev('$m1', { mention: true }), ev('$m2', { mention: true }), ev('$plain')],
      thread: [ev('$t1', { mention: true })],
      read: ['$m2'],
    })
    const server = serverCounts(3, 0, [['$a', 1, 0]])
    expect(roomToChannel(room as never, ctxWith(server)).unread).toEqual({ count: 4, mentions: 2 })
  })
})

describe('encryptedUnreadMentions (ADR-068 D4)', () => {
  it('skips own, read, edits, non-messages, still-encrypted and failed events; dedupes by id', () => {
    const same = ev('$dup', { mention: true })
    const room = fakeRoom({
      encrypted: true,
      main: [
        ev('$own', { mention: true, sender: ME }),
        ev('$read', { mention: true }),
        ev('$edit', { mention: true, edit: true }),
        ev('$react', { mention: true, type: 'm.reaction' }),
        ev('$enc', { type: 'm.room.encrypted' }),
        ev('$utd', { mention: true, utd: true }),
        same,
      ],
      thread: [same, ev('$thread', { mention: true })],
      read: ['$read'],
    })
    expect(encryptedUnreadMentions(room as never, ME)).toBe(2)
    expect(encryptedUnreadMentions(room as never, null)).toBe(0)
  })
})
