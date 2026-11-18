import { describe, it, expect, beforeEach } from 'vitest'
import { MatrixEvent, type IEvent } from 'matrix-js-sdk'
import type { AgentForm, FormId } from '../src/acl'
import { FORM_BLOCK, FORM_MSGTYPE, FORM_REL_TYPE, FORM_RESULT_BLOCK, FORM_RESULT_MSGTYPE, readFormDefinition } from '@tayet/shared/internal'
import {
  FORM_ANSWER_TIMEOUT_MS,
  FormReplies,
  FormSession,
  formRelatedOf,
  type DefinitionFact,
  type FormClock,
  type FormSessionPorts,
} from '../src/acl/internal/form-state'

// An agent's form in this session: which definitions open, the wait for the own send, the senders that
// count, and the state machine under a fake clock.

const ROOM = '!room:tayet.local'
const AGENT = '@a-abcdefghijkm:tayet.local'
const OTHER_AGENT = '@a-mnopqrstuvwx:tayet.local'
const ALICE = '@alice:tayet.local'

class FakeClock implements FormClock {
  now = 0
  private timers: Array<{ at: number; fn: () => void; id: number }> = []
  private next = 0
  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.next
    this.timers.push({ at: this.now + ms, fn, id })
    return id
  }
  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== handle)
  }
  advance(ms: number): void {
    this.now += ms
    const due = this.timers.filter((t) => t.at <= this.now)
    this.timers = this.timers.filter((t) => t.at > this.now)
    for (const t of due) t.fn()
  }
}

const definition = readFormDefinition({
  [FORM_BLOCK]: { trigger: '$answer', title: 'Edit', submitLabel: 'Save', fields: [{ kind: 'text', id: 'title', label: 'Title' }] },
})!
const fact = (over: Partial<DefinitionFact> = {}, trigger = '$answer'): DefinitionFact => ({
  id: '$form',
  roomId: ROOM,
  sender: AGENT,
  anchorId: '$card',
  anchorMessage: '$card',
  definition: { ...definition, trigger },
  ...over,
})

