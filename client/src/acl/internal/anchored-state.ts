import { RelationType, type MatrixEvent } from 'matrix-js-sdk'
import { editAppliesTo, isAgentSender } from '@tayet/shared/internal'
import { relationPage, type RelationsClient } from './approval-state'

// ADR-093 (Proposto) (PLANO-AGENTES §0.3.21 item 5): the anchored aggregator — "the latest version per
// member agent, edits by the author only, anchored on the conversation's creation event" — one piece,
// parametrized by the relation type (the page reader), the block reader and the output shape. The pinned
// panel (ADR-091 dec. 12, panel-state.ts) and the `/` commands manifest (ADR-093, command-state.ts) are two
// adapters of it.
//
// The source is the anchor's relations filtered by the adapter's relation type, read forward and paged to
// the end; one cache entry per conversation. What a message shows is the author's latest edit (the server's
// aggregated edit — and, when the server's aggregate is not the author's, the message's own edits read
// forward): an edit by any other account never counts (PLANO-AGENTES §8.30). The original need not decrypt
// — the author's edit that decrypts is enough; nothing that decrypts → the agent shows nothing. Only an
// agent that is a current member of the conversation counts; with more than one message from the same
// agent, the latest write wins; the adapter reads that write's block (a cleared or malformed one shows
// nothing) and shapes and orders the output.
//
// Live, without a read: an author's edit of a message this cache holds is applied in place (applyEdit) — the
// new content and the server instant of the edit; an older edit than the latest write changes nothing; an
// author's edit that does not decrypt takes the agent's content off (never the stale original) until it
// decrypts and is applied the same way; an edit by any other account is ignored whole, and never kept
// (§0.3.19 item 6, closed in A4-1: it is checked against the author before it is stored). An agent joining
// or leaving recomputes from the cache. The anchor is read again only for: the first list of the
// conversation, a new message, the removal of a watched event, and the late decrypt of an original whose
// content the cache does not have (needsRead). `changed` is called only when the output moved. The
// gateway's guards hold: a failed decrypt never reads, the reader's own copies never read, one Decrypted
// counts once.

// One anchored message as the reader needs it: its author (in clear), the content it shows with the server
// instant of that content, the event ids whose removal moves it (the original and the edit read), the
// author's edit it stands on (absent: the original) and the server instant of that latest known write —
// shown or not (an edit that does not decrypt).
export interface AnchoredFact {
  eventId: string
  sender: string
  shown?: { content: Record<string, unknown>; at: number }
  watch: string[]
  editId?: string
  writtenAt?: number
}

// A live edit of an anchored message: its id, author and server instant, and the new content when it
// decrypted.
export interface AnchoredEdit {
  id: string
  sender: string
  at: number
  content?: Record<string, unknown>
}

export interface AnchoredPage {
  facts: AnchoredFact[]
  next?: string
}

// The latest write of one member agent that shows content: what the adapter reads its block from.
export interface LatestWrite {
  sender: string
  content: Record<string, unknown>
  at: number
}

export interface AnchoredPorts<T> {
  // The conversation's creation event (the anchor), or undefined when the room does not hold it.
  anchorOf(roomId: string): string | undefined
  // One page of the anchor's relations of the adapter's type in the server's order, from `from`
  // (undefined = the start).
  fetchPage(roomId: string, anchorId: string, from: string | undefined): Promise<AnchoredPage>
  // Whether the account is a current member (joined) of the conversation.
  isMember(roomId: string, sender: string): boolean
  // The adapter: from the latest write of each member agent, the output — the block read (a cleared or
  // malformed one contributes nothing), shaped and ordered.
  output(roomId: string, latest: LatestWrite[]): T[]
  // The output moved: emit it.
  changed(roomId: string, items: T[]): void
  // Detached work is tracked by the gateway (disconnect waits / drops it).
  detach(work: Promise<unknown>): void
}

