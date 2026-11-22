import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

// The narrow shell's stack in the browser history. The screen in front is a function of the state
// that already exists (the selected conversation and the open thread in useChat, the dialogs in the
// Workspace); this module only keeps the browser history in step with it, so the system's back walks
// the stack. Each pushed screen is one history entry whose state carries only the kind of screen and
// its depth: the URL never changes and no id ever enters the history (P1).
//
// - Deeper: the entries are pushed. Shallower without the system's back (a conversation removed, a
//   jump that switches conversations, closing from the interface): the entries are gone back over.
// - The system's back (popstate) pops: the screens above the landing depth are closed, top first. An
//   entry that holds (a send in flight, PLANO-MOBILE M6 N2) refuses it: the popped entries are pushed
//   again and nothing is closed.
// - Only the stack creates entries: on a wide window nothing is contributed, so nothing is pushed,
//   and crossing to wide goes back over what the narrow window pushed.
// - A reload in the middle of the stack lands on the list: at start, an entry of ours deeper than the
//   root is gone back over, so the next back leaves the app.

// The screens that are pushed above the root (the list). The search sits between the list and the
// conversation (PLANO-MOBILE M6 B1).
export type StackScreen = 'search' | 'chat' | 'thread' | 'dialog'

export interface StackHistoryState {
  tayet: 'stack'
  screen: 'list' | StackScreen
  depth: number
}

// The root mark: the list, depth zero (written by the login's return in place of an empty state).
export const STACK_ROOT: StackHistoryState = { tayet: 'stack', screen: 'list', depth: 0 }

export const isStackState = (s: unknown): s is StackHistoryState =>
  typeof s === 'object' && s !== null && (s as { tayet?: unknown }).tayet === 'stack' &&
  typeof (s as { depth?: unknown }).depth === 'number'

const depthOf = (s: unknown): number => (isStackState(s) ? s.depth : 0)

// One screen a contributor wants on the stack. `key` tells two entries apart (the same key at the
// same depth is the same entry: switching conversations at the same depth creates none); `onPop` is
// what the system's back does to it; `holds`, while it answers true, refuses the system's back.
export interface StackEntry {
  key: string
  screen: StackScreen
  onPop: () => void
  holds?: () => boolean
}

