import { useEffect, useRef } from 'react'
import type { AgentCommand, Channel, Message, MessageId, ThreadUnread, User, UserId } from '@tayet/client'
import type { ComposeResult } from '../compose'
import type { ComposerCommand } from '../composer/RichComposer'
import { MessageRow, initialsOf } from './Timeline'
import { resolveAuthor } from '../author'
import { Composer } from './Composer'
import { ChannelLabel } from './ChannelLabel'
import { t, GLYPH } from '../i18n'

// Thread panel: the root message + its replies + a thread composer. Pure presentational — all data
// arrives as clean domain props, so it is driven identically by the live app and the DOM
// render-scan test (P1 on screen, for the thread surface). It reuses MessageRow, so thread messages
// render exactly like main-timeline ones. The composer sends into the thread; routing by
// threadParent is the ACL's job (ADR-007/ADR-011) — this component never names a relation.
export function ThreadPanel({
  root,
  channel,
  messages,
  usersById,
  unread,
  onClose,
  onSend,
  onSendAttachment,
  commands,
  onRetry,
  onReact,
  onEdit,
  onDelete,
  onOpenProfile,
  disabled,
  highlight,
  onHighlightEnd,
  selfId,
  onAnswer,
}: {
  root: Message
  // The thread's channel, the header's subtitle (manifest workspace.md §11 item 9).
  channel?: Channel
  messages: Message[]
  usersById: Record<string, User>
  // ADR-067: the open thread still has a reply the viewer has not read (cleared by the markRead on open).
  unread?: ThreadUnread
  onClose: () => void
  onSend: (body: ComposeResult, mentions: UserId[], command?: ComposerCommand) => void
  onSendAttachment?: (file: File) => void
  // ADR-093 (Proposto): the conversation's `/` commands — the thread composer opens the same popup (§21.1 item 2).
  commands?: AgentCommand[]
  onRetry?: (message: Message) => void
  onReact?: (message: Message, emoji: string) => void
  onEdit?: (message: Message, body: ComposeResult) => void
  onDelete?: (message: Message) => void
  // Perfil-de-outro (ADR-043): repassado a cada MessageRow group-start pra abrir o perfil do autor,
  // como na Timeline. Só o header (isGroupStart) o usa.
  onOpenProfile?: (user: UserId) => void
  disabled?: boolean
  // The reply a search jump reached (manifest workspace.md §8 item 9): centred and highlighted, with
  // the thread's padding/negative-margin treatment (§6.1).
  highlight?: { id: MessageId; seq: number }
  onHighlightEnd?: () => void
  // The viewer's own id, opaque — an approval card's answer by the viewer reads "Você" (§17.1 item 7).
  selfId?: UserId
  // Answer an approval card (ADR-091 dec. 14) — on the root and among the replies alike: the root follows
  // its own message's updates (useChat), so its card shows the send like any row (§18 item 7).
  onAnswer?: (message: Message, option: string) => void
}) {
  const rowsById = useRef(new Map<string, HTMLElement>())
  useEffect(() => {
    if (highlight) rowsById.current.get(highlight.id)?.scrollIntoView?.({ block: 'center' })
  }, [highlight])

  return (
    <aside className="thread-panel" aria-label={t('thread.title')}>
      <header className="thread-panel__header">
        <div className="thread-panel__heading">
          <h3 className="thread-panel__title">{t('thread.title')}</h3>
          {channel && (
            <div className="thread-panel__subtitle">
              <ChannelLabel channel={channel} hint={t('shell.privateHint')} />
            </div>
          )}
        </div>
        {unread?.unread && <span className="unread-dot" role="img" aria-label={t('thread.unreadReplies')} />}
        <button type="button" className="thread-panel__close" onClick={onClose} aria-label={t('thread.close')}>
          {GLYPH.close}
        </button>
      </header>

      <div className="thread-panel__root">
        <div className="message__group">
          <MessageRow
            selfId={selfId}
            message={root}
            usersById={usersById}
            isGroupStart
            avatarLabel={initialsOf(resolveAuthor(root, usersById, t('thread.someone')).name)}
            mine={root.mine === true}
            onReact={onReact}
            onEdit={onEdit}
            // The root snapshot does not follow its thread summary: the replies on screen gate the
            // delete instead (ADR-075 dec. 3, a root with replies stays).
            onDelete={messages.length === 0 ? onDelete : undefined}
            onOpenProfile={onOpenProfile}
            onAnswer={onAnswer}
          />
        </div>
      </div>

      {messages.length > 0 && (
        <div className="thread-panel__divider" role="separator" aria-label={t('timeline.replies', { n: messages.length })}>
          <span className="timeline__day-rule" aria-hidden="true" />
          <span className="timeline__day-label" aria-hidden="true">{t('timeline.replies', { n: messages.length })}</span>
          <span className="timeline__day-rule" aria-hidden="true" />
        </div>
      )}

      <div className="thread-panel__replies" role="log" aria-label={t('thread.replies')}>
        {messages.length === 0 && <p className="thread-panel__empty">{t('thread.empty')}</p>}
        {(() => {
          // Group consecutive-same-author replies, mirroring the main Timeline, so a thread reads
          // identically: group-start renders avatar + name + time, continuations render body-only
          // with a muted timestamp in the gutter.
          const groups: Message[][] = []
          for (const m of messages) {
            const last = groups[groups.length - 1]
            if (last && last[0]!.author === m.author) last.push(m)
            else groups.push([m])
          }
          return groups.map((group) => {
            const first = group[0]!
            const avatarLabel = initialsOf(resolveAuthor(first, usersById, t('thread.someone')).name)
            return (
              <div className="message__group" key={first.id}>
                {group.map((m, idx) => (
                  <MessageRow
            selfId={selfId}
                    key={m.id}
                    message={m}
                    usersById={usersById}
                    isGroupStart={idx === 0}
                    avatarLabel={avatarLabel}
                    mine={m.mine === true}
                    onRetry={onRetry}
                    onAnswer={onAnswer}
                    onReact={onReact}
                    onEdit={onEdit}
                    onDelete={onDelete}
                    onOpenProfile={onOpenProfile}
                    highlighted={highlight?.id === m.id}
                    onHighlightEnd={onHighlightEnd}
                    rowRef={(el) => {
                      if (el) rowsById.current.set(m.id, el)
                      else rowsById.current.delete(m.id)
                    }}
                  />
                ))}
              </div>
            )
          })
        })()}
      </div>

      <Composer
        onSend={onSend}
        onSendAttachment={onSendAttachment}
        users={Object.values(usersById)}
        commands={commands}
        disabled={disabled}
        variant="compact"
      />
    </aside>
  )
}
