import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { App, LogLevel } from '@slack/bolt'
import { RESPONSE_TTL_MS } from '../../src/api/slack/response'
import { open, type Frame, type RawSocket } from '../support/slack-socket'
import { ALICE, BOB, BOT, GENERAL, GONE, ME, TOKEN, call, createWorld, idLeaks, startSlack, type SlackHarness, type SlackStart } from '../support/slack-world'
import { fakeApprovals, type FakeApprovals } from '../support/slack-approvals'

// The approval card's click on the Slack layer (A3-4; PLANO-AGENTES §0.3.17): `block_actions` in an
// `interactive` envelope, the response_url, and the layer as a consumer of the bus while a socket is open.

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

async function start(opts: SlackStart = {}): Promise<SlackHarness> {
  dir = await mkdtemp(join(tmpdir(), 'slack-interactive-'))
  file = join(dir, 'slack-cards.json')
  const world = createWorld()
  approvals = fakeApprovals(world)
  h = await startSlack({ world, approvals, cardsFile: file, ...opts })
  return h
}

const button = (label: string, over: Record<string, unknown> = {}) => ({ type: 'button', text: { type: 'plain_text', text: label }, ...over })
// A card through chat.postMessage: two buttons whose action_ids are off the option rule (positional ids).
async function card(text = 'Publicar a versão 2.1?'): Promise<string> {
  const res = await call(h!.client(), 'chat.postMessage', {
    channel: GENERAL.id,
    text,
    blocks: [{ type: 'actions', block_id: 'release', elements: [button('Aprovar', { action_id: 'Approve.Release', value: 'release-2.1', style: 'primary' }), button('Rejeitar', { action_id: 'Reject.Release', style: 'danger' })] }],
  })
  return res.ts as string
}
// The person answered: the core's state, then its event on the bus.
function answer(ts: string, option: string): void {
  approvals.answer(GENERAL.id, ts, option, ALICE.id, AT)
  h!.world.emit({ type: 'approval.answered', conversation: GENERAL.id, id: ts, option, by: ALICE.id, at: AT })
}
const interactive = (s: RawSocket): Frame[] => s.frames.filter((f) => f.type === 'interactive')
const payloadOf = (f: Frame): Record<string, unknown> => f.payload as Record<string, unknown>
const entries = async (): Promise<Array<{ id: string }>> => (JSON.parse(await readFile(file, 'utf8')) as { cards: Array<{ id: string }> }).cards
const sock = async (): Promise<RawSocket> => {
  const s = await open(h!)
  sockets.push(s)
  await s.next((f) => f.type === 'hello')
  return s
}
const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('block_actions — Bolt 5.1.0 with no patch', () => {
  it('the click reaches app.action with the original action_id, block_id and value and the person; respond() replaces the request', async () => {
    await start()
    app = new App({ token: TOKEN, appToken: TOKEN, socketMode: true, clientOptions: { slackApiUrl: `${h!.url}/slack/api/` }, logLevel: LogLevel.ERROR })
    const got: Array<{ body: Record<string, unknown>; action: Record<string, unknown> }> = []
    app.action(/.+/, async ({ ack, body, action, respond }) => {
      await ack()
      got.push({ body: body as unknown as Record<string, unknown>, action: action as unknown as Record<string, unknown> })
      await respond({ replace_original: true, text: 'Aprovado por *Alice*' })
    })
    await app.start()
    const ts = await card()
    answer(ts, 'b1')
    await expect.poll(() => got.length).toBe(1)
    expect(got[0]!.action).toMatchObject({ type: 'button', action_id: 'Approve.Release', block_id: 'release', value: 'release-2.1', text: { type: 'plain_text', text: 'Aprovar' } })
    expect(got[0]!.body).toMatchObject({ type: 'block_actions', user: { id: ALICE.id }, channel: { id: GENERAL.id }, team: { id: ME.workspace }, container: { message_ts: ts } })
    // respond() → the chat.update path: the request edited; the card was answered, so no close.
    await expect.poll(() => h!.world.calls.filter((c) => c.op === 'edit').length).toBe(1)
    expect(h!.world.calls.find((c) => c.op === 'edit')).toMatchObject({ conversation: GENERAL.id, ts, text: 'Aprovado por Alice' })
    expect(approvals.calls.filter((c) => c.op === 'close')).toEqual([])
    // The ack took the entry out of the file.
    await expect.poll(entries).toEqual([])
    expect(idLeaks(got)).toEqual([])
  })
})

