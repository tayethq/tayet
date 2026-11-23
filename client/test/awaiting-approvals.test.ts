import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClientEvent, EventStatus, MatrixEvent, MatrixEventEvent, RoomEvent, SyncState, type IEvent } from 'matrix-js-sdk'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import { APPROVAL_CACHE_CAP, ApprovalAggregator, type AnswerPage } from '../src/acl/internal/approval-state'
import { AWAITING_CAP, AWAITING_CONCURRENCY, AWAITING_REQUEST_DEADLINE_MS } from '../src/acl/internal/awaiting-approvals'
import { SearchIndex } from '../src/acl/internal/search-index'
import type { SearchEntry, SearchStore } from '../src/acl/internal/search-store'
import { APPROVAL_BLOCK, APPROVAL_MSGTYPE, APPROVAL_RESPONSE_BLOCK, APPROVAL_RESPONSE_MSGTYPE, RESPONSE_REL_TYPE } from '@tayet/shared/internal'
import type { AclTelemetry, AwaitingApproval, DomainEvent, MessageId } from '../src/acl'

// ADR-099 (PLANO-MOBILE §0.19): the cards that wait for this person, across conversations. No stack: a
// fake client and room over real SDK events, the shape of approval-state.test.ts's gateway harness. The
// fake has two doors, as the product has: `reads` are this read's requests (authedRequest, with a signal)
// and `timelineReads` are the timeline path's (client.fetchRelations).

const ME = '@me:tayet.local'
const AGENT = '@a-abcdefghijkm:tayet.local'
const BOB = '@bob:tayet.local'
const CAROL = '@carol:tayet.local'
const ROOM_ID = '!room:tayet.local'
const OPTIONS = [
  { id: 'approve', label: 'Aprovar' },
  { id: 'reject', label: 'Rejeitar' },
]
const noopTelemetry: AclTelemetry = { untranslated: () => {} }

type Raw = Partial<IEvent> & { event_id: string }
type Handler = (...args: never[]) => void
type Read = { kind: 'event' | 'answers' | 'edits'; id: string; signal: AbortSignal }

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

const cardRaw = (id: string, ts = 1000, block: Record<string, unknown> = {}): Raw => ({
  event_id: id,
  room_id: ROOM_ID,
  sender: AGENT,
  type: 'm.room.message',
  origin_server_ts: ts,
  content: { msgtype: APPROVAL_MSGTYPE, body: `Pedido ${id}`, [APPROVAL_BLOCK]: { options: OPTIONS, ...block } },
})
const answerRaw = (id: string, card: string, sender: string, ts = 5000, option = 'approve'): Raw => ({
  event_id: id,
  room_id: ROOM_ID,
  sender,
  type: 'm.room.message',
  origin_server_ts: ts,
  content: {
    msgtype: APPROVAL_RESPONSE_MSGTYPE,
    body: option,
    [APPROVAL_RESPONSE_BLOCK]: { option },
    'm.relates_to': { rel_type: RESPONSE_REL_TYPE, event_id: card },
  },
})
const editRaw = (id: string, card: string, over: { closed?: boolean; sender?: string; ts?: number; text?: string } = {}): Raw => ({
  event_id: id,
  room_id: ROOM_ID,
  sender: over.sender ?? AGENT,
  type: 'm.room.message',
  origin_server_ts: over.ts ?? 4000,
  content: {
    msgtype: APPROVAL_MSGTYPE,
    body: '* editado',
    'm.new_content': {
      msgtype: APPROVAL_MSGTYPE,
      body: over.text ?? 'editado',
      [APPROVAL_BLOCK]: { options: OPTIONS, ...((over.closed ?? true) && { closed: true }) },
    },
    'm.relates_to': { rel_type: 'm.replace', event_id: card },
  },
})

const entryOf = (raw: Raw): SearchEntry =>
  ({
    eventId: raw.event_id,
    roomId: raw.room_id,
    sender: raw.sender,
    ts: raw.origin_server_ts,
    text: 'pedido',
    norm: 'pedido',
    snapshot: { body: { kind: 'approval', text: 'pedido', options: OPTIONS, state: { kind: 'open' } } },
  }) as unknown as SearchEntry

