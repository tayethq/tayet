import { describe, it, expect, vi } from 'vitest'
import {
  PANEL_BUSY_RETRY_MS,
  PANEL_FAILED_ATTEMPTS,
  PANEL_INTERVAL_MS,
  PANEL_REEDIT_WINDOW_MS,
  createPanelCore,
  createPanelReader,
  createPanelScheduler,
  type PanelOutcome,
  type PanelVersion,
  type SetTimer,
} from '../../src/core/panels'
import { ReadError } from '../../src/core/read'
import type { SendResult } from '../../src/core/queue'
import type { WriteJob } from '../../src/core/send'
import { WriteError } from '../../src/core/write'

// ADR-091 dec. 13 (A3-6): the agent's pinned panel in the sidecar — the scheduler (budget, rotation, the
// newest version wins, messages first, the server's limit), the reader (the anchor's relations, the agent's
// own only, the latest write; nothing at rest), the re-edit on a person's entry and the facade.

const ME = '@a-abcdefghijkl:test.local'
const OTHER_AGENT = '@a-zzzzzzzzzzzz:test.local'
const ALICE = '@alice:test.local'
const COFRE = '@cofre:test.local'
const SYSTEM = '@system:test.local'
const ROOM = '!room:test.local'
const ANCHOR = '$create'
const CONV = 'CAAAAAAAAAA'

// ── A fake clock: timers fire in order as time advances (no real timer anywhere). ─────────────────────
function clock() {
  let t = 1_000_000
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  const setTimer: SetTimer = (fn, ms) => {
    const id = ++seq
    timers.set(id, { at: t + ms, fn })
    return () => timers.delete(id)
  }
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await Promise.resolve()
  }
  const advance = async (ms: number): Promise<void> => {
    const end = t + ms
    for (;;) {
      await flush()
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (next === undefined || next[1].at > end) break
      timers.delete(next[0])
      t = Math.max(t, next[1].at)
      next[1].fn()
    }
    t = end
    await flush()
  }
  return { now: () => t, setTimer, advance, flush, pending: () => timers.size }
}

// ── The scheduler ────────────────────────────────────────────────────────────────────────────────────
function scheduler(plan: Array<PanelOutcome | Promise<PanelOutcome>> = [], idle: () => boolean = () => true) {
  const c = clock()
  const writes: Array<{ roomId: string; version: PanelVersion; at: number }> = []
  const logs: Array<Record<string, unknown>> = []
  const s = createPanelScheduler({
    write: (roomId, version) => {
      writes.push({ roomId, version, at: c.now() })
      return Promise.resolve(plan.shift() ?? { kind: 'ok' })
    },
    queueIdle: idle,
    log: (l) => logs.push(l),
    now: c.now,
    setTimer: c.setTimer,
  })
  return { s, c, writes, logs }
}
const w = (text: string): PanelVersion => ({ kind: 'write', text })