describe('block_actions — the envelope', () => {
  it('the whole payload, in an interactive envelope that accepts a response payload', async () => {
    await start()
    const s = await sock()
    const ts = await card()
    answer(ts, 'b2')
    const f = await s.next((x) => x.type === 'interactive')
    expect(f).toMatchObject({ type: 'interactive', accepts_response_payload: true, retry_attempt: 0, retry_reason: '' })
    const p = payloadOf(f)
    expect(p).toEqual({
      type: 'block_actions',
      token: '',
      api_app_id: BOT,
      team: { id: ME.workspace, domain: '' },
      enterprise: null,
      is_enterprise_install: false,
      user: { id: ALICE.id, username: ALICE.name, name: ALICE.name, team_id: ME.workspace },
      channel: { id: GENERAL.id, name: GENERAL.name },
      container: { type: 'message', message_ts: ts, channel_id: GENERAL.id, is_ephemeral: false },
      message: { type: 'message', user: ME.id, text: 'Publicar a versão 2.1?', ts },
      state: { values: {} },
      trigger_id: expect.stringMatching(/^[0-9a-f]{32}$/) as unknown,
      response_url: expect.stringMatching(new RegExp(`^${h!.url}/slack/response/[0-9a-f]{64}$`)) as unknown,
      actions: [{ type: 'button', action_id: 'Reject.Release', block_id: 'release', text: { type: 'plain_text', text: 'Rejeitar', emoji: true }, style: 'danger', action_ts: '1732000500.123000' }],
    })
    expect(idLeaks(p)).toEqual([])
    s.send({ envelope_id: f.envelope_id })
    await expect.poll(entries).toEqual([])
    expect(h!.logs.filter((l) => l.evt === 'ack-payload-ignored' || l.evt === 'slack-card-unknown')).toEqual([])
  })

  it('a card with no entry (sent by the native API or the MCP) → action_id = the option, block_id `approval`, no value, one line', async () => {
    await start()
    const s = await sock()
    const sent = await approvals.request(GENERAL.id, { text: 'Pelo MCP?', options: [{ id: 'approve', label: 'Aprovar' }] })
    answer(sent.id, 'approve')
    const f = await s.next((x) => x.type === 'interactive')
    expect((payloadOf(f).actions as unknown[])[0]).toEqual({ type: 'button', action_id: 'approve', block_id: 'approval', text: { type: 'plain_text', text: 'Aprovar', emoji: true }, action_ts: '1732000500.123000' })
    expect(h!.logs).toContainEqual({ evt: 'slack-card-unknown' })
    expect(JSON.stringify(h!.logs.filter((l) => l.evt === 'slack-card-unknown'))).toBe('[{"evt":"slack-card-unknown"}]')
  })

  it('an ack with a response payload: ignored with one line; the entry leaves', async () => {
    await start()
    const s = await sock()
    const ts = await card()
    answer(ts, 'b1')
    const f = await s.next((x) => x.type === 'interactive')
    s.send({ envelope_id: f.envelope_id, payload: { text: 'resposta no ack' } })
    await expect.poll(entries).toEqual([])
    expect(h!.logs).toContainEqual({ evt: 'ack-payload-ignored' })
  })

  it('no ack after the redeliveries: the drop line, and the entry stays', async () => {
    await start({ socket: { ackTimeoutMs: 20 } })
    const s = await sock()
    const ts = await card()
    answer(ts, 'b1')
    await expect.poll(() => h!.logs.some((l) => l.evt === 'envelope-dropped' && l.type === 'interactive' && l.reason === 'timeout')).toBe(true)
    expect(interactive(s).map((f) => f.retry_attempt)).toEqual([0, 1, 2, 3])
    expect((await entries()).map((e) => e.id)).toEqual([ts])
  })

  it('two sockets: one envelope each, each with its own id; the first ack takes the entry', async () => {
    await start()
    const a = await sock()
    const b = await sock()
    const ts = await card()
    answer(ts, 'b1')
    const fa = await a.next((x) => x.type === 'interactive')
    const fb = await b.next((x) => x.type === 'interactive')
    expect(fa.envelope_id).not.toBe(fb.envelope_id)
    expect(payloadOf(fa).response_url).toBe(payloadOf(fb).response_url)
    b.send({ envelope_id: fb.envelope_id })
    await expect.poll(entries).toEqual([])
  })

  it('the Slack edge: an id shape in a kept value blocks the frame (leak-blocked), nothing leaves', async () => {
    await start()
    const s = await sock()
    const sent = await approvals.request(GENERAL.id, { text: 'ok?', options: [{ id: 'approve', label: 'Aprovar' }] })
    // An entry the layer would never write (its preflight refuses it): written by hand.
    await writeFile(file, JSON.stringify({ cards: [{ conversation: GENERAL.id, id: sent.id, block_id: 'b', actions: [{ option: 'approve', action_id: 'a', value: 'x @u-abcdefghijkl:chat.example.com' }], at: 1 }] }))
    await h!.close()
    h = await startSlack({ world: h!.world, approvals, cardsFile: file })
    const s2 = await sock()
    answer(sent.id, 'approve')
    await expect.poll(() => h!.logs.some((l) => l.evt === 'leak-blocked' && String(l.path).includes('.actions[0].value'))).toBe(true)
    await tick(50)
    expect(interactive(s2)).toEqual([])
    expect(interactive(s)).toEqual([])
  })
})

