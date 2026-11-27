// ADR-088: the ACL contract types the translator also needs live in @tayet/shared; re-exported so the
// barrel's surface (and every importer of ./types) is unchanged.
export type { RosterEntry, AclMode, ConceptKind, AclTelemetry } from '@tayet/shared'
import type { RosterEntry, AclMode, AclTelemetry, Brand } from '@tayet/shared'
import type {
  ChannelId,
  UserId,
  MessageId,
  AccessId,
  Channel,
  Message,
  User,
  UserKind,
  AgentColor,
  Person,
  MyProfile,
  UserProfile,
  Role,
  Presence,
  Reaction,
  Device,
  MediaRef,
  UnsupportedShape,
  ThreadUnread,
  RichDoc,
  Timestamp,
  AgentCommand,
  AgentPanel,
  AgentForm,
  FormId,
  FormIssue,
  FormValues,
} from '@tayet/shared'
import type { OpaqueSession } from './session'

// ── Pagination ────────────────────────────────────────────────────────────────────────
export type PageCursor = Brand<string, 'PageCursor'>
export interface Page<T> {
  items: T[]
  nextCursor?: PageCursor
}

// ── Outbound event stream (observer multicast) ──────────────────────────────────────────
// The SDK is event-driven; the ACL exposes a *domain* stream, not pointwise lookups.
// Multicast because it is UI-friendly; async-iterable was rejected (awkward multicast).
export type Unsubscribe = () => void

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'offline'

// ADR-115 (Proposto): what this session may do in one channel, one yes or no per verb of the management
// screen. Per channel, not per person: the server may still refuse a verb against a given person, and
// that refusal reaches the screen as the verb's rejection.
export interface ChannelAbilities {
  rename: boolean
  editTopic: boolean
  addPeople: boolean
  removePeople: boolean
  setRoles: boolean
  archive: boolean
}

// Contract invariant: the stream NEVER emits a raw SDK object — the type only admits branded
// domain. Protocol noise (typing, state events, content-less ephemerals) is NOT an event:
// intentional silent discard (PLANO-FASE-1 §1.3 / ADR-007), not degradation.
export type DomainEvent =
  | { t: 'message.received'; channelId: ChannelId; message: Message }
  | { t: 'message.edited'; channelId: ChannelId; message: Message }
  | { t: 'message.removed'; channelId: ChannelId; messageId: MessageId }
  // Send-status transition for an optimistic message (ADR-010); the messageId is the stable id.
  | { t: 'message.status'; channelId: ChannelId; messageId: MessageId; status: 'sent' | 'failed' }
  // Carries the NEW aggregated array (not just ids) so it is consumable without a per-message
  // getter (PLANO-FASE-1-TRADUTORES §1.4). Aggregated by exact key; redaction → decrement.
  | { t: 'reaction.changed'; channelId: ChannelId; messageId: MessageId; reactions: Reaction[] }
  | { t: 'channel.changed'; channel: Channel }
  // ADR-026: channel lifecycle on the GLOBAL stream (replicated per-channel when applicable).
  // Distinct from channel.changed (in-place mutation): these INSERT/REMOVE from the active list.
  // Asymmetric payload (ADR-026 §1): `added` carries the whole Channel (consumer inserts without a
  // getChannel round-trip — mirrors channel.changed); `removed` carries only the channelId (removal
  // needs identity, and on a leave/kick we may have lost read access — mirrors message.removed).
  // `removed` is agnostic of cause: archived = left = removed all surface the same "drop from the
  // active list"; the archived-vs-gone distinction lives in Channel.archived (§2), not the event.
  // `added` pode carregar `archived: true` (entrei numa sala já arquivada) — o consumidor roteia pelo
  // campo (ADR-076 dec. 4).
  | { t: 'channel.added'; channel: Channel } // criação / fui adicionado
  | { t: 'channel.removed'; channelId: ChannelId } // arquivado / saí / fui removido
  | { t: 'member.changed'; channelId: ChannelId; user: UserId; role: Role | null }
  | { t: 'connection.changed'; state: ConnectionState } // hook for P4
  | { t: 'device.attention'; device: Device } // hook for Fase 2 (1-touch)
  | { t: 'content.unsupported'; channelId: ChannelId; shape: UnsupportedShape } // D3 prod
  // ADR-018 (D2): passive "new access to your account" notification. An ACCOUNT event (no
  // channelId) emitted on the GLOBAL stream (subscribe). `access` is the opaque AccessId the UI
  // returns to acknowledgeAccess — never parsed, never shown (P1; "access", not "device"). `at`
  // is the observed instant of the entry. Reuses Device (friendlyName/lastSeen) without new fields.
  | { t: 'account.newAccess'; access: AccessId; device: Device; at: Timestamp }
  // ADR-063 (decorre de ADR-018): the access of an earlier account.newAccess is now recognized —
  // acknowledged here, in another session of the account, or found recognized after this session
  // announced it. Same opaque AccessId; the consumer drops that notice. Global stream only.
  | { t: 'account.accessRecognized'; access: AccessId }
  // ADR-056: global (no channelId — presence is a fact of the person, not the membership;
  // rhymes with account.newAccess). Carries the VALUE so consumers never need a point-read
  // on the hot path; getPresence exists for the late subscriber (a dialog opened after the
  // EDUs). Original rationale cited StubStore ("no point lookup to re-fetch") — corrected
  // by the ADR-056 addendum: the live store is MemoryStore; the contract stands on the
  // reasons above.
  | { t: 'user.presence'; user: UserId; presence: Presence }
  // ADR-083: the organization's people list changed. No payload: the consumer re-reads listPeople.
  // Fires per state change, so a burst of them is normal (the first sync, a migration).
  | { t: 'people.changed' }
  // ADR-074 dec. 4: how complete the local message search is, for the UI's "preparing" and "partial
  // coverage" notices (workspace.md §8 items 7–8). `preparing` = some conversation still has older
  // messages to load AND budget left in this session; `partial` = some conversation still has older
  // messages and its budget for this session is spent. Global stream only; emitted on each transition.
  // Addendum 2026-10-28 (#240): `persisting` = some write of the index to the device has not committed
  // yet (a reload now may lose it); `degraded` = a write failed in this session, so the device keeps less
  // than this session found — true until the session ends.
  | { t: 'search.state'; preparing: boolean; partial: boolean; persisting: boolean; degraded: boolean }
  // ADR-091 dec. 12 (A3-5): the conversation's pinned panels moved — the WHOLE list, filtered
  // (agents that are members, not cleared) and ordered (the agents the person operates first, then by
  // name), exactly as listPanels hands it. Emitted only when the list changes. Channel stream (and global).
  | { t: 'panels.changed'; channelId: ChannelId; panels: AgentPanel[] }
  // ADR-093 (Proposto) (A4-1): the conversation's `/` commands moved — the WHOLE flat list (agents that are
  // members, not cleared), ordered by the command's name and then the agent's name, exactly as
  // listCommands hands it. Emitted only when the list changes. Channel stream (and global).
  | { t: 'commands.changed'; channelId: ChannelId; commands: AgentCommand[] }
  // An agent opened a form for THIS session (only the session that clicked the card or sent the command
  // gets it), and later its state moved. Channel stream (and global).
  | { t: 'form.opened'; channelId: ChannelId; form: AgentForm }
  | { t: 'form.changed'; channelId: ChannelId; form: AgentForm }
  // ADR-099: the approval cards that wait for this person, across conversations: the WHOLE list, newest
  // first, at most 200. Only while watchAwaitingApprovals has an observer: once when the first read ends
  // (empty too), then when the list changes. Global stream only.
  | { t: 'approvals.awaiting'; items: AwaitingApproval[] }

