import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  Acl,
  AccessId,
  AgentCommand,
  AgentPanel,
  Channel,
  ChannelId,
  ChannelPatch,
  ConnectionState,
  DataExportOptions,
  DataExportPart,
  Device,
  Message,
  MessageId,
  MyProfile,
  NewChannel,
  NewPerson,
  NewAgent,
  AgentPatch,
  AgentColor,
  PageCursor,
  Person,
  PersonInvite,
  Presence,
  RosterEntry,
  SearchHit,
  SendOpts,
  ThreadUnread,
  User,
  UserId,
  UserProfile,
} from '@tayet/client'
import type { ComposeResult } from './compose'
import type { ComposerCommand } from './composer/RichComposer'
import { createNotifier, type Notifier } from './notifier'
import { createLiveReader, type LiveReader } from './live-read'
import { coalesce } from './coalesce'
import { applyTitle } from './document-title'
import type { NewAccess } from './components/NewAccessBanner'
import type { KnownAccess } from './components/AccountSettings'
import type { ResetStatus } from './components/ResetAccessBanner'
import { getLocale } from './i18n'

function indexUsers(members: RosterEntry[]): Record<string, User> {
  const out: Record<string, User> = {}
  for (const { user } of members) out[user.id] = user
  return out
}

function upsertChannel(channels: Channel[], next: Channel): Channel[] {
  const i = channels.findIndex((c) => c.id === next.id)
  if (i === -1) return [...channels, next]
  const copy = channels.slice()
  copy[i] = next
  return copy
}

// Upsert by STABLE id (ADR-010): the optimistic 'pending' echo and the later settled view
// share one id, so this replaces in place — no duplicate, no flicker, no re-key.
function upsertMessage(messages: Message[], next: Message): Message[] {
  const i = messages.findIndex((m) => m.id === next.id)
  if (i === -1) return [...messages, next]
  const copy = messages.slice()
  copy[i] = next
  return copy
}

// message.edited is "this delivered message changed" (an edit, a late decrypt, a thread summary —
// ADR-015/066): apply in place, never insert. The ACL can re-emit a thread root the UI never loaded
// (outside the window); inserting it would append an old message at the bottom.
function replaceMessage(messages: Message[], next: Message): Message[] {
  const i = messages.findIndex((m) => m.id === next.id)
  if (i === -1) return messages
  const copy = messages.slice()
  copy[i] = next
  return copy
}

// The loaded thread roots (ADR-066) as a stable string key: one "count\tid" line per root, so the
// per-root unread read re-runs when a root appears or gains a reply, not on every timeline change.
function threadRootsKey(messages: Message[]): string {
  return messages
    .filter((m) => m.threadSummary !== undefined)
    .map((m) => `${m.threadSummary!.replyCount}\t${m.id}`)
    .join('\n')
}

// Jump to a search hit (ADR-074; manifest workspace.md §8 items 9–11, U5). At most this many older
// pages are walked to reach a message outside the loaded window before the jump gives up ("Não foi
// possível abrir esta mensagem"); the ADR-074 trigger reopens timelineSupport/context if it shows up.
export const JUMP_PAGE_LIMIT = 20

// Walks older pages from `cursor` until `target` is in hand or the ceiling. `older` comes back oldest
// first and deduped against `have`, ready to prepend. A thread walks the thread's own pages.
async function reachMessage(
  acl: Acl,
  channel: ChannelId,
  have: Message[],
  cursor: PageCursor | undefined,
  target: MessageId,
  thread?: MessageId,
): Promise<{ older: Message[]; cursor: PageCursor | undefined; pages: number; found: boolean }> {
  const seen = new Set<MessageId>(have.map((m) => m.id))
  const older: Message[] = []
  let pages = 0
  while (!seen.has(target) && cursor !== undefined && pages < JUMP_PAGE_LIMIT) {
    const page = await acl.getTimeline(channel, thread ? { thread, cursor } : { cursor })
    pages += 1
    const fresh = page.items.filter((m) => !seen.has(m.id))
    for (const m of fresh) seen.add(m.id)
    older.unshift(...fresh)
    cursor = page.nextCursor
  }
  return { older, cursor, pages, found: seen.has(target) }
}

// Prepends the older messages a jump walked, skipping any the state already has.
function prependOlder(prev: Message[], older: Message[]): Message[] {
  if (older.length === 0) return prev
  const have = new Set(prev.map((m) => m.id))
  return [...older.filter((m) => !have.has(m.id)), ...prev]
}

// A jump in progress: where it goes and, for a thread reply, the root whose thread it opens. The
// per-channel and thread effects consume it when the page they load is the one the jump needs.
interface JumpPlan {
  channel: ChannelId
  target: MessageId
  root?: Message
}

// Shared union of the people the operator can already see (Track U/U3, F4): the union of getMembers
// over the VISIBLE channels, deduped by UserId, sorted by displayName. The SINGLE source of that set
// — `listCandidates` layers the add-member guard + roster-exclusion on top (seam B1), while
// `listKnownContacts` (the U3 compose DM picker) uses it raw. No directory verb, no enumeration
// beyond the visible list: the UI composing existing per-channel reads; resolveUser stays
// non-interactive (ADR-029 §3).
async function unionOfVisibleMembers(acl: Acl, channels: Channel[]): Promise<User[]> {
  const lists = await Promise.all(channels.map((c) => acl.getMembers(c.id)))
  const byId = new Map<string, User>()
  for (const list of lists)
    for (const { user } of list) if (!byId.has(user.id)) byId.set(user.id, user)
  return [...byId.values()].sort((a, b) => a.displayName.localeCompare(b.displayName, getLocale()))
}

// ADR-090 (Proposto) dec. 3: the known set offers an agent only to its operator. Agents seen in the
// union are dropped and the session's own agents (acl.listOwnAgents(), read from #all) are added —
// deduped by id, re-sorted with the union's comparator so the union's relative order holds. The
// single place the filter exists; listCandidates and listKnownContacts both pass through it.
function offerableUnion(acl: Acl, union: User[]): User[] {
  const byId = new Map<string, User>()
  for (const u of union) if (u.kind !== 'agent') byId.set(u.id, u)
  for (const u of acl.listOwnAgents()) if (!byId.has(u.id)) byId.set(u.id, u)
  return [...byId.values()].sort((a, b) => a.displayName.localeCompare(b.displayName, getLocale()))
}

