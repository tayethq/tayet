import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ANCHORED_BUSY_RETRY_MS, ANCHORED_INTERVAL_MS, createAnchoredScheduler, type AnchoredOutcome, type SetTimer } from '../../src/core/anchored'
import { createCommandsCore, hashOf, validateCommands } from '../../src/core/commands'
import { declareAtBoot } from '../../src/slack-manifest'
import { PANEL_REEDIT_WINDOW_MS, createPanelCore } from '../../src/core/panels'
import type { SendResult } from '../../src/core/queue'
import type { WriteJob } from '../../src/core/send'
import { WriteError } from '../../src/core/write'

// ADR-093 (A4-2a; PLANO-AGENTES §0.3.22): the agent's commands in the sidecar — the strict validation, the
// file, the distribution over the conversations, clearing, the scheduler the panel shares, and the re-edit on
// a person's entry.

const ME = '@a-abcdefghijkl:test.local'
const ALICE = '@alice:test.local'
const COFRE = '@cofre:test.local'
const SYSTEM = '@system:test.local'
const CMD_REL = 'io.tayet.commands'
const PANEL_REL = 'io.tayet.panel'
const TOKENS: Record<string, string> = { '!a:test.local': 'CAAAAAAAAAA', '!b:test.local': 'CBBBBBBBBBB', '!c:test.local': 'CCCCCCCCCCC' }
const [A, B, C] = Object.keys(TOKENS) as [string, string, string]

const ping = { name: 'ping', description: 'Pong' }
const deploy = { name: 'deploy', description: 'Publicar', hint: '<ambiente>' }

// ── A fake clock: timers fire in order as time advances. ──────────────────────────────────────────────
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
    for (let i = 0; i < 40; i++) await Promise.resolve()
    await new Promise((r) => setImmediate(r))
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
  return { now: () => t, setTimer, advance, pending: () => timers.size }
}

// ── Validation (§0.3.21 item 4) ──────────────────────────────────────────────────────────────────────
describe('commands: strict validation', () => {
  const bad = (raw: unknown): string => {
    try {
      validateCommands(raw)
      return 'accepted'
    } catch (err) {
      return (err as WriteError).code
    }
  }

  it('each limit of the name, the description and the hint; the count; repeated names; unknown fields', () => {
    expect(validateCommands([{ name: 'a', description: 'x' }, { name: '9_-z'.padEnd(32, 'z'), description: 'é'.repeat(100), hint: 'h'.repeat(60) }])).toHaveLength(2)
    for (const name of ['', '/ping', 'Ping', '-ping', '_ping', 'a'.repeat(33), 'pïng', 'pi ng', 3]) expect(bad([{ name, description: 'x' }]), String(name)).toBe('invalid_argument')
    for (const description of ['', '   ', 'a'.repeat(101), 'a\nb', undefined, 5]) expect(bad([{ name: 'a', description }]), String(description)).toBe('invalid_argument')
    for (const hint of ['a'.repeat(61), 'a\nb', null, 1]) expect(bad([{ name: 'a', description: 'x', hint }]), String(hint)).toBe('invalid_argument')
    expect(bad(Array.from({ length: 26 }, (_, i) => ({ name: `c${i}`, description: 'x' })))).toBe('invalid_argument')
    expect(validateCommands(Array.from({ length: 25 }, (_, i) => ({ name: `c${i}`, description: 'x' })))).toHaveLength(25)
    expect(bad([ping, { ...ping, description: 'outra' }])).toBe('invalid_argument')
    expect(bad([{ ...ping, mentions: [] }])).toBe('invalid_argument')
    expect(bad(['ping'])).toBe('invalid_argument')
    expect(bad({ commands: [] })).toBe('invalid_argument')
  })

  it('normalized: description and hint trimmed, a blank hint left out; over 8 KiB → payload_too_large', () => {
    expect(validateCommands([{ name: 'a', description: '  x  ', hint: '  ' }, { name: 'b', description: 'y', hint: ' <z> ' }])).toEqual([
      { name: 'a', description: 'x' },
      { name: 'b', description: 'y', hint: '<z>' },
    ])
    const full = (ch: string) => Array.from({ length: 25 }, (_, i) => ({ name: `c${i}`.padEnd(32, 'x'), description: ch.repeat(100), hint: ch.repeat(60) }))
    expect(validateCommands(full('a'))).toHaveLength(25)
    expect(bad(full('é'))).toBe('payload_too_large')
  })
})

