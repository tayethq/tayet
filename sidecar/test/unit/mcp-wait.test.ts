import { describe, it, expect, afterEach, vi } from 'vitest'
import { EventBus } from '../../src/api/bus'
import { createWaits, type SetTimer } from '../../src/api/mcp/wait'
import { ALICE, GENERAL, message } from '../support/slack-world'
import { callTool, startMcp, type McpHarness } from '../support/mcp-world'

// wait_for_mention (S-g1, PLANO-AGENTES §0.3.13 item 6): a long-poll on the bus — `since` then
// `subscribe` — with an injectable clock.

interface Timer {
  ms: number
  fire: () => void
  cancelled: boolean
}
function fakeClock(): { timers: Timer[]; setTimer: SetTimer } {
  const timers: Timer[] = []
  return {
    timers,
    setTimer: (fn, ms) => {
      const t: Timer = { ms, fire: fn, cancelled: false }
      timers.push(t)
      return () => {
        t.cancelled = true
      }
    },
  }
}

const mention = (id: string, text = 'oi agente') => ({ type: 'mention' as const, conversation: GENERAL.id, message: message({ id, author: ALICE.id, text, mentionsMe: true }) })
const received = (id: string) => ({ type: 'message.received' as const, conversation: GENERAL.id, message: message({ id }) })

describe('the wait (bus only)', () => {
  it('a mention already after the cursor answers at once, with its own id as the cursor', async () => {
    const bus = new EventBus({ epoch: 'e1' })
    const waits = createWaits(bus, fakeClock().setTimer)
    const start = bus.head
    bus.publish(received('1.000000'))
    const m = bus.publish(mention('2.000000'))
    bus.publish(mention('3.000000'))
    expect(await waits.wait(start, 1000)).toMatchObject({ kind: 'mention', cursor: m.id, message: { id: '2.000000' } })
    // From that cursor, the next one.
    expect(await waits.wait(m.id, 1000)).toMatchObject({ kind: 'mention', message: { id: '3.000000' } })
  })

  it('no mention yet → subscribes; the first mention resolves and the subscription ends', async () => {
    const bus = new EventBus({ epoch: 'e1' })
    const clock = fakeClock()
    const waits = createWaits(bus, clock.setTimer)
    const p = waits.wait(undefined, 25_000)
    bus.publish(received('1.000000'))
    const m = bus.publish(mention('2.000000'))
    expect(await p).toMatchObject({ kind: 'mention', cursor: m.id })
    expect(clock.timers[0]?.cancelled).toBe(true)
    // Unsubscribed: a later publish reaches no listener of the ended wait.
    expect((bus as unknown as { listeners: Set<unknown> }).listeners.size).toBe(0)
  })

  it('the timeout → timedOut with the head as the cursor (the events seen were not mentions)', async () => {
    const bus = new EventBus({ epoch: 'e1' })
    const clock = fakeClock()
    const waits = createWaits(bus, clock.setTimer)
    const p = waits.wait(undefined, 25_000)
    bus.publish(received('1.000000'))
    expect(clock.timers[0]?.ms).toBe(25_000)
    clock.timers[0]?.fire()
    expect(await p).toEqual({ kind: 'timedOut', cursor: bus.head })
  })

  it('a cursor of another run or older than the ring → resync with the head', async () => {
    const bus = new EventBus({ epoch: 'e1', max: 2 })
    const waits = createWaits(bus, fakeClock().setTimer)
    expect(await waits.wait('other-1', 1000)).toEqual({ kind: 'resync', cursor: bus.head })
    const old = bus.head
    for (let i = 0; i < 4; i++) bus.publish(received(`${i}.000000`))
    expect(await waits.wait(old, 1000)).toEqual({ kind: 'resync', cursor: bus.head })
  })

  it('agent.revoked (replayed or live) → revoked; the signal and close → closed', async () => {
    const bus = new EventBus({ epoch: 'e1' })
    const waits = createWaits(bus, fakeClock().setTimer)
    const live = waits.wait(undefined, 1000)
    const start = bus.head
    bus.publish({ type: 'agent.revoked' })
    expect(await live).toEqual({ kind: 'revoked' })
    expect(await waits.wait(start, 1000)).toEqual({ kind: 'revoked' })

    const ac = new AbortController()
    const aborted = waits.wait(bus.head, 1000, ac.signal)
    ac.abort()
    expect(await aborted).toEqual({ kind: 'closed' })

    const pending = waits.wait(bus.head, 1000)
    waits.close()
    expect(await pending).toEqual({ kind: 'closed' })
    expect(await waits.wait(bus.head, 1000)).toEqual({ kind: 'closed' })
  })
})

