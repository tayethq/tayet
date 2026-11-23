import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { Channel, ChannelId, Presence, UserId } from '@tayet/client'
import { Chevron, Close, Plus } from '../icons'
import { loadArchivedCollapsed, saveArchivedCollapsed } from '../archived-pref'
import { Avatar, Button } from '../primitives'
import { useMedia } from '../MediaContext'
import { ChannelLabel } from './ChannelLabel'
import { AgentAvatar } from './AgentAvatar'
import { GroupBlock, groupCount } from './GroupBlock'
import { t } from '../i18n'

// Channel list. Renders the clean #name (channels) or peer displayName (DMs) + unread mark. NEVER
// renders channel.id (the opaque, protocol-shaped ADR-008 residual) — it lives only in the React key
// and click payload.
//
// Sectioned by kind (Track U/U3, F3): non-dm channels under "Canais", dm under "Mensagens diretas".
// Both sections are ALWAYS present (an empty one shows a quiet empty-state, not omission) so the
// per-section "+" is a stable, always-reachable compose entry. The exception is the third section,
// "Arquivados" (ADR-076 dec. 7, manifest workspace.md §9): present only with ≥1 archived channel,
// no "+", collapsible. The "+" seeds the compose intent
// (channel vs dm). The names are already clean from the translate layer (a channel is '#'+name, a DM
// is the peer's displayName).
//
// PR-β (manifest workspace.md §2/§7): a DM row carries the peer's avatar (photo when set, monogram
// as the fallback — ADR-036 dec. 5) with the presence dot; a CHANNEL row keeps the '#' idiom, no
// avatar (ratified). A PRIVATE channel row swaps the '#' for the lock (ChannelLabel, §8.35). The
// unread mark is a DISTINCT pattern from the presence dot (§3) — untouched.
//
// ADR-094 dec. 1 (manifest workspace.md §22.1 items 1 to 3, 5): a group conversation lives with the DMs,
// in the section's order, on the DM row's geometry with the numbered block in place of the avatar.
const sections = (): Array<{
  key: string
  label: string
  addLabel: string
  intent: 'channel' | 'dm'
  inGroup: (c: Channel) => boolean
}> => [
  { key: 'channels', label: t('list.channels'), addLabel: t('list.newChannel'), intent: 'channel', inGroup: (c) => c.kind !== 'dm' && c.kind !== 'group' },
  {
    key: 'dms',
    label: t('list.dms'),
    addLabel: t('list.newDm'),
    intent: 'dm',
    inGroup: (c) => c.kind === 'dm' || c.kind === 'group',
  },
]