// ── The fake protocol side: rooms, the anchor's relations and edits as the server keeps them ─────────
interface Ev {
  id: string
  sender: string
  ts: number
  content: Record<string, unknown>
}

function world() {
  const c = clock()
  const membership = new Map<string, string>([
    [A, 'join'],
    [B, 'join'],
  ])
  // relType → room → messages related to the anchor; target → edits.
  const anchored: Record<string, Record<string, Ev[]>> = { [CMD_REL]: {}, [PANEL_REL]: {} }
  const edits: Record<string, Ev[]> = {}
  const events: Record<string, Ev> = {}
  const relations = { count: 0 }
  let n = 0
  const room = (roomId: string) => ({
    roomId,
    getMyMembership: () => membership.get(roomId) ?? 'leave',
    currentState: { getStateEvents: (type: string) => (type === 'm.room.create' ? { getId: () => `$create-${roomId}` } : null) },
  })
  const fake = (e: Ev) => ({
    getId: () => e.id,
    getSender: () => e.sender,
    getTs: () => e.ts,
    isRedacted: () => false,
    isDecryptionFailure: () => false,
    isEncrypted: () => true,
    getClearContent: () => ({}),
    getContent: () => e.content,
    getOriginalContent: () => e.content,
  })
  const client = {
    getUserId: () => ME,
    getRoom: (id: string) => (id in TOKENS ? room(id) : null),
    getRooms: () => Object.keys(TOKENS).map(room),
    fetchRelations: vi.fn((roomId: string, target: string, relType: string) => {
      relations.count += 1
      if (relType === 'm.replace') return Promise.resolve({ chunk: edits[target] ?? [] })
      expect(target).toBe(`$create-${roomId}`)
      return Promise.resolve({ chunk: anchored[relType]?.[roomId] ?? [] })
    }),
    fetchRoomEvent: (_r: string, id: string) => (events[id] !== undefined ? Promise.resolve(events[id]) : Promise.reject(new Error('404'))),
    getEventMapper: () => (raw: Ev) => fake(raw),
    decryptEventIfNeeded: () => Promise.resolve(),
  }
  const jobs: Array<{ kind: string; roomId: string; content: Record<string, unknown> }> = []
  const results: SendResult[] = []
  const enqueue = (job: WriteJob): Promise<SendResult> => {
    const { channel, content } = job as { channel: string; content: Record<string, unknown> }
    jobs.push({ kind: job.kind, roomId: channel, content })
    const r = results.shift() ?? { ok: true as const, messageId: `$m${++n}` }
    if (r.ok) {
      const ev = { id: r.messageId, sender: ME, ts: c.now() + n, content }
      events[ev.id] = ev
      const rel = content['m.relates_to'] as { rel_type: string; event_id: string }
      if (rel.rel_type === 'm.replace') (edits[rel.event_id] ??= []).push(ev)
      else ((anchored[rel.rel_type] as Record<string, Ev[]>)[channel] ??= []).push(ev)
    }
    return Promise.resolve(r)
  }
  return { c, client, membership, jobs, results, enqueue, relations, room }
}

type World = ReturnType<typeof world>

let dir: string
const live: Array<{ idle(): Promise<void>; stop(): Promise<void> }> = []
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'commands-'))
})
afterEach(async () => {
  for (const k of live.splice(0)) await k.stop()
  await rm(dir, { recursive: true, force: true })
})

