import { describe, it, expect, afterEach } from 'vitest'
import { connect, isOpen, manualClock, open, socketUrl } from '../support/slack-socket'
import { BOT, startSlack, type SlackHarness } from '../support/slack-world'

// On the socket (PLANO-AGENTES §0.3.3 item 6, S-f2): `hello` first, a server ping every 10 s, a pong to
// every ping of the client, and the cut after 30 s with no pong of the client. The clock is injected.

let h: SlackHarness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 30))

describe('Socket Mode — hello', () => {
  it('the first frame is hello, with Slack’s shape and the agent’s B… as app_id', async () => {
    h = await startSlack()
    const a = await open(h)
    const hello = await a.next((f) => f.type === 'hello')
    expect(a.frames[0]).toBe(hello)
    expect(hello).toEqual({ type: 'hello', num_connections: 1, debug_info: { host: 'tayet-agent' }, connection_info: { app_id: BOT } })
    const b = await open(h)
    expect(await b.next((f) => f.type === 'hello')).toMatchObject({ num_connections: 2 })
    a.ws.close()
    b.ws.close()
  })
})

describe('Socket Mode — ping and pong', () => {
  it('the server pings every 10 s', async () => {
    const clock = manualClock()
    h = await startSlack({ socket: { clock } })
    const a = await open(h)
    let pings = 0
    a.ws.on('ping', () => pings++)
    clock.advance(9_999)
    await tick()
    expect(pings).toBe(0)
    clock.advance(1)
    await tick()
    expect(pings).toBe(1)
    clock.advance(20_000)
    await tick()
    expect(pings).toBe(3)
    a.ws.close()
  })

  it('a ping of the client gets a pong', async () => {
    h = await startSlack()
    const a = await open(h)
    const pong = new Promise<string>((r) => a.ws.once('pong', (data) => r(data.toString('utf8'))))
    a.ws.ping('from client')
    expect(await pong).toBe('from client')
    a.ws.close()
  })

  it('no pong of the client for 30 s → the connection is cut and cleaned up', async () => {
    const clock = manualClock()
    h = await startSlack({ socket: { clock } })
    // A client that never answers the pings.
    const r = await connect(await socketUrl(h), { autoPong: false })
    if (!isOpen(r)) throw new Error('refused')
    clock.advance(20_000)
    await tick()
    expect(r.ws.readyState).toBe(r.ws.OPEN)
    clock.advance(10_000)
    await r.closed
    await tick()
    expect(h.logs).toContainEqual({ evt: 'socket-close', connections: 0, reason: 'pong-timeout' })
  })

  it('a client that answers the pings stays', async () => {
    const clock = manualClock()
    h = await startSlack({ socket: { clock } })
    const a = await open(h)
    for (let i = 0; i < 6; i++) {
      clock.advance(10_000)
      await tick()
    }
    expect(a.ws.readyState).toBe(a.ws.OPEN)
    a.ws.close()
  })
})
