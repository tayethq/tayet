import { describe, it, expect, afterEach } from 'vitest'
import { App, LogLevel } from '@slack/bolt'
import { ACK_TIMEOUT_MS } from '../../src/api/slack/envelopes'
import { manualClock, open, type Frame, type RawSocket } from '../support/slack-socket'
import { ALICE, BOT, DM, GENERAL, ME, SECRET, TOKEN, idLeaks, message, startSlack, type SlackHarness } from '../support/slack-world'

// The bus events over the emulated Socket Mode (PLANO-AGENTES §0.3.12, S-f2; §0.3.3 item 6): a real Bolt
// 5.1.0 app with no patch (socket-mode 3.1.1) receives `message` and `app_mention`; raw clients see the
// envelopes, the redelivery and the per-connection ids.

let h: SlackHarness | undefined
let app: App | undefined
afterEach(async () => {
  await app?.stop().catch(() => {})
  app = undefined
  await h?.close()
  h = undefined
})

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms))

// The same snippet as the README: the local token in both fields, the base URL in clientOptions.
export function boltApp(url: string): App {
  return new App({ token: TOKEN, appToken: TOKEN, socketMode: true, clientOptions: { slackApiUrl: `${url}/slack/api/` }, logLevel: LogLevel.ERROR })
}

const envelopes = (s: RawSocket): Frame[] => s.frames.filter((f) => f.type === 'events_api')
const eventOf = (f: Frame): Record<string, unknown> => (f.payload as { event: Record<string, unknown> }).event

describe('Socket Mode — Bolt with no patch', () => {
  it('connects, gets hello, and a message.received of the bus reaches app.event("message") and is acked', async () => {
    h = await startSlack({ socket: { ackTimeoutMs: 300 } })
    app = boltApp(h.url)
    const got: Array<Record<string, unknown>> = []
    app.event('message', ({ event }) => {
      got.push(event as unknown as Record<string, unknown>)
      return Promise.resolve()
    })
    await app.start()
    expect(h.logs).toContainEqual({ evt: 'socket-open', connections: 1 })
    h.world.emit({ type: 'message.received', conversation: GENERAL.id, message: message({ id: '1731000000.000100', text: 'oi *agente*' }) })
    await expect.poll(() => got.length).toBe(1)
    expect(got[0]).toMatchObject({ type: 'message', channel: GENERAL.id, channel_type: 'channel', user: ALICE.id, text: 'oi *agente*', ts: '1731000000.000100', event_ts: '1731000000.000100' })
    await tick(700)
    expect(h.logs.filter((l) => l.evt === 'envelope-redelivered' || l.evt === 'envelope-dropped')).toEqual([])
  })

  it('mention → app_mention after the message, and say() answers in the thread', async () => {
    h = await startSlack()
    app = boltApp(h.url)
    const order: string[] = []
    app.event('message', ({ event }) => {
      order.push(`message ${(event as { ts: string }).ts}`)
      return Promise.resolve()
    })
    app.event('app_mention', async ({ event, say }) => {
      order.push(`app_mention ${event.ts}`)
      await say({ text: 'recebido', thread_ts: event.ts })
    })
    await app.start()
    const m = message({ id: '1731000000.000200', text: '@Relatórios resuma', mentionsMe: true, mentions: [ME.id] })
    h.world.messages.get(GENERAL.id)?.unshift(m)
    h.world.emit({ type: 'message.received', conversation: GENERAL.id, message: m })
    h.world.emit({ type: 'mention', conversation: GENERAL.id, message: m })
    await expect.poll(() => h?.world.calls.length).toBe(1)
    expect(order).toEqual(['message 1731000000.000200', 'app_mention 1731000000.000200'])
    expect(h.world.calls[0]).toMatchObject({ op: 'post', conversation: GENERAL.id, text: 'recebido', thread: '1731000000.000200' })
  })

  it('the agent’s own message goes out with its user_id and Bolt drops it (ignoreSelf)', async () => {
    h = await startSlack()
    app = boltApp(h.url)
    const got: string[] = []
    app.event('message', ({ event }) => {
      got.push((event as { ts: string }).ts)
      return Promise.resolve()
    })
    await app.start()
    h.world.emit({ type: 'message.received', conversation: GENERAL.id, message: message({ id: '1731000000.000300', author: ME.id, text: 'eu mesmo' }) })
    h.world.emit({ type: 'message.received', conversation: GENERAL.id, message: message({ id: '1731000000.000400', text: 'outra pessoa' }) })
    await expect.poll(() => got).toEqual(['1731000000.000400'])
  })
})