function harness() {
  const server = {
    events: new Map<string, Raw>(),
    answers: new Map<string, Raw[]>(),
    edits: new Map<string, Raw[]>(),
    // The clear content of an encrypted event, for the fake decryption.
    keys: new Map<string, Record<string, unknown>>(),
  }
  const loaded: MatrixEvent[] = []
  let membership = 'join'
  const room = {
    roomId: ROOM_ID,
    getCanonicalAlias: () => null,
    getMyMembership: () => membership,
    isSpaceRoom: () => false,
    findEventById: (id: string) => loaded.find((e) => e.getId() === id),
    getThread: () => undefined,
    getThreads: () => [],
    getEventForTxnId: () => undefined,
    getLiveTimeline: () => ({ getEvents: () => loaded, getPaginationToken: () => null }),
    getUnfilteredTimelineSet: () => ({ getTimelines: () => [{ getEvents: () => loaded }] }),
    relations: { getChildEventsForEvent: () => undefined },
    hasEncryptionStateEvent: () => false,
  }

  const reads: Read[] = []
  const load = { now: 0, max: 0 }
  // A test may hold or fail a request here, before the server answers it.
  const hook: { before?: (read: Read) => Promise<void> | void } = {}
  const authedRequest = async (_method: unknown, path: string, _q: unknown, _b: unknown, opts: { abortSignal: AbortSignal }): Promise<unknown> => {
    const rel = path.match(/\/relations\/([^/]+)\/([^/]+)$/)
    const id = decodeURIComponent(rel ? rel[1]! : path.match(/\/event\/([^/]+)$/)![1]!)
    const kind = !rel ? 'event' : decodeURIComponent(rel[2]!) === RESPONSE_REL_TYPE ? 'answers' : 'edits'
    const read: Read = { kind, id, signal: opts.abortSignal }
    reads.push(read)
    load.now += 1
    load.max = Math.max(load.max, load.now)
    try {
      await hook.before?.(read)
      await new Promise((r) => setTimeout(r, 0))
      if (kind === 'answers') return { chunk: structuredClone(server.answers.get(id) ?? []) }
      if (kind === 'edits') return { chunk: structuredClone(server.edits.get(id) ?? []) }
      const raw = server.events.get(id)
      if (!raw) throw new Error('not found')
      const latest = server.edits.get(id)?.at(-1)
      return structuredClone({ ...raw, unsigned: { ...raw.unsigned, ...(latest && { 'm.relations': { 'm.replace': latest } }) } })
    } finally {
      load.now -= 1
    }
  }

  const timelineReads = vi.fn(async (_room: string, id: string, relType: string) => ({
    chunk: structuredClone((relType === RESPONSE_REL_TYPE ? server.answers : server.edits).get(id) ?? []),
  }))
  const sends: Array<{ resolve: (v: { event_id: string }) => void; reject: (e: unknown) => void }> = []
  let txn = 0
  const handlers = new Map<string, Handler[]>()
  const client = {
    http: { authedRequest },
    getRooms: () => [room],
    getRoom: (id: string) => (id === ROOM_ID ? room : null),
    getCrypto: () => undefined,
    getUserId: () => ME,
    getAccountData: () => undefined,
    fetchRelations: timelineReads,
    fetchRoomEvent: async (_room: string, id: string) => server.events.get(id),
    getEventMapper: () => (raw: Partial<IEvent>) => new MatrixEvent(raw),
    decryptEventIfNeeded: async (ev: MatrixEvent) => {
      const content = server.keys.get(ev.getId() ?? '')
      if (content) Object.assign(ev, { clearEvent: { type: 'm.room.message', content } })
    },
    makeTxnId: () => `t${++txn}`,
    sendEvent: () => new Promise<{ event_id: string }>((resolve, reject) => sends.push({ resolve, reject })),
    cancelPendingEvent: () => {},
    stopClient: () => {},
    on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
    off: () => {},
  }

  const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
  const store: SearchStore = {
    load: async () => ({ entries: [], cursors: [] }),
    putEntries: async () => {},
    deleteEntries: async () => {},
    putCursor: async () => {},
    close: () => {},
  }
  const index = new SearchIndex(store)
  const g = gateway as unknown as {
    client: unknown
    live: boolean
    search: SearchIndex
    wireEvents(c: unknown): void
    ctx(room: unknown): unknown
    translateAll(events: MatrixEvent[], ctx: unknown): unknown
    approvalCards: Map<string, MatrixEvent>
    awaiting: { start(): void; holds(id: string): boolean }
  }
  g.client = client
  g.search = index
  g.wireEvents(client)
  g.live = true

  const events: DomainEvent[] = []
  gateway.subscribe((e) => events.push(e))
  const fire = (name: string, ...args: unknown[]): void => {
    for (const h of handlers.get(name) ?? []) (h as (...a: unknown[]) => void)(...args)
  }
  const lists = (): AwaitingApproval[][] => events.flatMap((e) => (e.t === 'approvals.awaiting' ? [e.items] : []))

  return {
    gateway, g, server, index, reads, load, hook, timelineReads, sends, events, lists,
    listed: (): string[] | undefined => lists().at(-1)?.map((i) => i.message.id as unknown as string),
    // A card the session holds in its window.
    inWindow(raw: Raw) {
      server.events.set(raw.event_id, raw)
      loaded.push(new MatrixEvent(structuredClone(raw)))
    },
    // A card only the index knows: older than the window.
    inIndex(raw: Raw) {
      server.events.set(raw.event_id, raw)
      index.upsert([entryOf(raw)])
    },
    // An event the sync delivers: on the server, in the room, on the timeline.
    live(raw: Raw) {
      server.events.set(raw.event_id, raw)
      const content = raw.content as { 'm.relates_to'?: { rel_type: string; event_id: string } }
      const rel = content['m.relates_to']
      if (rel) {
        const map = rel.rel_type === RESPONSE_REL_TYPE ? server.answers : server.edits
        map.set(rel.event_id, [...(map.get(rel.event_id) ?? []), raw])
      }
      const event = new MatrixEvent(structuredClone(raw))
      loaded.push(event)
      fire(RoomEvent.Timeline, event, room, false, false, { liveEvent: true })
    },
    // A deletion as the SDK delivers it: reported as one only when the room holds the target.
    redact(target: string) {
      const raw = { event_id: `$red-${target}`, room_id: ROOM_ID, sender: BOB, type: 'm.room.redaction', origin_server_ts: 9000, redacts: target, content: {} }
      for (const [card, list] of server.answers) server.answers.set(card, list.filter((r) => r.event_id !== target))
      const event = new MatrixEvent(raw)
      const held = loaded.find((e) => e.getId() === target)
      if (held) {
        loaded.splice(loaded.indexOf(held), 1)
        fire(RoomEvent.Redaction, event, room)
      }
      fire(RoomEvent.Timeline, event, room, false, false, { liveEvent: true })
    },
    decrypted(event: MatrixEvent) {
      fire(MatrixEventEvent.Decrypted, event)
    },
    reconnect() {
      fire(ClientEvent.Sync, SyncState.Reconnecting)
      fire(ClientEvent.Sync, SyncState.Syncing)
    },
    leave() {
      membership = 'leave'
      fire(RoomEvent.MyMembership, room, 'leave', 'join')
    },
    roomEvent: (id: string) => room.findEventById(id)!,
    room,
  }
}
type Harness = ReturnType<typeof harness>

