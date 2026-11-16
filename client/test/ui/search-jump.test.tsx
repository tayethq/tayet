// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook, act, cleanup, waitFor, render, screen } from '@testing-library/react'
import { useChat, JUMP_PAGE_LIMIT } from '../../src/ui/useChat'
import { Timeline } from '../../src/ui/components/Timeline'
import { ThreadPanel } from '../../src/ui/components/ThreadPanel'
import { MediaProvider } from '../../src/ui/MediaContext'
import type { Acl, Channel, ChannelId, Message, MessageId, PageCursor, SearchHit, UserId } from '../../src/acl'
import { copy } from '../support/copy'

// U5/U6 (manifest workspace.md §8 items 9–11): jumpTo from a search hit. In the loaded window →
// highlight at once; outside it → older pages up to JUMP_PAGE_LIMIT, then the failure; a thread reply
// → getMessage for the root, the thread opens, its pages are walked the same way. And the timeline's
// side of it: the pill, the inert rows, data-highlight and its end.

const cid = (s: string) => s as unknown as ChannelId
const uid = (s: string) => s as unknown as UserId
const mid = (s: string) => s as unknown as MessageId
const cur = (s: string) => s as unknown as PageCursor

const A = cid('!a:tayet.local')
const B = cid('!dm:tayet.local')
const RITA = uid('@rita:tayet.local')
const channels: Channel[] = [
  { id: A, name: '#all', kind: 'public', memberCount: 2, unread: { count: 0, mentions: 0 } },
  { id: B, name: 'rita', kind: 'dm', memberCount: 2, unread: { count: 0, mentions: 0 }, peer: RITA },
]

const msg = (id: string, channelId: ChannelId, over: Partial<Message> = {}): Message => ({
  id: mid(id),
  channelId,
  author: RITA,
  body: { kind: 'text', text: id },
  sentAt: 0 as never,
  reactions: [],
  mine: false,
  mentionsMe: false,
  ...over,
})
const range = (prefix: string, from: number, to: number, ch: ChannelId, over: Partial<Message> = {}) =>
  Array.from({ length: to - from + 1 }, (_, i) => msg(`${prefix}${from + i}`, ch, over))

const ROOT = msg('a-root', B)
type Pages = Record<string, { items: Message[]; nextCursor?: PageCursor }>

function fakeAcl(pages: Pages, opts: { root?: Message | undefined } = {}) {
  const getTimeline = vi.fn(async (id: ChannelId, o?: { thread?: MessageId; cursor?: PageCursor }) => {
    const key = `${id as unknown as string}|${(o?.thread as unknown as string) ?? ''}|${(o?.cursor as unknown as string) ?? ''}`
    return pages[key] ?? { items: [] }
  })
  const getMessage = vi.fn(async () => ('root' in opts ? opts.root : ROOT))
  const noop = () => {}
  const acl = {
    getChannels: async () => channels,
    getArchivedChannels: async () => [],
    getMembers: async () => [],
    getDevices: async () => [],
    currentUser: async () => ({ id: uid('@quim:tayet.local'), displayName: 'quim' }),
    getThreadUnread: async () => ({ unread: false }),
    getTimeline,
    getMessage,
    subscribe: () => noop,
    subscribeChannel: () => noop,
    markRead: async () => {},
  } as unknown as Acl
  return { acl, getTimeline, getMessage }
}

const hit = (message: Message): SearchHit => ({
  message,
  channel: message.channelId,
  excerpt: { before: '', match: 'x', after: '' },
})

const k = (ch: ChannelId, thread = '', cursor = '') => `${ch as unknown as string}|${thread}|${cursor}`

afterEach(cleanup)

