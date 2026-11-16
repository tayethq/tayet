// Minimal focus trap shared by every modal overlay that reuses the scrim (the U2 confirm dialog and
// add-member picker, the U3 compose dialog): Esc closes; Tab/Shift+Tab cycle within the dialog's
// enabled controls. Kept dependency-free so each overlay just wires onKeyDown to this with its own
// ref + close. Lifted verbatim from ChannelManagementPanel (Track U/U3, F-picker) — behaviour-
// preserving: the U2 suite is its falsification.
export function trapFocusKeyDown(
  e: React.KeyboardEvent,
  root: HTMLElement | null,
  onEscape: () => void,
): void {
  if (e.key === 'Escape') {
    e.stopPropagation()
    onEscape()
    return
  }
  if (e.key !== 'Tab' || !root) return
  const focusables = root.querySelectorAll<HTMLElement>('button:not([disabled])')
  if (focusables.length === 0) return
  const first = focusables[0]!
  const last = focusables[focusables.length - 1]!
  const active = document.activeElement
  if (e.shiftKey && active === first) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && active === last) {
    e.preventDefault()
    first.focus()
  }
}