export function ChannelList({
  channels,
  selectedId,
  onSelect,
  onCompose,
  presenceOf,
  notificationsPrompt,
  results,
  awaiting,
  archived,
  onRestore,
}: {
  channels: Channel[]
  selectedId?: ChannelId
  onSelect: (id: ChannelId) => void
  onCompose?: (intent: 'channel' | 'dm') => void
  // Presença de linha (ADR-056 rollout, §8.4): o leitor do mapa único do useChat, threadado pelo
  // Workspace. Opcional — ausente (harness bare), o Avatar da DM fica sem a prop (DOM sem wrapper).
  presenceOf?: (u: UserId) => Presence
  // ADR-073 dec. 6: the notifications prompt, threaded by the Workspace from App. Absent (harness bare,
  // permission already decided, or dismissed) → no notice.
  notificationsPrompt?: { onEnable: () => void; onDismiss: () => void }
  // Search results (manifest workspace.md §8 item 4): while there is a query they replace the sections,
  // in the same scroll; the notice above stays.
  results?: ReactNode
  // "Aguardando você" on the narrow list (workspace.md §23.2 items 2 and 5): under the notice, above the sections.
  awaiting?: ReactNode
  // ADR-076: archived channels (§9 — a third section after the DMs, replaced by results like the
  // others) and the Restore verb. Absent/empty → no section.
  archived?: Channel[]
  onRestore?: (id: ChannelId) => Promise<void>
}) {
  return (
    <nav className="channel-list" aria-label={t('list.nav')}>
      {notificationsPrompt && (
        // workspace.md §14 item 3 / §6.7 (forks 4, 6, 7 do §8.18): coluna (texto + botão) com o ✕ ao lado.
        <div className="channel-list__notice" role="status">
          <div className="channel-list__notice-body">
            <p className="channel-list__notice-text">{t('list.notifyPrompt')}</p>
            <Button size="gestao" onClick={notificationsPrompt.onEnable}>
              {t('list.enableNotifications')}
            </Button>
          </div>
          <button
            type="button"
            className="channel-list__notice-dismiss"
            aria-label={t('list.dismiss')}
            title={t('list.dismiss')}
            onClick={notificationsPrompt.onDismiss}
          >
            <Close />
          </button>
        </div>
      )}
      {awaiting}
      {results ?? (
        <>
          {sections().map(({ key, label, addLabel, intent, inGroup }) => {
            const items = channels.filter(inGroup)
            return (
              <section key={key} className="channel-list__section" aria-label={label}>
                <div className="channel-list__section-header">
                  <h2 className="channel-list__section-title">{label}</h2>
                  {onCompose && (
                    <button
                      type="button"
                      className="channel-list__section-add"
                      aria-label={addLabel}
                      onClick={() => onCompose(intent)}
                    >
                      <Plus />
                    </button>
                  )}
                </div>
                {items.length === 0 ? (
                  <p className="channel-list__empty">{t('list.empty')}</p>
                ) : (
                  <ul>
                    {items.map((c) =>
                      c.kind === 'group' ? (
                        <GroupRow key={c.id} channel={c} selected={c.id === selectedId} onSelect={onSelect} />
                      ) : intent === 'dm' ? (
                        <DmRow
                          key={c.id}
                          channel={c}
                          selected={c.id === selectedId}
                          onSelect={onSelect}
                          presenceOf={presenceOf}
                        />
                      ) : (
                        <li key={c.id}>
                          <button
                            type="button"
                            className={c.id === selectedId ? 'channel channel--selected' : 'channel'}
                            aria-current={c.id === selectedId ? 'true' : undefined}
                            onClick={() => onSelect(c.id)}
                          >
                            <span className="channel__name">
                              <ChannelLabel channel={c} lockSize={13} />
                            </span>
                            <UnreadBadge channel={c} />
                          </button>
                        </li>
                      ),
                    )}
                  </ul>
                )}
              </section>
            )
          })}
          {archived && archived.length > 0 && <ArchivedSection channels={archived} onRestore={onRestore} />}
        </>
      )}
    </nav>
  )
}

// ADR-076 / manifest workspace.md §9: the Archived section. The label is a toggle (collapsed by
// default, remembered per origin); rows are NOT buttons (no selection, no badge, no avatar/dot) and
// carry one action, Restore: "Restaurando…" while the verb pends, back to "Restaurar" with an inline
// notice on rejection. Completion is the stream's: channel.added moves the channel out of `channels`
// (the row and its state leave with it; the last one takes the section). P1: the button names the
// channel by its clean name, never the id.
type RestoreState = 'busy' | 'failed'

