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
