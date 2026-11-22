import { useEffect, useLayoutEffect, useRef } from 'react'
import type { MouseEvent, PointerEvent, TouchEvent } from 'react'
import { isNarrowWindow } from './narrow'

// The long press that opens a message's action sheet (manifest workspace.md §23.8 item 1, §29 item 5;
// PLANO-MOBILE §0.12.2 R4). A timer over a touch `pointerdown`: one finger, held still. A pure core with an
// injected clock (the unit tests drive a fake one) and the row's hook.
//
// Component constants, not tokens: there is no time or distance scale for gestures.
export const LONG_PRESS_MS = 500
export const LONG_PRESS_SLOP_PX = 10

export interface PressClock {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface PressPoint {
  pointerId: number
  pointerType: string
  x: number
  y: number
}

export interface LongPress {
  down(p: PressPoint): void
  move(p: PressPoint): void
  // pointerup and pointercancel.
  up(pointerId: number): void
  // A scroll, the page hidden, the row unmounted.
  cancel(): void
  // After a fire, the touch's end and its click belong to the press: each is claimed once.
  claimTouchEnd(): boolean
  claimClick(): boolean
}

export function createLongPress({
  clock,
  allow,
  onFire,
  onArmed,
}: {
  clock: PressClock
  // Whether a press may arm now (the hook: below the width breakpoint).
  allow: () => boolean
  onFire: () => void
  onArmed?: (armed: boolean) => void
}): LongPress {
  const pointers = new Set<number>()
  let start: PressPoint | undefined
  let timer: unknown
  let touchEnd = false
  let click = false
  const disarm = (): void => {
    if (start === undefined) return
    clock.clearTimeout(timer)
    start = undefined
    onArmed?.(false)
  }
  return {
    down: (p) => {
      // Any new press owns the next click.
      touchEnd = false
      click = false
      if (p.pointerType !== 'touch') return
      pointers.add(p.pointerId)
      // A second finger is a pinch or a scroll, never a press.
      if (pointers.size > 1) return disarm()
      if (!allow()) return
      start = p
      onArmed?.(true)
      timer = clock.setTimeout(() => {
        start = undefined
        onArmed?.(false)
        touchEnd = true
        click = true
        onFire()
      }, LONG_PRESS_MS)
    },
    move: (p) => {
      if (start === undefined || p.pointerId !== start.pointerId) return
      if (Math.hypot(p.x - start.x, p.y - start.y) > LONG_PRESS_SLOP_PX) disarm()
    },
    up: (pointerId) => {
      pointers.delete(pointerId)
      if (start?.pointerId === pointerId) disarm()
    },
    cancel: disarm,
    claimTouchEnd: () => {
      const claimed = touchEnd
      touchEnd = false
      return claimed
    },
    claimClick: () => {
      const claimed = click
      click = false
      return claimed
    },
  }
}

const browserClock: PressClock = {
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (handle) => window.clearTimeout(handle as number),
}

const pointOf = (e: PointerEvent): PressPoint => ({
  pointerId: e.pointerId,
  pointerType: e.pointerType,
  x: e.clientX,
  y: e.clientY,
})

export interface LongPressHandlers {
  onPointerDown: (e: PointerEvent) => void
  onPointerMove: (e: PointerEvent) => void
  onPointerUp: (e: PointerEvent) => void
  onPointerCancel: (e: PointerEvent) => void
  onTouchEnd: (e: TouchEvent) => void
  onClickCapture: (e: MouseEvent) => void
  onContextMenu: (e: MouseEvent) => void
}

// The row's handlers. Disabled, it hands back nothing (the row's DOM is unchanged). What the press claims:
// the touch's end takes preventDefault, which stops the compatibility mouse events and the click (React
// listens to touchend as non-passive); the first click after a fire is dropped as well; a context menu from a
// touch is suppressed. A scroll anywhere or the page going hidden cancels an armed press.
export function useLongPress(enabled: boolean, onFire: () => void): LongPressHandlers | undefined {
  const latest = useRef({ enabled, onFire })
  useLayoutEffect(() => {
    latest.current = { enabled, onFire }
  })
  const touched = useRef(false)
  const press = useRef<LongPress | null>(null)
  if (press.current === null) {
    const cancel = (): void => press.current?.cancel()
    press.current = createLongPress({
      clock: browserClock,
      allow: () => latest.current.enabled && isNarrowWindow(),
      onFire: () => latest.current.onFire(),
      onArmed: (armed) => {
        const listen = (armed ? document.addEventListener : document.removeEventListener).bind(document)
        listen('scroll', cancel, true)
        listen('visibilitychange', cancel)
      },
    })
  }
  useEffect(() => () => press.current?.cancel(), [])
  if (!enabled) return undefined
  const p = press.current
  return {
    onPointerDown: (e) => {
      touched.current = e.pointerType === 'touch'
      p.down(pointOf(e))
    },
    onPointerMove: (e) => p.move(pointOf(e)),
    onPointerUp: (e) => p.up(e.pointerId),
    onPointerCancel: (e) => p.up(e.pointerId),
    onTouchEnd: (e) => {
      if (p.claimTouchEnd()) e.preventDefault()
    },
    // Only a pointer's click (detail > 0): a keyboard click (detail 0) is never the press's, even while the
    // claim is still standing because the touch's end already stopped the click.
    onClickCapture: (e) => {
      if (e.detail > 0 && p.claimClick()) {
        e.preventDefault()
        e.stopPropagation()
      }
    },
    onContextMenu: (e) => {
      if (touched.current) e.preventDefault()
    },
  }
}
