import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ApprovalWatch,
  createApprovalCore,
  createCardReader,
  type CardReader,
  type CardReading,
  type SetTimer,
  type TrackedCard,
  type WatchDeps,
} from '../../src/core/approvals'
import { ReadError, type Resolver } from '../../src/core/read'
import type { SendResult } from '../../src/core/queue'
import type { WriteJob } from '../../src/core/send'
import { createWriteFacade } from '../../src/core/write'
import type { ApiEvent } from '../../src/api/contract'

// ADR-104 in the sidecar (PLANO-AGENTES §0.3.30, Aprovadores 2): a card that declares how many answers it
// asks for (`needed`) — the reader (resolveMultiApproval, page by page, one per person, cut at `needed`),
// the watch (one event per answer with `count` and `needed`, the seal only with `needed` answers read, the
// file with `needed` and `emitted`, written after the event) and the facade (request, state, close, edit,
// seal keep `needed`).

const ME = '@a-abcdefghijkl:test.local'
const OTHER_AGENT = '@a-zzzzzzzzzzzz:test.local'
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
const person = (n: number): string => `@p${n}:test.local`
const tokenOf = (u: string): string => `U${u.slice(1, u.indexOf(':')).toUpperCase().padEnd(10, '0')}`
const [A, B, C] = [person(1), person(2), person(3)]

// ── Fakes ─────────────────────────────────────────────────────────────────────────────────────────
interface Raw {
  id: string
  sender: string
  ts: number
  option?: string
  utd?: boolean
  redacted?: boolean
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
  getContent = () => ({ msgtype: 'io.tayet.approval.response', 'io.tayet.approval.response': { option: this.raw.option } })
  getWireContent = () => ({ 'm.relates_to': { rel_type: 'io.tayet.response', event_id: CARD } })
}

const answer = (id: string, sender: string, ts: number, option?: string, extra: Partial<Raw> = {}) => new FakeEvent({ id, sender, ts, option, ...extra })

function reader(answers: FakeEvent[][]) {
  const calls: Array<{ relType: string; from: unknown }> = []
  const client = {
    fetchRelations: vi.fn((_room: string, _card: string, relType: string, _type: unknown, opts: { from?: string }) => {
      calls.push({ relType, from: opts.from })
      const list = relType === 'm.replace' ? [[]] : answers
      const i = opts.from === undefined ? 0 : Number(opts.from)
      return Promise.resolve({ chunk: list[i] ?? [], ...(i + 1 < list.length && { next_batch: String(i + 1) }) })
    }),
    getEventMapper: () => (raw: unknown) => raw,
    decryptEventIfNeeded: () => Promise.resolve(),
  }
  return { reader: createCardReader(client as never, () => ACCOUNTS, () => ME), calls }
}
const responsePages = (calls: Array<{ relType: string }>): number => calls.filter((c) => c.relType === 'io.tayet.response').length

