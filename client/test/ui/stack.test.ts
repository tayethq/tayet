import { describe, expect, it, vi } from 'vitest'
import {
  STACK_ROOT,
  START_TIMEOUT_MS,
  createStackHistory,
  isStackState,
  type HistoryEnv,
  type StackEntry,
  type StackHistoryState,
} from '../../src/ui/stack'

// A browser history in memory. Like the real one, a traversal (go/back) is asynchronous: its popstate
// fires only when the test flushes, so the tests see what happens while one is in flight.
function fakeHistory(initial: unknown[] = [null]) {
  const entries: unknown[] = [...initial]
  let index = entries.length - 1
  const listeners = new Set<(state: unknown) => void>()
  const queued: number[] = []
  const pushes: StackHistoryState[] = []
  // A fake clock: timers fire only when the test advances it.
  let now = 0
  let timers: { at: number; fn: () => void; id: number }[] = []
  let nextTimer = 1
  const env: HistoryEnv = {
    state: () => entries[index],
    push: (state) => {
      entries.splice(index + 1)
      entries.push(state)
      index = entries.length - 1
      pushes.push(state)
    },
    go: (delta) => void queued.push(delta),
    back: () => void queued.push(-1),
    replace: (state) => {
      entries[index] = state
    },
    onPop: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    setTimeout: (fn, ms) => {
      const id = nextTimer++
      timers.push({ at: now + ms, fn, id })
      return id
    },
    clearTimeout: (id) => {
      timers = timers.filter((t) => t.id !== id)
    },
  }
  return {
    env,
    pushes,
    get index() {
      return index
    },
    get length() {
      return entries.length
    },
    stateAt: (i: number) => entries[i],
    current: () => entries[index],
    // Lands every queued traversal, firing popstate after each one (the browser's order).
    flush() {
      while (queued.length) {
        const delta = queued.shift()!
        const next = Math.max(0, Math.min(entries.length - 1, index + delta))
        if (next === index) continue
        index = next
        for (const fn of [...listeners]) fn(entries[index])
      }
    },
    // The system's back or forward button.
    press(delta: number) {
      queued.push(delta)
      this.flush()
    },
    pending: () => queued.length,
    // The browser could not make the queued traversals: they are dropped and no popstate fires.
    drop() {
      queued.length = 0
    },
    advance(ms: number) {
      now += ms
      const due = timers.filter((t) => t.at <= now)
      timers = timers.filter((t) => t.at > now)
      for (const t of due) t.fn()
    },
    timerCount: () => timers.length,
  }
}

// The screens contributor as the App drives it: depth 0 (list), 1 (conversation), 2 (thread).
function screens(depth: number, pops: { chat?: () => void; thread?: () => void } = {}): StackEntry[] {
  const list: StackEntry[] = []
  if (depth >= 1) list.push({ key: 'chat', screen: 'chat', onPop: pops.chat ?? (() => {}) })
  if (depth >= 2) list.push({ key: 'thread', screen: 'thread', onPop: pops.thread ?? (() => {}) })
  return list
}

describe('stack history: push and pop', () => {
  it('a deeper screen pushes one entry per level, with only the kind and the depth', () => {
    const h = fakeHistory([STACK_ROOT])
    const stack = createStackHistory(h.env)
    stack.set('screens', 0, screens(1))
    expect(h.current()).toEqual({ tayet: 'stack', screen: 'chat', depth: 1 })
    stack.set('screens', 0, screens(2))
    expect(h.current()).toEqual({ tayet: 'stack', screen: 'thread', depth: 2 })
    expect(h.length).toBe(3)
    expect(stack.keys()).toEqual(['chat', 'thread'])
  })

  it('switching conversations at the same depth creates no entry', () => {
    const h = fakeHistory()
    const stack = createStackHistory(h.env)
    stack.set('screens', 0, screens(1))
    stack.set('screens', 0, screens(1))
    stack.set('screens', 0, screens(1))
    expect(h.length).toBe(2)
  })

  it('the system back pops the top screen: the thread closes, then the conversation', () => {
    const h = fakeHistory()
    const thread = vi.fn()
    const chat = vi.fn()
    const stack = createStackHistory(h.env)
    stack.set('screens', 0, screens(2, { chat, thread }))
    h.press(-1)
    expect(thread).toHaveBeenCalledTimes(1)
    expect(chat).not.toHaveBeenCalled()
    // The contributor follows (useChat closed the thread): the history is already in step.
    stack.set('screens', 0, screens(1, { chat, thread }))
    expect(h.pending()).toBe(0)
    expect(h.index).toBe(1)
    h.press(-1)
    expect(chat).toHaveBeenCalledTimes(1)
    stack.set('screens', 0, screens(0))
    expect(h.index).toBe(0)
    expect(stack.keys()).toEqual([])
  })

  it('the interface back goes through the history (one path to pop)', () => {
    const h = fakeHistory()
    const chat = vi.fn()
    const stack = createStackHistory(h.env)
    stack.set('screens', 0, screens(1, { chat }))
    stack.back()
    expect(chat).not.toHaveBeenCalled()
    h.flush()
    expect(chat).toHaveBeenCalledTimes(1)
  })

  it('a two-step back at once closes both, top first', () => {
    const h = fakeHistory()
    const order: string[] = []
    const stack = createStackHistory(h.env)
    stack.set('screens', 0, screens(2, { chat: () => order.push('chat'), thread: () => order.push('thread') }))
    h.press(-2)
    expect(order).toEqual(['thread', 'chat'])
  })
})

