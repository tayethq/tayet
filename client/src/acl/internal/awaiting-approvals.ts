import { ClientPrefix, Method, MatrixEvent, RelationType, type IEvent, type MatrixClient, type Room } from 'matrix-js-sdk'
import type { ApprovalState, Message } from '@tayet/shared'
import {
  APPROVAL_MSGTYPE,
  brandChannelId,
  editAppliesTo,
  isAgentSender,
  type ApprovalCardFacts,
} from '@tayet/shared/internal'
import type { AwaitingApproval, Unsubscribe } from '../types'
import {
  fetchAnswerPage,
  fetchEditPage,
  takesAnswer,
  type ApprovalAggregator,
  type RelationsClient,
} from './approval-state'
import type { SearchIndex } from './search-index'

// ADR-099: the approval cards that wait for this person, across conversations (PLANO-MOBILE §0.19).
//
// Two sources name candidates: the cards this session holds, and the search index, which is only a list
// of names. Every candidate is read again on the server before it counts, the event and then its
// relations, so a card whose state was not read is never listed (the aggregator's provisional 'open' does
// not reach here). The newest AWAITING_CAP candidates stay tracked whatever their state: that is what lets
// a deleted answer bring a card back with no request. A pass runs when the first observer comes and when
// the connection returns; between passes the live stream moves the list through the aggregator. With no
// observer every hook returns at once and nothing is held.

export const AWAITING_CAP = 200
export const AWAITING_CONCURRENCY = 4
// Each request's deadline, counted from the moment it goes out. The value the SDK gives its own
// connection probe (sync.ts, localTimeoutMs).
export const AWAITING_REQUEST_DEADLINE_MS = 15_000

export interface AwaitingPorts {
  // The client once the first sync is in, undefined outside a live session.
  client(): MatrixClient | undefined
  approvals: ApprovalAggregator
  search(): SearchIndex | undefined
  // The cards the gateway holds outside the rooms' timelines.
  heldCards(): Iterable<MatrixEvent>
  // The card is at hand: the gateway finds it for the live edit and for answerApproval.
  hold(id: string, event: MatrixEvent): void
  // The card was deleted: out of the gateway's hands and out of the index.
  drop(id: string): void
  // Translate with this reader's source of state. It starts no read of its own.
  translate(room: Room, event: MatrixEvent, stateFor: (id: string, facts: ApprovalCardFacts) => ApprovalState): Message | null
  // The state as the session shows it: its own answer in flight folded in.
  overlay(roomId: string, id: string, state: ApprovalState): ApprovalState
  emit(items: AwaitingApproval[]): void
  detach(work: Promise<unknown>): void
}

interface Card {
  id: string
  roomId: string
  ts: number
  event?: MatrixEvent
  // The last read of its state succeeded.
  read: boolean
  // The generation of its newest read; an older one that lands late changes nothing.
  seq: number
  // Edits seen live during a read: the event that read brings may predate them.
  edits: MatrixEvent[]
  // Read and not decrypted: a key that arrives reads it again.
  sealed: boolean
  shown?: { item: AwaitingApproval; json: string }
}

const unreadable = (event: MatrixEvent): boolean =>
  event.isDecryptionFailure() || (event.isEncrypted() && event.getClearContent() === null)

// A card, by what this session can read of it. The cheap test: translating would start the timeline's read.
function isCard(event: MatrixEvent): boolean {
  if (!event.getId()?.startsWith('$') || event.isRedacted() || unreadable(event)) return false
  if (event.getType() !== 'm.room.message' || !isAgentSender(event.getSender() ?? '')) return false
  return event.getOriginalContent().msgtype === APPROVAL_MSGTYPE && !event.isRelation(RelationType.Replace)
}

const isOpenRoom = (room: Room | null | undefined): room is Room =>
  !!room && room.getMyMembership() === 'join' && !room.isSpaceRoom()

function applyEdit(card: MatrixEvent, edit: MatrixEvent): void {
  if (!editAppliesTo(edit.getSender(), card.getSender())) return
  const current = card.replacingEvent()
  if (!current || current.getTs() <= edit.getTs()) card.makeReplaced(edit)
}