describe('panel scheduler (§0.3.16 item 17; forks 2 and 4)', () => {
  it('one write every 10 s per agent: the first at once, the next a full interval later', async () => {
    const { s, c, writes } = scheduler()
    s.schedule('!a', w('1'))
    await c.advance(0)
    expect(writes).toHaveLength(1)
    s.schedule('!a', w('2'))
    await c.advance(PANEL_INTERVAL_MS - 1)
    expect(writes).toHaveLength(1)
    await c.advance(1)
    expect(writes.map((x) => (x.version as { text: string }).text)).toEqual(['1', '2'])
    expect(writes[1]!.at - writes[0]!.at).toBe(PANEL_INTERVAL_MS)
  })

  it('rotation among three conversations, one write per interval', async () => {
    const { s, c, writes } = scheduler()
    s.schedule('!a', w('a1'))
    s.schedule('!b', w('b1'))
    s.schedule('!c', w('c1'))
    await c.advance(0)
    s.schedule('!a', w('a2'))
    await c.advance(3 * PANEL_INTERVAL_MS)
    expect(writes.map((x) => x.roomId)).toEqual(['!a', '!b', '!c', '!a'])
    expect(writes.map((x) => x.at - writes[0]!.at)).toEqual([0, 1, 2, 3].map((n) => n * PANEL_INTERVAL_MS))
  })

  it('the newest version replaces the pending one and keeps its place in the rotation', async () => {
    const { s, c, writes } = scheduler()
    s.schedule('!a', w('a1'))
    await c.advance(0)
    s.schedule('!b', w('b1'))
    s.schedule('!c', w('c1'))
    s.schedule('!b', w('b2'))
    s.schedule('!b', w('b3'))
    await c.advance(2 * PANEL_INTERVAL_MS)
    expect(writes.map((x) => `${x.roomId}:${(x.version as { text: string }).text}`)).toEqual(['!a:a1', '!b:b3', '!c:c1'])
  })

  it('a clear replaces a write and a write replaces a clear', async () => {
    const { s, c, writes } = scheduler()
    s.schedule('!x', w('busy'))
    await c.advance(0)
    s.schedule('!a', w('a1'))
    s.schedule('!a', { kind: 'clear' })
    s.schedule('!b', { kind: 'clear' })
    s.schedule('!b', w('b1'))
    await c.advance(2 * PANEL_INTERVAL_MS)
    expect(writes.slice(1).map((x) => [x.roomId, x.version])).toEqual([
      ['!a', { kind: 'clear' }],
      ['!b', { kind: 'write', text: 'b1' }],
    ])
  })

  it('messages first: with the write queue busy it looks again every 1 s and keeps its turn', async () => {
    let idle = false
    const { s, c, writes } = scheduler([], () => idle)
    s.schedule('!a', w('a1'))
    await c.advance(0)
    expect(writes).toHaveLength(0)
    await c.advance(3 * PANEL_BUSY_RETRY_MS)
    expect(writes).toHaveLength(0)
    s.schedule('!b', w('b1'))
    idle = true
    await c.advance(PANEL_BUSY_RETRY_MS)
    expect(writes.map((x) => x.roomId)).toEqual(['!a'])
    expect(s.pending('!a')).toBe(false)
    expect(s.pending('!b')).toBe(true)
  })

  it('the server’s limit keeps the version pending and the next attempt waits retryAfterMs (no 30 s deadline)', async () => {
    const { s, c, writes, logs } = scheduler([{ kind: 'rate-limited', retryAfterMs: 45_000 }, { kind: 'rate-limited', retryAfterMs: 20_000 }])
    s.schedule('!a', w('a1'))
    s.schedule('!b', w('b1'))
    await c.advance(0)
    expect(writes).toHaveLength(1)
    expect(s.pending('!a')).toBe(true)
    await c.advance(45_000 - 1)
    expect(writes).toHaveLength(1)
    await c.advance(1)
    // The conversation kept its turn.
    expect(writes.map((x) => x.roomId)).toEqual(['!a', '!a'])
    await c.advance(20_000)
    expect(writes.map((x) => x.roomId)).toEqual(['!a', '!a', '!a'])
    await c.advance(PANEL_INTERVAL_MS)
    expect(writes.map((x) => x.roomId)).toEqual(['!a', '!a', '!a', '!b'])
    expect(logs.filter((l) => l.evt === 'panel-ratelimited')).toEqual([
      { evt: 'panel-ratelimited', retryAfterMs: 45_000 },
      { evt: 'panel-ratelimited', retryAfterMs: 20_000 },
    ])
  })

  it('a newer version that arrives during a limited attempt wins over the one handed back', async () => {
    let release!: (o: PanelOutcome) => void
    const { s, c, writes } = scheduler([new Promise<PanelOutcome>((r) => (release = r))])
    s.schedule('!a', w('old'))
    await c.advance(0)
    s.schedule('!a', w('new'))
    release({ kind: 'rate-limited', retryAfterMs: 1_000 })
    await c.advance(PANEL_INTERVAL_MS)
    expect(writes.map((x) => (x.version as { text: string }).text)).toEqual(['old', 'new'])
  })

  it('not a member any more: the version is dropped with one line and no id', async () => {
    const { s, c, writes, logs } = scheduler([{ kind: 'not-member' }])
    s.schedule(ROOM, w('a1'))
    await c.advance(0)
    expect(s.pending(ROOM)).toBe(false)
    await c.advance(5 * PANEL_INTERVAL_MS)
    expect(writes).toHaveLength(1)
    expect(logs).toEqual([{ evt: 'panel-dropped', reason: 'not-member' }])
    expect(JSON.stringify(logs)).not.toContain(ROOM)
  })

  it('another failure is tried again at later turns and dropped after the last attempt', async () => {
    const { s, c, writes, logs } = scheduler(Array.from({ length: PANEL_FAILED_ATTEMPTS }, () => ({ kind: 'failed' as const })))
    s.schedule('!a', w('a1'))
    await c.advance(10 * PANEL_INTERVAL_MS)
    expect(writes).toHaveLength(PANEL_FAILED_ATTEMPTS)
    expect(logs).toEqual([{ evt: 'panel-dropped', reason: 'failed' }])
  })

  it('a revocation (or a stop) stops it: what is pending is lost, nothing is written after', async () => {
    const { s, c, writes } = scheduler([{ kind: 'stop' }])
    s.schedule('!a', w('a1'))
    s.schedule('!b', w('b1'))
    await c.advance(0)
    expect(s.pending('!b')).toBe(false)
    s.schedule('!c', w('c1'))
    await c.advance(5 * PANEL_INTERVAL_MS)
    expect(writes.map((x) => x.roomId)).toEqual(['!a'])
    expect(c.pending()).toBe(0)
  })
})

