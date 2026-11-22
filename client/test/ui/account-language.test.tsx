// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, cleanup, fireEvent, renderHook, act, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { AccountSettings } from '../../src/ui/components/AccountSettings'
import { useLanguage, type LanguageState } from '../../src/ui/useLanguage'
import { LANGUAGE_SAVE_TIMEOUT_MS } from '../../src/ui/language'
import { applyLocale } from '../../src/ui/i18n'
import { ptBR } from '../../src/ui/i18n/pt-BR'
import { en } from '../../src/ui/i18n/en'
import { fill } from '../support/copy'
import { noExport } from '../support/data-export-fake'

// The language row of "Sua conta" (account-access.md §14): right after Aparência in the same block, a
// native select with the three options, the subtitle by state, and the hook behind it (account first,
// then the copy, then the reload; a failure leaves everything as it was).

const copy = ptBR.account

function language(over: Partial<LanguageState> = {}): LanguageState {
  return { choice: 'auto', shown: 'auto', status: 'idle', onChange: () => {}, onDismissFailure: () => {}, ...over }
}

function account(lang: LanguageState, props: Partial<ComponentProps<typeof AccountSettings>> = {}) {
  return render(
    <AccountSettings
      open
      accesses={[]}
      onLoadProfile={async () => ({ fullName: 'Marina' })}
      onSaveProfile={async () => {}}
      onSaveAvatar={async () => {}}
      onClearAvatar={async () => {}}
      onExportData={noExport}
      onReset={() => {}}
      onSignOut={() => {}}
      theme="light"
      onThemeChange={() => {}}
      language={lang}
      onClose={() => {}}
      {...props}
    />,
  )
}

const row = (root: HTMLElement) => root.querySelector<HTMLElement>('.account-settings__language')!
const select = (root: HTMLElement) => row(root).querySelector('select')!
const subtitle = (root: HTMLElement) => row(root).querySelector('.account-settings__language-subtitle')!.textContent

beforeEach(() => localStorage.clear())
afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.restoreAllMocks()
  applyLocale('pt-BR')
})

