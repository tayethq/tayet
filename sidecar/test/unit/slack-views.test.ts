import { describe, it, expect, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { App, LogLevel } from '@slack/bolt'
import { FormError } from '../../src/core/forms'
import { WriteError } from '../../src/core/write'
import { compose } from '../../src/api/slack/modal'
import { SUBMISSION_TIMEOUT_MS } from '../../src/api/slack/views'
import { RESPONSE_TTL_MS } from '../../src/api/slack/response'
import { tsOfMs } from '../../src/api/slack/translate'
import { manualClock, open, type Frame, type RawSocket } from '../support/slack-socket'
import { ALICE, GENERAL, ME, TOKEN, call, createWorld, idLeaks, message, refusal, startSlack, type SlackHarness, type SlackStart } from '../support/slack-world'
import { fakeApprovals, type FakeApprovals } from '../support/slack-approvals'
import { fakeForms, type FakeForms } from '../support/slack-forms'

// An agent's forms on the Slack layer: views.open with the trigger_id of a click or of a command (the order of the
// checks and their codes), the response_url in private_metadata, and the person's submission as `view_submission`
// with each outcome over the sockets and over HTTP; Bolt 5.1.0 in process with both receivers; the edge; the lines.

let h: SlackHarness | undefined
let app: App | undefined
let rx: Receiver | undefined
const sockets: RawSocket[] = []
let approvals: FakeApprovals
let forms: FakeForms
afterEach(async () => {
  for (const s of sockets.splice(0)) s.ws.terminate()
  await app?.stop().catch(() => {})
  app = undefined
  await h?.close()
  h = undefined
  await rx?.close()
  rx = undefined
})

const t = (text: string) => ({ type: 'plain_text', text })
const MODAL = {
  type: 'modal',
  callback_id: 'edit',
  private_metadata: 'state-1',
  title: t('Editar decisão'),
  submit: t('Salvar'),
  close: t('Cancelar'),
  blocks: [
    { type: 'section', text: { type: 'mrkdwn', text: 'Diga *por que* muda.' } },
    { type: 'input', block_id: 'why', label: t('Motivo'), element: { type: 'plain_text_input', action_id: 'why_input', multiline: true, min_length: 5, initial_value: 'Antes' } },
    { type: 'input', block_id: 'level', optional: true, label: t('Nível'), element: { type: 'radio_buttons', action_id: 'pick', options: [{ text: t('Baixo'), value: 'low' }, { text: t('Alto'), value: 'high' }] } },
  ],
}
const WHY = compose('why', 'why_input')
const LEVEL = compose('level', 'pick')

async function layer(opts: SlackStart & { noForms?: boolean } = {}): Promise<SlackHarness> {
  const world = createWorld()
  approvals = fakeApprovals(world)
  forms = fakeForms()
  h = await startSlack({ world, approvals, ...(opts.noForms !== true && { forms }), ...opts })
  return h
}
const sock = async (): Promise<RawSocket> => {
  const s = await open(h!)
  sockets.push(s)
  await s.next((f) => f.type === 'hello')
  return s
}
const tick = (ms = 40): Promise<void> => new Promise((r) => setTimeout(r, ms))
const payloadOf = (f: Frame): Record<string, unknown> => f.payload as Record<string, unknown>

async function card(): Promise<string> {
  const res = await call(h!.client(), 'chat.postMessage', { channel: GENERAL.id, text: 'Editar?', blocks: [{ type: 'actions', block_id: 'edit', elements: [{ type: 'button', action_id: 'Edit', text: t('Editar') }] }] })
  return res.ts as string
}
function answer(ts: string, at = Date.now()): void {
  approvals.answer(GENERAL.id, ts, 'b1', ALICE.id, at)
  h!.world.emit({ type: 'approval.answered', conversation: GENERAL.id, id: ts, option: 'b1', by: ALICE.id, at })
}
// A click on a fresh card, as the socket receives it (acked): its payload.
async function click(s: RawSocket, at?: number): Promise<Record<string, unknown>> {
  const ts = await card()
  answer(ts, at)
  const f = await s.next((x) => x.type === 'interactive' && payloadOf(x).type === 'block_actions' && (payloadOf(x).container as { message_ts: string }).message_ts === ts)
  s.send({ envelope_id: f.envelope_id })
  return payloadOf(f)
}
const viewsOpen = (trigger: unknown, view: unknown = MODAL, extra: Record<string, unknown> = {}) => call(h!.client(), 'views.open', { trigger_id: trigger, view, ...extra })
const refused = (trigger: unknown, view: unknown = MODAL, extra: Record<string, unknown> = {}) => refusal(h!.client(), 'views.open', { trigger_id: trigger, view, ...extra })
const submissionFrame = (s: RawSocket, n = 1) => s.next((x) => x.type === 'interactive' && payloadOf(x).type === 'view_submission' && s.frames.filter((y) => y.type === 'interactive' && payloadOf(y).type === 'view_submission').length >= n)
// No line carries a trigger_id, a ticket, private_metadata, a label or a value.
const noContentInLogs = (...words: string[]): void => {
  const all = JSON.stringify(h!.logs)
  for (const w of words) expect(all).not.toContain(w)
}
const lines = (evt: string) => h!.logs.filter((l) => l.evt === evt)

describe('views.open — the facade', () => {
  it('without the core\'s forms facade: unknown_method; views.update, views.push and views.publish are unknown_method with it too', async () => {
    await layer({ noForms: true })
    expect(await refused('0'.repeat(32))).toBe('unknown_method')
    await h!.close()
    await layer()
    for (const m of ['views.update', 'views.push', 'views.publish']) expect(await refusal(h!.client(), m, { view: MODAL })).toBe('unknown_method')
  })
})

describe('views.open — a click', () => {
  it('opens the form for the person who clicked: the core gets the origin, the fields and the meta; the view comes back; the trigger_id is spent', async () => {
    await layer()
    const s = await sock()
    const p = await click(s)
    const trigger = p.trigger_id as string
    const res = await viewsOpen(trigger)
    const o = forms.opened[0]!
    expect(o).toMatchObject({ conversation: GENERAL.id, origin: { kind: 'card', card: (p.container as { message_ts: string }).message_ts, person: ALICE.id }, meta: compose('state-1', 'edit') })
    expect(o.form).toMatchObject({ title: 'Editar decisão', submitLabel: 'Salvar' })
    expect((o.form.fields as Array<{ kind: string; id?: string }>).map((f) => [f.kind, f.id])).toEqual([['context', undefined], ['longText', WHY], ['radio', LEVEL]])
    const view = res.view as Record<string, unknown>
    expect(view).toMatchObject({ type: 'modal', callback_id: 'edit', private_metadata: 'state-1', title: { text: 'Editar decisão' }, submit: { text: 'Salvar' }, team_id: ME.workspace })
    expect((view.blocks as Array<{ block_id?: string }>).map((b) => b.block_id)).toEqual([undefined, 'why', 'level'])
    expect(view.id).toMatch(/^V[0-9A-F]{10}$/)
    expect(idLeaks(res)).toEqual([])
    expect(await refused(trigger)).toBe('exchanged_trigger_id')
    expect(forms.opened).toHaveLength(1)
    expect(lines('view-key-dropped')).toEqual([])
    noContentInLogs(trigger, 'state-1', 'Motivo', 'Editar decisão')
  })

  it('the order of the checks and their codes; nothing is spent by an open that fails', async () => {
    await layer()
    const s = await sock()
    const trigger = (await click(s)).trigger_id as string
    expect(await refused('not-a-trigger')).toBe('invalid_trigger_id')
    expect(await refused('0'.repeat(32))).toBe('expired_trigger_id')
    expect(await refused(undefined)).toBe('invalid_arguments')
    expect(await refused(trigger, MODAL, { interactivity_pointer: trigger })).toBe('invalid_arguments')
    // The trigger_id first: a broken modal with a bad trigger_id is a trigger_id error.
    expect(await refused('nope', { type: 'home' })).toBe('invalid_trigger_id')
    expect(await refused(trigger, { ...MODAL, type: 'home' })).toBe('invalid_arguments')
    expect(await refused(trigger, { ...MODAL, blocks: [{ type: 'input', label: t('x'), element: { type: 'users_select' } }] })).toBe('invalid_blocks')
    const big = Array.from({ length: 25 }, (_, i) => ({ type: 'input', block_id: `b${i}`, label: t('L'.repeat(2000)), element: { type: 'plain_text_input', action_id: 'a' } }))
    expect(await refused(trigger, { ...MODAL, blocks: big })).toBe('view_too_large')
    forms.failOpen.push(new FormError('origin_mismatch'))
    expect(await refused(trigger)).toBe('expired_trigger_id')
    forms.failOpen.push(new WriteError('invalid_argument'))
    expect(await refused(trigger)).toBe('invalid_blocks')
    expect(forms.opened).toEqual([])
    await viewsOpen(trigger)
    expect(forms.opened).toHaveLength(1)
  })

  it('an answer more than 60 s old when the click is delivered: expired_trigger_id', async () => {
    await layer()
    const s = await sock()
    const p = await click(s, Date.now() - 61_000)
    expect(await refused(p.trigger_id)).toBe('expired_trigger_id')
  })

  it('several sockets get the same trigger_id; it opens once', async () => {
    await layer()
    const a = await sock()
    const b = await sock()
    const ts = await card()
    answer(ts)
    const [fa, fb] = await Promise.all([a.next((x) => x.type === 'interactive'), b.next((x) => x.type === 'interactive')])
    expect(payloadOf(fa).trigger_id).toBe(payloadOf(fb).trigger_id)
    await viewsOpen(payloadOf(fa).trigger_id)
    expect(await refused(payloadOf(fb).trigger_id)).toBe('exchanged_trigger_id')
  })
})

describe('views.open — a command', () => {
  const command = (ms: number) => {
    const m = message({ id: tsOfMs(ms), conversation: GENERAL.id, author: ALICE.id, text: '/editar', mentionsMe: true, mentions: [ME.id], command: { name: 'editar', args: '' } })
    h!.world.messages.set(GENERAL.id, [m, ...(h!.world.messages.get(GENERAL.id) ?? [])])
    h!.world.emit({ type: 'mention', conversation: GENERAL.id, message: m })
    return m
  }

  it('the trigger_id of a slash command opens a form from the command\'s message; one more than 60 s old does not', async () => {
    await layer()
    const s = await sock()
    const m = command(Date.now())
    const f = await s.next((x) => x.type === 'slash_commands')
    s.send({ envelope_id: f.envelope_id })
    await viewsOpen(payloadOf(f).trigger_id)
    expect(forms.opened[0]!.origin).toEqual({ kind: 'command', message: m.id })
    command(Date.now() - 61_000)
    const old = await s.next((x) => x.type === 'slash_commands' && x !== f)
    expect(await refused(payloadOf(old).trigger_id)).toBe('expired_trigger_id')
  })
})

describe('the response_url in private_metadata', () => {
  it('written with the ticket replaced by a derived value of the same length; put back in the submission', async () => {
    await layer()
    const s = await sock()
    const p = await click(s)
    const url = p.response_url as string
    const ticket = url.slice(-64)
    const pm = JSON.stringify({ reply: url, n: 1 })
    const res = await viewsOpen(p.trigger_id, { ...MODAL, private_metadata: pm })
    expect((res.view as { private_metadata: string }).private_metadata).toBe(pm)
    const meta = forms.opened[0]!.meta as string
    expect(meta).not.toContain(ticket)
    expect(meta).toHaveLength(compose(pm, 'edit').length)
    forms.submit({ [WHY]: 'Porque sim' })
    const f = await submissionFrame(s)
    expect((payloadOf(f).view as { private_metadata: string }).private_metadata).toBe(pm)
    s.send({ envelope_id: f.envelope_id })
    await expect.poll(() => forms.results.length).toBe(1)
    noContentInLogs(ticket, pm)
  })

  // The derived value the app gets back instead of the ticket: same URL prefix, same length, not the ticket.
  const derivedOf = (f: Frame, url: string): string => {
    const got = JSON.parse((payloadOf(f).view as { private_metadata: string }).private_metadata) as { reply: string }
    expect(got.reply).not.toBe(url)
    expect(got.reply).toHaveLength(url.length)
    expect(got.reply.slice(0, -64)).toBe(url.slice(0, -64))
    return got.reply
  }
  const postUrl = async (url: string) => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ replace_original: true, text: 'x' }) })
    return { status: res.status, body: (await res.json()) as Record<string, unknown> }
  }

  it('the ticket expired before the submission: the app gets the derived value, and its URL is 404 expired_url', async () => {
    let clock = Date.now()
    await layer({ now: () => clock })
    const s = await sock()
    const p = await click(s)
    const url = p.response_url as string
    await viewsOpen(p.trigger_id, { ...MODAL, private_metadata: JSON.stringify({ reply: url }) })
    clock += RESPONSE_TTL_MS
    forms.submit({ [WHY]: 'Porque sim' })
    const f = await submissionFrame(s)
    const derived = derivedOf(f, url)
    expect(await postUrl(derived)).toEqual({ status: 404, body: { ok: false, error: 'expired_url' } })
    noContentInLogs(url.slice(-64))
  })

  it('after a restart (a new secret, nothing kept): the app gets the derived value, and its URL is 404 expired_url', async () => {
    await layer()
    const port = Number(new URL(h!.url).port)
    const first = await sock()
    const p = await click(first)
    const url = p.response_url as string
    await viewsOpen(p.trigger_id, { ...MODAL, private_metadata: JSON.stringify({ reply: url }) })
    const opened = forms.opened[0]!
    for (const x of sockets.splice(0)) x.ws.terminate()
    await h!.close()
    // The new run on the same port: the form opened by the previous run is submitted through it.
    await layer({ port })
    forms.opened.push(opened)
    const s = await sock()
    forms.submit({ [WHY]: 'Porque sim' })
    const f = await submissionFrame(s)
    const derived = derivedOf(f, url)
    expect(await postUrl(derived)).toEqual({ status: 404, body: { ok: false, error: 'expired_url' } })
  })
})

