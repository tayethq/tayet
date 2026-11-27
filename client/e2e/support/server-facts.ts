import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerUser } from '../../test/support/escrow-harness'
import { createRoom, HOMESERVER, invite, mintToken } from '../../test/support/synapse'
import { killSessionsOrThrow, liftMessageRatelimit, mintAdminToken, PROBE_USER } from '../../test/support/synapse-admin'
import { mintOidcSession } from '../../test/support/mint-oidc'
import { ESCROW_URL } from '../../test/support/stack-env'

// Protocol facts of the browser E2E tier, asserted BY THE SERVER (ADR-060 D3): "is this conversation
// encrypted?" has no affordance in the UI by P1, so the tier asks Synapse through the admin API.
// Node only. Protocol ids (mxids, room ids, event types) live in THIS file and in what it returns —
// never in a DOM assertion or selector.
//
// The admin token is ephemeral and belongs to the fixed probe account, never to the user under test:
// minting a token for erin would mint a device of erin and fire her new-access banner (ADR-018).
// The privilege is the token's (ADR-054 dec. 5); each read mints one and kills the probe's sessions
// at the end — the probe has a token, not a client, so the kill touches nothing connected.

// server_name of the dev-stack (infra/dev-stack/synapse/homeserver.yaml).
const SERVER_NAME = 'tayet.local'
const ORG_CHANNEL_ALIAS = `#all:${SERVER_NAME}`

const mxid = (localpart: string): string => `@${localpart}:${SERVER_NAME}`
// For reads of the browser's crypto store (keyed by the protocol user id), never for the DOM.
export const protocolUserId = mxid

export interface RoomFacts {
  /** `m.room.encryption` present in the room state. */
  encrypted: boolean
  /** Event types of the most recent message events, newest first (`m.room.message`/`m.room.encrypted`). */
  lastMessageTypes: string[]
}

interface RawEvent {
  type: string
  state_key?: string
  content?: Record<string, unknown>
  origin_server_ts?: number
}

