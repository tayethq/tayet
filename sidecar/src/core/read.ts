// Read path of the sidecar core (ADR-087 decs. 4, 5(a); PLANO-AGENTES §0.3.6 adjs. 3, 7, 10, 12): the
// shared translator (@tayet/shared/internal) over a MINIMAL translation context, the projection to the
// local API's contract (api/contract.ts), the opaque ids (api/ids.ts) and their reverse lookups.
// Everything that leaves this module is tokenized: the API layer (src/api/**) never sees a protocol
// id, and imports neither the SDK nor the shared translator (lint, eslint.config.js).
//
// The minimal context (§0.3.6 relatório E) — what the client's gateway builds in `ctx()` minus what the
// sidecar cannot or need not know:
// - the agent is never in the organization channel (§0.1 item 4): `kindOf` is the reserved prefix
//   (agent) or `member` — a guest session's rule — and there is no `agentOf`;
// - no unread counts, no custody verdicts, no optimistic echo (`stableIdFor` absent: the real id);
// - DMs come from the agent's own `m.direct`, which the join marks (core/join.ts, adj. 10).
//
// Reverse lookups (adj. 3): conversations and people in memory, rebuilt from the sync on a miss; a
// message `ts` through an LRU fed by every message this module emits, then, on a miss, the server's
// timestamp→event lookup + the neighbours of the same millisecond + the hash suffix. Nothing persists.
import type { MatrixClient, MatrixEvent, Room } from 'matrix-js-sdk'
import { ClientEvent, Direction, EventType, MatrixEvent as SdkEvent, MatrixEventEvent, Method, RelationType, RoomEvent } from 'matrix-js-sdk'
import {
  aggregateReactions,
  cleanDisplayName,
  displayedEdit,
  editAppliesTo,
  editToMessage,
  eventToMessage,
  foldedKind,
  roomToChannel,
  type Ctx,
} from '@tayet/shared/internal'
import type { ApprovalOption, Message } from '@tayet/shared'
import {
  conversationToken,
  CONVERSATION_TOKEN,
  eventSuffix,
  botToken,
  fileToken,
  messageTs,
  parseBound,
  parseTs,
  PERSON_TOKEN,
  personToken,
  serverNameOf,
  workspaceToken,
} from '../api/ids'
import type {
  ApiConversation,
  ApiConversationList,
  ApiEvent,
  ApiFile,
  ApiMe,
  ApiMemberState,
  ApiMessage,
  ApiMessageCommand,
  ApiApproval,
  ApiMessageList,
  ApiPeopleList,
  ApiPerson,
  ApiRich,
} from '../api/contract'
import { AGENT_LOCALPART } from '../whoami'
import { CursorStore } from './cursors'

// ── Errors the API layer maps to its codes ───────────────────────────────────────────────────────
export class ReadError extends Error {
  constructor(readonly code: 'conversation_not_found' | 'user_not_found' | 'message_not_found' | 'invalid_cursor' | 'invalid_argument') {
    super(code)
    this.name = 'ReadError'
  }
}

export interface MessageQuery {
  limit?: number
  cursor?: string
  oldest?: string
  latest?: string
  inclusive?: boolean
  thread?: string
}

export interface PageQuery {
  limit?: number
  cursor?: string
}

export interface ReadFacade {
  me(): Promise<ApiMe>
  // The agent's `B…` bot id (Slack layer only, §0.3.12 item 1; no native route carries it).
  bot(): string
  conversations(q: PageQuery): ApiConversationList
  conversation(id: string): ApiConversation
  members(id: string, q: PageQuery): ApiPeopleList
  person(id: string): ApiPerson
  messages(id: string, q: MessageQuery): Promise<ApiMessageList>
  // One message row by its ts (PLANO-AGENTES §0.3.12 item 3): internal, no native route; the Slack layer's
  // conversations.replies reads the thread's root through it. An edit, a removed message or another
  // kind of event → ReadError('message_not_found').
  message(id: string, ts: string): Promise<ApiMessage>
  // Live events, already projected; one listener per bus. Returns the unsubscribe.
  subscribe(listener: (event: ApiEvent) => void): () => void
}

export const PAGE_DEFAULT = 100
export const PAGE_MAX = 200
const SERVER_PAGE = 50
const TS_LRU_MAX = 10_000
const FILE_MAX = 10_000

// The infrastructure accounts every encrypted room carries (ADR-057 dec. 2, ADR-083 dec. 5): never a
// member, never the peer of a DM. Derived from the agent's own server name, as the client does.
const CUSTODY_LOCALPART = 'cofre'
// Event types compared as plain strings (getType() is a string).
const T_CREATE: string = EventType.RoomCreate
const T_MESSAGE: string = EventType.RoomMessage
const T_REACTION: string = EventType.Reaction
const T_REDACTION: string = EventType.RoomRedaction
const T_MEMBER: string = EventType.RoomMember
const SYSTEM_LOCALPART = 'system'
const ORG_CHANNEL_LOCALPART = 'all'

type Log = (line: Record<string, unknown>) => void

export type ReadClient = Pick<
  MatrixClient,
  | 'getUserId'
  | 'getRooms'
  | 'getRoom'
  | 'getAccountData'
  | 'getProfileInfo'
  | 'decryptEventIfNeeded'
  | 'createMessagesRequest'
  | 'relations'
  | 'fetchRoomEvent'
  | 'timestampToEvent'
  | 'on'
  | 'off'
