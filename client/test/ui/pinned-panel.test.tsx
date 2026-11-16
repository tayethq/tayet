// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup, fireEvent, renderHook, waitFor, act } from '@testing-library/react'
import { PinnedPanel } from '../../src/ui/components/PinnedPanel'
import { Workspace } from '../../src/ui/components/Workspace'
import { usePanelPref } from '../../src/ui/panel-pref'
import { createNotifier, type NotifierEnv } from '../../src/ui/notifier'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import type { AgentPanel, Channel, ChannelId, Message, RichDoc, User, UserId } from '../../src/acl'

// ADR-091 (Proposto) dec. 12, A3-5 — the pinned panel on screen (manifest workspace.md §17.2, §17.3, §18
// item 4, §19): sections, accordion, no title, another day, "mais {n}" and its list (Escape, click
// outside, another click, focus back, pick), the local preference (read, written, hashed), the narrow
// default, the mount in the shell, the render-scan, and the notifier ignoring it. The fixture ids carry
// REAL protocol shapes: anything rendered or stored from them turns the scans red.

const uid = (s: string): UserId => s as unknown as UserId
const cid = (s: string): ChannelId => s as unknown as ChannelId
const at = (n: number) => n as unknown as AgentPanel['updatedAt']

const ME = uid('@me:tayet.local')
const CH = cid('!equipe:tayet.local')
const A = uid('@a-aaaaaaaaaaaa:tayet.local')
const B = uid('@a-bbbbbbbbbbbb:tayet.local')
const C = uid('@a-cccccccccccc:tayet.local')
const D = uid('@a-dddddddddddd:tayet.local')
const E = uid('@a-eeeeeeeeeeee:tayet.local')
const agent = (id: UserId, displayName: string): User => ({ id, displayName, kind: 'agent', agentColor: 'ardosia' })
const USERS: Record<string, User> = {
  [A]: agent(A, 'Atlas'),
  [B]: agent(B, 'Publicação'),
  [C]: agent(C, 'Cobrança'),
  [D]: agent(D, 'Design'),
  [E]: agent(E, 'Estoque'),
}
// 11/Nov/2026 10:00 local; panels updated the same day unless said otherwise.
const NOW = new Date(2026, 10, 11, 10, 0).getTime()
const TODAY = new Date(2026, 10, 11, 9, 40).getTime()
const panel = (id: UserId, title: string | undefined, text: string, when = TODAY): AgentPanel => ({
  agent: id,
  ...(title !== undefined && { title }),
  text,
  updatedAt: at(when),
})
const P_A = panel(A, 'Produção de hoje', 'Três itens em andamento.')
const P_B = panel(B, 'Fila de publicação', 'Dois posts agendados.')
const P_C = panel(C, 'Fechamento do mês', 'Doze faturas emitidas.')
const P_D = panel(D, undefined, 'Cinco telas em revisão.')
const P_E = panel(E, 'Reposição', 'Nada abaixo do mínimo.')

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
beforeEach(() => localStorage.clear())

const sections = (c: HTMLElement) => [...c.querySelectorAll('section')].map((s) => s.getAttribute('aria-label'))
const expanded = (c: HTMLElement) =>
  [...c.querySelectorAll('section')].filter((s) => s.querySelector('button')?.getAttribute('aria-expanded') === 'true').map((s) => s.getAttribute('aria-label'))

