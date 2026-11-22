// The keyboard on the narrow window (workspace.md §23.1 item 4; PLANO-MOBILE §0.15 K1). iPhone Safari keeps
// the layout viewport when the on-screen keyboard opens and shrinks only the visual viewport; the viewport meta
// is left as it is (no `interactive-widget`). So the visual viewport's height is written, in JS, to a CSS
// variable on the root, and the narrow `.workspace` takes it as its height (100dvh when it is absent): the
// composer, the footers and the sheets, all inside the workspace, end above the keyboard. No position: fixed.
//
// The keyboard covers the system's bottom bar, so while it is open the bottom safe area does not add to the
// composer: the root carries `data-keyboard` while the visual viewport is shorter than the layout viewport by
// more than KEYBOARD_MIN. The layout viewport's height (the root's clientHeight) does not move with the
// keyboard; a pinch zoom shrinks the visual viewport by its scale, which `height × scale` undoes.
//
// On a narrow window the focused field is kept in sight (PLANO-MOBILE §8.21, R3): when the keyboard opens or
// grows (it can open in steps) and when the focus moves with it open, the field scrolls to the nearest edge of
// the container it scrolls in. A field with no such container (the composer, the search's) is left where it is.
import { NARROW_QUERY } from './narrow'

export const VIEWPORT_VAR = '--visual-viewport-height'
export const KEYBOARD_ATTR = 'data-keyboard'
// Below this the difference is the browser's own bars coming and going, not a keyboard (px, a heuristic of
// the module, not a design value).
export const KEYBOARD_MIN = 120

const FIELDS = 'input,textarea,select,[contenteditable]'

function revealField(win: Window): void {
  const field = win.document.activeElement as HTMLElement | null
  if (!field?.matches(FIELDS) || win.matchMedia?.(NARROW_QUERY).matches !== true) return
  for (let box = field.parentElement; box && box !== win.document.body; box = box.parentElement) {
    if (/auto|scroll/.test(win.getComputedStyle(box).overflowY)) {
      field.scrollIntoView({ block: 'nearest' })
      return
    }
  }
}

export function trackVisualViewport(win: Window = window, root: HTMLElement = win.document.documentElement): () => void {
  const vv = win.visualViewport
  if (!vv) return () => {}
  let open = false
  let lastHeight = Infinity
  const update = (): void => {
    const height = Math.round(vv.height * vv.scale)
    root.style.setProperty(VIEWPORT_VAR, `${height}px`)
    const wasOpen = open
    open = root.clientHeight - height > KEYBOARD_MIN
    if (open) root.setAttribute(KEYBOARD_ATTR, '')
    else root.removeAttribute(KEYBOARD_ATTR)
    if (open && (!wasOpen || height < lastHeight)) revealField(win)
    lastHeight = height
  }
  const onFocus = (): void => {
    if (open) revealField(win)
  }
  update()
  vv.addEventListener('resize', update)
  vv.addEventListener('scroll', update)
  win.document.addEventListener('focusin', onFocus)
  return () => {
    win.document.removeEventListener('focusin', onFocus)
    vv.removeEventListener('resize', update)
    vv.removeEventListener('scroll', update)
    root.style.removeProperty(VIEWPORT_VAR)
    root.removeAttribute(KEYBOARD_ATTR)
  }
}
