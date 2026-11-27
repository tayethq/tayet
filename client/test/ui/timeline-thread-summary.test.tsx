// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, renderHook, waitFor, act } from '@testing-library/react'
import { Timeline, lastReplyOf, relativeTimeOf } from '../../src/ui/components/Timeline'
import { Workspace } from '../../src/ui/components/Workspace'
import { useChat } from '../../src/ui/useChat'
import type { Acl, Channel, ChannelId, DomainEvent, Message, MessageId, PageCursor, User, UserId } from '../../src/acl'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { copy, fill } from '../support/copy'

// ADR-066 on screen: under a root with replies, "1 reply" / "N replies" with when the latest one was
// sent, plus the unread marker (a dot named "Unread replies", ADR-067) when getThreadUnread says the
// thread is unread. Clicking opens
// the thread through the SAME path as "Reply in thread". Fixtures carry REAL protocol-shaped ids
// (the ADR-008 residual) — the render-scan proves none reaches the DOM.

const cid = (s: string): ChannelId => s as unknown as ChannelId
const uid = (s: string): UserId => s as unknown as UserId
const mid = (s: string): MessageId => s as unknown as MessageId
const tms = (n: number) => n as unknown as Message['sentAt']

const alice: User = { id: uid('@alice:tayet.local'), displayName: 'Alice Anderson', kind: 'member' }
const usersById = { [alice.id]: alice }
const channelId = cid('!dm:tayet.local')
const NOW = Date.now()

function root(over: Partial<Message> = {}): Message {
  return {
    id: mid('$root:tayet.local'),
    channelId,
    author: alice.id,
    body: { kind: 'text', text: 'Ship on Friday?' },
    sentAt: tms(NOW - 3_600_000),
    reactions: [],
    mine: false,
    mentionsMe: false,
    ...over,
  }
}

afterEach(cleanup)

