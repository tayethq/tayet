// Approval cards in the sidecar (ADR-091 (Proposto); PLANO-AGENTES §0.3.16 items 5–7, 12; A3-3): sending,
// closing and editing the agent's own cards, reading their state, and the watch that turns the first valid
// answer into `approval.answered` and seals the card.
//
// - The SAME rule and the SAME source of order as the client (client/src/acl/internal/approval-state.ts):
//   `resolveApproval` over the card's relations filtered by the answer's relation type, read explicitly
//   FORWARD (the server's default is the reverse), page by page; the close is the author's FIRST closing
//   edit, read the same way. The original options only (an edit never changes them).
// - The watch covers the agent's OPEN cards. Each one is re-read whenever something touches it (an answer
//   arriving, decrypting or being removed; the boot; a sync that comes back): a valid answer that can be
//   read → the event, then the seal (the close write, keeping the request, through the write queue). An
//   answer that cannot be read yet → wait for its key (item 7). An invalid answer → one log line, no event.
// - At least once: the open cards live in `<store>/approvals.json` (only the lock holder writes it) as
//   API tokens — conversation `C…`/`D…` + `ts` + options — never a protocol id. A stop between the event and
//   the seal sends the event again on the next run; a card found closed on the server leaves the file.
// - A seal that fails does not undo the event; it is tried again (backoff), and so is a read that fails.
// - The agent's own close never hides a valid answer (the sidecar reaches the client's conclusion): the card
//   is read again BEFORE the close write (a decided answer → the event and the seal, which is the close) and
//   once more AFTER it, against the close event's server instant (an answer up to it → the event). An
//   answer that cannot be read yet keeps the card watched, closed or not, until it decrypts.
// - Nothing of the protocol reaches a log line: reasons and counts only.
import type { MatrixClient, MatrixEvent, Room } from 'matrix-js-sdk'
import { Direction, MatrixEvent as SdkEvent, MatrixEventEvent, RelationType } from 'matrix-js-sdk'
import { readFile } from 'node:fs/promises'
import {
  APPROVAL_LABEL_MAX,
  APPROVAL_MAX_OPTIONS,
  APPROVAL_MSGTYPE,
  APPROVAL_OPTION_ID,
  RESPONSE_REL_TYPE,
  aggregateReactions,
  approvalClosed,
  brandUserId,
  buildApprovalContent,
  buildApprovalEditContent,
  displayedEdit,
  editAppliesTo,
  mayAnswer,
  readApprovalOptions,
  resolveApproval,
  responseOption,
  richFromContent,
  type ApprovalAccounts,
  type ApprovalAnswer,
} from '@tayet/shared/internal'
import type { ApprovalOption, ApprovalState, RichDoc } from '@tayet/shared'
import type { ApiApproval, ApiApprovalStatus, ApiEvent, ApiMessage, ApiRich } from '../api/contract'
import { writeJsonAtomic } from '../store'
import { ReadError, type Resolver } from './read'
import { MENTIONS_MAX, WriteError, writeHelpers, type WriteDeps } from './write'

type Log = (line: Record<string, unknown>) => void

// ── Options (§0.3.16 item 12): the shared constants; more than one `primary` is refused, never demoted
// (demoting is the Slack layer's, A3-4). ─────────────────────────────────────────────────────────────
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const OPTION_KEYS: ReadonlySet<string> = new Set(['id', 'label', 'style'])

export function approvalOptionsOf(raw: unknown): ApprovalOption[] {
  const bad = (): never => {
    throw new WriteError('invalid_argument')
  }
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > APPROVAL_MAX_OPTIONS) return bad()
  const ids = new Set<string>()
  let primaries = 0
  return raw.map((item: unknown) => {
    if (!isRecord(item) || Object.keys(item).some((k) => !OPTION_KEYS.has(k))) return bad()
    const { id, label, style } = item
    if (typeof id !== 'string' || !APPROVAL_OPTION_ID.test(id) || ids.has(id)) return bad()
    if (typeof label !== 'string' || label.trim() === '' || [...label].length > APPROVAL_LABEL_MAX) return bad()
    if (style !== undefined && style !== 'primary' && style !== 'danger') return bad()
    if (style === 'primary' && ++primaries > 1) return bad()
    ids.add(id)
    return { id, label, ...(style !== undefined && { style }) }
  })
}