describe('PinnedPanel — sections and accordion (§17.2)', () => {
  it('one panel: a named section, the row as an expanded button, the body, "atualizado às"', () => {
    const { getByRole, container } = render(<PinnedPanel panels={[P_A]} usersById={USERS} now={NOW} />)
    const section = getByRole('region', { name: 'Painel de Atlas' })
    const row = section.querySelector('button')!
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(row.textContent).toContain('Produção de hoje')
    expect(row.textContent).toContain('Atlas')
    expect(row.textContent).toContain('atualizado às 09:40')
    expect(row.querySelector('[data-agent-avatar]')).not.toBeNull()
    expect(container.querySelector('.pinned-panel__body')?.textContent).toBe('Três itens em andamento.')
  })

  it('two and three panels: the first opens; one open at a time; no "mais" row', () => {
    const onPrefChange = vi.fn()
    const { container, getByRole } = render(<PinnedPanel panels={[P_A, P_B, P_C]} usersById={USERS} now={NOW} onPrefChange={onPrefChange} />)
    expect(sections(container)).toEqual(['Painel de Atlas', 'Painel de Publicação', 'Painel de Cobrança'])
    expect(expanded(container)).toEqual(['Painel de Atlas'])
    fireEvent.click(getByRole('region', { name: 'Painel de Cobrança' }).querySelector('button')!)
    expect(expanded(container)).toEqual(['Painel de Cobrança'])
    expect(container.querySelectorAll('.pinned-panel__body')).toHaveLength(1)
    expect(onPrefChange).toHaveBeenLastCalledWith(C, undefined)
    // Clicking the open one closes it: none open.
    fireEvent.click(getByRole('region', { name: 'Painel de Cobrança' }).querySelector('button')!)
    expect(expanded(container)).toEqual([])
    expect(onPrefChange).toHaveBeenLastCalledWith(null, undefined)
    expect(container.textContent).not.toContain('mais')
  })

  it('without a title the agent’s name takes the title’s place', () => {
    const { getByRole } = render(<PinnedPanel panels={[P_D]} usersById={USERS} now={NOW} />)
    const row = getByRole('region', { name: 'Painel de Design' }).querySelector('button')!
    expect(row.querySelector('.pinned-panel__title')?.textContent).toBe('Design')
    expect(row.querySelector('.pinned-panel__agent')).toBeNull()
  })

  it('another day: "atualizado em {data}" (the §11 item 6 formatter)', () => {
    const { container } = render(<PinnedPanel panels={[panel(A, 'Ontem', 'x', new Date(2026, 9, 28, 8, 0).getTime())]} usersById={USERS} now={NOW} />)
    expect(container.textContent).toContain('atualizado em 28 de out.')
  })

  it('the body renders the system RichText (same nodes as a message)', () => {
    const rich: RichDoc = [{ t: 'p', children: [{ t: 'strong', children: [{ t: 'text', text: '1 aguardando' }] }] }, { t: 'codeblock', text: 'item  status' }]
    const { container } = render(<PinnedPanel panels={[{ ...P_A, rich }]} usersById={USERS} now={NOW} />)
    expect(container.querySelector('.pinned-panel__body .rich strong')?.textContent).toBe('1 aguardando')
    expect(container.querySelector('.pinned-panel__body .rich__pre')?.textContent).toBe('item  status')
  })

  it('remembered state: none open, or the one remembered; the narrow default opens none', () => {
    const none = render(<PinnedPanel panels={[P_A, P_B]} usersById={USERS} initialOpen={null} now={NOW} />)
    expect(expanded(none.container)).toEqual([])
    cleanup()
    const second = render(<PinnedPanel panels={[P_A, P_B]} usersById={USERS} initialOpen={B} now={NOW} />)
    expect(expanded(second.container)).toEqual(['Painel de Publicação'])
    cleanup()
    const narrow = render(<PinnedPanel panels={[P_A, P_B]} usersById={USERS} collapsedByDefault now={NOW} />)
    expect(expanded(narrow.container)).toEqual([])
  })
})

