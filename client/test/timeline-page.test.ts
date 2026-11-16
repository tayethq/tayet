import { describe, it, expect, vi } from 'vitest'
import { MatrixEvent, type IEvent } from 'matrix-js-sdk'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import { brandChannelId } from '@tayet/shared/internal'
import type { AclTelemetry, PageCursor } from '../src/acl'

// #286: a page of the main timeline is what the stream keeps in the main timeline. The /messages
// chunk also carries thread replies and raw m.replace events, and the room's start is on the page
// that holds its creation, not only on the empty page after it. No stack: a fake client.

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const ROOM_ID = '!room:tayet.local'
const SENDER = '@bob:tayet.local'

let n = 0
function raw(content: object, extra: Partial<IEvent> = {}): Partial<IEvent> {
  n += 1
  return {
    event_id: `$e${n}:tayet.local`,
    room_id: ROOM_ID,
    sender: SENDER,
    type: 'm.room.message',
    origin_server_ts: 1000 + n,
    content,
    ...extra,
  }
}
const text = (body: string) => raw({ msgtype: 'm.text', body })
const threadReply = (root: string) =>
  raw({ msgtype: 'm.text', body: 'reply', 'm.relates_to': { rel_type: 'm.thread', event_id: root } })
const edit = (target: string, body: string) =>
  raw({
    msgtype: 'm.text',
    body: `* ${body}`,
    'm.new_content': { msgtype: 'm.text', body },
    'm.relates_to': { rel_type: 'm.replace', event_id: target },
  })
const create = () => raw({ creator: SENDER }, { type: 'm.room.create', state_key: '' })

function gatewayWith(chunkNewestFirst: Partial<IEvent>[], end?: string, live: Partial<IEvent>[] = [], token: string | null = 't0') {
  const timeline = {
    getEvents: () => live.map((e) => new MatrixEvent(e)),
    getPaginationToken: () => token,
  }
  const room = {
    roomId: ROOM_ID,
    getLiveTimeline: () => timeline,
    findEventById: () => undefined,
    getThread: () => null,
    hasEncryptionStateEvent: () => false,
    relations: { getChildEventsForEvent: () => undefined },
  }
  const client = {
    getRoom: () => room,
    // PLANO-AGENTES §0.3.11: kindOf (asked per author) looks for the organization channel — none here.
    getRooms: () => [],
    getUserId: () => '@me:tayet.local',
    getAccountData: () => undefined,
    decryptEventIfNeeded: vi.fn(async () => {}),
    createMessagesRequest: vi.fn(async () => ({ chunk: chunkNewestFirst, end })),
  }
  const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
  ;(gateway as unknown as { client: unknown }).client = client
  return gateway
}

const ID = brandChannelId(ROOM_ID)
const CURSOR = 't1' as unknown as PageCursor
const bodies = (items: { body: unknown }[]) => items.map((m) => (m.body as { text?: string }).text)

describe('getTimeline: a page of the main timeline (#286)', () => {
  it('a mixed chunk (message, thread reply, edit) yields only the main message', async () => {
    const main = text('main')
    const gateway = gatewayWith([edit(main.event_id!, 'changed'), threadReply(main.event_id!), main], 'next')

    const page = await gateway.getTimeline(ID, { cursor: CURSOR })

    expect(bodies(page.items)).toEqual(['main'])
    expect(page.items[0]?.threadParent).toBeUndefined()
  })

  it('an edit past the chunk reaches its message through the server bundle', async () => {
    const main = text('old')
    const latest = edit(main.event_id!, 'new')
    main.unsigned = { 'm.relations': { 'm.replace': latest } } as IEvent['unsigned']
    const gateway = gatewayWith([main], 'next')

    const page = await gateway.getTimeline(ID, { cursor: CURSOR })

    expect(bodies(page.items)).toEqual(['new'])
  })

  it('the first page drops a replacement row too', async () => {
    const main = text('main')
    const gateway = gatewayWith([], undefined, [main, edit(main.event_id!, 'changed')])

    const page = await gateway.getTimeline(ID)

    expect(page.items.map((m) => m.id)).toEqual([main.event_id])
  })
})

describe('getTimeline: the end of the history (#286)', () => {
  it('a chunk without `end` has no next cursor', async () => {
    const page = await gatewayWith([text('oldest')]).getTimeline(ID, { cursor: CURSOR })

    expect(bodies(page.items)).toEqual(['oldest'])
    expect(page.nextCursor).toBeUndefined()
  })

  it('an empty translated page without `end` has no next cursor', async () => {
    const page = await gatewayWith([]).getTimeline(ID, { cursor: CURSOR })

    expect(page.items).toEqual([])
    expect(page.nextCursor).toBeUndefined()
  })

  it('a chunk with `end` keeps the cursor, even when nothing on it is a row', async () => {
    const root = text('root')
    const page = await gatewayWith([threadReply(root.event_id!)], 'next').getTimeline(ID, { cursor: CURSOR })

    expect(page.items).toEqual([])
    expect(page.nextCursor).toBe('next')
  })

  it("a chunk holding the room's creation ends the history despite `end`", async () => {
    const page = await gatewayWith([text('first'), create()], 'next').getTimeline(ID, { cursor: CURSOR })

    expect(bodies(page.items)).toEqual(['first'])
    expect(page.nextCursor).toBeUndefined()
  })

  it('a room with no messages offers no cursor on its first page', async () => {
    const page = await gatewayWith([], undefined, [create()]).getTimeline(ID)

    expect(page.items).toEqual([])
    expect(page.nextCursor).toBeUndefined()
  })

  it('a first page short of the creation keeps the SDK token', async () => {
    const page = await gatewayWith([], undefined, [text('recent')]).getTimeline(ID)

    expect(page.nextCursor).toBe('t0')
  })
})