// ── Reading a card's state ──────────────────────────────────────────────────────────────────────────
export type RelationsClient = Pick<MatrixClient, 'fetchRelations' | 'getEventMapper' | 'decryptEventIfNeeded'>

export type IgnoredReason = 'not-a-person' | 'unknown-option' | 'after-close'

export interface CardReading {
  // open | answered | closed (resolveApproval never yields the client's sending/failed).
  state: ApprovalState
  // The author's first closing edit, or undefined while open.
  closedAt: number | undefined
  // Answers read that do not count, ahead of the one that decided (or all of them when none did).
  ignored: Array<{ eventId: string; reason: IgnoredReason }>
  // Every answer read (a removal of one of them is a reason to read again).
  answerIds: string[]
  // The deciding answer when it cannot be read yet: the watch waits for its key.
  pending?: MatrixEvent
  // The id of the answer that decided the card, when one did.
  decidedId?: string
}

export interface CardReader {
  // The card's state from the server. `fresh` skips the cache (a closed card's reading is kept: after the
  // close nothing counts any more).
  // `closedAt` is a close instant already known (the server's instant of the agent's own close event): the
  // edits are not read for it.
  read(roomId: string, cardId: string, options: readonly ApprovalOption[], opts?: { fresh?: boolean; closedAt?: number }): Promise<CardReading>
}

export const SETTLED_MAX = 500

type AnswerFact = ApprovalAnswer & { eventId: string; event: MatrixEvent }

// One page of a card's relations of one type, explicitly FORWARD (ADR-091 dec. 5), each event decrypted
// (or failed) before it is read — the client's relationPage.
export async function relationPage(client: RelationsClient, roomId: string, cardId: string, relType: string, from: string | undefined): Promise<{ events: MatrixEvent[]; next?: string }> {
  const res = await client.fetchRelations(roomId, cardId, relType, null, { dir: Direction.Forward, ...(from !== undefined && { from }) })
  const mapper = client.getEventMapper()
  const events = res.chunk.map((raw) => mapper(raw))
  await Promise.all(events.map((ev) => client.decryptEventIfNeeded(ev).catch(() => undefined)))
  return { events, ...(res.next_batch ? { next: res.next_batch } : {}) }
}

function answerFactOf(event: MatrixEvent): AnswerFact | undefined {
  const eventId = event.getId()
  const sender = event.getSender()
  if (!eventId || !sender) return undefined
  const decrypted = !event.isDecryptionFailure() && !(event.isEncrypted() && event.getClearContent() === null)
  const option = decrypted ? responseOption(event.getContent()) : undefined
  return { eventId, event, sender, ts: event.getTs(), decrypted, ...(option !== undefined && { option }), ...(event.isRedacted() && { redacted: true }) }
}

// Whether this answer counts, and why not (the order of resolveApproval's checks).
function verdictOf(a: AnswerFact, options: readonly ApprovalOption[], closedAt: number | undefined, accounts: ApprovalAccounts): IgnoredReason | 'redacted' | 'counts' {
  if (a.redacted === true) return 'redacted'
  if (!mayAnswer(a.sender, accounts)) return 'not-a-person'
  if (closedAt !== undefined && a.ts > closedAt) return 'after-close'
  if (!a.decrypted) return 'counts'
  return a.option !== undefined && options.some((o) => o.id === a.option) ? 'counts' : 'unknown-option'
}