// ── Fakes of the protocol side ───────────────────────────────────────────────────────────────────────
interface Ev {
  id: string
  sender: string
  ts: number
  content?: Record<string, unknown>
  utd?: boolean
  redacted?: boolean
}
const fakeEvent = (e: Ev) => ({
  getId: () => e.id,
  getSender: () => e.sender,
  getTs: () => e.ts,
  isRedacted: () => e.redacted === true,
  isDecryptionFailure: () => e.utd === true,
  isEncrypted: () => true,
  getClearContent: () => (e.utd === true ? null : {}),
  getContent: () => e.content ?? {},
  getOriginalContent: () => e.content ?? {},
})

const panelContent = (text: string, title?: string, cleared = false) => ({
  msgtype: 'io.tayet.panel',
  body: text,
  'io.tayet.panel': { ...(title !== undefined && { title }), ...(cleared && { cleared: true }) },
})
const editContent = (text: string, title?: string, cleared = false) => ({ msgtype: 'io.tayet.panel', body: `* ${text}`, 'm.new_content': panelContent(text, title, cleared) })

interface World {
  anchor: Ev[][]
  edits: Record<string, Ev[]>
  events: Record<string, Ev>
  member: boolean
}

function world(init: Partial<World> = {}) {
  const w: World = { anchor: [[]], edits: {}, events: {}, member: true, ...init }
  const calls = { anchor: 0, edits: 0, event: 0 }
  const room = {
    roomId: ROOM,
    getMyMembership: () => (w.member ? 'join' : 'leave'),
    currentState: { getStateEvents: (type: string) => (type === 'm.room.create' ? { getId: () => ANCHOR } : null) },
  }
  const client = {
    getUserId: () => ME,
    getRoom: (id: string) => (id === ROOM ? room : null),
    fetchRelations: vi.fn((_r: string, target: string, relType: string, _t: unknown, opts: { dir?: string; from?: string }) => {
      expect(opts.dir).toBe('f')
      if (relType === 'm.replace') {
        calls.edits += 1
        return Promise.resolve({ chunk: w.edits[target] ?? [] })
      }
      expect(target).toBe(ANCHOR)
      expect(relType).toBe('io.tayet.panel')
      calls.anchor += 1
      const i = opts.from === undefined ? 0 : Number(opts.from)
      return Promise.resolve({ chunk: w.anchor[i] ?? [], ...(i + 1 < w.anchor.length && { next_batch: String(i + 1) }) })
    }),
    fetchRoomEvent: vi.fn((_r: string, id: string) => {
      calls.event += 1
      const e = w.events[id] ?? w.anchor.flat().find((x) => x.id === id)
      return e === undefined ? Promise.reject(new Error('404')) : Promise.resolve(e)
    }),
    getEventMapper: () => (raw: Ev) => fakeEvent(raw),
    decryptEventIfNeeded: () => Promise.resolve(),
  }
  return { w, room, client: client as never, calls }
}

