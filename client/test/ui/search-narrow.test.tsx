// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup, fireEvent, waitFor, within, act, screen } from '@testing-library/react'
import { App } from '../../src/ui/App'
import { watchSearchState } from '../../src/ui/search-state'
import type { Acl, Channel, ChannelId, DomainEvent, Message, MessageId, SearchHit, User, UserId } from '../../src/acl'
import { copy, fill } from '../support/copy'

// PLANO-MOBILE M6 B1 to B4 (workspace.md §23.5 item 3): below 728px the search is a screen of the stack
// between the list and the conversation. Driven through App on jsdom's history, with a fake ACL.

const cid = (s: string): ChannelId => s as unknown as ChannelId
const uid = (s: string): UserId => s as unknown as UserId
const mid = (s: string): MessageId => s as unknown as MessageId

const me: User = { id: uid('@me:tayet.local'), displayName: 'Me', kind: 'member' }
const rita: User = { id: uid('@rita:tayet.local'), displayName: 'Rita', kind: 'member' }
const A: Channel = { id: cid('!a:tayet.local'), name: '#all', kind: 'public', memberCount: 2, unread: { count: 0, mentions: 0 } }
const B: Channel = { id: cid('!b:tayet.local'), name: '#obra', kind: 'public', memberCount: 2, unread: { count: 0, mentions: 0 } }

const msg = (id: string, channel: Channel, over: Partial<Message> = {}): Message => ({
  id: mid(id),
  channelId: channel.id,
  author: rita.id,
  body: { kind: 'text', text: `nota ${id}` },
  sentAt: Date.now() as never,
  reactions: [],
  mine: false,
  mentionsMe: false,
  ...over,
})
const ROOT = msg('root', B)
const IN_B = msg('b1', B)
const IN_THREAD = msg('t1', B, { threadParent: ROOT.id })
const MISSING = msg('gone', B)
const hitOf = (m: Message): SearchHit => ({ message: m, channel: m.channelId, excerpt: { before: '', match: 'nota', after: ` ${m.id as unknown as string}` } })

type Opts = { hits?: Message[] }

function fakeAcl(opts: Opts = {}) {
  const globals = new Set<(e: DomainEvent) => void>()
  const searchMessages = vi.fn(async () => (opts.hits ?? [IN_B, IN_THREAD, MISSING]).map(hitOf))
  const acl = {
    getChannels: async () => [A, B],
    getArchivedChannels: async () => [],
    getChannel: async (id: ChannelId) => (id === A.id ? A : B),
    getMembers: async () => [
      { user: me, role: 'admin', state: 'active' as const, self: true },
      { user: rita, role: 'member', state: 'active' as const, self: false },
    ],
    getPresence: () => 'offline' as const,
    getConnectionState: () => 'connecting' as const,
    getChannelAbilities: () => ({ rename: false, editTopic: false, addPeople: false, removePeople: false, setRoles: false, archive: false }),
    getDevices: async () => [],
    currentUser: async () => me,
    getMyProfile: async () => ({ fullName: me.displayName }),
    getAccountPreferences: async () => ({}),
    setAccountPreferences: async () => {},
    getThreadUnread: async () => ({ unread: false }),
    searchMessages,
    getMessage: async (_c: ChannelId, id: MessageId) => (id === ROOT.id ? ROOT : undefined),
    // The missing message is never in a page: the jump walks nothing (no cursor) and gives up.
    getTimeline: async (id: ChannelId, o?: { thread?: MessageId }) =>
      o?.thread ? { items: [IN_THREAD] } : { items: id === B.id ? [ROOT, IN_B] : [] },
    subscribe: (fn: (e: DomainEvent) => void) => {
      globals.add(fn)
      return () => globals.delete(fn)
    },
    subscribeChannel: () => () => {},
    // The narrow shell observes "Aguardando você" (M9b V1); nothing pending here.
    watchAwaitingApprovals: () => () => {},
    markRead: async () => {},
  } as unknown as Acl
  const emit = (e: DomainEvent) => act(() => globals.forEach((fn) => fn(e)))
  return { acl, searchMessages, emit }
}

let narrow = true
let coarse = false
const listeners = new Set<() => void>()
beforeEach(() => {
  narrow = true
  coarse = false
  window.history.replaceState(null, '')
  vi.stubGlobal('matchMedia', (q: string) => ({
    get matches() {
      return q === '(pointer: coarse)' ? coarse : q === '(width < 728px)' ? narrow : false
    },
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  }))
})
afterEach(() => {
  cleanup()
  listeners.clear()
  vi.unstubAllGlobals()
})

const setNarrow = (on: boolean) =>
  act(() => {
    narrow = on
    listeners.forEach((fn) => fn())
  })
const back = async () => {
  await act(async () => {
    window.history.back()
    await new Promise((r) => setTimeout(r, 20))
  })
}
const workspace = (c: HTMLElement) => c.querySelector<HTMLElement>('.workspace')!
const searchScreen = (c: HTMLElement) => c.querySelector<HTMLElement>('.search-screen')!
const field = (c: HTMLElement) => within(searchScreen(c)).getByRole('textbox', { name: copy.search.field })