// Wires the ACL to React state. ALL reconciliation (edits, removals, echo) already happened in
// the ACL — this hook only applies clean domain deltas. It never sees a protocol concept.
export interface ChatState {
  channels: Channel[]
  // ADR-076 dec. 4-5: the archived channels, a list apart from `channels` (which stays only-active).
  // Fed by getArchivedChannels + routing channel.added by `archived` + re-snapshot on channel.removed.
  archivedChannels: Channel[]
  selectedId: ChannelId | undefined
  messages: Message[]
  // ADR-091 (Proposto) dec. 12 (A3-5): the selected conversation's pinned panels, filtered and ordered by
  // the ACL (listPanels on select, then panels.changed). Empty while loading or when there are none.
  panels: AgentPanel[]
  // ADR-093 (Proposto), PLANO-AGENTES §0.3.24 item 1: the selected conversation's `/` commands, as the ACL
  // orders them (listCommands on select, then commands.changed). Empty while loading or when there are none.
  commands: AgentCommand[]
  usersById: Record<string, User>
  // ADR-039: the operator's own domain identity, for the sidebar footer. null until resolved (or if
  // the self-identity read fails) — the footer falls back to a neutral placeholder.
  currentUser: User | null
  connection: ConnectionState
  canLoadOlder: boolean
  // Search jump (ADR-074; manifest workspace.md §8 items 9–11). `jump` is the jump in flight (the
  // timeline pill, interaction blocked) or the one that failed (the inline line on its hit);
  // `highlight` is the row to mark — `seq` restarts the animation when the same row is reached again.
  jump: { target: MessageId; failed: boolean } | undefined
  highlight: { id: MessageId; seq: number } | undefined
  // Opens the conversation (and the thread) with the message marked: a search hit, or a card of "Aguardando você".
  jumpTo: (hit: Pick<SearchHit, 'message' | 'channel'>) => void
  // Forgets a failed jump's line (the narrow search screen closing, PLANO-MOBILE M6 B1).
  dismissJump: () => void
  clearHighlight: () => void
  // Thread sub-slice (PLANO-FASE-1-THREADS §7). Open a thread from a main-timeline message; the
  // panel shows the root + its replies and composes into the thread. All routing (threadParent,
  // m.thread) stays in the ACL — the UI only carries domain Messages.
  threadRoot: Message | undefined
  threadMessages: Message[]
  threadUnread: ThreadUnread | undefined
  // Per-root thread unread for the loaded roots with a thread summary (ADR-066), keyed by root id —
  // the marker on the root. Read from getThreadUnread (an in-memory read in the ACL); refreshed when
  // the channel's counts change (channel.changed) and after the open thread is marked read.
  threadUnreadByRoot: Record<string, ThreadUnread>
  // Channel-management sub-slice (Track U/U1, ADR-029). The channel whose management panel is open,
  // or undefined. State-mounted sibling of the ThreadPanel (no dedicated route). The list itself
  // still reconciles via the stream (channel.added/removed); this only drives panel visibility.
  managing: Channel | undefined
  // Roster of the MANAGED channel (Track U/U2, ADR-029 — seam A1). Keyed on `managing.id` in its OWN
  // effect, decoupled from `usersById`/`selectedId`: `select` does not clear `managing`, and the
  // manage entry point opens only on `current`, so `managing` can diverge from `selectedId` with the
  // panel open — sourcing the roster from `usersById` would show the wrong channel. `usersById` is
  // untouched (it still feeds author names on the spine). Members carry their Role for the role
  // control; the roster reconciles only on confirmed `member.changed` (never optimistically).
  members: RosterEntry[]
  // Reply mode (PLANO-FASE-1-REPLY commit 6): the message being replied to, or undefined. The UI only
  // carries the domain Message; send() passes its stable id as SendOpts.replyTo and the ACL owns
  // the relation (ADR-011). Cleared on send, on cancel, and on channel switch.
  replyTarget: Message | undefined
  // Passive new-access notifications (ADR-018). Each carries the opaque AccessId the UI hands back
  // to acknowledgeAccess on dismiss — never rendered. Sourced from the GLOBAL stream (account event).
  newAccesses: NewAccess[]
  dismissAccess: (access: AccessId) => void
  // ADR-018 (complemento proativo): a lista de acessos conhecidos à conta, surfaçada em
  // AccountSettings. Mapeada de getDevices() para a KnownAccess local de UI (id mantido só como key
  // de React, nunca renderizado; vocabulário "acesso", nunca "dispositivo" — P1). Carregada no
  // connect e atualizada quando um novo acesso aparece. lastSeen cruza pro meta "Ativo {quando}"
  // (manifesto account-access §2; gatilho do §8.A2 cumprido pelo relativeTimeOf).
  accesses: KnownAccess[]
  // ADR-083: whether the operator administers the organization, read once per connect, and its people.
  orgAdmin: boolean
  people: Person[]
  invitePerson: (person: NewPerson) => Promise<PersonInvite>
  removePerson: (user: UserId) => Promise<void>
  // ADR-086 (Proposto): agent management, pass-throughs to the barrel.
  createAgent: (name: string, color: AgentColor) => Promise<NewAgent>
  updateAgent: (user: UserId, patch: AgentPatch) => Promise<void>
  reissueAgent: (user: UserId) => Promise<{ token: string }>
  removeAgent: (user: UserId) => Promise<void>
  // ADR-082: where the reset stands, for the banner and the account surface.
  resetStatus: ResetStatus
  // ADR-019: device.attention raised → the actionable reset banner shows. requestReset drives the
  // single barrel verb (shared with the settings entry point).
  attentionNeeded: boolean
  requestReset: () => void
  startReply: (target: Message) => void
  cancelReply: () => void
  select: (id: ChannelId) => void
  // The narrow stack's way back to the list: nothing stays selected. A failed jump keeps its line: the
  // narrow stack comes back to the search on a failure (PLANO-MOBILE M6 B2).
  deselect: () => void
  // The composer emits the rich ComposeResult ({ text, rich? }); the ACL owns the protocol
  // translation (ADR-012). `mentions` rides separately (the opaque UserIds the picker collected, P1).
  // `command`: the picked `/` command (ADR-093 dec. 7) → SendOpts.command.
  send: (body: ComposeResult, mentions: UserId[], command?: ComposerCommand) => void
  sendAttachment: (file: File) => void
  // Edit rides the rich editor surface (ADR-051 PR-5b): the ComposeResult flows straight to the ACL,
  // symmetric with send — no markdown parse in the middle.
  edit: (message: Message, body: ComposeResult) => void
  remove: (message: Message) => void
  retry: (message: Message) => void
  // ADR-091 dec. 14: answer an approval card. Fire-and-forget like send: the card shows the send itself
  // (sending/failed, folded by the ACL) and "Tentar de novo" calls this again — never the message retry,
  // which would drop the card.
  answerApproval: (message: Message, option: string) => void
  toggleReaction: (message: Message, emoji: string) => void
  loadOlder: () => void
  openThread: (root: Message) => void
  closeThread: () => void
  sendThread: (body: ComposeResult, mentions: UserId[], command?: ComposerCommand) => void
  sendThreadAttachment: (file: File) => void
  // Channel-management verbs (Track U/U1, ADR-029 §2). Unlike send() (fire-and-forget, optimistic),
  // these RETURN the verb's Promise so the panel/dialog can await it, close on success, and keep the
  // error inline on failure (await-and-close). The error is NOT swallowed here — the component owns it.
  manageChannel: (channel: Channel) => void
  closeManage: () => void
  updateChannel: (id: ChannelId, patch: ChannelPatch) => Promise<void>
  archiveChannel: (id: ChannelId) => Promise<void>
  unarchiveChannel: (id: ChannelId) => Promise<void>
  leaveChannel: (id: ChannelId) => Promise<void>
  // ADR-094 dec. 9: the group's details panel converts it into a private channel (await-and-close;
  // the same room reconciles through channel.changed and stays selected).
  convertToChannel: (id: ChannelId, name: string) => Promise<void>
  // Member-management verbs (Track U/U2, ADR-029 §2). await-and-close, like the U1 verbs above:
  // each returns the ACL verb's Promise unwrapped (no .catch here — the panel owns the error) and
  // does NOT mutate `members` optimistically; the roster reconciles via the `member.changed` stream.
  // `setMemberRole` (not `setRole`) avoids colliding with a setState-style name.
  addMember: (id: ChannelId, user: UserId) => Promise<void>
  removeMember: (id: ChannelId, user: UserId) => Promise<void>
  setMemberRole: (id: ChannelId, user: UserId, role: 'admin' | 'member') => Promise<void>
  // Candidate set for the add-member picker (Track U/U2, ADR-029 §3 — seam B1). Composed lazily in
  // the UI when the picker opens: the union of `getMembers` over the VISIBLE channels, deduped by
  // UserId, minus the managed channel's roster, sorted by displayName. No new ACL verb — this is the
  // UI composing existing per-channel reads; `resolveUser` stays non-interactive.
  listCandidates: () => Promise<User[]>
  // Creation surfaces (Track U/U3, ADR-029 — the compose dialog). await-and-close, like the verbs
  // above: each returns void once the server accepts; the dialog owns the error (no .catch here) and
  // nothing is inserted optimistically. Post-creation selection is driven by the `channel.added`
  // stream, never an immediate setSelectedId (seam S1 — the room is not yet in the SDK store when the
  // verb resolves, so getMembers would throw). `listKnownContacts` feeds the DM picker.
  createChannel: (input: NewChannel) => Promise<void>
  openDirectMessage: (user: UserId) => Promise<void>
  // ADR-094 dec. 8 and 11: the group conversation of the compose dialog, selected by the same path as
  // openDirectMessage (an already-listed group — the same set — selects at once; a new one on its
  // channel.added).
  openGroupConversation: (users: UserId[]) => Promise<void>
  // Known-contact set for the compose DM picker (Track U/U3, F4). The raw union of visible members —
  // distinct from listCandidates: no managed-channel guard, no roster exclusion.
  listKnownContacts: () => Promise<User[]>
  // ADR-090 (Proposto) dec. 3: is this user an agent the session operates? A live read of
  // acl.listOwnAgents() (synchronous, #all state) — gates the profile's DM CTA for agents.
  isOwnAgent: (id: UserId) => boolean
  // Profile editor (ADR-040). loadMyProfile reads the org-managed fullName + current nickname lazily
  // when the editor opens (mirrors listCandidates), stashing fullName for the optimistic compute.
  // saveProfile writes the profile patch (await-and-close — the editor owns the error) and, on resolve,
  // optimistically updates currentUser.displayName to the new effective name (nickname || fullName)
  // when the patch carries a nickname. This is the ADR-039 one-shot→reactive promotion: the ACL write
  // does NOT update the local profile synchronously, so re-reading currentUser() would be stale — the
  // optimistic set is correct.
  loadMyProfile: () => Promise<MyProfile>
  saveProfile: (patch: { nickname?: string; pronouns?: string; note?: string }) => Promise<void>
  // Perfil-de-outro (ADR-043, Slice 2 PR-2). Lê o UserProfile read-only de OUTRO usuário (User +
  // pronomes) lazy quando a sub-tela abre — espelha loadMyProfile, mas pro alvo opaco, não pro self.
  // Sem promoção otimista: é só leitura, nada escreve. Passa direto pro UserProfileDialog.
  loadUserProfile: (user: UserId) => Promise<UserProfile>
  // Canais em comum com OUTRO usuário (ADR-053 dec. 4, PR-3). Derivação client-side: a interseção
  // dos canais visíveis com a membership do alvo — nenhum verbo de diretório, nenhum tipo novo. É o
  // idioma do ADR-029 §3 (a UI compondo leituras por-canal existentes), o mesmo de
  // unionOfVisibleMembers — que este NÃO reusa: aquele une pessoas, este filtra canais.
  // O alvo entra por ARGUMENTO, como em loadUserProfile: o Workspace conhece o alvo, o useChat tem
  // o acl, e nenhum dos dois precisa do que é do outro.
  loadCommonChannels: (user: UserId) => Promise<Channel[]>
  // Presença (ADR-056 — rollout de linha, PLANO-PRESENCA §8.4). `presenceByUser` é o mapa único
  // das superfícies de linha: UMA assinatura do stream global alimenta o estado (user.presence →
  // merge imutável); sem memo na Timeline por ora (EDU é diff-suppressed e o offline tem histerese
  // — adjudicação 7). As assinaturas do useChat atacham DEPOIS do connect (Boot aguarda
  // acl.connect antes do App montar), então EDUs do backlog podem preceder o mapa — as linhas
  // leem presenceByUser[id] ?? onGetPresence(id), com o point read síncrono como seed. Os
  // pass-throughs getPresence/subscribePresence PERMANECEM: o UserProfileDialog (superfície
  // entregue) não migra pro mapa — assina por conta própria no mount e resolve o late-subscriber
  // via point read.
  presenceByUser: Record<UserId, Presence>
  getPresence: (user: UserId) => Presence
  subscribePresence: (handler: (user: UserId, presence: Presence) => void) => () => void
  // Foto de perfil (ADR-041 PR-3). saveAvatar faz upload + set (await-and-close — o controle é dono do
  // erro) e, no resolve, otimisticamente seta currentUser.avatar = o MediaRef (mr_*) novo que setAvatar
  // devolve; clearAvatar → undefined. Mesma promoção reativa do displayName (ADR-039): o write não
  // atualiza o perfil local de forma síncrona, então re-ler viria stale — o otimista é a forma correta.
  // O footer/roster (que renderizam currentUser.avatar desde o PR-2) refletem na hora.
  saveAvatar: (file: File) => Promise<void>
  clearAvatar: () => Promise<void>
  // ADR-096: the data export, straight from the verb; the dialog's hook consumes the parts.
  exportMyData: (opts: DataExportOptions) => AsyncIterable<DataExportPart>
}

