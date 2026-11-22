import {
  createClient,
  ClientEvent,
  RoomEvent,
  RoomStateEvent,
  SyncState,
  EventType,
  EventStatus,
  JoinRule,
  RelationType,
  Direction,
  MatrixError,
  Method,
  ClientPrefix,
  ConnectionError as SdkConnectionError,
  MatrixEvent,
  MatrixEventEvent,
  Preset,
  ReceiptType,
  ThreadEvent,
  UserEvent,
  type User as SdkUser,
  type MatrixClient,
  type Room,
  type Thread,
  type RoomMember,
  type RoomState,
  type IEvent,
  type IRoomTimelineData,
  type AccountDataEvents,
  type WritableAccountDataEvents,
} from 'matrix-js-sdk'
// CryptoEvent is not re-exported from the package root (only the crypto-api subpath). The
// boundary lint confines this import to acl/internal, same as the SDK itself (PF-1).
import { CryptoEvent } from 'matrix-js-sdk/lib/crypto-api'
// ADR-059 D1: o sinal canônico de sessão perdida. Mesmo caminho público do TokenRefreshLogoutError
// em oidc.ts (não re-exportado da raiz).
import { HttpApiEvent, retryNetworkOperation } from 'matrix-js-sdk/lib/http-api/index'
import {
  custodyMxidFor,
  systemMxidFor,
  encryptedBirthState,
  CUSTODY_WAIT_MS,
  CUSTODY_POLL_MS,
  CUSTODY_SIGNAL_INVITE_FAILED,
  CUSTODY_SIGNAL_WAIT_TIMEOUT,
  CUSTODY_SIGNAL_INVITE_DEFERRED,
  CUSTODY_SIGNAL_SESSIONS_UNAVAILABLE,
  CUSTODY_INVITE_MAX_ATTEMPTS,
  CUSTODY_DRAIN_TICK_MS,
  CUSTODY_RETRY_MARGIN_MS,
  CUSTODY_RETRY_DEFAULT_MS,
  type InitialStateEvent,
} from './custody'
import type {
  AclOptions,
  DomainEvent,
  ConnectionState,
  Unsubscribe,
  OutgoingBody,
  SendOpts,
  ResolvedMedia,
  MediaVariant,
  Page,
  PageCursor,
  ResetOutcome,
  SearchHit,
  NewChannel,
  ChannelPatch,
  RosterEntry,
  NewPerson,
  NewAgent,
  AgentPatch,
  PersonInvite,
  DataExportOptions,
  DataExportPart,
  AccountPreferences,
} from '../types'
import { runDataExport, EXPORT_PAGE_SIZE } from './data-export'
import type { OpaqueSession } from '../session'
import type {
  Channel,
  Message,
  MessageBody,
  User,
  MyProfile,
  UserKind,
  AgentColor,
  Person,
  UserProfile,
  OrgFields,
  Presence,
  Device,
  ChannelId,
  UserId,
  MessageId,
  MediaRef,
  AccessId,
  Timestamp,
  ThreadUnread,
  AgentPanel,
  AgentCommand,
  FormId,
  FormValues,
} from '@tayet/shared'
import { GROUP_MAX_OTHERS } from '@tayet/shared'
import { threadUnreadOf, latestReplyFromAggregation, type LatestReply } from './thread-unread'
import {
  channelIdToRaw,
  messageIdToRaw,
  brandChannelId,
  brandUserId,
  brandMessageId,
  brandMediaRef,
  mediaRefToRaw,
  accessIdToRaw,
  brandAccessId,
  userIdToRaw,
} from '@tayet/shared/internal'
import {
  ACKNOWLEDGED_DEVICES_KEY,
  LEGACY_ACKNOWLEDGED_DEVICES_KEY,
  readAcknowledged,
} from './acknowledged-devices'
import {
  addPendingRecognition,
  clearAllPendingRecognitions,
  readPendingRecognitions,
  settlePendingRecognitions,
} from './pending-recognitions'
import { openSearchStore, wipeSearchIndexes, type SearchEntry, type StoredMedia } from './search-store'
import { SearchIndex, normalizeForSearch, searchableText } from './search-index'
import {
  BACKFILL_IDLE_MS,
  BACKFILL_PAGE_SIZE,
  BACKFILL_RATE_LIMIT_DEFAULT_MS,
  runSearchBackfill,
} from './search-backfill'

// ADR-074 dec. 4 + addendum 2026-10-28: the fields of search.state, as the gateway keeps the last one.
type SearchStateFields = Omit<Extract<DomainEvent, { t: 'search.state' }>, 't'>
import { NOTE_KEY, PROFILE_KEY, PRONOUNS_KEY, readOrgFields, readProfile, writeProfile } from './profile'
import { PREFERENCES_KEY, readPreferences, writePreferences } from './preferences'
import { roleOf, roleToPowerLevel } from '@tayet/shared/internal'
import { mimetypeToMsgtype } from '@tayet/shared/internal'
import { encryptAttachment, type EncryptedFile } from '@tayet/shared/internal/attachment-crypto'
import { decryptAttachmentBytes, disposeDecryptWorker } from './attachment-decrypt'
import {
  buildApprovalAnswerContent,
  buildFormSubmissionContent,
  buildAttachmentContent,
  buildEditContent,
  buildReactionContent,
  buildTextContent,
  type AttachmentMedia,
  type FormSubmissionLabel,
} from '@tayet/shared/internal'
import { LocalMediaRegistry } from './local-media'
import { createEscrowClient, createPeopleClient, type EscrowClient, type PeopleClient } from './escrow-client'
import {
  consultCustody,
  CustodyReconsult,
  ensureKeyRecovery,
  RecoveryRunner,
  RECOVERY_SIGNAL_BACKUP_STEP_FAILED,
  type CustodyConsultPorts,
  type RecoveryOutcome,
} from './key-recovery'
import {
  compareIdentity,
  phaseOf,
  resetAccess as runReset,
  type ResetApproval,
  type ResetPhase,
  type ResetPorts,
  type StoredIdentity,
} from './key-reset'
import { parseSessionBlob, makeRenewer, renewOnBoot, revokeSessionTokens } from './oidc'
import { guarded } from './handler-guard'
import { ServerUnreadStore } from './server-unread'
import {
  ConnectionError,
  NameInUseError,
  PeopleUnavailableError,
  PersonExistsError,
  RateLimitedError,
  SessionExpiredError,
} from '@tayet/shared'
import {
  roomToChannel,
  memberToUserRole,
  selfToUser,
  cleanDisplayName,
  deviceToDomain,
  accessDeviceToDomain,
  eventToMessage,
  editToMessage,
  editAppliesTo,
  relationsOf,
  threadSummaryOf,
  stableMessageId,
  aggregateReactions,
  presenceToDomain,
  mentionsUser,
  type Ctx,
  orgEventToPerson,
  agentFieldsOf,
  foldedKind,
  APPROVAL_MSGTYPE,
  PANEL_REL_TYPE,
  COMMANDS_REL_TYPE,
  commandNameOf,
  startsWithCommand,
  CONVERSATION_EVENT,
  isGroupConversation,
  hasGroupMarker,
  EDIT_REDACTION_FIELD,
  undecryptedArrival,
} from '@tayet/shared/internal'
import { ApprovalAggregator, PendingAnswers, answerFactOf, answeredCardOf, editFactOf, fetchAnswerPage, fetchEditPage, takesAnswer, type PendingAnswer } from './approval-state'
import { PanelAggregator, fetchPanelPage } from './panel-state'
import { CommandAggregator, fetchCommandsPage } from './command-state'
import { FormReplies, FormSession, fetchFormPage, formRelatedOf, realClock, type FormClock, type SubmitOutcome } from './form-state'
import { isReaderCopy } from './anchored-state'
import { ensureFoldRules } from './fold-rules'
import { isAgentColor, normalizeName } from '@tayet/shared/internal'

// Localpart of the organization channel's canonical alias (ADR-045 dec. 2/4). The full alias is
// built at session-join time from the operator's own mxid domain (#<localpart>:<domain>). This
// protocol literal stays confined to acl/internal — it never crosses the barrel (P1); the UI only
// ever sees the resulting public Channel arriving on the stream.
const ORG_CHANNEL_LOCALPART = 'all'

// ADR-083 dec. 3: the state event that marks a person as part of the organization, written only by
// the system account on the organization channel. Its state_key is the mxid WITHOUT the sigil: the
// server refuses another account's `@…` state_key, even at PL 100.
const ORG_MEMBER_EVENT = 'io.tayet.member'

// ADR-086 (Proposto) dec. 1: the reserved agent localpart — `a-` + 12 of lowercase base32, the
// alphabet of the escrow's random localparts (sibling of the `u-` of ADR-083). Only the escrow creates it.
const AGENT_LOCALPART = /^a-[a-z2-7]{12}$/

// ADR-086 (Proposto) dec. 4: removal writes a tombstone `{ removed: true, kind }` instead of `{}`;
// both read as absence.
const isTombstone = (content: { removed?: unknown } | undefined): boolean => content?.removed === true

// The kinds whose line (the name; the pending state, for a guest only) lives on a channel shared with
// this session, not on #all (ADR-083, ADR-086 dec. 3): a guest and an agent are never in #all.
const isOutsideOrgKind = (kind: unknown): boolean => kind === 'guest' || kind === 'agent'

// §8.24: quanto tempo oculto conta como "voltou de background" para a re-query das listas de devices.
// Valor do prompt de execução (não medido): abaixo disso uma troca de aba rápida não paga keys/query.
export const REQUERY_DEVICES_AFTER_HIDDEN_MS = 60_000

// SyncState → domain ConnectionState (the SDK's protocol-level sync machine never crosses
// the barrel; the UI only ever sees these four states — a P4 hook).
function toConnectionState(s: SyncState): ConnectionState | null {
  switch (s) {
    case SyncState.Prepared:
    case SyncState.Syncing:
      return 'connected'
    case SyncState.Reconnecting:
      return 'reconnecting'
    case SyncState.Error:
    case SyncState.Stopped:
      return 'offline'
    default:
      return null
  }
}

// Assinatura de FALHA DE REDE do SDK: o FetchHttpApi embrulha toda rejeição do fetch (servidor
// fora, DNS/CORS, timeout, cliente offline) num ConnectionError — classe própria, NÃO um
// MatrixError (node_modules/matrix-js-sdk/src/http-api/fetch.ts:315 → errors.ts:195). É o único
// sinal POSITIVO de rede que o SDK dá; ausência dele = falha local até prova em contrário.
// O `name` entra como segundo cinto porque a classe tem esse getter fixo e o instanceof cairia
// se o bundler resolvesse duas instâncias do módulo do SDK — a queda seria pro lado seguro
// (falha classificada como local), então o cinto só reduz falso-negativo.
// Espera `work` por no máximo `ms` e nunca lança: estouro ou falha viram um aviso neutro no console
// (`[acl] <label> timed out|failed`, sem payload — nenhum token, URL ou errcode). O bound não aborta o
// request; uma rejeição tardia (pós-bound) também é engolida aqui — nada fica sem handler.
async function bounded(work: Promise<unknown>, ms: number, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms)
  })
  const settled = work.then(
    () => 'done' as const,
    () => 'failed' as const,
  )
  try {
    const outcome = await Promise.race([settled, bound])
    if (outcome !== 'done') console.warn(`[acl] ${label} ${outcome === 'timeout' ? 'timed out' : 'failed'}`)
  } finally {
    clearTimeout(timer)
  }
}

function isNetworkFailure(e: unknown): boolean {
  return e instanceof SdkConnectionError || (e as Error | null)?.name === 'ConnectionError'
}

// ADR-075 addendum: the waiting summed over one deleteMessage call for the redactions of its edits, and the least
// each repeat waits (a zero wait from the server would otherwise spin without ever reaching the cap).
const EDIT_REDACTION_WAIT_CAP_MS = 60_000
const EDIT_REDACTION_MIN_WAIT_MS = 250

// The wait the server gave for an M_LIMIT_EXCEEDED (the Retry-After header, else retry_after_ms); undefined for
// any other error or when no usable time came with it.
function rateLimitWaitMs(err: unknown): number | undefined {
  if (!(err instanceof MatrixError) || err.errcode !== 'M_LIMIT_EXCEEDED') return undefined
  try {
    const ms = err.getRetryAfterMs()
    return ms !== null && ms >= 0 ? ms : undefined
  } catch {
    return undefined
  }
}

// Read an attachment's bytes. Browsers implement Blob.arrayBuffer() (the normal path); jsdom
// (the DOM-gate environment) does not, but DOES implement FileReader — environment shim only,
// no behavior difference.
async function fileBytes(file: File | Blob): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') return new Uint8Array(await file.arrayBuffer())
  return await new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.onerror = () => reject(reader.error ?? new Error('could not read attachment bytes'))
    reader.readAsArrayBuffer(file)
  })
}

// Which channel (if any) a domain event is scoped to — for per-channel subscription routing.
// Total no-op custody for resetAccess when no escrow is provisioned (never dereferenced — observe
// returns 'unreachable' first; keeps the ResetPorts.escrow field total).
const UNAVAILABLE_ESCROW: EscrowClient = {
  deposit: async () => ({ kind: 'unavailable' }),
  retrieve: async () => ({ kind: 'unavailable' }),
  rotate: async () => ({ kind: 'unavailable' }),
  retrieveSessions: async () => ({ kind: 'unavailable' }),
  revokeOthers: async () => ({ kind: 'unavailable' }),
}

// ADR-082 dec. 1: how often the approval is probed, and how long the window is waited on. The MAS
// approval lasts 10 minutes.
const APPROVAL_POLL_MS = 2_000
const APPROVAL_TIMEOUT_MS = 10 * 60_000
const APPROVAL_ACTION = 'org.matrix.cross_signing_reset'
const APPROVAL_WINDOW_FEATURES = 'popup,width=520,height=720'

// PKCS#8 prefix of an Ed25519 private key (RFC 8410): the 4S keeps the bare 32-byte seed.
const ED25519_PKCS8_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
])

// The public key of the cross-signing master kept in 4S, in the unpadded base64 of /keys/query.
// undefined when this browser cannot derive it (no Ed25519 in WebCrypto): "cannot tell", which must
// not read as a half-state on a healthy account.
async function ed25519PublicOf(seedBase64: string): Promise<string | undefined> {
  const seed = Uint8Array.from(atob(seedBase64), (c) => c.charCodeAt(0))
  const pkcs8 = new Uint8Array(ED25519_PKCS8_PREFIX.length + seed.length)
  pkcs8.set(ED25519_PKCS8_PREFIX)
  pkcs8.set(seed, ED25519_PKCS8_PREFIX.length)
  try {
    const key = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, true, ['sign'])
    const { x } = await crypto.subtle.exportKey('jwk', key)
    return x?.replaceAll('-', '+').replaceAll('_', '/')
  } catch {
    return undefined
  }
}

function channelKeyOf(e: DomainEvent): string | undefined {
  switch (e.t) {
    case 'message.received':
    case 'message.edited':
    case 'message.removed':
    case 'message.status':
    case 'reaction.changed':
    case 'member.changed':
    case 'content.unsupported':
    case 'panels.changed':
    case 'commands.changed':
    case 'form.opened':
    case 'form.changed':
      return e.channelId
    case 'channel.changed':
    case 'channel.added':
      return e.channel.id
    // ADR-026: channel.removed carries only the channelId (the consumer needs only identity to drop
    // it from the active list). Routed by that id so a per-channel subscriber of the removed channel
    // also sees it ("replicado no de canal quando aplicável" — ADR-026 §1).
    case 'channel.removed':
      return e.channelId
    // ADR-018/ADR-019: account.newAccess and device.attention are ACCOUNT events (no channel) —
    // global stream only. Handled explicitly (not folded into the wide default) so the closed
    // union forces a decision here when a new member is added.
    case 'account.newAccess':
    case 'account.accessRecognized':
    case 'device.attention':
    case 'people.changed':
      return undefined
    // ADR-056: presence is a fact of the person, not of any membership — global stream only,
    // same posture as the account events above.
    case 'user.presence':
      return undefined
    // ADR-074 dec. 4: the search state is of the account's local index — global stream only.
    case 'search.state':
      return undefined
    default:
      return undefined
  }
}

// The ONE module that touches matrix-js-sdk. Every concept the SDK exposes (mxids, room ids,
// power levels, state events, device sessions) is confined here and translated before it
// crosses the acl/index.ts barrel. The boundary lint (eslint.config.js) makes importing the
// SDK anywhere else a build error.
//
// This is the internal FACADE: every method returns clean domain types. create-acl.ts (which
// lives above acl/internal and therefore cannot import the SDK) wires these into the public
// Acl surface — so no SDK object ever reaches it, let alone the barrel.
// ADR-059 D2: quanto o signOut espera o wipe do store antes de seguir. Latência de UX adjudicada pelo
// owner (PLANO-RELEASE-PUBLICA §8.6), não constante de fonte: o SDK não tem timeout de deleteDatabase.
// Wipe desbloqueado resolve em ms. Revisão: um `[acl] store wipe timed out` em dogfood sem 2ª aba.
export const STORE_WIPE_BOUND_MS = 2_000
// ADR-062 D1: quanto o signOut espera a revogação dos tokens no emissor (descoberta + RFC 7009) antes
// de seguir para o wipe. Mesmo regime do bound acima: limita a espera, não aborta o request. Uma
// tentativa; estourado ou falho, o sign-out local segue e o reaper do servidor (D3) cobre o resto.
export const REVOKE_BOUND_MS = 2_000
// PLANO-RELEASE-PUBLICA §8.37 D1: how many delivered-but-not-yet-in-the-room events the ACL keeps as
// read targets (owner's cap). Oldest first out; an entry only lives until the SDK places the event.
const READ_TARGET_CAP = 500
// #243 (PLANO-RELEASE-PUBLICA §8.58): an event the server knows by id. A pending send's local echo
// carries the SDK's own id, `"~" + roomId + ":" + txnId` (client.js, sendEvent), until the PUT resolves;
// a receipt on it is a 400. The SDK has no predicate for this: isSending() is `!!status`, true for a
// SENT event that already holds its server id as well — the very event the own-send receipt (ADR-068
// D7) goes on. So the criterion is the id itself.
const hasServerId = (event: MatrixEvent): boolean => !(event.getId() ?? '~').startsWith('~')

// ADR-093 (Proposto) dec. 5: one anchored reader — the panels or the commands manifest — with its relation
// type, as the gateway's hooks run over them.
interface AnchoredReader {
  kind: 'panel' | 'commands'
  agg: PanelAggregator | CommandAggregator
  relType: string
}

// The room's first event: nothing precedes it, so a page holding it ends the history. Neither /sync
// nor /messages says so by itself. /sync sends a prev_batch for every room, even one delivered whole
// (and from that token /messages replays the same events), and /messages drops `end` only on the
// empty page after this one. A later joiner who cannot see this event gets the missing `end`.
function reachesRoomStart(events: MatrixEvent[]): boolean {
  return events.some((ev) => ev.getType() === EventType.RoomCreate)
}

export class MatrixGateway {
  private client: MatrixClient | undefined
  // ADR-068: the client's store — the default MemoryStore plus the capture of the server's unread
  // counts from each /sync (the channel count's only source). One per client; dropped on disconnect.
  private serverUnread: ServerUnreadStore | undefined
  private readonly opts: AclOptions

  // Domain-event multicast. Global subscribers see everything; per-channel subscribers see
  // only events scoped to their channel. Reconciliation (txn↔event, edits, redactions) is
  // done HERE — the UI never touches protocol identity (ADR-007/ADR-010).
  private readonly globalSubs = new Set<(e: DomainEvent) => void>()
  private readonly channelSubs = new Map<string, Set<(e: DomainEvent) => void>>()
  // Rooms whose live listeners (unread counts + thread replies) are already attached. Both are
  // room-scoped events the SDK emits without a room arg, so we wire them once per Room.
  private roomWired = new WeakSet<Room>()
  // ADR-066: last thread summary emitted per root (real event id → "count:latestAt"), so a Thread
  // Update that leaves the summary unchanged does not re-emit the root. Cleared on disconnect.
  private readonly threadSummaryEmitted = new Map<string, string>()
  // ADR-067: latest reply of a root seen on a /messages page (the server's aggregation), keyed by the
  // root's real event id. A paginated root never enters the room nor gets an SDK Thread, so this is
  // what getThreadUnread has for it. Per session; cleared on disconnect. Never crosses the barrel.
  private readonly pagedThreadLatest = new Map<string, LatestReply>()
  // ADR-074: the local message-search index of this session — opened once the crypto checks of the
  // connect passed (a wipe there must not be blocked by our own connection), closed on disconnect.
  // Fed by emit (the stream) and translateAll (every page); holds raw ids that never cross the barrel.
  private search: SearchIndex | undefined
  // The account the index belongs to: the sign-out wipe needs it where indexedDB.databases() is absent.
  private searchAccount: string | undefined
  // ADR-074 dec. 4: the last search.state emitted, so only transitions reach the stream.
  private lastSearchState: SearchStateFields | undefined
  // ADR-074 dec. 3: the idle backfill. `searchBackfillRun` is its generation — bumped on connect and
  // disconnect, so a run of an earlier session stops at its next step. The user's getTimeline/sendMessage
  // calls hold it back: `userOps` in flight, and `userIdleAt` (ms) until which it still waits after them.
  private readonly searchBackfill: boolean
  private searchBackfillRun = 0
  private userOps = 0
  private userIdleAt = 0
  // Teardown for every listener we attach (client- and room-scoped). disconnect() runs these so no
  // listener of ours outlives the client — without this, a Thread re-emit (Thread.forSource → Room
  // emit) could fire our handler AFTER teardown, hitting require() with a null client.
  private disposers: Array<() => void> = []
  // ADR-059 D1/D2: o SDK declarou a sessão morta (SessionLoggedOut). O teardown que segue não faz
  // requisição autenticada. Rearmado a cada connect bem-sucedido.
  private sessionLost = false
  // ADR-062 D1: o que a revogação no signOut precisa além dos tokens vivos do client (que o refresh
  // rotaciona — lidos do client na hora, nunca do blob). Só no caminho OIDC; o token legado não tem
  // client OAuth a revogar.
  private oidcIssuerRef: { homeserverUrl: string; clientId: string } | undefined
  // reaction event id → its target's real event id, so a reaction's redaction can be routed to
  // a reaction.changed (decrement) instead of a message.removed.
  private readonly reactionTargets = new Map<string, string>()

  // ADR-056: the ACL-side presence map — the point-read source for getPresence (the late
  // subscriber's answer). The live store is MemoryStore (the createClient default —
  // matrix.js:104), NOT StubStore as previously assumed, so client.getUser() DOES resolve. The
  // map stays for the right reasons: it is OUR domain diff authority (absence ≡ 'offline'), and
  // the SDK User object never crosses the barrel (P1). Key is the raw SDK user id (branded only
  // at emission). No persistence by design: presence is ephemeral and dies with the instance.
  private readonly presenceByUser = new Map<string, Presence>()

  // openDirectMessage idempotency memo (this session): rawUserId → the DM room id created/found for
  // them. Closes the m.direct sync-echo window so a fast second call returns the same id; the durable
  // copy lives in the m.direct account-data map (ADR-026 decision 5). Cleared on disconnect.
  private readonly directRoomByUser = new Map<string, string>()
  // openGroupConversation idempotency memo (this session, ADR-094 dec. 8): the exact set of others (raw ids,
  // sorted, joined) → the group room created/found for it. Same lifecycle as directRoomByUser; an entry is
  // re-checked on every hit (groupRoomFor) and dropped when its room no longer matches or is converted.
  private readonly groupRoomBySet = new Map<string, string>()
  // ADR-094 (Proposto) dec. 3: the creator's channel.added is held until the group is whole, by knowledge —
  // the openings in flight (createRoom not yet answered), the rooms of answered openings with their set, and
  // the held rooms with their 3 s safety timer and the openings they wait for. Cleared on disconnect.
  private readonly groupOpenings = new Set<object>()
  private readonly openedGroupRooms = new Map<string, string>()
  private readonly heldGroupRooms = new Map<string, { timer: ReturnType<typeof setTimeout>; waitFor: Set<object> }>()
  private orgChannelId: string | undefined

  // ADR-068 D7: own thread replies already sent whose remote echo has not arrived yet — the read
  // receipt on them goes when it does (readOwnSend). Cleared on disconnect.
  private readonly ownSendsAwaitingEcho = new Set<string>()

  // Fire-and-forget work the ACL itself started (joins, account-data writes, receipts, device
  // reads): each one runs through `detach`, and disconnect() waits for what is still in flight
  // before stopping the client — so no ACL request outlives the session that made it. Requests
  // internal to the SDK (its crypto outgoing-request loop) are not tracked here.
  private readonly inflight = new Set<Promise<unknown>>()

  private detach(work: Promise<unknown>): void {
    this.inflight.add(work)
    const done = (): void => {
      this.inflight.delete(work)
    }
    // Both arms handled: the derived promise never rejects, and `work` keeps its own catch.
    work.then(done, done)
  }

  // §8.37 D1: events delivered to the UI (message.received), for the window in which
  // room.findEventById cannot resolve them — a thread reply before the SDK's Thread timeline holds it
  // (it fills on the root's /relations). markRead(ch, id) uses the event from here, so the receipt
  // targets the reply itself and its thread_id comes from the content relation. Keyed by event id,
  // capped (READ_TARGET_CAP, oldest out), dropped once the room resolves it, cleared on disconnect.
  private readonly readTargets = new Map<string, MatrixEvent>()
  // §8.37 D3: per room, the most recent explicit markRead target that resolved nowhere. Its receipt
  // goes when the event reaches the room (RoomEvent.Timeline). Cleared on disconnect.
  private readonly pendingReadTarget = new Map<string, string>()

  // Room ids whose invite auto-join is in flight (ADR-044): prevents a duplicate joinRoom when
  // MyMembership re-fires 'invite' during initial sync. Cleared on settle (success AND failure),
  // so a transient join failure can be retried by a later fire.
  private readonly joiningInvites = new Set<string>()
  // Room ids entered by autoJoinInvite whose own join event still owes its private read receipt. The
  // server keeps the invite's push action and, once it consolidates an action that came after the join,
  // the invite stays in the unread count until the first read; a private receipt on the join event closes
  // that. An entry leaves this set when its receipt goes, so one entry gets at most one receipt. Cleared
  // on disconnect.
  private readonly entryReceiptsOwed = new Set<string>()

  // ── Encrypted inbound pipeline (PLANO-FASE-2 §4.3) ────────────────────────────────────────
  // True once the FIRST sync has PREPARED (set at the end of connect). Decryption settles
  // ASYNCHRONOUSLY (PF-1 item 2), so without this gate the initial sync's encrypted history
  // would settle AFTER connect() resolves and flood the stream with message.received for
  // historical messages — the stream is the LIVE tail only; history is getTimeline's job.
  private live = false
  // Real event ids seen on the live tail still decrypting — emission is deferred until the
  // decrypt SETTLES (never emit from raw m.room.encrypted: the common case decrypts instantly
  // and emitting early would flash a placeholder for every message).
  private readonly pendingDecrypt = new Set<string>()
  // Real event id → stable domain id of every message emitted (or page-returned) as
  // `unavailable`. When the key later arrives, the SDK re-emits Decrypted and the ACL upgrades
  // via message.edited under that SAME stable id (ADR-015: zero new mechanism).
  private readonly unavailableEmitted = new Map<string, string>()

  // ADR-009 media registry: opaque token → descriptor. Per-session, non-persistable. The mxc
  // (and EncryptedFile for cifrado) live ONLY here; the domain carries the token only.
  private readonly mediaByToken = new Map<string, { mxc: string; encrypted?: EncryptedFile; mimetype?: string }>()
  private readonly mediaByMxc = new Map<string, MediaRef>()
  private mediaCounter = 0

  // LOCAL media (ADR-010 optimistic attachment): an opaque MediaRef → the picked File/Blob, so the
  // pending bubble shows the local preview before upload (PLANO-FASE-1-UPLOAD §2). No mxc here.
  private readonly localMedia = new LocalMediaRegistry()

  // Object URLs minted by resolveMedia's remote path (PLANO-FASE-2-MEDIA §3.2 / §0.2 item 2):
  // every created URL registers here; `release()` revokes its own, and `disconnect` revokes
  // whatever is left — the mirror of mediaByToken's per-session residual. NO LRU / active
  // policy: that is deferred on the SW-unified trigger (ADR-016).
  private readonly objectUrls = new Set<string>()

  // Txn ids of our own optimistic ATTACHMENT sends. We emit their 'pending' message.received with a
  // LOCAL MediaRef in sendMessage; the SDK-driven re-emit of the SAME send (which would carry the
  // REMOTE mxc) is then suppressed in onTimeline so the local-ref bubble stays authoritative for the
  // session and only message.status updates it (decision (a), §4). Text echoes are NOT in this set.
  private readonly localEchoTxns = new Set<string>()

  // Bootstrap-memory holder of the 4S secret (fatia C2 — PF-1 item 2): the createClient
  // cryptoCallbacks read from here while a recovery pass is running; ensureKeyRecovery clears it
  // at the end of every pass and disconnect() clears it again. It NEVER reaches a log,
  // DomainEvent, the DOM or any persistence of ours (§0.2 item 3) — only the SDK's own store
  // keeps what the protocol requires.
  private recoverySecret: Uint8Array<ArrayBuffer> | undefined
  // Background retry of the recovery pass (§3.3) — per-session, cancelled on disconnect.
  private recoveryRunner: RecoveryRunner | undefined
  // The pass closure, kept for on-demand re-runs (recheckKeyRecovery — ACL-internal).
  private recoveryRun: ((attempt: number) => Promise<RecoveryOutcome>) | undefined
  // ADR-077 (revisa ADR-061 D1): re-consulta à custódia por sessão Megolm desconhecida, com backoff
  // e teto, em qualquer pass (cold inclusive). Por sessão de uso; cancelada no disconnect.
  private custodyReconsult: CustodyReconsult | undefined
  // ADR-057 dec. 7 (PR-5): o conjunto que habilita o veredito definitivo. undefined = custódia
  // NÃO consultada nesta sessão de uso (sem consulta, sem veredito — todo 'stalled' fica
  // 'stalled'); Set (possivelmente vazio) = consulta + import assentados, e um evento stalled
  // cuja sessão não está aqui gradua 'lost'. Limpo no disconnect: o veredito é POR sessão de
  // uso — a próxima consulta (próximo acesso/boot) corrige um lost tornado verdadeiro-depois
  // por depósito tardio (trade registrado na dec. 7). Num boot warm a consulta não roda por
  // padrão (C2 §5.2 assert 3); ela vem SOB DEMANDA, por sessão de um evento não decifrável
  // (custodyReconsult — ADR-077).
  private custodyImportedSessions: Set<string> | undefined
  // The custody client of this session (ADR-019), reused by resetAccess. Undefined when no escrow
  // is provisioned — resetAccess then fails closed (re-offers via device.attention).
  private escrow: EscrowClient | undefined
  // ADR-083: undefined when no escrow is provisioned. The admin flag is asked once per connect.
  private people: PeopleClient | undefined
  private orgAdmin: Promise<boolean> | undefined

  // Devices the user has already acknowledged a new-access notification for (ADR-018 §4). Seeded
  // from account data at connect (read BEFORE the first device-list delta — PF-2 cold-start
  // ordering, wired in the detection slice) and updated immediately by acknowledgeAccess so this
  // session stops re-emitting at once. The durable copy lives in account data; this is the
  // in-memory mirror.
  private acknowledgedDevices = new Set<string>()
  // Devices this session has already emitted account.newAccess for — guarantees "exactly one
  // event per new access" (§5.2 assert 1) across repeated DevicesUpdated fires and the baseline scan.
  private notifiedDevices = new Set<string>()
  // ADR-063, adendo (PLANO-RELEASE-PUBLICA §8.31). The boot's server read of the recognized set, started
  // unconditionally by startAccessDetection; a write waits for it only while it has not settled. The
  // promise never rejects (refreshAcknowledged swallows), so a failed read degrades, never blocks.
  private ackServerRead: Promise<void> | undefined
  // The current key's content this session KNOWS is on the server (boot read, sync echo, own write);
  // undefined when unknown (read failed). The "unchanged content → no request" short-circuit uses it.
  private ackServerCurrent: Set<string> | undefined
  // At most one PUT in flight; an acknowledgement during a flight marks it dirty and ONE more PUT, with
  // the whole set at that moment, follows when the flight ends (coalesced).
  private ackWriting = false
  private ackDirty = false

  // Server upload limit (ADR-009 / PLANO-FASE-1-UPLOAD §2). Fetched lazily once per session from
  // the AUTHENTICATED media config (m.upload.size, 1.11+ /_matrix/client/v1/media/config) and
  // cached. A value of undefined means the server advertised no cap (or the config was
  // unreachable) — the server still enforces its own limit, this is only the early client-side
  // reject that keeps a condemned attachment from ever reaching an optimistic bubble.
  private maxUploadBytes: number | undefined
  private mediaConfigFetched = false

  private formClock: FormClock = realClock

  private mintMediaRef(mxc: string, encrypted?: EncryptedFile, mimetype?: string): MediaRef {
    const existing = this.mediaByMxc.get(mxc)
    if (existing) return existing
    this.mediaCounter += 1
    const token = `mr_${this.mediaCounter}`
    this.mediaByToken.set(token, { mxc, encrypted, mimetype })
    const ref = brandMediaRef(token)
    this.mediaByMxc.set(mxc, ref)
    return ref
  }

