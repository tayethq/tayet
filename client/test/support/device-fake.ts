import { act } from '@testing-library/react'
import { vi } from 'vitest'

// A window for the M7 tests: width, pointer, display mode and user agent, with the change the app listens to.
export const IPHONE_SAFARI_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1'
export const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

export function fakeDevice(initial: { narrow?: boolean; coarse?: boolean; standalone?: boolean; ua?: string } = {}) {
  const state = { narrow: true, coarse: false, standalone: false, ua: DESKTOP_UA, ...initial }
  const listeners = new Set<() => void>()
  vi.stubGlobal('matchMedia', (q: string) => ({
    get matches() {
      if (q === '(width < 728px)') return state.narrow
      if (q === '(pointer: coarse)') return state.coarse
      if (q === '(display-mode: standalone)') return state.standalone
      return false
    },
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  }))
  vi.spyOn(navigator, 'userAgent', 'get').mockImplementation(() => state.ua)
  return {
    setNarrow(on: boolean) {
      act(() => {
        state.narrow = on
        for (const fn of [...listeners]) fn()
      })
    },
  }
}