describe('panel reader: the anchor’s relations, nothing at rest (fork 1)', () => {
  it('no panel → null', async () => {
    const { client } = world()
    expect(await createPanelReader(client, () => ME).find(ROOM)).toBeNull()
  })

  it('one panel, paged: the original shown when it has no edit; the id is kept in memory', async () => {
    const p = { id: '$p', sender: ME, ts: 10, content: panelContent('oi', 'Status') }
    const { client, calls } = world({ anchor: [[{ id: '$x', sender: ALICE, ts: 1 }], [p]] })
    const reader = createPanelReader(client, () => ME)
    expect(await reader.find(ROOM)).toEqual({ eventId: '$p', writtenAt: 10, shown: { content: panelContent('oi', 'Status'), at: 10 } })
    expect(calls.anchor).toBe(2)
    await reader.find(ROOM)
    expect(calls.anchor).toBe(2)
  })

  it('the agent’s own latest edit is what it shows; another account’s edit never counts', async () => {
    const p = { id: '$p', sender: ME, ts: 10, content: panelContent('v1') }
    const { client } = world({
      anchor: [[p]],
      edits: { $p: [{ id: '$e1', sender: ME, ts: 20, content: editContent('v2') }, { id: '$f', sender: ALICE, ts: 30, content: editContent('forged') }] },
    })
    expect(await createPanelReader(client, () => ME).find(ROOM)).toEqual({ eventId: '$p', writtenAt: 20, shown: { content: panelContent('v2'), at: 20 } })
  })

  it('two panels of the same agent → the latest write wins; another agent’s panel is ignored', async () => {
    const old = { id: '$old', sender: ME, ts: 10, content: panelContent('old') }
    const recent = { id: '$new', sender: ME, ts: 15, content: panelContent('new') }
    const theirs = { id: '$theirs', sender: OTHER_AGENT, ts: 99, content: panelContent('theirs') }
    const { client } = world({ anchor: [[old, recent, theirs]], edits: { $old: [{ id: '$oe', sender: ME, ts: 50, content: editContent('old edited') }] } })
    const found = await createPanelReader(client, () => ME).find(ROOM)
    expect(found?.eventId).toBe('$old')
    expect(found?.writtenAt).toBe(50)
  })

  it('a cleared panel is found with the mark; a content that does not decrypt is found without `shown`', async () => {
    const cleared = world({ anchor: [[{ id: '$p', sender: ME, ts: 10, content: panelContent('x') }]], edits: { $p: [{ id: '$c', sender: ME, ts: 20, content: editContent('', undefined, true) }] } })
    expect((await createPanelReader(cleared.client, () => ME).find(ROOM))?.shown?.content).toEqual(panelContent('', undefined, true))
    const lost = world({ anchor: [[{ id: '$p', sender: ME, ts: 10, utd: true }]], edits: { $p: [{ id: '$e', sender: ME, ts: 20, utd: true }] } })
    expect(await createPanelReader(lost.client, () => ME).find(ROOM)).toEqual({ eventId: '$p', writtenAt: 20 })
  })
})

// ── The core ─────────────────────────────────────────────────────────────────────────────────────────
function core(init: Partial<World> = {}, opts: { idle?: () => boolean; results?: SendResult[]; random?: () => number } = {}) {
  const c = clock()
  const wd = world(init)
  const jobs: WriteJob[] = []
  const logs: Array<Record<string, unknown>> = []
  let n = 0
  const resolver = {
    roomAnyOf: (token: string) => {
      if (token !== CONV) throw new ReadError('conversation_not_found')
      return wd.room
    },
    tokenOfRoom: () => CONV,
  }
  const p = createPanelCore({
    client: wd.client,
    resolver: resolver as never,
    enqueue: (job) => {
      jobs.push(job)
      const r = opts.results?.shift() ?? { ok: true as const, messageId: `$sent${++n}` }
      // The server now holds a new panel message (an edit is not read back by these tests unless set).
      const content = contentOf(job)
      if (r.ok && (content['m.relates_to'] as { rel_type?: string }).rel_type === 'io.tayet.panel') wd.w.events[r.messageId] = { id: r.messageId, sender: ME, ts: c.now(), content }
      return Promise.resolve(r)
    },
    queueIdle: opts.idle ?? (() => true),
    accounts: () => ({ custodian: COFRE, systemAccount: SYSTEM }),
    log: (l) => logs.push(l),
    now: c.now,
    setTimer: c.setTimer,
    random: opts.random ?? (() => 0.5),
  })
  return { p, c, wd, jobs, logs }
}
const contentOf = (job: WriteJob | undefined) => (job as { content: Record<string, unknown> }).content