export function createCardReader(client: RelationsClient, accounts: () => ApprovalAccounts, author: () => string, max = SETTLED_MAX): CardReader {
  const settled = new Map<string, CardReading>()
  return {
    async read(roomId, cardId, options, opts = {}) {
      const key = `${roomId} ${cardId}`
      const kept = settled.get(key)
      if (kept !== undefined && opts.fresh !== true) return kept
      // The close: the author's first edit carrying the mark (an edit that does not decrypt never closes).
      let closedAt: number | undefined = opts.closedAt
      let from: string | undefined
      while (closedAt === undefined) {
        const page = await relationPage(client, roomId, cardId, RelationType.Replace, from)
        const first = page.events.find((ev) => {
          if (ev.getSender() !== author() || ev.isDecryptionFailure() || ev.isRedacted()) return false
          const next = ((ev.getContent())['m.new_content'] ?? {}) as Record<string, unknown>
          return approvalClosed(next)
        })
        if (first !== undefined) {
          closedAt = first.getTs()
          break
        }
        if (page.next === undefined) break
        from = page.next
      }
      // The answers, until the end or the first one that resolves the card.
      const answers: AnswerFact[] = []
      let state: ApprovalState
      const closedOn = closedAt
      from = undefined
      for (;;) {
        const page = await relationPage(client, roomId, cardId, RESPONSE_REL_TYPE, from)
        for (const ev of page.events) {
          if (ev.getType() !== 'm.room.message' && !ev.isDecryptionFailure()) continue
          const fact = answerFactOf(ev)
          if (fact !== undefined) answers.push(fact)
        }
        state = resolveApproval(options, answers, closedOn, accounts())
        if (state.kind === 'answered' || page.next === undefined) break
        from = page.next
      }
      const ignored: CardReading['ignored'] = []
      let pending: MatrixEvent | undefined
      let decidedId: string | undefined
      for (const a of answers) {
        const verdict = verdictOf(a, options, closedAt, accounts())
        if (verdict === 'counts') {
          if (!a.decrypted) pending = a.event
          if (state.kind === 'answered') decidedId = a.eventId
          break
        }
        if (verdict !== 'redacted') ignored.push({ eventId: a.eventId, reason: verdict })
      }
      const reading: CardReading = {
        state,
        closedAt,
        ignored,
        answerIds: answers.map((a) => a.eventId),
        ...(pending !== undefined && { pending }),
        ...(decidedId !== undefined && { decidedId }),
      }
      if (closedAt !== undefined && pending === undefined) {
        settled.delete(key)
        settled.set(key, reading)
        if (settled.size > max) settled.delete(settled.keys().next().value as string)
      }
      return reading
    },
  }
}

// ── The facade (the native routes and the MCP tools) ─────────────────────────────────────────────────
export interface ApprovalRequest {
  text: string
  rich?: RichDoc
  options: ApprovalOption[]
  thread?: string
  mentions?: string[]
}

export interface ApprovalFacade {
  request(conversation: string, req: ApprovalRequest): Promise<ApiMessage>
  close(conversation: string, ts: string, text?: string, rich?: RichDoc): Promise<ApiMessage>
  state(conversation: string, ts: string): Promise<ApiApprovalStatus>
}

export interface ApprovalDeps extends WriteDeps {
  reader: CardReader
  watch: Pick<ApprovalWatch, 'track' | 'settle'>
  client: WriteDeps['client'] & { getRoom: MatrixClient['getRoom'] }
}

interface Card {
  eventId: string
  ev: MatrixEvent
  options: ApprovalOption[]
  // The content the card shows: the author's latest edit (PLANO-AGENTES §8.30), else the original.
  shown: Record<string, unknown>
}

export interface ApprovalCore {
  facade: ApprovalFacade
  // The PATCH of a card (write.ts `editCard`).
  editCard: NonNullable<WriteDeps['editCard']>
  // The seal of the watch: the close write, keeping the request (no write when already closed).
  seal: (roomId: string, eventId: string) => Promise<void>
  // The `approval` of a message the read side projects: the state only on the agent's own cards.
  approvalOf: (roomId: string, eventId: string, options: readonly ApprovalOption[], own: boolean) => Promise<ApiApproval>
}

// The `approval` of an own card from a reading's state.
function viewOf(options: readonly ApprovalOption[], state: ApprovalState, personToken: (userId: string) => string): ApiApproval {
  const view: ApiApproval = { options: optionsView(options) }
  switch (state.kind) {
    case 'answered':
      return { ...view, state: 'answered', answer: { ...(state.option !== undefined && { option: state.option }), by: personToken(state.by), at: state.at as unknown as number } }
    case 'closed':
      return { ...view, state: 'closed' }
    case 'open':
    case 'sending':
    case 'failed':
    case 'multi':
      // The client's local states and the state of a card that asks for several answers never come out of
      // resolveApproval.
      return { ...view, state: 'open' }
  }
}

