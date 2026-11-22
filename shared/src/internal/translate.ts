import type { Room, MatrixEvent, RoomMember, IMyDevice, Thread } from 'matrix-js-sdk'
import { Direction, JoinRule, EventStatus, RelationType, EventType } from 'matrix-js-sdk'
import { DecryptionFailureCode } from 'matrix-js-sdk/lib/crypto-api/index.js'
import type { EncryptedFile, RoomServerUnread } from './wire-types'
import type {
  ApprovalState,
  ApprovalOption,
  Channel,
  Message,
  MessageBody,
  MessageId,
  User,
  UserKind,
  AgentColor,
  Person,
  Presence,
  Reaction,
  Device,
  MediaRef,
  ThreadSummary,
  Timestamp,
  UnreadState,
  UnsupportedShape,
  UserId,
} from '../domain'
import type { AclMode, AclTelemetry, ConceptKind, RosterEntry } from '../acl-types'
import { UntranslatableConceptError } from '../errors'
import { roleOf } from './role-mapping'
import { brandChannelId, brandUserId, brandMessageId } from './protocol-ids'
import { richFromContent, stripReplyFallback } from './rich-text'
import { editAppliesTo } from './edit-author'
import { approvalClosed, isAgentSender, readApprovalNeeded, readApprovalOptions } from './approval'
import { readCommandMarker, startsWithCommand } from './commands'
import {
  APPROVAL_MSGTYPE,
  APPROVAL_RESPONSE_MSGTYPE,
  COMMANDS_MSGTYPE,
  COMMANDS_REL_TYPE,
  FORM_MSGTYPE,
  FORM_REL_TYPE,
  FORM_RESULT_MSGTYPE,
  FORM_SUBMISSION_MSGTYPE,
  CONVERSATION_EVENT,
  PANEL_MSGTYPE,
  PANEL_REL_TYPE,
  RESPONSE_REL_TYPE,
} from './product-events'

// ── Translation context ──────────────────────────────────────────────────────────────────
// D3 (ADR-007 §3) is threaded here: `strict` (dev/test/CI) throws on a concept with no
// translation; `lenient` (prod) degrades by nature. `telemetry` records only the *shape*.
export interface Ctx {
  mode: AclMode
  telemetry: AclTelemetry
  isDm: (roomId: string) => boolean
  // The DM peer's protocol id (the m.direct key that lists this room — PLANO-PRESENCA §8.4 item 9),
  // or undefined for a non-DM / unknown room. Optional like the other enrichers: a ctx without it
  // (unit-test fakes) simply mints no Channel.peer.
  dmPeerOf?: (roomId: string) => string | undefined
  // Current user's protocol id (stays inside the ACL) — used only to derive Message.mine, a
  // boolean. null when unknown (e.g. the room-agnostic getChannels ctx) → mine stays undefined.
  myUserId?: string | null
  // Destinatário estrutural da org (ADR-057 dec. 2) — presente em TODA sala cifrada nascida pela
  // ACL. Aqui só para ser SUBTRAÍDO: o cofre não conta como membro e nunca é o "outro" de um DM.
  // Ausente (fakes de unit test, ctx sem identidade) → nada a subtrair, comportamento pré-PR-4.
  custodian?: string | null
  // Conta de sistema (ADR-083 dec. 5): subtraída do contador do canal da org, como o cofre.
  systemAccount?: string | null
  // The organization channel's alias; absent (unit-test fakes) → no room is that channel.
  orgChannelAlias?: string | null
  // ADR-083 dec. 3: whether this person belongs to the organization. Absent (unit-test fakes) → the
  // translation of a member stays 'member', the behaviour before the organization had guests.
  kindOf?: (mxid: string) => UserKind
  // ADR-086 (Proposto) dec. 1/3: an agent's colour and operator's name, read from the agent's
  // io.tayet.member on the organization channel. Undefined when that channel is not readable (a
  // guest) or carries nothing: the translation then falls back to 'areia' and no operator. Asked only
  // for an mxid kindOf already called an agent.
  agentOf?: (mxid: string) => { color?: AgentColor; operatorName?: string } | undefined
  // Aggregated reactions for a message, keyed by its REAL event id (bound to a room by the
  // gateway). Absent on fresh stream events (no reactions yet) → defaults to [].
  reactionsFor?: (realEventId: string) => Reaction[]
  // ADR-066: the SDK's Thread model rooted at a REAL event id, when the room has one (bound to a
  // room by the gateway). Absent (room-agnostic ctx, unit fakes) → the summary comes only from the
  // server's aggregation on the root event.
  threadFor?: (realEventId: string) => Thread | undefined
  // Mint an opaque MediaRef for an mxc (cleartext) or EncryptedFile (cifrado). ADR-009: the
  // mxc never crosses the barrel — only this opaque token does. Bound to a room/session.
  mediaRefFor?: (mxc: string, encrypted?: EncryptedFile, mimetype?: string) => MediaRef
  // Resolve a relation target's REAL event id to its STABLE domain id (ADR-010): for one's own
  // sends the stable id is the txn, so a reply to an own message must surface that txn — not the
  // wire event id — or the UI's by-id lookup (e.g. the quoted preview) misses. Bound to a room by
  // the gateway; absent (room-agnostic ctx) → the real id is used as-is.
  stableIdFor?: (realEventId: string) => string
  // ADR-068: the server's unread counts of a room, captured from /sync by the ServerUnreadStore —
  // the ONLY source of the channel count, in encrypted and cleartext rooms alike. Absent (unit fakes)
  // → no source, the count is 0.
  serverUnread?: (roomId: string) => RoomServerUnread | undefined
  // ADR-057 dec. 7 (PR-5) + ADR-077 dec. 4: o discriminante do veredito definitivo. true SÓ
  // quando a custódia de sessão foi consultada com sucesso NESTA sessão de uso, a sessão do evento
  // não veio no import E as re-consultas dessa sessão esgotaram o teto — a prova que gradua
  // 'stalled' → 'lost' ('awaited' nunca gradua). Sem consulta (falha, boot sem recovery), teto não esgotado,
  // sessionId ausente, ou enricher ausente (fakes, ctx room-agnostic) → false: veredito de
  // perda exige evidência, nunca default.
  custodyMissing?: (sessionId: string | undefined) => boolean
  // ADR-077 dec. 1: notificado com a sessão Megolm de TODO evento não decifrável ('awaited' e
  // 'stalled') — o gateway decide se agenda a re-consulta à custódia (sessão fora do import, teto
  // não esgotado). Ausente → nada.
  onUndecryptable?: (sessionId: string) => void
  // ADR-091 dec. 3/5/6: the aggregated state of an approval card, keyed by its REAL event id,
  // given the card's original options and the instant it was closed (undefined while open). Bound to a
  // room by the gateway; synchronous — it answers from its cache and loads in the background (the
  // timeline never waits; the resolution arrives as message.edited of the card). Absent (sidecar in
  // A3-1, unit fakes) → the card reads 'closed' when closed, else 'open'.
  approvalStateFor?: (realEventId: string, card: ApprovalCardFacts) => ApprovalState
  // Who answered a form opened from this message (a card, or a command message), keyed by its REAL event
  // id, given what the rule needs of the anchor. Synchronous, from a cache that loads in the background;
  // the answer arrives as message.edited. Absent → no reply is shown.
  formReplyFor?: (realEventId: string, anchor: FormAnchorFacts) => { by: string; at: number } | undefined
}

// What the form reply rule needs of an anchor: the agent that may open a form from it, whether it is a
// card or a command, and its author.
export interface FormAnchorFacts {
  agent: string
  kind: 'card' | 'command'
  sender: string
}

