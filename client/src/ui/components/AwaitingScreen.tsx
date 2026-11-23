import type { ReactNode, Ref } from 'react'
import type { AwaitingApproval, Channel, Message, User, UserId } from '@tayet/client'
import { ScreenHeader } from '../primitives'
import { Chevron } from '../icons'
import { resolveAuthor } from '../author'
import { t } from '../i18n'
import { AgentAvatar } from './AgentAvatar'
import { ApprovalCard, timeOf } from './Timeline'
import { ChannelLabel, bareName } from './ChannelLabel'
import { whenOf } from './SearchResults'

// "Aguardando você" (ADR-099). The row on the narrow list (workspace.md §23.2 item 5) and the screen it opens
// (§23.4), a screen of the stack between the list and the conversation (PLANO-MOBILE §0.20 V2). The counts
// are the ACL's list (V4); the screen's cards are what it holds while it is on the stack (V3).

// The row: the counter · "Aguardando você" over the summary · the chevron. Only with something pending.
export function AwaitingRow({ count, summary, onOpen }: { count: number; summary: string; onOpen: () => void }) {
  return (
    <div className="awaiting-row">
      {/* Focused on the tap (a touch does not focus a button in every browser): the way back returns to it. */}
      <button
        type="button"
        className="awaiting-row__button"
        onClick={(e) => {
          e.currentTarget.focus()
          onOpen()
        }}
      >
        <span className="awaiting-row__count" aria-hidden="true">
          {count}
        </span>
        <span className="awaiting-row__text">
          <span className="awaiting-row__title">{t('awaiting.title')}</span>
          <span className="awaiting-row__summary">{summary}</span>
        </span>
        <span className="awaiting-row__chevron" aria-hidden="true">
          <Chevron />
        </span>
      </button>
    </div>
  )
}

// A catalog text with one placeholder filled by a node (the channel's label keeps its mark).
function withNode(key: 'awaiting.inChannel', node: ReactNode): ReactNode {
  const mark = '\u0000'
  const [before, after] = t(key, { channel: mark }).split(mark)
  return (
    <>
      {before}
      {node}
      {after}
    </>
  )
}

// V6: a channel or a group, "em {canal}" with the label; a direct conversation with the agent, "em conversa
// com {agente}".
function whereOf(channel: Channel | undefined, agent: string): ReactNode {
  if (!channel) return null
  if (channel.kind === 'dm') return t('awaiting.inConversationWith', { agent })
  if (channel.kind === 'group') return t('awaiting.inChannel', { channel: bareName(channel) })
  return withNode('awaiting.inChannel', <ChannelLabel channel={channel} />)
}

// F2 (amends V6): a card of today shows only the time, with the timeline's formatter; another day, the search
// result's.
export function originTime(sentAt: number, now: number = Date.now()): string {
  return new Date(sentAt).toDateString() === new Date(now).toDateString() ? timeOf(sentAt as never) : whenOf(sentAt, now)
}

export function AwaitingScreen({
  shown,
  summary,
  channels,
  usersById,
  selfId,
  onAnswer,
  onPick,
  onBack,
  backRef,
  strip,
  covered,
}: {
  shown: AwaitingApproval[]
  // The ACL's list summary; absent with zero (V4: the subtitle goes, the screen stays).
  summary?: string
  channels: Channel[]
  usersById: Record<string, User>
  selfId?: UserId
  onAnswer?: (message: Message, option: string) => void
  onPick: (item: AwaitingApproval) => void
  onBack: () => void
  backRef?: Ref<HTMLButtonElement>
  // The connection strip, under the header (W5).
  strip?: ReactNode
  covered: boolean
}) {
  return (
    <section
      className="awaiting-screen"
      aria-label={t('awaiting.title')}
      {...(covered && { 'data-stack-covered': '', inert: true })}
    >
      <ScreenHeader
        className="awaiting-screen__header"
        onBack={onBack}
        backRef={backRef}
        title={t('awaiting.title')}
        subtitle={summary}
      />
      {strip}
      <div className="awaiting-screen__body">
        {shown.map((item) => {
          const { message } = item
          if (message.body.kind !== 'approval') return null
          const author = resolveAuthor(message, usersById, t('timeline.someone'))
          const channel = channels.find((c) => c.id === item.channel)
          return (
            <ApprovalCard
              key={message.id}
              body={message.body}
              usersById={usersById}
              selfId={selfId}
              onAnswer={onAnswer ? (option) => onAnswer(message, option) : undefined}
              formReply={message.formReply}
              origin={
                <button type="button" className="awaiting-origin" onClick={() => onPick(item)}>
                  <AgentAvatar color={author.agentColor ?? 'areia'} size="gestao" />
                  <span className="awaiting-origin__text">
                    <span className="awaiting-origin__agent">{author.name}</span>{' '}
                    <span className="awaiting-origin__where">{whereOf(channel, author.name)}</span>
                  </span>
                  <span className="awaiting-origin__when">{originTime(message.sentAt as unknown as number)}</span>
                  <span className="awaiting-origin__chevron" aria-hidden="true">
                    <Chevron />
                  </span>
                </button>
              }
            />
          )
        })}
      </div>
    </section>
  )
}