const joinEvent = (userId: string, prev?: string) => ({
  getType: () => 'm.room.member',
  getStateKey: () => userId,
  getContent: () => ({ membership: 'join' }),
  getPrevContent: () => (prev !== undefined ? { membership: prev } : {}),
  // The agent's membership at the event (MSC4115): already in the conversation.
  getMembershipAtEvent: () => 'join',
})

describe('panel core: writing (§2 of the slice)', () => {
  it('no panel → a new message related to the anchor; later writes edit it (the id this run sent)', async () => {
    const { p, c, jobs } = core()
    expect(await p.facade.set(CONV, { text: 'v1', title: 'Status' })).toEqual({ conversation: CONV, pending: true })
    await c.advance(0)
    expect(jobs[0]).toMatchObject({ kind: 'panel', channel: ROOM })
    expect(contentOf(jobs[0])).toMatchObject({ msgtype: 'io.tayet.panel', body: 'v1', 'io.tayet.panel': { title: 'Status' }, 'm.relates_to': { rel_type: 'io.tayet.panel', event_id: ANCHOR } })
    await p.facade.set(CONV, { text: 'v2' })
    await c.advance(PANEL_INTERVAL_MS)
    expect(contentOf(jobs[1])).toMatchObject({ 'm.new_content': { body: 'v2', 'io.tayet.panel': {} }, 'm.relates_to': { rel_type: 'm.replace', event_id: '$sent1' } })
  })

  it('DELETE edits with the clear mark; a write after the clear is another edit of the same message', async () => {
    const p0 = { id: '$p', sender: ME, ts: 10, content: panelContent('x') }
    const { p, c, wd, jobs } = core({ anchor: [[p0]] })
    expect(await p.facade.clear(CONV)).toEqual({ conversation: CONV, pending: true })
    await c.advance(0)
    expect(contentOf(jobs[0])).toMatchObject({ 'm.new_content': { body: '', 'io.tayet.panel': { cleared: true } }, 'm.relates_to': { event_id: '$p' } })
    wd.w.edits.$p = [{ id: '$c', sender: ME, ts: 20, content: editContent('', undefined, true) }]
    await p.facade.set(CONV, { text: 'back' })
    await c.advance(PANEL_INTERVAL_MS)
    expect(contentOf(jobs[1])).toMatchObject({ 'm.new_content': { body: 'back' }, 'm.relates_to': { rel_type: 'm.replace', event_id: '$p' } })
  })

  it('DELETE with no panel, or already cleared, and nothing pending → nothing to do; with a write pending → the clear replaces it', async () => {
    const none = core()
    expect(await none.p.facade.clear(CONV)).toEqual({ conversation: CONV, pending: false })
    const done = core({ anchor: [[{ id: '$p', sender: ME, ts: 10, content: panelContent('') }]], edits: { $p: [{ id: '$c', sender: ME, ts: 20, content: editContent('', undefined, true) }] } })
    expect(await done.p.facade.clear(CONV)).toEqual({ conversation: CONV, pending: false })
    const busy = core({}, { idle: () => false })
    await busy.p.facade.set(CONV, { text: 'x' })
    expect(await busy.p.facade.clear(CONV)).toEqual({ conversation: CONV, pending: true })
    expect(busy.jobs).toHaveLength(0)
  })

  it('validation before anything is queued: membership, text, title', async () => {
    const { p, c, jobs, wd } = core()
    const code = async (f: () => Promise<unknown>): Promise<string> => f().then(() => 'ok', (e: ReadError | WriteError) => e.code)
    expect(await code(() => p.facade.set('CBBBBBBBBBB', { text: 'x' }))).toBe('conversation_not_found')
    expect(await code(() => p.facade.set(CONV, { text: '  ' }))).toBe('invalid_argument')
    expect(await code(() => p.facade.set(CONV, { text: 'x'.repeat(8 * 1024 + 1) }))).toBe('invalid_argument')
    expect(await code(() => p.facade.set(CONV, { text: 'x', title: 'a\nb' }))).toBe('invalid_argument')
    expect(await code(() => p.facade.set(CONV, { text: 'x', title: 't'.repeat(76) }))).toBe('invalid_argument')
    expect(await code(() => p.facade.set(CONV, { text: 'x'.repeat(8 * 1024), title: 't'.repeat(75) }))).toBe('ok')
    wd.w.member = false
    expect(await code(() => p.facade.set(CONV, { text: 'x' }))).toBe('not_member')
    expect(await code(() => p.facade.clear(CONV))).toBe('not_member')
    expect(await code(() => p.facade.get(CONV))).toBe('conversation_not_found')
    await c.advance(0)
    // The one accepted write met a conversation the agent had left by its turn: dropped.
    expect(jobs).toHaveLength(0)
  })

  it('GET: the panel, null when cleared, `unreadable` when it does not decrypt, and `pending`', async () => {
    const p0 = { id: '$p', sender: ME, ts: 10, content: panelContent('**oi**', 'Status') }
    const { p, c, wd } = core({ anchor: [[p0]] }, { idle: () => false })
    expect(await p.facade.get(CONV)).toEqual({ conversation: CONV, panel: { title: 'Status', text: '**oi**', updatedAt: 10 }, pending: false })
    await p.facade.set(CONV, { text: 'next' })
    await c.advance(0)
    expect((await p.facade.get(CONV)).pending).toBe(true)
    wd.w.edits.$p = [{ id: '$c', sender: ME, ts: 20, content: editContent('', undefined, true) }]
    expect(await p.facade.get(CONV)).toMatchObject({ panel: null })
    wd.w.edits.$p = [{ id: '$e', sender: ME, ts: 30, utd: true }]
    expect(await p.facade.get(CONV)).toMatchObject({ panel: null, unreadable: true })
  })

  it('the server’s limit through the queue keeps the version pending; a revoked queue stops the core', async () => {
    const { p, c, jobs } = core({}, { results: [{ ok: false, error: { kind: 'rate-limited', retryAfterMs: 15_000 } }, { ok: false, error: { kind: 'revoked' } }] })
    await p.facade.set(CONV, { text: 'x' })
    await c.advance(0)
    expect((await p.facade.get(CONV)).pending).toBe(true)
    await c.advance(15_000)
    expect(jobs).toHaveLength(2)
    expect((await p.facade.get(CONV)).pending).toBe(false)
    await p.facade.set(CONV, { text: 'y' })
    await c.advance(5 * PANEL_INTERVAL_MS)
    expect(jobs).toHaveLength(2)
  })
})

