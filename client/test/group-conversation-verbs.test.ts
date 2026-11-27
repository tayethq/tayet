import { describe, it, expect, vi } from 'vitest'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import { brandChannelId, brandUserId } from '@tayet/shared/internal'
import { GROUP_MAX_OTHERS } from '../src/acl'
import type { AclTelemetry, UserId } from '../src/acl'
import { directInviteHttp } from './support/direct-invite'

// ADR-094 (Proposto) dec. 6 to 9 and 13 — PR-2, the verbs (PLANO-CONVERSAS §0.3.2). Fake-client idiom of
// open-direct-message.test.ts and own-agent.test.ts: the state is what the sync would deliver.
//   - openGroupConversation: every refusal before createRoom; the createRoom body; the own agent counted in
//     the limit; idempotency by the exact set (memo, cold path, tie on the oldest creation).
//   - convertToChannel: name first, marker second; refusals before any write; a failure on the second
//     write propagates after the first.
//   - the five management verbs refuse in a group and keep working in a channel.

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const DOMAIN = 'tayet.local'
const ME = `@u-operadorxyz2:${DOMAIN}`
const CUSTODY = `@cofre:${DOMAIN}`
const SYSTEM = `@system:${DOMAIN}`
const ORG = `!org:${DOMAIN}`
const MINE = `@a-abcdefgh2345:${DOMAIN}`
const THEIRS = `@a-zzzzzzzz2345:${DOMAIN}`
const GUEST = `@guest:${DOMAIN}`
const P = Array.from({ length: 9 }, (_, i) => `@p${i}:${DOMAIN}`)
const MARKER = 'io.tayet.conversation'

interface FakeMember {
  userId: string
  membership: string
  rawDisplayName: string
  powerLevel: number
  getMxcAvatarUrl: () => null
}
const member = (userId: string, membership = 'join'): FakeMember => ({
  userId,
  membership,
  rawDisplayName: userId.slice(1, userId.indexOf(':')),
  powerLevel: 0,
  getMxcAvatarUrl: () => null,
})

interface RoomOpts {
  roomId: string
  alias?: string
  marker?: unknown
  members?: FakeMember[]
  createdAt?: number
  myMembership?: string
  orgState?: Record<string, Record<string, unknown>>
  canSend?: boolean
}

function fakeRoom(opts: RoomOpts): unknown {
  const members = opts.members ?? []
  const ev = (key: string, content: unknown, ts = 0) => ({ getStateKey: () => key, getContent: () => content, getTs: () => ts })
  return {
    roomId: opts.roomId,
    myUserId: ME,
    getMyMembership: () => opts.myMembership ?? 'join',
    getCanonicalAlias: () => opts.alias ?? null,
    getMember: (id: string) => members.find((m) => m.userId === id) ?? null,
    getMembers: () => members,
    currentState: {
      getStateEvents: (type: string, key?: string) => {
        if (type === 'io.tayet.member') {
          const state = opts.orgState ?? {}
          if (key === undefined) return Object.entries(state).map(([k, c]) => ev(k, c))
          return state[key] ? ev(key, state[key]) : null
        }
        if (key === undefined) return []
        if (type === MARKER && opts.marker !== undefined) return ev('', opts.marker)
        if (type === 'm.room.create') return ev('', {}, opts.createdAt ?? 0)
        return null
      },
      maySendStateEvent: () => opts.canSend ?? true,
    },
  }
}

const agentEvent = (operator: string) => ({ kind: 'agent', name: 'Agente', operator, color: 'ardosia' })
const ORG_STATE: Record<string, Record<string, unknown>> = {
  [MINE.slice(1)]: agentEvent('u-operadorxyz2'),
  [THEIRS.slice(1)]: agentEvent('u-outraoperad2'),
  [ME.slice(1)]: { kind: 'member', name: 'Rae' },
  [GUEST.slice(1)]: { kind: 'guest', name: 'Convidada' },
  ...Object.fromEntries(P.map((p) => [p.slice(1), { kind: 'member', name: p }])),
}
const org = () => fakeRoom({ roomId: ORG, alias: `#all:${DOMAIN}`, orgState: ORG_STATE, members: [member(ME)] })

