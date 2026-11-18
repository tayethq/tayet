import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import { buildFormDefinitionContent, buildFormSubmissionContent } from '@tayet/shared/internal'
import type { FormField } from '@tayet/shared'
import { createFormCore, FormError, type FormSubmitted } from '../../src/core/forms'
import { FORM_SUBMISSION_MAX_AGE_MS } from '../../src/core/form-limits'
import type { CardReader, CardReading } from '../../src/core/approvals'
import { ReadError, type Resolver } from '../../src/core/read'
import type { SendResult } from '../../src/core/queue'
import type { WriteJob } from '../../src/core/send'
import { WriteError } from '../../src/core/write'

// An agent's forms in the sidecar core: opening from a click or a command, the watch that hands a live
// submission to the listener once, and the result in its three outcomes.

const ME = '@a-abcdefghijkl:test.local'
const OTHER_AGENT = '@a-zzzzzzzzzzzz:test.local'
const ALICE = '@alice:test.local'
const BOB = '@bob:test.local'
const ROOM = '!room:test.local'
const CONV = 'CAAAAAAAAAA'
const NOW = 10_000_000
const OPTIONS = [{ id: 'edit', label: 'Editar' }]

const FIELDS: FormField[] = [
  { kind: 'context', text: 'Edite a decisão' },
  { kind: 'longText', id: 'why', label: 'Motivo', optional: false, minLength: 3, maxLength: 200, initial: 'antes' },
  { kind: 'select', id: 'pick', label: 'Escolha', optional: true, choices: { options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] } },
]
const FORM = { title: 'Editar decisão', submitLabel: 'Salvar', fields: FIELDS }

interface Raw {
  id: string
  sender: string
  ts?: number
  content?: Record<string, unknown>
  utd?: boolean
  redacted?: boolean
}

class FakeEvent extends EventEmitter {
  status = null
  constructor(public raw: Raw) {
    super()
  }
  getId = () => this.raw.id
  getSender = () => this.raw.sender
  getTs = () => this.raw.ts ?? NOW - 1_000
  getType = () => 'm.room.message'
  getContent = () => (this.raw.utd === true ? {} : (this.raw.content ?? {}))
  getOriginalContent = () => this.getContent()
  getWireContent = () => {
    const rel = this.raw.content?.['m.relates_to']
    return rel !== undefined ? { 'm.relates_to': rel } : {}
  }
  isDecryptionFailure = () => this.raw.utd === true
  isEncrypted = () => true
  getClearContent = () => (this.raw.utd === true ? null : this.getContent())
  isRedacted = () => this.raw.redacted === true
  localRedactionEvent = () => null
  replacingEvent = () => null
  // The key arrives: the clear content is there, and the event says so.
  decrypt(): void {
    this.raw.utd = false
    this.emit('Event.decrypted', this)
  }
}

const card = (sender = ME) => new FakeEvent({ id: '$card', sender, content: { msgtype: 'io.tayet.approval', body: 'Publicar?', 'io.tayet.approval': { options: OPTIONS } } })
const answer = (sender = ALICE) => new FakeEvent({ id: '$ans', sender, content: { msgtype: 'io.tayet.approval.response', 'io.tayet.approval.response': { option: 'edit' }, 'm.relates_to': { rel_type: 'io.tayet.response', event_id: '$card' } } })
const command = (sender = ALICE) => new FakeEvent({ id: '$cmd', sender, content: { msgtype: 'm.text', body: '/editar algo' } })
const definition = (id: string, anchor: string, trigger: string, sender = ME, meta: string | undefined = '{"view":"edit"}') =>
  new FakeEvent({ id, sender, content: buildFormDefinitionContent(anchor, trigger, FORM.title, FORM.submitLabel, FIELDS, meta) })
const submission = (id: string, anchor: string, form: string, values: Record<string, string | string[]>, extra: Partial<Raw> = {}) =>
  new FakeEvent({ id, sender: ALICE, content: buildFormSubmissionContent(anchor, form, FORM.title, values, [{ id: 'why', label: 'Motivo' }]), ...extra })

const ANSWERED: CardReading = { state: { kind: 'answered', by: ALICE as never, at: 5 as never, option: 'edit' }, closedAt: undefined, ignored: [], answerIds: ['$ans'], decidedId: '$ans' }
const OPEN: CardReading = { state: { kind: 'open' }, closedAt: undefined, ignored: [], answerIds: [] }

