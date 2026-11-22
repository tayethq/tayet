import { useEffect, useState } from 'react'

// The width signal of the narrow shell. Below this width the layout is a stack, with any pointer. The
// CSS uses the same media query literally (styles.css); a unit test keeps the two in step. The value is
// a layout breakpoint, not a design token.
export const NARROW_QUERY = '(width < 728px)'

const hasMatchMedia = (): boolean => typeof window !== 'undefined' && typeof window.matchMedia === 'function'

// Is the window narrow right now?
export const isNarrowWindow = (): boolean => hasMatchMedia() && window.matchMedia(NARROW_QUERY).matches

// Coarse pointer, right now (read at the key press: the composer's Enter, PLANO-MOBILE §0.15 N1).
export const isCoarsePointer = (): boolean => hasMatchMedia() && window.matchMedia('(pointer: coarse)').matches

// Coarse pointer or narrow window, right now: where the touch floor and the collapsed defaults apply
// (in CSS, the media list `(pointer: coarse), (width < 728px)`).
export const isCoarseOrNarrow = (): boolean =>
  hasMatchMedia() && (window.matchMedia('(pointer: coarse)').matches || window.matchMedia(NARROW_QUERY).matches)

// Narrow window, following resizes and rotations.
export function useNarrowWindow(): boolean {
  const [narrow, setNarrow] = useState(isNarrowWindow)
  useEffect(() => {
    if (!hasMatchMedia()) return
    const mql = window.matchMedia(NARROW_QUERY)
    const onChange = (): void => setNarrow(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])
  return narrow
}
