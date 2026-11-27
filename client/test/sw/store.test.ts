import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clickTargetOf,
  PENDING_MAX_AGE_MS,
  saveWorkerLocale,
  savePendingTarget,
  takePendingTarget,
  workerLocale,
} from '../../src/sw/store'

// ADR-117 dec. 4 and 5 (PR 5a of the push track): the page and the worker share the language and the pending click
// target in one Cache API cache. A Map-backed fake of the Cache API stands in (node has none).

class FakeCache {
  readonly entries = new Map<string, string>()
  async put(key: string, res: Response): Promise<void> {
    this.entries.set(key, await res.text())
  }
  async match(key: string): Promise<Response | undefined> {
    const v = this.entries.get(key)
    return v === undefined ? undefined : new Response(v)
  }
  async delete(key: string): Promise<boolean> {
    return this.entries.delete(key)
  }
}

let cache: FakeCache
const opened: string[] = []
beforeEach(() => {
  cache = new FakeCache()
  opened.length = 0
  ;(globalThis as { caches?: unknown }).caches = {
    open: async (name: string) => {
      opened.push(name)
      return cache
    },
  }
})
afterEach(() => {
  delete (globalThis as { caches?: unknown }).caches
})

describe('the language', () => {
  it('written by the page, read by the worker, in one cache', async () => {
    expect(await workerLocale()).toBeUndefined()
    await saveWorkerLocale('en')
    expect(await workerLocale()).toBe('en')
    expect(new Set(opened)).toEqual(new Set(['tayet-sw']))
  })

  it('without the Cache API: nothing written, nothing read, nothing thrown', async () => {
    delete (globalThis as { caches?: unknown }).caches
    await saveWorkerLocale('en')
    expect(await workerLocale()).toBeUndefined()
  })
})

describe('the pending target', () => {
  const target = { conversation: '!c:x', message: '$m', thread: '$t' }

  it('read once', async () => {
    await savePendingTarget(target, 1_000)
    expect(await takePendingTarget(2_000)).toEqual(target)
    expect(await takePendingTarget(2_000)).toBeUndefined()
  })

  it('valid for 5 minutes, then ignored (and still deleted)', async () => {
    await savePendingTarget(target, 0)
    expect(await takePendingTarget(PENDING_MAX_AGE_MS)).toEqual(target)
    await savePendingTarget(target, 0)
    expect(await takePendingTarget(PENDING_MAX_AGE_MS + 1)).toBeUndefined()
    expect(cache.entries.size).toBe(0)
    expect(PENDING_MAX_AGE_MS).toBe(300_000)
  })

  it('from the future, or not of the shape: ignored', async () => {
    await savePendingTarget(target, 5_000)
    expect(await takePendingTarget(1_000)).toBeUndefined()
    await cache.put('/__tayet-sw/pending', new Response(JSON.stringify({ target: { conversation: 3 }, at: 0 })))
    expect(await takePendingTarget(1)).toBeUndefined()
    await cache.put('/__tayet-sw/pending', new Response('not json'))
    expect(await takePendingTarget(1)).toBeUndefined()
  })
})

describe('clickTargetOf', () => {
  it('the shape', () => {
    expect(clickTargetOf({ conversation: 'c' })).toEqual({ conversation: 'c' })
    expect(clickTargetOf({ conversation: 'c', message: 'm', thread: 't', extra: 1 })).toEqual({ conversation: 'c', message: 'm', thread: 't' })
    for (const bad of [null, 'c', {}, { conversation: '' }, { conversation: 'c'.repeat(256) }, { conversation: 'c', message: 2 }, { conversation: 'c', thread: '' }]) {
      expect(clickTargetOf(bad)).toBeUndefined()
    }
  })
})
