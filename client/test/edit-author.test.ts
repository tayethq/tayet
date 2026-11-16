import { describe, it, expect, vi } from 'vitest'
import { MatrixEvent, RoomEvent, MatrixEventEvent, type IEvent } from 'matrix-js-sdk'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import { brandChannelId } from '@tayet/shared/internal'
import type { AclTelemetry, DomainEvent, MessageId, PageCursor } from '../src/acl'

// An edit applies only when it comes from the author of the message it targets (§0 da A3, blocker
// 0.2). Every client path that applies an edit — the live stream (cleartext, first settle of a
// deferred decrypt, late upgrade), a target the room does not hold, the pages (live timeline,
// /messages with the server's bundled edit, a thread) and the search jump — is exercised with a
// forged edit (another member) next to a legitimate one (the author).
// No stack: fake client and room over real SDK events.

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const ME = '@me:tayet.local'
const ALICE = '@alice:tayet.local' // the author of the target
const MALLORY = '@mallory:tayet.local' // another member of the conversation
const ROOM_ID = '!room:tayet.local'
const TARGET_ID = '$target:tayet.local'
const CHANNEL = brandChannelId(ROOM_ID)

type Handler = (...args: never[]) => void

let n = 0
function raw(content: object, extra: Partial<IEvent> = {}): Partial<IEvent> {
  n += 1
  return {
    event_id: `$e${n}:tayet.local`,
    room_id: ROOM_ID,
    sender: ALICE,
    type: 'm.room.message',
    origin_server_ts: 1000 + n,
    content,
    ...extra,
  }
}
const targetRaw = (): Partial<IEvent> =>
  raw({ msgtype: 'm.text', body: 'original' }, { event_id: TARGET_ID, origin_server_ts: 500 })
const editRaw = (sender: string, body: string, target = TARGET_ID): Partial<IEvent> =>
  raw(
    {
      msgtype: 'm.text',
      body: `* ${body}`,
      'm.new_content': { msgtype: 'm.text', body },
      'm.relates_to': { rel_type: 'm.replace', event_id: target },
    },
    { sender },
  )

// A fake encrypted edit walking the SDK's decrypt lifecycle (decrypt-cycle.test.ts has the full
// fixture): raw while decrypting, the failure stub on a settled failure, the clear payload on success.
function encryptedEdit(opts: { id: string; sender: string; body: string; wireRelation: boolean }) {
  let phase: 'decrypting' | 'failed' | 'clear' = 'decrypting'
  const relates = { rel_type: 'm.replace', event_id: TARGET_ID }
  const wire: Record<string, unknown> = { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'x', session_id: 's' }
  if (opts.wireRelation) wire['m.relates_to'] = relates
  const clear = {
    msgtype: 'm.text',
    body: `* ${opts.body}`,
    'm.new_content': { msgtype: 'm.text', body: opts.body },
    'm.relates_to': relates,
  }
  const content = (): Record<string, unknown> =>
    phase === 'clear' ? clear : phase === 'failed' ? { msgtype: 'm.bad.encrypted', body: '**' } : wire
  const ev = {
    isEncrypted: () => true,
    isBeingDecrypted: () => phase === 'decrypting',
    shouldAttemptDecryption: () => false,
    isDecryptionFailure: () => phase === 'failed',
    decryptionFailureReason: null,
    getWireContent: () => wire,
    getType: () => (phase === 'decrypting' ? 'm.room.encrypted' : 'm.room.message'),
    getContent: content,
    getOriginalContent: content,
    isRedacted: () => false,
    getId: () => opts.id,
    getTxnId: () => undefined,
    getSender: () => opts.sender,
    getRoomId: () => ROOM_ID,
    getTs: () => 2000,
    replacingEventDate: () => undefined,
    replacingEvent: () => null,
    getServerAggregatedRelation: () => undefined,
    getRelation: () => (wire['m.relates_to'] as object | undefined) ?? null,
    status: null,
  }
  return { ev, fail: () => (phase = 'failed'), clear: () => (phase = 'clear') }
}