describe('stack history: shorter without the system back', () => {
  it('closing the thread from the interface goes back over its entry', () => {
    const h = fakeHistory()
    const thread = vi.fn()
    const stack = createStackHistory(h.env)
    stack.set('screens', 0, screens(2, { thread }))
    stack.set('screens', 0, screens(1))
    expect(h.pending()).toBe(1)
    h.flush()
    expect(h.index).toBe(1)
    // The go-back's own popstate pops nothing again.
    expect(thread).not.toHaveBeenCalled()
  })

  it('a conversation removed with the thread open goes back two entries, and its popstate pops nothing', () => {
    const h = fakeHistory()
    const chat = vi.fn()
    const thread = vi.fn()
    const stack = createStackHistory(h.env)
    stack.set('screens', 0, screens(2, { chat, thread }))
    stack.set('screens', 0, screens(0))
    h.flush()
    expect(h.index).toBe(0)
    expect(chat).not.toHaveBeenCalled()
    expect(thread).not.toHaveBeenCalled()
  })

  it('what is left to push waits for the go-back to land', () => {
    const h = fakeHistory()
    const stack = createStackHistory(h.env)
    // A dialog opened from the list, then "Enviar mensagem": the dialog closes, the conversation opens.
    stack.set('dialog:profile', 1, [{ key: 'dialog:profile', screen: 'dialog', onPop: () => {} }])
    expect(h.length).toBe(2)
    stack.set('dialog:profile', 0, [])
    stack.set('screens', 0, screens(1))
    // Nothing pushed over the entry being left while the go-back is in flight.
    expect(h.length).toBe(2)
    h.flush()
    expect(h.index).toBe(1)
    expect(h.current()).toEqual({ tayet: 'stack', screen: 'chat', depth: 1 })
  })
})

describe('stack history: reload, forward and the width', () => {
  it('a reload in the middle of the stack goes back to the list, so the next back leaves the app', () => {
    const h = fakeHistory([STACK_ROOT, { tayet: 'stack', screen: 'chat', depth: 1 }, { tayet: 'stack', screen: 'thread', depth: 2 }])
    const stack = createStackHistory(h.env)
    expect(h.pending()).toBe(1)
    h.flush()
    expect(h.index).toBe(0)
    expect(h.current()).toEqual(STACK_ROOT)
    // The landing pops nothing and pushes nothing.
    expect(stack.keys()).toEqual([])
    expect(h.pushes).toEqual([])
  })

  it('a remount before the reload go-back lands does not go back a second time', () => {
    const h = fakeHistory([STACK_ROOT, { tayet: 'stack', screen: 'chat', depth: 1 }])
    const first = createStackHistory(h.env)
    first.dispose()
    createStackHistory(h.env)
    expect(h.pending()).toBe(1)
    h.flush()
    expect(h.index).toBe(0)
  })

  it('forward into an entry the document left is gone back over', () => {
    const h = fakeHistory()
    const chat = vi.fn()
    const stack = createStackHistory(h.env)
    stack.set('screens', 0, screens(1, { chat }))
    h.press(-1)
    stack.set('screens', 0, screens(0))
    h.press(1)
    h.flush()
    expect(h.index).toBe(0)
    expect(chat).toHaveBeenCalledTimes(1)
  })

  it('narrow to wide goes back over the entries; wide to narrow with a conversation pushes them again', () => {
    const h = fakeHistory()
    const stack = createStackHistory(h.env)
    stack.set('screens', 0, screens(2))
    // Wide: the screens contribute nothing.
    stack.set('screens', 0, screens(0))
    h.flush()
    expect(h.index).toBe(0)
    // Narrow again, the thread still open: two entries.
    stack.set('screens', 0, screens(2))
    expect(h.index).toBe(2)
    expect(h.current()).toEqual({ tayet: 'stack', screen: 'thread', depth: 2 })
  })
})