// What the aggregator needs of a card to decide its state. The close is permanent and dated by the
// author's FIRST closing edit (ADR-091 dec. 7): the translation only sees the displayed content, so it
// hands the aggregator what it knows — whether the author edited the card at all (the first close is then
// in the card's edits, which the aggregator reads) and a provisional instant for the displayed close.
export interface ApprovalCardFacts {
  options: readonly ApprovalOption[]
  // The card's author: only the author's edits close it.
  author: string
  // Provisional: the instant of the displayed close (the latest author edit carrying the mark, or the
  // card's own instant when it was born closed); undefined when the displayed content is open.
  closedAt: number | undefined
  // The card was born closed (its original content carries the mark): its own instant.
  bornClosedAt: number | undefined
  // The author edited the card: the first close, if any, is read from its edits.
  edited: boolean
  // How many answers the card asks for, from its original content; absent on a card its first answer
  // resolves.
  needed?: number
}

// The card behind a translation: its ORIGINAL content (the options come only from there — an edit never
// changes them), its real event id and the instant of the author's latest edit (the close, when the
// displayed content carries the closing mark).
interface CardSource {
  original: Record<string, unknown>
  sender: string
  realEventId: string | undefined
  editedAt: number | undefined
  sentAt: number
}

// The reply-relation envelope, as read off a message content (named only inside the ACL).
type RelatesTo = {
  rel_type?: string
  event_id?: string
  is_falling_back?: boolean
  'm.in_reply_to'?: { event_id?: string }
}

// The GENUINE reply target of an event, or undefined. m.in_reply_to under a m.thread relation
// with is_falling_back !== false is the spec's rich-reply FALLBACK for thread-unaware clients —
// representation, not a reply (the same semantics whose emission the thread gate forbids,
// PLANO-FASE-1-THREADS §9) — so it does NOT mint a replyTo. A bare m.in_reply_to (no rel_type)
// is the real thing (PLANO-FASE-1-REPLY §2.2).
export function genuineReplyTarget(content: Record<string, unknown>): string | undefined {
  const relates = content['m.relates_to'] as RelatesTo | undefined
  const target = relates?.['m.in_reply_to']?.event_id
  if (!target) return undefined
  if (relates?.rel_type === 'm.thread' && relates.is_falling_back !== false) return undefined
  return target
}

// A message's relations — threadParent + replyTo — derived from a content dict (PLANO-FASE-1-REPLY
// §0.6: every path that rebuilds a Message must preserve BOTH). Callers must pass the ORIGINAL
// content (getOriginalContent): relations are immutable in Matrix, and getContent() of an
// already-replaced event returns the edit's m.new_content, which carries no relation (the SDK's
// own getRelation() reads the wire content for the same reason).
export function relationsOf(
  content: Record<string, unknown>,
  ctx: Ctx,
): { threadParent?: MessageId; replyTo?: MessageId } {
  const relates = content['m.relates_to'] as RelatesTo | undefined
  // Both targets resolve to the target's STABLE id (an own target → its txn) so the UI's by-id
  // matches hold: the open thread (threadParent) and the quoted preview (replyTo).
  const threadRaw = relates?.rel_type === 'm.thread' && relates.event_id ? relates.event_id : undefined
  const threadParent = threadRaw ? brandMessageId(ctx.stableIdFor?.(threadRaw) ?? threadRaw) : undefined
  const replyRaw = genuineReplyTarget(content)
  const replyTo = replyRaw ? brandMessageId(ctx.stableIdFor?.(replyRaw) ?? replyRaw) : undefined
  return { threadParent, replyTo }
}

// ── Thread summary (ADR-066) ──────────────────────────────────────────────────────────────
// The thread under a root, as a product summary. Source order: the SDK's Thread when the room has
// one — it keeps the latest reply live as replies arrive by sync — else the server's aggregation
// bundled on the root (count + latest event), which is present on a root from /sync AND on the raw
// event of a /messages page, so a paginated root gets its summary without opening the thread.
// The count of a Thread held whole (first page fetched, nothing older to paginate) is its distinct
// reply events, pending or confirmed: the SDK's `length` can count one reply twice when the root's
// server aggregate (already including it) lands before the reply reaches the thread's timeline.
// A Thread not held whole keeps `length`, which starts from the server aggregate. A Thread that
// exists is trusted even at zero (all replies redacted → no summary). Nothing of the relation (ids,
// rel_type, the latest event) crosses (P1).
type BundledThread = { count?: unknown; latest_event?: { origin_server_ts?: unknown } }

export function threadSummaryOf(event: MatrixEvent, ctx: Ctx): ThreadSummary | undefined {
  const realId = event.getId()
  const thread = realId ? ctx.threadFor?.(realId) : undefined
  if (thread) {
    const count = heldWhole(thread) ? heldReplyCount(thread) : thread.length
    if (count <= 0) return undefined
    return { replyCount: count, latestReplyAt: ts(thread.replyToEvent?.getTs() ?? event.getTs()) }
  }
  const bundled = event.getServerAggregatedRelation<BundledThread>(RelationType.Thread)
  const count = typeof bundled?.count === 'number' ? bundled.count : 0
  if (count <= 0) return undefined
  const latest = bundled?.latest_event?.origin_server_ts
  return { replyCount: count, latestReplyAt: ts(typeof latest === 'number' ? latest : event.getTs()) }
}

function heldWhole(thread: Thread): boolean {
  return thread.initialEventsFetched && thread.liveTimeline.getPaginationToken(Direction.Backward) === null
}

// A redacted reply loses its relation and drops out; a local echo is the same event once confirmed.
function heldReplyCount(thread: Thread): number {
  return thread.events.filter((e) => e.getId() !== thread.id && e.isRelation(RelationType.Thread)).length
}

// ── Reaction aggregation (PLANO-FASE-1-TRADUTORES §1.4) ───────────────────────────────────
// Aggregate m.reaction (rel_type m.annotation) by EXACT key (no unicode normalization in the
// MVP). Redacted annotations are excluded → that IS the redaction→decrement. `mine` reflects
// the current user's own non-redacted annotation.
export function aggregateReactions(
  room: Room,
  realEventId: string,
  myUserId: string | null,
): Reaction[] {
  const rel = room.relations.getChildEventsForEvent(
    realEventId,
    RelationType.Annotation,
    EventType.Reaction,
  )
  const byKey = rel?.getSortedAnnotationsByKey()
  if (!byKey) return []
  const out: Reaction[] = []
  for (const [key, set] of byKey) {
    const live = [...set].filter((e) => !e.isRedacted())
    if (live.length === 0) continue
    out.push({
      emoji: key,
      count: live.length,
      mine: live.some((e) => e.getSender() === myUserId),
    })
  }
  return out
}

const ts = (n: number): Timestamp => n as Timestamp

// ── Stable message identity under local echo (ADR-010) ───────────────────────────────────
// The stable MessageId is the TRANSACTION id when present. On our own local echo getTxnId()
// returns the txn the ACL minted for the send. The id survives the server's echo NOT because
// getTxnId reads unsigned.transaction_id (on 41.6.0 it does not), but because the SDK reuses the
// local-echo event object when it reconciles the remote echo — so pending→sent keeps ONE id with
// no map (PLANO-GATES §8.12 item 3). Others' messages have no txn → the event id is the id. The
// ACL owns this; the UI never reconciles.
export function stableMessageId(event: MatrixEvent): string {
  return event.getTxnId() ?? event.getId() ?? ''
}

// SDK send status → domain status. null status = a received/settled message (no send lifecycle).
function statusOf(event: MatrixEvent): Message['status'] {
  switch (event.status) {
    case EventStatus.SENDING:
    case EventStatus.QUEUED:
    case EventStatus.ENCRYPTING:
      return 'pending'
    case EventStatus.NOT_SENT:
      return 'failed'
    case EventStatus.SENT:
      return 'sent'
    default:
      return undefined // received message — no send status
  }
}

// ── P1 presentation cleaning (the boundary where protocol terminology is stripped) ───────
// These never let `:server` or a bare mxid reach the domain. The render-scan + leak-scan
// tests are the gate; these helpers are the construction that makes the gate pass.
function localpart(mxid: string): string {
  const m = /^@([^:]+):/.exec(mxid)
  return m?.[1] ?? mxid.replace(/^@/, '')
}