// GET by default; `write` turns it into a JSON write (the profile probe of mas-login.spec.ts).
async function admin<T>(token: string, path: string, write?: { method: 'PUT'; body: unknown }): Promise<T> {
  const res = await fetch(`${HOMESERVER}${path}`, {
    method: write?.method ?? 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(write ? { 'Content-Type': 'application/json' } : {}) },
    ...(write ? { body: JSON.stringify(write.body) } : {}),
  })
  if (!res.ok) throw new Error(`admin ${write?.method ?? 'GET'} ${path} -> ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

const MESSAGE_TYPES = new Set(['m.room.message', 'm.room.encrypted'])

async function roomFacts(token: string, roomId: string): Promise<RoomFacts & { lastTs: number }> {
  const r = encodeURIComponent(roomId)
  const { state } = await admin<{ state: RawEvent[] }>(token, `/_synapse/admin/v1/rooms/${r}/state`)
  const { chunk } = await admin<{ chunk: RawEvent[] }>(token, `/_synapse/admin/v1/rooms/${r}/messages?dir=b&limit=50`)
  const messages = chunk.filter((e) => MESSAGE_TYPES.has(e.type))
  return {
    encrypted: state.some((e) => e.type === 'm.room.encryption'),
    lastMessageTypes: messages.map((e) => e.type),
    lastTs: messages[0]?.origin_server_ts ?? 0,
  }
}

// Runs `read` with a fresh admin token of the probe account, then kills the probe's sessions (loud:
// a failed kill would leave admin sessions accumulating across runs).
async function withAdmin<T>(read: (token: string) => Promise<T>): Promise<T> {
  registerUser(PROBE_USER) // idempotent; the tier does not depend on the integration suite having run
  const token = mintAdminToken(PROBE_USER)
  try {
    return await read(token)
  } finally {
    killSessionsOrThrow(PROBE_USER)
  }
}

async function joinedRooms(token: string, localpart: string): Promise<string[]> {
  const { joined_rooms } = await admin<{ joined_rooms: string[] }>(
    token,
    `/_synapse/admin/v1/users/${encodeURIComponent(mxid(localpart))}/joined_rooms`,
  )
  return joined_rooms
}

async function canonicalAlias(token: string, roomId: string): Promise<string | undefined> {
  const { state } = await admin<{ state: RawEvent[] }>(token, `/_synapse/admin/v1/rooms/${encodeURIComponent(roomId)}/state`)
  const ev = state.find((e) => e.type === 'm.room.canonical_alias')
  return ev?.content?.['alias'] as string | undefined
}

// The DM between two users: a room both joined that is not the org channel. Locally the same pair
// may share more than one such room across runs; the one with the most recent message is the one
// this run wrote to.
export async function directMessageFacts(a: string, b: string): Promise<RoomFacts> {
  return withAdmin(async (token) => {
    const theirs = new Set(await joinedRooms(token, b))
    const shared = (await joinedRooms(token, a)).filter((id) => theirs.has(id))
    const candidates: Array<RoomFacts & { lastTs: number }> = []
    for (const roomId of shared) {
      if ((await canonicalAlias(token, roomId)) === ORG_CHANNEL_ALIAS) continue
      candidates.push(await roomFacts(token, roomId))
    }
    if (candidates.length === 0) throw new Error(`no conversation shared by ${a} and ${b} besides the org channel`)
    candidates.sort((x, y) => y.lastTs - x.lastTs)
    const { encrypted, lastMessageTypes } = candidates[0]!
    return { encrypted, lastMessageTypes }
  })
}

// The org channel (ADR-045: seeded by the dev-stack under the canonical alias).
export async function orgChannelFacts(): Promise<RoomFacts> {
  return withAdmin(async (token) => {
    const { room_id } = await admin<{ room_id: string }>(
      token,
      `/_matrix/client/v3/directory/room/${encodeURIComponent(ORG_CHANNEL_ALIAS)}`,
    )
    const { encrypted, lastMessageTypes } = await roomFacts(token, room_id)
    return { encrypted, lastMessageTypes }
  })
}

// The devices the server holds for a user right now (admin API), as opaque ids. Used by the device-list
// spec (§8.24) to say WHERE a stale device list breaks: compared with what the peer's crypto store holds.
export async function currentDeviceIds(localpart: string): Promise<string[]> {
  return withAdmin(async (token) => {
    const { devices } = await admin<{ devices: Array<{ device_id: string }> }>(
      token,
      `/_synapse/admin/v2/users/${encodeURIComponent(mxid(localpart))}/devices`,
    )
    return devices.map((d) => d.device_id)
  })
}

// The user's push subscriptions as the server holds them (admin API; ADR-117 dec. 6), reduced to what a spec compares:
// the app id and the endpoint the subscription points at. Never logged: the endpoint is the spec's own receiver.
export async function pushersOf(localpart: string): Promise<Array<{ appId: string; endpoint?: string }>> {
  return withAdmin(async (token) => {
    const { pushers } = await admin<{ pushers: Array<{ app_id: string; data?: { endpoint?: string } }> }>(
      token,
      `/_synapse/admin/v1/users/${encodeURIComponent(mxid(localpart))}/pushers`,
    )
    return pushers.map((p) => ({ appId: p.app_id, endpoint: p.data?.endpoint }))
  })
}

// Whether the server holds a cross-signing master key for the user: the first login's bootstrap landed.
export async function hasCrossSigningMaster(localpart: string): Promise<boolean> {
  return withAdmin(async (token) => {
    const res = await fetch(`${HOMESERVER}/_matrix/client/v3/keys/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_keys: { [mxid(localpart)]: [] } }),
    })
    if (!res.ok) throw new Error(`keys/query -> ${res.status} ${await res.text()}`)
    const { master_keys } = (await res.json()) as { master_keys?: Record<string, unknown> }
    return master_keys?.[mxid(localpart)] !== undefined
  })
}