// ── Inbound (domain→SDK) ─────────────────────────────────────────────────────────────────
// INVARIANTE (P1 / ADR-007): uma única variante `attachment` — o cliente NUNCA nomeia um
// msgtype Matrix. A ACL infere m.image/m.file/m.video/m.audio do mimetype do arquivo
// (File.type) no envio. A assimetria com o MessageBody inbound (que separa image/file, para
// render) é DELIBERADA: inbound = o que renderizar; outbound = intenção do usuário, e a
// tradução intenção→msgtype é trabalho da ACL. NÃO dividir esta união para espelhar o
// MessageBody — isso vazaria a escolha de msgtype através do barrel. O pending de anexo
// (ADR-010) usa um MediaRef local (ADR-009) do File.
// ADR-012: `rich` is an ADDITIVE optional field — the structured document the ACL serializes to
// `formatted_body` (HTML). `text` stays the plain fallback (becomes the Matrix `body`); the
// serializer NEVER emits only `formatted_body`. Without `rich`, the send is byte-for-byte the
// prior plain-text contract. editMessage(messageId, body) gains rich content for free (same type).
// The `attachment` variant is untouched (rich caption on an attachment is out of scope — §8).
export type OutgoingBody =
  | { kind: 'text'; text: string; rich?: RichDoc }
  | { kind: 'attachment'; file: File | Blob; name?: string }