describe('the language row (account-access.md §14.1)', () => {
  it('sits right after Aparência, with no divider between the two', () => {
    const { container } = account(language())
    const appearance = container.querySelector('.account-settings__appearance')!
    expect(appearance.nextElementSibling).toBe(row(container))
    expect(row(container).nextElementSibling?.tagName).toBe('HR')
  })

  it('is a native select named "Idioma" with Automático, Português and English', () => {
    const { container } = account(language())
    expect(select(container).getAttribute('aria-label')).toBe(copy.language)
    expect([...select(container).options].map((o) => [o.value, o.textContent])).toEqual([
      ['auto', copy.languageAuto],
      ['pt-BR', copy.languagePt],
      ['en', copy.languageEn],
    ])
    expect(row(container).querySelector('.account-settings__language-title')!.textContent).toBe(copy.language)
  })

  it('Automático: the subtitle names the language the page is in', () => {
    const { container } = account(language())
    expect(subtitle(container)).toBe(fill(copy.languageDevice, { language: copy.languagePt }))
    expect(row(container).querySelector('.account-settings__language-value')!.textContent).toBe(copy.languageAuto)
  })

  it('Automático in English: "This device\'s language: English"', () => {
    applyLocale('en')
    const { container } = account(language())
    expect(subtitle(container)).toBe(fill(en.account.languageDevice, { language: en.account.languageEn }))
  })

  it('a chosen language: "Em todos os seus aparelhos"', () => {
    const { container } = account(language({ choice: 'en', shown: 'en' }))
    expect(subtitle(container)).toBe(copy.languageEverywhere)
    expect(select(container).value).toBe('en')
  })

  it('saving: the control is disabled and shows the new choice; the subtitle stays', () => {
    const { container } = account(language({ choice: 'auto', shown: 'en', status: 'saving' }))
    expect(row(container).dataset.status).toBe('saving')
    expect(select(container).disabled).toBe(true)
    expect(select(container).value).toBe('en')
    expect(subtitle(container)).toBe(fill(copy.languageDevice, { language: copy.languagePt }))
  })

  it('failed: the control is back on the choice and the subtitle says it failed', () => {
    const { container } = account(language({ choice: 'auto', shown: 'auto', status: 'failed' }))
    expect(row(container).dataset.status).toBe('failed')
    expect(select(container).disabled).toBe(false)
    expect(select(container).value).toBe('auto')
    expect(subtitle(container)).toBe(copy.languageFailed)
  })

  it('a pick goes to onChange; closing "Sua conta" dismisses a failure', () => {
    const onChange = vi.fn()
    const onDismissFailure = vi.fn()
    const onClose = vi.fn()
    const { container, getByRole } = account(language({ onChange, onDismissFailure, status: 'failed' }), { onClose })
    fireEvent.change(select(container), { target: { value: 'en' } })
    expect(onChange).toHaveBeenCalledWith('en')
    fireEvent.click(getByRole('button', { name: ptBR.dialog.close }))
    expect(onDismissFailure).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('useLanguage', () => {
  it('starts from the copy: none is Automatic', () => {
    const { result } = renderHook(() => useLanguage({ setAccountPreferences: async () => {} }, () => {}))
    expect(result.current).toMatchObject({ choice: 'auto', shown: 'auto', status: 'idle' })
    localStorage.setItem('tayet.locale', 'en')
    const second = renderHook(() => useLanguage({ setAccountPreferences: async () => {} }, () => {}))
    expect(second.result.current.choice).toBe('en')
  })

  it('a change: saving, account written, copy written, then one reload', async () => {
    let confirm!: () => void
    const setAccountPreferences = vi.fn(() => new Promise<void>((r) => (confirm = r)))
    const reload = vi.fn()
    const { result } = renderHook(() => useLanguage({ setAccountPreferences }, reload))
    act(() => result.current.onChange('en'))
    expect(result.current).toMatchObject({ status: 'saving', shown: 'en', choice: 'auto' })
    expect(setAccountPreferences).toHaveBeenCalledWith({ language: 'en' })
    expect(localStorage.getItem('tayet.locale')).toBeNull()
    expect(reload).not.toHaveBeenCalled()
    await act(async () => confirm())
    expect(localStorage.getItem('tayet.locale')).toBe('en')
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('Automatic writes an empty language and removes the copy', async () => {
    localStorage.setItem('tayet.locale', 'en')
    const setAccountPreferences = vi.fn(async () => {})
    const reload = vi.fn()
    const { result } = renderHook(() => useLanguage({ setAccountPreferences }, reload))
    await act(async () => result.current.onChange('auto'))
    expect(setAccountPreferences).toHaveBeenCalledWith({ language: '' })
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    expect(localStorage.getItem('tayet.locale')).toBeNull()
  })

  it('a failed write: back to the previous choice, failed, no copy, no reload', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const reload = vi.fn()
    const { result } = renderHook(() =>
      useLanguage(
        {
          setAccountPreferences: async () => {
            throw new Error('network')
          },
        },
        reload,
      ),
    )
    await act(async () => result.current.onChange('en'))
    await waitFor(() => expect(result.current.status).toBe('failed'))
    expect(result.current.shown).toBe('auto')
    expect(localStorage.getItem('tayet.locale')).toBeNull()
    expect(reload).not.toHaveBeenCalled()
    act(() => result.current.onDismissFailure())
    expect(result.current.status).toBe('idle')
  })

  it('a write past the ceiling is a failure', async () => {
    vi.useFakeTimers()
    try {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const reload = vi.fn()
      const { result } = renderHook(() => useLanguage({ setAccountPreferences: () => new Promise<void>(() => {}) }, reload))
      act(() => result.current.onChange('en'))
      await act(async () => vi.advanceTimersByTimeAsync(LANGUAGE_SAVE_TIMEOUT_MS))
      expect(result.current.status).toBe('failed')
      expect(reload).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a copy that does not take: failed, no reload', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const reload = vi.fn()
    const { result } = renderHook(() => useLanguage({ setAccountPreferences: async () => {} }, reload))
    await act(async () => result.current.onChange('en'))
    await waitFor(() => expect(result.current.status).toBe('failed'))
    expect(reload).not.toHaveBeenCalled()
  })

  it('a second pick while saving is ignored', () => {
    const setAccountPreferences = vi.fn(() => new Promise<void>(() => {}))
    const { result } = renderHook(() => useLanguage({ setAccountPreferences }, () => {}))
    act(() => result.current.onChange('en'))
    act(() => result.current.onChange('pt-BR'))
    expect(setAccountPreferences).toHaveBeenCalledTimes(1)
  })
})