describe('block_actions — a card of a chain', () => {
  it('the click on the 2nd and 3rd cards comes with container.message_ts = the origin; message is the card answered; its response_url acts on the live card', async () => {
    await start()
    const s = await sock()
    const origin = await card()
    answer(origin, 'b1')
    const first = await s.next((x) => x.type === 'interactive')
    expect(payloadOf(first).container).toMatchObject({ message_ts: origin })
    s.send({ envelope_id: first.envelope_id })
    const blocks = (n: number) => [{ type: 'actions', block_id: 'release', elements: [button('Aprovar', { action_id: `Approve.${n}` }), button('Rejeitar', { action_id: `Reject.${n}` })] }]
    const second = ((await call(h!.client(), 'chat.update', { channel: GENERAL.id, ts: origin, text: 'Segunda?', blocks: blocks(2) })).message as { ts: string }).ts
    answer(second, 'b2')
    const click2 = await s.next((x) => x.type === 'interactive' && x.envelope_id !== first.envelope_id)
    s.send({ envelope_id: click2.envelope_id })
    const p2 = payloadOf(click2)
    expect(p2.container).toEqual({ type: 'message', message_ts: origin, channel_id: GENERAL.id, is_ephemeral: false })
    expect(p2.message).toMatchObject({ ts: second, text: 'Segunda?' })
    expect((p2.actions as Array<Record<string, unknown>>)[0]).toMatchObject({ action_id: 'Reject.2', block_id: 'release' })
    expect(idLeaks(p2)).toEqual([])
    const third = ((await call(h!.client(), 'chat.update', { channel: GENERAL.id, ts: origin, text: 'Terceira?', blocks: blocks(3) })).message as { ts: string }).ts
    answer(third, 'b1')
    const click3 = await s.next((x) => x.type === 'interactive' && x.envelope_id !== first.envelope_id && x.envelope_id !== click2.envelope_id)
    s.send({ envelope_id: click3.envelope_id })
    expect(payloadOf(click3).container).toMatchObject({ message_ts: origin })
    // The 2nd card's response_url (an older card of the chain) acts on the live card (the 3rd).
    const res = await fetch(p2.response_url as string, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ replace_original: true, text: 'Fim' }) })
    expect(res.status).toBe(200)
    expect(h!.world.calls.filter((c) => c.op === 'edit')).toEqual([expect.objectContaining({ ts: third, text: 'Fim' })])
  })
})

