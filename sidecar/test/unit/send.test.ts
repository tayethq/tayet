import type { RichDoc } from '@tayet/shared'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventStatus } from 'matrix-js-sdk'
import * as shared from '@tayet/shared/internal'
import { attemptJob, createWriteGateway, jobChannel, NotMember, ReplyInThread, type GatewayClient, type WriteJob } from '../../src/core/send'

// The write gateway (ADR-087 dec. 7): which SDK method and arguments per relation, NotMember before
// any effect, reply-inside-thread refused as in the client. The content's shape belongs to the
// shared builders (pinned by their own tests): here a spy proves the gateway hands the builder's
// output to the SDK unchanged, without restating the builder's literals.
vi.mock('@tayet/shared/internal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tayet/shared/internal')>()
  return { ...actual, buildTextContent: vi.fn(actual.buildTextContent) }
})

const ROOM = '!room:test.local'
const ROOT = '$root'
const TARGET = '$target'
const ALICE = '@alice:test.local'

interface FakeClient {
  client: GatewayClient
  sendMessage: ReturnType<typeof vi.fn>
  sendEvent: ReturnType<typeof vi.fn>
  redactEvent: ReturnType<typeof vi.fn>
  cancelPendingEvent: ReturnType<typeof vi.fn>
  membership: string | null
  pending: Array<{ getTxnId: () => string; status: EventStatus | null }>
}

function fakeClient(): FakeClient {
  const f: FakeClient = {
    membership: 'join',
    pending: [],
    sendMessage: vi.fn(() => Promise.resolve({ event_id: '$accepted' })),
    sendEvent: vi.fn(() => Promise.resolve({ event_id: '$reaction' })),
    redactEvent: vi.fn(() => Promise.resolve({ event_id: '$redaction' })),
    cancelPendingEvent: vi.fn(),
    client: undefined as unknown as GatewayClient,
  }
  f.client = {
    getRoom: (roomId: string) =>
      roomId === ROOM && f.membership !== null
        ? { getMyMembership: () => f.membership, getPendingEvents: () => f.pending }
        : null,
    sendMessage: f.sendMessage,
    sendEvent: f.sendEvent,
    redactEvent: f.redactEvent,
    cancelPendingEvent: f.cancelPendingEvent,
  } as unknown as GatewayClient
  return f
}

const builder = vi.mocked(shared.buildTextContent)

beforeEach(() => {
  builder.mockClear()
})