// ── Relação no envio — ADR-011 ───────────────────────────────────────────────────────────
// Modificador OPCIONAL e ORTOGONAL ao conteúdo: a relação ("como a mensagem se anexa") vive
// AQUI, fora do OutgoingBody ("o quê"). A ACL traduz a intenção → relação de protocolo
// (`m.thread`); o cliente NUNCA nomeia um rel_type. `thread` é o MessageId de domínio estável
// da raiz (ADR-010), nunca um event id. Ponto de extensão aditivo: replies depois ganham
// `replyTo?: MessageId` no MESMO SendOpts, sem tocar OutgoingBody nem seu guard de compile-time.
export interface SendOpts {
  thread?: MessageId
  // A extensão aditiva que o ADR-011 (Aceito) nomeia literalmente (PLANO-FASE-1-REPLY §0.4/§0.7):
  // responder a uma mensagem da timeline principal. MessageId estável do alvo (ADR-010), nunca
  // event id. A ACL traduz intenção → relação de reply DENTRO da ACL (builder manual estendido —
  // gancho THREADS §9, opção (b); o SDK nunca monta a relação). Mutuamente exclusivo com `thread`
  // NESTA fatia — reply-dentro-de-thread é DEFERIDO com gatilho (PLANO-FASE-1-REPLY §0.7/§8).
  replyTo?: MessageId
  // ADR-037 (M2 outbound): menção intencional. UserId de domínio (opaco); a ACL resolve UserId→mxid e
  // emite `m.mentions: { user_ids }` no conteúdo — mxid/`m.mentions` NUNCA cruzam o barrel (P1).
  // Ortogonal ao conteúdo E à relação: combina com thread/replyTo (uma msg em thread pode mencionar).
  mentions?: UserId[]
  // ADR-093 (Proposto): the `/` command this message invokes — the agent (an opaque UserId) and the
  // command's name, without the slash. The text starts with "/name" (followed by the end or whitespace; the
  // arguments are the rest). The command implies the mention: the ACL adds the agent to the mentions.
  // Combines with thread and replyTo. Text only. The ACL rejects before any effect a name outside the rule,
  // a text that does not start with "/name", and an `agent` that is not an agent. On the wire, an encrypted
  // marker in the content carries the name and the agent; the receiving side reads Message.command.
  command?: { agent: UserId; name: string }
}

// ── Canais: criação e edição (PLANO-MEMBERSHIP-CANAIS §0.2 — assinaturas congeladas) ──────
// Vocabulário de produto puro (P1): `kind` é 'public'|'private' apenas — 'dm' NÃO é um kind de
// criação (DMs nascem por openDirectMessage). SEM campo de cifra (ausência estrutural, ADR-015 —
// toda sala que a ACL cria é E2E por nascimento). Ambos os tipos são reexportados pelo barrel
// (ChannelPatch na U1, NewChannel na U3) sob a regra spec-only: cada um só cruza a fronteira quando
// ganha um consumidor de UI real — no mesmo espírito de OutgoingBody/SendOpts.
export type NewChannel = { name: string; kind: 'public' | 'private'; topic?: string; members?: UserId[] }
export type ChannelPatch = { name?: string; topic?: string }
// ── Reset sob custódia — ADR-019 §2 (FROZEN signature) ───────────────────────────────────
// Single convergent outcome with the house discriminant `t:`. There is NO error/`redirecting`/
// `superseded` variant: the verb is total and fail-closed — anything that does not converge to
// `done` manifests as the PRESENCE of a re-emitted device.attention, never as a return value
// (mirrors acknowledgeAccess's void). `historyPreserved` is the honest flag of best-effort history
// (the protocol never re-encrypts; pre-reset history this device cannot decrypt stays lost).
// Neutral vocabulary under P1 — no device/session/crypto/"secure"-as-state term.
export type ResetOutcome = { t: 'done'; historyPreserved: boolean }

// ACL EXPOSES the ambiguity; the product treats `ambiguous` as an edge error in this slice
// (the disambiguation UX is deferred — PLANO-FASE-1 §1.3 / ADR-007).
export type Resolve<T> =
  | { ok: true; id: T }
  | { ok: false; reason: 'not-found' }
  | { ok: false; reason: 'ambiguous'; candidates: T[] }

// ── Media resolution — ADR-009 ────────────────────────────────────────────────────────────
// Lazy, explicit resolution of an opaque MediaRef. The `url` is directly usable PER-SESSION;
// `release()` is idempotent (revokes the object URL for the blob transport, no-op for SW).
// Transport (SW vs blob) is ACL-internal and never crosses this barrel.
export type MediaVariant = 'thumbnail' | 'full'
export interface ResolvedMedia {
  url: string
  release(): void
}

// ── Local message search — ADR-074 ───────────────────────────────────────────────────────
// One result of searchMessages. `message` is the translated Message as last seen (ids minted for this
// session); `channel` is where it lives; `excerpt` is the original text around the first match, split so
// the UI can mark the match without re-running the matching. No author name (the UI resolves it).
export type SearchHit = {
  message: Message
  channel: ChannelId
  excerpt: { before: string; match: string; after: string }
}

// ── Approvals awaiting the person — ADR-099 ──────────────────────────────────────────────
// One item of approvals.awaiting. `message` is the translated card with its state already read (the
// author and the instant come from it); `channel` is where it lives.
export type AwaitingApproval = { message: Message; channel: ChannelId }

// ── D3 fail-closed (contract-level) ──────────────────────────────────────────────────────
// AclMode, ConceptKind and AclTelemetry live in @tayet/shared (src/acl-types.ts, ADR-088).