function ArchivedSection({
  channels,
  onRestore,
}: {
  channels: Channel[]
  onRestore?: (id: ChannelId) => Promise<void>
}) {
  const [open, setOpen] = useState(() => !loadArchivedCollapsed())
  const [restore, setRestore] = useState<Record<string, RestoreState>>({})

  // A row that left the list takes its state with it (a later re-archive starts at rest).
  useEffect(() => {
    setRestore((prev) => {
      const keep = Object.fromEntries(
        Object.entries(prev).filter(([id]) => channels.some((c) => (c.id as unknown as string) === id)),
      )
      return Object.keys(keep).length === Object.keys(prev).length ? prev : keep
    })
  }, [channels])

  const toggle = () => {
    const next = !open
    setOpen(next)
    saveArchivedCollapsed(!next)
  }

  const run = (id: ChannelId) => {
    if (!onRestore) return
    const key = id as unknown as string
    setRestore((prev) => ({ ...prev, [key]: 'busy' }))
    onRestore(id).catch(() => setRestore((prev) => ({ ...prev, [key]: 'failed' })))
  }

  return (
    <section className="channel-list__section channel-list__section--archived" aria-label={t('list.archived')}>
      <button type="button" className="channel-list__archived-toggle" aria-expanded={open} onClick={toggle}>
        <h2 className="channel-list__section-title">{t('list.archivedCount', { n: channels.length })}</h2>
        <span className="channel-list__archived-chevron">
          <Chevron />
        </span>
      </button>
      {open && (
        <ul>
          {channels.map((c) => {
            const state = restore[c.id as unknown as string]
            return (
              <li key={c.id} className="channel-list__archived-row">
                <span className="channel-list__archived-body">
                  <span className="channel__name channel__name--archived">
                    <ChannelLabel channel={c} />
                  </span>
                  {state === 'failed' && (
                    <span className="channel-list__restore-error" role="status">
                      {t('list.restoreFailed')}
                    </span>
                  )}
                </span>
                {onRestore && (
                  <Button
                    variant="ghost"
                    size="gestao"
                    className="channel-list__restore"
                    aria-label={t('list.restoreNamed', { name: c.name })}
                    disabled={state === 'busy'}
                    onClick={() => run(c.id)}
                  >
                    {state === 'busy' ? t('list.restoring') : t('list.restore')}
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

// One DM row (per-row hook — the MemberRow precedent): resolves the peer's opaque photo via
// useMedia; the Avatar primitive owns the photo>monogram fallback and the presence wrapper/dot.
// Edge (DM without peer, e.g. a malformed m.direct): no dot, monogram from the name — the row
// never breaks. P1: peer feeds ONLY the presenceOf lookup, never an attribute or text.
function DmRow({
  channel,
  selected,
  onSelect,
  presenceOf,
}: {
  channel: Channel
  selected: boolean
  onSelect: (id: ChannelId) => void
  presenceOf?: (u: UserId) => Presence
}) {
  const avatar = useMedia(channel.peerAvatar, 'thumbnail').url
  return (
    <li>
      <button
        type="button"
        className={selected ? 'channel channel--dm channel--selected' : 'channel channel--dm'}
        aria-current={selected ? 'true' : undefined}
        onClick={() => onSelect(channel.id)}
      >
        {channel.peerAgent ? (
          // ADR-086: an agent's DM row carries the agent avatar — no photo, never presence.
          <AgentAvatar color={channel.peerAgent.color} />
        ) : (
          <Avatar
            label={channel.name[0] ?? '?'}
            src={avatar}
            size="cotidiano"
            presence={channel.peer ? presenceOf?.(channel.peer) : undefined}
          />
        )}
        <span className="channel__name">
          <ChannelLabel channel={channel} />
        </span>
        <UnreadBadge channel={channel} />
      </button>
    </li>
  )
}

// One group conversation row (ADR-094; workspace.md §22.1 items 2, 3 and 5): the DM row's geometry, the
// numbered block in place of the avatar (with the agent's dot when an agent takes part), no presence,
// the name on one line with the ellipsis. With nobody else, "Só você", quiet. P1: participants feed
// only the count, never an attribute or text.
function GroupRow({
  channel,
  selected,
  onSelect,
}: {
  channel: Channel
  selected: boolean
  onSelect: (id: ChannelId) => void
}) {
  const alone = (channel.participants?.length ?? 0) === 0
  return (
    <li>
      <button
        type="button"
        className={selected ? 'channel channel--group channel--selected' : 'channel channel--group'}
        aria-current={selected ? 'true' : undefined}
        onClick={() => onSelect(channel.id)}
      >
        <GroupBlock count={groupCount(channel.participants)} agent={(channel.participantAgents ?? 0) > 0} size="list" />
        <span className={alone ? 'channel__name channel__name--alone' : 'channel__name'}>
          <ChannelLabel channel={channel} />
        </span>
        <UnreadBadge channel={channel} />
      </button>
    </li>
  )
}

// workspace.md §13 item 5: the dot and the pill are exclusive; the pill's number is the mentions.
function UnreadBadge({ channel }: { channel: Channel }) {
  const { count, mentions } = channel.unread
  if (count === 0) return null
  if (mentions === 0) {
    return <span className="channel__unread-dot" aria-label={t('list.unread', { n: count })} />
  }
  return (
    <span className="badge badge--mention" aria-label={t('list.mentions', { n: mentions })}>
      {mentions}
    </span>
  )
}
