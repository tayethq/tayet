// The language is app work (UI), never domain. It is resolved once in the boot (main.tsx, synchronous,
// before the render) and read by t() and by every formatter.
//
// The person's choice lives in their account, so it follows them to every device. This module only
// knows the device's copy of it: tayet.locale in localStorage, written when the account has a language
// and removed when it is on Automatic. The copy serves everything that runs before a session exists
// (the sign-in screen, the boot); once connected, the Boot reconciles it with the account.
//
// LOCALES are the languages that have a catalog; ACTIVE_LOCALES are the ones a person can get.
// resolveLocale only returns an active one. applyLocale takes any existing language, so tests can
// render one that is not active.
export const LOCALES = ['pt-BR', 'en'] as const
export type Locale = (typeof LOCALES)[number]
export const ACTIVE_LOCALES: readonly Locale[] = ['pt-BR', 'en']
// The module's state before applyLocale runs. Resolution never falls back to it.
export const DEFAULT_LOCALE: Locale = 'pt-BR'
// What resolution gives someone whose device speaks none of the active languages.
export const FALLBACK_LOCALE: Locale = 'en'

const LOCALE_KEY = 'tayet.locale'

let current: Locale = DEFAULT_LOCALE

// BCP 47 tag → active language: equal (ignoring case), else by the language part ('pt' / 'pt-PT' →
// 'pt-BR'). Only active languages match.
function match(tag: string | null | undefined): Locale | null {
  if (!tag) return null
  const lower = tag.toLowerCase()
  const exact = ACTIVE_LOCALES.find((l) => l.toLowerCase() === lower)
  if (exact) return exact
  const language = lower.split('-')[0]
  return ACTIVE_LOCALES.find((l) => l.toLowerCase().split('-')[0] === language) ?? null
}

// The browser's languages in its order of preference; navigator.language when the list is missing.
function browserLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return []
  return navigator.languages?.length ? navigator.languages : [navigator.language]
}

// A language as the account stores it → an active language, or null (absent or one we do not have,
// which both count as Automatic). Exact: the account only ever holds a value this module wrote.
export function activeLocaleOf(value: string | undefined): Locale | null {
  return ACTIVE_LOCALES.find((l) => l === value) ?? null
}

// The device's copy of the account's choice: an active language, or null (Automatic, no copy, or a
// copy that is not an active language).
export function storedLocale(): Locale | null {
  try {
    return match(localStorage.getItem(LOCALE_KEY))
  } catch {
    return null
  }
}

// Write the copy (a language) or remove it (null = Automatic). Best-effort: the caller reads it back
// with storedLocale() to know whether it took.
export function saveStoredLocale(locale: Locale | null): void {
  try {
    if (locale) localStorage.setItem(LOCALE_KEY, locale)
    else localStorage.removeItem(LOCALE_KEY)
  } catch {
    // localStorage unavailable: the read-back tells the caller.
  }
}

// What Automatic gives on this device: the first of the browser's languages we have, else English.
export function deviceLocale(): Locale {
  for (const tag of browserLanguages()) {
    const browser = match(tag)
    if (browser) return browser
  }
  return FALLBACK_LOCALE
}

// The copy, then the browser's languages in order, then English.
export function resolveLocale(): Locale {
  return storedLocale() ?? deviceLocale()
}

export function applyLocale(locale: Locale): void {
  current = locale
  document.documentElement.lang = locale
}

export function getLocale(): Locale {
  return current
}