// `narrow`: the window is below the width breakpoint, where the shell is a stack. There the list
// is a screen of its own, so the boot selects nothing, and the open thread covers the
// conversation's timeline.
export function useChat(acl: Acl, { narrow = false }: { narrow?: boolean } = {}): ChatState {
  const narrowRef = useRef(narrow)
  useEffect(() => {
    narrowRef.current = narrow
  }, [narrow])
  const [channels, setChannels] = useState<Channel[]>([])
  const [archivedChannels, setArchivedChannels] = useState<Channel[]>([])
  const [selectedId, setSelectedId] = useState<ChannelId | undefined>(undefined)
  const [messages, setMessages] = useState<Message[]>([])
  const [panels, setPanels] = useState<AgentPanel[]>([])
  const [commands, setCommands] = useState<AgentCommand[]>([])
  const [usersById, setUsersById] = useState<Record<string, User>>({})
  // ADR-039: self-identity, resolved once at boot (mirrors getChannels). Opaque domain User — the
  // footer renders displayName/avatar only; the id stays a non-rendered key.
  const [currentUser, setCurrentUser] = useState<User | null>(null)
  const [connection, setConnection] = useState<ConnectionState>('connecting')
  const [cursor, setCursor] = useState<PageCursor | undefined>(undefined)
  const [threadRoot, setThreadRoot] = useState<Message | undefined>(undefined)
  const threadRootId = threadRoot?.id
  const threadRootChannel = threadRoot?.channelId
  const [threadMessages, setThreadMessages] = useState<Message[]>([])
  const [threadUnread, setThreadUnread] = useState<ThreadUnread | undefined>(undefined)
  const [threadUnreadByRoot, setThreadUnreadByRoot] = useState<Record<string, ThreadUnread>>({})
  // Bumped on the selected channel's channel.changed (its counts moved, threads included) so the
  // per-root unread is re-read.
  const [unreadTick, setUnreadTick] = useState(0)
  // Track U/U1 (ADR-029): the channel whose management panel is open. Mirrors threadRoot's pattern.
  const [managing, setManaging] = useState<Channel | undefined>(undefined)
  // Track U/U2 (ADR-029 — seam A1): the managed channel's roster, in its own state keyed on
  // managing.id (see the dedicated effect below). Distinct from usersById, which stays untouched.
  const [members, setMembers] = useState<RosterEntry[]>([])
  const [replyTarget, setReplyTarget] = useState<Message | undefined>(undefined)
  const [newAccesses, setNewAccesses] = useState<NewAccess[]>([])
  // ADR-018: acessos conhecidos à conta, mapeados de getDevices() (Device → KnownAccess). Carregados
  // no connect; atualizados em account.newAccess para o acesso recém-aparecido também entrar na lista.
  const [accesses, setAccesses] = useState<KnownAccess[]>([])
  const [orgAdmin, setOrgAdmin] = useState(false)
  const [people, setPeople] = useState<Person[]>([])
  // ADR-019: device.attention raised — the recovery hit the interactive wall and the user must
  // reset. A single boolean: the offer is for THIS session, deduped by nature. Cleared when a reset
  // converges; if it does not, the ACL re-emits device.attention and this flips back on.
  const [attentionNeeded, setAttentionNeeded] = useState(false)
  const [resetStatus, setResetStatus] = useState<ResetStatus>('idle')
  // ADR-056 rollout (PLANO-PRESENCA §8.4): o mapa único de presença das superfícies de linha,
  // alimentado pela assinatura global abaixo (uma assinatura, não uma por linha).
  const [presenceByUser, setPresenceByUser] = useState<Record<UserId, Presence>>({})
  // Attachment retry needs the original File, but a domain Message carries only an opaque MediaRef.
  // So we keep the picked File until its optimistic pending bubble settles: `pendingAttachment`
  // holds the File of the in-flight send (single-file — batch is deferred, PLANO §4) and is consumed
  // by the pending echo to map id→File for a possible retry. ACL stays the only place that touches
  // the SDK; this is purely the UI remembering what the user picked.
  const pendingAttachment = useRef<File | undefined>(undefined)
  // Seam S1 (Track U/U3): the id a creation verb is waiting to select. Armed by createChannel/
  // openDirectMessage; consumed (and cleared) by the channel.added handler when the matching room
  // lands in the store. Never selects an id the SDK store does not yet hold.
  const pendingSelect = useRef<ChannelId | null>(null)
  // Stable mirror of `channels` for openDirectMessage's idempotent fast-path: after the verb resolves
  // it checks whether the (possibly pre-existing) DM is ALREADY in the list, without re-creating the
  // callback on every channel change (which a closure over `channels` would force).
  const channelsRef = useRef<Channel[]>(channels)
  useEffect(() => {
    channelsRef.current = channels
  }, [channels])
  // ADR-073 dec. 7: the tab title follows the counts of what notifies.
  useEffect(() => {
    applyTitle(channels)
  }, [channels])
  // ADR-073: the notifier's view of the selection (dec. 4 suppression), same idiom as channelsRef.
  const selectedRef = useRef<ChannelId | undefined>(selectedId)
  useEffect(() => {
    selectedRef.current = selectedId
  }, [selectedId])
  const notifierRef = useRef<Notifier | undefined>(undefined)
  const liveReadRef = useRef<LiveReader | undefined>(undefined)
  // Search jump (U5). Mirrors of the window state the jump reads without re-creating its callback, and
  // `loadedRef`: the channel whose first page is in `messages` (undefined while it loads).
  const [jump, setJump] = useState<{ target: MessageId; failed: boolean } | undefined>(undefined)
  const [highlight, setHighlight] = useState<{ id: MessageId; seq: number } | undefined>(undefined)
  const highlightSeq = useRef(0)
  const jumpPlan = useRef<JumpPlan | undefined>(undefined)
  const messagesRef = useRef<Message[]>(messages)
  const cursorRef = useRef<PageCursor | undefined>(cursor)
  const loadedRef = useRef<ChannelId | undefined>(undefined)
  const threadRootRef = useRef<Message | undefined>(threadRoot)
  const threadMessagesRef = useRef<Message[]>(threadMessages)
  useEffect(() => {
    messagesRef.current = messages
    cursorRef.current = cursor
    threadRootRef.current = threadRoot
    threadMessagesRef.current = threadMessages
  }, [messages, cursor, threadRoot, threadMessages])
  // On a narrow window the open thread of the selected conversation is the screen in
  // front, covering the conversation's timeline. Read through refs by the notifier and the live read.
  const threadOnScreen = useCallback((): MessageId | undefined => {
    const root = threadRootRef.current
    return narrowRef.current && root && root.channelId === selectedRef.current ? root.id : undefined
  }, [])
  // The thread screen went away (back to the conversation, or the window widened): the conversation's
  // timeline is in view again and is read up to what the screen holds.
  const threadCovering = narrow && threadRoot !== undefined && threadRoot.channelId === selectedId
  const wasCovering = useRef(false)
  useEffect(() => {
    if (wasCovering.current && !threadCovering) liveReadRef.current?.resume()
    wasCovering.current = threadCovering
  }, [threadCovering])
  // Widening with the list on screen selects the first conversation, as the boot does.
  const wasNarrow = useRef(narrow)
  useEffect(() => {
    if (wasNarrow.current && !narrow && selectedRef.current === undefined) {
      const first = channelsRef.current[0]
      if (first) setSelectedId(first.id)
    }
    wasNarrow.current = narrow
  }, [narrow])
  // The jump reached its message (highlight it) or gave up (the failure line). Only the plan still in
  // force settles: a newer jump or a channel switch replaced it.
  const settleJump = useCallback((plan: JumpPlan, found: boolean) => {
    if (jumpPlan.current !== plan) return
    jumpPlan.current = undefined
    if (found) {
      setJump(undefined)
      highlightSeq.current += 1
      setHighlight({ id: plan.target, seq: highlightSeq.current })
    } else setJump({ target: plan.target, failed: true })
  }, [])
  const cancelJump = useCallback(() => {
    if (!jumpPlan.current) return
    jumpPlan.current = undefined
    setJump(undefined)
  }, [])
  // The main-timeline half of a jump, from a loaded window: walk older pages, prepend them, settle.
  const runMainJump = useCallback(
    (plan: JumpPlan, have: Message[], from: PageCursor | undefined, alive: () => boolean) => {
      reachMessage(acl, plan.channel, have, from, plan.target).then(
        (r) => {
          if (!alive()) return
          if (r.pages > 0) {
            setMessages((prev) => prependOlder(prev, r.older))
            setCursor(r.cursor)
          }
          settleJump(plan, r.found)
        },
        () => alive() && settleJump(plan, false),
      )
    },
    [acl, settleJump],
  )
  const filesByMessageId = useRef<Map<string, File>>(new Map())

  // ADR-083: the people list, only for an admin. A failure leaves the section absent.
  useEffect(() => {
    let alive = true
    let unsub = (): void => {}
    const read = coalesce(() => {
      void acl.listPeople().then((list) => alive && setPeople(list)).catch(() => {})
    })
    void (async () => {
      if (!(await acl.isOrgAdmin()) || !alive) return
      setOrgAdmin(true)
      read()
      unsub = acl.subscribe((e) => {
        if (e.t === 'people.changed') read()
      })
    })().catch(() => {})
    return () => {
      alive = false
      unsub()
    }
  }, [acl])

  // Global: initial channel load + connection/channel-list updates.
  useEffect(() => {
    let alive = true
    // ADR-018: Device → KnownAccess (id só como key, nunca renderizado).
    // Carregado agora e re-executado em account.newAccess para um acesso fresco entrar na lista.
    const loadAccesses = () =>
      void acl.getDevices().then((ds) => {
        if (!alive) return
        setAccesses(
          ds.map((d: Device) => ({
            id: d.id,
            friendlyName: d.friendlyName,
            current: d.current,
            lastSeen: d.lastSeen,
          })),
        )
      })
    loadAccesses()
    void acl.getChannels().then((chs) => {
      if (!alive) return
      setChannels(chs)
      // On a narrow window the list is on screen and nothing is selected.
      setSelectedId((cur) => cur ?? (narrowRef.current ? undefined : chs[0]?.id))
    })
    // ADR-076 dec. 3: the archived snapshot, a read apart (getChannels stays only-active).
    void acl
      .getArchivedChannels()
      .then((chs) => alive && setArchivedChannels(chs))
      .catch(() => {})
    // ADR-039: resolve who the operator is for the identity footer. Same mount guard as getChannels;
    // a failure leaves currentUser null (the footer falls back to a neutral placeholder).
    void acl.currentUser().then((u) => alive && setCurrentUser(u)).catch(() => {})
    const unsub = acl.subscribe((e) => {
      notifierRef.current?.handle(e)
      liveReadRef.current?.handle(e)
      if (e.t === 'connection.changed') setConnection(e.state)
      // ADR-076: an archived channel's metadata change never resurrects it among the active ones
      // (emitChannelChanged already skips archived rooms — defense in depth).
      else if (e.t === 'channel.changed') {
        if (e.channel.archived) setArchivedChannels((prev) => upsertChannel(prev, e.channel))
        else setChannels((prev) => upsertChannel(prev, e.channel))
      }
      // ADR-026 lifecycle: a channel was created / I was added (append if absent), or it was
      // removed (archived / I left / I was removed — the event is agnostic of cause, so one handler
      // covers archiveChannel and leaveChannel). On removal, drop it, deselect if it was selected,
      // and close the management panel if it was managing the now-gone channel.
      // ADR-076 dec. 4: channel.added routes by `archived` — true (I entered an already-archived room)
      // goes to the archived list; omitted (created / added / un-archived) goes to the active one.
      else if (e.t === 'channel.added') {
        const id = e.channel.id
        if (e.channel.archived) {
          setArchivedChannels((prev) => upsertChannel(prev, e.channel))
          setChannels((prev) => prev.filter((c) => c.id !== id))
        } else {
          setChannels((prev) => upsertChannel(prev, e.channel))
          setArchivedChannels((prev) => prev.filter((c) => c.id !== id))
        }
        // Seam S1: a creation verb armed this id; now that the room is in the store, select it (the
        // per-channel effect's getMembers will resolve, not throw). Clear the latch so a later,
        // unrelated channel.added never re-selects.
        if (pendingSelect.current === e.channel.id) {
          pendingSelect.current = null
          setSelectedId(e.channel.id)
        }
      }
      else if (e.t === 'channel.removed') {
        setChannels((prev) => prev.filter((c) => c.id !== e.channelId))
        setSelectedId((cur) => (cur === e.channelId ? undefined : cur))
        setManaging((cur) => (cur?.id === e.channelId ? undefined : cur))
        // ADR-076 dec. 5: removal is agnostic of cause — drop from both lists, then re-snapshot the
        // archived read (its join filter keeps a kicked/banned channel out; "archived" lands in).
        setArchivedChannels((prev) => prev.filter((c) => c.id !== e.channelId))
        void acl
          .getArchivedChannels()
          .then((chs) => alive && setArchivedChannels(chs))
          .catch(() => {})
      }
      // ADR-018: a new access to the account. Append a dismissible banner (deduped by the opaque
      // AccessId). friendlyName is the device's MAS display name; blank → the banner uses generic
      // copy. The AccessId is kept only to hand back to acknowledgeAccess on dismiss.
      else if (e.t === 'account.newAccess') {
        setNewAccesses((prev) =>
          prev.some((a) => a.access === e.access)
            ? prev
            : [...prev, { access: e.access, friendlyName: e.device.friendlyName }],
        )
        // A lista proativa reflete o novo acesso por APPEND INCREMENTAL do device que o evento já
        // carrega — NÃO um refetch de getDevices por evento (era O(n) em acessos não-reconhecidos: com
        // o OIDC criando um device por login, o connect disparava centenas de newAccess → centenas de
        // GET /v3/devices). Deduped por id; o backlog do connect (devices já no snapshot inicial) vira
        // no-op. §8.L23.
        setAccesses((prev) =>
          prev.some((a) => a.id === e.device.id)
            ? prev
            : [...prev, { id: e.device.id, friendlyName: e.device.friendlyName, current: e.device.current }],
        )
      }
      // ADR-063: that access is recognized (here or in another session of the account) — its notice
      // goes away. The known-access list keeps it: recognized is still an access.
      else if (e.t === 'account.accessRecognized')
        setNewAccesses((prev) => prev.filter((a) => a.access !== e.access))
      // ADR-019: actionable attention — the background recovery needs an interactive reset. Distinct
      // from the passive account.newAccess above; offers the reset rather than just notifying.
      else if (e.t === 'device.attention') setAttentionNeeded(true)
      // ADR-056 rollout (§8.4): merge imutável no mapa único de presença. Same-value events keep the
      // previous object identity, so a diff-suppressed duplicate never re-renders the tree.
      else if (e.t === 'user.presence')
        setPresenceByUser((prev) =>
          prev[e.user] === e.presence ? prev : { ...prev, [e.user]: e.presence },
        )
    })
    return () => {
      alive = false
      unsub()
    }
  }, [acl])

  // ADR-073: notifications from the live tab. The global subscription above forwards every DomainEvent
  // to the notifier; it reads the channel list and the selection through refs (not a stale closure)
  // and decides by itself.
  useEffect(() => {
    const notifier = createNotifier({
      getChannel: (id) => channelsRef.current.find((c) => c.id === id),
      getSelectedId: () => selectedRef.current,
      select: setSelectedId,
      getMembers: (id) => acl.getMembers(id).then((ms) => ms.map((m) => m.user)),
      getThreadOnScreen: threadOnScreen,
    })
    notifierRef.current = notifier
    return () => {
      notifierRef.current = undefined
      notifier.dispose()
    }
  }, [acl, threadOnScreen])

  // ADR-100: the open conversation is read as messages arrive (and when the document comes back in
  // view). Fed by the same global subscription; reads the selection, the open thread and what the
  // screen holds through refs. The selection's and the thread's own markRead (below) are untouched.
  useEffect(() => {
    const reader = createLiveReader({
      markRead: (id, upTo) => acl.markRead(id, upTo),
      getSelectedId: () => selectedRef.current,
      getOpenThread: () => {
        const root = threadRootRef.current
        return root && root.channelId === selectedRef.current ? root.id : undefined
      },
      getMain: () => messagesRef.current,
      getReplies: () => threadMessagesRef.current,
      threadRead: (id, root) =>
        void acl
          .getThreadUnread(id, root)
          .then((u) => {
            if (threadRootRef.current?.id === root) setThreadUnread(u)
          })
          .catch(() => {}),
      getThreadOnScreen: threadOnScreen,
    })
    liveReadRef.current = reader
    return () => {
      liveReadRef.current = undefined
      reader.dispose()
    }
  }, [acl, threadOnScreen])

  // Per-channel: load timeline + members, mark read, and apply stream deltas.
  useEffect(() => {
    if (!selectedId) return
    let alive = true
    const id = selectedId
    // Switching channels closes any open thread (its root belongs to the previous channel) and
    // any reply in progress (its target belongs to the previous channel too) — unless a search jump
    // into a thread of this channel is what selected it: then that thread opens (U5).
    const opening = jumpPlan.current?.channel === id ? jumpPlan.current.root : undefined
    setThreadRoot(opening)
    setThreadMessages([])
    setThreadUnread(undefined)
    setReplyTarget(undefined)
    loadedRef.current = undefined
    void acl.getTimeline(id).then((p) => {
      if (!alive) return
      setMessages(p.items)
      setCursor(p.nextCursor)
      loadedRef.current = id
      // A jump to a main-timeline message of this channel continues from this first page.
      const plan = jumpPlan.current
      if (plan?.channel === id && !plan.root) runMainJump(plan, p.items, p.nextCursor, () => alive)
    }, () => {
      // The page failed: a jump waiting on it gives up (never a pill left on screen).
      const plan = jumpPlan.current
      if (alive && plan?.channel === id && !plan.root) settleJump(plan, false)
    })
    void acl.getMembers(id).then((ms) => alive && setUsersById(indexUsers(ms)))
    void acl.markRead(id).catch(() => {})
    // The pinned panels (A3-5): read in the background of the timeline — a failed or slow read never
    // blocks it — then kept by panels.changed below (the whole list each time).
    setPanels([])
    void Promise.resolve()
      .then(() => acl.listPanels(id))
      .then(
        (list) => {
          if (alive) setPanels(list)
        },
        () => {},
      )
    // The conversation's commands (A4-4): the same background read, then commands.changed below.
    setCommands([])
    void Promise.resolve()
      .then(() => acl.listCommands(id))
      .then(
        (list) => {
          if (alive) setCommands(list)
        },
        () => {},
      )

    const unsub = acl.subscribeChannel(id, (e) => {
      // Thread replies (and our own thread echo) belong to the thread sub-slice, NOT the main
      // timeline — route them out by threadParent (ADR-010×threads / PLANO-FASE-1-THREADS §6).
      if (e.t === 'message.received') {
        // Map the optimistic attachment pending bubble's stable id → the picked File, so a failed
        // send can be retried (the Message body carries only an opaque MediaRef, never the File).
        if (
          e.message.status === 'pending' &&
          e.message.body.kind !== 'text' &&
          pendingAttachment.current &&
          !filesByMessageId.current.has(e.message.id)
        ) {
          filesByMessageId.current.set(e.message.id, pendingAttachment.current)
          pendingAttachment.current = undefined
        }
        if (e.message.threadParent === undefined) setMessages((prev) => upsertMessage(prev, e.message))
      } else if (e.t === 'message.edited') {
        // Route edits the same way as receives: a thread reply's edit belongs to the thread sub-slice,
        // not the main timeline (ADR-010×edit / ADR-011). Without this guard an edited thread reply
        // would be injected into the main timeline by the unconditional upsert.
        if (e.message.threadParent === undefined) {
          setMessages((prev) => replaceMessage(prev, e.message))
          // The open thread's root follows its own message (an edit, a late decrypt, an approval card's
          // state — A3-2 rodada 2): the same substitution as the list above. Functional, so a closed
          // root (undefined) never reopens and another thread's root is left as it is.
          setThreadRoot((root) => (root?.id === e.message.id ? e.message : root))
        }
      }
      else if (e.t === 'message.removed') {
        setMessages((prev) => prev.filter((m) => m.id !== e.messageId))
        // A deleted root closes its open thread (ADR-075). Functional: this handler outlives the
        // render that opened the thread; the thread subscription below clears the replies.
        setThreadRoot((root) => (root?.id === e.messageId ? undefined : root))
      }
      else if (e.t === 'message.status')
        setMessages((prev) =>
          prev.map((m) => (m.id === e.messageId ? { ...m, status: e.status } : m)),
        )
      else if (e.t === 'reaction.changed')
        setMessages((prev) =>
          prev.map((m) => (m.id === e.messageId ? { ...m, reactions: e.reactions } : m)),
        )
      else if (e.t === 'member.changed')
        void acl.getMembers(id).then((ms) => alive && setUsersById(indexUsers(ms)))
      else if (e.t === 'channel.changed') setUnreadTick((t) => t + 1)
      else if (e.t === 'panels.changed') setPanels(e.panels)
      else if (e.t === 'commands.changed') setCommands(e.commands)
    })
    return () => {
      alive = false
      unsub()
      // Leaving the channel a jump was headed to abandons it (the pill must not outlive it).
      if (jumpPlan.current?.channel === id) cancelJump()
    }
  }, [acl, selectedId, runMainJump, cancelJump])

  // Per-root thread unread (ADR-066 dec. 4): one getThreadUnread per loaded root WITH a summary —
  // an in-memory read in the ACL, no network. Re-read when the set of roots or their counts change,
  // when the channel's counts move (unreadTick) and when the open thread was marked read
  // (threadUnread refreshed), so the marker clears after reading.
  const rootsKey = threadRootsKey(messages)
  useEffect(() => {
    if (!selectedId || rootsKey === '') {
      setThreadUnreadByRoot({})
      return
    }
    let alive = true
    const id = selectedId
    const rootIds = rootsKey.split('\n').map((line) => line.slice(line.indexOf('\t') + 1) as MessageId)
    void Promise.all(
      rootIds.map((root) =>
        acl.getThreadUnread(id, root).then(
          (u) => [root, u] as const,
          () => undefined,
        ),
      ),
    ).then((entries) => {
      if (!alive) return
      const next: Record<string, ThreadUnread> = {}
      for (const entry of entries) if (entry) next[entry[0]] = entry[1]
      setThreadUnreadByRoot(next)
    })
    return () => {
      alive = false
    }
  }, [acl, selectedId, rootsKey, unreadTick, threadUnread])

  // Managed-channel roster (Track U/U2, ADR-029 — seam A1). Keyed on the PRIMITIVE managing?.id, not
  // the managing object (which is replaced on every channel.changed, which would churn the effect).
  // Wholly independent of the per-channel effect above: it loads getMembers(managing.id) and
  // re-fetches on this channel's member.changed via its OWN subscription, so the roster reflects the
  // MANAGED channel even when it differs from selectedId. Cleared when no panel is open. usersById is
  // never touched here. The role rides along (the U1 indexUsers drops it; the roster needs it).
  useEffect(() => {
    const id = managing?.id
    if (!id) {
      setMembers([])
      return
    }
    let alive = true
    void acl.getMembers(id).then((ms) => alive && setMembers(ms))
    const unsub = acl.subscribeChannel(id, (e) => {
      if (e.t === 'member.changed')
        void acl.getMembers(id).then((ms) => alive && setMembers(ms))
    })
    return () => {
      alive = false
      unsub()
    }
  }, [acl, managing?.id])

  // Thread sub-slice: load the open thread's replies + per-thread unread, and apply live deltas
  // scoped to this thread (threadParent === root.id). The live thread tail arrives via the SAME
  // stream (message.received with threadParent) — getTimeline({thread}) is scrollback only.
  useEffect(() => {
    // A root of ANOTHER channel: switching channels with a thread open commits the new selectedId
    // before the per-channel effect's setThreadRoot(undefined) lands, so this effect would read the
    // old root in the new channel (a 404 on the server, seen in the timeline.spec console ledger, §8.27).
    if (!selectedId || !threadRootId || threadRootChannel !== selectedId) return
    let alive = true
    const id = selectedId
    const rootId = threadRootId
    // The jump this load serves, if any: closing or switching the thread abandons it (cleanup below);
    // a newer jump re-opening the same thread is another plan and survives.
    const serving = jumpPlan.current?.root?.id === rootId ? jumpPlan.current : undefined
    void acl.getTimeline(id, { thread: rootId }).then((p) => {
      if (!alive) return
      setThreadMessages(p.items)
      // A jump to a reply of this thread: walk the thread's older pages until it is in hand (U5).
      const plan = jumpPlan.current
      if (plan?.root?.id === rootId)
        reachMessage(acl, id, p.items, p.nextCursor, plan.target, rootId).then(
          (r) => {
            if (!alive) return
            setThreadMessages((prev) => prependOlder(prev, r.older))
            settleJump(plan, r.found)
          },
          () => alive && settleJump(plan, false),
        )
      // Mark the thread read (threaded receipt) so its badge zeroes; refresh the count after.
      const last = p.items[p.items.length - 1]
      // No reply, no receipt: markRead without a target receipts the MAIN tail (#252, PLANO-RELEASE-PUBLICA §8.65).
      void (last ? acl.markRead(id, last.id) : Promise.resolve())
        .then(() => acl.getThreadUnread(id, rootId))
        .then((u) => alive && setThreadUnread(u))
        .catch(() => {})
    }, () => {
      // The thread page failed: a jump waiting on it gives up.
      if (alive && serving && jumpPlan.current === serving) settleJump(serving, false)
    })
    void acl.getThreadUnread(id, rootId).then((u) => alive && setThreadUnread(u))

    const unsub = acl.subscribeChannel(id, (e) => {
      if (e.t === 'message.received' && e.message.threadParent === rootId)
        setThreadMessages((prev) => upsertMessage(prev, e.message))
      else if (e.t === 'message.edited' && e.message.threadParent === rootId)
        setThreadMessages((prev) => upsertMessage(prev, e.message))
      else if (e.t === 'message.removed') {
        if (e.messageId === rootId) {
          // The open root was deleted (ADR-075): the panel closes.
          setThreadRoot(undefined)
          setThreadMessages([])
        } else setThreadMessages((prev) => prev.filter((m) => m.id !== e.messageId))
      }
      else if (e.t === 'message.status')
        setThreadMessages((prev) =>
          prev.map((m) => (m.id === e.messageId ? { ...m, status: e.status } : m)),
        )
      else if (e.t === 'reaction.changed')
        setThreadMessages((prev) =>
          prev.map((m) => (m.id === e.messageId ? { ...m, reactions: e.reactions } : m)),
        )
    })
    return () => {
      alive = false
      unsub()
      if (serving && jumpPlan.current === serving) cancelJump()
    }
    // Keyed on the root's id and channel, not the snapshot: the root following its own updates (above)
    // is no thread switch — the replies are not reloaded.
  }, [acl, selectedId, threadRootId, threadRootChannel, settleJump, cancelJump])

  // The composer already produced the rich body ({ text, rich? }, ADR-012); we pass it straight to
  // the ACL — no parse here (parseCompose left this call-site in ADR-051 PR-5). No formatting →
  // { text } only, so plain stays plain. In reply mode, pass the target's stable id as
  // SendOpts.replyTo (ADR-011) — the ACL translates intent → relation; the UI never names one — and
  // leave reply mode.
  const send = useCallback(
    (body: ComposeResult, mentions: UserId[], command?: ComposerCommand) => {
      if (!selectedId) return
      const opts: SendOpts | undefined =
        replyTarget || mentions.length || command
          ? {
              ...(replyTarget ? { replyTo: replyTarget.id } : {}),
              ...(mentions.length ? { mentions } : {}),
              ...(command ? { command } : {}),
            }
          : undefined
      setReplyTarget(undefined)
      void acl.sendMessage(selectedId, { kind: 'text', ...body }, opts).catch(() => {})
    },
    [acl, selectedId, replyTarget],
  )

  const startReply = useCallback((target: Message) => setReplyTarget(target), [])
  const cancelReply = useCallback(() => setReplyTarget(undefined), [])

  // Dismiss a new-access banner: hand the opaque AccessId back to the ACL (which persists the
  // acknowledgement so it never re-notifies) and drop the banner. acknowledgeAccess returns void —
  // the UI never awaits nor inspects it (ADR-018 §2.2).
  const dismissAccess = useCallback(
    (access: AccessId) => {
      acl.acknowledgeAccess(access)
      setNewAccesses((prev) => prev.filter((a) => a.access !== access))
    },
    [acl],
  )

  // Reset the account's access (ADR-019). The SAME verb for both entry points — the settings action
  // and the device.attention banner. Called straight from the click: the verb opens its window
  // before its first await (ADR-082 dec. 1), so nothing asynchronous may come before it here. The
  // promise stays pending through the approval; a rejection is the non-conclusion, which the user
  // sees and can retry.
  const requestReset = useCallback(() => {
    const running = acl.resetAccess()
    setResetStatus('pending')
    void running.then(
      () => {
        setAttentionNeeded(false)
        setResetStatus('done')
      },
      () => setResetStatus('notDone'),
    )
  }, [acl])

  // Edit one's own text message in place. The rich edit editor (ADR-051 PR-5b) already produced the
  // ComposeResult ({text, rich?}) — no parse here (parseCompose's last call-site left in PR-5b) — so
  // an edit stays symmetric with send: plain stays plain, formatted rides `rich`. The ACL owns the
  // m.replace.
  const edit = useCallback(
    (message: Message, body: ComposeResult) => {
      void acl.editMessage(message.id, { kind: 'text', ...body }).catch(() => {})
    },
    [acl],
  )

  // Delete one's own message (ADR-075). Not optimistic: the row leaves on the ACL's message.removed,
  // after the server accepts; a failure leaves it in place.
  const remove = useCallback(
    (message: Message) => void acl.deleteMessage(message.id).catch(() => {}),
    [acl],
  )

  // Send a picked file to the selected channel. The ACL infers the msgtype, uploads, and (commit 5)
  // shows the optimistic local preview — the UI only carries the user's intent (a File).
  const sendAttachment = useCallback(
    (file: File) => {
      if (!selectedId) return
      // Remember the File before sending: the ACL emits the optimistic pending echo synchronously,
      // and the message.received handler above consumes this to map the stable id → File for retry.
      pendingAttachment.current = file
      void acl.sendMessage(selectedId, { kind: 'attachment', file }).catch(() => {})
    },
    [acl, selectedId],
  )

  const openThread = useCallback((root: Message) => setThreadRoot(root), [])

  // Search jump (U5, manifest workspace.md §8 items 9–11). Main timeline: select the conversation; if
  // the message is in the loaded window, highlight it; else walk older pages (loadOlder's getTimeline
  // with the cursor, same dedupe) up to JUMP_PAGE_LIMIT. Thread reply: getMessage for the root, open
  // its thread, the same walk over the thread's pages. markRead is untouched (U6): selecting the
  // conversation already marks it, as a click on the list does.
  const jumpTo = useCallback(
    (hit: Pick<SearchHit, 'message' | 'channel'>) => {
      const channel = hit.channel
      const target = hit.message.id
      const rootId = hit.message.threadParent
      const plan: JumpPlan = { channel, target }
      jumpPlan.current = plan
      setHighlight(undefined)
      if (rootId === undefined) {
        if (channel !== selectedRef.current) {
          setJump({ target, failed: false })
          setSelectedId(channel)
          return
        }
        // Its first page is still loading: the per-channel effect picks the plan up when it lands.
        if (loadedRef.current !== channel) {
          setJump({ target, failed: false })
          return
        }
        if (messagesRef.current.some((m) => m.id === target)) {
          settleJump(plan, true)
          return
        }
        setJump({ target, failed: false })
        runMainJump(plan, messagesRef.current, cursorRef.current, () => loadedRef.current === channel)
        return
      }
      setJump({ target, failed: false })
      acl.getMessage(channel, rootId).then(
        (root) => {
          if (jumpPlan.current !== plan) return
          if (!root) {
            settleJump(plan, false)
            return
          }
          plan.root = root
          if (channel !== selectedRef.current) {
            setSelectedId(channel)
            return
          }
          if (threadRootRef.current?.id === root.id && threadMessagesRef.current.some((m) => m.id === target)) {
            settleJump(plan, true)
            return
          }
          // A fresh root object: the thread effect (re)loads it and consumes the plan.
          setThreadRoot(root)
        },
        () => settleJump(plan, false),
      )
    },
    [acl, runMainJump, settleJump],
  )
  const clearHighlight = useCallback(() => setHighlight(undefined), [])
  const dismissJump = useCallback(() => setJump((j) => (j?.failed ? undefined : j)), [])
  // A selection by the user abandons a jump in flight (and its failure line).
  const select = useCallback(
    (id: ChannelId) => {
      jumpPlan.current = undefined
      setJump(undefined)
      setSelectedId(id)
    },
    [],
  )
  const closeThread = useCallback(() => {
    setThreadRoot(undefined)
    setThreadMessages([])
    setThreadUnread(undefined)
  }, [])
  // Back to the list, nothing selected (an open thread goes with its conversation).
  const deselect = useCallback(() => {
    jumpPlan.current = undefined
    setJump((j) => (j?.failed ? j : undefined))
    setSelectedId(undefined)
    setThreadRoot(undefined)
    setThreadMessages([])
    setThreadUnread(undefined)
  }, [])

  // Compose into the open thread (ADR-011). We pass only the stable root MessageId; the ACL
  // translates intent → m.thread and routes the optimistic echo into the thread (commit 8).
  const sendThread = useCallback(
    (body: ComposeResult, mentions: UserId[], command?: ComposerCommand) => {
      if (selectedId && threadRoot)
        void acl
          .sendMessage(
            selectedId,
            { kind: 'text', ...body },
            { thread: threadRoot.id, ...(mentions.length ? { mentions } : {}), ...(command ? { command } : {}) },
          )
          .catch(() => {})
    },
    [acl, selectedId, threadRoot],
  )

  // A picked file into the open thread: sendAttachment's path (the File remembered for retry) plus
  // the root, which routes the send and its optimistic echo into the thread.
  const sendThreadAttachment = useCallback(
    (file: File) => {
      if (!selectedId || !threadRoot) return
      pendingAttachment.current = file
      void acl.sendMessage(selectedId, { kind: 'attachment', file }, { thread: threadRoot.id }).catch(() => {})
    },
    [acl, selectedId, threadRoot],
  )

  // Channel management (Track U/U1, ADR-029). Open/close the side panel.
  const manageChannel = useCallback((channel: Channel) => setManaging(channel), [])
  const closeManage = useCallback(() => setManaging(undefined), [])

  // await-and-close verbs (ADR-029 §2). Each returns the ACL verb's Promise unwrapped — the
  // panel/dialog awaits it to close on success or surface the error inline on failure. We do NOT
  // .catch() here (that is the component's job) and we do NOT update the channel list optimistically:
  // the list reconciles via the stream (channel.added/removed), the single source of truth.
  const updateChannel = useCallback(
    (id: ChannelId, patch: ChannelPatch) => acl.updateChannel(id, patch),
    [acl],
  )
  const archiveChannel = useCallback((id: ChannelId) => acl.archiveChannel(id), [acl])
  // ADR-076 dec. 1: not optimistic — the channel.added of the transition moves it back.
  const unarchiveChannel = useCallback((id: ChannelId) => acl.unarchiveChannel(id), [acl])
  const leaveChannel = useCallback((id: ChannelId) => acl.leaveChannel(id), [acl])
  const convertToChannel = useCallback((id: ChannelId, name: string) => acl.convertToChannel(id, name), [acl])

  // Member mutations (Track U/U2, ADR-029 §2). Same await-and-close shape as the U1 verbs: return
  // the Promise unwrapped, no .catch (the panel owns the error), no optimistic roster mutation (the
  // member.changed stream is the single source of truth — the roster effect above re-fetches on it).
  const addMember = useCallback((id: ChannelId, user: UserId) => acl.addMember(id, user), [acl])
  const removeMember = useCallback((id: ChannelId, user: UserId) => acl.removeMember(id, user), [acl])
  const setMemberRole = useCallback(
    (id: ChannelId, user: UserId, role: 'admin' | 'member') => acl.setRole(id, user, role),
    [acl],
  )

  // Candidate set for the add-member picker (seam B1, ADR-029 §3). Lazy — computed only when the
  // picker calls it, never eagerly. The union of getMembers over the VISIBLE channels (people the
  // operator can already see), deduped by UserId, minus the managed channel's current roster, sorted
  // by displayName. No directory verb, no cross-channel enumeration beyond the visible list: it is
  // the UI composing existing per-channel reads. resolveUser stays non-interactive.
  const listCandidates = useCallback(async (): Promise<User[]> => {
    const id = managing?.id
    if (!id) return []
    const present = new Set(members.map((m) => m.user.id))
    const union = offerableUnion(acl, await unionOfVisibleMembers(acl, channels))
    return union.filter((u) => !present.has(u.id))
  }, [acl, channels, members, managing?.id])

  // Known contacts for the compose DM picker (Track U/U3, F4 sibling). The union of visible members
  // MINUS the operator (PLANO-PRESENCA §8.6 item 2: you don't DM yourself — the ACL contract is the
  // backstop; this filter removes self from the OFFER). Distinct from listCandidates (managed-channel
  // guard + roster exclusion on the same helper). Graceful degradation: currentUser still null
  // (boot/harness) → raw union, the contract backstop covers. resolveUser stays non-interactive;
  // this is the UI composing existing per-channel reads.
  const listKnownContacts = useCallback(
    async (): Promise<User[]> => {
      const union = offerableUnion(acl, await unionOfVisibleMembers(acl, channels))
      return currentUser ? union.filter((u) => u.id !== currentUser.id) : union
    },
    [acl, channels, currentUser],
  )

  const isOwnAgent = useCallback((id: UserId): boolean => acl.listOwnAgents().some((u) => u.id === id), [acl])

  // Creation surfaces (Track U/U3, ADR-029). await-and-close: the Promise resolves on the server's
  // accept; the compose dialog owns the error (no .catch here) and nothing is inserted optimistically
  // (the list reconciles via channel.added — the single source of truth).
  //
  // Seam S1 — select-on-added: the freshly-created room is NOT yet in the SDK store when the verb
  // resolves, so selecting its id now would make the per-channel effect's getMembers throw ('channel
  // not found'). Instead we ARM the returned id; the channel.added handler selects it when the room
  // lands. createChannel always arms (the room is new). openDirectMessage is idempotent: if the
  // returned DM is ALREADY in `channels` no channel.added will fire, so we select it immediately.
  const createChannel = useCallback(
    async (input: NewChannel): Promise<void> => {
      const id = await acl.createChannel(input)
      pendingSelect.current = id
    },
    [acl],
  )
  const selectOrArm = useCallback((id: ChannelId): void => {
    if (channelsRef.current.some((c) => c.id === id)) setSelectedId(id)
    else pendingSelect.current = id
  }, [])
  const openDirectMessage = useCallback(
    async (user: UserId): Promise<void> => {
      selectOrArm(await acl.openDirectMessage(user))
    },
    [acl, selectOrArm],
  )
  // ADR-094 dec. 8: opening a set that already has a group returns it (idempotent, like the DM), so the
  // same fast-path applies; a new group arms and is selected on its channel.added (seam S1).
  const openGroupConversation = useCallback(
    async (users: UserId[]): Promise<void> => {
      selectOrArm(await acl.openGroupConversation(users))
    },
    [acl, selectOrArm],
  )

  // Retry a failed send: drop the failed bubble and re-send afresh (a new echo, new stable id).
  // Stays entirely in domain terms — the UI never touches the SDK's resend machinery. Text re-sends
  // the same text; an attachment re-runs upload+send atomically with the same File kept by id.
  const retry = useCallback(
    (message: Message) => {
      setMessages((prev) => prev.filter((m) => m.id !== message.id))
      if (message.body.kind === 'text') {
        // Re-send the same body — carry the RichDoc if the failed message had one, so a formatted
        // retry stays formatted (send now takes a ComposeResult, not a raw string).
        const body = message.body
        send({ text: body.text, ...(body.rich ? { rich: body.rich } : {}) }, [])
        return
      }
      const file = filesByMessageId.current.get(message.id)
      if (!file) return
      filesByMessageId.current.delete(message.id)
      // A thread attachment stays in its thread: its failed bubble lives in the thread slice.
      if (message.threadParent !== undefined) {
        setThreadMessages((prev) => prev.filter((m) => m.id !== message.id))
        sendThreadAttachment(file)
        return
      }
      sendAttachment(file)
    },
    [send, sendAttachment, sendThreadAttachment],
  )

  const answerApproval = useCallback(
    (message: Message, option: string) => {
      void acl.answerApproval(message.id, option).catch(() => {})
    },
    [acl],
  )

  // Toggle the current user's reaction with a given emoji (add if absent, remove if mine).
  const toggleReaction = useCallback(
    (message: Message, emoji: string) => {
      const existing = message.reactions.find((r) => r.emoji === emoji)
      if (existing?.mine) void acl.removeReaction(message.id, emoji).catch(() => {})
      else void acl.react(message.id, emoji).catch(() => {})
    },
    [acl],
  )

  // Scrollback: fetch an older page via the opaque cursor and PREPEND it (deduping by id so a
  // message that's also in the live tail isn't doubled). The live tail keeps arriving via stream.
  const loadOlder = useCallback(() => {
    if (!selectedId || !cursor) return
    const id = selectedId
    void acl.getTimeline(id, { cursor }).then((page) => {
      setMessages((prev) => {
        const have = new Set(prev.map((m) => m.id))
        const older = page.items.filter((m) => !have.has(m.id))
        return [...older, ...prev]
      })
      setCursor(page.nextCursor)
    })
  }, [acl, selectedId, cursor])

  // ADR-040: o fullName que loadMyProfile capturou, pro compute otimista do displayName efetivo.
  const myFullName = useRef<string>('')

  const loadMyProfile = useCallback(async (): Promise<MyProfile> => {
    const profile = await acl.getMyProfile()
    myFullName.current = profile.fullName
    return profile
  }, [acl])

  const saveProfile = useCallback(
    async (patch: { nickname?: string; pronouns?: string; note?: string }): Promise<void> => {
      await acl.updateMyProfile(patch)
      // Promoção otimista do displayName só quando o patch toca o apelido (ADR-039 reativo).
      if ('nickname' in patch) {
        const effective = (patch.nickname ?? '').trim() || myFullName.current
        setCurrentUser((u) => (u ? { ...u, displayName: effective } : u))
      }
    },
    [acl],
  )

  // ADR-041 PR-3: editar a foto. saveAvatar faz upload+set e, no resolve, seta currentUser.avatar com o
  // MediaRef novo que setAvatar devolve; clearAvatar limpa pra undefined. await-and-close (sem .catch —
  // o ProfilePhoto é dono do erro). Mesma promoção otimista do saveProfile (ADR-039 reativo): re-ler o
  // perfil viria stale, então o set local é a forma correta — footer/roster refletem na hora.
  const saveAvatar = useCallback(async (file: File): Promise<void> => {
    const ref = await acl.setAvatar(file)
    setCurrentUser((u) => (u ? { ...u, avatar: ref } : u))
  }, [acl])

  const clearAvatar = useCallback(async (): Promise<void> => {
    await acl.removeAvatar()
    setCurrentUser((u) => (u ? { ...u, avatar: undefined } : u))
  }, [acl])

  const exportMyData = useCallback((opts: DataExportOptions) => acl.exportMyData(opts), [acl])

  // ADR-043: lê o perfil read-only de outro usuário quando a sub-tela abre (espelha loadMyProfile).
  const loadUserProfile = useCallback(
    (user: UserId): Promise<UserProfile> => acl.getUserProfile(user),
    [acl],
  )

  // ADR-053 dec. 4: os canais que o operador compartilha com o alvo. Lê channelsRef, não `channels`,
  // para manter a identidade do callback estável — o Dialog o chama num efeito de mount, e um
  // callback que muda a cada mudança de canal re-dispararia o load (mesma razão do fast-path de
  // openDirectMessage). Filtra DMs: `channels` os inclui (a separação Canais/Mensagens-diretas é
  // presentacional — a ChannelList seciona por kind). NÃO filtra arquivados: getChannels() já é
  // só-ativos (ADR-026 §3), então isso vem de graça; arquivados vivem em `archivedChannels` (ADR-076). Preserva a ordem de `channels` — a lista tem
  // que bater com a sidebar, então não reordena. Custo: getMembers é síncrono e lê o store do SDK
  // (zero rede, medido no §0 desta trilha); o Promise é a assinatura do barrel, não I/O.
  const loadCommonChannels = useCallback(
    async (user: UserId): Promise<Channel[]> => {
      // ADR-094 dec. 13: nor group conversations — channels in common are channels.
      const visible = channelsRef.current.filter((c) => c.kind !== 'dm' && c.kind !== 'group')
      const rosters = await Promise.all(visible.map((c) => acl.getMembers(c.id)))
      return visible.filter((_, i) => rosters[i]!.some((m) => m.user.id === user))
    },
    [acl],
  )

  const invitePerson = useCallback((person: NewPerson) => acl.invitePerson(person), [acl])
  const removePerson = useCallback((user: UserId) => acl.removePerson(user), [acl])
  const createAgent = useCallback((name: string, color: AgentColor) => acl.createAgent(name, color), [acl])
  const updateAgent = useCallback((user: UserId, patch: AgentPatch) => acl.updateAgent(user, patch), [acl])
  const reissueAgent = useCallback((user: UserId) => acl.reissueAgent(user), [acl])
  const removeAgent = useCallback((user: UserId) => acl.removeAgent(user), [acl])

  // ADR-056: presença pro dialog — pass-throughs estáveis (identidade só muda com o acl, como
  // loadUserProfile; o Dialog assina num efeito de mount e um callback instável re-assinaria).
  const getPresence = useCallback((user: UserId): Presence => acl.getPresence(user), [acl])
  const subscribePresence = useCallback(
    (handler: (user: UserId, presence: Presence) => void) =>
      acl.subscribe((e) => {
        if (e.t === 'user.presence') handler(e.user, e.presence)
      }),
    [acl],
  )

  return {
    channels,
    archivedChannels,
    selectedId,
    messages,
    panels,
    commands,
    usersById,
    currentUser,
    connection,
    canLoadOlder: cursor !== undefined,
    threadRoot,
    threadMessages,
    threadUnread,
    threadUnreadByRoot,
    managing,
    members,
    replyTarget,
    newAccesses,
    dismissAccess,
    accesses,
    orgAdmin,
    people,
    invitePerson,
    removePerson,
    createAgent,
    updateAgent,
    reissueAgent,
    removeAgent,
    attentionNeeded,
    resetStatus,
    requestReset,
    startReply,
    cancelReply,
    select,
    deselect,
    jump,
    highlight,
    jumpTo,
    dismissJump,
    clearHighlight,
    send,
    sendAttachment,
    edit,
    remove,
    retry,
    answerApproval,
    toggleReaction,
    loadOlder,
    openThread,
    closeThread,
    sendThread,
    sendThreadAttachment,
    manageChannel,
    closeManage,
    updateChannel,
    archiveChannel,
    unarchiveChannel,
    leaveChannel,
    convertToChannel,
    addMember,
    removeMember,
    setMemberRole,
    listCandidates,
    createChannel,
    openDirectMessage,
    openGroupConversation,
    listKnownContacts,
    isOwnAgent,
    loadMyProfile,
    saveProfile,
    saveAvatar,
    clearAvatar,
    exportMyData,
    loadUserProfile,
    loadCommonChannels,
    presenceByUser,
    getPresence,
    subscribePresence,
  }
}
