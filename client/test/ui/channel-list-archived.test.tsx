// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, cleanup, within, fireEvent, act } from '@testing-library/react'
import { ChannelList } from '../../src/ui/components/ChannelList'
import type { Channel, ChannelId } from '../../src/acl'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { channelLabel } from '../support/channel-label'

// ADR-076 / manifest workspace.md §9: the Archived section of the sidebar list.
//   • Presence: absent with no archived channel (no empty-state, item 1); collapsed by default
//     (item 2), the toggle opens it and the choice persists per origin (tayet.archived-collapsed).
//   • Row (item 3): not a button, no unread badge — the only control is "Restaurar".
//   • Restore (items 4-7): "Restaurando…" disabled while the verb pends; completion is the props
//     (the row leaves; the last one takes the section); a rejection brings "Restaurar" back with the
//     inline notice.
//   • P1 (item 8): channel ids are protocol-shaped on purpose and never reach text or attributes.

const cid = (s: string): ChannelId => s as unknown as ChannelId

const active: Channel[] = [
  { id: cid('!engineering:tayet.local'), name: '#engineering', kind: 'public', memberCount: 3, unread: { count: 0, mentions: 0 } },
]
const arqOld: Channel = {
  id: cid('!old:tayet.local'),
  name: '#old-launch',
  kind: 'public',
  memberCount: 3,
  unread: { count: 4, mentions: 1 }, // never rendered as a badge here
  archived: true,
}
const arqPriv: Channel = {
  id: cid('!secret:tayet.local'),
  name: 'secret-plans',
  kind: 'private',
  memberCount: 2,
  unread: { count: 0, mentions: 0 },
  archived: true,
}

function deferred() {
  let resolve!: () => void
  let reject!: (e: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => localStorage.clear())
afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('ChannelList — Archived section (ADR-076, manifest §9)', () => {
  it('is absent with no archived channel', () => {
    const { queryByRole } = render(<ChannelList channels={active} archived={[]} onSelect={() => {}} />)
    expect(queryByRole('region', { name: 'Arquivados' })).toBeNull()
    // The two always-present sections stay.
    expect(queryByRole('region', { name: 'Canais' })).not.toBeNull()
    expect(queryByRole('region', { name: 'Mensagens diretas' })).not.toBeNull()
  })

  it('is collapsed by default; the toggle opens it and persists the choice', () => {
    const { getByRole, queryByText, unmount } = render(
      <ChannelList channels={active} archived={[arqOld, arqPriv]} onSelect={() => {}} onRestore={async () => {}} />,
    )
    const section = getByRole('region', { name: 'Arquivados' })
    const toggle = within(section).getByRole('button', { name: /Arquivados · 2/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(queryByText(channelLabel('#old-launch'))).toBeNull()

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(within(section).getByText(channelLabel('#old-launch'))).toBeTruthy()
    expect(localStorage.getItem('tayet.archived-collapsed')).toBe('false')
    unmount()

    // Remembered: a fresh mount comes back expanded.
    const again = render(<ChannelList channels={active} archived={[arqOld]} onSelect={() => {}} />)
    expect(again.getByRole('button', { name: /Arquivados · 1/ }).getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(again.getByRole('button', { name: /Arquivados · 1/ }))
    expect(localStorage.getItem('tayet.archived-collapsed')).toBe('true')
  })

  it('rows are not buttons and carry no badge; Restaurar is the only control', () => {
    localStorage.setItem('tayet.archived-collapsed', 'false')
    const { getByRole, container } = render(
      <ChannelList channels={active} archived={[arqOld, arqPriv]} onSelect={() => {}} onRestore={async () => {}} />,
    )
    const section = getByRole('region', { name: 'Arquivados' })
    const buttons = within(section).getAllByRole('button')
    // The toggle + one Restaurar per row — nothing that opens the channel.
    expect(buttons.map((b) => b.textContent)).toEqual(['Arquivados · 2', 'Restaurar', 'Restaurar'])
    expect(within(section).getByRole('button', { name: 'Restaurar #old-launch' })).toBeTruthy()
    expect(section.querySelector('.badge')).toBeNull()
    expect(within(section).getByText(channelLabel('#old-launch')).closest('button')).toBeNull()
    // Private: the lock takes the '#' slot, same ChannelLabel as the active rows.
    expect(within(section).getByText('secret-plans')).toBeTruthy()
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  it('Restaurar → "Restaurando…" disabled while pending → the row leaves when the props change', async () => {
    localStorage.setItem('tayet.archived-collapsed', 'false')
    const d = deferred()
    const calls: ChannelId[] = []
    const onRestore = (id: ChannelId) => {
      calls.push(id)
      return d.promise
    }
    const { getByRole, queryByRole, rerender } = render(
      <ChannelList channels={active} archived={[arqOld, arqPriv]} onSelect={() => {}} onRestore={onRestore} />,
    )
    fireEvent.click(getByRole('button', { name: 'Restaurar #old-launch' }))
    expect(calls).toEqual([arqOld.id])
    const busy = getByRole('button', { name: 'Restaurar #old-launch' })
    expect(busy.textContent).toBe('Restaurando…')
    expect((busy as HTMLButtonElement).disabled).toBe(true)
    // The other row is untouched.
    expect(getByRole('button', { name: 'Restaurar secret-plans' }).textContent).toBe('Restaurar')

    // The verb resolves, then the stream's channel.added moves it out of the archived props.
    await act(async () => d.resolve())
    rerender(<ChannelList channels={[...active, { ...arqOld, archived: undefined }]} archived={[arqPriv]} onSelect={() => {}} onRestore={onRestore} />)
    expect(queryByRole('button', { name: 'Restaurar #old-launch' })).toBeNull()
    expect(getByRole('button', { name: /Arquivados · 1/ })).toBeTruthy()

    // The last one leaves → the section goes with it.
    rerender(<ChannelList channels={active} archived={[]} onSelect={() => {}} onRestore={onRestore} />)
    expect(queryByRole('region', { name: 'Arquivados' })).toBeNull()
  })

  it('a rejection brings "Restaurar" back with the inline notice', async () => {
    localStorage.setItem('tayet.archived-collapsed', 'false')
    const d = deferred()
    const { getByRole, getByText, container } = render(
      <ChannelList channels={active} archived={[arqOld]} onSelect={() => {}} onRestore={() => d.promise} />,
    )
    fireEvent.click(getByRole('button', { name: 'Restaurar #old-launch' }))
    await act(async () => d.reject(new Error('forbidden')))
    const btn = getByRole('button', { name: 'Restaurar #old-launch' })
    expect(btn.textContent).toBe('Restaurar')
    expect((btn as HTMLButtonElement).disabled).toBe(false)
    expect(getByText('Não foi possível restaurar').getAttribute('role')).toBe('status')
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })
})