describe('thread summary under the root (ADR-066)', () => {
  it('"1 reply" with the latest-reply time; no marker when nothing is unread', () => {
    const m = root({ threadSummary: { replyCount: 1, latestReplyAt: tms(NOW - 5 * 60_000) } })
    const { getByRole, queryByLabelText } = render(
      <Timeline messages={[m]} usersById={usersById} onOpenThread={() => {}} threadUnreadOf={() => false} />,
    )
    const button = getByRole('button', { name: new RegExp(fill(copy.timeline.replies.one, { n: 1 })) })
    expect(button.textContent).toContain(fill(copy.timeline.replies.one, { n: 1 }))
    expect(button.textContent).toContain(`· ${lastReplyOf(m.threadSummary!.latestReplyAt)}`)
    expect(queryByLabelText(copy.timeline.unreadReplies)).toBeNull()
  })

  it('"N replies" plus the dot named "Unread replies", without a number; clicking opens the thread', () => {
    const onOpenThread = vi.fn()
    const m = root({ threadSummary: { replyCount: 3, latestReplyAt: tms(NOW - 30_000) } })
    const { getByRole, getByLabelText } = render(
      <Timeline messages={[m]} usersById={usersById} onOpenThread={onOpenThread} threadUnreadOf={() => true} />,
    )
    const dot = getByLabelText(copy.timeline.unreadReplies)
    expect(dot.textContent).toBe('')
    expect(dot.getAttribute('role')).toBe('img')
    const button = getByRole('button', { name: new RegExp(fill(copy.timeline.replies.other, { n: 3 })) })
    expect(button.textContent).toContain(lastReplyOf(m.threadSummary!.latestReplyAt))
    fireEvent.click(button)
    // Same call as the "Reply in thread" affordance: the domain Message, nothing else.
    expect(onOpenThread).toHaveBeenCalledWith(m)
    fireEvent.click(getByRole('button', { name: copy.timeline.replyInThread }))
    expect(onOpenThread).toHaveBeenNthCalledWith(2, m)
  })

  it('no summary without a thread, and none on a thread reply or where no thread can open', () => {
    const plain = root()
    const reply = root({
      id: mid('$reply:tayet.local'),
      threadParent: plain.id,
      threadSummary: { replyCount: 1, latestReplyAt: tms(NOW) },
    })
    const { queryByRole, rerender } = render(
      <Timeline messages={[plain, reply]} usersById={usersById} onOpenThread={() => {}} />,
    )
    expect(queryByRole('button', { name: /repl(y|ies)\b/ })).toBeNull()
    rerender(<Timeline messages={[root({ threadSummary: { replyCount: 2, latestReplyAt: tms(NOW) } })]} usersById={usersById} />)
    expect(queryByRole('button', { name: new RegExp(fill(copy.timeline.replies.other, { n: 2 })) })).toBeNull()
  })

  it('render-scan: the summary and the marker leak no protocol shape (P1)', () => {
    const m = root({ threadSummary: { replyCount: 4, latestReplyAt: tms(NOW - 2 * 86_400_000) } })
    const { container } = render(
      <Timeline messages={[m]} usersById={usersById} onOpenThread={() => {}} threadUnreadOf={() => true} />,
    )
    const text = container.textContent ?? ''
    expect(text).toContain(fill(copy.timeline.replies.other, { n: 4 })) // positive control
    expect(text).toContain(lastReplyOf(m.threadSummary!.latestReplyAt))
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
    expect(container.innerHTML).not.toMatch(/\$root|tayet\.local|m\.thread|rel_type/)
  })

  it('the summary suffix: the time today, the short date on another day, with the year on another year', () => {
    const now = new Date(2026, 10, 1, 15, 0).getTime()
    expect(lastReplyOf(tms(new Date(2026, 10, 1, 9, 29).getTime()), now)).toBe(fill(copy.timeline.lastReplyAt, { time: '09:29' }))
    expect(lastReplyOf(tms(new Date(2026, 9, 28, 9, 29).getTime()), now)).toBe(fill(copy.timeline.lastReplyOn, { date: '28 de out.' }))
    expect(lastReplyOf(tms(new Date(2025, 9, 28, 9, 29).getTime()), now)).toBe(fill(copy.timeline.lastReplyOn, { date: '28 de out. de 2025' }))
  })

  it('reads "2 respostas · última às HH:MM" as one line under a fixed clock', () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 1, 15, 0), toFake: ['Date'] })
    try {
      const m = root({ threadSummary: { replyCount: 2, latestReplyAt: tms(new Date(2026, 10, 1, 9, 29).getTime()) } })
      const { getByRole } = render(<Timeline messages={[m]} usersById={usersById} onOpenThread={() => {}} />)
      const button = getByRole('button', { name: new RegExp(fill(copy.timeline.replies.other, { n: 2 })) })
      expect(button.textContent).toBe('2 respostas · última às 09:29')
    } finally {
      vi.useRealTimers()
    }
  })

  it('relativeTimeOf: just now / minutes / hours / yesterday', () => {
    expect(relativeTimeOf(tms(NOW - 10_000), NOW)).toBe(copy.timeline.justNow)
    expect(relativeTimeOf(tms(NOW - 60_000), NOW)).toBe('há 1 minuto')
    expect(relativeTimeOf(tms(NOW - 3 * 3_600_000), NOW)).toBe('há 3 horas')
    expect(relativeTimeOf(tms(NOW - 86_400_000), NOW)).toBe('ontem')
  })
})

