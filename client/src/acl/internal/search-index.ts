import type { MessageBody } from '@tayet/shared'
import type { SearchCursor, SearchEntry, SearchStore } from './search-store'

// ADR-074: the local message-search index. Lives in the ACL because it keys on raw ids (event, room,
// sender, thread root) to dedupe, delete and resume the backfill across boots — none of which crosses
// the barrel (dec. 1). The gateway feeds it (dec. 2), runs the backfill (search-backfill.ts, dec. 3) and
// re-mints session ids on read (dec. 5). This module is pure: no SDK, no network.

// Dec. 5: a shorter query returns nothing.
export const SEARCH_MIN_QUERY = 2
// Characters of context on each side of the match in an excerpt (the UI clamps to 2 lines, §8 item 5).
export const EXCERPT_CONTEXT = 40
// Reevaluation trigger (ADR-074): past this many entries the whole-index load and the linear scan are
// reopened. Only reported, never enforced.
export const SEARCH_SCALE_TRIGGER = 50_000

export interface SearchExcerpt {
  before: string
  match: string
  after: string
}

// Dec. 2: what of a body is searchable. Text → its plain text (rich content always carries it, ADR-012);
// an attachment → its file name (an image's name is its `alt`, the protocol body); an approval card → the
// text of its request (ADR-091; its answers never reach the index); the rest → nothing.
export function searchableText(body: MessageBody): string | undefined {
  switch (body.kind) {
    case 'text':
      return body.text
    case 'approval':
      return body.text
    case 'file':
      return body.name
    case 'image':
      return body.alt
    case 'unsupported':
    case 'unavailable':
      return undefined
  }
}

// Dec. 5: case- and accent-insensitive — NFD with the combining marks removed, lowercased. Folded one
// code point at a time so every folded character maps back to its source (the excerpt needs that).
const MARKS = /\p{M}/gu
const fold = (ch: string): string =>
  ch.normalize('NFD').replace(MARKS, '').toLowerCase().normalize('NFD').replace(MARKS, '')

function foldWithMap(text: string): { norm: string; start: number[]; end: number[] } {
  let norm = ''
  const start: number[] = []
  const end: number[] = []
  let i = 0
  for (const ch of text) {
    const f = fold(ch)
    // A character that folds to nothing (a combining mark) belongs to the one before it.
    if (f.length === 0 && end.length > 0) end[end.length - 1] = i + ch.length
    for (let k = 0; k < f.length; k++) {
      start.push(i)
      end.push(i + ch.length)
    }
    norm += f
    i += ch.length
  }
  return { norm, start, end }
}

export function normalizeForSearch(text: string): string {
  return foldWithMap(text).norm
}

// Terms of a query, folded, split on whitespace; [] when the query is under the minimum.
export function queryTerms(query: string): string[] {
  if (query.trim().length < SEARCH_MIN_QUERY) return []
  return normalizeForSearch(query)
    .split(/\s+/)
    .filter((t) => t.length > 0)
}

export function matchesAll(norm: string, terms: string[]): boolean {
  return terms.length > 0 && terms.every((t) => norm.includes(t))
}

// The earliest occurrence of any term, cut out of the ORIGINAL text with context on both sides.
export function excerptOf(text: string, terms: string[]): SearchExcerpt {
  const { norm, start, end } = foldWithMap(text)
  let at = -1
  let len = 0
  for (const t of terms) {
    const i = norm.indexOf(t)
    if (i >= 0 && (at < 0 || i < at)) {
      at = i
      len = t.length
    }
  }
  const squash = (s: string): string => s.replace(/\s+/g, ' ')
  if (at < 0) return { before: '', match: '', after: squash(text.slice(0, EXCERPT_CONTEXT * 2)) }
  const from = start[at]!
  const to = end[at + len - 1]!
  return {
    before: squash(text.slice(Math.max(0, from - EXCERPT_CONTEXT), from)),
    match: text.slice(from, to),
    after: squash(text.slice(to, to + EXCERPT_CONTEXT)),
  }
}

// ADR-074 addendum 2026-10-28 (#240): how honest the persisted index is. `persisting` = some write of
// the index (upsert/remove) has not committed yet; `degraded` = a write failed in this session (the
// stored index misses what memory has) and stays true until the session ends.
export interface SearchWrites {
  persisting: boolean
  degraded: boolean
}