export class AwaitingApprovals {
  private readonly observers = new Set<symbol>()
  private readonly cards = new Map<string, Card>()
  // Lives while the list is observed in a live session; aborting it stops every request of this reader.
  private session: AbortController | undefined
  private pass: AbortController | undefined
  // A pass is choosing its candidates: what decrypts meanwhile is chosen by it, not read apart.
  private collecting = false
  // The first pass ended: from here on the list is emitted when it changes.
  private published = false
  private offline = false
  private generation = 0
  private inFlight = 0
  private readonly queue: Array<() => void> = []

  constructor(private readonly ports: AwaitingPorts) {}

  watch(): Unsubscribe {
    const observer = Symbol()
    this.observers.add(observer)
    if (this.observers.size === 1) this.start()
    return () => {
      if (this.observers.delete(observer) && this.observers.size === 0) this.stop()
    }
  }

  // The first observer came, or the session went live with observers waiting.
  start(): void {
    if (this.observers.size === 0 || this.session || !this.ports.client()) return
    this.session = new AbortController()
    this.runPass()
  }

  // The last observer left or the session ended: requests aborted, cards released.
  stop(): void {
    this.session?.abort()
    this.session = undefined
    this.pass?.abort()
    this.pass = undefined
    this.cards.clear()
    this.collecting = false
    this.published = false
  }

  reset(): void {
    this.stop()
    this.offline = false
  }

  // A tracked card is not evicted from the aggregator nor from the cards at hand.
  holds(id: string): boolean {
    return this.cards.has(id)
  }

  connection(connected: boolean): void {
    const returned = connected && this.offline
    this.offline = !connected
    if (returned && this.session) this.runPass()
  }

  // ── The live stream ────────────────────────────────────────────────────────────────────────────────
  // A card just delivered. No request of this reader: the translation that delivered it reads its state.
  arrived(event: MatrixEvent, room: Room): void {
    if (!this.session || !isCard(event) || this.cards.has(event.getId()!)) return
    const card = this.track(event.getId()!, room.roomId, event.getTs())
    if (!card) return
    card.event = event
    card.read = true
    this.update(card.id)
  }

  // A card that decrypted outside the live delivery (the key came later): its relations may predate it.
  decrypted(event: MatrixEvent, room: Room): void {
    const session = this.session
    if (!session || this.collecting || !isOpenRoom(room) || !isCard(event)) return
    const id = event.getId()!
    const known = this.cards.get(id)
    if (known && !known.sealed) return
    const card = known ?? this.track(id, room.roomId, event.getTs())
    if (!card) return
    card.sealed = false
    this.ports.detach(this.readCard(card, session.signal))
  }

  edited(id: string, edit: MatrixEvent): void {
    const card = this.cards.get(id)
    if (!card) return
    card.edits.push(edit)
    // The room's own copy is the SDK's to replace.
    const { event } = card
    if (event && this.ports.client()?.getRoom(card.roomId)?.findEventById(id) !== event) applyEdit(event, edit)
    this.update(id)
  }

  // A deletion on the timeline. The SDK reports one as such only when the room holds its target, so a
  // card or an answer this reader got from the server is settled here.
  redacted(targetId: string): void {
    if (!this.session) return
    if (this.cards.has(targetId)) this.forget(targetId)
    else this.ports.approvals.forgetAnswer(targetId)
  }

  // Something the card shows may have moved.
  update(id: string): void {
    const card = this.cards.get(id)
    if (card && this.render(card)) this.publish()
  }

  updateAll(): void {
    let changed = false
    for (const card of this.cards.values()) changed = this.render(card) || changed
    if (changed) this.publish()
  }

  // ── A pass ─────────────────────────────────────────────────────────────────────────────────────────
  private runPass(): void {
    this.pass?.abort()
    const pass = new AbortController()
    this.pass = pass
    this.collecting = true
    const run = async (): Promise<void> => {
      try {
        const chosen = await this.choose(pass.signal)
        if (pass.signal.aborted) return
        this.collecting = false
        await Promise.all(chosen.map((card) => this.readCard(card, pass.signal)))
      } catch {
        if (!pass.signal.aborted) console.warn('[acl] awaiting approvals pass failed')
      }
      if (pass.signal.aborted) return
      this.collecting = false
      if (this.published) return
      this.published = true
      this.publish()
    }
    this.ports.detach(run())
  }

