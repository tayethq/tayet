import { describe, expect, it } from 'vitest'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { readExportManifest, type Channel, type MediaRef, type Message } from '@tayet/shared'
import {
  APPROVAL_RESPONSE_MSGTYPE,
  EDIT_REDACTION_FIELD,
  FORM_REL_TYPE,
  FORM_RESULT_BLOCK,
  FORM_RESULT_MSGTYPE,
  FORM_SUBMISSION_BLOCK,
  RESPONSE_REL_TYPE,
  buildFormSubmissionContent,
  type FormSubmissionLabel,
} from '@tayet/shared/internal'
import {
  EXPORT_ATTACHMENT_ATTEMPTS,
  EXPORT_KEY_WAIT_PER_CONVERSATION_MS,
  EXPORT_KEY_WAIT_TOTAL_MS,
  EXPORT_OFFLINE_WINDOW_MS,
  EXPORT_PAGE_SIZE,
  runDataExport,
  type DataExportAccount,
  type DataExportPorts,
  type ExportEventView,
} from '../src/acl/internal/data-export'
import type { DataExportPart } from '../src/acl'

// ADR-096, PLANO-EXPORT-DADOS §0.3.3 and §0.3.5: the export engine over fake ports — the walk, the
// classification of the raw events (deleted markers, edits, answers to cards, form submissions), the wait for keys, the
// attachments, the failure window, cancellation and the order of the parts. The ids below are shaped like
// protocol ids on purpose: none of them may reach a path or a file.

const ME = '@me:test.example'
const OTHER = '@other:test.example'
const AGENT = '@agent-bot:test.example'

// A fake raw event: the view the engine reads, mutable so a key can "arrive" during a wait.
type Ev = ExportEventView

let seq = 0
const nextId = (): string => `$e${++seq}:test.example`

function text(sentAt: number, body: string, extra: Record<string, unknown> = {}, id = nextId()): Ev {
  const content = { msgtype: 'm.text', body, ...extra }
  return { id, type: 'm.room.encrypted', sentAt, redacted: false, wire: pickRel(content), content }
}

function pickRel(content: Record<string, unknown>): Record<string, unknown> {
  return { algorithm: 'x', ...(content['m.relates_to'] !== undefined && { 'm.relates_to': content['m.relates_to'] }) }
}

function edit(sentAt: number, target: string, body: string, id = nextId()): Ev {
  const content = {
    msgtype: 'm.text',
    body: `* ${body}`,
    'm.new_content': { msgtype: 'm.text', body },
    'm.relates_to': { rel_type: 'm.replace', event_id: target },
  }
  return { id, type: 'm.room.encrypted', sentAt, redacted: false, wire: pickRel(content), content }
}

function gone(sentAt: number, id = nextId(), type = 'm.room.encrypted'): Ev {
  return { id, type, sentAt, redacted: true, wire: {}, content: {} }
}

function redaction(sentAt: number, target: string, opts: { field?: boolean; inContent?: boolean } = {}): Ev {
  const content: Record<string, unknown> = {
    ...(opts.field && { [EDIT_REDACTION_FIELD]: true }),
    ...(opts.inContent && { redacts: target }),
  }
  return { id: nextId(), type: 'm.room.redaction', sentAt, redacted: false, wire: content, content, ...(!opts.inContent && { redacts: target }) }
}

function member(sentAt: number, membership: string, stateKey = ME): Ev {
  const content = { membership }
  return { id: nextId(), type: 'm.room.member', sentAt, redacted: false, stateKey, wire: content, content }
}

function answer(sentAt: number, card: string, label: string): Ev {
  const content = { msgtype: APPROVAL_RESPONSE_MSGTYPE, body: label, 'm.relates_to': { rel_type: RESPONSE_REL_TYPE, event_id: card } }
  return { id: nextId(), type: 'm.room.encrypted', sentAt, redacted: false, wire: pickRel(content), content, folded: 'response' }
}

const PURCHASE_LABELS: FormSubmissionLabel[] = [
  { id: 'supplier', label: 'Supplier' },
  { id: 'centre', label: 'Cost centre', options: [{ value: 'cc-210', label: 'Marketing' }] },
  { id: 'items', label: 'Items', options: [{ value: 'a4', label: 'A4 paper' }, { value: 'toner', label: 'Toner' }] },
]
const PURCHASE_VALUES = { supplier: 'Porto Print', centre: 'cc-210', items: ['a4', 'toner'] }

// The person's submission of a form, as the client writes it; `labels: null` = one sent before the copy.
function submission(
  sentAt: number,
  form: string,
  o: { values?: Record<string, string | string[]>; labels?: FormSubmissionLabel[] | null; title?: string } = {},
): Ev {
  const content = buildFormSubmissionContent('$anchor:test.example', form, o.title ?? 'Purchase order', o.values ?? PURCHASE_VALUES, o.labels ?? PURCHASE_LABELS) as Record<string, unknown>
  if (o.labels === null) {
    const { labels: _labels, ...block } = content[FORM_SUBMISSION_BLOCK] as Record<string, unknown>
    content[FORM_SUBMISSION_BLOCK] = block
  }
  return { id: nextId(), type: 'm.room.encrypted', sentAt, redacted: false, wire: pickRel(content), content, folded: 'form' }
}

// Another form event of the person's: a result, which never enters the export.
function formResult(sentAt: number, sub: string): Ev {
  const content = { msgtype: FORM_RESULT_MSGTYPE, body: 'ok', [FORM_RESULT_BLOCK]: { submission: sub, ok: true }, 'm.relates_to': { rel_type: FORM_REL_TYPE, event_id: '$anchor:test.example' } }
  return { id: nextId(), type: 'm.room.encrypted', sentAt, redacted: false, wire: pickRel(content), content, folded: 'form' }
}

