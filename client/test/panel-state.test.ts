import { describe, it, expect, vi } from 'vitest'
import { Direction, EventType, MatrixEvent, MatrixEventEvent, RoomEvent, RoomStateEvent, type IEvent } from 'matrix-js-sdk'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import { PanelAggregator, fetchPanelPage, type PanelFact, type PanelPage } from '../src/acl/internal/panel-state'
import { PANEL_BLOCK, PANEL_MSGTYPE, PANEL_REL_TYPE } from '@tayet/shared/internal'
import type { AclTelemetry, AgentPanel, ChannelId, DomainEvent } from '../src/acl'

// ADR-091 (Proposto) dec. 12, A3-5 — the client's reader of the pinned panels (PLANO-AGENTES §0.3.18
// items 1–4): grouping by agent, only the author's edit, the original that does not decrypt, the clear,
// the removal, the latest write per agent, members only, the order; panels.changed once per change; the
// late decrypt; disconnect. No stack: fake ports, then a fake client over real SDK events.

const ME = '@me:tayet.local'
const MINE = '@a-mmmmmmmmmmmm:tayet.local'
const AG_B = '@a-bbbbbbbbbbbb:tayet.local'
const AG_C = '@a-cccccccccccc:tayet.local'
const BOB = '@bob:tayet.local'
const ROOM_ID = '!room:tayet.local'
const CREATE_ID = '$create:tayet.local'

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0))
}

const content = (body: string, block: Record<string, unknown> = {}): Record<string, unknown> => ({ msgtype: PANEL_MSGTYPE, body, [PANEL_BLOCK]: block })
const fact = (eventId: string, sender: string, at: number | undefined, body = 'corpo', block: Record<string, unknown> = {}): PanelFact => ({
  eventId,
  sender,
  ...(at !== undefined && { shown: { content: content(body, block), at } }),
  watch: [eventId],
  ...(at !== undefined && { writtenAt: at }),
})

const NAMES: Record<string, string> = { [MINE]: 'Zeca', [AG_B]: 'Ágata', [AG_C]: 'Bruno' }

function aggregator(initial: Record<string, PanelPage>) {
  let pages = initial
  const members = new Set([MINE, AG_B, AG_C, BOB])
  const fetchPage = vi.fn(async (_room: string, _anchor: string, from: string | undefined) => {
    const page = pages[from ?? 'start']
    if (!page) throw new Error('no page')
    return page
  })
  const changed = vi.fn<(roomId: string, panels: AgentPanel[]) => void>()
  let anchor: string | undefined = CREATE_ID
  const agg = new PanelAggregator({
    anchorOf: () => anchor,
    fetchPage,
    isMember: (_room, sender) => members.has(sender),
    isOwn: (sender) => sender === MINE,
    nameOf: (_room, sender) => NAMES[sender] ?? sender,
    changed,
    detach: (work) => void work,
  })
  return {
    agg,
    fetchPage,
    changed,
    members,
    setPages: (p: Record<string, PanelPage>) => (pages = p),
    setAnchor: (a: string | undefined) => (anchor = a),
  }
}

const agents = (panels: AgentPanel[]): string[] => panels.map((p) => p.agent as unknown as string)