export interface AclOptions {
  mode: AclMode // 'strict' in dev/test/CI (throws); 'lenient' in prod (degrades by nature)
  telemetry: AclTelemetry
  // Base URL que a ACL disca para alcançar o backend (config de bootstrap que o app fornece,
  // ex.: 'https://tayet.example'). Deliberadamente neutro na superfície pública: o consumidor
  // nunca precisa saber que é um homeserver Matrix. A ACL é a única camada que usa.
  serverUrl: string
  session?: OpaqueSession
  /**
   * Chamado quando a ACL renova a sessão OIDC (refresh de token). Recebe a nova OpaqueSession
   * (blob re-serializado) para o app re-persistir. Refresh é da ACL; persistência é do app
   * (ADR-030 / ADR-032 D2). Opaco — o app re-persiste sem interpretar.
   */
  onSessionRenewed?: (session: OpaqueSession) => void
  /**
   * Chamado quando a ACL detecta que a sessão morreu em runtime e é IRRECUPERÁVEL — o refresh terminal
   * (refresh grant revogado/expirado: TokenRefreshLogoutError / invalid_grant). Irmão simétrico de
   * onSessionRenewed (renovou ↔ perdeu). Payload-free por P1: o errcode/tipo do SDK fica confinado em
   * acl/internal e NUNCA cruza o barrel (ADR-035 D2). O app faz o teardown (→ revoked); a idempotência
   * contra a tempestade de re-disparo é do consumidor (ADR-035 D3).
   */
  onSessionLost?: () => void
}

// ADR-118 dec. 4: the two sets of the role read. Ids of people and agents; the organization's own service
// accounts are never in them.
export interface OrgAccess {
  admins: UserId[]
  withoutAccess: UserId[]
}

// ADR-083: `kind` is what the admin chose; `channels` are the admin's own to add the person to.
export interface NewPerson {
  name: string
  email: string
  // ADR-086 (Proposto) dec. 4: an agent is never invited as a person — same type as the people
  // client's PersonKind (acl/internal/escrow-client.ts), spelled here so the surface imports nothing
  // from internal.
  kind: Exclude<UserKind, 'agent'>
  channels: ChannelId[]
}

// ADR-086 (Proposto): the agent the admin just created. `token` is the agent's credential, an opaque
// string shown ONCE by the UI (to be pasted into the agent's process) — never logged, never stored by
// the client, never read back: the service does not keep it either.
export interface NewAgent {
  userId: UserId
  token: string
}

// ADR-086: what the admin may change on an agent. The kind and the operator are not editable.
export interface AgentPatch {
  name?: string
  color?: AgentColor
}

// Two phases: the person exists from the first, and each channel is a separate step. A channel that
// failed comes back in `failedChannels`; the invite itself succeeded.
export interface PersonInvite {
  user: User
  failedChannels: ChannelId[]
}

// ── Data export of one person — ADR-096 ──────────────────────────────────────────────────
// The verb hands back the export as parts, already in the open format (shared/EXPORT-FORMAT.md): every
// path and text carries only synthetic identifiers. A module outside the ACL writes the zip
// (PLANO-EXPORT-DADOS §0.3.3 H1): the screen's zip writer, src/ui/zip.ts, read by the export dialog (§0.3.6).
export interface DataExportOptions {
  /** The README text (product copy from the catalog). */
  readme: string
  /** The name written for an access that has none (the same generic copy the accesses screen uses). */
  unnamedAccess: string
  signal?: AbortSignal
}

export type DataExportPart =
  | { t: 'file'; path: string; content: string }
  | { t: 'attachment'; path: string; data: Blob }
  | { t: 'progress'; done: number; total: number }
  | {
      t: 'done'
      totals: { conversations: number; messages: number; deleted: number; attachments: number; gaps: number }
      incomplete: Array<{ channel: Channel; gaps: number }>
    }

// ── Account preferences ──────────────────────────────────────────────────────────────────
// The person's interface preferences, kept in their account so they hold on every device. `language` is
// opaque to the ACL: the UI writes and validates it; absent means Automatic.
export interface AccountPreferences {
  language?: string
}

