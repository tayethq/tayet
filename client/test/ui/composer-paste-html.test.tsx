// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { act } from 'react'
import { RichComposer } from '../../src/ui/composer/RichComposer'
import { richTextContent } from '@tayet/shared/internal'
import type { ComposeResult } from '../../src/ui/compose'

// PLANO §8.26 debt: the text/html PASTE path of the composer — the path of the TipTap/ProseMirror
// advisories — had no test. A real paste event with text/html clipboard data goes through
// ProseMirror's own clipboard parser (parseFromClipboard → DOMParser → schema parse rules), the same
// code a user's paste runs. Assertion: no executable attribute and no javascript: scheme reaches the
// editor DOM, the ComposeResult handed to onSend, or the HTML the ACL serializes for the wire.

const PAYLOADS: Array<{ name: string; html: string; text: string }> = [
  { name: 'img onerror', html: '<p>before</p><img src=x onerror="window.__pwned=1">', text: 'before' },
  { name: 'javascript: link', html: '<p><a href="javascript:window.__pwned=1">click</a> me</p>', text: 'click me' },
  {
    name: 'entity-obfuscated javascript: link',
    html: '<p><a href="jav&#x09;ascript:window.__pwned=1">tab</a> <a href=" JaVaScRiPt:alert(1)">case</a></p>',
    text: 'tab case',
  },
  { name: '__proto__ attribute', html: '<p __proto__="polluted" constructor="x"><strong __proto__="y">bold</strong></p>', text: 'bold' },
  { name: 'script tag', html: '<p>safe</p><script>window.__pwned=1</script>', text: 'safe' },
  {
    name: 'event handlers on allowed tags',
    html: '<p onclick="window.__pwned=1"><em onmouseover="window.__pwned=1">em</em> <code onfocus="x()">c</code></p>',
    text: 'em c',
  },
  { name: 'svg/iframe/style', html: '<svg onload="window.__pwned=1"><a xlink:href="javascript:1">s</a></svg><iframe src="javascript:1"></iframe><p style="background:url(javascript:1)">styled</p>', text: 'styled' },
]

function pasteHtml(editable: HTMLElement, html: string, text: string): void {
  editable.focus()
  const paste = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(paste, 'clipboardData', {
    value: {
      getData: (t: string) => (t === 'text/html' ? html : t === 'text/plain' ? text : ''),
      types: ['text/html', 'text/plain'],
      files: [],
      items: [],
    },
  })
  act(() => {
    editable.dispatchEvent(paste)
  })
}

// Every attribute in a subtree, as "name=value".
function attributesOf(root: Element): string[] {
  const out: string[] = []
  for (const el of [root, ...Array.from(root.querySelectorAll('*'))])
    for (const a of Array.from(el.attributes)) out.push(`${a.name}=${a.value}`)
  return out
}

const EXECUTABLE_ATTR = /^on[a-z]+=/i
const JS_SCHEME = /^\s*j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t\s*:/i

function expectInert(editable: HTMLElement, body: ComposeResult | undefined): void {
  // Editor DOM: no on* handler, no javascript: in any attribute, no forbidden element.
  for (const attr of attributesOf(editable)) {
    expect(attr).not.toMatch(EXECUTABLE_ATTR)
    const value = attr.slice(attr.indexOf('=') + 1)
    expect(value).not.toMatch(JS_SCHEME)
    expect(attr.startsWith('__proto__') || attr.startsWith('constructor=')).toBe(false)
  }
  expect(editable.querySelector('script, img, svg, iframe, style, [style]')).toBeNull()
  expect(editable.innerHTML.toLowerCase()).not.toContain('javascript:')
  expect((window as { __pwned?: number }).__pwned).toBeUndefined()

  // The sent body (ComposeResult) and the wire HTML the ACL serializes from it.
  expect(body).toBeDefined()
  const sent = JSON.stringify(body)
  expect(sent.toLowerCase()).not.toContain('javascript:')
  expect(sent).not.toMatch(/"on[a-z]+"|__proto__|<script|onerror/i)
  const wire = richTextContent(body!.text, body!.rich)
  const formatted = wire.formatted_body ?? ''
  expect(formatted.toLowerCase()).not.toContain('javascript:')
  expect(formatted).not.toMatch(/\son[a-z]+=|<script|<img|<svg|<iframe|style=|__proto__/i)
  expect(Object.getPrototypeOf({}).polluted).toBeUndefined()
}

afterEach(() => {
  cleanup()
  delete (window as { __pwned?: number }).__pwned
})

describe('composer — text/html paste is inert (PLANO §8.26)', () => {
  for (const p of PAYLOADS) {
    it(`${p.name}: no executable attribute or javascript: scheme reaches the editor or the sent body`, () => {
      const onSend = vi.fn()
      const { container, getByRole } = render(<RichComposer onSend={onSend} />)
      const editable = container.querySelector('[contenteditable="true"]') as HTMLElement
      pasteHtml(editable, p.html, p.text)

      // The paste actually landed (positive control: the safe text is in the editor).
      for (const word of p.text.split(' ')) expect(editable.textContent).toContain(word)

      act(() => {
        getByRole('button', { name: 'Enviar' }).click()
      })
      expect(onSend).toHaveBeenCalledTimes(1)
      // Inspect the editor DOM as it was sent: re-paste (send cleared it) for the DOM check.
      const body = onSend.mock.calls[0]![0] as ComposeResult
      pasteHtml(editable, p.html, p.text)
      expectInert(editable, body)
    })
  }

  it('a safe https link survives the paste (the allowlist is not just "drop everything")', () => {
    const onSend = vi.fn()
    const { container, getByRole } = render(<RichComposer onSend={onSend} />)
    const editable = container.querySelector('[contenteditable="true"]') as HTMLElement
    pasteHtml(editable, '<p><a href="https://example.com/doc" onclick="x()">doc</a></p>', 'doc')
    const link = editable.querySelector('a')
    expect(link?.getAttribute('href')).toBe('https://example.com/doc')
    expect(link?.hasAttribute('onclick')).toBe(false)
    act(() => {
      getByRole('button', { name: 'Enviar' }).click()
    })
    expect(JSON.stringify(onSend.mock.calls[0]![0])).toContain('https://example.com/doc')
  })
})
