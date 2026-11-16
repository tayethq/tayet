import { describe, expect, it } from 'vitest'
import {
  BACKFILL_PAGES_PER_BOOT,
  runSearchBackfill,
  type BackfillPorts,
  type SearchState,
} from '../src/acl/internal/search-backfill'
import type { SearchCursor } from '../src/acl/internal/search-store'

// ADR-074 dec. 3/4: the backfill policy over fake ports — budget per conversation per boot, order by
// activity, cursor persisted per page and resumed on the next boot, one request at a time, pause under
// the user's activity, rate limit retried, and the search.state transitions.

interface FakeRoom {
  roomId: string
  lastActive: number
  // Pages older than the live window; the live window always exists.
  olderPages: number
}

function harness(rooms: FakeRoom[], cursors = new Map<string, SearchCursor>()) {
  const calls: string[] = []
  const states: SearchState[] = []
  let inFlight = 0
  let maxInFlight = 0
  let busy: number[] = []
  let rateLimitOnce = new Set<string>()
  const slept: number[] = []
  const ports: BackfillPorts = {
    rooms: () => rooms.map(({ roomId, lastActive }) => ({ roomId, lastActive })),
    cursor: (id) => cursors.get(id),
    setCursor: (c) => {
      cursors.set(c.roomId, c)
    },
    liveStart: async (id) => {
      calls.push(`live:${id}`)
      const r = rooms.find((x) => x.roomId === id)!
      return r.olderPages > 0 ? `${id}#0` : undefined
    },
    fetchOlder: async (id, token) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await Promise.resolve()
      inFlight -= 1
      if (rateLimitOnce.has(token)) {
        rateLimitOnce.delete(token)
        throw { rateLimited: 700 }
      }
      calls.push(`page:${token}`)
      const n = Number(token.split('#')[1]) + 1
      const r = rooms.find((x) => x.roomId === id)!
      return { end: n < r.olderPages ? `${id}#${n}` : undefined }
    },
    rateLimitWait: (err) => (err as { rateLimited?: number }).rateLimited,
    busyFor: () => busy.shift() ?? 0,
    sleep: async (ms) => {
      slept.push(ms)
    },
    cancelled: () => false,
    publish: (s) => {
      states.push(s)
    },
  }
  return {
    ports,
    calls,
    states,
    cursors,
    slept,
    maxInFlight: () => maxInFlight,
    setBusy: (b: number[]) => {
      busy = b
    },
    rateLimit: (token: string) => {
      rateLimitOnce = new Set([token])
    },
  }
}

describe('search backfill (ADR-074 dec. 3)', () => {
  it('most active conversation first, one at a time, the live window before the older pages', async () => {
    const h = harness([
      { roomId: 'old', lastActive: 1, olderPages: 1 },
      { roomId: 'new', lastActive: 9, olderPages: 2 },
    ])
    await runSearchBackfill(h.ports)
    expect(h.calls).toEqual(['live:new', 'page:new#0', 'page:new#1', 'live:old', 'page:old#0'])
    expect(h.maxInFlight()).toBe(1)
    expect(h.cursors.get('new')).toEqual({ roomId: 'new', done: true })
  })

  it('at most 10 pages per conversation per boot; the cursor persists and the next boot resumes', async () => {
    const rooms = [{ roomId: 'big', lastActive: 1, olderPages: 25 }]
    const first = harness(rooms)
    await runSearchBackfill(first.ports)
    const pages = first.calls.filter((c) => c.startsWith('page:'))
    expect(pages).toHaveLength(BACKFILL_PAGES_PER_BOOT)
    expect(first.cursors.get('big')).toEqual({ roomId: 'big', token: 'big#10', done: false })
    expect(first.states.at(-1)).toEqual({ preparing: false, partial: true })

    const second = harness(rooms, first.cursors)
    await runSearchBackfill(second.ports)
    expect(second.calls[0]).toBe('page:big#10') // no live restart: from the persisted cursor
    expect(second.calls.filter((c) => c.startsWith('page:'))).toHaveLength(BACKFILL_PAGES_PER_BOOT)

    const third = harness(rooms, second.cursors)
    await runSearchBackfill(third.ports)
    expect(third.calls.filter((c) => c.startsWith('page:'))).toHaveLength(5)
    expect(third.cursors.get('big')?.done).toBe(true)
    expect(third.states.at(-1)).toEqual({ preparing: false, partial: false })
  })

  it('search.state: preparing while budget is left, then off; partial only with a spent budget', async () => {
    const h = harness([
      { roomId: 'a', lastActive: 2, olderPages: 1 },
      { roomId: 'b', lastActive: 1, olderPages: 30 },
    ])
    await runSearchBackfill(h.ports)
    expect(h.states[0]).toEqual({ preparing: true, partial: false })
    expect(h.states.at(-1)).toEqual({ preparing: false, partial: true })
    // A conversation with nothing older than its live window is done at once.
    const empty = harness([{ roomId: 'tiny', lastActive: 1, olderPages: 0 }])
    await runSearchBackfill(empty.ports)
    expect(empty.states).toEqual([
      { preparing: true, partial: false },
      { preparing: false, partial: false },
    ])
    expect(empty.cursors.get('tiny')).toEqual({ roomId: 'tiny', done: true })
  })

  it("waits out the user's activity before a step", async () => {
    const h = harness([{ roomId: 'r', lastActive: 1, olderPages: 1 }])
    h.setBusy([2_000, 600])
    await runSearchBackfill(h.ports)
    expect(h.slept.reduce((a, b) => a + b, 0)).toBe(2_600)
    expect(h.calls).toEqual(['live:r', 'page:r#0'])
  })

  it('a rate limit waits the time asked and retries the same page, without spending budget', async () => {
    const h = harness([{ roomId: 'r', lastActive: 1, olderPages: 2 }])
    h.rateLimit('r#1')
    await runSearchBackfill(h.ports)
    expect(h.slept.reduce((a, b) => a + b, 0)).toBe(700)
    expect(h.calls).toEqual(['live:r', 'page:r#0', 'page:r#1'])
    expect(h.cursors.get('r')?.done).toBe(true)
  })

  it('another failure ends that conversation for this boot and the run moves on', async () => {
    const h = harness([
      { roomId: 'bad', lastActive: 2, olderPages: 3 },
      { roomId: 'ok', lastActive: 1, olderPages: 1 },
    ])
    const fetch = h.ports.fetchOlder
    h.ports.fetchOlder = async (id, token) => {
      if (id === 'bad') throw new Error('boom')
      return fetch(id, token)
    }
    await runSearchBackfill(h.ports)
    expect(h.calls).toEqual(['live:bad', 'live:ok', 'page:ok#0'])
    expect(h.cursors.get('bad')).toEqual({ roomId: 'bad', token: 'bad#0', done: false })
  })

  it('stops when cancelled', async () => {
    const h = harness([{ roomId: 'r', lastActive: 1, olderPages: 30 }])
    let steps = 0
    h.ports.cancelled = () => steps >= 3
    const fetch = h.ports.fetchOlder
    h.ports.fetchOlder = async (id, token) => {
      steps += 1
      return fetch(id, token)
    }
    await runSearchBackfill(h.ports)
    expect(h.calls.filter((c) => c.startsWith('page:')).length).toBeLessThanOrEqual(3)
  })
})