async function watched(h: Harness): Promise<() => void> {
  const off = h.gateway.watchAwaitingApprovals()
  await vi.waitFor(() => expect(h.lists().length).toBeGreaterThan(0), { timeout: 10_000 })
  await flush()
  return off
}
const answer = (h: Harness, id: string, option = 'approve'): Promise<void> => h.gateway.answerApproval(id as unknown as MessageId, option)

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('no observer costs nothing', () => {
  it('live cards, answers, deletions and a reconnection make no request of this read and emit no list', async () => {
    const h = harness()
    h.inIndex(cardRaw('$old'))
    h.live(cardRaw('$new', 2000))
    h.live(answerRaw('$r1', '$new', BOB))
    h.redact('$r1')
    h.reconnect()
    await flush()
    expect(h.reads).toEqual([])
    expect(h.lists()).toEqual([])
    expect(h.g.awaiting.holds('$new')).toBe(false)
  })

  it('the last observer to leave stops it: the requests in flight are aborted and nothing is emitted after', async () => {
    const h = harness()
    for (let i = 0; i < 10; i++) h.inIndex(cardRaw(`$c${i}`))
    h.hook.before = () => new Promise<void>(() => {})
    const first = h.gateway.watchAwaitingApprovals()
    const second = h.gateway.watchAwaitingApprovals()
    await flush()
    expect(h.reads).toHaveLength(AWAITING_CONCURRENCY)
    first()
    first() // idempotent: it does not count for the second observer
    expect(h.reads.some((r) => r.signal.aborted)).toBe(false)
    second()
    await flush()
    expect(h.reads).toHaveLength(AWAITING_CONCURRENCY)
    expect(h.reads.every((r) => r.signal.aborted)).toBe(true)
    h.reconnect()
    await flush()
    expect(h.reads).toHaveLength(AWAITING_CONCURRENCY)
    expect(h.lists()).toEqual([])
  })

  it('a new observer after a stop reads again from the start', async () => {
    const h = harness()
    h.inIndex(cardRaw('$c'))
    ;(await watched(h))()
    h.events.length = 0
    await watched(h)
    expect(h.listed()).toEqual(['$c'])
    expect(h.reads.filter((r) => r.kind === 'event')).toHaveLength(2)
  })

  it('an observer that comes before the session is live waits for it', async () => {
    const h = harness()
    h.inIndex(cardRaw('$c'))
    h.g.live = false
    h.gateway.watchAwaitingApprovals()
    await flush()
    expect(h.reads).toEqual([])
    h.g.live = true
    h.g.awaiting.start()
    await flush()
    expect(h.listed()).toEqual(['$c'])
  })

  it('disconnect aborts what is in flight', async () => {
    const h = harness()
    h.inIndex(cardRaw('$c'))
    h.hook.before = () => new Promise<void>(() => {})
    h.gateway.watchAwaitingApprovals()
    await flush()
    await h.gateway.disconnect()
    expect(h.reads[0]!.signal.aborted).toBe(true)
    expect(h.lists()).toEqual([])
  })
})

