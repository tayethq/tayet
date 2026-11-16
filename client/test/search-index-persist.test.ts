import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '../src/acl'
import { SEARCH_WRITE_FAILED, SearchIndex, normalizeForSearch, type SearchWrites } from '../src/acl/internal/search-index'
import { createMemorySearchStore, type SearchEntry, type SearchStore } from '../src/acl/internal/search-store'

// ADR-074 addendum 2026-10-28 (#240): the index's writes to the device are never swallowed. While one
// is in flight the index says `persisting`; a failed one flips `degraded` for the rest of the session
// and logs one error line (the product lost data). Memory keeps answering either way.

let seq = 0
function entry(text: string): SearchEntry {
  seq += 1
  const eventId = `$p${seq}`
  const snapshot = {
    id: eventId,
    channelId: '!r',
    author: '@a',
    body: { kind: 'text', text },
    sentAt: seq,
    reactions: [],
    mine: false,
    mentionsMe: false,
  } as unknown as Message
  return { eventId, roomId: '!r', sender: '@a', ts: seq, text, norm: normalizeForSearch(text), snapshot }
}

// A memory store whose putEntries/deleteEntries the test settles by hand, one call at a time.
function gatedStore(): { store: SearchStore; settle: (outcome: 'commit' | 'fail') => Promise<void>; pending: () => number } {
  const inner = createMemorySearchStore(`persist-${Math.random()}`)
  const queue: Array<{ resolve: () => void; reject: (e: Error) => void }> = []
  const gate = (): Promise<void> => new Promise((resolve, reject) => queue.push({ resolve, reject }))
  return {
    store: {
      ...inner,
      putEntries: (entries) => gate().then(() => inner.putEntries(entries)),
      deleteEntries: (ids) => gate().then(() => inner.deleteEntries(ids)),
    },
    settle: async (outcome) => {
      const next = queue.shift()!
      if (outcome === 'commit') next.resolve()
      else next.reject(Object.assign(new Error('quota'), { name: 'QuotaExceededError' }))
      // Let the index's then/catch run.
      await new Promise((r) => setTimeout(r, 0))
    },
    pending: () => queue.length,
  }
}

const all = (): boolean => true

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SearchIndex writes (addendum 2026-10-28)', () => {
  it('persisting goes true on upsert and false on commit — one transition each, however many batches', async () => {
    const { store, settle } = gatedStore()
    const heard: SearchWrites[] = []
    const index = new SearchIndex(store, (w) => heard.push(w))
    await index.ready

    index.upsert([entry('um')])
    index.upsert([entry('dois')])
    index.remove('$p1')
    expect(index.writes).toEqual({ persisting: true, degraded: false })
    expect(heard).toEqual([{ persisting: true, degraded: false }])

    await settle('commit')
    await settle('commit')
    expect(heard).toHaveLength(1)
    await settle('commit')
    expect(index.writes).toEqual({ persisting: false, degraded: false })
    expect(heard).toEqual([
      { persisting: true, degraded: false },
      { persisting: false, degraded: false },
    ])
  })

  it('a rejected write publishes degraded, logs one error, and memory still answers', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { store, settle } = gatedStore()
    const heard: SearchWrites[] = []
    const index = new SearchIndex(store, (w) => heard.push(w))
    await index.ready

    index.upsert([entry('alvo perdido')])
    await settle('fail')
    expect(error).toHaveBeenCalledTimes(1)
    expect(error.mock.calls[0]?.[0]).toBe(SEARCH_WRITE_FAILED)
    expect(heard.at(-1)).toEqual({ persisting: false, degraded: true })
    expect(index.writes).toEqual({ persisting: false, degraded: true })
    expect(index.search('alvo', all).map((h) => h.entry.text)).toEqual(['alvo perdido'])

    // The second failure of the session: no new line, degraded stays.
    index.upsert([entry('outro')])
    await settle('fail')
    expect(error).toHaveBeenCalledTimes(1)
    expect(index.writes).toEqual({ persisting: false, degraded: true })
    expect(index.search('outro', all)).toHaveLength(1)
  })

  it('degraded is published while other writes are still in flight', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { store, settle, pending } = gatedStore()
    const heard: SearchWrites[] = []
    const index = new SearchIndex(store, (w) => heard.push(w))
    await index.ready

    index.upsert([entry('a')])
    index.upsert([entry('b')])
    await settle('fail')
    expect(pending()).toBe(1)
    expect(heard.at(-1)).toEqual({ persisting: true, degraded: true })
    await settle('commit')
    expect(heard.at(-1)).toEqual({ persisting: false, degraded: true })
  })
})