function unread(ev: Ev, arrival: 'awaited' | 'stalled' = 'awaited'): Ev {
  const { content: _content, ...rest } = ev
  return { ...rest, undecrypted: arrival, hidden: ev.content } as Ev
}

// A key arrives: the hidden content becomes readable.
function arrive(ev: Ev): void {
  const hidden = (ev as Ev & { hidden?: Record<string, unknown> }).hidden
  delete ev.undecrypted
  ev.content = hidden
}

function channel(key: string, name: string, kind: Channel['kind']): Channel {
  return { id: key, name, kind, memberCount: 2, unread: { count: 0, mentions: 0 } } as unknown as Channel
}

interface Conv {
  key: string
  channel: Channel
  // Oldest first, like a conversation reads.
  events: Ev[]
}

class NoAnswer extends Error {}
class Limited extends Error {
  constructor(readonly waitMs?: number) {
    super('limited')
  }
}

const baseAccount = (): DataExportAccount => ({
  subject: { key: ME, name: 'Me Person', kind: 'member' },
  profile: { fullName: 'Me Person', jobTitle: 'Engineer' },
  accesses: [
    { name: 'Laptop', lastSeenAt: 1_000, current: true },
    { name: '  ', current: false },
  ],
  agents: [{ key: AGENT, name: 'Helper', kind: 'agent' }],
})

interface Options {
  conversations: Conv[]
  account?: DataExportAccount
  names?: Record<string, { name: string; kind: 'member' | 'guest' | 'agent' }>
  cards?: Record<string, string | undefined>
  media?: (ref: string, call: number) => Blob | Error
  mediaTypes?: Record<string, string>
  page?: (key: string, from: string | undefined, call: number) => Error | undefined
  onSleep?: (now: number) => void
  alive?: () => boolean
}

function harness(o: Options) {
  let clock = 0
  let held = 0
  const pageCalls: Array<{ key: string; from: string | undefined }> = []
  const mediaCalls: string[] = []
  const cardCalls: string[] = []
  const translated: string[] = []
  const slept: number[] = []
  const names = o.names ?? { [ME]: { name: 'Me Person', kind: 'member' }, [OTHER]: { name: 'Other Person', kind: 'member' }, [AGENT]: { name: 'Helper', kind: 'agent' } }
  const ports: DataExportPorts<Ev> = {
    hold: () => {
      held += 1
      let done = false
      return () => {
        if (!done) held -= 1
        done = true
      }
    },
    alive: () => (o.alive ? o.alive() : true),
    conversations: () => o.conversations.map(({ key, channel }) => ({ key, channel })),
    account: async () => o.account ?? baseAccount(),
    page: async (key, from) => {
      pageCalls.push({ key, from })
      const fail = o.page?.(key, from, pageCalls.length)
      if (fail) throw fail
      const newestFirst = [...o.conversations.find((c) => c.key === key)!.events].reverse()
      const start = from === undefined ? 0 : Number(from.split('#')[1])
      const events = newestFirst.slice(start, start + EXPORT_PAGE_SIZE)
      const next = start + EXPORT_PAGE_SIZE
      return { events, ...(next < newestFirst.length && { end: `${key}#${next}` }) }
    },
    decrypt: async () => {},
    view: (e) => ({ ...e }),
    translate: (_key, target, ed) => {
      translated.push(target.id)
      const content = (ed ? ed.content!['m.new_content'] : target.content) as Record<string, unknown>
      const mentions = ((content['m.mentions'] as { user_ids?: string[] } | undefined)?.user_ids ?? []) as string[]
      const base = { id: target.id, mentions } as unknown as Message
      const ref = `ref-${target.id}` as MediaRef
      switch (content.msgtype) {
        case 'm.text':
          return { ...base, body: { kind: 'text', text: content.body as string, ...(content.rich !== undefined && { rich: content.rich }) } } as Message
        case 'm.image':
          return { ...base, body: { kind: 'image', media: ref, alt: content.body as string } } as Message
        case 'm.file':
          return {
            ...base,
            body: { kind: 'file', media: ref, name: content.body as string, size: (content.size as number) ?? 0, mimetype: content.mimetype as string },
          } as Message
        case 'x.unknown':
          return { ...base, body: { kind: 'unsupported', shape: {} } } as Message
        default:
          return null
      }
    },
    cardAuthor: async (_key, card) => {
      cardCalls.push(card)
      return o.cards?.[card]
    },
    person: (_key, who) => names[who],
    media: async (ref) => {
      mediaCalls.push(ref)
      const out = o.media ? o.media(ref, mediaCalls.filter((r) => r === ref).length) : new Blob([`bytes of ${ref.length}`], { type: 'image/png' })
      if (out instanceof Error) throw out
      return out
    },
    mediaType: (ref) => o.mediaTypes?.[ref],
    classify: (err) => {
      if (err instanceof NoAnswer) return { kind: 'connection' }
      if (err instanceof Limited) return err.waitMs === undefined ? { kind: 'rateLimit' } : { kind: 'rateLimit', waitMs: err.waitMs }
      return { kind: 'other' }
    },
    now: () => clock,
    sleep: async (ms) => {
      slept.push(ms)
      clock += ms
      o.onSleep?.(clock)
    },
  }
  return {
    ports,
    pageCalls,
    mediaCalls,
    cardCalls,
    translated,
    slept,
    held: () => held,
    now: () => clock,
    // Time passing outside the engine (the consumer writing the zip, a suspended machine).
    advance: (ms: number) => {
      clock += ms
    },
  }
}

const OPTS = { readme: 'Read me.', unnamedAccess: 'Unnamed access' }

async function collect(ports: DataExportPorts<Ev>, opts: Parameters<typeof runDataExport>[1] = OPTS): Promise<DataExportPart[]> {
  const parts: DataExportPart[] = []
  for await (const part of runDataExport(ports, opts)) parts.push(part)
  return parts
}

