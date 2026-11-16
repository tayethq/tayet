import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ApprovalWatch,
  approvalOptionsOf,
  createApprovalCore,
  createCardReader,
  LOCATE_ATTEMPTS,
  RETRY_MS,
  type CardReader,
  type CardReading,
  type SetTimer,
  type TrackedCard,
  type WatchDeps,
} from '../../src/core/approvals'
import { ReadError, type Resolver } from '../../src/core/read'
import type { SendResult } from '../../src/core/queue'
import type { WriteJob } from '../../src/core/send'
import { WriteError, createWriteFacade } from '../../src/core/write'
import type { ApiEvent } from '../../src/api/contract'

// ADR-091 (A3-3): the approval cards of the sidecar — the option rules, the reader of card state (the same
// rule and the same forward relation read as the client), the watch (event once, seal, retry, the file of
// open cards) and the facade (send, close, PATCH, state).

const ME = '@a-abcdefghijkl:test.local'
const OTHER_AGENT = '@a-zzzzzzzzzzzz:test.local'
const ALICE = '@alice:test.local'
const BOB = '@bob:test.local'
const COFRE = '@cofre:test.local'
const SYSTEM = '@system:test.local'
const ROOM = '!room:test.local'
const CARD = '$card'
const CONV = 'CAAAAAAAAAA'
const OPTIONS = [
  { id: 'approve', label: 'Aprovar', style: 'primary' as const },
  { id: 'reject', label: 'Rejeitar' },
]
const ACCOUNTS = { custodian: COFRE, systemAccount: SYSTEM }

afterEach(() => {
  vi.useRealTimers()
})

// ── Fakes ─────────────────────────────────────────────────────────────────────────────────────────
interface Raw {
  id: string
  sender: string
  ts: number
  option?: string
  utd?: boolean
  redacted?: boolean
  // An edit's new content.
  closed?: boolean
  edit?: boolean
}

class FakeEvent extends EventEmitter {
  constructor(public raw: Raw) {
    super()
  }
  getId = () => this.raw.id
  getSender = () => this.raw.sender
  getTs = () => this.raw.ts
  getType = () => 'm.room.message'
  isDecryptionFailure = () => this.raw.utd === true
  isEncrypted = () => true
  getClearContent = () => (this.raw.utd === true ? null : {})
  isRedacted = () => this.raw.redacted === true
  getContent = () =>
    this.raw.edit === true
      ? { 'm.new_content': { msgtype: 'io.tayet.approval', ...(this.raw.closed === true && { 'io.tayet.approval': { options: OPTIONS, closed: true } }) } }
      : { msgtype: 'io.tayet.approval.response', 'io.tayet.approval.response': { option: this.raw.option } }
  getWireContent = () => ({ 'm.relates_to': { rel_type: 'io.tayet.response', event_id: CARD } })
}

// Pages of relations by type; `from` = the page index as a string.
function relationsClient(pages: { answers?: FakeEvent[][]; edits?: FakeEvent[][] }) {
  const calls: Array<{ relType: string; dir: unknown; from: unknown }> = []
  const client = {
    fetchRelations: vi.fn((_room: string, _card: string, relType: string, _type: unknown, opts: { dir?: unknown; from?: string }) => {
      calls.push({ relType, dir: opts.dir, from: opts.from })
      const list = (relType === 'm.replace' ? pages.edits : pages.answers) ?? [[]]
      const i = opts.from === undefined ? 0 : Number(opts.from)
      return Promise.resolve({ chunk: list[i] ?? [], ...(i + 1 < list.length && { next_batch: String(i + 1) }) })
    }),
    getEventMapper: () => (raw: unknown) => raw,
    decryptEventIfNeeded: () => Promise.resolve(),
  }
  return { client: client as never, calls }
}

const answer = (id: string, sender: string, ts: number, option?: string, extra: Partial<Raw> = {}) => new FakeEvent({ id, sender, ts, option, ...extra })
const edit = (id: string, sender: string, ts: number, closed: boolean) => new FakeEvent({ id, sender, ts, edit: true, closed })
const reader = (pages: { answers?: FakeEvent[][]; edits?: FakeEvent[][] }) => {
  const r = relationsClient(pages)
  return { reader: createCardReader(r.client, () => ACCOUNTS, () => ME), calls: r.calls }
}