  // The newest cards of both sources, plus the ones already tracked (a pass reads their relations again).
  private async choose(signal: AbortSignal): Promise<Card[]> {
    const client = this.ports.client()
    if (!client) return []
    const rooms = client.getRooms().filter(isOpenRoom)
    const eventsOf = (room: Room): MatrixEvent[] => [
      ...room.getUnfilteredTimelineSet().getTimelines().flatMap((t) => t.getEvents()),
      ...room.getThreads().flatMap((t) => t.timeline),
    ]
    // The boot's window decrypts on its own time: a card is only known as one after it.
    await Promise.all(rooms.flatMap(eventsOf).map((ev) => client.decryptEventIfNeeded(ev).catch(() => undefined)))
    const search = this.ports.search()
    await search?.ready
    if (signal.aborted) return []

    const found = new Map<string, Pick<Card, 'id' | 'roomId' | 'ts'>>()
    const add = (id: string, roomId: string, ts: number): void => {
      if (!found.has(id) && isOpenRoom(client.getRoom(roomId))) found.set(id, { id, roomId, ts })
    }
    for (const card of this.cards.values()) add(card.id, card.roomId, card.ts)
    for (const event of [...rooms.flatMap(eventsOf), ...this.ports.heldCards()]) {
      if (isCard(event)) add(event.getId()!, event.getRoomId() ?? '', event.getTs())
    }
    for (const entry of search?.approvals() ?? []) add(entry.eventId, entry.roomId, entry.ts)

    const newest = new Map([...found].sort(([, a], [, b]) => b.ts - a.ts).slice(0, AWAITING_CAP))
    let left = false
    for (const [id, card] of this.cards) {
      if (newest.has(id)) continue
      this.cards.delete(id)
      left ||= card.shown !== undefined
    }
    if (left) this.publish()
    return [...newest.values()].flatMap((c) => this.cards.get(c.id) ?? this.track(c.id, c.roomId, c.ts) ?? [])
  }

  // At most three requests without pagination: the event, its answers and, only when edited, its edits.
  private async readCard(card: Card, signal: AbortSignal): Promise<void> {
    const seq = ++this.generation
    card.seq = seq
    card.edits = []
    const current = (): boolean => !signal.aborted && card.seq === seq && this.cards.get(card.id) === card
    const { roomId, id } = card
    let read = false
    try {
      const client = this.ports.client()
      const room = client?.getRoom(roomId)
      if (!client || !isOpenRoom(room)) return
      const request = <T>(path: string, query?: Record<string, string>, prefix?: ClientPrefix): Promise<T> =>
        this.request(signal, (abortSignal) =>
          client.http.authedRequest<T>(Method.Get, path, query, undefined, { abortSignal, ...(prefix && { prefix }) }),
        )
      const base = `/rooms/${encodeURIComponent(roomId)}`
      const raw = await request<Partial<IEvent>>(`${base}/event/${encodeURIComponent(id)}`)
      if (!current()) return
      const event = new MatrixEvent({ ...raw, room_id: roomId })
      if (event.isRedacted()) {
        this.forget(id)
        return
      }
      await client.decryptEventIfNeeded(event)
      card.sealed = unreadable(event)
      if (card.sealed || !current()) return
      // The server bundles the latest edit. One that cannot be read may be the close: the state is unread.
      const bundle = event.getServerAggregatedRelation<Partial<IEvent>>(RelationType.Replace)
      if (bundle?.content && editAppliesTo(bundle.sender, event.getSender())) {
        const edit = new MatrixEvent({ ...bundle, room_id: roomId })
        await client.decryptEventIfNeeded(edit)
        card.sealed = unreadable(edit)
        if (card.sealed || !current()) return
        applyEdit(event, edit)
      }
      for (const edit of card.edits) applyEdit(event, edit)

      let facts: ApprovalCardFacts | undefined
      const message = this.ports.translate(room, event, (_id, f) => {
        facts = f
        return { kind: 'open' }
      })
      if (message?.body.kind !== 'approval' || !facts) return
      card.event = event
      this.ports.hold(id, event)
      // relationPage over this read's queue and deadline.
      const relations: RelationsClient = {
        getEventMapper: (opts) => client.getEventMapper(opts),
        decryptEventIfNeeded: (ev, opts) => client.decryptEventIfNeeded(ev, opts),
        fetchRelations: (_room, target, relType, _type, opts) =>
          request(
            `${base}/relations/${encodeURIComponent(target)}/${encodeURIComponent(relType ?? '')}`,
            { dir: String(opts?.dir), ...(opts?.from !== undefined && { from: opts.from }) },
            ClientPrefix.V1,
          ),
      }
      read = await this.ports.approvals.refresh(roomId, id, facts, {
        fetchPage: (r, c, from) => fetchAnswerPage(relations, r, c, from),
        fetchEditPage: (r, c, from) => fetchEditPage(relations, r, c, from),
      })
    } catch {
      // Failed, out of time or untranslatable: off the list until the next pass.
    } finally {
      if (current()) {
        card.read = read
        this.update(id)
      }
    }
  }