describe('stack history: the reload go-back that does not land', () => {
  const deep = () => [STACK_ROOT, { tayet: 'stack', screen: 'chat', depth: 1 }, { tayet: 'stack', screen: 'thread', depth: 2 }]

  it('the go-back lands within the limit: the timer is cleared and nothing else happens', () => {
    const h = fakeHistory(deep())
    const stack = createStackHistory(h.env)
    h.advance(START_TIMEOUT_MS - 1)
    h.flush()
    expect(h.index).toBe(0)
    expect(h.timerCount()).toBe(0)
    h.advance(START_TIMEOUT_MS)
    expect(h.current()).toEqual(STACK_ROOT)
    expect(h.pushes).toEqual([])
    stack.set('screens', 0, screens(1))
    expect(h.current()).toEqual({ tayet: 'stack', screen: 'chat', depth: 1 })
  })

  it('no popstate within the limit: the current entry becomes the root and the screens push from there', () => {
    const h = fakeHistory(deep())
    const stack = createStackHistory(h.env)
    h.drop()
    // While waiting, nothing is pushed.
    stack.set('screens', 0, screens(1))
    expect(h.pushes).toEqual([])
    h.advance(START_TIMEOUT_MS)
    expect(h.stateAt(2)).toEqual(STACK_ROOT)
    expect(h.current()).toEqual({ tayet: 'stack', screen: 'chat', depth: 1 })
    expect(stack.keys()).toEqual(['chat'])
    // A later system back pops as usual.
    const chat = vi.fn()
    stack.set('screens', 0, screens(1, { chat }))
    h.press(-1)
    expect(chat).toHaveBeenCalledTimes(1)
  })

  it('the next stack does not inherit a go-back that was given up on', () => {
    const h = fakeHistory(deep())
    createStackHistory(h.env).dispose()
    h.drop()
    const second = createStackHistory(h.env)
    h.advance(START_TIMEOUT_MS)
    second.set('screens', 0, screens(1))
    expect(h.current()).toEqual({ tayet: 'stack', screen: 'chat', depth: 1 })
  })
})

describe('stack history: dialogs', () => {
  it('an open dialog takes one entry above the screens; the system back closes it', () => {
    const h = fakeHistory()
    const close = vi.fn()
    const chat = vi.fn()
    const stack = createStackHistory(h.env)
    stack.set('screens', 0, screens(1, { chat }))
    stack.set('dialog:account', 1, [{ key: 'dialog:account', screen: 'dialog', onPop: close }])
    expect(h.current()).toEqual({ tayet: 'stack', screen: 'dialog', depth: 2 })
    h.press(-1)
    expect(close).toHaveBeenCalledTimes(1)
    expect(chat).not.toHaveBeenCalled()
  })

  it('closing the dialog from its own interface goes back over the entry', () => {
    const h = fakeHistory()
    const close = vi.fn()
    const stack = createStackHistory(h.env)
    stack.set('dialog:compose', 1, [{ key: 'dialog:compose', screen: 'dialog', onPop: close }])
    stack.set('dialog:compose', 0, [])
    h.flush()
    expect(h.index).toBe(0)
    expect(close).not.toHaveBeenCalled()
  })
})