describe('PanelAggregator', () => {
  it('one panel per agent; the person’s agents first, then by name (pt-BR)', async () => {
    const { agg } = aggregator({ start: { panels: [fact('$b', AG_B, 10), fact('$m', MINE, 20, 'meu', { title: 'Produção' }), fact('$c', AG_C, 30)] } })
    const panels = await agg.list(ROOM_ID)
    expect(agents(panels)).toEqual([MINE, AG_B, AG_C])
    expect(panels[0]).toEqual({ agent: MINE, title: 'Produção', text: 'meu', updatedAt: 20 })
    expect(panels[1]).toEqual({ agent: AG_B, text: 'corpo', updatedAt: 10 })
  })

  it('pages the anchor’s relations to the end', async () => {
    const { agg, fetchPage } = aggregator({ start: { panels: [fact('$b', AG_B, 10)], next: 'p2' }, p2: { panels: [fact('$c', AG_C, 20)] } })
    expect(agents(await agg.list(ROOM_ID))).toEqual([AG_B, AG_C])
    expect(fetchPage).toHaveBeenCalledTimes(2)
    // Cache: a second call reads nothing.
    await agg.list(ROOM_ID)
    expect(fetchPage).toHaveBeenCalledTimes(2)
  })

  it('two panel messages from the same agent: the latest write wins', async () => {
    const { agg } = aggregator({ start: { panels: [fact('$new', AG_B, 50, 'novo'), fact('$old', AG_B, 10, 'velho')] } })
    expect((await agg.list(ROOM_ID)).map((p) => p.text)).toEqual(['novo'])
  })

  it('the latest write being a clear hides the agent’s older panel too', async () => {
    const { agg } = aggregator({ start: { panels: [fact('$a', AG_B, 10, 'antigo'), fact('$b', AG_B, 40, '', { cleared: true })] } })
    expect(await agg.list(ROOM_ID)).toEqual([])
  })

  it('a cleared panel, a malformed block, nothing that decrypts and an author that is no agent are out', async () => {
    const malformed: PanelFact = { eventId: '$x', sender: AG_C, shown: { content: { msgtype: PANEL_MSGTYPE, body: 'x', [PANEL_BLOCK]: 'oops' }, at: 5 }, watch: ['$x'] }
    const { agg } = aggregator({
      start: { panels: [fact('$b', AG_B, 10, '', { cleared: true }), malformed, fact('$m', MINE, undefined), fact('$bob', BOB, 30)] },
    })
    expect(await agg.list(ROOM_ID)).toEqual([])
  })

  it('an agent that left: out; leaving is recomputed from the cache and emitted once', async () => {
    const { agg, members, changed, fetchPage } = aggregator({ start: { panels: [fact('$b', AG_B, 10), fact('$c', AG_C, 20)] } })
    expect(agents(await agg.list(ROOM_ID))).toEqual([AG_B, AG_C])
    members.delete(AG_C)
    agg.recompute(ROOM_ID)
    agg.recompute(ROOM_ID)
    expect(changed).toHaveBeenCalledTimes(1)
    expect(agents(changed.mock.calls[0]![1])).toEqual([AG_B])
    expect(fetchPage).toHaveBeenCalledTimes(1)
  })

  it('panels.changed once per change and never without one', async () => {
    const h = aggregator({ start: { panels: [fact('$b', AG_B, 10, 'v1')] } })
    await h.agg.list(ROOM_ID)
    expect(h.changed).not.toHaveBeenCalled()
    // A reload that brings the same list emits nothing.
    h.agg.invalidate(ROOM_ID)
    await flush()
    expect(h.changed).not.toHaveBeenCalled()
    h.setPages({ start: { panels: [fact('$b', AG_B, 20, 'v2')] } })
    h.agg.invalidate(ROOM_ID)
    await flush()
    expect(h.changed).toHaveBeenCalledTimes(1)
    expect(h.changed.mock.calls[0]![1].map((p) => p.text)).toEqual(['v2'])
    expect(await h.agg.list(ROOM_ID)).toEqual(h.changed.mock.calls[0]![1])
  })

  it('an invalidation during a read reads again; the list waits for the latest', async () => {
    const h = aggregator({ start: { panels: [fact('$b', AG_B, 10, 'v1')] } })
    const pending = h.agg.list(ROOM_ID)
    h.setPages({ start: { panels: [fact('$b', AG_B, 20, 'v2')] } })
    h.agg.invalidate(ROOM_ID)
    expect((await pending).map((p) => p.text)).toEqual(['v2'])
    expect(h.fetchPage).toHaveBeenCalledTimes(2)
  })

  it('a first read that fails rejects; the next call reads again', async () => {
    const h = aggregator({})
    await expect(h.agg.list(ROOM_ID)).rejects.toThrow()
    h.setPages({ start: { panels: [fact('$b', AG_B, 10)] } })
    expect(agents(await h.agg.list(ROOM_ID))).toEqual([AG_B])
  })

  it('a later read that fails keeps what the conversation showed and emits nothing', async () => {
    const h = aggregator({ start: { panels: [fact('$b', AG_B, 10)] } })
    await h.agg.list(ROOM_ID)
    h.setPages({})
    h.agg.invalidate(ROOM_ID)
    await flush()
    expect(h.changed).not.toHaveBeenCalled()
    expect(agents(await h.agg.list(ROOM_ID))).toEqual([AG_B])
  })

  it('no anchor in the room → no panels; nobody asked → an invalidation reads nothing', async () => {
    const h = aggregator({ start: { panels: [fact('$b', AG_B, 10)] } })
    h.agg.invalidate(ROOM_ID)
    await flush()
    expect(h.fetchPage).not.toHaveBeenCalled()
    h.setAnchor(undefined)
    expect(await h.agg.list(ROOM_ID)).toEqual([])
  })

  it('watched events name their conversation; clear (disconnect) forgets everything', async () => {
    const h = aggregator({ start: { panels: [{ ...fact('$b', AG_B, 10), watch: ['$b', '$b-edit'] }] } })
    await h.agg.list(ROOM_ID)
    expect(h.agg.watches('$b-edit')).toBe(ROOM_ID)
    h.agg.clear()
    expect(h.agg.watches('$b-edit')).toBeUndefined()
    h.agg.invalidate(ROOM_ID)
    await flush()
    expect(h.fetchPage).toHaveBeenCalledTimes(1)
  })
})

