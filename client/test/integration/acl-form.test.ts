import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { createAcl } from '../../src/acl'
import type { Acl, AclTelemetry, AgentForm, ChannelId, DomainEvent, FormId, Message, MessageId, UserId } from '../../src/acl'
import { createRoom, HOMESERVER, invite, join, mintToken, sendText, synapseReachable, whoami } from '../support/synapse'
import { registerUser } from '../support/escrow-harness'
import { freshUsers, type FreshUser } from '../support/fresh-users'
import {
  APPROVAL_BLOCK,
  APPROVAL_MSGTYPE,
  FORM_BLOCK,
  FORM_MSGTYPE,
  FORM_REL_TYPE,
  FORM_RESULT_BLOCK,
  FORM_RESULT_MSGTYPE,
  FORM_SUBMISSION_BLOCK,
  FORM_SUBMISSION_MSGTYPE,
  RESPONSE_REL_TYPE,
} from '@tayet/shared/internal'
import { FOLD_RULES } from '../../src/acl/internal/fold-rules'
import { FORM_ANSWER_TIMEOUT_MS } from '../../src/acl/internal/form-state'

// An agent's form against the real server. The agent is an account with the reserved localpart, driven
// raw by fetch: it never decrypts anything — it finds what it needs by the relations and the envelope
// (relation type, target, sender and event type are in clear). The ACLs show: only the session that
// clicked or sent the command opens the form; the values travel exactly; errors per field, done, no
// answer; the anchor gains the reply on every member; none of the three messages is a line or notifies;
// and forged or oversized definitions and forged results are ignored.
// Auto-skip without the stack; fileParallelism:false serializes the gates.

const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'
const OPTIONS = [{ id: 'edit', label: 'Editar', style: 'primary' }]
const opts = (n: number) => Array.from({ length: n }, (_, i) => ({ value: `v${i}`, label: `Opção ${i}` }))

const ALL_KINDS = [
  { kind: 'context', text: 'Revise o *título*', format: 'org.matrix.custom.html', formatted_body: '<p>Revise o <strong>título</strong></p>' },
  { kind: 'text', id: 'field.title', label: 'Título', minLength: 3, maxLength: 40 },
  { kind: 'longText', id: 'notes', label: 'Notas', optional: true },
  { kind: 'email', id: 'email', label: 'Email', optional: true },
  { kind: 'url', id: 'link', label: 'Link', optional: true },
  { kind: 'number', id: 'qty', label: 'Quantidade', min: '1', max: '9' },
  { kind: 'date', id: 'due', label: 'Prazo', optional: true },
  { kind: 'select', id: 'team', label: 'Time', groups: [{ label: 'Produto', options: opts(2) }] },
  { kind: 'multiSelect', id: 'tags', label: 'Tags', options: opts(3), optional: true },
  { kind: 'radio', id: 'prio', label: 'Prioridade', options: opts(3) },
  { kind: 'checkboxes', id: 'flags', label: 'Flags', options: opts(2), optional: true },
]

async function until<T>(get: () => T | undefined | Promise<T | undefined>, timeoutMs = 150_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await get()
    if (v !== undefined) return v
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 100))
  }
}

function agentLocalpart(): string {
  let tail = ''
  for (let i = 0; i < 8; i++) tail += BASE32[Math.floor(Math.random() * BASE32.length)]
  return `a-form${tail}`
}

