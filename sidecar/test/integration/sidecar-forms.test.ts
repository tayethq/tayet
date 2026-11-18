import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  brandUserId,
  buildFormSubmissionContent,
  buildTextContent,
  readFormDefinition,
  readFormResult,
  readFormSubmission,
  resolveFormReply,
  submissionLabels,
  type FormRelated,
} from '@tayet/shared/internal'
import type { FormField, FormValues } from '@tayet/shared'
import { ESCROW_URL, HS_URL, mintOidcSession, stackUp, startWellKnown, until } from '../support/stack'
import { startHuman, type Human, type SeenEvent } from '../support/human'
import { conversationToken, personToken } from '../../src/api/ids'
import { main } from '../../src/boot'
import type { Core } from '../../src/core/handle'
import type { FormSubmitted } from '../../src/core/forms'

// An agent's forms against the stack, through the core facade itself (no route of the local API reaches
// it): the core runs in this process (boot `main`), and its in-memory listener receives the submissions. The
// person speaks the protocol with the shared builders and reads what comes back with the shared readers the
// client uses (the sidecar package cannot import the client): the definition opens for the trigger this
// person sent, the result reads as the client reads it, and the reply rule says who answered.
// 1. click on the agent's card, in an encrypted conversation: open → the definition → submission → the
//    listener gets the values and the meta → errors by field → a new submission → accepted → answered.
// 2. a command for the agent, in an open channel: open → submission → refused (an error under no field id)
//    → a new submission → accepted → answered.
// Two rooms (the stack's createRoom limit is shared); one `a-` account per run, deleted at the end.

const STACK = stackUp()
const rand = (): string => Math.random().toString(36).slice(2, 8)

const FIELDS: FormField[] = [
  { kind: 'context', text: 'Diga por que a decisão muda.' },
  { kind: 'longText', id: 'why', label: 'Motivo', optional: false, minLength: 5, maxLength: 500, initial: 'Antes' },
  { kind: 'radio', id: 'level', label: 'Nível', optional: true, options: [{ value: 'low', label: 'Baixo' }, { value: 'high', label: 'Alto' }] },
]
const FORM = { title: 'Editar decisão', submitLabel: 'Salvar', fields: FIELDS }