const optionsView = (options: readonly ApprovalOption[]): ApiApproval['options'] =>
  options.map((o) => ({ id: o.id, label: o.label, ...(o.style !== undefined && { style: o.style }) }))

export function createApprovalCore(deps: ApprovalDeps): ApprovalCore {
  const { client, resolver, reader } = deps
  const h = writeHelpers(deps)

  // The agent's own card at a ts: own (not_own_message), a readable card (not_approval). An event read
  // from the server gets its latest edit applied — the author's only — as a listing page does.
  const cardOf = async (room: Room, eventId: string, ev: MatrixEvent): Promise<Card> => {
    h.owned(ev)
    if (ev.isDecryptionFailure()) throw new WriteError('not_approval')
    const original = ev.getOriginalContent()
    const options = original.msgtype === APPROVAL_MSGTYPE ? readApprovalOptions(original) : undefined
    if (options === undefined) throw new WriteError('not_approval')
    if (room.findEventById(eventId) === undefined && ev.replacingEvent() === null) {
      const bundled = ev.getServerAggregatedRelation<Record<string, unknown>>(RelationType.Replace)
      if (bundled) {
        const edit = new SdkEvent(bundled)
        await client.decryptEventIfNeeded(edit).catch(() => undefined)
        if (!edit.isDecryptionFailure() && editAppliesTo(edit.getSender(), ev.getSender())) ev.makeReplaced(edit)
      }
    }
    return { eventId, ev, options, shown: displayedEdit(ev).content }
  }

  const cardAt = async (room: Room, ts: string): Promise<Card> => {
    const { eventId, ev } = await h.messageAt(room, ts)
    return cardOf(room, eventId, ev)
  }

  const approvalOf = async (roomId: string, eventId: string, options: readonly ApprovalOption[], own: boolean): Promise<ApiApproval> => {
    if (!own) return { options: optionsView(options) }
    const { state } = await reader.read(roomId, eventId, options)
    return viewOf(options, state, (u) => resolver.tokenOfPerson(u))
  }

  // The card as an ApiMessage (the answers of close and PATCH). `state`: the one a reading just gave.
  const messageOf = async (room: Room, card: Card, shown: Record<string, unknown>, editedAt?: number, state?: ApprovalState): Promise<ApiMessage> => {
    const rich = richFromContent(shown)
    const ts = resolver.tsOf(room.roomId, card.eventId, card.ev.getTs())
    if (ts === null) throw new WriteError('upstream_failed')
    return {
      id: ts,
      conversation: resolver.tokenOfRoom(room.roomId),
      author: resolver.tokenOfPerson(h.me()),
      text: typeof shown.body === 'string' ? shown.body : '',
      ...(rich !== undefined && { rich: rich as unknown as ApiRich }),
      ...(await h.tsOfRelation(room, card.ev)),
      mentionsMe: false,
      reactions: aggregateReactions(room, card.eventId, h.me()).map((r) => ({ emoji: r.emoji, count: r.count, mine: r.mine })),
      ...(editedAt !== undefined && { editedAt }),
      approval: state !== undefined ? viewOf(card.options, state, (u) => resolver.tokenOfPerson(u)) : await approvalOf(room.roomId, card.eventId, card.options, true),
    }
  }

  // The close write (the agent's close and the seal): the request kept unless a new one is given. Returns
  // the new content and the server's instant of the close event.
  const writeClose = async (room: Room, card: Card, text?: string, rich?: RichDoc): Promise<{ shown: Record<string, unknown>; closedAt: number }> => {
    const keep = text === undefined
    const body = keep ? (typeof card.shown.body === 'string' ? card.shown.body : '') : text
    const doc = keep ? richFromContent(card.shown) : rich
    const content = buildApprovalEditContent(body, doc, card.options, true, card.eventId)
    const editId = await h.run({ kind: 'content', channel: room.roomId, content }, 'approval-close')
    return { shown: content['m.new_content'], closedAt: await h.instantOf(room, editId) }
  }

  // A settle whose read or seal failed: the close answers upstream_failed (the watch keeps trying).
  const settled = async (...args: Parameters<ApprovalWatch['settle']>): Promise<Settled> => {
    const out = await deps.watch.settle(...args)
    if (out.outcome === 'retry') throw new WriteError('upstream_failed')
    return out
  }

  const facade: ApprovalFacade = {
    async request(conversation, req) {
      const options = approvalOptionsOf(req.options)
      if (req.text.trim() === '') throw new WriteError('invalid_argument')
      const tokens = req.mentions ?? []
      if (tokens.length > MENTIONS_MAX || new Set(tokens).size !== tokens.length) throw new WriteError('invalid_argument')
      const room = h.joined(conversation)
      const mentions = tokens.map((t) => brandUserId(resolver.userOf(t)))
      let thread: string | undefined
      let threadTs: string | undefined
      if (req.thread !== undefined) {
        thread = await h.threadRoot(room, req.thread)
        threadTs = await resolver.tsOfRelated(room, thread)
      }
      const content = buildApprovalContent(req.text, req.rich, options, mentions, thread)
      const eventId = await h.run({ kind: 'content', channel: room.roomId, content, ...(thread !== undefined && { thread }) }, 'approval')
      const id = await h.acceptedTs(room, eventId)
      const token = resolver.tokenOfRoom(room.roomId)
      await deps.watch.track({ conversation: token, id, options }, { roomId: room.roomId, eventId })
      return {
        id,
        conversation: token,
        author: resolver.tokenOfPerson(h.me()),
        text: req.text,
        ...(req.rich !== undefined && { rich: req.rich as unknown as ApiRich }),
        ...(threadTs !== undefined && { thread: threadTs }),
        mentionsMe: false,
        ...(tokens.length > 0 && { mentions: tokens }),
        reactions: [],
        approval: { options: optionsView(options), state: 'open' },
      }
    },

    // The agent's close never hides a valid answer: read before the write, and once more after it.
    async close(conversation, ts, text, rich) {
      const room = h.joined(conversation)
      const card = await cardAt(room, ts)
      const tracked: TrackedCard = { conversation: resolver.tokenOfRoom(room.roomId), id: ts, options: card.options }
      const where = { roomId: room.roomId, eventId: card.eventId }
      if (approvalClosed(card.shown)) {
        // Already closed: no write; an answer up to the close that was never reported goes out now.
        const out = await settled(tracked, where)
        return messageOf(room, card, card.shown, undefined, out.reading?.state)
      }
      const before = await settled(tracked, where)
      // A decided answer was there: the event went out and the seal is the close (no second close).
      if (before.outcome === 'answered') return messageOf(room, card, card.shown, undefined, before.reading?.state)
      const written = await writeClose(room, card, text, rich)
      const after = await deps.watch.settle(tracked, where, written.closedAt)
      return messageOf(room, card, written.shown, written.closedAt, after.reading?.state)
    },

    async state(conversation, ts) {
      const room = h.joined(conversation)
      const card = await cardAt(room, ts)
      return { conversation: resolver.tokenOfRoom(room.roomId), id: ts, approval: await approvalOf(room.roomId, card.eventId, card.options, true) }
    },
  }

  return {
    facade,
    async editCard(room, eventId, ev, text, rich) {
      const card = await cardOf(room, eventId, ev)
      // Only the request changes: the original options, and the close as it is.
      const content = buildApprovalEditContent(text, rich, card.options, approvalClosed(card.shown), eventId)
      const editId = await h.run({ kind: 'content', channel: room.roomId, content }, 'approval-edit')
      return messageOf(room, card, content['m.new_content'], await h.instantOf(room, editId))
    },
    async seal(roomId, eventId) {
      const room = client.getRoom(roomId)
      if (room === null || room.getMyMembership() !== 'join') throw new WriteError('not_member')
      const ev = await h.loadEvent(room, eventId)
      if (ev === null || ev.isRedacted()) throw new ReadError('message_not_found')
      const card = await cardOf(room, eventId, ev)
      if (!approvalClosed(card.shown)) await writeClose(room, card)
    },
    approvalOf,
  }
}

