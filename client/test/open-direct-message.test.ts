import { describe, it, expect, vi } from 'vitest'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import type { AclTelemetry, UserId } from '../src/acl'

// Self-DM guard (PLANO-PRESENCA §8.6 item 2), unit side — no Synapse. Fake-client idiom of
// auto-join-invite.test.ts: inject the SDK client via the `client` cast, record what the guard
// must NOT reach. Two claims:
//   (i)  openDirectMessage(self) rejects BEFORE any protocol write — no createRoom, no m.direct
//        write — with a neutral message (no mxid: the error can surface in UI copy).
//   (ii) a target != self follows the normal creation path untouched (createRoom + m.direct).

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const ME = '@me:server'
const PEER = '@peer:server'
const ROOM = '!dm:server'

interface Captured {
  createRoomCalls: unknown[]
  accountData: Array<Record<string, unknown>>
}

function harness(): { gateway: MatrixGateway; cap: Captured } {
  const cap: Captured = { createRoomCalls: [], accountData: [] }
  const fakeClient = {
    getUserId: () => ME,
    getRoom: () => null,
    createRoom: (opts: unknown) => {
      cap.createRoomCalls.push(opts)
      return Promise.resolve({ room_id: ROOM })
    },
    getAccountData: () => undefined,
    // Issue #421 (F1): the map goes by a direct call; the custody invite too (ADR-057, addendum of 24/Nov/2026).
    http: {
      authedRequest: (method: string, path: string, _query: unknown, body: Record<string, unknown>) => {
        if (method === 'PUT' && path.endsWith('/account_data/m.direct')) cap.accountData.push(body)
        return Promise.resolve({})
      },
    },
  }
  const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
  ;(gateway as unknown as { client: unknown }).client = fakeClient
  return { gateway, cap }
}

describe('openDirectMessage — self-DM guard (PLANO-PRESENCA §8.6 item 2)', () => {
  it('(i) self as target rejects before any write: no createRoom, no m.direct entry', async () => {
    const { gateway, cap } = harness()
    await expect(gateway.openDirectMessage(ME as UserId)).rejects.toThrow(
      'Cannot open a direct message with yourself',
    )
    // Neutral copy — the message never carries the mxid (P1: it can reach UI copy verbatim).
    await gateway.openDirectMessage(ME as UserId).catch((err: Error) => {
      expect(err.message).not.toContain('@')
    })
    expect(cap.createRoomCalls).toEqual([])
    expect(cap.accountData).toEqual([])
  })

  it('(ii) a target != self follows the normal path (createRoom + m.direct write)', async () => {
    const { gateway, cap } = harness()
    const id = await gateway.openDirectMessage(PEER as UserId)
    expect(String(id)).toBe(ROOM)
    expect(cap.createRoomCalls).toHaveLength(1)
    expect(cap.accountData).toEqual([{ [PEER]: [ROOM] }])
  })
})