// Every room two users share besides the org channel — locally, the DMs between them that earlier
// runs left behind. Used by a spec's beforeAll to delete them (test/support/room-admin.ts) so its run
// starts with no history (PLANO-RELEASE-PUBLICA §8.24). Ids stay in Node, never reach the DOM.
export async function sharedRoomsBesidesOrgChannel(a: string, b: string): Promise<string[]> {
  return withAdmin(async (token) => {
    const theirs = new Set(await joinedRooms(token, b))
    const out: string[] = []
    for (const roomId of (await joinedRooms(token, a)).filter((id) => theirs.has(id))) {
      if ((await canonicalAlias(token, roomId)) !== ORG_CHANNEL_ALIAS) out.push(roomId)
    }
    return out
  })
}

// The group conversations (ADR-094 dec. 2: the `io.tayet.conversation` marker with `kind: 'group'`) any of
// these people is joined to — the hermetic start and end of group-conversation.spec.ts, so a set of people
// is never matched to an earlier run's group (dec. 8). Room ids stay in the harness (deleteRoom).
export async function groupRoomsOf(...localparts: string[]): Promise<string[]> {
  return withAdmin(async (token) => {
    const rooms = new Set<string>()
    for (const who of localparts) for (const id of await joinedRooms(token, who)) rooms.add(id)
    const out: string[] = []
    for (const roomId of rooms) {
      const { state } = await admin<{ state: RawEvent[] }>(token, `/_synapse/admin/v1/rooms/${encodeURIComponent(roomId)}/state`)
      const marker = state.find((e) => e.type === 'io.tayet.conversation' && e.state_key === '')
      if (marker?.content?.kind === 'group') out.push(roomId)
    }
    return out
  })
}

// Rooms of the tier whose name starts with `prefix` (admin room list, `search_term`): the channels a spec
// names after itself, for its own cleanup. Room ids stay in the harness (deleteRoom), never in the DOM.
export async function roomsNamed(prefix: string): Promise<string[]> {
  return withAdmin(async (token) => {
    const { rooms } = await admin<{ rooms: Array<{ room_id: string; name: string | null }> }>(
      token,
      `/_synapse/admin/v1/rooms?search_term=${encodeURIComponent(prefix)}`,
    )
    return rooms.filter((r) => r.name?.startsWith(prefix)).map((r) => r.room_id)
  })
}

// A private channel the system account puts the pair in, standing in for the admin of ADR-083 P2/P3:
// lua has no room in common with anyone yet, so no person can reach her from the known set (ADR-029
// dec. 3). Invited by protocol id, whether the account exists or not. The system's token stays with
// the harness and its session dies with the stack's next sweep.
export async function placeInPrivateChannel(name: string, localparts: string[]): Promise<void> {
  const token = await mintToken('system')
  const roomId = await createRoom(token, { name })
  for (const localpart of localparts) await invite(token, roomId, mxid(localpart))
}

// Lifts the message rate limit of one user of the tier, for a scenario that sends more than the local
// rc_message burst lets through (a 429 would land in the console ledger). The account must exist (after
// its first login). Per user and persisted; the pair is the spec's own.
export async function liftSendLimit(localpart: string): Promise<void> {
  await withAdmin((token) => liftMessageRatelimit(token, mxid(localpart)))
}

export interface ChannelFacts {
  /** `m.room.encryption` present in the room state. */
  encrypted: boolean
  /** `join_rules` of the room (`public`, `invite`, …). */
  joinRule: string | undefined
  /** Membership by localpart (`join`, `invite`, `leave`, …), from the room's member events. */
  membership: Record<string, string>
  /** Power level by localpart: the explicit `users` entries of `m.room.power_levels`. */
  powerLevels: Record<string, number>
  /** `users_default` of `m.room.power_levels`. */
  usersDefault: number
}