function core(wd: World = world(), opts: { idle?: () => boolean; panel?: boolean; random?: () => number } = {}) {
  const logs: Array<Record<string, unknown>> = []
  const log = (l: Record<string, unknown>) => logs.push(l)
  const scheduler = createAnchoredScheduler(['panel', 'commands'], { queueIdle: opts.idle ?? (() => true), log, now: wd.c.now, setTimer: wd.c.setTimer })
  const resolver = { tokenOfRoom: (roomId: string) => TOKENS[roomId] as string, roomAnyOf: () => wd.room(A) }
  const panels =
    opts.panel === true
      ? createPanelCore({
          client: wd.client as never,
          resolver: resolver as never,
          enqueue: wd.enqueue,
          queueIdle: () => true,
          accounts: () => ({ custodian: COFRE, systemAccount: SYSTEM }),
          log,
          scheduler,
          afterEntry: (roomId) => commandsCore.entry(roomId),
          setTimer: wd.c.setTimer,
          random: opts.random ?? (() => 0.5),
        })
      : undefined
  const file = join(dir, 'commands.json')
  const commandsCore = createCommandsCore({ client: wd.client as never, resolver, enqueue: wd.enqueue, scheduler, file, log })
  live.push(commandsCore)
  return { k: commandsCore, panels, wd, logs, file, scheduler }
}

const blockOf = (content: Record<string, unknown>) => {
  const shown = (content['m.new_content'] as Record<string, unknown> | undefined) ?? content
  return shown['io.tayet.commands'] as { commands?: unknown[]; cleared?: true }
}
const fileOf = async (file: string) => JSON.parse(await readFile(file, 'utf8')) as { commands: unknown[]; written: Record<string, string> }

// `at`: the agent's membership at the event, as the server sends it (MSC4115); null → the server sends none.
const joinEvent = (userId: string, at: string | null = 'join') => ({
  getType: () => 'm.room.member',
  getStateKey: () => userId,
  getContent: () => ({ membership: 'join' }),
  getPrevContent: () => ({}),
  getMembershipAtEvent: () => at ?? undefined,
})

describe('commands: the file (§0.3.22 item 2)', () => {
  it('atomic, 0600, the set and the hash per conversation token — never a protocol id', async () => {
    const { k, wd, file } = core()
    expect(await k.facade.set([deploy])).toEqual({ pending: 2 })
    await wd.c.advance(ANCHORED_INTERVAL_MS)
    await k.idle()
    const saved = await fileOf(file)
    expect(saved).toEqual({ commands: [deploy], written: { CAAAAAAAAAA: hashOf([deploy]), CBBBBBBBBBB: hashOf([deploy]) } })
    expect(((await stat(file)).mode & 0o777).toString(8)).toBe('600')
    const raw = await readFile(file, 'utf8')
    for (const id of [A, B, ME, '$m1', '$create']) expect(raw).not.toContain(id)
  })

  it('load: a file of an earlier run is the set; an unreadable one is ignored whole, with one line', async () => {
    await writeFile(join(dir, 'commands.json'), JSON.stringify({ commands: [ping], written: { CAAAAAAAAAA: hashOf([ping]) } }))
    const first = core()
    await first.k.load()
    expect(first.k.facade.get()).toEqual({ commands: [ping], pending: 0 })
    await writeFile(join(dir, 'commands.json'), JSON.stringify({ commands: [{ name: 'BAD', description: 'x' }], written: { CAAAAAAAAAA: 'h' } }))
    const second = core()
    await second.k.load()
    expect(second.k.facade.get().commands).toEqual([])
    expect(second.logs).toEqual([{ evt: 'commands-file-unreadable' }])
    second.k.reconcile()
    await second.wd.c.advance(3 * ANCHORED_INTERVAL_MS)
    expect(second.wd.jobs).toEqual([])
  })
})

