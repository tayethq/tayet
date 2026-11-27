// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { renderHook, act, cleanup, waitFor } from '@testing-library/react'
import { useChat } from '../../src/ui/useChat'
import type { Acl, Channel, ChannelId, Message, MessageId, UserId } from '../../src/acl'

// On a narrow window the list is a screen, so the boot selects
// nothing and the way back to the list clears the selection; widening with the list on screen selects
// the first conversation, as the boot does on a wide window. The fake ACL is built outside renderHook
// (an inline fake re-creates the effects on every render).

const uid = (s: string): UserId => s as unknown as UserId
const mid = (s: string): MessageId => s as unknown as MessageId
const cid = (s: string): ChannelId => s as unknown as ChannelId
const A = cid('!a:tayet.local')
const B = cid('!b:tayet.local')
const ch = (id: ChannelId, name: string): Channel => ({ id, name, kind: 'public', memberCount: 2, unread: { count: 0, mentions: 0 } })
const ROOT: Message = {
  id: mid('$root'),
  channelId: A,
  author: uid('@bob:tayet.local'),
  body: { kind: 'text', text: 'raiz' },
  sentAt: 1 as unknown as Message['sentAt'],
  reactions: [],
  mine: false,
  mentionsMe: false,
}

function fakeAcl(): Acl {
  return {
    getChannels: async () => [ch(A, '#a'), ch(B, '#b')],
    getArchivedChannels: async () => [],
    getChannel: async () => undefined,
    getMembers: async () => [],
    getDevices: async () => [],
    currentUser: async () => ({ id: uid('@me:tayet.local'), displayName: 'Me' }),
    getThreadUnread: async () => ({ unread: false }),
    getTimeline: async () => ({ items: [] }),
    listPanels: async () => [],
    listCommands: async () => [],
    getPresence: () => 'offline' as const,
    getConnectionState: () => 'connecting' as const,
    getChannelAbilities: () => ({ rename: false, editTopic: false, addPeople: false, removePeople: false, setRoles: false, archive: false }),
    subscribe: () => () => {},
    subscribeChannel: () => () => {},
    markRead: async () => {},
    acknowledgeAccess: () => {},
    isOrgAdmin: async () => false,
  } as unknown as Acl
}

afterEach(cleanup)

describe('useChat on a narrow window: the list on screen', () => {
  it('the boot selects nothing: the list is on screen', async () => {
    const acl = fakeAcl()
    const { result } = renderHook(() => useChat(acl, { narrow: true }))
    await waitFor(() => expect(result.current.channels).toHaveLength(2))
    expect(result.current.selectedId).toBeUndefined()
  })

  it('on a wide window the boot still selects the first conversation', async () => {
    const acl = fakeAcl()
    const { result } = renderHook(() => useChat(acl))
    await waitFor(() => expect(result.current.selectedId).toBe(A))
  })

  it('back to the list clears the selection and the open thread', async () => {
    const acl = fakeAcl()
    const { result } = renderHook(() => useChat(acl, { narrow: true }))
    await waitFor(() => expect(result.current.channels).toHaveLength(2))
    act(() => result.current.select(A))
    act(() => result.current.openThread(ROOT))
    expect(result.current.threadRoot?.id).toBe(ROOT.id)
    act(() => result.current.deselect())
    expect(result.current.selectedId).toBeUndefined()
    expect(result.current.threadRoot).toBeUndefined()
  })

  it('widening with the list on screen selects the first conversation; narrowing keeps the open one', async () => {
    const acl = fakeAcl()
    const { result, rerender } = renderHook(({ narrow }) => useChat(acl, { narrow }), { initialProps: { narrow: true } })
    await waitFor(() => expect(result.current.channels).toHaveLength(2))
    expect(result.current.selectedId).toBeUndefined()
    rerender({ narrow: false })
    await waitFor(() => expect(result.current.selectedId).toBe(A))
    act(() => result.current.select(B))
    rerender({ narrow: true })
    expect(result.current.selectedId).toBe(B)
  })
})