const localpartOf = (userId: string): string => userId.replace(/^@/, '').split(':')[0]!

// A channel of the tier by its name (admin room list, `search_term`): exactly one room may match, or the
// read throws — a spec names its channels with the run's timestamp. Facts are keyed by localpart.
export async function channelFacts(name: string): Promise<ChannelFacts> {
  return withAdmin(async (token) => {
    const { rooms } = await admin<{ rooms: Array<{ room_id: string; name: string | null }> }>(
      token,
      `/_synapse/admin/v1/rooms?search_term=${encodeURIComponent(name)}`,
    )
    const matches = rooms.filter((r) => r.name === name)
    if (matches.length !== 1) throw new Error(`channel "${name}": ${matches.length} rooms match`)
    const { state } = await admin<{ state: RawEvent[] }>(
      token,
      `/_synapse/admin/v1/rooms/${encodeURIComponent(matches[0]!.room_id)}/state`,
    )
    const pl = state.find((e) => e.type === 'm.room.power_levels')?.content ?? {}
    const users = (pl['users'] ?? {}) as Record<string, number>
    return {
      encrypted: state.some((e) => e.type === 'm.room.encryption'),
      joinRule: state.find((e) => e.type === 'm.room.join_rules')?.content?.['join_rule'] as string | undefined,
      membership: Object.fromEntries(
        state
          .filter((e) => e.type === 'm.room.member' && e.state_key)
          .map((e) => [localpartOf(e.state_key!), String(e.content?.['membership'])]),
      ),
      powerLevels: Object.fromEntries(Object.entries(users).map(([id, level]) => [localpartOf(id), level])),
      usersDefault: Number(pl['users_default'] ?? 0),
    }
  })
}

export interface UploadedMedia {
  /** Content type the server stored (`application/octet-stream` for an encrypted attachment). */
  type: string
  /** Bytes stored. */
  size: number
  createdTs: number
}

// What a user uploaded (admin API), newest first, without the media ids.
export async function uploadedMedia(localpart: string): Promise<UploadedMedia[]> {
  return withAdmin(async (token) => {
    const { media } = await admin<{ media: Array<{ media_type: string; media_length: number; created_ts: number }> }>(
      token,
      `/_synapse/admin/v1/users/${encodeURIComponent(mxid(localpart))}/media?limit=100&order_by=created_ts&dir=b`,
    )
    return media.map((m) => ({ type: m.media_type, size: m.media_length, createdTs: m.created_ts }))
  })
}

const STATE_AFTER = 'org.matrix.msc4222.state_after'

// Whether the homeserver answers MSC4222's `state_after` in /sync (ADR-078): without it, a `limited`
// rejoin over a reused Room leaves the SDK with the state from the start of the timeline (#244). The
// /sync runs as the probe account, never as a user under test (a token for her is a new device, and the
// `finally` would kill her browser session). A fresh stack leaves the probe in no room, so it creates
// one; later reads reuse it. The filter carries a nonce, against a server that keeps identical /sync
// responses; the Synapse configs in this repository turn that cache off (`sync_response_cache_duration: 0`).
export async function syncCarriesStateAfter(): Promise<boolean> {
  return withAdmin(async (token) => {
    if ((await joinedRooms(token, PROBE_USER)).length === 0) await createRoom(token, { name: 'state-after-probe' })
    const filter = JSON.stringify({ room: { timeline: { limit: 1 } }, account_data: { types: [`nonce.${Date.now()}`] } })
    const { rooms } = await admin<{ rooms?: { join?: Record<string, Record<string, unknown>> } }>(
      token,
      `/_matrix/client/v3/sync?timeout=0&org.matrix.msc4222.use_state_after=true&filter=${encodeURIComponent(filter)}`,
    )
    return Object.values(rooms?.join ?? {}).some((room) => STATE_AFTER in room)
  })
}

