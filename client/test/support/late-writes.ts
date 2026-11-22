import type * as ReactModule from 'react'

// React drops a state write to an unmounted component in silence, so a test counts them: mock 'react' with
// this and read `late` (PLANO-MOBILE M8, §3.4 of the prompt).
export function countLateWrites(react: typeof ReactModule, late: { count: number }): typeof ReactModule {
  function useState<S>(initial?: S | (() => S)) {
    const [value, set] = react.useState(initial as S | (() => S))
    const alive = react.useRef(true)
    react.useLayoutEffect(() => {
      alive.current = true
      return () => void (alive.current = false)
    }, [])
    const write = react.useCallback(
      (next: ReactModule.SetStateAction<S>) => {
        if (!alive.current) late.count += 1
        set(next)
      },
      [set],
    )
    return [value, write] as const
  }
  return { ...react, useState } as unknown as typeof ReactModule
}
