import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  AccessId,
  AgentCommand,
  AgentPanel,
  Channel,
  ChannelId,
  ChannelPatch,
  ConnectionState,
  Message,
  MessageId,
  MyProfile,
  NewChannel,
  NewPerson,
  NewAgent,
  AgentPatch,
  AgentColor,
  AwaitingApproval,
  Person,
  PersonInvite,
  OrgAccess,
  Presence,
  RosterEntry,
  ChannelAbilities,
  ThreadUnread,
  User,
  UserId,
  UserProfile,
} from '@tayet/client'
import type { ComposeResult } from '../compose'
import type { ComposerCommand, ComposerModeProps } from '../composer/RichComposer'
import { LinkSheet, type LinkRequest } from '../composer/LinkSheet'
import { historyOf, textBodyHTML } from '../composer/history'
import { ChannelList } from './ChannelList'
import { SearchField } from './SearchField'
import { SearchResults } from './SearchResults'
import { AwaitingRow, AwaitingScreen } from './AwaitingScreen'
import { awaitingSummary } from '../useAwaiting'
import type { ResolvedHit } from '../useSearch'
import { ChannelLabel, bareName, manageLabel } from './ChannelLabel'
import { AgentAvatar } from './AgentAvatar'
import { GroupBlock, groupCount } from './GroupBlock'
import { resolveAuthor } from '../author'
import { Timeline, excerptOf, actionsOf, type ActionsOrigin } from './Timeline'
import { MessageActionsSheet } from './MessageActionsSheet'
import { ImageViewer, OpenImageContext, type ImageView } from './ImageViewer'
import { Composer } from './Composer'
import { ThreadPanel } from './ThreadPanel'
import { ChannelManagementPanel } from './ChannelManagementPanel'
import { GroupDetailsPanel } from './GroupDetailsPanel'
import { NewConversationDialog } from './NewConversationDialog'
import { AccountSettings, type KnownAccess } from './AccountSettings'
import { OrgAdmin } from './OrgAdmin'
import type { DataExportVerb } from '../useDataExport'
import { UserProfileDialog } from './UserProfileDialog'
import { AgentFormDialog } from './AgentFormDialog'
import type { AgentFormSlice } from '../useAgentForm'
import { NewAccessBanner, type NewAccess } from './NewAccessBanner'
import { ResetAccessBanner, type ResetStatus } from './ResetAccessBanner'
import { PinnedPanel } from './PinnedPanel'
import { usePanelPref } from '../panel-pref'
import { Avatar, ScreenHeader } from '../primitives'
import { Settings, More, Plus, Search } from '../icons'
import { useMedia } from '../MediaContext'
import { isCoarseOrNarrow } from '../narrow'
import { useStackBack, useStackDialog } from '../stack'
import type { Theme } from '../theme'
import type { LanguageState } from '../useLanguage'
import type { DeviceNotificationsRow } from '../useDeviceNotifications'
import { t, APP_NAME, GLYPH } from '../i18n'

// workspace.md §13 item 2: at rest (`connected`) the sidebar says nothing.
const connectionLabel = (): Record<Exclude<ConnectionState, 'connected'>, string> => ({
  connecting: t('shell.connecting'),
  reconnecting: t('shell.reconnecting'),
  offline: t('shell.offline'),
})

// The search cluster's slice of the shell (manifest workspace.md §8), as useSearch shapes it.
export interface SearchProps {
  query: string
  onQuery: (query: string) => void
  scoped: boolean
  onToggleScope?: () => void
  onClear: () => void
  // The query is long enough: results replace the list's sections (§8 item 4).
  active: boolean
  hits: ResolvedHit[]
  searched: string
  preparing: boolean
  partial: boolean
  selected?: MessageId
  failed?: MessageId
  onPick: (hit: ResolvedHit) => void
  // The narrow window's full-screen search (workspace.md §23.5 item 3; PLANO-MOBILE M6 B1): whether it is
  // open (a screen of the stack, between the list and the conversation) and what opens it.
  open?: boolean
  onOpen?: () => void
}

// "Aguardando você" on the narrow window (workspace.md §23.2 item 5, §23.4; PLANO-MOBILE §0.20), as App
// shapes it: the ACL's list (undefined before its first read, V7), what the open screen holds (V3), whether it
// is open (a screen of the stack between the list and the conversation, V2) and its verbs.
export interface AwaitingProps {
  items?: AwaitingApproval[]
  shown: AwaitingApproval[]
  open: boolean
  onOpen: () => void
  // The back where there is no history stack (the harness).
  onClose: () => void
  // The origin line: the conversation opens with the card marked.
  onPick: (item: AwaitingApproval) => void
}