const files = (parts: DataExportPart[]) => parts.filter((p): p is Extract<DataExportPart, { t: 'file' }> => p.t === 'file')
const fileAt = (parts: DataExportPart[], path: string): string => files(parts).find((f) => f.path === path)!.content
const items = (parts: DataExportPart[], n = 1) =>
  (JSON.parse(fileAt(parts, `conversations/c${n}.json`)) as { items: Array<Record<string, unknown>> }).items
const manifestOf = (parts: DataExportPart[]) => readExportManifest(fileAt(parts, 'manifest.json'))
const one = (events: Ev[], kind: Channel['kind'] = 'private'): Conv[] => [{ key: '!room1:test.example', channel: channel('!room1:test.example', '#room-one', kind), events }]

describe('data export engine — the walk (§0.3.3 B1/B2)', () => {
  it('walks pages of 100 back to the start of the conversation', async () => {
    const events = Array.from({ length: 250 }, (_, i) => text(1_000 + i, `msg ${i}`))
    const h = harness({ conversations: one(events) })
    const parts = await collect(h.ports)
    expect(h.pageCalls.map((c) => c.from)).toEqual([undefined, '!room1:test.example#100', '!room1:test.example#200'])
    expect(items(parts)).toHaveLength(250)
    expect(items(parts)[0]).toMatchObject({ type: 'message', text: 'msg 0' })
    expect(items(parts)[249]).toMatchObject({ type: 'message', text: 'msg 249' })
  })

  it('joinedAt is the first entry: leaving and coming back, a profile change and own events about others do not move it', async () => {
    const events = [
      member(10, 'join'),
      member(20, 'join'), // a profile change: membership stays join
      member(25, 'invite', OTHER), // the person invited someone: not about her
      member(30, 'leave'),
      member(40, 'join'),
      text(50, 'hello'),
    ]
    const parts = await collect(harness({ conversations: one(events) }).ports)
    expect(manifestOf(parts).conversations[0]!.joinedAt).toBe(new Date(10).toISOString())
  })

  it('no own entry event → no joinedAt', async () => {
    const parts = await collect(harness({ conversations: one([text(50, 'hello')]) }).ports)
    expect(manifestOf(parts).conversations[0]).not.toHaveProperty('joinedAt')
  })
})

describe('data export engine — classification (§0.3.3 C, §0.3.4 item 6, §0.3.5 item 5)', () => {
  it('the final version: two edits, only the latest applies and the edits are no items', async () => {
    const original = text(100, 'v0')
    const events = [original, edit(200, original.id, 'v1'), edit(300, original.id, 'v2')]
    const parts = await collect(harness({ conversations: one(events) }).ports)
    expect(items(parts)).toEqual([expect.objectContaining({ type: 'message', text: 'v2', editedAt: new Date(300).toISOString() })])
    expect(JSON.stringify(parts)).not.toMatch(/v0|v1/)
  })

  it('deleted exactly once: the original and two edits deleted, the edit redactions carry the field', async () => {
    const original = gone(100)
    const e1 = gone(200)
    const e2 = gone(300)
    const events = [original, e1, e2, redaction(400, original.id), redaction(401, e1.id, { field: true }), redaction(402, e2.id, { field: true })]
    const parts = await collect(harness({ conversations: one(events) }).ports)
    expect(items(parts)).toEqual([{ type: 'deleted', id: 'm1', sentAt: new Date(100).toISOString() }])
    expect(manifestOf(parts).totals.deleted).toBe(1)
  })

  it('a live edit of a deleted message is dropped (data from before the delete took edits along)', async () => {
    const original = gone(100)
    const events = [original, edit(200, original.id, 'edited secret'), redaction(300, original.id)]
    const parts = await collect(harness({ conversations: one(events) }).ports)
    expect(items(parts)).toEqual([expect.objectContaining({ type: 'deleted' })])
    expect(JSON.stringify(parts)).not.toContain('edited secret')
  })

  it('an edit of a message outside the walk (another person’s, or absent) is dropped', async () => {
    const parts = await collect(harness({ conversations: one([edit(200, '$absent:test.example', 'orphan')]) }).ports)
    expect(items(parts)).toEqual([])
  })

  it('reads the redaction target from the top of the event and from the content (H5)', async () => {
    const a = gone(100)
    const b = gone(110)
    const events = [a, b, redaction(200, a.id, { field: true }), redaction(201, b.id, { field: true, inContent: true })]
    const parts = await collect(harness({ conversations: one(events) }).ports)
    expect(items(parts)).toEqual([])
  })

  it('a reaction, live or deleted, and a state event are no items', async () => {
    const reaction: Ev = { id: nextId(), type: 'm.reaction', sentAt: 100, redacted: false, wire: {}, content: {} }
    const events = [reaction, gone(110, nextId(), 'm.reaction'), gone(120, nextId(), 'm.room.topic'), text(130, 'kept')]
    const parts = await collect(harness({ conversations: one(events) }).ports)
    expect(items(parts)).toEqual([expect.objectContaining({ type: 'message', text: 'kept' })])
  })

  it('an unreadable latest edit makes the item unreadable — never the earlier version', async () => {
    const original = text(100, 'earlier')
    const events = [original, unread(edit(200, original.id, 'latest'), 'stalled')]
    const parts = await collect(harness({ conversations: one(events) }).ports)
    expect(items(parts)).toEqual([{ type: 'unreadable', id: 'm1', sentAt: new Date(100).toISOString() }])
    expect(JSON.stringify(parts)).not.toContain('earlier')
  })

  it('an unknown content is an unsupported marker; a null translation is left out', async () => {
    const events = [text(100, 'x', { msgtype: 'x.unknown' }), text(110, 'y', { msgtype: 'x.null' })]
    const parts = await collect(harness({ conversations: one(events) }).ports)
    expect(items(parts)).toEqual([{ type: 'unsupported', id: 'm1', sentAt: new Date(100).toISOString() }])
  })

  it('thread and reply references survive only for the person’s own items; the flags always do', async () => {
    const root = text(100, 'root')
    const events = [
      root,
      text(110, 'in own thread', { 'm.relates_to': { rel_type: 'm.thread', event_id: root.id } }),
      text(120, 'in other thread', { 'm.relates_to': { rel_type: 'm.thread', event_id: '$theirs:test.example' } }),
      text(130, 'reply to own', { 'm.relates_to': { 'm.in_reply_to': { event_id: root.id } } }),
      text(140, 'reply to other', { 'm.relates_to': { 'm.in_reply_to': { event_id: '$theirs:test.example' } } }),
    ]
    const it_ = items(await collect(harness({ conversations: one(events) }).ports))
    expect(it_[1]).toMatchObject({ inThread: true, threadRoot: 'm1', isReply: false })
    expect(it_[2]).toMatchObject({ inThread: true, isReply: false })
    expect(it_[2]).not.toHaveProperty('threadRoot')
    expect(it_[3]).toMatchObject({ inThread: false, isReply: true, replyTo: 'm1' })
    expect(it_[4]).toMatchObject({ isReply: true })
    expect(it_[4]).not.toHaveProperty('replyTo')
  })

  it('mentions: name and kind from the conversation’s state; without a name the mention leaves the list', async () => {
    const events = [text(100, 'hi @Other and @Gone', { 'm.mentions': { user_ids: [OTHER, '@gone:test.example'] } })]
    const parts = await collect(harness({ conversations: one(events) }).ports)
    const m = manifestOf(parts)
    const other = m.people.find((p) => p.name === 'Other Person')!
    expect(items(parts)[0]).toMatchObject({ text: 'hi @Other and @Gone', mentions: [other.id] })
    expect(m.people.map((p) => p.name)).not.toContain('@gone:test.example')
  })

  it('rich text rides along', async () => {
    const rich = [{ t: 'p', children: [{ t: 'strong', children: [{ t: 'text', text: 'bold' }] }] }]
    const parts = await collect(harness({ conversations: one([text(100, 'bold', { rich })]) }).ports)
    expect(items(parts)[0]).toMatchObject({ text: 'bold', rich })
  })
})

