// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, renderHook, waitFor, act } from '@testing-library/react'
import { useChat } from '../../src/ui/useChat'
import type { Acl, Channel, ChannelId, Message, MessageId, PageCursor, User, UserId } from '../../src/acl'

// #252 (PLANO-RELEASE-PUBLICA §8.65): opening a thread with no replies must send NO receipt — the
// untargeted markRead is the main-timeline tail (ADR-067: a thread receipt never marks the main
// timeline). The thread's unread is still read. Positive control: a thread with a reply receipts it.

const cid = (s: string): ChannelId => s as unknown as ChannelId
const uid = (s: string): UserId => s as unknown as UserId
const mid = (s: string): MessageId => s as unknown as MessageId
const tms = (n: number) => n as unknown as Message['sentAt']

const alice: User = { id: uid('@alice:tayet.local'), displayName: 'Alice Anderson', kind: 'member' }
const channelId = cid('!dm:tayet.local')
const channel: Channel = {
  id: channelId,
  name: 'Alice Anderson',
  kind: 'dm',
  memberCount: 2,
  unread: { count: 0, mentions: 0 },
}

function msg(id: string, over: Partial<Message> = {}): Message {
  return {
    id: mid(id),
    channelId,
    author: alice.id,
    body: { kind: 'text', text: id },
    sentAt: tms(1),
    reactions: [],
    mine: false,
    mentionsMe: false,
    ...over,
  }
}

const root = msg('$root:tayet.local')

function fakeAcl(threadItems: Message[]) {
  const markRead = vi.fn(async (_id: ChannelId, _upTo?: MessageId) => {})
  const getThreadUnread = vi.fn(async (_id: ChannelId, _root: MessageId) => ({ unread: false }))
  const acl = {
    getChannels: async () => [channel],
    getArchivedChannels: async () => [],
    getMembers: async () => [],
    getDevices: async () => [],
    currentUser: async () => alice,
    getThreadUnread,
    getTimeline: async (_id: ChannelId, opts?: { thread?: MessageId }) => ({
      items: opts?.thread ? threadItems : [root],
      nextCursor: undefined as PageCursor | undefined,
    }),
    getConnectionState: () => 'connecting' as const,
    getChannelAbilities: () => ({ rename: false, editTopic: false, addPeople: false, removePeople: false, setRoles: false, archive: false }),
    subscribe: () => () => {},
    subscribeChannel: () => () => {},
    markRead,
  } as unknown as Acl
  return { acl, markRead, getThreadUnread }
}

afterEach(cleanup)

describe('useChat — opening a thread receipts only a reply (#252)', () => {
  it('empty thread: no markRead at all, the thread unread is still read', async () => {
    const f = fakeAcl([])
    const { result } = renderHook(() => useChat(f.acl))
    await waitFor(() => expect(result.current.messages).toHaveLength(1))
    // The channel's own (main) receipt on select is legitimate; only the thread effect is under test.
    await waitFor(() => expect(f.markRead).toHaveBeenCalledWith(channelId))
    f.markRead.mockClear()
    f.getThreadUnread.mockClear()

    act(() => result.current.openThread(root))
    // Both reads of the thread's unread run: the immediate one and the one after the (skipped) receipt.
    await waitFor(() => expect(f.getThreadUnread).toHaveBeenCalledTimes(2))
    expect(f.getThreadUnread).toHaveBeenCalledWith(channelId, root.id)
    expect(f.markRead).not.toHaveBeenCalled()
  })

  it('positive control: a thread with a reply receipts that reply', async () => {
    const reply = msg('$reply:tayet.local', { threadParent: root.id })
    const f = fakeAcl([reply])
    const { result } = renderHook(() => useChat(f.acl))
    await waitFor(() => expect(result.current.messages).toHaveLength(1))
    await waitFor(() => expect(f.markRead).toHaveBeenCalledWith(channelId))
    f.markRead.mockClear()

    act(() => result.current.openThread(root))
    await waitFor(() => expect(f.markRead).toHaveBeenCalledWith(channelId, reply.id))
    expect(f.markRead).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(f.getThreadUnread).toHaveBeenCalledWith(channelId, root.id))
  })
})