function harness(opts?: { roomHoldsTarget?: boolean; fetchTarget?: () => Promise<Partial<IEvent>> }) {
  const target = new MatrixEvent(targetRaw())
  const holds = opts?.roomHoldsTarget ?? true
  const room = {
    roomId: ROOM_ID,
    getCanonicalAlias: () => null,
    getMyMembership: () => 'join',
    findEventById: (id: string) => (holds && id === TARGET_ID ? target : undefined),
    getThread: () => undefined,
    getLiveTimeline: () => ({ getEvents: () => (holds ? [target] : []), getPaginationToken: () => null }),
    relations: { getChildEventsForEvent: () => undefined },
    hasEncryptionStateEvent: () => false,
  }
  const handlers = new Map<string, Handler[]>()
  const fetchRoomEvent = vi.fn(opts?.fetchTarget ?? (async () => targetRaw()))
  const client = {
    getRooms: () => [room],
    getRoom: () => room,
    getCrypto: () => ({}),
    getUserId: () => ME,
    getAccountData: () => undefined,
    makeTxnId: () => 'txn-1',
    fetchRoomEvent,
    decryptEventIfNeeded: vi.fn(async () => {}),
    sendMessage: vi.fn(async () => ({ event_id: '$sent:tayet.local' })),
    on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
    off: () => {},
  }
  const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
  const g = gateway as unknown as { client: unknown; live: boolean; wireEvents(c: unknown): void }
  g.client = client
  g.wireEvents(client)
  g.live = true
  const events: DomainEvent[] = []
  gateway.subscribe((e) => events.push(e))
  const fire = (name: string, ...args: unknown[]): void => {
    for (const h of handlers.get(name) ?? []) (h as (...a: unknown[]) => void)(...args)
  }
  const timeline = (ev: unknown): void => fire(RoomEvent.Timeline as string, ev, room, false, false, { liveEvent: true })
  const decrypted = (ev: unknown): void => fire(MatrixEventEvent.Decrypted as string, ev)
  return { gateway, events, timeline, decrypted, fetchRoomEvent, client, target }
}

const edited = (events: DomainEvent[]) =>
  events.flatMap((e) => (e.t === 'message.edited' ? [e.message] : []))
const text = (m: { body: unknown } | undefined) => (m?.body as { text?: string } | undefined)?.text
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('live edit — only the author edits (cleartext timeline)', () => {
  it('an edit from another member emits nothing; the author’s own edit applies', () => {
    const { events, timeline } = harness()
    timeline(new MatrixEvent(editRaw(MALLORY, 'forged')))
    expect(events).toEqual([])

    timeline(new MatrixEvent(editRaw(ALICE, 'fixed')))
    const [m] = edited(events)
    expect(events).toHaveLength(1)
    expect(m?.id).toBe(TARGET_ID)
    expect(text(m)).toBe('fixed')
    expect(m?.author).toBe(ALICE)
    expect(m?.editedAt).toBeDefined()
  })
})

describe('live edit — after decryption', () => {
  it('first settle of a deferred encrypted edit: forged dropped, legitimate applied', () => {
    const { events, timeline, decrypted } = harness()
    const forged = encryptedEdit({ id: '$f1:tayet.local', sender: MALLORY, body: 'forged', wireRelation: true })
    timeline(forged.ev)
    forged.clear()
    decrypted(forged.ev)
    expect(events).toEqual([])

    const legit = encryptedEdit({ id: '$l1:tayet.local', sender: ALICE, body: 'fixed', wireRelation: true })
    timeline(legit.ev)
    legit.clear()
    decrypted(legit.ev)
    expect(edited(events).map(text)).toEqual(['fixed'])
  })

  it('an unreadable edit that later decrypts: forged dropped, legitimate applied', () => {
    const { events, timeline, decrypted } = harness()
    const forged = encryptedEdit({ id: '$f2:tayet.local', sender: MALLORY, body: 'forged', wireRelation: true })
    timeline(forged.ev)
    forged.fail()
    decrypted(forged.ev)
    forged.clear()
    decrypted(forged.ev)
    expect(events).toEqual([])

    const legit = encryptedEdit({ id: '$l2:tayet.local', sender: ALICE, body: 'fixed', wireRelation: true })
    timeline(legit.ev)
    legit.fail()
    decrypted(legit.ev)
    legit.clear()
    decrypted(legit.ev)
    expect(edited(events).map(text)).toEqual(['fixed'])
  })

  it('a surfaced `unavailable` that turns out to be an edit (late upgrade): forged dropped, legitimate applied', () => {
    const { events, timeline, decrypted } = harness()
    // No relation on the wire: the failure surfaces as an `unavailable` row, the clear payload is an edit.
    const forged = encryptedEdit({ id: '$f3:tayet.local', sender: MALLORY, body: 'forged', wireRelation: false })
    timeline(forged.ev)
    forged.fail()
    decrypted(forged.ev)
    expect(events.map((e) => e.t)).toEqual(['message.received'])
    forged.clear()
    decrypted(forged.ev)
    expect(edited(events)).toEqual([])

    const legit = encryptedEdit({ id: '$l3:tayet.local', sender: ALICE, body: 'fixed', wireRelation: false })
    timeline(legit.ev)
    legit.fail()
    decrypted(legit.ev)
    legit.clear()
    decrypted(legit.ev)
    expect(edited(events).map((m) => [m.id, text(m)])).toEqual([[TARGET_ID, 'fixed']])
  })
})