describe('data export engine — answers to approval requests (§0.3.5 items 2 and 9)', () => {
  const CARD = '$card:test.example'

  it('read: the option is the answer’s own fallback text and the agent asked', async () => {
    const parts = await collect(harness({ conversations: one([answer(100, CARD, 'Approve')]), cards: { [CARD]: AGENT } }).ports)
    const m = manifestOf(parts)
    const agent = m.people.find((p) => p.name === 'Helper')!
    expect(items(parts)).toEqual([{ type: 'approvalResponse', id: 'm1', sentAt: new Date(100).toISOString(), option: 'Approve', requestedBy: agent.id }])
    expect(agent.kind).toBe('agent')
  })

  it('an answer that does not decrypt is unreadable', async () => {
    const parts = await collect(harness({ conversations: one([unread(answer(100, CARD, 'Approve'), 'stalled')]), cards: { [CARD]: AGENT } }).ports)
    expect(items(parts)).toEqual([expect.objectContaining({ type: 'unreadable' })])
    expect(manifestOf(parts).totals.gaps).toBe(1)
  })

  it('a card that cannot be read makes the answer unreadable', async () => {
    const parts = await collect(harness({ conversations: one([answer(100, CARD, 'Approve')]), cards: {} }).ports)
    expect(items(parts)).toEqual([expect.objectContaining({ type: 'unreadable' })])
  })

  it('an agent with no name in the conversation’s state makes the answer unreadable', async () => {
    const h = harness({ conversations: one([answer(100, CARD, 'Approve')]), cards: { [CARD]: AGENT }, names: {} })
    expect(items(await collect(h.ports))).toEqual([expect.objectContaining({ type: 'unreadable' })])
  })

  it('reads each distinct card once', async () => {
    const h = harness({ conversations: one([answer(100, CARD, 'A'), answer(110, CARD, 'B'), answer(120, '$card2:test.example', 'C')]), cards: { [CARD]: AGENT, '$card2:test.example': AGENT } })
    await collect(h.ports)
    expect(h.cardCalls.sort()).toEqual(['$card2:test.example', CARD].sort())
  })

  it('a deleted answer is a deleted marker (C1): the device cannot tell it from a message', async () => {
    const parts = await collect(harness({ conversations: one([gone(100)]) }).ports)
    expect(items(parts)).toEqual([expect.objectContaining({ type: 'deleted' })])
  })
})

