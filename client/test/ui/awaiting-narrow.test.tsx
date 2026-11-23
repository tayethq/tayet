// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup, fireEvent, waitFor, within, act } from '@testing-library/react'
import { App } from '../../src/ui/App'
import { awaitingSummary } from '../../src/ui/useAwaiting'
import { originTime } from '../../src/ui/components/AwaitingScreen'
import { timeOf } from '../../src/ui/components/Timeline'
import { whenOf } from '../../src/ui/components/SearchResults'
import { applyLocale } from '../../src/ui/i18n/locale'
import { en } from '../../src/ui/i18n/en'
import type { Acl, AwaitingApproval, Channel, ChannelId, DomainEvent, Message, MessageId, User, UserId } from '../../src/acl'
import { copy, fill } from '../support/copy'

// "Aguardando você" on the narrow window (workspace.md §23.2 item 5, §23.4; PLANO-MOBILE §0.20). Driven through
// App on jsdom's history, with a fake ACL whose read emits what each test says.

const cid = (s: string): ChannelId => s as unknown as ChannelId
const uid = (s: string): UserId => s as unknown as UserId
const mid = (s: string): MessageId => s as unknown as MessageId

const me: User = { id: uid('@me:tayet.local'), displayName: 'Me', kind: 'member' }
const FIN: Channel = { id: cid('!fin:tayet.local'), name: '#financeiro', kind: 'public', memberCount: 3, unread: { count: 0, mentions: 0 } }
const DM: Channel = { id: cid('!dm:tayet.local'), name: 'Atlas', kind: 'dm', memberCount: 2, unread: { count: 0, mentions: 0 } }
const GRP: Channel = { id: cid('!grp:tayet.local'), name: 'Ana, Bruno', kind: 'group', memberCount: 4, unread: { count: 0, mentions: 0 } }

const agents = {
  ledger: { id: uid('@a-ledger:tayet.local'), name: 'Ledger', color: 'ocre' as const },
  atlas: { id: uid('@a-atlas:tayet.local'), name: 'Atlas', color: 'ardosia' as const },
  scout: { id: uid('@a-scout:tayet.local'), name: 'Scout', color: 'salvia' as const },
}

let clock = 1_000_000
const card = (id: string, channel: Channel, agent: (typeof agents)[keyof typeof agents], over: Partial<Message> = {}): Message => ({
  id: mid(id),
  channelId: channel.id,
  author: agent.id,
  authorAt: { name: agent.name, agent: true, color: agent.color },
  body: {
    kind: 'approval',
    text: `pedido ${id}`,
    options: [
      { id: 'yes', label: 'Aprovar', style: 'primary' },
      { id: 'no', label: 'Recusar' },
    ],
    state: { kind: 'open' },
  },
  sentAt: (clock += 1000) as never,
  reactions: [],
  mine: false,
  mentionsMe: false,
  ...over,
})
const item = (m: Message): AwaitingApproval => ({ message: m, channel: m.channelId })
const withState = (m: Message, state: Extract<Message['body'], { kind: 'approval' }>['state']): Message =>
  ({ ...m, body: { ...(m.body as Extract<Message['body'], { kind: 'approval' }>), state } })

const C1 = card('c1', FIN, agents.ledger)
const C2 = card('c2', DM, agents.atlas)
const C3 = card('c3', GRP, agents.scout)

function fakeAcl() {
  const globals = new Set<(e: DomainEvent) => void>()
  const calls: string[] = []
  let watching = 0
  const watchAwaitingApprovals = vi.fn(() => {
    calls.push(`watch:${globals.size}`)
    watching += 1
    return () => {
      watching -= 1
    }
  })
  const answerApproval = vi.fn(async () => {})
  const acl = {
    getChannels: async () => [FIN, DM, GRP],
    getArchivedChannels: async () => [],
    getChannel: async (id: ChannelId) => [FIN, DM, GRP].find((c) => c.id === id),
    getMembers: async () => [{ user: me, role: 'admin', state: 'active' as const, self: true }],
    getPresence: () => 'offline' as const,
    getDevices: async () => [],
    currentUser: async () => me,
    getMyProfile: async () => ({ fullName: me.displayName }),
    getAccountPreferences: async () => ({}),
    setAccountPreferences: async () => {},
    getThreadUnread: async () => ({ unread: false }),
    searchMessages: async () => [],
    getMessage: async () => undefined,
    getTimeline: async (id: ChannelId) => ({ items: [C1, C2, C3].filter((m) => m.channelId === id) }),
    subscribe: (fn: (e: DomainEvent) => void) => {
      globals.add(fn)
      return () => globals.delete(fn)
    },
    subscribeChannel: () => () => {},
    watchAwaitingApprovals,
    answerApproval,
    markRead: async () => {},
  } as unknown as Acl
  const emit = (e: DomainEvent) => act(() => globals.forEach((fn) => fn(e)))
  const awaiting = (...ms: Message[]) => emit({ t: 'approvals.awaiting', items: ms.map(item) })
  return { acl, emit, awaiting, watchAwaitingApprovals, answerApproval, calls, globals, watching: () => watching }
}