function world(opts: { events?: FakeEvent[]; reading?: CardReading; commandFor?: boolean } = {}) {
  const local = new Map((opts.events ?? []).map((e) => [e.raw.id, e]))
  const room = {
    roomId: ROOM,
    getMyMembership: () => 'join',
    findEventById: (id: string) => local.get(id),
    getPendingEvents: () => [],
  }
  const resolver: Resolver = {
    roomAnyOf: (t) => {
      if (t !== CONV) throw new ReadError('conversation_not_found')
      return room as never
    },
    userOf: (t) => {
      const u = { UALICE00000: ALICE, UBOB0000000: BOB }[t]
      if (u === undefined) throw new ReadError('user_not_found')
      return u
    },
    eventOf: (_r, ts) => (ts.startsWith('ts-') ? Promise.resolve(ts.slice(3)) : Promise.reject(new ReadError('message_not_found'))),
    tsOf: (_r, id) => `ts-${id}`,
    tsOfRelated: (_r, id) => Promise.resolve(`ts-${id}`),
    tokenOfRoom: () => CONV,
    tokenOfPerson: (u) => ({ [ALICE]: 'UALICE00000', [BOB]: 'UBOB0000000', [ME]: 'UME00000000' })[u] ?? 'U??????????',
    file: () => undefined,
    noteFile: () => 'F',
  }
  const jobs: WriteJob[] = []
  const logs: Array<Record<string, unknown>> = []
  const reads: Array<{ cardId: string; fresh?: boolean }> = []
  const fetched: string[] = []
  let n = 0
  const reader: CardReader = {
    read: (_room, cardId, _options, o = {}) => {
      reads.push({ cardId, ...(o.fresh !== undefined && { fresh: o.fresh }) })
      return Promise.resolve(opts.reading ?? ANSWERED)
    },
  }
  const client = {
    getUserId: () => ME,
    fetchRoomEvent: (_r: string, id: string) => {
      fetched.push(id)
      return id.startsWith('$sent') ? Promise.resolve({ event_id: id, origin_server_ts: 2_000 }) : Promise.reject(new Error('not found'))
    },
    decryptEventIfNeeded: () => Promise.resolve(),
    relations: () => Promise.resolve({ events: [] }),
    uploadContent: () => Promise.reject(new Error('no')),
    getMediaConfig: () => Promise.resolve({}),
    http: { authedRequest: () => Promise.reject(new Error('no')) },
  }
  const core = createFormCore({
    client,
    resolver,
    enqueue: (job: WriteJob): Promise<SendResult> => {
      jobs.push(job)
      return Promise.resolve({ ok: true, messageId: `$sent${++n}` })
    },
    onRevoked: () => {},
    log: (line) => logs.push(line),
    reader,
    commandAt: () => opts.commandFor ?? true,
    now: () => NOW,
  })
  const got: FormSubmitted[] = []
  const note = async (ev: FakeEvent) => {
    core.noteEvent(ev as never, room as never)
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
  }
  return { core, jobs, logs, reads, fetched, got, note, listen: () => core.facade.listen((s) => got.push(s)) }
}

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p
    return 'ok'
  } catch (err) {
    return (err as { code: string }).code
  }
}
const contentOf = (job: WriteJob | undefined) => (job as { content?: Record<string, unknown> } | undefined)?.content
const reasons = (logs: Array<Record<string, unknown>>) => logs.filter((l) => l.evt === 'form-submission-ignored').map((l) => l.reason)