// Pure presentational shell: channel list + timeline + composer. All data arrives as props, so
// it is driven identically by the live app (App.tsx) and by the DOM render-scan test. Nothing
// here reaches for the ACL or any protocol concept — it only renders clean domain.
export function Workspace({
  channels,
  archivedChannels,
  onRestoreChannel,
  selectedChannelId,
  messages,
  panels,
  commands,
  usersById,
  currentUser,
  connection,
  threadRoot,
  threadMessages,
  threadUnread,
  threadUnreadByRoot,
  replyTarget,
  onSelectChannel,
  onSend,
  onSendAttachment,
  onRetry,
  onAnswerApproval,
  onReact,
  onEdit,
  onDelete,
  onReply,
  onCancelReply,
  onLoadOlder,
  onOpenThread,
  onCloseThread,
  onSendThread,
  onSendThreadAttachment,
  managing,
  members,
  channelAbilities,
  onManageChannel,
  onCloseManage,
  onUpdateChannel,
  onArchiveChannel,
  onLeaveChannel,
  onConvertToChannel,
  onAddMember,
  onRemoveMember,
  onSetRole,
  loadCandidates,
  onCreateChannel,
  onOpenDirectMessage,
  onOpenGroupConversation,
  loadKnownContacts,
  isOwnAgent,
  accesses,
  orgAdmin,
  people,
  onGetOrgAccess,
  onSetOrgAdmin,
  onInvitePerson,
  onRemovePerson,
  onCreateAgent,
  onUpdateAgent,
  onReissueAgent,
  onRemoveAgent,
  onLoadProfile,
  onLoadUserProfile,
  onLoadCommonChannels,
  presenceByUser,
  onGetPresence,
  onSubscribePresence,
  onSaveProfile,
  onSaveAvatar,
  onClearAvatar,
  onExportData,
  onReset,
  onSignOut,
  theme,
  onThemeChange,
  language,
  notifications,
  notificationsPrompt,
  search,
  awaiting,
  jump,
  agentForm,
  highlight,
  onHighlightEnd,
  newAccesses,
  onDismissAccess,
  attentionNeeded,
  resetStatus,
  narrow = false,
  onBackToList,
}: {
  channels: Channel[]
  // ADR-076: the sidebar's Archived section (absent/empty → no section) and its Restore verb.
  archivedChannels?: Channel[]
  onRestoreChannel?: (id: ChannelId) => Promise<void>
  selectedChannelId?: ChannelId
  messages: Message[]
  // ADR-091 (Proposto) dec. 12 (A3-5): the conversation's pinned panels, as the ACL orders them.
  panels?: AgentPanel[]
  // ADR-093 (Proposto), PLANO-AGENTES §0.3.24 item 1: the conversation's `/` commands, as the ACL orders
  // them — handed to the conversation's composer and the thread's.
  commands?: AgentCommand[]
  usersById: Record<string, User>
  // ADR-039: the operator's own identity for the sidebar footer. Optional — the bare render-scan
  // harness mounts Workspace without it; null until resolved (the footer falls back to a placeholder).
  currentUser?: User | null
  connection: ConnectionState
  threadRoot?: Message
  threadMessages?: Message[]
  threadUnread?: ThreadUnread
  // ADR-066: per-root thread unread (useChat), for the marker on each root's thread summary.
  threadUnreadByRoot?: Record<string, ThreadUnread>
  // Reply mode: the domain Message being replied to (state owned by useChat). The composer only
  // receives clean display strings derived from it.
  replyTarget?: Message
  // Channel-management sub-slice (Track U/U1, ADR-029). All optional, mirroring the thread pattern:
  // `managing` is the channel whose panel is open; the verbs are await-and-close (return Promises).
  managing?: Channel
  // Track U/U2 roster + mutations. Optional, mirroring the U1 props: the panel renders the read-only
  // roster from `members` (defaulting to []) and the interactive controls only when the handlers are
  // wired. App always wires them; the render-scan harness mounts the panel bare.
  members?: RosterEntry[]
  // ADR-115 (Proposto): what the session may do in the managed channel. Absent = not read: read-only.
  channelAbilities?: ChannelAbilities
  onManageChannel?: (channel: Channel) => void
  onCloseManage?: () => void
  onUpdateChannel?: (id: ChannelId, patch: ChannelPatch) => Promise<void>
  onArchiveChannel?: (id: ChannelId) => Promise<void>
  onLeaveChannel?: (id: ChannelId) => Promise<void>
  // ADR-094 dec. 9: converts the managed group into a private channel (the group's details panel).
  onConvertToChannel?: (id: ChannelId, name: string) => Promise<void>
  onAddMember?: (id: ChannelId, user: UserId) => Promise<void>
  onRemoveMember?: (id: ChannelId, user: UserId) => Promise<void>
  onSetRole?: (id: ChannelId, user: UserId, role: 'admin' | 'member') => Promise<void>
  loadCandidates?: () => Promise<User[]>
  // Compose sub-slice (Track U/U3, ADR-029). All optional, mirroring the management props: the
  // "New conversation" entry + dialog mount only when wired. App always wires them; the render-scan
  // harness mounts the dialog directly (not via Workspace).
  onCreateChannel?: (input: NewChannel, wanted?: () => boolean) => Promise<void>
  onOpenDirectMessage?: (user: UserId, wanted?: () => boolean) => Promise<void>
  onOpenGroupConversation?: (users: UserId[], wanted?: () => boolean) => Promise<void>
  loadKnownContacts?: () => Promise<User[]>
  // ADR-090 (Proposto) dec. 3: the DM CTA on an agent's profile only for its operator. Absent (bare
  // harness) → no agent is own: fail-closed, the CTA never shows on an agent.
  isOwnAgent?: (user: UserId) => boolean
  // Account sub-slice (ADR-038/039): the identity footer + account modal mount only when the account
  // verbs are wired (App). The bare render-scan harness omits them, so the footer never appears there.
  accesses?: KnownAccess[]
  // ADR-083: a seção "Organização" de "Sua conta". Ausente (harness bare) = operador sem a seção.
  orgAdmin?: boolean
  people?: Person[]
  // ADR-118 (fatia 1c): the Admin, opened from "Sua conta" on the wide window. Absent → no Admin row.
  onGetOrgAccess?: () => Promise<OrgAccess>
  onSetOrgAdmin?: (user: UserId, admin: boolean) => Promise<void>
  onInvitePerson?: (person: NewPerson) => Promise<PersonInvite>
  onRemovePerson?: (user: UserId) => Promise<void>
  onCreateAgent?: (name: string, color: AgentColor) => Promise<NewAgent>
  onUpdateAgent?: (user: UserId, patch: AgentPatch) => Promise<void>
  onReissueAgent?: (user: UserId) => Promise<{ token: string }>
  onRemoveAgent?: (user: UserId) => Promise<void>
  // Editar perfil (ADR-040): opcionais aqui, required no AccountSettings — sob o guard canAccount,
  // montar a conta sem eles é irrepresentável (padrão U1/U2). App as liga; o harness bare as omite.
  onLoadProfile?: () => Promise<MyProfile>
  // Perfil-de-outro (ADR-043, Slice 2 PR-2): opcional, espelha as props de conta. App a liga; o
  // harness de render-scan a omite (sem ela, a sub-tela de perfil-de-outro nunca monta). Threadada
  // pra dentro pra alimentar o UserProfileDialog quando `openProfile` está setado.
  onLoadUserProfile?: (user: UserId) => Promise<UserProfile>
  // ADR-053 dec. 4: os canais em comum, threadados pro UserProfileDialog. Opcional dos dois lados —
  // ausente → sem seção. NÃO entra no guard do bloco de montagem (que é openProfile && onLoadUserProfile).
  onLoadCommonChannels?: (user: UserId) => Promise<Channel[]>
  // ADR-056 rollout de linha (§8.4): o mapa único do useChat, lido pelas superfícies de linha via
  // presenceOf abaixo. Opcional — o harness bare o omite e nenhuma linha ganha wrapper/dot (o
  // Avatar sem a prop é byte-idêntico, ADR-036 addendum).
  presenceByUser?: Record<UserId, Presence>
  // ADR-056: presença do alvo, threadada pro UserProfileDialog. Opcionais dos dois lados (idioma de
  // onLoadCommonChannels): ausentes → o dialog não renderiza o cluster de presença. App as liga; o
  // harness bare as omite. Fora do guard de montagem (que segue openProfile && onLoadUserProfile).
  onGetPresence?: (user: UserId) => Presence
  onSubscribePresence?: (handler: (user: UserId, presence: Presence) => void) => () => void
  onSaveProfile?: (patch: { nickname?: string; pronouns?: string; note?: string }) => Promise<void>
  // Foto de perfil (ADR-041 PR-3): opcionais aqui, required no AccountSettings — sob o mesmo guard
  // canAccount. App as liga; o harness bare as omite.
  onSaveAvatar?: (file: File) => Promise<void>
  onClearAvatar?: () => Promise<void>
  // ADR-096: the data export ("Seus dados"), under the same canAccount guard. App wires it.
  onExportData?: DataExportVerb
  onReset?: () => void
  onSignOut?: () => void
  // Aparência (app-side, não domínio): opcionais, espelham as props de conta. App as liga; o harness
  // de render-scan as omite (canAccount falso → AccountSettings não monta → tema não é necessário).
  theme?: Theme
  onThemeChange?: (theme: Theme) => void
  // The language row of "Your account" (app-side, like the theme). Optional for the same reason.
  language?: LanguageState
  // ADR-117, addendum of 26/Nov/2026 (F1): the "Notifications" row of "Your account" (app-side, like the language),
  // owned by useDeviceNotifications in App. Optional: the bare harness omits it and the row is not drawn.
  notifications?: DeviceNotificationsRow
  // ADR-073 dec. 6 (app-side, como o tema): o aviso de permissão de notificações na lista de
  // conversas. App o liga só enquanto deve aparecer; o harness o omite.
  notificationsPrompt?: { onEnable: () => void; onDismiss: () => void }
  // Local message search (ADR-074; manifest workspace.md §4.7/§8). App wires it from useSearch; the
  // bare harness omits it and the sidebar has no field.
  search?: SearchProps
  awaiting?: AwaitingProps
  // Search jump (§8 items 9–10): in flight → the timeline pill; the row reached → highlighted in the
  // timeline or in the open thread, whichever holds it.
  jump?: { target: MessageId; failed: boolean }
  // ADR-103 (Proposto): the agent's form open in this session (useAgentForm), drawn as a dialog.
  agentForm?: AgentFormSlice
  highlight?: { id: MessageId; seq: number }
  onHighlightEnd?: () => void
  // Avisos de segurança (ADR-018/019), trazidos pra coluna de conteúdo (PR-S1): o banner passivo de
  // novo-acesso + o banner acionável de reset agora vivem acima da timeline, não como irmãos no #root.
  // Opcionais — o harness de render-scan os omite, então nenhum renderiza lá.
  newAccesses?: NewAccess[]
  onDismissAccess?: (access: AccessId) => void
  attentionNeeded?: boolean
  // ADR-082: while the account surface is open, the state lives there; closed, in the banner.
  resetStatus?: ResetStatus
  onSelectChannel: (id: ChannelId) => void
  onSend: (body: ComposeResult, mentions: UserId[], command?: ComposerCommand) => void
  onSendAttachment?: (file: File) => void
  onRetry?: (message: Message) => void
  // ADR-091 dec. 14: answer an approval card with one of its options (useChat → acl.answerApproval).
  onAnswerApproval?: (message: Message, option: string) => void
  onReact?: (message: Message, emoji: string) => void
  onEdit?: (message: Message, body: ComposeResult) => void
  // Delete one's own message (ADR-075); MessageRow scopes it.
  onDelete?: (message: Message) => void
  onReply?: (message: Message) => void
  onCancelReply?: () => void
  onLoadOlder?: () => void
  onOpenThread?: (message: Message) => void
  onCloseThread?: () => void
  onSendThread?: (body: ComposeResult, mentions: UserId[], command?: ComposerCommand) => void
  onSendThreadAttachment?: (file: File) => void
  // The window is below the width breakpoint and the shell is a stack:
  // one screen at a time — the list, the conversation, the thread. App reads the width; the
  // harness mounts both.
  narrow?: boolean
  // The conversation screen's back where there is no history stack (the harness): back to the list.
  onBackToList?: () => void
}) {
  const [composing, setComposing] = useState(false)
  // Compose intent seeded by the per-section "+" (Track U/U3, F3): the ChannelList "+" sets which
  // mode the dialog opens in. Channel "+" → 'channel', DM "+" → 'dm'.
  const [composeMode, setComposeMode] = useState<'channel' | 'dm'>('channel')
  const [accountOpen, setAccountOpen] = useState(false)
  // The Admin (organization-admin.md §2.1; C2, C7): full screen in place of the workspace, wide window only, for
  // an admin only. It closes on going back, when the role drops (R6) and when the window narrows below 728px.
  const [adminOpen, setAdminOpen] = useState(false)
  const accountButton = useRef<HTMLButtonElement>(null)
  // Drill-in de perfil-de-outro (ADR-043): qual perfil está aberto (UserId opaco) ou null. Espelha
  // o padrão de estado local de `composing`/`accountOpen`. Gated por onLoadUserProfile (App liga; o
  // harness bare omite → a sub-tela nunca monta). Os entry points o setam no Commit 3.
  const [openProfile, setOpenProfile] = useState<UserId | null>(null)
  // The compose entry + dialog appear only when all three verbs are wired (App), never in the bare
  // render-scan harness mount.
  const canCompose = Boolean(onCreateChannel && onOpenDirectMessage && onOpenGroupConversation && loadKnownContacts)
  // ADR-053 dec. 5: o CTA de DM só existe quando há verbo E dá pra saber que o alvo NÃO é o operador.
  // currentUser é User | null | undefined (harness / boot / resolvido — ADR-039): sem id, não há
  // comparação, e mostrar o botão arriscaria DM consigo mesmo — sala criada, sem verbo de apagar.
  // O custo aceito é o botão aparecer um beat atrasado durante o boot.
  // ADR-090 (Proposto) dec. 3: and on an agent's profile, only when the session operates it.
  const canDm = Boolean(
    onOpenDirectMessage &&
      currentUser?.id &&
      openProfile &&
      openProfile !== currentUser.id &&
      (usersById[openProfile]?.kind !== 'agent' || isOwnAgent?.(openProfile) === true),
  )
  // Same gate for the identity footer + account modal: both verbs must be wired (App). The bare
  // render-scan harness omits them, so the footer never renders there.
  const canAccount = Boolean(
    onReset && onSignOut && onLoadProfile && onSaveProfile && onSaveAvatar && onClearAvatar && onExportData,
  )
  const current = channels.find((c) => c.id === selectedChannelId)
  // Footer identity: a clean display name + its monogram, both derived from the domain User (P1 —
  // never an id). null currentUser → a neutral placeholder until self-identity resolves.
  const accountName = currentUser?.displayName?.trim() || t('shell.account')
  const accountInitial = accountName.slice(0, 1).toUpperCase()
  // Presença de linha (ADR-056 rollout, §8.4 — caminho (b) do track): as assinaturas do useChat
  // atacham DEPOIS do connect (Boot aguarda acl.connect antes do App montar), então o mapa pode não
  // ter o backlog — o point read síncrono (onGetPresence) seeda o que o mapa ainda não viu. Sem
  // nenhum dos dois (harness bare) → undefined → Avatar sem a prop, DOM byte-idêntico.
  const presenceOf =
    presenceByUser || onGetPresence
      ? (u: UserId): Presence => presenceByUser?.[u] ?? onGetPresence?.(u) ?? 'offline'
      : undefined
  const selfPresence = currentUser ? presenceOf?.(currentUser.id) : undefined
  // Foto do operador (ADR-041 PR-2): resolve o avatar opaco → URL via useMedia (no-op enquanto
  // currentUser é null). O Avatar cai pro monograma sem foto. P1: o mr_* fica aqui+ACL, nunca no DOM.
  const accountAvatar = useMedia(currentUser?.avatar, 'thumbnail').url
  const replyAuthor = replyTarget ? resolveAuthor(replyTarget, usersById, t('shell.someone')) : undefined
  const replyingTo =
    replyTarget && replyAuthor
      ? { author: replyAuthor.name, authorAgent: replyAuthor.agentColor, excerpt: excerptOf(replyTarget.body) }
      : undefined
  // ADR-086 (workspace.md §15.2): a DM with an agent — the header carries the agent avatar and, when
  // known, "operado por <pessoa>" as its secondary line; never the green presence.
  const headerAgent = current?.kind === 'dm' ? current.peerAgent : undefined
  // ADR-094 (workspace.md §22.1 items 4 and 5): a group's header has the numbered block, and in the
  // topic's place the people (counting the reader) and, with agents among them, " · " and the agents. No
  // presence, no topic. With nobody else: "Só você", quiet, without the count.
  const headerGroup = current?.kind === 'group' ? current : undefined
  const groupAgents = headerGroup?.participantAgents ?? 0
  const groupAlone = headerGroup !== undefined && (headerGroup.participants?.length ?? 0) === 0
  const groupLine =
    headerGroup && !groupAlone
      ? [
          t('group.people', { n: groupCount(headerGroup.participants) - groupAgents }),
          ...(groupAgents > 0 ? [t('group.agents', { n: groupAgents })] : []),
        ].join(` ${GLYPH.dot} `)
      : undefined

  // ── The narrow stack. The screen in front follows the selection and the
  // open thread; the covered screens stay mounted (their scroll survives) but leave the tab order and
  // the accessibility tree.
  const threadOpen = Boolean(threadRoot && onCloseThread && onSendThread)
  const threadInFront = threadOpen && threadRoot?.channelId === selectedChannelId
  const searchOpen = narrow && search?.open === true
  const awaitingOpen = narrow && awaiting?.open === true && !searchOpen
  const screen: Screen | undefined = !narrow
    ? undefined
    : selectedChannelId === undefined
      ? searchOpen
        ? 'search'
        : awaitingOpen
          ? 'awaiting'
          : 'list'
      : threadInFront
        ? 'thread'
        : 'chat'
  // "Nova conversa" on a narrow window is a full screen over the others (new-conversation.md §11).
  const composeScreen = narrow && composing && canCompose
  // So is "Sua conta", with the screens above it (account-access.md §13.2; PLANO-MOBILE M7 H1).
  const accountScreen = narrow && accountOpen && canAccount
  // So are a group's details, someone's profile over them and the agent's form over both (PLANO-MOBILE M8),
  // and a channel's details (channel-management.md §13.2).
  const groupScreen = narrow && managing?.kind === 'group' && Boolean(onCloseManage && onLeaveChannel && onConvertToChannel)
  const channelScreen =
    narrow &&
    managing !== undefined &&
    managing.kind !== 'group' &&
    Boolean(onCloseManage && onUpdateChannel && onArchiveChannel && onLeaveChannel && onAddMember && onRemoveMember && onSetRole && loadCandidates)
  const profileScreen = narrow && openProfile !== null && Boolean(onLoadUserProfile)
  const formScreen = narrow && Boolean(agentForm?.form)
  const screenOver = composeScreen || accountScreen || groupScreen || channelScreen || profileScreen || formScreen
  const stackProps = (of: Screen) =>
    screen !== undefined && (screen !== of || screenOver) ? { 'data-stack-covered': '', inert: true } : {}
  const backToList = useStackBack(() => onBackToList?.())
  const backFromThread = useStackBack(() => onCloseThread?.())
  const backFromSearch = useStackBack(() => search?.onClear())
  const backFromAwaiting = useStackBack(() => awaiting?.onClose())
  const chatBackRef = useRef<HTMLButtonElement>(null)
  const threadBackRef = useRef<HTMLButtonElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const awaitingBackRef = useRef<HTMLButtonElement>(null)
  useStackFocus(screen, searchOpen || awaitingOpen, {
    search: searchInputRef,
    awaiting: awaitingBackRef,
    chat: chatBackRef,
    thread: threadBackRef,
  })
  // V4: the row and the subtitle count the ACL's list only.
  const awaitingCount = awaiting?.items?.length ?? 0
  const awaitingLine = awaiting?.items && awaitingCount > 0 ? awaitingSummary(awaiting.items, usersById) : undefined
  // On a narrow window each open dialog takes a history entry, and the system's back closes it. "Nova
  // conversa" is a full screen of its own there (PLANO-MOBILE M6) and keeps the same entry (ADR-106 dec. 11);
  // so is "Sua conta", which takes its own entries, one per screen and sheet (AccountSettings, M7 H1), as a
  // group's details do (GroupDetailsPanel, with the leave sheet). A child's entries are pushed before the ones
  // below, which are declared bottom first (M8): the profile over the details, the form over both.
  // N2: while its send is in flight (up to the cap) the screen refuses the system's back.
  const composeLocked = useRef(false)
  useStackDialog('compose', composeScreen, () => setComposing(false), () => composeLocked.current)
  useStackDialog('profile', profileScreen, () => setOpenProfile(null))
  useStackDialog('agent-form', formScreen, () => {
    if (agentForm?.form) agentForm.close(agentForm.form.id)
  })

  // The message's action sheet (§23.8): which message, from which screen, and where it was opened from. The
  // message is read fresh from what is on screen, so a message that goes away (or a wide window) closes it.
  const [sheet, setSheet] = useState<{ id: MessageId; where: 'chat' | 'thread'; origin: ActionsOrigin } | null>(null)
  const closeSheet = (): void => setSheet(null)
  const sheetPanel = useRef<HTMLDivElement | null>(null)
  const sheetMessage = !sheet
    ? undefined
    : (sheet.where === 'chat' ? messages : threadRoot ? [threadRoot, ...(threadMessages ?? [])] : []).find((m) => m.id === sheet.id)
  // In the thread: no reply nor thread (§29 item 1), and the root stays while it has replies on screen, the
  // ThreadPanel's gate (ADR-075 dec. 3).
  const rootWithReplies = sheetMessage !== undefined && sheetMessage.id === threadRoot?.id && (threadMessages?.length ?? 0) > 0
  const sheetWired =
    sheet?.where === 'chat'
      ? { onReact, onReply, onOpenThread, onEdit, onDelete }
      : { onReact, onEdit, onDelete: rootWithReplies ? undefined : onDelete }
  const sheetOpen = narrow && sheetMessage !== undefined
  useStackDialog('actions', sheetOpen, closeSheet)
  useEffect(() => {
    if (sheet && !sheetOpen) setSheet(null)
  }, [sheet, sheetOpen])
  useLayoutEffect(() => (sheetOpen && sheet ? holdRow(sheet.origin.row, sheetPanel.current) : undefined), [sheetOpen, sheet])
  // The image viewer (§25.2, §23.5 item 2): on a narrow window a screen of the stack, so the system's back
  // closes it (PLANO-MOBILE §0.14 V4); on a wide one an overlay with no history entry (F3 a).
  const [image, setImage] = useState<ImageView | null>(null)
  const closeImage = (): void => setImage(null)
  useStackDialog('image', narrow && image !== null, closeImage)
  const openActions = (where: 'chat' | 'thread') =>
    narrow ? (m: Message, origin: ActionsOrigin) => setSheet({ id: m.id, where, origin }) : undefined

  // Editing from the bottom composer (§23.7 item 2, §23.8 item 5; PLANO-MOBILE §0.15 E1 to E3): which message,
  // from which screen, in which conversation. The message is read fresh from what is on screen; it going away,
  // another conversation, the thread closing or a wide window cancels the edit (and the composer gives the
  // draft back). An entry of the stack: the system's back cancels it. Reply and edit never coexist.
  const [edit, setEdit] = useState<{ id: MessageId; where: 'chat' | 'thread'; channel?: ChannelId } | null>(null)
  const editMessage = !edit
    ? undefined
    : (edit.where === 'chat' ? messages : threadRoot ? [threadRoot, ...(threadMessages ?? [])] : []).find((m) => m.id === edit.id)
  const editBody = editMessage?.body.kind === 'text' ? editMessage.body : undefined
  const editOpen =
    narrow && edit !== null && editBody !== undefined && edit.channel === selectedChannelId && (edit.where === 'chat' || threadInFront)
  useEffect(() => {
    if (edit && !editOpen) setEdit(null)
  }, [edit, editOpen])
  useStackDialog('edit', editOpen, () => setEdit(null))
  const startEdit = (where: 'chat' | 'thread') => (m: Message): void => {
    if (where === 'chat' && replyTarget) onCancelReply?.()
    setEdit({ id: m.id, where, channel: selectedChannelId })
  }
  const replyFromSheet = (m: Message): void => {
    setEdit(null)
    onReply?.(m)
  }
  // The link sheet (§23.7 item 3): the composer hands its request up and the sheet mounts here, a direct child
  // of the `.workspace`. An entry of the stack, like the action sheet.
  const [link, setLink] = useState<{ request: LinkRequest; where: 'chat' | 'thread' } | null>(null)
  const linkOpen = narrow && link !== null && (link.where === 'chat' || threadInFront)
  useEffect(() => {
    if (link && !linkOpen) setLink(null)
  }, [link, linkOpen])
  useStackDialog('link', linkOpen, () => setLink(null))
  // The ↑/↓ history (§25.6), in any width: the conversation's in its composer, the thread's in the thread's.
  const chatHistory = useMemo(() => historyOf(messages), [messages])
  const threadHistory = useMemo(() => historyOf(threadMessages ?? []), [threadMessages])
  const composerMode = (where: 'chat' | 'thread'): ComposerModeProps => ({
    narrow,
    conversation: selectedChannelId,
    history: where === 'chat' ? chatHistory : threadHistory,
    ...(narrow && { onOpenLink: (request: LinkRequest) => setLink({ request, where }) }),
    ...(editOpen &&
      edit?.where === where &&
      editMessage &&
      editBody && {
        editTarget: { key: edit.id, html: textBodyHTML(editBody) },
        onSaveEdit: (body: ComposeResult) => {
          onEdit?.(editMessage, body)
          setEdit(null)
        },
        onCancelEdit: () => setEdit(null),
      }),
  })
  const chatComposer = composerMode('chat')
  const threadComposer = composerMode('thread')

  // Off `connected`, a thin strip under the list's, the conversation's and the thread's
  // header; on a narrow window it replaces the sidebar's connection line.
  const connectionStrip =
    narrow && connection !== 'connected' ? (
      <p className={`connection-strip connection-strip--${connection}`} role="status">
        {connectionLabel()[connection]}
      </p>
    ) : null
  // The account banners, in the conversation and, on a narrow window, in the list too.
  const banners = (
    <>
      {newAccesses && onDismissAccess && <NewAccessBanner accesses={newAccesses} onDismiss={onDismissAccess} />}
      {onReset && !accountOpen && (
        <ResetAccessBanner present={attentionNeeded ?? false} status={resetStatus} onReset={onReset} onSignOut={onSignOut} />
      )}
    </>
  )
  // The block before the header's heading: the group's numbered block or, in a DM with an agent,
  // the agent's avatar as a 30 block.
  const headerLeading = headerGroup ? (
    <GroupBlock count={groupCount(headerGroup.participants)} agent={groupAgents > 0} size="header" />
  ) : headerAgent ? (
    <span className="channel-header__agent">
      <AgentAvatar color={headerAgent.color} />
    </span>
  ) : null
  const headerSubtitle: ReactNode =
    headerAgent?.operatorName !== undefined ? (
      <span data-agent-operator="">{t('agent.operatedBy', { name: headerAgent.operatorName })}</span>
    ) : groupLine !== undefined ? (
      <span data-group-count="">{groupLine}</span>
    ) : current?.topic && !headerGroup ? (
      current.topic
    ) : undefined

  const canAdmin = Boolean(orgAdmin && onGetOrgAccess && onSetOrgAdmin && onInvitePerson && onRemovePerson)
  const adminShown = adminOpen && canAdmin && !narrow
  useEffect(() => {
    if (adminOpen && !adminShown) {
      setAdminOpen(false)
      accountButton.current?.focus()
    }
  }, [adminOpen, adminShown])
  const closeAdmin = () => {
    setAdminOpen(false)
    // Back from the Admin, the focus returns to the account button that led there.
    requestAnimationFrame(() => accountButton.current?.focus())
  }

  const shell = (
    <div className="workspace" data-stack={screen} hidden={adminShown || undefined}>
      <aside className="sidebar" {...stackProps('list')}>
        <div className="sidebar__brand">
          <span className="sidebar__brand-tile" aria-hidden="true">
            {APP_NAME[0]}
          </span>
          <div className="sidebar__brand-text">
            <h1 className="sidebar__brand-name">{APP_NAME}</h1>
            {!narrow && connection !== 'connected' && (
              <p className={`connection connection--${connection}`} role="status">
                {connectionLabel()[connection]}
              </p>
            )}
          </div>
          {/* On a narrow window "Nova conversa" sits on the top (the sections have no "+"). */}
          {narrow && canCompose && (
            <button
              type="button"
              className="sidebar__compose"
              aria-label={t('newConversation.title')}
              title={t('newConversation.title')}
              onClick={() => {
                setComposeMode('channel')
                setComposing(true)
              }}
            >
              <Plus size={20} />
            </button>
          )}
        </div>
        {narrow && connectionStrip}
        {narrow && banners}
        {search && narrow ? (
          // "buscar" on the narrow list (§23.2 item 3): a button that opens the full-screen search.
          <div className="search">
            <button type="button" className="search__field search__open" aria-label={t('search.field')} onClick={search.onOpen}>
              <span className="search__icon">
                <Search />
              </span>
              {t('search.placeholder')}
            </button>
          </div>
        ) : (
          search && (
            <SearchField
              query={search.query}
              onQuery={search.onQuery}
              scoped={search.scoped}
              onToggleScope={search.onToggleScope}
              onClear={search.onClear}
              onSubmit={search.active && search.hits[0] ? () => search.onPick(search.hits[0]!) : undefined}
            />
          )
        )}
        <ChannelList
          channels={channels}
          archived={archivedChannels}
          onRestore={onRestoreChannel}
          selectedId={selectedChannelId}
          onSelect={onSelectChannel}
          presenceOf={presenceOf}
          notificationsPrompt={notificationsPrompt}
          awaiting={
            narrow && awaiting && awaitingLine !== undefined ? (
              <AwaitingRow count={awaitingCount} summary={awaitingLine} onOpen={awaiting.onOpen} />
            ) : undefined
          }
          results={
            search?.active && !narrow ? (
              <SearchResults
                hits={search.hits}
                searched={search.searched}
                preparing={search.preparing}
                channels={channels}
                selected={search.selected}
                failed={search.failed}
                onPick={search.onPick}
                onClear={search.onClear}
              />
            ) : undefined
          }
          onCompose={
            canCompose
              ? (intent) => {
                  setComposeMode(intent)
                  setComposing(true)
                }
              : undefined
          }
        />
        {/* Partial coverage (§8 item 8): fixed under the list, outside its scroll, with the results. */}
        {search?.active && search.partial && !narrow && (
          <p className="sidebar__coverage">{t('search.partial')}</p>
        )}
        {canAccount && (
          <button
            ref={accountButton}
            type="button"
            className="sidebar__footer"
            aria-label={t('shell.account')}
            onClick={() => setAccountOpen(true)}
          >
            {/* Self MOSTRA o próprio dot (fork ratificado — workspace.md §2/§7 item 5). O anel lê
                --presence-ring sobrescrita no seletor .sidebar (§7 item 4). */}
            <Avatar label={accountInitial} src={accountAvatar} presence={selfPresence} />
            <span className="sidebar__footer-name">{accountName}</span>
            <span className="sidebar__footer-icon" aria-hidden="true">
              <Settings />
            </span>
          </button>
        )}
      </aside>
      {narrow && search && (
        // The full-screen search (§23.5 item 3): back and the field on top, the connection strip, the hint
        // without text, the results with a query, partial coverage in a footer outside the scroll. It stays
        // mounted under the conversation, so the query, the results and the scroll survive the way back.
        <section className="search-screen" aria-label={t('search.field')} {...stackProps('search')}>
          <ScreenHeader className="search-screen__header" onBack={backFromSearch}>
            <SearchField
              query={search.query}
              onQuery={search.onQuery}
              scoped={false}
              onClear={search.onClear}
              onSubmit={search.active && search.hits[0] ? () => search.onPick(search.hits[0]!) : undefined}
              narrow
              onShortcut={search.onOpen}
              inputRef={searchInputRef}
            />
          </ScreenHeader>
          {connectionStrip}
          <div className="search-screen__body">
            {search.query.length === 0 && <p className="search__hint search-screen__hint">{t('search.hint')}</p>}
            {search.active && (
              <SearchResults
                hits={search.hits}
                searched={search.searched}
                preparing={search.preparing}
                channels={channels}
                selected={search.selected}
                failed={search.failed}
                onPick={search.onPick}
              />
            )}
          </div>
          {search.active && search.partial && <p className="sidebar__coverage">{t('search.partial')}</p>}
        </section>
      )}
      {awaitingOpen && awaiting && (
        // "Aguardando você" (§23.4): mounted while it is on the stack, so its cards and scroll survive the
        // conversation opened from it.
        <AwaitingScreen
          shown={awaiting.shown}
          summary={awaitingLine}
          channels={archivedChannels ? [...channels, ...archivedChannels] : channels}
          usersById={usersById}
          selfId={currentUser?.id}
          onAnswer={onAnswerApproval}
          onPick={awaiting.onPick}
          onBack={backFromAwaiting}
          backRef={awaitingBackRef}
          strip={connectionStrip}
          covered={screen !== 'awaiting' || screenOver}
        />
      )}
      <main className="main" {...stackProps('chat')}>
        {narrow ? (
          // The screen header — back, the kind's heading, and the "⋯" of a group or a channel (workspace.md
          // §37 item 1); a direct message has none.
          <ScreenHeader
            className="channel-screen-header"
            onBack={backToList}
            backRef={chatBackRef}
            leading={headerLeading}
            title={current ? <ChannelLabel channel={current} hint={t('shell.privateHint')} lockSize={14} /> : ''}
            titleClassName={groupAlone ? 'channel-header__name--alone' : undefined}
            subtitle={headerSubtitle}
            action={
              current && current.kind !== 'dm' && onManageChannel ? (
                <button
                  type="button"
                  className="ui-screen-header__action"
                  onClick={() => onManageChannel(current)}
                  aria-label={manageLabel(current)}
                  title={manageLabel(current)}
                >
                  <More size={20} />
                </button>
              ) : undefined
            }
          />
        ) : (
        <header className="channel-header">
          {headerLeading}
          <div className="channel-header__heading">
            <h2 className={groupAlone ? 'channel-header__name channel-header__name--alone' : 'channel-header__name'}>
              {current ? <ChannelLabel channel={current} hint={t('shell.privateHint')} lockSize={14} /> : t('shell.selectChannel')}
            </h2>
            {headerAgent?.operatorName !== undefined && (
              <p className="channel-header__topic" data-agent-operator="">
                {t('agent.operatedBy', { name: headerAgent.operatorName })}
              </p>
            )}
            {groupLine !== undefined && (
              <p className="channel-header__topic" data-group-count="">
                {groupLine}
              </p>
            )}
            {current?.topic && !headerGroup && <p className="channel-header__topic">{current.topic}</p>}
          </div>
          {/* Manage entry point (Track U/U1). Gated to a real channel that is NOT a DM — DMs have no
              management surface (ADR-029 scope). A group's opens its details panel, titled
              "Detalhes da conversa" (workspace.md §22.1 item 4; manageLabel). */}
          {current && current.kind !== 'dm' && onManageChannel && (
            <button
              type="button"
              className="channel-header__manage"
              onClick={() => onManageChannel(current)}
              aria-label={manageLabel(current)}
              title={manageLabel(current)}
            >
              <More />
            </button>
          )}
        </header>
        )}
        {connectionStrip}
        {banners}
        {current && panels && panels.length > 0 && (
          <PinnedPanelSlot
            // One per conversation: its remembered state is read when it mounts. Prefixed: the Timeline,
            // a sibling, is keyed by the bare conversation id.
            key={`panel-${current.id}`}
            account={currentUser?.id}
            channel={current.id}
            panels={panels}
            usersById={usersById}
          />
        )}
        <Timeline
          // One Timeline per conversation: each opens anchored at its latest message (§8.27 B).
          key={selectedChannelId}
          messages={messages}
          usersById={usersById}
          onRetry={onRetry}
          onAnswer={onAnswerApproval}
          onReact={onReact}
          onOpenThread={onOpenThread}
          onEdit={onEdit}
          onDelete={onDelete}
          onReply={onReply}
          onOpenProfile={onLoadUserProfile ? (u) => setOpenProfile(u) : undefined}
          presenceOf={presenceOf}
          threadUnreadOf={threadUnreadByRoot ? (root) => threadUnreadByRoot[root.id]?.unread === true : undefined}
          onLoadOlder={onLoadOlder}
          jumping={jump !== undefined && !jump.failed}
          highlight={highlight}
          onHighlightEnd={onHighlightEnd}
          selfId={currentUser?.id}
          onOpenActions={openActions('chat')}
          held={sheet?.where === 'chat' ? sheet.id : undefined}
          editingBelow={editOpen && edit?.where === 'chat' ? edit.id : undefined}
        />
        {current && (
          <Composer
            onSend={onSend}
            onSendAttachment={onSendAttachment}
            users={Object.values(usersById)}
            commands={commands}
            replyingTo={replyingTo}
            onCancelReply={onCancelReply}
            disabled={connection === 'offline'}
            // A conversation with an empty name (a group or DM with nobody else) takes the generic
            // placeholder, never "Mensagem para Só você" (PLANO-CONVERSAS §0.3.5 item 4).
            placeholder={current.name ? t('composer.placeholderFor', { name: bareName(current) }) : t('composer.placeholder')}
            {...chatComposer}
          />
        )}
      </main>
      {threadRoot && onCloseThread && onSendThread && (
        <ThreadPanel
          covered={screen !== undefined && (screen !== 'thread' || screenOver)}
          header={
            narrow ? (
              // "Thread" over the channel's name, back in place of the close.
              <ScreenHeader
                className="thread-screen-header"
                onBack={backFromThread}
                backRef={threadBackRef}
                title={t('thread.title')}
                subtitle={current ? <ChannelLabel channel={current} hint={t('shell.privateHint')} /> : undefined}
                action={
                  threadUnread?.unread ? (
                    <span className="unread-dot" role="img" aria-label={t('thread.unreadReplies')} />
                  ) : undefined
                }
              />
            ) : undefined
          }
          strip={connectionStrip}
          root={threadRoot}
          channel={current}
          messages={threadMessages ?? []}
          usersById={usersById}
          unread={threadUnread}
          onClose={onCloseThread}
          onSend={onSendThread}
          onSendAttachment={onSendThreadAttachment}
          commands={commands}
          onRetry={onRetry}
          onAnswer={onAnswerApproval}
          onReact={onReact}
          onEdit={onEdit}
          onDelete={onDelete}
          onOpenProfile={onLoadUserProfile ? (u) => setOpenProfile(u) : undefined}
          disabled={connection === 'offline'}
          highlight={highlight}
          onHighlightEnd={onHighlightEnd}
          selfId={currentUser?.id}
          onOpenActions={openActions('thread')}
          held={sheet?.where === 'thread' ? sheet.id : undefined}
          editingBelow={editOpen && edit?.where === 'thread' ? edit.id : undefined}
          composer={threadComposer}
        />
      )}
      {managing?.kind === 'group' && onCloseManage && onLeaveChannel && onConvertToChannel && (
        // ADR-094 dec. 9 and 13: the group's own panel — participants, convert, leave
        // (channel-management.md §10). Keyed on the id, like the channel's.
        <GroupDetailsPanel
          key={managing.id}
          channel={managing}
          members={members ?? []}
          onConvertToChannel={onConvertToChannel}
          onLeaveChannel={onLeaveChannel}
          onOpenProfile={onLoadUserProfile ? (u) => setOpenProfile(u) : undefined}
          presenceOf={presenceOf}
          onClose={onCloseManage}
          narrow={narrow}
          covered={profileScreen || formScreen}
        />
      )}
      {managing &&
        managing.kind !== 'group' &&
        onCloseManage &&
        onUpdateChannel &&
        onArchiveChannel &&
        onLeaveChannel &&
        onAddMember &&
        onRemoveMember &&
        onSetRole &&
        loadCandidates && (
        // Keyed on the channel id so switching the managed channel remounts with a fresh form.
        <ChannelManagementPanel
          key={managing.id}
          channel={managing}
          members={members ?? []}
          abilities={channelAbilities}
          onUpdateChannel={onUpdateChannel}
          onArchiveChannel={onArchiveChannel}
          onLeaveChannel={onLeaveChannel}
          onAddMember={onAddMember}
          onRemoveMember={onRemoveMember}
          onSetRole={onSetRole}
          loadCandidates={loadCandidates}
          onOpenProfile={onLoadUserProfile ? (u) => setOpenProfile(u) : undefined}
          presenceOf={presenceOf}
          onClose={onCloseManage}
          narrow={narrow}
          covered={profileScreen || formScreen}
        />
      )}
      {composing && canCompose && (
        <NewConversationDialog
          onCreateChannel={onCreateChannel!}
          onOpenDirectMessage={onOpenDirectMessage!}
          onOpenGroupConversation={onOpenGroupConversation!}
          loadKnownContacts={loadKnownContacts!}
          initialMode={composeMode}
          presenceOf={presenceOf}
          onClose={() => setComposing(false)}
          narrow={narrow}
          onLockChange={(on) => {
            composeLocked.current = on
          }}
        />
      )}
      {canAccount && (
        <AccountSettings
          open={accountOpen}
          accesses={accesses ?? []}
          orgAdmin={orgAdmin}
          people={people}
          onOpenAdmin={canAdmin ? () => setAdminOpen(true) : undefined}
          displayName={currentUser?.displayName}
          avatarUrl={accountAvatar}
          presence={selfPresence}
          onLoadProfile={onLoadProfile!}
          onSaveProfile={onSaveProfile!}
          onSaveAvatar={onSaveAvatar!}
          onClearAvatar={onClearAvatar!}
          onExportData={onExportData!}
          onReset={onReset!}
          resetStatus={resetStatus}
          onSignOut={onSignOut!}
          theme={theme!}
          onThemeChange={onThemeChange!}
          language={language!}
          notifications={notifications}
          narrow={narrow}
          onClose={() => setAccountOpen(false)}
        />
      )}
      {openProfile && onLoadUserProfile && (
        // Sub-tela de perfil-de-outro (ADR-043). Keyed no UserId pra remontar (load fresco) ao trocar
        // de alvo. Read-only quanto ao PERFIL — nenhum verbo de escrita; o DM é navegação (ADR-053).
        // O verbo vai gated por canDm — nunca por non-null assertion: o guard deste bloco (openProfile
        // && onLoadUserProfile) não inclui o verbo, então a não-nulidade NÃO está garantida aqui.
        // Prop ausente → o Dialog não põe CTA.
        <UserProfileDialog
          key={openProfile}
          userId={openProfile}
          onLoadUserProfile={onLoadUserProfile}
          onLoadCommonChannels={onLoadCommonChannels}
          onSelectChannel={onSelectChannel}
          onGetPresence={onGetPresence}
          onSubscribePresence={onSubscribePresence}
          onOpenDirectMessage={canDm ? onOpenDirectMessage : undefined}
          onClose={() => setOpenProfile(null)}
          onNavigated={groupScreen || channelScreen ? onCloseManage : undefined}
          narrow={narrow}
          covered={formScreen}
        />
      )}
      {agentForm?.form && (
        // Keyed on the form: a new form starts with its own values and no errors.
        <AgentFormDialog
          key={agentForm.form.id}
          form={agentForm.form}
          agent={agentForm.agent}
          onSubmit={agentForm.submit}
          onClose={agentForm.close}
          narrow={narrow}
        />
      )}
      {sheet && sheetOpen && sheetMessage && (
        // Keyed on the message: another message's sheet starts on its menu, not on a pending question.
        <MessageActionsSheet
          key={sheet.id}
          message={sheetMessage}
          actions={actionsOf(sheetMessage, sheetWired)}
          onReact={onReact}
          onReply={replyFromSheet}
          onOpenThread={onOpenThread}
          onEditMessage={startEdit(sheet.where)}
          onDelete={onDelete}
          onClose={closeSheet}
          returnFocus={sheet.origin.returnFocus}
          panelRef={sheetPanel}
        />
      )}
      {image && <ImageViewer image={image} narrow={narrow} onClose={closeImage} />}
      {linkOpen && link && <LinkSheet request={link.request} onClose={() => setLink(null)} />}
    </div>
  )
  // Thumbnails in the timeline and in the thread open the viewer through this (§25.2; §23.12, thread).
  return (
    <OpenImageContext.Provider value={setImage}>
      {adminShown && (
        <OrgAdmin
          people={people ?? []}
          inviteChannels={channels}
          displayName={currentUser?.displayName}
          onBack={closeAdmin}
          onGetOrgAccess={onGetOrgAccess!}
          onSetOrgAdmin={onSetOrgAdmin!}
          onInvitePerson={onInvitePerson!}
          onRemovePerson={onRemovePerson!}
          onCreateAgent={onCreateAgent}
          onUpdateAgent={onUpdateAgent}
          onReissueAgent={onReissueAgent}
          onRemoveAgent={onRemoveAgent}
        />
      )}
      {shell}
    </OpenImageContext.Provider>
  )
}

