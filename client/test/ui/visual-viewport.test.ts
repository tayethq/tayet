// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
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

// R3 (PLANO-MOBILE §8.21): jsdom has no layout, so the proof is which element is asked to scroll, and when.
describe('the focused field under the keyboard', () => {
  function screen({ narrow = true, layout = 844 } = {}) {
    document.body.innerHTML =
      '<div id="body" style="overflow-y: auto"><input id="first"><textarea id="long"></textarea><select id="list"></select><button id="button"></button></div>' +
      '<div id="composer"><div id="editor" contenteditable="true" tabindex="0"></div></div>'
    const scrolled: [string, unknown][] = []
    for (const el of document.querySelectorAll<HTMLElement>('[id]'))
      el.scrollIntoView = vi.fn((options?: unknown) => void scrolled.push([el.id, options]))
    const vv = new FakeViewport()
    const root = document.createElement('div')
    Object.defineProperty(root, 'clientHeight', { configurable: true, get: () => layout })
    const win = {
      visualViewport: vv,
      document,
      matchMedia: (q: string) => ({ matches: narrow && q === '(width < 728px)' }),
      getComputedStyle: (el: Element) => getComputedStyle(el),
    } as unknown as Window
    stops.push(trackVisualViewport(win, root))
    return { vv, scrolled, ids: () => scrolled.map(([id]) => id), focus: (id: string) => document.getElementById(id)!.focus() }
  }

  it('the keyboard opening scrolls the focused field to the nearest edge', () => {
    const t = screen()
    t.focus('long')
    expect(t.ids()).toEqual([])
    t.vv.set(508)
    expect(t.scrolled).toEqual([['long', { block: 'nearest' }]])
  })

  it('a keyboard that opens in steps reveals at each one; the same height, or a taller one, does not', () => {
    const t = screen()
    t.focus('first')
    t.vv.set(640)
    t.vv.set(508)
    expect(t.ids()).toEqual(['first', 'first'])
    t.vv.dispatchEvent(new Event('scroll'))
    t.vv.set(520)
    expect(t.ids()).toEqual(['first', 'first'])
  })

  it('the focus moving with the keyboard open reveals the new field', () => {
    const t = screen()
    t.vv.set(508)
    t.focus('first')
    t.focus('list')
    expect(t.ids()).toEqual(['first', 'list'])
  })

  it('with the keyboard closed neither the focus nor the browser bars move anything', () => {
    const t = screen()
    t.focus('first')
    t.focus('long')
    t.vv.set(760)
    t.vv.set(844)
    expect(t.ids()).toEqual([])
  })

  it('the composer, with no container of its own to scroll, is left where it is', () => {
    const t = screen()
    t.focus('editor')
    t.vv.set(508)
    expect(t.ids()).toEqual([])
  })

  it('a button is not a field', () => {
    const t = screen()
    t.focus('button')
    t.vv.set(508)
    expect(t.ids()).toEqual([])
  })

  it('a wide window moves nothing', () => {
    const t = screen({ narrow: false })
    t.focus('long')
    t.vv.set(508)
    t.focus('first')
    expect(t.ids()).toEqual([])
  })

  it('stopping stops the reveal', () => {
    const t = screen()
    t.vv.set(508)
    stops.pop()!()
    t.focus('first')
    expect(t.ids()).toEqual([])
  })
})