// The browser history, injected: the unit tests drive a fake one.
export interface HistoryEnv {
  state(): unknown
  push(state: StackHistoryState): void
  go(delta: number): void
  back(): void
  // Writes `state` on the current entry, keeping the URL.
  replace(state: StackHistoryState): void
  // Calls `fn` with the landing entry's state on every popstate. Returns the unsubscribe.
  onPop(fn: (state: unknown) => void): () => void
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

// How long the reload's go-back may take before the stack gives up waiting for its popstate.
export const START_TIMEOUT_MS = 1_000

export function browserHistoryEnv(): HistoryEnv {
  return {
    state: () => window.history.state,
    push: (state) => window.history.pushState(state, ''),
    go: (delta) => window.history.go(delta),
    back: () => window.history.back(),
    replace: (state) => window.history.replaceState(state, ''),
    onPop: (fn) => {
      const listener = (e: PopStateEvent): void => fn(e.state)
      window.addEventListener('popstate', listener)
      return () => window.removeEventListener('popstate', listener)
    },
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
  }
}

export interface StackHistory {
  // Replaces what one contributor wants on the stack. `order` sorts contributors (the screens are 0;
  // a dialog takes the moment it opened, so a later one sits above).
  set(contributor: string, order: number, entries: StackEntry[]): void
  // The interface's back: one step, through the history (the single path that pops).
  back(): void
  // Back through the history until the entry `key` is on top (nothing when it is absent or on top).
  popTo(key: string): void
  // What the history holds above the root, by key (for the tests).
  keys(): string[]
  dispose(): void
}

// The reload's go-back is in flight. A stack created again before it lands (a remount) waits for that
// landing instead of going back a second time, which would leave the app.
let startInFlight = false

export function createStackHistory(env: HistoryEnv): StackHistory {
  const contributors = new Map<string, { order: number; entries: StackEntry[] }>()
  // The entries this document pushed and still stands on, bottom first.
  let entries: { key: string; screen: StackScreen }[] = []
  // A go() of ours is in flight: its popstate lands asynchronously and must not pop anything again.
  let traversing = false
  // A popTo() in flight: until its popstate lands, another one would go back too far.
  let popping = false
  let disposed = false
  // The reload's go-back, while it has not landed.
  let startTimer: unknown
  const clearStart = (): void => {
    if (startTimer === undefined) return
    env.clearTimeout(startTimer)
    startTimer = undefined
  }

  const desired = (): StackEntry[] =>
    [...contributors.values()].sort((a, b) => a.order - b.order).flatMap((c) => c.entries)

  const entryOf = (key: string): StackEntry | undefined => desired().find((e) => e.key === key)

  const goBack = (n: number): void => {
    traversing = true
    env.go(-n)
  }

  const reconcile = (): void => {
    if (disposed || traversing) return
    const want = desired()
    let k = 0
    while (k < entries.length && k < want.length && entries[k]!.key === want[k]!.key) k++
    if (entries.length > k) {
      // Shallower: go back over the extra entries; what is left to push follows the landing.
      const n = entries.length - k
      entries = entries.slice(0, k)
      goBack(n)
      return
    }
    for (let i = k; i < want.length; i++) {
      const e = want[i]!
      entries.push({ key: e.key, screen: e.screen })
      env.push({ tayet: 'stack', screen: e.screen, depth: i + 1 })
    }
  }

  const onPop = (state: unknown): void => {
    if (disposed) return
    popping = false
    const depth = depthOf(state)
    if (traversing) {
      traversing = false
      startInFlight = false
      clearStart()
      if (depth === entries.length) {
        reconcile()
        return
      }
    }
    if (depth < entries.length) {
      // An entry that holds refuses the system's back: the popped entries are pushed again, the screens stay.
      if (entries.slice(depth).some((e) => entryOf(e.key)?.holds?.() === true)) {
        for (let i = depth; i < entries.length; i++)
          env.push({ tayet: 'stack', screen: entries[i]!.screen, depth: i + 1 })
        return
      }
      // The system's back: close what was above the landing, top first. The contributors' state
      // follows, and their next set() finds the history already in step.
      const popped = entries.slice(depth).reverse()
      entries = entries.slice(0, depth)
      for (const e of popped) entryOf(e.key)?.onPop()
    } else if (depth > entries.length) {
      // Forward into entries this document no longer stands on (dead after a pop or a reload).
      goBack(depth - entries.length)
    }
  }

  const unsubscribe = env.onPop(onPop)
  // Reload in the middle of the stack: back to the list, so the next back leaves the app.
  const start = depthOf(env.state())
  if (start > 0 && startInFlight) traversing = true
  else if (start > 0) {
    startInFlight = true
    goBack(start)
  }
  // A go-back the browser cannot make never fires popstate. Past the limit the stack stops waiting:
  // the current entry becomes the root and the contributors' screens are pushed from there.
  if (start > 0) {
    startTimer = env.setTimeout(() => {
      startTimer = undefined
      if (disposed || !traversing) return
      traversing = false
      startInFlight = false
      env.replace(STACK_ROOT)
      reconcile()
    }, START_TIMEOUT_MS)
  }

  return {
    set: (contributor, order, list) => {
      if (list.length === 0) contributors.delete(contributor)
      else contributors.set(contributor, { order, entries: list })
      reconcile()
    },
    back: () => env.back(),
    popTo: (key) => {
      const at = entries.findIndex((e) => e.key === key)
      if (at < 0 || at >= entries.length - 1 || traversing || popping) return
      popping = true
      env.go(at + 1 - entries.length)
    },
    keys: () => entries.map((e) => e.key),
    dispose: () => {
      disposed = true
      clearStart()
      unsubscribe()
      contributors.clear()
    },
  }
}

// ── React ───────────────────────────────────────────────────────────────────────────────────────

const StackContext = createContext<StackHistory | null>(null)

// One stack per mounted app, on the real history. Without the provider (the render-scan harness) the
// hooks below do nothing and the header's back closes by itself.
export function StackProvider({ children, env }: { children: ReactNode; env?: HistoryEnv }) {
  const [stack, setStack] = useState<StackHistory | null>(null)
  useEffect(() => {
    const s = createStackHistory(env ?? browserHistoryEnv())
    setStack(s)
    return () => s.dispose()
  }, [env])
  return <StackContext.Provider value={stack}>{children}</StackContext.Provider>
}

// The latest value of `fn`, for a callback the history calls later.
function useLatest<T>(value: T): { current: T } {
  const ref = useRef(value)
  useLayoutEffect(() => {
    ref.current = value
  })
  return ref
}

// The screens of the stack: the search, the conversation and its thread, while the window is narrow.
export function useStackScreens({
  narrow,
  search = false,
  chat,
  thread,
  onPopSearch = () => {},
  onPopChat,
  onPopThread,
}: {
  narrow: boolean
  search?: boolean
  chat: boolean
  thread: boolean
  onPopSearch?: () => void
  onPopChat: () => void
  onPopThread: () => void
}): void {
  const stack = useContext(StackContext)
  const pops = useLatest({ onPopSearch, onPopChat, onPopThread })
  const withSearch = narrow && search
  const depth = !narrow || !chat ? 0 : thread ? 2 : 1
  useEffect(() => {
    if (!stack) return
    const list: StackEntry[] = []
    if (withSearch) list.push({ key: 'search', screen: 'search', onPop: () => pops.current.onPopSearch() })
    if (depth >= 1) list.push({ key: 'chat', screen: 'chat', onPop: () => pops.current.onPopChat() })
    if (depth >= 2) list.push({ key: 'thread', screen: 'thread', onPop: () => pops.current.onPopThread() })
    stack.set('screens', 0, list)
  }, [stack, withSearch, depth, pops])
}

let dialogOrder = 0

// A dialog open on a narrow window takes one history entry: the system's back closes it; closing it
// from the interface goes back over the entry. The full screens that replace the dialogs reuse it.
// While `holds` answers true the system's back leaves it open (PLANO-MOBILE M6 N2).
export function useStackDialog(name: string, open: boolean, onClose: () => void, holds?: () => boolean): void {
  const stack = useContext(StackContext)
  const close = useLatest({ onClose, holds })
  useEffect(() => {
    if (!stack || !open) return
    dialogOrder += 1
    const contributor = `dialog:${name}`
    stack.set(contributor, dialogOrder, [
      { key: contributor, screen: 'dialog', onPop: () => close.current.onClose(), holds: () => close.current.holds?.() === true },
    ])
    return () => stack.set(contributor, 0, [])
  }, [stack, name, open, close])
}

// The header's back: one step through the history. Without a stack (the harness), `fallback` closes
// the screen directly.
export function useStackBack(fallback: () => void): () => void {
  const stack = useContext(StackContext)
  return () => (stack ? stack.back() : fallback())
}

// Back through the history to the entry `key` (the failed jump's way back to the search, M6 B2).
export function useStackPopTo(): (key: string) => void {
  const stack = useContext(StackContext)
  return useCallback((key: string) => stack?.popTo(key), [stack])
}