describe('stack history: P1', () => {
  it('no id ever enters the history state: only the kind and the depth', () => {
    const h = fakeHistory([STACK_ROOT])
    const stack = createStackHistory(h.env)
    stack.set('screens', 0, screens(2))
    stack.set('dialog:profile', 1, [{ key: 'dialog:profile', screen: 'dialog', onPop: () => {} }])
    for (let i = 0; i < h.length; i++) {
      const s = h.stateAt(i)
      expect(isStackState(s)).toBe(true)
      expect(Object.keys(s as object).sort()).toEqual(['depth', 'screen', 'tayet'])
      expect(JSON.stringify(s)).not.toMatch(/[!@$][^"]*:/)
    }
  })
})

// PLANO-MOBILE M6 B1 to B3: the search sits between the list and the conversation.
function withSearch(depth: number, pops: { search?: () => void; chat?: () => void; thread?: () => void } = {}): StackEntry[] {
  return [{ key: 'search', screen: 'search', onPop: pops.search ?? (() => {}) }, ...screens(depth, pops)]
}

describe('stack history: the search screen (M6)', () => {
  it('list, search, conversation, thread: one entry each, the search under the conversation', () => {
    const h = fakeHistory([STACK_ROOT])
    const stack = createStackHistory(h.env)
    stack.set('screens', 0, withSearch(0))
    expect(h.current()).toEqual({ tayet: 'stack', screen: 'search', depth: 1 })
    stack.set('screens', 0, withSearch(2))
    expect(stack.keys()).toEqual(['search', 'chat', 'thread'])
    expect(h.current()).toEqual({ tayet: 'stack', screen: 'thread', depth: 3 })
  })

  it('back from a thread opened by a result passes through the conversation, then the search, then the list', () => {
    const h = fakeHistory()
    const order: string[] = []
    const pops = { search: () => order.push('search'), chat: () => order.push('chat'), thread: () => order.push('thread') }
    const stack = createStackHistory(h.env)
    stack.set('screens', 0, withSearch(2, pops))
    h.press(-1)
    stack.set('screens', 0, withSearch(1, pops))
    h.press(-1)
    stack.set('screens', 0, withSearch(0, pops))
    h.press(-1)
    stack.set('screens', 0, [])
    expect(order).toEqual(['thread', 'chat', 'search'])
    expect(h.index).toBe(0)
    expect(h.pending()).toBe(0)
  })

  it('popTo goes back through the history to the search, closing what is above it, top first', () => {
    const h = fakeHistory()
    const order: string[] = []
    const stack = createStackHistory(h.env)
    stack.set('screens', 0, withSearch(2, { chat: () => order.push('chat'), thread: () => order.push('thread'), search: () => order.push('search') }))
    stack.popTo('search')
    expect(order).toEqual([])
    h.flush()
    expect(order).toEqual(['thread', 'chat'])
    expect(h.current()).toEqual({ tayet: 'stack', screen: 'search', depth: 1 })
  })

  it('popTo twice before the first lands goes back only once', () => {
    const h = fakeHistory()
    const search = vi.fn()
    const stack = createStackHistory(h.env)
    stack.set('screens', 0, withSearch(1, { search }))
    stack.popTo('search')
    stack.popTo('search')
    h.flush()
    expect(search).not.toHaveBeenCalled()
    expect(h.index).toBe(1)
  })

  it('popTo does nothing when the entry is on top or absent', () => {
    const h = fakeHistory()
    const stack = createStackHistory(h.env)
    stack.set('screens', 0, withSearch(0))
    stack.popTo('search')
    stack.popTo('chat')
    expect(h.pending()).toBe(0)
  })
})

// PLANO-MOBILE M6 N2: an entry that holds refuses the system's back.
describe('stack history: an entry that holds (M6 N2)', () => {
  it('while it holds, the system back pushes the entry again and closes nothing', () => {
    const h = fakeHistory()
    const onPop = vi.fn()
    let holding = true
    const stack = createStackHistory(h.env)
    stack.set('dialog:compose', 1, [{ key: 'dialog:compose', screen: 'dialog', onPop, holds: () => holding }])
    h.press(-1)
    expect(onPop).not.toHaveBeenCalled()
    expect(h.current()).toEqual({ tayet: 'stack', screen: 'dialog', depth: 1 })
    expect(stack.keys()).toEqual(['dialog:compose'])
    holding = false
    h.press(-1)
    expect(onPop).toHaveBeenCalledTimes(1)
  })

  it('a back over several entries is refused whole when one of them holds', () => {
    const h = fakeHistory()
    const chat = vi.fn()
    const dialog = vi.fn()
    const stack = createStackHistory(h.env)
    stack.set('screens', 0, screens(1, { chat }))
    stack.set('dialog:compose', 1, [{ key: 'dialog:compose', screen: 'dialog', onPop: dialog, holds: () => true }])
    h.press(-2)
    expect(chat).not.toHaveBeenCalled()
    expect(dialog).not.toHaveBeenCalled()
    expect(h.current()).toEqual({ tayet: 'stack', screen: 'dialog', depth: 2 })
  })
})