describe('PinnedPanel — many agents (§19.1)', () => {
  const MANY = [P_A, P_B, P_C, P_D, P_E]

  it('at most 3 sections and the "mais {n}" row, closed', () => {
    const { container, getByRole } = render(<PinnedPanel panels={MANY} usersById={USERS} now={NOW} />)
    expect(sections(container)).toEqual(['Painel de Atlas', 'Painel de Publicação', 'Painel de Cobrança'])
    const more = getByRole('button', { name: 'mais 2' })
    expect(more.getAttribute('aria-expanded')).toBe('false')
    expect(more.querySelector('[data-agent-avatar]')).toBeNull()
  })

  it('the list opens over the timeline as the group "Outros painéis", in order, rows without chevron', () => {
    const { getByRole, queryByRole } = render(<PinnedPanel panels={MANY} usersById={USERS} now={NOW} />)
    expect(queryByRole('group', { name: 'Outros painéis' })).toBeNull()
    fireEvent.click(getByRole('button', { name: 'mais 2' }))
    const list = getByRole('group', { name: 'Outros painéis' })
    const rows = [...list.querySelectorAll('button')]
    expect(rows.map((r) => r.querySelector('.pinned-panel__title')?.textContent)).toEqual(['Design', 'Reposição'])
    expect(list.querySelector('.pinned-panel__chevron')).toBeNull()
    expect(getByRole('button', { name: 'mais 2' }).getAttribute('aria-expanded')).toBe('true')
    // The list takes the focus.
    expect(document.activeElement).toBe(rows[0])
  })

  it('Escape, a click outside and another click on the row close it without change; the focus returns to the row', () => {
    const onPrefChange = vi.fn()
    const { container, getByRole, queryByRole } = render(
      <div>
        <PinnedPanel panels={MANY} usersById={USERS} now={NOW} onPrefChange={onPrefChange} />
        <p data-testid="outside">fora</p>
      </div>,
    )
    const more = () => getByRole('button', { name: 'mais 2' })
    const before = sections(container)

    fireEvent.click(more())
    fireEvent.keyDown(getByRole('group', { name: 'Outros painéis' }).querySelector('button')!, { key: 'Escape' })
    expect(queryByRole('group', { name: 'Outros painéis' })).toBeNull()
    expect(document.activeElement).toBe(more())

    fireEvent.click(more())
    fireEvent.mouseDown(container.querySelector('[data-testid="outside"]')!)
    expect(queryByRole('group', { name: 'Outros painéis' })).toBeNull()
    expect(document.activeElement).toBe(more())

    fireEvent.click(more())
    fireEvent.mouseDown(more())
    fireEvent.click(more())
    expect(queryByRole('group', { name: 'Outros painéis' })).toBeNull()
    expect(document.activeElement).toBe(more())

    expect(sections(container)).toEqual(before)
    expect(onPrefChange).not.toHaveBeenCalled()
  })

  it('a pick takes the third section, open; the one that was third returns to the list, in order', () => {
    const onPrefChange = vi.fn()
    const { container, getByRole } = render(<PinnedPanel panels={MANY} usersById={USERS} now={NOW} onPrefChange={onPrefChange} />)
    fireEvent.click(getByRole('button', { name: 'mais 2' }))
    fireEvent.click(getByRole('button', { name: /Reposição/ }))
    expect(sections(container)).toEqual(['Painel de Atlas', 'Painel de Publicação', 'Painel de Estoque'])
    expect(expanded(container)).toEqual(['Painel de Estoque'])
    expect(onPrefChange).toHaveBeenLastCalledWith(E, E)
    fireEvent.click(getByRole('button', { name: 'mais 2' }))
    const rows = [...getByRole('group', { name: 'Outros painéis' }).querySelectorAll('button')]
    expect(rows.map((r) => r.querySelector('.pinned-panel__title')?.textContent)).toEqual(['Fechamento do mês', 'Design'])
  })

  it('a remembered pick comes back in the third section', () => {
    const { container } = render(<PinnedPanel panels={MANY} usersById={USERS} initialPicked={D} initialOpen={D} now={NOW} />)
    expect(sections(container)).toEqual(['Painel de Atlas', 'Painel de Publicação', 'Painel de Design'])
    expect(expanded(container)).toEqual(['Painel de Design'])
  })

  it('render-scan: names, titles and times on screen; no protocol shape in the DOM, list open', () => {
    const { container, getByRole } = render(<PinnedPanel panels={MANY} usersById={USERS} now={NOW} />)
    fireEvent.click(getByRole('button', { name: 'mais 2' }))
    expect(container.textContent).toContain('Produção de hoje')
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
    for (const id of [A, B, C, D, E]) expect(container.innerHTML).not.toContain(id as unknown as string)
  })
})

