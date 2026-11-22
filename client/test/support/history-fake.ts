import { act } from '@testing-library/react'
import type { HistoryEnv, StackHistoryState } from '../../src/ui/stack'

// A browser history whose landings the test decides (the stack's `go` lands asynchronously), for the narrow
// surfaces' tests.
export function fakeHistory() {
  const entries: unknown[] = [null]
  let index = 0
  const listeners = new Set<(s: unknown) => void>()
  const queued: number[] = []
  const env: HistoryEnv = {
    state: () => entries[index],
    push: (s: StackHistoryState) => {
      entries.splice(index + 1)
      entries.push(s)
      index = entries.length - 1
    },
    go: (d) => void queued.push(d),
    back: () => void queued.push(-1),
    replace: (s: StackHistoryState) => {
      entries[index] = s
    },
    onPop: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
  }
  const land = () => {
    // A landing may leave the stack with more to undo (one contributor at a time): until it settles.
    while (queued.length) {
      const delta = queued.shift()!
      act(() => {
        index = Math.max(0, index + delta)
        for (const fn of [...listeners]) fn(entries[index])
      })
    }
  }
  return {
    env,
    land,
    depth: () => index,
    screens: () => entries.slice(1, index + 1).map((s) => (s as StackHistoryState).screen),
    // The system's back.
    back: () => {
      queued.push(-1)
      land()
    },
  }
}