describe('view_submission over the sockets', () => {
  const opened = async (): Promise<RawSocket> => {
    await layer()
    const s = await sock()
    await viewsOpen((await click(s)).trigger_id)
    return s
  }

  it('the payload: the fields Bolt reads, state.values per element, the view rebuilt; no labels', async () => {
    const s = await opened()
    forms.submit({ [WHY]: 'Porque sim' })
    const f = await submissionFrame(s)
    expect(f).toMatchObject({ accepts_response_payload: true, retry_attempt: 0 })
    const p = payloadOf(f)
    expect(p).toMatchObject({ type: 'view_submission', team: { id: ME.workspace }, user: { id: ALICE.id, name: ALICE.name }, token: '', enterprise: null, is_enterprise_install: false, response_urls: [] })
    const view = p.view as Record<string, unknown>
    expect(view).toMatchObject({ callback_id: 'edit', private_metadata: 'state-1', id: expect.stringMatching(/^V/) as unknown })
    expect(view.state).toEqual({ values: { why: { why_input: { type: 'plain_text_input', value: 'Porque sim' } }, level: { pick: { type: 'radio_buttons', selected_option: null } } } })
    expect(p).not.toHaveProperty('labels')
    expect(idLeaks(p)).toEqual([])
    s.send({ envelope_id: f.envelope_id })
    await expect.poll(() => forms.results).toEqual([{ conversation: GENERAL.id, submission: expect.any(String) as unknown, outcome: { ok: true } }])
    noContentInLogs('Porque sim', 'Motivo')
  })

  const cases: Array<[string, Record<string, unknown> | undefined, unknown]> = [
    ['an empty ack', undefined, { ok: true }],
    ['clear', { response_action: 'clear' }, { ok: true }],
    ['errors (the keys that are no block of a field leave)', { response_action: 'errors', errors: { why: 'Curto demais', nope: 'x', level: '' } }, { errors: { [WHY]: 'Curto demais' } }],
    ['errors over 300 characters, cut', { response_action: 'errors', errors: { level: 'é'.repeat(400) } }, { errors: { [LEVEL]: 'é'.repeat(300) } }],
    ['errors with no field left', { response_action: 'errors', errors: { nope: 'x' } }, { refused: true }],
    ['update', { response_action: 'update', view: MODAL }, { refused: true }],
    ['push', { response_action: 'push', view: MODAL }, { refused: true }],
    ['an invalid body', { something: 1 }, { refused: true }],
    ['errors that is no object', { response_action: 'errors', errors: 'x' }, { refused: true }],
  ]
  for (const [name, ack, outcome] of cases) {
    it(`${name} → ${JSON.stringify(outcome).slice(0, 40)}`, async () => {
      const s = await opened()
      forms.submit({ [WHY]: 'Porque sim' })
      const f = await submissionFrame(s)
      s.send({ envelope_id: f.envelope_id, ...(ack !== undefined && { payload: ack }) })
      await expect.poll(() => forms.results.map((r) => r.outcome)).toEqual([outcome])
    })
  }

  it('a socket closed before its ack, and no socket open: refused at once', async () => {
    const s = await opened()
    forms.submit({ [WHY]: 'Porque sim' })
    await submissionFrame(s)
    s.ws.close()
    await expect.poll(() => forms.results.map((r) => r.outcome)).toEqual([{ refused: true }])
    await expect.poll(() => h!.api.bus).toBeDefined()
    await tick(100)
    forms.submit({ [WHY]: 'Porque sim' })
    await expect.poll(() => forms.results.map((r) => r.outcome)).toEqual([{ refused: true }, { refused: true }])
    expect(lines('view-submission-refused').map((l) => l.reason)).toEqual(['closed', 'no-socket'])
  })

  it('two sockets: only the first ack counts', async () => {
    const a = await opened()
    const b = await sock()
    forms.submit({ [WHY]: 'Porque sim' })
    const [fa, fb] = await Promise.all([submissionFrame(a), submissionFrame(b)])
    b.send({ envelope_id: fb.envelope_id, payload: { response_action: 'errors', errors: { why: 'Não' } } })
    await expect.poll(() => forms.results.length).toBe(1)
    a.send({ envelope_id: fa.envelope_id })
    await tick()
    expect(forms.results.map((r) => r.outcome)).toEqual([{ errors: { [WHY]: 'Não' } }])
  })

  it('one attempt: no ack in 10 s → nothing is written, one line; a late ack is ignored with a line', async () => {
    const clock = manualClock(Date.now())
    await layer({ socket: { clock } })
    const s = await sock()
    await viewsOpen((await click(s)).trigger_id)
    forms.submit({ [WHY]: 'Porque sim' })
    const f = await submissionFrame(s)
    clock.advance(SUBMISSION_TIMEOUT_MS - 1)
    await tick()
    expect(lines('view-submission-unanswered')).toEqual([])
    clock.advance(1)
    await expect.poll(() => lines('view-submission-unanswered')).toHaveLength(1)
    s.send({ envelope_id: f.envelope_id })
    await expect.poll(() => lines('ack-unknown')).toHaveLength(1)
    expect(s.frames.filter((x) => x.type === 'interactive' && payloadOf(x).type === 'view_submission')).toHaveLength(1)
    expect(forms.results).toEqual([])
  })

  it('a block_actions ack still ignores its payload', async () => {
    await layer()
    const s = await sock()
    const ts = await card()
    answer(ts)
    const f = await s.next((x) => x.type === 'interactive')
    s.send({ envelope_id: f.envelope_id, payload: { response_action: 'errors', errors: { why: 'x' } } })
    await expect.poll(() => lines('ack-payload-ignored')).toHaveLength(1)
    expect(forms.results).toEqual([])
  })
})