describe('panel preference (panel-pref.ts) — hashed, read and written', () => {
  it('nothing remembered → ready with an empty state; a save is read back by the next mount', async () => {
    const first = renderHook(() => usePanelPref(ME, CH, [A, B, C]))
    await waitFor(() => expect(first.result.current.ready).toBe(true))
    expect(first.result.current.initial).toEqual({})
    act(() => first.result.current.save(C, C))
    first.unmount()

    const again = renderHook(() => usePanelPref(ME, CH, [A, B, C]))
    await waitFor(() => expect(again.result.current.ready).toBe(true))
    expect(again.result.current.initial).toEqual({ open: C, picked: C })

    // Another conversation remembers nothing.
    const other = renderHook(() => usePanelPref(ME, cid('!outra:tayet.local'), [A, B, C]))
    await waitFor(() => expect(other.result.current.ready).toBe(true))
    expect(other.result.current.initial).toEqual({})
  })

  it('"none open" is remembered too', async () => {
    const first = renderHook(() => usePanelPref(ME, CH, [A]))
    await waitFor(() => expect(first.result.current.ready).toBe(true))
    act(() => first.result.current.save(null, undefined))
    first.unmount()
    const again = renderHook(() => usePanelPref(ME, CH, [A]))
    await waitFor(() => expect(again.result.current.ready).toBe(true))
    expect(again.result.current.initial).toEqual({ open: null })
  })

  it('no key nor value of localStorage passes the leak-scan, with real ids of account, conversation and agent', async () => {
    const h = renderHook(() => usePanelPref(ME, CH, [A, B]))
    await waitFor(() => expect(h.result.current.ready).toBe(true))
    act(() => h.result.current.save(B, A))
    const entries = Object.keys(localStorage).map((k) => [k, localStorage.getItem(k) ?? ''])
    expect(entries).toHaveLength(1)
    const [key, value] = entries[0]!
    expect(key).toMatch(/^tayet\.panel\.[0-9a-f]{16}$/)
    expect(value).toMatch(/^\{"o":"[0-9a-f]{16}","p":"[0-9a-f]{16}"\}$/)
    const all = entries.flat().join('\n')
    expect(findProtocolLeaksInText(all)).toEqual([])
    for (const raw of [ME, CH, A, B]) {
      const s = raw as unknown as string
      expect(all).not.toContain(s)
      expect(all).not.toContain(s.slice(1, s.indexOf(':')))
    }
  })
})

