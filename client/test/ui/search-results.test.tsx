// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, within, act } from '@testing-library/react'
import type { Acl, Channel, ChannelId, DomainEvent, Message, MessageId, SearchHit, UserId } from '@tayet/client'
import { Workspace } from '../../src/ui/components/Workspace'
import { MediaProvider } from '../../src/ui/MediaContext'
import { useSearch, SEARCH_DEBOUNCE_MS } from '../../src/ui/useSearch'
import { watchSearchState } from '../../src/ui/search-state'
import { whenOf } from '../../src/ui/components/SearchResults'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { copy } from '../support/copy'

// Manifest workspace.md §8 items 4–8 (U3/U4/U8): results replace the list's sections while there is a
// query; header + flat list; empty, preparing and partial states; vocabulary and P1. A fake Acl serves
// searchMessages and the search.state stream; ids are protocol-shaped on purpose, so a leak would show.

const cid = (s: string) => s as unknown as ChannelId
const uid = (s: string) => s as unknown as UserId
const mid = (s: string) => s as unknown as MessageId

const DM = cid('!dm:tayet.local')
const PRIV = cid('!priv:tayet.local')
const RITA = uid('@rita:tayet.local')
const QUIM = uid('@quim:tayet.local')
const ANA = uid('@ana:tayet.local')

const CHANNELS: Channel[] = [
  { id: PRIV, kind: 'private', name: '#liderança', memberCount: 2, unread: { count: 0, mentions: 0 } },
  { id: DM, kind: 'dm', name: 'rita', memberCount: 2, unread: { count: 0, mentions: 0 }, peer: RITA },
]

const msg = (id: string, channelId: ChannelId, over: Partial<Message> = {}): Message => ({
  id: mid(id),
  channelId,
  author: RITA,
  body: { kind: 'text', text: 'Subi o protótipo de entrada pra revisão.' },
  sentAt: Date.now() as never,
  reactions: [],
  mine: false,
  mentionsMe: false,
  ...over,
})

const HITS: SearchHit[] = [
  {
    message: msg('$a:tayet.local', DM),
    channel: DM,
    excerpt: { before: 'Subi o ', match: 'protótipo', after: ' de entrada pra revisão.' },
  },
  {
    message: msg('$b:tayet.local', PRIV, { author: QUIM, threadParent: mid('$root:tayet.local') }),
    channel: PRIV,
    excerpt: { before: 'Olhei o ', match: 'protótipo', after: ' — tá calmo.' },
  },
  {
    message: msg('$c:tayet.local', DM, { author: ANA, mine: true }),
    channel: DM,
    excerpt: { before: 'Mandei o ', match: 'protótipo', after: ' novo.' },
  },
]

function fakeAcl(hits: SearchHit[] = HITS) {
  const handlers = new Set<(e: DomainEvent) => void>()
  const searchMessages = vi.fn(async (_q: string, _opts?: { channel?: ChannelId }) => hits)
  const acl = {
    searchMessages,
    getMembers: async (id: ChannelId) =>
      [
        { user: { id: RITA, displayName: 'Rita Ramos' }, role: 'member', state: 'joined' },
        { user: { id: ANA, displayName: 'Ana Lima' }, role: 'member', state: 'joined' },
        ...(id === PRIV ? [{ user: { id: QUIM, displayName: 'Quim Souza' }, role: 'member', state: 'joined' }] : []),
      ],
    subscribe: (h: (e: DomainEvent) => void) => {
      handlers.add(h)
      return () => handlers.delete(h)
    },
  } as unknown as Acl
  const emit = (e: DomainEvent) => handlers.forEach((h) => h(e))
  return { acl, searchMessages, emit }
}

function Harness({ acl, current, onPick }: { acl: Acl; current?: ChannelId; onPick?: (h: SearchHit) => void }) {
  const s = useSearch(acl, current)
  return (
    <MediaProvider resolve={async () => ({ url: '', release: () => {} })}>
      <Workspace
        channels={CHANNELS}
        selectedChannelId={current}
        messages={[]}
        usersById={{}}
        connection="connected"
        onSelectChannel={() => {}}
        onSend={() => {}}
        search={{
          query: s.query,
          onQuery: s.setQuery,
          scoped: s.scoped,
          onToggleScope: s.toggleScope,
          onClear: s.clear,
          active: s.active,
          hits: s.hits,
          searched: s.searched,
          preparing: s.state.preparing,
          partial: s.state.partial,
          onPick: (r) => onPick?.(r.hit),
        }}
      />
    </MediaProvider>
  )
}

const field = () => screen.getByRole('textbox', { name: 'Buscar mensagens' })
const typeQuery = async (value: string) => {
  fireEvent.change(field(), { target: { value } })
  await act(async () => {
    await new Promise((r) => setTimeout(r, SEARCH_DEBOUNCE_MS + 20))
  })
}
const region = () => screen.getByRole('region', { name: 'Resultados da busca' })

afterEach(cleanup)

