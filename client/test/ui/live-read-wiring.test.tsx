// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { cleanup, renderHook, waitFor, act } from '@testing-library/react'
import { useChat } from '../../src/ui/useChat'
import type { Acl, Channel, ChannelId, DomainEvent, Message, MessageId, PageCursor, User, UserId } from '../../src/acl'

// ADR-100 wiring: useChat feeds the global stream to the live reader. A message of someone else that
// arrives in the selected conversation, in view, gets a receipt on itself; a hidden document gets none
// until it comes back. The selection's own markRead(id) stays (dec. 4).

const cid = (s: string): ChannelId => s as unknown as ChannelId
const uid = (s: string): UserId => s as unknown as UserId
const mid = (s: string): MessageId => s as unknown as MessageId

const alice: User = { id: uid('@alice:tayet.local'), displayName: 'Alice Anderson', kind: 'member' }
const channelId = cid('!dm:tayet.local')
const channel: Channel = { id: channelId, name: 'Alice Anderson', kind: 'dm', memberCount: 2, unread: { count: 0, mentions: 0 } }

let seq = 0
const msg = (over: Partial<Message> = {}): Message => ({
  id: mid(`$m${++seq}:tayet.local`),
  channelId,
  author: alice.id,
  body: { kind: 'text', text: 'oi' },
  sentAt: 1 as unknown as Message['sentAt'],
  reactions: [],
  mine: false,
  mentionsMe: false,
  ...over,
})

function fakeAcl() {
  const handlers = new Set<(e: DomainEvent) => void>()
  const markRead = vi.fn(async (_id: ChannelId, _upTo?: MessageId) => {})
  const acl = {
    getChannels: async () => [channel],
    getArchivedChannels: async () => [],
    getMembers: async () => [],
    getDevices: async () => [],
    currentUser: async () => alice,
    getThreadUnread: async () => ({ unread: false }),
    getTimeline: async () => ({ items: [] as Message[], nextCursor: undefined as PageCursor | undefined }),
    listPanels: async () => [],
    listCommands: async () => [],
    isOrgAdmin: async () => false,
    getConnectionState: () => 'connecting' as const,
    getChannelAbilities: () => ({ rename: false, editTopic: false, addPeople: false, removePeople: false, setRoles: false, archive: false }),
    subscribe: (h: (e: DomainEvent) => void) => {
      handlers.add(h)
      return () => handlers.delete(h)
    },
    subscribeChannel: (id: ChannelId, h: (e: DomainEvent) => void) => {
      const w = (e: DomainEvent) => {
        if ('channelId' in e && e.channelId === id) h(e)
      }
      handlers.add(w)
      return () => handlers.delete(w)
    },
    markRead,
  } as unknown as Acl
  const emit = (e: DomainEvent) => act(() => handlers.forEach((h) => h(e)))
  return { acl, markRead, emit }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('useChat — the open conversation is read as messages arrive (ADR-100)', () => {
  it('in view: markRead(id, the message)', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const f = fakeAcl()
    const { result } = renderHook(() => useChat(f.acl))
    await waitFor(() => expect(result.current.selectedId).toBe(channelId))
    await waitFor(() => expect(f.markRead).toHaveBeenCalledWith(channelId))
    f.markRead.mockClear()
    const m = msg()
    f.emit({ t: 'message.received', channelId, message: m })
    expect(f.markRead).toHaveBeenCalledWith(channelId, m.id)
  })

  it('without focus: none; the window focus brings it', async () => {
    const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    const f = fakeAcl()
    const { result } = renderHook(() => useChat(f.acl))
    await waitFor(() => expect(result.current.selectedId).toBe(channelId))
    await waitFor(() => expect(f.markRead).toHaveBeenCalledWith(channelId))
    f.markRead.mockClear()
    const m = msg()
    f.emit({ t: 'message.received', channelId, message: m })
    await waitFor(() => expect(result.current.messages.map((x) => x.id)).toEqual([m.id]))
    expect(f.markRead).not.toHaveBeenCalled()
    focus.mockReturnValue(true)
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    // Dec. 3: back in view, one receipt on the last main message the screen holds.
    expect(f.markRead).toHaveBeenCalledTimes(1)
    expect(f.markRead).toHaveBeenCalledWith(channelId, m.id)
  })
})