describe('sources, order and cap', () => {
  it('both sources, no card twice, newest first', async () => {
    const h = harness()
    h.inWindow(cardRaw('$b', 2000))
    h.inIndex(cardRaw('$a', 1000))
    h.inIndex(cardRaw('$c', 3000))
    h.index.upsert([entryOf(cardRaw('$b', 2000))])
    await watched(h)
    expect(h.listed()).toEqual(['$c', '$b', '$a'])
    expect(h.reads.filter((r) => r.kind === 'event' && r.id === '$b')).toHaveLength(1)
    expect(h.lists().at(-1)![0]).toMatchObject({ channel: ROOM_ID, message: { author: AGENT, sentAt: 3000, body: { kind: 'approval', state: { kind: 'open' } } } })
  })

  it(`the ${AWAITING_CAP} newest, the two sources added up; the rest is not even read`, async () => {
    const h = harness()
    const total = AWAITING_CAP + 40
    for (let i = 0; i < total; i++) (i % 2 ? h.inWindow : h.inIndex)(cardRaw(`$c${i}`, 1000 + i))
    await watched(h)
    expect(h.listed()).toEqual(Array.from({ length: AWAITING_CAP }, (_, i) => `$c${total - 1 - i}`))
    expect(new Set(h.reads.map((r) => r.id)).size).toBe(AWAITING_CAP)
  }, 20_000)

  it('a live card newer than a full list pushes the oldest out', async () => {
    const h = harness()
    for (let i = 0; i < AWAITING_CAP; i++) h.inIndex(cardRaw(`$c${i}`, 1000 + i))
    await watched(h)
    h.live(cardRaw('$new', 9000))
    await flush()
    expect(h.listed()).toHaveLength(AWAITING_CAP)
    expect(h.listed()![0]).toBe('$new')
    expect(h.listed()).not.toContain('$c0')
  }, 20_000)

  it('one emission when the first pass ends, empty too, and none for a pass that changes nothing', async () => {
    const empty = harness()
    await watched(empty)
    expect(empty.lists()).toEqual([[]])

    const h = harness()
    h.inIndex(cardRaw('$a'))
    h.inIndex(cardRaw('$b', 2000))
    await watched(h)
    expect(h.lists()).toHaveLength(1)
    h.reconnect()
    await flush()
    expect(h.reads.filter((r) => r.kind === 'event')).toHaveLength(4)
    expect(h.lists()).toHaveLength(1)
  })

  it('a text message, a card from a person and a card of a conversation the session left are no candidates', async () => {
    const h = harness()
    h.inWindow({ ...cardRaw('$text'), content: { msgtype: 'm.text', body: 'oi' } })
    h.inWindow({ ...cardRaw('$forged'), sender: BOB })
    h.index.upsert([entryOf({ ...cardRaw('$gone'), room_id: '!left:tayet.local' })])
    await watched(h)
    expect(h.reads).toEqual([])
    expect(h.listed()).toEqual([])
  })

  it('leaving the conversation takes its cards off', async () => {
    const h = harness()
    h.inIndex(cardRaw('$c'))
    await watched(h)
    h.leave()
    expect(h.listed()).toEqual([])
  })
})

