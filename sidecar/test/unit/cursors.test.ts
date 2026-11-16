import { describe, it, expect } from 'vitest'
import { CursorStore } from '../../src/core/cursors'

describe('cursor store (§0.3.6 adj. 7)', () => {
  it('opaque cur_ ids; repeatable; a copy, not the stored state', () => {
    const store = new CursorStore<{ n: number; list: number[] }>()
    const id = store.put({ n: 1, list: [1] })
    expect(id).toMatch(/^cur_[A-Za-z0-9_-]{22}$/)
    const a = store.take(id)
    a?.list.push(2)
    expect(store.take(id)).toEqual({ n: 1, list: [1] })
  })

  it('expires after the TTL; unknown → undefined', () => {
    let now = 0
    const store = new CursorStore<number>({ now: () => now, ttlMs: 1000 })
    const id = store.put(7)
    now = 999
    expect(store.take(id)).toBe(7)
    now = 1001
    expect(store.take(id)).toBeUndefined()
    expect(store.take('cur_nope')).toBeUndefined()
  })

  it('LRU bound', () => {
    const store = new CursorStore<number>({ max: 2 })
    const a = store.put(1)
    store.put(2)
    store.put(3)
    expect(store.size).toBe(2)
    expect(store.take(a)).toBeUndefined()
  })
})
