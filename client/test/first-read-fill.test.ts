import { describe, it, expect, vi, afterEach } from 'vitest'
import { MatrixEvent, type IEvent } from 'matrix-js-sdk'
import { MatrixGateway, FIRST_READ_FILL_MS } from '../src/acl/internal/matrix-client'
import { brandChannelId } from '@tayet/shared/internal'
import type { AclTelemetry } from '../src/acl'

// Issue #421 (lote "Nova conversa", CI run 45452432541): a room joined after the first sync reaches its joiner
// with the server's default of 10 timeline events, without the room's creation for a new direct conversation
// (its birth marker is one event more) or group. The first read of a live window without the room's start, in a room
// whose join this session saw happen (after its first sync), fetches ONE page back, under FIRST_READ_FILL_MS; a
// deadline or a failure answers as before. Any other room never fetches, even with this session's own join in the
// window (CI run 45519024444: a quiet room brings it in the initial sync's window). Harness of
// timeline-page.test.ts, with the direct /messages request faked; the seen join is set on the gateway's set, which
// the →join listener fills on the stack (acl-first-read-fill).

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const ROOM_ID = '!room:tayet.local'
const SENDER = '@bob:tayet.local'

let n = 0
function raw(content: object, extra: Partial<IEvent> = {}): Partial<IEvent> {
  n += 1
  return { event_id: `$f${n}:tayet.local`, room_id: ROOM_ID, sender: SENDER, type: 'm.room.message', origin_server_ts: 1000 + n, content, ...extra }
}
const text = (body: string) => raw({ msgtype: 'm.text', body })
const create = () => raw({ creator: SENDER }, { type: 'm.room.create', state_key: '' })
// This session's own join event, in the window.
const myJoin = () => raw({ membership: 'join' }, { type: 'm.room.member', state_key: '@me:tayet.local', sender: '@me:tayet.local' })
const otherJoin = () => raw({ membership: 'join' }, { type: 'm.room.member', state_key: SENDER })

function gatewayWith(
  live: Partial<IEvent>[],
  fetchPage: () => Promise<{ chunk: Partial<IEvent>[]; end?: string }>,
  { joinSeen = true }: { joinSeen?: boolean } = {},
) {
  const requests: Array<{ path: string; query: unknown }> = []
  const timeline = { getEvents: () => live.map((e) => new MatrixEvent(e)), getPaginationToken: () => 't0' }
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
    getRooms: () => [],
    getUserId: () => '@me:tayet.local',
    getAccountData: () => undefined,
    decryptEventIfNeeded: vi.fn(async () => {}),
    http: {
      authedRequest: (method: string, path: string, query: unknown, _body: unknown, opts?: { abortSignal?: AbortSignal }) => {
        requests.push({ path, query })
        if (method !== 'GET' || !path.endsWith('/messages')) throw new Error(`unexpected ${method} ${path}`)
        return new Promise((resolve, reject) => {
          opts?.abortSignal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
          fetchPage().then(resolve, reject)
        })
      },
    },
  }
  const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
  ;(gateway as unknown as { client: unknown }).client = client
  // The room's transition to join, seen by this session after its first sync.
  if (joinSeen) (gateway as unknown as { joinsSeen: Set<string> }).joinsSeen.add(ROOM_ID)
  return { gateway, requests }
}

const ID = brandChannelId(ROOM_ID)
const bodies = (items: { body: unknown }[]) => items.map((m) => (m.body as { text?: string }).text)

afterEach(() => {
  vi.useRealTimers()
})

