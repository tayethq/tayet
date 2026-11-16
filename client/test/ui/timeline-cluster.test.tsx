// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, within } from '@testing-library/react'
import { Timeline } from '../../src/ui/components/Timeline'
import { ThreadPanel } from '../../src/ui/components/ThreadPanel'
import type { Channel, ChannelId, Message, MessageId, User, UserId } from '../../src/acl'
import { copy, fill } from '../support/copy'

// Manifest workspace.md §11: the mention label, "Você" as one's own author, the action bar's order
// and the ThreadPanel's subtitle and divider. The reactions line is reactions.test.tsx's; the summary
// copy is timeline-thread-summary.test.tsx's.

const uid = (s: string): UserId => s as unknown as UserId
const mid = (s: string): MessageId => s as unknown as MessageId
const cid = (s: string): ChannelId => s as unknown as ChannelId
const tms = (n: number) => n as unknown as Message['sentAt']

const me: User = { id: uid('@me:tayet.local'), displayName: 'Marina Alves', kind: 'member' }
const bob: User = { id: uid('@bob:tayet.local'), displayName: 'Bob Brown', kind: 'member' }
const usersById: Record<string, User> = { [me.id]: me, [bob.id]: bob }
const channel = { id: cid('!r:tayet.local'), name: '#produto', kind: 'public' } as unknown as Channel

function msg(id: string, over: Partial<Message> = {}): Message {
  return {
    id: mid(`$${id}:tayet.local`),
    channelId: channel.id,
    author: bob.id,
    body: { kind: 'text', text: `text ${id}` },
    sentAt: tms(1_000),
    reactions: [],
    mine: false,
    mentionsMe: false,
    ...over,
  }
}

const mine = (id: string): Message => msg(id, { author: me.id, mine: true })

afterEach(cleanup)

describe('author "Você" (§11 item 7)', () => {
  it('one\'s own header reads "Você"; the profile button keeps the display name', () => {
    const { container, getAllByRole } = render(<Timeline messages={[mine('a')]} usersById={usersById} onOpenProfile={() => {}} />)
    expect(container.querySelector('.message__author')?.textContent).toBe(copy.timeline.you)
    const buttons = getAllByRole('button', { name: fill(copy.timeline.viewProfile, { name: me.displayName }) })
    expect(buttons.map((b) => b.textContent)).toContain(copy.timeline.you)
  })

  it("someone else's header keeps the name", () => {
    const { container } = render(<Timeline messages={[msg('a')]} usersById={usersById} />)
    expect(container.querySelector('.message__author')?.textContent).toBe(bob.displayName)
  })
})

describe('mention label (§11 item 1)', () => {
  it('only on a message that mentions the viewer, in a continuation too', () => {
    const { getAllByText } = render(
      <Timeline messages={[msg('a'), msg('b', { mentionsMe: true })]} usersById={usersById} />,
    )
    const labels = getAllByText(copy.timeline.mentionsYou)
    expect(labels).toHaveLength(1)
    expect(labels[0]!.closest('.message')?.textContent).toContain('text b')
    expect(labels[0]!.querySelector('.message__mention-dot')).toBeTruthy()
  })

  it('absent without a mention', () => {
    const { queryByText } = render(<Timeline messages={[msg('a')]} usersById={usersById} />)
    expect(queryByText(copy.timeline.mentionsYou)).toBeNull()
  })
})

describe('action bar (§11 item 4)', () => {
  const titles = (root: HTMLElement): (string | null)[] =>
    Array.from(root.querySelector('.message__actions')!.querySelectorAll(':scope > button, :scope > .reaction-anchor > button')).map((b) =>
      b.getAttribute('title'),
    )

  it('React · Reply · Thread on a message of someone else, no "More"', () => {
    const { container } = render(
      <Timeline messages={[msg('a')]} usersById={usersById} onReact={() => {}} onReply={() => {}} onOpenThread={() => {}} />,
    )
    expect(titles(container)).toEqual([copy.timeline.reactOpen, copy.timeline.reply, copy.timeline.replyInThread])
  })

  it('+ Edit · Delete on one\'s own', () => {
    const { container } = render(
      <Timeline
        messages={[mine('a')]}
        usersById={usersById}
        onReact={() => {}}
        onReply={() => {}}
        onOpenThread={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
      />,
    )
    expect(titles(container)).toEqual([
      copy.timeline.reactOpen,
      copy.timeline.reply,
      copy.timeline.replyInThread,
      copy.timeline.editMessage,
      copy.timeline.deleteMessage,
    ])
  })
})

describe('ThreadPanel header and divider (§11 item 9)', () => {
  const panel = (replies: Message[]) =>
    render(
      <ThreadPanel root={msg('root')} channel={channel} messages={replies} usersById={usersById} onClose={() => {}} onSend={() => {}} />,
    )

  it('the channel, with its mark, under "Thread"', () => {
    const { container } = panel([])
    expect(container.querySelector('.thread-panel__heading .thread-panel__subtitle')?.textContent).toBe('#produto')
  })

  it('"N respostas" between the root and the first reply', () => {
    const { container } = panel([msg('r1'), mine('r2')])
    const divider = container.querySelector('.thread-panel__divider') as HTMLElement
    const label = fill(copy.timeline.replies.other, { n: 2 })
    expect(divider.getAttribute('aria-label')).toBe(label)
    expect(within(divider).getByText(label)).toBeTruthy()
    expect(divider.previousElementSibling?.className).toBe('thread-panel__root')
    expect(divider.nextElementSibling?.className).toBe('thread-panel__replies')
  })

  it('no divider before the first reply', () => {
    const { container } = panel([])
    expect(container.querySelector('.thread-panel__divider')).toBeNull()
  })
})