// Removes the suffix " (@user:server)" from an already trimmed name, in one right-to-left pass. The
// suffix starts at the LEFTMOST `(@` that qualifies, which is not always the last one (the user part may
// itself hold `(@`): the first colon after it leaves a non-empty user part, and what lies between that
// colon and the final `)` is non-empty and has no `)`.
export function stripDisambiguation(name: string): string {
  const close = name.length - 1
  if (name[close] !== ')') return name
  const previousClose = name.lastIndexOf(')', close - 1)
  let colon = -1 // the first colon at or after i + 2
  let open = -1
  for (let i = close - 4; i >= 0; i--) {
    if (name[i + 2] === ':') colon = i + 2 // right after `(@`, so it would leave the user part empty
    else if (colon > previousClose && name[i] === '(' && name[i + 1] === '@') open = i
  }
  return open === -1 ? name : name.slice(0, open).trimEnd()
}

// Exported for the editable-profile snapshot (ADR-040): matrix-client reuses this EXACT cleaning so a
// fullName snapshot can never be an mxid (mirrors selfToUser's posture). Pure string fn, no SDK.
export function cleanDisplayName(raw: string | undefined, mxid: string): string {
  const name = (raw ?? '').trim()
  if (!name) return localpart(mxid)
  // A name that IS an mxid → localpart. The SDK also appends a disambiguation suffix
  // " (@user:server)" to colliding names; strip it so the server never shows.
  if (/^@[^:]+:/.test(name)) return localpart(name)
  return stripDisambiguation(name).trim() || localpart(mxid)
}

// Channel display: "#name" for public/private, the peer's name for a DM. Strips any
// alias-style ":server" tail defensively (named rooms won't carry it; unnamed fallbacks can),
// and the `@` sigil too — a DM's last-resort fallback name can be mxid-shaped (§8.5/§8.6 item 5).
// ADR-086 (Proposto): the agent fields of a User, only for an agent. The colour falls back to 'areia'
// when the organization channel is not readable; the mark never depends on it.
export const DEFAULT_AGENT_COLOR: AgentColor = 'areia'
export function agentFieldsOf(
  mxid: string,
  kind: UserKind,
  ctx: Pick<Ctx, 'agentOf'>,
): Pick<User, 'agentColor' | 'operatorName'> {
  if (kind !== 'agent') return {}
  const info = ctx.agentOf?.(mxid)
  return {
    agentColor: info?.color ?? DEFAULT_AGENT_COLOR,
    ...(info?.operatorName !== undefined && { operatorName: info.operatorName }),
  }
}

// PLANO-AGENTES §0.3.11 (P6 / ADR-086 dec. 2): the explicit display name of a member event, cleaned —
// unlike cleanDisplayName it NEVER falls back to the localpart: no explicit name → undefined, so the UI
// shows its own "Alguém". The SDK's disambiguation suffix " (@x:y)" is stripped; an mxid-shaped name is
// dropped (P1).
function explicitDisplayName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const name = raw.trim()
  if (!name || /^@[^:]+:/.test(name)) return undefined
  return stripDisambiguation(name).trim() || undefined
}

// The author's portrait at the event (Message.authorAt). The name comes from the event's sentinel
// RoomMember — the member state AT that event, not the current roster — and only from its explicit
// `displayname` (never RoomMember.name, which the SDK computes down to the id). `agent` is kindOf (the
// reserved prefix); `color` only when agentOf read a recorded one (no 'areia' fallback here — the UI
// owns the default). Absent when there is no sender.
function authorAtOf(event: MatrixEvent, sender: string, ctx: Ctx): Pick<Message, 'authorAt'> {
  if (!sender) return {}
  const content = event.sender?.events.member?.getContent() as Record<string, unknown> | undefined
  const name = explicitDisplayName(content?.['displayname'])
  const agent = ctx.kindOf?.(sender) === 'agent'
  const color = agent ? ctx.agentOf?.(sender)?.color : undefined
  return { authorAt: { ...(name !== undefined && { name }), agent, ...(color !== undefined && { color }) } }
}