describe('requests', () => {
  it('the numbers of the decision: 200 cards, 4 at a time', () => {
    expect([AWAITING_CAP, AWAITING_CONCURRENCY]).toEqual([200, 4])
  })

  it('paginated answers are read forward until the card is settled, and no further', async () => {
    const pages: Record<string, AnswerPage> = {
      start: { answers: [{ eventId: '$a', sender: AGENT, ts: 1, decrypted: true, option: 'approve' }], next: 'p2' },
      p2: { answers: [{ eventId: '$b', sender: BOB, ts: 2, decrypted: true, option: 'reject' }], next: 'p3' },
    }
    const fetchPage = vi.fn(async (_r: string, _c: string, from: string | undefined) => pages[from ?? 'start']!)
    const none = vi.fn(async () => ({ answers: [], edits: [] }))
    const agg = new ApprovalAggregator({ fetchPage: none, fetchEditPage: none, accounts: () => ({}), changed: () => {}, detach: () => {} })
    const facts = { options: OPTIONS, author: AGENT, closedAt: undefined, bornClosedAt: undefined, edited: false }
    expect(await agg.refresh(ROOM_ID, '$c', facts, { fetchPage, fetchEditPage: none })).toBe(true)
    expect(fetchPage.mock.calls.map((c) => c[2])).toEqual([undefined, 'p2'])
    expect(agg.peek(ROOM_ID, '$c')).toMatchObject({ kind: 'answered', by: BOB })
    expect(none).not.toHaveBeenCalled()
  })

  it(`at most ${AWAITING_CONCURRENCY} in flight`, async () => {
    const h = harness()
    for (let i = 0; i < 30; i++) h.inIndex(cardRaw(`$c${i}`))
    await watched(h)
    expect(h.load.max).toBe(AWAITING_CONCURRENCY)
    expect(h.reads).toHaveLength(60)
    expect(h.timelineReads).not.toHaveBeenCalled()
  })

  it('the event and the answers; the edits only for an edited card', async () => {
    const h = harness()
    h.inIndex(cardRaw('$plain'))
    h.inIndex(cardRaw('$edited', 2000))
    h.server.edits.set('$edited', [editRaw('$e', '$edited', { closed: false, text: 'Texto novo' })])
    await watched(h)
    const kinds = (id: string): string[] => h.reads.filter((r) => r.id === id).map((r) => r.kind).sort()
    expect(kinds('$plain')).toEqual(['answers', 'event'])
    expect(kinds('$edited')).toEqual(['answers', 'edits', 'event'])
    expect(h.lists().at(-1)![0]!.message.body).toMatchObject({ text: 'Texto novo', state: { kind: 'open' } })
  })

  it('a request past its deadline is aborted, frees its place, and its card is out', async () => {
    const h = harness()
    h.inIndex(cardRaw('$slow', 1000))
    h.inIndex(cardRaw('$fast', 2000))
    h.hook.before = (read) => (read.id === '$slow' ? new Promise<void>(() => {}) : undefined)
    vi.useFakeTimers()
    h.gateway.watchAwaitingApprovals()
    await vi.advanceTimersByTimeAsync(AWAITING_REQUEST_DEADLINE_MS - 1)
    expect(h.lists()).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(h.reads.find((r) => r.id === '$slow')!.signal.aborted).toBe(true)
    expect(h.listed()).toEqual(['$fast'])
  })
})

