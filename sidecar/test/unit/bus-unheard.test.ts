import { describe, it, expect, afterEach } from 'vitest'
import { connect, type Socket } from 'node:net'
import { EventBus, type BusEntry } from '../../src/api/bus'
import { createApiServer, type ApiServer } from '../../src/api/server'
import type { ApiEvent } from '../../src/api/contract'
import { createWorld, TOKEN } from '../support/slack-world'

// Redelivery of the unheard (A3-3b; ADR-091 dec. 7): an `approval.answered` published with NO consumer
// open is kept (at most 200) and goes to the first consumer that opens without a valid cursor of this run
// (no id, or `resync`), right after the `resync`; a consumer with a cursor of this run gets the ring's
// replay only (what it replays leaves the list). Delivered once.

const answered = (id: string): ApiEvent => ({ type: 'approval.answered', conversation: 'CAAAAAAAAAA', id, option: 'ok', by: 'UBBBBBBBBBB', at: 5 })
const other = (id: string): ApiEvent => ({ type: 'conversation.removed', id })
const ids = (entries: BusEntry[]): string[] => entries.map((e) => (e.event.type === 'approval.answered' ? e.event.id : e.event.type))
const noop = (): void => {}

describe('the bus keeps what nobody heard', () => {
  it('published with no consumer → given to the first consumer with no cursor, once', () => {
    const bus = new EventBus({ epoch: 'e1' })
    bus.publish(answered('1.000001'))
    bus.publish(other('C1'))
    bus.publish(answered('1.000002'))
    const a = bus.open(undefined, noop)
    expect(a.replay).toEqual({ kind: 'events', entries: [] })
    // Only the answers, in publish order.
    expect(ids(a.unheard)).toEqual(['1.000001', '1.000002'])
    a.close()
    // Delivered once: the next fresh consumer gets nothing.
    const b = bus.open(undefined, noop)
    expect(b.unheard).toEqual([])
    b.close()
  })

  it('a consumer connected at publish → nothing kept; a plain subscriber does not count as one', () => {
    const bus = new EventBus({ epoch: 'e1' })
    const live: BusEntry[] = []
    const a = bus.open(undefined, (e) => live.push(e))
    bus.publish(answered('1.000001'))
    expect(ids(live)).toEqual(['1.000001'])
    a.close()
    expect(bus.open(undefined, noop).unheard).toEqual([])

    const bus2 = new EventBus({ epoch: 'e2' })
    // wait_for_mention and the Slack broadcaster subscribe plainly: not someone listening for the answer.
    const off = bus2.subscribe(noop)
    bus2.publish(answered('1.000003'))
    off()
    expect(ids(bus2.open(undefined, noop).unheard)).toEqual(['1.000003'])
  })

  it('a cursor of this run → only the replay; what the replay carried leaves the list', () => {
    const bus = new EventBus({ epoch: 'e1' })
    const a = bus.open(undefined, noop)
    const seen = bus.publish(other('C1'))
    a.close()
    bus.publish(answered('1.000001'))
    const b = bus.open(seen.id, noop)
    expect(b.replay.kind === 'events' && ids(b.replay.entries)).toEqual(['1.000001'])
    expect(b.unheard).toEqual([])
    b.close()
    // Not given twice.
    expect(bus.open(undefined, noop).unheard).toEqual([])
  })

  it('a cursor of this run at the head keeps the list for the next fresh consumer', () => {
    const bus = new EventBus({ epoch: 'e1' })
    bus.publish(answered('1.000001'))
    const b = bus.open(bus.head, noop)
    expect(b.replay).toEqual({ kind: 'events', entries: [] })
    expect(b.unheard).toEqual([])
    b.close()
    expect(ids(bus.open(undefined, noop).unheard)).toEqual(['1.000001'])
  })

  it('a cursor of another run (resync) gets the list', () => {
    const bus = new EventBus({ epoch: 'e2' })
    bus.publish(answered('1.000001'))
    const b = bus.open('e1-40', noop)
    expect(b.replay).toEqual({ kind: 'resync', head: 'e2-1' })
    expect(ids(b.unheard)).toEqual(['1.000001'])
  })

  it('the cap: past 200 the oldest leaves, with one line without id', () => {
    const logs: Array<Record<string, unknown>> = []
    const bus = new EventBus({ epoch: 'e1', log: (l) => logs.push(l) })
    for (let i = 0; i < 202; i++) bus.publish(answered(`1.${String(i).padStart(6, '0')}`))
    const got = bus.open(undefined, noop).unheard
    expect(got).toHaveLength(200)
    expect(ids(got)[0]).toBe('1.000002')
    expect(logs).toEqual([
      { evt: 'unheard-dropped', type: 'approval.answered' },
      { evt: 'unheard-dropped', type: 'approval.answered' },
    ])
  })

  it('a closed consumer no longer counts: what is published after its close is kept', () => {
    const bus = new EventBus({ epoch: 'e1' })
    const a = bus.open(undefined, noop)
    a.close()
    a.close()
    bus.publish(answered('1.000001'))
    expect(ids(bus.open(undefined, noop).unheard)).toEqual(['1.000001'])
  })
})

