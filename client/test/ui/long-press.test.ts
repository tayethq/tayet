// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import {
  createLongPress,
  useLongPress,
  LONG_PRESS_MS,
  LONG_PRESS_SLOP_PX,
  type PressClock,
  type PressPoint,
} from '../../src/ui/long-press'

// The long press that opens the action sheet (PLANO-MOBILE §0.12.2 R4, workspace.md §23.8 item 1, §29 item
// 5): 500 ms of one still touch finger; every cancellation of R4; the touch's end and the click after a fire
// claimed once; a context menu from a touch suppressed. A fake clock drives the core.

function fakeClock() {
  let now = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  let next = 1
  const clock: PressClock = {
    setTimeout: (fn, ms) => {
      timers.set(next, { at: now + ms, fn })
      return next++
    },
    clearTimeout: (h) => void timers.delete(h as number),
  }
  const advance = (ms: number) => {
    now += ms
    for (const [h, t] of [...timers]) {
      if (t.at <= now) {
        timers.delete(h)
        t.fn()
      }
    }
  }
  return { clock, advance, pending: () => timers.size }
}

const touch = (over: Partial<PressPoint> = {}): PressPoint => ({ pointerId: 1, pointerType: 'touch', x: 100, y: 100, ...over })

function press(allow = () => true) {
  const c = fakeClock()
  const onFire = vi.fn()
  const onArmed = vi.fn()
  const p = createLongPress({ clock: c.clock, allow, onFire, onArmed })
  return { ...c, p, onFire, onArmed }
}

describe('long press core', () => {
  it('fires after 500 ms of a still touch', () => {
    const { p, advance, onFire } = press()
    p.down(touch())
    advance(LONG_PRESS_MS - 1)
    expect(onFire).not.toHaveBeenCalled()
    advance(1)
    expect(onFire).toHaveBeenCalledOnce()
  })

  it('a mouse or a pen never arms', () => {
    const { p, advance, onFire } = press()
    p.down(touch({ pointerType: 'mouse' }))
    p.down(touch({ pointerId: 2, pointerType: 'pen' }))
    advance(LONG_PRESS_MS)
    expect(onFire).not.toHaveBeenCalled()
  })

  it('does not arm where it is not allowed (the wide window, N7 b)', () => {
    const { p, advance, onFire } = press(() => false)
    p.down(touch())
    advance(LONG_PRESS_MS)
    expect(onFire).not.toHaveBeenCalled()
  })

  it('moving within the tolerance keeps it; past it cancels', () => {
    const kept = press()
    kept.p.down(touch())
    kept.p.move(touch({ x: 100 + LONG_PRESS_SLOP_PX }))
    kept.advance(LONG_PRESS_MS)
    expect(kept.onFire).toHaveBeenCalledOnce()

    const moved = press()
    moved.p.down(touch())
    moved.p.move(touch({ x: 100 + 8, y: 100 + 8 }))
    moved.advance(LONG_PRESS_MS)
    expect(moved.onFire).not.toHaveBeenCalled()
  })

  it('a move of another pointer does not count', () => {
    const { p, advance, onFire } = press()
    p.down(touch())
    p.move(touch({ pointerId: 9, x: 400 }))
    advance(LONG_PRESS_MS)
    expect(onFire).toHaveBeenCalledOnce()
  })

  it('lifting the finger before the time cancels (pointerup and pointercancel)', () => {
    for (const end of ['up', 'cancel'] as const) {
      const { p, advance, onFire, pending } = press()
      p.down(touch())
      advance(LONG_PRESS_MS - 100)
      p.up(1)
      expect(pending()).toBe(0)
      advance(200)
      expect(onFire, end).not.toHaveBeenCalled()
    }
  })

  it('a second finger cancels', () => {
    const { p, advance, onFire } = press()
    p.down(touch())
    p.down(touch({ pointerId: 2 }))
    advance(LONG_PRESS_MS)
    expect(onFire).not.toHaveBeenCalled()
  })

  it('a scroll, the page hidden or the unmount cancels (cancel())', () => {
    const { p, advance, onFire, onArmed } = press()
    p.down(touch())
    expect(onArmed).toHaveBeenLastCalledWith(true)
    p.cancel()
    expect(onArmed).toHaveBeenLastCalledWith(false)
    advance(LONG_PRESS_MS)
    expect(onFire).not.toHaveBeenCalled()
  })

  it('after a fire the touch end and the click are claimed once each; a new press clears them', () => {
    const { p, advance } = press()
    expect(p.claimTouchEnd()).toBe(false)
    expect(p.claimClick()).toBe(false)
    p.down(touch())
    advance(LONG_PRESS_MS)
    p.up(1)
    expect(p.claimTouchEnd()).toBe(true)
    expect(p.claimTouchEnd()).toBe(false)
    expect(p.claimClick()).toBe(true)
    expect(p.claimClick()).toBe(false)

    p.down(touch())
    advance(LONG_PRESS_MS)
    p.down(touch({ pointerId: 3, pointerType: 'mouse' }))
    expect(p.claimClick()).toBe(false)
  })

  it('a short tap claims nothing: the link or the pill under it works', () => {
    const { p, advance } = press()
    p.down(touch())
    advance(100)
    p.up(1)
    expect(p.claimTouchEnd()).toBe(false)
    expect(p.claimClick()).toBe(false)
  })
})