let txn = 0
async function send(token: string, roomId: string, content: Record<string, unknown>): Promise<string> {
  txn += 1
  const res = await fetch(`${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/form${txn}_${process.pid}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(content),
  })
  if (!res.ok) throw new Error(`send -> ${res.status}`)
  return ((await res.json()) as { event_id: string }).event_id
}

type Raw = { event_id: string; sender: string; type: string; origin_server_ts: number; content: Record<string, unknown> }
async function relations(token: string, roomId: string, anchorId: string, relType: string): Promise<Raw[]> {
  const res = await fetch(
    `${HOMESERVER}/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/relations/${encodeURIComponent(anchorId)}/${encodeURIComponent(relType)}?dir=f&limit=100`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  if (!res.ok) throw new Error(`relations -> ${res.status}`)
  return ((await res.json()) as { chunk: Raw[] }).chunk
}
async function latestFrom(token: string, roomId: string, sender: string, type: string): Promise<Raw | undefined> {
  const res = await fetch(`${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=30`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`messages -> ${res.status}`)
  return ((await res.json()) as { chunk: Raw[] }).chunk.find((e) => e.sender === sender && e.type === type)
}

const definition = (anchorId: string, trigger: string, fields: unknown[] = ALL_KINDS, extra: Record<string, unknown> = {}) => ({
  msgtype: FORM_MSGTYPE,
  body: 'Editar decisão',
  [FORM_BLOCK]: { trigger, title: 'Editar decisão', submitLabel: 'Salvar', fields, meta: '{"view":"edit"}', ...extra },
  'm.relates_to': { rel_type: FORM_REL_TYPE, event_id: anchorId },
})
const result = (anchorId: string, submission: string, outcome: Record<string, unknown>) => ({
  msgtype: FORM_RESULT_MSGTYPE,
  body: 'ok',
  [FORM_RESULT_BLOCK]: { submission, ...outcome },
  'm.relates_to': { rel_type: FORM_REL_TYPE, event_id: anchorId },
})

async function overrideRule(token: string, ruleId: string): Promise<{ actions: unknown[]; conditions: unknown[]; enabled: boolean } | undefined> {
  const res = await fetch(`${HOMESERVER}/_matrix/client/v3/pushrules/global/override/${encodeURIComponent(ruleId)}`, { headers: { Authorization: `Bearer ${token}` } })
  return res.ok ? ((await res.json()) as { actions: unknown[]; conditions: unknown[]; enabled: boolean }) : undefined
}

// What the server notified for the room: only which known event each one is. No id or body leaves here.
async function notifiedKnown(token: string, roomId: string, known: Map<string, string>): Promise<string[]> {
  const res = await fetch(`${HOMESERVER}/_matrix/client/v3/notifications?limit=100`, { headers: { Authorization: `Bearer ${token}` } })
  if (!res.ok) throw new Error(`notifications -> ${res.status}`)
  const page = (await res.json()) as { notifications: Array<{ room_id: string; event: { event_id: string } }> }
  return page.notifications.filter((n) => n.room_id === roomId).map((n) => known.get(n.event.event_id) ?? 'unknown')
}

class Session {
  readonly events: DomainEvent[] = []
  readonly acl: Acl
  constructor() {
    this.acl = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    this.acl.subscribe((e) => this.events.push(e))
  }
  async connect(token: string): Promise<void> {
    await this.acl.connect(token as Parameters<Acl['connect']>[0])
  }
  channel(name: string): Promise<ChannelId> {
    return until(() => this.events.find((e): e is Extract<DomainEvent, { t: 'channel.changed' }> => e.t === 'channel.changed' && e.channel.name === `#${name}`)?.channel.id)
  }
  forms(): AgentForm[] {
    return this.events.flatMap((e) => (e.t === 'form.opened' || e.t === 'form.changed' ? [e.form] : []))
  }
  opened(): AgentForm[] {
    return this.events.flatMap((e) => (e.t === 'form.opened' ? [e.form] : []))
  }
  lastForm(): AgentForm | undefined {
    return this.forms().at(-1)
  }
  state(kind: AgentForm['state']['kind']): Promise<AgentForm> {
    return until(() => {
      const last = this.lastForm()
      return last?.state.kind === kind ? last : undefined
    })
  }
  messages(id: string): Message[] {
    return this.events.flatMap((e) => ((e.t === 'message.received' || e.t === 'message.edited') && e.message.id === (id as unknown as MessageId) ? [e.message] : []))
  }
  lineIds(): string[] {
    return this.events.flatMap((e) => (e.t === 'message.received' ? [e.message.id as unknown as string] : []))
  }
  sawLine(id: string): Promise<unknown> {
    return until(() => this.events.find((e) => e.t === 'message.received' && e.message.id === (id as unknown as MessageId)))
  }
  reply(id: string): Promise<{ by: UserId; at: number }> {
    return until(() => this.messages(id).at(-1)?.formReply as { by: UserId; at: number } | undefined)
  }
}

describe.skipIf(!SYNAPSE)('agent form — protocol, session and reply', () => {
  let person: FreshUser
  let other: FreshUser
  let agentToken: string
  let otherAgentToken: string
  let personId: string
  let agentId: string
  const first = new Session()
  const second = new Session()
  const third = new Session()

  beforeAll(async () => {
    ;[person, other] = await freshUsers(['frmp', 'frmo'])
    const localpart = agentLocalpart()
    registerUser(localpart)
    agentToken = await mintToken(localpart)
    const otherLocalpart = agentLocalpart()
    registerUser(otherLocalpart)
    otherAgentToken = await mintToken(otherLocalpart)
    personId = await whoami(person.token)
    agentId = await whoami(agentToken)
    await first.connect(person.token)
    await second.connect(await mintToken(person.name))
    await third.connect(other.token)
    for (const { ruleId } of FOLD_RULES) {
      await until(() => overrideRule(person.token, ruleId), 60_000)
      await until(() => overrideRule(other.token, ruleId), 60_000)
    }
  }, 300_000)

  afterAll(async () => {
    await Promise.all([first.acl.disconnect(), second.acl.disconnect(), third.acl.disconnect()])
  })

  // A test that stops halfway leaves its form open; one form at a time would block the next test.
  afterEach(() => {
    for (const f of first.opened()) first.acl.closeForm(f.id)
  })

  async function room(encrypted: boolean): Promise<{ roomId: string; name: string }> {
    const name = `tayet-form-${process.pid}-${Math.floor(Math.random() * 1e6)}`
    const roomId = await createRoom(person.token, {
      name,
      ...(encrypted && { initialState: [{ type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }] }),
    })
    for (const token of [other.token, agentToken, otherAgentToken]) {
      await invite(person.token, roomId, await whoami(token))
      await join(token, roomId)
    }
    return { roomId, name }
  }

  // The agent publishes a card, the first session answers it, the agent finds the answer by the card's
  // relations: the trigger of a form opened by a click.
  async function clicked(roomId: string): Promise<{ cardId: string; answerId: string }> {
    const cardId = await send(agentToken, roomId, { msgtype: APPROVAL_MSGTYPE, body: 'Editar a decisão?', [APPROVAL_BLOCK]: { options: OPTIONS } })
    await until(() => first.messages(cardId)[0])
    await first.acl.answerApproval(cardId as unknown as MessageId, 'edit')
    const answerId = await until(async () => (await relations(agentToken, roomId, cardId, RESPONSE_REL_TYPE))[0]?.event_id)
    return { cardId, answerId }
  }

  it('A — clear room, opened by a click: only the clicking session opens it; values, errors, done; the reply on every member; never a line or a notification', async () => {
    const { roomId, name } = await room(false)
    await Promise.all([first.channel(name), second.channel(name), third.channel(name)])
    const { cardId, answerId } = await clicked(roomId)
    const definitionId = await send(agentToken, roomId, definition(cardId, answerId))

    const form = await until(() => first.opened().find((f) => (f.id as unknown as string) === definitionId))
    expect(form).toMatchObject({ agent: agentId, anchor: cardId, title: 'Editar decisão', submitLabel: 'Salvar', state: { kind: 'open' } })
    expect(form.fields).toHaveLength(ALL_KINDS.length)
    expect(form.fields[0]).toEqual({
      kind: 'context',
      text: 'Revise o *título*',
      rich: [{ t: 'p', children: [{ t: 'text', text: 'Revise o ' }, { t: 'strong', children: [{ t: 'text', text: 'título' }] }] }],
    })
    expect(form.fields.map((f) => f.kind)).toEqual(ALL_KINDS.map((f) => f.kind))
    expect(form).not.toHaveProperty('meta')

    // Invalid values: the codes come back and the server holds no submission (only the definition).
    const invalid = await first.acl.submitForm(form.id, { 'field.title': 'ab', qty: '12', team: 'nope', prio: 'v1' })
    expect(invalid).toEqual({ issues: { 'field.title': { code: 'minLength', min: 3 }, qty: { code: 'range', min: '1', max: '9' }, team: { code: 'option' } } })
    expect((await relations(agentToken, roomId, cardId, FORM_REL_TYPE)).map((r) => r.event_id)).toEqual([definitionId])

    // Valid values: the agent reads them in clear, exactly; it answers with an error per field.
    const values = { 'field.title': 'Novo título', qty: '3', team: 'v1', prio: 'v2', tags: ['v0', 'v2'], email: 'a@b.co' }
    expect(await first.acl.submitForm(form.id, values)).toEqual({ ok: true })
    const sub1 = await until(async () => (await relations(agentToken, roomId, cardId, FORM_REL_TYPE)).find((r) => r.content.msgtype === FORM_SUBMISSION_MSGTYPE))
    expect(sub1.sender).toBe(personId)
    expect(sub1.content).toMatchObject({ body: 'Editar decisão', [FORM_SUBMISSION_BLOCK]: { form: definitionId, values } })
    const errorsId = await send(agentToken, roomId, result(cardId, sub1.event_id, { errors: { 'field.title': 'Esse título já existe' } }))
    expect((await first.state('errors')).state).toEqual({ kind: 'errors', errors: { 'field.title': 'Esse título já existe' } })

    // Again; the agent accepts.
    expect(await first.acl.submitForm(form.id, { ...values, 'field.title': 'Outro título' })).toEqual({ ok: true })
    const sub2 = await until(async () =>
      (await relations(agentToken, roomId, cardId, FORM_REL_TYPE)).find((r) => r.content.msgtype === FORM_SUBMISSION_MSGTYPE && r.event_id !== sub1.event_id),
    )
    const okId = await send(agentToken, roomId, result(cardId, sub2.event_id, { ok: true }))
    await first.state('done')

    // The anchor gains the reply on the three sessions: the person, at the accepted submission's time.
    for (const s of [first, second, third]) expect(await s.reply(cardId)).toEqual({ by: personId, at: sub2.origin_server_ts })

    // Only the first session ever saw the form.
    const barrierId = await sendText(other.token, roomId, 'barreira')
    for (const s of [first, second, third]) await s.sawLine(barrierId)
    expect(second.forms()).toEqual([])
    expect(third.forms()).toEqual([])

    // No line, live or on a page, on any session; nothing notified the other member.
    const formIds = [definitionId, sub1.event_id, errorsId, sub2.event_id, okId]
    for (const s of [first, second, third]) for (const id of formIds) expect(s.lineIds()).not.toContain(id)
    const page = await third.acl.getTimeline(await third.channel(name))
    for (const id of formIds) expect(page.items.map((m) => m.id as unknown as string)).not.toContain(id)
    // A barrier from the person: once it notified the other member, every earlier event was counted.
    const notifyBarrier = await sendText(person.token, roomId, 'barreira da pessoa')
    const known = new Map<string, string>([[cardId, 'card'], [notifyBarrier, 'barrier'], ...formIds.map((id) => [id, 'form'] as [string, string])])
    await until(async () => ((await notifiedKnown(other.token, roomId, known)).includes('barrier') ? true : undefined))
    expect((await notifiedKnown(other.token, roomId, known)).filter((k) => k === 'form')).toEqual([])

    // The fourth rule, in the exact shape of the others.
    expect(await overrideRule(other.token, 'io.tayet.fold.form')).toMatchObject({
      enabled: true,
      actions: [],
      conditions: [{ kind: 'event_property_is', key: 'content.m\\.relates_to.rel_type', value: FORM_REL_TYPE }],
    })
    first.acl.closeForm(form.id)
  }, 400_000)

  it('B — encrypted room, opened by a command: the submission is encrypted with the relation in clear; the other member sees the reply', async () => {
    const { roomId, name } = await room(true)
    const channel = await first.channel(name)
    await third.channel(name)
    const commandId = await first.acl.sendMessage(channel, { kind: 'text', text: '/edit 42' }, { command: { agent: agentId as UserId, name: 'edit' } })
    const command = await until(() => latestFrom(agentToken, roomId, personId, 'm.room.encrypted'))
    const definitionId = await send(agentToken, roomId, definition(command.event_id, command.event_id, [{ kind: 'text', id: 'title', label: 'Título' }]))

    const form = await until(() => first.opened().find((f) => (f.id as unknown as string) === definitionId))
    expect(await first.acl.submitForm(form.id, { title: 'Cifrado' })).toEqual({ ok: true })
    const submission = await until(async () => (await relations(agentToken, roomId, command.event_id, FORM_REL_TYPE)).find((r) => r.sender === personId))
    expect(submission.type).toBe('m.room.encrypted')
    expect(submission.content['m.relates_to']).toEqual({ rel_type: FORM_REL_TYPE, event_id: command.event_id })
    expect(JSON.stringify(submission.content)).not.toContain('Cifrado')
    await send(agentToken, roomId, result(command.event_id, submission.event_id, { ok: true }))
    await first.state('done')
    expect(await third.reply(command.event_id)).toEqual({ by: personId, at: submission.origin_server_ts })
    // The sending session too, on its own command message (held by its send id), in place.
    expect(await first.reply(commandId as unknown as string)).toEqual({ by: personId, at: submission.origin_server_ts })
    first.acl.closeForm(form.id)
  }, 400_000)

  it('C — no answer: noAnswer after 15 s (a few seconds of tolerance up), then a late ok → done', async () => {
    const { roomId, name } = await room(false)
    await first.channel(name)
    const { cardId, answerId } = await clicked(roomId)
    const definitionId = await send(agentToken, roomId, definition(cardId, answerId, [{ kind: 'text', id: 'title', label: 'Título' }]))
    const form = await until(() => first.opened().find((f) => (f.id as unknown as string) === definitionId))
    // The wait counts from the server's confirmation of the send (the submit resolves then), not from the click.
    expect(await first.acl.submitForm(form.id, { title: 'x' })).toEqual({ ok: true })
    const accepted = Date.now()
    await first.state('noAnswer')
    const waited = Date.now() - accepted
    expect(waited).toBeGreaterThanOrEqual(FORM_ANSWER_TIMEOUT_MS - 200)
    expect(waited).toBeLessThanOrEqual(FORM_ANSWER_TIMEOUT_MS + 5_000)
    const submission = await until(async () => (await relations(agentToken, roomId, cardId, FORM_REL_TYPE)).find((r) => r.sender === personId))
    await send(agentToken, roomId, result(cardId, submission.event_id, { ok: true }))
    await first.state('done')
    first.acl.closeForm(form.id)
  }, 300_000)

  it('D — forged and oversized definitions and a forged result are ignored, and none is a line', async () => {
    const { roomId, name } = await room(false)
    await first.channel(name)
    const { cardId, answerId } = await clicked(roomId)
    const tooBig = [{ kind: 'context', text: 'x'.repeat(3000) }, ...Array.from({ length: 11 }, () => ({ kind: 'context', text: 'y'.repeat(3000) }))]
    const tooMany = Array.from({ length: 26 }, (_, i) => ({ kind: 'text', id: `f${i}`, label: 'L' }))
    const forged = [
      await send(other.token, roomId, definition(cardId, answerId)),
      await send(otherAgentToken, roomId, definition(cardId, answerId)),
      await send(agentToken, roomId, definition(cardId, cardId)),
      await send(agentToken, roomId, definition(cardId, answerId, tooBig)),
      await send(agentToken, roomId, definition(cardId, answerId, tooMany)),
    ]
    const barrierId = await sendText(other.token, roomId, 'barreira')
    await first.sawLine(barrierId)
    expect(first.opened().filter((f) => forged.includes(f.id as unknown as string))).toEqual([])

    // None of them took the trigger: the agent's valid definition still opens.
    const definitionId = await send(agentToken, roomId, definition(cardId, answerId, [{ kind: 'text', id: 'title', label: 'Título' }]))
    const form = await until(() => first.opened().find((f) => (f.id as unknown as string) === definitionId))
    expect(await first.acl.submitForm(form.id, { title: 'x' })).toEqual({ ok: true })
    const submission = await until(async () => (await relations(agentToken, roomId, cardId, FORM_REL_TYPE)).find((r) => r.sender === personId))
    const forgedResult = await send(other.token, roomId, result(cardId, submission.event_id, { ok: true }))
    const barrier2 = await sendText(other.token, roomId, 'barreira 2')
    await first.sawLine(barrier2)
    expect(first.forms().some((f) => (f.id as unknown as string) === definitionId && f.state.kind === 'done')).toBe(false)
    for (const id of [...forged, forgedResult, definitionId, submission.event_id]) expect(first.lineIds()).not.toContain(id)
    first.acl.closeForm(form.id as FormId)
  }, 300_000)
})

describe('ACL form (availability)', () => {
  it(SYNAPSE ? 'stack reachable' : 'stack down — skipped', () => {
    expect(typeof SYNAPSE).toBe('boolean')
  })
})