describe('response_url', () => {
  let clock = 1_000_000
  const startClocked = () => start({ now: () => clock })
  async function urlOfClick(): Promise<{ url: string; ts: string }> {
    const s = await sock()
    const ts = await card()
    answer(ts, 'b1')
    const f = await s.next((x) => x.type === 'interactive')
    s.send({ envelope_id: f.envelope_id })
    return { url: payloadOf(f).response_url as string, ts }
  }
  const post = async (url: string, body: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }

  it('replace_original with text → the chat.update path, HTTP 200 { ok: true }, with no Bearer; an open card is closed', async () => {
    await startClocked()
    const s = await sock()
    const ts = await card()
    // The click of a card still open (an answer the seal has not closed yet).
    h!.world.emit({ type: 'approval.answered', conversation: GENERAL.id, id: ts, option: 'b1', by: ALICE.id, at: AT })
    const f = await s.next((x) => x.type === 'interactive')
    const r = await post(payloadOf(f).response_url as string, { replace_original: true, text: 'Feito' })
    expect(r).toEqual({ status: 200, body: { ok: true } })
    expect(h!.world.calls.filter((c) => c.op === 'edit')).toEqual([{ op: 'edit', conversation: GENERAL.id, ts, text: 'Feito' }])
    expect(approvals.calls.filter((c) => c.op === 'close')).toEqual([{ op: 'close', conversation: GENERAL.id, ts }])
  })

  it('replace_original with a markdown block → the message edited with the Markdown rendered', async () => {
    await startClocked()
    const { url, ts } = await urlOfClick()
    expect(await post(url, { replace_original: true, blocks: [{ type: 'markdown', text: 'Shipped **2.1**' }] })).toEqual({ status: 200, body: { ok: true } })
    expect(h!.world.calls.filter((c) => c.op === 'edit')).toEqual([
      { op: 'edit', conversation: GENERAL.id, ts, text: 'Shipped 2.1', rich: [{ t: 'p', children: [{ t: 'text', text: 'Shipped ' }, { t: 'strong', children: [{ t: 'text', text: '2.1' }] }] }] },
    ])
  })

  it('no replace_original, or a delete_original → 400 invalid_arguments', async () => {
    await startClocked()
    const { url } = await urlOfClick()
    expect(await post(url, { text: 'x' })).toEqual({ status: 400, body: { ok: false, error: 'invalid_arguments' } })
    expect(await post(url, { replace_original: true, delete_original: true, text: 'x' })).toEqual({ status: 400, body: { ok: false, error: 'invalid_arguments' } })
    expect(h!.world.calls.filter((c) => c.op === 'edit')).toEqual([])
  })

  it('an id shape in the new text → 400 invalid_arguments by the chat.update preflight, nothing edited', async () => {
    await startClocked()
    const { url } = await urlOfClick()
    expect(await post(url, { replace_original: true, text: 'veja @alice:example.org' })).toEqual({ status: 400, body: { ok: false, error: 'invalid_arguments' } })
    expect(h!.logs).toContainEqual({ evt: 'leak-blocked', where: 'slack chat.update', path: '$.text', pattern: 'mxid' })
    expect(h!.world.calls.filter((c) => c.op === 'edit')).toEqual([])
  })

  it('replace_original with an actions block → the chat.update path: an answered card gets a new card in its place', async () => {
    await startClocked()
    const { url, ts } = await urlOfClick()
    const blocks = [{ type: 'actions', block_id: 'release', elements: [button('Aprovar', { action_id: 'Approve.Release', style: 'primary' }), button('Rejeitar', { action_id: 'Reject.Release', style: 'danger' })] }]
    expect(await post(url, { replace_original: true, text: 'Segunda aprovação?', blocks })).toEqual({ status: 200, body: { ok: true } })
    const requests = approvals.calls.filter((c) => c.op === 'request')
    expect(requests).toHaveLength(2)
    expect(requests[1]).toMatchObject({ text: 'Segunda aprovação?', options: [{ id: 'b1' }, { id: 'b2' }] })
    expect(h!.world.calls.filter((c) => c.op === 'edit')).toEqual([])
    const aliases = (JSON.parse(await readFile(file, 'utf8')) as { aliases: Array<{ origin: string }> }).aliases
    expect(aliases.map((a) => a.origin)).toEqual([ts])
  })

  it('an unknown ticket → 404 expired_url', async () => {
    await startClocked()
    expect(await post(`${h!.url}/slack/response/${'0'.repeat(64)}`, { replace_original: true, text: 'x' })).toEqual({ status: 404, body: { ok: false, error: 'expired_url' } })
    expect(await post(`${h!.url}/slack/response/nope`, { replace_original: true, text: 'x' })).toEqual({ status: 404, body: { ok: false, error: 'expired_url' } })
  })

  it('30 min: valid just before, expired_url at the deadline (injected clock)', async () => {
    await startClocked()
    const { url } = await urlOfClick()
    clock += RESPONSE_TTL_MS - 1
    expect((await post(url, { replace_original: true, text: 'a tempo' })).status).toBe(200)
    clock += 1
    expect(await post(url, { replace_original: true, text: 'tarde' })).toEqual({ status: 404, body: { ok: false, error: 'expired_url' } })
  })

  it('5 uses (a refused call counts too), then expired_url', async () => {
    await startClocked()
    const { url } = await urlOfClick()
    expect((await post(url, { text: 'sem replace' })).status).toBe(400)
    for (let i = 0; i < 4; i++) expect((await post(url, { replace_original: true, text: `v${i}` })).status).toBe(200)
    expect(await post(url, { replace_original: true, text: 'sexta' })).toEqual({ status: 404, body: { ok: false, error: 'expired_url' } })
  })

  it('revoked → 503; a web page (Origin) is refused by the server first', async () => {
    await startClocked()
    const { url } = await urlOfClick()
    expect((await post(url, { replace_original: true, text: 'x' }, { origin: 'https://evil.example' })).status).toBe(403)
    await h!.api.revoke(0, 0)
    expect((await post(url, { replace_original: true, text: 'x' })).status).toBe(503)
  })
})

