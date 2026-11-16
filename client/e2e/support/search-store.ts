import type { Page } from '@playwright/test'

// ADR-074 dec. 6 + addendum 2026-10-28 (#240): what the device's search index holds, read straight from
// IndexedDB in the page — the `tayet-search-*` databases of the context's account. A reload proves
// nothing about persistence on its own (the post-reload window brings recent messages back, addendum
// 2026-10-23); the store read does. Only counts and a boolean leave the page: no protocol id.
export interface SearchStoreFacts {
  entries: number
  hit: boolean
  cursors: number
}

export async function searchStoreFacts(page: Page, needle: string): Promise<SearchStoreFacts> {
  return page.evaluate(async (needle) => {
    const facts = { entries: 0, hit: false, cursors: 0 }
    for (const d of (await indexedDB.databases()).filter((x) => x.name?.startsWith('tayet-search-'))) {
      const db: IDBDatabase = await new Promise((resolve, reject) => {
        const q = indexedDB.open(d.name!)
        q.onsuccess = () => resolve(q.result)
        q.onerror = () => reject(q.error)
      })
      const all = (store: string): Promise<unknown[]> =>
        new Promise((resolve, reject) => {
          const q = db.transaction(store, 'readonly').objectStore(store).getAll()
          q.onsuccess = () => resolve(q.result as unknown[])
          q.onerror = () => reject(q.error)
        })
      try {
        const entries = (await all('entries')) as Array<{ text?: string }>
        facts.entries += entries.length
        facts.hit ||= entries.some((e) => e.text?.includes(needle))
        facts.cursors += (await all('cursors')).length
      } finally {
        db.close()
      }
    }
    return facts
  }, needle)
}