describe('a card whose state was not read is not listed', () => {
  for (const kind of ['event', 'answers', 'edits'] as const) {
    it(`a failed ${kind} read keeps it out, without a word in the console; the next pass tries again`, async () => {
      const h = harness()
      const consoled = (['log', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}))
      h.inWindow(cardRaw('$c'))
      h.server.edits.set('$c', [editRaw('$e', '$c', { closed: false })])
      h.hook.before = (read) => {
        if (read.kind === kind) throw new Error('offline')
      }
      await watched(h)
      expect(h.listed()).toEqual([])
      for (const spy of consoled) expect(spy).not.toHaveBeenCalled()
      h.hook.before = undefined
      h.reconnect()
      await flush()
      expect(h.listed()).toEqual(['$c'])
    })
  }

  it('the provisional open of the timeline never reaches the list', async () => {
    const h = harness()
    h.timelineReads.mockRejectedValue(new Error('offline'))
    await watched(h)
    h.live(cardRaw('$c'))
    await flush()
    const received = h.events.find((e) => e.t === 'message.received')
    expect(received?.t === 'message.received' && received.message.body).toMatchObject({ state: { kind: 'open' } })
    expect(h.listed()).toEqual([])
  })

  it('a listed card whose later read fails leaves', async () => {
    const h = harness()
    h.inIndex(cardRaw('$c'))
    await watched(h)
    h.hook.before = () => {
      throw new Error('offline')
    }
    h.reconnect()
    await flush()
    expect(h.listed()).toEqual([])
  })

  it('a candidate that does not decrypt is out, without error; with the key, it enters on the next pass', async () => {
    const h = harness()
    const clear = cardRaw('$enc')
    h.inIndex({ ...clear, type: 'm.room.encrypted', content: { algorithm: 'a', ciphertext: 'x' } })
    await watched(h)
    expect(h.listed()).toEqual([])
    h.server.keys.set('$enc', clear.content as Record<string, unknown>)
    h.reconnect()
    await flush()
    expect(h.listed()).toEqual(['$enc'])
  })

  it('a window card whose key comes after the pass enters when it decrypts', async () => {
    const h = harness()
    const clear = cardRaw('$enc')
    h.inWindow({ ...clear, type: 'm.room.encrypted', content: { algorithm: 'a', ciphertext: 'x' } })
    await watched(h)
    expect(h.reads).toEqual([])
    h.server.keys.set('$enc', clear.content as Record<string, unknown>)
    const event = h.roomEvent('$enc')
    Object.assign(event, { clearEvent: { type: 'm.room.message', content: clear.content } })
    h.decrypted(event)
    await flush()
    expect(h.listed()).toEqual(['$enc'])
  })

  it('an edit that does not decrypt may be the close: out, and no failure of translation', async () => {
    const untranslated = vi.spyOn(noopTelemetry, 'untranslated')
    const h = harness()
    h.inIndex(cardRaw('$c'))
    h.server.edits.set('$c', [{ ...editRaw('$e', '$c'), type: 'm.room.encrypted', content: { algorithm: 'a', ciphertext: 'x' } }])
    await watched(h)
    expect(h.listed()).toEqual([])
    expect(untranslated).not.toHaveBeenCalled()
  })

  it('a deleted candidate is out and its entry leaves the index', async () => {
    const h = harness()
    h.inIndex({ ...cardRaw('$dead'), content: {}, unsigned: { redacted_because: { type: 'm.room.redaction' } as never } })
    h.inIndex(cardRaw('$alive'))
    await watched(h)
    expect(h.listed()).toEqual(['$alive'])
    expect(h.index.get('$dead')).toBeUndefined()
    expect(h.index.get('$alive')).toBeDefined()
  })

  it('answered, closed, born closed and one’s own answer on a card of several: read and out', async () => {
    const h = harness()
    h.inIndex(cardRaw('$answered'))
    h.server.answers.set('$answered', [answerRaw('$r1', '$answered', BOB)])
    h.inIndex(cardRaw('$closed'))
    h.server.edits.set('$closed', [editRaw('$e', '$closed')])
    h.inIndex(cardRaw('$born', 1000, { closed: true }))
    h.inIndex(cardRaw('$mine', 1000, { needed: 3 }))
    h.server.answers.set('$mine', [answerRaw('$r2', '$mine', ME)])
    h.inIndex(cardRaw('$others', 1000, { needed: 3 }))
    h.server.answers.set('$others', [answerRaw('$r3', '$others', BOB)])
    await watched(h)
    expect(h.listed()).toEqual(['$others'])
    // Re-emitting what the read moved starts no read outside this one's limit (a card's form reply).
    expect(h.timelineReads).not.toHaveBeenCalled()
  })
})

