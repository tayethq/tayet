import { Direction, RelationType, type MatrixClient, type MatrixEvent } from 'matrix-js-sdk'
import type { ApprovalState } from '@tayet/shared'
import {
  RESPONSE_REL_TYPE,
  approvalClosed,
  approvalSettled,
  resolveApproval,
  resolveMultiApproval,
  responseOption,
  type ApprovalAccounts,
  type ApprovalAnswer,
  type ApprovalCardFacts,
} from '@tayet/shared/internal'

// ADR-091 (Proposto) dec. 3/5/6/7/8/9 — the client's aggregator of approval-card state (PLANO-AGENTES
// §0.3.16 items 3 and 4). The card is born 'open' (or 'closed') and resolves when the read of its answers
// lands: the timeline never waits. The source of the order is the card's relations filtered by the
// answer's relation type, read FORWARD (the server's default is the reverse) — the same source the
// sidecar reads. One cache entry per card; live answers, late decrypts and deletions update it, and each
// change that moves the state re-emits the card (message.edited, by the gateway).
//
// The close (dec. 7) is dated by the author's FIRST edit carrying the closing mark and is permanent: a
// later edit of the author, with or without the mark, neither reopens the card nor moves that instant —
// it only changes the text shown. For an edited card the aggregator reads its edits the same way (the
// card's relations, forward) up to the first closing edit of the author; live, the first close seen
// fixes the instant.

// One answer, with its event id (to dedupe live/paged copies, apply a late decrypt and drop a deletion).
export type AnswerFact = ApprovalAnswer & { eventId: string }

export interface AnswerPage {
  answers: AnswerFact[]
  next?: string
}

// One edit of the card, as the close needs it: author, server instant, whether it carries the mark.
export interface EditFact {
  sender: string
  ts: number
  closed: boolean
}

export interface EditPage {
  edits: EditFact[]
  next?: string
}

export interface ApprovalPorts {
  // One page of the card's answers in the server's order, from `from` (undefined = the start).
  fetchPage(roomId: string, cardId: string, from: string | undefined): Promise<AnswerPage>
  // One page of the card's edits in the server's order.
  fetchEditPage(roomId: string, cardId: string, from: string | undefined): Promise<EditPage>
  accounts(): ApprovalAccounts
  // The state of this card moved: re-translate and re-emit it.
  changed(roomId: string, cardId: string): void
  // Detached work is tracked by the gateway (disconnect waits / drops it).
  detach(work: Promise<unknown>): void
  // ADR-099: a card observed by the awaiting list is never evicted.
  held?(cardId: string): boolean
  // ADR-099: a read of the card ended (or failed) and what it shows did not move.
  settled?(roomId: string, cardId: string): void
}

export type ApprovalReads = Pick<ApprovalPorts, 'fetchPage' | 'fetchEditPage'>

interface Entry {
  roomId: string
  cardId: string
  // The answers in the server's order: those of the pages read forward, as the server returned them (the
  // authority), then those that arrived only live and are in no page yet, in order of arrival. A live
  // answer a page later brings takes the page's place; a late decrypt keeps the answer where it is.
  paged: AnswerFact[]
  live: AnswerFact[]
  // The last facts the card was translated with — the rule needs them to tell whether to read further.
  facts: ApprovalCardFacts
  // The read reached the last page.
  complete: boolean
  next: string | undefined
  // A read is under way (its generation; an invalidation bumps it, so a stale read is dropped).
  loading: number | undefined
  loaded: boolean
  // The first closing edit of the author found in the card's edits: undefined = not read yet, null =
  // read, none. `liveClose` is the first close this session saw on the stream.
  firstClose: number | null | undefined
  liveClose: number | undefined
  editsLoading: boolean
  // ADR-099, refresh: the generation of the one under way; and whether one found the card edited, which
  // a later translation of an older copy of the event must not undo.
  refreshing: number | undefined
  editSeen: boolean
  // What the card last showed, to emit only when it moves.
  shown: string
}

// Cards kept in the cache; past this the oldest goes (it reloads on its next translation).
export const APPROVAL_CACHE_CAP = 500

