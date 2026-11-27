// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook, act, cleanup, waitFor } from '@testing-library/react'
import { useChat } from '../../src/ui/useChat'
import type { Acl, Channel, ChannelId, DomainEvent, Message, MessageBody, MessageId, UserId } from '../../src/acl'

// A3-2 rodada 2 (PLANO-AGENTES §8.32): the open thread's root follows the updates of its own message —
// a message.edited whose id is the open root's replaces the root's snapshot, the same substitution the
// timeline list applies (replaceMessage). Three cases: the author edits a plain root's text, a root that
// decrypts late, an approval-card root whose state moves. Another thread's root is never touched; a
// closed root never reopens; the thread page is not reloaded by a root update.

const uid = (s: string): UserId => s as unknown as UserId
const mid = (s: string): MessageId => s as unknown as MessageId
const cid = (s: string): ChannelId => s as unknown as ChannelId
const CH = cid('!r:tayet.local')
const channel: Channel = { id: CH, name: '#r', kind: 'public', memberCount: 2, unread: { count: 0, mentions: 0 } }

const msg = (id: string, body: MessageBody, over: Partial<Message> = {}): Message => ({
  id: mid(id),
  channelId: CH,
  author: uid('@bob:tayet.local'),
  body,
  sentAt: 1 as unknown as Message['sentAt'],
  reactions: [{ emoji: '👍', count: 2, mine: true }],
  mine: false,
  mentionsMe: false,
  threadSummary: { replyCount: 1, latestReplyAt: 2 as unknown as Message['sentAt'] },
  ...over,
})
const OPTIONS = [{ id: 'approve', label: 'Aprovar', style: 'primary' as const }]
const ROOT_TEXT = msg('$root', { kind: 'text', text: 'antes' })
const ROOT_UTD = msg('$utd', { kind: 'unavailable', arrival: 'awaited' })
const ROOT_CARD = msg('$card', { kind: 'approval', text: 'Publicar?', options: OPTIONS, state: { kind: 'open' } }, { author: uid('@a-abcdefghijkl:tayet.local') })
const OTHER = msg('$other', { kind: 'text', text: 'outra' })

function fakeAcl(items: Message[]) {
  const handlers = new Set<(e: DomainEvent) => void>()
  const getTimeline = vi.fn(async (_id: ChannelId, opts?: { thread?: MessageId }) => ({ items: opts?.thread ? [] : items }))
  const acl = {
    getChannels: async () => [channel],
    getArchivedChannels: async () => [],
    getChannel: async () => channel,
    getMembers: async () => [],
    getDevices: async () => [],
    currentUser: async () => ({ id: uid('@me:tayet.local'), displayName: 'Me' }),
    getThreadUnread: async () => ({ unread: false }),
    getTimeline,
    getPresence: () => 'offline' as const,
    getConnectionState: () => 'connecting' as const,
    getChannelAbilities: () => ({ rename: false, editTopic: false, addPeople: false, removePeople: false, setRoles: false, archive: false }),
    subscribe: () => () => {},
    subscribeChannel: (_id: ChannelId, h: (e: DomainEvent) => void) => {
      handlers.add(h)
      return () => handlers.delete(h)
    },
    markRead: async () => {},
    acknowledgeAccess: () => {},
    connect: async () => {},
    disconnect: async () => {},
  } as unknown as Acl
  const emit = (e: DomainEvent): void => act(() => [...handlers].forEach((h) => h(e)))
  const threadLoads = (): number => getTimeline.mock.calls.filter(([, o]) => o?.thread !== undefined).length
  return { acl, emit, threadLoads }
}

const edited = (m: Message): DomainEvent => ({ t: 'message.edited', channelId: CH, message: m })

async function opened(root: Message) {
  const fake = fakeAcl([root, OTHER])
  const { result } = renderHook(() => useChat(fake.acl))
  act(() => result.current.select(CH))
  await waitFor(() => expect(result.current.messages).toHaveLength(2))
  act(() => result.current.openThread(root))
  await waitFor(() => expect(fake.threadLoads()).toBe(1))
  return { result, ...fake }
}

afterEach(cleanup)

describe('useChat — the open thread root follows message.edited (A3-2 rodada 2)', () => {
  it('(a) the author edits the text of a plain root', async () => {
    const { result, emit, threadLoads } = await opened(ROOT_TEXT)
    const next = { ...ROOT_TEXT, body: { kind: 'text' as const, text: 'depois' }, editedAt: 5 as unknown as Message['sentAt'] }
    emit(edited(next))
    expect(result.current.threadRoot).toEqual(next)
    expect(result.current.threadRoot?.reactions).toEqual(ROOT_TEXT.reactions)
    // The root update is no thread switch: the replies are not reloaded.
    expect(threadLoads()).toBe(1)
  })

  it('(b) a root that decrypts late', async () => {
    const { result, emit } = await opened(ROOT_UTD)
    const next = { ...ROOT_UTD, body: { kind: 'text' as const, text: 'decifrada' } }
    emit(edited(next))
    expect(result.current.threadRoot?.body).toEqual({ kind: 'text', text: 'decifrada' })
  })

  it('(c) an approval-card root whose state moves (sending → answered)', async () => {
    const { result, emit, threadLoads } = await opened(ROOT_CARD)
    const body = ROOT_CARD.body as Extract<MessageBody, { kind: 'approval' }>
    emit(edited({ ...ROOT_CARD, body: { ...body, state: { kind: 'sending', option: 'approve' } } }))
    expect(result.current.threadRoot?.body).toMatchObject({ state: { kind: 'sending', option: 'approve' } })
    const answered = { kind: 'answered' as const, by: uid('@me:tayet.local'), at: 9 as unknown as Message['sentAt'], option: 'approve' }
    emit(edited({ ...ROOT_CARD, body: { ...body, state: answered } }))
    expect(result.current.threadRoot?.body).toMatchObject({ state: answered })
    expect(threadLoads()).toBe(1)
  })

  it('another message’s edit leaves the root as it is', async () => {
    const { result, emit } = await opened(ROOT_TEXT)
    const before = result.current.threadRoot
    emit(edited({ ...OTHER, body: { kind: 'text', text: 'mudou' } }))
    expect(result.current.threadRoot).toBe(before)
  })

  it('a closed root does not reopen on its edit', async () => {
    const { result, emit } = await opened(ROOT_TEXT)
    act(() => result.current.closeThread())
    emit(edited({ ...ROOT_TEXT, body: { kind: 'text', text: 'depois' } }))
    expect(result.current.threadRoot).toBeUndefined()
  })
})
