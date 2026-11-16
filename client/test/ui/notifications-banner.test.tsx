// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, within } from '@testing-library/react'
import { ChannelList } from '../../src/ui/components/ChannelList'
import { MediaProvider } from '../../src/ui/MediaContext'
import { copy } from '../support/copy'

// ADR-073 dec. 6: the notifications prompt inside the conversation list, before the first section.
// Presentational: App decides when it shows; the list only renders it and hands the clicks back.

const mount = (prompt?: { onEnable: () => void; onDismiss: () => void }) =>
  render(
    <MediaProvider resolve={async () => ({ url: '', release: () => {} })}>
      <ChannelList channels={[]} onSelect={() => {}} notificationsPrompt={prompt} />
    </MediaProvider>,
  )

afterEach(cleanup)

describe('notifications prompt in the channel list (ADR-073 dec. 6)', () => {
  it('absent without the prop', () => {
    mount()
    expect(screen.queryByText('Receba avisos de mensagens diretas e menções')).toBeNull()
  })

  it('renders as a status before the first section and hands both clicks back', () => {
    const onEnable = vi.fn()
    const onDismiss = vi.fn()
    mount({ onEnable, onDismiss })
    const nav = screen.getByRole('navigation', { name: copy.list.nav })
    const notice = within(nav).getByRole('status')
    expect(notice.textContent).toContain('Receba avisos de mensagens diretas e menções')
    expect(nav.firstElementChild).toBe(notice)
    within(notice).getByRole('button', { name: 'Ativar notificações' }).click()
    within(notice).getByRole('button', { name: 'Dispensar' }).click()
    expect(onEnable).toHaveBeenCalledTimes(1)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('artboard structure (workspace.md §14 item 3; forks 2, 4, 7 do §8.18): column (text + gestao button), Close icon beside', () => {
    mount({ onEnable: () => {}, onDismiss: () => {} })
    const notice = screen.getByRole('status')
    const enable = within(notice).getByRole('button', { name: 'Ativar notificações' })
    const dismiss = within(notice).getByRole('button', { name: 'Dispensar' })
    // Text and button share the column; the dismiss is its sibling, outside it.
    const column = enable.parentElement as HTMLElement
    expect(column.parentElement).toBe(notice)
    expect(column.textContent).toContain('Receba avisos de mensagens diretas e menções')
    expect(column.contains(dismiss)).toBe(false)
    expect(dismiss.parentElement).toBe(notice)
    expect(enable.dataset.variant).toBe('fill')
    expect(enable.dataset.size).toBe('gestao')
    // ✕ is the system Close icon (an aria-hidden svg), not the × glyph.
    expect(dismiss.textContent).toBe('')
    expect(dismiss.querySelector('svg[aria-hidden="true"]')).not.toBeNull()
  })
})