const keyOf = (roomId: string, cardId: string): string => `${roomId}\u0000${cardId}`
// Before the read lands: open or closed, or, on a card that asks for several answers, no answers yet.
const fallback = (facts: ApprovalCardFacts): ApprovalState =>
  facts.needed !== undefined
    ? { kind: 'multi', needed: facts.needed, answers: [], closed: facts.closedAt !== undefined }
    : facts.closedAt !== undefined
      ? { kind: 'closed' }
      : { kind: 'open' }
const minOf = (...xs: Array<number | null | undefined>): number | undefined => {
  const ns = xs.filter((x): x is number => typeof x === 'number')
  return ns.length > 0 ? Math.min(...ns) : undefined
}

export class ApprovalAggregator {
  private readonly entries = new Map<string, Entry>()
  // Answer event id → the card it answers (live decrypts and deletions name only the answer).
  private readonly byAnswer = new Map<string, string>()
  private generation = 0
  // Deletions seen during each refresh under way: its pages may still carry the deleted answer.
  private readonly goneDuringRefresh = new Set<Set<string>>()

  constructor(private readonly ports: ApprovalPorts) {}

  // Synchronous, from the translator (Ctx.approvalStateFor): the cached state, else the fallback while
  // the reads start in the background.
  stateFor(roomId: string, cardId: string, facts: ApprovalCardFacts): ApprovalState {
    const key = keyOf(roomId, cardId)
    let entry = this.entries.get(key)
    if (!entry) {
      entry = this.create(roomId, cardId, facts)
      if (facts.edited) this.readEdits(entry)
      this.read(entry)
      return fallback(facts)
    }
    // LRU touch.
    this.entries.delete(key)
    this.entries.set(key, entry)
    entry.facts = entry.editSeen ? { ...facts, edited: true } : facts
    // An entry only a refresh created so far: the timeline does not wait for that one.
    if (!entry.loaded && entry.loading === undefined) this.read(entry)
    if (facts.edited && entry.firstClose === undefined && entry.liveClose === undefined && !entry.editsLoading) this.readEdits(entry)
    const state = this.ready(entry) ? this.resolve(entry) : fallback(facts)
    entry.shown = JSON.stringify(state)
    // A close (or an edit) can make the rule want answers past where the read stopped.
    if (this.ready(entry) && !approvalSettled(state) && !entry.complete && entry.loading === undefined) this.read(entry)
    return state
  }

  // ADR-099: read the card from the start, awaited: its close first when it is edited, then its answers.
  // Nothing changes until both land, and then they replace what the cache had, which a gap of the sync may
  // have left behind. Rejects when a request fails; false when a newer refresh or an eviction overtook it.
  async refresh(roomId: string, cardId: string, facts: ApprovalCardFacts, reads: ApprovalReads): Promise<boolean> {
    const key = keyOf(roomId, cardId)
    const entry = this.entries.get(key) ?? this.create(roomId, cardId, facts)
    const gen = ++this.generation
    entry.refreshing = gen
    const current = (): boolean => entry.refreshing === gen && this.entries.get(key) === entry
    const gone = new Set<string>()
    this.goneDuringRefresh.add(gone)
    try {
      const edited = facts.edited || entry.facts.edited
      const close = edited ? await this.findFirstClose(entry, reads, current) : null
      if (close === undefined || !current()) return false
      // A close once seen stays (dec. 7).
      const firstClose = close ?? entry.firstClose ?? null
      const probe: Entry = { ...entry, facts: { ...facts, edited }, paged: [], live: [], firstClose }
      const liveBefore = new Set(entry.live.map((a) => a.eventId))
      let next: string | undefined
      do {
        const page = await reads.fetchPage(roomId, cardId, next)
        if (!current()) return false
        for (const a of page.answers) if (!replaceInPlace(probe.paged, a)) probe.paged.push(a)
        next = page.next
      } while (next !== undefined && !approvalSettled(this.resolve(probe)))

      const complete = next === undefined
      const inPages = new Set(probe.paged.map((a) => a.eventId))
      entry.paged = probe.paged.filter((a) => !gone.has(a.eventId))
      // A live answer older than a complete read and absent from it was deleted meanwhile.
      entry.live = entry.live.filter((a) => !inPages.has(a.eventId) && !(complete && liveBefore.has(a.eventId)))
      for (const a of entry.paged) this.byAnswer.set(a.eventId, key)
      entry.facts = { ...facts, edited: edited || entry.facts.edited }
      if (edited) {
        entry.editSeen = true
        entry.firstClose = firstClose
      }
      // A read that began before this one is dropped; one that began after it (the session's own answer
      // was accepted) runs again over what this one brought.
      const readAgain = entry.loading !== undefined && entry.loading > gen
      entry.loading = undefined
      entry.refreshing = undefined
      entry.next = next
      entry.complete = complete && !readAgain
      entry.loaded = true
      if (readAgain) this.read(entry)
      this.settle(entry)
      return true
    } finally {
      this.goneDuringRefresh.delete(gone)
      if (current()) {
        entry.refreshing = undefined
        if (!entry.loaded && entry.loading === undefined) this.entries.delete(key)
      }
    }
  }