// ── Reader ───────────────────────────────────────────────────────────────────────────────────────────
describe('card reader with `needed` (ADR-104)', () => {
  it('N = 10 across pages of 5: one per person, read until the tenth, the eleventh left out and no line of the log', async () => {
    const people = Array.from({ length: 11 }, (_, i) => answer(`$a${i + 1}`, person(i + 1), 10 + i, 'approve'))
    const r = reader([people.slice(0, 5), people.slice(5, 10).concat(people[10] as FakeEvent), [answer('$late', person(20), 99, 'approve')]])
    const out = await r.reader.read(ROOM, CARD, OPTIONS, { needed: 10 })
    expect(out.state).toMatchObject({ kind: 'multi', needed: 10, closed: false })
    expect(out.counted?.map((a) => a.eventId)).toEqual(people.slice(0, 10).map((e) => e.raw.id))
    expect(out.counted?.[0]).toEqual({ eventId: '$a1', by: person(1), at: 10, option: 'approve' })
    expect(out.pendings).toEqual([])
    expect(out.ignored).toEqual([])
    // Settled on the second page: the third is never fetched.
    expect(responsePages(r.calls)).toBe(2)
  })

  it('a second answer of the same person does not count and is no line; an invalid one is', async () => {
    const r = reader([[answer('$x', A, 1, 'maybe'), answer('$a1', A, 2, 'approve'), answer('$a2', A, 3, 'reject'), answer('$o', OTHER_AGENT, 4, 'approve'), answer('$b', B, 5, 'reject')]])
    const out = await r.reader.read(ROOM, CARD, OPTIONS, { needed: 3 })
    expect(out.counted?.map((a) => [a.by, a.option])).toEqual([
      [A, 'approve'],
      [B, 'reject'],
    ])
    expect(out.ignored).toEqual([
      { eventId: '$x', reason: 'unknown-option' },
      { eventId: '$o', reason: 'not-a-person' },
    ])
  })

  it('a removed answer leaves; the next one of the same person takes its place', async () => {
    const r = reader([[answer('$a1', A, 1, 'approve', { redacted: true }), answer('$b', B, 2, 'approve'), answer('$a2', A, 3, 'reject')]])
    const out = await r.reader.read(ROOM, CARD, OPTIONS, { needed: 2 })
    expect(out.counted).toEqual([
      { eventId: '$b', by: B, at: 2, option: 'approve' },
      { eventId: '$a2', by: A, at: 3, option: 'reject' },
    ])
    expect(out.answerIds).toEqual(['$a1', '$b', '$a2'])
  })

  it('an answer that cannot be read holds its place without the option and is handed as pending (every one of them)', async () => {
    const u1 = answer('$u1', A, 1, undefined, { utd: true })
    const u2 = answer('$u2', C, 3, undefined, { utd: true })
    const out = await reader([[u1, answer('$b', B, 2, 'approve'), u2, answer('$d', person(4), 4, 'approve')]]).reader.read(ROOM, CARD, OPTIONS, { needed: 3 })
    expect(out.counted).toEqual([
      { eventId: '$u1', by: A, at: 1 },
      { eventId: '$b', by: B, at: 2, option: 'approve' },
      { eventId: '$u2', by: C, at: 3 },
    ])
    expect(out.pendings).toEqual([u1, u2])
    expect(out.state).toMatchObject({ kind: 'multi', answers: [{ by: A, at: 1 }, { by: B, at: 2, option: 'approve' }, { by: C, at: 3 }] })
  })
})