describe('the panel in the shell (Workspace)', () => {
  const channel: Channel = { id: CH, name: '#equipe', kind: 'private', memberCount: 4, unread: { count: 0, mentions: 0 } }
  const me: User = { id: ME, displayName: 'Bruna', kind: 'member' }
  const root: Message = {
    id: '$root:tayet.local' as unknown as Message['id'],
    channelId: CH,
    author: ME,
    body: { kind: 'text', text: 'raiz' },
    sentAt: TODAY as unknown as Message['sentAt'],
    reactions: [],
    mine: true,
    mentionsMe: false,
  }
  const shell = (extra: Partial<Parameters<typeof Workspace>[0]> = {}) => (
    <Workspace
      channels={[channel]}
      selectedChannelId={CH}
      messages={[root]}
      usersById={{ ...USERS, [ME]: me }}
      currentUser={me}
      connection="connected"
      onSelectChannel={() => {}}
      onSend={() => {}}
      {...extra}
    />
  )

  it('between the banners and the timeline, once the preference resolves; none without panels', async () => {
    const { container, rerender } = render(
      shell({
        panels: [P_A, P_B],
        newAccesses: [{ access: 'DEV1' as never, friendlyName: 'Laptop' }],
        onDismissAccess: () => {},
        attentionNeeded: true,
        onReset: () => {},
      }),
    )
    await waitFor(() => expect(container.querySelector('.pinned-panel')).not.toBeNull())
    const main = container.querySelector('main')!
    const order = [...main.children].map((el) => el.className.split(' ')[0])
    const i = order.indexOf('pinned-panel')
    expect(order.slice(i - 2, i + 2)).toEqual(['new-access-banner', 'reset-access-banner', 'pinned-panel', 'timeline'])
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
    rerender(shell({ panels: [] }))
    expect(container.querySelector('.pinned-panel')).toBeNull()
  })

  it('only in the main timeline: the open thread has no panel', async () => {
    const { container } = render(shell({ panels: [P_A], threadRoot: root, threadMessages: [], onCloseThread: () => {}, onSendThread: () => {} }))
    await waitFor(() => expect(container.querySelector('.pinned-panel')).not.toBeNull())
    expect(container.querySelectorAll('.pinned-panel')).toHaveLength(1)
    expect(container.querySelector('.thread-panel .pinned-panel')).toBeNull()
  })

  it('a panel of a new agent arriving keeps the panel mounted: the list stays open, the open section stays', async () => {
    const F = uid('@a-ffffffffffff:tayet.local')
    const users = { ...USERS, [F]: agent(F, 'Faturamento'), [ME]: me }
    const { container, getByRole, queryByRole, rerender } = render(shell({ panels: [P_A, P_B, P_C, P_D, P_E], usersById: users }))
    await waitFor(() => expect(container.querySelector('.pinned-panel')).not.toBeNull())
    fireEvent.click(getByRole('region', { name: 'Painel de Publicação' }).querySelector('button')!)
    fireEvent.click(getByRole('button', { name: 'mais 2' }))
    expect(queryByRole('group', { name: 'Outros painéis' })).not.toBeNull()
    rerender(shell({ panels: [P_A, P_B, P_C, P_D, P_E, panel(F, 'Notas', 'Emitidas.')], usersById: users }))
    // Let the new agent's token resolve in the background.
    await act(async () => {
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
    })
    expect(queryByRole('group', { name: 'Outros painéis' })).not.toBeNull()
    expect(getByRole('button', { name: 'mais 3' }).getAttribute('aria-expanded')).toBe('true')
    expect(expanded(container)).toEqual(['Painel de Publicação'])
  })

  it('the remembered state survives a remount; on the narrow shell nothing opens by default', async () => {
    const first = render(shell({ panels: [P_A, P_B] }))
    await waitFor(() => expect(first.container.querySelector('.pinned-panel')).not.toBeNull())
    expect(expanded(first.container)).toEqual(['Painel de Atlas'])
    fireEvent.click(first.getByRole('region', { name: 'Painel de Publicação' }).querySelector('button')!)
    first.unmount()
    const second = render(shell({ panels: [P_A, P_B] }))
    await waitFor(() => expect(second.container.querySelector('.pinned-panel')).not.toBeNull())
    expect(expanded(second.container)).toEqual(['Painel de Publicação'])
    second.unmount()
    localStorage.clear()

    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(pointer: coarse)', addEventListener() {}, removeEventListener() {} }))
    const narrow = render(shell({ panels: [P_A, P_B] }))
    await waitFor(() => expect(narrow.container.querySelector('.pinned-panel')).not.toBeNull())
    expect(expanded(narrow.container)).toEqual([])
  })
})

describe('the notifier never sees a panel', () => {
  it('panels.changed shows no notification', () => {
    const notify = vi.fn(() => ({ onclick: null, close() {} }))
    const env: NotifierEnv = {
      permission: () => 'granted',
      notify,
      isVisible: () => false,
      hasFocus: () => false,
      focusWindow: () => {},
      now: () => 0,
      setTimeout: () => 1,
      clearTimeout: () => {},
    }
    const notifier = createNotifier({ getChannel: () => undefined, getSelectedId: () => undefined, select: () => {}, getMembers: async () => [] }, env)
    notifier.handle({ t: 'panels.changed', channelId: CH, panels: [P_A] })
    expect(notify).not.toHaveBeenCalled()
  })
})