describe('commands: distribution (§0.3.22 items 3 and 5)', () => {
  it('declare → a new manifest in each conversation (the anchor’s relation), one every 10 s; then edits of the same message', async () => {
    const { k, wd } = core()
    expect(await k.facade.set([ping])).toEqual({ pending: 2 })
    await wd.c.advance(0)
    expect(wd.jobs).toHaveLength(1)
    expect(k.facade.get().pending).toBe(1)
    await wd.c.advance(ANCHORED_INTERVAL_MS)
    expect(wd.jobs.map((j) => [j.kind, j.roomId, (j.content['m.relates_to'] as { rel_type: string }).rel_type])).toEqual([
      ['commands', A, CMD_REL],
      ['commands', B, CMD_REL],
    ])
    expect(blockOf(wd.jobs[0]!.content)).toEqual({ commands: [ping] })
    expect(k.facade.get().pending).toBe(0)
    await k.facade.set([ping, deploy])
    await wd.c.advance(2 * ANCHORED_INTERVAL_MS)
    expect(wd.jobs.slice(2).map((j) => [j.roomId, j.content['m.relates_to']])).toEqual([
      [A, { rel_type: 'm.replace', event_id: '$m1' }],
      [B, { rel_type: 'm.replace', event_id: '$m2' }],
    ])
    expect(blockOf(wd.jobs[2]!.content)).toEqual({ commands: [ping, deploy] })
  })

  it('declaring the same set again writes nothing (file nor manifest); a set back to the written one unmarks the pending', async () => {
    const { k, wd, file } = core()
    await k.facade.set([ping])
    await wd.c.advance(2 * ANCHORED_INTERVAL_MS)
    await k.idle()
    const before = await stat(file)
    expect(await k.facade.set([{ ...ping }])).toEqual({ pending: 0 })
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs)
    await k.facade.set([deploy])
    expect(await k.facade.set([ping])).toEqual({ pending: 0 })
    await wd.c.advance(3 * ANCHORED_INTERVAL_MS)
    expect(wd.jobs).toHaveLength(2)
  })

  it('entering a conversation marks it; leaving one drops its pending version and its hash', async () => {
    const { k, wd, file } = core()
    await k.facade.set([ping])
    await wd.c.advance(2 * ANCHORED_INTERVAL_MS)
    wd.membership.set(C, 'join')
    k.noteMembership(C, 'join')
    await wd.c.advance(ANCHORED_INTERVAL_MS)
    expect(wd.jobs.map((j) => j.roomId)).toEqual([A, B, C])
    await k.facade.set([deploy])
    wd.membership.set(B, 'leave')
    k.noteMembership(B, 'leave')
    await wd.c.advance(4 * ANCHORED_INTERVAL_MS)
    expect(wd.jobs.slice(3).map((j) => j.roomId)).toEqual([A, C])
    await k.idle()
    expect(Object.keys((await fileOf(file)).written).sort()).toEqual(['CAAAAAAAAAA', 'CCCCCCCCCCC'])
  })

  it('boot with no change reads and writes nothing; boot with a difference writes only it; a left conversation leaves the file', async () => {
    const first = core()
    await first.k.facade.set([ping])
    await first.wd.c.advance(2 * ANCHORED_INTERVAL_MS)
    await first.k.stop()

    const again = core(world())
    await again.k.load()
    const before = await stat(again.file)
    again.k.reconcile()
    await again.wd.c.advance(3 * ANCHORED_INTERVAL_MS)
    expect([again.wd.jobs.length, again.wd.relations.count]).toEqual([0, 0])
    await again.k.idle()
    expect((await stat(again.file)).mtimeMs).toBe(before.mtimeMs)

    const changed = world()
    changed.membership.set(B, 'leave')
    changed.membership.set(C, 'join')
    const third = core(changed)
    await third.k.load()
    third.k.reconcile()
    await third.wd.c.advance(3 * ANCHORED_INTERVAL_MS)
    expect(third.wd.jobs.map((j) => j.roomId)).toEqual([C])
    await third.k.idle()
    expect(Object.keys((await fileOf(third.file)).written).sort()).toEqual(['CAAAAAAAAAA', 'CCCCCCCCCCC'])
  })

  it('the first write after a lost file finds the agent’s own manifest through the anchor and edits it', async () => {
    const wd = world()
    const first = core(wd)
    await first.k.facade.set([ping])
    await wd.c.advance(2 * ANCHORED_INTERVAL_MS)
    await first.k.stop()
    await rm(first.file)
    const second = core(wd)
    await second.k.load()
    await second.k.facade.set([deploy])
    await wd.c.advance(2 * ANCHORED_INTERVAL_MS)
    expect(wd.jobs.slice(2).map((j) => j.content['m.relates_to'])).toEqual([
      { rel_type: 'm.replace', event_id: '$m1' },
      { rel_type: 'm.replace', event_id: '$m2' },
    ])
  })
})