describe('live edit — target the room does not hold', () => {
  it('the sender is read from the server: forged dropped, legitimate applied', async () => {
    const { events, timeline, fetchRoomEvent } = harness({ roomHoldsTarget: false })
    timeline(new MatrixEvent(editRaw(MALLORY, 'forged')))
    await flush()
    expect(events).toEqual([])

    timeline(new MatrixEvent(editRaw(ALICE, 'fixed')))
    await flush()
    expect(edited(events).map((m) => [m.id, text(m)])).toEqual([[TARGET_ID, 'fixed']])
    expect(fetchRoomEvent).toHaveBeenCalledWith(ROOM_ID, TARGET_ID)
  })

  it('a target whose sender cannot be read is never edited', async () => {
    const { events, timeline } = harness({
      roomHoldsTarget: false,
      fetchTarget: async () => {
        throw new Error('offline')
      },
    })
    timeline(new MatrixEvent(editRaw(ALICE, 'fixed')))
    await flush()
    expect(events).toEqual([])
  })
})

describe('pages — an edit applied by the SDK or the server bundle is checked too', () => {
  it('/messages page: the bundled edit applies only when it is the author’s', async () => {
    const { gateway, client } = harness()
    const forgedTarget = raw({ msgtype: 'm.text', body: 'kept' })
    forgedTarget.unsigned = { 'm.relations': { 'm.replace': editRaw(MALLORY, 'forged', forgedTarget.event_id) } } as IEvent['unsigned']
    const legitTarget = raw({ msgtype: 'm.text', body: 'old' })
    legitTarget.unsigned = { 'm.relations': { 'm.replace': editRaw(ALICE, 'new', legitTarget.event_id) } } as IEvent['unsigned']
    ;(client as unknown as { createMessagesRequest: unknown }).createMessagesRequest = async () => ({
      chunk: [legitTarget, forgedTarget],
      end: 'next',
    })

    const page = await gateway.getTimeline(CHANNEL, { cursor: 't1' as unknown as PageCursor })

    expect(page.items.map((m) => [text(m), m.author, m.editedAt !== undefined])).toEqual([
      ['kept', ALICE, false],
      ['new', ALICE, true],
    ])
  })

  it('live timeline page: a target the SDK already replaced with a forged edit shows its original', async () => {
    const { gateway, target } = harness()
    target.makeReplaced(new MatrixEvent(editRaw(MALLORY, 'forged')))

    const page = await gateway.getTimeline(CHANNEL)

    expect(page.items.map((m) => [text(m), m.editedAt])).toEqual([['original', undefined]])
  })

  it('live timeline page: the author’s replacement still shows', async () => {
    const { gateway, target } = harness()
    target.makeReplaced(new MatrixEvent(editRaw(ALICE, 'fixed')))

    const page = await gateway.getTimeline(CHANNEL)

    expect(page.items.map((m) => [text(m), m.editedAt !== undefined])).toEqual([['fixed', true]])
  })

  it('thread page: a reply replaced by a forged edit (the SDK applies bundles unchecked) shows its original', async () => {
    const { gateway, client } = harness()
    const reply = (body: string) =>
      new MatrixEvent(raw({ msgtype: 'm.text', body, 'm.relates_to': { rel_type: 'm.thread', event_id: TARGET_ID } }))
    const forged = reply('kept')
    forged.makeReplaced(new MatrixEvent(editRaw(MALLORY, 'forged', forged.getId())))
    const legit = reply('old')
    legit.makeReplaced(new MatrixEvent(editRaw(ALICE, 'new', legit.getId())))
    ;(client as unknown as { relations: unknown }).relations = async () => ({ events: [legit, forged], nextBatch: null })

    const page = await gateway.getTimeline(CHANNEL, { thread: TARGET_ID as unknown as MessageId })

    expect(page.items.map(text)).toEqual(['kept', 'new'])
  })

  it('search jump (getMessage): a held target replaced by a forged edit shows its original', async () => {
    const { gateway, target } = harness()
    target.makeReplaced(new MatrixEvent(editRaw(MALLORY, 'forged')))

    const m = await gateway.getMessage(CHANNEL, TARGET_ID as unknown as MessageId)

    expect([text(m), m?.editedAt]).toEqual(['original', undefined])
  })
})