// The held row (§23.8 item 7, PLANO-MOBILE R3): its scroller moves it to sit just above the sheet (a row taller
// than the room shows its top). A conversation too short to scroll that far, or a row near the end, gets the
// missing room as bottom padding on the scroller while the row is held — a measured length, not a scale value —
// and the inline style the scroller had comes back on release, so nothing is left behind.
const SCROLLERS = '.timeline, .thread-panel__root, .thread-panel__replies'
function holdRow(row: HTMLElement, panel: HTMLElement | null): (() => void) | undefined {
  const scroller = row.closest<HTMLElement>(SCROLLERS)
  if (!scroller || !panel) return undefined
  const inline = scroller.style.paddingBottom
  const box = row.getBoundingClientRect()
  const view = scroller.getBoundingClientRect()
  const floor = Math.min(panel.getBoundingClientRect().top, view.bottom)
  const target = scroller.scrollTop + (box.height > floor - view.top ? box.top - view.top : box.bottom - floor)
  const room = target - (scroller.scrollHeight - scroller.clientHeight)
  if (room > 0) scroller.style.paddingBottom = `calc(${getComputedStyle(scroller).paddingBottom} + ${room}px)`
  scroller.scrollTop = target
  return () => {
    scroller.style.paddingBottom = inline
  }
}