describe('commands: clearing (§0.3.22 item 4)', () => {
  it('DELETE clears where a manifest is written (the clear mark) and empties the set; with nothing → null (204)', async () => {
    const { k, wd, file } = core()
    expect(await k.facade.clear()).toBeNull()
    await k.facade.set([ping])
    await wd.c.advance(0)
    // A: written; B: still pending → its first write is dropped, nothing to clear there.
    expect(await k.facade.clear()).toEqual({ pending: 1 })
    expect(k.facade.get()).toEqual({ commands: [], pending: 1 })
    await wd.c.advance(3 * ANCHORED_INTERVAL_MS)
    expect(wd.jobs.map((j) => [j.roomId, blockOf(j.content)])).toEqual([
      [A, { commands: [ping] }],
      [A, { cleared: true }],
    ])
    await k.idle()
    expect(await fileOf(file)).toEqual({ commands: [], written: {} })
    expect(await k.facade.clear()).toBeNull()
  })

  it('declaring an empty list is the same clear', async () => {
    const { k, wd } = core()
    await k.facade.set([ping])
    await wd.c.advance(2 * ANCHORED_INTERVAL_MS)
    expect(await k.facade.set([])).toEqual({ pending: 2 })
    await wd.c.advance(2 * ANCHORED_INTERVAL_MS)
    expect(wd.jobs.slice(2).map((j) => blockOf(j.content))).toEqual([{ cleared: true }, { cleared: true }])
  })

  it('stopped (revocation, stop): the facade answers unavailable and nothing more is written', async () => {
    const { k, wd } = core()
    await k.facade.set([ping])
    await k.stop()
    await wd.c.advance(3 * ANCHORED_INTERVAL_MS)
    expect(wd.jobs).toHaveLength(0)
    await expect(k.facade.set([deploy])).rejects.toEqual(new WriteError('unavailable'))
    await expect(k.facade.clear()).rejects.toEqual(new WriteError('unavailable'))
  })
})