// ── Watch ────────────────────────────────────────────────────────────────────────────────────────────
type Ans = [sender: string, ts: number, option?: string]
function multi(needed: number, answers: Ans[], opts: { closedAt?: number; pendings?: FakeEvent[]; ids?: string[] } = {}): CardReading {
  const counted = answers.map(([by, at, option], i) => ({ eventId: opts.ids?.[i] ?? `$${by}-${at}`, by, at, ...(option !== undefined && { option }) }))
  return {
    state: { kind: 'multi', needed, answers: counted.map(({ by, at, option }) => ({ by: by as never, at: at as never, ...(option !== undefined && { option }) })), closed: opts.closedAt !== undefined },
    closedAt: opts.closedAt,
    ignored: [],
    answerIds: counted.map((a) => a.eventId),
    counted,
    pendings: (opts.pendings ?? []) as never,
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
}

async function watchWorld(opts: { readings?: CardReading[]; file?: string; seal?: () => Promise<void>; onEmit?: (file: string) => void } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'approvals-multi-'))
  const file = opts.file ?? join(dir, 'approvals.json')
  const readings = [...(opts.readings ?? [])]
  let last: CardReading = multi(3, [])
  const seen: Array<{ needed?: number }> = []
  const fakeReader: CardReader = {
    read: (_room, _card, _options, o = {}) => {
      seen.push({ ...(o.needed !== undefined && { needed: o.needed }) })
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
    locate: () => Promise.resolve({ roomId: ROOM, eventId: CARD }),
    seal: (_room, eventId) => {
      seals.push(eventId)
      return opts.seal?.() ?? Promise.resolve()
    },
    personToken: tokenOf,
    emit: (e) => {
      opts.onEmit?.(file)
      events.push(e)
    },
    log: (l) => logs.push(l),
    setTimer,
  }
  const watch = new ApprovalWatch(deps)
  const onDisk = async (): Promise<unknown> => {
    await watch.saved()
    return JSON.parse(await readFile(file, 'utf8'))
  }
  const touch = async (): Promise<void> => {
    watch.noteEvent({ getWireContent: () => ({ 'm.relates_to': { rel_type: 'io.tayet.response', event_id: CARD } }), getType: () => 'm.room.message' } as never)
    await flush()
  }
  return {
    watch,
    events,
    logs,
    seals,
    timers,
    seen,
    file,
    onDisk,
    touch,
    cleanup: async () => {
      await watch.saved()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

const TRACKED: TrackedCard = { conversation: CONV, id: '1730900000.000001', options: OPTIONS, needed: 3 }
const ev = (by: string, at: number, option: string, count: number, needed = 3): ApiEvent => ({ type: 'approval.answered', conversation: CONV, id: TRACKED.id, option, by: tokenOf(by), at, count, needed })

describe('approval watch with `needed` (ADR-104)', () => {
  it('one event per answer with `count` and `needed`; no seal before N read; the seal at N; the file keeps what went out', async () => {
    const w = await watchWorld({ readings: [multi(3, []), multi(3, [[A, 10, 'approve']]), multi(3, [[A, 10, 'approve'], [B, 20, 'reject']]), multi(3, [[A, 10, 'approve'], [B, 20, 'reject'], [C, 30, 'approve']])] })
    await w.watch.track(TRACKED, { roomId: ROOM, eventId: CARD })
    await flush()
    expect(await w.onDisk()).toEqual({ cards: [{ ...TRACKED, emitted: [] }] })
    await w.touch()
    expect(w.events).toEqual([ev(A, 10, 'approve', 1)])
    expect(w.seals).toEqual([])
    expect(await w.onDisk()).toEqual({ cards: [{ ...TRACKED, emitted: [{ by: tokenOf(A), at: 10 }] }] })
    await w.touch()
    expect(w.events.at(-1)).toEqual(ev(B, 20, 'reject', 2))
    expect(w.seals).toEqual([])
    await w.touch()
    expect(w.events).toEqual([ev(A, 10, 'approve', 1), ev(B, 20, 'reject', 2), ev(C, 30, 'approve', 3)])
    expect(w.seals).toEqual([CARD])
    expect(w.watch.size).toBe(0)
    expect(await w.onDisk()).toEqual({ cards: [] })
    expect(w.seen.every((s) => s.needed === 3)).toBe(true)
    expect(w.logs.filter((l) => l.evt === 'approval-answered')).toEqual([1, 2, 3].map((count) => ({ evt: 'approval-answered', count, needed: 3 })))
    expect(JSON.stringify(w.logs)).not.toMatch(/[!$@]/)
    await w.cleanup()
  })

  it('several answers in one reading: one event each, in the server order, `count` rising to the last', async () => {
    const w = await watchWorld({ readings: [multi(3, [[A, 10, 'approve'], [B, 20, 'reject'], [C, 30, 'approve']])] })
    await w.watch.track(TRACKED, { roomId: ROOM, eventId: CARD })
    await flush()
    expect(w.events).toEqual([ev(A, 10, 'approve', 1), ev(B, 20, 'reject', 2), ev(C, 30, 'approve', 3)])
    expect(w.seals).toEqual([CARD])
    await w.cleanup()
  })

  it('an answer that cannot be read holds the seal; its event goes out when it decrypts, then the seal', async () => {
    const u = new FakeEvent({ id: '$u', sender: A, ts: 10, utd: true })
    const w = await watchWorld({
      readings: [multi(3, [[A, 10], [B, 20, 'reject'], [C, 30, 'approve']], { pendings: [u] }), multi(3, [[A, 10, 'approve'], [B, 20, 'reject'], [C, 30, 'approve']])],
    })
    await w.watch.track(TRACKED, { roomId: ROOM, eventId: CARD })
    await flush()
    expect(w.events).toEqual([ev(B, 20, 'reject', 1), ev(C, 30, 'approve', 2)])
    expect(w.seals).toEqual([])
    expect(w.timers.some((t) => !t.cancelled && t.ms === 60_000)).toBe(true)
    u.emit('Event.decrypted')
    await flush()
    expect(w.events.at(-1)).toEqual(ev(A, 10, 'approve', 3))
    expect(w.events).toHaveLength(3)
    expect(w.seals).toEqual([CARD])
    await w.cleanup()
  })

  it('a removed answer: no event of withdrawal; the same person answering again (another instant) → its event', async () => {
    const w = await watchWorld({
      readings: [multi(3, [[A, 10, 'approve'], [B, 20, 'reject']]), multi(3, [[B, 20, 'reject']]), multi(3, [[B, 20, 'reject'], [A, 40, 'reject']])],
    })
    await w.watch.track(TRACKED, { roomId: ROOM, eventId: CARD })
    await flush()
    expect(w.events).toHaveLength(2)
    w.watch.noteEvent({ getWireContent: () => ({}), getType: () => 'm.room.redaction', event: { redacts: `$${A}-10` }, getContent: () => ({}) } as never)
    await flush()
    expect(w.events).toHaveLength(2)
    await w.touch()
    expect(w.events.at(-1)).toEqual(ev(A, 40, 'reject', 2))
    expect(w.seals).toEqual([])
    await w.cleanup()
  })

  it('closed short of N (found closed): what counted up to the close goes out, no seal, the card leaves the watch', async () => {
    const w = await watchWorld({ readings: [multi(3, [[A, 10, 'approve']], { closedAt: 50 })] })
    await w.watch.track(TRACKED, { roomId: ROOM, eventId: CARD })
    await flush()
    expect(w.events).toEqual([ev(A, 10, 'approve', 1)])
    expect(w.seals).toEqual([])
    expect(w.watch.size).toBe(0)
    await w.cleanup()
  })

  it('the file is written AFTER the event (at the event the answer is not on disk yet)', async () => {
    const atEmit: unknown[] = []
    const w = await watchWorld({ readings: [multi(3, []), multi(3, [[A, 10, 'approve']])], onEmit: (file) => atEmit.push(JSON.parse(readFileSync(file, 'utf8'))) })
    await w.watch.track(TRACKED, { roomId: ROOM, eventId: CARD })
    await flush()
    await w.touch()
    expect(atEmit).toEqual([{ cards: [{ ...TRACKED, emitted: [] }] }])
    expect(await w.onDisk()).toEqual({ cards: [{ ...TRACKED, emitted: [{ by: tokenOf(A), at: 10 }] }] })
    await w.cleanup()
  })

  it('boot with a partial card: what is on the list is not sent again; what came while down goes out', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'approvals-multi-boot-'))
    const file = join(dir, 'approvals.json')
    await writeFile(file, JSON.stringify({ cards: [{ ...TRACKED, emitted: [{ by: tokenOf(A), at: 10 }] }] }))
    const w = await watchWorld({ file, readings: [multi(3, [[A, 10, 'approve'], [B, 20, 'reject']])] })
    await w.watch.load()
    w.watch.recheckAll()
    await flush()
    expect(w.events).toEqual([ev(B, 20, 'reject', 2)])
    expect(await w.onDisk()).toEqual({ cards: [{ ...TRACKED, emitted: [{ by: tokenOf(A), at: 10 }, { by: tokenOf(B), at: 20 }] }] })
    await w.cleanup()
    await rm(dir, { recursive: true, force: true })
  })

  it('a stop between the event and the write: the next run sends that event again (at least once)', async () => {
    let snapshot = ''
    const first = await watchWorld({ readings: [multi(3, []), multi(3, [[A, 10, 'approve']])], onEmit: (f) => (snapshot = readFileSync(f, 'utf8')) })
    await first.watch.track(TRACKED, { roomId: ROOM, eventId: CARD })
    await flush()
    await first.touch()
    expect(first.events).toEqual([ev(A, 10, 'approve', 1)])
    await first.watch.stop()
    // The disk as it was at the event: the stop came before the write.
    const dir = await mkdtemp(join(tmpdir(), 'approvals-multi-stop-'))
    const file = join(dir, 'approvals.json')
    await writeFile(file, snapshot)
    const second = await watchWorld({ file, readings: [multi(3, [[A, 10, 'approve']])] })
    await second.watch.load()
    second.watch.recheckAll()
    await flush()
    expect(second.events).toEqual(first.events)
    await second.cleanup()
    await first.cleanup()
    await rm(dir, { recursive: true, force: true })
  })

  it('malformed entries: an invalid `needed` drops the entry; a malformed `emitted` is empty; a file without the new fields loads as before', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'approvals-multi-load-'))
    const file = join(dir, 'approvals.json')
    const base = { conversation: CONV, options: OPTIONS }
    await writeFile(
      file,
      JSON.stringify({
        cards: [
          { ...base, id: 'n1', needed: 1 },
          { ...base, id: 'n11', needed: 11 },
          { ...base, id: 'nx', needed: '3' },
          { ...base, id: 'n2.5', needed: 2.5 },
          { ...base, id: 'bad-emitted', needed: 3, emitted: [{ by: 1, at: 'x' }] },
          { ...base, id: 'no-emitted', needed: 2 },
          { ...base, id: 'plain' },
        ],
      }),
    )
    const w = await watchWorld({ file, readings: [multi(3, [[A, 10, 'approve']]), multi(2, []), { state: { kind: 'open' }, closedAt: undefined, ignored: [], answerIds: [] }] })
    await w.watch.load()
    expect(w.watch.size).toBe(3)
    w.watch.recheckAll()
    await flush()
    // The malformed list was empty: the answer goes out again.
    expect(w.events).toMatchObject([{ id: 'bad-emitted', count: 1, needed: 3 }])
    const disk = (await w.onDisk()) as { cards: Array<Record<string, unknown>> }
    expect(disk.cards.map((c) => c.id)).toEqual(['bad-emitted', 'no-emitted', 'plain'])
    expect(disk.cards[1]).toEqual({ ...base, id: 'no-emitted', needed: 2, emitted: [] })
    expect(disk.cards[2]).toEqual({ ...base, id: 'plain' })
    await w.cleanup()
    await rm(dir, { recursive: true, force: true })
  })
})