let narrow = true
const listeners = new Set<() => void>()
beforeEach(() => {
  narrow = true
  applyLocale('pt-BR')
  window.history.replaceState(null, '')
  vi.stubGlobal('matchMedia', (q: string) => ({
    get matches() {
      return q === '(width < 728px)' ? narrow : false
    },
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  }))
})
afterEach(() => {
  cleanup()
  listeners.clear()
  vi.unstubAllGlobals()
  applyLocale('pt-BR')
})

// The width change and what the shell loads after it, inside act.
const setNarrow = async (on: boolean) => {
  await act(async () => {
    narrow = on
    listeners.forEach((fn) => fn())
    await new Promise((r) => setTimeout(r, 20))
  })
}
const back = async () => {
  await act(async () => {
    window.history.back()
    await new Promise((r) => setTimeout(r, 20))
  })
}
const workspace = (c: HTMLElement) => c.querySelector<HTMLElement>('.workspace')!
const row = (c: HTMLElement) => c.querySelector<HTMLElement>('.sidebar .awaiting-row__button')
const screen = (c: HTMLElement) => c.querySelector<HTMLElement>('.awaiting-screen')
const cards = (c: HTMLElement) => [...screen(c)!.querySelectorAll<HTMLElement>('.approval')]
const summaryOf = (n: number, list: string) => fill(n === 1 ? copy.awaiting.summary.one : copy.awaiting.summary.other, { n, agents: list })

async function mount(wide = false) {
  if (wide) narrow = false
  const f = fakeAcl()
  const r = render(<App acl={f.acl} onSignOut={() => {}} />)
  await waitFor(() => expect(r.container.querySelector('.channel')).not.toBeNull())
  return { ...f, ...r }
}
async function openScreen(c: HTMLElement) {
  fireEvent.click(row(c)!)
  await waitFor(() => expect(workspace(c).dataset.stack).toBe('awaiting'))
}

describe('the observer (V1)', () => {
  it('one observer, subscribed before the watch, only while the window is narrow; it comes and goes with the width', async () => {
    const f = await mount()
    expect(f.watchAwaitingApprovals).toHaveBeenCalledTimes(1)
    // The stream was subscribed before the watch (the shell's other subscribers come first too).
    expect(f.calls[0]).not.toBe('watch:0')
    expect(f.watching()).toBe(1)
    await setNarrow(false)
    expect(f.watching()).toBe(0)
    await setNarrow(true)
    expect(f.watchAwaitingApprovals).toHaveBeenCalledTimes(2)
    expect(f.watching()).toBe(1)
  })

  it('a wide window never observes', async () => {
    const f = await mount(true)
    expect(f.watchAwaitingApprovals).not.toHaveBeenCalled()
  })
})