// ── Options ──────────────────────────────────────────────────────────────────────────────────────────
describe('approvalOptionsOf (§0.3.16 item 12)', () => {
  const bad = (raw: unknown): string => {
    try {
      approvalOptionsOf(raw)
      return 'accepted'
    } catch (err) {
      return (err as WriteError).code
    }
  }

  it('1 to 25 options; id [a-z0-9_-]{1,32}, unique; label non-empty, ≤ 75 characters; style primary|danger; one primary', () => {
    expect(approvalOptionsOf([{ id: 'ok_1-x', label: 'OK', style: 'primary' }, { id: 'no', label: 'Não', style: 'danger' }, { id: 'later', label: 'Depois' }])).toEqual([
      { id: 'ok_1-x', label: 'OK', style: 'primary' },
      { id: 'no', label: 'Não', style: 'danger' },
      { id: 'later', label: 'Depois' },
    ])
    expect(approvalOptionsOf([{ id: 'x'.repeat(32), label: '🙂'.repeat(75) }])).toHaveLength(1)
    expect(approvalOptionsOf(Array.from({ length: 25 }, (_, n) => ({ id: `o${n}`, label: 'L' })))).toHaveLength(25)
    for (const raw of [
      null,
      {},
      [],
      Array.from({ length: 26 }, (_, n) => ({ id: `o${n}`, label: 'L' })),
      [{ id: '', label: 'L' }],
      [{ id: 'Upper', label: 'L' }],
      [{ id: 'x'.repeat(33), label: 'L' }],
      [{ id: 'a', label: 'L' }, { id: 'a', label: 'M' }],
      [{ id: 'a', label: '' }],
      [{ id: 'a', label: ' \n ' }],
      [{ id: 'a', label: '🙂'.repeat(76) }],
      [{ id: 'a', label: 7 }],
      [{ id: 'a', label: 'L', style: 'secondary' }],
      [{ id: 'a', label: 'L', style: 'primary' }, { id: 'b', label: 'M', style: 'primary' }],
      [{ id: 'a', label: 'L', extra: true }],
    ]) {
      expect(bad(raw), JSON.stringify(raw)).toBe('invalid_argument')
    }
  })
})

// ── Reader ───────────────────────────────────────────────────────────────────────────────────────────
describe('card reader (ADR-091 decs. 4, 5, 7, 9)', () => {
  it('reads the answers FORWARD, page by page, in the server order, and stops at the first that counts', async () => {
    const r = reader({ answers: [[answer('$a1', OTHER_AGENT, 10, 'approve')], [answer('$a2', BOB, 20, 'reject'), answer('$a3', ALICE, 15, 'approve')], [answer('$a4', ALICE, 30, 'approve')]] })
    const out = await r.reader.read(ROOM, CARD, OPTIONS)
    expect(out.state).toEqual({ kind: 'answered', by: BOB, at: 20, option: 'reject' })
    expect(r.calls.filter((c) => c.relType === 'io.tayet.response')).toEqual([
      { relType: 'io.tayet.response', dir: 'f', from: undefined },
      { relType: 'io.tayet.response', dir: 'f', from: '1' },
    ])
    expect(r.calls.find((c) => c.relType === 'm.replace')?.dir).toBe('f')
    expect(out.ignored).toEqual([{ eventId: '$a1', reason: 'not-a-person' }])
  })

  it('agent, custody and system never count; an option not on the card does not; a removed answer is skipped silently', async () => {
    const r = reader({
      answers: [[answer('$c', COFRE, 1, 'approve'), answer('$s', SYSTEM, 2, 'approve'), answer('$x', ALICE, 3, 'maybe'), answer('$d', BOB, 4, 'approve', { redacted: true })]],
    })
    const out = await r.reader.read(ROOM, CARD, OPTIONS)
    expect(out.state).toEqual({ kind: 'open' })
    expect(out.ignored).toEqual([
      { eventId: '$c', reason: 'not-a-person' },
      { eventId: '$s', reason: 'not-a-person' },
      { eventId: '$x', reason: 'unknown-option' },
    ])
    expect(out.answerIds).toEqual(['$c', '$s', '$x', '$d'])
  })

  it('the close is the author’s FIRST closing edit; an answer after it does not count; another sender’s close is no close', async () => {
    const r = reader({
      edits: [[edit('$e0', ALICE, 5, true), edit('$e1', ME, 8, false)], [edit('$e2', ME, 10, true), edit('$e3', ME, 12, true)]],
      answers: [[answer('$late', ALICE, 11, 'approve')]],
    })
    const out = await r.reader.read(ROOM, CARD, OPTIONS)
    expect(out.closedAt).toBe(10)
    expect(out.state).toEqual({ kind: 'closed' })
    expect(out.ignored).toEqual([{ eventId: '$late', reason: 'after-close' }])
  })

  it('a deciding answer that cannot be read: answered without the option, and it is handed as pending', async () => {
    const utd = answer('$u', ALICE, 5, undefined, { utd: true })
    const out = await reader({ answers: [[utd, answer('$b', BOB, 6, 'approve')]] }).reader.read(ROOM, CARD, OPTIONS)
    expect(out.state).toEqual({ kind: 'answered', by: ALICE, at: 5 })
    expect(out.pending).toBe(utd)
  })

  it('a closed card’s reading is kept (nothing changes after the close); `fresh` reads again; open cards are never kept', async () => {
    const closed = reader({ edits: [[edit('$e', ME, 10, true)]], answers: [[answer('$a', ALICE, 9, 'approve')]] })
    await closed.reader.read(ROOM, CARD, OPTIONS)
    await closed.reader.read(ROOM, CARD, OPTIONS)
    expect(closed.calls).toHaveLength(2)
    await closed.reader.read(ROOM, CARD, OPTIONS, { fresh: true })
    expect(closed.calls).toHaveLength(4)
    const open = reader({ answers: [[]] })
    await open.reader.read(ROOM, CARD, OPTIONS)
    await open.reader.read(ROOM, CARD, OPTIONS)
    expect(open.calls).toHaveLength(4)
  })
})

