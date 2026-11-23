// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { Field } from '../../src/ui/primitives'
import { trackVisualViewport, KEYBOARD_ATTR } from '../../src/ui/visual-viewport'

// W6 (PLANO-MOBILE §0.20): on a narrow window with the keyboard open, a field inside the `Field` primitive brings
// its whole box (label, control, error and hint) into sight, also when its error shows or changes with the focus
// in it. A field outside the primitive keeps the R3 rule (the control alone). jsdom has no layout: the proof is
// which element is asked to scroll.

let narrow = true
let scrolled: string[] = []
beforeEach(() => {
  narrow = true
  scrolled = []
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: narrow && q === '(width < 728px)' }))
  // jsdom has no scrollIntoView: each call is recorded by the element's name.
  Element.prototype.scrollIntoView = function (this: HTMLElement) {
    scrolled.push(this.dataset.name ?? this.id)
  }
  document.documentElement.setAttribute(KEYBOARD_ATTR, '')
})
afterEach(() => {
  cleanup()
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
  vi.unstubAllGlobals()
  document.documentElement.removeAttribute(KEYBOARD_ATTR)
})

function Form({ error, other, scroll = true }: { error?: string; other?: string; scroll?: boolean }) {
  return (
    <div style={{ overflowY: scroll ? 'auto' : 'visible' }}>
      <Field label="Valor" htmlFor="value" error={error} hint="Em reais" />
      <Field label="Nota" htmlFor="note" error={other} />
      <input id="loose" />
    </div>
  )
}
const box = (id: string) => document.getElementById(id)!.closest<HTMLElement>('.ui-field')!
const mark = () => {
  box('value').dataset.name = 'value-box'
  box('note').dataset.name = 'note-box'
}

describe('W6: the error under the focused field', () => {
  it('an error that shows with the field focused scrolls the whole box; a new error again', () => {
    const r = render(<Form />)
    mark()
    document.getElementById('value')!.focus()
    r.rerender(<Form error="Obrigatório" />)
    expect(scrolled).toEqual(['value-box'])
    r.rerender(<Form error="Use um número" />)
    expect(scrolled).toEqual(['value-box', 'value-box'])
  })

  it('with the keyboard closed, or a wide window, nothing moves', () => {
    const r = render(<Form />)
    mark()
    document.getElementById('value')!.focus()
    document.documentElement.removeAttribute(KEYBOARD_ATTR)
    r.rerender(<Form error="Obrigatório" />)
    document.documentElement.setAttribute(KEYBOARD_ATTR, '')
    narrow = false
    r.rerender(<Form error="Use um número" />)
    expect(scrolled).toEqual([])
  })

  it("another row's error, or a field outside the primitive, moves nothing", () => {
    const r = render(<Form />)
    mark()
    document.getElementById('value')!.focus()
    r.rerender(<Form other="Obrigatório" />)
    document.getElementById('loose')!.focus()
    r.rerender(<Form error="Obrigatório" other="Obrigatório" />)
    expect(scrolled).toEqual([])
  })

  it('a field with no container to scroll in is left where it is', () => {
    const r = render(<Form scroll={false} />)
    mark()
    document.getElementById('value')!.focus()
    r.rerender(<Form scroll={false} error="Obrigatório" />)
    expect(scrolled).toEqual([])
  })
})

describe('W6: the keyboard and the focus (the R3 triggers)', () => {
  class FakeViewport extends EventTarget {
    height = 844
    scale = 1
    set(height: number): void {
      this.height = height
      this.dispatchEvent(new Event('resize'))
    }
  }
  it('inside a Field the box scrolls; a field outside the primitive scrolls alone', () => {
    document.documentElement.removeAttribute(KEYBOARD_ATTR)
    render(<Form />)
    mark()
    const vv = new FakeViewport()
    const root = document.createElement('div')
    Object.defineProperty(root, 'clientHeight', { configurable: true, get: () => 844 })
    const win = { visualViewport: vv, document, matchMedia, getComputedStyle: (el: Element) => getComputedStyle(el) } as unknown as Window
    const stop = trackVisualViewport(win, root)
    document.getElementById('value')!.focus()
    vv.set(508)
    document.getElementById('loose')!.focus()
    stop()
    expect(scrolled).toEqual(['value-box', 'loose'])
  })
})