describe('data export engine — form submissions', () => {
  const FORM = '$form:test.example'

  it('read: title, the agent that opened the form, and each field as text, choice or list of choices', async () => {
    const parts = await collect(harness({ conversations: one([submission(100, FORM)]), cards: { [FORM]: AGENT } }).ports)
    const agent = manifestOf(parts).people.find((p) => p.name === 'Helper')!
    expect(items(parts)).toEqual([
      {
        type: 'formSubmission',
        id: 'm1',
        sentAt: new Date(100).toISOString(),
        title: 'Purchase order',
        requestedBy: agent.id,
        fields: [
          { label: 'Supplier', value: 'Porto Print' },
          { label: 'Cost centre', value: 'cc-210', option: 'Marketing' },
          { label: 'Items', value: ['a4', 'toner'], option: ['A4 paper', 'Toner'] },
        ],
      },
    ])
  })

  it('an optional field left empty is not in the submission, so not in the item', async () => {
    const values = { supplier: 'Porto Print', centre: 'cc-210' }
    const labels = PURCHASE_LABELS.slice(0, 2)
    const parts = await collect(harness({ conversations: one([submission(100, FORM, { values, labels })]), cards: { [FORM]: AGENT } }).ports)
    expect((items(parts)[0]!.fields as Array<{ label: string }>).map((f) => f.label)).toEqual(['Supplier', 'Cost centre'])
  })

  it('two submissions of the same form are two items; the form’s author is read once', async () => {
    const second = { values: { ...PURCHASE_VALUES, supplier: 'Gráfica Sul' } }
    const h = harness({ conversations: one([submission(100, FORM), submission(200, FORM, second)]), cards: { [FORM]: AGENT } })
    const parts = await collect(h.ports)
    expect(items(parts).map((i) => [i.type, (i.fields as Array<{ value: unknown }>)[0]!.value])).toEqual([
      ['formSubmission', 'Porto Print'],
      ['formSubmission', 'Gráfica Sul'],
    ])
    expect(h.cardCalls).toEqual([FORM])
  })

  it('a submission without the copy of the labels is unreadable and counts as a gap', async () => {
    const parts = await collect(harness({ conversations: one([submission(100, FORM, { labels: null })]), cards: { [FORM]: AGENT } }).ports)
    expect(items(parts)).toEqual([expect.objectContaining({ type: 'unreadable' })])
    expect(manifestOf(parts).totals).toMatchObject({ messages: 0, gaps: 1 })
  })

  it('a copy of the labels that breaks a rule, or an empty title, is unreadable', async () => {
    const wrong = [PURCHASE_LABELS[0]!, { id: 'centre', label: 'Cost centre', options: [{ value: 'cc-999', label: 'Other' }] }, PURCHASE_LABELS[2]!]
    const parts = await collect(harness({ conversations: one([submission(100, FORM, { labels: wrong }), submission(200, FORM, { title: '' })]), cards: { [FORM]: AGENT } }).ports)
    expect(items(parts).map((i) => i.type)).toEqual(['unreadable', 'unreadable'])
  })

  it('a submission that does not decrypt is unreadable and counts as a gap', async () => {
    const parts = await collect(harness({ conversations: one([unread(submission(100, FORM), 'stalled')]), cards: { [FORM]: AGENT } }).ports)
    expect(items(parts)).toEqual([expect.objectContaining({ type: 'unreadable' })])
    expect(manifestOf(parts).totals.gaps).toBe(1)
  })

  it('a submission whose key arrives within the wait is read', async () => {
    const ev = unread(submission(100, FORM))
    const h = harness({ conversations: one([ev]), cards: { [FORM]: AGENT }, onSleep: (now) => now >= 1_000 && arrive(ev) })
    expect(items(await collect(h.ports))).toEqual([expect.objectContaining({ type: 'formSubmission' })])
  })

  it('a deleted submission is a deleted marker', async () => {
    const parts = await collect(harness({ conversations: one([{ ...gone(100), folded: 'form' }]) }).ports)
    expect(items(parts)).toEqual([expect.objectContaining({ type: 'deleted' })])
  })

  it('a form whose author cannot be read, or has no name in the conversation, makes the submission unreadable', async () => {
    expect(items(await collect(harness({ conversations: one([submission(100, FORM)]), cards: {} }).ports))).toEqual([expect.objectContaining({ type: 'unreadable' })])
    const nameless = harness({ conversations: one([submission(100, FORM)]), cards: { [FORM]: AGENT }, names: {} })
    expect(items(await collect(nameless.ports))).toEqual([expect.objectContaining({ type: 'unreadable' })])
  })

  it('another form event of the person is no item; one that decrypts into it is dropped after the wait', async () => {
    const hidden = unread(formResult(300, '$s:test.example'))
    const h = harness({ conversations: one([submission(100, FORM), formResult(200, '$s:test.example'), hidden]), cards: { [FORM]: AGENT }, onSleep: () => arrive(hidden) })
    const parts = await collect(h.ports)
    expect(items(parts).map((i) => i.type)).toEqual(['formSubmission'])
  })

  it('counts in messages, beside messages and answers', async () => {
    const parts = await collect(harness({ conversations: one([text(50, 'hi'), answer(60, '$card:test.example', 'Approve'), submission(100, FORM)]), cards: { [FORM]: AGENT, '$card:test.example': AGENT } }).ports)
    expect(manifestOf(parts).conversations[0]).toMatchObject({ messages: 3, gaps: 0 })
    expect(manifestOf(parts).totals.messages).toBe(3)
  })
})

describe('data export engine — waiting for keys (§0.3.3 A7)', () => {
  it('a key that arrives within the wait: the message is read', async () => {
    const late = unread(text(100, 'arrived'))
    const h = harness({ conversations: one([late]), onSleep: (now) => now >= 2_000 && arrive(late) })
    const parts = await collect(h.ports)
    expect(items(parts)).toEqual([expect.objectContaining({ type: 'message', text: 'arrived' })])
    expect(h.now()).toBeGreaterThanOrEqual(2_000)
    expect(h.now()).toBeLessThan(EXPORT_KEY_WAIT_PER_CONVERSATION_MS)
  })

  it('5 s per conversation, then a gap', async () => {
    const h = harness({ conversations: one([unread(text(100, 'never'))]) })
    const parts = await collect(h.ports)
    expect(items(parts)).toEqual([expect.objectContaining({ type: 'unreadable' })])
    expect(h.now()).toBe(EXPORT_KEY_WAIT_PER_CONVERSATION_MS)
  })

  it('no wait when nothing may still arrive', async () => {
    const h = harness({ conversations: one([unread(text(100, 'stalled'), 'stalled')]) })
    await collect(h.ports)
    expect(h.slept).toEqual([])
  })

  it('60 s summed over the export', async () => {
    const conversations = Array.from({ length: 15 }, (_, i) => ({
      key: `!r${i}:test.example`,
      channel: channel(`!r${i}:test.example`, `#r${i}`, 'private'),
      events: [unread(text(100, `never ${i}`))],
    }))
    const h = harness({ conversations })
    const parts = await collect(h.ports)
    expect(h.now()).toBe(EXPORT_KEY_WAIT_TOTAL_MS)
    expect(manifestOf(parts).totals.gaps).toBe(15)
  })
})