// ── Device notifications ─────────────────────────────────────────────────────────────────
// ADR-117 dec. 6: this access's Web Push subscription, in the shape of the browser's PushSubscription.toJSON
// (`endpoint` and the two keys, unpadded base64url). Opaque to the ACL beyond its shape.
export interface DeviceNotificationSubscription {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

// ADR-117 dec. 5: where a notification's click leads, as the notification carries it (strings it got from the push or
// from the live tab). Untrusted until resolveNotificationTarget checks it against the session's conversations.
export interface NotificationTarget {
  conversation: string
  message?: string
  thread?: string
}

// ── The single public surface ────────────────────────────────────────────────────────────
export interface Acl {
  // Outbound (SDK→domain)
  getChannels(): Promise<Channel[]>
  // ADR-076 dec. 3: só os arquivados (getChannels segue só-ativos, ADR-026 §3).
  getArchivedChannels(): Promise<Channel[]>
  getChannel(id: ChannelId): Promise<Channel>
  // Scrollback only — the LIVE tail arrives via the stream (message.received), NOT here. The
  // cursor opaquely wraps the SDK's /messages backfill token (PLANO §1.3). Accepts a thread from
  // the start (threads are MVP) without assuming root-only.
  getTimeline(id: ChannelId, opts?: { thread?: MessageId; cursor?: PageCursor }): Promise<Page<Message>>
  getMembers(id: ChannelId): Promise<RosterEntry[]>
  // ADR-083: the organization, from the state the sync already delivers. Outside the organization
  // channel (a guest) the list is empty. Service accounts are not people.
  listPeople(): Promise<Person[]>
  // ADR-090 (Proposto) dec. 3: the agents this session operates, read from the organization channel.
  // The only agents the known set offers (picker, add member, DM). Without that channel (a guest)
  // the list is empty. Synchronous: state the sync already delivered, no network.
  listOwnAgents(): User[]
  // ADR-083 dec. 7: asked once per connect; any failure is false. ADR-118 dec. 6: the answer turns false,
  // without a new read, when an organization verb or read meets the service's refusal
  // (OrgAccessDeniedError) or when this session takes its own role away (setOrgAdmin on itself).
  isOrgAdmin(): Promise<boolean>
  // ADR-118 dec. 4, admin of the organization only: who is an admin and who has no valid access, each a
  // set of people and agents of the organization (the caller crosses them with listPeople). Nothing is
  // kept. OrgAccessDeniedError when the session is not an admin; PeopleUnavailableError when the
  // service did not answer.
  getOrgAccess(): Promise<OrgAccess>
  // ADR-056: point read from the ACL-side presence map (solves the late subscriber —
  // a dialog opened after the EDUs passed). Unknown resolves 'offline'. Synchronous by
  // design: it is a Map lookup, no network.
  getPresence(user: UserId): Presence
  // ADR-114 (Proposto): point read of the connection state — the last one the ACL reported on the
  // stream (solves the late subscriber — a screen that subscribed after the state was reported).
  // 'connecting' before the first. Synchronous by design: a field read, no network.
  getConnectionState(): ConnectionState
  // ADR-115 (Proposto): point read of what this session may do in a channel (rename, topic, add, remove,
  // roles, archive), from the state the ACL already holds. All false for a channel this session is not
  // in, a direct conversation or a group conversation. Synchronous by design: no network.
  getChannelAbilities(id: ChannelId): ChannelAbilities
  getDevices(): Promise<Device[]>

  // Self-identity (ADR-039): who the operator is, as a domain User. Derives from the internal
  // whoami (the canonical id the ACL already holds to compute `mine`) — the mxid and the whoami
  // never cross this barrel; only the opaque User does (UserId/displayName/avatar?). Mirrors the
  // `mine` pattern (ADR-007/039): a self-identity read at the product altitude, no protocol id
  // exposed. Resolves the same shape getMembers yields per member (clean displayName, opaque avatar).
  currentUser(): Promise<User>

  // Editable profile (ADR-040). getMyProfile reads the org-managed fullName (displayName snapshot) +
  // the self-authored nickname + pronouns (extended profile, ADR-042). The account-data key/mxid/claims
  // never cross this barrel — only clean strings. Mirrors the `currentUser` P1 posture (ADR-039).
  getMyProfile(): Promise<MyProfile>
  // Perfil editável (ADR-040 → ADR-042 → ADR-053). Patch por PRESENÇA de chave: um patch só com
  // `pronouns` NÃO reescreve o nome; um só com `nickname` NÃO toca o perfil estendido; um só com
  // `note` não toca nenhum dos dois. nickname mantém a semântica do ADR-040 (escreve o displayName
  // efetivo + snapshot do fullName no 1º write); pronouns e note escrevem campos estendidos MSC4133
  // distintos. '' em qualquer um limpa. Chave/mxid/método de protocolo nunca cruzam o barrel — só
  // strings limpas. Generaliza setNickname (2º consumidor, ADR-036 ≥2); `note` é a 3ª chave, não
  // verbo novo. ADR-086 (Proposto) dec. 6: a nickname equal (case, accent and space aside) to the name
  // of a known agent rejects with NameInUseError before any write — UX; the mark is what prevents
  // impersonation.
  updateMyProfile(patch: { nickname?: string; pronouns?: string; note?: string }): Promise<void>

  // Perfil de OUTRO usuário (ADR-043): nome efetivo + foto + pronomes, resolvido lazy quando a tela de
  // perfil-de-outro abre. Espelha getMyProfile (self) — o sibling de-outro. Uma leitura única via perfil
  // estendido (MSC4133): nome + foto + pronomes numa volta. mxid/url-de-mídia-bruta/chave de protocolo
  // nunca cruzam o barrel — só o UserProfile opaco. Escopo in-room (o entry point compartilha sala; a
  // leitura herda a visibilidade de displayName/avatar). Importe UserProfile no topo do arquivo.
  getUserProfile(user: UserId): Promise<UserProfile>

  // Foto de perfil (ADR-041). setAvatar faz upload cleartext (mídia de perfil pública) e grava o avatar
  // do perfil, devolvendo o MediaRef opaco do mxc novo; removeAvatar limpa. File/MediaRef cruzam o barrel
  // (limpos/opacos); o mxc nunca cruza. Verbos de mídia dedicados (não o patch — generalização espera pronomes).
  setAvatar(file: File): Promise<MediaRef>
  removeAvatar(): Promise<void>