// useChat: the root's summary arrives as message.edited (ADR-066 dec. 3) and is applied IN PLACE;
// a message.edited for a root the UI never loaded is NOT inserted. The per-root marker is read from
// getThreadUnread and re-read on the channel's channel.changed.
describe('useChat — thread summary + per-root unread', () => {
  const channel: Channel = {
    id: channelId,
    name: 'Alice Anderson',
    kind: 'dm',
    memberCount: 2,
    unread: { count: 0, mentions: 0 },
  }

  function fakeAcl(initial: Message[]) {
    let channelHandler: ((e: DomainEvent) => void) | undefined
    let unread = 0
    const getThreadUnread = vi.fn(async () => ({ unread: unread > 0 }))
    const acl = {
      getChannels: async () => [channel],
      getArchivedChannels: async () => [],
      getMembers: async () => [{ user: alice, role: 'member', state: 'active' }],
      getDevices: async () => [],
      currentUser: async () => alice,
      getThreadUnread,
      getTimeline: async () => ({ items: initial, nextCursor: undefined as PageCursor | undefined }),
      getConnectionState: () => 'connecting' as const,
      getChannelAbilities: () => ({ rename: false, editTopic: false, addPeople: false, removePeople: false, setRoles: false, archive: false }),
      subscribe: () => () => {},
      subscribeChannel: (_id: ChannelId, h: (e: DomainEvent) => void) => {
        channelHandler = h
        return () => {}
      },
      markRead: async () => {},
    } as unknown as Acl
    return {
      acl,
      getThreadUnread,
      setUnread: (n: number) => (unread = n),
      emit: (e: DomainEvent) => channelHandler?.(e),
    }
  }

  it('applies the root update in place, ignores an unknown root, and tracks the marker', async () => {
    const r = root()
    const f = fakeAcl([r])
    const { result } = renderHook(() => useChat(f.acl))
    await waitFor(() => expect(result.current.messages).toHaveLength(1))

    f.setUnread(1)
    act(() =>
      f.emit({
        t: 'message.edited',
        channelId,
        message: { ...r, threadSummary: { replyCount: 1, latestReplyAt: tms(NOW) } },
      }),
    )
    await waitFor(() => expect(result.current.messages[0]!.threadSummary?.replyCount).toBe(1))
    await waitFor(() => expect(result.current.threadUnreadByRoot[r.id]?.unread).toBe(true))

    // A root outside the loaded window: never appended at the bottom.
    act(() =>
      f.emit({
        t: 'message.edited',
        channelId,
        message: { ...root({ id: mid('$old:tayet.local') }), threadSummary: { replyCount: 2, latestReplyAt: tms(NOW) } },
      }),
    )
    expect(result.current.messages.map((m) => m.id)).toEqual([r.id])

    // The thread was read elsewhere: the channel's counts move → the marker is re-read and clears.
    f.setUnread(0)
    act(() => f.emit({ t: 'channel.changed', channel }))
    await waitFor(() => expect(result.current.threadUnreadByRoot[r.id]?.unread).toBe(false))
  })

  it('switching channels with a thread open never reads that thread in the new channel', async () => {
    const other: Channel = { ...channel, id: cid('!other:tayet.local'), name: '#other', kind: 'public' }
    const r = root()
    const getTimeline = vi.fn(async (_id: ChannelId, _opts?: { thread?: MessageId }) => ({
      items: [r],
      nextCursor: undefined as PageCursor | undefined,
    }))
    const acl = {
      getChannels: async () => [channel, other],
      getArchivedChannels: async () => [],
      getMembers: async () => [],
      getDevices: async () => [],
      currentUser: async () => alice,
      getThreadUnread: async () => ({ unread: false }),
      getTimeline,
      getConnectionState: () => 'connecting' as const,
      getChannelAbilities: () => ({ rename: false, editTopic: false, addPeople: false, removePeople: false, setRoles: false, archive: false }),
      subscribe: () => () => {},
      subscribeChannel: () => () => {},
      markRead: async () => {},
    } as unknown as Acl
    const { result } = renderHook(() => useChat(acl))
    await waitFor(() => expect(result.current.messages).toHaveLength(1))
    act(() => result.current.openThread(r))
    await waitFor(() => expect(getTimeline).toHaveBeenCalledWith(channelId, { thread: r.id }))
    act(() => result.current.select(other.id))
    await waitFor(() => expect(result.current.threadRoot).toBeUndefined())
    expect(getTimeline).not.toHaveBeenCalledWith(other.id, { thread: r.id })
  })

  it('Workspace wires the marker from the per-root map', () => {
    const m = root({ threadSummary: { replyCount: 2, latestReplyAt: tms(NOW) } })
    const { getByLabelText } = render(
      <Workspace
        channels={[channel]}
        selectedChannelId={channelId}
        messages={[m]}
        usersById={usersById}
        currentUser={alice}
        connection="connected"
        threadUnreadByRoot={{ [m.id]: { unread: true } }}
        onSelectChannel={() => {}}
        onSend={() => {}}
        onOpenThread={() => {}}
      />,
    )
    expect(getByLabelText(copy.timeline.unreadReplies)).toBeTruthy()
  })
})