describe('anchored scheduler: panel and manifest share one budget (§0.3.22 item 6)', () => {
  function shared(plan: AnchoredOutcome[] = [], idle: () => boolean = () => true) {
    const c = clock()
    const writes: Array<{ kind: string; roomId: string; at: number }> = []
    const logs: Array<Record<string, unknown>> = []
    const s = createAnchoredScheduler(['panel', 'commands'], { queueIdle: idle, log: (l) => logs.push(l), now: c.now, setTimer: c.setTimer })
    const writer = (kind: string) => (roomId: string) => {
      writes.push({ kind, roomId, at: c.now() })
      return Promise.resolve(plan.shift() ?? { kind: 'ok' as const })
    }
    const panel = s.lane<string>('panel', writer('panel'))
    const commands = s.lane<string>('commands', writer('commands'))
    return { s, c, writes, logs, panel, commands }
  }
  const seq = (writes: Array<{ kind: string; roomId: string }>) => writes.map((x) => `${x.kind[0]}${x.roomId}`)

  it('both pending → one by one, the panel first; inside each kind, rotation among the conversations; one write every 10 s', async () => {
    const { c, writes, panel, commands } = shared()
    commands.schedule('1', 'v')
    commands.schedule('2', 'v')
    panel.schedule('1', 'v')
    panel.schedule('2', 'v')
    panel.schedule('3', 'v')
    await c.advance(6 * ANCHORED_INTERVAL_MS)
    expect(seq(writes)).toEqual(['p1', 'c1', 'p2', 'c2', 'p3'])
    expect(writes.map((x) => x.at - writes[0]!.at)).toEqual([0, 1, 2, 3, 4].map((i) => i * ANCHORED_INTERVAL_MS))
  })

  it('a drained scheduler starts again from the panel', async () => {
    const { c, writes, panel, commands } = shared()
    panel.schedule('1', 'v')
    commands.schedule('1', 'v')
    await c.advance(2 * ANCHORED_INTERVAL_MS)
    commands.schedule('2', 'v')
    panel.schedule('2', 'v')
    await c.advance(2 * ANCHORED_INTERVAL_MS)
    expect(seq(writes)).toEqual(['p1', 'c1', 'p2', 'c2'])
  })

  it('messages first: with the write queue busy neither kind writes; it looks again every 1 s', async () => {
    let idle = false
    const { c, writes, commands } = shared([], () => idle)
    commands.schedule('1', 'v')
    await c.advance(3 * ANCHORED_BUSY_RETRY_MS)
    expect(writes).toHaveLength(0)
    idle = true
    await c.advance(ANCHORED_BUSY_RETRY_MS)
    expect(seq(writes)).toEqual(['c1'])
  })

  it('the server’s limit holds both kinds for retryAfterMs; not a member drops with a line of its kind; stop loses everything', async () => {
    const { c, writes, logs, panel, commands, s } = shared([{ kind: 'rate-limited', retryAfterMs: 25_000 }, { kind: 'ok' }, { kind: 'not-member' }])
    commands.schedule('1', 'v')
    await c.advance(0)
    panel.schedule('9', 'v')
    await c.advance(24_999)
    expect(writes).toHaveLength(1)
    await c.advance(1)
    // The limited manifest kept its place; the panel alternates in.
    expect(seq(writes)).toEqual(['c1', 'p9'])
    await c.advance(ANCHORED_INTERVAL_MS)
    expect(seq(writes)).toEqual(['c1', 'p9', 'c1'])
    expect(logs).toEqual([
      { evt: 'commands-ratelimited', retryAfterMs: 25_000 },
      { evt: 'commands-dropped', reason: 'not-member' },
    ])
    commands.schedule('2', 'v')
    panel.schedule('3', 'v')
    s.stop()
    await c.advance(5 * ANCHORED_INTERVAL_MS)
    expect(writes).toHaveLength(3)
    expect([commands.count(), panel.count(), c.pending()]).toEqual([0, 0, 0])
  })
})

describe('commands: the re-edit on a person’s entry (§0.3.22 item 7)', () => {
  const withPanel = async (wd: World) => {
    // A panel already written by the agent in A (so the panel's part has something to re-edit).
    await wd.enqueue({ kind: 'panel', channel: A, content: { msgtype: 'io.tayet.panel', body: 'estado', 'io.tayet.panel': {}, 'm.relates_to': { rel_type: PANEL_REL, event_id: `$create-${A}` } } })
    wd.jobs.length = 0
  }

  it('the panel’s window: after its random delay the panel goes first, then the manifest with the stored set — nothing decrypted for it', async () => {
    const wd = world()
    await withPanel(wd)
    const { k, panels } = core(wd, { panel: true, random: () => 0.3 })
    await k.facade.set([ping])
    await wd.c.advance(2 * ANCHORED_INTERVAL_MS)
    wd.jobs.length = 0
    panels!.noteEvent(joinEvent(ALICE) as never, wd.room(A) as never)
    panels!.noteEvent(joinEvent('@bob:test.local') as never, wd.room(A) as never)
    await wd.c.advance(PANEL_REEDIT_WINDOW_MS * 0.3 - 1)
    expect(wd.jobs).toHaveLength(0)
    await wd.c.advance(1 + ANCHORED_INTERVAL_MS)
    expect(wd.jobs.map((j) => j.kind)).toEqual(['panel', 'commands'])
    expect(blockOf(wd.jobs[1]!.content)).toEqual({ commands: [ping] })
    expect(wd.jobs[1]!.content['m.relates_to']).toEqual({ rel_type: 'm.replace', event_id: '$m2' })
  })

  it('a panel PUT inside the window cancels only the panel’s part; an empty set re-edits nothing', async () => {
    const wd = world()
    await withPanel(wd)
    const { k, panels } = core(wd, { panel: true })
    await k.facade.set([ping])
    await wd.c.advance(2 * ANCHORED_INTERVAL_MS)
    wd.jobs.length = 0
    panels!.noteEvent(joinEvent(ALICE) as never, wd.room(A) as never)
    await wd.c.advance(1_000)
    await panels!.facade.set('CAAAAAAAAAA', { text: 'novo' })
    await wd.c.advance(3 * ANCHORED_INTERVAL_MS)
    expect(wd.jobs.map((j) => j.kind)).toEqual(['panel', 'commands'])
    expect((wd.jobs[0]!.content['m.new_content'] as { body: string }).body).toBe('novo')

    const empty = world()
    const bare = core(empty, { panel: true })
    bare.panels!.noteEvent(joinEvent(ALICE) as never, empty.room(A) as never)
    await empty.c.advance(3 * ANCHORED_INTERVAL_MS)
    expect(empty.jobs).toEqual([])
  })
})