describe('useChat.jumpTo (U5)', () => {
  it('a message in the loaded window: highlighted at once, no page walked', async () => {
    const { acl, getTimeline } = fakeAcl({ [k(A)]: { items: range('a', 1, 3, A) } })
    const { result } = renderHook(() => useChat(acl))
    await waitFor(() => expect(result.current.messages).toHaveLength(3))
    const calls = getTimeline.mock.calls.length
    act(() => result.current.jumpTo(hit(result.current.messages[0]!)))
    expect(result.current.highlight?.id).toBe(mid('a1'))
    expect(result.current.jump).toBeUndefined()
    expect(getTimeline.mock.calls.length).toBe(calls)
  })

  it('outside the window of another conversation: selects it, walks older pages, highlights', async () => {
    const { acl, getTimeline } = fakeAcl({
      [k(A)]: { items: range('a', 1, 3, A) },
      [k(B)]: { items: range('b', 31, 60, B), nextCursor: cur('c1') },
      [k(B, '', 'c1')]: { items: range('b', 6, 30, B), nextCursor: cur('c2') },
      [k(B, '', 'c2')]: { items: range('b', 1, 5, B) },
    })
    const { result } = renderHook(() => useChat(acl))
    await waitFor(() => expect(result.current.messages).toHaveLength(3))
    act(() => result.current.jumpTo(hit(msg('b1', B))))
    expect(result.current.selectedId).toBe(B)
    expect(result.current.jump).toEqual({ target: mid('b1'), failed: false })
    await waitFor(() => expect(result.current.highlight?.id).toBe(mid('b1')))
    expect(result.current.jump).toBeUndefined()
    expect(result.current.messages.map((m) => m.id)).toEqual(range('b', 1, 60, B).map((m) => m.id))
    expect(result.current.canLoadOlder).toBe(false)
    expect(getTimeline).toHaveBeenCalledWith(B, { cursor: cur('c2') })
  })

  it(`gives up after ${JUMP_PAGE_LIMIT} older pages: the failure, no highlight`, async () => {
    const pages: Pages = { [k(A)]: { items: [msg('a1', A)], nextCursor: cur('p0') } }
    for (let i = 0; i < 40; i++) pages[k(A, '', `p${i}`)] = { items: [msg(`old${i}`, A)], nextCursor: cur(`p${i + 1}`) }
    const { acl, getTimeline } = fakeAcl(pages)
    const { result } = renderHook(() => useChat(acl))
    await waitFor(() => expect(result.current.messages).toHaveLength(1))
    act(() => result.current.jumpTo(hit(msg('never', A))))
    await waitFor(() => expect(result.current.jump).toEqual({ target: mid('never'), failed: true }))
    expect(result.current.highlight).toBeUndefined()
    const older = getTimeline.mock.calls.filter(([, o]) => o?.cursor !== undefined)
    expect(older).toHaveLength(JUMP_PAGE_LIMIT)
    // A selection by the user clears the failure.
    act(() => result.current.select(B))
    expect(result.current.jump).toBeUndefined()
  })

  it('a thread reply: getMessage for the root, the thread opens, its pages are walked', async () => {
    const reply = (n: number) => msg(`r${n}`, B, { threadParent: ROOT.id })
    const { acl, getMessage } = fakeAcl({
      [k(A)]: { items: [msg('a1', A)] },
      [k(B)]: { items: [ROOT] },
      [k(B, 'a-root')]: { items: [reply(3), reply(4)], nextCursor: cur('t1') },
      [k(B, 'a-root', 't1')]: { items: [reply(1), reply(2)] },
    })
    const { result } = renderHook(() => useChat(acl))
    await waitFor(() => expect(result.current.messages).toHaveLength(1))
    act(() => result.current.jumpTo(hit(reply(1))))
    await waitFor(() => expect(result.current.highlight?.id).toBe(mid('r1')))
    expect(getMessage).toHaveBeenCalledWith(B, ROOT.id)
    expect(result.current.selectedId).toBe(B)
    expect(result.current.threadRoot?.id).toBe(ROOT.id)
    expect(result.current.threadMessages.map((m) => m.id)).toEqual([1, 2, 3, 4].map((n) => mid(`r${n}`)))
    expect(result.current.jump).toBeUndefined()
  })

  it('a page that fails ends the jump in the failure — main timeline and thread', async () => {
    const { acl, getTimeline } = fakeAcl({ [k(A)]: { items: [msg('a1', A)] } })
    const base = getTimeline.getMockImplementation()!
    getTimeline.mockImplementation(async (id, o) => {
      if (id === B) throw new Error('page failed')
      return base(id, o)
    })
    const { result } = renderHook(() => useChat(acl))
    await waitFor(() => expect(result.current.messages).toHaveLength(1))
    act(() => result.current.jumpTo(hit(msg('b1', B))))
    await waitFor(() => expect(result.current.jump).toEqual({ target: mid('b1'), failed: true }))
    act(() => result.current.jumpTo(hit(msg('r1', B, { threadParent: ROOT.id }))))
    await waitFor(() => expect(result.current.jump).toEqual({ target: mid('r1'), failed: true }))
    expect(result.current.highlight).toBeUndefined()
  })

  it('a thread reply whose root cannot be read: the failure', async () => {
    const { acl } = fakeAcl({ [k(A)]: { items: [msg('a1', A)] } }, { root: undefined })
    const { result } = renderHook(() => useChat(acl))
    await waitFor(() => expect(result.current.messages).toHaveLength(1))
    act(() => result.current.jumpTo(hit(msg('r1', B, { threadParent: ROOT.id }))))
    await waitFor(() => expect(result.current.jump?.failed).toBe(true))
    expect(result.current.selectedId).toBe(A)
  })

  it('a selection by the user during the jump abandons it', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { acl, getTimeline } = fakeAcl({
      [k(A)]: { items: [msg('a1', A)] },
      [k(B)]: { items: [msg('b2', B)], nextCursor: cur('c1') },
      [k(B, '', 'c1')]: { items: [msg('b1', B)] },
    })
    const base = getTimeline.getMockImplementation()!
    getTimeline.mockImplementation(async (id, o) => {
      if (o?.cursor) await gate
      return base(id, o)
    })
    const { result } = renderHook(() => useChat(acl))
    await waitFor(() => expect(result.current.messages).toHaveLength(1))
    act(() => result.current.jumpTo(hit(msg('b1', B))))
    await waitFor(() => expect(getTimeline).toHaveBeenCalledWith(B, { cursor: cur('c1') }))
    act(() => result.current.select(A))
    expect(result.current.jump).toBeUndefined()
    await act(async () => release())
    expect(result.current.highlight).toBeUndefined()
  })
})