// ── fetchPanelPage: what a panel shows ──────────────────────────────────────────────────────────
const panelRaw = (id: string, sender: string, ts: number, body: string, extra: Partial<IEvent> = {}): Partial<IEvent> => ({
  event_id: id,
  room_id: ROOM_ID,
  sender,
  type: 'm.room.message',
  origin_server_ts: ts,
  content: { ...content(body, { title: 'T' }), 'm.relates_to': { rel_type: PANEL_REL_TYPE, event_id: CREATE_ID } },
  ...extra,
})
const editRaw = (id: string, sender: string, ts: number, target: string, body: string, block: Record<string, unknown> = {}): Partial<IEvent> => ({
  event_id: id,
  room_id: ROOM_ID,
  sender,
  type: 'm.room.message',
  origin_server_ts: ts,
  content: { msgtype: PANEL_MSGTYPE, body: `* ${body}`, 'm.new_content': content(body, block), 'm.relates_to': { rel_type: 'm.replace', event_id: target } },
})
const bundle = (edit: Partial<IEvent>): Partial<IEvent> => ({ unsigned: { 'm.relations': { 'm.replace': edit } } as never })

// A fake client: relations by (event id, relation type); events in `failing` do not decrypt.
function relationsClient(byKey: Record<string, Partial<IEvent>[]>, failing: Set<string> = new Set()) {
  const fetchRelations = vi.fn(async (_room: string, eventId: string, relType: string) => ({ chunk: byKey[`${eventId} ${relType}`] ?? [] }))
  const mapper = (raw: Partial<IEvent>): MatrixEvent => {
    const ev = new MatrixEvent(raw)
    if (failing.has(raw.event_id ?? '')) {
      ev.isDecryptionFailure = () => true
      ev.isEncrypted = () => true
      ev.getClearContent = () => null
    }
    return ev
  }
  return { fetchRelations, getEventMapper: () => mapper, decryptEventIfNeeded: vi.fn(async () => {}) }
}