// ── Watch ────────────────────────────────────────────────────────────────────────────────────────────
const OPEN: CardReading = { state: { kind: 'open' }, closedAt: undefined, ignored: [], answerIds: [] }
const ANSWERED: CardReading = { state: { kind: 'answered', by: ALICE as never, at: 42 as never, option: 'approve' }, closedAt: undefined, ignored: [], answerIds: ['$ans'] }
const CLOSED: CardReading = { state: { kind: 'answered', by: ALICE as never, at: 42 as never, option: 'approve' }, closedAt: 50, ignored: [], answerIds: ['$ans'] }
const CLOSED_EMPTY: CardReading = { state: { kind: 'closed' }, closedAt: 50, ignored: [], answerIds: [] }

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
}

async function watchWorld(opts: { readings?: CardReading[]; seal?: () => Promise<void>; file?: string; locate?: WatchDeps['locate'] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'approvals-'))
  const file = opts.file ?? join(dir, 'approvals.json')
  const readings = [...(opts.readings ?? [])]
  let last: CardReading = OPEN
  let reads = 0
  const fakeReader: CardReader = {
    read: () => {
      reads += 1
      last = readings.shift() ?? last
      return Promise.resolve(last)
    },
  }
  const events: ApiEvent[] = []
  const logs: Array<Record<string, unknown>> = []
  const seals: string[] = []
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = []
  const setTimer: SetTimer = (fn, ms) => {
    const t = { fn, ms, cancelled: false }
    timers.push(t)
    return () => {
      t.cancelled = true
    }
  }
  const deps: WatchDeps = {
    file,
    reader: fakeReader,
    locate: opts.locate ?? (() => Promise.resolve({ roomId: ROOM, eventId: CARD })),
    seal: (_room, eventId) => {
      seals.push(eventId)
      return opts.seal?.() ?? Promise.resolve()
    },
    personToken: (u) => (u === ALICE ? 'UALICE00000' : 'U??????????'),
    emit: (e) => events.push(e),
    log: (l) => logs.push(l),
    setTimer,
  }
  const watch = new ApprovalWatch(deps)
  const fire = async (): Promise<void> => {
    const live = timers.filter((t) => !t.cancelled)
    timers.length = 0
    for (const t of live) t.fn()
    await flush()
  }
  const onDisk = async (): Promise<unknown> => {
    await watch.saved()
    return JSON.parse(await readFile(file, 'utf8'))
  }
  return { watch, deps, events, logs, seals, timers, fire, file, dir, onDisk, reads: () => reads, cleanup: async () => {
      await watch.saved()
      await rm(dir, { recursive: true, force: true })
    } }
}

const TRACKED: TrackedCard = { conversation: CONV, id: '1730900000.000001', options: OPTIONS }
const liveAnswer = (cardId = CARD) =>
  ({
    getWireContent: () => ({ 'm.relates_to': { rel_type: 'io.tayet.response', event_id: cardId } }),
    getType: () => 'm.room.message',
  }) as never