function cleanChannelName(raw: string): string {
  const stripped = raw.replace(/:[^\s:]+$/, '').replace(/^[#@]/, '').trim()
  return stripped || raw.replace(/^[#@]/, '')
}

// ── Room → Channel ───────────────────────────────────────────────────────────────────────
// `join` só: um cofre ainda em `invite` não entrou no getJoinedMemberCount, então subtrair nesse
// caso derrubaria o contador em 1 indevidamente.
function custodianJoined(room: Room, ctx: Ctx): boolean {
  return !!ctx.custodian && room.getMember(ctx.custodian)?.membership === 'join'
}

function systemJoined(room: Room, ctx: Ctx): boolean {
  return !!ctx.systemAccount && room.getMember(ctx.systemAccount)?.membership === 'join'
}

// ADR-094 (Proposto) dec. 4: the people of a conversation — the members in `join` or `invite`, without the
// session itself, the custody and the system account, in display-name order (case- and accent-insensitive,
// ties broken by the raw id so the order is stable whatever the store's order). ONE list feeds a group's
// name and its `participants`, and the name of any room without an authored name.
const collator = new Intl.Collator(undefined, { sensitivity: 'base' })

function conversationPeople(room: Room, ctx: Ctx): { id: string; name: string }[] {
  return room
    .getMembers()
    .filter((m) => m.membership === 'join' || m.membership === 'invite')
    .filter((m) => m.userId !== room.myUserId && m.userId !== ctx.custodian && m.userId !== ctx.systemAccount)
    .map((m) => ({ id: m.userId, name: cleanDisplayName(m.rawDisplayName, m.userId) }))
    .sort((a, b) => collator.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

// ADR-094 (Proposto) dec. 2 and 3: a room is a group conversation when it is not a DM, not the
// organization channel, and carries the marker with exactly `{ kind: 'group' }`. Anything else (absent,
// malformed, `{ kind: 'channel' }` after a conversion) classifies by visibility. Read after the join: the
// marker is in the store by the time of `channel.added`. Exported for the client's ACL triggers
// (channel.changed on a group's member events, matrix-client.ts).
export function isGroupConversation(room: Room, ctx: Ctx): boolean {
  if (!hasGroupMarker(room)) return false
  return !ctx.isDm(room.roomId) && !isOrgChannel(room, ctx)
}

// The cheap half of isGroupConversation: only the room's own marker, no context. A false here is final (no
// marker, no group); a true still needs isGroupConversation (a DM or #all carrying the marker is not a
// group). Lets the client skip building the translation context on the hot member-event path.
export function hasGroupMarker(room: Room): boolean {
  return room.currentState.getStateEvents(CONVERSATION_EVENT, '')?.getContent()?.kind === 'group'
}

// ADR-083 dec. 2: #all is invite-only on the server and stays a public channel in the product
// (ADR-045 dec. 2): to everyone who sees it, it is the open channel of the organization.
function isOrgChannel(room: Room, ctx: Ctx): boolean {
  return !!ctx.orgChannelAlias && room.getCanonicalAlias() === ctx.orgChannelAlias
}

// Fonte do nome de exibição. `room.name` tem duas naturezas que o tipo não distingue: o nome AUTORADO
// (m.room.name — palavra de humano; passa verbatim) e o nome CALCULADO pelo SDK quando não há m.room.name
// (dos heroes, em inglês — "Empty room", "X and 2 others" —, com o id quando falta perfil, e com o cofre,
// que é hero de toda sala cifrada sem nome: ADR-057 dec. 2, "#bob and cofre" provado vivo no fecho da
// PR-4). O calculado nunca é usado (ADR-094 dec. 4; PLANO-CONVERSAS §0.3.1 item 5): sem nome autorado, o
// nome é recomputado na fonte das pessoas da conversa (conversationPeople), nunca sanitizado da string
// pronta. Sala sem mais ninguém (eu, cofre, system) → nome vazio: leak-free por construção, fora do
// envelope do produto (createChannel sempre autora nome; DM vive do m.direct).
function displayNameSource(room: Room, ctx: Ctx): string {
  const authored = room.currentState.getStateEvents('m.room.name', '')?.getContent()?.name
  if (typeof authored === 'string' && authored.trim()) return authored
  return conversationPeople(room, ctx)
    .map((p) => p.name)
    .join(', ')
}

// ADR-068 D1/D4: the channel count is the server's (room + Σ threads), read the same way in both kinds
// of room — in cleartext it is the very number the SDK used to sum (room.ts:1533), in an encrypted room
// the SDK dropped it. Mentions: the server's highlight in cleartext; in an encrypted room the server
// cannot see m.mentions (highlight is always 0), so the ACL counts the decrypted events in memory.
function unreadOf(room: Room, ctx: Ctx): UnreadState {
  if (!ctx.serverUnread) return { count: 0, mentions: 0 }
  const server = ctx.serverUnread(room.roomId)
  let count = server?.room.total ?? 0
  let highlight = server?.room.highlight ?? 0
  for (const t of server?.threads.values() ?? []) {
    count += t.total
    highlight += t.highlight
  }
  const mentions = room.hasEncryptionStateEvent() ? encryptedUnreadMentions(room, ctx.myUserId) : highlight
  return { count, mentions }
}

// ADR-068 D4: in an encrypted room, the unread mentions are the decrypted messages in memory (main
// timelines and threads) from someone else, not an edit, that mention the user and that no receipt of
// theirs covers. Coverage is room.hasUserReadEvent (RoomReceipts) — NOT the Thread's, which carries the
// beforeFirstThreadedReceipt heuristic (ADR-067). An event still encrypted is not counted yet; its
// decrypt re-emits the channel (matrix-client.ts, onDecryptedMention). A mention outside what is in
// memory is not seen (D6 a).
export function encryptedUnreadMentions(room: Room, me: string | null | undefined): number {
  if (!me) return 0
  const seen = new Set<string>()
  let n = 0
  const consider = (event: MatrixEvent): void => {
    const id = event.getId()
    if (!id || seen.has(id)) return
    seen.add(id)
    if (event.getSender() === me || event.isRedacted() || event.isDecryptionFailure()) return
    if (event.getType() !== EventType.RoomMessage || event.isRelation(RelationType.Replace)) return
    // The displayed content (displayedEdit): a mention added by someone else's edit never counts.
    if (!mentionsUserInContent(displayedEdit(event).content, me)) return
    if (room.hasUserReadEvent(me, id)) return
    n++
  }
  for (const timeline of room.getUnfilteredTimelineSet().getTimelines()) timeline.getEvents().forEach(consider)
  for (const thread of room.getThreads()) thread.events.forEach(consider)
  return n
}

export function roomToChannel(room: Room, ctx: Ctx): Channel {
  const dm = ctx.isDm(room.roomId)
  const org = isOrgChannel(room, ctx)
  // ADR-094 dec. 3: the DM map, then the marker, then visibility. The org channel is never a group.
  const group = isGroupConversation(room, ctx)
  const open = room.getJoinRule() === JoinRule.Public || org
  const kind: Channel['kind'] = dm ? 'dm' : group ? 'group' : open ? 'public' : 'private'

  let name: string
  let peer: Channel['peer']
  let peerAvatar: Channel['peerAvatar']
  let peerAgent: Channel['peerAgent']
  let participants: Channel['participants']
  let participantAgents: Channel['participantAgents']
  if (dm) {
    const peerRaw = ctx.dmPeerOf?.(room.roomId)
    // DM display = the other party's clean name. β1b: with no OTHER joined member (the ADR-044
    // invited window, or a peer who left) but a known peer, derive the name from the peer's
    // MEMBER (an invite member event carries the profile) — the SDK's calculated room name is
    // mxid-shaped for a profileless invitee. The room name stays the last-resort fallback.
    const me = room.myUserId
    // ADR-057 dec. 2 — RIPPLE do DM de 3 membros: com o cofre joinado, getJoinedMembers() devolve
    // [eu, par, cofre] e o `find` original pegaria o PRIMEIRO não-eu, que pode ser o cofre (a ordem
    // é a do store do SDK, não estável). O DM passaria a se chamar pelo nome da identidade de
    // custódia. Excluir o cofre aqui é o que mantém "um DM se chama (e se parece com) o outro
    // humano" — o resto do bloco (peer/peerAvatar) já vem do m.direct, que só lista o par.
    const other = room.getJoinedMembers().find((m) => m.userId !== me && m.userId !== ctx.custodian)
    const peerMember = !other && peerRaw ? room.getMember(peerRaw) : null
    name = other
      ? cleanDisplayName(other.rawDisplayName, other.userId)
      : peerMember
        ? cleanDisplayName(peerMember.rawDisplayName, peerMember.userId)
        : cleanChannelName(displayNameSource(room, ctx))
    if (peerRaw) {
      peer = brandUserId(peerRaw)
      // Same path memberToUserRole uses for a member's photo (ADR-009: opaque MediaRef, never mxc).
      const mxcAvatar = room.getMember(peerRaw)?.getMxcAvatarUrl()
      peerAvatar = mxcAvatar && ctx.mediaRefFor ? ctx.mediaRefFor(mxcAvatar) : undefined
      // ADR-086: the agent mark of the DM travels on the channel (PLANO-AGENTES §0 F1).
      if (ctx.kindOf?.(peerRaw) === 'agent') {
        const { agentColor, operatorName } = agentFieldsOf(peerRaw, 'agent', ctx)
        peerAgent = { color: agentColor ?? DEFAULT_AGENT_COLOR, ...(operatorName !== undefined && { operatorName }) }
      }
    }
  } else if (group) {
    // ADR-094 dec. 4: always the people, never the room's name (authored or calculated); no `#`. A group
    // with nobody else: '' and [].
    const people = conversationPeople(room, ctx)
    name = people.map((p) => p.name).join(', ')
    participants = people.map((p) => brandUserId(p.id))
    // PLANO-CONVERSAS §0.3.4 item 1: the agents among them, by the same kindOf the DM's peerAgent reads.
    participantAgents = people.filter((p) => ctx.kindOf?.(p.id) === 'agent').length
  } else {
    name = '#' + cleanChannelName(displayNameSource(room, ctx))
  }

  const topicEv = room.currentState.getStateEvents('m.room.topic', '')
  const topic = topicEv?.getContent()?.topic
  const cleanTopic = typeof topic === 'string' && topic.trim() ? topic : undefined

  // ADR-026: arquivamento é o state event custom reversível io.tayet.archived (não destrutivo —
  // preserva membership). `active === true` → archived: true; ausente/false → a chave NÃO existe no
  // objeto (spread condicional, não `archived: undefined` — ADR-076 dec. 6: "ausente = ativo" vale
  // também para `'archived' in channel`). O tipo do evento é detalhe interno — nunca cruza o barrel
  // (o Channel carrega só o booleano de produto).
  const archivedEv = room.currentState.getStateEvents('io.tayet.archived', '')
  const archived = archivedEv?.getContent()?.active === true

  return {
    id: brandChannelId(room.roomId),
    name,
    kind,
    topic: cleanTopic,
    // ADR-057 dec. 2: o cofre está joinado em toda sala cifrada e inflaria o contador em 1. Subtrai
    // em vez de contar getJoinedMembers().filter(...).length de propósito — o count do SDK vem do
    // summary do servidor e pode divergir dos membros conhecidos localmente sob lazy-loading;
    // subtrair preserva a semântica existente e só age quando o cofre está de fato joinado.
    memberCount:
      room.getJoinedMemberCount() - (custodianJoined(room, ctx) ? 1 : 0) - (systemJoined(room, ctx) ? 1 : 0),
    unread: unreadOf(room, ctx),
    ...(archived && { archived: true }),
    ...(org && { org: true }),
    // OMITTED (not explicit undefined) on a non-DM — the `archived` idiom: every existing channel
    // object stays byte-identical, and `'peer' in channel` proves the invariant structurally.
    ...(peer !== undefined && { peer }),
    ...(peerAvatar !== undefined && { peerAvatar }),
    ...(peerAgent !== undefined && { peerAgent }),
    // ADR-094 dec. 1: present if and only if kind === 'group' (possibly empty); omitted otherwise.
    ...(participants !== undefined && { participants }),
    ...(participantAgents !== undefined && { participantAgents }),
  }
}

// ── RoomMember → { user, role } ──────────────────────────────────────────────────────────
export function memberToUserRole(
  member: RoomMember,
  ctx: Ctx,
  // ADR-081: resolved by the caller against the session — this translator does not know the client.
  self: boolean,
): RosterEntry {
  const mxcAvatar = member.getMxcAvatarUrl()
  const kind = ctx.kindOf?.(member.userId) ?? 'member'
  const user: User = {
    id: brandUserId(member.userId),
    displayName: cleanDisplayName(member.rawDisplayName, member.userId),
    kind,
    ...agentFieldsOf(member.userId, kind, ctx),
    // ADR-009: opaque MediaRef, never a raw mxc:// (the leak-scan would catch a raw mxc).
    avatar: mxcAvatar && ctx.mediaRefFor ? ctx.mediaRefFor(mxcAvatar) : undefined,
  }
  // 'invited' = added but not yet joined (ADR-044: joins on their next connect). Role is still
  // computed from the invite's PL (default → 'member'); `state` drives the roster chip. The raw
  // `invite` membership string stays here in acl/internal — only MemberState crosses (P1).
  return {
    user,
    role: roleOf(member.powerLevel, kind),
    state: member.membership === 'invite' ? 'invited' : 'active',
    self,
  }
}

// ADR-083: one person of the organization, from its io.tayet.member content plus the member event of
// a room the session shares with them, when there is one. The member event is the live name; a person
// who never connected, or a guest outside the session's rooms, has only the name the admin typed. The
// SDK fills a RoomMember's raw name with the mxid when the event has none: that is not a name.
export function orgEventToPerson(
  input: { mxid: string; kind: UserKind; content: { name?: unknown; email?: unknown }; member: RoomMember | null },
  flags: { pending: boolean; self: boolean },
  ctx: Ctx,
): Person {
  const { mxid, kind, content, member } = input
  const live = member?.rawDisplayName
  const typed = typeof content.name === 'string' ? content.name : undefined
  const mxcAvatar = member?.getMxcAvatarUrl()
  return {
    user: {
      id: brandUserId(mxid),
      displayName: cleanDisplayName(live && live !== mxid ? live : typed, mxid),
      kind,
      ...agentFieldsOf(mxid, kind, ctx),
      avatar: mxcAvatar && ctx.mediaRefFor ? ctx.mediaRefFor(mxcAvatar) : undefined,
    },
    email: typeof content.email === 'string' ? content.email : undefined,
    ...flags,
  }
}

// ADR-056: protocol presence → domain. 1:1 for the three known values; anything else
// (including the SDK's constructor default on virgin Users) collapses to 'offline'.
export function presenceToDomain(raw: string): Presence {
  return raw === 'online' ? 'online' : raw === 'unavailable' ? 'away' : 'offline'
}

// ── Self → User (ADR-039) ────────────────────────────────────────────────────────────────
// The own-user counterpart of memberToUserRole: the SAME translation (brandUserId + cleanDisplayName
// + the opaque mediaRefFor for the avatar), only sourced from the whoami id + own profile instead of
// a RoomMember — a self-identity read has no room and no role. The raw mxid is the INPUT only: it
// never reaches the returned User's renderable surface (cleanDisplayName collapses an mxid-shaped raw
// name to its localpart; ADR-009 keeps the avatar opaque). P1: only the opaque User crosses.
export function selfToUser(
  userId: string,
  rawDisplayName: string | undefined,
  mxcAvatar: string | null | undefined,
  ctx: Ctx,
): User {
  const kind = ctx.kindOf?.(userId) ?? 'member'
  return {
    id: brandUserId(userId),
    displayName: cleanDisplayName(rawDisplayName, userId),
    kind,
    ...agentFieldsOf(userId, kind, ctx),
    avatar: mxcAvatar && ctx.mediaRefFor ? ctx.mediaRefFor(mxcAvatar) : undefined,
  }
}

// ── IMyDevice → Device ───────────────────────────────────────────────────────────────────
// P1/ADR-015: friendlyName é APENAS o display name do MAS; ausente → vazio (a UI renderiza "Acesso
// desconhecido"). NUNCA cai pro device_id — o id opaco jamais vira "nome" na tela. (Antes havia um
// fallback `|| d.device_id` "para toda linha ter rótulo"; era um vazamento latente, exposto quando o
// login OIDC passou a criar devices sem display_name. Espelha accessDeviceToDomain.)
export function deviceToDomain(d: IMyDevice): Device {
  return {
    id: d.device_id as Device['id'],
    friendlyName: (d.display_name ?? '').trim(),
    lastSeen: d.last_seen_ts !== undefined ? ts(d.last_seen_ts) : undefined,
    // Mapper dumb: default false. A derivação verdadeira de `current` é override no getDevices
    // (onde o myDeviceId é conhecido — espelha `mine`). §8.A3.
    current: false,
  }
}

// ADR-018: the Device carried by account.newAccess. Unlike deviceToDomain (the settings device
// list, which falls back to the device id so every row has a label), an ABSENT MAS display name
// yields an EMPTY friendlyName here — the banner then uses generic copy ("um novo acesso"), so the
// opaque device id NEVER surfaces as a "name" on the user's screen (§2 / P1).
export function accessDeviceToDomain(d: IMyDevice): Device {
  return {
    id: d.device_id as Device['id'],
    friendlyName: (d.display_name ?? '').trim(),
    lastSeen: d.last_seen_ts !== undefined ? ts(d.last_seen_ts) : undefined,
    // Event-payload de um acesso OUTRO (newAccess/attention) → nunca o atual. Default false.
    current: false,
  }
}

// ── MatrixEvent → MessageBody ────────────────────────────────────────────────────────────
const TEXT_MSGTYPES = new Set(['m.text', 'm.notice', 'm.emote'])

function unsupported(shape: UnsupportedShape, kind: ConceptKind, ctx: Ctx): MessageBody {
  if (ctx.mode === 'strict') throw new UntranslatableConceptError({ conceptKind: kind, shape })
  ctx.telemetry.untranslated({ conceptKind: kind, shape })
  return { kind: 'unsupported', shape }
}

// Pull the mxc (and EncryptedFile, if cifrado) out of a media event's content.
function extractMedia(content: Record<string, unknown>): { mxc: string; encrypted?: EncryptedFile } | undefined {
  const file = content.file as EncryptedFile | undefined
  if (file?.url) return { mxc: file.url, encrypted: file }
  const url = content.url
  if (typeof url === 'string' && url) return { mxc: url }
  return undefined
}

// `isReply` is the caller-owned signal (a genuine m.in_reply_to on the event — PLANO-FASE-1-REPLY §2.3)
// that conditions the strip of the legacy plain-text reply fallback. NEVER strip without it: a
// `> ` quote typed by the user in a non-reply is genuine content. The <mx-reply> counterpart in
// formatted_body needs no signal — that wrapper exists only as fallback (HARD_DROP in rich-text).
function translateBody(content: Record<string, unknown>, ctx: Ctx, isReply = false, card?: CardSource): MessageBody {
  const msgtype = typeof content.msgtype === 'string' ? content.msgtype : undefined
  const shape: UnsupportedShape = { msgtype, eventType: 'm.room.message' }
  if (msgtype === APPROVAL_MSGTYPE) return approvalBody(content, ctx, isReply, shape, card)
  if (msgtype && TEXT_MSGTYPES.has(msgtype)) {
    const raw = typeof content.body === 'string' ? content.body : ''
    const text = isReply ? stripReplyFallback(raw) : raw
    // ADR-012: populate `rich` when the event carried formatted (org.matrix.custom.html) content.
    // richFromContent is the SINGLE place the protocol rich vocabulary is named (acl/internal/
    // rich-text.ts); inbound is fail-closed — only known nodes survive. Edit content goes through
    // THIS same path: editToMessage passes the m.new_content dict, so no duplicate logic in the
    // m.replace branch. Absent/unparseable formatted_body → undefined → plain text unchanged.
    const rich = richFromContent(content)
    return rich ? { kind: 'text', text, rich } : { kind: 'text', text }
  }
  if (msgtype === 'm.image' || msgtype === 'm.file' || msgtype === 'm.video' || msgtype === 'm.audio') {
    const media = extractMedia(content)
    const info = (content.info ?? {}) as Record<string, unknown>
    const mimetype = typeof info.mimetype === 'string' ? info.mimetype : undefined
    if (!media || !ctx.mediaRefFor) return unsupported(shape, 'message-content', ctx)
    // Encrypted attachment (EncryptedFile envelope) translates EXACTLY like cleartext (fatia B
    // — ADR-016): the envelope rides into the per-session descriptor behind the opaque MediaRef
    // and resolveMedia serves the decrypted bytes as a blob URL. The fatia-A `unavailable`
    // window (PLANO-FASE-2 §4.5) is closed; nothing of the envelope crosses the barrel.
    const ref = ctx.mediaRefFor(media.mxc, media.encrypted, mimetype)
    const name = typeof content.body === 'string' && content.body ? content.body : 'file'
    if (msgtype === 'm.image') {
      return {
        kind: 'image',
        media: ref,
        alt: typeof content.body === 'string' ? content.body : undefined,
        width: typeof info.w === 'number' ? info.w : undefined,
        height: typeof info.h === 'number' ? info.h : undefined,
        blurhash:
          typeof info['xyz.amorgan.blurhash'] === 'string'
            ? (info['xyz.amorgan.blurhash'] as string)
            : undefined,
      }
    }
    // file/video/audio render as a downloadable file in this slice (domain has no a/v kind).
    return {
      kind: 'file',
      media: ref,
      name,
      size: typeof info.size === 'number' ? info.size : 0,
      mimetype: mimetype ?? 'application/octet-stream',
    }
  }
  // Genuinely unknown msgtype → fail-closed in strict, visible placeholder in lenient.
  return unsupported(shape, 'message-content', ctx)
}

// ADR-091 dec. 1: the approval card. The request is the usual body/formatted body of the
// DISPLAYED content (the author's latest edit); the options are read from the ORIGINAL content only. Only
// an agent sends a card: the type from any other author — or from an author the translation does not
// know (an edit without its original) — is no card, and neither is a malformed block: both fall into the
// unknown-type treatment that already exists.
function approvalBody(
  content: Record<string, unknown>,
  ctx: Ctx,
  isReply: boolean,
  shape: UnsupportedShape,
  card: CardSource | undefined,
): MessageBody {
  if (!card || !isAgentSender(card.sender)) return unsupported(shape, 'message-content', ctx)
  const options = readApprovalOptions(card.original)
  if (!options) return unsupported(shape, 'message-content', ctx)
  const needed = readApprovalNeeded(card.original)
  if (needed === null) return unsupported(shape, 'message-content', ctx)
  const raw = typeof content.body === 'string' ? content.body : ''
  const text = isReply ? stripReplyFallback(raw) : raw
  const request = richFromContent(content)
  const closedAt = approvalClosed(content) ? (card?.editedAt ?? card?.sentAt) : undefined
  const bornClosedAt = card && approvalClosed(card.original) ? card.sentAt : undefined
  const realId = card?.realEventId
  const facts: ApprovalCardFacts = {
    options,
    author: card?.sender ?? '',
    closedAt,
    bornClosedAt,
    edited: card?.editedAt !== undefined,
    ...(needed !== undefined && { needed }),
  }
  const unread: ApprovalState =
    needed !== undefined
      ? { kind: 'multi', needed, answers: [], closed: closedAt !== undefined }
      : closedAt !== undefined
        ? { kind: 'closed' }
        : { kind: 'open' }
  const state: ApprovalState = (realId !== undefined ? ctx.approvalStateFor?.(realId, facts) : undefined) ?? unread
  return { kind: 'approval', text, ...(request && { request }), options, state }
}

// ADR-091 dec. 2/12; PLANO-AGENTES §0.3.16 item 8: an answer to a card and a panel never become
// a line, read or not — nor a commands manifest (ADR-093 (Proposto), §0.3.21 item 3). The relation type in
// clear decides first (the wire content of an encrypted event carries it), then the type of the content, of
// an edit's new content too. The three messages of an agent's form fold the same way.
// 'response' | 'panel' | 'commands' | 'form' | undefined.
export function foldedKind(event: MatrixEvent): 'response' | 'panel' | 'commands' | 'form' | undefined {
  // Optional calls: the SDK's MatrixEvent has both; the hand-built fakes of the existing suites may not.
  const wire = (event.getWireContent?.() ?? {}) as Record<string, unknown>
  const original = (event.getOriginalContent?.() ?? event.getContent?.() ?? {}) as Record<string, unknown>
  const relType =
    (wire['m.relates_to'] as RelatesTo | undefined)?.rel_type ?? (original['m.relates_to'] as RelatesTo | undefined)?.rel_type
  if (relType === RESPONSE_REL_TYPE) return 'response'
  if (relType === PANEL_REL_TYPE) return 'panel'
  if (relType === COMMANDS_REL_TYPE) return 'commands'
  if (relType === FORM_REL_TYPE) return 'form'
  const newContent = (original['m.new_content'] ?? {}) as Record<string, unknown>
  for (const msgtype of [original.msgtype, newContent.msgtype]) {
    if (msgtype === APPROVAL_RESPONSE_MSGTYPE) return 'response'
    if (msgtype === PANEL_MSGTYPE) return 'panel'
    if (msgtype === COMMANDS_MSGTYPE) return 'commands'
    if (msgtype === FORM_MSGTYPE || msgtype === FORM_SUBMISSION_MSGTYPE || msgtype === FORM_RESULT_MSGTYPE) return 'form'
  }
  return undefined
}

// The card an edit event replaces carries its own type in the new content: such an edit is never a line
// of its own (the target shows it), and its own content holds no options.
function isApprovalEdit(event: MatrixEvent): boolean {
  const original = event.getOriginalContent() as Record<string, unknown>
  const relates = original['m.relates_to'] as RelatesTo | undefined
  const newContent = (original['m.new_content'] ?? {}) as Record<string, unknown>
  return relates?.rel_type === 'm.replace' && (newContent.msgtype === APPROVAL_MSGTYPE || original.msgtype === APPROVAL_MSGTYPE)
}

// ADR-037 addendum (inbound): menção = intenção declarada em m.mentions.user_ids (espelho inbound do
// M2 outbound), NÃO o highlight amplo da push-rule (que casava display name como substring). Lê o
// conteúdo (decifrado; em sala E2EE o m.mentions vive no ciphertext, legível só pós-decrypt — o UTD
// path segue false e é corrigido no re-emit). myUserId ausente → false, como mine.
function mentionsUserInContent(content: Record<string, unknown>, myUserId: string | null | undefined): boolean {
  if (myUserId == null) return false
  const mentions = (content['m.mentions'] ?? {}) as { user_ids?: unknown }
  return Array.isArray(mentions.user_ids) && mentions.user_ids.includes(myUserId)
}

// ADR-089 dec. 3: as pessoas mencionadas, da MESMA fonte de mentionsMe (m.mentions.user_ids do
// conteúdo dado — o top-level no evento vivo, m.new_content na edição). Vazio → ausente (spread de
// `{}`), para nenhum site ganhar uma chave `mentions: undefined`.
function mentionsOf(content: Record<string, unknown>): { mentions?: UserId[] } {
  const ids = ((content['m.mentions'] ?? {}) as { user_ids?: unknown }).user_ids
  if (!Array.isArray(ids)) return {}
  const users = [...new Set(ids.filter((id): id is string => typeof id === 'string' && id !== ''))]
  return users.length > 0 ? { mentions: users.map(brandUserId) } : {}
}

// ADR-093 (Proposto), PLANO-AGENTES §0.3.21 item 8: the command a message carries, derived from the ORIGINAL
// content — its marker names an agent, that agent is in its mentions — and the text SHOWN (on an edit, the
// new content's), which starts with "/name". Absent when the rule does not close (an edit that takes the
// prefix away loses it). The manifest is never consulted: the command records the intent, and the manifest
// may change later. PLANO-AGENTES §0.3.23 item 4: only a person's message is a command — when whoever sent it
// (on an edit, the edit's sender and the target's) is an agent, there is none.
function commandOf(original: Record<string, unknown>, body: MessageBody, senders: readonly string[]): Pick<Message, 'command'> {
  if (body.kind !== 'text') return {}
  if (senders.some(isAgentSender)) return {}
  const marker = readCommandMarker(original)
  if (!marker || !isAgentSender(marker.to)) return {}
  const ids = ((original['m.mentions'] ?? {}) as { user_ids?: unknown }).user_ids
  if (!Array.isArray(ids) || !ids.includes(marker.to)) return {}
  if (!startsWithCommand(body.text, marker.name)) return {}
  return { command: { agent: brandUserId(marker.to), name: marker.name } }
}

// Live-path menção: o m.mentions do evento cru (top-level). No edit path use mentionsUserInContent
// sobre m.new_content — o conjunto de display, mesma fonte do body (ver editToMessage).
export function mentionsUser(event: MatrixEvent, myUserId: string | null | undefined): boolean {
  return mentionsUserInContent(event.getContent() as Record<string, unknown>, myUserId)
}

// What a message shows after its edits: the replacement's content and date only when the replacement
// is the author's (editAppliesTo, PLANO-AGENTES §8.30). The SDK applies a server-bundled edit while it
// maps an event (event-mapper, no sender check) and our pages apply bundles too, so whoever replaced the
// event, a replacement by someone else is read past HERE, on every path that translates a message: the
// original content stays and no edit date appears. The bundle and the applied replacement are checked
// each on its own sender (the server's aggregation is not trusted to have filtered).
export function displayedEdit(event: MatrixEvent): { content: Record<string, unknown>; editedAt: number | undefined } {
  const author = event.getSender()
  // Optional calls: the SDK's MatrixEvent always has both; the hand-built event fakes of the existing
  // suites predate this read and stand for an event nobody replaced, which is what they are.
  const replacing = event.replacingEvent?.() ?? null
  const bundled = event.getServerAggregatedRelation?.<{ sender?: string }>(RelationType.Replace)
  const replacingOk = replacing !== null && editAppliesTo(replacing.getSender(), author)
  const bundledOk = bundled !== undefined && editAppliesTo(bundled.sender, author)
  const content = (replacing !== null && !replacingOk ? event.getOriginalContent() : event.getContent()) as Record<string, unknown>
  // The bundle's date first (as replacingEventDate reads it), else the applied replacement's — each only
  // when it is the author's.
  const date = bundledOk ? event.replacingEventDate() : replacingOk ? replacing.getDate() : undefined
  return { content, editedAt: date ? date.getTime() : undefined }
}

// Translate an `m.replace` edit into the post-edit Message. The id is the TARGET's stable id
// (the UI never re-keys), body comes from `m.new_content`, and `editedAt` marks it. The TARGET's
// relations (threadParent/replyTo) and original timestamp are derived from `original` when the
// caller has it (PLANO-FASE-1-REPLY §0.6 — an edit replaces content, never the relation; before this fix
// the synced m.replace path hardcoded threadParent: undefined and zeroed the target's relation).
export function editToMessage(
  editEvent: MatrixEvent,
  stableTargetId: string,
  ctx: Ctx,
  original?: MatrixEvent,
): Message {
  const content = editEvent.getContent() as Record<string, unknown>
  const newContent = (content['m.new_content'] ?? {}) as Record<string, unknown>
  const sender = editEvent.getSender() ?? ''
  const relations = original
    ? relationsOf(original.getOriginalContent() as Record<string, unknown>, ctx)
    : {}
  // An edit of a reply keeps the legacy fallback strip conditioned on the TARGET's relation
  // (legacy clients repeat the fallback inside m.new_content).
  const body = translateBody(
      newContent,
      ctx,
      relations.replyTo !== undefined,
      original
        ? {
            original: original.getOriginalContent() as Record<string, unknown>,
            sender: original.getSender?.() ?? '',
            realEventId: original.getId() ?? undefined,
            editedAt: editEvent.getTs(),
            sentAt: original.getTs(),
          }
        : undefined,
    )
  return {
    id: brandMessageId(stableTargetId),
    channelId: brandChannelId(editEvent.getRoomId() ?? ''),
    author: brandUserId(sender),
    body,
    sentAt: ts(original?.getTs() ?? editEvent.getTs()),
    editedAt: ts(editEvent.getTs()),
    reactions: [],
    threadParent: relations.threadParent,
    replyTo: relations.replyTo,
    // ADR-066: editing a root keeps its thread summary (derived from the TARGET, like relations).
    threadSummary: original ? threadSummaryOf(original, ctx) : undefined,
    mine: ctx.myUserId != null && sender === ctx.myUserId,
    // Numa edição, mentionsMe espelha o m.new_content (conjunto de display — mesma fonte do body),
    // NÃO o m.mentions do top-level do evento (conjunto de notificação = só as menções recém-adicionadas
    // pra não re-notificar; ao manter um @bob já mencionado, o top-level fica vazio e destacaria false).
    mentionsMe: mentionsUserInContent(newContent, ctx.myUserId),
    ...mentionsOf(newContent),
    // ADR-093: the marker and the mentions from the TARGET's original content, the text from the edit's.
    ...(original
      ? commandOf(original.getOriginalContent() as Record<string, unknown>, body, [sender, original.getSender?.() ?? ''])
      : {}),
    // The portrait from the TARGET's sentinel when the caller has it (the author at the original
    // message), else from the edit's own — same sender either way: only the author edits, and every
    // caller checks it with editAppliesTo before translating (PLANO-AGENTES §8.30).
    ...authorAtOf(original ?? editEvent, sender, ctx),
  }
}

// ADR-057 dec. 7 (PR-1 do track CRIPTO-COBERTURA): the graduated unavailability discriminator.
// The SDK failure code is protocol vocabulary and dies HERE (dec. 8); what crosses the barrel is
// the product distinction 'awaited' ("pode ainda chegar") × 'stalled' ("não chega por este
// canal"). 'stalled' is NOT a loss verdict — the custody channel (dec. 5/6, PR-5) may yet
// deliver; the client cannot prove irrecoverability locally (the spike saw
// HISTORICAL_MESSAGE_NO_KEY_BACKUP for cases custody will resolve).
const STALLED_CODES: ReadonlySet<DecryptionFailureCode> = new Set([
  // The sender declared it is withholding the key — a live share will not come.
  DecryptionFailureCode.MEGOLM_KEY_WITHHELD,
  DecryptionFailureCode.MEGOLM_KEY_WITHHELD_FOR_UNVERIFIED_DEVICE,
  // We hold the session at a LATER ratchet index; Megolm never walks backwards, so the needed
  // index cannot arrive by live share — only an export/restore path can deliver it.
  DecryptionFailureCode.OLM_UNKNOWN_MESSAGE_INDEX,
  // Historical message and the server has no key backup — the backup channel is exhausted.
  DecryptionFailureCode.HISTORICAL_MESSAGE_NO_KEY_BACKUP,
  // Sent while the user was not a member — outside the coverage invariant (ADR-057 norma 1).
  DecryptionFailureCode.HISTORICAL_MESSAGE_USER_NOT_JOINED,
  // Sender-trust refusals: policy, not latency — nothing arrives by waiting.
  DecryptionFailureCode.SENDER_IDENTITY_PREVIOUSLY_VERIFIED,
  DecryptionFailureCode.UNSIGNED_SENDER_DEVICE,
  DecryptionFailureCode.UNKNOWN_SENDER_DEVICE,
])

// Unlisted codes (UNKNOWN_ERROR, future SDK additions) and a missing reason default to
// 'awaited': declaring a channel dead requires evidence, and 'awaited' is exactly the transient
// contract the bare pre-ADR-057 variant already had. The mapping is deny-list, not allow-list,
// so an SDK upgrade can only ever soften a verdict, never invent one.
function arrivalOf(reason: DecryptionFailureCode | null | undefined): 'awaited' | 'stalled' {
  return reason != null && STALLED_CODES.has(reason) ? 'stalled' : 'awaited'
}

// ADR-096 (PLANO-EXPORT-DADOS §0.3.3 A7): the same grade for any event that failed to decrypt, a line or
// not (an edit, an answer to a card), so the export knows what may still arrive. undefined = not a failure.
export function undecryptedArrival(event: MatrixEvent): 'awaited' | 'stalled' | undefined {
  return event.isDecryptionFailure() ? arrivalOf(event.decryptionFailureReason) : undefined
}

// PR-5 (ADR-057 dec. 7) + ADR-077: gradua 'stalled' para o veredito definitivo 'lost' quando o
// ctx PROVA que a custódia foi consultada até o teto e a sessão não veio. 'awaited' NÃO gradua,
// nem depois do teto: a família "pode ainda chegar" fica como está (o hook ainda notifica a
// sessão, para a re-consulta). Sem enricher ou sem session_id na wire, o grau transitório fica.
// O session_id morre aqui (dec. 8): entra como discriminante, nunca como payload.
function gradedArrival(
  reason: DecryptionFailureCode | null | undefined,
  wire: Record<string, unknown>,
  ctx: Ctx,
): 'awaited' | 'stalled' | 'lost' {
  const grade = arrivalOf(reason)
  const sessionId = typeof wire['session_id'] === 'string' ? wire['session_id'] : undefined
  if (sessionId !== undefined) ctx.onUndecryptable?.(sessionId)
  return grade === 'stalled' && ctx.custodyMissing?.(sessionId) === true ? 'lost' : grade
}

// Returns null for events that are NOT renderable messages (state events, ephemerals,
// reactions, redacted tombstones) — intentional silent discard (ADR-007 §5), never a throw.
export function eventToMessage(event: MatrixEvent, ctx: Ctx): Message | null {
  // Decrypt-fail → TRANSIENT `unavailable` (ADR-015 item 1 / PLANO-FASE-2 §4.3), NEVER through
  // translateBody: the SDK's settled-failure stub is m.room.message with msgtype
  // 'm.bad.encrypted' (PF-1 item 2), which would surface a technical shape as `unsupported` —
  // and throw in strict — for what is the COMMON case (key not yet available). No payload
  // crosses: the body carries only the graduated product grade (arrivalOf, ADR-057 dec. 7),
  // never the failure code. Relations come from the WIRE content: the failure
  // stub carries no m.relates_to, but the envelope's relation is cleartext by construction
  // (PF-1 item 3) — the same source the SDK's own getRelation() reads.
  if (event.isDecryptionFailure()) {
    if (event.isRedacted()) return null
    const wire = event.getWireContent() as Record<string, unknown>
    const wireRelates = wire['m.relates_to'] as RelatesTo | undefined
    // An edit we cannot read yet: silent discard (P4) — the target keeps its current content and
    // the edit applies on the late-decrypt upgrade. A phantom `unavailable` bubble for a
    // replacement event would be wrong (it is not a new message).
    if (wireRelates?.rel_type === 'm.replace') return null
    // ADR-091: an answer or a panel that cannot be read is no line either (§0.3.16 item 8) — the
    // relation type in clear decides. The card it answers resolves without the option (dec. 9).
    if (foldedKind(event) !== undefined) return null
    const relations = relationsOf(wire, ctx)
    const failedSender = event.getSender() ?? ''
    return {
      id: brandMessageId(stableMessageId(event)),
      channelId: brandChannelId(event.getRoomId() ?? ''),
      author: brandUserId(failedSender),
      body: { kind: 'unavailable', arrival: gradedArrival(event.decryptionFailureReason, wire, ctx) },
      sentAt: ts(event.getTs()),
      reactions: ctx.reactionsFor?.(event.getId() ?? '') ?? [],
      threadParent: relations.threadParent,
      replyTo: relations.replyTo,
      threadSummary: threadSummaryOf(event, ctx),
      mine: ctx.myUserId != null && failedSender === ctx.myUserId,
      mentionsMe: false, // UTD: indetectável aqui; o valor real chega no re-emit pós-decrypt (máquina edited)
      ...authorAtOf(event, failedSender, ctx),
      status: statusOf(event),
    }
  }
  if (event.getType() !== 'm.room.message') return null
  if (event.isRedacted()) return null
  // ADR-091: answers and panels fold (never a line); a card's edit is shown by its target.
  if (foldedKind(event) !== undefined || isApprovalEdit(event)) return null
  const { content, editedAt } = displayedEdit(event)

  // Relations (threadParent + replyTo — PLANO-FASE-1-REPLY §2.2, replyTo mirrors threadParent) come from
  // the ORIGINAL content: getContent() of an already-edited event is the edit's m.new_content,
  // which carries no relation (see relationsOf) — the body below still uses the CURRENT content.
  // Our own optimistic reply echo flows through HERE too (the pending event carries the sent
  // m.relates_to), so the pending bubble is born with replyTo — no new path.
  const relations = relationsOf(event.getOriginalContent() as Record<string, unknown>, ctx)

  const sender = event.getSender() ?? ''
  const original = event.getOriginalContent() as Record<string, unknown>
  const body = translateBody(content, ctx, relations.replyTo !== undefined, {
    original,
    sender: event.getSender() ?? '',
    realEventId: event.getId() ?? undefined,
    editedAt,
    sentAt: event.getTs(),
  })

  return {
    id: brandMessageId(stableMessageId(event)),
    channelId: brandChannelId(event.getRoomId() ?? ''),
    author: brandUserId(sender),
    body,
    sentAt: ts(event.getTs()),
    editedAt: editedAt !== undefined ? ts(editedAt) : undefined,
    reactions: ctx.reactionsFor?.(event.getId() ?? '') ?? [],
    threadParent: relations.threadParent,
    replyTo: relations.replyTo,
    threadSummary: threadSummaryOf(event, ctx),
    mine: ctx.myUserId != null && sender === ctx.myUserId,
    mentionsMe: mentionsUserInContent(content, ctx.myUserId),
    ...mentionsOf(content),
    ...commandOf(original, body, [sender]),
    ...formReplyOf(event, body, commandOf(original, body, [sender]).command, ctx),
    ...authorAtOf(event, sender, ctx),
    status: statusOf(event),
  }
}

// The reply to a form opened from this message: only a card (the agent is its author) or a command (the
// agent it names) can be an anchor.
function formReplyOf(
  event: MatrixEvent,
  body: MessageBody,
  command: Message['command'],
  ctx: Ctx,
): Pick<Message, 'formReply'> {
  const realId = event.getId()
  const sender = event.getSender() ?? ''
  if (!ctx.formReplyFor || !realId || !hasServerIdShape(realId)) return {}
  const anchor: FormAnchorFacts | undefined =
    body.kind === 'approval'
      ? { agent: sender, kind: 'card', sender }
      : command
        ? { agent: command.agent as string, kind: 'command', sender }
        : undefined
  const reply = anchor ? ctx.formReplyFor(realId, anchor) : undefined
  return reply ? { formReply: { by: brandUserId(reply.by), at: ts(reply.at) } } : {}
}

// A local echo's id (the SDK's `~` prefix) is not a server id; no reply can name it.
const hasServerIdShape = (id: string): boolean => !id.startsWith('~')