describe('useLongPress', () => {
  afterEach(() => vi.useRealTimers())

  const narrow = (matches: boolean) =>
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(width < 728px)' ? matches : false, addEventListener() {}, removeEventListener() {} }))

  const ev = (over: Record<string, unknown> = {}) =>
    ({ pointerId: 1, pointerType: 'touch', clientX: 10, clientY: 10, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...over }) as never

  it('disabled, it hands back nothing', () => {
    const { result } = renderHook(() => useLongPress(false, () => {}))
    expect(result.current).toBeUndefined()
  })

  it('suppresses what was under the finger after a fire, and the context menu of a touch', () => {
    vi.useFakeTimers()
    narrow(true)
    const onFire = vi.fn()
    const { result } = renderHook(() => useLongPress(true, onFire))
    const h = result.current!
    h.onPointerDown(ev())
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(onFire).toHaveBeenCalledOnce()
    h.onPointerUp(ev())
    const end = ev()
    h.onTouchEnd(end)
    expect((end as { preventDefault: () => void }).preventDefault).toHaveBeenCalled()
    // A keyboard click (detail 0) is left alone, and does not spend the claim; the pointer's click is dropped.
    const keyboard = ev({ detail: 0 })
    h.onClickCapture(keyboard)
    expect((keyboard as { stopPropagation: () => void }).stopPropagation).not.toHaveBeenCalled()
    const click = ev({ detail: 1 })
    h.onClickCapture(click)
    expect((click as { stopPropagation: () => void }).stopPropagation).toHaveBeenCalled()
    const menu = ev()
    h.onContextMenu(menu)
    expect((menu as { preventDefault: () => void }).preventDefault).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('a mouse keeps its context menu; the wide window never arms', () => {
    vi.useFakeTimers()
    narrow(false)
    const onFire = vi.fn()
    const { result } = renderHook(() => useLongPress(true, onFire))
    result.current!.onPointerDown(ev())
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(onFire).not.toHaveBeenCalled()
    result.current!.onPointerDown(ev({ pointerType: 'mouse' }))
    const menu = ev()
    result.current!.onContextMenu(menu)
    expect((menu as { preventDefault: () => void }).preventDefault).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('a scroll anywhere cancels an armed press', () => {
    vi.useFakeTimers()
    narrow(true)
    const onFire = vi.fn()
    const { result } = renderHook(() => useLongPress(true, onFire))
    result.current!.onPointerDown(ev())
    document.dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(LONG_PRESS_MS)
    expect(onFire).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
