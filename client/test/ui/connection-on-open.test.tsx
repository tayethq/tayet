// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup, waitFor, act } from '@testing-library/react'
import { App } from '../../src/ui/App'
import { applyLocale } from '../../src/ui/i18n/locale'
import type { Acl, Channel, ChannelId, ConnectionState, DomainEvent, User, UserId } from '../../src/acl'

// ADR-114 (Proposto) dec. 2: the screen reads the connection state from the ACL when it mounts and
// again right after subscribing. The connect resolves on the first sync, and the events that said the
// connection is good left before the screen subscribed — mounted on an ACL already connected, the
// shell shows neither the strip (narrow) nor the sidebar line (wide).

const cid = (s: string): ChannelId => s as unknown as ChannelId
const uid = (s: string): UserId => s as unknown as UserId
const me: User = { id: uid('@me:tayet.local'), displayName: 'Me', kind: 'member' }
const FIN: Channel = { id: cid('!fin:tayet.local'), name: '#financeiro', kind: 'public', memberCount: 3, unread: { count: 0, mentions: 0 } }

function fakeAcl(state: () => ConnectionState) {
  const globals = new Set<(e: DomainEvent) => void>()
  const acl = {
    getChannels: async () => [FIN],
    getArchivedChannels: async () => [],
    getChannel: async () => FIN,
    getMembers: async () => [{ user: me, role: 'admin', state: 'active' as const, self: true }],
    getPresence: () => 'offline' as const,
    getConnectionState: vi.fn(state),
    getChannelAbilities: () => ({ rename: false, editTopic: false, addPeople: false, removePeople: false, setRoles: false, archive: false }),
    getDevices: async () => [],
    currentUser: async () => me,
    getMyProfile: async () => ({ fullName: me.displayName }),
    getAccountPreferences: async () => ({}),
    setAccountPreferences: async () => {},
    getThreadUnread: async () => ({ unread: false }),
    searchMessages: async () => [],
    getMessage: async () => undefined,
    getTimeline: async () => ({ items: [] }),
    subscribe: (fn: (e: DomainEvent) => void) => {
      globals.add(fn)
      return () => globals.delete(fn)
    },
    subscribeChannel: () => () => {},
    watchAwaitingApprovals: () => () => {},
    markRead: async () => {},
  } as unknown as Acl
  const emit = (e: DomainEvent) => act(() => globals.forEach((fn) => fn(e)))
  return { acl, emit, globals }
}

let narrow = true
beforeEach(() => {
  narrow = true
  applyLocale('pt-BR')
  window.history.replaceState(null, '')
  vi.stubGlobal('matchMedia', (q: string) => ({
    get matches() {
      return q === '(width < 728px)' ? narrow : false
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function mount(state: () => ConnectionState, wide = false) {
  if (wide) narrow = false
  const f = fakeAcl(state)
  const r = render(<App acl={f.acl} onSignOut={() => {}} />)
  await waitFor(() => expect(r.container.querySelector('.channel')).not.toBeNull())
  return { ...f, ...r }
}
const strip = (c: HTMLElement) => c.querySelector('.connection-strip')
const line = (c: HTMLElement) => c.querySelector('.sidebar .connection')

describe('ADR-114 — the shell mounted on an ACL already connected', () => {
  it('narrow: no connection strip', async () => {
    const { container } = await mount(() => 'connected')
    expect(strip(container)).toBeNull()
  })

  it('wide: no connection line in the sidebar', async () => {
    const { container } = await mount(() => 'connected', true)
    expect(line(container)).toBeNull()
    expect(strip(container)).toBeNull()
  })

  it('a state reported between the first render and the subscribe is read again after subscribing', async () => {
    // 'connecting' for the first render, 'connected' by the time the stream is subscribed.
    let state: ConnectionState = 'connecting'
    const f = fakeAcl(() => state)
    const realSubscribe = f.acl.subscribe
    ;(f.acl as { subscribe: Acl['subscribe'] }).subscribe = (fn) => {
      state = 'connected'
      return realSubscribe(fn)
    }
    const { container } = render(<App acl={f.acl} onSignOut={() => {}} />)
    await waitFor(() => expect(container.querySelector('.channel')).not.toBeNull())
    expect(strip(container)).toBeNull()
  })

  it('control: an ACL still connecting shows the strip, and the stream still moves it', async () => {
    const { container, emit } = await mount(() => 'connecting')
    expect(strip(container)).not.toBeNull()
    emit({ t: 'connection.changed', state: 'connected' } as DomainEvent)
    expect(strip(container)).toBeNull()
  })
})
