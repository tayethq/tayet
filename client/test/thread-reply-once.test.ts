import { describe, it, expect } from 'vitest'
import { MatrixEvent, MatrixEventEvent, RoomEvent, ThreadEvent } from 'matrix-js-sdk'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import type { AclTelemetry, DomainEvent } from '../src/acl'

// #421 N6: a thread reply has one emission path, onThreadReply (ThreadEvent.NewReply). In an encrypted room the
// SDK inserts the live reply into the Thread's timeline while it still decrypts (RoomEvent.Timeline), the
// decrypt settles (MatrixEventEvent.Decrypted), and only then Thread.onEcho fires NewReply, with the reply
// already decrypted (matrix-js-sdk 41.6.0, thread.js onEcho after updateThreadMetadata). The timeline must not
// defer the reply to the decrypt path, or onDecrypted emits it and onThreadReply emits it again.

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const ROOM_ID = '!room:tayet.local'
const ROOT_ID = '$root:tayet.local'
const REPLY_ID = '$reply:tayet.local'
type Handler = (...args: unknown[]) => void

const relation = { rel_type: 'm.thread', event_id: ROOT_ID }

// An encrypted thread reply as the SDK holds it before the decrypt settles: the relation in clear on the
// envelope, no clear event yet (shouldAttemptDecryption() is true).
function encryptedReply(): MatrixEvent {
  return new MatrixEvent({
    type: 'm.room.encrypted',
    event_id: REPLY_ID,
    room_id: ROOM_ID,
    sender: '@other:tayet.local',
    origin_server_ts: 4000,
    content: { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'x', 'm.relates_to': relation },
  })
}

// The decrypt settles in success: the clear event is set (what the SDK's decrypt does to the same object).
function settle(ev: MatrixEvent, content: Record<string, unknown> = { msgtype: 'm.text', body: 'reply', 'm.relates_to': relation }): void {
  const raw = ev as unknown as { clearEvent: unknown; _decryptionFailureReason: string | null }
  raw.clearEvent = { type: 'm.room.message', content }
  raw._decryptionFailureReason = null
}

// The decrypt settles in failure, as the SDK leaves the object: the bad-encrypted stub (no relation in it)
// and a failure code.
function fail(ev: MatrixEvent): void {
  const raw = ev as unknown as { clearEvent: unknown; _decryptionFailureReason: string | null }
  raw.clearEvent = { type: 'm.room.message', content: { msgtype: 'm.bad.encrypted', body: '** Unable to decrypt **' } }
  raw._decryptionFailureReason = 'MEGOLM_UNKNOWN_INBOUND_SESSION_ID'
}

function harness() {
  const root = new MatrixEvent({
    type: 'm.room.message',
    event_id: ROOT_ID,
    room_id: ROOM_ID,
    sender: '@me:tayet.local',
    origin_server_ts: 1000,
    content: { msgtype: 'm.text', body: 'root' },
  })
  const roomHandlers = new Map<string, Handler[]>()
  const clientHandlers = new Map<string, Handler[]>()
  const fakeRoom = {
    getMyMembership: () => 'join',
    getCanonicalAlias: () => null,
    roomId: ROOM_ID,
    findEventById: (id: string) => (id === ROOT_ID ? root : undefined),
    getThread: () => undefined,
    getLiveTimeline: () => ({ getEvents: () => [root] }),
    relations: { getChildEventsForEvent: () => undefined },
    on: (name: string, h: Handler) => roomHandlers.set(name, [...(roomHandlers.get(name) ?? []), h]),
    off: () => {},
  }
  const fakeClient = {
    getRooms: () => [fakeRoom],
    getRoom: () => fakeRoom,
    getUserId: () => '@me:tayet.local',
    getAccountData: () => undefined,
    getCrypto: () => undefined,
    stopClient: () => {},
    on: (name: string, h: Handler) => clientHandlers.set(name, [...(clientHandlers.get(name) ?? []), h]),
    off: () => {},
  }
  const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
  const g = gateway as unknown as {
    client: unknown
    live: boolean
    attachRoom(r: unknown): void
    wireEvents(c: unknown): unknown
    approvals: { noteAnswer(roomId: string, cardId: string, answer: { decrypted: boolean; option?: string }): void }
  }
  g.client = fakeClient
  g.wireEvents(fakeClient)
  g.live = true
  g.attachRoom(fakeRoom)
  const events: DomainEvent[] = []
  gateway.subscribe((e) => events.push(e))
  const thread = { id: ROOT_ID, length: 1, replyToEvent: null, rootEvent: root, room: fakeRoom }
  const fireClient = (name: string, ...args: unknown[]) => {
    for (const h of clientHandlers.get(name) ?? []) h(...args)
  }
  const fireRoom = (name: string, ...args: unknown[]) => {
    for (const h of roomHandlers.get(name) ?? []) h(...args)
  }
  const answers: Array<{ cardId: string; decrypted: boolean; option?: string }> = []
  g.approvals.noteAnswer = (_roomId, cardId, answer) => void answers.push({ cardId, decrypted: answer.decrypted, ...(answer.option !== undefined && { option: answer.option }) })
  return {
    events,
    answers,
    // The live insertion into the Thread's timeline set, re-emitted by the room to the client.
    timeline: (ev: MatrixEvent) => fireClient(RoomEvent.Timeline, ev, fakeRoom, false, false, { liveEvent: true }),
    decrypted: (ev: MatrixEvent) => fireClient(MatrixEventEvent.Decrypted, ev),
    newReply: (ev: MatrixEvent) => fireRoom(ThreadEvent.NewReply, thread, ev),
  }
}

