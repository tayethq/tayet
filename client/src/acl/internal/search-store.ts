import type { Message } from '@tayet/shared'
import { accountHash } from './pending-recognitions'

// ADR-074 dec. 6/7: where the local search index lives between boots. Two implementations behind one
// interface — IndexedDB in the browser, memory where there is no `indexedDB` (Node/vitest, a browser
// without it; the same guard as the crypto store in matrix-client.ts). No dependency. Everything here
// is ACL-internal: raw ids are stored on purpose (the index re-mints session ids on read, dec. 1) and
// never cross the barrel. The database name carries no raw account id (a short hash of it, the
// pending-recognitions idiom).

// The internal descriptor of an attachment (ADR-009 registry shape). A MediaRef is valid only in the
// session that minted it, so the index keeps what re-mints one.
export interface StoredMedia {
  mxc: string
  encrypted?: unknown
  mimetype?: string
}

export interface SearchEntry {
  eventId: string
  roomId: string
  sender: string
  ts: number
  text: string
  norm: string
  threadRoot?: string
  // The translated Message, with raw ids in place of session ids and the media token blanked; the
  // index re-mints both on read.
  snapshot: Message
  media?: StoredMedia
}

// Per room: where the backward backfill stopped. `token` undefined + !done = not started yet (the
// first step starts from the live timeline). done = the start of the room was reached.
export interface SearchCursor {
  roomId: string
  token?: string
  done: boolean
}

export interface SearchStore {
  load(): Promise<{ entries: SearchEntry[]; cursors: SearchCursor[] }>
  putEntries(entries: SearchEntry[]): Promise<void>
  deleteEntries(eventIds: string[]): Promise<void>
  putCursor(cursor: SearchCursor): Promise<void>
  close(): void
}

const DB_PREFIX = 'tayet-search-'
const ENTRIES = 'entries'
const CURSORS = 'cursors'

export const searchDbName = (account: string): string => DB_PREFIX + accountHash(account)

// ── Memory ─────────────────────────────────────────────────────────────────────────────────
// Keyed by database name at module level, so a second gateway of the same account in the same process
// sees what the first wrote — the same "survives the instance" contract as the IndexedDB one, which is
// what the integration tests exercise in Node.
const memoryDbs = new Map<string, { entries: Map<string, SearchEntry>; cursors: Map<string, SearchCursor> }>()

export function memorySearchDbNames(): string[] {
  return [...memoryDbs.keys()]
}

export function createMemorySearchStore(name: string): SearchStore {
  const db = (): { entries: Map<string, SearchEntry>; cursors: Map<string, SearchCursor> } => {
    let d = memoryDbs.get(name)
    if (!d) {
      d = { entries: new Map(), cursors: new Map() }
      memoryDbs.set(name, d)
    }
    return d
  }
  return {
    load: async () => {
      const d = memoryDbs.get(name)
      return { entries: d ? [...d.entries.values()] : [], cursors: d ? [...d.cursors.values()] : [] }
    },
    putEntries: async (entries) => {
      const d = db()
      for (const e of entries) d.entries.set(e.eventId, e)
    },
    deleteEntries: async (ids) => {
      const d = memoryDbs.get(name)
      if (d) for (const id of ids) d.entries.delete(id)
    },
    putCursor: async (cursor) => {
      db().cursors.set(cursor.roomId, cursor)
    },
    close: () => {},
  }
}

// ── IndexedDB ──────────────────────────────────────────────────────────────────────────────
const done = (req: IDBRequest): Promise<unknown> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('indexeddb request failed'))
  })

const committed = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('indexeddb transaction failed'))
    tx.onabort = () => reject(tx.error ?? new Error('indexeddb transaction aborted'))
  })

export function createIndexedDbSearchStore(name: string, idb: IDBFactory = indexedDB): SearchStore {
  let closed = false
  const opening: Promise<IDBDatabase> = new Promise((resolve, reject) => {
    const req = idb.open(name, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(ENTRIES)) db.createObjectStore(ENTRIES, { keyPath: 'eventId' })
      if (!db.objectStoreNames.contains(CURSORS)) db.createObjectStore(CURSORS, { keyPath: 'roomId' })
    }
    req.onsuccess = () => {
      const db = req.result
      // A wipe from elsewhere (another tab's sign-out) must not be blocked by this connection.
      db.onversionchange = () => db.close()
      if (closed) db.close()
      resolve(db)
    }
    req.onerror = () => reject(req.error ?? new Error('indexeddb open failed'))
  })
  // A failed open degrades to an index that lives only in memory for this session.
  opening.catch(() => {})

  const write = async (store: string, fn: (s: IDBObjectStore) => void): Promise<void> => {
    if (closed) return
    const db = await opening
    const tx = db.transaction(store, 'readwrite')
    fn(tx.objectStore(store))
    await committed(tx)
  }

  return {
    load: async () => {
      const db = await opening
      const tx = db.transaction([ENTRIES, CURSORS], 'readonly')
      const [entries, cursors] = await Promise.all([
        done(tx.objectStore(ENTRIES).getAll()),
        done(tx.objectStore(CURSORS).getAll()),
      ])
      return { entries: entries as SearchEntry[], cursors: cursors as SearchCursor[] }
    },
    putEntries: (entries) => write(ENTRIES, (s) => entries.forEach((e) => s.put(e))),
    deleteEntries: (ids) => write(ENTRIES, (s) => ids.forEach((id) => s.delete(id))),
    putCursor: (cursor) => write(CURSORS, (s) => s.put(cursor)),
    close: () => {
      closed = true
      opening.then((db) => db.close()).catch(() => {})
    },
  }
}

export function openSearchStore(account: string): SearchStore {
  const name = searchDbName(account)
  return typeof indexedDB === 'undefined' ? createMemorySearchStore(name) : createIndexedDbSearchStore(name)
}

// ADR-074 dec. 7: every account's index goes with the session's local state (one session per browser,
// session-store.ts — the clearAllPendingRecognitions rule). Whole databases, by deleteDatabase. A
// browser without indexedDB.databases() only loses the account it is told about.
export async function wipeSearchIndexes(account?: string): Promise<void> {
  for (const name of [...memoryDbs.keys()]) if (name.startsWith(DB_PREFIX)) memoryDbs.delete(name)
  if (typeof indexedDB === 'undefined') return
  const names = new Set<string>()
  if (account) names.add(searchDbName(account))
  if (typeof indexedDB.databases === 'function') {
    for (const info of await indexedDB.databases()) {
      if (info.name?.startsWith(DB_PREFIX)) names.add(info.name)
    }
  }
  await Promise.all([...names].map((name) => done(indexedDB.deleteDatabase(name))))
}