export interface ProfileFacts {
  displayName: string | undefined
  /** The account has an avatar set (its content URI stays here). */
  hasAvatar: boolean
}

// A user's profile as the server holds it (admin API v2).
export async function profileFacts(localpart: string): Promise<ProfileFacts> {
  return withAdmin(async (token) => {
    const user = await admin<{ displayname?: string | null; avatar_url?: string | null }>(
      token,
      `/_synapse/admin/v2/users/${encodeURIComponent(mxid(localpart))}`,
    )
    return { displayName: user.displayname ?? undefined, hasAvatar: !!user.avatar_url }
  })
}

// Sets a user's display name on the server (admin API v2, PUT). Test-only probe of the MAS consent page
// (P4-2): `matrix_user.display_name` there is what the homeserver says, so the page is driven from here.
// An empty string is a valid value: the MAS hands it to the template as "" (falsy, like null).
export async function setDisplayName(localpart: string, value: string): Promise<void> {
  await withAdmin(async (token) => {
    await admin(token, `/_synapse/admin/v2/users/${encodeURIComponent(mxid(localpart))}`, {
      method: 'PUT',
      body: { displayname: value },
    })
  })
}

export interface DirectoryEntry {
  fullName: string
  jobTitle: string
  workEmail: string
}

const ORG_KEYS: Record<keyof DirectoryEntry, string> = {
  fullName: 'io.tayet.full_name',
  jobTitle: 'io.tayet.job_title',
  workEmail: 'io.tayet.work_email',
}

// A user's line of the dev-stack's directory: what the organization says about them (ADR-054).
export function directoryEntry(localpart: string): DirectoryEntry {
  const tsv = readFileSync(join(import.meta.dirname, '../../../infra/dev-stack/directory.tsv'), 'utf8')
  const fields = tsv.split('\n').find((line) => line.startsWith(`${localpart}\t`))?.split('\t')
  if (!fields) throw new Error(`${localpart} is not in directory.tsv`)
  return { fullName: fields[1]!, jobTitle: fields[2]!, workEmail: fields[3]! }
}

// The harness's own stand-in for the `up` writer of production (ADR-054 dec. 5), which skips an account
// born after it ran: same route (client-API, never the admin API, which drops custom fields), same keys,
// an ephemeral admin token. PUT with an entry, DELETE without one (absence declared).
export async function syncOrgFields(localpart: string, entry: DirectoryEntry | undefined): Promise<void> {
  await withAdmin(async (token) => {
    for (const [field, key] of Object.entries(ORG_KEYS) as Array<[keyof DirectoryEntry, string]>) {
      const res = await fetch(`${HOMESERVER}/_matrix/client/v3/profile/${encodeURIComponent(mxid(localpart))}/${key}`, {
        method: entry ? 'PUT' : 'DELETE',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(entry && { body: JSON.stringify({ [key]: entry[field] }) }),
      })
      if (!res.ok && (entry || (res.status !== 404 && res.status !== 405))) {
        throw new Error(`${entry ? 'PUT' : 'DELETE'} ${key} of ${localpart} -> ${res.status} ${await res.text()}`)
      }
    }
  })
}

// ADR-086 (agents.spec.ts): what the agent's process would do with the credential shown once — the
// spec plays the agent with the token the UI displayed, never with an admin privilege. `whoami` says
// whether a credential still works (401 after a reissue); `join` puts the agent in a room of the pair
// (an agent only enters a conversation it is added to or joins; it is never in the org channel).
export async function agentCredentialWorks(token: string): Promise<boolean> {
  const res = await fetch(`${HOMESERVER}/_matrix/client/v3/account/whoami`, { headers: { Authorization: `Bearer ${token}` } })
  return res.ok
}

