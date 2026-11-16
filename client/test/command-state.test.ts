import { describe, it, expect, vi } from 'vitest'
import { EventType, MatrixEvent, MatrixEventEvent, RoomEvent, RoomStateEvent, type IEvent } from 'matrix-js-sdk'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import { CommandAggregator } from '../src/acl/internal/command-state'
import { PanelAggregator, type PanelPage } from '../src/acl/internal/panel-state'
import type { AnchoredFact, AnchoredPage } from '../src/acl/internal/anchored-state'
import { COMMANDS_BLOCK, COMMANDS_MSGTYPE, COMMANDS_REL_TYPE, PANEL_BLOCK, PANEL_MSGTYPE } from '@tayet/shared/internal'
import type { AclTelemetry, AgentCommand, AgentPanel, ChannelId, DomainEvent } from '../src/acl'

// ADR-093 (Proposto), A4-1 (PLANO-AGENTES §0.3.21 items 3–6, 9): the commands adapter of the anchored
// aggregator — the flat list, the order (command name, then agent name), members only, the clear, the
// latest write per agent, edits by the author only, the late decrypt; the gateway's listCommands and
// commands.changed; and the §0.3.19 item 6 follow-up (a live edit is kept only after its author is
// checked), on both adapters. No stack: fake ports, then a fake client over real SDK events.

const ME = '@me:tayet.local'
const AG_A = '@a-aaaaaaaaaaaa:tayet.local'
const AG_B = '@a-bbbbbbbbbbbb:tayet.local'
const AG_C = '@a-cccccccccccc:tayet.local'
const BOB = '@bob:tayet.local'
const ROOM_ID = '!room:tayet.local'
const CREATE_ID = '$create:tayet.local'

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0))
}

type Cmd = { name: string; description?: string; hint?: string }
const manifest = (cmds: Cmd[], extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  msgtype: COMMANDS_MSGTYPE,
  body: cmds.map((c) => `/${c.name}`).join('\n'),
  [COMMANDS_BLOCK]: { commands: cmds.map((c) => ({ description: 'Faz algo', ...c })), ...extra },
})
const fact = (eventId: string, sender: string, at: number | undefined, cmds: Cmd[] = [{ name: 'status' }], extra: Record<string, unknown> = {}): AnchoredFact => ({
  eventId,
  sender,
  ...(at !== undefined && { shown: { content: manifest(cmds, extra), at } }),
  watch: [eventId],
  ...(at !== undefined && { writtenAt: at }),
})

// Agent names: Ana (A), Beto (B) and — on purpose — a second "Ana" for C, to show the tie on the agent.
const NAMES: Record<string, string> = { [AG_A]: 'Zélia', [AG_B]: 'Ana', [AG_C]: 'Bruno' }

function aggregator(initial: Record<string, AnchoredPage>) {
  let pages = initial
  const members = new Set([AG_A, AG_B, AG_C, BOB])
  const fetchPage = vi.fn(async (_room: string, _anchor: string, from: string | undefined) => {
    const page = pages[from ?? 'start']
    if (!page) throw new Error('no page')
    return page
  })
  const changed = vi.fn<(roomId: string, commands: AgentCommand[]) => void>()
  const agg = new CommandAggregator({
    anchorOf: () => CREATE_ID,
    fetchPage,
    isMember: (_room, sender) => members.has(sender),
    nameOf: (_room, sender) => NAMES[sender] ?? sender,
    changed,
    detach: (work) => void work,
  })
  return { agg, fetchPage, changed, members, setPages: (p: Record<string, AnchoredPage>) => (pages = p) }
}

const pairs = (commands: AgentCommand[]): string[] => commands.map((c) => `${c.name}@${NAMES[c.agent as unknown as string]}`)