describe('data export engine — attachments (§0.3.3 E, §0.3.5 item 4)', () => {
  it('obtained: written at the builder’s path, the size from the bytes when the body has none', async () => {
    const img = text(100, 'photo.png', { msgtype: 'm.image' })
    const h = harness({ conversations: one([img]), mediaTypes: { [`ref-${img.id}`]: 'image/png' } })
    const parts = await collect(h.ports)
    const att = parts.find((p): p is Extract<DataExportPart, { t: 'attachment' }> => p.t === 'attachment')!
    const item = items(parts)[0] as { text: string; attachment: Record<string, unknown> }
    expect(item.text).toBe('')
    expect(item.attachment).toEqual({ file: att.path, name: 'photo.png', mimetype: 'image/png', size: att.data.size })
    expect(att.path).toBe('attachments/c1/m1-photo.png')
  })

  it('a file keeps the name, type and size of the body', async () => {
    const f = text(100, 'report.pdf', { msgtype: 'm.file', size: 1234, mimetype: 'application/pdf' })
    const item = items(await collect(harness({ conversations: one([f]) }).ports))[0] as { attachment: Record<string, unknown> }
    expect(item.attachment).toMatchObject({ name: 'report.pdf', mimetype: 'application/pdf', size: 1234 })
  })

  it('two failures with an answer → missing, counted as a gap', async () => {
    const f = text(100, 'report.pdf', { msgtype: 'm.file', size: 10, mimetype: 'application/pdf' })
    const h = harness({ conversations: one([f]), media: () => new Error('media fetch failed') })
    const parts = await collect(h.ports)
    expect(h.mediaCalls).toHaveLength(EXPORT_ATTACHMENT_ATTEMPTS)
    expect(items(parts)[0]).toMatchObject({ attachment: { name: 'report.pdf', mimetype: 'application/pdf', size: 10, missing: true } })
    expect(parts.some((p) => p.t === 'attachment')).toBe(false)
    expect(manifestOf(parts).totals).toMatchObject({ gaps: 1, attachments: 0 })
  })

  it('a failure with no answer spends no try', async () => {
    const f = text(100, 'report.pdf', { msgtype: 'm.file', size: 10, mimetype: 'application/pdf' })
    const h = harness({
      conversations: one([f]),
      media: (_ref, call) => (call <= 3 ? new NoAnswer() : call === 4 ? new Error('media unavailable') : new Blob(['ok'])),
    })
    const parts = await collect(h.ports)
    expect(h.mediaCalls).toHaveLength(5)
    expect(manifestOf(parts).totals).toMatchObject({ attachments: 1, gaps: 0 })
  })
})

describe('data export engine — failures (§0.3.5 item 4)', () => {
  it('two minutes in a row without a successful request → ConnectionError', async () => {
    const h = harness({ conversations: one([text(100, 'x')]), page: () => new NoAnswer() })
    await expect(collect(h.ports)).rejects.toMatchObject({ name: 'ConnectionError' })
    expect(h.now()).toBe(EXPORT_OFFLINE_WINDOW_MS)
    expect(h.held()).toBe(0)
  })

  it('a connection that comes back inside the window carries on', async () => {
    const h = harness({ conversations: one([text(100, 'x')]), page: (_k, _f, call) => (call <= 4 ? new NoAnswer() : undefined) })
    const parts = await collect(h.ports)
    expect(items(parts)).toHaveLength(1)
    expect(h.now()).toBe(1_000 + 2_000 + 4_000 + 8_000)
  })

  it('a rate limit waits the time given, then repeats', async () => {
    const h = harness({ conversations: one([text(100, 'x')]), page: (_k, _f, call) => (call === 1 ? new Limited(3_000) : undefined) })
    await collect(h.ports)
    expect(h.now()).toBe(3_000)
    expect(h.pageCalls).toHaveLength(2)
  })

  it('a rate limit counts in the same window', async () => {
    const h = harness({ conversations: one([text(100, 'x')]), page: () => new Limited(50_000) })
    await expect(collect(h.ports)).rejects.toMatchObject({ name: 'ConnectionError' })
    expect(h.now()).toBe(EXPORT_OFFLINE_WINDOW_MS)
  })

  // Two conversations; between them the consumer holds the export for `pauseMs` (the clock moves with no
  // request in flight). `fail(call)` decides the second conversation's page calls.
  async function pausedExport(pauseMs: number, fail: (call: number) => Error | undefined, firstFails = 0) {
    const conversations = [0, 1].map((i) => ({ key: `!w${i}:test.example`, channel: channel(`!w${i}:test.example`, `#w${i}`, 'private'), events: [text(100, `w${i}`)] }))
    let second = 0
    const h = harness({
      conversations,
      page: (key, _from, call) => {
        if (key === '!w0:test.example') return call <= firstFails ? new NoAnswer() : undefined
        second += 1
        return fail(second)
      },
    })
    const marks: number[] = []
    const run = (async () => {
      for await (const part of runDataExport(h.ports, OPTS)) {
        if (part.t === 'progress' && part.done === 1) {
          h.advance(pauseMs)
          marks.push(h.now())
        }
      }
    })()
    return { h, run, marks }
  }

  it('a pause longer than the window between two successes does not eat the window', async () => {
    const { h, run } = await pausedExport(EXPORT_OFFLINE_WINDOW_MS + 80_000, (call) => (call === 1 ? new NoAnswer() : undefined))
    await run
    expect(h.pageCalls.map((c) => c.key)).toEqual(['!w0:test.example', '!w1:test.example', '!w1:test.example'])
  })

  it('after such a pause, failing for ever ends exactly one window after the first failure', async () => {
    const { h, run, marks } = await pausedExport(EXPORT_OFFLINE_WINDOW_MS + 80_000, () => new NoAnswer())
    await expect(run).rejects.toMatchObject({ name: 'ConnectionError' })
    expect(h.now()).toBe(marks[0]! + EXPORT_OFFLINE_WINDOW_MS)
  })

  it('a failure, a success, then a new run of failures: the second window counts from its own start', async () => {
    // The first conversation fails once (1 s wait) and then succeeds at t = 1 s; 50 s pass; then failures.
    const { h, run, marks } = await pausedExport(50_000, () => new NoAnswer(), 1)
    await expect(run).rejects.toMatchObject({ name: 'ConnectionError' })
    expect(marks[0]).toBe(51_000)
    expect(h.now()).toBe(51_000 + EXPORT_OFFLINE_WINDOW_MS)
  })

  it('a page failure with an answer rejects the export', async () => {
    const h = harness({ conversations: one([text(100, 'x')]), page: () => new Error('forbidden') })
    await expect(collect(h.ports)).rejects.toThrow('forbidden')
    expect(h.held()).toBe(0)
  })

  it('a session that ends in the middle stops it', async () => {
    let alive = true
    const h = harness({ conversations: one([text(100, 'x')]), alive: () => alive, page: () => ((alive = false), undefined) })
    await expect(collect(h.ports)).rejects.toThrow('export: the session ended')
  })
})