describe('Socket Mode — envelopes on the wire', () => {
  it('Slack’s envelope and payload; channel_type per kind; edited and removed', async () => {
    h = await startSlack()
    const s = await open(h)
    await s.next((f) => f.type === 'hello')
    h.world.emit({ type: 'message.received', conversation: SECRET.id, message: message({ id: '1731000000.000500', conversation: SECRET.id, author: ME.id, text: 'privado', thread: '1731000000.000100' }) })
    h.world.emit({ type: 'message.received', conversation: DM.id, message: message({ id: '1731000000.000600', conversation: DM.id, text: 'direto' }) })
    h.world.emit({ type: 'message.edited', conversation: GENERAL.id, message: message({ id: '1731000000.000100', text: 'novo texto', editedAt: 1731000005000 }) })
    h.world.emit({ type: 'message.removed', conversation: GENERAL.id, id: '1731000000.000100' })
    h.world.emit({ type: 'reaction.changed', conversation: GENERAL.id, id: '1731000000.000100', reactions: [] })
    await expect.poll(() => envelopes(s).length).toBe(4)
    const [a, b, c, d] = envelopes(s) as [Frame, Frame, Frame, Frame]
    expect(a).toMatchObject({ type: 'events_api', accepts_response_payload: false, retry_attempt: 0, retry_reason: '' })
    expect(a.envelope_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(a.payload).toMatchObject({
      token: '',
      team_id: ME.workspace,
      api_app_id: BOT,
      type: 'event_callback',
      authorizations: [{ team_id: ME.workspace, user_id: ME.id, is_bot: true }],
      event: { type: 'message', channel: SECRET.id, channel_type: 'group', user: ME.id, bot_id: BOT, text: 'privado', thread_ts: '1731000000.000100' },
    })
    const payload = a.payload as { event_id: string; event_time: number }
    expect(payload.event_id).toMatch(/^Ev[A-Z2-7]{10}$/)
    expect(Number.isInteger(payload.event_time)).toBe(true)
    expect(eventOf(b)).toMatchObject({ channel: DM.id, channel_type: 'im' })
    expect(eventOf(b)).not.toHaveProperty('bot_id')
    expect(eventOf(c)).toMatchObject({ type: 'message', subtype: 'message_changed', channel: GENERAL.id, message: { type: 'message', ts: '1731000000.000100', text: 'novo texto', edited: { user: ALICE.id } }, previous_message: { ts: '1731000000.000100' } })
    expect(eventOf(d)).toMatchObject({ type: 'message', subtype: 'message_deleted', channel: GENERAL.id, deleted_ts: '1731000000.000100' })
    // Distinct event_ids, all opaque; nothing of the protocol in any envelope.
    expect(new Set(envelopes(s).map((f) => (f.payload as { event_id: string }).event_id)).size).toBe(4)
    for (const f of envelopes(s)) expect(idLeaks(f)).toEqual([])
    s.ws.close()
  })

  it('no ack (raw client) → redelivered 1, 2, 3 with retry_reason timeout, then dropped', async () => {
    const clock = manualClock()
    h = await startSlack({ socket: { clock } })
    const s = await open(h)
    h.world.emit({ type: 'message.received', conversation: GENERAL.id, message: message({ id: '1731000000.000700', text: 'sem ack' }) })
    await expect.poll(() => envelopes(s).length).toBe(1)
    for (let i = 1; i <= 3; i++) {
      clock.advance(ACK_TIMEOUT_MS)
      await expect.poll(() => envelopes(s).length).toBe(i + 1)
    }
    const all = envelopes(s)
    expect(new Set(all.map((f) => f.envelope_id)).size).toBe(1)
    expect(all.map((f) => [f.retry_attempt, f.retry_reason])).toEqual([[0, ''], [1, 'timeout'], [2, 'timeout'], [3, 'timeout']])
    clock.advance(ACK_TIMEOUT_MS)
    await tick()
    expect(envelopes(s)).toHaveLength(4)
    expect(h.logs).toContainEqual({ evt: 'envelope-dropped', envelope_id: all[0]?.envelope_id, type: 'events_api', reason: 'timeout' })
    s.ws.close()
  })

  it('an ack stops the redelivery; an unknown ack is ignored with one line', async () => {
    const clock = manualClock()
    h = await startSlack({ socket: { clock } })
    const s = await open(h)
    h.world.emit({ type: 'message.received', conversation: GENERAL.id, message: message({ id: '1731000000.000800', text: 'com ack' }) })
    const env = await s.next((f) => f.type === 'events_api')
    s.send({ envelope_id: env.envelope_id, payload: {} })
    s.send({ envelope_id: '00000000-0000-0000-0000-000000000000' })
    await expect.poll(() => h?.logs.filter((l) => l.evt === 'ack-unknown').length).toBe(1)
    clock.advance(ACK_TIMEOUT_MS * 5)
    await tick()
    expect(envelopes(s)).toHaveLength(1)
    s.ws.close()
  })

  it('two connections get the same event with distinct envelope_ids, each acked on its own', async () => {
    const clock = manualClock()
    h = await startSlack({ socket: { clock } })
    const a = await open(h)
    const b = await open(h)
    h.world.emit({ type: 'message.received', conversation: GENERAL.id, message: message({ id: '1731000000.000900', text: 'para os dois' }) })
    const ea = await a.next((f) => f.type === 'events_api')
    const eb = await b.next((f) => f.type === 'events_api')
    expect(ea.envelope_id).not.toBe(eb.envelope_id)
    expect(eventOf(ea)).toEqual(eventOf(eb))
    expect((ea.payload as { event_id: string }).event_id).toBe((eb.payload as { event_id: string }).event_id)
    a.send({ envelope_id: ea.envelope_id })
    await tick()
    clock.advance(ACK_TIMEOUT_MS)
    await expect.poll(() => envelopes(b).length).toBe(2)
    expect(envelopes(a)).toHaveLength(1)
    a.ws.close()
    b.ws.close()
  })

  it('the Slack edge scans every envelope: a protocol id the translation brings in is withheld', async () => {
    h = await startSlack()
    const s = await open(h)
    // The file's `filetype` is born at the Slack translation (the extension of a name that the native edge
    // scanned as content, id shapes only); in the Slack shape it is structural: the full pattern set.
    const file = { id: 'FFILEAAAAAA', name: 'relatorio.verify', mimetype: 'text/plain', size: 1 }
    h.world.emit({ type: 'message.received', conversation: GENERAL.id, message: message({ id: '1731000001.000100', text: 'anexo', files: [file] }) })
    h.world.emit({ type: 'message.received', conversation: GENERAL.id, message: message({ id: '1731000001.000200', text: 'limpa' }) })
    await expect.poll(() => envelopes(s).length).toBe(1)
    expect(eventOf(envelopes(s)[0] as Frame).ts).toBe('1731000001.000200')
    expect(h.logs).toContainEqual({ evt: 'leak-blocked', where: 'slack socket envelope', path: '$.payload.event.files[0].filetype', pattern: 'verify' })
    expect(JSON.stringify(h.logs)).not.toContain('relatorio')
    s.ws.close()
  })

  it('a person’s scp address reaches the agent with its text; a user id still arrives without it', async () => {
    h = await startSlack()
    const s = await open(h)
    await s.next((f) => f.type === 'hello')
    const text = 'scp dev@build-host:project/test/goldens/home.png .'
    h.world.emit({ type: 'message.received', conversation: GENERAL.id, message: message({ id: '1731000002.000100', text }) })
    h.world.emit({ type: 'message.received', conversation: GENERAL.id, message: message({ id: '1731000002.000200', text: 'ask @alice:tayet.local' }) })
    await expect.poll(() => envelopes(s).length).toBe(2)
    const [a, b] = envelopes(s).map(eventOf)
    expect(a).toMatchObject({ type: 'message', ts: '1731000002.000100', text })
    expect(b).toMatchObject({ type: 'message', ts: '1731000002.000200', text: '' })
    expect(h.logs.filter((l) => l.evt === 'leak-blocked')).toEqual([{ evt: 'leak-blocked', where: 'event:message.received', path: '$.message.text', pattern: 'mxid' }])
    s.ws.close()
  })
})