> & { http: Pick<MatrixClient['http'], 'authedRequest'> }

// ── m.direct (the DM map of the agent's own account) ─────────────────────────────────────────────
export function dmPeerByRoom(client: Pick<MatrixClient, 'getAccountData'>): Map<string, string> {
  const content = (client.getAccountData(EventType.Direct as never)?.getContent() ?? {})
  const out = new Map<string, string>()
  for (const [userId, rooms] of Object.entries(content)) {
    if (Array.isArray(rooms)) for (const id of rooms) if (typeof id === 'string' && !out.has(id)) out.set(id, userId)
  }
  return out
}

const localpartOf = (userId: string): string => userId.slice(1, userId.includes(':') ? userId.indexOf(':') : undefined)
export const isAgent = (userId: string): boolean => AGENT_LOCALPART.test(localpartOf(userId))

export function infraAccounts(me: string): Set<string> {
  const server = serverNameOf(me)
  return new Set([`@${CUSTODY_LOCALPART}:${server}`, `@${SYSTEM_LOCALPART}:${server}`])
}

export interface FileRef {
  uri: string
  encrypted?: unknown
  mimetype?: string
  // The file's name as the listing projected it (§0.3.7 item 8): the download's Content-Disposition.
  name?: string
}

// The minimal translation context (header).
export function sidecarCtx(client: ReadClient, room: Room | undefined, files: Map<string, FileRef>, log: Log): Ctx {
  const me = client.getUserId()
  const dm = dmPeerByRoom(client)
  const server = me !== null ? serverNameOf(me) : null
  return {
    mode: 'lenient',
    telemetry: { untranslated: ({ conceptKind }) => log({ evt: 'untranslated', conceptKind }) },
    isDm: (roomId) => dm.has(roomId),
    dmPeerOf: (roomId) => dm.get(roomId),
    myUserId: me,
    custodian: server !== null ? `@${CUSTODY_LOCALPART}:${server}` : null,
    systemAccount: server !== null ? `@${SYSTEM_LOCALPART}:${server}` : null,
    orgChannelAlias: server !== null ? `#${ORG_CHANNEL_LOCALPART}:${server}` : null,
    kindOf: (userId) => (isAgent(userId) ? 'agent' : 'member'),
    reactionsFor: room ? (realEventId) => aggregateReactions(room, realEventId, me) : undefined,
    threadFor: room ? (realEventId) => room.getThread(realEventId) ?? undefined : undefined,
    mediaRefFor: (uri, encrypted, mimetype) => {
      const id = fileToken(uri)
      if (!files.has(id)) {
        if (files.size >= FILE_MAX) files.delete(files.keys().next().value as string)
        files.set(id, { uri, encrypted, mimetype })
      }
      return id as never
    },
  }
}

// A person's name at the edge: the cleaned display name, or '' when there is none. The client's
// fallback (the localpart) is an id here — `u-…`/`a-…` would be withheld by the edge scan and fail a
// whole listing — and the `U…` token already identifies the person.
export function displayName(rawName: string | undefined, userId: string): string {
  const raw = (rawName ?? '').trim()
  if (raw === '' || raw === userId || /^@[^:]+:/.test(raw)) return ''
  return cleanDisplayName(raw, userId)
}

// The name of an author as the last event seen from them showed it (PLANO-AGENTES §0.3.12 item 8):
// `Message.authorAt.name`, kept per person while translating. "Last" = the newest event by its
// instant, whatever order the pages arrive in. It answers `person()` for someone who left every
// conversation the agent shares (the roster no longer names them).
export function createAuthorNames(): { note(userId: string, name: string | undefined, at: number): void; get(userId: string): string | undefined; people(): Iterable<string> } {
  const names = new Map<string, { name: string; at: number }>()
  return {
    note(userId, name, at) {
      if (name === undefined || name.trim() === '') return
      const seen = names.get(userId)
      if (seen === undefined || at >= seen.at) names.set(userId, { name, at })
    },
    get: (userId) => names.get(userId)?.name,
    people: () => names.keys(),
  }
}

// A person's name for `person()`: whoever is still in a conversation keeps the roster's name, as
// before; whoever left gets the name of their last event seen ('' without one, via displayName).
export function personNameOf(present: boolean, rosterName: string | undefined, departedName: string | undefined): string | undefined {
  return present ? rosterName : departedName
}

// ── Projection: domain Message → ApiMessage (no shape/status/blurhash/arrival, adj. 12) ───────────
export function projectBody(m: Message, content: Record<string, unknown>): Pick<ApiMessage, 'text' | 'rich' | 'files' | 'unavailable' | 'unsupported'> {
  const body = m.body
  switch (body.kind) {
    case 'text':
      return body.rich !== undefined ? { text: body.text, rich: body.rich as unknown as Record<string, unknown> } : { text: body.text }
    case 'image': {
      const info = (content.info ?? {}) as Record<string, unknown>
      const file: ApiFile = {
        id: body.media,
        name: typeof content.body === 'string' && content.body !== '' ? content.body : 'image',
        mimetype: typeof info.mimetype === 'string' ? info.mimetype : 'application/octet-stream',
        size: typeof info.size === 'number' ? info.size : 0,
        ...(body.width !== undefined && { width: body.width }),
        ...(body.height !== undefined && { height: body.height }),
      }
      return { text: '', files: [file] }
    }
    case 'file':
      return { text: '', files: [{ id: body.media, name: body.name, mimetype: body.mimetype, size: body.size }] }
    // ADR-091 (Proposto): the body of a card is its request as text; the formatted request and the
    // `approval` (options, and the state on the agent's own cards) are added by the read side (A3-3).
    case 'approval':
      return { text: body.text }
    case 'unsupported':
      return { text: '', unsupported: true }
    case 'unavailable':
      return { text: '', unavailable: true }
  }
}