  // Account preferences, read straight from the server (never from the synced cache, which can lag a
  // recent write right after a reload). Without `fresh`, an account whose synced cache does not show
  // the preferences at all resolves {} with no request; `fresh: true` always asks the server. An
  // account that never chose anything resolves {}. Any other failure rejects.
  getAccountPreferences(opts?: { fresh?: boolean }): Promise<AccountPreferences>
  // Patch by key presence: `language` absent leaves it; '' removes it (Automatic). Unknown fields
  // already stored are kept, read straight from the server when the synced cache shows the
  // preferences; with none in the cache the patch is written alone. Resolves when the server confirms
  // the write; failure rejects.
  setAccountPreferences(patch: { language?: string }): Promise<void>

  // ADR-117 dec. 6: notifications on this device, with the app closed. `enable` checks the subscription's shape
  // (rejects with Error, before any request), then registers it unless the account already has it exactly so:
  // idempotent, called on every opening in which the device is on. `disable` removes the one this session
  // registered and forgets it; with none, it resolves without a request. signOut removes it too, bounded.
  enableDeviceNotifications(subscription: DeviceNotificationSubscription): Promise<void>
  disableDeviceNotifications(): Promise<void>
  // ADR-117 dec. 5: a notification's target → a conversation this session is in and lists, or undefined (unknown,
  // left, malformed; never rejects). With `message` and `thread`, the thread reply too, read like getMessage within
  // 3 s; without it in time, only the conversation. No request is made before the conversation is known.
  resolveNotificationTarget(target: NotificationTarget): Promise<{ channel: ChannelId; message?: Message } | undefined>

  // Per-thread unread (ADR-067; closes the deferred per-thread badge from PLANO-FASE-1-TRADUTORES §1.5).
  // A boolean derived by the ACL from the user's READ RECEIPTS, with the same rule in encrypted and
  // cleartext rooms: the thread is unread when its latest reply is not the user's and no receipt
  // covers it. It does NOT read the per-thread counts of the server or the SDK (in an encrypted room
  // those stay 0 until the user has sent a threaded receipt there). In-memory, no network.
  // markRead(channelId, <a thread reply's MessageId>) sends a threaded receipt and clears it. A
  // receipt arriving by sync (read on another device) reaches the UI as channel.changed.
  // The CHANNEL count is untouched (ADR-067, out of scope): in a cleartext room it includes thread
  // replies; in an encrypted room it excludes them until the user has a threaded receipt there.
  getThreadUnread(channelId: ChannelId, root: MessageId): Promise<ThreadUnread>

  // Local message search (ADR-074). Searches what this device has loaded — the conversations seen
  // live, every page read, and the idle backfill (its progress is the search.state event). Substring,
  // case- and accent-insensitive, space-separated terms all required; newest first; under 2 characters
  // → []. `opts.channel` narrows to one conversation. In memory, no network per query.
  searchMessages(query: string, opts?: { channel?: ChannelId }): Promise<SearchHit[]>
  // Point read of one message (ADR-074 dec. 5; the deferred verb of PLANO-FASE-1-REPLY §0.5): from the
  // search index when it holds it, else from the server. undefined when the message does not exist,
  // was removed, or this session cannot read it.
  getMessage(channelId: ChannelId, messageId: MessageId): Promise<Message | undefined>
  // ADR-091 dec. 12 (A3-5): the conversation's pinned panels — one per agent that is a member,
  // the cleared ones out, ordered (the agents the person operates first, then by name). Read through the
  // conversation's anchor, in the background of the timeline (it never blocks it); updates arrive as
  // panels.changed. Rejects ('channel not found') for a conversation that is unknown or of which the
  // session is not a member, like the other read verbs. The panel is never part of Channel.
  listPanels(channelId: ChannelId): Promise<AgentPanel[]>
  // ADR-093 (Proposto) (A4-1): the conversation's `/` commands — flat, one item per command of each agent
  // that is a member (a cleared manifest is out), ordered by the command's name and then the agent's name.
  // Read through the conversation's anchor, in the background; updates arrive as commands.changed. Rejects
  // ('channel not found') like listPanels.
  listCommands(channelId: ChannelId): Promise<AgentCommand[]>

  // ADR-099: observe the approval cards that still take this person's answer, in every conversation;
  // the list arrives as approvals.awaiting on the global stream (subscribe before calling). The first
  // observer starts the read and the last one to leave stops it; with none it costs nothing. A further
  // observer joins the same read and gets the next change, not a replay. Reads again when the connection
  // returns. A card whose state could not be read is not listed. answerApproval takes any item's id,
  // its conversation open or not.
  watchAwaitingApprovals(): Unsubscribe

  // Outbound event stream (multicast)
  subscribe(handler: (e: DomainEvent) => void): Unsubscribe // global, cross-channel
  subscribeChannel(id: ChannelId, handler: (e: DomainEvent) => void): Unsubscribe