describe('search results (workspace.md §8 items 4–8)', () => {
  it('replace the sections in the same nav; the list comes back on clear', async () => {
    const { acl, searchMessages } = fakeAcl()
    render(<Harness acl={acl} />)
    const nav = screen.getByRole('navigation', { name: copy.list.nav })
    expect(within(nav).getByRole('region', { name: 'Canais' })).toBeTruthy()

    await typeQuery('p')
    expect(screen.queryByRole('region', { name: 'Resultados da busca' })).toBeNull()
    expect(searchMessages).not.toHaveBeenCalled()

    await typeQuery('protótipo')
    expect(searchMessages).toHaveBeenCalledWith('protótipo', undefined)
    expect(nav.contains(region())).toBe(true)
    expect(within(nav).queryByRole('region', { name: 'Canais' })).toBeNull()
    expect(within(region()).getByRole('heading', { name: '3 resultados' })).toBeTruthy()

    fireEvent.click(within(region()).getByRole('button', { name: 'limpar' }))
    expect(screen.queryByRole('region', { name: 'Resultados da busca' })).toBeNull()
    expect(within(nav).getByRole('region', { name: 'Canais' })).toBeTruthy()
  })

  it('a hit: author + excerpt as its name, conversation (not on the peer\'s DM messages), date, the term in <mark>, the thread marker', async () => {
    const { acl } = fakeAcl()
    const onPick = vi.fn()
    render(<Harness acl={acl} onPick={onPick} />)
    await typeQuery('protótipo')
    const dm = within(region()).getByRole('button', { name: 'Rita Ramos: Subi o protótipo de entrada pra revisão.' })
    expect(dm.querySelector('mark')?.textContent).toBe('protótipo')
    expect(dm.textContent).not.toContain('· rita')
    expect(dm.textContent).toMatch(/hoje \d{2}:\d{2}/)
    expect(dm.textContent).not.toContain('em thread')
    const mine = within(region()).getByRole('button', { name: 'Ana Lima: Mandei o protótipo novo.' })
    expect(mine.textContent).toContain('· rita')
    const thread = within(region()).getByRole('button', { name: 'Quim Souza: Olhei o protótipo — tá calmo.' })
    expect(within(thread).getByRole('img', { name: 'Canal privado' })).toBeTruthy()
    expect(thread.textContent).toContain('liderança')
    expect(thread.textContent).toContain('em thread')
    fireEvent.click(thread)
    expect(onPick).toHaveBeenCalledWith(HITS[1])
  })

  it('Enter opens the first result', async () => {
    const { acl } = fakeAcl()
    const onPick = vi.fn()
    render(<Harness acl={acl} onPick={onPick} />)
    await typeQuery('protótipo')
    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(onPick).toHaveBeenCalledWith(HITS[0])
  })

  it('the chip narrows the search to the open conversation', async () => {
    const { acl, searchMessages } = fakeAcl()
    render(<Harness acl={acl} current={DM} />)
    await typeQuery('protótipo')
    fireEvent.click(screen.getByRole('button', { name: 'nesta conversa' }))
    await act(async () => {
      await new Promise((r) => setTimeout(r, SEARCH_DEBOUNCE_MS + 20))
    })
    expect(searchMessages).toHaveBeenLastCalledWith('protótipo', { channel: DM })
  })

  it('nothing found (§8 item 6)', async () => {
    const { acl } = fakeAcl([])
    render(<Harness acl={acl} />)
    await typeQuery('zzz')
    expect(region().textContent).toContain('Nada encontrado para “zzz”')
    expect(region().textContent).toContain('Mostrando o que já foi carregado neste dispositivo')
  })

  it('preparing (§8 item 7): the bar and "Preparando a busca…" over the partial results', async () => {
    const { acl, emit } = fakeAcl()
    watchSearchState(acl)
    emit({ t: 'search.state', preparing: true, partial: false, persisting: false, degraded: false })
    render(<Harness acl={acl} />)
    await typeQuery('protótipo')
    const status = within(region()).getByRole('status')
    expect(status.textContent).toBe('Preparando a busca…')
    expect(status.querySelector('.sweep__bar')).toBeTruthy()
    expect(within(region()).getAllByRole('button', { name: /protótipo/ })).toHaveLength(3)
    await act(async () => emit({ t: 'search.state', preparing: false, partial: false, persisting: false, degraded: false }))
    expect(within(region()).queryByRole('status')).toBeNull()
  })

  it('partial coverage (§8 item 8): the line under the list, outside its scroll', async () => {
    const { acl, emit } = fakeAcl()
    watchSearchState(acl)
    render(<Harness acl={acl} />)
    await act(async () => emit({ t: 'search.state', preparing: false, partial: true, persisting: false, degraded: false }))
    expect(screen.queryByText('Mostrando o que já foi carregado neste dispositivo')).toBeNull()
    await typeQuery('protótipo')
    const line = screen.getByText('Mostrando o que já foi carregado neste dispositivo')
    const nav = screen.getByRole('navigation', { name: copy.list.nav })
    expect(nav.contains(line)).toBe(false)
    expect(line.previousElementSibling).toBe(nav)
  })

  it('P1: no protocol id in the results, as text or markup', async () => {
    const { acl } = fakeAcl()
    render(<Harness acl={acl} />)
    await typeQuery('protótipo')
    expect(findProtocolLeaksInText(region().textContent ?? '')).toEqual([])
    expect(findProtocolLeaksInText(region().innerHTML)).toEqual([])
    for (const word of ['sala', 'evento', 'servidor', 'índice', 'sincroniz']) {
      expect(region().textContent?.toLowerCase()).not.toContain(word)
    }
  })
})

describe('whenOf (the date column)', () => {
  const now = new Date(2026, 9, 23, 15, 0).getTime()
  it('today, this week, older, another year', () => {
    expect(whenOf(new Date(2026, 9, 23, 9, 18).getTime(), now)).toBe('hoje 09:18')
    expect(whenOf(new Date(2026, 9, 20, 16, 40).getTime(), now)).toBe('ter 16:40')
    expect(whenOf(new Date(2026, 9, 12, 10, 0).getTime(), now)).toBe('12 out')
    expect(whenOf(new Date(2025, 11, 3, 10, 0).getTime(), now)).toBe('3 dez 2025')
  })
})