describe('the edge', () => {
  it('a block_id named room_id passes both ways; an id shape in a person\'s value is refused with leak-blocked and never sent', async () => {
    await layer()
    const s = await sock()
    const view = { ...MODAL, blocks: [{ type: 'input', block_id: 'room_id', label: t('Sala'), element: { type: 'plain_text_input', action_id: 'event_id' } }] }
    const res = await viewsOpen((await click(s)).trigger_id, view)
    expect((res.view as { blocks: Array<{ block_id: string }> }).blocks[0]!.block_id).toBe('room_id')
    const id = compose('room_id', 'event_id')
    forms.submit({ [id]: 'a sala de sempre' })
    const f = await submissionFrame(s)
    expect((payloadOf(f).view as { state: { values: Record<string, unknown> } }).state.values).toHaveProperty('room_id')
    s.send({ envelope_id: f.envelope_id })
    await expect.poll(() => forms.results.length).toBe(1)
    forms.submit({ [id]: 'fale com @bob:chat.example.com' })
    await expect.poll(() => forms.results.map((r) => r.outcome)).toEqual([{ ok: true }, { refused: true }])
    expect(lines('leak-blocked').length).toBeGreaterThan(0)
    expect(lines('view-submission-refused').map((l) => l.reason)).toEqual(['leak'])
    expect(s.frames.filter((x) => x.type === 'interactive' && payloadOf(x).type === 'view_submission')).toHaveLength(1)
    noContentInLogs('@bob:chat.example.com')
  })

  it('an id shape in the modal is refused before any effect (internal_error), the trigger_id not spent', async () => {
    await layer()
    const s = await sock()
    const trigger = (await click(s)).trigger_id
    expect(await refused(trigger, { ...MODAL, title: t('!abc:chat.example.com') })).toBe('internal_error')
    expect(forms.opened).toEqual([])
    await viewsOpen(trigger)
  })
})