// Issue #421, lote "Nova conversa" (F3; ADR-116, Proposto): the direct conversation is born with the marker
// `io.tayet.conversation` `{ kind: 'direct' }`. When the map write fails and the session is redone (no memo, the
// map without the room), the next opening finds the marked room with the person and does not create another.
// Before the marker, that second opening created a second room.
describe('openDirectMessage — the marked room survives a failed map write and a new session', () => {
  const MARKER = 'io.tayet.conversation'
  interface ServerRoom {
    marker?: unknown
    creator?: string
    members: Map<string, string>
  }
  function server() {
    return { rooms: new Map<string, ServerRoom>(), direct: {} as Record<string, string[]>, createRooms: 0 }
  }
  type Server = ReturnType<typeof server>
  const sdkRoom = (id: string, room: ServerRoom) => ({
    roomId: id,
    getMyMembership: () => room.members.get(ME) ?? 'leave',
    getJoinRule: () => 'invite',
    getCanonicalAlias: () => null,
    hasEncryptionStateEvent: () => true,
    isSpaceRoom: () => false,
    getMember: (userId: string) => (room.members.has(userId) ? { userId, membership: room.members.get(userId), events: {} } : null),
    getMembers: () => [...room.members].map(([userId, membership]) => ({ userId, membership })),
    currentState: {
      getStateEvents: (type: string) => {
        if (type === MARKER && room.marker) return { getContent: () => room.marker }
        if (type === 'm.room.create' && room.creator) return { getSender: () => room.creator, getContent: () => ({}) }
        return null
      },
    },
  })
  function session(srv: Server, mapFails: boolean): MatrixGateway {
    // The session's synced copy of the map, taken when it starts (as the first sync would bring it).
    const cached = JSON.parse(JSON.stringify(srv.direct)) as Record<string, string[]>
    const mapWrite = async (content: Record<string, string[]>) => {
      if (mapFails) throw new Error('map write failed')
      srv.direct = content
    }
    const fakeClient = {
      on: () => {},
      off: () => {},
      getUserId: () => ME,
      getRooms: () => [...srv.rooms].map(([id, room]) => sdkRoom(id, room)),
      getRoom: (id: string) => {
        const room = srv.rooms.get(id)
        return room ? sdkRoom(id, room) : null
      },
      createRoom: async (opts: { invite?: string[]; initial_state?: Array<{ type: string; content: unknown }> }) => {
        srv.createRooms++
        const id = `!dm${srv.createRooms}:server`
        const marker = opts.initial_state?.find((e) => e.type === MARKER)?.content
        srv.rooms.set(id, { marker, creator: ME, members: new Map([[ME, 'join'], ...(opts.invite ?? []).map((u) => [u, 'invite'] as [string, string])]) })
        return { room_id: id }
      },
      getAccountData: (type: string) => (type === 'm.direct' ? { getContent: () => cached } : undefined),
      setAccountData: (_type: string, content: Record<string, string[]>) => mapWrite(content),
      http: {
        authedRequest: async (method: string, path: string, _query: unknown, body: unknown) => {
          const invite = /^\/rooms\/([^/]+)\/invite$/.exec(path)
          if (method === 'POST' && invite) {
            const room = srv.rooms.get(decodeURIComponent(invite[1]!))
            room?.members.set((body as { user_id: string }).user_id, 'invite')
            return {}
          }
          if (method === 'PUT' && path.endsWith('/account_data/m.direct')) return mapWrite(body as Record<string, string[]>)
          throw new Error(`unexpected request in fake: ${method} ${path}`)
        },
      },
    }
    const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
    const internals = gateway as unknown as { client: unknown; live: boolean; noteDirectMarker(room: unknown): void }
    internals.client = fakeClient
    internals.live = true
    // connect()'s one sweep over what the first sync brought.
    for (const room of fakeClient.getRooms()) internals.noteDirectMarker(room)
    return gateway
  }

  it('the map write rejects, the session is redone without memo: the same room, no second createRoom', async () => {
    const srv = server()
    await expect(session(srv, true).openDirectMessage(PEER as UserId)).rejects.toThrow('map write failed')
    expect(srv.createRooms).toBe(1)
    expect(srv.direct).toEqual({})

    vi.useFakeTimers()
    const again = session(srv, false)
    expect(String(await again.openDirectMessage(PEER as UserId))).toBe('!dm1:server')
    expect(srv.createRooms).toBe(1)
    // Dec. 5: the map is written back, once, out of the verb's way, after the room has read the same for 3 s.
    await vi.advanceTimersByTimeAsync(2_999)
    expect(srv.direct).toEqual({})
    await vi.advanceTimersByTimeAsync(1)
    expect(srv.direct).toEqual({ [PEER]: ['!dm1:server'] })
    vi.useRealTimers()
  })

  it('a room that had one other person only for a moment (its invites in pieces) is not written to the map', async () => {
    vi.useFakeTimers()
    const srv = server()
    srv.rooms.set('!w:server', { marker: { kind: 'direct' }, creator: ME, members: new Map([[ME, 'join'], [PEER, 'invite']]) })
    const gateway = session(srv, false)
    const read = (gateway as unknown as { dmPeerByRoom(): Map<string, string> }).dmPeerByRoom()
    expect(read.get('!w:server')).toBe(PEER)
    srv.rooms.get('!w:server')!.members.set('@other:server', 'invite')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(srv.direct).toEqual({})
    expect((gateway as unknown as { dmPeerByRoom(): Map<string, string> }).dmPeerByRoom().has('!w:server')).toBe(false)
    vi.useRealTimers()
  })

  // PR #515 review (/security-review, adjudicated): an ordinary account creates a room with the marker, invites two
  // people without is_direct and leaves. The marker is read only when the room's creator is this session or the peer.
  it('a marked room created by a third party, with one other person, is not a direct conversation', async () => {
    vi.useFakeTimers()
    const srv = server()
    srv.rooms.set('!c:server', {
      marker: { kind: 'direct' },
      creator: '@carol:server',
      members: new Map([[ME, 'join'], [PEER, 'join'], ['@carol:server', 'leave']]),
    })
    const gateway = session(srv, false)
    expect((gateway as unknown as { dmPeerByRoom(): Map<string, string> }).dmPeerByRoom().has('!c:server')).toBe(false)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(srv.direct).toEqual({})
    vi.useRealTimers()
    expect(String(await gateway.openDirectMessage(PEER as UserId))).not.toBe('!c:server')
    expect(srv.createRooms).toBe(1)
  })

  it('a marked room whose create event is not in the state is not a direct conversation', () => {
    const srv = server()
    srv.rooms.set('!n:server', { marker: { kind: 'direct' }, members: new Map([[ME, 'join'], [PEER, 'join']]) })
    const gateway = session(srv, false)
    expect((gateway as unknown as { dmPeerByRoom(): Map<string, string> }).dmPeerByRoom().has('!n:server')).toBe(false)
  })

  it('a marked room created by the peer is a direct conversation', () => {
    const srv = server()
    srv.rooms.set('!p:server', { marker: { kind: 'direct' }, creator: PEER, members: new Map([[ME, 'join'], [PEER, 'join']]) })
    const gateway = session(srv, false)
    expect((gateway as unknown as { dmPeerByRoom(): Map<string, string> }).dmPeerByRoom().get('!p:server')).toBe(PEER)
  })
})