describe('commands: the re-edit only for an entry after the agent’s own, cancelled by a new write (§0.3.22 item 7)', () => {
  // A panel and the set [ping] already written in A; nothing pending, nothing queued.
  const ready = async (random = () => 0.5) => {
    const wd = world()
    await wd.enqueue({ kind: 'panel', channel: A, content: { msgtype: 'io.tayet.panel', body: 'estado', 'io.tayet.panel': {}, 'm.relates_to': { rel_type: PANEL_REL, event_id: `$create-${A}` } } })
    const made = core(wd, { panel: true, random })
    await made.k.facade.set([ping])
    await wd.c.advance(2 * ANCHORED_INTERVAL_MS)
    wd.jobs.length = 0
    return made
  }
  // What was written in A (a PUT of commands also writes in B, the other conversation joined).
  const inA = (wd: World) => wd.jobs.filter((j) => j.roomId === A)
  const kinds = (wd: World) => inA(wd).map((j) => j.kind)

  it('the agent enters a conversation that already has a person: her earlier join opens no window', async () => {
    const { panels, wd } = await ready()
    // The join of who was there before the agent: the agent's membership at that event is not `join`.
    panels!.noteEvent(joinEvent(ALICE, 'leave') as never, wd.room(A) as never)
    panels!.noteEvent(joinEvent('@bob:test.local', 'invite') as never, wd.room(A) as never)
    expect(wd.c.pending()).toBe(0)
    await wd.c.advance(PANEL_REEDIT_WINDOW_MS + 3 * ANCHORED_INTERVAL_MS)
    expect(wd.jobs).toEqual([])
  })

  it('a person who enters after the agent: a window, then the panel’s and the commands’ re-edit (also with no membership from the server)', async () => {
    for (const at of ['join', null]) {
      const { panels, wd } = await ready()
      panels!.noteEvent(joinEvent(ALICE, at) as never, wd.room(A) as never)
      await wd.c.advance(PANEL_REEDIT_WINDOW_MS + ANCHORED_INTERVAL_MS)
      expect(kinds(wd), String(at)).toEqual(['panel', 'commands'])
      expect(blockOf(wd.jobs[1]!.content)).toEqual({ commands: [ping] })
    }
  })

  it('a commands PUT inside the window: the window ends and the commands are not re-edited (the panel still is)', async () => {
    const { k, panels, wd } = await ready()
    panels!.noteEvent(joinEvent(ALICE) as never, wd.room(A) as never)
    await wd.c.advance(1_000)
    await k.facade.set([deploy])
    await wd.c.advance(PANEL_REEDIT_WINDOW_MS + 3 * ANCHORED_INTERVAL_MS)
    expect(kinds(wd)).toEqual(['commands', 'panel'])
    expect(blockOf(inA(wd)[0]!.content)).toEqual({ commands: [deploy] })
  })

  it('a panel PUT inside the window: the panel is not re-edited; the commands, with no write of theirs, are', async () => {
    const { panels, wd } = await ready()
    panels!.noteEvent(joinEvent(ALICE) as never, wd.room(A) as never)
    await wd.c.advance(1_000)
    await panels!.facade.set('CAAAAAAAAAA', { text: 'novo' })
    await wd.c.advance(PANEL_REEDIT_WINDOW_MS + 3 * ANCHORED_INTERVAL_MS)
    expect(kinds(wd)).toEqual(['panel', 'commands'])
    expect((wd.jobs[0]!.content['m.new_content'] as { body: string }).body).toBe('novo')
  })

  it('two entries in the same window: one re-edit', async () => {
    const { panels, wd } = await ready()
    panels!.noteEvent(joinEvent(ALICE) as never, wd.room(A) as never)
    await wd.c.advance(1_000)
    panels!.noteEvent(joinEvent('@bob:test.local') as never, wd.room(A) as never)
    await wd.c.advance(PANEL_REEDIT_WINDOW_MS + 3 * ANCHORED_INTERVAL_MS)
    expect(kinds(wd)).toEqual(['panel', 'commands'])
  })
})