export async function agentJoins(token: string, roomId: string): Promise<void> {
  const res = await fetch(`${HOMESERVER}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: '{}',
  })
  if (!res.ok) throw new Error(`agent join -> ${res.status} ${await res.text()}`)
}

// The agent's edits in a channel of the tier (A3-3b): the events of an agent account (`a-` localpart)
// that replace another event, read by the relation type, which stays in the clear on an encrypted event.
// The approval card's seal and the agent's close are such edits; the count and the distinct targets go
// out, never an id.
export async function agentEditsIn(name: string): Promise<{ edits: number; targets: number }> {
  return withAdmin(async (token) => {
    const { rooms } = await admin<{ rooms: Array<{ room_id: string; name: string | null }> }>(
      token,
      `/_synapse/admin/v1/rooms?search_term=${encodeURIComponent(name)}`,
    )
    const matches = rooms.filter((r) => r.name === name)
    if (matches.length !== 1) throw new Error(`channel "${name}": ${matches.length} rooms match`)
    const { chunk } = await admin<{ chunk: Array<RawEvent & { sender?: string }> }>(
      token,
      `/_synapse/admin/v1/rooms/${encodeURIComponent(matches[0]!.room_id)}/messages?dir=b&limit=100`,
    )
    const edits = chunk.filter((e) => {
      const rel = e.content?.['m.relates_to'] as { rel_type?: string } | undefined
      return e.sender !== undefined && localpartOf(e.sender).startsWith('a-') && rel?.rel_type === 'm.replace'
    })
    const targets = new Set(edits.map((e) => (e.content?.['m.relates_to'] as { event_id?: string }).event_id))
    return { edits: edits.length, targets: targets.size }
  })
}

// What the server counted as unread for `person` in their DM with `peer` (issue #7: the notifications.spec
// title once read 3 after 2 messages). Shaped like the acl-approval probe (#402): only shapes leave —
// the event type, whose it is (the person, the peer, someone else), the membership of a membership event
// and whose membership it is,
// the order and whether the server already holds it as read. Never an id, token or body.
//
// It needs the person's own token: /notifications and the unread count of /sync answer only for the
// caller. The mint makes a device of the person (ADR-018 would show a new-access banner), so this runs
// only on the failure path of a spec, and the minted session is logged out before returning.
type Whose = 'self' | 'peer' | 'other'
export type CountedShape = { type: string; sender: Whose; membership?: string; target?: Whose; read?: boolean }
export interface CountedFacts {
  /** `unread_notifications` of the DM in a fresh /sync of the person. */
  server: { notifications: number; highlights: number }
  /** What /notifications holds for the person in that DM, oldest first. */
  counted: CountedShape[]
  /** The DM's timeline as the server has it (admin read), oldest first. */
  timeline: CountedShape[]
}

export async function countedInDirectMessage(person: string, peer: string): Promise<CountedFacts> {
  const whose = (userId: string | undefined): Whose => (userId === mxid(person) ? 'self' : userId === mxid(peer) ? 'peer' : 'other')
  // A membership event also says whose membership it is (the state key): an invite of the person
  // themself is the one default rule that notifies a membership event (`.m.rule.invite_for_me`).
  const shape = (e: RawEvent & { sender?: string }): CountedShape =>
    e.type === 'm.room.member'
      ? { type: e.type, sender: whose(e.sender), membership: String(e.content?.['membership'] ?? 'none'), target: whose(e.state_key) }
      : { type: e.type, sender: whose(e.sender) }
  const rooms = await sharedRoomsBesidesOrgChannel(person, peer)
  const { roomId, timeline } = await withAdmin(async (admin_) => {
    let best: { id: string; ts: number } | undefined
    for (const id of rooms) {
      const { lastTs } = await roomFacts(admin_, id)
      if (!best || lastTs > best.ts) best = { id, ts: lastTs }
    }
    if (!best) throw new Error(`no DM between ${person} and ${peer}`)
    const { chunk } = await admin<{ chunk: Array<RawEvent & { sender?: string }> }>(
      admin_,
      `/_synapse/admin/v1/rooms/${encodeURIComponent(best.id)}/messages?dir=f&limit=100`,
    )
    return { roomId: best.id, timeline: chunk.map(shape) }
  })
  const token = await mintToken(person)
  try {
    const auth = { headers: { Authorization: `Bearer ${token}` } }
    const counted: CountedShape[] = []
    let from: string | undefined
    for (;;) {
      const q = from === undefined ? '' : `&from=${encodeURIComponent(from)}`
      const res = await fetch(`${HOMESERVER}/_matrix/client/v3/notifications?limit=100${q}`, auth)
      if (!res.ok) throw new Error(`notifications -> ${res.status}`)
      const page = (await res.json()) as {
        notifications: Array<{ room_id: string; read: boolean; event: RawEvent & { sender?: string } }>
        next_token?: string
      }
      for (const n of page.notifications) if (n.room_id === roomId) counted.push({ ...shape(n.event), read: n.read })
      if (!page.next_token || page.notifications.length === 0) break
      from = page.next_token
    }
    counted.reverse() // /notifications is newest first
    // A nonce in the filter, against a server that keeps identical /sync responses; the Synapse configs in
    // this repository turn that cache off (`sync_response_cache_duration: 0`).
    const filter = JSON.stringify({
      room: { rooms: [roomId], timeline: { limit: 1, not_types: [`x.nonce.${Date.now()}`] }, state: { lazy_load_members: true } },
      presence: { types: [] },
      account_data: { types: [] },
    })
    const res = await fetch(`${HOMESERVER}/_matrix/client/v3/sync?timeout=0&filter=${encodeURIComponent(filter)}`, auth)
    if (!res.ok) throw new Error(`sync -> ${res.status}`)
    const sync = (await res.json()) as {
      rooms?: { join?: Record<string, { unread_notifications?: { notification_count?: number; highlight_count?: number } }> }
    }
    const u = sync.rooms?.join?.[roomId]?.unread_notifications ?? {}
    return { server: { notifications: u.notification_count ?? 0, highlights: u.highlight_count ?? 0 }, counted, timeline }
  } finally {
    await fetch(`${HOMESERVER}/_matrix/client/v3/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => undefined)
  }
}