async function mount(opts: Opts = {}) {
  const f = fakeAcl(opts)
  watchSearchState(f.acl)
  const r = render(<App acl={f.acl} onSignOut={() => {}} />)
  await waitFor(() => expect(r.container.querySelector('.channel')).not.toBeNull())
  return { ...f, ...r }
}
async function openAndQuery(c: HTMLElement, q = 'nota') {
  fireEvent.click(within(c.querySelector('.sidebar')!).getByRole('button', { name: copy.search.field }))
  fireEvent.change(field(c), { target: { value: q } })
  await waitFor(() => expect(within(searchScreen(c)).getAllByRole('button', { name: /^Rita:/ }).length).toBeGreaterThan(0))
}

describe('narrow search: the list and the screen (B1)', () => {
  it('the list has a button, not a field; it opens the screen with the field focused and the hint', async () => {
    const { container } = await mount()
    const sidebar = container.querySelector<HTMLElement>('.sidebar')!
    expect(within(sidebar).queryByRole('textbox')).toBeNull()
    expect(sidebar.querySelector('.search__kbd')).toBeNull()
    fireEvent.click(within(sidebar).getByRole('button', { name: copy.search.field }))
    expect(workspace(container).dataset.stack).toBe('search')
    expect(searchScreen(container).hasAttribute('inert')).toBe(false)
    expect(document.activeElement).toBe(field(container))
    expect(field(container).getAttribute('enterkeyhint')).toBe('search')
    expect(within(searchScreen(container)).getByText(copy.search.hint)).toBeTruthy()
    // No chip and no ⌘K hint on the narrow field.
    expect(searchScreen(container).querySelector('.search__chip, .search__kbd')).toBeNull()
  })

  it('with a query: the count, the hits on the screen, no "limpar", the ✕ clears', async () => {
    const { container } = await mount()
    await openAndQuery(container)
    const s = searchScreen(container)
    expect(within(s).getByText(fill(copy.search.results.other, { n: 3 }))).toBeTruthy()
    expect(within(s).queryByRole('button', { name: copy.search.clearShort })).toBeNull()
    expect(within(s).queryByText(copy.search.hint)).toBeNull()
    fireEvent.click(within(s).getByRole('button', { name: copy.search.clear }))
    expect((field(container) as HTMLInputElement).value).toBe('')
    expect(within(s).getByText(copy.search.hint)).toBeTruthy()
  })

  it('preparing, nothing found and partial coverage in its footer outside the scroll', async () => {
    const { container, emit } = await mount({ hits: [] })
    emit({ t: 'search.state', preparing: true, partial: true, persisting: false, degraded: false } as DomainEvent)
    fireEvent.click(within(container.querySelector('.sidebar')!).getByRole('button', { name: copy.search.field }))
    fireEvent.change(field(container), { target: { value: 'zzz' } })
    const s = searchScreen(container)
    await waitFor(() => expect(within(s).getByText(fill(copy.search.nothingFound, { query: 'zzz' }))).toBeTruthy())
    expect(within(s).getByText(copy.search.preparing)).toBeTruthy()
    const footer = s.querySelector('.sidebar__coverage')!
    expect(footer.textContent).toBe(copy.search.partial)
    expect(footer.parentElement).toBe(s)
    expect(s.querySelector('.search-screen__body')!.contains(footer)).toBe(false)
  })

  it('a hit opens the conversation with the message marked; back finds the search, its results and the hit selected; back again finds the list without a query', async () => {
    const { container } = await mount()
    await openAndQuery(container)
    fireEvent.click(within(searchScreen(container)).getAllByRole('button', { name: /^Rita:/ })[0]!)
    await waitFor(() => expect(workspace(container).dataset.stack).toBe('chat'))
    await waitFor(() => expect(container.querySelector('.main [data-highlight]')).not.toBeNull())
    expect(searchScreen(container).hasAttribute('inert')).toBe(true)
    await back()
    await waitFor(() => expect(workspace(container).dataset.stack).toBe('search'))
    expect((field(container) as HTMLInputElement).value).toBe('nota')
    const first = within(searchScreen(container)).getAllByRole('button', { name: /^Rita:/ })[0]!
    expect(first.getAttribute('aria-current')).toBe('true')
    await back()
    await waitFor(() => expect(workspace(container).dataset.stack).toBe('list'))
    fireEvent.click(within(container.querySelector('.sidebar')!).getByRole('button', { name: copy.search.field }))
    expect((field(container) as HTMLInputElement).value).toBe('')
  })
})