export const SEARCH_WRITE_FAILED = '[acl] search index write failed'

export class SearchIndex {
  private readonly entries = new Map<string, SearchEntry>()
  private readonly cursors = new Map<string, SearchCursor>()
  // Removals seen before the stored index finished loading: the load must not bring them back.
  private readonly removedBeforeLoad = new Set<string>()
  private loaded = false
  private inFlight = 0
  private degraded = false
  // Resolves once the stored index is in memory (a failed load resolves too: the index then starts
  // empty for this session). Writes before it are kept — what the session saw is newer than the store.
  readonly ready: Promise<void>

  // `onWrites` hears only the transitions of SearchWrites: one batch or thirty-five in a burst give a
  // single false→true→false.
  constructor(
    private readonly store: SearchStore,
    private readonly onWrites: (writes: SearchWrites) => void = () => {},
  ) {
    this.ready = this.load()
  }

  get writes(): SearchWrites {
    return { persisting: this.inFlight > 0, degraded: this.degraded }
  }

  // A failed write is handled, never swallowed: the product lost data, so the first failure of the
  // session is an error line and flips `degraded`; later ones change nothing observable.
  private track(write: Promise<void>): void {
    this.inFlight += 1
    if (this.inFlight === 1) this.onWrites(this.writes)
    write.then(
      () => this.settle(false),
      (err: unknown) => {
        const first = !this.degraded
        if (first) {
          this.degraded = true
          console.error(SEARCH_WRITE_FAILED, (err as Error)?.name)
        }
        this.settle(first)
      },
    )
  }

  private settle(flipped: boolean): void {
    this.inFlight -= 1
    if (this.inFlight === 0 || flipped) this.onWrites(this.writes)
  }

  private async load(): Promise<void> {
    try {
      const { entries, cursors } = await this.store.load()
      for (const e of entries) {
        if (!this.entries.has(e.eventId) && !this.removedBeforeLoad.has(e.eventId)) this.entries.set(e.eventId, e)
      }
      for (const c of cursors) if (!this.cursors.has(c.roomId)) this.cursors.set(c.roomId, c)
    } catch {
      // best-effort: a store that will not open leaves an index that lives only in this session
    }
    this.loaded = true
    this.removedBeforeLoad.clear()
    if (this.entries.size >= SEARCH_SCALE_TRIGGER) console.warn('[acl] search index reached its scale trigger')
  }

  get size(): number {
    return this.entries.size
  }

  get(eventId: string): SearchEntry | undefined {
    return this.entries.get(eventId)
  }

  // ADR-099: the approval cards the index holds. Only candidates: their snapshot's state is stale.
  approvals(): SearchEntry[] {
    return [...this.entries.values()].filter((e) => e.snapshot.body.kind === 'approval')
  }

  // Idempotent by event id (dec. 2): re-indexing replaces.
  upsert(entries: SearchEntry[]): void {
    if (entries.length === 0) return
    for (const e of entries) this.entries.set(e.eventId, e)
    this.track(this.store.putEntries(entries))
  }

  remove(eventId: string): void {
    if (!this.loaded) this.removedBeforeLoad.add(eventId)
    if (!this.entries.delete(eventId) && this.loaded) return
    this.track(this.store.deleteEntries([eventId]))
  }

  cursor(roomId: string): SearchCursor | undefined {
    return this.cursors.get(roomId)
  }

  setCursor(cursor: SearchCursor): void {
    this.cursors.set(cursor.roomId, cursor)
    this.store.putCursor(cursor).catch(() => {})
  }

  // Dec. 5: AND of folded substrings, newest first. `include` narrows by room (the caller passes the
  // rooms the session can show). In-memory scan.
  search(query: string, include: (roomId: string) => boolean): Array<{ entry: SearchEntry; excerpt: SearchExcerpt }> {
    const terms = queryTerms(query)
    if (terms.length === 0) return []
    const hits: SearchEntry[] = []
    for (const e of this.entries.values()) if (include(e.roomId) && matchesAll(e.norm, terms)) hits.push(e)
    hits.sort((a, b) => b.ts - a.ts)
    return hits.map((entry) => ({ entry, excerpt: excerptOf(entry.text, terms) }))
  }

  close(): void {
    this.store.close()
  }
}