// ── Through the SSE ─────────────────────────────────────────────────────────────────────────────────

interface Frame {
  id?: string
  event?: string
  data?: string
  comment?: string
}

const servers: ApiServer[] = []
const sockets: Socket[] = []
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy()
  for (const s of servers.splice(0)) await s.close()
})

function stream(port: number, lastEventId?: string): Promise<Frame[]> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1')
    sockets.push(socket)
    let buf = ''
    socket.setEncoding('utf8')
    socket.write(`GET /v1/events HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${TOKEN}\r\n${lastEventId !== undefined ? `Last-Event-ID: ${lastEventId}\r\n` : ''}\r\n`)
    socket.on('data', (chunk: string) => {
      buf += chunk
      const head = buf.indexOf('\r\n\r\n')
      if (head === -1) return
      const text = buf.slice(head + 4).replace(/^[0-9a-f]+\r\n|\r\n[0-9a-f]+\r\n|\r\n$/gm, '')
      const frames: Frame[] = []
      for (const block of text.split('\n\n').slice(0, -1)) {
        const f: Frame = {}
        for (const line of block.split('\n')) {
          if (line.startsWith(':')) f.comment = line.slice(1).trim()
          else if (line.startsWith('id: ')) f.id = line.slice(4)
          else if (line.startsWith('event: ')) f.event = line.slice(7)
          else if (line.startsWith('data: ')) f.data = line.slice(6)
        }
        frames.push(f)
      }
      if (frames.some((f) => f.comment === 'open')) resolve(frames)
    })
  })
}

async function startApi() {
  const world = createWorld()
  const api = createApiServer({ read: world.read, write: world.write, state: () => 'online', token: TOKEN, listen: { host: '127.0.0.1', port: 0 }, log: () => {} })
  servers.push(api)
  const url = await api.start()
  return { world, api, port: Number(new URL(url).port) }
}

describe('SSE: the unheard after the boot', () => {
  it('a stream opened after the event (no cursor) gets it first, without an id line; once', async () => {
    const { world, port } = await startApi()
    world.emit(answered('1.000001'))
    const frames = await stream(port)
    expect(frames[0]).toEqual({ event: 'approval.answered', data: JSON.stringify(answered('1.000001')) })
    expect(frames[1]).toEqual({ comment: 'open' })
    const again = await stream(port)
    expect(again.filter((f) => f.event === 'approval.answered')).toEqual([])
  })

  it('a stream with a cursor of another run: resync first, then the unheard; the cursor stays at the head', async () => {
    const { world, api, port } = await startApi()
    world.emit(other('C1'))
    world.emit(answered('1.000001'))
    const frames = await stream(port, 'otherrun-9')
    expect(frames.map((f) => f.event ?? `:${f.comment}`)).toEqual(['resync', 'approval.answered', ':open'])
    expect(frames[0]?.id).toBe(`${api.bus.epoch}-2`)
    expect(frames[1]?.id).toBeUndefined()
  })

  it('a stream reconnecting with a cursor of this run gets the replay, with ids; not again on a fresh one', async () => {
    const { world, api, port } = await startApi()
    const first = await stream(port)
    expect(first).toEqual([{ comment: 'open' }])
    for (const s of sockets.splice(0)) s.destroy()
    // The server sees the close before the next publish.
    await new Promise((r) => setTimeout(r, 50))
    world.emit(answered('1.000001'))
    const frames = await stream(port, `${api.bus.epoch}-0`)
    expect(frames[0]).toMatchObject({ id: `${api.bus.epoch}-1`, event: 'approval.answered' })
    const fresh = await stream(port)
    expect(fresh.filter((f) => f.event === 'approval.answered')).toEqual([])
  })
})