describe('the first read of a window without the room start (issue #421)', () => {
  it('a short window fetches one page back: everything in order, no repeat, no cursor once the start is in', async () => {
    const shared = text('b')
    const live = [shared, text('c')]
    // dir=b: newest first; the page overlaps the window by one event and ends at the creation.
    const { gateway, requests } = gatewayWith(live, async () => ({ chunk: [shared, text('a'), create()], end: 'older' }))
    const page = await gateway.getTimeline(ID)
    expect(bodies(page.items)).toEqual(['a', 'b', 'c'])
    expect(page.nextCursor).toBeUndefined()
    expect(requests).toHaveLength(1)
    expect(requests[0]!.query).toMatchObject({ from: 't0', dir: 'b', limit: '30' })
  })

  it('a page that does not reach the start keeps its own cursor; still one request', async () => {
    const { gateway, requests } = gatewayWith([text('c')], async () => ({ chunk: [text('b'), text('a')], end: 'older' }))
    const page = await gateway.getTimeline(ID)
    expect(bodies(page.items)).toEqual(['a', 'b', 'c'])
    expect(String(page.nextCursor)).toBe('older')
    expect(requests).toHaveLength(1)
  })

  it('an event the stream delivers while the page is fetched is in the answer (the screen replaces its list with it)', async () => {
    const live = [text('b')]
    const { gateway } = gatewayWith(live, async () => {
      live.push(text('c'))
      return { chunk: [text('a'), create()] }
    })
    const page = await gateway.getTimeline(ID)
    expect(bodies(page.items)).toEqual(['a', 'b', 'c'])
  })

  it.each([
    ['short', 3],
    ['long', 40],
  ])('a %s window of a room whose join this session did not see does not fetch (a room joined before it)', async (_label, size) => {
    const live = [otherJoin(), ...Array.from({ length: size }, (_, i) => text(`m${i}`))]
    const { gateway, requests } = gatewayWith(live, async () => ({ chunk: [create()] }), { joinSeen: false })
    const page = await gateway.getTimeline(ID)
    expect(requests).toHaveLength(0)
    expect(String(page.nextCursor)).toBe('t0')
  })

  // CI run 45519024444: a session born after its entry to a quiet room has that entry in the initial sync's window.
  it('a window with this session\'s own join, in a room whose join it did not see, does not fetch', async () => {
    const live = [text('a'), myJoin(), text('b')]
    const { gateway, requests } = gatewayWith(live, async () => ({ chunk: [create()] }), { joinSeen: false })
    const page = await gateway.getTimeline(ID)
    expect(requests).toHaveLength(0)
    expect(bodies(page.items)).toEqual(['a', 'b'])
    expect(String(page.nextCursor)).toBe('t0')
  })

  it('a long window without the start, in a room whose join this session saw, fetches', async () => {
    const live = Array.from({ length: 40 }, (_, i) => text(`m${i}`))
    const { gateway, requests } = gatewayWith(live, async () => ({ chunk: [text('a'), create()] }))
    const page = await gateway.getTimeline(ID)
    expect(requests).toHaveLength(1)
    expect(bodies(page.items)[0]).toBe('a')
    expect(page.nextCursor).toBeUndefined()
  })

  it('a request past the 3 s deadline answers as today: the live window and its cursor', async () => {
    vi.useFakeTimers()
    const { gateway } = gatewayWith([text('c')], () => new Promise(() => {}))
    const read = gateway.getTimeline(ID)
    await vi.advanceTimersByTimeAsync(FIRST_READ_FILL_MS)
    const page = await read
    expect(bodies(page.items)).toEqual(['c'])
    expect(String(page.nextCursor)).toBe('t0')
  })

  // PR #515 review: someone added to a private channel with history cannot read what came before the entry; a page
  // with any of that would open the conversation with rows of "message unavailable". The page is dropped.
  it('a fetched page with an event that does not decrypt answers as today: the live window and its cursor', async () => {
    const sealed = raw({ algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'x', session_id: 's' }, { type: 'm.room.encrypted' })
    const { gateway, requests } = gatewayWith([text('c')], async () => ({ chunk: [text('b'), sealed, text('a')], end: 'older' }))
    const page = await gateway.getTimeline(ID)
    expect(requests).toHaveLength(1)
    expect(bodies(page.items)).toEqual(['c'])
    expect(String(page.nextCursor)).toBe('t0')
  })

  it('a request that fails answers as today too', async () => {
    const { gateway } = gatewayWith([text('c')], async () => {
      throw new Error('refused')
    })
    const page = await gateway.getTimeline(ID)
    expect(bodies(page.items)).toEqual(['c'])
    expect(String(page.nextCursor)).toBe('t0')
  })
})