describe('write gateway (core/send.ts)', () => {
  it('no relation → sendMessage(roomId, content, txnId) with the builder output', async () => {
    const f = fakeClient()
    const id = await createWriteGateway(f.client).sendText({ channel: ROOM, text: 'hello' }, 'txn1')
    expect(id).toBe('$accepted')
    expect(builder).toHaveBeenCalledExactlyOnceWith('hello', undefined, undefined, undefined)
    expect(f.sendMessage).toHaveBeenCalledExactlyOnceWith(ROOM, builder.mock.results[0]!.value, 'txn1')
  })

  // PLANO-AGENTES §0.3.12 item 4: the Slack layer's rich text reaches the builder (formatted_body).
  it('rich goes to the builder with the plain fallback', async () => {
    const f = fakeClient()
    const rich: RichDoc = [{ t: 'p', children: [{ t: 'strong', children: [{ t: 'text', text: 'hi' }] }] }]
    await createWriteGateway(f.client).sendText({ channel: ROOM, text: 'hi', rich }, 'txn-rich')
    expect(builder).toHaveBeenCalledExactlyOnceWith('hi', rich, undefined, undefined)
    expect(builder.mock.results[0]!.value).toMatchObject({ body: 'hi', formatted_body: '<p><strong>hi</strong></p>' })
  })

  it('an edit carries rich too', async () => {
    const f = fakeClient()
    const rich: RichDoc = [{ t: 'p', children: [{ t: 'em', children: [{ t: 'text', text: 'novo' }] }] }]
    await createWriteGateway(f.client).editText(ROOM, TARGET, 'novo', 'txn-edit-rich', rich)
    expect(f.sendMessage).toHaveBeenCalledExactlyOnceWith(ROOM, shared.buildEditContent('novo', rich, TARGET), 'txn-edit-rich')
  })

  it('mentions go to the builder as user ids', async () => {
    const f = fakeClient()
    await createWriteGateway(f.client).sendText({ channel: ROOM, text: 'hi', mentions: [ALICE] }, 'txn2')
    expect(builder).toHaveBeenCalledExactlyOnceWith('hi', undefined, [ALICE], undefined)
    expect(f.sendMessage).toHaveBeenCalledExactlyOnceWith(ROOM, builder.mock.results[0]!.value, 'txn2')
  })

  it('thread → sendMessage(roomId, threadRoot, content, txnId)', async () => {
    const f = fakeClient()
    await createWriteGateway(f.client).sendText({ channel: ROOM, text: 'in thread', thread: ROOT, mentions: [ALICE] }, 'txn3')
    expect(builder).toHaveBeenCalledExactlyOnceWith('in thread', undefined, [ALICE], { thread: ROOT })
    expect(f.sendMessage).toHaveBeenCalledExactlyOnceWith(ROOM, ROOT, builder.mock.results[0]!.value, 'txn3')
  })

  it('reply → sendMessage(roomId, content, txnId), no thread argument', async () => {
    const f = fakeClient()
    await createWriteGateway(f.client).sendText({ channel: ROOM, text: 'reply', replyTo: TARGET }, 'txn4')
    expect(builder).toHaveBeenCalledExactlyOnceWith('reply', undefined, undefined, { replyTo: TARGET })
    expect(f.sendMessage).toHaveBeenCalledExactlyOnceWith(ROOM, builder.mock.results[0]!.value, 'txn4')
  })

  it('reply inside a thread is refused before any effect', async () => {
    const f = fakeClient()
    const p = createWriteGateway(f.client).sendText({ channel: ROOM, text: 'x', thread: ROOT, replyTo: TARGET }, 'txn5')
    await expect(p).rejects.toBeInstanceOf(ReplyInThread)
    await expect(p).rejects.toThrow('cannot reply inside a thread')
    expect(builder).not.toHaveBeenCalled()
    expect(f.sendMessage).not.toHaveBeenCalled()
  })

  it.each([
    ['unknown channel', null],
    ['invited only', 'invite'],
    ['left', 'leave'],
  ])('NotMember (%s) before any effect', async (_label, membership) => {
    const f = fakeClient()
    f.membership = membership
    await expect(createWriteGateway(f.client).sendText({ channel: ROOM, text: 'x' }, 'txn6')).rejects.toBeInstanceOf(NotMember)
    expect(builder).not.toHaveBeenCalled()
    expect(f.sendMessage).not.toHaveBeenCalled()
  })

  it('cancelLocal cancels the pending event of that transaction only, when cancellable', () => {
    const f = fakeClient()
    const mine = { getTxnId: () => 'txnA', status: EventStatus.NOT_SENT }
    const other = { getTxnId: () => 'txnB', status: EventStatus.NOT_SENT }
    f.pending.push(other, mine)
    const g = createWriteGateway(f.client)
    g.cancelLocal(ROOM, 'txnA')
    expect(f.cancelPendingEvent).toHaveBeenCalledExactlyOnceWith(mine)
    f.cancelPendingEvent.mockClear()
    mine.status = EventStatus.SENT
    g.cancelLocal(ROOM, 'txnA')
    g.cancelLocal(ROOM, 'txnZ')
    g.cancelLocal('!other:test.local', 'txnA')
    expect(f.cancelPendingEvent).not.toHaveBeenCalled()
  })
})