// ── Facade ───────────────────────────────────────────────────────────────────────────────────────────
const cardContent = (needed: unknown, extra: Record<string, unknown> = {}) => ({ msgtype: 'io.tayet.approval', body: 'Publicar?', 'io.tayet.approval': { options: OPTIONS, needed, ...extra } })

async function facadeWorld(cards: Array<{ id: string; original?: Record<string, unknown>; shown?: Record<string, unknown> }>, readings: CardReading[] = []) {
  const local = new Map(
    cards.map((e) => {
      const original = e.original ?? cardContent(3)
      return [
        e.id,
        {
          getId: () => e.id,
          getSender: () => ME,
          getType: () => 'm.room.message',
          getTs: () => 1_000,
          getContent: () => e.shown ?? original,
          getOriginalContent: () => original,
          getWireContent: () => ({}),
          isRedacted: () => false,
          localRedactionEvent: () => null,
          isDecryptionFailure: () => false,
          replacingEvent: () => null,
          replacingEventId: () => undefined,
          status: null,
        },
      ]
    }),
  )
  const room = { roomId: ROOM, getMyMembership: () => 'join', findEventById: (id: string) => local.get(id), getPendingEvents: () => [], relations: { getChildEventsForEvent: () => undefined } }
  const resolver: Resolver = {
    roomAnyOf: (t) => {
      if (t !== CONV) throw new ReadError('conversation_not_found')
      return room as never
    },
    userOf: () => '',
    eventOf: (_r, ts) => (ts.startsWith('ts-') ? Promise.resolve(ts.slice(3)) : Promise.reject(new ReadError('message_not_found'))),
    tsOf: (_r, id) => `ts-${id}`,
    tsOfRelated: (_r, id) => Promise.resolve(`ts-${id}`),
    tokenOfRoom: () => CONV,
    tokenOfPerson: (u) => (u === ME ? 'UME00000000' : tokenOf(u)),
    file: () => undefined,
    noteFile: () => 'F',
  }
  const jobs: WriteJob[] = []
  let n = 0
  const queue = [...readings]
  const reads: Array<{ needed?: number; closedAt?: number }> = []
  let last: CardReading = multi(3, [])
  const cardReader: CardReader = {
    read: (_room, _card, _options, opts = {}) => {
      reads.push({ ...(opts.needed !== undefined && { needed: opts.needed }), ...(opts.closedAt !== undefined && { closedAt: opts.closedAt }) })
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
  const dir = await mkdtemp(join(tmpdir(), 'approvals-multi-facade-'))
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
  return {
    core,
    write,
    jobs,
    watch,
    reads,
    apiEvents,
    dir,
    cleanup: async () => {
      await watch.saved()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

const block = (job: WriteJob | undefined): unknown => {
  const content = (job as { content?: Record<string, unknown> } | undefined)?.content ?? {}
  const next = (content['m.new_content'] ?? content) as Record<string, unknown>
  return next['io.tayet.approval']
}

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p
    return 'ok'
  } catch (err) {
    return (err as { code: string }).code
  }
}

describe('approval facade with `needed` (ADR-104)', () => {
  it('request: `needed` in the block, kept by the watch and on disk, answered with `needed` and no answers', async () => {
    const f = await facadeWorld([])
    const out = await f.core.facade.request(CONV, { text: 'Publicar?', options: OPTIONS, needed: 3 })
    expect(block(f.jobs[0])).toEqual({ options: OPTIONS, needed: 3 })
    expect(f.reads[0]).toEqual({ needed: 3 })
    expect(out.approval).toEqual({ options: OPTIONS, needed: 3, answers: [], state: 'open' })
    await f.watch.saved()
    expect(JSON.parse(await readFile(join(f.dir, 'approvals.json'), 'utf8'))).toEqual({ cards: [{ conversation: CONV, id: 'ts-$sent1', options: OPTIONS, needed: 3, emitted: [] }] })
    for (const bad of [1, 11, 2.5, Number.NaN]) expect(await code(f.core.facade.request(CONV, { text: 'x', options: OPTIONS, needed: bad }))).toBe('invalid_argument')
    expect(f.jobs).toHaveLength(1)
    await f.cleanup()
  })

  it('state of an own card: open with an answer not read yet (no option), answered with N read, closed short of N', async () => {
    const f = await facadeWorld([{ id: '$c' }], [multi(2, [[A, 10, 'approve'], [B, 20]]), multi(2, [[A, 10, 'approve'], [B, 20, 'reject']]), multi(2, [[A, 10, 'approve']], { closedAt: 50 })])
    const answers = [{ option: 'approve', by: tokenOf(A), at: 10 }]
    expect((await f.core.facade.state(CONV, 'ts-$c')).approval).toEqual({ options: OPTIONS, needed: 2, answers: [...answers, { by: tokenOf(B), at: 20 }], state: 'open' })
    expect((await f.core.facade.state(CONV, 'ts-$c')).approval).toEqual({ options: OPTIONS, needed: 2, answers: [...answers, { option: 'reject', by: tokenOf(B), at: 20 }], state: 'answered' })
    expect((await f.core.facade.state(CONV, 'ts-$c')).approval).toEqual({ options: OPTIONS, needed: 2, answers, state: 'closed' })
    expect(f.reads.every((r) => r.needed === 3)).toBe(true)
    // Another agent's card: the options and `needed`, no state.
    expect(await f.core.approvalOf(ROOM, '$x', OPTIONS, false, 3)).toEqual({ options: OPTIONS, needed: 3 })
    await f.cleanup()
  })

  it('an invalid declaration on the card: not_approval, no write', async () => {
    const f = await facadeWorld([{ id: '$bad', original: cardContent(1) }, { id: '$str', original: cardContent('3') }])
    expect(await code(f.core.facade.state(CONV, 'ts-$bad'))).toBe('not_approval')
    expect(await code(f.core.facade.close(CONV, 'ts-$str'))).toBe('not_approval')
    expect(f.jobs).toEqual([])
    await f.cleanup()
  })

  it('the agent closes short of N: the close keeps `needed`, what counted goes out, the answer is `closed` with the answers', async () => {
    const f = await facadeWorld([{ id: '$c' }], [multi(3, [[A, 10, 'approve']]), multi(3, [[A, 10, 'approve'], [B, 1_500, 'reject']], { closedAt: 2_000 })])
    const out = await f.core.facade.close(CONV, 'ts-$c')
    expect(f.jobs).toHaveLength(1)
    expect(block(f.jobs[0])).toEqual({ options: OPTIONS, needed: 3, closed: true })
    expect(f.reads.at(-1)).toEqual({ needed: 3, closedAt: 2_000 })
    expect(f.apiEvents).toMatchObject([
      { option: 'approve', count: 1, needed: 3 },
      { option: 'reject', count: 2, needed: 3 },
    ])
    expect(out.approval).toMatchObject({ needed: 3, state: 'closed', answers: [{ option: 'approve' }, { option: 'reject' }] })
    expect(f.watch.size).toBe(0)
    await f.cleanup()
  })

  it('complete before the close: the seal is the close (one write, keeping `needed`), the answer is `answered`', async () => {
    const full = multi(2, [[A, 10, 'approve'], [B, 20, 'reject']])
    const f = await facadeWorld([{ id: '$c', original: cardContent(2) }], [full])
    const out = await f.core.facade.close(CONV, 'ts-$c', 'texto do fecho')
    expect(f.jobs).toHaveLength(1)
    expect(block(f.jobs[0])).toEqual({ options: OPTIONS, needed: 2, closed: true })
    expect(f.apiEvents).toHaveLength(2)
    expect(out.approval).toMatchObject({ needed: 2, state: 'answered' })
    await f.cleanup()
  })

  it('PATCH and seal carry the original `needed`', async () => {
    const f = await facadeWorld([{ id: '$open' }, { id: '$seal' }])
    await f.write.edit(CONV, 'ts-$open', 'Novo pedido')
    expect(block(f.jobs[0])).toEqual({ options: OPTIONS, needed: 3 })
    await f.core.seal(ROOM, '$seal')
    expect(block(f.jobs[1])).toEqual({ options: OPTIONS, needed: 3, closed: true })
    await f.cleanup()
  })
})