const receivedReplies = (events: DomainEvent[]) =>
  events.filter((e) => e.t === 'message.received' && e.message.threadParent === ROOT_ID)

describe('a live encrypted thread reply is one message.received (#421 N6)', () => {
  it('timeline while decrypting → decrypt settles → NewReply: exactly one, with its content', () => {
    const h = harness()
    const ev = encryptedReply()
    h.timeline(ev)
    settle(ev)
    h.decrypted(ev)
    h.newReply(ev)
    const got = receivedReplies(h.events)
    expect(got).toHaveLength(1)
    const only = got[0]!
    if (only.t !== 'message.received') throw new Error('unreachable')
    expect(only.message.body).toMatchObject({ kind: 'text', text: 'reply' })
  })

  it('NewReply while still decrypting → the decrypt settles: exactly one, from the deferred path', () => {
    const h = harness()
    const ev = encryptedReply()
    h.timeline(ev)
    h.newReply(ev)
    expect(receivedReplies(h.events)).toHaveLength(0)
    settle(ev)
    h.decrypted(ev)
    expect(receivedReplies(h.events)).toHaveLength(1)
  })

  // 3a: the reply arrives unreadable and gains its content later → message.edited under the same id.
  it('a reply that settles in failure surfaces once as `unavailable`; the late decrypt is message.edited under the same id', () => {
    const h = harness()
    const ev = encryptedReply()
    h.timeline(ev)
    h.newReply(ev)
    fail(ev)
    h.decrypted(ev)
    const first = receivedReplies(h.events)
    expect(first).toHaveLength(1)
    const unavailable = first[0]!
    if (unavailable.t !== 'message.received') throw new Error('unreachable')
    expect(unavailable.message.body.kind).toBe('unavailable')
    settle(ev)
    h.decrypted(ev)
    expect(receivedReplies(h.events)).toHaveLength(1)
    const edits = h.events.filter((e) => e.t === 'message.edited' && e.message.id === unavailable.message.id)
    expect(edits).toHaveLength(1)
    const edit = edits[0]!
    if (edit.t !== 'message.edited') throw new Error('unreachable')
    expect(edit.message.body).toMatchObject({ kind: 'text', text: 'reply' })
    expect(edit.message.threadParent).toBe(ROOT_ID)
  })

  // 3b: never decrypts → one `unavailable`, a re-failure adds nothing.
  it('a reply that never decrypts is one `unavailable`; a re-failure emits no second receive', () => {
    const h = harness()
    const ev = encryptedReply()
    h.timeline(ev)
    fail(ev)
    h.decrypted(ev)
    h.newReply(ev)
    h.decrypted(ev)
    const got = receivedReplies(h.events)
    expect(got).toHaveLength(1)
    const only = got[0]!
    if (only.t !== 'message.received') throw new Error('unreachable')
    expect(only.message.body.kind).toBe('unavailable')
  })

  // 3c: an answer to a card inside a thread carries the response relation, not the thread one: N6 leaves its
  // path as it was (timeline defers it, the decrypt folds it into the card), late decrypt included; never a line.
  it('an answer to a card in a thread folds into the card, also when it decrypts late; never a message.received', () => {
    const h = harness()
    const CARD_ID = '$card:tayet.local'
    const answerRel = { rel_type: 'io.tayet.response', event_id: CARD_ID }
    const answer = new MatrixEvent({
      type: 'm.room.encrypted',
      event_id: '$answer:tayet.local',
      room_id: ROOM_ID,
      sender: '@other:tayet.local',
      origin_server_ts: 5000,
      content: { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'x', 'm.relates_to': answerRel },
    })
    h.timeline(answer)
    fail(answer)
    h.decrypted(answer)
    settle(answer, { msgtype: 'io.tayet.approval.response', body: 'Aprovar', 'io.tayet.approval.response': { option: 'yes' }, 'm.relates_to': answerRel })
    h.decrypted(answer)
    expect(h.answers).toEqual([
      { cardId: CARD_ID, decrypted: false },
      { cardId: CARD_ID, decrypted: true, option: 'yes' },
    ])
    expect(h.events.filter((e) => e.t === 'message.received')).toEqual([])
  })
})