describe('fetchPanelPage — the content a panel shows', () => {
  it('asks the anchor’s relations of the panel’s type, explicitly FORWARD; no edit → the original', async () => {
    const client = relationsClient({ [`${CREATE_ID} ${PANEL_REL_TYPE}`]: [panelRaw('$p', AG_B, 1000, 'quadro')] })
    const page = await fetchPanelPage(client as never, ROOM_ID, CREATE_ID, undefined)
    expect(client.fetchRelations).toHaveBeenCalledWith(ROOM_ID, CREATE_ID, PANEL_REL_TYPE, null, { dir: Direction.Forward })
    expect(page.panels).toEqual([{ eventId: '$p', sender: AG_B, shown: { content: expect.objectContaining({ body: 'quadro' }), at: 1000 }, watch: ['$p'], writtenAt: 1000 }])
  })

  it('the server’s aggregated edit of the author: its new content and its instant', async () => {
    const client = relationsClient({
      [`${CREATE_ID} ${PANEL_REL_TYPE}`]: [panelRaw('$p', AG_B, 1000, 'v1', bundle(editRaw('$e', AG_B, 2000, '$p', 'v2', { title: 'Novo' })))],
    })
    const [p] = (await fetchPanelPage(client as never, ROOM_ID, CREATE_ID, undefined)).panels
    expect(p?.shown).toEqual({ content: content('v2', { title: 'Novo' }), at: 2000 })
    expect(p?.watch).toEqual(['$p', '$e'])
  })

  it('the original does not decrypt, the author’s edit does → the edit', async () => {
    const client = relationsClient(
      { [`${CREATE_ID} ${PANEL_REL_TYPE}`]: [panelRaw('$p', AG_B, 1000, 'v1', bundle(editRaw('$e', AG_B, 2000, '$p', 'v2')))] },
      new Set(['$p']),
    )
    const [p] = (await fetchPanelPage(client as never, ROOM_ID, CREATE_ID, undefined)).panels
    expect(p?.shown?.content.body).toBe('v2')
  })

  it('nothing decrypts → nothing shown (the panel does not appear)', async () => {
    const client = relationsClient(
      { [`${CREATE_ID} ${PANEL_REL_TYPE}`]: [panelRaw('$p', AG_B, 1000, 'v1', bundle(editRaw('$e', AG_B, 2000, '$p', 'v2')))] },
      new Set(['$p', '$e']),
    )
    const [p] = (await fetchPanelPage(client as never, ROOM_ID, CREATE_ID, undefined)).panels
    expect(p?.shown).toBeUndefined()
    expect(p?.watch).toEqual(['$p', '$e'])
    // The panel stands on the author's edit, which must decrypt: its late decrypt is what moves the panel.
    expect(p).toMatchObject({ editId: '$e', writtenAt: 2000 })
  })

  it('an author’s edit that does not decrypt never falls back to the stale original', async () => {
    const client = relationsClient(
      { [`${CREATE_ID} ${PANEL_REL_TYPE}`]: [panelRaw('$p', AG_B, 1000, 'v1', bundle(editRaw('$e', AG_B, 2000, '$p', 'v2')))] },
      new Set(['$e']),
    )
    const [p] = (await fetchPanelPage(client as never, ROOM_ID, CREATE_ID, undefined)).panels
    expect(p?.shown).toBeUndefined()
  })

  it('an aggregated edit forged by another member never counts: the author’s latest edit is read', async () => {
    const forged = editRaw('$forged', BOB, 3000, '$p', 'forjado')
    const client = relationsClient({
      [`${CREATE_ID} ${PANEL_REL_TYPE}`]: [panelRaw('$p', AG_B, 1000, 'v1', bundle(forged))],
      [`$p m.replace`]: [editRaw('$e1', AG_B, 1500, '$p', 'v2'), forged, editRaw('$e2', AG_B, 2500, '$p', 'v3')],
    })
    const [p] = (await fetchPanelPage(client as never, ROOM_ID, CREATE_ID, undefined)).panels
    expect(client.fetchRelations).toHaveBeenCalledWith(ROOM_ID, '$p', 'm.replace', null, { dir: Direction.Forward })
    expect(p?.shown).toEqual({ content: content('v3'), at: 2500 })
  })

  it('a forged aggregate and no author edit → the original', async () => {
    const forged = editRaw('$forged', BOB, 3000, '$p', 'forjado')
    const client = relationsClient({ [`${CREATE_ID} ${PANEL_REL_TYPE}`]: [panelRaw('$p', AG_B, 1000, 'v1', bundle(forged))], [`$p m.replace`]: [forged] })
    const [p] = (await fetchPanelPage(client as never, ROOM_ID, CREATE_ID, undefined)).panels
    expect(p?.shown?.content.body).toBe('v1')
  })

  it('a panel of an account that is no agent, and a removed panel, are skipped', async () => {
    const client = relationsClient({
      [`${CREATE_ID} ${PANEL_REL_TYPE}`]: [panelRaw('$bob', BOB, 1000, 'pessoa'), panelRaw('$gone', AG_B, 1000, 'x', { unsigned: { redacted_because: {} } as never })],
    })
    const page = await fetchPanelPage(client as never, ROOM_ID, CREATE_ID, undefined)
    expect(page.panels).toEqual([])
  })
})