// S-c2 (§0.3.7 items 1, 4): the other write effects, one attempt each, NotMember before any effect.
describe('write gateway: edit, removal, reaction, attachment (S-c2)', () => {
  it('edit → sendMessage(roomId, m.replace content of the shared builder, txnId), no thread argument', async () => {
    const f = fakeClient()
    const g = createWriteGateway(f.client)
    expect(await g.editText(ROOM, TARGET, 'novo texto', 'txn1')).toBe('$accepted')
    expect(f.sendMessage).toHaveBeenCalledExactlyOnceWith(ROOM, shared.buildEditContent('novo texto', undefined, TARGET), 'txn1')
  })

  it('removal → redactEvent(roomId, eventId, txnId)', async () => {
    const f = fakeClient()
    expect(await createWriteGateway(f.client).redact(ROOM, TARGET, 'txn2')).toBe('$redaction')
    expect(f.redactEvent).toHaveBeenCalledExactlyOnceWith(ROOM, TARGET, 'txn2')
  })

  it('reaction → sendEvent(roomId, m.reaction, the annotation of the shared builder, txnId)', async () => {
    const f = fakeClient()
    expect(await createWriteGateway(f.client).react(ROOM, TARGET, '👍', 'txn3')).toBe('$reaction')
    expect(f.sendEvent).toHaveBeenCalledExactlyOnceWith(ROOM, 'm.reaction', shared.buildReactionContent(TARGET, '👍'), 'txn3')
  })

  it('attachment → sendMessage with the content as given; a thread root goes as the threadId', async () => {
    const f = fakeClient()
    const g = createWriteGateway(f.client)
    const content = { msgtype: 'm.file', body: 'a.pdf' }
    await g.sendAttachment(ROOM, content, undefined, 'txn4')
    await g.sendAttachment(ROOM, content, ROOT, 'txn5')
    expect(f.sendMessage.mock.calls).toEqual([
      [ROOM, content, 'txn4'],
      [ROOM, ROOT, content, 'txn5'],
    ])
  })

  it('every effect is refused before any call when the agent is not joined', async () => {
    const f = fakeClient()
    f.membership = 'invite'
    const g = createWriteGateway(f.client)
    await expect(g.editText(ROOM, TARGET, 'x', 't')).rejects.toBeInstanceOf(NotMember)
    await expect(g.redact(ROOM, TARGET, 't')).rejects.toBeInstanceOf(NotMember)
    await expect(g.react(ROOM, TARGET, '👍', 't')).rejects.toBeInstanceOf(NotMember)
    await expect(g.sendAttachment(ROOM, {}, undefined, 't')).rejects.toBeInstanceOf(NotMember)
    expect(f.sendMessage).not.toHaveBeenCalled()
    expect(f.sendEvent).not.toHaveBeenCalled()
    expect(f.redactEvent).not.toHaveBeenCalled()
  })

  it('attemptJob dispatches each kind; unreact is the redaction of the reaction event; jobChannel', async () => {
    const f = fakeClient()
    const g = createWriteGateway(f.client)
    const jobs: WriteJob[] = [
      { kind: 'text', req: { channel: ROOM, text: 'oi' } },
      { kind: 'edit', channel: ROOM, target: TARGET, text: 'oi2' },
      { kind: 'redact', channel: ROOM, target: TARGET },
      { kind: 'react', channel: ROOM, target: TARGET, key: '🎉' },
      { kind: 'unreact', channel: ROOM, reaction: '$myreaction' },
      { kind: 'attachment', channel: ROOM, content: { msgtype: 'm.file' } },
    ]
    const ids = []
    for (const job of jobs) ids.push(await attemptJob(g, job, 'txn'))
    expect(ids).toEqual(['$accepted', '$accepted', '$redaction', '$reaction', '$redaction', '$accepted'])
    expect(f.redactEvent.mock.calls).toEqual([
      [ROOM, TARGET, 'txn'],
      [ROOM, '$myreaction', 'txn'],
    ])
    expect(jobs.map(jobChannel)).toEqual(jobs.map(() => ROOM))
  })

  it('cancelLocal covers a pending reaction or redaction too (any type, by transaction id)', () => {
    const f = fakeClient()
    const reaction = { getTxnId: () => 'txnR', status: EventStatus.QUEUED, getType: () => 'm.reaction' }
    const redaction = { getTxnId: () => 'txnD', status: EventStatus.ENCRYPTING, getType: () => 'm.room.redaction' }
    f.pending.push(reaction, redaction)
    const g = createWriteGateway(f.client)
    g.cancelLocal(ROOM, 'txnR')
    g.cancelLocal(ROOM, 'txnD')
    expect(f.cancelPendingEvent.mock.calls).toEqual([[reaction], [redaction]])
  })
})
