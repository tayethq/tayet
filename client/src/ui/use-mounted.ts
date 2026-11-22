import { useLayoutEffect, useRef } from 'react'

// Whether this opening is still on screen, for what a verb does when it settles (PLANO-MOBILE §8.21, R4). A
// layout effect: it turns false in the commit that takes the surface away, before anything else can run. It
// tells openings apart because each surface that uses it keys itself on its subject: another person or another
// group, and the same one opened again, are new instances.
export function useMounted(): { readonly current: boolean } {
  const mounted = useRef(false)
  useLayoutEffect(() => {
    mounted.current = true
    return () => void (mounted.current = false)
  }, [])
  return mounted
}