describe('data export engine — cancellation and the backfill hold (§0.3.5 items 1 and 3)', () => {
  const reason = new Error('cancelled by the person')

  it('before the first request', async () => {
    const ctl = new AbortController()
    ctl.abort(reason)
    const h = harness({ conversations: one([text(100, 'x')]) })
    await expect(collect(h.ports, { ...OPTS, signal: ctl.signal })).rejects.toBe(reason)
    expect(h.pageCalls).toHaveLength(0)
    expect(h.held()).toBe(0)
  })

  it('during the walk', async () => {
    const ctl = new AbortController()
    const h = harness({ conversations: one([text(100, 'x')]), page: () => (ctl.abort(reason), new NoAnswer()) })
    await expect(collect(h.ports, { ...OPTS, signal: ctl.signal })).rejects.toBe(reason)
    expect(h.held()).toBe(0)
  })

  it('during the wait for keys', async () => {
    const ctl = new AbortController()
    const h = harness({ conversations: one([unread(text(100, 'x'))]), onSleep: (now) => now >= 1_000 && ctl.abort(reason) })
    await expect(collect(h.ports, { ...OPTS, signal: ctl.signal })).rejects.toBe(reason)
    expect(h.now()).toBe(1_000)
    expect(h.held()).toBe(0)
  })

  it('during an attachment', async () => {
    const ctl = new AbortController()
    const f = text(100, 'a.pdf', { msgtype: 'm.file', mimetype: 'application/pdf' })
    const h = harness({ conversations: one([f]), media: () => (ctl.abort(reason), new Error('media fetch failed')) })
    await expect(collect(h.ports, { ...OPTS, signal: ctl.signal })).rejects.toBe(reason)
    expect(h.held()).toBe(0)
  })

  it('between conversations', async () => {
    const ctl = new AbortController()
    const conversations = [0, 1].map((i) => ({ key: `!r${i}:test.example`, channel: channel(`!r${i}:test.example`, `#r${i}`, 'private'), events: [text(100, 'x')] }))
    const h = harness({ conversations })
    const seen: DataExportPart[] = []
    await expect(
      (async () => {
        for await (const part of runDataExport(h.ports, { ...OPTS, signal: ctl.signal })) {
          seen.push(part)
          if (part.t === 'progress' && part.done === 1) ctl.abort(reason)
        }
      })(),
    ).rejects.toBe(reason)
    expect(h.pageCalls.map((c) => c.key)).toEqual(['!r0:test.example'])
    expect(h.held()).toBe(0)
  })

  it('holds the backfill from the first step and lets go at the end', async () => {
    const h = harness({ conversations: one([text(100, 'x')]) })
    const it_ = runDataExport(h.ports, OPTS)[Symbol.asyncIterator]()
    expect(h.held()).toBe(0)
    await it_.next()
    expect(h.held()).toBe(1)
    for (let r = await it_.next(); !r.done; r = await it_.next());
    expect(h.held()).toBe(0)
  })

  it('lets go when the consumer stops early (return)', async () => {
    const h = harness({ conversations: one([text(100, 'x')]) })
    for await (const part of runDataExport(h.ports, OPTS)) {
      expect(part.t).toBe('progress')
      expect(h.held()).toBe(1)
      break
    }
    expect(h.held()).toBe(0)
  })
})