  // Inbound (domain→SDK)
  // `opts.thread` (ADR-011) é traduzido para a relação m.thread DENTRO da ACL. Aditivo: enviar
  // sem opts continua idêntico ao contrato da fundação (ADR-010).
  // Pré-condição (ADR-058): o canal tem de ser conhecido da sessão e do qual ela é membro. Para
  // canal desconhecido, ou em que a sessão não é membro (convite ainda não aceito, canal que ela
  // deixou), o verbo rejeita ('channel not found') antes de qualquer efeito, sem emitir eco. Quem
  // cria um canal espera o `channel.added` dele antes de enviar.
  sendMessage(channelId: ChannelId, body: OutgoingBody, opts?: SendOpts): Promise<MessageId>
  editMessage(messageId: MessageId, body: OutgoingBody): Promise<void>
  // ADR-091 dec. 14: answer an approval card with one of its options (the option's `id`).
  // Rejects before any effect when the message is not a card, the option is not among the card's, or the
  // card is no longer open (answered or closed). Not a line: the card itself shows the send — its state
  // goes 'sending', then resolves by the usual rule (message.edited of the card), or 'failed' and the
  // promise rejects; calling again with the same option retries. A call while the answer is in flight
  // joins it (no second send).
  answerApproval(messageId: MessageId, option: string): Promise<void>
  // Submit the open form. The values are checked first: with issues, they come back per field and
  // nothing is sent. Otherwise the form goes 'sending', then 'failed' (the promise rejects), 'noAnswer'
  // (no result 15 s after the server accepted it), 'errors' or 'done', by form.changed. From 'failed',
  // 'noAnswer' or 'errors' a call sends again. 'done' ends the form and frees the session for the next
  // one. Rejects for a form that is not open in this session.
  submitForm(formId: FormId, values: FormValues): Promise<{ ok: true } | { issues: Record<string, FormIssue> }>
  // Discard the open form without confirming; a later result for it is ignored.
  closeForm(formId: FormId): void
  // ADR-075 dec. 5: own message only; not optimistic — resolves after the server accepts, then message.removed.
  deleteMessage(messageId: MessageId): Promise<void>
  react(messageId: MessageId, emoji: string): Promise<void>
  removeReaction(messageId: MessageId, emoji: string): Promise<void>

  // Close the read loop (PLANO-FASE-1-TRADUTORES §1.5): send a read receipt up to a message
  // (or the latest). Without this, server-derived unread never zeroes. For the CHANNEL count the ACL
  // reads the counts (UnreadState); per thread it reads the receipts (getThreadUnread, ADR-067).
  markRead(channelId: ChannelId, upToMessageId?: MessageId): Promise<void>

  // ── Canais, membership, papel e DM (PLANO-MEMBERSHIP-CANAIS §0.2 — assinaturas CONGELADAS) ──
  // Verbos de administração de sala client-side (token do próprio usuário — admin de sala, não de
  // servidor). A tradução intenção→protocolo (createRoom/sendStateEvent/invite/kick/setPowerLevel/
  // leave+forget/m.direct) vive em acl/internal; nenhum vocabulário Matrix cruza aqui (ADR-007/P1).
  // Falha do servidor rejeita HONESTO (a Promise rejeita) — nunca silenciada nem contornada; o
  // stream é a verdade (resolve-on-confirm via channel.added/removed e member.changed — ADR-026).
  createChannel(input: NewChannel): Promise<ChannelId>
  // unarchiveChannel é o sibling de archiveChannel. ADR-076: `channel.added` na transição, com
  // `archived` omitido. Arquivar é reversível por construção.
  archiveChannel(id: ChannelId): Promise<void>
  unarchiveChannel(id: ChannelId): Promise<void>
  updateChannel(id: ChannelId, patch: ChannelPatch): Promise<void>
  leaveChannel(id: ChannelId): Promise<void> // EU saio (≠ removeMember)
  addMember(channelId: ChannelId, user: UserId): Promise<void>
  // ADR-083. PersonExistsError when nothing was missing; PeopleUnavailableError when the service did
  // not finish, and repeating the call completes it.
  invitePerson(person: NewPerson): Promise<PersonInvite>
  removePerson(user: UserId): Promise<void>
  // ADR-086 (Proposto), admin of the organization only (the service decides). NameInUseError on a
  // normalised name collision (dec. 6); PeopleUnavailableError when the service did not finish
  // (repeating completes). The agent appears in listPeople through the stream like a person.
  createAgent(name: string, color: AgentColor): Promise<NewAgent>
  updateAgent(user: UserId, patch: AgentPatch): Promise<void>
  // The current credential stops working now; the new one is returned once.
  reissueAgent(user: UserId): Promise<{ token: string }>
  removeAgent(user: UserId): Promise<void>
  // ADR-118 dec. 5, admin of the organization only: give (true) or take (false) the admin role; both are
  // idempotent. LastAdminError when taking it would leave no admin; NotMemberError when the person is not a
  // member (a guest, a removed account); OrgAccessDeniedError when the session is not an admin;
  // PeopleUnavailableError when the service did not answer. The organization verbs above (invite, remove,
  // agents) also reject with OrgAccessDeniedError on that refusal.
  setOrgAdmin(user: UserId, admin: boolean): Promise<void>
  removeMember(channelId: ChannelId, user: UserId): Promise<void>
  // 'admin'→PL 50, 'member'→PL 0 (owner-tier PL 100 fora do Role). Os guardrails de PL do Matrix
  // viram REJEIÇÃO LEGÍTIMA (um admin/50 não promove acima de 50 nem rebaixa o criador/100) — isso
  // é comportamento correto, não bug: a falha rejeita honesto (ADR-026 / §0.2 aresta).
  setRole(channelId: ChannelId, user: UserId, role: 'admin' | 'member'): Promise<void>
  // IDEMPOTENTE (DM existente não duplica). Rejeita o operador como alvo (backstop; a UI filtra
  // o self da oferta — PLANO-PRESENCA §8.6 item 2).
  openDirectMessage(user: UserId): Promise<ChannelId>
  // ADR-094 (Proposto) dec. 6 to 8 and 11: IDEMPOTENTE pelo conjunto exato (abrir o mesmo conjunto foca a
  // conversa existente). De 2 a GROUP_MAX_OTHERS outros participantes, pessoas ou agentes da própria sessão;
  // a própria sessão, repetido, um só, acima do limite ou agente de outro operador rejeitam antes de qualquer
  // escrita (backstop; a UI não oferece).
  openGroupConversation(users: UserId[]): Promise<ChannelId>
  // ADR-094 (Proposto) dec. 9: a mesma conversa vira canal privado com este nome. Só grupo, nome não vazio,
  // e só quem pode (pessoa da organização que participa; convidado e agente não). Irreversível no produto.
  convertToChannel(id: ChannelId, name: string): Promise<void>