// ── The gateway ──────────────────────────────────────────────────────────────────────────────
type Handler = (...args: never[]) => void
const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const CHANNEL = ROOM_ID as unknown as ChannelId

function harness() {
  const members = new Map<string, { membership: string; rawDisplayName: string }>([
    [ME, { membership: 'join', rawDisplayName: 'Eu' }],
    [AG_B, { membership: 'join', rawDisplayName: 'Ágata' }],
    [AG_C, { membership: 'join', rawDisplayName: 'Bruno' }],
    [MINE, { membership: 'join', rawDisplayName: 'Zeca' }],
    [BOB, { membership: 'join', rawDisplayName: 'Bob' }],
  ])
  const room = {
    roomId: ROOM_ID,
    getCanonicalAlias: () => null,
    getMyMembership: () => 'join',
    findEventById: () => undefined,
    getThread: () => undefined,
    getLiveTimeline: () => ({ getEvents: () => [], getPaginationToken: () => null }),
    relations: { getChildEventsForEvent: () => undefined },
    hasEncryptionStateEvent: () => false,
    currentState: { getStateEvents: (type: string, key: string) => (type === EventType.RoomCreate && key === '' ? { getId: () => CREATE_ID } : undefined) },
    getMember: (id: string) => members.get(id) ?? null,
  }
  const handlers = new Map<string, Handler[]>()
  let anchorChunk: Partial<IEvent>[] = []
  const failing = new Set<string>()
  let readHook: (() => void) | undefined
  const fetchRelations = vi.fn(async (_room: string, eventId: string, relType: string) => {
    readHook?.()
    return { chunk: eventId === CREATE_ID && relType === PANEL_REL_TYPE ? anchorChunk : [] }
  })
  const mapper = (raw: Partial<IEvent>): MatrixEvent => {
    const ev = new MatrixEvent(raw)
    if (failing.has(raw.event_id ?? '')) {
      ev.isDecryptionFailure = () => true
      ev.isEncrypted = () => true
      ev.getClearContent = () => null
    }
    return ev
  }
  const client = {
    getRooms: () => [room],
    getRoom: (id: string) => (id === ROOM_ID ? room : null),
    getCrypto: () => ({}),
    getUserId: () => ME,
    getAccountData: () => undefined,
    fetchRelations,
    getEventMapper: () => mapper,
    // Like the SDK: every decrypt attempt of a mapped event is reported on the client (success or not).
    decryptEventIfNeeded: vi.fn(async (ev: MatrixEvent) => fire(MatrixEventEvent.Decrypted as string, ev)),
    on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
    off: () => {},
  }
  const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
  const g = gateway as unknown as { client: unknown; live: boolean; wireEvents(c: unknown): void; isOwnAgent(m: string): boolean }
  g.client = client
  g.wireEvents(client)
  g.live = true
  g.isOwnAgent = (m: string) => m === MINE
  const events: DomainEvent[] = []
  gateway.subscribe((e) => events.push(e))
  const fire = (name: string, ...args: unknown[]): void => {
    for (const h of handlers.get(name) ?? []) (h as (...a: unknown[]) => void)(...args)
  }
  const timeline = (ev: unknown): void => fire(RoomEvent.Timeline as string, ev, room, false, false, { liveEvent: true })
  const decrypted = (ev: unknown): void => fire(MatrixEventEvent.Decrypted as string, ev)
  const redaction = (target: string): void =>
    fire(RoomEvent.Redaction as string, new MatrixEvent({ type: 'm.room.redaction', redacts: target, room_id: ROOM_ID, sender: AG_B, event_id: `$red-${target}` }), room)
  const memberEvent = (userId: string, membership: string): void => {
    members.set(userId, { membership, rawDisplayName: members.get(userId)?.rawDisplayName ?? '' })
    fire(RoomStateEvent.Members as string, new MatrixEvent({ type: 'm.room.member' }), {}, { userId, roomId: ROOM_ID, membership, powerLevel: 0 })
  }
  return {
    gateway,
    events,
    timeline,
    decrypted,
    redaction,
    memberEvent,
    failing,
    fetchRelations,
    setAnchorChunk: (c: Partial<IEvent>[]) => (anchorChunk = c),
    onRead: (f: () => void) => (readHook = f),
  }
}