const group = (roomId: string, others: string[], extra: Partial<RoomOpts> = {}) =>
  fakeRoom({
    roomId,
    marker: { kind: 'group' },
    members: [member(ME), member(CUSTODY), member(SYSTEM), ...others.map((u) => member(u))],
    ...extra,
  })

function harness(rooms: unknown[] = []) {
  const all = [org(), ...rooms]
  const writes: string[] = []
  let n = 0
  const createRoom = vi.fn(async (_opts: Record<string, unknown>) => {
    writes.push('createRoom')
    n += 1
    return { room_id: `!new${n}:${DOMAIN}` }
  })
  const client = {
    getUserId: () => ME,
    getRooms: () => all,
    getRoom: (id: string) => all.find((r) => (r as { roomId: string }).roomId === id) ?? null,
    getAccountData: () => undefined,
    setAccountData: vi.fn(async () => ({})),
    createRoom,
    // The ACL invites by a direct call (ADR-057, addendum of 24/Nov/2026).
    http: directInviteHttp(async () => {
      writes.push('invite')
      return {}
    }),
    kick: vi.fn(async () => {
      writes.push('kick')
      return {}
    }),
    setPowerLevel: vi.fn(async () => {
      writes.push('setPowerLevel')
      return {}
    }),
    setRoomName: vi.fn(async () => {
      writes.push('setRoomName')
      return {}
    }),
    setRoomTopic: vi.fn(async () => {
      writes.push('setRoomTopic')
      return {}
    }),
    sendStateEvent: vi.fn(async (_room: string, type: string, content: unknown) => {
      writes.push(`state:${type}:${JSON.stringify(content)}`)
      return {}
    }),
  }
  const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
  ;(gateway as unknown as { client: unknown }).client = client
  // The structural recipient (ADR-057) is infra; stub it so the writes are about the verb.
  ;(gateway as unknown as { inviteCustodian: () => Promise<void> }).inviteCustodian = async () => {}
  return { gateway, client, writes, rooms: all }
}

const ids = (...raw: string[]): UserId[] => raw.map((u) => brandUserId(u))

describe('openGroupConversation — refusals before any write (ADR-094 dec. 7)', () => {
  const cases: [string, string[]][] = [
    ['the session itself', [P[0]!, ME]],
    ['a repeated id', [P[0]!, P[1]!, P[0]!]],
    ['a single other', [P[0]!]],
    ['none', []],
    ['more than 8 others', P.slice(0, 9)],
    ["another operator's agent", [P[0]!, THEIRS]],
  ]
  for (const [label, users] of cases) {
    it(`${label} → rejects, no createRoom, neutral message`, async () => {
      const { gateway, writes } = harness()
      const err = (await gateway.openGroupConversation(ids(...users)).catch((e: unknown) => e)) as Error
      expect(err).toBeInstanceOf(Error)
      expect(err.message).not.toContain('@')
      expect(err.message).not.toContain(DOMAIN)
      expect(writes).toEqual([])
    })
  }

  it('GROUP_MAX_OTHERS is the limit the verb applies', async () => {
    expect(GROUP_MAX_OTHERS).toBe(8)
    const { gateway, client } = harness()
    await gateway.openGroupConversation(ids(...P.slice(0, GROUP_MAX_OTHERS)))
    expect(client.createRoom).toHaveBeenCalledTimes(1)
  })
})

describe('openGroupConversation — the own agent (ADR-094 dec. 7, ADR-090 dec. 1)', () => {
  it('7 people + my agent passes; 8 people + my agent refuses', async () => {
    const { gateway, client } = harness()
    await gateway.openGroupConversation(ids(...P.slice(0, 7), MINE))
    expect(client.createRoom).toHaveBeenCalledTimes(1)
    await expect(gateway.openGroupConversation(ids(...P.slice(0, 8), MINE))).rejects.toThrow()
    expect(client.createRoom).toHaveBeenCalledTimes(1)
  })
})