// ── Small LRU (insertion order of a Map) ─────────────────────────────────────────────────────────
class Lru<V> {
  private readonly map = new Map<string, V>()
  constructor(private readonly max: number) {}
  get(key: string): V | undefined {
    const v = this.map.get(key)
    if (v !== undefined) {
      this.map.delete(key)
      this.map.set(key, v)
    }
    return v
  }
  set(key: string, value: V): void {
    this.map.delete(key)
    this.map.set(key, value)
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string)
  }
  has(key: string): boolean {
    return this.map.has(key)
  }
}

interface MessageCursor {
  kind: 'messages'
  roomId: string
  thread?: string
  from: string | null
  pending: ApiMessage[]
  exhausted: boolean
  oldest: bigint | null
  latest: bigint | null
  inclusive: boolean
}

interface OffsetCursor {
  kind: 'offset'
  scope: string
  offset: number
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return PAGE_DEFAULT
  if (!Number.isInteger(limit) || limit < 1) throw new ReadError('invalid_argument')
  return Math.min(limit, PAGE_MAX)
}

const tsKey = (ts: string): bigint => (parseTs(ts) as NonNullable<ReturnType<typeof parseTs>>).key

// ── ts ↔ event (adj. 3): LRU fed by every emitted message; on a miss, the server's timestamp→event
// lookup, then the neighbours of the same millisecond, checked against the hash suffix. ─────────────
export type TsClient = Pick<ReadClient, 'fetchRoomEvent' | 'timestampToEvent' | 'http'>

export interface TsIndex {
  // The ts of an event of a room (and remembers it); null for a local (pending) id.
  tsOf(roomId: string, eventId: string, originServerTs: number): string | null
  // The ts of a related event (thread root, reply/edit target, redacted message), or undefined.
  tsOfRelated(roomId: string, eventId: string, findLocal: (id: string) => MatrixEvent | undefined): Promise<string | undefined>
  // ts → event id, or ReadError('message_not_found').
  eventOf(roomId: string, ts: string): Promise<string>
}

type RawEvent = { event_id?: string; origin_server_ts?: number }

export function createTsIndex(client: TsClient, onCollision: (roomId: string) => void, max = TS_LRU_MAX): TsIndex {
  // `${roomId} ${ts}` → event id; `${roomId} ${eventId}` → ts.
  const tsToEvent = new Lru<string>(max)
  const eventToTs = new Lru<string>(max)

  const remember = (roomId: string, eventId: string, value: string): void => {
    const key = `${roomId} ${value}`
    const known = tsToEvent.get(key)
    if (known !== undefined && known !== eventId) {
      // P-S2 adj. 4: same ts, another event → metric; the first one keeps the ts.
      onCollision(roomId)
    } else if (known === undefined) {
      tsToEvent.set(key, eventId)
    }
    eventToTs.set(`${roomId} ${eventId}`, value)
  }

  const tsOf = (roomId: string, eventId: string, originServerTs: number): string | null => {
    if (!eventId.startsWith('$')) return null
    const value = messageTs(originServerTs, eventId)
    remember(roomId, eventId, value)
    return value
  }

  return {
    tsOf,
    async tsOfRelated(roomId, eventId, findLocal) {
      const cached = eventToTs.get(`${roomId} ${eventId}`)
      if (cached !== undefined) return cached
      const local = findLocal(eventId)
      if (local !== undefined) return tsOf(roomId, eventId, local.getTs()) ?? undefined
      try {
        const raw = await client.fetchRoomEvent(roomId, eventId)
        return typeof raw.origin_server_ts === 'number' ? (tsOf(roomId, eventId, raw.origin_server_ts) ?? undefined) : undefined
      } catch {
        return undefined
      }
    },
    async eventOf(roomId, value) {
      const parsed = parseTs(value)
      if (parsed === null) throw new ReadError('message_not_found')
      const cached = tsToEvent.get(`${roomId} ${value}`)
      if (cached !== undefined) return cached
      let candidate: { event_id: string; origin_server_ts: number }
      try {
        candidate = await client.timestampToEvent(roomId, parsed.ms, Direction.Forward)
      } catch {
        throw new ReadError('message_not_found')
      }
      if (candidate.origin_server_ts !== parsed.ms) throw new ReadError('message_not_found')
      if (eventSuffix(candidate.event_id) === parsed.suffix) {
        remember(roomId, candidate.event_id, value)
        return candidate.event_id
      }
      // Neighbours of the same millisecond, in timeline order (events_before comes newest first).
      const path = `/rooms/${encodeURIComponent(roomId)}/context/${encodeURIComponent(candidate.event_id)}`
      let context: { events_before?: RawEvent[]; events_after?: RawEvent[] }
      try {
        context = await client.http.authedRequest(Method.Get, path, { limit: '20' })
      } catch {
        throw new ReadError('message_not_found')
      }
      const ordered = [...(context.events_before ?? []).reverse(), ...(context.events_after ?? [])]
      const matches = ordered.filter(
        (e): e is { event_id: string; origin_server_ts: number } =>
          typeof e.event_id === 'string' && e.origin_server_ts === parsed.ms && eventSuffix(e.event_id) === parsed.suffix,
      )
      const first = matches[0]?.event_id
      if (first === undefined) throw new ReadError('message_not_found')
      if (matches.length > 1) onCollision(roomId)
      remember(roomId, first, value)
      return first
    },
  }
}

