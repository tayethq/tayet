import { describe, it, expect } from 'vitest'
import { addDirectRooms, backfillDirect, classifyJoinError, createJoinLoop, createJoinPorts, joinLog } from '../../src/core/join'
import { conversationToken } from '../../src/api/ids'
import { findProtocolLeaks, ID_SHAPE_PATTERNS } from '@tayet/shared/leak-scan'

// The auto-join wiring (core/join.ts): the custody agent's classification, only the operator's
// invites accepted (PLANO-AGENTES §0.3.10 item 2), 404 → reject the invite, `join-dead` in the
// operator log, no join while the sync is down.

const OPERATOR = '@operator:x'
// The join lines name the conversation by its token (§0.3.12 item 9); these rooms are not DMs.
const conv = (roomId: string): string => conversationToken(roomId, false)

interface FakeRoom {
  roomId: string
  membership: string
  // The sender of the agent's own `invite` member event (default: the operator); null = unreadable.
  inviter?: string | null
  direct?: boolean
}

function fakeClient(rooms: FakeRoom[], joinError?: Error) {
  const joined: string[] = []
  const left: string[] = []
  const inviteEvent = (r: FakeRoom) =>
    r.membership !== 'invite'
      ? null
      : {
          events: {
            member: {
              getContent: () => ({ membership: 'invite', ...(r.direct === true ? { is_direct: true } : {}) }),
              getSender: () => (r.inviter === null ? undefined : (r.inviter ?? OPERATOR)),
            },
          },
        }
  const client = {
    getRooms: () => rooms.map((r) => ({ roomId: r.roomId, getMyMembership: () => r.membership })),
    getRoom: (id: string) => {
      const r = rooms.find((x) => x.roomId === id)
      return r === undefined ? null : { getMyMembership: () => r.membership, getMember: () => inviteEvent(r) }
    },
    getUserId: () => '@a-abcdefghijkl:x',
    getAccountData: () => undefined,
    setAccountData: () => Promise.resolve({}),
    joinRoom: (id: string) => {
      if (joinError !== undefined) return Promise.reject(joinError)
      joined.push(id)
      return Promise.resolve({})
    },
    leave: (id: string) => {
      left.push(id)
      // The server's answer: the agent is out of the room (what the next sync shows).
      const r = rooms.find((x) => x.roomId === id)
      if (r !== undefined) r.membership = 'leave'
      return Promise.resolve({})
    },
  }
  return { client: client as unknown as Parameters<typeof createJoinPorts>[0], joined, left }
}

const ports = (f: ReturnType<typeof fakeClient>, logs: Array<Record<string, unknown>>) =>
  createJoinPorts(f.client, (l) => logs.push(l), OPERATOR)
const healthy = () => ({ healthy: true, state: 'SYNCING' })

const notFound = Object.assign(new Error('M_UNKNOWN: no servers'), { httpStatus: 404, errcode: 'M_UNKNOWN' })

describe('classifyJoinError (copy of the custody agent wiring)', () => {
  it('429 with and without a hint, 404 dead, anything else an error', () => {
    expect(classifyJoinError({ errcode: 'M_LIMIT_EXCEEDED', data: { retry_after_ms: 1500 } })).toEqual({ kind: 'ratelimited', retryAfterMs: 1500 })
    expect(classifyJoinError({ errcode: 'M_LIMIT_EXCEEDED', data: {} })).toEqual({ kind: 'ratelimited', retryAfterMs: null })
    expect(classifyJoinError(notFound)).toMatchObject({ kind: 'dead' })
    expect(classifyJoinError(new Error('boom'))).toMatchObject({ kind: 'error' })
  })
})