describe('openGroupConversation — the createRoom body (ADR-094 dec. 6)', () => {
  it('private preset, no name, invites, encryption + marker, users map 100 / 50 without guest nor agent', async () => {
    const { gateway, client } = harness()
    const id = await gateway.openGroupConversation(ids(P[0]!, P[1]!, GUEST, MINE))
    expect(String(id)).toBe(`!new1:${DOMAIN}`)
    const body = client.createRoom.mock.calls[0]![0]
    expect(body['preset']).toBe('private_chat')
    expect('name' in body).toBe(false)
    expect('is_direct' in body).toBe(false)
    expect(body['invite']).toEqual([P[0], P[1], GUEST, MINE])
    const state = body['initial_state'] as { type: string; state_key: string; content: Record<string, unknown> }[]
    expect(state).toContainEqual({ type: MARKER, state_key: '', content: { kind: 'group' } })
    expect(state.find((e) => e.type === 'm.room.encryption')?.content['algorithm']).toBe('m.megolm.v1.aes-sha2')
    expect(body['power_level_content_override']).toEqual({ users: { [ME]: 100, [P[0]!]: 50, [P[1]!]: 50 } })
  })
})

describe('openGroupConversation — idempotency by the exact set (ADR-094 dec. 8)', () => {
  it('same set in another order → same id, no new createRoom (memo, room still unknown to the store)', async () => {
    const { gateway, client } = harness()
    const a = await gateway.openGroupConversation(ids(P[0]!, P[1]!))
    const b = await gateway.openGroupConversation(ids(P[1]!, P[0]!))
    expect(b).toBe(a)
    expect(client.createRoom).toHaveBeenCalledTimes(1)
  })

  it('cold path: finds the existing group (invite counts as a participant)', async () => {
    const existing = fakeRoom({
      roomId: `!g:${DOMAIN}`,
      marker: { kind: 'group' },
      members: [member(ME), member(CUSTODY), member(P[0]!), member(P[1]!, 'invite')],
    })
    const { gateway, client } = harness([existing])
    expect(String(await gateway.openGroupConversation(ids(P[1]!, P[0]!)))).toBe(`!g:${DOMAIN}`)
    expect(client.createRoom).not.toHaveBeenCalled()
  })

  it('a set different in one person creates another', async () => {
    const { gateway, client } = harness([group(`!g:${DOMAIN}`, [P[0]!, P[1]!])])
    expect(String(await gateway.openGroupConversation(ids(P[0]!, P[2]!)))).toBe(`!new1:${DOMAIN}`)
    expect(String(await gateway.openGroupConversation(ids(P[0]!, P[1]!, P[2]!)))).toBe(`!new2:${DOMAIN}`)
    expect(client.createRoom).toHaveBeenCalledTimes(2)
  })

  it('whoever left undoes the match — cold path and memo alike', async () => {
    const left = fakeRoom({
      roomId: `!g:${DOMAIN}`,
      marker: { kind: 'group' },
      members: [member(ME), member(P[0]!), member(P[1]!, 'leave')],
    })
    const { gateway, client, rooms } = harness([left])
    expect(String(await gateway.openGroupConversation(ids(P[0]!, P[1]!)))).toBe(`!new1:${DOMAIN}`)
    // The memo's room lands in the store; then someone leaves it: the entry drops and a new one is made.
    rooms.push(fakeRoom({ roomId: `!new1:${DOMAIN}`, marker: { kind: 'group' }, members: [member(ME), member(P[0]!), member(P[1]!, 'leave')] }))
    expect(String(await gateway.openGroupConversation(ids(P[0]!, P[1]!)))).toBe(`!new2:${DOMAIN}`)
    expect(client.createRoom).toHaveBeenCalledTimes(2)
  })

  it('a room the session is not in, or that is no longer a group, does not match', async () => {
    const { gateway, client } = harness([
      group(`!left:${DOMAIN}`, [P[0]!, P[1]!], { myMembership: 'leave' }),
      group(`!conv:${DOMAIN}`, [P[0]!, P[1]!], { marker: { kind: 'channel' } }),
    ])
    expect(String(await gateway.openGroupConversation(ids(P[0]!, P[1]!)))).toBe(`!new1:${DOMAIN}`)
    expect(client.createRoom).toHaveBeenCalledTimes(1)
  })

  it('two matches: the oldest creation wins, then the raw id', async () => {
    const { gateway } = harness([
      group(`!b-newer:${DOMAIN}`, [P[0]!, P[1]!], { createdAt: 2000 }),
      group(`!z-older:${DOMAIN}`, [P[0]!, P[1]!], { createdAt: 1000 }),
      group(`!a-older:${DOMAIN}`, [P[0]!, P[1]!], { createdAt: 1000 }),
    ])
    expect(String(await gateway.openGroupConversation(ids(P[0]!, P[1]!)))).toBe(`!a-older:${DOMAIN}`)
  })
})

