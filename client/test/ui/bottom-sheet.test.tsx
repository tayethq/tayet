// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { useState } from 'react'
import { render, cleanup, fireEvent, act } from '@testing-library/react'
import { BottomSheet } from '../../src/ui/primitives'

// The BottomSheet primitive (workspace.md §23.9, PLANO-MOBILE §0.12.2 R2): scrim and panel are siblings,
// the scrim closes on a tap, Esc closes, Tab stays inside, the first button takes the focus and, on close,
// the focus goes back to where it came from.

afterEach(cleanup)

function Harness({ onClose }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false)
  const [opener, setOpener] = useState<HTMLButtonElement | null>(null)
  const close = (): void => {
    onClose?.()
    setOpen(false)
  }
  return (
    <div className="workspace">
      <button type="button" ref={setOpener} onClick={() => setOpen(true)}>
        open
      </button>
      {open && (
        <BottomSheet ariaLabel="Ações" onClose={close} returnFocus={opener}>
          <button type="button">first</button>
          <button type="button">last</button>
        </BottomSheet>
      )}
    </div>
  )
}

function openSheet(onClose?: () => void) {
  const view = render(<Harness onClose={onClose} />)
  const opener = view.getByRole('button', { name: 'open' })
  opener.focus()
  fireEvent.click(opener)
  return { ...view, opener }
}

describe('BottomSheet', () => {
  it('scrim and panel are siblings, direct children of the mounting root; the panel is a modal dialog', () => {
    const { container, getByRole } = openSheet()
    const root = container.querySelector('.workspace')!
    const scrim = root.querySelector(':scope > .ui-sheet__scrim')
    const panel = getByRole('dialog', { name: 'Ações' })
    expect(scrim).not.toBeNull()
    expect(panel.parentElement).toBe(root)
    expect(panel.getAttribute('aria-modal')).toBe('true')
    expect(panel.getAttribute('data-padding')).toBe('actions')
  })

  it('the first button takes the focus; closing gives it back to the opener', () => {
    const { getByRole, opener } = openSheet()
    expect(document.activeElement).toBe(getByRole('button', { name: 'first' }))
    fireEvent.keyDown(getByRole('dialog'), { key: 'Escape' })
    expect(document.activeElement).toBe(opener)
  })

  it('a tap on the scrim closes', () => {
    const onClose = vi.fn()
    const { container, queryByRole } = openSheet(onClose)
    fireEvent.click(container.querySelector('.ui-sheet__scrim')!)
    expect(onClose).toHaveBeenCalledOnce()
    expect(queryByRole('dialog')).toBeNull()
  })

  it('Tab cycles inside the panel', () => {
    const { getByRole } = openSheet()
    const first = getByRole('button', { name: 'first' })
    const last = getByRole('button', { name: 'last' })
    act(() => last.focus())
    fireEvent.keyDown(last, { key: 'Tab' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
  })

  it('the actions sheet, with an input inside, still focuses its first button and Tab walks only the buttons', () => {
    const view = render(
      <div className="workspace">
        <BottomSheet ariaLabel="Ações" onClose={() => {}} returnFocus={null}>
          <input aria-label="campo" />
          <button type="button">first</button>
          <button type="button">last</button>
        </BottomSheet>
      </div>,
    )
    const first = view.getByRole('button', { name: 'first' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(view.getByRole('button', { name: 'last' }))
  })

  it('a form (focus="field"): the field takes the first focus, its own autoFocus wins, and Tab walks fields and buttons', () => {
    const form = (autoFocusSecond: boolean) =>
      render(
        <div className="workspace">
          <BottomSheet ariaLabel="Link" onClose={() => {}} returnFocus={null} padding="form" focus="field">
            <input aria-label="texto" />
            <input aria-label="url" autoFocus={autoFocusSecond} />
            <button type="button">ok</button>
          </BottomSheet>
        </div>,
      )
    const plain = form(false)
    expect(document.activeElement).toBe(plain.getByRole('textbox', { name: 'texto' }))
    const ok = plain.getByRole('button', { name: 'ok' })
    act(() => ok.focus())
    fireEvent.keyDown(ok, { key: 'Tab' })
    expect(document.activeElement).toBe(plain.getByRole('textbox', { name: 'texto' }))
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(ok)
    cleanup()
    const seeded = form(true)
    expect(document.activeElement).toBe(seeded.getByRole('textbox', { name: 'url' }))
  })

  it('a return target gone from the document is left alone', () => {
    const { getByRole, opener } = openSheet()
    opener.remove()
    fireEvent.keyDown(getByRole('dialog'), { key: 'Escape' })
    expect(document.activeElement).toBe(document.body)
  })
})
