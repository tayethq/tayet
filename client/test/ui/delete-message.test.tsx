// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, renderHook, waitFor, act } from '@testing-library/react'
import { Timeline } from '../../src/ui/components/Timeline'
import { ThreadPanel } from '../../src/ui/components/ThreadPanel'
import { useChat } from '../../src/ui/useChat'
import type { Acl, Channel, ChannelId, DomainEvent, Message, MessageId, PageCursor, User, UserId } from '../../src/acl'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'

// ADR-075 on screen: only one's own settled message offers "Apagar mensagem", never a thread root with
// replies; the action asks first, inline in the action bar ("Apagar mensagem?" → "Apagar" / "Cancelar",
// Esc cancels); a deleted root closes its open thread. Fixtures carry protocol-shaped ids (the ADR-008
// residual) — the render-scan proves none reaches the DOM.

const cid = (s: string): ChannelId => s as unknown as ChannelId
const uid = (s: string): UserId => s as unknown as UserId
const mid = (s: string): MessageId => s as unknown as MessageId
const tms = (n: number) => n as unknown as Message['sentAt']

const me: User = { id: uid('@me:tayet.local'), displayName: 'Me Myself', kind: 'member' }
const alice: User = { id: uid('@alice:tayet.local'), displayName: 'Alice Anderson', kind: 'member' }
const usersById = { [me.id]: me, [alice.id]: alice }
const channelId = cid('!room:tayet.local')

function msg(over: Partial<Message> = {}): Message {
  return {
    id: mid('$m1:tayet.local'),
    channelId,
    author: me.id,
    body: { kind: 'text', text: 'to be deleted' },
    sentAt: tms(1),
    reactions: [],
    mine: true,
    mentionsMe: false,
    status: 'sent',
    ...over,
  }
}

afterEach(cleanup)

describe('delete affordance scope (ADR-075 dec. 1 and 3)', () => {
  const offers = (m: Message): boolean => {
    const { queryByLabelText } = render(<Timeline messages={[m]} usersById={usersById} onDelete={() => {}} />)
    const found = queryByLabelText('Apagar mensagem') !== null
    cleanup()
    return found
  }

  it('own and sent: offered', () => expect(offers(msg())).toBe(true))
  it("someone else's: not offered", () => expect(offers(msg({ author: alice.id, mine: false }))).toBe(false))
  it('pending: not offered', () => expect(offers(msg({ status: 'pending' }))).toBe(false))
  it('failed: not offered', () => expect(offers(msg({ status: 'failed' }))).toBe(false))
  it('no status (received form): offered', () => expect(offers(msg({ status: undefined }))).toBe(true))
  it('a root with replies: not offered', () =>
    expect(offers(msg({ threadSummary: { replyCount: 2, latestReplyAt: tms(2) } }))).toBe(false))
  it('a root without replies: offered', () =>
    expect(offers(msg({ threadSummary: { replyCount: 0, latestReplyAt: tms(2) } }))).toBe(true))
  it('without onDelete: not offered', () => {
    const { queryByLabelText } = render(<Timeline messages={[msg()]} usersById={usersById} />)
    expect(queryByLabelText('Apagar mensagem')).toBeNull()
  })

  it('in the thread panel, a root with replies on screen is not offered; its own reply is', () => {
    const root = msg()
    const reply = msg({ id: mid('$r1:tayet.local'), body: { kind: 'text', text: 'reply' }, threadParent: root.id })
    const { getAllByLabelText } = render(
      <ThreadPanel root={root} messages={[reply]} usersById={usersById} onClose={() => {}} onSend={() => {}} onDelete={() => {}} />,
    )
    expect(getAllByLabelText('Apagar mensagem')).toHaveLength(1)
  })
})