describe('convertToChannel (ADR-094 dec. 9)', () => {
  const G = `!g:${DOMAIN}`

  it('name first, marker second, trimmed name', async () => {
    const { gateway, writes } = harness([group(G, [P[0]!, P[1]!])])
    await gateway.convertToChannel(brandChannelId(G), '  projeto  ')
    expect(writes).toEqual(['setRoomName', `state:${MARKER}:{"kind":"channel"}`])
  })

  it('refusals before any write: not a group, empty name, no power', async () => {
    const channel = fakeRoom({ roomId: `!c:${DOMAIN}`, members: [member(ME), member(P[0]!)] })
    const { gateway, writes } = harness([channel, group(G, [P[0]!, P[1]!]), group(`!np:${DOMAIN}`, [P[0]!, P[1]!], { canSend: false })])
    await expect(gateway.convertToChannel(brandChannelId(`!c:${DOMAIN}`), 'x')).rejects.toThrow()
    await expect(gateway.convertToChannel(brandChannelId(`!unknown:${DOMAIN}`), 'x')).rejects.toThrow()
    await expect(gateway.convertToChannel(brandChannelId(G), '   ')).rejects.toThrow()
    await expect(gateway.convertToChannel(brandChannelId(`!np:${DOMAIN}`), 'x')).rejects.toThrow()
    expect(writes).toEqual([])
  })

  it('a failure on the marker propagates, the name already went', async () => {
    const { gateway, client, writes } = harness([group(G, [P[0]!, P[1]!])])
    const boom = new Error('marker refused')
    client.sendStateEvent.mockRejectedValueOnce(boom)
    await expect(gateway.convertToChannel(brandChannelId(G), 'projeto')).rejects.toBe(boom)
    expect(writes).toEqual(['setRoomName'])
  })

  it('drops the memo entry pointing at the room', async () => {
    const { gateway, client, rooms } = harness()
    const id = await gateway.openGroupConversation(ids(P[0]!, P[1]!))
    rooms.push(group(String(id), [P[0]!, P[1]!]))
    await gateway.convertToChannel(id, 'projeto')
    const memo = (gateway as unknown as { groupRoomBySet: Map<string, string> }).groupRoomBySet
    expect([...memo.values()]).not.toContain(String(id))
    expect(client.createRoom).toHaveBeenCalledTimes(1)
  })
})

describe('management verbs refuse in a group, work in a channel (ADR-094 dec. 7 and 13)', () => {
  const G = `!g:${DOMAIN}`
  const C = `!c:${DOMAIN}`
  const verbs: [string, (gw: MatrixGateway, room: string) => Promise<unknown>][] = [
    ['addMember', (gw, room) => gw.addMember(brandChannelId(room), brandUserId(P[2]!))],
    ['removeMember', (gw, room) => gw.removeMember(brandChannelId(room), brandUserId(P[0]!))],
    ['setRole', (gw, room) => gw.setRole(brandChannelId(room), brandUserId(P[0]!), 'admin')],
    ['updateChannel', (gw, room) => gw.updateChannel(brandChannelId(room), { name: 'x', topic: 'y' })],
    ['archiveChannel', (gw, room) => gw.archiveChannel(brandChannelId(room))],
  ]
  for (const [name, call] of verbs) {
    it(`${name}: group → rejects before any write; channel → writes`, async () => {
      const channel = fakeRoom({ roomId: C, members: [member(ME), member(P[0]!)] })
      const { gateway, writes } = harness([group(G, [P[0]!, P[1]!]), channel])
      const err = (await call(gateway, G).catch((e: unknown) => e)) as Error
      expect(err).toBeInstanceOf(Error)
      expect(err.message).not.toContain('@')
      expect(writes).toEqual([])
      await call(gateway, C)
      expect(writes.length).toBeGreaterThan(0)
    })
  }

  it('leaveChannel does not change: a group can be left', async () => {
    const { gateway, client } = harness([group(G, [P[0]!, P[1]!])])
    const leave = vi.fn(async () => ({}))
    const forget = vi.fn(async () => ({}))
    Object.assign(client, { leave, forget })
    await gateway.leaveChannel(brandChannelId(G))
    expect(leave).toHaveBeenCalledTimes(1)
  })
})