// The pinned panel with its local preference (panel-pref.ts), mounted once the conversation's preference
// first resolves so the first render already shows the remembered state; from then on it stays mounted (a
// new agent's token resolves in the background — the open list and the accordion survive it).
function PinnedPanelSlot({
  account,
  channel,
  panels,
  usersById,
}: {
  account: UserId | undefined
  channel: ChannelId
  panels: AgentPanel[]
  usersById: Record<string, User>
}) {
  const pref = usePanelPref(account, channel, panels.map((p) => p.agent))
  // Collapsed by default on a coarse pointer or in a narrow window; read once, on mount.
  const [narrow] = useState(isCoarseOrNarrow)
  if (account !== undefined && !pref.ready) return null
  return (
    <PinnedPanel
      panels={panels}
      usersById={usersById}
      initialOpen={pref.initial.open}
      initialPicked={pref.initial.picked}
      collapsedByDefault={narrow}
      onPrefChange={pref.save}
    />
  )
}

type Screen = 'list' | 'search' | 'awaiting' | 'chat' | 'thread'

// The stack's focus: a screen pushed takes the focus on its back (the search, on its field); a screen
// popped gives it back to the control that opened it. A width change moves nothing. `under` is a screen
// between the list and the conversation (the search or "Aguardando você").
function useStackFocus(
  screen: Screen | undefined,
  under: boolean,
  targets: Record<Exclude<Screen, 'list'>, { current: HTMLElement | null }>,
): void {
  const base = under ? 1 : 0
  const depth = screen === 'thread' ? base + 2 : screen === 'chat' ? base + 1 : screen === 'search' || screen === 'awaiting' ? 1 : 0
  const lastFocus = useRef<HTMLElement | null>(null)
  const openers = useRef<(HTMLElement | null)[]>([])
  const prev = useRef({ depth, screen, narrow: screen !== undefined })
  useEffect(() => {
    const onFocus = (e: FocusEvent): void => {
      lastFocus.current = e.target instanceof HTMLElement ? e.target : null
    }
    document.addEventListener('focusin', onFocus)
    return () => document.removeEventListener('focusin', onFocus)
  }, [])
  useLayoutEffect(() => {
    const narrow = screen !== undefined
    const was = prev.current
    prev.current = { depth, screen, narrow }
    // ⌘K from a conversation trades it for the search at the same depth: that is a push too.
    const pushed = depth > was.depth || (depth === was.depth && screen === 'search' && was.screen !== 'search')
    if (!narrow || !was.narrow || (!pushed && depth === was.depth)) return
    if (pushed) {
      openers.current[was.depth + 1] = lastFocus.current
      for (let d = was.depth + 2; d <= depth; d++) openers.current[d] = null
      if (screen && screen !== 'list') targets[screen].current?.focus()
    } else {
      const opener = openers.current[depth + 1]
      if (opener?.isConnected) opener.focus()
    }
  }, [screen, depth, targets])
}