describe('inline two-step confirmation (ADR-075 dec. 4 and 6)', () => {
  function open() {
    const onDelete = vi.fn()
    const m = msg()
    const view = render(<Timeline messages={[m]} usersById={usersById} onDelete={onDelete} />)
    fireEvent.click(view.getByLabelText('Apagar mensagem'))
    return { ...view, onDelete, m }
  }

  it('"Apagar mensagem?" → "Apagar" deletes the message, and the bar returns', () => {
    const { getByText, getByRole, onDelete, m, container, getByLabelText } = open()
    expect(getByText('Apagar mensagem?')).toBeTruthy()
    expect(container.querySelector('.message__actions--confirming')).not.toBeNull()
    // The safe answer has focus.
    expect(document.activeElement).toBe(getByRole('button', { name: 'Cancelar' }))
    fireEvent.click(getByRole('button', { name: 'Apagar' }))
    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(onDelete).toHaveBeenCalledWith(m)
    expect(container.querySelector('.message__actions--confirming')).toBeNull()
    expect(getByLabelText('Apagar mensagem')).toBeTruthy()
  })

  it('"Cancelar" does not delete', () => {
    const { getByRole, onDelete, queryByText } = open()
    fireEvent.click(getByRole('button', { name: 'Cancelar' }))
    expect(onDelete).not.toHaveBeenCalled()
    expect(queryByText('Apagar mensagem?')).toBeNull()
  })

  it('Esc does not delete', () => {
    const { getByRole, onDelete, queryByText } = open()
    fireEvent.keyDown(getByRole('button', { name: 'Cancelar' }), { key: 'Escape' })
    expect(onDelete).not.toHaveBeenCalled()
    expect(queryByText('Apagar mensagem?')).toBeNull()
  })

  it('no protocol id reaches the DOM while confirming', () => {
    const { container } = open()
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })
})

describe('useChat — delete (ADR-075)', () => {
  const channel: Channel = {
    id: channelId,
    name: '#room',
    kind: 'public',
    memberCount: 2,
    unread: { count: 0, mentions: 0 },
  }

  function fakeAcl(initial: Message[]) {
    const handlers: Array<(e: DomainEvent) => void> = []
    const deleteMessage = vi.fn(async () => {})
    const acl = {
      getChannels: async () => [channel],
      getArchivedChannels: async () => [],
      getMembers: async () => [{ user: me, role: 'member', state: 'active' }],
      getDevices: async () => [],
      currentUser: async () => me,
      getThreadUnread: async () => ({ unread: false }),
      getTimeline: async (_id: ChannelId, opts?: { thread?: MessageId }) => ({
        items: opts?.thread ? [] : initial,
        nextCursor: undefined as PageCursor | undefined,
      }),
      getConnectionState: () => 'connecting' as const,
      getChannelAbilities: () => ({ rename: false, editTopic: false, addPeople: false, removePeople: false, setRoles: false, archive: false }),
      subscribe: () => () => {},
      subscribeChannel: (_id: ChannelId, h: (e: DomainEvent) => void) => {
        handlers.push(h)
        return () => {
          const i = handlers.indexOf(h)
          if (i >= 0) handlers.splice(i, 1)
        }
      },
      markRead: async () => {},
      deleteMessage,
    } as unknown as Acl
    return { acl, deleteMessage, emit: (e: DomainEvent) => handlers.slice().forEach((h) => h(e)) }
  }

  it('remove calls deleteMessage with the id; the row leaves only on message.removed', async () => {
    const m = msg()
    const f = fakeAcl([m])
    const { result } = renderHook(() => useChat(f.acl))
    await waitFor(() => expect(result.current.messages).toHaveLength(1))
    act(() => result.current.remove(m))
    expect(f.deleteMessage).toHaveBeenCalledWith(m.id)
    expect(result.current.messages).toHaveLength(1)
    act(() => f.emit({ t: 'message.removed', channelId, messageId: m.id }))
    await waitFor(() => expect(result.current.messages).toHaveLength(0))
  })

  it('message.removed of the open root closes the thread', async () => {
    const r = msg()
    const f = fakeAcl([r])
    const { result } = renderHook(() => useChat(f.acl))
    await waitFor(() => expect(result.current.messages).toHaveLength(1))
    act(() => result.current.openThread(r))
    expect(result.current.threadRoot?.id).toBe(r.id)
    act(() => f.emit({ t: 'message.removed', channelId, messageId: r.id }))
    await waitFor(() => expect(result.current.threadRoot).toBeUndefined())
    expect(result.current.threadMessages).toEqual([])
  })

  it('message.removed of another message leaves the open thread alone', async () => {
    const r = msg()
    const other = msg({ id: mid('$m2:tayet.local'), body: { kind: 'text', text: 'other' } })
    const f = fakeAcl([r, other])
    const { result } = renderHook(() => useChat(f.acl))
    await waitFor(() => expect(result.current.messages).toHaveLength(2))
    act(() => result.current.openThread(r))
    act(() => f.emit({ t: 'message.removed', channelId, messageId: other.id }))
    await waitFor(() => expect(result.current.messages).toHaveLength(1))
    expect(result.current.threadRoot?.id).toBe(r.id)
  })
})