describe('FormSession', () => {
  let clock: FakeClock
  let events: Array<{ t: string; form: AgentForm }>
  let sends: Array<{ resolve: (id: string) => void; reject: (e: Error) => void; values: unknown; labels: unknown }>
  let session: FormSession

  beforeEach(() => {
    clock = new FakeClock()
    events = []
    sends = []
    const ports: FormSessionPorts = {
      send: (_room, _anchor, _form, _title, values, labels) => new Promise((resolve, reject) => sends.push({ resolve, reject, values, labels })),
      emit: (e) => events.push(e),
      clock,
    }
    session = new FormSession(ports)
  })

  const ownAnswer = (id = '$answer') => session.beginOwnSend()({ id, roomId: ROOM, anchorId: '$card', agent: AGENT })
  const states = (): string[] => events.map((e) => (e.t === 'form.opened' ? 'opened' : e.form.state.kind))
  const flush = () => new Promise((r) => setTimeout(r, 0))
  const formId = '$form' as FormId

  async function sent(id = '$s1'): Promise<void> {
    const outcome = session.submit(formId, { title: 'x' })
    sends.at(-1)!.resolve(id)
    expect(await outcome).toEqual({ ok: true })
  }

  it('opens only for a trigger this instance sent', () => {
    session.noteDefinition(fact())
    expect(events).toHaveLength(0)
    ownAnswer()
    session.noteDefinition(fact())
    expect(events).toEqual([{ t: 'form.opened', channelId: ROOM, form: expect.objectContaining({ id: '$form', anchor: '$card', agent: AGENT, state: { kind: 'open' } }) }])
  })

  it('waits for the own send to be confirmed, then opens; a failed send drops the wait', () => {
    const settle = session.beginOwnSend()
    session.noteDefinition(fact())
    expect(events).toHaveLength(0)
    settle({ id: '$answer', roomId: ROOM, anchorId: '$card', agent: AGENT })
    expect(states()).toEqual(['opened'])

    const other = new FormSession({ send: async () => '', emit: (e) => events.push(e), clock })
    const fail = other.beginOwnSend()
    other.noteDefinition(fact())
    fail()
    expect(states()).toEqual(['opened'])
  })

  it('ignores a definition from another agent, another anchor or another room', () => {
    ownAnswer()
    session.noteDefinition(fact({ sender: OTHER_AGENT }))
    session.noteDefinition(fact({ sender: ALICE }))
    session.noteDefinition(fact({ anchorId: '$other' }))
    session.noteDefinition(fact({ roomId: '!other:tayet.local' }))
    expect(events).toHaveLength(0)
  })

  it('one form at a time: a second definition for the same trigger, or one while another is open, is ignored', () => {
    ownAnswer()
    ownAnswer('$answer2')
    session.noteDefinition(fact())
    session.noteDefinition(fact({ id: '$form2' }))
    session.noteDefinition(fact({ id: '$form3' }, '$answer2'))
    expect(states()).toEqual(['opened'])
  })

  it('values with issues come back by field and nothing is sent', async () => {
    ownAnswer()
    session.noteDefinition(fact())
    expect(await session.submit(formId, {})).toEqual({ issues: { title: { code: 'required' } } })
    expect(sends).toHaveLength(0)
  })

  it('sending → failed', async () => {
    ownAnswer()
    session.noteDefinition(fact())
    const outcome = session.submit(formId, { title: 'x' })
    sends[0]!.reject(new Error('down'))
    await expect(outcome).rejects.toThrow('down')
    expect(states()).toEqual(['opened', 'sending', 'failed'])
  })

  it('sending → noAnswer at 15 s and not before; then a late ok → done', async () => {
    ownAnswer()
    session.noteDefinition(fact())
    await sent()
    clock.advance(FORM_ANSWER_TIMEOUT_MS - 1)
    expect(states()).toEqual(['opened', 'sending'])
    clock.advance(1)
    expect(states()).toEqual(['opened', 'sending', 'noAnswer'])
    session.noteResult({ roomId: ROOM, sender: AGENT, result: { submission: '$s1', ok: true } })
    expect(states()).toEqual(['opened', 'sending', 'noAnswer', 'done'])
  })

  it('errors → sending → done, with the agent’s messages', async () => {
    ownAnswer()
    session.noteDefinition(fact())
    await sent('$s1')
    session.noteResult({ roomId: ROOM, sender: AGENT, result: { submission: '$s1', errors: { title: 'Too short' } } })
    expect(events.at(-1)!.form.state).toEqual({ kind: 'errors', errors: { title: 'Too short' } })
    await sent('$s2')
    session.noteResult({ roomId: ROOM, sender: AGENT, result: { submission: '$s2', ok: true } })
    expect(states()).toEqual(['opened', 'sending', 'errors', 'sending', 'done'])
    clock.advance(FORM_ANSWER_TIMEOUT_MS)
    expect(states().at(-1)).toBe('done')
  })

  it('the send carries the labels of the fields sent; a resend after errors carries those of the second values', async () => {
    const order = readFormDefinition({
      [FORM_BLOCK]: {
        trigger: '$answer',
        title: 'Order',
        submitLabel: 'Send',
        fields: [
          { kind: 'context', text: 'Fill in the order' },
          { kind: 'text', id: 'supplier', label: 'Supplier', hint: 'Who sells it' },
          { kind: 'select', id: 'centre', label: 'Cost centre', options: [{ value: 'cc-210', label: 'Marketing', description: 'Team budget' }, { value: 'cc-300', label: 'Sales' }] },
          { kind: 'multiSelect', id: 'items', label: 'Items', optional: true, options: [{ value: 'a4', label: 'A4 paper' }, { value: 'toner', label: 'Toner' }] },
        ],
      },
    })!
    ownAnswer()
    session.noteDefinition(fact({ definition: order }))
    const first = session.submit(formId, { supplier: 'Porto Print', centre: 'cc-210', items: [] })
    sends.at(-1)!.resolve('$s1')
    await first
    expect(sends[0]!.values).toEqual({ supplier: 'Porto Print', centre: 'cc-210' })
    expect(sends[0]!.labels).toEqual([
      { id: 'supplier', label: 'Supplier' },
      { id: 'centre', label: 'Cost centre', options: [{ value: 'cc-210', label: 'Marketing' }] },
    ])
    session.noteResult({ roomId: ROOM, sender: AGENT, result: { submission: '$s1', errors: { centre: 'Closed' } } })
    const second = session.submit(formId, { supplier: 'Porto Print', centre: 'cc-300', items: ['toner', 'a4'] })
    sends.at(-1)!.resolve('$s2')
    await second
    expect(sends[1]!.labels).toEqual([
      { id: 'supplier', label: 'Supplier' },
      { id: 'centre', label: 'Cost centre', options: [{ value: 'cc-300', label: 'Sales' }] },
      { id: 'items', label: 'Items', options: [{ value: 'toner', label: 'Toner' }, { value: 'a4', label: 'A4 paper' }] },
    ])
  })

  it('a result from anyone but the definition’s author is ignored', async () => {
    ownAnswer()
    session.noteDefinition(fact())
    await sent()
    session.noteResult({ roomId: ROOM, sender: OTHER_AGENT, result: { submission: '$s1', ok: true } })
    session.noteResult({ roomId: ROOM, sender: ALICE, result: { submission: '$s1', ok: true } })
    session.noteResult({ roomId: ROOM, sender: AGENT, result: { submission: '$unknown', ok: true } })
    expect(states()).toEqual(['opened', 'sending'])
  })

  it('a result that arrives before the server confirmed the submission waits for it', async () => {
    ownAnswer()
    session.noteDefinition(fact())
    const outcome = session.submit(formId, { title: 'x' })
    session.noteResult({ roomId: ROOM, sender: AGENT, result: { submission: '$s1', ok: true } })
    expect(states()).toEqual(['opened', 'sending'])
    sends[0]!.resolve('$s1')
    await outcome
    expect(states()).toEqual(['opened', 'sending', 'done'])
  })

  it('done frees the session: a new definition of another own trigger opens without closeForm', async () => {
    ownAnswer()
    ownAnswer('$answer2')
    session.noteDefinition(fact())
    await sent()
    session.noteResult({ roomId: ROOM, sender: AGENT, result: { submission: '$s1', ok: true } })
    session.noteDefinition(fact({ id: '$form2' }, '$answer2'))
    expect(states()).toEqual(['opened', 'sending', 'done', 'opened'])
    expect(events.at(-1)!.form.id).toBe('$form2')
  })

  it('after done, closeForm does not throw and emits nothing; a late result emits nothing', async () => {
    ownAnswer()
    session.noteDefinition(fact())
    await sent()
    session.noteResult({ roomId: ROOM, sender: AGENT, result: { submission: '$s1', ok: true } })
    const before = events.length
    expect(() => session.close(formId)).not.toThrow()
    session.noteResult({ roomId: ROOM, sender: AGENT, result: { submission: '$s1', ok: true } })
    session.noteResult({ roomId: ROOM, sender: AGENT, result: { submission: '$s1', errors: { title: 'late' } } })
    clock.advance(FORM_ANSWER_TIMEOUT_MS)
    expect(events).toHaveLength(before)
  })

  it('closeForm, then a late result: nothing is emitted', async () => {
    ownAnswer()
    session.noteDefinition(fact())
    await sent()
    session.close(formId)
    const before = events.length
    session.noteResult({ roomId: ROOM, sender: AGENT, result: { submission: '$s1', ok: true } })
    clock.advance(FORM_ANSWER_TIMEOUT_MS)
    await flush()
    expect(events).toHaveLength(before)
    await expect(session.submit(formId, { title: 'x' })).rejects.toThrow('form not found')
  })
})

