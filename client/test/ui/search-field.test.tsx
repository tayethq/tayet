// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent } from '@testing-library/react'
import type { Acl, ChannelId } from '@tayet/client'
import { SearchField } from '../../src/ui/components/SearchField'
import { useSearch } from '../../src/ui/useSearch'

// Manifest workspace.md §8 items 1–3 (U3/U7): the field, the ⌘K/Ctrl+K focus, the scope chip, ✕ and
// Esc, the focus hint. Driven through useSearch, as the App wires it.

const acl = { searchMessages: async () => [], getMembers: async () => [] } as unknown as Acl

function Harness({ current, onSubmit }: { current?: ChannelId; onSubmit?: () => void }) {
  const s = useSearch(acl, current)
  return (
    <SearchField
      query={s.query}
      onQuery={s.setQuery}
      scoped={s.scoped}
      onToggleScope={s.toggleScope}
      onClear={s.clear}
      onSubmit={onSubmit}
    />
  )
}

const field = () => screen.getByRole('textbox', { name: 'Buscar mensagens' }) as HTMLInputElement

afterEach(cleanup)

describe('search field (workspace.md §8 items 1–3)', () => {
  it('at rest: placeholder and the shortcut hint, no chip, no clear', () => {
    render(<Harness current={'c1' as ChannelId} />)
    expect(field().placeholder).toBe('buscar')
    expect(document.querySelector('.search__kbd')?.textContent).toMatch(/^(⌘K|Ctrl K)$/)
    expect(screen.queryByRole('button', { name: /nesta conversa/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Limpar busca' })).toBeNull()
  })

  it('⌘K and Ctrl+K focus the field from anywhere, and the browser default is prevented', () => {
    render(
      <>
        <button type="button">elsewhere</button>
        <Harness />
      </>,
    )
    screen.getByRole('button', { name: 'elsewhere' }).focus()
    const meta = fireEvent.keyDown(document.body, { key: 'k', metaKey: true })
    expect(meta).toBe(false)
    expect(document.activeElement).toBe(field())
    screen.getByRole('button', { name: 'elsewhere' }).focus()
    fireEvent.keyDown(document.body, { key: 'K', ctrlKey: true })
    expect(document.activeElement).toBe(field())
    // A plain k is typing, not the shortcut.
    screen.getByRole('button', { name: 'elsewhere' }).focus()
    expect(fireEvent.keyDown(document.body, { key: 'k' })).toBe(true)
  })

  it('focused without text shows the hint; typing replaces it', () => {
    render(<Harness />)
    expect(screen.queryByText('Busque em todas as suas conversas')).toBeNull()
    fireEvent.focus(field())
    expect(screen.getByText('Busque em todas as suas conversas')).toBeTruthy()
    fireEvent.change(field(), { target: { value: 'pr' } })
    expect(screen.queryByText('Busque em todas as suas conversas')).toBeNull()
    expect(document.querySelector('.search__kbd')).toBeNull()
  })

  it('with text and an open conversation: the chip toggles the scope', () => {
    render(<Harness current={'c1' as ChannelId} />)
    fireEvent.change(field(), { target: { value: 'protótipo' } })
    const chip = screen.getByRole('button', { name: 'nesta conversa' })
    expect(chip.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(chip)
    const on = screen.getByRole('button', { name: 'nesta conversa ✓' })
    expect(on.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(on)
    expect(screen.getByRole('button', { name: 'nesta conversa' }).getAttribute('aria-pressed')).toBe('false')
  })

  it('no chip without an open conversation', () => {
    render(<Harness />)
    fireEvent.change(field(), { target: { value: 'protótipo' } })
    expect(screen.queryByRole('button', { name: /nesta conversa/ })).toBeNull()
  })

  it('✕ and Esc clear the term and the scope', () => {
    render(<Harness current={'c1' as ChannelId} />)
    fireEvent.change(field(), { target: { value: 'protótipo' } })
    fireEvent.click(screen.getByRole('button', { name: 'nesta conversa' }))
    fireEvent.click(screen.getByRole('button', { name: 'Limpar busca' }))
    expect(field().value).toBe('')
    fireEvent.change(field(), { target: { value: 'protótipo' } })
    expect(screen.getByRole('button', { name: 'nesta conversa' }).getAttribute('aria-pressed')).toBe('false')
    fireEvent.keyDown(field(), { key: 'Escape' })
    expect(field().value).toBe('')
  })

  it('Enter submits (opens the first result)', () => {
    const onSubmit = vi.fn()
    render(<Harness onSubmit={onSubmit} />)
    fireEvent.change(field(), { target: { value: 'protótipo' } })
    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })
})