describe('wait_for_mention through the real client', () => {
  let h: McpHarness | undefined
  afterEach(async () => {
    await h?.close()
    h = undefined
  })

  const armed = async (clock: { timers: Timer[] }, n = 1): Promise<Timer> => {
    await vi.waitFor(() => expect(clock.timers.length).toBeGreaterThanOrEqual(n))
    return clock.timers[n - 1] as Timer
  }

  it('waits, then answers the mention (through the edge) with a cursor that continues', async () => {
    const clock = fakeClock()
    h = await startMcp({ setTimer: clock.setTimer })
    const c = await h.client('modern')
    const p = callTool(c, 'wait_for_mention', {})
    expect((await armed(clock)).ms).toBe(25_000)
    h.world.emit(mention('1730000500.000500'))
    const a = await p
    expect(a.isError).not.toBe(true)
    const v = a.structuredContent as { mention: { conversation: string; message: { id: string } }; cursor: string }
    expect(v.mention).toMatchObject({ conversation: GENERAL.id, message: { id: '1730000500.000500', mentionsMe: true } })
    // A second mention published before the next call is not lost.
    h.world.emit(mention('1730000600.000600'))
    const next = await callTool(c, 'wait_for_mention', { after: v.cursor })
    expect(next.structuredContent).toMatchObject({ mention: { message: { id: '1730000600.000600' } } })
  })

  it('timeout → { timedOut, cursor }; timeout_s over 50 is cut to 50', async () => {
    const clock = fakeClock()
    h = await startMcp({ setTimer: clock.setTimer })
    const c = await h.client()
    const p = callTool(c, 'wait_for_mention', { timeout_s: 600 })
    const t = await armed(clock)
    expect(t.ms).toBe(50_000)
    t.fire()
    expect((await p).structuredContent).toEqual({ timedOut: true, cursor: h.api.bus.head })
  })

  it('a stale cursor → { resync, cursor }', async () => {
    h = await startMcp()
    const a = await callTool(await h.client(), 'wait_for_mention', { after: 'oldrun-7' })
    expect(a.structuredContent).toEqual({ resync: true, cursor: h.api.bus.head })
  })

  it('a revocation in flight ends the wait with isError revoked', async () => {
    const clock = fakeClock()
    h = await startMcp({ setTimer: clock.setTimer })
    const c = await h.client()
    const p = callTool(c, 'wait_for_mention', { timeout_s: 30 })
    await armed(clock)
    const revoking = h.api.revoke(200, 0)
    const a = await p
    expect(a.isError).toBe(true)
    expect(a.content[0]?.text).toBe('revoked')
    await revoking
  })

  it('a mention withheld at the edge reaches the wait as unavailable, never with the id', async () => {
    const clock = fakeClock()
    h = await startMcp({ setTimer: clock.setTimer })
    const c = await h.client()
    const p = callTool(c, 'wait_for_mention', {})
    await armed(clock)
    h.world.emit(mention('1730000700.000700', 'fala com @bob:server.example'))
    const a = await p
    expect(a.structuredContent).toMatchObject({ mention: { message: { id: '1730000700.000700', text: '', unavailable: true } } })
    expect(JSON.stringify(a)).not.toContain('@bob')
  })

  it('the server closing resolves a pending wait: the answer (unavailable) goes out first', async () => {
    const clock = fakeClock()
    h = await startMcp({ setTimer: clock.setTimer })
    const c = await h.client()
    const p = callTool(c, 'wait_for_mention', {})
    await armed(clock)
    await h.api.close()
    h = undefined
    const a = await p
    expect(a.isError).toBe(true)
    expect(a.content[0]?.text).toBe('unavailable')
    await c.close().catch(() => {})
  })
})