describe('auto-join loop', () => {
  it("accepts the operator's invites (and only invites)", async () => {
    const f = fakeClient([
      { roomId: '!a:x', membership: 'invite' },
      { roomId: '!b:x', membership: 'join' },
      { roomId: '!c:x', membership: 'invite' },
    ])
    const logs: Array<Record<string, unknown>> = []
    const loop = createJoinLoop(createJoinPorts(f.client, (l) => logs.push(l), OPERATOR), () => ({ healthy: true, state: 'SYNCING' }))
    await loop.tick()
    expect(f.joined).toEqual(['!a:x', '!c:x'])
    expect(logs.filter((l) => l.evt === 'joined')).toEqual([
      { evt: 'joined', conversation: conv('!a:x') },
      { evt: 'joined', conversation: conv('!c:x') },
    ])
  })

  it('404 → join-dead and the invite rejected', async () => {
    const f = fakeClient([{ roomId: '!dead:x', membership: 'invite' }], notFound)
    const logs: Array<Record<string, unknown>> = []
    const loop = createJoinLoop(createJoinPorts(f.client, (l) => logs.push(l), OPERATOR), () => ({ healthy: true, state: 'SYNCING' }))
    await loop.tick()
    expect(f.left).toEqual(['!dead:x'])
    expect(logs.map((l) => l.evt)).toEqual(['join-dead', 'invite-rejected'])
    expect(logs[0]).toMatchObject({ conversation: conv('!dead:x'), attempts: 1 })
    expect(loop.state.dead.has('!dead:x')).toBe(true)
  })

  it('no join while the sync is down; one signal per outage', async () => {
    const f = fakeClient([{ roomId: '!a:x', membership: 'invite' }])
    const logs: Array<Record<string, unknown>> = []
    let healthy = false
    const loop = createJoinLoop(createJoinPorts(f.client, (l) => logs.push(l), OPERATOR), () => ({ healthy, state: healthy ? 'SYNCING' : 'ERROR' }))
    await loop.tick()
    await loop.tick()
    expect(f.joined).toEqual([])
    expect(logs).toEqual([{ evt: 'join-skipped-sync', state: 'ERROR' }])
    healthy = true
    await loop.tick()
    expect(f.joined).toEqual(['!a:x'])
  })
})

// PLANO-AGENTES §0.3.10 item 2: the agent belongs to its operator.
describe('invites only from the operator', () => {
  it('another person → refused: leave, no join, `invite-refused` with no mxid', async () => {
    const f = fakeClient([
      { roomId: '!mine:x', membership: 'invite' },
      { roomId: '!theirs:x', membership: 'invite', inviter: '@bob:x' },
    ])
    const logs: Array<Record<string, unknown>> = []
    const loop = createJoinLoop(ports(f, logs), healthy)
    await loop.tick()
    expect(f.joined).toEqual(['!mine:x'])
    expect(f.left).toEqual(['!theirs:x'])
    expect(logs).toContainEqual({ evt: 'invite-refused', conversation: conv('!theirs:x'), reason: 'not-operator' })
    expect(JSON.stringify(logs)).not.toMatch(/@bob|@operator/)
  })

  it('an unreadable inviter → refused (fail-closed)', async () => {
    const f = fakeClient([{ roomId: '!who:x', membership: 'invite', inviter: null }])
    const logs: Array<Record<string, unknown>> = []
    await createJoinLoop(ports(f, logs), healthy).tick()
    expect(f.joined).toEqual([])
    expect(f.left).toEqual(['!who:x'])
    expect(logs).toEqual([{ evt: 'invite-refused', conversation: conv('!who:x'), reason: 'inviter-unknown' }])
  })

  it('a DM from someone who is not the operator → refused the same way, m.direct untouched', async () => {
    const f = fakeClient([{ roomId: '!dm:x', membership: 'invite', inviter: '@bob:x', direct: true }])
    let marked = false
    ;(f.client as unknown as { setAccountData: () => Promise<unknown> }).setAccountData = () => {
      marked = true
      return Promise.resolve({})
    }
    const logs: Array<Record<string, unknown>> = []
    await createJoinLoop(ports(f, logs), healthy).tick()
    expect(f.left).toEqual(['!dm:x'])
    expect(f.joined).toEqual([])
    expect(marked).toBe(false)
    expect(logs).toEqual([{ evt: 'invite-refused', conversation: conv('!dm:x'), reason: 'not-operator' }])
  })

  it('invites pending at boot go through the same filter on the first healthy tick', async () => {
    const f = fakeClient([
      { roomId: '!old-op:x', membership: 'invite' },
      { roomId: '!old-bob:x', membership: 'invite', inviter: '@bob:x' },
      { roomId: '!already:x', membership: 'join' },
    ])
    const logs: Array<Record<string, unknown>> = []
    let up = false
    const loop = createJoinLoop(ports(f, logs), () => ({ healthy: up, state: up ? 'SYNCING' : null }))
    await loop.tick()
    expect(f.joined).toEqual([])
    expect(f.left).toEqual([])
    up = true
    await loop.tick()
    expect(f.joined).toEqual(['!old-op:x'])
    expect(f.left).toEqual(['!old-bob:x'])
  })

  it('no retry for a refused invite, even when the leave fails; a later invite in that room is judged again', async () => {
    const rooms: FakeRoom[] = [{ roomId: '!r:x', membership: 'invite', inviter: '@bob:x' }]
    const f = fakeClient(rooms)
    let leaves = 0
    ;(f.client as unknown as { leave: () => Promise<unknown> }).leave = () => {
      leaves += 1
      return Promise.reject(new Error('M_LIMIT_EXCEEDED'))
    }
    const logs: Array<Record<string, unknown>> = []
    const loop = createJoinLoop(ports(f, logs), healthy)
    await loop.tick()
    await loop.tick()
    await loop.tick()
    expect(leaves).toBe(1)
    expect(f.joined).toEqual([])
    expect(logs.map((l) => l.evt)).toEqual(['invite-refused', 'invite-refuse-failed'])
    // The room leaves the `invite` state (the bob invite went away), then the operator invites.
    rooms[0]!.membership = 'leave'
    await loop.tick()
    rooms[0]!.membership = 'invite'
    rooms[0]!.inviter = OPERATOR
    await loop.tick()
    expect(f.joined).toEqual(['!r:x'])
  })
})