  // `internal` is not on the barrel: integration tests that need the index without the idle backfill
  // racing them turn it off (ADR-074 dec. 3).
  constructor(opts: AclOptions, internal?: { searchBackfill?: boolean; formClock?: FormClock }) {
    this.formClock = internal?.formClock ?? realClock
    this.opts = opts
    this.searchBackfill = internal?.searchBackfill ?? true
  }

  // ADR-091: the approval cards' aggregated state (approval-state.ts). The read of a card's
  // answers runs in the background; when it (or a live answer, decrypt or deletion) moves what the card
  // shows, the card is re-translated and re-emitted as message.edited.
  private readonly approvals = new ApprovalAggregator({
    fetchPage: (roomId, cardId, from) => fetchAnswerPage(this.require(), roomId, cardId, from),
    fetchEditPage: (roomId, cardId, from) => fetchEditPage(this.require(), roomId, cardId, from),
    accounts: () => {
      const me = this.client?.getUserId()
      return me ? { custodian: custodyMxidFor(me), systemAccount: systemMxidFor(me) } : {}
    },
    changed: (roomId, cardId) => this.emitApprovalCard(roomId, cardId),
    detach: (work) => this.detach(work),
  })
  // The card events this session translated, for the re-emission when the room no longer holds them (a
  // /messages page, a thread page). Bounded like readTargets.
  private readonly approvalCards = new Map<string, MatrixEvent>()
  // ADR-091 dec. 14 (A3-2): this session's own answer per card while it is in flight or not sent. Folded
  // into the card's state (sending/failed) only while the aggregated state is open. Cleared on disconnect.
  private readonly pendingAnswers = new PendingAnswers()
  // ADR-091 dec. 12 (A3-5): the pinned panels per conversation (panel-state.ts), read through
  // the anchor's relations; reloaded by a live panel event, its late decrypt or removal, recomputed when an
  // agent joins or leaves. panels.changed only when the list moves. Cleared on disconnect.
  private readonly panels = new PanelAggregator({
    anchorOf: (roomId) => this.client?.getRoom(roomId)?.currentState.getStateEvents(EventType.RoomCreate, '')?.getId() ?? undefined,
    fetchPage: (roomId, anchorId, from) => fetchPanelPage(this.require(), roomId, anchorId, from),
    isMember: (roomId, sender) => this.client?.getRoom(roomId)?.getMember(sender)?.membership === 'join',
    isOwn: (sender) => this.isOwnAgent(sender),
    nameOf: (roomId, sender) => cleanDisplayName(this.client?.getRoom(roomId)?.getMember(sender)?.rawDisplayName, sender),
    changed: (roomId, panels) => this.emit({ t: 'panels.changed', channelId: brandChannelId(roomId), panels }),
    detach: (work) => this.detach(work),
  })
  // ADR-093 (Proposto) (A4-1): the agents' `/` commands per conversation (command-state.ts), the second
  // adapter of the anchored aggregator — the same hooks as the panels (a live manifest event, its late
  // decrypt or removal, an agent joining or leaving). commands.changed only when the list moves. Cleared on
  // disconnect.
  private readonly commands = new CommandAggregator({
    anchorOf: (roomId) => this.client?.getRoom(roomId)?.currentState.getStateEvents(EventType.RoomCreate, '')?.getId() ?? undefined,
    fetchPage: (roomId, anchorId, from) => fetchCommandsPage(this.require(), roomId, anchorId, from),
    isMember: (roomId, sender) => this.client?.getRoom(roomId)?.getMember(sender)?.membership === 'join',
    nameOf: (roomId, sender) => cleanDisplayName(this.client?.getRoom(roomId)?.getMember(sender)?.rawDisplayName, sender),
    changed: (roomId, commands) => this.emit({ t: 'commands.changed', channelId: brandChannelId(roomId), commands }),
    detach: (work) => this.detach(work),
  })
  // An agent's form: the forms this session may open and the one it has open (form-state.ts).
  private readonly forms = new FormSession({
    send: (roomId, anchorId, formId, title, values, labels) => this.sendFormSubmission(roomId, anchorId, formId, title, values, labels),
    emit: (e) => this.emit(e),
    clock: {
      setTimeout: (fn, ms) => this.formClock.setTimeout(fn, ms),
      clearTimeout: (handle) => this.formClock.clearTimeout(handle),
    },
  })
  // Who answered a form opened from a card or a command message, for every member.
  private readonly formReplies = new FormReplies({
    fetchPage: (roomId, anchorId, from) => fetchFormPage(this.require(), roomId, anchorId, from),
    senderOf: (roomId, eventId) => this.senderOfEvent(roomId, eventId),
    changed: (roomId, anchorId) => this.emitAnchorChanged(roomId, anchorId),
    detach: (work) => this.detach(work),
  })
  // The anchored readers, one per relation type (ADR-093 dec. 5): the gateway's hooks run over both.
  private get anchored(): ReadonlyArray<AnchoredReader> {
    return [
      { kind: 'panel', agg: this.panels, relType: PANEL_REL_TYPE },
      { kind: 'commands', agg: this.commands, relType: COMMANDS_REL_TYPE },
    ]
  }

  subscribe(handler: (e: DomainEvent) => void): Unsubscribe {
    this.globalSubs.add(handler)
    return () => this.globalSubs.delete(handler)
  }

  subscribeChannel(id: ChannelId, handler: (e: DomainEvent) => void): Unsubscribe {
    const key = channelIdToRaw(id)
    let set = this.channelSubs.get(key)
    if (!set) {
      set = new Set()
      this.channelSubs.set(key, set)
    }
    set.add(handler)
    // ADR-112 (Proposto) dec. 2: subscribing is how the UI opens a conversation. Never awaited.
    this.detach(this.repairCustody(key))
    return () => set.delete(handler)
  }

