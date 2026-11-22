// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { trackVisualViewport, VIEWPORT_VAR, KEYBOARD_ATTR } from '../../src/ui/visual-viewport'

// The keyboard on the narrow window (workspace.md §23.1 item 4; PLANO-MOBILE §0.15 K1). Playwright's Chromium
// opens no on-screen keyboard, so the visual viewport is simulated: its height lands on the root's CSS variable
// on every resize and scroll, the keyboard flag follows the gap to the layout viewport (pinch zoom undone by
// the scale), and stopping takes both away.

class FakeViewport extends EventTarget {
  height = 844
  scale = 1
  set(height: number, scale = 1): void {
    this.height = height
    this.scale = scale
    this.dispatchEvent(new Event('resize'))
  }
}

function setup(layout = 844) {
  const vv = new FakeViewport()
  const root = document.createElement('div')
  Object.defineProperty(root, 'clientHeight', { configurable: true, get: () => layout })
  const win = { visualViewport: vv, document } as unknown as Window
  const stop = trackVisualViewport(win, root)
  return { vv, root, stop, height: () => root.style.getPropertyValue(VIEWPORT_VAR) }
}

let stops: (() => void)[] = []
afterEach(() => {
  stops.forEach((s) => s())
  stops = []
})

describe('trackVisualViewport', () => {
  it('writes the visual viewport height at once, and again on resize and on scroll', () => {
    const t = setup()
    stops.push(t.stop)
    expect(t.height()).toBe('844px')
    t.vv.set(508)
    expect(t.height()).toBe('508px')
    t.vv.height = 500
    t.vv.dispatchEvent(new Event('scroll'))
    expect(t.height()).toBe('500px')
  })

  it('flags the keyboard while the visual viewport is shorter than the layout one; the bars coming and going do not', () => {
    const t = setup(800)
    stops.push(t.stop)
    expect(t.root.hasAttribute(KEYBOARD_ATTR)).toBe(false)
    t.vv.set(470)
    expect(t.root.hasAttribute(KEYBOARD_ATTR)).toBe(true)
    t.vv.set(860) // the toolbar collapsed: taller than the layout viewport
    expect(t.root.hasAttribute(KEYBOARD_ATTR)).toBe(false)
    t.vv.set(740)
    expect(t.root.hasAttribute(KEYBOARD_ATTR)).toBe(false)
  })

  it('a pinch zoom is not a keyboard: height × scale', () => {
    const t = setup(800)
    stops.push(t.stop)
    t.vv.set(400, 2)
    expect(t.height()).toBe('800px')
    expect(t.root.hasAttribute(KEYBOARD_ATTR)).toBe(false)
  })

  it('stopping removes the listeners, the variable and the flag', () => {
    const t = setup(800)
    t.vv.set(400)
    t.stop()
    expect(t.height()).toBe('')
    expect(t.root.hasAttribute(KEYBOARD_ATTR)).toBe(false)
    t.vv.set(300)
    expect(t.height()).toBe('')
  })

  it('without a visual viewport it does nothing', () => {
    const root = document.createElement('div')
    const stop = trackVisualViewport({ document } as unknown as Window, root)
    expect(root.style.getPropertyValue(VIEWPORT_VAR)).toBe('')
    stop()
  })
})