describe('live, with no new request of this read', () => {
  // Both sources: a card the room holds and one it does not.
  for (const source of ['inWindow', 'inIndex'] as const) {
    const ready = async (): Promise<Harness> => {
      const h = harness()
      h[source](cardRaw('$c'))
      await watched(h)
      expect(h.listed()).toEqual(['$c'])
      h.reads.length = 0
      return h
    }

    it(`${source}: another person's answer takes it out`, async () => {
      const h = await ready()
      h.live(answerRaw('$r', '$c', BOB))
      expect(h.listed()).toEqual([])
      expect(h.reads).toEqual([])
      expect(h.timelineReads).not.toHaveBeenCalled()
    })

    it(`${source}: an agent's answer does not`, async () => {
      const h = await ready()
      h.live(answerRaw('$r', '$c', AGENT))
      expect(h.listed()).toEqual(['$c'])
    })

    it(`${source}: the agent's close takes it out; another member's does not`, async () => {
      const h = await ready()
      h.live(editRaw('$forged', '$c', { sender: BOB }))
      expect(h.listed()).toEqual(['$c'])
      h.live(editRaw('$close', '$c'))
      expect(h.listed()).toEqual([])
      expect(h.reads).toEqual([])
      expect(h.timelineReads).not.toHaveBeenCalled()
    })

    it(`${source}: one's own answer takes it out, sending and accepted`, async () => {
      const h = await ready()
      const done = answer(h, '$c')
      expect(h.listed()).toEqual([])
      h.server.answers.set('$c', [answerRaw('$mine', '$c', ME)])
      h.sends[0]!.resolve({ event_id: '$mine' })
      await done
      await flush()
      expect(h.listed()).toEqual([])
      expect(h.reads).toEqual([])
    })

    it(`${source}: one's own answer that fails keeps it, failed`, async () => {
      const h = await ready()
      const done = answer(h, '$c', 'reject')
      h.sends[0]!.reject(Object.assign(new Error('offline'), { status: EventStatus.NOT_SENT }))
      await expect(done).rejects.toThrow('offline')
      expect(h.listed()).toEqual(['$c'])
      expect(h.lists().at(-1)![0]!.message.body).toMatchObject({ state: { kind: 'failed', option: 'reject' } })
    })

    it(`${source}: a deleted answer brings it back`, async () => {
      const h = await ready()
      h.live(answerRaw('$r', '$c', BOB))
      h.redact('$r')
      expect(h.listed()).toEqual(['$c'])
      expect(h.reads).toEqual([])
      expect(h.timelineReads).not.toHaveBeenCalled()
    })

    it(`${source}: a deleted card leaves, and the index with it`, async () => {
      const h = await ready()
      h.index.upsert([entryOf(cardRaw('$c'))])
      h.redact('$c')
      expect(h.listed()).toEqual([])
      expect(h.index.get('$c')).toBeUndefined()
      expect(h.reads).toEqual([])
    })
  }

  it('a new card enters', async () => {
    const h = harness()
    await watched(h)
    h.live(cardRaw('$new', 2000))
    await flush()
    expect(h.listed()).toEqual(['$new'])
    expect(h.reads).toEqual([])
  })

  it('a deleted answer known only from the relations brings its card back', async () => {
    const h = harness()
    h.inIndex(cardRaw('$c'))
    h.server.answers.set('$c', [answerRaw('$r', '$c', BOB)])
    await watched(h)
    expect(h.listed()).toEqual([])
    h.reads.length = 0
    h.redact('$r')
    expect(h.listed()).toEqual(['$c'])
    expect(h.reads).toEqual([])
  })

  it('a text edit changes the item and keeps it', async () => {
    const h = harness()
    h.inIndex(cardRaw('$c'))
    await watched(h)
    h.live(editRaw('$e', '$c', { closed: false, text: 'Pedido novo' }))
    await flush()
    expect(h.listed()).toEqual(['$c'])
    expect(h.lists().at(-1)![0]!.message.body).toMatchObject({ text: 'Pedido novo' })
  })
})

describe('what moves while a read runs', () => {
  // Holds the first request of a kind until released, then lets the server answer with what it had.
  const held = (h: Harness, kind: Read['kind']): (() => void) => {
    let release = (): void => {}
    const gate = new Promise<void>((r) => (release = r))
    h.hook.before = (read) => (read.kind === kind ? gate : undefined)
    return release
  }

  it('an answer that arrives during the read of the answers is not lost', async () => {
    const h = harness()
    h.inIndex(cardRaw('$c'))
    const release = held(h, 'answers')
    h.gateway.watchAwaitingApprovals()
    await flush()
    h.live(answerRaw('$r', '$c', BOB))
    h.server.answers.set('$c', []) // the page predates it
    release()
    await flush()
    expect(h.listed()).toEqual([])
  })

  it('an answer deleted during the read does not come back with its page', async () => {
    const h = harness()
    h.inIndex(cardRaw('$c'))
    await watched(h)
    h.live(answerRaw('$r', '$c', BOB))
    const release = held(h, 'answers')
    h.reconnect()
    await flush()
    h.redact('$r')
    h.server.answers.set('$c', [answerRaw('$r', '$c', BOB)]) // the page predates the deletion
    release()
    await flush()
    expect(h.listed()).toEqual(['$c'])
  })

  it('a close that arrives during the read of the event is not lost', async () => {
    const h = harness()
    h.inIndex(cardRaw('$c'))
    const release = held(h, 'event')
    h.gateway.watchAwaitingApprovals()
    await flush()
    const close = editRaw('$close', '$c')
    h.live(close)
    // The event's answer predates the close; the relations read after it do not.
    h.server.edits.set('$c', [])
    release()
    h.hook.before = (read) => {
      if (read.kind !== 'event') h.server.edits.set('$c', [close])
    }
    await flush()
    expect(h.listed()).toEqual([])
  })

  it('one’s own answer accepted during the read stays counted', async () => {
    const h = harness()
    h.inIndex(cardRaw('$c'))
    await watched(h)
    const release = held(h, 'answers')
    h.reconnect()
    await flush()
    const done = answer(h, '$c')
    h.sends[0]!.resolve({ event_id: '$mine' })
    await done
    release()
    await flush()
    expect(h.listed()).toEqual([])
  })

  it('a connection that returns during a pass replaces it, and the first list waits for the new one', async () => {
    const h = harness()
    h.inIndex(cardRaw('$c'))
    let first = true
    h.hook.before = () => {
      if (!first) return
      first = false
      return new Promise<void>(() => {})
    }
    h.gateway.watchAwaitingApprovals()
    await flush()
    h.reconnect()
    await flush()
    expect(h.reads[0]!.signal.aborted).toBe(true)
    expect(h.lists().map((l) => l.length)).toEqual([1])
  })
})