describe('invites only from the operator — the re-invite between two ticks', () => {
  it('invite → leave → invite with no tick in between: observe() lets the operator\'s re-invite through', async () => {
    const rooms: FakeRoom[] = [{ roomId: '!r:x', membership: 'invite', inviter: '@bob:x' }]
    const f = fakeClient(rooms)
    const logs: Array<Record<string, unknown>> = []
    const loop = createJoinLoop(ports(f, logs), healthy)
    await loop.tick()
    expect(f.left).toEqual(['!r:x'])
    // The sync delivers the leave and, before the next tick, alice's invite (measured on the stack).
    loop.observe('!r:x', 'leave')
    rooms[0]!.membership = 'invite'
    rooms[0]!.inviter = OPERATOR
    loop.observe('!r:x', 'invite')
    await loop.tick()
    expect(f.joined).toEqual(['!r:x'])
    expect(logs.filter((l) => l.evt === 'invite-refused')).toHaveLength(1)
  })

  it('observe(invite) on a refused room still pending keeps it refused (no retry)', async () => {
    const f = fakeClient([{ roomId: '!r:x', membership: 'invite', inviter: '@bob:x' }])
    ;(f.client as unknown as { leave: () => Promise<unknown> }).leave = () => Promise.reject(new Error('boom'))
    const logs: Array<Record<string, unknown>> = []
    const loop = createJoinLoop(ports(f, logs), healthy)
    await loop.tick()
    loop.observe('!r:x', 'invite')
    await loop.tick()
    expect(logs.filter((l) => l.evt === 'invite-refused')).toHaveLength(1)
    expect(f.joined).toEqual([])
  })
})

// §0.3.6 adj. 10: m.direct marked from the invite before the join, and backfilled at boot from the
// prev_content of the agent's own member event.
const ME = '@a-abcdefghijkl:x'
const INFRA = new Set(['@cofre:x', '@system:x'])

function directClient(initial: Record<string, string[]> = {}) {
  let content: Record<string, string[]> = initial
  const writes: Array<Record<string, string[]>> = []
  return {
    writes,
    get content() {
      return content
    },
    getUserId: () => ME,
    getAccountData: () => ({ getContent: () => content }),
    setAccountData: (_type: string, next: Record<string, string[]>) => {
      content = next
      writes.push(next)
      return Promise.resolve({})
    },
  }
}

