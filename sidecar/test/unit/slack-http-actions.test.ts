import { describe, it, expect, afterEach, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { App, LogLevel } from '@slack/bolt'
import { createHttpActions, KEPT_MAX, REDELIVERY_MS, UNACCEPTED_ROUNDS, type HttpActions, type HttpClick } from '../../src/api/slack/http-actions'
import { EventBus } from '../../src/api/bus'
import { writeFile } from 'node:fs/promises'
import { ACK_TIMEOUT_MS, MAX_RETRIES } from '../../src/api/slack/envelopes'
import type { SocketClock } from '../../src/api/slack/socket'
import { open, type RawSocket } from '../support/slack-socket'
import { ALICE, BOB, GENERAL, GONE, ME, TOKEN, call, createWorld, idLeaks, message, startSlack, type SlackHarness, type SlackStart } from '../support/slack-world'
import { fakeApprovals, type FakeApprovals } from '../support/slack-approvals'

// The approval card's click as a signed HTTP POST (`--slack-actions-url`): the request (Slack's form body and
// signature, keyed by the local token), the ack, the retries, the kept clicks and their redelivery, and the
// layer with and without the option.

// ── A receiver of the test: records every request and checks its signature with the token ───────────────────

interface Got {
  headers: IncomingHttpHeaders
  body: string
  payload: Record<string, unknown>
  signed: boolean
}

type Answer = number | 'hang' | 'reset'

interface Receiver {
  url: string
  got: Got[]
  close(): Promise<void>
}

const signatureOf = (secret: string, ts: string, body: string): string => `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`

async function receiver(answer: (n: number, got: Got) => Answer, secret = TOKEN): Promise<Receiver> {
  const got: Got[] = []
  const hung: ServerResponse[] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const ts = String(req.headers['x-slack-request-timestamp'] ?? '')
      const payloadField = new URLSearchParams(body).get('payload')
      got.push({ headers: req.headers, body, payload: payloadField !== null ? (JSON.parse(payloadField) as Record<string, unknown>) : {}, signed: req.headers['x-slack-signature'] === signatureOf(secret, ts, body) })
      const a = answer(got.length, got[got.length - 1] as Got)
      if (a === 'hang') return void hung.push(res)
      if (a === 'reset') return void req.socket.destroy()
      res.writeHead(a, { 'content-type': 'text/plain' })
      res.end('ignored by the sender')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}/slack/actions`,
    got,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections()
        server.close(() => r())
      }),
  }
}

// A free loopback port (for a receiver that starts after the layer).
async function freePort(): Promise<number> {
  const s = createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  const port = (s.address() as AddressInfo).port
  await new Promise<void>((r) => s.close(() => r()))
  return port
}

// ── A driven clock ───────────────────────────────────────────────────────────────────────────────────────────

interface Driven extends SocketClock {
  advance(ms: number): void
  readonly timers: number
}

function drivenClock(start = 1_732_000_000_000): Driven {
  let t = start
  let n = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => t,
    setTimeout: (fn, ms) => {
      const id = ++n
      timers.set(id, { at: t + ms, fn })
      return id
    },
    clearTimeout: (h) => void timers.delete(h as number),
    setInterval: () => 0,
    clearInterval: () => {},
    advance(ms) {
      t += ms
      for (const [id, x] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (x.at > t || !timers.has(id)) continue
        timers.delete(id)
        x.fn()
      }
    },
    get timers() {
      return timers.size
    },
  }
}

// ── The module ───────────────────────────────────────────────────────────────────────────────────────────────

let rx: Receiver | undefined
let actions: HttpActions | undefined
let logs: Array<Record<string, unknown>> = []
afterEach(async () => {
  actions?.stop()
  actions = undefined
  await rx?.close()
  rx = undefined
  logs = []
})

const payloadOf = (n: number, ticket = 'a'): Record<string, unknown> => ({
  type: 'block_actions',
  container: { type: 'message', message_ts: `1732000000.00010${n}`, channel_id: GENERAL.id },
  actions: [{ type: 'button', action_id: `Pick.${n}`, block_id: 'pick', value: `v-${n}` }],
  response_url: `http://127.0.0.1:1/slack/response/${ticket.repeat(64)}`,
})

interface Probe extends HttpClick {
  builds: number
  acks: number
}