describe('open', () => {
  it('from a click: the card read fresh, the deciding answer is the trigger, the card the anchor; written through the queue', async () => {
    const w = world({ events: [card()] })
    const out = await w.core.facade.open({ conversation: CONV, origin: { kind: 'card', card: 'ts-$card', person: 'UALICE00000' }, form: FORM, meta: '{"view":"edit"}' })
    expect(out).toEqual({ id: 'ts-$sent1' })
    expect(w.reads).toEqual([{ cardId: '$card', fresh: true }])
    expect(w.jobs).toEqual([{ kind: 'content', channel: ROOM, content: buildFormDefinitionContent('$card', '$ans', FORM.title, FORM.submitLabel, FIELDS, '{"view":"edit"}') }])
  })

  it('from a command for this agent: the message is the trigger and the anchor', async () => {
    const w = world({ events: [command()] })
    await w.core.facade.open({ conversation: CONV, origin: { kind: 'command', message: 'ts-$cmd' }, form: FORM })
    expect(contentOf(w.jobs[0])).toEqual(buildFormDefinitionContent('$cmd', '$cmd', FORM.title, FORM.submitLabel, FIELDS))
  })

  it('refused before any effect: another author’s card, no deciding answer, another person’s answer, no command for this agent', async () => {
    const other = world({ events: [card(OTHER_AGENT)] })
    expect(await code(other.core.facade.open({ conversation: CONV, origin: { kind: 'card', card: 'ts-$card', person: 'UALICE00000' }, form: FORM }))).toBe('not_own_message')
    const open = world({ events: [card()], reading: OPEN })
    const err = await open.core.facade.open({ conversation: CONV, origin: { kind: 'card', card: 'ts-$card', person: 'UALICE00000' }, form: FORM }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(FormError)
    expect((err as FormError).code).toBe('origin_mismatch')
    const bob = world({ events: [card()] })
    expect(await code(bob.core.facade.open({ conversation: CONV, origin: { kind: 'card', card: 'ts-$card', person: 'UBOB0000000' }, form: FORM }))).toBe('origin_mismatch')
    const noCommand = world({ events: [command()], commandFor: false })
    expect(await code(noCommand.core.facade.open({ conversation: CONV, origin: { kind: 'command', message: 'ts-$cmd' }, form: FORM }))).toBe('origin_mismatch')
    const notCard = world({ events: [command(ME)] })
    expect(await code(notCard.core.facade.open({ conversation: CONV, origin: { kind: 'card', card: 'ts-$cmd', person: 'UALICE00000' }, form: FORM }))).toBe('not_approval')
    for (const w of [other, open, bob, noCommand, notCard]) expect(w.jobs).toEqual([])
  })

  it('an invalid definition is refused before any effect; a key the schema does not know never reaches the conversation', async () => {
    const w = world({ events: [card()] })
    const open = (form: unknown, meta?: unknown) =>
      code(w.core.facade.open({ conversation: CONV, origin: { kind: 'card', card: 'ts-$card', person: 'UALICE00000' }, form: form as never, meta }))
    expect(await open({ ...FORM, title: 'x'.repeat(25) })).toBe('invalid_argument')
    expect(await open({ ...FORM, fields: [] })).toBe('invalid_argument')
    expect(await open({ ...FORM, fields: [{ kind: 'file', id: 'f', label: 'F' }] })).toBe('invalid_argument')
    expect(await open({ ...FORM, fields: [null] })).toBe('invalid_argument')
    expect(await open({ ...FORM, fields: 'x' })).toBe('invalid_argument')
    expect(await open(FORM, 7)).toBe('invalid_argument')
    expect(await open(FORM, 'x'.repeat(4097))).toBe('invalid_argument')
    expect(await code(w.core.facade.open({ conversation: CONV, origin: { kind: 'elsewhere' } as never, form: FORM }))).toBe('invalid_argument')
    expect(w.jobs).toEqual([])
    expect(await open({ ...FORM, fields: [{ ...FIELDS[1], extra: 'kept?' }] })).toBe('ok')
    expect(JSON.stringify(contentOf(w.jobs[0]))).not.toContain('extra')
  })
})

describe('the watch of submissions', () => {
  const clickWorld = (extra: FakeEvent[] = [], opts: { def?: FakeEvent } = {}) =>
    world({ events: [card(), answer(), opts.def ?? definition('$def', '$card', '$ans'), command(), definition('$def2', '$cmd', '$cmd'), ...extra] })

  it('a valid submission from a click: handed to the listener once, in tokens, with the definition’s fields and meta', async () => {
    const w = clickWorld()
    w.listen()
    const ev = submission('$sub1', '$card', '$def', { why: 'porque sim', pick: 'b' })
    await w.note(ev)
    await w.note(ev)
    expect(w.got).toEqual([
      {
        conversation: CONV,
        form: { id: 'ts-$def', title: FORM.title, submitLabel: FORM.submitLabel, fields: FIELDS, meta: '{"view":"edit"}' },
        submission: { id: 'ts-$sub1', by: 'UALICE00000', at: NOW - 1_000, values: { why: 'porque sim', pick: 'b' } },
        origin: { kind: 'card', anchor: 'ts-$card' },
      },
    ])
    expect(w.logs).toEqual([{ evt: 'form-submission-accepted' }])
  })

  it('from a command: the origin is the command, its message the anchor', async () => {
    const w = clickWorld()
    w.listen()
    await w.note(submission('$sub2', '$cmd', '$def2', { why: 'abc' }))
    expect(w.got.map((g) => g.origin)).toEqual([{ kind: 'command', anchor: 'ts-$cmd' }])
  })

  it('ignored with a reason: not the trigger’s owner; another author’s definition; invalid values; an unknown field; too old; malformed', async () => {
    const w = clickWorld([definition('$foreign', '$card', '$ans', OTHER_AGENT)])
    w.listen()
    await w.note(new FakeEvent({ ...submission('$s1', '$card', '$def', { why: 'abc' }).raw, sender: BOB }))
    await w.note(submission('$s2', '$card', '$foreign', { why: 'abc' }))
    await w.note(submission('$s3', '$card', '$def', { why: 'ab' }))
    await w.note(submission('$s4', '$card', '$def', { why: 'abc', other: 'x' }))
    await w.note(submission('$s5', '$card', '$def', { why: 'abc' }, { ts: NOW - FORM_SUBMISSION_MAX_AGE_MS - 1 }))
    await w.note(new FakeEvent({ id: '$s6', sender: ALICE, content: { msgtype: 'io.tayet.form.submission', 'io.tayet.form.submission': { values: {} }, 'm.relates_to': { rel_type: 'io.tayet.form', event_id: '$card' } } }))
    await w.note(submission('$s7', '$cmd', '$def', { why: 'abc' }))
    expect(reasons(w.logs)).toEqual(['not-owner', 'unknown-form', 'invalid-values', 'invalid-values', 'too-old', 'malformed', 'unknown-form'])
    expect(w.got).toEqual([])
  })

  it('a submission up to a minute old is taken', async () => {
    const w = clickWorld()
    w.listen()
    await w.note(submission('$s', '$card', '$def', { why: 'abc' }, { ts: NOW - FORM_SUBMISSION_MAX_AGE_MS }))
    expect(w.got).toHaveLength(1)
  })

  it('the agent’s own messages and other relations are not looked at', async () => {
    const w = clickWorld()
    w.listen()
    await w.note(new FakeEvent({ ...submission('$mine', '$card', '$def', { why: 'abc' }).raw, sender: ME }))
    await w.note(answer())
    expect(w.got).toEqual([])
    expect(w.logs).toEqual([])
  })

  it('a submission that cannot be read waits for its key, and is taken once it decrypts', async () => {
    const w = clickWorld()
    w.listen()
    const ev = submission('$late', '$card', '$def', { why: 'abc' }, { utd: true })
    await w.note(ev)
    expect(w.got).toEqual([])
    ev.decrypt()
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
    expect(w.got.map((g) => g.submission.id)).toEqual(['ts-$late'])
  })

  it('a decryption that still fails keeps the wait: the next one that reads it is taken; the listener leaves', async () => {
    const w = clickWorld()
    w.listen()
    const ev = submission('$retry', '$card', '$def', { why: 'abc' }, { utd: true })
    await w.note(ev)
    ev.emit('Event.decrypted', ev)
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
    expect(w.got).toEqual([])
    expect(ev.listenerCount('Event.decrypted')).toBe(1)
    ev.decrypt()
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
    expect(w.got.map((g) => g.submission.id)).toEqual(['ts-$retry'])
    expect(ev.listenerCount('Event.decrypted')).toBe(0)
  })

  it('no key within the minute: the wait ends with one line, the listener leaves, a later key reads nothing', async () => {
    const w = clickWorld()
    w.listen()
    const ev = submission('$never', '$card', '$def', { why: 'abc' }, { utd: true, ts: NOW - FORM_SUBMISSION_MAX_AGE_MS + 20 })
    await w.note(ev)
    expect(ev.listenerCount('Event.decrypted')).toBe(1)
    await expect.poll(() => ev.listenerCount('Event.decrypted')).toBe(0)
    expect(w.logs).toEqual([{ evt: 'form-submission-ignored', reason: 'unreadable' }])
    ev.decrypt()
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
    expect(w.got).toEqual([])
  })

  it('no listener: the submission is ignored as before, nothing is read', async () => {
    const w = clickWorld()
    await w.note(submission('$s', '$card', '$def', { why: 'abc' }))
    expect(w.got).toEqual([])
    expect(w.logs).toEqual([])
    expect(w.fetched).toEqual([])
  })
})

describe('result', () => {
  const accepted = async (fieldsDef?: FakeEvent) => {
    const w = world({ events: [card(), answer(), fieldsDef ?? definition('$def', '$card', '$ans')] })
    w.listen()
    await w.note(submission('$sub', '$card', '$def', { why: 'abc' }))
    expect(w.got).toHaveLength(1)
    return w
  }
  const resultBlock = (job: WriteJob | undefined) => contentOf(job)?.['io.tayet.form.result']

  it('ok, errors by field, refused: each one through the queue, related to the anchor; once per submission', async () => {
    const ok = await accepted()
    await ok.core.facade.result(CONV, 'ts-$sub', { ok: true })
    expect(contentOf(ok.jobs[0])).toMatchObject({ msgtype: 'io.tayet.form.result', 'm.relates_to': { rel_type: 'io.tayet.form', event_id: '$card' } })
    expect(resultBlock(ok.jobs[0])).toEqual({ submission: '$sub', ok: true })
    expect(await code(ok.core.facade.result(CONV, 'ts-$sub', { ok: true }))).toBe('message_not_found')

    const errors = await accepted()
    await errors.core.facade.result(CONV, 'ts-$sub', { errors: { why: 'Curto demais' } })
    expect(resultBlock(errors.jobs[0])).toEqual({ submission: '$sub', errors: { why: 'Curto demais' } })

    const refused = await accepted()
    await refused.core.facade.result(CONV, 'ts-$sub', { refused: true })
    expect(resultBlock(refused.jobs[0])).toEqual({ submission: '$sub', errors: { _: 'refused' } })
  })

  it('refused picks a key that is no field id', async () => {
    const fields: FormField[] = [
      { kind: 'text', id: '_', label: 'A', optional: true, minLength: 0, maxLength: 10 },
      { kind: 'text', id: 'why', label: 'B', optional: true, minLength: 0, maxLength: 10 },
    ]
    const def = new FakeEvent({ id: '$def', sender: ME, content: buildFormDefinitionContent('$card', '$ans', 'T', 'S', fields) })
    const w = await accepted(def)
    await w.core.facade.result(CONV, 'ts-$sub', { refused: true })
    expect(resultBlock(w.jobs[0])).toEqual({ submission: '$sub', errors: { __: 'refused' } })
  })

  it('refused as invalid_argument: an error key that is no field id, a message outside 1..300, none, or a mixed outcome', async () => {
    const w = await accepted()
    for (const outcome of [{ errors: { nope: 'x' } }, { errors: { why: '' } }, { errors: { why: 'x'.repeat(301) } }, { errors: {} }, { ok: true, errors: { why: 'x' } }, { errors: { why: 7 } }, {}]) {
      expect(await code(w.core.facade.result(CONV, 'ts-$sub', outcome as never)), JSON.stringify(outcome)).toBe('invalid_argument')
    }
    await w.core.facade.result(CONV, 'ts-$sub', { errors: { why: '🙂'.repeat(300) } })
    expect(w.jobs).toHaveLength(1)
  })

  it('a submission this run did not hand over: message_not_found', async () => {
    const w = world({ events: [card()] })
    expect(await code(w.core.facade.result(CONV, 'ts-$sub', { ok: true }))).toBe('message_not_found')
    expect(await code(w.core.facade.result('CBBBBBBBBBB', 'ts-$sub', { ok: true }))).toBe('conversation_not_found')
    expect(w.jobs).toEqual([])
  })
})

describe('logs', () => {
  it('no log line carries an id, a value or a label', async () => {
    const w = world({ events: [card(), answer(), definition('$def', '$card', '$ans'), definition('$foreign', '$card', '$ans', OTHER_AGENT)] })
    w.listen()
    await w.note(submission('$a', '$card', '$def', { why: 'segredo-123' }))
    await w.note(submission('$b', '$card', '$foreign', { why: 'segredo-123' }))
    await w.note(submission('$c', '$card', '$def', { why: 'x' }))
    await w.note(new FakeEvent({ ...submission('$d', '$card', '$def', { why: 'segredo-123' }).raw, sender: BOB }))
    await w.core.facade.result(CONV, 'ts-$a', { errors: { why: 'Mensagem do agente' } })
    expect(w.logs.length).toBeGreaterThan(3)
    const text = JSON.stringify(w.logs)
    for (const forbidden of ['$', '!', '@', 'ts-', 'UALICE', 'segredo', 'Motivo', 'Editar', 'Mensagem', 'why', CONV]) expect(text).not.toContain(forbidden)
  })
})

describe('WriteError codes stay the write path’s', () => {
  it('FormError is its own class', () => {
    expect(new FormError('origin_mismatch')).not.toBeInstanceOf(WriteError)
  })
})
