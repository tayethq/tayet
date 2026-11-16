import { describe, it, expect, afterEach } from 'vitest'
import { App, LogLevel } from '@slack/bolt'
import { RESPONSE_TTL_MS, RESPONSE_USES } from '../../src/api/slack/response'
import type { ApiMessage } from '../../src/api/contract'
import { open, type Frame, type RawSocket } from '../support/slack-socket'
import { ALICE, BOT, DM, GENERAL, ME, TOKEN, createWorld, idLeaks, message, startSlack, type SlackHarness, type SlackStart } from '../support/slack-world'

// A person's `/` command on the Slack layer (A4-3; PLANO-AGENTES §0.3.25 items 4–7): the `slash_commands` envelope in
// place of the `message` and the `app_mention` of that message, its payload, and its response — the ack's payload
// and the response_url — as an ordinary reply in the command's thread.

let h: SlackHarness | undefined
let app: App | undefined
const sockets: RawSocket[] = []
afterEach(async () => {
  for (const s of sockets.splice(0)) s.ws.terminate()
  await app?.stop().catch(() => {})
  app = undefined
  await h?.close()
  h = undefined
})

let clock = 1_000_000
async function start(opts: SlackStart = {}): Promise<SlackHarness> {
  h = await startSlack({ world: createWorld(), now: () => clock, ...opts })
  return h
}
const sock = async (): Promise<RawSocket> => {
  const s = await open(h!)
  sockets.push(s)
  await s.next((f) => f.type === 'hello')
  return s
}
const tick = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms))

let seq = 0
// A person's message in the world (so a reply in its thread finds it), with or without a command for this agent.
function said(text: string, over: Partial<ApiMessage> = {}): ApiMessage {
  seq += 1
  const m = message({ id: `1732000${String(600 + seq)}.000100`, conversation: GENERAL.id, author: ALICE.id, text, mentionsMe: true, mentions: [ME.id], ...over })
  const conv = m.conversation
  h!.world.messages.set(conv, [m, ...(h!.world.messages.get(conv) ?? [])])
  return m
}
const commandMessage = (args = 'produção', over: Partial<ApiMessage> = {}): ApiMessage =>
  said(`/deploy${args === '' ? '' : ` ${args}`}`, { command: { name: 'deploy', args }, ...over })
// The core publishes message.received, then mention, for a message that mentions the agent.
function live(m: ApiMessage): void {
  h!.world.emit({ type: 'message.received', conversation: m.conversation, message: m })
  if (m.mentionsMe) h!.world.emit({ type: 'mention', conversation: m.conversation, message: m })
}
const commands = (s: RawSocket): Frame[] => s.frames.filter((f) => f.type === 'slash_commands')
const events = (s: RawSocket): Array<Record<string, unknown>> =>
  s.frames.filter((f) => f.type === 'events_api').map((f) => (f.payload as { event: Record<string, unknown> }).event)
const payloadOf = (f: Frame): Record<string, unknown> => f.payload as Record<string, unknown>
const posts = () => h!.world.calls.filter((c) => c.op === 'post')
const post = async (url: string, body: unknown) => {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}
// No line carries the command's name, its args or a response's text.
const noContentInLogs = (...words: string[]): void => {
  const all = JSON.stringify(h!.logs)
  for (const w of words) expect(all).not.toContain(w)
}

describe('slash_commands — Bolt 5.1.0 with no patch', () => {
  it('app.command gets the command; ack(text) and respond() become replies in the command’s thread; no message nor app_mention of it', async () => {
    await start()
    app = new App({ token: TOKEN, appToken: TOKEN, socketMode: true, clientOptions: { slackApiUrl: `${h!.url}/slack/api/` }, logLevel: LogLevel.ERROR })
    const got: Array<Record<string, unknown>> = []
    const heard: string[] = []
    app.command('/deploy', async ({ ack, command, respond }) => {
      await ack('Recebido: *produção*')
      got.push({ ...command })
      await respond({ response_type: 'in_channel', text: 'Feito' })
    })
    app.event('message', ({ event }) => Promise.resolve(void heard.push(`message ${(event as { ts: string }).ts}`)))
    app.event('app_mention', ({ event }) => Promise.resolve(void heard.push(`app_mention ${event.ts}`)))
    await app.start()
    await tick(100)
    const m = commandMessage()
    live(m)
    const plain = said(`<@${ME.id}> oi`)
    live(plain)
    await expect.poll(() => posts().length).toBe(2)
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ command: '/deploy', text: 'produção', channel_id: GENERAL.id, user_id: ALICE.id, team_id: ME.workspace, message_ts: m.id })
    // Both replies in a new thread under the command's message; the ack first.
    expect(posts()).toEqual([
      { op: 'post', conversation: GENERAL.id, text: 'Recebido: produção', rich: expect.anything() as unknown, thread: m.id },
      { op: 'post', conversation: GENERAL.id, text: 'Feito', thread: m.id },
    ])
    // The ordinary mention still came; the command's message did not.
    await expect.poll(() => heard.length).toBe(2)
    expect(heard).toEqual([`message ${plain.id}`, `app_mention ${plain.id}`])
    expect(h!.logs.filter((l) => l.evt === 'slash-command-response')).toEqual([
      { evt: 'slash-command-response', via: 'ack' },
      { evt: 'slash-command-response', via: 'response_url' },
    ])
    expect(idLeaks(got)).toEqual([])
    noContentInLogs('produção', 'deploy', 'Recebido', 'Feito')
  })
})