function click(n: number): Probe {
  const c: Probe = {
    builds: 0,
    acks: 0,
    build: () => {
      c.builds += 1
      return Promise.resolve(payloadOf(n, c.builds === 1 ? 'a' : 'b'))
    },
    acked: () => {
      c.acks += 1
      return Promise.resolve()
    },
  }
  return c
}

function start(clock: Driven, url: string): HttpActions {
  actions = createHttpActions({ url, secret: TOKEN, log: (l) => logs.push(l), clock })
  return actions
}

const lines = (evt: string): Array<Record<string, unknown>> => logs.filter((l) => l.evt === evt)

describe('the request', () => {
  it('Slack\'s form body and signature (keyed by the local token); a 2xx is the ack; one line', async () => {
    rx = await receiver(() => 200)
    const clock = drivenClock()
    const c = click(1)
    await start(clock, rx.url).deliver(c)
    await expect.poll(() => c.acks).toBe(1)
    expect(rx.got).toHaveLength(1)
    const g = rx.got[0]!
    expect(g.signed).toBe(true)
    expect(g.headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(g.headers['x-slack-request-timestamp']).toBe(String(Math.floor(clock.now() / 1000)))
    expect(g.headers['x-slack-signature']).toMatch(/^v0=[0-9a-f]{64}$/)
    expect(g.headers['x-slack-retry-num']).toBeUndefined()
    expect(g.headers['x-slack-retry-reason']).toBeUndefined()
    expect(g.headers['user-agent']).toBe('tayet-agent')
    // One field, `payload`, whose JSON is the payload as built.
    expect([...new URLSearchParams(g.body).keys()]).toEqual(['payload'])
    expect(g.payload).toEqual(payloadOf(1))
    expect(lines('slack-action-delivered')).toEqual([{ evt: 'slack-action-delivered', status: 200 }])
  })

  it('any 2xx is the ack (204, 299)', async () => {
    let status = 204
    rx = await receiver(() => status)
    const clock = drivenClock()
    const a = click(1)
    await start(clock, rx.url).deliver(a)
    await expect.poll(() => a.acks).toBe(1)
    status = 299
    const b = click(2)
    await actions!.deliver(b)
    await expect.poll(() => b.acks).toBe(1)
    expect(lines('slack-action-retried')).toEqual([])
  })

  it('a redirect is not followed: a 3xx is a failure', async () => {
    rx = await receiver((n) => (n === 1 ? 302 : 200))
    const clock = drivenClock()
    const c = click(1)
    await start(clock, rx.url).deliver(c)
    await expect.poll(() => c.acks).toBe(1)
    expect(rx.got).toHaveLength(2)
    expect(rx.got[1]!.headers['x-slack-retry-reason']).toBe('http_error')
  })
})

describe('retries', () => {
  it('500: the same payload again up to 3 times, a fresh timestamp and signature each, with the retry headers; then kept', async () => {
    const clock = drivenClock()
    // Each request moves the clock one second: the next attempt's timestamp follows it.
    rx = await receiver(() => {
      clock.advance(1_000)
      return 500
    })
    const c = click(1)
    await start(clock, rx.url).deliver(c)
    await expect.poll(() => actions!.kept).toBe(1)
    expect(rx.got).toHaveLength(1 + MAX_RETRIES)
    expect(rx.got.map((g) => g.signed)).toEqual([true, true, true, true])
    expect(rx.got.map((g) => g.headers['x-slack-retry-num'])).toEqual([undefined, '1', '2', '3'])
    expect(rx.got.map((g) => g.headers['x-slack-retry-reason'])).toEqual([undefined, 'http_error', 'http_error', 'http_error'])
    const stamps = rx.got.map((g) => g.headers['x-slack-request-timestamp'])
    expect(new Set(stamps).size).toBe(4)
    expect(new Set(rx.got.map((g) => g.headers['x-slack-signature'])).size).toBe(4)
    expect(rx.got.every((g) => g.body === rx!.got[0]!.body)).toBe(true)
    expect(c.builds).toBe(1)
    expect(c.acks).toBe(0)
    expect(lines('slack-action-retried')).toEqual([1, 2, 3].map((attempt) => ({ evt: 'slack-action-retried', attempt, reason: 'http_error' })))
    expect(lines('slack-action-kept')).toEqual([{ evt: 'slack-action-kept', kept: 1 }])
  })

  it('silence for 3 s: the attempt times out, then the retries (http_timeout); a late success on a retry is the ack', async () => {
    rx = await receiver((n) => (n <= 2 ? 'hang' : 200))
    const clock = drivenClock()
    const c = click(1)
    await start(clock, rx.url).deliver(c)
    await expect.poll(() => rx!.got.length).toBe(1)
    clock.advance(ACK_TIMEOUT_MS - 1)
    await new Promise((r) => setTimeout(r, 20))
    expect(rx.got).toHaveLength(1)
    clock.advance(1)
    await expect.poll(() => rx!.got.length).toBe(2)
    clock.advance(ACK_TIMEOUT_MS)
    await expect.poll(() => c.acks).toBe(1)
    expect(rx.got.map((g) => g.headers['x-slack-retry-reason'])).toEqual([undefined, 'http_timeout', 'http_timeout'])
    expect(lines('slack-action-delivered')).toEqual([{ evt: 'slack-action-delivered', status: 200, attempt: 2 }])
    expect(actions!.kept).toBe(0)
  })

  it('a refused connection: connection_failed', async () => {
    const port = await freePort()
    const clock = drivenClock()
    const c = click(1)
    await start(clock, `http://127.0.0.1:${port}/slack/actions`).deliver(c)
    await expect.poll(() => actions!.kept).toBe(1)
    expect(lines('slack-action-retried').map((l) => l.reason)).toEqual(['connection_failed', 'connection_failed', 'connection_failed'])
  })
})

describe('kept clicks', () => {
  it('redelivered every 30 s, in order, each rebuilt (a fresh ticket), with no retry headers; the first failure stops the round', async () => {
    let up = false
    let failAt = 0
    rx = await receiver((n) => (!up ? 500 : n === failAt ? 500 : 200))
    const clock = drivenClock()
    const a = click(1)
    const b = click(2)
    const c = click(3)
    start(clock, rx.url)
    await actions!.deliver(a)
    await expect.poll(() => actions!.kept).toBe(1)
    // While a click is kept, the next ones join the list without going out.
    await actions!.deliver(b)
    await actions!.deliver(c)
    await expect.poll(() => actions!.kept).toBe(3)
    expect(rx.got).toHaveLength(4)
    // The app comes back; the 2nd redelivery of this round fails: a goes, b stops the round, c waits.
    up = true
    failAt = rx.got.length + 2
    clock.advance(REDELIVERY_MS - 1)
    await new Promise((r) => setTimeout(r, 20))
    expect(rx.got).toHaveLength(4)
    clock.advance(1)
    await expect.poll(() => actions!.kept).toBe(2)
    await expect.poll(() => rx!.got.length).toBe(6)
    await new Promise((r) => setTimeout(r, 20))
    expect(rx.got).toHaveLength(6)
    expect(a.acks).toBe(1)
    expect(b.acks).toBe(0)
    // Next round: b then c.
    clock.advance(REDELIVERY_MS)
    await expect.poll(() => actions!.kept).toBe(0)
    expect([b.acks, c.acks]).toEqual([1, 1])
    const redelivered = rx.got.slice(4)
    expect(redelivered.map((g) => (g.payload.actions as Array<{ action_id: string }>)[0]!.action_id)).toEqual(['Pick.1', 'Pick.2', 'Pick.2', 'Pick.3'])
    expect(redelivered.every((g) => g.signed && g.headers['x-slack-retry-num'] === undefined)).toBe(true)
    // Rebuilt: the response_url of a redelivery is not the first one.
    expect(redelivered.every((g) => String(g.payload.response_url).endsWith('b'.repeat(64)))).toBe(true)
    expect(lines('slack-action-delivered').filter((l) => l.redelivered === true)).toHaveLength(3)
    expect(clock.timers).toBe(0)
  })

  it(`at most ${KEPT_MAX}: the oldest leaves first, with one line without id`, async () => {
    rx = await receiver(() => 500)
    const clock = drivenClock()
    start(clock, rx.url)
    const first = click(0)
    await actions!.deliver(first)
    await expect.poll(() => actions!.kept).toBe(1)
    for (let i = 1; i <= KEPT_MAX; i++) await actions!.deliver(click(i))
    await expect.poll(() => lines('slack-action-dropped').length).toBe(1)
    expect(actions!.kept).toBe(KEPT_MAX)
    expect(lines('slack-action-dropped')).toEqual([{ evt: 'slack-action-dropped', reason: 'full' }])
    expect(rx.got).toHaveLength(1 + MAX_RETRIES)
  })

  it('stop: nothing more goes out and nothing is kept', async () => {
    rx = await receiver(() => 500)
    const clock = drivenClock()
    start(clock, rx.url)
    await actions!.deliver(click(1))
    await expect.poll(() => actions!.kept).toBe(1)
    actions!.stop()
    expect(actions!.kept).toBe(0)
    clock.advance(REDELIVERY_MS * 3)
    await new Promise((r) => setTimeout(r, 20))
    expect(rx.got).toHaveLength(1 + MAX_RETRIES)
  })

  it('a payload the Slack edge withholds is not sent: leak-blocked and one drop line', async () => {
    rx = await receiver(() => 200)
    const clock = drivenClock()
    const c: HttpClick = { build: () => Promise.resolve({ type: 'block_actions', channel: { id: '!abcdefghij:example.org' } }), acked: vi.fn(() => Promise.resolve()) }
    await start(clock, rx.url).deliver(c)
    await expect.poll(() => lines('slack-action-dropped').length).toBe(1)
    expect(lines('leak-blocked').length).toBeGreaterThan(0)
    expect(rx.got).toEqual([])
  })

  it('no line carries the token, the signature, the body or the response_url', async () => {
    rx = await receiver((n) => (n <= 4 ? 500 : 200))
    const clock = drivenClock()
    start(clock, rx.url)
    await actions!.deliver(click(1))
    await expect.poll(() => actions!.kept).toBe(1)
    clock.advance(REDELIVERY_MS)
    await expect.poll(() => actions!.kept).toBe(0)
    const all = JSON.stringify(logs)
    for (const g of rx.got) {
      expect(all).not.toContain(String(g.headers['x-slack-signature']))
      expect(all).not.toContain(g.body)
    }
    expect(all).not.toContain(TOKEN)
    expect(all).not.toContain('/slack/response/')
    expect(all).not.toContain('1732000000.000101')
  })
})

// ── The layer ────────────────────────────────────────────────────────────────────────────────────────────────

let h: SlackHarness | undefined
let app: App | undefined
let dir: string | undefined
const sockets: RawSocket[] = []
afterEach(async () => {
  for (const s of sockets.splice(0)) s.ws.terminate()
  await app?.stop().catch(() => {})
  app = undefined
  await h?.close()
  h = undefined
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  dir = undefined
})

const AT = 1_732_000_500_123
let approvals: FakeApprovals
let file: string

async function layer(opts: SlackStart = {}): Promise<SlackHarness> {
  dir = await mkdtemp(join(tmpdir(), 'slack-http-actions-'))
  file = join(dir, 'slack-cards.json')
  const world = createWorld()
  approvals = fakeApprovals(world)
  h = await startSlack({ world, approvals, cardsFile: file, ...opts })
  return h
}

const button = (label: string, over: Record<string, unknown> = {}) => ({ type: 'button', text: { type: 'plain_text', text: label }, ...over })
async function card(text = 'Publicar a versão 2.1?'): Promise<string> {
  const res = await call(h!.client(), 'chat.postMessage', {
    channel: GENERAL.id,
    text,
    blocks: [{ type: 'actions', block_id: 'release', elements: [button('Aprovar', { action_id: 'Approve.Release', value: 'release-2.1', style: 'primary' }), button('Rejeitar', { action_id: 'Reject.Release', style: 'danger' })] }],
  })
  return res.ts as string
}
function answer(ts: string, option: string): void {
  approvals.answer(GENERAL.id, ts, option, ALICE.id, AT)
  h!.world.emit({ type: 'approval.answered', conversation: GENERAL.id, id: ts, option, by: ALICE.id, at: AT })
}
const entries = async (): Promise<Array<{ id: string }>> => (JSON.parse(await readFile(file, 'utf8')) as { cards: Array<{ id: string }> }).cards
const sock = async (): Promise<RawSocket> => {
  const s = await open(h!)
  sockets.push(s)
  await s.next((f) => f.type === 'hello')
  return s
}

describe('the layer with --slack-actions-url', () => {
  it('the click goes to the URL, the payload of the socket\'s block_actions; a 2xx removes the card\'s entry; no socket gets `interactive`', async () => {
    rx = await receiver(() => 200)
    await layer({ actionsUrl: rx.url })
    const s = await sock()
    const ts = await card()
    expect((await entries()).map((e) => e.id)).toEqual([ts])
    answer(ts, 'b1')
    await expect.poll(() => rx!.got.length).toBe(1)
    const g = rx.got[0]!
    expect(g.signed).toBe(true)
    expect(g.payload).toMatchObject({
      type: 'block_actions',
      user: { id: ALICE.id },
      channel: { id: GENERAL.id },
      team: { id: ME.workspace },
      container: { type: 'message', message_ts: ts, channel_id: GENERAL.id },
      response_url: expect.stringMatching(new RegExp(`^${h!.url}/slack/response/[0-9a-f]{64}$`)) as unknown,
      actions: [{ type: 'button', action_id: 'Approve.Release', block_id: 'release', value: 'release-2.1', style: 'primary', text: { type: 'plain_text', text: 'Aprovar', emoji: true } }],
    })
    expect(idLeaks(g.payload)).toEqual([])
    await expect.poll(entries).toEqual([])
    // The socket heard nothing of it.
    await new Promise((r) => setTimeout(r, 50))
    expect(s.frames.filter((f) => f.type === 'interactive')).toEqual([])
  })

  it('the other envelopes do not change: a message still reaches the socket as events_api', async () => {
    rx = await receiver(() => 200)
    await layer({ actionsUrl: rx.url })
    const s = await sock()
    h!.world.emit({ type: 'message.received', conversation: GENERAL.id, message: message({ id: '1732000600.000100', conversation: GENERAL.id, author: ALICE.id, text: 'oi' }) })
    const f = await s.next((x) => x.type === 'events_api')
    expect((f.payload as { event: { type: string; text: string } }).event).toMatchObject({ type: 'message', text: 'oi' })
    expect(rx.got).toEqual([])
  })

  it('no socket open: the click still goes out, and the bus keeps nothing for a later consumer', async () => {
    rx = await receiver(() => 200)
    await layer({ actionsUrl: rx.url })
    const ts = await card()
    answer(ts, 'b2')
    await expect.poll(() => rx!.got.length).toBe(1)
    expect((rx.got[0]!.payload.actions as Array<{ action_id: string }>)[0]!.action_id).toBe('Reject.Release')
    // A stream opened now (GET /v1/events with no cursor) gets no unheard click.
    const later = h!.api.bus.open(undefined, () => {})
    expect(later.unheard).toEqual([])
    later.close()
  })

  it('the app is down: retries, the click is kept and delivered on the next round; the card\'s entry leaves then', async () => {
    // Down for the immediate attempts (the first and the retries), back for the first periodic round. A timeout
    // well above the receiver's answer time: under load a 200 must not read as a timeout (it would count as a
    // refused round).
    rx = await receiver((n) => (n <= 1 + MAX_RETRIES ? 500 : 200))
    await layer({ actionsUrl: rx.url, redeliveryMs: 200, socket: { ackTimeoutMs: 1_000 } })
    const ts = await card()
    answer(ts, 'b1')
    await expect.poll(() => h!.logs.filter((l) => l.evt === 'slack-action-kept').length, { timeout: 10_000 }).toBe(1)
    expect(rx.got.slice(0, 1 + MAX_RETRIES).map((g) => g.headers['x-slack-retry-num'])).toEqual([undefined, '1', '2', '3'])
    await expect.poll(entries, { timeout: 10_000 }).toEqual([])
    expect(rx.got).toHaveLength(2 + MAX_RETRIES)
    expect(h!.logs.filter((l) => l.evt === 'slack-action-dropped')).toEqual([])
    const last = rx.got.at(-1)!
    expect(last.headers['x-slack-retry-num']).toBeUndefined()
    // Rebuilt: another response_url ticket than the first attempt's.
    expect(last.payload.response_url).not.toBe(rx.got[0]!.payload.response_url)
    expect((last.payload.container as { message_ts: string }).message_ts).toBe(ts)
  })

  it('without the option nothing changes: the socket gets `interactive`, nothing is POSTed', async () => {
    rx = await receiver(() => 200)
    await layer()
    const s = await sock()
    const ts = await card()
    answer(ts, 'b1')
    const f = await s.next((x) => x.type === 'interactive')
    expect((f.payload as { container: { message_ts: string } }).container.message_ts).toBe(ts)
    expect(rx.got).toEqual([])
    expect(h!.logs.filter((l) => String(l.evt).startsWith('slack-action-'))).toEqual([])
  })
})

describe('Bolt 5.1.0 with no patch, in HTTP mode', () => {
  it('signingSecret = the local token: app.action gets the original action_id and value; respond() replaces the request', async () => {
    const port = await freePort()
    await layer({ actionsUrl: `http://127.0.0.1:${port}/slack/actions` })
    app = new App({ token: TOKEN, signingSecret: TOKEN, endpoints: '/slack/actions', clientOptions: { slackApiUrl: `${h!.url}/slack/api/` }, logLevel: LogLevel.ERROR })
    const got: Array<{ body: Record<string, unknown>; action: Record<string, unknown>; retryNum: unknown }> = []
    app.action(/.+/, async ({ ack, body, action, respond, context }) => {
      await ack()
      got.push({ body: body as unknown as Record<string, unknown>, action: action as unknown as Record<string, unknown>, retryNum: context.retryNum })
      await respond({ replace_original: true, text: 'Aprovado por *Alice*' })
    })
    await app.start({ port, host: '127.0.0.1' })
    const ts = await card()
    answer(ts, 'b1')
    await expect.poll(() => got.length).toBe(1)
    expect(got[0]!.action).toMatchObject({ type: 'button', action_id: 'Approve.Release', block_id: 'release', value: 'release-2.1' })
    expect(got[0]!.body).toMatchObject({ type: 'block_actions', user: { id: ALICE.id }, container: { message_ts: ts } })
    expect(got[0]!.retryNum).toBeUndefined()
    await expect.poll(() => h!.world.calls.filter((c) => c.op === 'edit').length).toBe(1)
    expect(h!.world.calls.find((c) => c.op === 'edit')).toMatchObject({ conversation: GENERAL.id, ts, text: 'Aprovado por Alice' })
    await expect.poll(entries).toEqual([])
    expect(h!.logs.filter((l) => l.evt === 'slack-action-delivered')).toEqual([{ evt: 'slack-action-delivered', status: 200 }])
  })

  it('another signing secret: Bolt answers 401 and the click is retried, then kept', async () => {
    const port = await freePort()
    await layer({ actionsUrl: `http://127.0.0.1:${port}/slack/actions`, socket: { ackTimeoutMs: 500 } })
    app = new App({ token: TOKEN, signingSecret: 'another-secret', endpoints: '/slack/actions', clientOptions: { slackApiUrl: `${h!.url}/slack/api/` }, logLevel: LogLevel.ERROR, logger: { debug() {}, info() {}, warn() {}, error() {}, setLevel() {}, getLevel: () => LogLevel.ERROR, setName() {} } })
    const got: unknown[] = []
    app.action(/.+/, async ({ ack }) => {
      await ack()
      got.push(1)
    })
    await app.start({ port, host: '127.0.0.1' })
    const ts = await card()
    answer(ts, 'b1')
    await expect.poll(() => h!.logs.filter((l) => l.evt === 'slack-action-kept').length).toBe(1)
    expect(h!.logs.filter((l) => l.evt === 'slack-action-retried').map((l) => l.reason)).toEqual(['http_error', 'http_error', 'http_error'])
    expect(got).toEqual([])
  })
})

// ── A kept click the app never accepts ───────────────────────────────────────────────────────────────────────

const actionOf = (g: Got): string => (g.payload.actions as Array<{ action_id: string }>)[0]!.action_id

describe('a kept click the app never accepts', () => {
  it(`500 in every round: dropped in the ${UNACCEPTED_ROUNDS}rd counted round, with a line; the click waiting behind it goes in that same round`, async () => {
    // Pick.1 is always refused; Pick.2 is accepted.
    rx = await receiver((_n, g) => (actionOf(g) === 'Pick.1' ? 500 : 200))
    const clock = drivenClock()
    start(clock, rx.url)
    const a = click(1)
    const b = click(2)
    await actions!.deliver(a)
    await expect.poll(() => actions!.kept).toBe(1)
    await actions!.deliver(b)
    await expect.poll(() => actions!.kept).toBe(2)
    // The immediate attempts (1 + 3 retries) do not count.
    expect(rx.got.map(actionOf)).toEqual(['Pick.1', 'Pick.1', 'Pick.1', 'Pick.1'])
    for (let round = 1; round < UNACCEPTED_ROUNDS; round++) {
      clock.advance(REDELIVERY_MS)
      await expect.poll(() => rx!.got.length).toBe(4 + round)
      await new Promise((r) => setTimeout(r, 20))
      // The failure stops the round: b is not tried, nothing is dropped, the order holds.
      expect(rx.got.map(actionOf).slice(4)).toEqual(Array.from({ length: round }, () => 'Pick.1'))
      expect(actions!.kept).toBe(2)
      expect(lines('slack-action-dropped')).toEqual([])
    }
    clock.advance(REDELIVERY_MS)
    await expect.poll(() => actions!.kept).toBe(0)
    expect(rx.got.map(actionOf).slice(4)).toEqual(['Pick.1', 'Pick.1', 'Pick.1', 'Pick.2'])
    expect(lines('slack-action-dropped')).toEqual([{ evt: 'slack-action-dropped', reason: 'unaccepted' }])
    expect([a.acks, b.acks]).toEqual([0, 1])
    expect(clock.timers).toBe(0)
  })

  it('no answer within 3 s counts too (http_timeout)', async () => {
    rx = await receiver(() => 'hang')
    const clock = drivenClock()
    start(clock, rx.url)
    await actions!.deliver(click(1))
    for (let i = 1; i <= 1 + MAX_RETRIES; i++) {
      await expect.poll(() => rx!.got.length).toBe(i)
      clock.advance(ACK_TIMEOUT_MS)
    }
    await expect.poll(() => actions!.kept).toBe(1)
    for (let round = 1; round <= UNACCEPTED_ROUNDS; round++) {
      clock.advance(REDELIVERY_MS)
      await expect.poll(() => rx!.got.length).toBe(4 + round)
      clock.advance(ACK_TIMEOUT_MS)
      // The timeout settles the attempt; the next round's timer is armed after it.
      await new Promise((r) => setTimeout(r, 30))
    }
    await expect.poll(() => actions!.kept).toBe(0)
    expect(lines('slack-action-dropped')).toEqual([{ evt: 'slack-action-dropped', reason: 'unaccepted' }])
  })

  it('a refused connection in every round: the click stays (the count does not move)', async () => {
    const port = await freePort()
    const clock = drivenClock()
    start(clock, `http://127.0.0.1:${port}/slack/actions`)
    await actions!.deliver(click(1))
    await expect.poll(() => actions!.kept).toBe(1)
    const rounds = UNACCEPTED_ROUNDS + 2
    for (let round = 1; round <= rounds; round++) {
      const before = logs.length
      clock.advance(REDELIVERY_MS)
      // Wait for the round's attempt to settle (the timer re-armed).
      await expect.poll(() => clock.timers).toBe(1)
      expect(logs.length).toBe(before)
    }
    expect(actions!.kept).toBe(1)
    expect(lines('slack-action-dropped')).toEqual([])
  })
})

describe('Bolt 5.1.0 with no patch, in HTTP mode: a button with no app.action', () => {
  it('Bolt answers no 2xx (its unhandled-request handler: 404 after ~3 s); the click is dropped in the 3rd round and the next click, which has a listener, goes', async () => {
    const port = await freePort()
    // The sidecar waits 4 s per attempt, so Bolt's own answer (at ~3 s) is what it sees.
    await layer({ actionsUrl: `http://127.0.0.1:${port}/slack/actions`, socket: { ackTimeoutMs: 4_000 }, redeliveryMs: 100 })
    const errors: string[] = []
    const logger = { debug() {}, info() {}, warn() {}, error: (...m: unknown[]) => void errors.push(m.map(String).join(' ')), setLevel() {}, getLevel: () => LogLevel.ERROR, setName() {} }
    app = new App({ token: TOKEN, signingSecret: TOKEN, endpoints: '/slack/actions', clientOptions: { slackApiUrl: `${h!.url}/slack/api/` }, logger })
    const got: string[] = []
    // A listener for Reject.Release only: Approve.Release has none.
    app.action('Reject.Release', async ({ ack, action }) => {
      await ack()
      got.push((action as { action_id: string }).action_id)
    })
    await app.start({ port, host: '127.0.0.1' })
    const first = await card('Primeiro?')
    const second = await card('Segundo?')
    answer(first, 'b1')
    answer(second, 'b2')
    await expect.poll(() => got, { timeout: 45_000, interval: 200 }).toEqual(['Reject.Release'])
    // What Bolt answered to the click with no listener: no 2xx, before the sidecar's 4 s.
    const retried = h!.logs.filter((l) => l.evt === 'slack-action-retried')
    expect(retried.map((l) => l.reason)).toEqual(['http_error', 'http_error', 'http_error'])
    expect(errors.some((e) => e.includes('not acknowledged within 3 seconds'))).toBe(true)
    expect(h!.logs.filter((l) => l.evt === 'slack-action-dropped')).toEqual([{ evt: 'slack-action-dropped', reason: 'unaccepted' }])
    // Bolt runs the listener before it answers 200: the delivery line follows the listener.
    await expect.poll(() => h!.logs.filter((l) => l.evt === 'slack-action-delivered'), { timeout: 10_000 }).toEqual([{ evt: 'slack-action-delivered', status: 200, redelivered: true }])
    // The dropped card keeps its entry; the delivered one left the file.
    await expect.poll(async () => (await entries()).map((e) => e.id)).toEqual([first])
    void second
  }, 60_000)
})

// ── A click decided before the layer exists (the boot's recovery) ────────────────────────────────────────────

describe('a click decided before the layer is created', () => {
  it('an approval.answered on the bus before the layer exists is delivered over HTTP when it is created, with the action_id kept from the last run', async () => {
    rx = await receiver(() => 200)
    dir = await mkdtemp(join(tmpdir(), 'slack-http-actions-boot-'))
    file = join(dir, 'slack-cards.json')
    const world = createWorld()
    approvals = fakeApprovals(world)
    // The card of a previous run: in the world (the server) and in the layer's file on disk.
    const sent = await approvals.request(GENERAL.id, { text: 'Publicar?', options: [{ id: 'b1', label: 'Aprovar' }] })
    await writeFile(file, JSON.stringify({ cards: [{ conversation: GENERAL.id, id: sent.id, block_id: 'release', actions: [{ option: 'b1', action_id: 'Approve.Release', value: 'release-2.1' }], at: AT }], aliases: [] }))
    approvals.answer(GENERAL.id, sent.id, 'b1', ALICE.id, AT)
    // The boot's recovery publishes before any consumer: the bus keeps it.
    const bus = new EventBus()
    bus.publish({ type: 'approval.answered', conversation: GENERAL.id, id: sent.id, option: 'b1', by: ALICE.id, at: AT })
    h = await startSlack({ world, approvals, cardsFile: file, bus, actionsUrl: rx.url })
    await expect.poll(() => rx!.got.length).toBe(1)
    expect(rx.got[0]!.payload).toMatchObject({ type: 'block_actions', container: { message_ts: sent.id }, actions: [{ action_id: 'Approve.Release', block_id: 'release', value: 'release-2.1' }] })
    await expect.poll(entries).toEqual([])
    // Delivered to the HTTP side, so nothing is left for a later stream.
    const later = bus.open(undefined, () => {})
    expect(later.unheard).toEqual([])
    later.close()
  })
})

// ADR-104 (Aprovadores 2): a card created by the native API that asks for several answers → one signed
// POST per answer; none is deduplicated.
describe('the layer with --slack-actions-url — a card that asks for several answers (ADR-104)', () => {
  it('three approval.answered of the same card → three block_actions POSTs, one per person, in order', async () => {
    rx = await receiver(() => 200)
    await layer({ actionsUrl: rx.url })
    const ts = '1732000400.000100'
    const people = [ALICE, BOB, GONE]
    people.forEach((p, i) => h!.world.emit({ type: 'approval.answered', conversation: GENERAL.id, id: ts, option: 'approve', by: p.id, at: AT + i, count: i + 1, needed: 3 }))
    await expect.poll(() => rx!.got.length).toBe(3)
    await new Promise((r) => setTimeout(r, 50))
    expect(rx.got).toHaveLength(3)
    expect(rx.got.every((g) => g.signed)).toBe(true)
    expect(rx.got.map((g) => (g.payload.user as { id: string }).id)).toEqual(people.map((p) => p.id))
    expect(rx.got.map((g) => (g.payload.container as { message_ts: string }).message_ts)).toEqual([ts, ts, ts])
    expect(rx.got.map((g) => g.payload.type)).toEqual(['block_actions', 'block_actions', 'block_actions'])
    expect(idLeaks(rx.got.map((g) => g.payload))).toEqual([])
  })
})