  // ADR-099: the card's state when it was read, never the provisional one. 'reading' while a read that
  // may move it runs. Starts nothing.
  peek(roomId: string, cardId: string): ApprovalState | 'reading' | undefined {
    const entry = this.entries.get(keyOf(roomId, cardId))
    if (!entry?.loaded) return undefined
    if (this.closeKnown(entry)) {
      const state = this.resolve(entry)
      if (entry.complete || approvalSettled(state)) return state
    }
    return entry.loading !== undefined || entry.editsLoading ? 'reading' : undefined
  }

  // A live edit of the card by its author (the caller checked the author, PLANO-AGENTES §8.30). The first
  // close seen fixes the instant; nothing after it moves it. Called before the edit is translated.
  noteEdit(roomId: string, cardId: string, edit: EditFact): void {
    if (!edit.closed) return
    const entry = this.entries.get(keyOf(roomId, cardId))
    if (!entry) return // the card is not on screen; its next translation reads the edits
    entry.liveClose = minOf(entry.liveClose, edit.ts)
  }

  // A live answer (or a late decrypt of one): upsert it into its card.
  noteAnswer(roomId: string, cardId: string, answer: AnswerFact): void {
    const key = keyOf(roomId, cardId)
    this.byAnswer.set(answer.eventId, key)
    const entry = this.entries.get(key)
    if (!entry) return // the card is not on screen; its next translation reads the relations
    if (!replaceInPlace(entry.paged, answer)) upsertLive(entry.live, answer)
    if (this.ready(entry)) this.settle(entry)
  }

  // This session's own answer, accepted by the server (A3-2). It joins as a live answer, then the card's
  // relations are read again: the server's order is the authority, and another person's answer that
  // came first on the server but has not reached this client yet must come out in front of it — two
  // clients answering at nearly the same time agree on who was first only by the page. The instant is
  // provisional until the page brings the server's.
  noteOwnAnswer(roomId: string, cardId: string, answer: AnswerFact): void {
    const key = keyOf(roomId, cardId)
    this.byAnswer.set(answer.eventId, key)
    const entry = this.entries.get(key)
    if (!entry) return // its next translation reads the relations, this answer included
    if (!replaceInPlace(entry.paged, answer)) upsertLive(entry.live, answer)
    entry.complete = false
    this.read(entry)
    // Shown at once by the rule (the page may move it later); the read above settles the rest.
    if (!this.ready(entry)) return
    const shown = JSON.stringify(this.resolve(entry))
    if (shown === entry.shown) return
    entry.shown = shown
    this.ports.changed(entry.roomId, entry.cardId)
  }

  // A deletion. True when the deleted event was an answer this cache knows (so it is no message).
  forgetAnswer(answerId: string): boolean {
    for (const gone of this.goneDuringRefresh) gone.add(answerId)
    const key = this.byAnswer.get(answerId)
    if (key === undefined) return false
    this.byAnswer.delete(answerId)
    const entry = this.entries.get(key)
    if (entry) {
      entry.paged = entry.paged.filter((a) => a.eventId !== answerId)
      entry.live = entry.live.filter((a) => a.eventId !== answerId)
      if (this.ready(entry)) this.settle(entry)
    }
    return true
  }

  isAnswer(eventId: string): boolean {
    return this.byAnswer.has(eventId)
  }

  clear(): void {
    this.entries.clear()
    this.byAnswer.clear()
    this.generation += 1
  }