describe('slash_commands — the envelope in place of message + app_mention (item 4)', () => {
  it('live: one slash_commands envelope that accepts a response payload; no events_api for that message', async () => {
    await start()
    const s = await sock()
    const m = commandMessage()
    live(m)
    const f = await s.next((x) => x.type === 'slash_commands')
    expect(f).toMatchObject({ type: 'slash_commands', accepts_response_payload: true, retry_attempt: 0, retry_reason: '' })
    s.send({ envelope_id: f.envelope_id })
    // A barrier: a plain message after it arrives, and the command's message never did.
    const after = said('depois', { mentionsMe: false, mentions: [] })
    live(after)
    await s.next((x) => x.type === 'events_api')
    expect(events(s).map((e) => e.ts)).toEqual([after.id])
    expect(commands(s)).toHaveLength(1)
    expect(h!.logs).toContainEqual({ evt: 'slash-command', sockets: 1 })
  })

  it('the late decryption: the unreadable message goes as before; the readable version (message.edited) is not sent; its mention is the envelope', async () => {
    await start()
    const s = await sock()
    const m = said('', { unavailable: true, mentionsMe: false, mentions: [] })
    live(m)
    const first = await s.next((x) => x.type === 'events_api')
    expect((payloadOf(first).event as Record<string, unknown>).ts).toBe(m.id)
    const readable: ApiMessage = { ...m, unavailable: undefined, text: '/deploy produção', mentionsMe: true, mentions: [ME.id], command: { name: 'deploy', args: 'produção' } }
    h!.world.emit({ type: 'message.edited', conversation: m.conversation, message: readable })
    h!.world.emit({ type: 'mention', conversation: m.conversation, message: readable })
    const f = await s.next((x) => x.type === 'slash_commands')
    expect(payloadOf(f)).toMatchObject({ command: '/deploy', text: 'produção', message_ts: m.id })
    await tick()
    expect(events(s)).toHaveLength(1)
  })

  it('a command for another agent, or a name outside the set (no `command` on the message): message + app_mention, as before', async () => {
    await start()
    const s = await sock()
    const other = said('/deploy produção')
    live(other)
    const unknown = said('/rollback agora')
    live(unknown)
    await expect.poll(() => events(s).length).toBe(4)
    expect(events(s).map((e) => `${e.type as string} ${e.ts as string}`)).toEqual([`message ${other.id}`, `app_mention ${other.id}`, `message ${unknown.id}`, `app_mention ${unknown.id}`])
    expect(commands(s)).toEqual([])
  })

  // The command implies the mention, which the text does not carry: the mrkdwn of a read prefixes it, as for any
  // mention missing from the text (slack/mrkdwn.ts richToMrkdwn).
  it('the history shows the command’s message as text (the implied mention first)', async () => {
    await start()
    const m = commandMessage()
    const res = await fetch(`${h!.url}/slack/api/conversations.history?channel=${GENERAL.id}`, { headers: { authorization: `Bearer ${TOKEN}` } })
    const body = (await res.json()) as { messages: Array<Record<string, unknown>> }
    expect(body.messages.find((x) => x.ts === m.id)).toEqual({ type: 'message', user: ALICE.id, text: `<@${ME.id}> /deploy produção`, ts: m.id })
  })
})

describe('slash_commands — the payload (item 5)', () => {
  it('each field; thread_ts only in a thread; no protocol id', async () => {
    await start()
    const s = await sock()
    const m = commandMessage('')
    live(m)
    const p = payloadOf(await s.next((x) => x.type === 'slash_commands'))
    expect(p).toEqual({
      command: '/deploy',
      text: '',
      channel_id: GENERAL.id,
      channel_name: GENERAL.name,
      user_id: ALICE.id,
      user_name: ALICE.name,
      team_id: ME.workspace,
      api_app_id: BOT,
      trigger_id: expect.stringMatching(/^[0-9a-f]{32}$/) as unknown,
      response_url: expect.stringMatching(new RegExp(`^${h!.url}/slack/response/[0-9a-f]{64}$`)) as unknown,
      message_ts: m.id,
    })
    expect(idLeaks(p)).toEqual([])
    const root = said('a raiz', { mentionsMe: false, mentions: [] })
    const reply = commandMessage('homologação', { thread: root.id })
    live(reply)
    await expect.poll(() => commands(s).length).toBe(2)
    expect(payloadOf(commands(s)[1]!)).toMatchObject({ text: 'homologação', message_ts: reply.id, thread_ts: root.id })
  })

  it('in a direct conversation: channel_name `directmessage`', async () => {
    await start()
    const s = await sock()
    const m = commandMessage('produção', { conversation: DM.id })
    live(m)
    expect(payloadOf(await s.next((x) => x.type === 'slash_commands'))).toMatchObject({ channel_id: DM.id, channel_name: 'directmessage' })
  })
})