// ── Over HTTP ────────────────────────────────────────────────────────────────────────────────────────────────

interface Receiver {
  url: string
  got: Array<{ payload: Record<string, unknown>; signed: boolean }>
  close(): Promise<void>
}
type Reply = { status: number; body?: string } | 'hang'
const signatureOf = (ts: string, body: string): string => `v0=${createHmac('sha256', TOKEN).update(`v0:${ts}:${body}`).digest('hex')}`

async function receiver(reply: (payload: Record<string, unknown>) => Reply): Promise<Receiver> {
  const got: Receiver['got'] = []
  const hung: ServerResponse[] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      const payload = JSON.parse(new URLSearchParams(body).get('payload') ?? '{}') as Record<string, unknown>
      got.push({ payload, signed: req.headers['x-slack-signature'] === signatureOf(String(req.headers['x-slack-request-timestamp']), body) })
      const r = reply(payload)
      if (r === 'hang') return void hung.push(res)
      res.writeHead(r.status, { 'content-type': 'application/json' })
      res.end(r.body ?? '')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/slack/actions`,
    got,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections()
        server.close(() => r())
      }),
  }
}
async function freePort(): Promise<number> {
  const s = createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  const port = (s.address() as AddressInfo).port
  await new Promise<void>((r) => s.close(() => r()))
  return port
}

describe('view_submission over HTTP (--slack-actions-url)', () => {
  // The click is answered 200; the submission gets `answer`.
  const httpOpened = async (answerOf: () => Reply, opts: SlackStart = {}): Promise<void> => {
    rx = await receiver((p) => (p.type === 'view_submission' ? answerOf() : { status: 200 }))
    await layer({ actionsUrl: rx.url, ...opts })
    const ts = await card()
    answer(ts)
    await expect.poll(() => rx!.got.length).toBe(1)
    await viewsOpen(rx.got[0]!.payload.trigger_id)
  }

  const cases: Array<[string, Reply, unknown]> = [
    ['200 with an empty body', { status: 200 }, { ok: true }],
    ['200 with errors', { status: 200, body: JSON.stringify({ response_action: 'errors', errors: { why: 'Curto' } }) }, { errors: { [WHY]: 'Curto' } }],
    ['200 with clear', { status: 200, body: JSON.stringify({ response_action: 'clear' }) }, { ok: true }],
    ['200 with update', { status: 200, body: JSON.stringify({ response_action: 'update', view: MODAL }) }, { refused: true }],
    ['200 with a body that is no JSON', { status: 200, body: 'ok' }, { refused: true }],
    ['a status without 2xx', { status: 404 }, { refused: true }],
  ]
  for (const [name, reply, outcome] of cases) {
    it(`${name} → ${JSON.stringify(outcome).slice(0, 40)}`, async () => {
      await httpOpened(() => reply)
      forms.submit({ [WHY]: 'Porque sim' })
      await expect.poll(() => forms.results.map((r) => r.outcome)).toEqual([outcome])
      const sub = rx!.got.find((g) => g.payload.type === 'view_submission')!
      expect(sub.signed).toBe(true)
      expect(rx!.got.filter((g) => g.payload.type === 'view_submission')).toHaveLength(1)
    })
  }

  it('a refused connection: refused at once', async () => {
    const port = await freePort()
    await layer({ actionsUrl: `http://127.0.0.1:${port}/slack/actions` })
    // The command path needs no click: a socket for the command, the submission over HTTP.
    const s = await sock()
    const m = message({ id: tsOfMs(Date.now()), conversation: GENERAL.id, author: ALICE.id, text: '/editar', mentionsMe: true, mentions: [ME.id], command: { name: 'editar', args: '' } })
    h!.world.messages.set(GENERAL.id, [m])
    h!.world.emit({ type: 'mention', conversation: GENERAL.id, message: m })
    const f = await s.next((x) => x.type === 'slash_commands')
    s.send({ envelope_id: f.envelope_id })
    await viewsOpen(payloadOf(f).trigger_id)
    forms.submit({ [WHY]: 'Porque sim' })
    await expect.poll(() => forms.results.map((r) => r.outcome)).toEqual([{ refused: true }])
    expect(lines('view-submission-refused').map((l) => l.reason)).toEqual(['connection'])
    // Not on the sockets.
    expect(s.frames.filter((x) => x.type === 'interactive')).toEqual([])
  })

  it('no answer in 10 s: nothing is written, one line', async () => {
    const clock = manualClock(Date.now())
    await httpOpened(() => 'hang', { socket: { clock } })
    forms.submit({ [WHY]: 'Porque sim' })
    await expect.poll(() => rx!.got.filter((g) => g.payload.type === 'view_submission').length).toBe(1)
    clock.advance(SUBMISSION_TIMEOUT_MS)
    await expect.poll(() => lines('view-submission-unanswered')).toHaveLength(1)
    expect(forms.results).toEqual([])
  })

  it('out of the clicks\' queue: a submission goes while a click is kept', async () => {
    let clicks = 0
    rx = await receiver((p) => (p.type === 'view_submission' ? { status: 200 } : ++clicks === 1 ? { status: 200 } : { status: 500 }))
    await layer({ actionsUrl: rx.url, socket: { ackTimeoutMs: 200 }, redeliveryMs: 60_000 })
    const ts = await card()
    answer(ts)
    await expect.poll(() => rx!.got.length).toBe(1)
    await viewsOpen(rx.got[0]!.payload.trigger_id)
    // A second click the app refuses: retried, then kept.
    answer(await card())
    await expect.poll(() => lines('slack-action-kept').length, { timeout: 5_000 }).toBe(1)
    forms.submit({ [WHY]: 'Porque sim' })
    await expect.poll(() => forms.results.map((r) => r.outcome)).toEqual([{ ok: true }])
  })
})