// ── --slack-manifest: who sets the set (PLANO-AGENTES §0.3.25 item 3; A4-3) ──────────────────────────────────────
describe('commands: the Slack manifest at the boot and a later PUT/DELETE (§0.3.25 item 3)', () => {
  const manifest = { commands: [deploy], cut: { descriptions: 0, hints: 0 } }
  const noLog = (): void => {}

  it('the manifest is declared at every boot; a PUT after it holds until the next boot; a restart with no change writes nothing', async () => {
    const first = core()
    await first.k.load()
    await declareAtBoot(first.k, manifest, noLog)
    expect(first.k.facade.get().commands).toEqual([deploy])
    await first.wd.c.advance(2 * ANCHORED_INTERVAL_MS)
    expect(first.wd.jobs.map((j) => blockOf(j.content).commands)).toEqual([[deploy], [deploy]])
    await first.k.facade.set([ping])
    expect(first.k.facade.get().commands).toEqual([ping])
    await first.wd.c.advance(2 * ANCHORED_INTERVAL_MS)
    await first.k.stop()
    expect((await fileOf(first.file)).commands).toEqual([ping])

    // Next boot: the manifest again, over the PUT's set.
    const second = core(world())
    await second.k.load()
    expect(second.k.facade.get().commands).toEqual([ping])
    await declareAtBoot(second.k, manifest, noLog)
    expect(second.k.facade.get().commands).toEqual([deploy])
    await second.wd.c.advance(2 * ANCHORED_INTERVAL_MS)
    expect(second.wd.jobs).toHaveLength(2)
    await second.k.stop()

    // And again with no change: the hashes keep it from writing.
    const third = core(world())
    await third.k.load()
    await declareAtBoot(third.k, manifest, noLog)
    await third.wd.c.advance(3 * ANCHORED_INTERVAL_MS)
    expect(third.wd.jobs).toEqual([])
  })

  it('a DELETE after the manifest holds until the next boot; without the flag the stored set stays (nothing changes)', async () => {
    const first = core()
    await first.k.load()
    await declareAtBoot(first.k, manifest, noLog)
    await first.wd.c.advance(2 * ANCHORED_INTERVAL_MS)
    expect(await first.k.facade.clear()).toEqual({ pending: 2 })
    await first.wd.c.advance(2 * ANCHORED_INTERVAL_MS)
    expect(first.k.facade.get()).toEqual({ commands: [], pending: 0 })
    await first.k.facade.set([ping])
    await first.wd.c.advance(2 * ANCHORED_INTERVAL_MS)
    await first.k.stop()

    const plain = core(world())
    await plain.k.load()
    await declareAtBoot(plain.k, undefined, noLog)
    await plain.wd.c.advance(3 * ANCHORED_INTERVAL_MS)
    expect(plain.k.facade.get().commands).toEqual([ping])
    expect(plain.wd.jobs).toEqual([])
  })
})