interface Entry {
  roomId: string
  facts: AnchoredFact[]
  // The read in flight, and whether something asked for a fresh read while it ran.
  loading: Promise<void> | undefined
  dirty: boolean
  loaded: boolean
  // What was last handed out (list or changed), to emit only when the output moves.
  shown: string | undefined
  // The author's live edits applied in place, per message: re-applied over each read (a read in flight may
  // predate them). Keyed by message and author, so an edit whose message the cache does not hold yet cannot
  // displace the author's.
  live: Map<string, AnchoredEdit>
}

// Conversations kept in the cache; past this the oldest goes (its next list reads it again).
export const ANCHORED_CACHE_CAP = 100
const DECRYPTS_SEEN_CAP = 5_000

const liveKey = (messageId: string, sender: string): string => `${messageId}\u0000${sender}`

export class AnchoredAggregator<T> {
  private readonly entries = new Map<string, Entry>()
  // Watched event id → its conversation (a removal names only the event).
  private readonly byEvent = new Map<string, string>()
  // Events whose decrypt already moved the output: the SDK reports the same decrypt again (it retries the
  // events of a session whenever one of them decrypts — the reader's copies included), and a decrypt that
  // was read once changes nothing the second time. Bounded; the oldest go first.
  private readonly decryptsSeen = new Set<string>()
  private generation = 0

  // `unavailable` is the message of the rejection when the first read of a conversation fails.
  constructor(
    private readonly ports: AnchoredPorts<T>,
    private readonly unavailable: string,
  ) {}

  // The conversation's output. The first call reads it; later calls answer from the cache (and wait for a
  // read in flight).
  async list(roomId: string): Promise<T[]> {
    let entry = this.entries.get(roomId)
    if (!entry) {
      entry = { roomId, facts: [], loading: undefined, dirty: false, loaded: false, shown: undefined, live: new Map() }
      this.entries.set(roomId, entry)
      this.trim()
      this.reload(entry)
    } else {
      // LRU touch.
      this.entries.delete(roomId)
      this.entries.set(roomId, entry)
    }
    while (entry.loading) await entry.loading
    if (!entry.loaded) {
      // The read failed: the next call reads again.
      if (this.entries.get(roomId) === entry) this.entries.delete(roomId)
      throw new Error(this.unavailable)
    }
    const items = this.compute(entry)
    entry.shown = JSON.stringify(items)
    return items
  }

  // A new message arrived, a watched event was removed, or an original without content decrypted: read the
  // conversation again.
  invalidate(roomId: string): void {
    const entry = this.entries.get(roomId)
    if (!entry) return // nobody asked for this conversation yet
    this.reload(entry)
  }

  // Membership or a name moved in the conversation: recompute from the cache.
  recompute(roomId: string): void {
    const entry = this.entries.get(roomId)
    if (!entry || !entry.loaded || entry.loading) return
    this.settle(entry)
  }

  // Whether a late decrypt or a removal of this event moves a conversation's output.
  watches(eventId: string): string | undefined {
    return this.byEvent.get(eventId)
  }

  // Whether this message makes the conversation worth a read: the cache asked for the conversation and
  // either does not hold the message (a new one) or holds it with no content and no edit (an original that
  // did not decrypt). `known` = only a message the cache holds (the reader's own copies).
  needsRead(roomId: string, messageId: string, known: boolean): boolean {
    const entry = this.entries.get(roomId)
    if (!entry) return false
    const fact = entry.facts.find((f) => f.eventId === messageId)
    if (!fact) return !known
    return fact.shown === undefined && fact.editId === undefined
  }