// What the write side (core/write.ts) shares with the read side: the same reverse lookups, ts index
// and file map, so a token the API handed out resolves the same way for a write. Raw ids inside the
// core only — never handed to src/api/**.
export interface Resolver {
  // A conversation token → its room, whatever the agent's membership (the write checks it); unknown
  // or of the other kind → ReadError('conversation_not_found').
  roomAnyOf(token: string): Room
  // A person token → the raw user id, or ReadError('user_not_found').
  userOf(token: string): string
  // ts → event id in the room, or ReadError('message_not_found').
  eventOf(room: Room, ts: string): Promise<string>
  // The ts of an event (remembered by the index).
  tsOf(roomId: string, eventId: string, originServerTs: number): string | null
  tsOfRelated(room: Room, eventId: string): Promise<string | undefined>
  tokenOfRoom(roomId: string): string
  tokenOfPerson(userId: string): string
  // A file token → its descriptor, or undefined (re-reading the listing registers it again).
  file(token: string): FileRef | undefined
  // Registers a file this agent just uploaded; returns its token.
  noteFile(ref: FileRef): string
}

export function createReadFacade(client: ReadClient, log: Log, opts: { now?: () => number } = {}): ReadFacade {
  return createReadSide(client, log, opts).facade
}

// ADR-091 (A3-3): the `approval` of a card the read side projects (core/approvals.ts) — bound once the
// approval core exists (it needs this side's resolver).
// `needed`: the number of answers the card declares (ADR-104), when it does.
export type ApprovalView = (roomId: string, eventId: string, options: readonly ApprovalOption[], own: boolean, needed?: number) => Promise<ApiApproval>

export interface ReadSide {
  facade: ReadFacade
  resolver: Resolver
  // An event of the core that is not read off the timeline (`approval.answered`): to the same listeners
  // (the API layer's edge and bus). Held until the first listener subscribes.
  announce: (event: ApiEvent) => void
  bindApprovals: (view: ApprovalView) => void
  // The set the agent declared (core/commands.ts `declares`). Unbound, no message carries a command.
  bindCommands: (declares: (name: string) => boolean) => void
  // Whether a message (read and decrypted) carries a command for this agent, by the rule of the listing.
  commandAt: (room: Room, ev: MatrixEvent) => boolean
}

// PLANO-AGENTES §0.3.23 items 1, 3, 5, 6: the command a message carries for this agent. The translator gave
// one (a person's message, the marker names an agent among the mentions, the text starts with "/name"); it
// names this agent; the message was never edited; and the name is in the set declared now. Another agent's
// command, or none, is a plain mention. A name outside the set logs `command-unknown`, never the name.
export function commandFor(m: Message, me: string, declares: ((name: string) => boolean) | undefined, log: Log): ApiMessageCommand | undefined {
  if (m.command === undefined || declares === undefined || m.body.kind !== 'text') return undefined
  if ((m.command.agent as unknown as string) !== me || m.editedAt !== undefined) return undefined
  const { name } = m.command
  if (!declares(name)) {
    log({ evt: 'command-unknown' })
    return undefined
  }
  return { name, args: m.body.text.slice(name.length + 1).trimStart() }
}

