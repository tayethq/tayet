import { describe, it, expect } from 'vitest'
import { EventBus } from '../../src/api/bus'

// The event bus (§0.3.6 adj. 11): <epoch>-<seq>, ring of 1000 / 10 min, resync out of the ring or
// from another epoch.
describe('event bus', () => {
  it('ids are <epoch>-<seq>; replay after an id inside the ring', () => {
    const bus = new EventBus({ epoch: 'e1' })
    const a = bus.publish({ type: 'resync' })
    bus.publish({ type: 'conversation.removed', id: 'C1' })
    bus.publish({ type: 'conversation.removed', id: 'C2' })
    expect(a.id).toBe('e1-1')
    expect(bus.head).toBe('e1-3')
    const r = bus.since('e1-1')
    expect(r.kind === 'events' && r.entries.map((e) => e.id)).toEqual(['e1-2', 'e1-3'])
    expect(bus.since('e1-3')).toEqual({ kind: 'events', entries: [] })
    expect(bus.since(undefined)).toEqual({ kind: 'events', entries: [] })
  })

  it('another epoch, a future seq, or garbage → resync at the head', () => {
    const bus = new EventBus({ epoch: 'e2' })
    bus.publish({ type: 'resync' })
    expect(bus.since('e1-1')).toEqual({ kind: 'resync', head: 'e2-1' })
    expect(bus.since('e2-9')).toEqual({ kind: 'resync', head: 'e2-1' })
    expect(bus.since('nope')).toEqual({ kind: 'resync', head: 'e2-1' })
  })

  it('older than the ring (count) → resync; the edge of the ring still replays', () => {
    const bus = new EventBus({ epoch: 'e', max: 3 })
    for (let i = 0; i < 5; i++) bus.publish({ type: 'conversation.removed', id: `C${i}` })
    // Ring = seq 3, 4, 5. After 2 the next needed is 3 → replays; after 1 the next (2) is gone.
    const r = bus.since('e-2')
    expect(r.kind === 'events' && r.entries.map((e) => e.seq)).toEqual([3, 4, 5])
    expect(bus.since('e-1').kind).toBe('resync')
  })

  it('older than 10 minutes → out of the ring', () => {
    let now = 0
    const bus = new EventBus({ epoch: 'e', now: () => now })
    bus.publish({ type: 'resync' })
    bus.publish({ type: 'resync' })
    now = 10 * 60_000 + 1
    expect(bus.since('e-1').kind).toBe('resync')
  })

  it('subscribers get every publish', () => {
    const bus = new EventBus()
    const got: string[] = []
    const off = bus.subscribe((e) => got.push(e.event.type))
    bus.publish({ type: 'agent.revoked' })
    off()
    bus.publish({ type: 'resync' })
    expect(got).toEqual(['agent.revoked'])
  })
})