// ── The watch ───────────────────────────────────────────────────────────────────────────────────────
export const APPROVALS_FILE = 'approvals.json'
// The waits between attempts of a seal (or of a read) that failed; the last one repeats.
export const RETRY_MS = [2_000, 5_000, 15_000, 60_000] as const
// A deciding answer that cannot be read: read again at this pace too, besides its key's arrival.
export const DECRYPT_RECHECK_MS = 60_000
// A card whose message cannot be found is given this many attempts before it leaves the file.
export const LOCATE_ATTEMPTS = 5

// What the file keeps: API tokens and the options, never a protocol id.
export interface TrackedCard {
  conversation: string
  id: string
  options: ApprovalOption[]
}

export type SetTimer = (fn: () => void, ms: number) => () => void
const realTimer: SetTimer = (fn, ms) => {
  const t = setTimeout(fn, ms)
  t.unref()
  return () => clearTimeout(t)
}

export interface WatchDeps {
  file: string
  reader: CardReader
  // The card's room and event; null when the card is gone for good (the conversation left, or the message
  // not found). Thrown errors are transient.
  locate(card: TrackedCard): Promise<{ roomId: string; eventId: string } | null>
  seal(roomId: string, eventId: string): Promise<void>
  personToken(userId: string): string
  emit(event: ApiEvent): void
  log: Log
  setTimer?: SetTimer
}