  // A live edit of a message, applied in place — no read. Only the author's (editAppliesTo), checked BEFORE
  // the edit is kept when the cache holds the message; an edit older than the latest known write changes
  // nothing; without content (it did not decrypt) the agent shows nothing until the same edit decrypts and
  // comes here again.
  applyEdit(roomId: string, messageId: string, edit: AnchoredEdit): void {
    const entry = this.entries.get(roomId)
    if (!entry) return
    const fact = entry.facts.find((f) => f.eventId === messageId)
    if (fact && !editAppliesTo(edit.sender, fact.sender)) return
    const key = liveKey(messageId, edit.sender)
    const prev = entry.live.get(key)
    if (!prev || edit.at >= prev.at) entry.live.set(key, edit)
    if (this.applyTo(entry, messageId, edit) && entry.loaded && !entry.loading) this.settle(entry)
  }

  // The first report of this event's successful decrypt: true once, false for every repeat.
  firstDecrypt(eventId: string): boolean {
    if (this.decryptsSeen.has(eventId)) return false
    this.decryptsSeen.add(eventId)
    if (this.decryptsSeen.size > DECRYPTS_SEEN_CAP) {
      const oldest = this.decryptsSeen.values().next().value
      if (oldest !== undefined) this.decryptsSeen.delete(oldest)
    }
    return true
  }

  clear(): void {
    this.entries.clear()
    this.byEvent.clear()
    this.decryptsSeen.clear()
    this.generation += 1
  }

  private reload(entry: Entry): void {
    if (entry.loading) {
      entry.dirty = true
      return
    }
    const gen = this.generation
    const run = async (): Promise<void> => {
      do {
        entry.dirty = false
        const anchor = this.ports.anchorOf(entry.roomId)
        const facts: AnchoredFact[] = []
        let from: string | undefined
        if (anchor !== undefined) {
          for (;;) {
            const page = await this.ports.fetchPage(entry.roomId, anchor, from)
            if (gen !== this.generation) return
            facts.push(...page.facts)
            if (page.next === undefined) break
            from = page.next
          }
        }
        if (gen !== this.generation || this.entries.get(entry.roomId) !== entry) return
        for (const f of facts) for (const id of f.watch) this.byEvent.set(id, entry.roomId)
        entry.facts = facts
        // The live edits over the read (one the read already has changes nothing; one that is not the
        // author's is refused by applyTo).
        for (const [key, edit] of entry.live) this.applyTo(entry, key.slice(0, key.indexOf('\u0000')), edit)
        entry.loaded = true
      } while (entry.dirty)
    }
    const work = run()
      .catch(() => {
        // A failed read keeps what the conversation showed; a first read that fails leaves it unloaded.
      })
      .finally(() => {
        entry.loading = undefined
        if (entry.loaded && entry.shown !== undefined) this.settle(entry)
      })
    entry.loading = work
    this.ports.detach(work)
  }

  // Apply one edit to the fact it targets. True when the fact changed.
  private applyTo(entry: Entry, messageId: string, edit: AnchoredEdit): boolean {
    const fact = entry.facts.find((f) => f.eventId === messageId)
    if (!fact || !editAppliesTo(edit.sender, fact.sender)) return false
    const latest = fact.writtenAt ?? fact.shown?.at
    if (latest !== undefined && edit.at < latest) return false
    if (!fact.watch.includes(edit.id)) fact.watch.push(edit.id)
    this.byEvent.set(edit.id, entry.roomId)
    const shown = edit.content ? { content: edit.content, at: edit.at } : undefined
    const same = fact.editId === edit.id && fact.writtenAt === edit.at && JSON.stringify(fact.shown) === JSON.stringify(shown)
    fact.editId = edit.id
    fact.writtenAt = edit.at
    fact.shown = shown
    return !same
  }

  // Emit the output when it moved since it was last handed out.
  private settle(entry: Entry): void {
    if (entry.shown === undefined) return
    const items = this.compute(entry)
    const shown = JSON.stringify(items)
    if (shown === entry.shown) return
    entry.shown = shown
    this.ports.changed(entry.roomId, items)
  }

