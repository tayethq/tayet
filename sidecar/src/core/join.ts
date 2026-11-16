// Auto-join of the sidecar (PLANO-AGENTES §0.3.1 S1.1, row `join-queue.ts`; §0.3.5 adj. 9; §0.3.6
// adj. 10 — a direct invite is marked in m.direct before the join, and a boot backfills it): the
// custody agent's join queue (join-queue.ts, copied with one port added: `admission`) wired as in
// agent/src/main.ts, with nothing of custody. Policy (PLANO-AGENTES §0.3.10 items 1–2): the agent
// belongs to its operator, so ONLY the operator's invites are accepted. Any other — a channel or a
// DM, pending at boot or new — is refused by leaving the room (`invite-refused`, no retry); an
// unreadable inviter is refused too (fail-closed). Rooms the agent is already in are not revisited.
// A dead room (404) has its invite rejected so a restart does not re-pay the join budget on it.
//
// Logs: one JSON line per join outcome (`joined`, `join-dead`, `invite-refused` with its `reason`,
// and the queue's own rate-limit / error / stall signals). The room is named by its conversation token
// (`C…`/`D…`, api/ids.ts; §0.3.12 item 9) — never its protocol id, a room name, nor who invited (the
// operator's or anyone's mxid never reaches a log). The queue (a copy of the custody agent's) logs the
// raw `roomId`; the port's log turns it into `conversation` before the line is written.
import type { MatrixClient, Room } from 'matrix-js-sdk'
import { EventType } from 'matrix-js-sdk'
import { conversationToken } from '../api/ids'
import { joinTick, newJoinQueueState, type JoinOutcome, type JoinPorts, type JoinQueueState } from './join-queue'

// Classification of the SDK's error, as in the custody agent (agent/src/main.ts `classifyJoinError`):
// M_LIMIT_EXCEEDED carries retry_after_ms in MatrixError.data; 404 is the dead-room discriminator
// (A6: no local member `join` → the server treats the join as remote and it never completes on a
// single server; an unknown/purged room is equally unjoinable).
export function classifyJoinError(err: unknown): JoinOutcome {
  const e = err as {
    httpStatus?: unknown
    errcode?: unknown
    data?: { retry_after_ms?: unknown }
  }
  if (e.errcode === 'M_LIMIT_EXCEEDED') {
    const retry = e.data?.retry_after_ms
    return { kind: 'ratelimited', retryAfterMs: typeof retry === 'number' ? retry : null }
  }
  if (e.httpStatus === 404) return { kind: 'dead', message: String(err) }
  return { kind: 'error', message: String(err) }
}

// The queue's `room-dead` signal is the sidecar's `join-dead` (same line, the operator's name); its
// `roomId` becomes the conversation token (a DM by the agent's own m.direct, as the read side does).
export function joinLog(log: (line: Record<string, unknown>) => void, isDirect: (roomId: string) => boolean): JoinPorts['log'] {
  return (line) => {
    const { roomId, ...rest } = line
    const out = typeof roomId === 'string' ? { ...rest, conversation: conversationToken(roomId, isDirect(roomId)) } : rest
    log(out.evt === 'room-dead' ? { ...out, evt: 'join-dead' } : out)
  }
}

// ── m.direct (PLANO-AGENTES §0.3.6 adj. 10) ─────────────────────────────────────────────────────
// The agent's own DM map, as the client keeps it (matrix-client.ts `autoJoinInvite`/`addDirectRoom`):
// a direct invite is marked BEFORE the join, from the invite member event (after the join that event
// is replaced and the signal is gone). Read-union-write: re-read right before writing.
type DirectClient = Pick<MatrixClient, 'getUserId' | 'getAccountData' | 'setAccountData'>

function directMap(client: Pick<MatrixClient, 'getAccountData'>): Record<string, string[]> {
  const content = (client.getAccountData(EventType.Direct as never)?.getContent() ?? {})
  const out: Record<string, string[]> = {}
  for (const [user, rooms] of Object.entries(content)) {
    if (Array.isArray(rooms)) out[user] = rooms.filter((r): r is string => typeof r === 'string')
  }
  return out
}

export async function addDirectRooms(client: DirectClient, pairs: ReadonlyArray<{ user: string; roomId: string }>): Promise<void> {
  const content = directMap(client)
  let changed = false
  for (const { user, roomId } of pairs) {
    const list = content[user] ?? []
    if (!list.includes(roomId)) {
      content[user] = [...list, roomId]
      changed = true
    }
  }
  if (changed) await client.setAccountData(EventType.Direct as never, content as never)
}

// The inviter of a pending invite of this agent (the sender of its own `invite` member event), or
// undefined (no invite, or no readable sender).
export function inviterOf(room: Room, me: string): string | undefined {
  const invite = room.getMember(me)?.events.member
  if (invite?.getContent().membership !== 'invite') return undefined
  const sender = invite.getSender()
  return typeof sender === 'string' && sender !== '' ? sender : undefined
}