// ── Bolt 5.1.0, in process ───────────────────────────────────────────────────────────────────────────────────

describe('Bolt 5.1.0 with no patch', () => {
  // app.action → client.views.open → app.view(callback_id): state.values and private_metadata; errors, then accepted.
  const wire = (a: App, viewsOpenFirst: boolean, got: Array<Record<string, unknown>>) => {
    a.action('Edit', async ({ ack, body, client }) => {
      if (!viewsOpenFirst) await ack()
      await client.views.open({ trigger_id: (body as { trigger_id: string }).trigger_id, view: MODAL as never })
      if (viewsOpenFirst) await ack()
    })
    a.view('edit', async ({ ack, view, body }) => {
      got.push({ values: view.state.values, meta: view.private_metadata, user: body.user.id })
      if (got.length === 1) await ack({ response_action: 'errors', errors: { why: 'Escreva mais' } })
      else await ack()
    })
  }

  it('Socket Mode: views.open before the ack; app.view gets the values; ack(errors) then ack()', async () => {
    await layer()
    app = new App({ token: TOKEN, appToken: TOKEN, socketMode: true, clientOptions: { slackApiUrl: `${h!.url}/slack/api/` }, logLevel: LogLevel.ERROR })
    const got: Array<Record<string, unknown>> = []
    wire(app, true, got)
    await app.start()
    await expect.poll(() => h!.api.bus).toBeDefined()
    await expect.poll(() => lines('socket-open').length).toBe(1)
    answer(await card())
    await expect.poll(() => forms.opened.length, { timeout: 10_000 }).toBe(1)
    forms.submit({ [WHY]: 'Curto' })
    await expect.poll(() => forms.results.length, { timeout: 10_000 }).toBe(1)
    forms.submit({ [WHY]: 'Agora sim, longo', [LEVEL]: 'high' })
    await expect.poll(() => forms.results.length, { timeout: 10_000 }).toBe(2)
    expect(forms.results.map((r) => r.outcome)).toEqual([{ errors: { [WHY]: 'Escreva mais' } }, { ok: true }])
    expect(got[1]).toEqual({ values: { why: { why_input: { type: 'plain_text_input', value: 'Agora sim, longo' } }, level: { pick: { type: 'radio_buttons', selected_option: { text: { type: 'plain_text', text: 'Alto', emoji: true }, value: 'high' } } } }, meta: 'state-1', user: ALICE.id })
  })

  it('HTTP receiver with processBeforeResponse: views.open before the 2xx; app.view acks errors, then accepted', async () => {
    const port = await freePort()
    await layer({ actionsUrl: `http://127.0.0.1:${port}/slack/actions` })
    app = new App({ token: TOKEN, signingSecret: TOKEN, endpoints: '/slack/actions', processBeforeResponse: true, clientOptions: { slackApiUrl: `${h!.url}/slack/api/` }, logLevel: LogLevel.ERROR })
    const got: Array<Record<string, unknown>> = []
    wire(app, true, got)
    await app.start({ port, host: '127.0.0.1' })
    answer(await card())
    await expect.poll(() => forms.opened.length, { timeout: 10_000 }).toBe(1)
    await expect.poll(() => lines('slack-action-delivered').length, { timeout: 10_000 }).toBe(1)
    forms.submit({ [WHY]: 'Curto' })
    await expect.poll(() => forms.results.length, { timeout: 10_000 }).toBe(1)
    forms.submit({ [WHY]: 'Agora sim, longo' })
    await expect.poll(() => forms.results.length, { timeout: 10_000 }).toBe(2)
    expect(forms.results.map((r) => r.outcome)).toEqual([{ errors: { [WHY]: 'Escreva mais' } }, { ok: true }])
    expect(got[0]).toMatchObject({ meta: 'state-1', user: ALICE.id })
  })
})