  private emit(e: DomainEvent): void {
    this.indexForSearch(e)
    for (const h of this.globalSubs) h(e)
    const key = channelKeyOf(e)
    if (key) {
      const set = this.channelSubs.get(key)
      if (set) for (const h of set) h(e)
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────────────────
  async connect(session: OpaqueSession): Promise<void> {
    // ADR-032 D2: a OpaqueSession é OU um blob OIDC renovável OU uma string crua (env/dogfood legado).
    // Desserializa aqui (a ACL é a única que interpreta — acl/session.ts). O blob e o OidcTokenRefresher
    // vivem confinados em acl/internal/oidc.ts (fronteira do SDK — ADR-007).
    const parsed = parseSessionBlob(session)
    // ADR-059: sessão nova, sinal rearmado. Zerado na ENTRADA (não no fim) para que uma perda
    // durante o próprio sync inicial deste connect não seja apagada pelo sucesso dele.
    this.sessionLost = false

    let baseUrl: string
    let accessToken: string
    let refreshToken: string | undefined

    if (parsed.oidc) {
      baseUrl = parsed.homeserverUrl
      accessToken = parsed.accessToken
      refreshToken = parsed.refreshToken
      this.oidcIssuerRef = { homeserverUrl: parsed.homeserverUrl, clientId: parsed.clientId }
    } else {
      baseUrl = this.opts.serverUrl
      accessToken = parsed.accessToken
      this.oidcIssuerRef = undefined
    }

    // Identidade SEMPRE via whoami — fonte canônica do MXID com sigil (@) e do device_id, direto do
    // homeserver. O sub do id token OIDC NÃO é um MXID confiável (formato do MAS varia: localpart/sem
    // sigil) e quebra o createClient com "leading sigil is incorrect or missing". O caminho legado já
    // fazia assim; o atalho de identidade OIDC era otimização prematura (§8.L25).
    const probe = createClient({ baseUrl, accessToken })
    // L19/ADR-007: o errcode do SDK é detectado e DESCARTADO aqui (acl/internal); cruza a barrel só
    // como tipo de domínio. M_UNKNOWN_TOKEN = token de auth morto (expirado/revogado, com ou sem
    // soft_logout) → SessionExpiredError. Estreito de propósito: SÓ esse errcode vira sessão-expirada;
    // todo o resto (rede/transporte/outro errcode) sobe como está → 'error'/retry no Boot. Errar pra
    // 'error' é seguro (retry); errar pra 'revoked' mandaria re-logar por um soluço de rede.
    const who = await probe.whoami().catch(async (e: unknown) => {
      if (e instanceof MatrixError && e.errcode === 'M_UNKNOWN_TOKEN') {
        // ADR-059 D3: expiração renova, revogação encerra. Com blob renovável, o 401 do probe é no caso
        // comum só o access token vencido — tenta o refresh UMA vez e refaz o whoami com o token novo
        // (o onSessionRenewed do renewer já re-persistiu o blob). Só a rejeição terminal ('revoked')
        // cai no caminho de sessão morta abaixo; ConnectionError da tentativa sobe como está.
        if (parsed.oidc && parsed.refreshToken) {
          const renewal = await renewOnBoot(parsed, parsed.refreshToken, this.opts.onSessionRenewed)
          if (renewal !== 'revoked') {
            accessToken = renewal.accessToken
            refreshToken = renewal.refreshToken ?? refreshToken
            return await createClient({ baseUrl, accessToken })
              .whoami()
              .catch((e2: unknown) => {
                if (isNetworkFailure(e2)) throw new ConnectionError()
                throw e2
              })
          }
        }
        // Sessão morta ⇒ store morto: o crypto store nunca sobrevive ao device dono. O caminho
        // mid-session já limpava (onSessionLost → signOut → clearStores); o de boot não — essa
        // assimetria deixava um store órfão pro device seguinte (mismatch do OlmMachine no
        // initRustCrypto). Best-effort, mesmo regime do signOut: o wipe nunca engole o throw.
        await bounded((async () => probe.clearStores())(), STORE_WIPE_BOUND_MS, 'store wipe')
        clearAllPendingRecognitions() // §8.38: the local hints die with the session's local state
        await bounded(wipeSearchIndexes(), STORE_WIPE_BOUND_MS, 'search index wipe') // ADR-074 dec. 7
        throw new SessionExpiredError()
      }
      // Falha de REDE (o whoami é o primeiro toque de rede do boot) → tipo de domínio próprio, o
      // único que autoriza a copy de conexão na tela. Mesmo regime do irmão acima: o detalhe do SDK
      // (mensagem/cause/URL) morre aqui — payload-free é o que deixa o tipo cruzar a barrel. O
      // rastro pra debug não some: o transporte do SDK loga o fetch que falhou (console ≠ DOM), e
      // o Boot loga o erro de domínio antes de classificar.
      if (isNetworkFailure(e)) throw new ConnectionError()
      throw e
    })

    // Refresh na ACL; persistência no app — só no caminho OIDC. O refresher recebe o device CANÔNICO
    // do whoami (mesmo device, forma canônica), nunca um id derivado do token (§8.L25). O renewer
    // subclassa OidcTokenRefresher e re-emite a sessão renovada via onSessionRenewed.
    let tokenRefreshFunction:
      | ((rt: string) => Promise<{ accessToken: string; refreshToken?: string }>)
      | undefined
    if (parsed.oidc) {
      // O emissor por refresh também marca a perda ANTES de avisar o app: o Boot chama signOut no
      // mesmo tick, e o disconnect precisa do flag já posto (ADR-059 D2).
      // §8.24 (mitigação defensiva): refresh bem-sucedido → re-query das listas de devices rastreadas.
      const onRenewed = (s: OpaqueSession): void => {
        this.opts.onSessionRenewed?.(s)
        this.markPeerDeviceListsStale()
      }
      const refresher = makeRenewer(parsed, who.device_id ?? '', onRenewed, () => {
        this.sessionLost = true
        this.opts.onSessionLost?.()
      })
      tokenRefreshFunction = (rt) => refresher.doRefreshAccessToken(rt)
    }

    // ADR-068 D2/D3: the public `store` option, with the localStorage the createClient default passes
    // (matrix.ts:129). After each capture, the rooms whose server counts changed get the existing
    // channel.changed — the SDK's UnreadNotifications fired before the capture, with the old value.
    const serverUnread = new ServerUnreadStore(
      { localStorage: globalThis.localStorage },
      guarded('onServerUnread', this.opts.mode, (roomIds: string[]) => {
        for (const roomId of roomIds) {
          const room = this.client?.getRoom(roomId)
          if (room) this.emitChannelChanged(room)
        }
      }),
    )
    this.serverUnread = serverUnread
    const client = createClient({
      baseUrl,
      accessToken,
      refreshToken,
      store: serverUnread,
      tokenRefreshFunction,
      userId: who.user_id,
      deviceId: who.device_id,
      // 4S access is programmatic and UI-free (fatia C2 — PF-1 item 2): whenever the SDK needs
      // the secret-storage key, it reads the bootstrap-memory holder that ensureKeyRecovery
      // populates from the escrow. Outside a recovery pass the holder is empty and the callback
      // answers null — the SDK operation fails quietly and the runner retries later.
      cryptoCallbacks: {
        getSecretStorageKey: async ({ keys }) => {
          const secret = this.recoverySecret
          if (!secret) return null
          const ids = Object.keys(keys)
          if (ids.length === 0) return null
          const def = await this.client?.secretStorage.getDefaultKeyId()
          const id = def !== null && def !== undefined && ids.includes(def) ? def : ids[0]!
          return [id, secret]
        },
        cacheSecretStorageKey: (_keyId, _keyInfo, key) => {
          // bootstrapSecretStorage hands the newly-created key back; keep it for the remaining
          // 4S writes of the SAME pass (the pass's finally clears it).
          this.recoverySecret = key
        },
      },
    })
    this.client = client

    // ADR-059 D1: com o expiry do token conhecido e >= 60 s restantes, o SDK resolve o 401 como
    // logout SEM tentar o refresh (refresh.js) — o emissor do oidc.ts não dispara. O evento é o
    // ponto em que o SDK conclui "a sessão acabou" nos dois braços; traduzido aqui no mesmo
    // onSessionLost payload-free. Emissor burro, sem debounce: a idempotência é do Boot (ADR-035 D3).
    const onLoggedOut = (): void => {
      this.sessionLost = true
      this.opts.onSessionLost?.()
    }
    const gLoggedOut = guarded('onLoggedOut', this.opts.mode, onLoggedOut)
    client.on(HttpApiEvent.SessionLoggedOut, gLoggedOut)
    this.disposers.push(() => client.off(HttpApiEvent.SessionLoggedOut, gLoggedOut))

    // Rust-crypto bootstrap (Fase 2, PF-1 item 1) — BEFORE startClient so the first sync already
    // handles to-device/key traffic. Web path: IndexedDB store (the SDK default, prefix
    // "matrix-js-sdk"); the wasm artifact loads lazily inside the SDK (no top-level await — see
    // PLANO-FASE-2 §9). Node (vitest/integration) has no IndexedDB → memory store, the same
    // regime Fase 0 proved (SS5). Confined here: no crypto option crosses the
    // barrel (createAcl/connect gain no parameter — ADR-015 item 3). Deliberately NO
    // cross-signing/secret-storage/backup bootstrap — that is fatia C/D, gated by PF-2; the
    // happy-path cipher works without them (rust-crypto shares the room key with the room's
    // devices independent of verification).
    const cryptoStoreOpts = typeof indexedDB === 'undefined' ? { useIndexedDB: false } : {}
    try {
      await client.initRustCrypto(cryptoStoreOpts)
    } catch (e) {
      // Resgate de store órfão: se o wipe de uma sessão morta não rodou (parque anterior a este
      // fix) ou falhou, o OlmMachine encontra credenciais de OUTRO device no store e recusa.
      // Fragilidade aceita: a detecção é por substring da mensagem do matrix-sdk-crypto (wasm);
      // se a string mudar upstream, o resgate deixa de disparar e voltamos ao status quo (crash
      // classificado como 'error' no Boot) — nunca a algo pior. Wipe + UM retry; segundo estouro
      // propaga. O client ainda não roda aqui (startClient vem depois), então clearStores não
      // lança por cliente ativo. O boot pós-wipe percorre o fluxo de device novo já existente e
      // coberto (recovery via escrow, gate C2).
      if (!String((e as Error)?.message ?? e).includes("doesn't match the account")) throw e
      await bounded((async () => client.clearStores())(), STORE_WIPE_BOUND_MS, 'store wipe')
      // ADR-074 dec. 7: an orphan crypto store means an earlier session's local state survived; its
      // search index goes with it.
      await bounded(wipeSearchIndexes(who.user_id), STORE_WIPE_BOUND_MS, 'search index wipe')
      await client.initRustCrypto(cryptoStoreOpts)
    }

    // ADR-062 D2 (PLANO-RELEASE-PUBLICA §8.22): identidade de device = conta Olm. Irmão do resgate
    // acima, que cobre store de OUTRO device; aqui é store SEM conta (ou com conta nova) para o MESMO
    // device — o rust-crypto cria conta Olm nova sob o device id antigo e, no primeiro sync, publica
    // identidade nova por cima das OTKs da velha (o `eIrA0ZrBoZ`: todo claim dá InvalidSignature).
    // Antes do startClient o rust-crypto ainda não enviou nada (o keys/upload sai no onSyncCompleted).
    await this.assertDeviceIdentity(client, who.user_id, who.device_id)

    // ADR-074: the search index, loaded from the store in the background (dec. 6). Before the stream
    // is wired, so the first live event already has somewhere to go.
    // Its write transitions (addendum 2026-10-28) join the backfill's progress in search.state; a
    // late one from an index of an earlier session is dropped.
    const search = new SearchIndex(openSearchStore(who.user_id), (writes) => {
      if (this.search === search) this.publishSearchState(writes)
    })
    this.search = search
    this.searchAccount = who.user_id
    this.lastSearchState = undefined

    // Wire the domain stream BEFORE startClient so no live event is missed. Returns the presence
    // handler so it can be re-attached on the raw self User once startClient has minted it (below).
    const onPresence = this.wireEvents(client)

    // Resolve on the first PREPARED sync — after which getRooms()/timelines are populated.
    await new Promise<void>((resolve, reject) => {
      const onSync = (state: SyncState): void => {
        if (state === SyncState.Prepared) {
          client.off(ClientEvent.Sync, onSync)
          resolve()
        }
      }
      client.on(ClientEvent.Sync, onSync)
      // Thread support must be enabled at init (matrix-js-sdk 41.6.0 — it is an IStartClientOpts
      // flag in the pinned lib, NOT a createClient opt). Without it, threaded events collapse into
      // the main timeline and the per-thread split breaks (PLANO-FASE-1-THREADS §6 risk). With it
      // on, the SDK routes thread replies to per-thread timelines while the main timeline stays clean.
      client.startClient({ initialSyncLimit: 30, threadSupport: true }).catch(reject)
    })

    // The SDK's startClient stores a RAW self User (new User(userId), no reEmitter —
    // lib/client.js:531-532), so UserEvent.LastPresenceTs for our own EDUs dies on the
    // instance and never reaches the MatrixClient. Re-attach the same handler directly on
    // the self instance, and drain the state the initial-sync snapshot already wrote to it
    // (setPresenceEvent recorded user.presence before we could listen). onPresence is
    // idempotent via the map diff, so a future upstream fix causing double-fire is benign.
    const selfUser = client.getUser(who.user_id)
    if (selfUser) {
      selfUser.on(UserEvent.LastPresenceTs, onPresence)
      this.disposers.push(() => selfUser.off(UserEvent.LastPresenceTs, onPresence))
      onPresence(undefined, selfUser) // synthetic drain; diff no-ops if snapshot had nothing
    }

    // Attach live listeners (unread + thread tail) to the rooms the initial sync brought in.
    for (const room of client.getRooms()) this.attachRoom(room)

    // §8.24 (mitigação defensiva): de volta de background após mais de 60 s oculto → re-query das
    // listas de devices rastreadas (ver markPeerDeviceListsStale). Só no browser.
    if (typeof document !== 'undefined') {
      let hiddenAt: number | undefined = document.visibilityState === 'hidden' ? Date.now() : undefined
      const onVisibility = (): void => {
        if (document.visibilityState === 'hidden') {
          hiddenAt ??= Date.now()
          return
        }
        const since = hiddenAt
        hiddenAt = undefined
        if (since !== undefined && Date.now() - since > REQUERY_DEVICES_AFTER_HIDDEN_MS) this.markPeerDeviceListsStale()
      }
      document.addEventListener('visibilitychange', onVisibility)
      this.disposers.push(() => document.removeEventListener('visibilitychange', onVisibility))
    }

    // From here on, encrypted events arriving on the timeline are the LIVE tail — their
    // settled decrypts may emit on the stream (§4.3). Initial-sync history settles silently.
    this.live = true

    // ADR-074 dec. 3: the search backfill starts once the client is ready. Not awaited and not
    // `detach`ed (it lives as long as the session); each request it makes is tracked instead.
    if (this.searchBackfill) this.startSearchBackfill(client)

    // Org-channel invite acceptance (ADR-083 dec. 2): fire-and-forget after the first sync, same
    // discipline as the passive detection below. NOT awaited — the connect resolves without it; when
    // the join completes the →join transition emits channel.added and the channel reaches the stream.
    this.detach(this.joinOrgChannel())

    // ADR-091 dec. 10: the rules that keep answers and panels out of the unread count.
    // Fire-and-forget and tolerant: a failure is signalled, never a connect failure.
    this.detach(ensureFoldRules(client, this.opts.telemetry))

    // Passive new-access detection (ADR-018 / D2): fire-and-forget after the first sync. It reads
    // the recognized set from account data BEFORE wiring/scanning (PF-2 cold-start ordering), then
    // watches the own-user device list. NOT awaited — it is a notification, never a login gate.
    this.detach(this.startAccessDetection(client))

    // Custody-backed key recovery (fatia C2 — ADR-013): fire-and-forget AFTER the first sync
    // (bootstrapSecretStorage needs the account-data echo, PF-2 item 1) and NEVER awaited —
    // custody is a hard dependency of history recovery, not of login (§0.2 item 1).
    this.startKeyRecovery(client, accessToken)

    // OIDC cria um device por login SEM display_name (§8.L22). Sem isso a lista de acessos cairia
    // pro id cru (o vazamento de P1 que o deviceToDomain agora recusa). Damos ao device um rótulo
    // neutro de produto. SÓ no caminho OIDC; fire-and-forget e best-effort (não derruba o connect).
    if (parsed.oidc) this.detach(this.nameOidcDeviceIfNameless(client))
  }

  // PLANO-RELEASE-PUBLICA §8.24 — mitigação defensiva, independente da raiz: marca TODOS os usuários
  // rastreados pelo rust-crypto como desatualizados (`markAllTrackedUsersAsDirty`, rust-crypto.js:1746),
  // o que força um keys/query na próxima oportunidade — o fim do próximo sync (onSyncCompleted →
  // outgoing requests) ou o próximo envio cifrado (ensureEncryptionSession dispara o loop de outgoing
  // requests e o ensureSessionsForUsers espera o keys/query em voo, RoomEncryptor.js:198-209). Uma
  // sessão longa que perdeu um `device_lists.changed` volta a aprender os devices do par sem relogar.
  // Custo: um keys/query a mais por gatilho. O método não está no tipo público `CryptoApi` do SDK
  // 41.6.0 (só em CryptoBackend/RustCrypto), daí o acesso estrutural; ausente → no-op. Best-effort:
  // nunca derruba nada, e não age numa sessão perdida (ADR-059 D2: sem rede no teardown).
  private markPeerDeviceListsStale(): void {
    if (this.sessionLost) return
    const crypto = this.client?.getCrypto() as { markAllTrackedUsersAsDirty?: () => Promise<void> } | undefined
    crypto?.markAllTrackedUsersAsDirty?.().catch(() => {})
  }

  // ADR-062 D2: compara a ed25519 da conta Olm local com a que o servidor publica para este device.
  // A query vai ao servidor (downloadKeysForUsers = POST /keys/query cru), nunca ao cache do
  // rust-crypto, que acabou de nascer do mesmo store sob suspeita. Servidor sem chaves → device novo
  // (o primeiro connect após o login), segue; iguais → segue; diferentes → a identidade publicada
  // não é mais alcançável deste store e não há conserto pelo cliente (as OTKs da conta velha seguem
  // no servidor): o device publicado é inalcançável e inútil. Antes do wipe, revoga a sessão no
  // emissor (best-effort com bound, mesmo caminho do signOut — só no caminho OIDC): o MAS encerra a
  // sessão e apaga o device no Synapse, em vez de deixá-lo publicado até o reaper (D3, 30 dias). Os
  // tokens são os do client que o connect acabou de criar. Depois, wipe best-effort e
  // SessionExpiredError → 'revoked' → login frio = device novo.
  // Falha da própria query: rede → ConnectionError (retry no Boot); o resto propaga ('failed').
  // Nunca seguimos sem a resposta — seguir é o que deixa o rust-crypto publicar por cima.
  private async assertDeviceIdentity(client: MatrixClient, userId: string, deviceId: string | undefined): Promise<void> {
    const crypto = client.getCrypto()
    if (!crypto || !deviceId) return
    const own = await crypto.getOwnDeviceKeys()
    const res = await client.downloadKeysForUsers([userId]).catch((e: unknown) => {
      if (isNetworkFailure(e)) throw new ConnectionError()
      throw e
    })
    const published = res.device_keys?.[userId]?.[deviceId]?.keys?.[`ed25519:${deviceId}`]
    if (published === undefined || published === own.ed25519) return
    console.warn('[acl] device identity diverges from the server; ending this access')
    if (this.oidcIssuerRef) {
      await bounded(
        revokeSessionTokens({
          ...this.oidcIssuerRef,
          accessToken: client.getAccessToken() ?? undefined,
          refreshToken: client.getRefreshToken() ?? undefined,
        }),
        REVOKE_BOUND_MS,
        'diverged session revoke',
      )
    }
    await bounded((async () => client.clearStores())(), STORE_WIPE_BOUND_MS, 'store wipe')
    clearAllPendingRecognitions() // §8.38: the local hints die with the session's local state
    await bounded(wipeSearchIndexes(userId), STORE_WIPE_BOUND_MS, 'search index wipe') // ADR-074 dec. 7
    throw new SessionExpiredError()
  }

  // Seta um display_name neutro no device atual quando o login OIDC não trouxe nenhum (§8.L22 / P1).
  // Idempotente: lê o self-device primeiro e só escreve quando o nome está ausente — um reload não
  // re-seta. Confinado em acl/internal (nenhum termo cruza o barrel); rótulo é vocabulário de produto.
  private async nameOidcDeviceIfNameless(client: MatrixClient): Promise<void> {
    const NEUTRAL_DEVICE_LABEL = 'Tayet · navegador'
    try {
      const myDeviceId = client.getDeviceId()
      if (!myDeviceId) return
      const own = (await client.getDevices()).devices.find((d) => d.device_id === myDeviceId)
      if (!this.client) return // disconnected during the await
      if (own && (own.display_name ?? '').trim() !== '') return // já tem nome → não re-seta
      await client.setDeviceDetails(myDeviceId, { display_name: NEUTRAL_DEVICE_LABEL })
    } catch {
      // best-effort: nomear o device é higiene de UX, não pré-requisito do login (como startKeyRecovery)
    }
  }

  // Reads the escrow URL from the environment — the same channel the app's bootstrap URLs live
  // in (VITE_SERVER_URL; PF-2 item 4): AclOptions is a barrel type and this slice is
  // contract-zero. Without the env the escrow is NOT provisioned and the behavior is exactly
  // fatia A's (no bootstrap, no retry loop) — the existing suites prove that by construction.
  private static escrowUrlFromEnv(): string | undefined {
    const vite = (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_ESCROW_URL
    const node = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
      ?.TAYET_ESCROW_URL
    // Precedência node-first: no browser o node (TAYET_ESCROW_URL) é sempre undefined → cai no vite
    // (/escrow, proxy same-origin). Nos gates o harness seta o node → vence, apontando pro escrow
    // efêmero. Sem essa ordem o vite=/escrow do .env sombra o override de teste e o escrow fica
    // inalcançável sob jsdom (o canal node seria dead code). #7 PR2.
    return node ?? vite ?? undefined
  }

  private startKeyRecovery(client: MatrixClient, accessToken: string): void {
    const escrowUrl = MatrixGateway.escrowUrlFromEnv()
    const crypto = client.getCrypto()
    if (escrowUrl) {
      this.people = createPeopleClient({ baseUrl: escrowUrl, token: () => client.getAccessToken() ?? accessToken })
    }
    if (!escrowUrl || !crypto) return
    const escrow = createEscrowClient({ baseUrl: escrowUrl, token: () => client.getAccessToken() ?? accessToken })
    this.escrow = escrow
    // ADR-057 dec. 6/7: o desfecho da consulta à custódia de sessão. Sucesso materializa o conjunto
    // do veredito (união através de passes — re-consulta só acrescenta, e um veredito já ganho não
    // é revogado por falha posterior); falha vira sinal nomeado na telemetria existente, TODA vez
    // (cada consulta perdida é um adiamento real do veredito — mesma lição de verbosidade do sinal
    // `deferred` do F11).
    const custodyPorts: CustodyConsultPorts = {
      crypto,
      escrow,
      onCustodySessions: (outcome) => {
        if (outcome.kind === 'unavailable') {
          this.signalUncovered(CUSTODY_SIGNAL_SESSIONS_UNAVAILABLE)
          return
        }
        const set = this.custodyImportedSessions ?? new Set<string>()
        for (const id of outcome.sessionIds) set.add(id)
        this.custodyImportedSessions = set
      },
    }
    // ADR-077: "consulta só" (consultCustody direto — não re-roda o pass: nem o checkKeyBackupAndEnable
    // do ramo warm, nem um cold que ainda está em retry no runner). ADR-059 D2: nada de rede numa
    // sessão perdida ou já desconectada.
    this.custodyReconsult = new CustodyReconsult({
      consult: async () => {
        if (this.client !== client || this.sessionLost) return
        await consultCustody(custodyPorts)
      },
      imported: (sessionId) => this.custodyImportedSessions?.has(sessionId) === true,
      pending: (sessionId) => this.undecryptableOf(new Set([sessionId])).length > 0,
      retryDecryption: (sessionIds) => {
        if (this.client !== client || this.sessionLost) return
        this.retryDecryption(new Set(sessionIds))
      },
    })
    const run = (attempt: number): Promise<RecoveryOutcome> =>
      ensureKeyRecovery(
        {
          crypto,
          getDefaultKeyId: () => client.secretStorage.getDefaultKeyId(),
          // ADR-061 D2: ausência PROVADA — segredo fora do 4S, ou M_NOT_FOUND da versão corrente.
          // Não usa crypto.getKeyBackupInfo(): ele devolve null também quando a checagem falha.
          probeBackup: async () => {
            if (!(await client.secretStorage.isStored('m.megolm_backup.v1'))) return 'absent'
            try {
              await client.http.authedRequest(Method.Get, '/room_keys/version', undefined, undefined, {
                prefix: ClientPrefix.V3,
              })
              return 'present'
            } catch (e) {
              if (e instanceof MatrixError && e.errcode === 'M_NOT_FOUND') return 'absent'
              throw e
            }
          },
          onBackupStepFailed: (step) => this.signalUncovered(`${RECOVERY_SIGNAL_BACKUP_STEP_FAILED}.${step}`),
          ensureOwnIdentity: async () => {
            // The tracked-user branch of userHasCrossSigningKeys runs a /keys/query through the
            // OlmMachine (ingested), making our own master/self-signing PUBLIC keys available to
            // the private-key import of the recovery branch. The boolean is irrelevant here.
            await crypto.userHasCrossSigningKeys(client.getUserId() ?? undefined, true)
          },
          storedIdentity: () => this.storedIdentity(client),
          escrow,
          setSecret: (s) => {
            this.recoverySecret = s
          },
          clearSecret: () => {
            this.recoverySecret = undefined
          },
          onCustodySessions: custodyPorts.onCustodySessions,
        },
        attempt,
      )
    this.recoveryRun = run
    // ADR-019 §1: when the background pass hits the MSC3967 UIA wall it cannot drive, the runner
    // raises the actionable device.attention for the current session (defaults preserve the C2
    // backoff hygiene; only the emitter is injected).
    this.recoveryRunner = new RecoveryRunner(run, undefined, undefined, () => this.detach(this.emitDeviceAttention()))
    this.recoveryRunner.start()
  }

  // Raise device.attention for the CURRENT session (ADR-019 §1): the recovery path needs an
  // interactive reset the background cannot perform. The Device names the session that needs the
  // user; its friendlyName follows accessDeviceToDomain (empty when MAS has no display name) so the
  // opaque device id never surfaces as a "name" — the actionable copy ("esta sessão precisa de
  // você") is generic. Best-effort lookup; a minimal Device if the device list is unreachable.
  private async emitDeviceAttention(): Promise<void> {
    const client = this.client
    const myDeviceId = client?.getDeviceId()
    if (!client || !myDeviceId) return
    let device: Device
    try {
      const own = (await client.getDevices()).devices.find((d) => d.device_id === myDeviceId)
      device = own ? accessDeviceToDomain(own) : { id: myDeviceId as Device['id'], friendlyName: '', current: false }
    } catch {
      device = { id: myDeviceId as Device['id'], friendlyName: '', current: false }
    }
    if (!this.client) return // disconnected during the await
    this.emit({ t: 'device.attention', device })
  }

  // ACL-internal (NOT on the barrel): re-runs the recovery pass on demand and reports the
  // outcome. The integration gate uses it for the warm=cold proof (§5.2 assert 3 — second pass
  // is a no-op, observed externally as a silent escrow audit); a future app-resume hook can
  // reuse it. 'unprovisioned' = no escrow configured for this session.
  async recheckKeyRecovery(): Promise<RecoveryOutcome | 'unprovisioned'> {
    // attempt 0: an on-demand pass has wait-first semantics — it never claims by itself.
    return this.recoveryRun ? this.recoveryRun(0) : 'unprovisioned'
  }

  // ADR-077 dec. 3: os eventos entregues à UI como `unavailable` (unavailableEmitted), ainda não
  // decifrados, cuja sessão Megolm está no conjunto. Só eles: a re-decifragem e o "ainda pendente"
  // da re-consulta não varrem o histórico inteiro.
  private undecryptableOf(sessionIds: ReadonlySet<string>): MatrixEvent[] {
    const client = this.client
    if (!client || this.unavailableEmitted.size === 0) return []
    const rooms = client.getRooms()
    const found: MatrixEvent[] = []
    for (const realId of this.unavailableEmitted.keys()) {
      for (const room of rooms) {
        const ev = room.findEventById(realId)
        if (!ev) continue
        const sessionId = (ev.getWireContent() as { session_id?: unknown }).session_id
        if (ev.isDecryptionFailure() && typeof sessionId === 'string' && sessionIds.has(sessionId)) found.push(ev)
        break
      }
    }
    return found
  }

  // ADR-077 dec. 3: re-decifra os eventos pendentes das sessões — `MatrixEvent.attemptDecryption`
  // com `isRetry` (o mesmo que o rust-crypto faz em onRoomKeyUpdated; decryptEventIfNeeded não
  // serve: um evento que falhou já tem clearEvent e shouldAttemptDecryption dá false). A nova falha
  // re-entra no downloader por sessão do backup (o GET que o 404 do primeiro pass encerrou); o
  // desfecho volta pelo Decrypted de sempre (upgrade via message.edited, ou o grau honesto).
  // attemptDecryption pede o CryptoBackend, que o tipo público CryptoApi não expõe no SDK 41.6.0
  // (RustCrypto é os dois) — daí o acesso estrutural.
  private retryDecryption(sessionIds: ReadonlySet<string>): void {
    const backend = this.client?.getCrypto() as unknown as Parameters<MatrixEvent['attemptDecryption']>[0] | undefined
    if (!backend) return
    for (const ev of this.undecryptableOf(sessionIds)) {
      ev.attemptDecryption(backend, { isRetry: true }).catch(() => {})
    }
  }

  // ── Reset sob custódia (ADR-019 §2, ADR-082) ───────────────────────────────────────────────
  // The barrel verb. Total, re-entrant, fail-closed: builds the SDK-backed ResetPorts and hands
  // the orchestration to key-reset (which observes the world and resumes). The approval window and
  // the rotate/4S mess stay here, inside acl/internal; only the neutral ResetOutcome crosses. Runs
  // synchronously up to the first await of key-reset, which is what keeps window.open in the gesture.
  async resetAccess(): Promise<ResetOutcome> {
    return runReset(this.buildResetPorts())
  }

  // ADR-082 dec. 1: tells "no approval" from "approval in hand" without consuming it. A body that
  // differs from the stored keys goes through the authorization, and without the approval the server
  // answers the 401 with the flows; with it, the server moves on to validate the key and rejects this
  // empty one with a 400, so nothing is stored and the approval survives. Depends on that order
  // inside the server: test/integration/reset-approval-probe.test.ts pins it. Anything else (a blip)
  // reads as "not yet".
  private async approvalGranted(client: MatrixClient): Promise<boolean> {
    try {
      await client.http.authedRequest(Method.Post, '/keys/device_signing/upload', undefined, { master_key: {} }, {
        prefix: ClientPrefix.V3,
      })
      return false
    } catch (e) {
      return e instanceof MatrixError && e.httpStatus === 400
    }
  }

  // The approval URL comes from the issuer's metadata and goes only to the window, never to the DOM
  // of the app. Blank window first: it has to exist inside the gesture, and the URL needs the network.
  private openApprovalWindow(): ResetApproval {
    const popup = globalThis.window?.open?.('about:blank', '_blank', APPROVAL_WINDOW_FEATURES) ?? null
    const close = (): void => {
      if (popup && !popup.closed) popup.close()
    }
    const wait = async (): Promise<boolean> => {
      const client = this.require()
      if (await this.approvalGranted(client)) return true
      if (!popup || popup.closed) return false
      const manage = (await client.getAuthMetadata()).account_management_uri
      if (!manage) return false
      const url = new URL(manage)
      url.searchParams.set('action', APPROVAL_ACTION)
      popup.location.href = url.href
      const deadline = Date.now() + APPROVAL_TIMEOUT_MS
      while (this.client === client && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, APPROVAL_POLL_MS))
        // Read before the probe: the approval may land in the same beat the window closes.
        const closed = popup.closed
        if (await this.approvalGranted(client)) return true
        if (closed) return false
      }
      return false
    }
    return { wait, close }
  }

  // ADR-082 dec. 2. Runs with the custodied secret in the holder. The two sides: the public key
  // derived from the master in 4S, and the server identity (a query, not the local cache). The query
  // failing propagates (a retry for the recovery, a non-conclusion for the reset), never a half-state.
  private async storedIdentity(client: MatrixClient): Promise<StoredIdentity> {
    const userId = client.getSafeUserId()
    const res = await client.downloadKeysForUsers([userId])
    const server = Object.values(res.master_keys?.[userId]?.keys ?? {})[0]
    let stored: string | undefined
    try {
      stored = await client.secretStorage.get('m.cross_signing.master')
    } catch {
      return 'unreadable'
    }
    if (stored === undefined) return 'unreadable'
    const derived = await ed25519PublicOf(stored)
    return derived === undefined ? 'same' : compareIdentity(derived, server)
  }

  private buildResetPorts(): ResetPorts {
    return {
      // observeReset() short-circuits to 'unreachable' when custody is absent, so the stub is never
      // dereferenced — it only keeps the port total when no escrow is provisioned.
      escrow: this.escrow ?? UNAVAILABLE_ESCROW,
      openApproval: () => this.openApprovalWindow(),
      observe: () => this.observeReset(),
      generateSecret: () => crypto.getRandomValues(new Uint8Array(32)),
      recreate4S: async (secret) => {
        // A new descriptor, never the one of the burned secret (ADR-082 dec. 5). What this device
        // holds goes into it, so a stop right after this is still a consistent world.
        await this.requireCrypto().bootstrapSecretStorage({
          createSecretStorageKey: () => Promise.resolve({ privateKey: secret }),
          setupNewSecretStorage: true,
          setupNewKeyBackup: false,
        })
      },
      resetIdentity: async () => {
        // Replace the cross-signing identity. The approval is already confirmed (ADR-082 dec. 1), so
        // the upload needs no auth; a virgin upload never did. The first accepted upload consumes it.
        await this.requireCrypto().bootstrapCrossSigning({
          setupNewCrossSigning: true,
          authUploadDeviceSigningKeys: async (makeRequest) => makeRequest(null),
        })
      },
      resetBackup: () => this.requireCrypto().resetKeyBackup(),
      adoptWorld: async () => {
        // Recovery branch (no new identity, no burn): force our own public identity in, import the
        // cross-signing private keys from the custodied 4S, then enable the backup engine.
        const crypto = this.requireCrypto()
        const client = this.require()
        await crypto.userHasCrossSigningKeys(client.getUserId() ?? undefined, true)
        await crypto.bootstrapCrossSigning({})
        await crypto.loadSessionBackupPrivateKeyFromSecretStorage()
        await crypto.checkKeyBackupAndEnable()
      },
      restoreHistory: async () => {
        // Best-effort, never re-encrypts (perda honesta — ADR-019 §4). `historyPreserved` is honest:
        // true only when the backup that existed gave keys back; nothing to restore or a failure
        // (a half-state's backup key is out of reach of the current secret) is false.
        try {
          const crypto = this.requireCrypto()
          await crypto.loadSessionBackupPrivateKeyFromSecretStorage()
          return (await crypto.restoreKeyBackup()).total > 0
        } catch {
          return false
        }
      },
      raiseAttention: () => this.detach(this.emitDeviceAttention()),
      setSecret: (s) => {
        this.recoverySecret = s
      },
      clearSecret: () => {
        this.recoverySecret = undefined
      },
    }
  }

  // Decide the resume point (key-reset's re-entrancy input) from the live world: custody reachability
  // + cross-signing status (does this device hold a healthy identity?) + 4S presence + the identity
  // in 4S against the server (ADR-082 dec. 2). phaseOf holds the table.
  private async observeReset(): Promise<ResetPhase> {
    const client = this.client
    const crypto = client?.getCrypto()
    const escrow = this.escrow
    if (!client || !crypto || !escrow) return { kind: 'unreachable' }
    try {
      // An authed request first: the custody takes the token as it is, and only the homeserver path
      // refreshes an expired one (the session-long token lasts minutes in production).
      await client.whoami()
      const retrieved = await escrow.retrieve()
      if (retrieved.kind === 'unavailable') return { kind: 'unreachable' }
      if (retrieved.kind === 'none') return { kind: 'fresh' } // nothing custodied → deposit + build
      const { secret, etag } = retrieved
      const has4S = (await client.secretStorage.getDefaultKeyId()) !== null
      const cs = (await crypto.getCrossSigningStatus()).privateKeysCachedLocally
      this.recoverySecret = secret
      try {
        return phaseOf({
          secret,
          etag,
          has4S,
          crossSigningCached: cs.masterKey && cs.selfSigningKey && cs.userSigningKey,
          identity: has4S ? await this.storedIdentity(client) : 'unreadable',
        })
      } finally {
        this.recoverySecret = undefined
      }
    } catch {
      return { kind: 'unreachable' }
    }
  }

  private requireCrypto(): NonNullable<ReturnType<MatrixClient['getCrypto']>> {
    const crypto = this.require().getCrypto()
    if (!crypto) throw new Error('ACL: crypto not initialized')
    return crypto
  }

  // Per-room live listeners (idempotent). Two concerns:
  //  - unread badge stays live (server counts) → channel.changed;
  //  - live per-thread tail (PLANO-FASE-1-THREADS §2.4): ThreadEvent.NewReply fires for each reply
  //    (including the first, which the SDK seeds via createThread→addEvent). It is emitted on the
  //    ROOM — the MatrixClient does NOT re-emit it on its own typed surface in 41.6.0 — so we
  //    attach per-room here. Each reply → message.received with threadParent populated
  //    (eventToMessage reads the m.thread relation). This stream is the ONLY live source for the
  //    thread tail; getTimeline({thread}) is scrollback only, mirroring §1.3 per-thread.
  private attachRoom(room: Room): void {
    if (this.roomWired.has(room)) return
    this.roomWired.add(room)
    // ADR-068: the channel count is read from the ServerUnreadStore, which captures AFTER this fires —
    // so on a sync this emission still carries the previous count, and the store's own channel.changed
    // follows with the new one. It stays for the SDK's local recounts (an encrypted room's decrypts).
    const onUnread = (): void => this.emitChannelChanged(room)
    const onThreadReply = (thread: Thread, event: MatrixEvent): void => {
      // Guard: a Thread re-emit can fire during/after teardown; never touch the SDK once
      // disconnected (require()/ctx() would throw 'ACL not connected').
      if (!this.client) return
      // Encrypted reply still decrypting → defer to the settled-decrypt path (§4.3). NewReply
      // does NOT re-fire after decryption, so the Decrypted handler is the one that emits it
      // (threadParent comes from the envelope relation — PF-1 item 3).
      if (event.isEncrypted() && (event.isBeingDecrypted() || event.shouldAttemptDecryption())) {
        const id = event.getId()
        if (id && this.live) this.pendingDecrypt.add(id)
        return
      }
      // Our own attachment echo, as in onTimeline: the local-ref bubble emitted by the send stays
      // authoritative for the session and settles via message.status only.
      const ownTxn = event.getTxnId()
      if (ownTxn && this.localEchoTxns.has(ownTxn)) return
      // ADR-091: an answer to a card in a thread lives in the thread's timeline; it folds the same.
      if (this.routeFolded(event, thread.room)) return
      const ctx = this.ctx(thread.room)
      const msg = eventToMessage(event, ctx)
      if (msg) this.emitReceivedTracked(msg, event)
    }
    // ADR-066: the root's thread summary follows the SDK's Thread — a new reply (NewReply, emitted
    // after the reply above) or a metadata change (Update: initial fetch, pending→sent, redaction).
    // An encrypted reply still decrypting counts already (the relation is cleartext), so the root
    // is refreshed before the reply's own deferred emission.
    const onThreadChanged = (thread: Thread): void => {
      if (!this.client) return
      this.emitThreadRootChanged(thread)
    }
    // ADR-067 dec. 3: a receipt of MINE (read on another device, by sync; or our own markRead echo)
    // changes getThreadUnread. UnreadNotifications does not cover it: the sync emits it while applying
    // the counts (sync.ts resetThreadUnreadNotificationCountFromSync), BEFORE the room's ephemeral
    // receipts are added (room.addEphemeralEvents) — a re-read on that tick sees the old receipt.
    // Room.addReceipt emits Receipt after its structures are updated, so this re-read is current.
    const onReceipt = (event: MatrixEvent): void => {
      const me = this.client?.getUserId()
      if (!me) return
      const content = event.getContent<Record<string, Record<string, Record<string, unknown>>>>()
      const mine = Object.values(content).some((byType) =>
        Object.values(byType ?? {}).some((byUser) => !!byUser && Object.hasOwn(byUser, me)),
      )
      if (mine) this.emitChannelChanged(room)
    }
    const gUnread = guarded('onUnread', this.opts.mode, onUnread)
    const gReceipt = guarded('onReceipt', this.opts.mode, onReceipt)
    const gThreadReply = guarded('onThreadReply', this.opts.mode, onThreadReply)
    const gThreadChanged = guarded('onThreadChanged', this.opts.mode, onThreadChanged)
    const gOwnEcho = guarded('onOwnEcho', this.opts.mode, (_thread: Thread, event: MatrixEvent) => this.onOwnEcho(event))
    room.on(RoomEvent.UnreadNotifications, gUnread)
    room.on(RoomEvent.Receipt, gReceipt)
    room.on(ThreadEvent.NewReply, gThreadReply)
    room.on(ThreadEvent.NewReply, gThreadChanged)
    room.on(ThreadEvent.NewReply, gOwnEcho)
    room.on(ThreadEvent.Update, gThreadChanged)
    this.disposers.push(() => {
      room.off(RoomEvent.UnreadNotifications, gUnread)
      room.off(RoomEvent.Receipt, gReceipt)
      room.off(ThreadEvent.NewReply, gThreadReply)
      room.off(ThreadEvent.NewReply, gThreadChanged)
      room.off(ThreadEvent.NewReply, gOwnEcho)
      room.off(ThreadEvent.Update, gThreadChanged)
    })
  }

  // ADR-066: re-derive a thread ROOT and emit it as message.edited (the "message changed in place"
  // machine, ADR-015 precedent — no new DomainEvent) when its summary changed. editedAt is the
  // root's own, so no "(edited)" appears. The root may be outside what the UI loaded; consumers
  // apply message.edited in place and never insert it. Deduped per root on the summary value.
  private emitThreadRootChanged(thread: Thread): void {
    const room = thread.room
    const root = thread.rootEvent ?? room.findEventById(thread.id)
    if (!root) return
    const msg = eventToMessage(root, this.ctx(room))
    if (!msg) return
    const key = msg.threadSummary ? `${msg.threadSummary.replyCount}:${msg.threadSummary.latestReplyAt}` : ''
    if (this.threadSummaryEmitted.get(thread.id) === key) return
    this.threadSummaryEmitted.set(thread.id, key)
    this.emit({ t: 'message.edited', channelId: msg.channelId, message: msg })
  }

  // Translate SDK events → DomainEvent and multicast. Every branch either emits branded
  // domain or silently drops protocol noise (typing/presence/state) — ADR-007 §5.
  // Returns the presence handler so connect() can re-attach it on the raw self User (which the
  // SDK creates without a reEmitter — see the connect() block after the Prepared sync).
  private wireEvents(client: MatrixClient): (event: MatrixEvent | undefined, user: SdkUser) => void {
    // Live timeline tail: new messages + edits. Backfill (toStartOfTimeline) and non-live
    // events are ignored — scrollback is getTimeline's job (commit 11), not the stream.
    const onTimeline = (
      event: MatrixEvent,
      room: Room | undefined,
      toStartOfTimeline?: boolean,
      _removed?: boolean,
      data?: IRoomTimelineData,
    ): void => {
      if (!this.client || !room) return
      // Before the live-only filter: a Thread fills from /relations with non-live insertions (§8.37).
      this.settleReadTarget(event, room)
      if (toStartOfTimeline || data?.liveEvent === false) return
      // A3-5: an edit of a panel (A4-1: or of a commands manifest), read or not (its relation is in clear)
      // — before the decrypt deferral below, which a settled failure skips.
      this.noteAnchoredEdit(event, room)
      // Reactions (m.reaction / m.annotation) → reaction.changed carrying the new aggregate.
      if (event.getType() === 'm.reaction') {
        const rel = event.getRelation()
        if (rel?.rel_type === RelationType.Annotation && rel.event_id) {
          const reactionId = event.getId()
          if (reactionId) this.reactionTargets.set(reactionId, rel.event_id)
          this.emitReactionChanged(room, rel.event_id)
        }
        return
      }
      // Encrypted event still decrypting (PLANO-FASE-2 §4.3): NEVER emit from the raw
      // m.room.encrypted — the common case decrypts near-instantly and an early emission would
      // flash a placeholder for every message. Register and defer: the client-level Decrypted
      // re-emit (wired below) routes it when the decrypt SETTLES (success → message.received
      // normal; failure → message.received with `unavailable`). Our OWN echo never lands here:
      // makeEncrypted retains the plaintext clearEvent (PF-1 item 4), so it falls through with
      // the clear type as before. Settled events (clearEvent present) also fall through —
      // a settled FAILURE is translated to `unavailable` by eventToMessage.
      if (event.isEncrypted() && (event.isBeingDecrypted() || event.shouldAttemptDecryption())) {
        const realId = event.getId()
        if (realId && this.live) this.pendingDecrypt.add(realId)
        return
      }
      // Local echoes (our own in-flight sends) carry a non-null status and ARE emitted now —
      // as message.received with status 'pending' (ADR-010 optimistic echo). The stable id
      // (txn) keeps it consistent with the later sent/received view.
      if (event.getType() !== 'm.room.message') return // state events: noise
      // Suppress the SDK re-emit of our own optimistic ATTACHMENT echo. We already emitted
      // message.received with the LOCAL preview in sendMessage; skipping here (both the pending and
      // the settled remote echo) keeps that local-ref bubble authoritative for the session — the
      // bubble settles via message.status only (decision (a)). Text echoes are not in this set.
      const ownTxn = event.getTxnId()
      if (ownTxn && this.localEchoTxns.has(ownTxn)) return
      // ADR-091: an answer folds into its card (message.edited of the card), a panel is dropped.
      if (this.routeFolded(event, room)) return
      const ctx = this.ctx(room)
      const content = event.getContent() as Record<string, unknown>
      const relates = content['m.relates_to'] as { rel_type?: string; event_id?: string } | undefined
      if (relates?.rel_type === 'm.replace' && relates.event_id) {
        this.routeLiveEdit(event, room, relates.event_id, ctx)
        return
      }
      // Thread replies arrive via the per-thread stream (ThreadEvent.NewReply, attached per-room),
      // NOT the main timeline — even though the SDK re-emits RoomEvent.Timeline from the thread
      // timelineSet (verified against 41.6.0). The ONE exception is our OWN optimistic echo into a
      // thread (ADR-010×threads): the SDK only routes an echo to a thread once that thread exists,
      // so the FIRST reply to a root is echoed on the MAIN timeline. Without this branch its
      // pending bubble would never reach the thread. We emit it as message.received with
      // threadParent populated → useChat routes it into the thread sub-slice. The stable MessageId
      // (the txn id) is preserved, so when the send settles (via NewReply) the bubble reconciles in
      // place — the UI never reconciles txn↔event (that is the ACL's job). Remote/settled replies
      // (status not pending) are skipped here and handled by NewReply (deduped by stable id).
      if (relates?.rel_type === 'm.thread') {
        const echo = eventToMessage(event, ctx)
        if (echo?.status === 'pending')
          this.emit({ t: 'message.received', channelId: echo.channelId, message: echo })
        return
      }
      const msg = eventToMessage(event, ctx)
      if (msg) this.emitReceivedTracked(msg, event)
    }

    // Settled decrypts of LIVE-tail events (PLANO-FASE-2 §4.3). The event-mapper re-emits
    // MatrixEventEvent.Decrypted on the client for every encrypted event it maps (PF-1 item 2),
    // so ONE client-level listener covers the whole live stream. Only events previously seen on
    // the live tail (pendingDecrypt) or previously surfaced as `unavailable` are routed —
    // historical/scrollback decrypts settle inside getTimeline and are not the stream's business.
    const onDecrypted = (event: MatrixEvent): void => {
      if (!this.client) return
      const realId = event.getId()
      const roomId = event.getRoomId()
      const room = roomId ? this.client.getRoom(roomId) : null
      if (!realId || !room) return
      const wasPending = this.pendingDecrypt.delete(realId)
      const upgradeStableId = this.unavailableEmitted.get(realId)
      if (!wasPending && upgradeStableId === undefined) {
        this.noteAnchoredDecrypt(event, room)
        return
      }
      // ADR-091 dec. 9: an answer settles its card either way — without the option on failure (kept
      // pending, so the late decrypt routes it again and the card gains the option), with it on success.
      if (this.routeFolded(event, room)) {
        if (event.isDecryptionFailure()) this.pendingDecrypt.add(realId)
        return
      }
      const ctx = this.ctx(room)
      if (event.isDecryptionFailure()) {
        // A3-5: an unreadable edit of a held panel (A4-1: or manifest) takes it off until it decrypts (no read).
        this.noteAnchoredFailure(event, room)
        // Settled in failure → message.received with `unavailable` (eventToMessage translates;
        // a failed m.replace is silently dropped there — P4). Re-failure of an already-surfaced
        // unavailable changes nothing, except the move to `lost` (ADR-077, below).
        if (upgradeStableId === undefined) {
          const msg = eventToMessage(event, ctx)
          if (msg) this.emitReceivedTracked(msg, event)
          // A silently-dropped failure (an unreadable m.replace) still OWES its routing: keep it
          // pending so a later successful decrypt applies the edit to its target.
          else this.pendingDecrypt.add(realId)
          return
        }
        // ADR-077 dec. 6: the re-failure after the LAST custody re-consult settles the honest
        // grade — only the move to `lost` is re-emitted (message.edited under the same stable id;
        // the notifier already treats an unavailable edit as "only the grade moved"). Earlier
        // re-failures keep "Waiting for message…" and emit nothing.
        const regraded = eventToMessage(event, ctx)
        if (regraded?.body.kind === 'unavailable' && regraded.body.arrival === 'lost') {
          this.emit({ t: 'message.edited', channelId: regraded.channelId, message: regraded })
        }
        return
      }
      // Decrypt settled in SUCCESS.
      if (upgradeStableId !== undefined) {
        // Late decrypt (key arrived after we surfaced `unavailable`): UPGRADE via the existing
        // message.edited machine under the SAME stable id (ADR-015 item 1 — zero new mechanism;
        // the UI already reconciles message.edited in place).
        this.unavailableEmitted.delete(realId)
        const content = event.getContent() as Record<string, unknown>
        const relates = content['m.relates_to'] as { rel_type?: string; event_id?: string } | undefined
        if (relates?.rel_type === 'm.replace' && relates.event_id) {
          // The unreadable event turned out to be an edit: apply it to its target now.
          this.routeLiveEdit(event, room, relates.event_id, ctx)
          return
        }
        const msg = eventToMessage(event, ctx)
        if (msg) this.emit({ t: 'message.edited', channelId: msg.channelId, message: msg })
        return
      }
      // First settle of a deferred live event → route exactly like a live timeline message:
      // m.replace applies to its target; everything else (incl. thread replies, which NewReply
      // dropped while encrypted) is a message.received.
      const content = event.getContent() as Record<string, unknown>
      const relates = content['m.relates_to'] as { rel_type?: string; event_id?: string } | undefined
      if (relates?.rel_type === 'm.replace' && relates.event_id) {
        this.routeLiveEdit(event, room, relates.event_id, ctx)
        return
      }
      const msg = eventToMessage(event, ctx)
      if (msg) this.emitReceivedTracked(msg, event)
    }

    // Local-echo status transitions (sent/failed) for our own optimistic messages (ADR-010).
    // `null` is terminal too: when the remote echo arrives via /sync BEFORE the PUT /send
    // resolves, the SDK reconciles it (room.handleRemoteEcho → setStatus(null), "successfully
    // sent") and emits LocalEchoUpdated with status null — SENT never fires for that event. The
    // attachment echo is suppressed in the timeline (localEchoTxns), so this is its only settle.
    // When the PUT won the race (oldStatus SENT), 'sent' was already emitted — skip the repeat.
    const onLocalEcho = (
      event: MatrixEvent,
      room: Room,
      _oldEventId?: string,
      oldStatus?: EventStatus | null,
    ): void => {
      // The echo of our own redaction (deleteMessage, ADR-075) is no message: its txn names nothing
      // the UI holds.
      if (event.getType() === EventType.RoomRedaction) return
      // Nor is the echo of our own answer to a card (A3-2): it folds into the card, never a line.
      // Our own form submission reaches the reply rule here: the SDK reconciles the server's echo into the
      // local one (status null, server id and instant) without a timeline event.
      if (foldedKind(event) !== undefined) {
        if (foldedKind(event) === 'form' && event.status === null && hasServerId(event)) this.noteForm(event, room)
        return
      }
      const status =
        event.status === EventStatus.SENT || (event.status === null && oldStatus !== EventStatus.SENT)
          ? 'sent'
          : event.status === EventStatus.NOT_SENT
            ? 'failed'
            : undefined
      if (!status) return // still pending (SENDING/QUEUED/ENCRYPTING/CANCELLED)
      this.emit({
        t: 'message.status',
        channelId: brandChannelId(room.roomId),
        messageId: brandMessageId(stableMessageId(event)),
        status,
      })
    }

    // Redaction → nothing for the redaction of one's own edit (it carries EDIT_REDACTION_FIELD: deleteMessage
    // already removed the message, ADR-075 addendum), else reaction.changed (if a reaction was removed), else
    // message.removed.
    const onRedaction = (event: MatrixEvent, room: Room): void => {
      if (event.getContent()[EDIT_REDACTION_FIELD] === true) return
      const targetId = event.getAssociatedId()
      if (!targetId) return
      // Was the redacted event a reaction? Route to a decrement, not a message removal.
      const reactionTarget =
        this.reactionTargets.get(targetId) ??
        (room.findEventById(targetId)?.getType() === 'm.reaction'
          ? (room.findEventById(targetId)?.getRelation()?.event_id ?? undefined)
          : undefined)
      if (reactionTarget) {
        this.reactionTargets.delete(targetId)
        this.emitReactionChanged(room, reactionTarget)
        return
      }
      // ADR-091 dec. 8: a deleted answer leaves its card's answers (the next valid one takes over);
      // it was never a message, so there is nothing to remove.
      if (this.approvals.forgetAnswer(targetId)) return
      // A3-5: a removed panel (or edit of one) leaves its conversation's panels; it was never a message.
      // A4-1: the same for a commands manifest.
      for (const { agg } of this.anchored) {
        const anchoredRoom = agg.watches(targetId)
        if (anchoredRoom !== undefined) {
          agg.invalidate(anchoredRoom)
          return
        }
      }
      this.emit({
        t: 'message.removed',
        channelId: brandChannelId(room.roomId),
        messageId: brandMessageId(targetId),
      })
    }

    // Channel metadata: rename + newly-known room.
    const onName = (room: Room): void => this.emitChannelChanged(room)
    const onRoom = (room: Room): void => {
      this.attachRoom(room)
      this.emitChannelChanged(room)
    }

    // Membership/role changes (join/leave/role). role=null means no longer a member.
    const onMembers = (_event: MatrixEvent, _state: RoomState, member: RoomMember): void => {
      // Choke point irmão do filtro de getMembers (ADR-057 dec. 2): a entrada e o join do cofre
      // acontecem no nascimento de TODA sala cifrada, então sem este guard cada canal criado
      // emitiria member.changed de um membro que a UI não pode nem nomear.
      // ADR-083 dec. 5: a conta de sistema passa pelo mesmo guard, uma entrada para cada conta.
      if (this.isCustodian(member.userId) || this.isSystemAccount(member.userId)) {
        // ADR-112 dec. 3: the repair sees the custody enter here, before the guard drops the event.
        if (this.custodyRepairs.has(member.roomId)) this.detach(this.discardOnceRepaired(member.roomId))
        return
      }
      this.reviewHeldGroupRoom(member.roomId)
      // A3-5: an agent joining, leaving or renamed moves the conversation's panels (filter and order);
      // A4-1: and its commands.
      if (this.isAgentAccount(member.userId)) for (const { agg } of this.anchored) agg.recompute(member.roomId)
      // ADR-083: a guest is never in #all, so their pending line lives on a channel shared with this session.
      const org = this.joinedOrgChannel()
      if (
        member.roomId === org?.roomId ||
        isOutsideOrgKind(org?.currentState.getStateEvents(ORG_MEMBER_EVENT, member.userId.slice(1))?.getContent().kind)
      ) {
        this.emit({ t: 'people.changed' })
      }
      const role = member.membership === 'join' ? roleOf(member.powerLevel, this.kindOf(member.userId)) : null
      this.emit({
        t: 'member.changed',
        channelId: brandChannelId(member.roomId),
        user: brandUserId(member.userId),
        role,
      })
      // PLANO-PRESENCA §8.6 item 3: a member event of a DM's PEER re-translates the channel
      // (fresh peerAvatar/name on the sidebar row). Narrow on purpose: non-peer churn and
      // non-DM rooms keep the old contract (member events never re-translate the channel).
      // ADR-094 (Proposto) dec. 5: in a group conversation EVERY member event re-translates it — the
      // group's name and `participants` are its people (join/invite). Custody and system churn returned
      // above; a room that is neither a group nor a DM keeps the old contract.
      if (this.dmPeerByRoom().get(member.roomId) === member.userId) {
        const room = this.client?.getRoom(member.roomId)
        if (room) this.emitChannelChanged(room)
      } else {
        const room = this.client?.getRoom(member.roomId)
        // The marker alone first: only a room that carries it pays for the translation context.
        if (room && hasGroupMarker(room) && isGroupConversation(room, this.ctx())) this.emitChannelChanged(room)
      }
    }

    // ADR-026: MY OWN membership transitions drive channel lifecycle (created/added vs left/removed),
    // anchored on the user's own membership (an account-over-channel event), not on a peer's content.
    // Space rooms are excluded for consistency with getChannels/emitChannelChanged (they are not
    // channels). Membership is KnownMembership | string — compared as plain strings.
    const onMyMembership = (room: Room, membership: string, prevMembership?: string): void => {
      if (!this.client || room.isSpaceRoom()) return
      if (prevMembership !== 'join' && membership === 'join') {
        if (this.groupOpenings.size > 0 || this.openedGroupRooms.has(room.roomId)) this.holdGroupRoom(room.roomId)
        else this.emit({ t: 'channel.added', channel: roomToChannel(room, this.ctx(room)) })
        this.sendEntryReceipt(room)
      } else if (prevMembership === 'join' && (membership === 'leave' || membership === 'ban')) {
        this.emit({ t: 'channel.removed', channelId: brandChannelId(room.roomId) })
      } else if (membership === 'invite' && prevMembership !== 'invite') {
        this.detach(this.autoJoinInvite(room))
      }
    }

    // ADR-026: archiving is a custom state event (io.tayet.archived). active === true → the channel
    // leaves the active list (channel.removed, agnostic of cause). ADR-076 dec. 2: un-archiving emits
    // channel.added ONLY on the transition (prev active === true → new not true), translated from the
    // currentState the SDK already updated (archived omitted); a state replay without the transition
    // emits nothing. Guards mirror emitChannelChanged: my membership is join and not a space room.
    //
    // #245, ADR-026 §1: a topic-only change is an in-place mutation → channel.changed. The SDK has
    // no RoomEvent.Topic (only Name), so m.room.topic is caught here by type; emitChannelChanged
    // carries the guards (join, not a space, not archived). updateChannel with name AND topic emits
    // twice (Room.name, then this) — accepted: upsertChannel is idempotent.
    const onStateEvent = (event: MatrixEvent, state: RoomState, prevEvent: MatrixEvent | null): void => {
      if (!this.client) return
      if (event.getType() === 'm.room.topic') {
        const room = this.client.getRoom(state.roomId)
        if (room) this.emitChannelChanged(room)
        return
      }
      if (event.getType() === ORG_MEMBER_EVENT) {
        if (state.roomId === this.joinedOrgChannel()?.roomId) this.emit({ t: 'people.changed' })
        return
      }
      // ADR-094 (Proposto) dec. 5: the conversation marker changing (group ↔ channel) re-classifies the
      // room in place: kind, name and `participants` move. emitChannelChanged carries the guards.
      if (event.getType() === CONVERSATION_EVENT) {
        this.reviewHeldGroupRoom(state.roomId)
        const room = this.client.getRoom(state.roomId)
        if (room) this.emitChannelChanged(room)
        return
      }
      if (event.getType() !== 'io.tayet.archived') return
      if (event.getContent()?.active === true) {
        this.emit({ t: 'channel.removed', channelId: brandChannelId(event.getRoomId() ?? '') })
      } else if (prevEvent?.getContent()?.active === true) {
        const room = this.client.getRoom(state.roomId)
        if (!room || room.getMyMembership() !== 'join' || room.isSpaceRoom()) return
        this.emit({ t: 'channel.added', channel: roomToChannel(room, this.ctx(room)) })
      }
    }

    // ADR-026: leaveChannel = leave + forget. The join→leave MyMembership transition RACES with
    // forget — forget removes the Room from the store before the leave delta syncs, so that
    // transition (hence its channel.removed) is lost. forget emits ClientEvent.DeleteRoom reliably,
    // so we anchor the self-leave channel.removed here. Idempotent with onMyMembership: a double
    // channel.removed is a harmless no-op (removal is agnostic of cause and identity-only, §1).
    const onDeleteRoom = (roomId: string): void => {
      if (!this.client) return
      this.emit({ t: 'channel.removed', channelId: brandChannelId(roomId) })
    }

    // Connection state (P4 hook).
    const onSync = (state: SyncState): void => {
      const cs = toConnectionState(state)
      if (cs) this.emit({ t: 'connection.changed', state: cs })
    }

    // ADR-056 dec. 3: presence EDUs → user.presence, backed by the ACL-side map. We listen on
    // LastPresenceTs, NOT on the SDK's presence-change event: LastPresenceTs re-fires for EVERY
    // presence EDU (User.createUser re-emits it at the client level), while the value-change
    // event is swallowed for an offline EDU landing on a virgin User — a fresh User is born
    // "offline" (User constructor default), so nothing changes on the object and the event never
    // fires. The store is MemoryStore (createClient default, matrix.js:104), not StubStore as an
    // earlier version of this comment assumed; the real client-level hole is the SELF user:
    // startClient stores a raw `new User(userId)` with no reEmitter (client.js:531-532), so its
    // events never reach the MatrixClient — connect() re-attaches this handler directly on that
    // instance. Our own map (absence ≡ 'offline') is the diff authority: same value twice → no
    // emission, and a first offline EDU is invisible (nothing observable changed). The protocol
    // presence string is translated at this line and never crosses (P1).
    const onPresence = (_event: MatrixEvent | undefined, user: SdkUser): void => {
      if (!this.client) return
      const next = presenceToDomain(user.presence)
      const prev = this.presenceByUser.get(user.userId) ?? 'offline'
      if (next === prev) return
      this.presenceByUser.set(user.userId, next)
      this.emit({ t: 'user.presence', user: brandUserId(user.userId), presence: next })
    }

    // ADR-068 D4: in an encrypted room the channel's mentions are counted from the decrypted events in
    // memory, so a decrypt that reveals a mention of the user changes the channel. The SDK emits nothing
    // for it here: its own recount takes the Thread's heuristic and may leave the counts untouched.
    const onDecryptedMention = (event: MatrixEvent): void => {
      if (!this.client || event.isDecryptionFailure()) return
      const me = this.client.getUserId()
      if (!me || event.getSender() === me || !mentionsUser(event, me)) return
      const roomId = event.getRoomId()
      const room = roomId ? this.client.getRoom(roomId) : null
      if (room) this.emitChannelChanged(room)
    }

    // §8.24 H4: every handler runs behind the guard (handler-guard.ts) — none may throw into the SDK's
    // sync batch. The wrapped references are the ones registered AND unregistered.
    const m = this.opts.mode
    const G = {
      onTimeline: guarded('onTimeline', m, onTimeline),
      onDecrypted: guarded('onDecrypted', m, onDecrypted),
      onDecryptedMention: guarded('onDecryptedMention', m, onDecryptedMention),
      onLocalEcho: guarded('onLocalEcho', m, onLocalEcho),
      onRedaction: guarded('onRedaction', m, onRedaction),
      onName: guarded('onName', m, onName),
      onRoom: guarded('onRoom', m, onRoom),
      onMembers: guarded('onMembers', m, onMembers),
      onMyMembership: guarded('onMyMembership', m, onMyMembership),
      onStateEvent: guarded('onStateEvent', m, onStateEvent),
      onDeleteRoom: guarded('onDeleteRoom', m, onDeleteRoom),
      onSync: guarded('onSync', m, onSync),
      onPresence: guarded('onPresence', m, onPresence),
    }
    // Attach every listener, and register its symmetric teardown so disconnect() leaves no orphan
    // (the reported 'ACL not connected' came from a Room/Thread re-emit reaching a handler after
    // teardown). The handlers themselves also guard on `this.client` as a second line of defence.
    client.on(RoomEvent.Timeline, G.onTimeline)
    client.on(MatrixEventEvent.Decrypted, G.onDecrypted)
    client.on(MatrixEventEvent.Decrypted, G.onDecryptedMention)
    client.on(RoomEvent.LocalEchoUpdated, G.onLocalEcho)
    client.on(RoomEvent.Redaction, G.onRedaction)
    client.on(RoomEvent.Name, G.onName)
    client.on(ClientEvent.Room, G.onRoom)
    client.on(RoomStateEvent.Members, G.onMembers)
    client.on(RoomEvent.MyMembership, G.onMyMembership)
    client.on(RoomStateEvent.Events, G.onStateEvent)
    client.on(ClientEvent.DeleteRoom, G.onDeleteRoom)
    client.on(ClientEvent.Sync, G.onSync)
    client.on(UserEvent.LastPresenceTs, G.onPresence)
    // §8.24 H4: a sync batch whose processing threw ("Caught /sync error") is re-emitted by the SDK as
    // SyncUnexpectedError; the device-list change of that batch is lost (the token already moved on),
    // so re-query every tracked list. Neutral signal: the error itself is never logged here.
    const onSyncUnexpected = guarded('onSyncUnexpected', m, (): void => {
      console.warn('[acl] sync batch failed')
      this.markPeerDeviceListsStale()
    })
    client.on(ClientEvent.SyncUnexpectedError, onSyncUnexpected)
    this.disposers.push(
      () => client.off(RoomEvent.Timeline, G.onTimeline),
      () => client.off(MatrixEventEvent.Decrypted, G.onDecrypted),
      () => client.off(MatrixEventEvent.Decrypted, G.onDecryptedMention),
      () => client.off(RoomEvent.LocalEchoUpdated, G.onLocalEcho),
      () => client.off(RoomEvent.Redaction, G.onRedaction),
      () => client.off(RoomEvent.Name, G.onName),
      () => client.off(ClientEvent.Room, G.onRoom),
      () => client.off(RoomStateEvent.Members, G.onMembers),
      () => client.off(RoomEvent.MyMembership, G.onMyMembership),
      () => client.off(RoomStateEvent.Events, G.onStateEvent),
      () => client.off(ClientEvent.DeleteRoom, G.onDeleteRoom),
      () => client.off(ClientEvent.Sync, G.onSync),
      () => client.off(UserEvent.LastPresenceTs, G.onPresence),
      () => client.off(ClientEvent.SyncUnexpectedError, onSyncUnexpected),
    )

    return G.onPresence
  }

  // Apply a live m.replace to its target and emit message.edited. Shared by the cleartext
  // timeline path and the settled-decrypt path (§4.3) so both stay byte-for-byte identical.
  // Passing the TARGET event itself lets editToMessage derive the target's relations
  // (threadParent/replyTo) and original timestamp (PLANO-FASE-1-REPLY §0.6 — the synced m.replace path
  // used to hardcode threadParent: undefined and zero the relation).
  // Only the author edits (PLANO-AGENTES §8.30): an edit by anyone else is dropped in silence — no
  // event, so no search entry either. The target's sender comes from the room, else from the events
  // this session delivered (readTargets), else from a read of the event; one that cannot be read is
  // never edited.
  private routeLiveEdit(editEvent: MatrixEvent, room: Room, targetRealId: string, ctx: Ctx): void {
    // ADR-091: a panel's update is no line (routeFolded reloads the panels before this is reached).
    if (foldedKind(editEvent) !== undefined) return
    const original =
      room.findEventById(targetRealId) ?? this.readTargets.get(targetRealId) ?? this.approvalCards.get(targetRealId)
    if (original) {
      if (!editAppliesTo(editEvent.getSender(), original.getSender())) return
      if (foldedKind(original) !== undefined) return
      // ADR-091 dec. 7: the author's first close seen live fixes the card's close instant (before the
      // edit is translated, so the card it re-emits already reads it).
      if ((original.getOriginalContent() as Record<string, unknown>).msgtype === APPROVAL_MSGTYPE) {
        const fact = editFactOf(editEvent)
        const cardId = original.getId()
        if (fact && cardId) this.approvals.noteEdit(room.roomId, cardId, fact)
      }
      const edited = editToMessage(editEvent, stableMessageId(original), ctx, original)
      this.emit({ t: 'message.edited', channelId: edited.channelId, message: edited })
      return
    }
    const client = this.client
    if (!client) return
    this.detach(
      client
        .fetchRoomEvent(room.roomId, targetRealId)
        .then((target) => {
          if (this.client !== client || !editAppliesTo(editEvent.getSender(), target.sender)) return
          // A card's edit needs the card's original options; without the card at hand it waits for the
          // card's next translation (the UI does not hold a card the room does not).
          const newContent = (editEvent.getContent()['m.new_content'] ?? {}) as Record<string, unknown>
          if (newContent.msgtype === APPROVAL_MSGTYPE) return
          const edited = editToMessage(editEvent, targetRealId, ctx, undefined)
          this.emit({ t: 'message.edited', channelId: edited.channelId, message: edited })
        })
        .catch(() => undefined),
    )
  }

  // Emit a message.received, recording an `unavailable` body for the late-decrypt upgrade
  // (real event id → stable id; the Decrypted handler upgrades via message.edited under the
  // SAME stable id when the key arrives — ADR-015 item 1).
  private emitReceivedTracked(msg: Message, event: MatrixEvent): void {
    const realEventId = event.getId() ?? undefined
    if (msg.body.kind === 'unavailable' && realEventId) {
      this.unavailableEmitted.set(realEventId, messageIdToRaw(msg.id))
    }
    this.rememberReadTarget(event)
    this.noteApprovalCard(msg, event)
    this.emit({ t: 'message.received', channelId: msg.channelId, message: msg })
  }

  // §8.37 D1: keep every delivered event as a read target. Resolving at delivery time is not enough:
  // the first reply of a thread is delivered from the Thread the SDK seeds, and the Thread's
  // initialisation then resets its timeline until the root's /relations answers — the event leaves
  // the room for that window. The entry goes when the room resolves it again (settleReadTarget,
  // markRead) or under the cap.
  private rememberReadTarget(event: MatrixEvent): void {
    const id = event.getId()
    if (!id) return
    this.readTargets.delete(id)
    this.readTargets.set(id, event)
    if (this.readTargets.size > READ_TARGET_CAP) {
      const oldest = this.readTargets.keys().next().value
      if (oldest !== undefined) this.readTargets.delete(oldest)
    }
  }

  // §8.37 D1/D3, on every timeline insertion (main or a Thread's, live or not): the room now resolves
  // the event, so its read-target entry goes; and a deferred explicit markRead on it gets its receipt.
  private settleReadTarget(event: MatrixEvent, room: Room): void {
    const id = event.getId()
    if (!id) return
    if (this.readTargets.has(id) && room.findEventById(id)) this.readTargets.delete(id)
    if (this.pendingReadTarget.get(room.roomId) !== id) return
    this.pendingReadTarget.delete(room.roomId)
    const receipt = this.sendReceipt(event)
    if (receipt) this.detach(receipt.catch(() => {}))
  }

  private emitChannelChanged(room: Room): void {
    // ADR-026: an archived channel must not re-surface in the active list via a metadata change —
    // it left the list (channel.removed); a rename/topic/unread tick on it is not a channel.changed.
    if (!this.client || room.getMyMembership() !== 'join' || room.isSpaceRoom() || this.isArchived(room)) return
    // ADR-094 dec. 3: a held room has not been added yet; its channel.added carries the state of the moment.
    if (this.heldGroupRooms.has(room.roomId)) return
    this.emit({ t: 'channel.changed', channel: roomToChannel(room, this.ctx()) })
  }

  // Re-aggregate a target message's reactions and emit the new array (consumable directly).
  private emitReactionChanged(room: Room, targetRealEventId: string): void {
    const reactions = aggregateReactions(room, targetRealEventId, this.client?.getUserId() ?? null)
    const target = room.findEventById(targetRealEventId)
    const stableId = target ? stableMessageId(target) : targetRealEventId
    this.emit({
      t: 'reaction.changed',
      channelId: brandChannelId(room.roomId),
      messageId: brandMessageId(stableId),
      reactions,
    })
  }

  async disconnect(): Promise<void> {
    // Symmetric teardown: remove every listener we attached BEFORE discarding the client, so a late
    // Thread/Room re-emit during stopClient cannot reach a handler (the per-handler `this.client`
    // guards are the second line of defence). roomWired is reset so a future connect() re-attaches.
    const client = this.client
    // Cancel the recovery retry FIRST (§3.3 — same hygiene as the check drain below): an
    // in-flight pass becomes inert and no new attempt is scheduled; the bootstrap-memory secret
    // does not outlive the session.
    this.recoveryRunner?.cancel()
    this.recoveryRunner = undefined
    this.recoveryRun = undefined
    // ADR-077: o timer da re-consulta morre com a sessão (ADR-059 D2: sem rede no teardown).
    this.custodyReconsult?.cancel()
    this.custodyReconsult = undefined
    this.recoverySecret = undefined
    // Veredito é POR sessão de uso (ADR-057 dec. 7): a próxima sessão re-consulta e re-prova.
    this.custodyImportedSessions = undefined
    this.people = undefined
    this.orgAdmin = undefined
    for (const off of this.disposers.splice(0)) off()
    this.roomWired = new WeakSet<Room>()
    this.threadSummaryEmitted.clear()
    this.pagedThreadLatest.clear()
    this.approvals.clear()
    this.approvalCards.clear()
    this.pendingAnswers.clear()
    this.panels.clear()
    this.commands.clear()
    this.forms.clear()
    this.formReplies.clear()
    // ADR-074: the backfill stops at its next step; the index's store connection closes with the
    // session (a sign-out wipe follows).
    this.searchBackfillRun += 1
    this.search?.close()
    this.search = undefined
    this.lastSearchState = undefined
    this.mediaConfigFetched = false
    this.maxUploadBytes = undefined
    this.localMedia.clear()
    this.localEchoTxns.clear()
    this.directRoomByUser.clear()
    this.groupRoomBySet.clear()
    for (const held of this.heldGroupRooms.values()) clearTimeout(held.timer)
    this.heldGroupRooms.clear()
    this.openedGroupRooms.clear()
    this.groupOpenings.clear()
    // Revoke every object URL this session minted (PLANO-FASE-2-MEDIA §0.2 item 2 — the ONE
    // revocation trigger this slice has; no LRU/active policy) and drop the decrypt worker.
    for (const url of this.objectUrls) URL.revokeObjectURL(url)
    this.objectUrls.clear()
    disposeDecryptWorker()
    this.live = false
    // F11: a fila de convites deferidos morre com a sessão (o drain checa this.client, mas
    // parar o timer aqui é o teardown simétrico — nenhum interval órfão pós-disconnect).
    this.custodyInviteQueue.clear()
    this.stopCustodyDrainIfIdle()
    this.custodyAttempted.clear()
    this.custodyRepairs.clear()
    this.pendingDecrypt.clear()
    this.unavailableEmitted.clear()
    this.ownSendsAwaitingEcho.clear()
    this.readTargets.clear()
    this.pendingReadTarget.clear()
    this.entryReceiptsOwed.clear()
    this.acknowledgedDevices.clear()
    this.notifiedDevices.clear()
    this.ackServerRead = undefined
    this.ackServerCurrent = undefined
    this.ackDirty = false
    this.serverUnread = undefined
    this.client = undefined
    // Drain the ACL's own fire-and-forget work (`detach`) BEFORE stopping, for the same reason as the
    // key-backup check below: stopClient() frees the OlmMachine. With this.client cleared, every
    // tracked continuation is inert at its next guard; what is still awaiting a round-trip settles
    // here. Bound: REVOKE_BOUND_MS, the teardown bound for an HTTP round-trip already in flight —
    // same regime (limits the wait, never aborts the request; a late settle is swallowed).
    if (this.inflight.size > 0) {
      await bounded(Promise.allSettled([...this.inflight]), REVOKE_BOUND_MS, 'teardown drain')
    }
    // Drain the rust-crypto initial key-backup check BEFORE stopping (PLANO-FASE-2 §9): the SDK
    // kicks a fire-and-forget checkKeyBackupAndEnable at crypto start, and stopClient() frees the
    // wasm OlmMachine (RustCrypto.stop → olmMachine.close) — if the check is still awaiting its
    // HTTP round-trip, its resume hits the freed machine ("null pointer passed to rust", an
    // unhandled rejection). The call below is deduped against the in-flight check (the manager
    // keeps one promise), so awaiting it closes the race window for the dominant trigger.
    // ADR-059 D2: sessão perdida → nenhuma request autenticada no teardown. Não há sessão para
    // habilitar backup, e a única request possível falha (e disparava um 2º refresh).
    if (!this.sessionLost) {
      try {
        await client?.getCrypto()?.checkKeyBackupAndEnable()
      } catch {
        // best-effort drain — we are stopping regardless
      }
    }
    client?.stopClient()
  }

  // Logout (ADR-034 D1; ADR-062 D1). Revoga a sessão no emissor, para o cliente E apaga o store de
  // cripto do SDK. `clearStores` LANÇA se o cliente estiver rodando → `disconnect()` primeiro (ele faz
  // stopClient + libera o OlmMachine). `clearStores()` (sem args) apaga as IndexedDB do rust-crypto sob o
  // prefixo default — o MESMO que o `initRustCrypto()` usa — então nenhum nome de store precisa cruzar
  // (P1). Em Node (sem indexedDB) o wipe do rust é no-op: o invariante "limpa cripto" é verificável só
  // em browser (dogfood).
  //
  // ADR-062 D1 (supersede ADR-034 D2): sair revoga os tokens DESTA sessão no MAS por RFC 7009
  // (revokeSessionTokens, oidc.ts) — direto no `revocation_endpoint`, NÃO o `client.logout()` (/logout
  // do homeserver) nem o end_session (RP-initiated, com redirect, encerraria a sessão de browser do MAS
  // inteira). Ordem: tokens lidos do client vivo → disconnect (parar ANTES de revogar: revogar com o
  // sync rodando faria o próprio SDK declarar a sessão perdida no meio do logout) → revogação com bound
  // (REVOKE_BOUND_MS) → wipe. Uma tentativa; falha ou estouro vira um aviso neutro no console e o logout
  // local segue — o usuário nunca fica preso "meio-deslogado" por rede. Sessão PERDIDA (ADR-059 D2,
  // `sessionLost`): nenhuma request — o servidor já encerrou o que haveria a revogar.
  //
  // ADR-059 D2: o wipe tem bound (STORE_WIPE_BOUND_MS). O deleteDatabase do SDK não resolve enquanto
  // outra conexão segura o IndexedDB (`onblocked` só loga) — o bound NÃO aborta o wipe (o request
  // segue pendente e completa quando a conexão fecha), só limita quanto o logout espera.
  async signOut(): Promise<void> {
    const client = this.client
    const account = this.searchAccount
    const issuer = this.oidcIssuerRef
    const revoke =
      client && issuer && !this.sessionLost
        ? {
            ...issuer,
            accessToken: client.getAccessToken() ?? undefined,
            refreshToken: client.getRefreshToken() ?? undefined,
          }
        : undefined
    await this.disconnect()
    if (!client) return
    if (revoke) await bounded(revokeSessionTokens(revoke), REVOKE_BOUND_MS, 'session revoke')
    // clearStores lança SÍNCRONO com o client rodando; o async wrapper vira isso numa rejeição que o
    // bounded engole (best-effort: o logout segue válido mesmo se o store resistir a sumir).
    await bounded((async () => client.clearStores())(), STORE_WIPE_BOUND_MS, 'store wipe')
    // §8.38: the pending dismissals are local state of this session, wiped with the store.
    clearAllPendingRecognitions()
    // ADR-074 dec. 7: the search index too (its connection was closed by disconnect above).
    await bounded(wipeSearchIndexes(account), STORE_WIPE_BOUND_MS, 'search index wipe')
  }

  private require(): MatrixClient {
    if (!this.client) throw new Error('ACL not connected')
    return this.client
  }

  // DM membership comes from the `m.direct` account-data map (userId → roomId[]). The INVERSE
  // (roomId → userId) is the DM-peer seam (PLANO-PRESENCA §8.4 item 9): the userId KEY that
  // dmRoomIds used to discard IS the peer. Deterministic on a malformed map that lists the same
  // room under two users: the FIRST key (account-data object iteration order) wins — the map is
  // written one key at a time by addDirectRoom, so in practice each room has exactly one owner.
  private dmPeerByRoom(): Map<string, string> {
    const ev = this.require().getAccountData(EventType.Direct as keyof AccountDataEvents)
    const content = (ev?.getContent() ?? {}) as Record<string, unknown>
    const out = new Map<string, string>()
    for (const [userId, v] of Object.entries(content)) {
      if (Array.isArray(v)) {
        for (const id of v) if (typeof id === 'string' && !out.has(id)) out.set(id, userId)
      }
    }
    return out
  }

  private dmRoomIds(): Set<string> {
    return new Set(this.dmPeerByRoom().keys())
  }

  // When a room is given, reactions are aggregated from its relations container (keyed by the
  // message's real event id). Room-agnostic callers (getChannels) omit it.
  private ctx(room?: Room): Ctx {
    const dmPeer = this.dmPeerByRoom()
    const myUserId = this.client?.getUserId() ?? null
    return {
      mode: this.opts.mode,
      telemetry: this.opts.telemetry,
      isDm: (roomId) => dmPeer.has(roomId),
      dmPeerOf: (roomId) => dmPeer.get(roomId),
      myUserId,
      custodian: myUserId ? custodyMxidFor(myUserId) : null,
      systemAccount: myUserId ? systemMxidFor(myUserId) : null,
      orgChannelAlias: this.orgChannelAlias(),
      kindOf: (mxid) => this.kindOf(mxid),
      agentOf: (mxid) => this.agentOf(mxid),
      serverUnread: (roomId) => this.serverUnread?.get(roomId),
      reactionsFor: room
        ? (realEventId) => aggregateReactions(room, realEventId, myUserId)
        : undefined,
      // ADR-066: the SDK's Thread rooted at this event, if the room has one (summary source #1).
      threadFor: room ? (realEventId) => room.getThread(realEventId) ?? undefined : undefined,
      mediaRefFor: (mxc, encrypted, mimetype) => this.mintMediaRef(mxc, encrypted, mimetype),
      // Relation target real id → stable domain id (ADR-010): an own message's stable id is its
      // txn, which the room's event (server echo included) still carries. Unknown id → as-is.
      stableIdFor: room
        ? (realEventId) => {
            const target = room.findEventById(realEventId)
            return target ? stableMessageId(target) : realEventId
          }
        : undefined,
      // ADR-057 dec. 7 (PR-5) + ADR-077 dec. 4: veredito de perda EXIGE prova — consulta feita
      // nesta sessão de uso (set materializado) E sessão conhecida E ausente do import E re-consultas
      // da sessão esgotadas. Qualquer elo faltando → false (o grau transitório fica).
      custodyMissing: (sessionId) =>
        this.custodyImportedSessions !== undefined &&
        sessionId !== undefined &&
        !this.custodyImportedSessions.has(sessionId) &&
        this.custodyReconsult?.exhausted(sessionId) === true,
      // ADR-077 dec. 1: todo evento não decifrável avisa a sua sessão; a re-consulta decide.
      onUndecryptable: (sessionId) => this.custodyReconsult?.note(sessionId),
      // ADR-091: the card's aggregated state — cached, else open/closed while the read runs.
      // A3-2: this session's own answer in flight folds in while the card is open (the aggregated state wins).
      approvalStateFor: room
        ? (realEventId, card) =>
            this.pendingAnswers.overlay(room.roomId, realEventId, this.approvals.stateFor(room.roomId, realEventId, card), this.client?.getUserId() ?? undefined)
        : undefined,
      formReplyFor: room ? (realEventId, anchor) => this.formReplies.replyFor(room.roomId, realEventId, anchor) : undefined,
    }
  }

  // ADR-091 dec. 2/12; PLANO-AGENTES §0.3.16 item 8: an answer or a panel never becomes a line — nor a
  // commands manifest (ADR-093 (Proposto), §0.3.21 item 3). An answer updates its card (decrypted or not:
  // author and instant are in clear); a panel or a manifest goes to its anchored reader (noteAnchored: an
  // edit applied in place, a new message read). True when the event was one of them — the caller emits
  // nothing for it.
  private routeFolded(event: MatrixEvent, room: Room): boolean {
    const kind = foldedKind(event)
    if (kind === undefined) return false
    // A3-2: the local echo of this session's own answer (no server id yet) is no answer the rule reads —
    // the send itself folds into the card (answerApproval) and joins the aggregator once accepted.
    if (kind === 'response' && hasServerId(event)) {
      const cardId = answeredCardOf(event)
      const fact = answerFactOf(event)
      if (cardId && fact) this.approvals.noteAnswer(room.roomId, cardId, fact)
    }
    if (kind === 'panel' || kind === 'commands') this.noteAnchored(event, room, kind)
    if (kind === 'form' && hasServerId(event)) this.noteForm(event, room)
    return true
  }

  // A live form message: the reply aggregator learns of all three; a definition may open a form for this
  // session and a result may move it. A readable message of a form type that breaks the rule is
  // ignored and signalled by its shape only.
  private noteForm(event: MatrixEvent, room: Room): void {
    const { related, anchorId, malformed } = formRelatedOf(event)
    if (malformed && !event.isDecryptionFailure() && !(event.isEncrypted() && event.getClearContent() === null)) {
      const msgtype = (event.getContent() as Record<string, unknown>).msgtype
      this.opts.telemetry.untranslated({
        conceptKind: 'message-content',
        shape: { eventType: 'm.room.message', ...(typeof msgtype === 'string' && { msgtype }) },
      })
    }
    if (!related || !anchorId) return
    this.formReplies.noteLive(room.roomId, anchorId, related)
    if (related.kind === 'definition') {
      const anchor = room.findEventById(anchorId)
      this.forms.noteDefinition({
        id: related.id,
        roomId: room.roomId,
        sender: related.sender,
        anchorId,
        anchorMessage: anchor ? stableMessageId(anchor) : anchorId,
        definition: related.definition,
      })
    } else if (related.kind === 'result') {
      this.forms.noteResult({ roomId: room.roomId, sender: related.sender, result: related.result })
    }
  }

  // The submission goes by the ordinary message path, encrypted where the room is.
  private async sendFormSubmission(
    roomId: string,
    anchorId: string,
    formId: string,
    title: string,
    values: FormValues,
    labels: FormSubmissionLabel[],
  ): Promise<string> {
    const client = this.require()
    const content = buildFormSubmissionContent(anchorId, formId, title, values, labels)
    const res = await client.sendEvent(roomId, EventType.RoomMessage, content as never, client.makeTxnId())
    return res.event_id
  }

  // The author of an event: from the room, else from the server.
  private async senderOfEvent(roomId: string, eventId: string): Promise<string | undefined> {
    const client = this.client
    if (!client) return undefined
    const local = client.getRoom(roomId)?.findEventById(eventId)?.getSender()
    if (local) return local
    const raw = await client.http.authedRequest<{ sender?: unknown }>(
      Method.Get,
      `/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`,
    )
    return typeof raw.sender === 'string' ? raw.sender : undefined
  }

  // A form reply on an anchor moved: re-translate it and emit it in place.
  private emitAnchorChanged(roomId: string, anchorId: string): void {
    const room = this.client?.getRoom(roomId)
    if (!room) return
    const anchor = room.findEventById(anchorId) ?? this.approvalCards.get(anchorId) ?? this.readTargets.get(anchorId)
    if (!anchor) return
    const msg = eventToMessage(anchor, this.ctx(room))
    if (msg) this.emit({ t: 'message.edited', channelId: msg.channelId, message: msg })
  }

  // A3-5, on the live stream before the decrypt deferral: an edit of a panel (A4-1: or manifest) that arrives
  // already settled as a decrypt failure never enters pendingDecrypt (nor routeFolded: its type is
  // unreadable), so the reader learns of it here — the agent's content stops showing until the edit decrypts.
  private noteAnchoredEdit(event: MatrixEvent, room: Room): void {
    if (event.isDecryptionFailure()) this.noteAnchoredFailure(event, room)
  }

  // The anchored message an event edits, from its relation in clear on the envelope, when a reader's cache
  // holds that message: the reader and the message's id.
  private editedAnchored(event: MatrixEvent, room: Room): { agg: AnchoredReader['agg']; messageId: string } | undefined {
    const wire = (event.getWireContent?.() ?? {}) as Record<string, unknown>
    const rel = wire['m.relates_to'] as { rel_type?: unknown; event_id?: unknown } | undefined
    if (rel?.rel_type !== RelationType.Replace || typeof rel.event_id !== 'string') return undefined
    const messageId = rel.event_id
    const reader = this.anchored.find(({ agg }) => agg.watches(messageId) === room.roomId)
    return reader ? { agg: reader.agg, messageId } : undefined
  }

  // A3-5: an edit of a held panel (A4-1: or manifest) that did not decrypt — applied without content (the
  // author's only; never a read). Its later decrypt applies the content in place.
  private noteAnchoredFailure(event: MatrixEvent, room: Room): void {
    const target = this.editedAnchored(event, room)
    const id = event.getId()
    const sender = event.getSender()
    if (target && id && sender) target.agg.applyEdit(room.roomId, target.messageId, { id, sender, at: event.getTs() })
  }

  // A3-5: a decrypted (or clear) panel event (A4-1: or manifest event). An edit of a held message is applied
  // in place — no read; the aggregator keeps only the author's and never an older one. A new message reads
  // the anchor only when it is new or an original the cache holds without content — and, for the reader's
  // own copies, only the latter (a copy is never new).
  private noteAnchored(event: MatrixEvent, room: Room, kind: AnchoredReader['kind']): void {
    const id = event.getId()
    const sender = event.getSender()
    if (!id || !sender) return
    const target = this.editedAnchored(event, room)
    if (target) {
      const newContent = (event.getContent() as Record<string, unknown>)['m.new_content']
      const content = typeof newContent === 'object' && newContent !== null ? (newContent as Record<string, unknown>) : undefined
      target.agg.applyEdit(room.roomId, target.messageId, { id, sender, at: event.getTs(), ...(content && { content }) })
      return
    }
    const reader = this.anchored.find((r) => r.kind === kind)
    if (!reader) return
    const wire = (event.getWireContent?.() ?? {}) as Record<string, unknown>
    const rel = wire['m.relates_to'] as { rel_type?: unknown } | undefined
    const clear = (event.getContent() as Record<string, unknown>)['m.relates_to'] as { rel_type?: unknown } | undefined
    if (rel?.rel_type !== reader.relType && clear?.rel_type !== reader.relType) return
    if (reader.agg.needsRead(room.roomId, id, isReaderCopy(event))) reader.agg.invalidate(room.roomId)
  }

  // A3-5: a decrypt (or a failed one) outside the live deferral — the reader's copies, or an event the SDK
  // never put on the timeline (an edit whose target, sent before this person joined, is not loaded fires
  // Decrypted only). A failure never reads: an edit of a held message is applied without content. A success
  // of a panel or manifest event goes to noteAnchored — and only its first report: the SDK reports the same
  // decrypt again whenever another event of its session decrypts.
  private noteAnchoredDecrypt(event: MatrixEvent, room: Room): void {
    const id = event.getId()
    if (!id) return
    if (event.isDecryptionFailure()) {
      this.noteAnchoredFailure(event, room)
      return
    }
    const kind = foldedKind(event)
    if (kind !== 'panel' && kind !== 'commands') return
    const reader = this.anchored.find((r) => r.kind === kind)
    if (!reader || !reader.agg.firstDecrypt(id)) return
    this.noteAnchored(event, room, kind)
  }

  // A card's state moved: re-translate it and emit it in place (message.edited — the UI applies it only
  // to a message it holds). The card comes from the room, else from what this session translated.
  private emitApprovalCard(roomId: string, cardId: string): void {
    const room = this.client?.getRoom(roomId)
    if (!room) return
    const card = room.findEventById(cardId) ?? this.approvalCards.get(cardId) ?? this.readTargets.get(cardId)
    if (!card) return
    const msg = eventToMessage(card, this.ctx(room))
    if (msg?.body.kind === 'approval') this.emit({ t: 'message.edited', channelId: msg.channelId, message: msg })
  }

  private noteApprovalCard(msg: Message, event: MatrixEvent): void {
    const id = event.getId()
    if (msg.body.kind !== 'approval' || !id) return
    this.approvalCards.delete(id)
    this.approvalCards.set(id, event)
    if (this.approvalCards.size > READ_TARGET_CAP) {
      const oldest = this.approvalCards.keys().next().value
      if (oldest !== undefined) this.approvalCards.delete(oldest)
    }
  }

  private requireRoom(id: ChannelId): Room {
    const room = this.require().getRoom(channelIdToRaw(id))
    if (!room) throw new Error('channel not found')
    return room
  }

  // Send precondition (ADR-058 dec. 1): the room must be in the store AND this session must be a
  // member of it. A pending invite or a channel it left (not yet forgotten) is not a send target —
  // its cipher state may be missing and the server would refuse the event after the upload. Same
  // error as requireRoom; only membership is checked (archived/space are other decisions).
  private requireJoinedRoom(id: ChannelId): Room {
    const room = this.requireRoom(id)
    if (room.getMyMembership() !== 'join') throw new Error('channel not found')
    return room
  }

  // ── Channel creation — E2E by default (PLANO-FASE-2 §4.4 / ADR-015 item 2) ────────────────
  // Encryption is DERIVED FROM VISIBILITY, never from size (ADR-045): a `public` channel is born in
  // the clear (no m.room.encryption in initial_state) — a public room's access boundary is already the
  // whole organization, so E2E there buys no confidentiality; a `private` channel is born with Megolm
  // at any N. No crypto parameter crosses the barrel — the ADR-015 structural invariant holds: the
  // decision is a pure function of `kind`, which is already domain vocabulary (security is not
  // independent domain state). DMs have their OWN path (openDirectMessage) and are always Megolm.
  // This is the PRODUCT verb (PLANO-MEMBERSHIP-CANAIS §0.2): the owner-frozen NewChannel shape drives
  // it. `kind` → Preset (public → PublicChat = join_rule público; private → PrivateChat) AND the
  // encryption decision; `topic` → initial_state m.room.topic so the channel is born with it;
  // `members` → invite[]. The protocol vocabulary (Preset/m.room.*/invite) stays here.
  async createChannel(input: NewChannel): Promise<ChannelId> {
    const client = this.require()
    // ADR-090 (Proposto) dec. 4: an agent that is not this session's is refused BEFORE createRoom, so
    // no room is born with an invite the sidecar would refuse.
    for (const u of input.members ?? []) this.assertNotOthersAgent(userIdToRaw(u))
    const encrypted = input.kind !== 'public'
    const initial_state: InitialStateEvent[] = encrypted ? encryptedBirthState() : []
    if (input.topic) {
      initial_state.push({ type: EventType.RoomTopic, state_key: '', content: { topic: input.topic } })
    }
    const res = await client.createRoom({
      name: input.name,
      preset: input.kind === 'public' ? Preset.PublicChat : Preset.PrivateChat,
      invite: input.members?.map((u) => userIdToRaw(u)),
      initial_state,
    })
    // ADR-057 dec. 2: só sala CIFRADA ganha destinatário estrutural. Canal público nasce em claro
    // (ADR-045) — não há sessão Megolm para custodiar, então o cofre não tem o que fazer lá.
    if (encrypted) await this.inviteCustodian(res.room_id)
    return brandChannelId(res.room_id)
  }

  // ── Destinatário estrutural da org (ADR-057 dec. 2; F1 fail-open, F3) ─────────────────────
  // O mxid do cofre para o domínio do usuário conectado, ou null se a identidade ainda não está
  // pronta / é malformada. Ponto único de derivação — os filtros de ocultação e o convite leem
  // daqui, então nunca divergem.
  private custodianMxid(): string | null {
    const me = this.client?.getUserId()
    return me ? custodyMxidFor(me) : null
  }

  private isCustodian(userId: string): boolean {
    return userId === this.custodianMxid()
  }

  private systemAccountMxid(): string | null {
    const me = this.client?.getUserId()
    return me ? systemMxidFor(me) : null
  }

  private isSystemAccount(userId: string): boolean {
    return userId === this.systemAccountMxid()
  }

  // ADR-086 (Proposto) dec. 1/2: an agent account is recognized by its reserved localpart — `a-` + 12
  // of lowercase base32, which only the escrow creates. Derived from the mxid like the two above, so
  // the mark needs no room state and the mxid never crosses the barrel.
  private isAgentAccount(userId: string): boolean {
    const localpart = userId.slice(1, userId.includes(':') ? userId.indexOf(':') : undefined)
    return AGENT_LOCALPART.test(localpart)
  }

  // ADR-090 (Proposto) dec. 3/4: an agent this session operates — its live (non-tombstone)
  // io.tayet.member on #all records this session's localpart as `operator`. Without #all (a guest)
  // nothing is own: fail-closed, a guest is never an operator. The single predicate of listOwnAgents
  // and of the backstop; the operator's localpart never leaves this method.
  private isOwnAgent(mxid: string): boolean {
    if (!this.isAgentAccount(mxid)) return false
    const me = this.client?.getUserId()
    const org = this.joinedOrgChannel()
    if (!me || !org || !me.includes(':') || !mxid.includes(':')) return false
    const content = org.currentState
      .getStateEvents(ORG_MEMBER_EVENT, mxid.slice(1))
      ?.getContent<{ operator?: unknown; removed?: unknown }>()
    if (!content || isTombstone(content) || typeof content.operator !== 'string') return false
    return `@${content.operator}${mxid.slice(mxid.indexOf(':'))}` === me
  }

  private assertNotOthersAgent(mxid: string): void {
    if (this.isAgentAccount(mxid) && !this.isOwnAgent(mxid))
      throw new Error('Only the agent\'s operator can add it to a conversation')
  }

  // FAIL-OPEN COM SINAL (F1, ratificado). Duas coisas que este método NÃO faz, ambas deliberadas:
  //
  //  1. Não entra no array `invite` do createRoom. Lá, uma recusa do servidor derruba a criação
  //     inteira — fail-CLOSED, que é justamente o que o F1 rejeitou: reter a criação de canal refém
  //     da disponibilidade do serviço de custódia inverte o custo (o backup já cobre o caso normal;
  //     a custódia é a rede para a janela).
  //  2. Não deixa erro nenhum atravessar o barrel. Do ponto de vista do usuário o canal FOI criado
  //     com sucesso — porque foi. O que se perdeu é uma propriedade de infra que ele não conhece.
  //
  // O preço do fail-open é que a perda tem que ser OBSERVÁVEL, senão vira exatamente a classe de
  // falha silenciosa que este track existe para matar (vide A1). Daí o sinal nomeado.
  private async inviteCustodian(roomId: string): Promise<void> {
    const custodian = this.custodianMxid()
    if (!custodian) return this.signalUncovered(CUSTODY_SIGNAL_INVITE_FAILED)
    this.custodyAttempted.add(roomId)
    try {
      await this.require().invite(roomId, custodian)
      this.noteInviteAccepted(roomId)
    } catch (err) {
      // F11 (ratificado): o /invite do cofre consome o rc_message do CRIADOR — sob rajada
      // de createRoom o 429 é sistemático, não excepcional (6/12 salas sem cofre, §8.4).
      // Rate limit NÃO é recusa: enfileira honrando retry_after_ms e o verbo resolve com o
      // sinal DISTINTO `deferred`. Todo outro erro segue no fail-open imediato do F1.
      if (err instanceof MatrixError && err.errcode === 'M_LIMIT_EXCEEDED') {
        this.deferCustodyInvite(roomId, err)
        return
      }
      if (await this.custodyAlreadyIn(roomId, custodian, err)) return
      return this.signalUncovered(CUSTODY_SIGNAL_INVITE_FAILED)
    }
    // A espera é OBRIGATÓRIA, não otimização: o fan-out Megolm decide a cobertura no instante do
    // nascimento da sessão, e a primeira sessão nasce no primeiro envio. Se o verbo resolvesse antes
    // de o estado local do criador conhecer o cofre, a UI poderia mandar a primeira mensagem para um
    // conjunto de devices que ainda não inclui a custódia — e Megolm não anda para trás.
    if (!(await this.waitForCustodyMembership(roomId, custodian)))
      this.signalUncovered(CUSTODY_SIGNAL_WAIT_TIMEOUT)
  }

  // `invite` OU `join` bastam: o C1 prova que o fan-out inclui membros convidados enquanto
  // history_visibility !== 'joined' (e a dec. 3 pina `shared`). O agente joina sozinho logo depois
  // (F2), mas esperar pelo join seria esperar por um round-trip que a cobertura não precisa.
  private async waitForCustodyMembership(roomId: string, custodian: string): Promise<boolean> {
    const deadline = Date.now() + CUSTODY_WAIT_MS
    for (;;) {
      if (this.custodyPresent(roomId, custodian)) return true
      if (Date.now() >= deadline) return false
      await new Promise((r) => setTimeout(r, CUSTODY_POLL_MS))
    }
  }

  private custodyPresent(roomId: string, custodian: string): boolean {
    const membership = this.client?.getRoom(roomId)?.getMember(custodian)?.membership
    return membership === 'invite' || membership === 'join'
  }

  // ── Repair on open (ADR-112, Proposto) ─────────────────────────────────────────────────────
  // Rooms that went through inviteCustodian in this session: one invite each (birth, queue or repair).
  private readonly custodyAttempted = new Set<string>()
  // Rooms under repair → whether the server accepted the repair's invite.
  private readonly custodyRepairs = new Map<string, boolean>()

  // The local member list is complete (startClient does not lazy-load members), so absence is read
  // from it, as of the last sync. The server's refusal is the net for a sync that is behind.
  private async repairCustody(roomId: string): Promise<void> {
    if (!this.live || this.sessionLost || this.custodyAttempted.has(roomId)) return
    const room = this.client?.getRoom(roomId)
    const custodian = this.custodianMxid()
    if (!room || !custodian) return
    if (room.getMyMembership() !== 'join' || !room.hasEncryptionStateEvent()) return
    // The product's public channels (roomToChannel), which may carry encryption from before ADR-045.
    if (room.getJoinRule() === JoinRule.Public || room.getCanonicalAlias() === this.orgChannelAlias()) return
    if (this.custodyPresent(roomId, custodian)) return
    this.custodyRepairs.set(roomId, false)
    await this.inviteCustodian(roomId)
  }

  // The invite's answer and the member event come in either order; the second one discards.
  private noteInviteAccepted(roomId: string): void {
    if (!this.custodyRepairs.has(roomId)) return // birth: the outbound session is left alone
    this.custodyRepairs.set(roomId, true)
    this.detach(this.discardOnceRepaired(roomId))
  }

  // ADR-112 dec. 3: the next message is born in a session the custody receives from its first index.
  private async discardOnceRepaired(roomId: string): Promise<void> {
    const custodian = this.custodianMxid()
    if (!custodian || !this.custodyRepairs.get(roomId) || !this.custodyPresent(roomId, custodian)) return
    this.custodyRepairs.delete(roomId)
    await this.client?.getCrypto()?.forceDiscardSession(roomId)
  }

  // Synapse answers "already in the room" and "not allowed to invite" with the same 403 M_FORBIDDEN, so
  // the member's state on the server decides, not the wording of the error.
  private async custodyAlreadyIn(roomId: string, custodian: string, err: unknown): Promise<boolean> {
    if (!(err instanceof MatrixError) || err.errcode !== 'M_FORBIDDEN') return false
    try {
      const { membership } = await this.require().getStateEvent(roomId, EventType.RoomMember, custodian)
      return membership === 'invite' || membership === 'join'
    } catch {
      return false
    }
  }

  // Canal existente da ACL (AclTelemetry.untranslated), não um mecanismo novo. `conceptKind:
  // 'member'` porque o que não pôde ser realizado foi uma membership; `eventType` carrega o nome do
  // sinal. UnsupportedShape é payload-free por construção (ADR-007 §3), então nem o roomId nem o
  // mxid do cofre vazam por aqui — o sinal diz O QUE falhou, nunca ONDE nem PARA QUEM.
  private signalUncovered(signal: string): void {
    this.opts.telemetry.untranslated({ conceptKind: 'member', shape: { eventType: signal } })
  }

  // ── F11: fila de convites estruturais deferidos por rate limit (PR-3.1) ────────────────────
  // Fora do caminho do verbo por desenho: o createChannel/openDirectMessage JÁ resolveu quando
  // isto roda. Drain SERIALIZADO (um invite em voo por vez — attempts rejeitados contam no
  // balde, medido na PR-4) num timer curto que só existe enquanto a fila não está vazia.
  private readonly custodyInviteQueue = new Map<string, { attempts: number; nextAttemptTs: number }>()
  private custodyDrainTimer: ReturnType<typeof setInterval> | undefined
  private custodyDraining = false

  private deferCustodyInvite(roomId: string, err: MatrixError): void {
    const entry = this.custodyInviteQueue.get(roomId) ?? { attempts: 0, nextAttemptTs: 0 }
    entry.attempts += 1
    if (entry.attempts >= CUSTODY_INVITE_MAX_ATTEMPTS) {
      // Teto: só AGORA a perda vira o fail-open do F1 — e a sala sai da fila.
      this.custodyInviteQueue.delete(roomId)
      this.stopCustodyDrainIfIdle()
      return this.signalUncovered(CUSTODY_SIGNAL_INVITE_FAILED)
    }
    const retryAfter = typeof err.data.retry_after_ms === 'number' ? err.data.retry_after_ms : CUSTODY_RETRY_DEFAULT_MS
    entry.nextAttemptTs = Date.now() + retryAfter + CUSTODY_RETRY_MARGIN_MS
    this.custodyInviteQueue.set(roomId, entry)
    this.signalUncovered(CUSTODY_SIGNAL_INVITE_DEFERRED)
    if (this.custodyDrainTimer === undefined) {
      this.custodyDrainTimer = setInterval(() => this.detach(this.drainCustodyInvites()), CUSTODY_DRAIN_TICK_MS)
    }
  }

  private async drainCustodyInvites(): Promise<void> {
    if (this.custodyDraining) return
    this.custodyDraining = true
    try {
      for (const [roomId, entry] of this.custodyInviteQueue) {
        if (Date.now() < entry.nextAttemptTs) continue
        const custodian = this.custodianMxid()
        const client = this.client
        if (!custodian || !client) {
          // Desconectado com fila viva: a sala não tem mais como ser convidada NESTA sessão.
          this.custodyInviteQueue.delete(roomId)
          this.signalUncovered(CUSTODY_SIGNAL_INVITE_FAILED)
          continue
        }
        try {
          await client.invite(roomId, custodian)
          this.noteInviteAccepted(roomId)
          // Sucesso tardio: a espera de membership do caminho imediato NÃO se aplica — o
          // verbo já resolveu há muito. Sessões nascidas antes deste invite são aceitas
          // (backup cobre o caso normal; gap composto registrado no §3/F11).
          this.custodyInviteQueue.delete(roomId)
        } catch (err) {
          if (err instanceof MatrixError && err.errcode === 'M_LIMIT_EXCEEDED') {
            this.deferCustodyInvite(roomId, err)
          } else {
            this.custodyInviteQueue.delete(roomId)
            if (!(await this.custodyAlreadyIn(roomId, custodian, err)))
              this.signalUncovered(CUSTODY_SIGNAL_INVITE_FAILED)
          }
        }
      }
    } finally {
      this.custodyDraining = false
      this.stopCustodyDrainIfIdle()
    }
  }

  private stopCustodyDrainIfIdle(): void {
    if (this.custodyInviteQueue.size === 0 && this.custodyDrainTimer !== undefined) {
      clearInterval(this.custodyDrainTimer)
      this.custodyDrainTimer = undefined
    }
  }

  // ── Channel lifecycle & membership verbs (PLANO-MEMBERSHIP-CANAIS §0.2) ────────────────────
  // Each verb is the SDK-side translation of a frozen product verb. The mutation is
  // resolve-on-confirm: the verb resolves on the server's accept and the STREAM (channel.added/
  // removed, member.changed, channel.changed) is the source of truth (ADR-026). A server refusal
  // — notably the PL guardrails of setRole — rejects HONESTLY (the Promise rejects), never
  // swallowed nor worked around.

  // Archive = the reversible custom state event io.tayet.archived (a non-destructive flag: membership
  // is preserved and the channel only leaves the active list — the rejected destructive alternatives
  // are recorded in ADR-026). Gated by PL: a server refusal for insufficient PL propagates honestly.
  // The inverse verb is unarchiveChannel (ADR-076), right below.
  async archiveChannel(id: ChannelId): Promise<void> {
    this.assertNotGroup(id)
    await this.require().sendStateEvent(
      channelIdToRaw(id) as string,
      'io.tayet.archived' as never,
      { active: true } as never,
      '',
    )
  }

  // ADR-076 dec. 1: un-archive flips the same state event off, same PL as archiveChannel; a refusal
  // propagates honestly. Not optimistic — the channel.added of the transition (onStateEvent) is the
  // confirmation.
  async unarchiveChannel(id: ChannelId): Promise<void> {
    await this.require().sendStateEvent(
      channelIdToRaw(id) as string,
      'io.tayet.archived' as never,
      { active: false } as never,
      '',
    )
  }

  // Edit channel metadata (m.room.name / m.room.topic via the canonical SDK seams). Both optional.
  async updateChannel(id: ChannelId, patch: ChannelPatch): Promise<void> {
    this.assertNotGroup(id)
    const client = this.require()
    const raw = channelIdToRaw(id)
    if (patch.name !== undefined) await client.setRoomName(raw, patch.name)
    if (patch.topic !== undefined) await client.setRoomTopic(raw, patch.topic)
  }

  // I leave the channel: leave + forget (≠ removeMember, which kicks someone else). forget drops it
  // from the room list so it does not linger after leaving (the stream emits channel.removed).
  async leaveChannel(id: ChannelId): Promise<void> {
    const client = this.require()
    const raw = channelIdToRaw(id)
    await client.leave(raw)
    await client.forget(raw)
  }

  async addMember(channelId: ChannelId, user: UserId): Promise<void> {
    // L19/ADR-007: the SDK errcode is detected and DISCARDED here (acl/internal); only a domain
    // error type crosses the barrel. M_LIMIT_EXCEEDED = the server's rate limit (rc_invites.per_user)
    // → RateLimitedError. Narrow of purpose, mirroring M_UNKNOWN_TOKEN → SessionExpiredError: ONLY
    // this errcode is remapped; everything else (network/transport/other errcode) propagates as-is,
    // so the panel's generic inline error still fires.
    // ADR-090 (Proposto) dec. 4: only the operator adds the agent. Contract-level backstop — the
    // candidate list offers only the session's own agents, so a UI path never reaches this throw.
    // ADR-094 (Proposto) dec. 7: a group's members are fixed (checked first: no write at all).
    this.assertNotGroup(channelId)
    this.assertNotOthersAgent(userIdToRaw(user))
    try {
      await this.require().invite(channelIdToRaw(channelId), userIdToRaw(user))
    } catch (e) {
      if (e instanceof MatrixError && e.errcode === 'M_LIMIT_EXCEEDED') throw new RateLimitedError()
      throw e
    }
  }

  // ADR-083: the escrow provisions the person (and `system` writes #all); the channels are the
  // admin's, with the admin's own token. A channel that fails does not undo the invite.
  async invitePerson({ name, email, kind, channels }: NewPerson): Promise<PersonInvite> {
    const outcome = await (this.people?.invite({ name, email, kind }) ?? { kind: 'unavailable' as const })
    if (outcome.kind === 'exists') throw new PersonExistsError()
    if (outcome.kind === 'unavailable') throw new PeopleUnavailableError()
    if (outcome.kind === 'rejected') throw new Error('Invite rejected')
    const id = brandUserId(outcome.userId)
    const failedChannels: ChannelId[] = []
    for (const channel of channels) {
      await this.addMember(channel, id).catch(() => failedChannels.push(channel))
    }
    return { user: { id, displayName: name, kind: outcome.personKind }, failedChannels }
  }

  async removePerson(user: UserId): Promise<void> {
    const outcome = await (this.people?.remove(userIdToRaw(user)) ?? { kind: 'unavailable' as const })
    if (outcome.kind === 'unavailable') throw new PeopleUnavailableError()
    if (outcome.kind === 'rejected') throw new Error('Removal rejected')
  }

  // ADR-086 (Proposto): the escrow creates, edits, reissues and removes the agent; `system` writes #all,
  // so the list follows through the stream. The token crosses once, as an opaque string.
  async createAgent(name: string, color: AgentColor): Promise<NewAgent> {
    const outcome = await (this.people?.createAgent({ name, color }) ?? { kind: 'unavailable' as const })
    if (outcome.kind === 'name_taken') throw new NameInUseError()
    if (outcome.kind === 'unavailable') throw new PeopleUnavailableError()
    if (outcome.kind === 'rejected') throw new Error('Agent rejected')
    return { userId: brandUserId(outcome.userId), token: outcome.token }
  }

  async updateAgent(user: UserId, patch: AgentPatch): Promise<void> {
    const outcome = await (this.people?.updateAgent(userIdToRaw(user), patch) ?? { kind: 'unavailable' as const })
    if (outcome.kind === 'name_taken') throw new NameInUseError()
    if (outcome.kind === 'unavailable') throw new PeopleUnavailableError()
    if (outcome.kind === 'rejected') throw new Error('Agent update rejected')
  }

  async reissueAgent(user: UserId): Promise<{ token: string }> {
    const outcome = await (this.people?.reissueAgent(userIdToRaw(user)) ?? { kind: 'unavailable' as const })
    if (outcome.kind === 'unavailable') throw new PeopleUnavailableError()
    if (outcome.kind === 'rejected') throw new Error('Agent reissue rejected')
    return { token: outcome.token }
  }

  async removeAgent(user: UserId): Promise<void> {
    const outcome = await (this.people?.removeAgent(userIdToRaw(user)) ?? { kind: 'unavailable' as const })
    if (outcome.kind === 'unavailable') throw new PeopleUnavailableError()
    if (outcome.kind === 'rejected') throw new Error('Agent removal rejected')
  }

  isOrgAdmin(): Promise<boolean> {
    this.orgAdmin ??= this.people?.isAdmin() ?? Promise.resolve(false)
    return this.orgAdmin
  }

  async removeMember(channelId: ChannelId, user: UserId): Promise<void> {
    this.assertNotGroup(channelId)
    await this.require().kick(channelIdToRaw(channelId), userIdToRaw(user))
  }

  // Role → power level (admin/50, member/0 — roleToPowerLevel). NO special handling of the Matrix PL
  // guardrails: a server error (demoting the creator/100, promoting above one's own PL) becomes a
  // DOMAIN rejection, not a fix. Owner-tier (PL 100) is deliberately outside Role (ADR-026).
  // ADR-083 dec. 4: a guest is never promoted — same honest rejection, decided here because the
  // server has no notion of kind and would accept the PL.
  async setRole(channelId: ChannelId, user: UserId, role: 'admin' | 'member'): Promise<void> {
    this.assertNotGroup(channelId)
    if (role === 'admin') {
      const kind = this.kindOf(userIdToRaw(user))
      if (kind === 'guest') throw new Error('Cannot promote a guest')
      // ADR-086 (Proposto) dec. 5: an agent is never admin.
      if (kind === 'agent') throw new Error('Cannot promote an agent')
    }
    await this.require().setPowerLevel(channelIdToRaw(channelId), userIdToRaw(user), roleToPowerLevel(role))
  }

  // Open (or reveal) a 1:1 DM — IDEMPOTENT (PLANO-MEMBERSHIP-CANAIS §0.2 / ADR-026 decision 5): an
  // existing DM with this user is never duplicated. We look it up via the m.direct account-data map
  // (keyed by user) AND an in-session memo, then create + mark m.direct only when none exists. The
  // in-session memo closes the m.direct sync-echo window so a fast second call still returns the same
  // room id (the durable copy lives in m.direct; this mirror keeps idempotency robust this session).
  async openDirectMessage(user: UserId): Promise<ChannelId> {
    const client = this.require()
    const rawUser = userIdToRaw(user)
    // PLANO-PRESENCA §8.6 item 2: the operator is never a DM target. Contract-level backstop —
    // the picker filters self out of the offer, so a UI path never reaches this throw.
    if (rawUser === client.getUserId())
      throw new Error('Cannot open a direct message with yourself')
    // ADR-090 (Proposto) dec. 4: only the operator opens a DM with the agent (same backstop idiom).
    this.assertNotOthersAgent(rawUser)
    // Session memo is authoritative for idempotency: a DM created/found THIS session is trusted
    // unconditionally — the room id is valid even before its first sync echo lands (getRoom() would
    // still be null right after createRoom). The membership check lives only on the cold m.direct
    // path below, to skip a DM left in a prior session.
    const memo = this.directRoomByUser.get(rawUser)
    if (memo) {
      // ADR-112 dec. 1: the first attempt may have failed at the map write; the retry completes it.
      if (!this.directRoomsFor(rawUser).includes(memo)) await this.addDirectRoom(rawUser, memo)
      return brandChannelId(memo)
    }
    for (const roomId of this.directRoomsFor(rawUser)) {
      if (client.getRoom(roomId)?.getMyMembership() === 'join') {
        this.directRoomByUser.set(rawUser, roomId)
        return brandChannelId(roomId)
      }
    }
    const res = await client.createRoom({
      preset: Preset.TrustedPrivateChat,
      is_direct: true,
      invite: [rawUser],
      initial_state: encryptedBirthState(),
    })
    this.directRoomByUser.set(rawUser, res.room_id)
    // Um DM passa a ter TRÊS membros no protocolo (eu, o par, o cofre) e continuar sendo um 1:1 no
    // produto: o cofre é filtrado em getMembers/member.changed, e roomToChannel o exclui do nome,
    // do avatar e do memberCount. m.direct segue mapeando só o par humano (addDirectRoom), o
    // que mantém isDm/dmPeerOf intocados.
    // ADR-112 dec. 1: the invite does not depend on the map. Both settle before a map failure is rethrown.
    const [mapWrite] = await Promise.allSettled([
      this.addDirectRoom(rawUser, res.room_id),
      this.inviteCustodian(res.room_id),
    ])
    if (mapWrite.status === 'rejected') throw mapWrite.reason
    return brandChannelId(res.room_id)
  }

  // ── Group conversation (ADR-094, Proposto; PLANO-CONVERSAS §0.3.2) ─────────────────────────────
  // Open (or reveal) a group with exactly these others — IDEMPOTENT by the exact set (dec. 8). Every refusal
  // happens before any write, with a neutral message (no id: it can reach UI copy). The session's own agent
  // may join, only here at creation and counted in the limit (dec. 7); another operator's agent is refused
  // (ADR-090 dec. 4). Birth (dec. 6): private preset, no name, the marker, encryption, and a users override
  // with the session at 100 and each member of the organization at 50 — a guest and an agent are left out
  // of the map (PL 0: they take part and cannot convert). The events map of the preset is not touched.
  async openGroupConversation(users: UserId[]): Promise<ChannelId> {
    const client = this.require()
    const me = client.getUserId()
    const raws = users.map((u) => userIdToRaw(u) as string)
    if (raws.some((u) => u === me)) throw new Error('Cannot include yourself in a group conversation')
    if (new Set(raws).size !== raws.length) throw new Error('A person appears more than once')
    if (raws.length < 2) throw new Error('A group conversation needs at least two other participants')
    if (raws.length > GROUP_MAX_OTHERS) throw new Error('Too many participants for a group conversation')
    for (const u of raws) this.assertNotOthersAgent(u)
    const key = [...raws].sort().join('\n')
    const existing = this.groupRoomFor(key)
    if (existing) return brandChannelId(existing)
    const powerUsers: Record<string, number> = {}
    if (me) powerUsers[me] = 100
    for (const u of raws) if (this.kindOf(u) === 'member') powerUsers[u] = 50
    // ADR-094 dec. 3: the opening is known before createRoom, so a join that lands before the answer is held.
    const opening = {}
    this.groupOpenings.add(opening)
    let res: { room_id: string }
    try {
      res = await client.createRoom({
        preset: Preset.PrivateChat,
        invite: raws,
        initial_state: [...encryptedBirthState(), { type: CONVERSATION_EVENT, state_key: '', content: { kind: 'group' } }],
        power_level_content_override: { users: powerUsers },
      })
      this.openedGroupRooms.set(res.room_id, key)
    } finally {
      this.groupOpenings.delete(opening)
      for (const [roomId, held] of this.heldGroupRooms) {
        held.waitFor.delete(opening)
        this.reviewHeldGroupRoom(roomId)
      }
    }
    this.groupRoomBySet.set(key, res.room_id)
    // ADR-057 dec. 2: an encrypted room gets the structural recipient, as a private channel does.
    await this.inviteCustodian(res.room_id)
    return brandChannelId(res.room_id)
  }

  // ADR-094 (Proposto) dec. 3: hold the creator's channel.added (an opening in flight, or the room of an answered
  // one), with a 3 s safety deadline from the join; a room that is already whole goes at once.
  private holdGroupRoom(roomId: string): void {
    const timer = setTimeout(() => this.releaseGroupRoom(roomId), 3000)
    this.heldGroupRooms.set(roomId, { timer, waitFor: new Set(this.groupOpenings) })
    this.reviewHeldGroupRoom(roomId)
  }

  // Release when the room is the opening's and whole (the marker, and its people exactly the set), or when it
  // is another room and every opening in flight at its join has answered (or failed).
  private reviewHeldGroupRoom(roomId: string): void {
    const held = this.heldGroupRooms.get(roomId)
    if (!held) return
    const key = this.openedGroupRooms.get(roomId)
    const room = this.client?.getRoom(roomId)
    if (key === undefined) {
      if (held.waitFor.size === 0) this.releaseGroupRoom(roomId)
      return
    }
    if (room && hasGroupMarker(room) && isGroupConversation(room, this.ctx()) && this.groupPeopleKey(room) === key)
      this.releaseGroupRoom(roomId)
  }

  private releaseGroupRoom(roomId: string): void {
    const held = this.heldGroupRooms.get(roomId)
    if (!held) return
    clearTimeout(held.timer)
    this.heldGroupRooms.delete(roomId)
    this.openedGroupRooms.delete(roomId)
    const room = this.client?.getRoom(roomId)
    if (!room || room.getMyMembership() !== 'join' || room.isSpaceRoom()) return
    this.emit({ t: 'channel.added', channel: roomToChannel(room, this.ctx(room)) })
  }

  // The group for an exact set of others. The memo wins while its room is still unknown to the store (right
  // after createRoom, before the sync echo) or still matches: this session in `join`, a group, and its people
  // exactly the set. Otherwise the entry drops and the cold path scans the joined groups; two matches (a race
  // between two sides, accepted like the DM's, ADR-044) resolve to the oldest creation, then the raw id.
  private groupRoomFor(key: string): string | undefined {
    const client = this.require()
    const ctx = this.ctx()
    const matches = (room: Room): boolean =>
      room.getMyMembership() === 'join' && isGroupConversation(room, ctx) && this.groupPeopleKey(room) === key
    const memo = this.groupRoomBySet.get(key)
    if (memo) {
      const room = client.getRoom(memo)
      if (!room || matches(room)) return memo
      this.groupRoomBySet.delete(key)
    }
    const createdAt = (room: Room): number => room.currentState.getStateEvents(EventType.RoomCreate, '')?.getTs() ?? Infinity
    const found = client
      .getRooms()
      .filter((room) => hasGroupMarker(room) && matches(room))
      .sort((a, b) => createdAt(a) - createdAt(b) || (a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : 0))[0]
    if (!found) return undefined
    this.groupRoomBySet.set(key, found.roomId)
    return found.roomId
  }

  // The people of a room as the memo key: members in `join` or `invite`, without the session, the custody and
  // the system account (the same people as the group's `participants`, ADR-094 dec. 4), raw ids sorted.
  private groupPeopleKey(room: Room): string {
    const me = this.client?.getUserId()
    return room
      .getMembers()
      .filter((m) => m.membership === 'join' || m.membership === 'invite')
      .map((m) => m.userId)
      .filter((u) => u !== me && !this.isCustodian(u) && !this.isSystemAccount(u))
      .sort()
      .join('\n')
  }

  // ADR-094 (Proposto) dec. 9: the same room becomes a private channel. Name first, marker second: a failure
  // on the marker leaves an intact group (with a name it never shows, dec. 4), and repeating the verb
  // completes. The power to send both is read from the room's power levels — a PL 50 member of the
  // organization has it from birth, a guest or an agent does not. No alias and no unique-name check, as in
  // createChannel. The memo entry pointing at the room drops: it is no longer a group.
  async convertToChannel(id: ChannelId, name: string): Promise<void> {
    const client = this.require()
    const raw = channelIdToRaw(id) as string
    const room = client.getRoom(raw)
    if (!room || room.getMyMembership() !== 'join' || !hasGroupMarker(room) || !isGroupConversation(room, this.ctx()))
      throw new Error('Only a group conversation can become a channel')
    const trimmed = name.trim()
    if (!trimmed) throw new Error('A channel needs a name')
    const me = client.getUserId()
    if (
      !me ||
      !room.currentState.maySendStateEvent(EventType.RoomName, me) ||
      !room.currentState.maySendStateEvent(CONVERSATION_EVENT as never, me)
    )
      throw new Error('Not allowed to turn this conversation into a channel')
    for (const [key, roomId] of this.groupRoomBySet) if (roomId === raw) this.groupRoomBySet.delete(key)
    await client.setRoomName(raw, trimmed)
    await client.sendStateEvent(raw, CONVERSATION_EVENT as never, { kind: 'channel' } as never, '')
  }

  // ADR-094 (Proposto) dec. 7 and 13: a group has fixed members and no management — adding, removing, a
  // role, renaming, the topic and archiving refuse before any write. Only the product enforces it (invite
  // is PL 0 on the protocol). The marker alone first, so a channel never pays for the context.
  private assertNotGroup(id: ChannelId): void {
    const room = this.require().getRoom(channelIdToRaw(id) as string)
    if (room && hasGroupMarker(room) && isGroupConversation(room, this.ctx()))
      throw new Error('A group conversation cannot be managed; turn it into a channel first')
  }

  // Room ids the m.direct map tags as DMs WITH this user (account data, keyed userId → roomId[]).
  private directRoomsFor(rawUser: string): string[] {
    const ev = this.require().getAccountData(EventType.Direct as keyof AccountDataEvents)
    const content = (ev?.getContent() ?? {}) as Record<string, unknown>
    const v = content[rawUser]
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []
  }

  // Read-union-write the m.direct map (last-write-wins per key, so re-read immediately before
  // writing). Mirrors persistAcknowledged; the key is a protocol detail that never crosses the barrel.
  private async addDirectRoom(rawUser: string, roomId: string): Promise<void> {
    const client = this.client
    if (!client) return
    const ev = client.getAccountData(EventType.Direct as keyof AccountDataEvents)
    const content = { ...((ev?.getContent() ?? {}) as Record<string, string[]>) }
    const list = Array.isArray(content[rawUser]) ? content[rawUser] : []
    if (!list.includes(roomId)) content[rawUser] = [...list, roomId]
    await client.setAccountData(
      EventType.Direct as keyof WritableAccountDataEvents,
      content as unknown as AccountDataEvents[keyof WritableAccountDataEvents],
    )
  }

  // Auto-join an invite WITHOUT explicit acceptance (ADR-044). In a corporate Model B you don't
  // "accept" a DM or a channel you were added to — it just appears. The invitee side reads whether
  // this was a direct invite, and who the inviter is, from the invite member event BEFORE joining
  // (after join, events.member becomes the join event and the invite signal is gone). On a direct
  // invite it converges the DM map on the invitee's side so the SAME conversation resolves to one
  // room both ways (the bug: each side had created/seen only its own room). This method must NOT
  // emit channel.added — the invite→join transition re-fires MyMembership and the existing →join
  // branch emits it; emitting here too would double-add. A join failure is swallowed (the caller is
  // a void listener; an unhandled rejection would leak) and clears the in-flight guard.
  private async autoJoinInvite(room: Room): Promise<void> {
    const client = this.client
    if (!client) return
    const roomId = room.roomId
    if (this.joiningInvites.has(roomId)) return
    const myUserId = client.getUserId()
    const inviteEvent = myUserId ? room.getMember(myUserId)?.events.member : undefined
    const direct = inviteEvent?.getContent()?.is_direct === true
    const inviter = inviteEvent?.getSender()
    this.joiningInvites.add(roomId)
    try {
      // Mark m.direct BEFORE joining: setAccountData awaits the sync echo (41.6.0), so by the time
      // joinRoom fires the invite->join transition, the store already reflects m.direct and the
      // resulting channel.added classifies this room as a DM on the invitee side (no AccountData
      // listener reclassifies after the fact). On a non-direct (channel) invite this is skipped and
      // the room correctly stays a non-DM.
      if (direct && inviter) await this.addDirectRoom(inviter, roomId)
      // Owed before joining: the sync may deliver the join (and the ->join transition) before joinRoom
      // resolves. Whichever sees the join event first sends the receipt.
      this.entryReceiptsOwed.add(roomId)
      await client.joinRoom(roomId)
      this.sendEntryReceipt(client.getRoom(roomId))
    } catch {
      // Swallow: no error channel in AclTelemetry; the guard is cleared below so a later
      // MyMembership fire for the same invite can retry.
      this.entryReceiptsOwed.delete(roomId)
    } finally {
      this.joiningInvites.delete(roomId)
    }
  }

  // The organization channel's alias: built from the operator's own mxid domain (everything after
  // the first ':' of getUserId()), never a hardcoded server_name (dev = tayet.local, prod = other).
  private orgChannelAlias(): string | null {
    const userId = this.client?.getUserId()
    return userId ? `#${ORG_CHANNEL_LOCALPART}:${userId.slice(userId.indexOf(':') + 1)}` : null
  }

  // Accepts the pending invite to the organization channel (ADR-083 dec. 2, revises ADR-045 dec. 4).
  // With no invite this does nothing: that is a guest. autoJoinInvite is the single choke point: the
  // stream's MyMembership branch reaches it for the same invite, and its in-flight guard keeps it to
  // one join. This call only covers an invite the stream did not hand over. channel.added is emitted
  // by the →join transition (ADR-026); nothing is emitted manually here.
  private async joinOrgChannel(): Promise<void> {
    const client = this.client
    const alias = this.orgChannelAlias()
    if (!client || !alias) return
    const invite = client.getRooms().find((r) => r.getMyMembership() === 'invite' && r.getCanonicalAlias() === alias)
    if (invite) await this.autoJoinInvite(invite)
  }

  // ADR-083 dec. 3: read from the organization channel's state, which the sync already delivers.
  // Absent event = guest; a removal leaves empty content, so it reads as absent too. Outside that
  // channel the operator is a guest and a guest classifies no one: it only knows itself, so the others
  // fall back to the rule before ADR-083 (role by power level), not to a "Convidado" label for all.
  // ADR-086 (Proposto) dec. 2: the reserved agent prefix is checked BEFORE the state, so every session
  // (a guest's included) reads an agent as an agent. Dec. 4: a tombstone (`removed: true`) is absence.
  private kindOf(mxid: string): UserKind {
    if (this.isAgentAccount(mxid)) return 'agent'
    const org = this.joinedOrgChannel()
    if (!org) return mxid === this.client?.getUserId() ? 'guest' : 'member'
    const content = org.currentState.getStateEvents(ORG_MEMBER_EVENT, mxid.slice(1))?.getContent<{ kind?: unknown; removed?: unknown }>()
    return !isTombstone(content) && content?.kind === 'member' ? 'member' : 'guest'
  }

  // ADR-086 (Proposto) dec. 1/3: an agent's colour and operator, from its io.tayet.member on the
  // organization channel (written by `system` only). Without that channel (a guest) or the event,
  // undefined: the translation falls back to 'areia' and no operator (PLANO-AGENTES §0.1 item 5). The
  // operator is recorded as a localpart; its name is the live member name, else the name the admin
  // typed — never the localpart (that would be a protocol id on screen).
  private agentOf(mxid: string): { color?: AgentColor; operatorName?: string } | undefined {
    const org = this.joinedOrgChannel()
    if (!org) return undefined
    const content = org.currentState
      .getStateEvents(ORG_MEMBER_EVENT, mxid.slice(1))
      ?.getContent<{ color?: unknown; operator?: unknown; removed?: unknown }>()
    if (!content || isTombstone(content)) return undefined
    const color = isAgentColor(content.color) ? content.color : undefined
    let operatorName: string | undefined
    if (typeof content.operator === 'string' && content.operator.length > 0 && mxid.includes(':')) {
      const operator = `@${content.operator}${mxid.slice(mxid.indexOf(':'))}`
      const live = org.getMember(operator)?.rawDisplayName
      const typed = org.currentState
        .getStateEvents(ORG_MEMBER_EVENT, operator.slice(1))
        ?.getContent<{ name?: unknown }>().name
      const name = live && live !== operator ? live : typeof typed === 'string' ? typed : undefined
      if (name?.trim()) operatorName = cleanDisplayName(name, operator)
    }
    return { ...(color && { color }), ...(operatorName !== undefined && { operatorName }) }
  }

  // ADR-086 dec. 6 (client UX): the names of the agents this session knows — the organization
  // channel's live agents and the agents met in shared rooms — normalized like the escrow does.
  private knownAgentNames(): Set<string> {
    const client = this.require()
    const names = new Set<string>()
    const org = this.joinedOrgChannel()
    for (const event of org?.currentState.getStateEvents(ORG_MEMBER_EVENT) ?? []) {
      const content = event.getContent<{ name?: unknown; removed?: unknown }>()
      if (isTombstone(content) || !this.isAgentAccount(`@${event.getStateKey() ?? ''}`)) continue
      if (typeof content.name === 'string') names.add(normalizeName(content.name))
    }
    for (const room of client.getRooms()) {
      if (room.getMyMembership() !== 'join') continue
      for (const m of room.getMembers()) {
        if (this.isAgentAccount(m.userId) && m.rawDisplayName && m.rawDisplayName !== m.userId) names.add(normalizeName(m.rawDisplayName))
      }
    }
    return names
  }

  // Memoized: kindOf runs once per roster line, and the roster of the organization channel is the
  // whole organization.
  private joinedOrgChannel(): Room | undefined {
    const client = this.client
    const alias = this.orgChannelAlias()
    if (!client || !alias) return undefined
    const known = this.orgChannelId ? client.getRoom(this.orgChannelId) : null
    if (known?.getMyMembership() === 'join') return known
    const found = client.getRooms().find((r) => r.getMyMembership() === 'join' && r.getCanonicalAlias() === alias)
    this.orgChannelId = found?.roomId
    return found
  }

  // Is this room archived? Reads the custom reversible state event io.tayet.archived (ADR-026).
  private isArchived(room: Room): boolean {
    const ev = room.currentState.getStateEvents('io.tayet.archived', '')
    return ev?.getContent()?.active === true
  }

  // ── Outbound reads (SDK → domain) ────────────────────────────────────────────────────────
  // getChannels() is only-active (ADR-026 §3): archived channels are filtered so the cold-start
  // snapshot does not diverge from the stream (which removed them via channel.removed).
  getChannels(): Channel[] {
    const ctx = this.ctx()
    return this.require()
      .getRooms()
      .filter((r) => r.getMyMembership() === 'join' && !r.isSpaceRoom() && !this.isArchived(r))
      .map((r) => roomToChannel(r, ctx))
  }

  // ADR-076 dec. 3: the archived read — getChannels() with the archive filter inverted. The join
  // filter keeps a channel I was kicked/banned from (still in the store as leave) out of the list.
  getArchivedChannels(): Channel[] {
    const ctx = this.ctx()
    return this.require()
      .getRooms()
      .filter((r) => r.getMyMembership() === 'join' && !r.isSpaceRoom() && this.isArchived(r))
      .map((r) => roomToChannel(r, ctx))
  }

  getChannel(id: ChannelId): Channel {
    return roomToChannel(this.requireRoom(id), this.ctx())
  }

  getMembers(id: ChannelId): RosterEntry[] {
    const room = this.requireRoom(id)
    const ctx = this.ctx(room)
    // Joined = active; invited = added-but-not-yet-connected (PLANO §8.CONVITE). Both cross;
    // memberToUserRole stamps `state` from membership. The invite→join flip surfaces via the
    // existing member.changed re-fetch (self-heal) — no stream change needed.
    // ADR-057 dec. 2 (P1 estendido a "infra invisível"): o destinatário estrutural NUNCA cruza o
    // barrel. Este é um dos dois choke points — o outro é a emissão de member.changed. Tudo que a
    // UI sabe sobre membership passa por um dos dois, então `listKnownContacts`, o roster do manage
    // panel, o picker de DM e os contadores herdam a ocultação por construção (verificado por grep:
    // nenhum consumidor chama getMembers do SDK direto fora daqui e de roomToChannel).
    // ADR-083 dec. 5: a conta de sistema sai pelos mesmos dois choke points.
    const custodian = this.custodianMxid()
    const systemAccount = this.systemAccountMxid()
    // ADR-081: only the boolean crosses; the session's id stays here.
    const me = this.client?.getUserId()
    return room
      .getMembers()
      .filter((m) => m.membership === 'join' || m.membership === 'invite')
      .filter((m) => m.userId !== custodian && m.userId !== systemAccount)
      .map((m) => memberToUserRole(m, ctx, m.userId === me))
  }

  // ADR-083: io.tayet.member of the organization channel is the single source. Pending = the member's
  // invite to that channel; a guest never gets one, so theirs is an invite to a channel shared with
  // this session, and a guest in none of them has no state to show.
  listPeople(): Person[] {
    const org = this.joinedOrgChannel()
    if (!org) return []
    const client = this.require()
    const ctx = this.ctx(org)
    const me = client.getUserId()
    const shared = client.getRooms().filter((r) => r.getMyMembership() === 'join' && r.roomId !== org.roomId)
    return org.currentState.getStateEvents(ORG_MEMBER_EVENT).flatMap((event) => {
      const mxid = `@${event.getStateKey() ?? ''}`
      const content = event.getContent<{ kind?: unknown; name?: unknown; email?: unknown; removed?: unknown }>()
      // ADR-086 (Proposto) dec. 2: 'agent' comes from the reserved prefix only, as in kindOf — the
      // recorded kind neither grants nor removes it. An agent is listed like a guest (outside #all);
      // a tombstone is absence.
      const kind = this.isAgentAccount(mxid) ? 'agent' : content.kind
      if (isTombstone(content) || this.isCustodian(mxid) || this.isSystemAccount(mxid)) return []
      if (kind !== 'member' && kind !== 'guest' && kind !== 'agent') return []
      if (kind === 'agent' && !this.isAgentAccount(mxid)) return []
      const orgMember = org.getMember(mxid)
      const seenIn = shared.map((r) => r.getMember(mxid)).filter((m) => m !== null)
      // ADR-086; account-access.md §11: an agent's line reads "operado por" and "Remover", never pending —
      // the agent does not accept an invite like a person, so its `invite` in a shared room is no state.
      const pending =
        kind === 'member'
          ? orgMember?.membership === 'invite'
          : kind === 'guest'
            ? seenIn.some((m) => m.membership === 'invite')
            : false
      return [
        orgEventToPerson(
          { mxid, kind, content, member: orgMember ?? seenIn[0] ?? null },
          { pending, self: mxid === me },
          ctx,
        ),
      ]
    })
  }

  // ADR-090 (Proposto) dec. 3: the agents this session operates, from #all — the only agents the
  // known set offers. Built like listPeople's line (orgEventToPerson), so kind/colour/operatorName
  // match; no new field crosses. Without #all → [] (fail-closed). Sorted by name; the UI re-sorts
  // the merged offer with its locale.
  listOwnAgents(): User[] {
    const org = this.joinedOrgChannel()
    if (!org) return []
    const client = this.require()
    const ctx = this.ctx(org)
    const shared = client.getRooms().filter((r) => r.getMyMembership() === 'join' && r.roomId !== org.roomId)
    return org.currentState
      .getStateEvents(ORG_MEMBER_EVENT)
      .flatMap((event) => {
        const mxid = `@${event.getStateKey() ?? ''}`
        if (!this.isOwnAgent(mxid)) return []
        const content = event.getContent<{ name?: unknown }>()
        const member = shared.map((r) => r.getMember(mxid)).find((m) => m !== null) ?? null
        return [orgEventToPerson({ mxid, kind: 'agent', content: { name: content.name }, member }, { pending: false, self: false }, ctx).user]
      })
      .sort((a, b) => a.displayName.localeCompare(b.displayName))
  }

  // ADR-056: synchronous point read off the presence map — never a network call. A user the
  // stream has not spoken about resolves 'offline' (unknown ≡ offline, no fourth state).
  getPresence(user: UserId): Presence {
    return this.presenceByUser.get(userIdToRaw(user)) ?? 'offline'
  }

  // ── Self-identity (ADR-039) ───────────────────────────────────────────────────────────────
  // Derives a domain User from the canonical whoami id (client.getUserId() — the same identity
  // already used in this file to derive Message.mine). Built by the SAME path as getMembers:
  // selfToUser reuses brandUserId + the profile's clean displayName/avatar (cleanDisplayName +
  // the opaque mediaRefFor). The mxid and the whoami stay confined to the ACL — only the opaque
  // User crosses (P1, mirrors `mine`). getUserId() is null pre-ready; we throw, since the boot
  // only ever calls this post-ready (never a silent empty-id User).
  // ADR-083: the SDK's User gets its name from a member event of a joined room, and until then holds
  // the mxid. A person on the first boot has no joined room yet (the invite is still being accepted,
  // or a guest has none), so the name comes from the profile; a failed read falls back as before.
  async currentUser(): Promise<User> {
    const { userId, rawDisplayName, avatarUrl } = await this.selfProfile()
    return selfToUser(userId, rawDisplayName, avatarUrl, this.ctx())
  }

  private async selfProfile(): Promise<{ userId: string; rawDisplayName?: string; avatarUrl?: string }> {
    const client = this.require()
    const userId = client.getUserId()
    if (!userId) throw new Error('current user unavailable: identity not ready')
    const profile = client.getUser(userId)
    const known = profile?.rawDisplayName
    if (known && known !== userId) return { userId, rawDisplayName: known, avatarUrl: profile?.avatarUrl }
    const fetched = await client.getProfileInfo(userId).catch(() => null)
    return { userId, rawDisplayName: fetched?.displayname, avatarUrl: fetched?.avatar_url ?? profile?.avatarUrl }
  }

  // ── Editable profile (ADR-040) ────────────────────────────────────────────────────────────
  // The org-managed name the client can see IS the Matrix displayName (MAS-seeded from the IdP `name`
  // claim at registration). cleanSelfDisplayName mirrors selfToUser's cleaning: an mxid-shaped raw name
  // collapses to its localpart, so fullName is NEVER an mxid. Throws pre-ready (boot only calls this
  // post-ready), same contract as currentUser.
  private async cleanSelfDisplayName(): Promise<string> {
    const { userId, rawDisplayName } = await this.selfProfile()
    return cleanDisplayName(rawDisplayName, userId)
  }

  // getMyProfile: fullName resolve em TRÊS níveis (ADR-054 dec. 7): diretório (camada organizacional,
  // a autoridade) ?? snapshot em account-data ?? displayName vivo limpo. O snapshot PERMANECE — vira
  // fallback pré-sync, pra conta que o sync de diretório ainda não alcançou. A migração do ADR-040 é
  // por PRECEDÊNCIA, não por remoção: nenhum caminho antigo foi cortado, só passou a ceder ao
  // diretório quando ele existe. nickname continua vindo do account data. No write here — the
  // snapshot is captured at the write site.
  // ADR-041: avatar = the live profile avatar_url minted to an opaque MediaRef (same mintMediaRef
  // mapper selfToUser uses; the mxc stays confined). Absent avatar_url → undefined (no photo).
  // ADR-042: pronouns = extended profile (MSC4133) read fail-soft — propriedade ausente / servidor sem a
  // flag → undefined, nunca throw (P4). A chave io.tayet.pronouns fica confinada aqui (mesma postura do
  // PROFILE_KEY); só o valor string cruza o barrel.
  // ADR-053: note = recado auto-autorado, MESMO sink dos pronomes (perfil estendido, classe (c) — não
  // classe nova). Lido na mesma volta e com o mesmo fail-soft; a chave fica confinada aqui igual.
  async getMyProfile(): Promise<MyProfile> {
    const client = this.require()
    const raw = client.getAccountData(PROFILE_KEY as keyof AccountDataEvents)?.getContent()
    const { fullName, nickname } = readProfile(raw)
    const userId = client.getUserId()
    const avatarUrl = userId ? client.getUser(userId)?.avatarUrl : undefined
    const avatar = avatarUrl ? this.mintMediaRef(avatarUrl) : undefined
    let pronouns: string | undefined
    let note: string | undefined
    let org: OrgFields | undefined
    const myId = client.getUserId()
    if (myId) {
      // ADR-053: uma volta só traz pronomes + recado (o perfil estendido é um documento, mesma forma
      // do getUserProfile). Cada valor é validado por si: recado ausente/malformado não some com os
      // pronomes. ADR-054: a camada organizacional vem na MESMA volta, pelo mesmo motivo.
      try {
        const ext = await client.getExtendedProfile(myId) // Record<string, unknown> (§0.4)
        const p = ext[PRONOUNS_KEY]
        pronouns = typeof p === 'string' && p.length > 0 ? p : undefined
        const n = ext[NOTE_KEY]
        note = typeof n === 'string' && n.length > 0 ? n : undefined
        org = readOrgFields(ext)
      } catch {
        // perfil estendido ausente/indisponível — degrada limpo, nunca throw (8.P3). O fullName cai
        // sozinho pra precedência antiga (snapshot ?? displayName vivo): org undefined some do ??.
        pronouns = undefined
        note = undefined
        org = undefined
      }
    }
    return { fullName: org?.fullName ?? fullName ?? (await this.cleanSelfDisplayName()), nickname, avatar, pronouns, note, org }
  }

  // ── Perfil de outro usuário (ADR-043) ─────────────────────────────────────────────────────
  // Uma volta via getExtendedProfile(raw): displayname + avatar_url + io.tayet.pronouns juntos (MSC4133 on,
  // provado no read-back do ADR-042). Fail-soft: se a leitura estendida falhar, cai pro cache de room-state
  // (client.getUser — o alvo é in-room, já renderizado no roster/autor) com pronomes ausente; nunca throw.
  // Limpeza/opacidade idênticas a currentUser (cleanDisplayName + mintMediaRef); mxid/avatar_url confinados.
  // ADR-053: o recado vem na MESMA volta (mesmo documento estendido, chave distinta) — custo zero. O
  // fallback de room-state não o tem: não há fonte de recado no state da sala, só nome+avatar.
  // ADR-083 dec. 6: quem não compartilha sala cai aqui pelo 403 do ADR-052, agora alcançável por guest.
  // Sem rejeição, o dialog não mostra profile.loadFailed: o perfil vem só com nome e sem org.
  async getUserProfile(user: UserId): Promise<UserProfile> {
    const client = this.require()
    const raw = userIdToRaw(user)
    let displayName: string
    let avatar: MediaRef | undefined
    let pronouns: string | undefined
    let note: string | undefined
    let org: OrgFields | undefined
    try {
      const ext = await client.getExtendedProfile(raw) // Record<string, unknown> (§0.4)
      const dn = typeof ext.displayname === 'string' ? ext.displayname : undefined
      displayName = cleanDisplayName(dn, raw)
      const au = typeof ext.avatar_url === 'string' && ext.avatar_url.length > 0 ? ext.avatar_url : undefined
      avatar = au ? this.mintMediaRef(au) : undefined
      const p = ext[PRONOUNS_KEY]
      pronouns = typeof p === 'string' && p.length > 0 ? p : undefined
      const n = ext[NOTE_KEY]
      note = typeof n === 'string' && n.length > 0 ? n : undefined
      org = readOrgFields(ext)
    } catch {
      const u = client.getUser(raw) // fail-soft: cache in-room; pronomes ausente
      // P1: someone only `invite` (an agent added by its operator before its process runs, a person
      // not connected yet) has no SDK User name; the member event of a shared room carries it. Without
      // it cleanDisplayName would fall back to the localpart — a protocol id on screen.
      const known = (name: string | undefined): string | undefined => (name && name !== raw ? name : undefined)
      const memberName = client
        .getRooms()
        .map((r) => known(r.getMember(raw)?.rawDisplayName))
        .find((name) => name !== undefined)
      displayName = cleanDisplayName(known(u?.rawDisplayName) ?? memberName, raw)
      avatar = u?.avatarUrl ? this.mintMediaRef(u.avatarUrl) : undefined
      pronouns = undefined
      note = undefined // o room-state não carrega recado — a ausência é decisão, não esquecimento
      org = undefined // idem pra camada organizacional: o room-state não a carrega (ADR-054)
    }
    const kind = this.kindOf(raw)
    return { id: user, displayName, kind, ...agentFieldsOf(raw, kind, { agentOf: (mxid) => this.agentOf(mxid) }), avatar, pronouns, note, org }
  }

  // updateMyProfile (ADR-042, generaliza setNickname): patch por presença de chave. 'nickname' in patch →
  // captura fullName (o nome da org) no 1º write — neste momento, se nenhum apelido foi setado, displayName
  // É o nome da org. Persiste {fullName, nickname} e seta o displayName efetivo = nickname || fullName; ''
  // limpa → reverte ao fullName. 'pronouns' in patch → escreve/limpa o campo estendido MSC4133 (sink
  // distinto do account-data); '' deleta a propriedade. 'note' in patch → idem, no MESMO sink dos
  // pronomes, chave distinta (ADR-053): as duas são independentes — uma no patch não mexe na outra.
  // Chave/mxid/claims confinados aqui; só strings limpas tocam o SDK. P1.
  async updateMyProfile(patch: { nickname?: string; pronouns?: string; note?: string }): Promise<void> {
    const client = this.require()
    const nickname = patch.nickname?.trim()
    if (nickname && this.knownAgentNames().has(normalizeName(nickname))) throw new NameInUseError()
    if ('nickname' in patch) {
      const raw = client.getAccountData(PROFILE_KEY as keyof AccountDataEvents)?.getContent()
      const existing = readProfile(raw)
      const fullName = existing.fullName ?? (await this.cleanSelfDisplayName())
      const content = writeProfile(raw, { fullName, nickname: patch.nickname ?? '' })
      await client.setAccountData(
        PROFILE_KEY as keyof WritableAccountDataEvents,
        content as unknown as AccountDataEvents[keyof WritableAccountDataEvents],
      )
      await client.setDisplayName((patch.nickname ?? '').trim() || fullName)
    }
    if ('pronouns' in patch) {
      const p = patch.pronouns?.trim()
      if (p) await client.setExtendedProfileProperty(PRONOUNS_KEY, p)
      else await client.deleteExtendedProfileProperty(PRONOUNS_KEY)
    }
    if ('note' in patch) {
      const n = patch.note?.trim()
      if (n) await client.setExtendedProfileProperty(NOTE_KEY, n)
      else await client.deleteExtendedProfileProperty(NOTE_KEY)
    }
  }

  // ── Foto de perfil (ADR-041) ──────────────────────────────────────────────────────────────
  // Avatar é mídia de perfil PÚBLICA (perfil Matrix não é E2E) → upload cleartext via uploadContent
  // (o caminho da Fase-1, sem cifra), nunca attachment-crypto. File limpo entra; o mxc fica confinado
  // aqui (chamadas do SDK) e em mintMediaRef; volta um MediaRef opaco (token mr_*, mesmo mapeador que
  // selfToUser usa via ctx.mediaRefFor — NÃO o mxc cru). setAvatar: upload → setAvatarUrl(mxc) → cunha
  // o MediaRef do mxc fresco. removeAvatar: setAvatarUrl('') limpa a foto.
  async setAvatar(file: File): Promise<MediaRef> {
    const client = this.require()
    const uploaded = await client.uploadContent(file) // cleartext — sem cifra
    const mxc = uploaded.content_uri
    await client.setAvatarUrl(mxc)
    return this.mintMediaRef(mxc) // mesmo mapeador de selfToUser (opaco; o mxc não cruza)
  }

  async removeAvatar(): Promise<void> {
    const client = this.require()
    await client.setAvatarUrl('')
  }

  // ── Account preferences ──────────────────────────────────────────────────────────────────
  // Both verbs go straight to the account-data endpoint, like refreshAcknowledged. The read skips the
  // synced cache: right after a reload it can come from Synapse's /sync response cache and miss a write
  // already on the server, and the boot reads right after the reload that follows a language change.
  // The cache only answers "has this account ever stored preferences": no key there and no `fresh`
  // means no request, so an account that never chose anything does not pay a 404 on every boot. The
  // write follows the same rule for the read it merges over: with no key in the cache it writes the
  // patch alone, so an account's first choice does not pay a 404 either (what it can lose is an unknown
  // field another device stored while the cache was behind). It uses authedRequest rather than
  // setAccountData, which also waits for the sync echo; the caller reloads on the server's answer and
  // has no use for the echo.
  async getAccountPreferences(opts?: { fresh?: boolean }): Promise<AccountPreferences> {
    const client = this.require()
    if (!opts?.fresh && !this.hasCachedPreferences(client)) return {}
    return readPreferences(await this.fetchPreferences(client))
  }

  async setAccountPreferences(patch: { language?: string }): Promise<void> {
    const client = this.require()
    const current = this.hasCachedPreferences(client) ? await this.fetchPreferences(client) : undefined
    await client.http.authedRequest(Method.Put, this.preferencesPath(client), undefined, writePreferences(current, patch))
  }

  private hasCachedPreferences(client: MatrixClient): boolean {
    return client.getAccountData(PREFERENCES_KEY as keyof AccountDataEvents) !== undefined
  }

  private preferencesPath(client: MatrixClient): string {
    const userId = client.getUserId()
    if (!userId) throw new Error('no session')
    return `/user/${encodeURIComponent(userId)}/account_data/${encodeURIComponent(PREFERENCES_KEY)}`
  }

  // The stored content, or undefined when the account has none (M_NOT_FOUND). Other failures reject.
  private async fetchPreferences(client: MatrixClient): Promise<unknown> {
    try {
      return await client.http.authedRequest(Method.Get, this.preferencesPath(client))
    } catch (e) {
      if (e instanceof MatrixError && e.errcode === 'M_NOT_FOUND') return undefined
      throw e
    }
  }

  async getDevices(): Promise<Device[]> {
    const client = this.require()
    const res = await client.getDevices()
    // Derivação de `current` mora aqui — onde o myDeviceId naturalmente está (espelha `mine`,
    // derivado onde o self-id é conhecido). O device_id cru nunca cruza: só o booleano. §8.A3 / P1.
    const myDeviceId = client.getDeviceId()
    return res.devices.map((d) => ({
      ...deviceToDomain(d),
      current: myDeviceId != null && d.device_id === myDeviceId,
    }))
  }

  // ── New-access acknowledgement (ADR-018 §2.2 / §4) ────────────────────────────────────────
  // FROZEN signature: returns void (success is the absence of re-emission). Records the access
  // locally so this session stops re-emitting at once, then persists asynchronously. A write
  // failure degrades to a benign re-notification on the next cold start — never a hidden access.
  // ADR-063, adendo 2 (§8.38): the access also goes to the pending list (localStorage), synchronously
  // and BEFORE the PUT, so the next boot of this account knows about it even if the PUT dies with the
  // page or lands after that boot's server read.
  acknowledgeAccess(access: AccessId): void {
    const deviceId = accessIdToRaw(access)
    this.acknowledgedDevices.add(deviceId)
    const userId = this.client?.getUserId()
    if (userId) addPendingRecognition(userId, deviceId)
    this.persistAcknowledged()
  }

  // Write the recognized set to the custom account-data key (ADR-018 §4). The key is a protocol detail
  // and never crosses the barrel; no payload reaches telemetry on failure (P1).
  //
  // Base of the union (ADR-063, adendo; PLANO-RELEASE-PUBLICA §8.31): the in-memory set — the boot's
  // cache read ∪ the boot's server read ∪ every sync echo (both keys, legacy included) ∪ this session's
  // own acknowledgements — NOT getAccountData. Right after a reload the synced cache can come from
  // Synapse's /sync response cache and miss acknowledgements already on the server; a union over it
  // used to write them away. A GET before the PUT is ruled out: it would reopen the unload window
  // §8.30 closed. The write goes ONLY to the current key (legacy is never touched).
  //
  // Serialized and coalesced: one PUT in flight at a time; acknowledgements during a flight mark it
  // dirty and ONE more PUT with the whole set follows. Every PUT goes with keepalive (§8.30): same path
  // setAccountDataRaw builds, through the SDK's own authedRequest, with the same retry. The write waits
  // for the boot's server read only while it is still pending; a failed read degrades to the set as it
  // is (ADR-018 §4). Unchanged content against what this session knows is on the server → no request.
  private persistAcknowledged(): void {
    if (this.ackWriting) {
      this.ackDirty = true
      return
    }
    const client = this.client
    if (!client) return
    this.ackWriting = true
    this.detach(this.drainAcknowledged(client))
  }

  private async drainAcknowledged(client: MatrixClient): Promise<void> {
    try {
      const userId = client.getUserId()
      if (!userId) return
      const path = `/user/${encodeURIComponent(userId)}/account_data/${encodeURIComponent(ACKNOWLEDGED_DEVICES_KEY)}`
      await this.ackServerRead
      do {
        this.ackDirty = false
        if (this.client !== client) return // disconnected
        const devices = [...this.acknowledgedDevices]
        const known = this.ackServerCurrent
        if (known && known.size === devices.length && devices.every((d) => known.has(d))) continue
        try {
          await retryNetworkOperation(5, () =>
            client.http.authedRequest(Method.Put, path, undefined, { devices }, { keepAlive: true }),
          )
          this.ackServerCurrent = new Set(devices)
        } catch {
          // best-effort: re-notification on the next cold start is the benign degraded mode
        }
      } while (this.ackDirty)
    } finally {
      this.ackWriting = false
    }
  }

  // ── New-access detection (ADR-018 §3.1 / PF-1) ────────────────────────────────────────────
  // The own-user device list is the source of the signal. CryptoEvent.DevicesUpdated (rust-crypto)
  // is the trigger; the actual list comes from getDevices() (REST), translated by the existing
  // deviceToDomain. A second login of the same user appears as a new device here.
  private async startAccessDetection(client: MatrixClient): Promise<void> {
    // Cold-start ordering (PF-2): read the recognized set BEFORE any delta is processed, else a
    // returning session re-notifies for every already-known device. loadAcknowledged is synchronous
    // (account data is in the synced cache after the first PREPARED sync) and runs before wiring.
    this.loadAcknowledged()
    const myUserId = client.getUserId() ?? ''
    // ADR-063, adendo 2 (§8.38): dismissals of a previous page whose write may not have landed join the
    // in-memory set before any scan (the boot's and every DevicesUpdated one). A hint: it only adds.
    for (const deviceId of readPendingRecognitions(myUserId)) this.acknowledgedDevices.add(deviceId)
    const onDevicesUpdated = (users: string[]): void => {
      if (!this.client) return
      if (!users.includes(myUserId)) return // only OUR account's device list matters
      this.detach(this.scanForNewAccess())
    }
    const gDevicesUpdated = guarded('onDevicesUpdated', this.opts.mode, onDevicesUpdated)
    client.on(CryptoEvent.DevicesUpdated, gDevicesUpdated)
    this.disposers.push(() => client.off(CryptoEvent.DevicesUpdated, gDevicesUpdated))
    // ADR-063: the recognized set is the ACCOUNT's (ADR-018 §4) — an acknowledgement made in another
    // session, or one this session's own boot read missed, arrives as an account-data change and
    // retracts the notice of that access here (account.accessRecognized).
    const onAccountData = (ev: MatrixEvent): void => {
      if (!this.client) return
      const type = ev.getType()
      if (type !== ACKNOWLEDGED_DEVICES_KEY && type !== LEGACY_ACKNOWLEDGED_DEVICES_KEY) return
      const echoed = readAcknowledged(ev.getContent())
      if (type === ACKNOWLEDGED_DEVICES_KEY) this.ackServerCurrent = echoed
      this.mergeAcknowledged(echoed)
      settlePendingRecognitions(myUserId, echoed)
    }
    const gAccountData = guarded('onAccountData', this.opts.mode, onAccountData)
    client.on(ClientEvent.AccountData, gAccountData)
    this.disposers.push(() => client.off(ClientEvent.AccountData, gAccountData))
    // The server read of the set runs on EVERY boot (ADR-063, adendo; §8.31), in the background — one
    // GET. Before, it ran only when the boot had a candidate to announce, so a later access was
    // acknowledged with no server read at all and the write's base could miss entries.
    const bootRead = this.refreshAcknowledged(client)
    this.ackServerRead = bootRead
    // ADR-063, adendo 2 (§8.38): once the boot read settles, a pending dismissal the server still lacks
    // (the previous page's PUT died with it, or has not landed) is written again — the same serialized,
    // coalesced PUT, with the in-memory set as base. Closes residual (4) of the first addendum.
    this.detach(bootRead.then(() => this.resumePendingRecognitions(client)))
    // Baseline scan of the current list (covers a DevicesUpdated that fired before wiring). On a
    // virgin cold start with N already-acknowledged devices this emits nothing (§5.2 assert 4).
    // The synced cache can be stale at boot — Synapse answers an initial /sync of the same device from
    // its response cache (sync_response_cache_duration, 2m), so a reload right after a dismissal reads
    // the set from before it (PLANO-RELEASE-PUBLICA §8.23): scanForNewAccess confirms with the boot read.
    await this.scanForNewAccess()
  }

  private resumePendingRecognitions(client: MatrixClient): void {
    if (this.client !== client) return
    const userId = client.getUserId()
    if (!userId) return
    const onServer = this.ackServerCurrent
    const pending = readPendingRecognitions(userId)
    if (pending.some((deviceId) => !onServer?.has(deviceId))) this.persistAcknowledged()
  }

  // Server copy of the CURRENT key, straight from the account-data endpoint — NOT
  // getAccountDataFromServer, which answers from the synced cache once the initial sync is done. The
  // legacy key is never written, so its cached copy cannot be stale and is not re-read. An account
  // that never acknowledged anything has no key (404, and Chromium logs it): absent = nothing new.
  // Failure keeps the cache read: degraded mode is a benign re-notification (ADR-018 §4).
  private async refreshAcknowledged(client: MatrixClient): Promise<void> {
    const userId = client.getUserId()
    if (!userId) return
    const path = `/user/${encodeURIComponent(userId)}/account_data/${encodeURIComponent(ACKNOWLEDGED_DEVICES_KEY)}`
    try {
      const current = await client.http.authedRequest(Method.Get, path)
      if (this.client !== client) return // disconnected during the await
      const server = readAcknowledged(current)
      this.ackServerCurrent = server
      this.mergeAcknowledged(server)
      settlePendingRecognitions(userId, server)
    } catch (e) {
      // best-effort: the cache read stands. M_NOT_FOUND is a known state — no set on the server yet.
      if (this.client === client && e instanceof MatrixError && e.errcode === 'M_NOT_FOUND') this.ackServerCurrent = new Set()
    }
  }

  // Grow the in-memory set (it never shrinks: the persisted set is monotonic, so a stale copy can
  // only be a subset) and retract every notice this session emitted for a newly recognized access.
  // An access never notified here needs no retraction — the UI never heard of it.
  private mergeAcknowledged(incoming: Set<string>): void {
    for (const deviceId of incoming) {
      if (this.acknowledgedDevices.has(deviceId)) continue
      this.acknowledgedDevices.add(deviceId)
      if (this.notifiedDevices.has(deviceId)) {
        this.emit({ t: 'account.accessRecognized', access: brandAccessId(deviceId) })
      }
    }
  }

  private loadAcknowledged(): void {
    const client = this.client
    if (!client) return
    const ev = client.getAccountData(ACKNOWLEDGED_DEVICES_KEY as keyof AccountDataEvents)
    const legacy = client.getAccountData(LEGACY_ACKNOWLEDGED_DEVICES_KEY as keyof AccountDataEvents)
    this.acknowledgedDevices = readAcknowledged(ev?.getContent(), legacy?.getContent())
  }

  // Diff the own-user device list against (self ∪ acknowledged ∪ already-notified) and emit
  // account.newAccess for each genuinely new access. Self-exclusion via getDeviceId() (PF-1.2) —
  // a session never notifies about its own login.
  // Before announcing anything, every scan with a candidate waits for the boot's server read of the
  // set while it is pending (ADR-063 D1; adendo 2, §8.38) — the boot scan AND the DevicesUpdated ones,
  // which before ran unchecked and could announce from a stale cache. Same failure semantics and bound
  // as the boot path: refreshAcknowledged never rejects (a failed read keeps the cache read) and has no
  // bound of its own beyond the request. A settled read costs nothing; no candidate, no wait.
  private async scanForNewAccess(): Promise<void> {
    const client = this.client
    if (!client) return
    const myDeviceId = client.getDeviceId()
    let devices
    try {
      devices = (await client.getDevices()).devices
    } catch {
      return // transient; a later DevicesUpdated retries
    }
    if (!this.client) return // disconnected during the await
    const pending = () =>
      devices.filter(
        (d) =>
          d.device_id !== myDeviceId && // auto-exclusion of the current session
          !this.acknowledgedDevices.has(d.device_id) && // already recognized (synced state)
          !this.notifiedDevices.has(d.device_id), // exactly one event per access
      )
    if (pending().length > 0) {
      await (this.ackServerRead ?? this.refreshAcknowledged(client))
      if (this.client !== client) return
    }
    for (const d of pending()) {
      const deviceId = d.device_id
      this.notifiedDevices.add(deviceId)
      this.emit({
        t: 'account.newAccess',
        access: brandAccessId(deviceId),
        device: accessDeviceToDomain(d),
        at: Date.now() as Timestamp,
      })
    }
  }

  // Per-thread unread (ADR-067): a boolean from the user's receipts, same rule in encrypted and
  // cleartext rooms (thread-unread.ts). It does not read the per-thread counts of the server or the
  // SDK. In-memory, no network: the SDK's Thread when the room has one, else the aggregation kept for
  // a paginated root. The channel count (roomToChannel → unreadOf) is untouched.
  getThreadUnread(id: ChannelId, root: MessageId): ThreadUnread {
    const room = this.requireRoom(id)
    const me = this.require().getUserId()
    if (!me) return { unread: false }
    const rootRealId = this.realEventIdInRoom(room, root)
    return threadUnreadOf(room, rootRealId, me, this.pagedThreadLatest.get(rootRealId))
  }

  // A page of the main timeline, the contract the stream already keeps in useChat: a thread reply
  // belongs to its thread and an edit to its target, so neither is a row. Both still go through
  // translateAll, which feeds the search index with every event of the page.
  private mainTimelineItems(events: MatrixEvent[], ctx: Ctx): Message[] {
    const edits = new Set(events.filter((ev) => ev.isRelation(RelationType.Replace)).map(stableMessageId))
    return this.translateAll(events, ctx).filter(
      (m) => m.threadParent === undefined && !edits.has(messageIdToRaw(m.id)),
    )
  }

  private translateAll(events: MatrixEvent[], ctx: Ctx): Message[] {
    const items: Message[] = []
    const indexed: SearchEntry[] = []
    for (const ev of events) {
      const m = eventToMessage(ev, ctx)
      if (m) {
        this.noteApprovalCard(m, ev)
        // ADR-074 dec. 2 (ii): every page this returns feeds the search index — the UI's scrollback
        // and the backfill alike. Keyed by the event's own id.
        const realId = ev.getId()
        if (this.search && realId) {
          const entry = this.toSearchEntry(m, realId)
          if (entry) indexed.push(entry)
        }
        // A page item surfaced as `unavailable` is registered for the late-decrypt upgrade,
        // exactly like a stream emission (the Decrypted handler upgrades via message.edited).
        if (m.body.kind === 'unavailable') {
          const realId = ev.getId()
          if (realId) this.unavailableEmitted.set(realId, messageIdToRaw(m.id))
        }
        items.push(m)
      } else if (ev.isRedacted()) {
        // A page that brings the event already redacted drops its old entry (ADR-075): otherwise the
        // index, and getMessage through it, would keep a message that no longer exists.
        const realId = ev.getId()
        if (realId) this.search?.remove(realId)
      }
    }
    this.search?.upsert(indexed)
    return items
  }

  // ── Local message search (ADR-074) ──────────────────────────────────────────────────────
  // Dec. 2 (i): the stream feeds the index — received and edited upsert (the late decrypt of an
  // `unavailable` arrives as message.edited, ADR-015), removed deletes. An own send is indexed when it
  // settles (message.status 'sent'), under its real event id: its stable id is the txn (ADR-010), which
  // does not survive the session. Never lets a failure reach the emitter.
  private indexForSearch(e: DomainEvent): void {
    const search = this.search
    const client = this.client
    if (!search || !client) return
    try {
      switch (e.t) {
        case 'message.received':
        case 'message.edited': {
          if (e.message.status === 'pending' || e.message.status === 'failed') return
          const realId = this.realEventIdOf(e.channelId, e.message.id)
          const entry = realId ? this.toSearchEntry(e.message, realId) : undefined
          if (entry) search.upsert([entry])
          return
        }
        case 'message.removed': {
          const realId = this.realEventIdOf(e.channelId, e.messageId)
          if (realId) search.remove(realId)
          return
        }
        case 'message.status': {
          if (e.status !== 'sent') return
          const room = client.getRoom(channelIdToRaw(e.channelId))
          const realId = this.realEventIdOf(e.channelId, e.messageId)
          const ev = realId ? room?.findEventById(realId) : undefined
          const msg = ev && room ? eventToMessage(ev, this.ctx(room)) : undefined
          const entry = msg && realId ? this.toSearchEntry(msg, realId) : undefined
          if (entry) search.upsert([entry])
          return
        }
        default:
          return
      }
    } catch {
      console.warn('[acl] search index update failed')
    }
  }

  // A stable MessageId → the real event id, in its room (the txn of an own send is resolved by the
  // room's events). Undefined while there is none (an own send not yet accepted).
  private realEventIdOf(channelId: ChannelId, messageId: MessageId): string | undefined {
    const room = this.client?.getRoom(channelIdToRaw(channelId))
    const raw = room ? this.realEventIdInRoom(room, messageId) : messageIdToRaw(messageId)
    return raw.startsWith('$') ? raw : undefined
  }

  // Dec. 1: the stored form of a translated message — raw ids in place of session ids (the own send's
  // txn would not survive a reload) and the media token swapped for its descriptor (a MediaRef is per
  // session, ADR-009). Nothing searchable → no entry (dec. 2).
  private toSearchEntry(msg: Message, eventId: string): SearchEntry | undefined {
    const text = searchableText(msg.body)
    if (text === undefined || text.trim() === '') return undefined
    const roomId = channelIdToRaw(msg.channelId)
    const room = this.client?.getRoom(roomId)
    const raw = (id: MessageId): string => (room ? this.realEventIdInRoom(room, id) : messageIdToRaw(id))
    let body = msg.body
    let media: StoredMedia | undefined
    if (body.kind === 'image' || body.kind === 'file') {
      const d = this.mediaByToken.get(mediaRefToRaw(body.media))
      if (!d) return undefined
      media = { mxc: d.mxc, encrypted: d.encrypted, mimetype: d.mimetype }
      body = { ...body, media: brandMediaRef('') }
    }
    const threadRoot = msg.threadParent ? raw(msg.threadParent) : undefined
    const snapshot: Message = { ...msg, id: brandMessageId(eventId), body }
    delete snapshot.status
    if (threadRoot) snapshot.threadParent = brandMessageId(threadRoot)
    if (msg.replyTo) snapshot.replyTo = brandMessageId(raw(msg.replyTo))
    return {
      eventId,
      roomId,
      sender: userIdToRaw(msg.author),
      ts: msg.sentAt,
      text,
      norm: normalizeForSearch(text),
      threadRoot,
      snapshot,
      media,
    }
  }

  // Dec. 1/5: re-mint the session's ids on read — an own message's stable id is still its txn while
  // the room holds it (ADR-010) — and a MediaRef from the stored descriptor.
  private fromSearchEntry(entry: SearchEntry): Message {
    const room = this.client?.getRoom(entry.roomId)
    const stable = (raw: string): MessageId => {
      const ev = room?.findEventById(raw)
      return brandMessageId(ev ? stableMessageId(ev) : raw)
    }
    const s = entry.snapshot
    let body = s.body
    if ((body.kind === 'image' || body.kind === 'file') && entry.media) {
      const media = this.mintMediaRef(entry.media.mxc, entry.media.encrypted as EncryptedFile | undefined, entry.media.mimetype)
      body = { ...body, media }
    }
    const msg: Message = { ...s, id: stable(entry.eventId), channelId: brandChannelId(entry.roomId), author: brandUserId(entry.sender), body }
    if (s.threadParent) msg.threadParent = stable(messageIdToRaw(s.threadParent))
    if (s.replyTo) msg.replyTo = stable(messageIdToRaw(s.replyTo))
    return msg
  }

  private async asUserOp<T>(work: () => Promise<T>): Promise<T> {
    this.userOps += 1
    try {
      return await work()
    } finally {
      this.userOps -= 1
      this.userIdleAt = Date.now() + BACKFILL_IDLE_MS
    }
  }

  // Dec. 3: the ports of the backfill runner (search-backfill.ts) over this client.
  private startSearchBackfill(client: MatrixClient): void {
    this.searchBackfillRun += 1
    const run = this.searchBackfillRun
    const cancelled = (): boolean => run !== this.searchBackfillRun || this.client !== client || !this.search
    // Every request the backfill makes is tracked like the ACL's other fire-and-forget work, so
    // disconnect drains it instead of letting it outlive the session.
    const tracked = <T>(work: Promise<T>): Promise<T> => {
      this.detach(work)
      return work
    }
    const indexPage = async (room: Room, events: MatrixEvent[]): Promise<void> => {
      await tracked(this.settleDecryption(events))
      if (!cancelled()) this.translateAll(events, this.ctx(room))
    }
    const roomOf = (roomId: string): Room => {
      const room = client.getRoom(roomId)
      if (!room) throw new Error('channel not found')
      return room
    }
    runSearchBackfill({
      rooms: () =>
        client
          .getRooms()
          .filter((r) => r.getMyMembership() === 'join')
          .map((r) => ({ roomId: r.roomId, lastActive: r.getLastActiveTimestamp() })),
      cursor: (roomId) => this.search?.cursor(roomId),
      setCursor: (cursor) => this.search?.setCursor(cursor),
      liveStart: async (roomId) => {
        const room = roomOf(roomId)
        const timeline = room.getLiveTimeline()
        await indexPage(room, timeline.getEvents())
        return timeline.getPaginationToken(Direction.Backward) ?? undefined
      },
      fetchOlder: async (roomId, token) => {
        const room = roomOf(roomId)
        const res = await tracked(client.createMessagesRequest(roomId, token, BACKFILL_PAGE_SIZE, Direction.Backward))
        await indexPage(room, res.chunk.map((raw) => new MatrixEvent(raw)))
        return { end: res.end ?? undefined }
      },
      rateLimitWait: (err) => {
        if (err instanceof RateLimitedError) return BACKFILL_RATE_LIMIT_DEFAULT_MS
        if (err instanceof MatrixError && err.errcode === 'M_LIMIT_EXCEEDED') {
          return err.data.retry_after_ms ?? BACKFILL_RATE_LIMIT_DEFAULT_MS
        }
        return undefined
      },
      busyFor: () => (this.userOps > 0 ? BACKFILL_IDLE_MS : Math.max(0, this.userIdleAt - Date.now())),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      cancelled,
      publish: (state) => {
        if (!cancelled()) this.publishSearchState(state)
      },
    }).catch(() => console.warn('[acl] search backfill stopped'))
  }

  // Dec. 5: AND of folded substrings over the loaded index, newest first, narrowed to the conversations
  // this session knows (and to one, when asked). Ids are minted for this session.
  async searchMessages(query: string, opts?: { channel?: ChannelId }): Promise<SearchHit[]> {
    const client = this.require()
    const search = this.search
    if (!search) return []
    await search.ready
    const only = opts?.channel ? channelIdToRaw(opts.channel) : undefined
    const include = (roomId: string): boolean => (only === undefined || roomId === only) && client.getRoom(roomId) !== null
    return search.search(query, include).map(({ entry, excerpt }) => {
      const message = this.fromSearchEntry(entry)
      return { message, channel: message.channelId, excerpt }
    })
  }

  // ADR-091 dec. 12 (A3-5): the conversation's pinned panels, filtered and ordered by the
  // aggregator. Same precondition as the send verbs: known and joined, else 'channel not found'.
  async listPanels(channelId: ChannelId): Promise<AgentPanel[]> {
    const room = this.requireJoinedRoom(channelId)
    return this.panels.list(room.roomId)
  }

  // ADR-093 (Proposto) (A4-1): the conversation's `/` commands, flat, filtered and ordered by the
  // aggregator. Same precondition as listPanels: known and joined, else 'channel not found'.
  async listCommands(channelId: ChannelId): Promise<AgentCommand[]> {
    const room = this.requireJoinedRoom(channelId)
    return this.commands.list(room.roomId)
  }

  // Dec. 5: the index's snapshot when it has one; else the event the room holds or the server's,
  // decrypted and translated. Not found / no access → undefined; a network failure propagates.
  async getMessage(channelId: ChannelId, messageId: MessageId): Promise<Message | undefined> {
    const client = this.require()
    const roomId = channelIdToRaw(channelId)
    const room = client.getRoom(roomId) ?? undefined
    const realId = room ? this.realEventIdInRoom(room, messageId) : messageIdToRaw(messageId)
    if (this.search) {
      await this.search.ready
      const entry = this.search.get(realId)
      // A card's state is aggregated live (ADR-091): its snapshot would show a stale one.
      if (entry && entry.roomId === roomId && entry.snapshot.body.kind !== 'approval') return this.fromSearchEntry(entry)
    }
    let event = room?.findEventById(realId)
    if (!event) {
      try {
        event = new MatrixEvent(await client.fetchRoomEvent(roomId, realId))
      } catch (e) {
        if (e instanceof MatrixError && (e.errcode === 'M_NOT_FOUND' || e.errcode === 'M_FORBIDDEN')) return undefined
        if (isNetworkFailure(e)) throw new ConnectionError()
        throw e
      }
    }
    if (event.isRedacted()) return undefined
    await client.decryptEventIfNeeded(event).catch(() => undefined)
    return eventToMessage(event, this.ctx(room)) ?? undefined
  }

  // Dec. 4 (+ addendum 2026-10-28): the backfill publishes its progress, the index its writes; each
  // side updates its own fields over the last state, and the event goes out only when a field changes.
  private publishSearchState(part: Partial<SearchStateFields>): void {
    const last = this.lastSearchState
    const next: SearchStateFields = {
      ...(last ?? { preparing: false, partial: false, ...(this.search?.writes ?? { persisting: false, degraded: false }) }),
      ...part,
    }
    if (
      last &&
      last.preparing === next.preparing &&
      last.partial === next.partial &&
      last.persisting === next.persisting &&
      last.degraded === next.degraded
    ) {
      return
    }
    this.lastSearchState = next
    this.emit({ t: 'search.state', ...next })
  }

  // Settle decryption for a page of events BEFORE translating (PLANO-FASE-2 §4.3): scrollback
  // must yield the decrypted content (or a settled `unavailable`), never a raw m.room.encrypted
  // dropped by the type filter. decryptEventIfNeeded resolves when the attempt SETTLES (success
  // or failure); cleartext events resolve immediately. Backfill events built from raw JSON
  // (createMessagesRequest) are decryptable too — the attempt reads the room id off the event.
  private async settleDecryption(events: MatrixEvent[]): Promise<void> {
    const client = this.require()
    await Promise.all(events.map((ev) => client.decryptEventIfNeeded(ev).catch(() => undefined)))
  }

  // Scrollback. No cursor → the currently-loaded live timeline (newest) + a cursor to go older.
  // With a cursor → an older page via /messages (backwards), returned chronologically so the UI
  // prepends it. The LIVE tail is NOT here — it arrives via the stream (message.received).
  // ADR-074 dec. 3: a user's page request holds the search backfill back.
  getTimeline(id: ChannelId, opts?: { thread?: MessageId; cursor?: PageCursor }): Promise<Page<Message>> {
    return this.asUserOp(() => this.timelinePage(id, opts))
  }

  private async timelinePage(
    id: ChannelId,
    opts?: { thread?: MessageId; cursor?: PageCursor },
  ): Promise<Page<Message>> {
    const room = this.requireRoom(id)
    const ctx = this.ctx(room)

    // Thread scrollback (PLANO-FASE-1-THREADS §2.2). Backfill the m.thread relations of the root
    // via the relations API (paginated by an opaque token). BACKWARD-ONLY — bidirectional cursor /
    // permalink jump stays DEFERRED (PLANO-FASE-1-TRADUTORES §1.3); we do NOT introduce a forward cursor.
    // The LIVE thread tail is NOT here — it arrives via the stream (message.received with
    // threadParent), so §1.3's "scrollback only" invariant holds per-thread too. The PageCursor
    // token type may differ from the main timeline's (relations nextBatch vs /messages end) — that
    // difference stays ACL-internal behind the opaque brand.
    if (opts?.thread) {
      const rootRealId = this.realEventIdInRoom(room, opts.thread)
      const res = await this.require().relations(
        room.roomId,
        rootRealId,
        RelationType.Thread,
        EventType.RoomMessage,
        { dir: Direction.Backward, from: opts.cursor as string | undefined, limit: 30 },
      )
      // dir=b yields newest→oldest; reverse to chronological so the UI prepends older above.
      const events = [...res.events].reverse()
      await this.settleDecryption(events)
      return {
        items: this.translateAll(events, ctx),
        nextCursor: res.nextBatch ? (res.nextBatch as PageCursor) : undefined,
      }
    }

    if (!opts?.cursor) {
      const timeline = room.getLiveTimeline()
      const events = timeline.getEvents()
      await this.settleDecryption(events)
      const items = this.mainTimelineItems(events, ctx)
      const token = timeline.getPaginationToken(Direction.Backward)
      return { items, nextCursor: token && !reachesRoomStart(events) ? (token as PageCursor) : undefined }
    }

    const res = await this.require().createMessagesRequest(
      channelIdToRaw(id),
      opts.cursor as string,
      30,
      Direction.Backward,
    )
    // /messages dir=b yields newest→oldest; reverse to chronological for prepend-above.
    const events = res.chunk.map((raw) => new MatrixEvent(raw)).reverse()
    for (const ev of events) {
      const evId = ev.getId()
      const latest = latestReplyFromAggregation(ev)
      if (evId && latest) this.pagedThreadLatest.set(evId, latest)
    }
    // A raw event carries its latest edit bundled; the SDK applies it only to events in a timeline.
    const replaced = events.flatMap((ev) => {
      const edit = ev.getServerAggregatedRelation<Partial<IEvent>>(RelationType.Replace)
      return edit ? [{ ev, edit: new MatrixEvent(edit) }] : []
    })
    await this.settleDecryption([...events, ...replaced.map((r) => r.edit)])
    // Only the author's edit applies (PLANO-AGENTES §8.30), even if the server already filtered.
    for (const { ev, edit } of replaced) {
      if (!edit.isDecryptionFailure() && editAppliesTo(edit.getSender(), ev.getSender())) ev.makeReplaced(edit)
    }
    return {
      items: this.mainTimelineItems(events, ctx),
      nextCursor: res.end && !reachesRoomStart(events) ? (res.end as PageCursor) : undefined,
    }
  }

  // ── Inbound: send ────────────────────────────────────────────────────────────────────────
  // Resolve a domain root MessageId → the real protocol event id, within a known room. ADR-008
  // Opt 1 makes the raw value the event id for received messages; for our own sends this session
  // the raw value is the txn id, so we also scan the live timeline by txn. Confined to the ACL.
  private realEventIdInRoom(room: Room, messageId: MessageId): string {
    const raw = messageIdToRaw(messageId)
    const directId = room.findEventById(raw)?.getId()
    if (directId) return directId
    for (const ev of room.getLiveTimeline().getEvents()) {
      const evId = ev.getId()
      if (ev.getTxnId() === raw && evId) return evId
    }
    return raw
  }

  // Build the m.thread relation for an outbound send (ADR-011). The client passes only a stable
  // root MessageId via SendOpts.thread; the ACL owns the intent→relation translation and the
  // client never names `rel_type`/`m.thread`. The rich-reply fallback (`is_falling_back` +
  // `m.in_reply_to`) is DEFERRED (PLANO §8 / ADR-011) — we attach a CLEAN m.thread relation, and
  // because the relation is already present the SDK's addThreadRelationIfNeeded does NOT inject a
  // fallback (verified against 41.6.0; passing only threadId WOULD inject it, so we keep the manual
  // relation). We also pass the threadId to sendMessage so the SDK affiliates the local echo to the
  // thread (setThread).
  //
  // Crucially we ALSO ensure the Thread model exists first: the SDK only routes an echo to a thread
  // that already exists, and on the FIRST reply to a root no Thread exists yet. Without one,
  // addPendingEvent has no thread timelineSet to receive the echo — the main set correctly rejects a
  // thread relation ("Ignoring event … timelineSet(threadId=undefined)") — so the optimistic bubble
  // never surfaces. createThread is idempotent (returns the existing thread) and re-emits
  // ThreadEvent/RoomEvent.Timeline from the thread, which our per-room listener and the main
  // RoomEvent.Timeline handler pick up.
  private threadTarget(room: Room | undefined, opts?: SendOpts): { threadRootId?: string } {
    if (!opts?.thread || !room) return {}
    const threadRootId = this.realEventIdInRoom(room, opts.thread)
    if (!room.getThread(threadRootId)) {
      room.createThread(threadRootId, room.findEventById(threadRootId) ?? undefined, [], false)
    }
    return { threadRootId }
  }

  // Resolve a reply target (SendOpts.replyTo, ADR-011 / PLANO-FASE-1-REPLY §2.4) to its REAL event id
  // within the room. Same machine as react/editMessage (locate): direct id match for received
  // messages, txn scan for our own sends this session (ADR-010 — their stable id IS the txn).
  // m.in_reply_to requires the server-acked event id; a still-pending target only has the SDK's
  // local "~" placeholder, so both the unknown and the not-yet-acked cases fail LOUD (the UI
  // already withholds the Reply affordance on status 'pending' — this is the fail-closed
  // backstop, PLANO-FASE-1-REPLY §6). No queue/wait is invented.
  private replyTargetEventId(room: Room, replyTo: MessageId): string {
    const raw = messageIdToRaw(replyTo)
    const event =
      room.findEventById(raw) ??
      room
        .getLiveTimeline()
        .getEvents()
        .find((ev) => ev.getTxnId() === raw)
    const realId = event?.getId()
    if (!realId || realId.startsWith('~')) throw new Error('reply target not found or not yet delivered')
    return realId
  }

  // Pre-validate an attachment against the server's upload limit BEFORE any upload or optimistic
  // bubble (PLANO-FASE-1-UPLOAD §6) — a condemned send must never surface a pending bubble. The
  // media config is fetched once (authenticated v1) and cached; failure to read it degrades to "no
  // client-side cap" (the server still rejects oversize). Mimetype is normalised by the caller
  // (empty → application/octet-stream); the server config exposes only a size limit (m.upload.size),
  // not a mimetype allow-list, so there is nothing further to validate here.
  private async assertWithinMediaLimits(file: File | Blob): Promise<void> {
    const client = this.require()
    if (!this.mediaConfigFetched) {
      try {
        const cfg = await client.getMediaConfig(true)
        const max = cfg['m.upload.size']
        this.maxUploadBytes = typeof max === 'number' ? max : undefined
      } catch {
        this.maxUploadBytes = undefined
      }
      this.mediaConfigFetched = true
    }
    if (this.maxUploadBytes !== undefined && file.size > this.maxUploadBytes) {
      throw new Error('attachment exceeds the server upload size limit')
    }
  }

  // Text/attachment send with optimistic echo (ADR-010). We MINT the transaction id so the stable
  // MessageId is known up-front and returned to the caller; the SDK's local echo fires the
  // 'pending' bubble, and LocalEchoUpdated drives the sent/failed status. Resolves on the server's
  // accept; rejects on terminal failure. `opts.thread` routes the send into a thread (ADR-011).
  // ADR-074 dec. 3: a send holds the search backfill back.
  sendMessage(id: ChannelId, body: OutgoingBody, opts?: SendOpts): Promise<MessageId> {
    return this.asUserOp(() => this.send(id, body, opts))
  }

  // ADR-093 (Proposto) (A4-1): SendOpts.command, checked before any effect — no echo, no send. Each refusal
  // says which rule failed (the ACL's plain-Error idiom for an invalid argument).
  private assertCommand(body: OutgoingBody, command: NonNullable<SendOpts['command']>): void {
    if (body.kind !== 'text') throw new Error('a command is sent as text only')
    if (commandNameOf(command.name) === undefined) throw new Error('invalid command name')
    if (!startsWithCommand(body.text, command.name)) throw new Error('command text must start with /name')
    if (!this.isAgentAccount(userIdToRaw(command.agent))) throw new Error('command target is not an agent')
  }

  private async send(id: ChannelId, body: OutgoingBody, opts?: SendOpts): Promise<MessageId> {
    const client = this.require()
    const roomId = channelIdToRaw(id)
    // Reply-INSIDE-thread is DEFERRED with a written trigger (PLANO-FASE-1-REPLY §0.7/§8): its combined
    // envelope (m.thread + m.in_reply_to + is_falling_back) is exactly the fallback semantics the
    // thread gate asserts we never emit. Reject loud — never build it half-way.
    if (opts?.thread && opts.replyTo) throw new Error('cannot reply inside a thread')
    // ADR-093 (Proposto) (A4-1): a command is checked before any effect.
    if (opts?.command) this.assertCommand(body, opts.command)
    // ADR-058 (fail-closed): the channel must be KNOWN to this session, and the session a MEMBER of
    // it, before any effect — no pending echo, no upload, no send. Without the Room the SDK keeps
    // no local echo (no 'sent' ever) and does not encrypt the event, and the attachment cipher
    // decision below would read "not encrypted" for lack of data (PLANO-GATES §8.12 item 5); a
    // pending invite may lack the cipher state too. No wait/retry here: a caller that creates a
    // channel waits for its channel.added first.
    const room = this.requireJoinedRoom(id)
    const { threadRootId } = this.threadTarget(room, opts)

    if (body.kind === 'text') {
      const replyTargetId = opts?.replyTo ? this.replyTargetEventId(room, opts.replyTo) : undefined
      const txnId = client.makeTxnId()
      // The content is assembled by the pure builder (S-a2, @tayet/shared/internal outbound.ts):
      // ADR-012 fragment, ADR-037 (M2) m.mentions (UserId→mxid resolved there, inside the ACL; empty/
      // absent omits it), and the relation. What stays here is the SDK method and its arguments.
      // Plain (no rich, no mentions) keeps the exact prior sendTextMessage path so plain text stays
      // byte-for-byte the current contract.
      const mentions = opts?.mentions
      // ADR-093: the command rides as the encrypted marker and implies the mention of its agent (the
      // builder adds the agent to m.mentions once).
      const command = opts?.command
      // A command message may open a form for this session: its id joins the session's triggers.
      const settleTrigger = command ? this.forms.beginOwnSend() : undefined
      let sent: { event_id: string }
      try {
        if (threadRootId) {
          const content = buildTextContent(body.text, body.rich, mentions, { thread: threadRootId }, command)
          sent = await client.sendMessage(roomId, threadRootId, content as never, txnId)
        } else if (replyTargetId) {
          // Reply envelope (PLANO-FASE-1-REPLY §0.4 — the deliberate extension of the manual relation
          // builder, THREADS §9 option (b)): EXACTLY { 'm.in_reply_to': { event_id } }, built by the
          // builder. No threadId is passed, so the SDK's addThreadRelationIfNeeded stays a no-op
          // (verified on 41.6.0: it only acts when a threadId is given). The envelope assert (§5.3)
          // proves all of this fail-closed.
          const content = buildTextContent(body.text, body.rich, mentions, { replyTo: replyTargetId }, command)
          sent = await client.sendMessage(roomId, content as never, txnId)
        } else if (body.rich || mentions?.length || command) {
          sent = await client.sendMessage(roomId, buildTextContent(body.text, body.rich, mentions, undefined, command) as never, txnId)
        } else {
          sent = await client.sendTextMessage(roomId, body.text, txnId)
        }
      } catch (err) {
        settleTrigger?.()
        throw err
      }
      if (command) {
        const agent = userIdToRaw(command.agent)
        settleTrigger?.({ id: sent.event_id, roomId, anchorId: sent.event_id, agent })
        // Its reply is re-emitted on the message in place as soon as an accepted result arrives.
        this.formReplies.watch(roomId, sent.event_id, { agent, kind: 'command', sender: client.getUserId() ?? '' })
      }
      this.readOwnSend(room, sent.event_id)
      return brandMessageId(txnId)
    }
    // Replying with an attachment is outside this slice (PLANO-FASE-1-REPLY §2.4 scopes the reply send to
    // the TEXT path). Fail loud rather than silently dropping the caller's reply intent.
    if (opts?.replyTo) throw new Error('replying with an attachment is not supported')
    // Attachment: the ACL infers the msgtype from the file's mimetype (P1 — the client never
    // names a msgtype). In an E2E room the bytes are ENCRYPTED before upload (ADR-016 — fatia B
    // closes the fatia-A fail-closed window, issue #15): the repo only ever sees an opaque
    // octet-stream without a filename; the real name/mimetype live INSIDE the Megolm payload.
    const file = body.file
    const mimetype = file.type || 'application/octet-stream'
    const msgtype = mimetypeToMsgtype(mimetype)
    const name = body.name ?? (file instanceof File ? file.name : 'file')
    // The SAME room check the fatia-A fail-closed used — what it gates changed: cipher path
    // instead of rejection. Derived from the RESOLVED room (ADR-058 dec. 3), never an optional
    // lookup. CTR keeps ciphertext length == plaintext length, so the size limit
    // is checked BEFORE encrypting with no error margin (and before echoing — no condemned
    // bubble, PLANO §3.3 item 4).
    const encryptedRoom = room.hasEncryptionStateEvent()
    await this.assertWithinMediaLimits(file)

    // ── Optimistic attachment echo (ADR-010 — the novel variable). Mint the txn up-front so the
    // stable MessageId is known, then emit a 'pending' message.received carrying a LOCAL MediaRef
    // (the picked bytes) so the bubble shows a preview INSTANTLY, before the upload. The body mirrors
    // the inbound split (image/* → image; else → file) so echo↔received stay symmetric on reload;
    // width/height are omitted (optional — PLANO §2). Record the txn so onTimeline suppresses the
    // SDK re-emit (which would carry the REMOTE mxc).
    const txnId = client.makeTxnId()
    this.localEchoTxns.add(txnId)
    const localRef = brandMediaRef(this.localMedia.mint(file))
    const pendingBody: MessageBody = mimetype.startsWith('image/')
      ? { kind: 'image', media: localRef, alt: name }
      : { kind: 'file', media: localRef, name, size: file.size, mimetype }
    this.emit({
      t: 'message.received',
      channelId: id,
      message: {
        id: brandMessageId(txnId),
        channelId: id,
        author: brandUserId(client.getUserId() ?? ''),
        body: pendingBody,
        sentAt: Date.now() as Timestamp,
        reactions: [],
        threadParent: opts?.thread,
        mine: true,
        mentionsMe: false,
        status: 'pending',
      },
    })

    // Upload + send. A failure in ANY step (encrypt, bytes or event) collapses to
    // status:'failed' (PLANO §3 granularity note). The SDK's LocalEchoUpdated cannot fire
    // 'failed' for an upload that never reached sendMessage, so we emit it ourselves and
    // rethrow (sendMessage rejects on terminal failure — ADR-010). Retry re-runs this whole
    // encrypt+upload+send atomically under a fresh txn.
    let sent: { event_id: string }
    try {
      let media: AttachmentMedia
      if (encryptedRoom) {
        // E2E path (ADR-016): read bytes → fresh-key encrypt → upload the CIPHERTEXT with no
        // filename and application/octet-stream (PF-1 item 4 — the repo must not see the real
        // name or mimetype). The event content carries `file` (envelope + the upload's mxc)
        // INSTEAD of `url`; `info` keeps the PLAINTEXT mimetype/size — all of it inside the
        // payload Megolm encrypts (the gate proves it on the wire). Thumbnail: parity rule
        // (PF-3) — the cleartext path generates none, so neither does this one.
        const bytes = await fileBytes(file)
        const { ciphertext, info } = await encryptAttachment(bytes)
        const upload = await client.uploadContent(ciphertext, {
          includeFilename: false,
          type: 'application/octet-stream',
        })
        media = { encrypted: info, url: upload.content_uri }
      } else {
        const upload = await client.uploadContent(file, { name, type: mimetype })
        media = { url: upload.content_uri }
      }
      // The pure builder (S-a2) assembles the content, thread relation last. sendMessage's content is
      // a strict union; the inferred-msgtype object is structurally valid RoomMessage content. The
      // cast is confined here, inside the ACL (the runtime value is the real `content` object).
      const content = buildAttachmentContent(msgtype, name, mimetype, file.size, media, threadRootId)
      if (threadRootId) {
        sent = await client.sendMessage(roomId, threadRootId, content as never, txnId)
      } else {
        sent = await client.sendMessage(roomId, content as never, txnId)
      }
    } catch (err) {
      this.emit({ t: 'message.status', channelId: id, messageId: brandMessageId(txnId), status: 'failed' })
      throw err
    }
    this.readOwnSend(room, sent.event_id)
    return brandMessageId(txnId)
  }

  // ADR-068 D7: our own message leaves the room read up to it — a read receipt on the sent event.
  // Without it the server keeps counting the replies before ours (measured: an own reply left the
  // thread at 1, while the per-thread dot of ADR-067 treats an own last reply as read). The SDK picks
  // the receipt's thread from the event (threaded for a thread reply, `main` otherwise). Best-effort:
  // the message is already sent, so a failed receipt does not fail the send.
  // A thread reply has no findable local echo when the send resolves (measured, §8.32: neither the room
  // nor its Thread holds it until the remote echo comes by sync), so its id waits for that echo
  // (ThreadEvent.NewReply, attachRoom) and the receipt goes then.
  private readOwnSend(room: Room, eventId: string): void {
    const event = room.findEventById(eventId)
    if (event) this.sendOwnReceipt(event)
    else this.ownSendsAwaitingEcho.add(eventId)
  }

  private onOwnEcho(event: MatrixEvent): void {
    const id = event.getId()
    if (id && this.ownSendsAwaitingEcho.delete(id)) this.sendOwnReceipt(event)
  }

  // The receipt an automatic entry owes, on this session's own join event, once that event is in the
  // room with its server id. Private: the other members never see it. A failed receipt is swallowed.
  private sendEntryReceipt(room: Room | null | undefined): void {
    const myUserId = this.client?.getUserId()
    if (!room || !myUserId || !this.entryReceiptsOwed.has(room.roomId)) return
    const entry = room.currentState.getStateEvents(EventType.RoomMember, myUserId)
    if (!entry || entry.getContent().membership !== 'join' || !hasServerId(entry)) return
    this.entryReceiptsOwed.delete(room.roomId)
    const receipt = this.sendReceipt(entry, ReceiptType.ReadPrivate)
    if (receipt) this.detach(receipt.catch(() => {}))
  }

  private sendOwnReceipt(event: MatrixEvent): void {
    const receipt = this.sendReceipt(event)
    if (receipt) this.detach(receipt.catch(() => {}))
  }

  // #243: the one way a read receipt leaves the ACL. Never on an event without its server id (a local
  // echo): no receipt at all, the server would answer 400. Without a type it is the public read receipt.
  private sendReceipt(event: MatrixEvent, type?: ReceiptType): Promise<unknown> | undefined {
    if (!hasServerId(event)) return undefined
    return type ? this.client?.sendReadReceipt(event, type) : this.client?.sendReadReceipt(event)
  }

  // ── Inbound: edit ──────────────────────────────────────────────────────────────────────
  // Edit a prior message in place (m.replace). Like react, it takes only a (stable) MessageId — no
  // channel — so it REUSES locate() to find (room, real event id). That same scan resolves an
  // edit-of-PENDING (our own not-yet-acked send, whose stable id is the txn) via the txn match, so
  // no new reconciliation path is invented (PLANO §0.3 / constraint: "Edit-de-pending reusa locate").
  // The client never names a relation: the ACL builds the m.replace envelope with m.new_content
  // carrying the post-edit content. Text-only this slice (attachment caption is out of scope, §8);
  // the rich serializer is wired in commit 6. The inbound m.replace branch in onTimeline already
  // emits message.edited when the echo/sync arrives — the optimistic echo is commit 8.
  async editMessage(messageId: MessageId, body: OutgoingBody): Promise<void> {
    if (body.kind !== 'text') throw new Error('only text messages can be edited')
    const loc = this.locate(messageId)
    if (!loc) throw new Error('message not found')
    // Rich edits (ADR-012): the post-edit content (incl. formatted_body, when rich) lives INSIDE
    // m.new_content — drift-correct for 41.x (the edit's formatted_body is NOT on the top-level
    // content). The top-level body is the `* `-prefixed plain fallback for non-edit-aware clients.
    // Assembled by the pure builder (S-a2).
    const content = buildEditContent(body.text, body.rich, loc.realEventId)

    // Snapshot the PRE-edit view via the canonical translation, BEFORE the optimistic emit. Its id is
    // stableMessageId(original) === messageId, so re-emitting it reconciles the bubble in place. This
    // is the rollback used if the send rejects (the optimistic emit below is not free like a normal
    // send, which carries status:'failed' — an edit has no failed state, so we compensate explicitly).
    const original = loc.room.findEventById(loc.realEventId)
    const preEdit = original ? (eventToMessage(original, this.ctx(loc.room)) ?? undefined) : undefined

    // ── Optimistic edit echo (ADR-010 × edit). Emit the edited view NOW, under the SAME stable id,
    // so the bubble updates instantly. The synced m.replace later re-emits message.edited under that
    // same id (the onTimeline branch already handles it) → the UI upsert reconciles in place, never
    // re-keys. We build the domain body directly from the OutgoingBody (identical to what
    // translateBody would yield inbound) — the UI never reconciles txn↔event (that is the ACL's job).
    const editedBody: MessageBody =
      body.rich ? { kind: 'text', text: body.text, rich: body.rich } : { kind: 'text', text: body.text }
    // The TARGET's relations (threadParent/replyTo) survive the edit — same derivation as the
    // synced path (editToMessage), keeping the two paths symmetric (PLANO-FASE-1-REPLY §0.6). Read off
    // the ORIGINAL content: an already-edited target's getContent() would carry no relation.
    const relations = original
      ? relationsOf(original.getOriginalContent() as Record<string, unknown>, this.ctx(loc.room))
      : {}
    this.emit({
      t: 'message.edited',
      channelId: brandChannelId(loc.room.roomId),
      message: {
        id: messageId,
        channelId: brandChannelId(loc.room.roomId),
        author: brandUserId(this.require().getUserId() ?? ''),
        body: editedBody,
        sentAt: (original?.getTs() ?? Date.now()) as Timestamp,
        editedAt: Date.now() as Timestamp,
        reactions: original ? this.ctx(loc.room).reactionsFor?.(loc.realEventId) ?? [] : [],
        threadParent: relations.threadParent,
        replyTo: relations.replyTo,
        // ADR-066: an edited root keeps its thread summary (same derivation as the synced path).
        threadSummary: original ? threadSummaryOf(original, this.ctx(loc.room)) : undefined,
        mine: true,
        mentionsMe: false,
      },
    })

    // On terminal failure, ROLL BACK to the pre-edit view (same stable id → upsert in place) so the
    // UI never keeps content that did not persist, then re-throw so the caller knows it failed. The
    // "(edited)" badge derives from message.editedAt: preEdit carries the original editedAt (undefined
    // if never edited), so the rollback also clears a phantom badge. Rich UX of edit failure is
    // deferred with a trigger (PLANO §8) — this minimal rollback covers correctness.
    try {
      await this.require().sendMessage(loc.room.roomId, content as never)
    } catch (err) {
      if (preEdit) this.emit({ t: 'message.edited', channelId: brandChannelId(loc.room.roomId), message: preEdit })
      throw err
    }
  }

  // ── Inbound: answer an approval card ──────────────────────────────────────────────────
  // ADR-091 dec. 14 (A3-2). Refused before any effect: a message that is not a card, an option
  // that is not among the card's ORIGINAL options, a card no longer open (answered or closed). The echo
  // never becomes a line: the card shows 'sending', then resolves by the usual rule once the server
  // accepted the answer (another person's earlier answer, in the server's order, still wins), or
  // shows 'failed' — "Tentar de novo" calls this again with the same option. A call while this card's
  // answer is in flight joins it: never a second send.
  async answerApproval(messageId: MessageId, option: string): Promise<void> {
    const client = this.require()
    const card = this.approvalCardOf(messageId)
    if (!card) throw new Error('message not found')
    const { room, cardId, body } = card
    const roomId = room.roomId
    const chosen = body.options.find((o) => o.id === option)
    if (!chosen) throw new Error('option not on the card')
    const inFlight = this.pendingAnswers.get(roomId, cardId)
    if (body.state.kind === 'sending' && inFlight?.work) return inFlight.work
    if (body.state.kind === 'multi' && body.state.own?.status === 'sending' && inFlight?.work) return inFlight.work
    if (!takesAnswer(body.state, client.getUserId() ?? undefined)) throw new Error('approval card not open')

    const pending: PendingAnswer = { option, status: 'sending' }
    const txnId = client.makeTxnId()
    const cardAuthor = (room.findEventById(cardId) ?? this.approvalCards.get(cardId) ?? this.readTargets.get(cardId))?.getSender()
    const settleTrigger = this.forms.beginOwnSend()
    this.pendingAnswers.set(roomId, cardId, pending)
    this.emitApprovalCard(roomId, cardId)
    const work = (async (): Promise<void> => {
      try {
        const res = await client.sendEvent(roomId, EventType.RoomMessage, buildApprovalAnswerContent(cardId, option, chosen.label) as never, txnId)
        settleTrigger(cardAuthor ? { id: res.event_id, roomId, anchorId: cardId, agent: cardAuthor } : undefined)
        if (this.client !== client) return
        // Sent: 'sending' until the aggregator resolves the card (the overlay drops it then).
        this.pendingAnswers.update(roomId, cardId, pending, { status: 'sent', work: undefined })
        this.approvals.noteOwnAnswer(roomId, cardId, {
          eventId: res.event_id,
          sender: client.getUserId() ?? '',
          ts: Date.now(),
          decrypted: true,
          option,
        })
        this.emitApprovalCard(roomId, cardId)
      } catch (err) {
        settleTrigger()
        if (this.client !== client) throw err
        // The SDK keeps a failed echo queued; the retry is a new send, so the old one goes.
        const echo = room
          .getLiveTimeline()
          .getEvents()
          .find((ev) => ev.getTxnId() === txnId)
        if (echo?.status === EventStatus.NOT_SENT) {
          try {
            client.cancelPendingEvent(echo)
          } catch {
            // Already gone.
          }
        }
        if (this.pendingAnswers.update(roomId, cardId, pending, { status: 'failed', work: undefined })) this.emitApprovalCard(roomId, cardId)
        throw err
      }
    })()
    if (pending.status === 'sending') pending.work = work
    return work
  }

  // ── Inbound: an agent's form ───────────────────────────────────────────────────────────
  // Checked before any effect: values with issues come back by field and nothing is sent.
  submitForm(formId: FormId, values: FormValues): Promise<SubmitOutcome> {
    this.require()
    return this.forms.submit(formId, values)
  }

  closeForm(formId: FormId): void {
    this.forms.close(formId)
  }

  // The card a MessageId names, translated as this session shows it (the pending answer folded in): from
  // the rooms (locate), else from the cards this session translated off a page. Undefined when the
  // message is unknown; a body other than 'approval' is returned so the caller can refuse it.
  private approvalCardOf(messageId: MessageId): { room: Room; cardId: string; body: Extract<MessageBody, { kind: 'approval' }> } | undefined {
    const loc = this.locate(messageId)
    const raw = messageIdToRaw(messageId)
    const cached = loc ? undefined : this.approvalCards.get(raw)
    const room = loc?.room ?? (cached ? this.client?.getRoom(cached.getRoomId() ?? '') ?? undefined : undefined)
    const cardId = loc?.realEventId ?? cached?.getId()
    if (!room || !cardId) return undefined
    const event = room.findEventById(cardId) ?? this.approvalCards.get(cardId) ?? this.readTargets.get(cardId)
    const msg = event ? eventToMessage(event, this.ctx(room)) : null
    if (msg?.body.kind !== 'approval') throw new Error('not an approval card')
    return { room, cardId, body: msg.body }
  }

  // ── Inbound: delete ────────────────────────────────────────────────────────────────────
  // Redact one's own message and its edits (ADR-075 and its addendum). Order: list one's own edits on the
  // server, redact the message, redact the edits — the message first, because redacting an edit makes the
  // SDK put its target back to the previous content. Listing or the message's redaction failing → nothing
  // changed, the verb rejects, no emit. Not optimistic (dec. 5): a removal that then failed would have to put
  // the message back, and the stream has no reinsert event — so the emit waits for the server. It carries the
  // messageId we were given (the stable id, ADR-010): the synced redaction's emit in onRedaction carries the
  // raw target id instead, which for this session's own send (id = txn) is a no-op in the UI. The search
  // index resolves the real event id via realEventIdOf in both cases. Each edit is then redacted with
  // EDIT_REDACTION_FIELD in the content (onRedaction emits nothing for it); one failing rejects the verb after
  // the emit and leaves the remaining edits on the server (no repair queue, a known limit).
  async deleteMessage(messageId: MessageId): Promise<void> {
    const loc = this.locate(messageId)
    if (!loc) throw new Error('message not found')
    const edits = await this.ownEditIds(loc.room.roomId, loc.realEventId)
    await this.require().redactEvent(loc.room.roomId, loc.realEventId)
    this.emit({ t: 'message.removed', channelId: brandChannelId(loc.room.roomId), messageId })
    await this.redactEdits(loc.room.roomId, edits)
  }

  // One's own live edits of a message, as the server lists them (the m.replace relations, forward, every
  // page). Nothing is decrypted: the sender and the redaction mark are on the envelope. Another person's
  // edit, an already redacted one and an edit still being sent (not on the server) are left out.
  private async ownEditIds(roomId: string, targetId: string): Promise<string[]> {
    const client = this.require()
    const me = client.getUserId()
    const ids: string[] = []
    let from: string | undefined
    do {
      const res = await client.fetchRelations(roomId, targetId, RelationType.Replace, null, {
        dir: Direction.Forward,
        ...(from !== undefined && { from }),
      })
      for (const raw of res.chunk) {
        if (raw.sender === me && raw.event_id && !raw.unsigned?.redacted_because) ids.push(raw.event_id)
      }
      from = res.next_batch ?? undefined
    } while (from !== undefined)
    return ids
  }

  // Redacts the edits one at a time, through the redaction endpoint directly (the SDK's redactEvent sends no
  // custom content). On M_LIMIT_EXCEEDED it waits the time the server gave (at least EDIT_REDACTION_MIN_WAIT_MS) and
  // repeats, up to EDIT_REDACTION_WAIT_CAP_MS of time actually waited, summed over the call; past that, or with no
  // time given, it rejects.
  private async redactEdits(roomId: string, editIds: string[]): Promise<void> {
    const client = this.require()
    let waited = 0
    for (const editId of editIds) {
      const path = `/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent(editId)}/${encodeURIComponent(client.makeTxnId())}`
      for (;;) {
        try {
          await client.http.authedRequest(Method.Put, path, undefined, { [EDIT_REDACTION_FIELD]: true })
          break
        } catch (err) {
          const given = rateLimitWaitMs(err)
          if (given === undefined) throw err
          const wait = Math.max(given, EDIT_REDACTION_MIN_WAIT_MS)
          if (waited + wait > EDIT_REDACTION_WAIT_CAP_MS) throw err
          waited += wait
          await new Promise((resolve) => setTimeout(resolve, wait))
        }
      }
    }
  }

  // ── Inbound: reactions ───────────────────────────────────────────────────────────────────
  // react/removeReaction take only a (stable) MessageId — no channel context — so we locate the
  // (room, real event id) by scanning rooms: a direct id match (others' messages) or a txn match
  // (our own, whose stable id is the txn). The echo of an own thread reply is never in the room's
  // timeline (#421): until its remote echo arrives it is only the room's in-flight send (the SDK's
  // txn map), and afterwards it lives in its thread's timeline — so the txn match looks in both.
  private locate(messageId: MessageId): { room: Room; realEventId: string } | undefined {
    const target = messageIdToRaw(messageId)
    for (const room of this.require().getRooms()) {
      const direct = room.findEventById(target)
      const directId = direct?.getId()
      if (directId) return { room, realEventId: directId }
      const inFlightId = room.getEventForTxnId(target)?.getId()
      if (inFlightId) return { room, realEventId: inFlightId }
      for (const ev of [room.getLiveTimeline().getEvents(), ...room.getThreads().map((t) => t.timeline)].flat()) {
        const evId = ev.getId()
        if (ev.getTxnId() === target && evId) return { room, realEventId: evId }
      }
    }
    return undefined
  }

  async react(messageId: MessageId, emoji: string): Promise<void> {
    const loc = this.locate(messageId)
    if (!loc) throw new Error('message not found')
    await this.require().sendEvent(loc.room.roomId, EventType.Reaction, buildReactionContent(loc.realEventId, emoji))
    // Re-aggregate after the server accepts: our own echo may reconcile in place (no second
    // Timeline event), so emit here to guarantee the new aggregate reaches subscribers.
    this.emitReactionChanged(loc.room, loc.realEventId)
  }

  async removeReaction(messageId: MessageId, emoji: string): Promise<void> {
    const loc = this.locate(messageId)
    if (!loc) return
    const client = this.require()
    const rel = loc.room.relations.getChildEventsForEvent(
      loc.realEventId,
      RelationType.Annotation,
      EventType.Reaction,
    )
    const mine = rel
      ?.getRelations()
      .find(
        (e) => e.getSender() === client.getUserId() && e.getRelation()?.key === emoji && !e.isRedacted(),
      )
    const id = mine?.getId()
    if (id) {
      // Record the reaction→target mapping by the REAL reaction id BEFORE redacting: our own
      // reaction's local echo reconciles in place (its Timeline event carried the local-echo
      // id, not this real one), so without this the synced redaction would miss the map and be
      // misrouted to message.removed instead of a reaction.changed decrement.
      this.reactionTargets.set(id, loc.realEventId)
      await client.redactEvent(loc.room.roomId, id)
    }
    this.emitReactionChanged(loc.room, loc.realEventId)
  }

  // ── Inbound: close the read loop ─────────────────────────────────────────────────────────
  async markRead(id: ChannelId, upToMessageId?: MessageId): Promise<void> {
    this.require()
    const room = this.requireRoom(id)
    if (!upToMessageId) {
      // #243: the live timeline ends in our own pending sends (local echoes, pendingEventOrdering
      // 'chronological'), so the target is the last event with its server id — none, no receipt.
      const events = room.getLiveTimeline().getEvents()
      let last: MatrixEvent | undefined
      for (let i = events.length - 1; i >= 0 && !last; i--) if (hasServerId(events[i]!)) last = events[i]
      if (last) await this.sendReceipt(last)
      return
    }
    // §8.37 D2: an explicit target resolves in the room, then in the delivered-events registry (D1).
    // Never the main timeline's tail: that receipt would carry thread_id "main" and leave a thread
    // reply unread for good (ADR-067). The SDK derives thread_id from the content relation
    // (threadIdForReceipt → threadRootId), so an event outside every timeline is a valid target.
    const raw = messageIdToRaw(upToMessageId)
    const inRoom = room.findEventById(raw)
    if (inRoom) this.readTargets.delete(raw)
    const registered = this.readTargets.get(raw)
    const event = inRoom ?? (registered?.getRoomId() === room.roomId ? registered : undefined)
    if (!event) {
      // D3: no receipt now and no fallback; it goes when the event reaches the room.
      this.pendingReadTarget.set(room.roomId, raw)
      console.warn('[acl] read receipt deferred until the message reaches the room')
      return
    }
    if (!hasServerId(event)) {
      // #243: a local echo is in the room but has no server id yet — deferred the same way as D3 (and
      // the send's own receipt, ADR-068 D7, lands once it resolves).
      this.pendingReadTarget.set(room.roomId, raw)
      console.warn('[acl] read receipt deferred until the message is sent')
      return
    }
    this.pendingReadTarget.delete(room.roomId)
    await this.sendReceipt(event)
  }

  // ── Media resolution (ADR-009) ───────────────────────────────────────────────────────────
  // Transport = BLOB (authenticated download → decrypt-if-cifrado → object URL). This is the
  // functional fallback ADR-009 sanctions; the Service-Worker optimization for inline cleartext
  // is a transport-only change (no contract/UI churn) deferred from this slice. `release()`
  // revokes the object URL. Authenticated fetch is the ACL's job — `<img src>` with a v1 URL
  // would NOT send the bearer header (drift note in ADR-009).
  async resolveMedia(ref: MediaRef, variant: MediaVariant = 'full'): Promise<ResolvedMedia> {
    const raw = mediaRefToRaw(ref)
    // LOCAL ref (optimistic attachment preview): resolve straight to an object URL of the picked
    // bytes — no SDK, no network, no mxc (PLANO §2/§6). `variant` is irrelevant for a local preview.
    const local = this.localMedia.resolve(raw)
    if (local) return local

    // resolveMedia keeps its four messages: no answer and a rate limit are a failed fetch here. The
    // caught error is never attached (it is the SDK's).
    const blob = await this.mediaBlob(ref, variant, undefined).catch((err: unknown) => {
      if (err instanceof ConnectionError || err instanceof MatrixError) return undefined
      throw err
    })
    if (!blob) throw new Error('media fetch failed')
    const url = URL.createObjectURL(blob)
    this.objectUrls.add(url)
    return {
      url,
      release: () => {
        // Idempotent (set membership guards the double-revoke), and disconnect-safe: a URL
        // already swept by the session teardown is not revoked twice.
        if (this.objectUrls.delete(url)) URL.revokeObjectURL(url)
      },
    }
  }

  // The bytes behind a MediaRef minted by this session, decrypted when the attachment is encrypted
  // (PLANO-EXPORT-DADOS §0.3.3 E1): resolveMedia's path up to the Blob. A failure with no answer from the
  // server rejects with ConnectionError, a rate limit with the SDK's error as is (the export waits on it);
  // every other failure with resolveMedia's messages. An aborted `signal` rejects with its reason.
  private async mediaBlob(ref: MediaRef, variant: MediaVariant, signal: AbortSignal | undefined): Promise<Blob> {
    const desc = this.mediaByToken.get(mediaRefToRaw(ref))
    if (!desc) throw new Error('unknown media ref')
    const client = this.require()

    const thumb = variant === 'thumbnail' && !desc.encrypted
    const parts = /^mxc:\/\/([^/]+)\/([^/?#]+)$/.exec(desc.mxc)
    if (!parts) throw new Error('cannot resolve media url')
    const path = `/media/${thumb ? 'thumbnail' : 'download'}/${encodeURIComponent(parts[1]!)}/${encodeURIComponent(parts[2]!)}`
    const query: Record<string, string> = { allow_redirect: 'true' }
    if (thumb) Object.assign(query, { width: '96', height: '96', method: 'scale' })

    // Through the SDK's http-api (v1 authenticated media), NOT a raw fetch: an expired access
    // token (M_UNKNOWN_TOKEN) then rides the same 401→refresh→retry cycle as every other
    // authenticated request (http-api/fetch.js), instead of failing the download (§8.21).
    let bytes: ArrayBuffer | undefined
    let failure: unknown
    try {
      const blob = await client.http.authedRequest<Blob>(Method.Get, path, query, undefined, {
        prefix: ClientPrefix.V1,
        rawResponseBody: true,
        ...(signal && { abortSignal: signal }),
      })
      bytes = await blob.arrayBuffer()
    } catch (err) {
      failure = err
    }
    if (bytes === undefined) {
      // The caught error is never attached (it is the SDK's): only its kind decides.
      if (signal?.aborted) throw signal.reason
      if (isNetworkFailure(failure)) throw new ConnectionError()
      if (failure instanceof MatrixError && failure.errcode === 'M_LIMIT_EXCEEDED') throw failure
      throw new Error('media fetch failed')
    }
    if (desc.encrypted) {
      // Verify-then-decrypt via the PF-2 dispatch (Worker in the browser; direct under Node).
      // ANY failure here (hash mismatch, malformed envelope) rejects with a DOMAIN error — no
      // cipher/protocol detail crosses (§2/P4); the UI uses its existing media-failure
      // affordance. Never best-effort bytes.
      try {
        bytes = await decryptAttachmentBytes(bytes, desc.encrypted)
      } catch {
        throw new Error('media unavailable')
      }
    }

    // The Blob carries the PLAINTEXT mimetype (from the decrypted content, captured on the
    // descriptor at mint time) — the repo only ever saw application/octet-stream.
    return new Blob([bytes], desc.mimetype ? { type: desc.mimetype } : undefined)
  }

  // ── Data export (ADR-096; PLANO-EXPORT-DADOS §0.3.5) ─────────────────────────────────────
  // The ports of the export engine (data-export.ts) over this client. The person's own events come from a
  // filtered /messages walk (§0.3.3 B1), built as raw events outside any timeline and never passed through
  // translateAll: the search index is not fed (B3). The backfill is held back through `userOps`.
  exportMyData(opts: DataExportOptions): AsyncIterable<DataExportPart> {
    return this.runExport(opts)
  }

  private async *runExport(opts: DataExportOptions): AsyncGenerator<DataExportPart, void, undefined> {
    const client = this.require()
    const me = client.getUserId()
    if (!me) throw new Error('current user unavailable: identity not ready')
    const roomOf = (roomId: string): Room => {
      const room = client.getRoom(roomId)
      if (!room) throw new Error('channel not found')
      return room
    }

    yield* runDataExport<MatrixEvent>(
      {
        hold: () => {
          this.userOps += 1
          let held = true
          return () => {
            if (!held) return
            held = false
            this.userOps -= 1
            this.userIdleAt = Date.now() + BACKFILL_IDLE_MS
          }
        },
        alive: () => this.client === client && !this.sessionLost,
        conversations: () =>
          [...this.getChannels(), ...this.getArchivedChannels()].map((channel) => ({ key: channelIdToRaw(channel.id), channel })),
        account: async () => {
          const subject = await this.currentUser()
          const profile = await this.getMyProfile()
          const devices = await this.getDevices()
          return {
            subject: { key: me, name: subject.displayName, kind: subject.kind },
            profile: {
              // A1: the profile screen's rule — getMyProfile's fullName as it comes.
              fullName: profile.fullName,
              nickname: profile.nickname,
              pronouns: profile.pronouns,
              note: profile.note,
              jobTitle: profile.org?.jobTitle,
              workEmail: profile.org?.workEmail,
              avatar: profile.avatar,
            },
            accesses: devices.map((d) => ({ name: d.friendlyName, lastSeenAt: d.lastSeen, current: d.current })),
            agents: this.listOwnAgents().map((u) => ({ key: userIdToRaw(u.id), name: u.displayName, kind: 'agent' as const })),
          }
        },
        page: async (roomId, from, signal) => {
          const res = await client.http.authedRequest<{ chunk?: IEvent[]; end?: string }>(
            Method.Get,
            `/rooms/${encodeURIComponent(roomId)}/messages`,
            {
              dir: 'b',
              limit: String(EXPORT_PAGE_SIZE),
              filter: JSON.stringify({ senders: [me] }),
              ...(from !== undefined && { from }),
            },
            undefined,
            signal ? { abortSignal: signal } : undefined,
          )
          return { events: (res.chunk ?? []).map((raw) => new MatrixEvent(raw)), ...(res.end ? { end: res.end } : {}) }
        },
        decrypt: async (events) => {
          await this.settleDecryption(events)
          // ADR-077 dec. 1: every undecryptable session is noted, as the translation does for a line.
          for (const ev of events) {
            const session = ev.isDecryptionFailure() ? ev.getWireContent().session_id : undefined
            if (typeof session === 'string') this.custodyReconsult?.note(session)
          }
        },
        view: (ev) => {
          const failed = ev.isDecryptionFailure()
          const unread = failed || (ev.isEncrypted() && ev.getClearContent() === null)
          const redacts = (ev.event as { redacts?: unknown }).redacts
          return {
            id: ev.getId() ?? '',
            type: ev.getWireType(),
            sentAt: ev.getTs(),
            redacted: ev.isRedacted(),
            ...(unread && { undecrypted: failed ? (undecryptedArrival(ev) ?? 'awaited') : 'stalled' }),
            ...(ev.getStateKey() !== undefined && { stateKey: ev.getStateKey() }),
            wire: ev.getWireContent() as Record<string, unknown>,
            ...(!unread && { content: ev.getOriginalContent() as Record<string, unknown> }),
            ...(typeof redacts === 'string' && { redacts }),
            ...(foldedKind(ev) !== undefined && { folded: foldedKind(ev) }),
          }
        },
        translate: (roomId, target, edit) => {
          const room = roomOf(roomId)
          if (edit) target.makeReplaced(edit)
          return eventToMessage(target, this.ctx(room))
        },
        cardAuthor: async (roomId, cardId, signal) => {
          const local = client.getRoom(roomId)?.findEventById(cardId)?.getSender()
          if (local) return local
          try {
            const raw = await client.http.authedRequest<{ sender?: unknown }>(
              Method.Get,
              `/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(cardId)}`,
              undefined,
              undefined,
              signal ? { abortSignal: signal } : undefined,
            )
            return typeof raw.sender === 'string' ? raw.sender : undefined
          } catch (err) {
            // §0.3.5 item 2: only "not found" and "forbidden" make the card unreadable (the pair getMessage
            // reads as absence); any other failure goes up as is — no answer and a rate limit are waited on by
            // the engine, the rest fails the export.
            if (err instanceof MatrixError && (err.errcode === 'M_NOT_FOUND' || err.errcode === 'M_FORBIDDEN')) return undefined
            throw err
          }
        },
        person: (roomId, mxid) => {
          const member = client.getRoom(roomId)?.getMember(mxid)
          const raw = member?.rawDisplayName?.trim()
          if (!raw || raw === mxid) return undefined
          return { name: cleanDisplayName(raw, mxid), kind: this.kindOf(mxid) }
        },
        media: (ref, signal) => this.mediaBlob(ref, 'full', signal),
        mediaType: (ref) => this.mediaByToken.get(mediaRefToRaw(ref))?.mimetype,
        classify: (err) => {
          if (isNetworkFailure(err) || err instanceof ConnectionError) return { kind: 'connection' }
          if (err instanceof RateLimitedError) return { kind: 'rateLimit' }
          if (err instanceof MatrixError && err.errcode === 'M_LIMIT_EXCEEDED') {
            const waitMs = rateLimitWaitMs(err)
            return waitMs === undefined ? { kind: 'rateLimit' } : { kind: 'rateLimit', waitMs }
          }
          return { kind: 'other' }
        },
        now: () => Date.now(),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      },
      opts,
    )
  }
}