  // Acknowledge a new-access notification (ADR-018 §2.2 — FROZEN signature). Takes the opaque
  // AccessId from an account.newAccess event and marks that access as recognized so it never
  // re-notifies (the recognized set lives in account data — per-account, synced across devices).
  // Returns void: success is the ABSENCE of re-emission; a write failure degrades to a benign
  // re-notification on the next cold start, never to a hidden access. Neutral vocabulary — no
  // device/session/crypto term, no protocol id parsed or exposed.
  acknowledgeAccess(access: AccessId): void

  // Reset the account's custody-backed access (ADR-019 §2 — FROZEN signature). The single
  // emergency exit ADR-014 implies: when cross-signing becomes irrecoverable (the residual claim,
  // total device loss, deliberate compromise), this re-roots trust in a fresh custodied secret and
  // invalidates the old one. Total and RE-ENTRANT: it reads the observed world (custody etag +
  // cross-signing status + 4S presence) and RESUMES the pending step, never regenerating material
  // blindly — so a re-call after an interrupted attempt (incl. a top-level redirect) converges.
  // The interactive step (the MAS approval page) is ACL-internal and outside our DOM; the only
  // vocabulary that crosses is the neutral ResetOutcome. Both entry points (settings, the
  // device.attention response) call this same verb. Non-conclusion re-offers via device.attention.
  resetAccess(): Promise<ResetOutcome>

  // Resolve an opaque MediaRef to a usable per-session URL + release() (ADR-009). Lazy: the
  // bytes are fetched (authenticated) and, if encrypted, decrypted here — never eagerly.
  resolveMedia(ref: MediaRef, variant?: MediaVariant): Promise<ResolvedMedia>

  // ADR-096: a copy of the person's own data (PLANO-EXPORT-DADOS §0.3.5 item 1). Parts in order: progress
  // (0 of the total), then per conversation each attachment as soon as it is obtained, the conversation's
  // file and progress; at the end the profile picture (when obtained), README.txt, manifest.json,
  // account.json; last, `done`. The search backfill is held back the whole time. Aborting `signal` rejects
  // with its reason; a failure rejects (a connection that stays down for two minutes: ConnectionError).
  // Consumed by the export dialog (src/ui/useDataExport.ts, PLANO-EXPORT-DADOS §0.3.6).
  exportMyData(opts: DataExportOptions): AsyncIterable<DataExportPart>

  // Residual string→id path only (deep-link, raw mention, programmatic).
  // Click/select/autocomplete carry a ChannelId/UserId — they do NOT go through here.
  resolveChannel(raw: string): Promise<Resolve<ChannelId>>
  resolveUser(raw: string): Promise<Resolve<UserId>>

  // Lifecycle
  connect(session: OpaqueSession): Promise<void>
  disconnect(): Promise<void>

  // Logout (ADR-034 D1/D2): encerra a sessão E apaga o store de cripto do SDK. LOCAL-ONLY — não
  // revoga a sessão no servidor (a copy é "Sair deste navegador"; o refresh token expira sozinho).
  // Vocabulário neutro: nenhum termo de store/cripto/dispositivo cruza. O app complementa com a
  // limpeza da sessão persistida (clearSession) e a navegação à tela de revogação (D8b).
  signOut(): Promise<void>
}