describe('narrow search: the jump (B2, B3)', () => {
  it('a failed jump comes back to the search by itself, with the failure on its hit', async () => {
    const { container } = await mount()
    await openAndQuery(container)
    const hits = within(searchScreen(container)).getAllByRole('button', { name: /^Rita:/ })
    fireEvent.click(hits[2]!)
    await waitFor(() => expect(workspace(container).dataset.stack).toBe('search'))
    await waitFor(() => expect(within(searchScreen(container)).getByText(copy.search.openFailed)).toBeTruthy())
    expect((field(container) as HTMLInputElement).value).toBe('nota')
  })

  it('a hit in a thread opens the conversation and the thread over it; back goes through the conversation, then the search', async () => {
    const { container } = await mount()
    await openAndQuery(container)
    fireEvent.click(within(searchScreen(container)).getAllByRole('button', { name: /^Rita:/ })[1]!)
    await waitFor(() => expect(workspace(container).dataset.stack).toBe('thread'))
    await waitFor(() => expect(container.querySelector('.thread-panel [data-highlight]')).not.toBeNull())
    await back()
    await waitFor(() => expect(workspace(container).dataset.stack).toBe('chat'))
    await act(async () => { await new Promise((r) => setTimeout(r, 50)) })
    console.log('DBG', JSON.stringify(window.history.state), window.history.length)
    await back()
    console.log('DBG2', JSON.stringify(window.history.state), workspace(container).dataset.stack)
    await waitFor(() => expect(workspace(container).dataset.stack).toBe('search'))
  })
})

describe('narrow search: Enter (B4)', () => {
  it('coarse pointer: Enter lets the field go and opens nothing', async () => {
    coarse = true
    const { container } = await mount()
    await openAndQuery(container)
    field(container).focus()
    fireEvent.keyDown(field(container), { key: 'Enter' })
    expect(document.activeElement).not.toBe(field(container))
    expect(workspace(container).dataset.stack).toBe('search')
  })

  it('fine pointer: Enter opens the first result', async () => {
    const { container } = await mount()
    await openAndQuery(container)
    fireEvent.keyDown(field(container), { key: 'Enter' })
    await waitFor(() => expect(workspace(container).dataset.stack).toBe('chat'))
  })
})

describe('narrow search: the width and ⌘K', () => {
  it('narrowing with a query opens the screen with it, under the open conversation (ADR-106 dec. 7); widening keeps it in the column', async () => {
    narrow = false
    const { container } = await mount()
    const sidebar = container.querySelector<HTMLElement>('.sidebar')!
    fireEvent.change(within(sidebar).getByRole('textbox', { name: copy.search.field }), { target: { value: 'nota' } })
    await waitFor(() => expect(within(sidebar).getAllByRole('button', { name: /^Rita:/ }).length).toBeGreaterThan(0))
    setNarrow(true)
    // The wide window always has a conversation open: it stays in front, the search under it.
    await waitFor(() => expect(workspace(container).dataset.stack).toBe('chat'))
    // The history settles with the search under the conversation.
    await waitFor(() => expect(window.history.state).toEqual({ tayet: 'stack', screen: 'chat', depth: 2 }))
    await back()
    await waitFor(() => expect(workspace(container).dataset.stack).toBe('search'))
    expect((field(container) as HTMLInputElement).value).toBe('nota')
    setNarrow(false)
    await waitFor(() => expect(container.querySelector('.search-screen')).toBeNull())
    expect((within(container.querySelector('.sidebar')!).getByRole('textbox', { name: copy.search.field }) as HTMLInputElement).value).toBe('nota')
  })

  it('a scope on goes off when the window narrows, and the chip is not offered', async () => {
    narrow = false
    const { container, searchMessages } = await mount()
    await waitFor(() => expect(container.querySelector('.main .channel-header')).not.toBeNull())
    const sidebar = container.querySelector<HTMLElement>('.sidebar')!
    fireEvent.change(within(sidebar).getByRole('textbox', { name: copy.search.field }), { target: { value: 'nota' } })
    fireEvent.click(within(sidebar).getByRole('button', { name: copy.search.scoped }))
    await waitFor(() => expect(searchMessages).toHaveBeenLastCalledWith('nota', expect.objectContaining({ channel: A.id })))
    setNarrow(true)
    await waitFor(() => expect(searchMessages).toHaveBeenLastCalledWith('nota', undefined))
    expect(container.querySelector('.search__chip')).toBeNull()
  })

  it('⌘K on the narrow list opens the screen with the field focused', async () => {
    const { container } = await mount()
    fireEvent.keyDown(document, { key: 'k', metaKey: true })
    await waitFor(() => expect(workspace(container).dataset.stack).toBe('search'))
    await waitFor(() => expect(document.activeElement).toBe(field(container)))
  })

  it('the connection strip sits under the screen header', async () => {
    const { container, emit } = await mount()
    emit({ t: 'connection', state: 'offline' } as unknown as DomainEvent)
    fireEvent.click(within(container.querySelector('.sidebar')!).getByRole('button', { name: copy.search.field }))
    const s = searchScreen(container)
    await waitFor(() => expect(s.querySelector('.connection-strip')).not.toBeNull())
    expect(s.querySelector('.search-screen__header')!.nextElementSibling).toBe(s.querySelector('.connection-strip'))
    expect(screen.getAllByRole('status').length).toBeGreaterThan(0)
  })
})