  private create(roomId: string, cardId: string, facts: ApprovalCardFacts): Entry {
    const entry: Entry = {
      roomId,
      cardId,
      paged: [],
      live: [],
      facts,
      complete: false,
      next: undefined,
      loading: undefined,
      loaded: false,
      firstClose: undefined,
      liveClose: undefined,
      editsLoading: false,
      refreshing: undefined,
      editSeen: false,
      shown: JSON.stringify(fallback(facts)),
    }
    this.entries.set(keyOf(roomId, cardId), entry)
    this.trim()
    return entry
  }

  // The answers are read and, for an edited card, the instant of its first close is known.
  private ready(entry: Entry): boolean {
    return entry.loaded && this.closeKnown(entry)
  }

  // For an edited card, the instant of its first close is known (read, or seen live).
  private closeKnown(entry: Entry): boolean {
    return !entry.facts.edited || entry.firstClose !== undefined || entry.liveClose !== undefined
  }

  // The instant of the close: the card born closed, else the author's first closing edit (read or seen
  // live). An unedited card's close can only be its birth.
  private closeOf(entry: Entry): number | undefined {
    const f = entry.facts
    if (!f.edited) return minOf(f.bornClosedAt, entry.liveClose)
    return minOf(f.bornClosedAt, entry.firstClose, entry.liveClose)
  }

  // A card that declares how many answers it asks for has its own rule; the others resolve on one answer.
  private resolve(entry: Entry): ApprovalState {
    const { options, needed } = entry.facts
    const answers = [...entry.paged, ...entry.live]
    if (needed !== undefined) return resolveMultiApproval(options, answers, this.closeOf(entry), this.ports.accounts(), needed)
    return resolveApproval(options, answers, this.closeOf(entry), this.ports.accounts())
  }

  // After a change: read on when the rule needs more, and re-emit the card when what it shows moved.
  private settle(entry: Entry): void {
    if (!this.ready(entry)) return
    const state = this.resolve(entry)
    if (!approvalSettled(state) && !entry.complete && entry.loading === undefined) {
      this.read(entry)
      return
    }
    const shown = JSON.stringify(state)
    if (shown === entry.shown) {
      this.ports.settled?.(entry.roomId, entry.cardId)
      return
    }
    entry.shown = shown
    this.ports.changed(entry.roomId, entry.cardId)
  }

  // Page forward until the end or until the card is settled (its first answer, or all it asks for).
  private read(entry: Entry): void {
    const gen = ++this.generation
    entry.loading = gen
    const key = keyOf(entry.roomId, entry.cardId)
    const run = async (): Promise<void> => {
      let from = entry.next
      for (;;) {
        const page = await this.ports.fetchPage(entry.roomId, entry.cardId, from)
        if (entry.loading !== gen || this.entries.get(key) !== entry) return
        for (const a of page.answers) {
          // The page is the authority: an answer seen live leaves the live tail for the page's place.
          entry.live = entry.live.filter((l) => l.eventId !== a.eventId)
          if (!replaceInPlace(entry.paged, a)) entry.paged.push(a)
          this.byAnswer.set(a.eventId, key)
        }
        entry.next = page.next
        if (page.next === undefined) {
          entry.complete = true
          break
        }
        from = page.next
        if (this.closeKnown(entry) && approvalSettled(this.resolve(entry))) break
      }
      entry.loading = undefined
      entry.loaded = true
      this.settle(entry)
    }
    this.ports.detach(
      run().catch(() => {
        // A failed read leaves the card as it shows (open/closed); its next translation retries.
        if (entry.loading === gen) entry.loading = undefined
        if (!entry.loaded && entry.refreshing === undefined) this.entries.delete(key)
        this.ports.settled?.(entry.roomId, entry.cardId)
      }),
    )
  }

  // Page the card's edits forward until the author's first closing edit, or the end.
  private readEdits(entry: Entry): void {
    entry.editsLoading = true
    const key = keyOf(entry.roomId, entry.cardId)
    const run = async (): Promise<void> => {
      const found = await this.findFirstClose(entry, this.ports, () => this.entries.get(key) === entry)
      if (found === undefined) return
      entry.firstClose = found ?? entry.firstClose ?? null
      entry.editsLoading = false
      this.settle(entry)
    }
    this.ports.detach(
      run().catch(() => {
        // Unread edits leave the card on its fallback; its next translation retries.
        entry.editsLoading = false
        this.ports.settled?.(entry.roomId, entry.cardId)
      }),
    )
  }