  // At most AWAITING_CONCURRENCY in flight, each with its deadline. The race covers the response's body,
  // which the SDK reads after it has let go of the abort signal.
  private async request<T>(signal: AbortSignal, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.inFlight >= AWAITING_CONCURRENCY) await new Promise<void>((resolve) => this.queue.push(resolve))
    else this.inFlight += 1
    const own = new AbortController()
    const abort = (): void => own.abort()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      if (signal.aborted) throw new Error('read ended')
      signal.addEventListener('abort', abort)
      timer = setTimeout(abort, AWAITING_REQUEST_DEADLINE_MS)
      const ended = new Promise<never>((_, reject) => {
        own.signal.addEventListener('abort', () => reject(new Error('read ended')), { once: true })
      })
      return await Promise.race([work(own.signal), ended])
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      // The slot passes straight to the next in line.
      const next = this.queue.shift()
      if (next) next()
      else this.inFlight -= 1
    }
  }

  // ── The list ───────────────────────────────────────────────────────────────────────────────────────
  // Undefined when the cap is full of newer cards.
  private track(id: string, roomId: string, ts: number): Card | undefined {
    let pushedOut: Card | undefined
    if (this.cards.size >= AWAITING_CAP) {
      pushedOut = [...this.cards.values()].reduce((a, b) => (b.ts < a.ts ? b : a))
      if (pushedOut.ts >= ts) return undefined
      this.cards.delete(pushedOut.id)
    }
    const card: Card = { id, roomId, ts, read: false, seq: 0, edits: [], sealed: false }
    this.cards.set(id, card)
    if (pushedOut?.shown) this.publish()
    return card
  }

  private forget(id: string): void {
    const card = this.cards.get(id)
    if (!card) return
    this.cards.delete(id)
    this.ports.drop(id)
    if (card.shown) this.publish()
  }

  // Recompute what the list has of this card. True when it changed.
  private render(card: Card): boolean {
    const item = this.itemOf(card)
    if (item === 'unchanged') return false
    const json = item && JSON.stringify(item)
    if (json === card.shown?.json) return false
    card.shown = item && json ? { item, json } : undefined
    return true
  }

  private itemOf(card: Card): AwaitingApproval | 'unchanged' | undefined {
    const client = this.ports.client()
    const room = client?.getRoom(card.roomId)
    if (!client || !card.read || !card.event || card.event.isRedacted() || !isOpenRoom(room)) return undefined
    const known = this.ports.approvals.peek(card.roomId, card.id)
    if (known === undefined) return undefined
    // A read of the timeline's path is settling it: what the list had stands until it lands.
    if (known === 'reading') return 'unchanged'
    const state = this.ports.overlay(card.roomId, card.id, known)
    if (!takesAnswer(state, client.getUserId() ?? undefined)) return undefined
    try {
      const message = this.ports.translate(room, card.event, () => state)
      if (message?.body.kind !== 'approval') return undefined
      return { message, channel: brandChannelId(card.roomId) }
    } catch {
      return undefined
    }
  }

  private publish(): void {
    if (!this.session || !this.published) return
    const items = [...this.cards.values()].flatMap((card) => (card.shown ? [card.shown.item] : []))
    this.ports.emit(items.sort((a, b) => b.message.sentAt - a.message.sentAt))
  }
}