describe('the row on the list (§23.2 item 5; V4, V7)', () => {
  it('no row before the first list, none with an empty one; with items, the count and the summary', async () => {
    const { container, awaiting } = await mount()
    expect(row(container)).toBeNull()
    awaiting()
    expect(row(container)).toBeNull()
    awaiting(C2, C1)
    const r = row(container)!
    expect(r.querySelector('.awaiting-row__count')!.textContent).toBe('2')
    expect(within(r).getByText(copy.awaiting.title)).toBeTruthy()
    expect(r.querySelector('.awaiting-row__summary')!.textContent).toBe(summaryOf(2, 'Atlas e Ledger'))
    // Under the notice, above the sections.
    expect(r.closest('.channel-list')!.querySelector('.channel-list__section')!.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy()
  })

  it('crossing to wide takes the row away', async () => {
    const { container, awaiting } = await mount()
    awaiting(C1)
    expect(row(container)).not.toBeNull()
    await setNarrow(false)
    expect(row(container)).toBeNull()
  })
})

describe('the summary (V5)', () => {
  const list = (...ms: Message[]) => ms.map(item)
  it('pt-BR: plural, the agents in the list order, a repeated agent once', () => {
    applyLocale('pt-BR')
    expect(awaitingSummary(list(C1), {})).toBe(fill(copy.awaiting.summary.one, { n: 1, agents: 'Ledger' }))
    expect(awaitingSummary(list(C1, C2), {})).toBe(fill(copy.awaiting.summary.other, { n: 2, agents: 'Ledger e Atlas' }))
    expect(awaitingSummary(list(C1, C2, C3), {})).toBe(fill(copy.awaiting.summary.other, { n: 3, agents: 'Ledger, Atlas e Scout' }))
    const again = card('c4', FIN, agents.ledger)
    expect(awaitingSummary(list(C1, again), {})).toBe(fill(copy.awaiting.summary.other, { n: 2, agents: 'Ledger' }))
  })

  it('English: the same rules', () => {
    applyLocale('en')
    expect(awaitingSummary(list(C1), {})).toBe(fill(en.awaiting.summary.one, { n: 1, agents: 'Ledger' }))
    expect(awaitingSummary(list(C1, C2), {})).toBe(fill(en.awaiting.summary.other, { n: 2, agents: 'Ledger and Atlas' }))
    expect(awaitingSummary(list(C1, C2, C3), {})).toBe(fill(en.awaiting.summary.other, { n: 3, agents: 'Ledger, Atlas, and Scout' }))
    const again = card('c5', FIN, agents.ledger)
    expect(awaitingSummary(list(C1, again), {})).toBe(fill(en.awaiting.summary.other, { n: 2, agents: 'Ledger' }))
  })
})

describe('the origin time (F2)', () => {
  const now = new Date(2026, 10, 22, 15, 0).getTime()
  const today = new Date(2026, 10, 22, 9, 24).getTime()
  const before = new Date(2026, 10, 18, 9, 24).getTime()
  for (const lang of ['pt-BR', 'en'] as const) {
    it(`${lang}: today only the time, the timeline's; another day, the search result's`, () => {
      applyLocale(lang)
      expect(originTime(today, now)).toBe(timeOf(today as never))
      expect(originTime(today, now)).toBe('09:24')
      expect(originTime(before, now)).toBe(whenOf(before, now))
      expect(originTime(before, now)).not.toBe('09:24')
    })
  }
})

describe('the screen (§23.4; V2, V3, V4, V6, W5)', () => {
  it('opens on the stack with the focus on its back; the header has the title and the summary; one card per item, newest first, with its origin', async () => {
    const { container, awaiting } = await mount()
    awaiting(C3, C2, C1)
    await openScreen(container)
    const s = screen(container)!
    expect(s.hasAttribute('inert')).toBe(false)
    expect(document.activeElement).toBe(within(s).getByRole('button', { name: copy.dialog.back }))
    expect(within(s).getByRole('heading', { name: copy.awaiting.title })).toBeTruthy()
    expect(s.querySelector('.ui-screen-header__subtitle')!.textContent).toBe(summaryOf(3, 'Scout, Atlas e Ledger'))
    const where = cards(container).map((c) => c.querySelector('.awaiting-origin__where')!.textContent)
    expect(where).toEqual([
      fill(copy.awaiting.inChannel, { channel: 'Ana, Bruno' }),
      fill(copy.awaiting.inConversationWith, { agent: 'Atlas' }),
      fill(copy.awaiting.inChannel, { channel: '#financeiro' }),
    ])
    expect(cards(container)[0]!.querySelector('.awaiting-origin__agent')!.textContent).toBe('Scout')
  })

  it('a button answers from the screen', async () => {
    const { container, awaiting, answerApproval } = await mount()
    awaiting(C1)
    await openScreen(container)
    fireEvent.click(within(cards(container)[0]!).getByRole('button', { name: 'Aprovar' }))
    expect(answerApproval).toHaveBeenCalledWith(C1.id, 'yes')
  })

  it('an answered card stays in place while the counts drop; with zero the subtitle goes and the screen stays', async () => {
    const { container, awaiting, emit } = await mount()
    awaiting(C2, C1)
    await openScreen(container)
    emit({ t: 'message.edited', channelId: C1.channelId, message: withState(C1, { kind: 'answered', by: me.id, at: 5 as never, option: 'yes' }) })
    awaiting(C2)
    expect(cards(container)).toHaveLength(2)
    expect(cards(container)[1]!.querySelector('.approval__by')!.textContent).toContain(copy.timeline.you)
    expect(within(cards(container)[1]!).queryByRole('button', { name: 'Aprovar' })).toBeNull()
    expect(screen(container)!.querySelector('.ui-screen-header__subtitle')!.textContent).toBe(summaryOf(1, 'Atlas'))
    awaiting()
    expect(cards(container)).toHaveLength(2)
    expect(screen(container)!.querySelector('.ui-screen-header__subtitle')).toBeNull()
    expect(workspace(container).dataset.stack).toBe('awaiting')
  })

  it('a card not sent stays with "Tentar de novo", which answers again', async () => {
    const { container, awaiting, emit, answerApproval } = await mount()
    awaiting(C1)
    await openScreen(container)
    emit({ t: 'message.edited', channelId: C1.channelId, message: withState(C1, { kind: 'failed', option: 'no' }) })
    awaiting()
    const c = cards(container)[0]!
    expect(within(c).getByText(copy.timeline.failed)).toBeTruthy()
    fireEvent.click(within(c).getByRole('button', { name: copy.timeline.retry }))
    expect(answerApproval).toHaveBeenCalledWith(C1.id, 'no')
  })

  it('a deleted card goes at once; a new one comes in, in order', async () => {
    const { container, awaiting, emit } = await mount()
    awaiting(C2, C1)
    await openScreen(container)
    emit({ t: 'message.removed', channelId: C2.channelId, messageId: C2.id })
    expect(cards(container)).toHaveLength(1)
    awaiting(C3, C1)
    expect(cards(container).map((c) => c.querySelector('.awaiting-origin__agent')!.textContent)).toEqual(['Scout', 'Ledger'])
  })

  it('what the screen held goes when it leaves the stack: reopened, the ACL list holds', async () => {
    const { container, awaiting, emit } = await mount()
    awaiting(C2, C1)
    await openScreen(container)
    emit({ t: 'message.edited', channelId: C1.channelId, message: withState(C1, { kind: 'answered', by: me.id, at: 5 as never, option: 'yes' }) })
    awaiting(C2)
    expect(cards(container)).toHaveLength(2)
    await back()
    await waitFor(() => expect(workspace(container).dataset.stack).toBe('list'))
    expect(screen(container)).toBeNull()
    expect(document.activeElement).toBe(row(container))
    await openScreen(container)
    expect(cards(container)).toHaveLength(1)
  })

  it('reached with nothing pending, it goes back to the list (V4)', async () => {
    const { container, awaiting, globals } = await mount()
    awaiting(C1)
    const r = row(container)!
    act(() => {
      fireEvent.click(r)
      globals.forEach((fn) => fn({ t: 'approvals.awaiting', items: [] }))
    })
    await waitFor(() => expect(workspace(container).dataset.stack).toBe('list'))
    expect(screen(container)).toBeNull()
  })

  it('its last card deleted with the screen open, it goes back to the list (F1)', async () => {
    const { container, awaiting, emit } = await mount()
    awaiting(C2, C1)
    await openScreen(container)
    emit({ t: 'message.removed', channelId: C2.channelId, messageId: C2.id })
    expect(workspace(container).dataset.stack).toBe('awaiting')
    emit({ t: 'message.removed', channelId: C1.channelId, messageId: C1.id })
    awaiting()
    await waitFor(() => expect(workspace(container).dataset.stack).toBe('list'))
    expect(screen(container)).toBeNull()
  })

  it('its last card answered, it stays (V4, F1)', async () => {
    const { container, awaiting, emit } = await mount()
    awaiting(C1)
    await openScreen(container)
    emit({ t: 'message.edited', channelId: C1.channelId, message: withState(C1, { kind: 'answered', by: me.id, at: 5 as never, option: 'yes' }) })
    awaiting()
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(workspace(container).dataset.stack).toBe('awaiting')
    expect(cards(container)).toHaveLength(1)
  })

  it('the connection strip sits under the header (W5)', async () => {
    const { container, awaiting, emit } = await mount()
    awaiting(C1)
    await openScreen(container)
    emit({ t: 'connection.changed', state: 'offline' } as DomainEvent)
    const header = screen(container)!.querySelector('.ui-screen-header')!
    expect(header.nextElementSibling!.classList.contains('connection-strip')).toBe(true)
    expect(header.nextElementSibling!.textContent).toBe(copy.shell.offline)
  })

  it('the origin opens the conversation with the card marked; back finds the screen, back again the list', async () => {
    const { container, awaiting } = await mount()
    awaiting(C2, C1)
    await openScreen(container)
    fireEvent.click(cards(container)[1]!.querySelector('.awaiting-origin')!)
    await waitFor(() => expect(workspace(container).dataset.stack).toBe('chat'))
    await waitFor(() => expect(container.querySelector('.main [data-highlight]')).not.toBeNull())
    expect(container.querySelector('.main [data-highlight]')!.textContent).toContain('pedido c1')
    expect(screen(container)!.hasAttribute('inert')).toBe(true)
    await back()
    await waitFor(() => expect(workspace(container).dataset.stack).toBe('awaiting'))
    expect(cards(container)).toHaveLength(2)
    await back()
    await waitFor(() => expect(workspace(container).dataset.stack).toBe('list'))
  })

  it('crossing to wide closes the screen', async () => {
    const { container, awaiting } = await mount()
    awaiting(C1)
    await openScreen(container)
    await setNarrow(false)
    await waitFor(() => expect(screen(container)).toBeNull())
  })
})