describe('approval watch', () => {
  it('a card is on disk (tokens + options, no protocol id) before the send answers; a live answer → one event, then the seal', async () => {
    const w = await watchWorld({ readings: [OPEN, ANSWERED] })
    await w.watch.track(TRACKED, { roomId: ROOM, eventId: CARD })
    const disk = JSON.stringify(await w.onDisk())
    expect(JSON.parse(disk)).toEqual({ cards: [TRACKED] })
    expect(disk).not.toMatch(/[!$@]/)
    await flush()
    expect(w.events).toEqual([])
    w.watch.noteEvent(liveAnswer())
    await flush()
    expect(w.events).toEqual([{ type: 'approval.answered', conversation: CONV, id: TRACKED.id, option: 'approve', by: 'UALICE00000', at: 42 }])
    expect(w.seals).toEqual([CARD])
    expect(await w.onDisk()).toEqual({ cards: [] })
    expect(JSON.stringify(w.logs)).not.toMatch(/[!$@]/)
    await w.cleanup()
  })

  it('touches during a read read once more after it; the event is emitted once', async () => {
    const w = await watchWorld({ readings: [ANSWERED, ANSWERED, ANSWERED], seal: () => new Promise((r) => setTimeout(r, 5)) })
    await w.watch.track(TRACKED, { roomId: ROOM, eventId: CARD })
    w.watch.noteEvent(liveAnswer())
    w.watch.noteEvent(liveAnswer())
    await new Promise((r) => setTimeout(r, 30))
    await flush()
    expect(w.events).toHaveLength(1)
    // An answer to a card the watch does not know reads nothing.
    w.watch.noteEvent(liveAnswer('$other'))
    await flush()
    expect(w.events).toHaveLength(1)
    await w.cleanup()
  })

  it('a deciding answer that cannot be read: no event until its key arrives, then the event with the option', async () => {
    const pending = new FakeEvent({ id: '$u', sender: ALICE, ts: 42, utd: true })
    const waiting: CardReading = { state: { kind: 'answered', by: ALICE as never, at: 42 as never }, closedAt: undefined, ignored: [], answerIds: ['$u'], pending: pending as never }
    const w = await watchWorld({ readings: [waiting, ANSWERED] })
    await w.watch.track(TRACKED, { roomId: ROOM, eventId: CARD })
    await flush()
    expect(w.events).toEqual([])
    expect(w.seals).toEqual([])
    expect(w.timers.some((t) => !t.cancelled && t.ms === 60_000)).toBe(true)
    pending.emit('Event.decrypted')
    await flush()
    expect(w.events).toMatchObject([{ type: 'approval.answered', option: 'approve' }])
    await w.cleanup()
  })

  it('an invalid answer: one log line with the reason (no id), no event; logged once per answer', async () => {
    const invalid: CardReading = { ...OPEN, ignored: [{ eventId: '$x', reason: 'unknown-option' }], answerIds: ['$x'] }
    const w = await watchWorld({ readings: [invalid, invalid] })
    await w.watch.track(TRACKED, { roomId: ROOM, eventId: CARD })
    await flush()
    w.watch.noteEvent(liveAnswer())
    await flush()
    expect(w.events).toEqual([])
    expect(w.logs.filter((l) => l.evt === 'approval-answer-ignored')).toEqual([{ evt: 'approval-answer-ignored', reason: 'unknown-option' }])
    await w.cleanup()
  })

  it('the removal of a known answer reads the card again (the next valid one takes over)', async () => {
    const first: CardReading = { ...OPEN, answerIds: ['$gone'] }
    const w = await watchWorld({ readings: [first, ANSWERED] })
    await w.watch.track(TRACKED, { roomId: ROOM, eventId: CARD })
    await flush()
    w.watch.noteEvent({ getWireContent: () => ({}), getType: () => 'm.room.redaction', event: { redacts: '$gone' }, getContent: () => ({}) } as never)
    await flush()
    expect(w.events).toHaveLength(1)
    await w.cleanup()
  })

  it('a card found closed on the server with no valid answer leaves the watch with no event', async () => {
    const w = await watchWorld({ readings: [CLOSED_EMPTY] })
    await w.watch.track(TRACKED, { roomId: ROOM, eventId: CARD })
    await flush()
    expect(w.events).toEqual([])
    expect(w.seals).toEqual([])
    expect(w.watch.size).toBe(0)
    expect(await w.onDisk()).toEqual({ cards: [] })
    await w.cleanup()
  })

  it('a seal that fails does not undo the event and is tried again with backoff; the event is not sent twice', async () => {
    let n = 0
    const w = await watchWorld({
      readings: [ANSWERED],
      seal: () => (++n < 3 ? Promise.reject(new WriteError('upstream_failed')) : Promise.resolve()),
    })
    await w.watch.track(TRACKED, { roomId: ROOM, eventId: CARD })
    await flush()
    expect(w.events).toHaveLength(1)
    expect(w.timers.filter((t) => !t.cancelled).map((t) => t.ms)).toEqual([RETRY_MS[0]])
    await w.fire()
    expect(w.timers.filter((t) => !t.cancelled).map((t) => t.ms)).toEqual([RETRY_MS[1]])
    await w.fire()
    expect(w.seals).toHaveLength(3)
    expect(w.events).toHaveLength(1)
    expect(w.watch.size).toBe(0)
    expect(w.logs.filter((l) => l.evt === 'approval-seal-failed')).toEqual([
      { evt: 'approval-seal-failed', attempt: 1, code: 'upstream_failed' },
      { evt: 'approval-seal-failed', attempt: 2, code: 'upstream_failed' },
    ])
    await w.cleanup()
  })

  it('a seal refused for good (the card was removed, the agent left) drops the card', async () => {
    const w = await watchWorld({ readings: [ANSWERED], seal: () => Promise.reject(new ReadError('message_not_found')) })
    await w.watch.track(TRACKED, { roomId: ROOM, eventId: CARD })
    await flush()
    expect(w.watch.size).toBe(0)
    expect(w.logs).toContainEqual({ evt: 'approval-seal-dropped', code: 'message_not_found' })
    await w.cleanup()
  })

  it('boot: the cards of an earlier run are loaded and, at the first healthy sync, an answer given meanwhile → event and seal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'approvals-boot-'))
    const file = join(dir, 'approvals.json')
    await writeFile(file, JSON.stringify({ cards: [TRACKED, { conversation: 1 }, { conversation: CONV, id: 'x', options: [] }] }))
    const located: TrackedCard[] = []
    const w = await watchWorld({
      file,
      readings: [ANSWERED],
      locate: (c) => {
        located.push(c)
        return Promise.resolve({ roomId: ROOM, eventId: CARD })
      },
    })
    await w.watch.load()
    expect(w.watch.size).toBe(1)
    expect(w.logs).toContainEqual({ evt: 'approvals-loaded', count: 1 })
    w.watch.recheckAll()
    await flush()
    expect(located).toEqual([expect.objectContaining(TRACKED)])
    expect(w.events).toMatchObject([{ type: 'approval.answered', id: TRACKED.id }])
    expect(await w.onDisk()).toEqual({ cards: [] })
    await w.cleanup()
    await rm(dir, { recursive: true, force: true })
  })

  it('a stop between the event and the seal: the next run sends the event again (at least once)', async () => {
    const first = await watchWorld({ readings: [ANSWERED], seal: () => new Promise(() => {}) })
    await first.watch.track(TRACKED, { roomId: ROOM, eventId: CARD })
    await flush()
    expect(first.events).toHaveLength(1)
    await first.watch.stop()
    const second = await watchWorld({ file: first.file, readings: [ANSWERED] })
    await second.watch.load()
    second.watch.recheckAll()
    await flush()
    expect(second.events).toEqual(first.events)
    expect(second.watch.size).toBe(0)
    await second.cleanup()
    await first.cleanup()
  })

  it('a card whose message cannot be found is tried a few times, then leaves the file', async () => {
    const w = await watchWorld({ locate: () => Promise.resolve(null) })
    await writeFile(w.file, JSON.stringify({ cards: [TRACKED] }))
    await w.watch.load()
    w.watch.recheckAll()
    await flush()
    for (let i = 1; i < LOCATE_ATTEMPTS; i++) await w.fire()
    expect(w.watch.size).toBe(0)
    expect(w.logs).toContainEqual({ evt: 'approval-card-gone' })
    await w.cleanup()
  })

  it('a card found closed with a valid answer up to the close (never reported): the event, no seal', async () => {
    const w = await watchWorld({ readings: [CLOSED] })
    await w.watch.track(TRACKED, { roomId: ROOM, eventId: CARD })
    await flush()
    expect(w.events).toMatchObject([{ type: 'approval.answered', option: 'approve' }])
    expect(w.seals).toEqual([])
    expect(w.watch.size).toBe(0)
    // Settled again in the same run (the card left the watch): the event is never sent twice.
    expect((await w.watch.settle(TRACKED, { roomId: ROOM, eventId: CARD })).outcome).toBe('answered')
    expect(w.events).toHaveLength(1)
    await w.cleanup()
  })
})