const panelEvents = (events: DomainEvent[]) => events.flatMap((e) => (e.t === 'panels.changed' ? [e] : []))
const liveEdit = (id: string, sender: string, ts: number, target: string, body: string): MatrixEvent => new MatrixEvent(editRaw(id, sender, ts, target, body))

describe('gateway — listPanels and panels.changed', () => {
  it('lists the panels in order; a live edit of the author is applied in place and emitted once — no read', async () => {
    const h = harness()
    h.setAnchorChunk([panelRaw('$b', AG_B, 1000, 'b1'), panelRaw('$m', MINE, 1100, 'm1')])
    const onChannel: DomainEvent[] = []
    h.gateway.subscribeChannel(CHANNEL, (e) => onChannel.push(e))
    expect(agents(await h.gateway.listPanels(CHANNEL))).toEqual([MINE, AG_B])
    h.timeline(liveEdit('$e', AG_B, 2000, '$b', 'b2'))
    await flush()
    const changed = panelEvents(onChannel)
    expect(changed).toHaveLength(1)
    expect(changed[0]!.panels.map((p) => [p.text, p.updatedAt])).toEqual([['m1', 1100], ['b2', 2000]])
    expect(h.fetchRelations).toHaveBeenCalledTimes(1)
    // Never a line.
    expect(h.events.filter((e) => e.t === 'message.received' || e.t === 'message.edited')).toEqual([])
  })

  it('an agent leaving drops its panel; joining again brings it back — each one change', async () => {
    const h = harness()
    h.setAnchorChunk([panelRaw('$b', AG_B, 1000, 'b1'), panelRaw('$c', AG_C, 1000, 'c1')])
    await h.gateway.listPanels(CHANNEL)
    h.memberEvent(AG_C, 'leave')
    h.memberEvent(AG_C, 'join')
    const changed = panelEvents(h.events)
    expect(changed.map((e) => agents(e.panels))).toEqual([[AG_B], [AG_B, AG_C]])
  })

  it('a removed panel: one read, no message.removed, the list loses it', async () => {
    const h = harness()
    h.setAnchorChunk([panelRaw('$b', AG_B, 1000, 'b1')])
    await h.gateway.listPanels(CHANNEL)
    h.setAnchorChunk([])
    h.redaction('$b')
    await flush()
    expect(panelEvents(h.events).map((e) => e.panels)).toEqual([[]])
    expect(h.events.filter((e) => e.t === 'message.removed')).toEqual([])
    expect(h.fetchRelations).toHaveBeenCalledTimes(2)
  })

  it('late decrypt of an original the cache has without content: one read, the panel appears', async () => {
    const h = harness()
    h.setAnchorChunk([panelRaw('$b', AG_B, 1000, 'b1')])
    h.failing.add('$b')
    expect(await h.gateway.listPanels(CHANNEL)).toEqual([])
    h.failing.delete('$b')
    h.decrypted(new MatrixEvent(panelRaw('$b', AG_B, 1000, 'b1')))
    await flush()
    expect(panelEvents(h.events).map((e) => agents(e.panels))).toEqual([[AG_B]])
    expect(h.fetchRelations).toHaveBeenCalledTimes(2)
  })

  it('a new panel (here reported only as decrypted): one read', async () => {
    const h = harness()
    expect(await h.gateway.listPanels(CHANNEL)).toEqual([])
    h.setAnchorChunk([panelRaw('$n', AG_C, 4000, 'novo')])
    h.decrypted(new MatrixEvent(panelRaw('$n', AG_C, 4000, 'novo')))
    await flush()
    expect(panelEvents(h.events).map((e) => agents(e.panels))).toEqual([[AG_C]])
    expect(h.fetchRelations).toHaveBeenCalledTimes(2)
  })

  it('N author edits in a row: no read after the first, panels.changed once per change', async () => {
    const h = harness()
    h.setAnchorChunk([panelRaw('$b', AG_B, 1000, 'b1')])
    await h.gateway.listPanels(CHANNEL)
    for (const [id, ts, body] of [['$e1', 2000, 'b2'], ['$e2', 3000, 'b3'], ['$e3', 4000, 'b4']] as const) h.timeline(liveEdit(id, AG_B, ts, '$b', body))
    // The same edit again changes nothing.
    h.timeline(liveEdit('$e3', AG_B, 4000, '$b', 'b4'))
    await flush()
    expect(panelEvents(h.events).map((e) => e.panels.map((p) => p.text))).toEqual([['b2'], ['b3'], ['b4']])
    expect(h.fetchRelations).toHaveBeenCalledTimes(1)
  })

  it('an older edit arriving after a newer one changes nothing', async () => {
    const h = harness()
    h.setAnchorChunk([panelRaw('$b', AG_B, 1000, 'b1')])
    await h.gateway.listPanels(CHANNEL)
    h.timeline(liveEdit('$new', AG_B, 3000, '$b', 'novo'))
    h.timeline(liveEdit('$old', AG_B, 2000, '$b', 'velho'))
    await flush()
    expect(panelEvents(h.events).map((e) => e.panels.map((p) => p.text))).toEqual([['novo']])
    expect(h.fetchRelations).toHaveBeenCalledTimes(1)
  })

  it('an edit forged by another member: no read, no change, no event', async () => {
    const h = harness()
    h.setAnchorChunk([panelRaw('$b', AG_B, 1000, 'b1')])
    await h.gateway.listPanels(CHANNEL)
    h.timeline(liveEdit('$forged', BOB, 3000, '$b', 'forjado'))
    await flush()
    expect(panelEvents(h.events)).toEqual([])
    expect(h.fetchRelations).toHaveBeenCalledTimes(1)
    expect((await h.gateway.listPanels(CHANNEL)).map((p) => p.text)).toEqual(['b1'])
  })

  it('an edit that arrives already failed: off the list without a read; its late decrypt brings it back without a read', async () => {
    const h = harness()
    h.setAnchorChunk([panelRaw('$b', AG_B, 1000, 'b1')])
    await h.gateway.listPanels(CHANNEL)
    // The edit, unreadable on arrival: its relation in clear on the envelope, a settled failure (not
    // decrypting any more — it never enters the decrypt deferral).
    let clear = false
    const relates = { rel_type: 'm.replace', event_id: '$b' }
    const wire = { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'x', session_id: 's', 'm.relates_to': relates }
    const clearContent = { msgtype: PANEL_MSGTYPE, body: '* b2', 'm.new_content': content('b2'), 'm.relates_to': relates }
    const failed = { msgtype: 'm.bad.encrypted', body: '**' }
    const ev = {
      isEncrypted: () => true,
      isBeingDecrypted: () => false,
      shouldAttemptDecryption: () => false,
      isDecryptionFailure: () => !clear,
      decryptionFailureReason: null,
      getWireContent: () => wire,
      getClearContent: () => (clear ? clearContent : null),
      getType: () => 'm.room.message',
      getContent: () => (clear ? clearContent : failed),
      getOriginalContent: () => (clear ? clearContent : failed),
      isRedacted: () => false,
      getId: () => '$late',
      getTxnId: () => undefined,
      getSender: () => AG_B,
      getRoomId: () => ROOM_ID,
      getTs: () => 2000,
      getRelation: () => null,
      status: null,
    }
    h.timeline(ev)
    await flush()
    // Never the stale original: the panel leaves the list while its latest write cannot be read.
    expect(panelEvents(h.events).map((e) => e.panels)).toEqual([[]])
    clear = true
    h.decrypted(ev)
    await flush()
    expect(panelEvents(h.events).map((e) => e.panels.map((p) => p.text))).toEqual([[], ['b2']])
    expect(h.fetchRelations).toHaveBeenCalledTimes(1)
    expect(h.events.filter((e) => e.t === 'message.received' || e.t === 'message.edited')).toEqual([])
  })

  it('an edit the SDK reports only as decrypted (its target is not loaded): applied without a read', async () => {
    const h = harness()
    h.setAnchorChunk([panelRaw('$b', AG_B, 1000, 'b1')])
    h.failing.add('$b')
    // A person who joined after the panel: nothing decrypts, nothing shown.
    expect(await h.gateway.listPanels(CHANNEL)).toEqual([])
    // Only Decrypted fires for the agent's next edit — no Timeline.
    h.decrypted(liveEdit('$e2', AG_B, 3000, '$b', 'b3'))
    await flush()
    expect(panelEvents(h.events).map((e) => e.panels.map((p) => p.text))).toEqual([['b3']])
    expect(h.fetchRelations).toHaveBeenCalledTimes(1)
  })

  it('the reader’s own decrypts (and failures) never start another read', async () => {
    const h = harness()
    h.setAnchorChunk([panelRaw('$b', AG_B, 1000, 'b1', bundle(editRaw('$e', AG_B, 2000, '$b', 'b2'))), panelRaw('$c', AG_C, 1000, 'c1')])
    h.failing.add('$c')
    expect(agents(await h.gateway.listPanels(CHANNEL))).toEqual([AG_B])
    await flush()
    // One read: the anchor's page (the bundle needs no read of its own).
    expect(h.fetchRelations).toHaveBeenCalledTimes(1)
    expect(panelEvents(h.events)).toEqual([])
  })

  it('the SDK reporting the same live decrypt again and again: applied once, no read', async () => {
    const h = harness()
    h.setAnchorChunk([panelRaw('$b', AG_B, 1000, 'b1')])
    h.failing.add('$b')
    expect(await h.gateway.listPanels(CHANNEL)).toEqual([])
    const live = liveEdit('$e9', AG_B, 3000, '$b', 'b9')
    for (let i = 0; i < 5; i++) h.decrypted(live)
    await flush()
    expect(panelEvents(h.events).map((e) => e.panels.map((p) => p.text))).toEqual([['b9']])
    expect(h.fetchRelations).toHaveBeenCalledTimes(1)
  })

  it('rejects an unknown conversation like the other read verbs', async () => {
    const h = harness()
    await expect(h.gateway.listPanels('!other:tayet.local' as unknown as ChannelId)).rejects.toThrow('channel not found')
  })

  it('disconnect clears the cache: a later event reads nothing', async () => {
    const h = harness()
    h.setAnchorChunk([panelRaw('$b', AG_B, 1000, 'b1')])
    await h.gateway.listPanels(CHANNEL)
    const calls = h.fetchRelations.mock.calls.length
    await h.gateway.disconnect().catch(() => {})
    h.redaction('$b')
    await flush()
    expect(h.fetchRelations.mock.calls.length).toBe(calls)
  })
})
