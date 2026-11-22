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
export const VIEWPORT_VAR = '--visual-viewport-height'
export const KEYBOARD_ATTR = 'data-keyboard'
// Below this the difference is the browser's own bars coming and going, not a keyboard (px, a heuristic of
// the module, not a design value).
export const KEYBOARD_MIN = 120

export function trackVisualViewport(win: Window = window, root: HTMLElement = win.document.documentElement): () => void {
  const vv = win.visualViewport
  if (!vv) return () => {}
  const update = (): void => {
    const height = Math.round(vv.height * vv.scale)
    root.style.setProperty(VIEWPORT_VAR, `${height}px`)
    if (root.clientHeight - height > KEYBOARD_MIN) root.setAttribute(KEYBOARD_ATTR, '')
    else root.removeAttribute(KEYBOARD_ATTR)
  }
  update()
  vv.addEventListener('resize', update)
  vv.addEventListener('scroll', update)
  return () => {
    vv.removeEventListener('resize', update)
    vv.removeEventListener('scroll', update)
    root.style.removeProperty(VIEWPORT_VAR)
    root.removeAttribute(KEYBOARD_ATTR)
  }
}