describe('the connection returns: the relations are read again', () => {
  it('an answer the sync skipped takes the card out', async () => {
    const h = harness()
    h.inWindow(cardRaw('$c'))
    await watched(h)
    h.server.answers.set('$c', [answerRaw('$r', '$c', CAROL)])
    h.reconnect()
    await flush()
    expect(h.listed()).toEqual([])
  })

  it('a close the sync skipped takes it out, and a later translation of the stale event does not reopen it', async () => {
    const h = harness()
    h.inWindow(cardRaw('$c'))
    await watched(h)
    h.server.edits.set('$c', [editRaw('$close', '$c')])
    h.reconnect()
    await flush()
    expect(h.listed()).toEqual([])
    h.g.translateAll([h.roomEvent('$c')], h.g.ctx(h.room))
    await expect(answer(h, '$c')).rejects.toThrow('approval card not open')
  })

  it('an answer the sync skipped the deletion of brings it back', async () => {
    const h = harness()
    h.inIndex(cardRaw('$c'))
    await watched(h)
    h.live(answerRaw('$r', '$c', BOB))
    expect(h.listed()).toEqual([])
    h.server.answers.set('$c', [])
    h.reconnect()
    await flush()
    expect(h.listed()).toEqual(['$c'])
  })
})

describe('an observed card is not evicted', () => {
  const flood = async (h: Harness): Promise<void> => {
    const cards = Array.from({ length: APPROVAL_CACHE_CAP + 50 }, (_, i) => new MatrixEvent(cardRaw(`$other${i}`)))
    h.g.translateAll(cards, h.g.ctx(h.room))
    await flush()
  }

  it('past 500 cards translated elsewhere, a live answer still takes it out', async () => {
    const h = harness()
    h.inIndex(cardRaw('$c'))
    await watched(h)
    await flood(h)
    expect(h.g.approvalCards.has('$c')).toBe(true)
    expect(h.g.approvalCards.size).toBe(APPROVAL_CACHE_CAP)
    h.live(answerRaw('$r', '$c', BOB))
    expect(h.listed()).toEqual([])
  })

  it('past 500, a live close still takes it out', async () => {
    const h = harness()
    h.inIndex(cardRaw('$c'))
    await watched(h)
    await flood(h)
    h.live(editRaw('$close', '$c'))
    expect(h.listed()).toEqual([])
  })

  it('past 500, answering still works', async () => {
    const h = harness()
    h.inIndex(cardRaw('$c'))
    await watched(h)
    await flood(h)
    const done = answer(h, '$c')
    h.sends[0]!.resolve({ event_id: '$mine' })
    await done
    expect(h.listed()).toEqual([])
  })

  it('released by the last observer, it is evicted like any other', async () => {
    const h = harness()
    h.inIndex(cardRaw('$c'))
    ;(await watched(h))()
    await flood(h)
    expect(h.g.approvalCards.has('$c')).toBe(false)
  })
})

describe('answering from the list', () => {
  it('an item from the index answers with the conversation never opened', async () => {
    const h = harness()
    h.inIndex(cardRaw('$old'))
    await watched(h)
    const { id } = h.lists().at(-1)![0]!.message
    const done = h.gateway.answerApproval(id, 'approve')
    h.sends[0]!.resolve({ event_id: '$mine' })
    await done
    expect(h.listed()).toEqual([])
  })
})

describe('SearchIndex.approvals', () => {
  it('only the approval entries', () => {
    const h = harness()
    const text = { ...entryOf(cardRaw('$t')), snapshot: { body: { kind: 'text', text: 'oi' } } } as unknown as SearchEntry
    h.index.upsert([entryOf(cardRaw('$c')), text])
    expect(h.index.approvals().map((e) => e.eventId)).toEqual(['$c'])
  })
})
