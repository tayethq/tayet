// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { loadTheme, saveTheme, applyTheme, type Theme } from '../src/ui/theme'

beforeEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
})
afterEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
})

describe('theme (app-side, persistência + aplicação)', () => {
  it('default é light quando nada persistido', () => {
    expect(loadTheme()).toBe('light')
  })

  it('persiste e relê o tema (roundtrip)', () => {
    saveTheme('dark')
    expect(loadTheme()).toBe('dark')
    saveTheme('light')
    expect(loadTheme()).toBe('light')
  })

  it('aplica dark como data-theme no documentElement; light remove o atributo', () => {
    applyTheme('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    applyTheme('light')
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })

  it('migra a chave legada: tema preservado, chave legada removida, nova presente', () => {
    localStorage.setItem('aurora.theme', 'dark')
    expect(loadTheme()).toBe('dark')
    expect(localStorage.getItem('tayet.theme')).toBe('dark')
    expect(localStorage.getItem('aurora.theme')).toBeNull()
  })

  it('chave nova presente vence a legada (a legada não é lida nem removida)', () => {
    localStorage.setItem('tayet.theme', 'light')
    localStorage.setItem('aurora.theme', 'dark')
    expect(loadTheme()).toBe('light')
    expect(localStorage.getItem('aurora.theme')).toBe('dark')
  })

  it('loadTheme degrada pra light se localStorage lançar', () => {
    const orig = Storage.prototype.getItem
    Storage.prototype.getItem = () => {
      throw new Error('blocked')
    }
    const t: Theme = loadTheme()
    Storage.prototype.getItem = orig
    expect(t).toBe('light')
  })
})

// The browser-chrome color follows the applied theme: a minimal stylesheet stands in for tokens.css.
describe('theme-color meta follows the applied theme', () => {
  const LIGHT = 'rgb(1, 2, 3)'
  const DARK = 'rgb(4, 5, 6)'
  let style: HTMLStyleElement | null = null
  const metas = () => document.head.querySelectorAll('meta[name="theme-color"]')

  const injectCss = () => {
    style = document.createElement('style')
    style.textContent = `:root { --color-bg: ${LIGHT}; } [data-theme="dark"] { --color-bg: ${DARK}; }`
    document.head.appendChild(style)
  }

  afterEach(() => {
    style?.remove()
    style = null
    metas().forEach((m) => m.remove())
  })

  it('light → the light value', () => {
    injectCss()
    applyTheme('light')
    expect(metas()).toHaveLength(1)
    expect(metas()[0]?.getAttribute('content')).toBe(LIGHT)
  })

  it('dark → the dark value', () => {
    injectCss()
    applyTheme('dark')
    expect(metas()).toHaveLength(1)
    expect(metas()[0]?.getAttribute('content')).toBe(DARK)
  })

  it('back to light → the light value, still a single meta', () => {
    injectCss()
    applyTheme('light')
    applyTheme('dark')
    applyTheme('light')
    expect(metas()).toHaveLength(1)
    expect(metas()[0]?.getAttribute('content')).toBe(LIGHT)
  })

  it('without the variable → no meta', () => {
    applyTheme('light')
    applyTheme('dark')
    expect(metas()).toHaveLength(0)
  })
})