describe.skipIf(!STACK)('sidecar forms ↔ stack: the core facade, the listener, the three outcomes', () => {
  let alice: string
  let agent: { userId: string; token: string }
  let wellKnown: Awaited<ReturnType<typeof startWellKnown>>
  let store: string
  let person: Human
  let core: Core
  const cwd = process.cwd()
  const got: FormSubmitted[] = []

  const escrow = (method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${ESCROW_URL}/v1/agents${path}`, {
      method,
      headers: { Authorization: `Bearer ${alice}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })

  const joinAgent = async (room: string): Promise<string> => {
    await person.waitForMembership(room, agent.userId, 'join', 90_000)
    const conv = conversationToken(room, false)
    await until(() => (core.read.conversations({}).conversations.some((c) => c.id === conv) ? true : undefined), 30_000, 'the conversation in the core')
    return conv
  }
  // The person's view of a form message related to `anchor`, as the client's reply rule reads it.
  const relatedOf = (e: SeenEvent): FormRelated | undefined => {
    const base = { id: e.eventId, sender: e.sender, ts: 0 }
    const definition = readFormDefinition(e.content)
    if (definition && e.content.msgtype === 'io.tayet.form') return { ...base, kind: 'definition', definition }
    const submission = readFormSubmission(e.content)
    if (submission) return { ...base, kind: 'submission', submission }
    const result = readFormResult(e.content)
    return result ? { ...base, kind: 'result', result } : undefined
  }
  const formEvent = (anchor: string, msgtype: string, pred: (e: SeenEvent) => boolean = () => true) =>
    person.waitForEvent((e) => e.relation?.rel_type === 'io.tayet.form' && e.relation.event_id === anchor && e.content.msgtype === msgtype && pred(e), 60_000)
  // The person's own submissions, as sent (the person's client keeps its own sends; the support's event list
  // does not always echo them in a room in the clear).
  const sent: FormRelated[] = []
  const repliesOf = (anchor: string): FormRelated[] => {
    const seen = person.events().filter((e) => e.relation?.rel_type === 'io.tayet.form' && e.relation.event_id === anchor).flatMap((e) => relatedOf(e) ?? [])
    return [...seen, ...sent.filter((s) => !seen.some((r) => r.id === s.id))]
  }
  const submit = async (room: string, anchor: string, form: string, values: FormValues): Promise<{ id: string; submitted: FormSubmitted }> => {
    const before = got.length
    const content = buildFormSubmissionContent(anchor, form, FORM.title, values, submissionLabels(FIELDS, values))
    const id = await person.sendContent(room, content)
    sent.push({ id, sender: person.userId, ts: 0, kind: 'submission', submission: readFormSubmission(content)! })
    const submitted = await until(() => got[before], 60_000, 'the submission at the listener')
    return { id, submitted }
  }

  beforeAll(async () => {
    alice = (await mintOidcSession('alice', 'alicepass123')).accessToken
    const res = await escrow('POST', '', { name: `Sidecar Forms ${rand()}` })
    expect(res.status).toBe(201)
    agent = (await res.json()) as { userId: string; token: string }
    person = await startHuman(alice)
    wellKnown = await startWellKnown(HS_URL)
    store = await mkdtemp(join(tmpdir(), 'sidecar-forms-it-'))
    const booted = await main(['--server', wellKnown.url, '--token', agent.token, '--store', store])
    if (booted === null) throw new Error('no core')
    core = booted
    await until(() => (core.state() === 'online' ? true : undefined), 90_000, 'the core online')
    core.forms!.listen((s) => got.push(s))
  }, 240_000)

  afterAll(async () => {
    await core?.shutdown()
    process.chdir(cwd)
    person?.stop()
    if (agent !== undefined) await escrow('DELETE', `/${encodeURIComponent(agent.userId)}`)
    await wellKnown?.close()
    if (store !== undefined) await rm(store, { recursive: true, force: true })
  }, 60_000)

  it('1. click, encrypted conversation: open → the session that clicked gets the definition → errors by field → resubmit → accepted', async () => {
    const room = await person.createEncryptedRoom([agent.userId])
    const conv = await joinAgent(room)
    const card = await core.approvals!.request(conv, { text: `Mudar a decisão ${rand()}?`, options: [{ id: 'edit', label: 'Editar' }] })
    const cardEv = await person.waitForMessage((m) => m.content.msgtype === 'io.tayet.approval' && m.sender === agent.userId)
    expect(cardEv.wireType).toBe('m.room.encrypted')
    const answer = await person.answerApproval(room, cardEv.eventId, 'edit', 'Editar')

    const opened = await until(
      async () => core.forms!.open({ conversation: conv, origin: { kind: 'card', card: card.id, person: personToken(person.userId) }, form: FORM, meta: '{"view":"edit"}' }).catch(() => undefined),
      30_000,
      'the form opened',
    )
    // The definition the person's client reads: from the agent, for the trigger this person sent.
    const def = await formEvent(cardEv.eventId, 'io.tayet.form')
    expect(def.sender).toBe(agent.userId)
    const definition = readFormDefinition(def.content)
    expect(definition).toEqual({ trigger: answer, title: FORM.title, submitLabel: FORM.submitLabel, fields: FIELDS })

    const first = await submit(room, cardEv.eventId, def.eventId, { why: 'Prazo', level: 'high' })
    expect(first.submitted).toEqual({
      conversation: conv,
      form: { id: opened.id, title: FORM.title, submitLabel: FORM.submitLabel, fields: FIELDS, meta: '{"view":"edit"}' },
      submission: { id: expect.any(String) as string, by: personToken(person.userId), at: expect.any(Number) as number, values: { why: 'Prazo', level: 'high' } },
      origin: { kind: 'card', anchor: card.id },
    })
    await core.forms!.result(conv, first.submitted.submission.id, { errors: { why: 'Explique um pouco mais.' } })
    const errors = await formEvent(cardEv.eventId, 'io.tayet.form.result', (e) => readFormResult(e.content)?.submission === first.id)
    expect(readFormResult(errors.content)).toEqual({ submission: first.id, errors: { why: 'Explique um pouco mais.' } })

    const second = await submit(room, cardEv.eventId, def.eventId, { why: 'O prazo do cliente mudou.' })
    expect(second.submitted.submission.values).toEqual({ why: 'O prazo do cliente mudou.' })
    await core.forms!.result(conv, second.submitted.submission.id, { ok: true })
    await formEvent(cardEv.eventId, 'io.tayet.form.result', (e) => readFormResult(e.content)?.submission === second.id)

    // Answered, by the reply rule every member reads: the person, with the accepted submission.
    const related = repliesOf(cardEv.eventId)
    const reply = resolveFormReply({ id: cardEv.eventId, agent: agent.userId, kind: 'card', sender: agent.userId }, related, (t) => (t === answer ? person.userId : undefined))
    expect(reply?.by).toBe(person.userId)
    expect(got).toHaveLength(2)
  }, 240_000)

  it('2. command, open channel: open → submission → refused (no field) → resubmit → accepted', async () => {
    await core.commands!.set([{ name: 'editar', description: 'Editar a decisão' }])
    const room = await person.createPublicChannel()
    await person.invite(room, agent.userId)
    const conv = await joinAgent(room)
    await until(async () => ((await person.readCommands(room, agent.userId)).shown?.block?.commands?.length === 1 ? true : undefined), 60_000, 'the manifest')
    const text = `/editar ${rand()}`
    const command = await person.sendContent(room, buildTextContent(text, undefined, [brandUserId(agent.userId)], undefined, { name: 'editar', agent: brandUserId(agent.userId) }))
    const ts = await until(async () => core.read.messages(conv, {}).then((p) => p.messages.find((m) => m.text === text)?.id).catch(() => undefined), 30_000, 'the command in the listing')

    const opened = await core.forms!.open({ conversation: conv, origin: { kind: 'command', message: ts }, form: FORM })
    const def = await formEvent(command, 'io.tayet.form')
    expect(def.sender).toBe(agent.userId)
    expect(readFormDefinition(def.content)?.trigger).toBe(command)

    const first = await submit(room, command, def.eventId, { why: 'Primeira tentativa' })
    expect(first.submitted).toMatchObject({ conversation: conv, form: { id: opened.id }, origin: { kind: 'command', anchor: ts } })
    expect(first.submitted.form).not.toHaveProperty('meta')
    await core.forms!.result(conv, first.submitted.submission.id, { refused: true })
    const refused = await formEvent(command, 'io.tayet.form.result', (e) => readFormResult(e.content)?.submission === first.id)
    const read = readFormResult(refused.content)
    // In error with no field: the client shows "not sent".
    expect(read && 'errors' in read && Object.keys(read.errors).some((k) => FIELDS.some((f) => f.kind !== 'context' && f.id === k))).toBe(false)

    const second = await submit(room, command, def.eventId, { why: 'Segunda tentativa' })
    await core.forms!.result(conv, second.submitted.submission.id, { ok: true })
    await formEvent(command, 'io.tayet.form.result', (e) => readFormResult(e.content)?.submission === second.id)
    const related = repliesOf(command)
    expect(resolveFormReply({ id: command, agent: agent.userId, kind: 'command', sender: person.userId }, related, () => undefined)?.by).toBe(person.userId)
  }, 240_000)
})