// What the last read of a card concluded: open (nothing counts yet); waiting (a deciding answer cannot be
// read yet); answered (the event went out — sealed when it was open); closed (closed with no valid answer);
// retry (a read or the seal failed, tried again later); gone (the card left the watch for good).
export type Outcome = 'open' | 'waiting' | 'answered' | 'closed' | 'retry' | 'gone'
export interface Settled {
  outcome: Outcome
  reading?: CardReading
}

interface Watched extends TrackedCard {
  roomId?: string
  eventId?: string
  running: boolean
  again: boolean
  attempts: number
  locateMisses: number
  // The server's instant of the agent's own close, when this run wrote it.
  closedAt?: number
  current?: Promise<void>
  last?: Settled
  cancel?: () => void
}

const keyOf = (c: TrackedCard): string => `${c.conversation} ${c.id}`

export class ApprovalWatch {
  private readonly cards = new Map<string, Watched>()
  private readonly byEvent = new Map<string, Watched>()
  // Answer event id → its card (a removal of an answer names only the answer).
  private readonly byAnswer = new Map<string, Watched>()
  private readonly logged = new Set<string>()
  // Cards whose event went out in this run (kept past the card leaving the watch: never twice per run).
  private readonly emitted = new Set<string>()
  private saving: Promise<void> = Promise.resolve()
  private readonly setTimer: SetTimer
  private stopped = false

  constructor(private readonly deps: WatchDeps) {
    this.setTimer = deps.setTimer ?? realTimer
  }

