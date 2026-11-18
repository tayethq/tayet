import { useState } from 'react'
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
  Person,
  PersonInvite,
  Presence,
  RosterEntry,
  ThreadUnread,
  User,
  UserId,
  UserProfile,
} from '@tayet/client'
import type { ComposeResult } from '../compose'
import type { ComposerCommand } from '../composer/RichComposer'
import { ChannelList } from './ChannelList'
import { SearchField } from './SearchField'
import { SearchResults } from './SearchResults'
import type { ResolvedHit } from '../useSearch'
import { ChannelLabel, bareName, manageLabel } from './ChannelLabel'
import { AgentAvatar } from './AgentAvatar'
import { GroupBlock, groupCount } from './GroupBlock'
import { resolveAuthor } from '../author'
import { Timeline, excerptOf } from './Timeline'
import { Composer } from './Composer'
import { ThreadPanel } from './ThreadPanel'
import { ChannelManagementPanel } from './ChannelManagementPanel'
import { GroupDetailsPanel } from './GroupDetailsPanel'
import { NewConversationDialog } from './NewConversationDialog'
import { AccountSettings, type KnownAccess } from './AccountSettings'
import type { DataExportVerb } from '../useDataExport'
import { UserProfileDialog } from './UserProfileDialog'
import { AgentFormDialog } from './AgentFormDialog'
import type { AgentFormSlice } from '../useAgentForm'
import { NewAccessBanner, type NewAccess } from './NewAccessBanner'
import { ResetAccessBanner, type ResetStatus } from './ResetAccessBanner'
import { PinnedPanel } from './PinnedPanel'
import { usePanelPref } from '../panel-pref'
import { Avatar } from '../primitives'
import { Settings, More } from '../icons'
import { useMedia } from '../MediaContext'
import type { Theme } from '../theme'
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
  notificationsPrompt,
  search,
  jump,
  agentForm,
  highlight,
  onHighlightEnd,
  newAccesses,
  onDismissAccess,
  attentionNeeded,
  resetStatus,
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
  onCreateChannel?: (input: NewChannel) => Promise<void>
  onOpenDirectMessage?: (user: UserId) => Promise<void>
  onOpenGroupConversation?: (users: UserId[]) => Promise<void>
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
  // ADR-073 dec. 6 (app-side, como o tema): o aviso de permissão de notificações na lista de
  // conversas. App o liga só enquanto deve aparecer; o harness o omite.
  notificationsPrompt?: { onEnable: () => void; onDismiss: () => void }
  // Local message search (ADR-074; manifest workspace.md §4.7/§8). App wires it from useSearch; the
  // bare harness omits it and the sidebar has no field.
  search?: SearchProps
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
}) {
  const [composing, setComposing] = useState(false)
  // Compose intent seeded by the per-section "+" (Track U/U3, F3): the ChannelList "+" sets which
  // mode the dialog opens in. Channel "+" → 'channel', DM "+" → 'dm'.
  const [composeMode, setComposeMode] = useState<'channel' | 'dm'>('channel')
  const [accountOpen, setAccountOpen] = useState(false)
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

  return (
    <div className="workspace">
      <aside className="sidebar">
        <div className="sidebar__brand">
          <span className="sidebar__brand-tile" aria-hidden="true">
            {APP_NAME[0]}
          </span>
          <div className="sidebar__brand-text">
            <h1 className="sidebar__brand-name">{APP_NAME}</h1>
            {connection !== 'connected' && (
              <p className={`connection connection--${connection}`} role="status">
                {connectionLabel()[connection]}
              </p>
            )}
          </div>
        </div>
        {search && (
          <SearchField
            query={search.query}
            onQuery={search.onQuery}
            scoped={search.scoped}
            onToggleScope={search.onToggleScope}
            onClear={search.onClear}
            onSubmit={search.active && search.hits[0] ? () => search.onPick(search.hits[0]!) : undefined}
          />
        )}
        <ChannelList
          channels={channels}
          archived={archivedChannels}
          onRestore={onRestoreChannel}
          selectedId={selectedChannelId}
          onSelect={onSelectChannel}
          presenceOf={presenceOf}
          notificationsPrompt={notificationsPrompt}
          results={
            search?.active ? (
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
        {search?.active && search.partial && (
          <p className="sidebar__coverage">{t('search.partial')}</p>
        )}
        {canAccount && (
          <button
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
      <main className="main">
        <header className="channel-header">
          {headerGroup && (
            <GroupBlock count={groupCount(headerGroup.participants)} agent={groupAgents > 0} size="header" />
          )}
          <div className="channel-header__heading">
            <h2 className={groupAlone ? 'channel-header__name channel-header__name--alone' : 'channel-header__name'}>
              {headerAgent && <AgentAvatar color={headerAgent.color} size="gestao" />}
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
        {newAccesses && onDismissAccess && (
          <NewAccessBanner accesses={newAccesses} onDismiss={onDismissAccess} />
        )}
        {onReset && !accountOpen && (
          <ResetAccessBanner
            present={attentionNeeded ?? false}
            status={resetStatus}
            onReset={onReset}
            onSignOut={onSignOut}
          />
        )}
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
          />
        )}
      </main>
      {threadRoot && onCloseThread && onSendThread && (
        <ThreadPanel
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
        />
      )}
      {canAccount && (
        <AccountSettings
          open={accountOpen}
          accesses={accesses ?? []}
          orgAdmin={orgAdmin}
          people={people}
          inviteChannels={channels}
          onInvitePerson={onInvitePerson}
          onRemovePerson={onRemovePerson}
          onCreateAgent={onCreateAgent}
          onUpdateAgent={onUpdateAgent}
          onReissueAgent={onReissueAgent}
          onRemoveAgent={onRemoveAgent}
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
        />
      )}
    </div>
  )
}

// The shell's narrow signal for the panel's default (manifest §17.2 item 6, "no celular, recolhido").
// styles.css has no width breakpoint; its only device query is the coarse pointer of the touch floor
// (PLANO §0.2), reused here rather than inventing a width.
const isNarrow = (): boolean => typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches === true

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
  const [narrow] = useState(isNarrow)
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