// ── Facade ───────────────────────────────────────────────────────────────────────────────────────────
interface CardEv {
  id: string
  sender?: string
  original?: Record<string, unknown>
  shown?: Record<string, unknown>
  utd?: boolean
}

async function facadeWorld(events: CardEv[] = [], readings: CardReading[] = []) {
  const local = new Map(
    events.map((e) => {
      const original = e.original ?? { msgtype: 'io.tayet.approval', body: 'Publicar?', 'io.tayet.approval': { options: OPTIONS } }
      return [
        e.id,
        {
          getId: () => e.id,
          getSender: () => e.sender ?? ME,
          getType: () => 'm.room.message',
          getTs: () => 1_000,
          getContent: () => e.shown ?? original,
          getOriginalContent: () => original,
          getWireContent: () => ({}),
          isRedacted: () => false,
          localRedactionEvent: () => null,
          isDecryptionFailure: () => e.utd === true,
          replacingEvent: () => null,
          replacingEventId: () => undefined,
          status: null,
        },
      ]
    }),
  )
  const room = {
    roomId: ROOM,
    getMyMembership: () => 'join',
    findEventById: (id: string) => local.get(id),
    getPendingEvents: () => [],
    relations: { getChildEventsForEvent: () => undefined },
  }
  const resolver: Resolver = {
    roomAnyOf: (t) => {
      if (t !== CONV) throw new ReadError('conversation_not_found')
      return room as never
    },
    userOf: (t) => (t === 'UALICE00000' ? ALICE : ''),
    eventOf: (_r, ts) => (ts.startsWith('ts-') ? Promise.resolve(ts.slice(3)) : Promise.reject(new ReadError('message_not_found'))),
    tsOf: (_r, id) => `ts-${id}`,
    tsOfRelated: (_r, id) => Promise.resolve(`ts-${id}`),
    tokenOfRoom: () => CONV,
    tokenOfPerson: (u) => (u === ME ? 'UME00000000' : u === ALICE ? 'UALICE00000' : 'U??????????'),
    file: () => undefined,
    noteFile: () => 'F',
  }
  const jobs: WriteJob[] = []
  let n = 0
  const queue = [...readings]
  // Every read the core and the watch make, with the close instant they passed.
  const reads: Array<{ cardId: string; closedAt?: number }> = []
  let last: CardReading = OPEN
  const cardReader: CardReader = {
    read: (_room, cardId, _options, opts = {}) => {
      reads.push({ cardId, ...(opts.closedAt !== undefined && { closedAt: opts.closedAt }) })
      last = queue.shift() ?? last
      return Promise.resolve(last)
    },
  }
  const client = {
    getUserId: () => ME,
    getRoom: () => room,
    fetchRoomEvent: (_r: string, id: string) => Promise.resolve({ event_id: id, origin_server_ts: 2_000 }),
    decryptEventIfNeeded: () => Promise.resolve(),
    relations: () => Promise.resolve({ events: [] }),
    uploadContent: () => Promise.reject(new Error('no')),
    getMediaConfig: () => Promise.resolve({}),
    http: { authedRequest: () => Promise.reject(new Error('no')) },
  }
  const deps = {
    client: client as never,
    resolver,
    enqueue: (job: WriteJob): Promise<SendResult> => {
      jobs.push(job)
      return Promise.resolve({ ok: true, messageId: `$sent${++n}` })
    },
    onRevoked: () => {},
    log: () => {},
  }
  const dir = await mkdtemp(join(tmpdir(), 'approvals-facade-'))
  const apiEvents: ApiEvent[] = []
  let seal: (roomId: string, eventId: string) => Promise<void> = () => Promise.resolve()
  const watch = new ApprovalWatch({
    file: join(dir, 'approvals.json'),
    reader: cardReader,
    locate: () => Promise.resolve({ roomId: ROOM, eventId: CARD }),
    seal: (r, e) => seal(r, e),
    personToken: (u) => resolver.tokenOfPerson(u),
    emit: (e) => apiEvents.push(e),
    log: () => {},
    setTimer: () => () => {},
  })
  const core = createApprovalCore({ ...deps, reader: cardReader, watch })
  seal = core.seal
  const write = createWriteFacade({ ...deps, editCard: core.editCard })
  return { core, write, jobs, watch, reads, apiEvents, cleanup: async () => {
      await watch.saved()
      await rm(dir, { recursive: true, force: true })
    } }
}

