import { afterAll } from 'vitest'

// Vitest global setup — runs once per test file, inside that file's environment (node or jsdom).
// Purpose: make the real TipTap/ProseMirror editor survive jsdom, which has no layout engine.
// Product code is untouched; these are ambient environment shims for the test host only.

// TipTap re-renders per transaction (shouldRerenderOnTransaction); under React 19 in jsdom those
// updates can land outside act() and pollute stderr. Marking the environment act-aware keeps
// React's act bookkeeping consistent (Testing Library already sets this on import; we make it
// explicit and deterministic regardless of import order).
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom implements no layout, so prosemirror-view's coordsAtPos → singleRect calls
// getClientRects()/getBoundingClientRect() on an Element or a Range while resolving the caret for
// scrollIntoView (fired on every selection move). In this jsdom those come back missing on the
// Range path, throwing "target.getClientRects is not a function" as an *unhandled* error — the
// rich-composer tests still pass, but Vitest flags it as a possible false positive. Inert stub:
// an empty rect list + a zero rect. singleRect finds no non-zero rect and no-ops the scroll, which
// is exactly right in a headless DOM. Only the two methods singleRect actually calls are stubbed.
if (typeof Element !== 'undefined') {
  const zeroRect = (): DOMRect =>
    ({
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect
  const emptyRectList = (): DOMRectList =>
    Object.assign([] as DOMRect[], { item: () => null }) as unknown as DOMRectList

  Element.prototype.getClientRects = emptyRectList
  Element.prototype.getBoundingClientRect = zeroRect
  if (typeof Range !== 'undefined') {
    Range.prototype.getClientRects = emptyRectList
    Range.prototype.getBoundingClientRect = zeroRect
  }
}

// @tiptap/react does not destroy an editor on unmount: it schedules `editor.destroy()` on a 1 ms
// setTimeout (EditorInstanceManager.scheduleDestroy). After the last test's cleanup that timer can
// still be pending when the file's jsdom environment is torn down, and the destroy then throws
// "window is not defined" as an unhandled error (public CI run 43862011014). This hook runs after
// every afterAll of the test file (sequence.hooks "stack": setup hooks are registered first, so they
// run last) and waits one 1 ms timer: Node fires timers of equal duration in insertion order, so every
// destroy the file's unmounts scheduled has finished before the environment goes away. The real
// setTimeout is captured here, before any test can install fake timers.
if (typeof Element !== 'undefined') {
  const realSetTimeout = globalThis.setTimeout
  afterAll(() => new Promise<void>((resolve) => realSetTimeout(resolve, 1)))
}