export function createReadSide(client: ReadClient, log: Log, opts: { now?: () => number } = {}): ReadSide {
  const files = new Map<string, FileRef>()
  const roomsByToken = new Map<string, string>()
  const peopleByToken = new Map<string, string>()
  const cursors = new CursorStore<MessageCursor | OffsetCursor>({ now: opts.now })
  const authorNames = createAuthorNames()
  let myName: string | null = null
  let approvalView: ApprovalView | undefined
  let declares: ((name: string) => boolean) | undefined

  const me = (): string => {
    const id = client.getUserId()
    if (id === null) throw new Error('no user id')
    return id
  }

  const joinedRooms = (): Room[] => client.getRooms().filter((r) => r.getMyMembership() === 'join')

  const rebuild = (): void => {
    const dm = dmPeerByRoom(client)
    roomsByToken.clear()
    peopleByToken.clear()
    peopleByToken.set(personToken(me()), me())
    for (const room of client.getRooms()) {
      roomsByToken.set(conversationToken(room.roomId, dm.has(room.roomId)), room.roomId)
      for (const member of room.getMembers()) peopleByToken.set(personToken(member.userId), member.userId)
    }
    // An author seen on a message keeps resolving after leaving (users.info of who left, §0.3.12 item 8).
    for (const userId of authorNames.people()) peopleByToken.set(personToken(userId), userId)
  }

  const tokenOfRoom = (roomId: string): string => {
    const token = conversationToken(roomId, dmPeerByRoom(client).has(roomId))
    roomsByToken.set(token, roomId)
    return token
  }
  const tokenOfPerson = (userId: string): string => {
    const token = personToken(userId)
    peopleByToken.set(token, userId)
    return token
  }

  const roomAnyOf = (token: string): Room => {
    if (!CONVERSATION_TOKEN.test(token)) throw new ReadError('conversation_not_found')
    if (!roomsByToken.has(token)) rebuild()
    const roomId = roomsByToken.get(token)
    const room = roomId !== undefined ? client.getRoom(roomId) : null
    if (room === null) throw new ReadError('conversation_not_found')
    // A conversation's kind decides its prefix: a token of the other kind is not this conversation.
    if (tokenOfRoom(room.roomId) !== token) throw new ReadError('conversation_not_found')
    return room
  }

  const roomOf = (token: string): Room => {
    const room = roomAnyOf(token)
    if (room.getMyMembership() !== 'join') throw new ReadError('conversation_not_found')
    return room
  }

  const userOf = (token: string): string => {
    if (!PERSON_TOKEN.test(token)) throw new ReadError('user_not_found')
    if (!peopleByToken.has(token)) rebuild()
    const userId = peopleByToken.get(token)
    if (userId === undefined) throw new ReadError('user_not_found')
    return userId
  }

  const tsIndex = createTsIndex(client, (roomId) => log({ evt: 'ts-collision', conversation: tokenOfRoom(roomId) }))
  const tsOfEvent = (roomId: string, ev: MatrixEvent): string | null => {
    const id = ev.getId()
    return id === undefined ? null : tsIndex.tsOf(roomId, id, ev.getTs())
  }
  const tsOfRelated = (room: Room, eventId: string): Promise<string | undefined> =>
    tsIndex.tsOfRelated(room.roomId, eventId, (id) => room.findEventById(id))
  const eventOfTs = (room: Room, value: string): Promise<string> => tsIndex.eventOf(room.roomId, value)

  const project = async (room: Room, m: Message, ts: string, content: Record<string, unknown>): Promise<ApiMessage> => {
    authorNames.note(m.author, m.authorAt?.name, parseTs(ts)?.ms ?? 0)
    const out: ApiMessage = {
      id: ts,
      conversation: tokenOfRoom(room.roomId),
      author: tokenOfPerson(m.author),
      ...projectBody(m, content),
      mentionsMe: m.mentionsMe,
      reactions: m.reactions.map((r) => ({ emoji: r.emoji, count: r.count, mine: r.mine })),
    }
    if (m.threadParent !== undefined) {
      const thread = await tsOfRelated(room, m.threadParent)
      if (thread !== undefined) out.thread = thread
    }
    if (m.replyTo !== undefined) {
      const replyTo = await tsOfRelated(room, m.replyTo)
      if (replyTo !== undefined) out.replyTo = replyTo
    }
    if (m.editedAt !== undefined) out.editedAt = m.editedAt
    const command = commandFor(m, me(), declares, log)
    if (command !== undefined) out.command = command
    // ADR-089 dec. 3: the people mentioned, as tokens (absent when the domain has none).
    if (m.mentions !== undefined && m.mentions.length > 0) out.mentions = m.mentions.map((u) => tokenOfPerson(u as unknown as string))
    // The download's name (§0.3.7 item 8): what this projection shows is what the header carries.
    for (const f of out.files ?? []) {
      const ref = files.get(f.id)
      if (ref !== undefined) ref.name = f.name
    }
    if (m.threadSummary !== undefined) {
      out.threadSummary = { replyCount: m.threadSummary.replyCount, latestReplyAt: m.threadSummary.latestReplyAt as unknown as number }
    }
    if (m.body.kind === 'approval') {
      // ADR-091 (A3-3): the request formatted, and the options; the state only on the agent's own card.
      if (m.body.request !== undefined) out.rich = m.body.request as unknown as ApiRich
      const options = m.body.options
      const own = (m.author as unknown as string) === me()
      const needed = m.body.state.kind === 'multi' ? m.body.state.needed : undefined
      out.approval = { options: options.map((o) => ({ id: o.id, label: o.label, ...(o.style !== undefined && { style: o.style }) })), ...(needed !== undefined && { needed }) }
      if (approvalView !== undefined) {
        try {
          out.approval = await approvalView(room.roomId, m.id, options, own, needed)
        } catch {
          // The state could not be read now: the options alone (the next read tries again).
          log({ evt: 'approval-state-unavailable' })
        }
      }
    }
    return out
  }

  // An event of a page/stream → ApiMessage, or null (not a message row).
  const messageOf = async (room: Room, ev: MatrixEvent, ctx: Ctx): Promise<ApiMessage | null> => {
    const m = eventToMessage(ev, ctx)
    if (m === null) return null
    const ts = tsOfEvent(room.roomId, ev)
    if (ts === null) return null
    // The displayed content: the projection reads the files off it, past an edit by someone else.
    return project(room, m, ts, displayedEdit(ev).content)
  }

  const settle = (events: MatrixEvent[]): Promise<unknown> =>
    Promise.all(events.map((ev) => client.decryptEventIfNeeded(ev).catch(() => undefined)))

  // One server page of a listing, newest first.
  const fetchPage = async (room: Room, cur: MessageCursor): Promise<void> => {
    const ctx = sidecarCtx(client, room, files, log)
    let events: MatrixEvent[]
    let next: string | null
    if (cur.thread !== undefined) {
      const res = await client.relations(room.roomId, cur.thread, RelationType.Thread, EventType.RoomMessage, {
        dir: Direction.Backward,
        from: cur.from ?? undefined,
        limit: SERVER_PAGE,
      })
      events = res.events // newest first
      next = res.nextBatch ?? null
    } else if (cur.from === null) {
      const timeline = room.getLiveTimeline()
      events = [...timeline.getEvents()].reverse()
      next = timeline.getPaginationToken(Direction.Backward)
    } else {
      const res = await client.createMessagesRequest(room.roomId, cur.from, SERVER_PAGE, Direction.Backward)
      events = res.chunk.map((raw) => new SdkEvent(raw))
      next = res.end ?? null
      // A raw event carries its latest edit bundled; the SDK applies it only inside a timeline.
      const replaced = events.flatMap((ev) => {
        const edit = ev.getServerAggregatedRelation<Record<string, unknown>>(RelationType.Replace)
        return edit ? [{ ev, edit: new SdkEvent(edit) }] : []
      })
      await settle([...events, ...replaced.map((r) => r.edit)])
      // Only the author's edit applies (PLANO-AGENTES §8.30), even if the server already filtered.
      for (const { ev, edit } of replaced) {
        if (!edit.isDecryptionFailure() && editAppliesTo(edit.getSender(), ev.getSender())) ev.makeReplaced(edit)
      }
    }
    await settle(events)
    const reachedStart = events.some((ev) => ev.getType() === T_CREATE)
    for (const ev of events) {
      // The main listing has neither edits (they replace their target) nor thread replies.
      if (ev.isRelation(RelationType.Replace)) continue
      const msg = await messageOf(room, ev, ctx)
      if (msg === null) continue
      if (cur.thread === undefined && msg.thread !== undefined) continue
      cur.pending.push(msg)
    }
    if (next === null || next === cur.from || reachedStart) cur.exhausted = true
    cur.from = next
  }

  const offsetPage = <T>(scope: string, all: T[], q: PageQuery): { items: T[]; next?: string } => {
    const limit = clampLimit(q.limit)
    let offset = 0
    if (q.cursor !== undefined) {
      const cur = cursors.take(q.cursor)
      if (cur === undefined || cur.kind !== 'offset' || cur.scope !== scope) throw new ReadError('invalid_cursor')
      offset = cur.offset
    }
    const items = all.slice(offset, offset + limit)
    const rest = offset + limit < all.length
    return rest ? { items, next: cursors.put({ kind: 'offset', scope, offset: offset + limit }) } : { items }
  }

  const conversationOf = (room: Room): ApiConversation => {
    const ctx = sidecarCtx(client, room, files, log)
    const channel = roomToChannel(room, ctx)
    const infra = infraAccounts(me())
    const out: ApiConversation = {
      id: tokenOfRoom(room.roomId),
      // The domain names a channel "#name" (a display convention of the client); the API carries the
      // bare name, as Slack's conversations do. A DM's and a group's name carry no '#' (ADR-094 dec. 4).
      name: channel.kind === 'dm' || channel.kind === 'group' ? channel.name : channel.name.replace(/^#/, ''),
      kind: channel.kind,
      memberCount: room.getJoinedMembers().filter((m) => !infra.has(m.userId)).length,
    }
    if (channel.topic !== undefined && channel.topic !== '') out.topic = channel.topic
    const peer = channel.peer as unknown as string | undefined
    if (peer !== undefined) out.peer = tokenOfPerson(peer)
    return out
  }

  const personOf = (userId: string, rawName: string | undefined): ApiPerson => ({
    id: tokenOfPerson(userId),
    name: displayName(rawName, userId),
    kind: isAgent(userId) ? 'agent' : 'member',
  })

  // Still in some conversation the agent shares (joined or invited), or the agent itself.
  const present = (userId: string): boolean =>
    userId === me() ||
    client.getRooms().some((room) => {
      const membership = room.getMember(userId)?.membership
      return membership === 'join' || membership === 'invite'
    })

  const nameOf = (userId: string): string | undefined => {
    for (const room of client.getRooms()) {
      const member = room.getMember(userId)
      if (member?.rawDisplayName && member.rawDisplayName !== userId) return member.rawDisplayName
    }
    return undefined
  }

  // ── Live events ────────────────────────────────────────────────────────────────────────────────
  const listeners = new Set<(event: ApiEvent) => void>()
  const held: ApiEvent[] = []
  const emit = (event: ApiEvent): void => {
    for (const l of listeners) l(event)
  }
  const announce = (event: ApiEvent): void => {
    if (listeners.size === 0) held.push(event)
    else emit(event)
  }
  let chain: Promise<void> = Promise.resolve()
  // Emission order = arrival order: each live event is handled after the previous one settled.
  const serial = (task: () => Promise<void>): void => {
    chain = chain.then(task).catch((err: unknown) => log({ evt: 'read-event-error', message: String(err) }))
  }
  let prepared = false

  const MEMBER_STATE: Record<string, ApiMemberState | undefined> = { join: 'joined', invite: 'invited', leave: 'left', ban: 'left' }

  // An event the room does not hold (an edit's target), read from the server as it is (not decrypted: its
  // sender and its relation type travel in clear).
  const fetchedOf = async (room: Room, eventId: string): Promise<MatrixEvent | undefined> => {
    try {
      return new SdkEvent(await client.fetchRoomEvent(room.roomId, eventId))
    } catch {
      return undefined
    }
  }

  const onLiveEvent = async (ev: MatrixEvent, room: Room): Promise<void> => {
    await client.decryptEventIfNeeded(ev).catch(() => undefined)
    const ctx = sidecarCtx(client, room, files, log)
    const conversation = tokenOfRoom(room.roomId)
    const type: string = ev.getType()
    if (type === T_MESSAGE && ev.isRelation(RelationType.Replace)) {
      const targetId = ev.getRelation()?.event_id
      if (targetId === undefined) return
      // Only the author edits (PLANO-AGENTES §8.30): the target's sender from the room, else from a read
      // of the event; another sender, or one that cannot be read, drops the edit with a log line.
      const original = room.findEventById(targetId)
      const target = original ?? (await fetchedOf(room, targetId))
      // PLANO-AGENTES §0.3.23 item 9: the edit of a folded message (a panel, a manifest, an answer), by the
      // agent itself or by another, is never `message.edited` — the edit's new content says so when it
      // decrypts, the target's relation type in clear always does.
      if (foldedKind(ev) !== undefined || (target !== undefined && foldedKind(target) !== undefined)) return
      const targetSender = target?.getSender()
      if (!editAppliesTo(ev.getSender(), targetSender)) {
        log({ evt: 'edit-ignored', reason: targetSender === undefined ? 'author-unknown' : 'not-author' })
        return
      }
      const ts = await tsOfRelated(room, targetId)
      if (ts === undefined) return
      const m = editToMessage(ev, targetId, ctx, original)
      emit({ type: 'message.edited', conversation, message: await project(room, m, ts, (ev.getContent()['m.new_content'] ?? {}) as Record<string, unknown>) })
      return
    }
    if (type === T_MESSAGE || ev.isDecryptionFailure()) {
      const message = await messageOf(room, ev, ctx)
      if (message === null) return
      emit({ type: 'message.received', conversation, message })
      if (message.mentionsMe) emit({ type: 'mention', conversation, message })
      if (ev.isDecryptionFailure()) {
        // Late keys: the readable version arrives as an edit of the same message.
        ev.once(MatrixEventEvent.Decrypted, () =>
          serial(async () => {
            if (ev.isDecryptionFailure()) return
            const upgraded = await messageOf(room, ev, sidecarCtx(client, room, files, log))
            if (upgraded === null) return
            emit({ type: 'message.edited', conversation, message: upgraded })
            if (upgraded.mentionsMe) emit({ type: 'mention', conversation, message: upgraded })
          }),
        )
      }
      return
    }
    if (type === T_REACTION) {
      const targetId = ev.getRelation()?.event_id
      if (targetId === undefined) return
      const ts = await tsOfRelated(room, targetId)
      if (ts === undefined) return
      const reactions = aggregateReactions(room, targetId, client.getUserId()).map((r) => ({ emoji: r.emoji, count: r.count, mine: r.mine }))
      emit({ type: 'reaction.changed', conversation, id: ts, reactions })
      return
    }
    if (type === T_REDACTION) {
      const target = (ev.event as { redacts?: unknown }).redacts ?? ev.getContent<{ redacts?: unknown }>().redacts
      if (typeof target !== 'string') return
      const ts = await tsOfRelated(room, target)
      if (ts !== undefined) emit({ type: 'message.removed', conversation, id: ts })
      return
    }
    if (type === T_MEMBER) {
      const userId = ev.getStateKey()
      if (userId === undefined || userId === me() || infraAccounts(me()).has(userId)) return
      const state = MEMBER_STATE[(ev.getContent().membership) ?? '']
      if (state === undefined) return
      emit({ type: 'member.changed', conversation, person: personOf(userId, ev.getContent().displayname), state })
    }
  }

  const onTimeline = (ev: MatrixEvent, room: Room | undefined, toStart: boolean | undefined, removed: boolean, data: { liveEvent?: boolean }): void => {
    if (!prepared || room === undefined || toStart === true || removed || data.liveEvent !== true) return
    if (ev.getId()?.startsWith('$') !== true) return // own pending sends: the server's echo comes later
    serial(() => onLiveEvent(ev, room))
  }
  const onMembership = (room: Room, membership: string, prev?: string): void => {
    if (!prepared) return
    if (membership === 'join' && prev !== 'join') serial(() => Promise.resolve(emit({ type: 'conversation.added', conversation: conversationOf(room) })))
    if ((membership === 'leave' || membership === 'ban') && prev === 'join') serial(() => Promise.resolve(emit({ type: 'conversation.removed', id: tokenOfRoom(room.roomId) })))
  }
  const onSync = (state: string): void => {
    if (state === 'PREPARED' || state === 'SYNCING') prepared = true
  }

  // Live events count only after the first healthy sync (the initial sync is history, not news). The
  // facade is created before startClient, so it sees that transition.
  client.on(ClientEvent.Sync, onSync)

  const facade: ReadFacade = {
    async me() {
      const id = me()
      if (myName === null) {
        try {
          const profile = await client.getProfileInfo(id)
          myName = typeof profile.displayname === 'string' ? profile.displayname : ''
        } catch {
          myName = ''
        }
      }
      return { id: tokenOfPerson(id), workspace: workspaceToken(serverNameOf(id)), name: displayName(myName, id), kind: 'agent' }
    },

    bot() {
      return botToken(me())
    },

    conversations(q) {
      const all = joinedRooms()
        .map(conversationOf)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      const page = offsetPage('conversations', all, q)
      return page.next !== undefined ? { conversations: page.items, next: page.next } : { conversations: page.items }
    },

    conversation(id) {
      return conversationOf(roomOf(id))
    },

    members(id, q) {
      const room = roomOf(id)
      const infra = infraAccounts(me())
      const all = room
        .getJoinedMembers()
        .filter((m) => !infra.has(m.userId))
        .map((m) => personOf(m.userId, m.rawDisplayName))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      const page = offsetPage(`members ${room.roomId}`, all, q)
      return page.next !== undefined ? { people: page.items, next: page.next } : { people: page.items }
    },

    person(id) {
      const userId = userOf(id)
      return personOf(userId, personNameOf(present(userId), nameOf(userId), authorNames.get(userId)))
    },

    async messages(id, q) {
      const room = roomOf(id)
      const limit = clampLimit(q.limit)
      let cur: MessageCursor
      if (q.cursor !== undefined) {
        const taken = cursors.take(q.cursor)
        if (taken === undefined || taken.kind !== 'messages' || taken.roomId !== room.roomId) throw new ReadError('invalid_cursor')
        cur = taken
      } else {
        const oldest = q.oldest !== undefined ? parseBound(q.oldest) : null
        const latest = q.latest !== undefined ? parseBound(q.latest) : null
        if ((q.oldest !== undefined && oldest === null) || (q.latest !== undefined && latest === null)) throw new ReadError('invalid_argument')
        cur = { kind: 'messages', roomId: room.roomId, from: null, pending: [], exhausted: false, oldest, latest, inclusive: q.inclusive === true }
        // A thread listing pages the server's replies from the newest (from = null), never the live timeline.
        if (q.thread !== undefined) cur.thread = await eventOfTs(room, q.thread)
      }
      const out: ApiMessage[] = []
      while (out.length < limit) {
        if (cur.pending.length === 0) {
          if (cur.exhausted) break
          await fetchPage(room, cur)
          continue
        }
        const msg = cur.pending.shift() as ApiMessage
        const key = tsKey(msg.id)
        if (cur.latest !== null && (cur.inclusive ? key > cur.latest : key >= cur.latest)) continue
        if (cur.oldest !== null && (cur.inclusive ? key < cur.oldest : key <= cur.oldest)) {
          // Newest first: everything after this one is older still.
          cur.pending = []
          cur.exhausted = true
          break
        }
        out.push(msg)
      }
      const more = cur.pending.length > 0 || !cur.exhausted
      return more ? { messages: out, next: cursors.put(cur) } : { messages: out }
    },

    async message(id, ts) {
      const room = roomOf(id)
      const eventId = await eventOfTs(room, ts)
      let ev = room.findEventById(eventId)
      if (ev === undefined) {
        let fetched: MatrixEvent
        try {
          fetched = new SdkEvent(await client.fetchRoomEvent(room.roomId, eventId))
        } catch {
          throw new ReadError('message_not_found')
        }
        // As a listing page does (fetchPage): the latest edit comes bundled; the SDK applies it only
        // inside a timeline.
        const bundled = fetched.getServerAggregatedRelation<Record<string, unknown>>(RelationType.Replace)
        const edit = bundled ? new SdkEvent(bundled) : undefined
        await settle(edit !== undefined ? [fetched, edit] : [fetched])
        // Only the author's edit applies (PLANO-AGENTES §8.30), even if the server already filtered.
        if (edit !== undefined && !edit.isDecryptionFailure() && editAppliesTo(edit.getSender(), fetched.getSender())) fetched.makeReplaced(edit)
        ev = fetched
      } else {
        await settle([ev])
      }
      if (ev.isRedacted() || ev.isRelation(RelationType.Replace)) throw new ReadError('message_not_found')
      const msg = await messageOf(room, ev, sidecarCtx(client, room, files, log))
      if (msg?.id !== ts) throw new ReadError('message_not_found')
      return msg
    },

    subscribe(listener) {
      if (listeners.size === 0) {
        client.on(RoomEvent.Timeline, onTimeline)
        client.on(RoomEvent.MyMembership, onMembership)
      }
      listeners.add(listener)
      for (const event of held.splice(0)) listener(event)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          client.off(RoomEvent.Timeline, onTimeline)
          client.off(RoomEvent.MyMembership, onMembership)
        }
      }
    },
  }

  const resolver: Resolver = {
    roomAnyOf,
    userOf,
    eventOf: eventOfTs,
    tsOf: (roomId, eventId, originServerTs) => tsIndex.tsOf(roomId, eventId, originServerTs),
    tsOfRelated,
    tokenOfRoom,
    tokenOfPerson,
    file: (token) => files.get(token),
    noteFile: (ref) => {
      const id = fileToken(ref.uri)
      files.delete(id)
      if (files.size >= FILE_MAX) files.delete(files.keys().next().value as string)
      files.set(id, ref)
      return id
    },
  }
  return {
    facade,
    resolver,
    announce,
    bindApprovals: (view) => {
      approvalView = view
    },
    bindCommands: (port) => {
      declares = port
    },
    commandAt: (room, ev) => {
      const m = eventToMessage(ev, sidecarCtx(client, room, files, log))
      return m !== null && commandFor(m, me(), declares, log) !== undefined
    },
  }
}