const newContent = (job: WriteJob | undefined): Record<string, unknown> =>
  ((job as { content?: Record<string, unknown> } | undefined)?.content?.['m.new_content'] ?? {}) as Record<string, unknown>

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p
    return 'ok'
  } catch (err) {
    return (err as { code: string }).code
  }
}

describe('approval facade', () => {
  it('request: the card content through the queue, kept by the watch, answered like a message POST with the open state', async () => {
    const f = await facadeWorld()
    const out = await f.core.facade.request(CONV, { text: 'Publicar?', options: OPTIONS, mentions: ['UALICE00000'] })
    expect(f.jobs).toEqual([
      {
        kind: 'content',
        channel: ROOM,
        content: {
          msgtype: 'io.tayet.approval',
          body: 'Publicar?',
          'io.tayet.approval': { options: OPTIONS },
          'm.mentions': { user_ids: [ALICE] },
        },
      },
    ])
    expect(f.watch.size).toBe(1)
    expect(f.reads[0]).toEqual({ cardId: '$sent1' })
    expect(out).toEqual({
      id: 'ts-$sent1',
      conversation: CONV,
      author: 'UME00000000',
      text: 'Publicar?',
      mentionsMe: false,
      mentions: ['UALICE00000'],
      reactions: [],
      approval: { options: OPTIONS, state: 'open' },
    })
    expect(await code(f.core.facade.request(CONV, { text: ' ', options: OPTIONS }))).toBe('invalid_argument')
    expect(await code(f.core.facade.request(CONV, { text: 'x', options: [] }))).toBe('invalid_argument')
    await f.cleanup()
  })

  it('close without text keeps the request and marks the card closed; with text replaces it; the watch lets go', async () => {
    const f = await facadeWorld([{ id: '$c1', shown: { msgtype: 'io.tayet.approval', body: 'Pedido editado', 'io.tayet.approval': { options: OPTIONS } } }, { id: '$c2' }], [OPEN, CLOSED_EMPTY, OPEN, CLOSED_EMPTY])
    const out = await f.core.facade.close(CONV, 'ts-$c1')
    expect(f.jobs[0]).toEqual({
      kind: 'content',
      channel: ROOM,
      content: {
        msgtype: 'io.tayet.approval',
        body: '* Pedido editado',
        'm.new_content': { msgtype: 'io.tayet.approval', body: 'Pedido editado', 'io.tayet.approval': { options: OPTIONS, closed: true } },
        'm.relates_to': { rel_type: 'm.replace', event_id: '$c1' },
      },
    })
    expect(out).toMatchObject({ id: 'ts-$c1', text: 'Pedido editado', editedAt: 2_000, approval: { state: 'closed' } })
    await f.core.facade.close(CONV, 'ts-$c2', 'Encerrado')
    expect(newContent(f.jobs[1])).toEqual({
      msgtype: 'io.tayet.approval',
      body: 'Encerrado',
      'io.tayet.approval': { options: OPTIONS, closed: true },
    })
    expect(f.watch.size).toBe(0)
    expect(f.apiEvents).toEqual([])
    await f.cleanup()
  })

  it('close of a card already closed: no new write; an answer up to that close never reported goes out now', async () => {
    const f = await facadeWorld([{ id: '$c', shown: { msgtype: 'io.tayet.approval', body: 'x', 'io.tayet.approval': { options: OPTIONS, closed: true } } }], [CLOSED])
    expect(await f.core.facade.close(CONV, 'ts-$c')).toMatchObject({ id: 'ts-$c', approval: { state: 'answered' } })
    expect(f.jobs).toEqual([])
    expect(f.apiEvents).toMatchObject([{ type: 'approval.answered', id: 'ts-$c', option: 'approve' }])
    await f.cleanup()
  })

  it('close and state of a message that is not the agent’s card: not_own_message / not_approval, no write', async () => {
    const f = await facadeWorld([
      { id: '$theirs', sender: OTHER_AGENT },
      { id: '$text', original: { msgtype: 'm.text', body: 'oi' } },
      { id: '$utd', utd: true },
    ])
    expect(await code(f.core.facade.close(CONV, 'ts-$theirs'))).toBe('not_own_message')
    expect(await code(f.core.facade.close(CONV, 'ts-$text'))).toBe('not_approval')
    expect(await code(f.core.facade.state(CONV, 'ts-$utd'))).toBe('not_approval')
    expect(await code(f.core.facade.state(CONV, 'ts-nope'))).toBe('message_not_found')
    expect(f.jobs).toEqual([])
    await f.cleanup()
  })

  it('PATCH of the agent’s card (write.edit): the request changes; type, original options and the close stay', async () => {
    const closedShown = { msgtype: 'io.tayet.approval', body: 'velho', 'io.tayet.approval': { options: OPTIONS, closed: true } }
    const f = await facadeWorld([{ id: '$open' }, { id: '$closed', shown: closedShown }])
    const out = await f.write.edit(CONV, 'ts-$open', 'Novo pedido')
    expect((f.jobs[0] as { content: Record<string, unknown> }).content).toEqual({
      msgtype: 'io.tayet.approval',
      body: '* Novo pedido',
      'm.new_content': { msgtype: 'io.tayet.approval', body: 'Novo pedido', 'io.tayet.approval': { options: OPTIONS } },
      'm.relates_to': { rel_type: 'm.replace', event_id: '$open' },
    })
    expect(out).toMatchObject({ text: 'Novo pedido', approval: { options: OPTIONS, state: 'open' } })
    await f.write.edit(CONV, 'ts-$closed', 'Outro')
    expect(newContent(f.jobs[1])['io.tayet.approval']).toEqual({ options: OPTIONS, closed: true })
    await f.cleanup()
  })

  it('state: the own card’s state with the person as a token; another agent’s card carries the options alone', async () => {
    const f = await facadeWorld([{ id: '$c' }], [ANSWERED])
    expect(await f.core.facade.state(CONV, 'ts-$c')).toEqual({
      conversation: CONV,
      id: 'ts-$c',
      approval: { options: OPTIONS, state: 'answered', answer: { option: 'approve', by: 'UALICE00000', at: 42 } },
    })
    expect(await f.core.approvalOf(ROOM, '$x', OPTIONS, false)).toEqual({ options: OPTIONS })
    await f.cleanup()
  })

  it('the seal closes through the same write; an already closed card is not written again', async () => {
    const f = await facadeWorld([{ id: '$c' }, { id: '$done', shown: { msgtype: 'io.tayet.approval', body: 'x', 'io.tayet.approval': { options: OPTIONS, closed: true } } }], [CLOSED, CLOSED])
    await f.core.seal(ROOM, '$c')
    expect(f.jobs).toHaveLength(1)
    expect(newContent(f.jobs[0])).toMatchObject({ body: 'Publicar?', 'io.tayet.approval': { closed: true } })
    await f.core.seal(ROOM, '$done')
    expect(f.jobs).toHaveLength(1)
    await f.cleanup()
  })
})