describe('CommandAggregator', () => {
  it('flat, ordered by the command’s name and then the agent’s name; the same name under two agents is two items', async () => {
    const { agg } = aggregator({
      start: {
        facts: [
          fact('$a', AG_A, 10, [{ name: 'deploy', hint: '<ambiente>' }, { name: 'status' }]),
          fact('$b', AG_B, 20, [{ name: 'status', description: 'Estado' }, { name: 'build' }]),
        ],
      },
    })
    const commands = await agg.list(ROOM_ID)
    expect(pairs(commands)).toEqual(['build@Ana', 'deploy@Zélia', 'status@Ana', 'status@Zélia'])
    expect(commands[1]).toEqual({ agent: AG_A, name: 'deploy', description: 'Faz algo', hint: '<ambiente>' })
    expect(commands[2]).toEqual({ agent: AG_B, name: 'status', description: 'Estado' })
  })

  it('only agents that are current members; leaving recomputes from the cache, once', async () => {
    const { agg, members, changed, fetchPage } = aggregator({ start: { facts: [fact('$a', AG_A, 10), fact('$b', AG_B, 20)] } })
    expect(await agg.list(ROOM_ID)).toHaveLength(2)
    members.delete(AG_A)
    agg.recompute(ROOM_ID)
    agg.recompute(ROOM_ID)
    expect(changed).toHaveBeenCalledTimes(1)
    expect(pairs(changed.mock.calls[0]![1])).toEqual(['status@Ana'])
    expect(fetchPage).toHaveBeenCalledTimes(1)
  })

  it('an author that is no agent is out', async () => {
    const { agg } = aggregator({ start: { facts: [fact('$bob', BOB, 10)] } })
    expect(await agg.list(ROOM_ID)).toEqual([])
  })

  it('a cleared manifest is out; the latest write being a clear hides the agent’s older manifest too', async () => {
    const { agg } = aggregator({ start: { facts: [fact('$old', AG_A, 10, [{ name: 'deploy' }]), fact('$clr', AG_A, 30, [], { cleared: true }), fact('$b', AG_B, 5)] } })
    expect(pairs(await agg.list(ROOM_ID))).toEqual(['status@Ana'])
  })

  it('two manifests from the same agent: the latest write wins', async () => {
    const { agg } = aggregator({ start: { facts: [fact('$new', AG_A, 50, [{ name: 'novo' }]), fact('$old', AG_A, 10, [{ name: 'velho' }])] } })
    expect((await agg.list(ROOM_ID)).map((c) => c.name)).toEqual(['novo'])
  })

  it('a block that is not an object leaves the agent without commands; nothing that decrypts too', async () => {
    const malformed: AnchoredFact = { eventId: '$x', sender: AG_A, shown: { content: { msgtype: COMMANDS_MSGTYPE, body: '', [COMMANDS_BLOCK]: 'oops' }, at: 5 }, watch: ['$x'] }
    const { agg } = aggregator({ start: { facts: [malformed, fact('$c', AG_C, undefined)] } })
    expect(await agg.list(ROOM_ID)).toEqual([])
  })

  it('a live edit of the author is applied in place (no read); one by another account changes nothing', async () => {
    const h = aggregator({ start: { facts: [fact('$a', AG_A, 10, [{ name: 'v1' }])] } })
    await h.agg.list(ROOM_ID)
    h.agg.applyEdit(ROOM_ID, '$a', { id: '$forged', sender: BOB, at: 30, content: manifest([{ name: 'forjado' }]) })
    expect(h.changed).not.toHaveBeenCalled()
    h.agg.applyEdit(ROOM_ID, '$a', { id: '$e', sender: AG_A, at: 20, content: manifest([{ name: 'v2' }]) })
    expect(h.changed).toHaveBeenCalledTimes(1)
    expect(h.changed.mock.calls[0]![1].map((c) => c.name)).toEqual(['v2'])
    expect(h.fetchPage).toHaveBeenCalledTimes(1)
  })

  it('an author’s edit that does not decrypt takes the commands off until it decrypts', async () => {
    const h = aggregator({ start: { facts: [fact('$a', AG_A, 10, [{ name: 'v1' }])] } })
    await h.agg.list(ROOM_ID)
    h.agg.applyEdit(ROOM_ID, '$a', { id: '$e', sender: AG_A, at: 20 })
    h.agg.applyEdit(ROOM_ID, '$a', { id: '$e', sender: AG_A, at: 20, content: manifest([{ name: 'v2' }]) })
    expect(h.changed.mock.calls.map((c) => c[1].map((x) => x.name))).toEqual([[], ['v2']])
  })

  it('a first read that fails rejects with its own message; the next call reads again', async () => {
    const h = aggregator({})
    await expect(h.agg.list(ROOM_ID)).rejects.toThrow('commands unavailable')
    h.setPages({ start: { facts: [fact('$a', AG_A, 10)] } })
    expect(await h.agg.list(ROOM_ID)).toHaveLength(1)
  })
})