describe('the Slack socket as a consumer of the bus', () => {
  it('an answer with no socket open is kept; the first socket gets it once (after hello), a second one does not', async () => {
    await start()
    const ts = await card()
    answer(ts, 'b1')
    await tick()
    const a = await sock()
    const f = await a.next((x) => x.type === 'interactive')
    expect(a.frames.indexOf(f)).toBeGreaterThan(a.frames.findIndex((x) => x.type === 'hello'))
    expect((payloadOf(f).actions as Array<{ action_id: string }>)[0]?.action_id).toBe('Approve.Release')
    const b = await sock()
    await tick(100)
    expect(interactive(a)).toHaveLength(1)
    expect(interactive(b)).toEqual([])
  })

  it('→ 0 sockets closes the consumer: the next answer is kept again and goes to the next socket', async () => {
    await start()
    const a = await sock()
    a.ws.close()
    await expect.poll(() => h!.logs.some((l) => l.evt === 'socket-close' && l.connections === 0)).toBe(true)
    const ts = await card()
    answer(ts, 'b2')
    await tick()
    const b = await sock()
    const f = await b.next((x) => x.type === 'interactive')
    expect((payloadOf(f).actions as Array<{ action_id: string }>)[0]?.action_id).toBe('Reject.Release')
  })

  it('an SSE stream that opens first takes the kept answer (one consumer list for every transport)', async () => {
    await start()
    const ts = await card()
    answer(ts, 'b1')
    await tick()
    const ctrl = new AbortController()
    const res = await fetch(`${h!.url}/v1/events`, { headers: { authorization: `Bearer ${TOKEN}` }, signal: ctrl.signal })
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
    let buf = ''
    while (!buf.includes(': open')) buf += (await reader.read()).value ?? ''
    ctrl.abort()
    expect(buf).toContain('event: approval.answered')
    const a = await sock()
    await tick(100)
    expect(interactive(a)).toEqual([])
  })
})

// A click in a channel whose name a person wrote with the vocabulary reaches the app: the channel's and the person's
// names in the payload take the id shapes only.
describe('block_actions — names written by people', () => {
  it('a click in a channel named "Verificação de contas", by "Verônica (verificação)", reaches the app', async () => {
    await start()
    const s = await sock()
    const ts = await card()
    h!.world.read.conversation = (id) => ({ ...GENERAL, id, name: 'Verificação de contas' })
    h!.world.read.person = (id) => ({ ...ALICE, id, name: 'Verônica (verificação)' })
    answer(ts, 'b1')
    const p = payloadOf(await s.next((x) => x.type === 'interactive'))
    expect(p).toMatchObject({
      type: 'block_actions',
      channel: { id: GENERAL.id, name: 'Verificação de contas' },
      user: { id: ALICE.id, username: 'Verônica (verificação)', name: 'Verônica (verificação)' },
    })
    expect(h!.logs.filter((l) => l.evt === 'leak-blocked')).toEqual([])
  })
})

// ADR-104 (Aprovadores 2): a card created by the native API that asks for several answers reaches the
// Slack layer as one `block_actions` per answer — none is deduplicated, the card unknown to the layer's file.
describe('block_actions — a card that asks for several answers (ADR-104)', () => {
  it('three approval.answered of the same card → three interactive envelopes, one per person, in order', async () => {
    await start()
    const s = await sock()
    const ts = '1732000400.000100'
    const people = [ALICE, BOB, GONE]
    people.forEach((p, i) => h!.world.emit({ type: 'approval.answered', conversation: GENERAL.id, id: ts, option: 'approve', by: p.id, at: AT + i, count: i + 1, needed: 3 }))
    await expect.poll(() => interactive(s).length).toBe(3)
    const payloads = interactive(s).map(payloadOf)
    expect(payloads.map((p) => (p.user as { id: string }).id)).toEqual(people.map((p) => p.id))
    expect(payloads.map((p) => (p.container as { message_ts: string }).message_ts)).toEqual([ts, ts, ts])
    expect(payloads.map((p) => (p.actions as Array<{ action_id: string; block_id: string }>)[0])).toMatchObject(people.map(() => ({ action_id: 'approve', block_id: 'approval' })))
    expect(new Set(payloads.map((p) => p.response_url)).size).toBe(3)
    for (const f of interactive(s)) s.send({ envelope_id: f.envelope_id })
    await tick()
    expect(interactive(s)).toHaveLength(3)
    expect(idLeaks(payloads)).toEqual([])
  })
})