// org-admin.spec.ts (PLANO-ADMIN slice 1c): puts the trio's admin role back as `up` leaves it — `admin` an admin,
// `members` not — through the org service's own verbs (ADR-118 dec. 5), with headless OIDC sessions minted only
// here, after the browsers are closed (a minted session of a signed-in person would be a new access on their
// screen). The admin role is given back first by whoever holds it now, so the last-admin lock never refuses the
// demotions. Two logins at most (the MAS login burst).
export async function restoreOrgAdmins(admin: { user: string; password: string }, members: Array<{ user: string; password: string }>): Promise<void> {
  const call = (token: string, method: 'PUT' | 'DELETE', who: string): Promise<Response> =>
    fetch(`${ESCROW_URL}/v1/people/${encodeURIComponent(mxid(who))}/admin`, {
      method,
      headers: { Authorization: `Bearer ${token}` },
    })
  const adminToken = (await mintOidcSession(admin.user, admin.password)).accessToken
  let given = (await call(adminToken, 'PUT', admin.user)).status === 200
  for (const m of members) {
    if (given) break
    const token = (await mintOidcSession(m.user, m.password)).accessToken
    given = (await call(token, 'PUT', admin.user)).status === 200
  }
  if (!given) throw new Error(`restoreOrgAdmins: nobody could give ${admin.user} the admin role back`)
  for (const m of members) {
    const status = (await call(adminToken, 'DELETE', m.user)).status
    if (status !== 200) throw new Error(`restoreOrgAdmins: demoting ${m.user} answered ${status}`)
  }
}