describe('m.direct', () => {
  it('a direct invite is marked under its inviter before the join; a channel invite is not', async () => {
    const order: string[] = []
    const d = directClient()
    const invites: Record<string, { is_direct?: boolean; sender: string }> = {
      '!dm:x': { is_direct: true, sender: '@alice:x' },
      '!ch:x': { sender: '@alice:x' },
    }
    const client = {
      ...d,
      setAccountData: (t: string, c: Record<string, string[]>) => {
        order.push('mark')
        return d.setAccountData(t, c)
      },
      getRooms: () => Object.keys(invites).map((roomId) => ({ roomId, getMyMembership: () => 'invite' })),
      getRoom: (id: string) => ({
        getMyMembership: () => 'invite',
        getMember: (u: string) =>
          u === ME
            ? {
                events: {
                  member: {
                    getContent: () => ({ membership: 'invite', ...(invites[id]?.is_direct ? { is_direct: true } : {}) }),
                    getSender: () => invites[id]?.sender,
                  },
                },
              }
            : null,
      }),
      joinRoom: (id: string) => {
        order.push(`join ${id}`)
        return Promise.resolve({})
      },
      leave: () => Promise.resolve({}),
    }
    const loop = createJoinLoop(createJoinPorts(client as never, () => {}, '@alice:x'), () => ({ healthy: true, state: 'SYNCING' }))
    await loop.tick()
    expect(d.content).toEqual({ '@alice:x': ['!dm:x'] })
    expect(order.indexOf('mark')).toBeLessThan(order.indexOf('join !dm:x'))
    expect(order).toContain('join !ch:x')
  })

  it('read-union-write keeps the existing entries and writes nothing when already there', async () => {
    const d = directClient({ '@bob:x': ['!b:x'] })
    await addDirectRooms(d as never, [{ user: '@alice:x', roomId: '!a:x' }])
    expect(d.content).toEqual({ '@bob:x': ['!b:x'], '@alice:x': ['!a:x'] })
    await addDirectRooms(d as never, [{ user: '@alice:x', roomId: '!a:x' }])
    expect(d.writes).toHaveLength(1)
  })

  it('backfill: joined rooms with a direct invite in prev_content get the single other person', async () => {
    const room = (roomId: string, prev: Record<string, unknown> | undefined, members: Array<[string, string]>, mine = 'join') => ({
      roomId,
      getMyMembership: () => mine,
      currentState: { getStateEvents: () => (prev === undefined ? null : { getPrevContent: () => prev }) },
      getMembers: () => [[ME, 'join'], ...members].map(([userId, membership]) => ({ userId, membership })),
    })
    const d = directClient({ '@carol:x': ['!known:x'] })
    const logs: Array<Record<string, unknown>> = []
    const client = {
      ...d,
      getRooms: () => [
        room('!dm:x', { membership: 'invite', is_direct: true }, [['@alice:x', 'join'], ['@cofre:x', 'join']]),
        room('!ch:x', { membership: 'invite' }, [['@alice:x', 'join']]),
        room('!two:x', { membership: 'invite', is_direct: true }, [['@alice:x', 'join'], ['@bob:x', 'join']]),
        room('!known:x', { membership: 'invite', is_direct: true }, [['@carol:x', 'join']]),
        room('!none:x', undefined, [['@alice:x', 'join']]),
        room('!inv:x', { membership: 'invite', is_direct: true }, [['@dan:x', 'invite']]),
        room('!pending:x', { membership: 'invite', is_direct: true }, [['@erin:x', 'join']], 'invite'),
      ],
    }
    expect(await backfillDirect(client as never, INFRA, (l) => logs.push(l))).toBe(2)
    expect(d.content).toEqual({ '@carol:x': ['!known:x'], '@alice:x': ['!dm:x'], '@dan:x': ['!inv:x'] })
    expect(logs).toEqual([{ evt: 'direct-backfill', rooms: 2 }])
    expect(await backfillDirect(client as never, INFRA, () => {})).toBe(0)
  })
})

// PLANO-AGENTES §0.3.12 item 9: the queue's raw `roomId` never reaches the line.
describe('join log lines carry the conversation token', () => {
  it('roomId → conversation (C… or D… by m.direct); no room id in the line', () => {
    const logs: Array<Record<string, unknown>> = []
    const port = joinLog((l) => logs.push(l), (roomId) => roomId === '!dm:x')
    port({ evt: 'joined', roomId: '!a:x' })
    port({ evt: 'joined', roomId: '!dm:x' })
    port({ evt: 'room-dead', roomId: '!b:x', attempts: 1, message: 'm' })
    expect(logs).toEqual([
      { evt: 'joined', conversation: conversationToken('!a:x', false) },
      { evt: 'joined', conversation: conversationToken('!dm:x', true) },
      { evt: 'join-dead', conversation: conversationToken('!b:x', false), attempts: 1, message: 'm' },
    ])
    expect(String(logs[0]?.conversation)).toMatch(/^C/)
    expect(String(logs[1]?.conversation)).toMatch(/^D/)
    expect(JSON.stringify(logs)).not.toContain('!')
  })
})

// The declared exception of §0.3.12 item 9: `String(err)` is free text from the SDK or the server and
// may carry an id (here a room id in the error's URL). It stays as diagnostics (README, --debug note):
// the finding is in `message`, and nowhere else in the line.
describe('the declared exception: String(err) in `message`', () => {
  it('a join error whose text carries a room id leaks only through `message`', async () => {
    const err = new Error('POST /_matrix/client/v3/join/!room:x failed')
    const f = fakeClient([{ roomId: '!room:x', membership: 'invite' }], err)
    const logs: Array<Record<string, unknown>> = []
    await createJoinLoop(ports(f, logs), healthy).tick()
    const line = logs.find((l) => l.evt === 'join-error')
    expect(line).toMatchObject({ conversation: conv('!room:x'), message: String(err) })
    expect(findProtocolLeaks(line, new Set(), ID_SHAPE_PATTERNS).map((l) => l.path)).toEqual(['$.message'])
  })
})