// ── §0.3.19 item 6 (A4-1 item 9): a live edit is kept only after its author is checked ─────────────────
const deferred = <T,>() => {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}
const panelContent = (body: string): Record<string, unknown> => ({ msgtype: PANEL_MSGTYPE, body, [PANEL_BLOCK]: {} })
const panelFact = (eventId: string, sender: string, at: number, body: string): AnchoredFact => ({
  eventId,
  sender,
  shown: { content: panelContent(body), at },
  watch: [eventId],
  writtenAt: at,
})

describe('live edit kept only after the author is checked (§0.3.19 item 6)', () => {
  function panels() {
    let next: Promise<PanelPage> | undefined
    const fetchPage = vi.fn(async () => (next ? next : { panels: [panelFact('$b', AG_B, 1000, 'b1')] }))
    const changed = vi.fn<(roomId: string, panels: AgentPanel[]) => void>()
    const agg = new PanelAggregator({
      anchorOf: () => CREATE_ID,
      fetchPage,
      isMember: () => true,
      isOwn: () => false,
      nameOf: (_r, s) => s,
      changed,
      detach: (work) => void work,
    })
    return { agg, fetchPage, changed, hold: (p: Promise<PanelPage>) => (next = p) }
  }

  it('a forged edit during a re-read in flight does not displace the author’s edit', async () => {
    const h = panels()
    expect((await h.agg.list(ROOM_ID)).map((p) => p.text)).toEqual(['b1'])
    // A re-read starts and answers with what the server had before the edits below.
    const read = deferred<PanelPage>()
    h.hold(read.promise)
    h.agg.invalidate(ROOM_ID)
    h.agg.applyEdit(ROOM_ID, '$b', { id: '$e', sender: AG_B, at: 2000, content: panelContent('b2') })
    h.agg.applyEdit(ROOM_ID, '$b', { id: '$forged', sender: BOB, at: 3000, content: panelContent('forjado') })
    read.resolve({ panels: [panelFact('$b', AG_B, 1000, 'b1')] })
    await flush()
    expect((await h.agg.list(ROOM_ID)).map((p) => p.text)).toEqual(['b2'])
  })

  it('a first read in flight: the author’s edit survives a later forged one for the same message', async () => {
    const h = panels()
    const read = deferred<PanelPage>()
    h.hold(read.promise)
    const listing = h.agg.list(ROOM_ID)
    h.agg.applyEdit(ROOM_ID, '$b', { id: '$e', sender: AG_B, at: 2000, content: panelContent('b2') })
    h.agg.applyEdit(ROOM_ID, '$b', { id: '$forged', sender: BOB, at: 3000, content: panelContent('forjado') })
    read.resolve({ panels: [panelFact('$b', AG_B, 1000, 'b1')] })
    expect((await listing).map((p) => p.text)).toEqual(['b2'])
  })

  it('the same holds on the commands adapter', async () => {
    const held: { next?: Promise<AnchoredPage> } = {}
    const agg = new CommandAggregator({
      anchorOf: () => CREATE_ID,
      fetchPage: async () => (held.next ? held.next : { facts: [fact('$a', AG_A, 1000, [{ name: 'v1' }])] }),
      isMember: () => true,
      nameOf: (_r, s) => s,
      changed: () => {},
      detach: (work) => void work,
    })
    await agg.list(ROOM_ID)
    const read = deferred<AnchoredPage>()
    held.next = read.promise
    agg.invalidate(ROOM_ID)
    agg.applyEdit(ROOM_ID, '$a', { id: '$e', sender: AG_A, at: 2000, content: manifest([{ name: 'v2' }]) })
    agg.applyEdit(ROOM_ID, '$a', { id: '$forged', sender: BOB, at: 3000, content: manifest([{ name: 'forjado' }]) })
    read.resolve({ facts: [fact('$a', AG_A, 1000, [{ name: 'v1' }])] })
    await flush()
    expect((await agg.list(ROOM_ID)).map((c) => c.name)).toEqual(['v2'])
  })
})

// ── The gateway ──────────────────────────────────────────────────────────────────────────────
type Handler = (...args: never[]) => void
const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const CHANNEL = ROOM_ID as unknown as ChannelId