// The inviter of a pending direct invite of this agent, or undefined (not direct, or no invite).
export function directInviter(room: Room, me: string): string | undefined {
  const invite = room.getMember(me)?.events.member
  if (invite?.getContent().is_direct !== true) return undefined
  return inviterOf(room, me)
}

// Backfill at boot (adj. 10): rooms this agent joined before the join marked m.direct (S-b2) have no
// entry. Their direct flag survives in the `prev_content` of the agent's own member event (the invite
// it replaced); the peer is the one other person of the room (joined or invited), never the custody
// or system account. Ambiguous (no other person, or more than one) → left alone.
export async function backfillDirect(
  client: DirectClient & Pick<MatrixClient, 'getRooms'>,
  infra: ReadonlySet<string>,
  log: (line: Record<string, unknown>) => void,
): Promise<number> {
  const me = client.getUserId()
  if (me === null) return 0
  const known = new Set(Object.values(directMap(client)).flat())
  const pairs: Array<{ user: string; roomId: string }> = []
  for (const room of client.getRooms()) {
    if (room.getMyMembership() !== 'join' || known.has(room.roomId)) continue
    const own = room.currentState.getStateEvents(EventType.RoomMember, me)
    const prev = own?.getPrevContent() as { membership?: unknown; is_direct?: unknown } | undefined
    if (prev?.membership !== 'invite' || prev.is_direct !== true) continue
    const others = room
      .getMembers()
      .filter((m) => m.userId !== me && !infra.has(m.userId) && (m.membership === 'join' || m.membership === 'invite'))
    if (others.length !== 1) continue
    pairs.push({ user: (others[0] as { userId: string }).userId, roomId: room.roomId })
  }
  if (pairs.length > 0) {
    await addDirectRooms(client, pairs)
    log({ evt: 'direct-backfill', rooms: pairs.length })
  }
  return pairs.length
}

export function createJoinPorts(
  client: Pick<MatrixClient, 'getRooms' | 'getRoom' | 'joinRoom' | 'leave'> & DirectClient,
  log: (line: Record<string, unknown>) => void,
  // The operator's mxid, learned at boot (step 3b). Never logged.
  operator: string,
): JoinPorts {
  return {
    admission: {
      operator,
      inviter: (roomId) => {
        const room = client.getRoom(roomId)
        const me = client.getUserId()
        return room !== null && me !== null ? inviterOf(room, me) : undefined
      },
    },
    invitedRooms: () =>
      client
        .getRooms()
        .filter((room) => room.getMyMembership() === 'invite')
        .map((room) => room.roomId),
    async attemptJoin(roomId) {
      try {
        const room = client.getRoom(roomId)
        const me = client.getUserId()
        const inviter = room !== null && me !== null ? directInviter(room, me) : undefined
        if (inviter !== undefined) await addDirectRooms(client, [{ user: inviter, roomId }])
        await client.joinRoom(roomId)
        return { kind: 'joined' }
      } catch (err) {
        return classifyJoinError(err)
      }
    },
    rejectInvite: async (roomId) => {
      await client.leave(roomId)
    },
    myMembership: (roomId) => client.getRoom(roomId)?.getMyMembership() ?? null,
    log: joinLog(log, (roomId) => Object.values(directMap(client)).some((rooms) => rooms.includes(roomId))),
    now: () => Date.now(),
  }
}

// The tick of the custody agent's loop, join part only: guarded by `ticking` (one tick at a time),
// skipped while the sync is down (#248: a join with the sync stopped is the loop — /join answers 200
// and the SDK never sees the transition), one `join-skipped-sync` signal per outage.
export interface JoinLoop {
  tick(): Promise<void>
  // Every change of this agent's membership (RoomEvent.MyMembership), synchronously: a refused room
  // that is no longer `invite` leaves the refused set at once, so a later invite in it (the operator's,
  // after the leave) is judged again even when no tick ran in between (measured on the stack:
  // invite → leave → invite between two ticks).
  observe(roomId: string, membership: string): void
  state: JoinQueueState
}

export function createJoinLoop(
  ports: JoinPorts,
  health: () => { healthy: boolean; state: string | null },
): JoinLoop {
  const state = newJoinQueueState()
  let ticking = false
  let skipLogged = false
  return {
    state,
    observe(roomId, membership) {
      if (membership !== 'invite') state.refused.delete(roomId)
    },
    async tick() {
      if (ticking) return
      ticking = true
      try {
        const h = health()
        if (h.healthy) {
          skipLogged = false
          await joinTick(ports, state)
        } else if (!skipLogged) {
          skipLogged = true
          ports.log({ evt: 'join-skipped-sync', state: h.state })
        }
      } catch (err) {
        ports.log({ evt: 'tick-error', message: String(err) })
      } finally {
        ticking = false
      }
    },
  }
}