describe('formRelatedOf and FormReplies', () => {
  const ev = (id: string, sender: string, content: Record<string, unknown>, ts = 1): MatrixEvent =>
    new MatrixEvent({ type: 'm.room.message', event_id: id, room_id: ROOM, sender, origin_server_ts: ts, content } as Partial<IEvent>)
  const rel = { 'm.relates_to': { rel_type: FORM_REL_TYPE, event_id: '$cmd' } }

  it('reads a form message with its anchor; a malformed one is flagged', () => {
    const good = formRelatedOf(ev('$d', AGENT, { msgtype: FORM_MSGTYPE, body: 'Edit', ...rel, [FORM_BLOCK]: { trigger: '$cmd', title: 'Edit', submitLabel: 'Save', fields: [{ kind: 'text', id: 'a', label: 'A' }] } }))
    expect(good).toMatchObject({ anchorId: '$cmd', malformed: false, related: { kind: 'definition', sender: AGENT } })
    const bad = formRelatedOf(ev('$d', AGENT, { msgtype: FORM_MSGTYPE, body: 'Edit', ...rel, [FORM_BLOCK]: { title: 'x' } }))
    expect(bad).toEqual({ anchorId: '$cmd', malformed: true })
  })

  it('an own command message, watched before any translation, gains the reply when the ok result arrives', async () => {
    const changed: string[] = []
    const work: Array<Promise<unknown>> = []
    const replies = new FormReplies({
      fetchPage: async () => ({ related: [] }),
      senderOf: async () => undefined,
      changed: (_room, anchor) => changed.push(anchor),
      detach: (w) => work.push(w),
    })
    replies.watch(ROOM, '$cmd', { agent: AGENT, kind: 'command', sender: ALICE })
    await Promise.all(work)
    const live = [
      ev('$d', AGENT, { msgtype: FORM_MSGTYPE, body: 'E', ...rel, [FORM_BLOCK]: { trigger: '$cmd', title: 'E', submitLabel: 'S', fields: [{ kind: 'text', id: 'a', label: 'A' }] } }),
      ev('$s', ALICE, { msgtype: 'io.tayet.form.submission', body: 'E', ...rel, 'io.tayet.form.submission': { form: '$d', values: { a: 'x' } } }, 7),
      ev('$r', AGENT, { msgtype: FORM_RESULT_MSGTYPE, body: 'ok', ...rel, [FORM_RESULT_BLOCK]: { submission: '$s', ok: true } }),
    ]
    for (const e of live) replies.noteLive(ROOM, '$cmd', formRelatedOf(e).related!)
    await Promise.all(work)
    expect(changed).toEqual(['$cmd'])
    expect(replies.replyFor(ROOM, '$cmd', { agent: AGENT, kind: 'command', sender: ALICE })).toEqual({ by: ALICE, at: 7 })
  })

  it('reads the anchor’s relations once, then follows live messages; emits only when the reply moves', async () => {
    const changed: string[] = []
    const pages = [
      formRelatedOf(ev('$d', AGENT, { msgtype: FORM_MSGTYPE, body: 'E', ...rel, [FORM_BLOCK]: { trigger: '$cmd', title: 'E', submitLabel: 'S', fields: [{ kind: 'text', id: 'a', label: 'A' }] } })).related!,
      formRelatedOf(ev('$s', ALICE, { msgtype: 'io.tayet.form.submission', body: 'E', ...rel, 'io.tayet.form.submission': { form: '$d', values: { a: 'x' } } }, 42)).related!,
    ]
    const work: Array<Promise<unknown>> = []
    const replies = new FormReplies({
      fetchPage: async () => ({ related: pages }),
      senderOf: async () => undefined,
      changed: (_room, anchor) => changed.push(anchor),
      detach: (w) => work.push(w),
    })
    const anchor = { agent: AGENT, kind: 'command' as const, sender: ALICE }
    expect(replies.replyFor(ROOM, '$cmd', anchor)).toBeUndefined()
    await Promise.all(work)
    expect(changed).toEqual([])
    const result = formRelatedOf(ev('$r', AGENT, { msgtype: FORM_RESULT_MSGTYPE, body: 'ok', ...rel, [FORM_RESULT_BLOCK]: { submission: '$s', ok: true } })).related!
    replies.noteLive(ROOM, '$cmd', result)
    await Promise.all(work)
    expect(changed).toEqual(['$cmd'])
    expect(replies.replyFor(ROOM, '$cmd', anchor)).toEqual({ by: ALICE, at: 42 })
  })
})