const manifestRaw = (id: string, sender: string, ts: number, cmds: Cmd[]): Partial<IEvent> => ({
  event_id: id,
  room_id: ROOM_ID,
  sender,
  type: 'm.room.message',
  origin_server_ts: ts,
  content: { ...manifest(cmds), 'm.relates_to': { rel_type: COMMANDS_REL_TYPE, event_id: CREATE_ID } },
})
const editRaw = (id: string, sender: string, ts: number, target: string, cmds: Cmd[], extra: Record<string, unknown> = {}): Partial<IEvent> => ({
  event_id: id,
  room_id: ROOM_ID,
  sender,
  type: 'm.room.message',
  origin_server_ts: ts,
  content: { msgtype: COMMANDS_MSGTYPE, body: '* x', 'm.new_content': manifest(cmds, extra), 'm.relates_to': { rel_type: 'm.replace', event_id: target } },
})

function harness() {
  const members = new Map<string, { membership: string; rawDisplayName: string }>([
    [ME, { membership: 'join', rawDisplayName: 'Eu' }],
    [AG_A, { membership: 'join', rawDisplayName: 'Zélia' }],
    [AG_B, { membership: 'join', rawDisplayName: 'Ana' }],
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
  const fetchRelations = vi.fn(async (_room: string, eventId: string, relType: string) => ({
    chunk: eventId === CREATE_ID && relType === COMMANDS_REL_TYPE ? anchorChunk : [],
  }))
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
    decryptEventIfNeeded: vi.fn(async (ev: MatrixEvent) => fire(MatrixEventEvent.Decrypted as string, ev)),
    on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
    off: () => {},
  }
  const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
  const g = gateway as unknown as { client: unknown; live: boolean; wireEvents(c: unknown): void; isOwnAgent(m: string): boolean }
  g.client = client
  g.wireEvents(client)
  g.live = true
  g.isOwnAgent = () => false
  const events: DomainEvent[] = []
  gateway.subscribe((e) => events.push(e))
  const fire = (name: string, ...args: unknown[]): void => {
    for (const h of handlers.get(name) ?? []) (h as (...a: unknown[]) => void)(...args)
  }
  const timeline = (ev: unknown): void => fire(RoomEvent.Timeline as string, ev, room, false, false, { liveEvent: true })
  const decrypted = (ev: unknown): void => fire(MatrixEventEvent.Decrypted as string, ev)
  const redaction = (target: string): void =>
    fire(RoomEvent.Redaction as string, new MatrixEvent({ type: 'm.room.redaction', redacts: target, room_id: ROOM_ID, sender: AG_A, event_id: `$red-${target}` }), room)
  const memberEvent = (userId: string, membership: string): void => {
    members.set(userId, { membership, rawDisplayName: members.get(userId)?.rawDisplayName ?? '' })
    fire(RoomStateEvent.Members as string, new MatrixEvent({ type: 'm.room.member' }), {}, { userId, roomId: ROOM_ID, membership, powerLevel: 0 })
  }
  return { gateway, events, timeline, decrypted, redaction, memberEvent, failing, fetchRelations, setAnchorChunk: (c: Partial<IEvent>[]) => (anchorChunk = c) }
}

const commandEvents = (events: DomainEvent[]) => events.flatMap((e) => (e.t === 'commands.changed' ? [e] : []))
const names = (commands: AgentCommand[]): string[] => commands.map((c) => c.name)

describe('gateway — listCommands and commands.changed', () => {
  it('lists the flat list; a live edit of the author is applied in place and emitted once on the channel — no read, never a line', async () => {
    const h = harness()
    h.setAnchorChunk([manifestRaw('$a', AG_A, 1000, [{ name: 'deploy' }]), manifestRaw('$b', AG_B, 1000, [{ name: 'build' }])])
    const onChannel: DomainEvent[] = []
    h.gateway.subscribeChannel(CHANNEL, (e) => onChannel.push(e))
    expect(names(await h.gateway.listCommands(CHANNEL))).toEqual(['build', 'deploy'])
    h.timeline(new MatrixEvent(editRaw('$e', AG_A, 2000, '$a', [{ name: 'deploy' }, { name: 'rollback' }])))
    await flush()
    const changed = commandEvents(onChannel)
    expect(changed).toHaveLength(1)
    expect(names(changed[0]!.commands)).toEqual(['build', 'deploy', 'rollback'])
    expect(h.fetchRelations).toHaveBeenCalledTimes(1)
    expect(h.events.filter((e) => e.t === 'message.received' || e.t === 'message.edited')).toEqual([])
    // The panels are not touched by a manifest.
    expect(h.events.filter((e) => e.t === 'panels.changed')).toEqual([])
  })

  it('the clear: the agent’s commands leave the list', async () => {
    const h = harness()
    h.setAnchorChunk([manifestRaw('$a', AG_A, 1000, [{ name: 'deploy' }])])
    await h.gateway.listCommands(CHANNEL)
    h.timeline(new MatrixEvent(editRaw('$clr', AG_A, 2000, '$a', [], { cleared: true })))
    await flush()
    expect(commandEvents(h.events).map((e) => e.commands)).toEqual([[]])
  })

  it('an edit forged by another member: no read, no change, no event', async () => {
    const h = harness()
    h.setAnchorChunk([manifestRaw('$a', AG_A, 1000, [{ name: 'deploy' }])])
    await h.gateway.listCommands(CHANNEL)
    h.timeline(new MatrixEvent(editRaw('$forged', BOB, 3000, '$a', [{ name: 'forjado' }])))
    await flush()
    expect(commandEvents(h.events)).toEqual([])
    expect(names(await h.gateway.listCommands(CHANNEL))).toEqual(['deploy'])
  })

  it('an agent leaving drops its commands; joining brings them back — each one change', async () => {
    const h = harness()
    h.setAnchorChunk([manifestRaw('$a', AG_A, 1000, [{ name: 'deploy' }]), manifestRaw('$b', AG_B, 1000, [{ name: 'build' }])])
    await h.gateway.listCommands(CHANNEL)
    h.memberEvent(AG_A, 'leave')
    h.memberEvent(AG_A, 'join')
    expect(commandEvents(h.events).map((e) => names(e.commands))).toEqual([['build'], ['build', 'deploy']])
  })

  it('a removed manifest: one read, no message.removed', async () => {
    const h = harness()
    h.setAnchorChunk([manifestRaw('$a', AG_A, 1000, [{ name: 'deploy' }])])
    await h.gateway.listCommands(CHANNEL)
    h.setAnchorChunk([])
    h.redaction('$a')
    await flush()
    expect(commandEvents(h.events).map((e) => e.commands)).toEqual([[]])
    expect(h.events.filter((e) => e.t === 'message.removed')).toEqual([])
    expect(h.fetchRelations).toHaveBeenCalledTimes(2)
  })

  it('late decrypt of an original the cache has without content: one read, the commands appear (once per repeat)', async () => {
    const h = harness()
    h.setAnchorChunk([manifestRaw('$a', AG_A, 1000, [{ name: 'deploy' }])])
    h.failing.add('$a')
    expect(await h.gateway.listCommands(CHANNEL)).toEqual([])
    h.failing.delete('$a')
    h.decrypted(new MatrixEvent(manifestRaw('$a', AG_A, 1000, [{ name: 'deploy' }])))
    h.decrypted(new MatrixEvent(manifestRaw('$a', AG_A, 1000, [{ name: 'deploy' }])))
    await flush()
    expect(commandEvents(h.events).map((e) => names(e.commands))).toEqual([['deploy']])
    expect(h.fetchRelations).toHaveBeenCalledTimes(2)
  })

  it('an edit that arrives already failed takes the commands off; its late decrypt brings the new ones — no read', async () => {
    const h = harness()
    h.setAnchorChunk([manifestRaw('$a', AG_A, 1000, [{ name: 'deploy' }])])
    await h.gateway.listCommands(CHANNEL)
    const failed = new MatrixEvent(editRaw('$e', AG_A, 2000, '$a', [{ name: 'novo' }]))
    failed.isDecryptionFailure = () => true
    failed.getWireContent = () => ({ 'm.relates_to': { rel_type: 'm.replace', event_id: '$a' } })
    h.timeline(failed)
    h.decrypted(new MatrixEvent(editRaw('$e', AG_A, 2000, '$a', [{ name: 'novo' }])))
    await flush()
    expect(commandEvents(h.events).map((e) => names(e.commands))).toEqual([[], ['novo']])
    expect(h.fetchRelations).toHaveBeenCalledTimes(1)
  })

  it('an unknown conversation rejects like listPanels', async () => {
    const h = harness()
    await expect(h.gateway.listCommands('!other:tayet.local' as unknown as ChannelId)).rejects.toThrow('channel not found')
  })
})