  // The open cards of earlier runs (a file that cannot be read is an empty watch, with a log line).
  async load(): Promise<void> {
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(this.deps.file, 'utf8'))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.deps.log({ evt: 'approvals-file-unreadable' })
      return
    }
    const list = isRecord(raw) && Array.isArray(raw.cards) ? raw.cards : []
    for (const item of list) {
      if (!isRecord(item) || typeof item.conversation !== 'string' || typeof item.id !== 'string') continue
      const options = readApprovalOptions({ [APPROVAL_MSGTYPE]: { options: item.options } })
      if (options === undefined) continue
      const card: Watched = { conversation: item.conversation, id: item.id, options, running: false, again: false, attempts: 0, locateMisses: 0 }
      this.cards.set(keyOf(card), card)
    }
    if (this.cards.size > 0) this.deps.log({ evt: 'approvals-loaded', count: this.cards.size })
  }

  get size(): number {
    return this.cards.size
  }

  // A card just sent: kept (on disk before the answer of the send) and read once — an answer may have
  // come before the watch knew the card.
  async track(card: TrackedCard, where: { roomId: string; eventId: string }): Promise<void> {
    const watched: Watched = { ...card, ...where, running: false, again: false, attempts: 0, locateMisses: 0 }
    this.cards.set(keyOf(card), watched)
    this.byEvent.set(where.eventId, watched)
    await this.persist()
    void this.check(watched)
  }

  // Read the card now and say what it concluded (the agent's close, before and after its write). A card
  // the watch does not hold (sent by an earlier run whose file was lost) is taken in for the read.
  // `closedAt`: the server's instant of the close this run just wrote.
  async settle(card: TrackedCard, where: { roomId: string; eventId: string }, closedAt?: number): Promise<Settled> {
    let watched = this.byEvent.get(where.eventId) ?? this.cards.get(keyOf(card))
    if (watched === undefined) {
      watched = { ...card, ...where, running: false, again: false, attempts: 0, locateMisses: 0 }
      this.cards.set(keyOf(card), watched)
      this.byEvent.set(where.eventId, watched)
    }
    if (closedAt !== undefined) watched.closedAt = closedAt
    watched.last = undefined
    await this.check(watched, true)
    return watched.last ?? { outcome: 'gone' }
  }

  // The boot and a sync that comes back: every open card is read again.
  recheckAll(): void {
    for (const card of this.cards.values()) void this.check(card)
  }

  // A live event (from the timeline, or a decryption): an answer to a watched card, or the removal of a
  // known answer, reads that card again.
  noteEvent(ev: MatrixEvent): void {
    const wire = ev.getWireContent() as Record<string, unknown>
    const rel = wire['m.relates_to'] as { rel_type?: unknown; event_id?: unknown } | undefined
    if (rel?.rel_type === RESPONSE_REL_TYPE && typeof rel.event_id === 'string') {
      const card = this.byEvent.get(rel.event_id)
      if (card !== undefined) void this.check(card)
      return
    }
    const redacts = ev.getType() === 'm.room.redaction' ? ((ev.event as { redacts?: unknown }).redacts ?? ev.getContent<{ redacts?: unknown }>().redacts) : undefined
    if (typeof redacts === 'string') {
      const card = this.byAnswer.get(redacts)
      if (card !== undefined) void this.check(card)
    }
  }

  // No more reads or timers; resolves once the file has the last set (the lock is released after it).
  stop(): Promise<void> {
    this.stopped = true
    for (const card of this.cards.values()) card.cancel?.()
    return this.saved()
  }

  // The pending writes of the file, settled.
  saved(): Promise<void> {
    return this.saving
  }

  // One card read at a time; a touch during a read reads it once more after (the promise settles after
  // that last read). `fresh`: a read that must start after this call, even if one is under way.
  private check(card: Watched, fresh = false): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (card.running && card.current !== undefined) {
      card.again = true
      if (!fresh) return card.current
    }
    if (card.running) return card.current ?? Promise.resolve()
    card.running = true
    card.cancel?.()
    card.cancel = undefined
    card.current = (async () => {
      try {
        do {
          card.again = false
          await this.once(card)
        } while (card.again && !this.stopped && this.cards.get(keyOf(card)) === card)
      } finally {
        card.running = false
      }
    })()
    return card.current
  }

  private later(card: Watched, ms: number): void {
    if (this.stopped || this.cards.get(keyOf(card)) !== card) return
    card.cancel?.()
    card.cancel = this.setTimer(() => {
      card.cancel = undefined
      void this.check(card)
    }, ms)
  }

  private retry(card: Watched): void {
    const ms = RETRY_MS[Math.min(card.attempts, RETRY_MS.length - 1)] as number
    card.attempts += 1
    this.later(card, ms)
  }

  private async once(card: Watched): Promise<void> {
    const { log } = this.deps
    if (card.roomId === undefined || card.eventId === undefined) {
      let where: { roomId: string; eventId: string } | null
      try {
        where = await this.deps.locate(card)
      } catch {
        log({ evt: 'approval-check-failed', stage: 'locate' })
        card.last = { outcome: 'retry' }
        return this.retry(card)
      }
      if (where === null) {
        card.locateMisses += 1
        card.last = { outcome: 'retry' }
        if (card.locateMisses < LOCATE_ATTEMPTS) return this.retry(card)
        log({ evt: 'approval-card-gone' })
        card.last = { outcome: 'gone' }
        return this.drop(card)
      }
      card.roomId = where.roomId
      card.eventId = where.eventId
      this.byEvent.set(where.eventId, card)
    }
    let reading: CardReading
    try {
      reading = await this.deps.reader.read(card.roomId, card.eventId, card.options, { fresh: true, ...(card.closedAt !== undefined && { closedAt: card.closedAt }) })
    } catch {
      log({ evt: 'approval-check-failed', stage: 'read' })
      card.last = { outcome: 'retry' }
      return this.retry(card)
    }
    for (const id of reading.answerIds) this.byAnswer.set(id, card)
    for (const { eventId, reason } of reading.ignored) {
      if (this.logged.has(eventId)) continue
      this.logged.add(eventId)
      log({ evt: 'approval-answer-ignored', reason })
    }
    const state = reading.state
    if (state.kind !== 'answered') {
      // Closed with no valid answer up to the close: nothing more to watch.
      if (reading.closedAt !== undefined) {
        card.last = { outcome: 'closed', reading }
        return this.drop(card)
      }
      card.last = { outcome: 'open', reading }
      return
    }
    if (state.option === undefined) {
      // Item 7: who and when are known, the option is not — wait for the key before the event, closed or not.
      card.last = { outcome: 'waiting', reading }
      const pending = reading.pending
      if (pending !== undefined) pending.once(MatrixEventEvent.Decrypted, () => void this.check(card))
      return this.later(card, DECRYPT_RECHECK_MS)
    }
    if (!this.emitted.has(keyOf(card))) {
      this.emitted.add(keyOf(card))
      log({ evt: 'approval-answered' })
      this.deps.emit({
        type: 'approval.answered',
        conversation: card.conversation,
        id: card.id,
        option: state.option,
        by: this.deps.personToken(state.by),
        at: state.at as unknown as number,
      })
    }
    // Already closed (by the agent, or by the seal of an earlier run): the event was all that was missing.
    if (reading.closedAt !== undefined) {
      card.last = { outcome: 'answered', reading }
      return this.drop(card)
    }
    try {
      await this.deps.seal(card.roomId, card.eventId)
      card.last = { outcome: 'answered', reading }
      this.drop(card)
    } catch (err) {
      // Gone for good: the card leaves the watch. Anything else is tried again; the event stands.
      const code = err instanceof WriteError || err instanceof ReadError ? err.code : undefined
      if (code === 'not_member' || code === 'message_not_found' || code === 'not_approval' || code === 'not_own_message') {
        log({ evt: 'approval-seal-dropped', code })
        card.last = { outcome: 'gone', reading }
        return this.drop(card)
      }
      card.last = { outcome: 'retry', reading }
      if (code === 'revoked' || code === 'unavailable') return
      log({ evt: 'approval-seal-failed', attempt: card.attempts + 1, ...(code !== undefined && { code }) })
      this.retry(card)
    }
  }

  private drop(card: Watched): void {
    if (this.cards.get(keyOf(card)) !== card) return
    card.cancel?.()
    this.cards.delete(keyOf(card))
    if (card.eventId !== undefined) this.byEvent.delete(card.eventId)
    for (const [id, c] of this.byAnswer) if (c === card) this.byAnswer.delete(id)
    void this.persist()
  }

  // Writes are chained (writeJsonAtomic's temp name is per process); each one writes the latest set.
  private persist(): Promise<void> {
    this.saving = this.saving
      .then(() => writeJsonAtomic(this.deps.file, { cards: [...this.cards.values()].map(({ conversation, id, options }) => ({ conversation, id, options })) }))
      .catch(() => this.deps.log({ evt: 'approvals-file-error' }))
    return this.saving
  }
}

// The watch's `locate` over the read side's reverse lookups: the token of a conversation the agent left,
// or a ts that names no message, is a card gone.
export function locateWith(resolver: Resolver): WatchDeps['locate'] {
  return async (card) => {
    let room: Room
    try {
      room = resolver.roomAnyOf(card.conversation)
    } catch {
      return null
    }
    if (room.getMyMembership() !== 'join') return null
    try {
      return { roomId: room.roomId, eventId: await resolver.eventOf(room, card.id) }
    } catch (err) {
      if (err instanceof ReadError) return null
      throw err
    }
  }
}