  private compute(entry: Entry): T[] {
    // The latest write per agent among the messages that show something.
    const latest = new Map<string, LatestWrite>()
    for (const f of entry.facts) {
      if (!f.shown || !isAgentSender(f.sender) || !this.ports.isMember(entry.roomId, f.sender)) continue
      const prev = latest.get(f.sender)
      if (!prev || f.shown.at >= prev.at) latest.set(f.sender, { sender: f.sender, content: f.shown.content, at: f.shown.at })
    }
    return this.ports.output(entry.roomId, [...latest.values()])
  }

  private trim(): void {
    while (this.entries.size > ANCHORED_CACHE_CAP) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) return
      this.entries.delete(oldest)
    }
  }
}

const decrypted = (ev: MatrixEvent): boolean => !ev.isDecryptionFailure() && !(ev.isEncrypted() && ev.getClearContent() === null)

// The copies the anchored readers map from the server's answers. The SDK reports their decrypts like any
// event's; the gateway tells them apart so a read never triggers another read.
const readerCopies = new WeakSet<MatrixEvent>()
export const isReaderCopy = (ev: MatrixEvent): boolean => readerCopies.has(ev)
const markCopy = (ev: MatrixEvent): void => void readerCopies.add(ev)

// One page of the anchor's relations of `relType`, forward, each message resolved to the content it shows:
// the server's aggregated edit when it is the author's and decrypts; when the aggregate is someone else's,
// the message's own edits read forward (the author's latest that decrypts); else the original when it
// decrypts. An author's edit that exists and does not decrypt shows nothing (never the stale original).
export async function fetchAnchoredPage(
  client: RelationsClient,
  roomId: string,
  anchorId: string,
  relType: string,
  from: string | undefined,
): Promise<AnchoredPage> {
  const { events, next } = await relationPage(client, roomId, anchorId, relType, from, markCopy)
  const mapper = client.getEventMapper()
  const facts: AnchoredFact[] = []
  for (const ev of events) {
    const eventId = ev.getId()
    const sender = ev.getSender()
    if (!eventId || !sender || ev.isRedacted() || !isAgentSender(sender)) continue
    const watch = [eventId]
    let edit: MatrixEvent | undefined
    const bundled = ev.getServerAggregatedRelation<Record<string, unknown>>(RelationType.Replace)
    if (bundled) {
      const b = mapper(bundled as never)
      readerCopies.add(b)
      await client.decryptEventIfNeeded(b).catch(() => undefined)
      if (editAppliesTo(b.getSender(), sender)) edit = b
      else edit = await latestAuthorEdit(client, roomId, eventId, sender)
    }
    let shown: AnchoredFact['shown']
    const editId = edit?.getId() ?? undefined
    if (edit) {
      if (editId) watch.push(editId)
      if (decrypted(edit) && !edit.isRedacted()) {
        const newContent = (edit.getContent() as Record<string, unknown>)['m.new_content']
        if (typeof newContent === 'object' && newContent !== null) shown = { content: newContent as Record<string, unknown>, at: edit.getTs() }
      }
    } else if (decrypted(ev)) {
      shown = { content: ev.getOriginalContent() as Record<string, unknown>, at: ev.getTs() }
    }
    const writtenAt = edit ? edit.getTs() : ev.getTs()
    facts.push({ eventId, sender, ...(shown && { shown }), watch, ...(editId !== undefined && { editId }), writtenAt })
  }
  return { facts, ...(next !== undefined && { next }) }
}

// The message's edits read forward to the end: the author's latest (by server instant). Used only when the
// server's aggregated edit is not the author's.
async function latestAuthorEdit(client: RelationsClient, roomId: string, messageId: string, author: string): Promise<MatrixEvent | undefined> {
  let from: string | undefined
  let latest: MatrixEvent | undefined
  for (;;) {
    const page = await relationPage(client, roomId, messageId, RelationType.Replace, from, markCopy)
    for (const e of page.events) {
      if (!editAppliesTo(e.getSender(), author) || e.isRedacted()) continue
      if (!latest || e.getTs() >= latest.getTs()) latest = e
    }
    if (page.next === undefined) return latest
    from = page.next
  }
}