describe('panel core: the re-edit on a person’s entry (§0.3.16 item 16; fork 2)', () => {
  const shown = { id: '$p', sender: ME, ts: 10, content: panelContent('estado', 'Status') }

  it('one entry → after the random delay, the same content and title as an edit', async () => {
    const { p, c, wd, jobs } = core({ anchor: [[shown]] }, { random: () => 0.25 })
    p.noteEvent(joinEvent(ALICE, 'invite') as never, wd.room as never)
    await c.advance(PANEL_REEDIT_WINDOW_MS * 0.25 - 1)
    expect(jobs).toHaveLength(0)
    await c.advance(1)
    expect(contentOf(jobs[0])).toMatchObject({ 'm.new_content': { body: 'estado', 'io.tayet.panel': { title: 'Status' } }, 'm.relates_to': { rel_type: 'm.replace', event_id: '$p' } })
  })

  it('several entries inside the window → one re-edit', async () => {
    const { p, c, wd, jobs } = core({ anchor: [[shown]] }, { random: () => 0.9 })
    p.noteEvent(joinEvent(ALICE) as never, wd.room as never)
    await c.advance(1_000)
    p.noteEvent(joinEvent('@bob:test.local') as never, wd.room as never)
    p.noteEvent(joinEvent('@carol:test.local', 'leave') as never, wd.room as never)
    await c.advance(PANEL_REEDIT_WINDOW_MS + PANEL_INTERVAL_MS)
    expect(jobs).toHaveLength(1)
  })

  it('an agent, an infrastructure account, the agent itself, or a name change (join → join) → no re-edit', async () => {
    const { p, c, wd, jobs } = core({ anchor: [[shown]] })
    for (const who of [OTHER_AGENT, COFRE, SYSTEM, ME]) p.noteEvent(joinEvent(who) as never, wd.room as never)
    p.noteEvent(joinEvent(ALICE, 'join') as never, wd.room as never)
    p.noteEvent({ ...joinEvent(ALICE), getContent: () => ({ membership: 'invite' }) } as never, wd.room as never)
    await c.advance(2 * PANEL_REEDIT_WINDOW_MS)
    expect(jobs).toHaveLength(0)
  })

  it('a cleared panel, or none → no re-edit', async () => {
    const cleared = core({ anchor: [[shown]], edits: { $p: [{ id: '$c', sender: ME, ts: 20, content: editContent('', undefined, true) }] } })
    cleared.p.noteEvent(joinEvent(ALICE) as never, cleared.wd.room as never)
    await cleared.c.advance(2 * PANEL_REEDIT_WINDOW_MS)
    expect(cleared.jobs).toHaveLength(0)
    const none = core()
    none.p.noteEvent(joinEvent(ALICE) as never, none.wd.room as never)
    await none.c.advance(2 * PANEL_REEDIT_WINDOW_MS)
    expect(none.jobs).toHaveLength(0)
  })

  it('a PUT inside the window cancels the re-edit (only the PUT goes out)', async () => {
    const { p, c, wd, jobs } = core({ anchor: [[shown]] }, { random: () => 0.5 })
    p.noteEvent(joinEvent(ALICE) as never, wd.room as never)
    await c.advance(1_000)
    await p.facade.set(CONV, { text: 'novo' })
    await c.advance(2 * PANEL_REEDIT_WINDOW_MS + PANEL_INTERVAL_MS)
    expect(jobs).toHaveLength(1)
    expect(contentOf(jobs[0])).toMatchObject({ 'm.new_content': { body: 'novo' } })
  })

  it('a content that does not decrypt (lost store) → skipped with one line, nothing written', async () => {
    const { p, c, wd, jobs, logs } = core({ anchor: [[{ id: '$p', sender: ME, ts: 10, utd: true }]] })
    p.noteEvent(joinEvent(ALICE) as never, wd.room as never)
    await c.advance(2 * PANEL_REEDIT_WINDOW_MS)
    expect(jobs).toHaveLength(0)
    expect(logs).toEqual([{ evt: 'panel-reedit-skipped' }])
  })

  it('the re-edit shares the budget: right after a write it waits for the interval', async () => {
    const { p, c, wd, jobs } = core({ anchor: [[shown]] }, { random: () => 0 })
    await p.facade.set(CONV, { text: 'v1' })
    await c.advance(0)
    expect(jobs).toHaveLength(1)
    // The read after the write sees the agent's edit.
    wd.w.edits.$p = [{ id: '$e', sender: ME, ts: 20, content: editContent('v1') }]
    p.noteEvent(joinEvent(ALICE) as never, wd.room as never)
    await c.advance(PANEL_INTERVAL_MS - 1)
    expect(jobs).toHaveLength(1)
    await c.advance(1)
    expect(contentOf(jobs[1])).toMatchObject({ 'm.new_content': { body: 'v1' } })
  })

  it('stop: the pending re-edit and versions are lost', async () => {
    const { p, c, wd, jobs } = core({ anchor: [[shown]] })
    p.noteEvent(joinEvent(ALICE) as never, wd.room as never)
    p.stop()
    await c.advance(2 * PANEL_REEDIT_WINDOW_MS)
    expect(jobs).toHaveLength(0)
    expect(c.pending()).toBe(0)
  })
})
