// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { t } from '../src/ui/i18n'
import { resolveLocale, applyLocale, getLocale } from '../src/ui/i18n/locale'
import { ptBR } from '../src/ui/i18n/pt-BR'

// Catálogo e resolução de locale (ADR-080 D1/D2). Asserts pelo valor do catálogo (D5), nunca pelo
// literal; a interpolação e o plural são os únicos lugares em que o teste compõe a string esperada.

beforeEach(() => localStorage.clear())
afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
  applyLocale('pt-BR')
})

describe('t()', () => {
  it('resolve uma chave de família para o valor do catálogo', () => {
    expect(t('account.title')).toBe(ptBR.account.title)
    expect(t('dialog.close')).toBe(ptBR.dialog.close)
  })

  it('interpola {nome}; parâmetro ausente deixa o marcador', () => {
    expect(t('profile.viewLabel', { name: 'Ana' })).toBe(ptBR.profile.viewLabel.replace('{name}', 'Ana'))
    expect(t('profile.viewLabel')).toBe(ptBR.profile.viewLabel)
  })

  it('plural 1/N pelas regras do locale; zero pega other', () => {
    const { one, other } = ptBR.search.results
    expect(t('search.results', { n: 1 })).toBe(one.replace('{n}', '1'))
    expect(t('search.results', { n: 2 })).toBe(other.replace('{n}', '2'))
    expect(t('search.results', { n: 0 })).toBe(other.replace('{n}', '0'))
  })

  it('chave ausente é erro de typecheck (e de runtime, se forçada)', () => {
    // @ts-expect-error — a união de chaves não tem esta.
    expect(() => t('account.nope')).toThrow()
  })
})

describe('locale', () => {
  it('sem override nem browser suportado: pt-BR', () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('ja-JP')
    expect(resolveLocale()).toBe('pt-BR')
  })

  it('tayet.locale vence; tag não suportada cai para o browser, depois pt-BR', () => {
    localStorage.setItem('tayet.locale', 'pt-br')
    expect(resolveLocale()).toBe('pt-BR')
    // v0.1.0: só pt-BR existe (D7) — 'en' não é suportado ainda.
    localStorage.setItem('tayet.locale', 'en')
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('pt-PT')
    expect(resolveLocale()).toBe('pt-BR')
  })

  it('localStorage indisponível degrada para o browser / pt-BR', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US')
    expect(resolveLocale()).toBe('pt-BR')
  })

  it('applyLocale define o lang do documento e o locale de t()', () => {
    document.documentElement.lang = 'en'
    applyLocale('pt-BR')
    expect(document.documentElement.lang).toBe('pt-BR')
    expect(getLocale()).toBe('pt-BR')
  })
})