describe('slash_commands — the response (items 6–7)', () => {
  async function command(over: Partial<ApiMessage> = {}): Promise<{ s: RawSocket; f: Frame; m: ApiMessage; url: string }> {
    const s = await sock()
    const m = commandMessage('produção', over)
    live(m)
    const f = await s.next((x) => x.type === 'slash_commands')
    return { s, f, m, url: payloadOf(f).response_url as string }
  }

  it('an ack with a payload → a reply in the command’s thread (the thread it was sent in); response_type makes no difference', async () => {
    await start()
    const root = said('a raiz', { mentionsMe: false, mentions: [] })
    const { s, f } = await command({ thread: root.id })
    s.send({ envelope_id: f.envelope_id, payload: { response_type: 'ephemeral', text: 'só para você' } })
    await expect.poll(() => posts().length).toBe(1)
    expect(posts()[0]).toMatchObject({ conversation: GENERAL.id, text: 'só para você', thread: root.id })
  })

  it('an empty ack writes nothing; replace_original/delete_original are ignored with a line (and an ack of only them writes nothing)', async () => {
    await start()
    const a = await command()
    a.s.send({ envelope_id: a.f.envelope_id })
    const b = await command()
    b.s.send({ envelope_id: b.f.envelope_id, payload: { replace_original: true, delete_original: 'true' } })
    await tick(80)
    expect(posts()).toEqual([])
    expect(h!.logs.filter((l) => l.evt === 'slash-response-flag-ignored')).toEqual([
      { evt: 'slash-response-flag-ignored', flag: 'replace_original' },
      { evt: 'slash-response-flag-ignored', flag: 'delete_original' },
    ])
  })

  it('two sockets: one envelope each; only the first ack counts', async () => {
    await start()
    const s1 = await sock()
    const s2 = await sock()
    live(commandMessage())
    const f1 = await s1.next((x) => x.type === 'slash_commands')
    const f2 = await s2.next((x) => x.type === 'slash_commands')
    expect(payloadOf(f1).response_url).toBe(payloadOf(f2).response_url)
    s1.send({ envelope_id: f1.envelope_id, payload: { text: 'primeiro' } })
    await expect.poll(() => posts().length).toBe(1)
    s2.send({ envelope_id: f2.envelope_id, payload: { text: 'segundo' } })
    await expect.poll(() => h!.logs.filter((l) => l.evt === 'ack-payload-ignored').length).toBe(1)
    expect(posts().map((p) => p.text)).toEqual(['primeiro'])
  })

  it('the response_url: with no Bearer, HTTP 200 and a reply in the thread; flags ignored with a line; nothing to write → 200, nothing written', async () => {
    await start()
    const { m, url } = await command()
    expect(await post(url, { text: 'Feito', replace_original: true })).toEqual({ status: 200, body: { ok: true } })
    expect(await post(url, { delete_original: true })).toEqual({ status: 200, body: { ok: true } })
    expect(posts()).toEqual([{ op: 'post', conversation: GENERAL.id, text: 'Feito', thread: m.id }])
    expect(h!.logs.filter((l) => l.evt === 'slash-response-flag-ignored').map((l) => l.flag)).toEqual(['replace_original', 'delete_original'])
    // A broken body is refused (and spends a use, as the card's ticket does).
    const raw = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' })
    expect(raw.status).toBe(400)
  })

  it(`${RESPONSE_USES} uses, then expired_url`, async () => {
    await start()
    const { url } = await command()
    for (let i = 0; i < RESPONSE_USES; i++) expect((await post(url, { text: `v${i}` })).status).toBe(200)
    expect(await post(url, { text: 'sexta' })).toEqual({ status: 404, body: { ok: false, error: 'expired_url' } })
    expect(posts()).toHaveLength(RESPONSE_USES)
  })

  it('30 min: valid just before, expired_url at the deadline (injected clock)', async () => {
    await start()
    const { url } = await command()
    clock += RESPONSE_TTL_MS - 1
    expect((await post(url, { text: 'a tempo' })).status).toBe(200)
    clock += 1
    expect(await post(url, { text: 'tarde' })).toEqual({ status: 404, body: { ok: false, error: 'expired_url' } })
  })

  it('the reply takes the chat.postMessage path: an id shape in the text is refused before any effect', async () => {
    await start()
    const { url } = await command()
    const r = await post(url, { text: 'veja @alice:example.org' })
    expect(r.status).toBe(500)
    expect(posts()).toEqual([])
    expect(h!.logs.some((l) => l.evt === 'leak-blocked')).toBe(true)
  })
})