describe('data export engine — the account and the output (§0.3.5 items 1, 6 and 7)', () => {
  it('the profile picture: written last among the attachments, before the files of the end', async () => {
    const account = { ...baseAccount(), profile: { ...baseAccount().profile, avatar: 'ref-avatar' as MediaRef } }
    const h = harness({ conversations: one([text(100, 'x')]), account, mediaTypes: { 'ref-avatar': 'image/png' } })
    const parts = await collect(h.ports)
    expect(parts.map((p) => (p.t === 'file' || p.t === 'attachment' ? `${p.t}:${p.path}` : p.t))).toEqual([
      'progress',
      'file:conversations/c1.json',
      'progress',
      'attachment:attachments/account/avatar.png',
      'file:README.txt',
      'file:manifest.json',
      'file:account.json',
      'done',
    ])
    expect(JSON.parse(fileAt(parts, 'account.json')).profile.avatar).toBe('attachments/account/avatar.png')
  })

  it('a picture that could not be obtained: the profile goes without it and no gap counts', async () => {
    const account = { ...baseAccount(), profile: { ...baseAccount().profile, avatar: 'ref-avatar' as MediaRef } }
    const h = harness({ conversations: one([text(100, 'x')]), account, media: () => new Error('media fetch failed') })
    const parts = await collect(h.ports)
    expect(JSON.parse(fileAt(parts, 'account.json')).profile).not.toHaveProperty('avatar')
    expect(manifestOf(parts).totals.gaps).toBe(0)
    expect(parts.some((p) => p.t === 'attachment')).toBe(false)
  })

  it('an access with no name takes the generic copy; jobTitle and the agents come along', async () => {
    const account = JSON.parse(fileAt(await collect(harness({ conversations: [] }).ports), 'account.json'))
    expect(account.accesses).toEqual([
      { name: 'Laptop', lastSeenAt: new Date(1_000).toISOString(), current: true },
      { name: 'Unnamed access', current: false },
    ])
    expect(account.profile).toEqual({ fullName: 'Me Person', jobTitle: 'Engineer' })
    expect(account.agents).toHaveLength(1)
  })

  it('order of parts: progress 0, each attachment as obtained, the file, progress; then the end; done last', async () => {
    const conversations = [0, 1].map((i) => ({
      key: `!r${i}:test.example`,
      channel: channel(`!r${i}:test.example`, `#r${i}`, 'public'),
      events: [text(100, `f${i}.pdf`, { msgtype: 'm.file', size: 3, mimetype: 'application/pdf' }), text(110, `t${i}`)],
    }))
    const parts = await collect(harness({ conversations }).ports)
    expect(parts.map((p) => (p.t === 'progress' ? `progress ${p.done}/${p.total}` : p.t === 'done' ? 'done' : p.path))).toEqual([
      'progress 0/2',
      'attachments/c1/m1-f0.pdf',
      'conversations/c1.json',
      'progress 1/2',
      'attachments/c2/m3-f1.pdf',
      'conversations/c2.json',
      'progress 2/2',
      'README.txt',
      'manifest.json',
      'account.json',
      'done',
    ])
  })

  it('names without the mark of their kind; a group with nobody else stays empty; kinds carried', async () => {
    const conversations = [
      { key: '!a:test.example', channel: channel('!a:test.example', '#general', 'public'), events: [] },
      { key: '!b:test.example', channel: channel('!b:test.example', '#secret', 'private'), events: [] },
      { key: '!c:test.example', channel: channel('!c:test.example', 'Other Person', 'dm'), events: [] },
      { key: '!d:test.example', channel: channel('!d:test.example', '', 'group'), events: [] },
    ]
    const m = manifestOf(await collect(harness({ conversations }).ports))
    expect(m.conversations.map((c) => [c.name, c.kind])).toEqual([
      ['general', 'public'],
      ['secret', 'private'],
      ['Other Person', 'dm'],
      ['', 'group'],
    ])
  })

  it('done is the manifest: totals, and each conversation with a gap as its Channel', async () => {
    const withGap = channel('!b:test.example', '#b', 'private')
    const conversations = [
      { key: '!a:test.example', channel: channel('!a:test.example', '#a', 'private'), events: [text(100, 'ok'), gone(110)] },
      { key: '!b:test.example', channel: withGap, events: [unread(text(100, 'no'), 'stalled'), unread(text(110, 'no'), 'stalled')] },
    ]
    const parts = await collect(harness({ conversations }).ports)
    const done = parts.at(-1) as Extract<DataExportPart, { t: 'done' }>
    expect(done.totals).toEqual(manifestOf(parts).totals)
    expect(done.totals).toEqual({ conversations: 2, messages: 1, deleted: 1, attachments: 0, gaps: 2 })
    expect(done.incomplete).toEqual([{ channel: withGap, gaps: 2 }])
  })

  it('leak-scan: no protocol shape and no input key in any path or file', async () => {
    const root = text(100, 'root text')
    const card = '$card:test.example'
    const form = '$form:test.example'
    const conversations: Conv[] = [
      {
        key: '!leak:test.example',
        channel: channel('!leak:test.example', '#leaks', 'private'),
        events: [
          member(50, 'join'),
          root,
          edit(110, root.id, 'root edited'),
          text(120, 'reply', { 'm.relates_to': { rel_type: 'm.thread', event_id: root.id }, 'm.mentions': { user_ids: [OTHER, ME] } }),
          text(130, 'pic.png', { msgtype: 'm.image' }),
          gone(140),
          unread(text(150, 'no'), 'stalled'),
          answer(160, card, 'Approve'),
          submission(170, form),
        ],
      },
    ]
    const account = { ...baseAccount(), profile: { ...baseAccount().profile, avatar: 'ref-avatar' as MediaRef } }
    const parts = await collect(harness({ conversations, cards: { [card]: AGENT, [form]: AGENT }, account }).ports)
    expect(items(parts).some((i) => i.type === 'formSubmission')).toBe(true)
    const keys = [ME, OTHER, AGENT, card, form, '$anchor:test.example', '!leak:test.example', ...conversations[0]!.events.map((e) => e.id)]
    for (const p of parts) {
      if (p.t !== 'file' && p.t !== 'attachment') continue
      expect(findProtocolLeaksInText(p.path)).toEqual([])
      for (const k of keys) expect(p.path).not.toContain(k)
      if (p.t === 'file') {
        expect(findProtocolLeaksInText(p.content)).toEqual([])
        for (const k of keys) expect(p.content).not.toContain(k)
      }
    }
  })
})