  // The instant of the author's first closing edit; null when there is none; undefined when overtaken.
  private async findFirstClose(entry: Entry, reads: ApprovalReads, current: () => boolean): Promise<number | null | undefined> {
    let from: string | undefined
    do {
      const page = await reads.fetchEditPage(entry.roomId, entry.cardId, from)
      if (!current()) return undefined
      const first = page.edits.find((e) => e.closed && e.sender === entry.facts.author)
      if (first) return first.ts
      from = page.next
    } while (from !== undefined)
    return null
  }

  private trim(): void {
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= APPROVAL_CACHE_CAP) return
      if (!this.ports.held?.(entry.cardId)) this.entries.delete(key)
    }
  }
}

// A known answer is replaced where it stands (a late decrypt, a repeat): true when it was there.
function replaceInPlace(list: AnswerFact[], answer: AnswerFact): boolean {
  const i = list.findIndex((a) => a.eventId === answer.eventId)
  if (i < 0) return false
  list[i] = answer
  return true
}

// The live tail, in order of arrival.
function upsertLive(list: AnswerFact[], answer: AnswerFact): void {
  if (!replaceInPlace(list, answer)) list.push(answer)
}

// An answer event as the rule reads it: author and server instant in clear; the option only when the
// content decrypted.
export function answerFactOf(event: MatrixEvent): AnswerFact | undefined {
  const eventId = event.getId()
  const sender = event.getSender()
  if (!eventId || !sender) return undefined
  const decrypted = !event.isDecryptionFailure() && !(event.isEncrypted() && event.getClearContent() === null)
  const option = decrypted ? responseOption(event.getContent() as Record<string, unknown>) : undefined
  return { eventId, sender, ts: event.getTs(), decrypted, ...(option !== undefined && { option }), ...(event.isRedacted() && { redacted: true }) }
}

// An edit event of a card as the close reads it: the closing mark in its new content. An edit that does
// not decrypt carries no readable mark and never closes.
export function editFactOf(event: MatrixEvent): EditFact | undefined {
  const sender = event.getSender()
  if (!sender || event.isDecryptionFailure() || event.isRedacted()) return undefined
  const newContent = ((event.getContent() as Record<string, unknown>)['m.new_content'] ?? {}) as Record<string, unknown>
  return { sender, ts: event.getTs(), closed: approvalClosed(newContent) }
}

// The card an answer event answers, from the relation in clear (the wire content of an encrypted event
// carries it), or undefined.
export function answeredCardOf(event: MatrixEvent): string | undefined {
  const wire = event.getWireContent() as Record<string, unknown>
  const clear = event.getContent() as Record<string, unknown>
  for (const content of [wire, clear]) {
    const rel = content['m.relates_to'] as { rel_type?: unknown; event_id?: unknown } | undefined
    if (rel?.rel_type === RESPONSE_REL_TYPE && typeof rel.event_id === 'string') return rel.event_id
  }
  return undefined
}

export type RelationsClient = Pick<MatrixClient, 'fetchRelations' | 'getEventMapper' | 'decryptEventIfNeeded'>

// One page of a card's relations of one type, explicitly FORWARD (the server's default is backward) —
// ADR-091 dec. 5 — each event decrypted (or failed) before it is read. Also the panel reader's (A3-5).
// `onMapped` sees each mapped event before its decrypt starts (the panel reader marks its own copies).
export async function relationPage(
  client: RelationsClient,
  roomId: string,
  cardId: string,
  relType: string,
  from: string | undefined,
  onMapped?: (ev: MatrixEvent) => void,
): Promise<{ events: MatrixEvent[]; next?: string }> {
  const res = await client.fetchRelations(roomId, cardId, relType, null, { dir: Direction.Forward, ...(from !== undefined && { from }) })
  const mapper = client.getEventMapper()
  const events = res.chunk.map((raw) => mapper(raw))
  if (onMapped) for (const ev of events) onMapped(ev)
  await Promise.all(events.map((ev) => client.decryptEventIfNeeded(ev).catch(() => undefined)))
  return { events, ...(res.next_batch ? { next: res.next_batch } : {}) }
}

