import { useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { trapFocusKeyDown, TRAP_BUTTONS, TRAP_FIELDS } from '../focus-trap'

// BottomSheet (composes, ADR-036; manifest workspace.md §23.9, adjudicated into the tier on 15/Nov/2026). A
// scrim over the whole screen that closes on a tap, and a panel held to the bottom edge at the screen's width.
// Scrim and panel are siblings with no wrapper, so a row of the screen can sit between them (the held message,
// §23.8 item 7): the mounting chrome renders the sheet as a direct child of its positioned root (the
// `.workspace`), both absolute, never fixed, no portal.
//
// Focus: the panel is a modal dialog with the shared trap (Esc closes, Tab cycles its buttons); the first
// button takes the focus on mount and, on close, the focus goes back to `returnFocus` when it is still in the
// document. The system's back is the caller's (useStackDialog). `focus="field"` (a form, the link sheet): Tab
// cycles the fields and the buttons, and the first focus is the caller's field (its autoFocus, which lands
// before this effect), else the first field.
export function BottomSheet({
  ariaLabel,
  onClose,
  returnFocus,
  padding = 'actions',
  panelRef,
  focus = 'button',
  role = 'dialog',
  children,
}: {
  ariaLabel: string
  onClose: () => void
  returnFocus: HTMLElement | null
  // §23.10: --space-8 for actions, --space-16 for a form (the link sheet).
  padding?: 'actions' | 'form'
  // The panel, for a caller that measures it (the held row's scroll).
  panelRef?: { current: HTMLDivElement | null }
  // What takes the first focus and what Tab walks: the buttons (actions) or the fields and buttons (a form).
  focus?: 'button' | 'field'
  // A confirmation that interrupts a destructive action is announced as an alert, as in the Dialog.
  role?: 'dialog' | 'alertdialog'
  children: ReactNode
}) {
  const ownRef = useRef<HTMLDivElement | null>(null)
  const back = useRef(returnFocus)
  back.current = returnFocus
  const selector = focus === 'field' ? TRAP_FIELDS : TRAP_BUTTONS
  const form = useRef(focus === 'field')
  useLayoutEffect(() => {
    const panel = ownRef.current
    if (!(form.current && panel?.contains(document.activeElement)))
      panel?.querySelector<HTMLElement>(form.current ? 'input:not([disabled])' : TRAP_BUTTONS)?.focus()
    return () => {
      if (back.current?.isConnected) back.current.focus()
    }
  }, [])
  const setPanel = (el: HTMLDivElement | null): void => {
    ownRef.current = el
    if (panelRef) panelRef.current = el
  }
  return (
    <>
      <div className="ui-sheet__scrim" role="presentation" onClick={onClose} />
      <div
        ref={setPanel}
        className="ui-sheet"
        data-padding={padding}
        role={role}
        aria-modal="true"
        aria-label={ariaLabel}
        onKeyDown={(e) => trapFocusKeyDown(e, ownRef.current, onClose, selector)}
      >
        {children}
      </div>
    </>
  )
}
