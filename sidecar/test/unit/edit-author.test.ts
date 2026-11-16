import { describe, it, expect, vi } from 'vitest'
import { ClientEvent, MatrixEvent, RoomEvent, type IEvent } from 'matrix-js-sdk'
import { createReadFacade, type ReadClient } from '../../src/core/read'
import { conversationToken, messageTs } from '../../src/api/ids'
import type { ApiEvent } from '../../src/api/contract'

// An edit applies only when it comes from the author of the message it targets (§0 da A3, blocker
// 0.2): the live path emits no `message.edited` for another member's edit (and logs it without any
// protocol id), and the two reads — a listing page and one message — show the original when the
// server bundles a forged edit. No stack: a fake client over real SDK events.

const ME = '@a-aaaaaaaaaaaa:tayet.local'
const ALICE = '@alice:tayet.local'
const MALLORY = '@mallory:tayet.local'
const ROOM_ID = '!room:tayet.local'
const TARGET_ID = '$target:tayet.local'
const CONVERSATION = conversationToken(ROOM_ID, false)

let n = 0
function raw(content: object, extra: Partial<IEvent> = {}): Partial<IEvent> {
  n += 1
  return { event_id: `$e${n}:tayet.local`, room_id: ROOM_ID, sender: ALICE, type: 'm.room.message', origin_server_ts: 1000 + n, content, ...extra }
}
const targetRaw = (): Partial<IEvent> => raw({ msgtype: 'm.text', body: 'original' }, { event_id: TARGET_ID, origin_server_ts: 500 })
const editRaw = (sender: string, body: string, target = TARGET_ID): Partial<IEvent> =>
  raw(
    { msgtype: 'm.text', body: `* ${body}`, 'm.new_content': { msgtype: 'm.text', body }, 'm.relates_to': { rel_type: 'm.replace', event_id: target } },
    { sender },
  )

type Handler = (...args: unknown[]) => void

function harness(opts: { roomHoldsTarget?: boolean; chunk?: Partial<IEvent>[]; fetched?: Partial<IEvent> } = {}) {
  const target = new MatrixEvent(targetRaw())
  const holds = opts.roomHoldsTarget ?? true
  const room = {
    roomId: ROOM_ID,
    getMyMembership: () => 'join',
    getMembers: () => [],
    getMember: () => null,
    findEventById: (id: string) => (holds && id === TARGET_ID ? target : undefined),
    getThread: () => null,
    getLiveTimeline: () => ({ getEvents: () => [], getPaginationToken: () => 'older' }),
    relations: { getChildEventsForEvent: () => undefined },
    currentState: { getStateEvents: () => null },
  }
  const handlers = new Map<string, Handler[]>()
  const fetched = opts.fetched ?? targetRaw()
  const client = {
    getUserId: () => ME,
    getRooms: () => [room],
    getRoom: () => room,
    getAccountData: () => undefined,
    getProfileInfo: () => Promise.resolve({}),
    decryptEventIfNeeded: async () => {},
    createMessagesRequest: () => Promise.resolve({ chunk: opts.chunk ?? [], end: undefined }),
    relations: () => Promise.resolve({ events: [], nextBatch: null }),
    fetchRoomEvent: vi.fn(async (_roomId: string, id: string) => (id === fetched.event_id ? fetched : Promise.reject(new Error('M_NOT_FOUND')))),
    timestampToEvent: () => Promise.resolve({ event_id: fetched.event_id as string, origin_server_ts: fetched.origin_server_ts as number }),
    http: { authedRequest: () => Promise.resolve({}) },
    on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
    off: () => {},
  } as unknown as ReadClient
  const logs: Record<string, unknown>[] = []
  const facade = createReadFacade(client, (line) => logs.push(line))
  const fire = (name: string, ...args: unknown[]): void => {
    for (const h of handlers.get(name) ?? []) h(...args)
  }
  fire(ClientEvent.Sync, 'PREPARED')
  const events: ApiEvent[] = []
  facade.subscribe((e) => events.push(e))
  const timeline = (ev: MatrixEvent): void => fire(RoomEvent.Timeline, ev, room, false, false, { liveEvent: true })
  return { facade, events, logs, timeline, client }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
}

describe('sidecar live edit — only the author edits', () => {
  it('another member’s edit emits no message.edited and logs it without ids; the author’s edit applies', async () => {
    const { events, logs, timeline } = harness()
    timeline(new MatrixEvent(editRaw(MALLORY, 'forged')))
    await settle()
    expect(events).toEqual([])
    expect(logs).toContainEqual({ evt: 'edit-ignored', reason: 'not-author' })
    expect(JSON.stringify(logs)).not.toMatch(/[$!@]/)

    timeline(new MatrixEvent(editRaw(ALICE, 'fixed')))
    await settle()
    expect(events.map((e) => e.type)).toEqual(['message.edited'])
    const e = events[0]
    if (e?.type === 'message.edited') expect([e.message.id, e.message.text]).toEqual([messageTs(500, TARGET_ID), 'fixed'])
  })

  it('a target the room does not hold: its sender is read from the server before the edit applies', async () => {
    const { events, logs, timeline, client } = harness({ roomHoldsTarget: false })
    timeline(new MatrixEvent(editRaw(MALLORY, 'forged')))
    await settle()
    expect(events).toEqual([])
    expect(logs).toContainEqual({ evt: 'edit-ignored', reason: 'not-author' })

    timeline(new MatrixEvent(editRaw(ALICE, 'fixed')))
    await settle()
    expect(events.map((e) => e.type)).toEqual(['message.edited'])
    expect(client.fetchRoomEvent).toHaveBeenCalledWith(ROOM_ID, TARGET_ID)
  })
})

describe('sidecar reads — the server-bundled edit is checked too', () => {
  it('listing page: a forged bundled edit leaves the original; the author’s bundled edit shows', async () => {
    const forgedTarget = raw({ msgtype: 'm.text', body: 'kept' })
    forgedTarget.unsigned = { 'm.relations': { 'm.replace': editRaw(MALLORY, 'forged', forgedTarget.event_id) } }
    const legitTarget = raw({ msgtype: 'm.text', body: 'old' })
    legitTarget.unsigned = { 'm.relations': { 'm.replace': editRaw(ALICE, 'new', legitTarget.event_id) } }
    const { facade } = harness({ chunk: [legitTarget, forgedTarget] })

    const page = await facade.messages(CONVERSATION, {})

    expect(page.messages.map((m) => [m.text, m.editedAt !== undefined])).toEqual([
      ['new', true],
      ['kept', false],
    ])
  })

  it('one message: a forged bundled edit leaves the original', async () => {
    const fetched = targetRaw()
    fetched.unsigned = { 'm.relations': { 'm.replace': editRaw(MALLORY, 'forged') } }
    const { facade } = harness({ roomHoldsTarget: false, fetched })

    const m = await facade.message(CONVERSATION, messageTs(500, TARGET_ID))

    expect([m.text, m.editedAt]).toEqual(['original', undefined])
  })

  it('one message: the author’s bundled edit shows', async () => {
    const fetched = targetRaw()
    fetched.unsigned = { 'm.relations': { 'm.replace': editRaw(ALICE, 'fixed') } }
    const { facade } = harness({ roomHoldsTarget: false, fetched })

    const m = await facade.message(CONVERSATION, messageTs(500, TARGET_ID))

    expect([m.text, m.editedAt !== undefined]).toEqual(['fixed', true])
  })
})