// One page of a card's answers: the relations filtered by the answer's relation type, forward.
export async function fetchAnswerPage(client: RelationsClient, roomId: string, cardId: string, from: string | undefined): Promise<AnswerPage> {
  const { events, next } = await relationPage(client, roomId, cardId, RESPONSE_REL_TYPE, from)
  const answers = events
    .filter((ev) => ev.getType() === 'm.room.message' || ev.isDecryptionFailure())
    .map(answerFactOf)
    .filter((a): a is AnswerFact => a !== undefined)
  return { answers, ...(next !== undefined && { next }) }
}

// One page of a card's edits: the relations filtered by the edit relation type, forward (the same read
// and the same order as the answers).
export async function fetchEditPage(client: RelationsClient, roomId: string, cardId: string, from: string | undefined): Promise<EditPage> {
  const { events, next } = await relationPage(client, roomId, cardId, RelationType.Replace, from)
  const edits = events
    .filter((ev) => ev.getType() === 'm.room.message')
    .map(editFactOf)
    .filter((e): e is EditFact => e !== undefined)
  return { edits, ...(next !== undefined && { next }) }
}

// ADR-091 (Proposto) dec. 14 (A3-2): this session's own answer in flight, per card. The echo of the send
// never becomes a line: it folds into the card as 'sending' or 'failed' — and only while the aggregated
// state is 'open'. Once the card is answered (by anyone, the server's order deciding) or closed, the
// local pending goes: the aggregated state wins. A sent answer stays 'sending' until the aggregator
// resolves the card, so the buttons never come back in between.
export interface PendingAnswer {
  option: string
  status: 'sending' | 'sent' | 'failed'
  // The send under way (a double click or another option while it runs joins it, never a second send).
  work?: Promise<void>
}

// Whether a card, as this session shows it, takes an answer from `selfId` now: open, or its own answer not
// sent; on a card that asks for several answers, not closed, not complete, no answer of `selfId` counted,
// and no answer of its own in flight.
export function takesAnswer(state: ApprovalState, selfId: string | undefined): boolean {
  switch (state.kind) {
    case 'open':
    case 'failed':
      return true
    case 'multi':
      return (
        !state.closed &&
        !approvalSettled(state) &&
        !state.answers.some((a) => (a.by as string) === selfId) &&
        (state.own === undefined || state.own.status === 'failed')
      )
    case 'sending':
    case 'answered':
    case 'closed':
      return false
  }
}

export class PendingAnswers {
  private readonly byCard = new Map<string, PendingAnswer>()

  get(roomId: string, cardId: string): PendingAnswer | undefined {
    return this.byCard.get(keyOf(roomId, cardId))
  }

  set(roomId: string, cardId: string, pending: PendingAnswer): void {
    this.byCard.set(keyOf(roomId, cardId), pending)
  }

  // Replace only when `pending` is still the card's (a clear or a newer attempt wins over a late result).
  update(roomId: string, cardId: string, pending: PendingAnswer, next: Partial<PendingAnswer>): boolean {
    if (this.byCard.get(keyOf(roomId, cardId)) !== pending) return false
    Object.assign(pending, next)
    return true
  }

  // The state the card shows: the aggregated one, with the pending folded in only while the card still
  // takes the viewer's answer. On a card that asks for several answers that is: not closed, not complete,
  // and no answer of `selfId` counted yet; a sent answer not yet aggregated stays 'sending', so the
  // buttons never come back in between.
  overlay(roomId: string, cardId: string, state: ApprovalState, selfId?: string): ApprovalState {
    const key = keyOf(roomId, cardId)
    const pending = this.byCard.get(key)
    if (!pending) return state
    switch (state.kind) {
      case 'open':
        return pending.status === 'failed' ? { kind: 'failed', option: pending.option } : { kind: 'sending', option: pending.option }
      case 'multi':
        if (state.closed || approvalSettled(state) || state.answers.some((a) => (a.by as string) === selfId)) {
          this.byCard.delete(key)
          return state
        }
        return { ...state, own: { status: pending.status === 'failed' ? 'failed' : 'sending', option: pending.option } }
      case 'answered':
      case 'closed':
        this.byCard.delete(key)
        return state
      case 'sending':
      case 'failed':
        // The aggregator never produces these; nothing to fold over.
        return state
    }
  }

  clear(): void {
    this.byCard.clear()
  }
}