// PLANO-AGENTES §8.33 (architect's adjustment): the agent's own close never hides a valid answer — the real
// watch and the real core, the reader faked. The close instant compared is the close event's server
// instant (2 000 in this world), never the local clock.
describe('the agent’s close agrees with the client (ADR-091 dec. 7)', () => {
  const closedAnswered: CardReading = { state: { kind: 'answered', by: ALICE as never, at: 1_500 as never, option: 'reject' }, closedAt: 2_000, ignored: [], answerIds: ['$a'] }
  const closedEmpty: CardReading = { state: { kind: 'closed' }, closedAt: 2_000, ignored: [], answerIds: ['$late'] }

  it('an answer before the close the sidecar had not seen: the event goes out, the seal is the close, close answers `answered`', async () => {
    const f = await facadeWorld([{ id: '$c' }], [ANSWERED, CLOSED])
    const out = await f.core.facade.close(CONV, 'ts-$c', 'texto do fecho')
    expect(f.apiEvents).toEqual([{ type: 'approval.answered', conversation: CONV, id: 'ts-$c', option: 'approve', by: 'UALICE00000', at: 42 }])
    expect(f.jobs).toHaveLength(1)
    // The seal keeps the request (it is the one close written).
    expect(newContent(f.jobs[0])).toMatchObject({ body: 'Publicar?', 'io.tayet.approval': { closed: true } })
    expect(out.approval).toEqual({ options: OPTIONS, state: 'answered', answer: { option: 'approve', by: 'UALICE00000', at: 42 } })
    expect(f.watch.size).toBe(0)
    await f.cleanup()
  })

  it('an answer that lands between the read and the close, up to the close instant: the event after the close, no second write', async () => {
    const f = await facadeWorld([{ id: '$c' }], [OPEN, closedAnswered])
    const out = await f.core.facade.close(CONV, 'ts-$c')
    expect(f.jobs).toHaveLength(1)
    expect(f.reads.at(-1)).toEqual({ cardId: '$c', closedAt: 2_000 })
    expect(f.apiEvents).toMatchObject([{ type: 'approval.answered', option: 'reject', at: 1_500 }])
    expect(out).toMatchObject({ editedAt: 2_000, approval: { state: 'answered', answer: { option: 'reject' } } })
    expect(f.watch.size).toBe(0)
    await f.cleanup()
  })

  it('an answer after the close: no event, state `closed`', async () => {
    const f = await facadeWorld([{ id: '$c' }], [OPEN, closedEmpty])
    const out = await f.core.facade.close(CONV, 'ts-$c')
    expect(f.apiEvents).toEqual([])
    expect(out.approval).toEqual({ options: OPTIONS, state: 'closed' })
    expect(f.watch.size).toBe(0)
    await f.cleanup()
  })

  it('an answer before the close that cannot be read: the card stays watched after the close, and the event goes out when it decrypts', async () => {
    const pending = new FakeEvent({ id: '$u', sender: ALICE, ts: 1_500, utd: true })
    const waiting = (closedAt?: number): CardReading => ({ state: { kind: 'answered', by: ALICE as never, at: 1_500 as never }, closedAt, ignored: [], answerIds: ['$u'], pending: pending as never })
    const f = await facadeWorld([{ id: '$c' }], [waiting(), waiting(2_000), closedAnswered])
    const out = await f.core.facade.close(CONV, 'ts-$c')
    expect(f.jobs).toHaveLength(1)
    expect(f.apiEvents).toEqual([])
    expect(f.watch.size).toBe(1)
    expect(out.approval).toEqual({ options: OPTIONS, state: 'answered', answer: { by: 'UALICE00000', at: 1_500 } })
    pending.emit('Event.decrypted')
    await flush()
    expect(f.apiEvents).toMatchObject([{ type: 'approval.answered', option: 'reject' }])
    expect(f.jobs).toHaveLength(1)
    expect(f.watch.size).toBe(0)
    await f.cleanup()
  })
})