describe('the timeline side of a jump (§8 items 9–10)', () => {
  const wrap = (node: React.ReactNode) =>
    render(<MediaProvider resolve={async () => ({ url: '', release: () => {} })}>{node}</MediaProvider>)

  it('in flight: the pill, rows inert, the timeline not dimmed', () => {
    wrap(<Timeline messages={[msg('a1', A)]} usersById={{}} onLoadOlder={() => {}} jumping />)
    expect(screen.getByRole('status').textContent).toBe('Abrindo a mensagem…')
    const log = screen.getByRole('log', { name: copy.timeline.messages })
    expect(log.querySelector('.message__group')?.hasAttribute('inert')).toBe(true)
    expect(screen.getByText(copy.timeline.loadOlder).hasAttribute('inert')).toBe(true)
    expect(log.style.opacity).toBe('')
  })

  it('reached: data-highlight on the row until its animation ends', () => {
    const onEnd = vi.fn()
    const scroll = vi.fn()
    Element.prototype.scrollIntoView = scroll
    wrap(
      <Timeline
        messages={[msg('a1', A), msg('a2', A)]}
        usersById={{}}
        highlight={{ id: mid('a2'), seq: 1 }}
        onHighlightEnd={onEnd}
      />,
    )
    const rows = document.querySelectorAll('article.message')
    expect(rows[0]!.hasAttribute('data-highlight')).toBe(false)
    expect(rows[1]!.getAttribute('data-highlight')).toBe('true')
    expect(scroll).toHaveBeenCalledWith({ block: 'center' })
    // jsdom has no AnimationEvent: a plain animationend carrying the name, as the browser sends it.
    const end = (animationName: string) =>
      act(() => {
        rows[1]!.dispatchEvent(Object.assign(new Event('animationend', { bubbles: true }), { animationName }))
      })
    end('message-spin')
    expect(onEnd).not.toHaveBeenCalled()
    end('highlight-linger')
    expect(onEnd).toHaveBeenCalledTimes(1)
  })

  it('in the thread: the reply row carries the highlight', () => {
    wrap(
      <ThreadPanel
        root={ROOT}
        messages={[msg('r1', B, { threadParent: ROOT.id })]}
        usersById={{}}
        onClose={() => {}}
        onSend={() => {}}
        highlight={{ id: mid('r1'), seq: 1 }}
      />,
    )
    const replies = screen.getByRole('log', { name: copy.thread.replies })
    expect(replies.querySelector('article.message')?.getAttribute('data-highlight')).toBe('true')
  })
})
