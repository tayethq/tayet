// Locale é trabalho de APP (UI), NUNCA domínio — não cruza o barrel/ACL (ADR-080 D2; molde de
// theme.ts: localStorage, chave neutra, best-effort). Resolvido uma vez no boot (main.tsx, síncrono,
// antes do render) e lido por t() e por toda formatação (ADR-080 D3). Nunca por conta: o boot/login
// roda antes de existir sessão.
//
// No v0.1.0 só pt-BR existe (ADR-080 D7): todo caminho da resolução cai nele. O `en` entra em
// LOCALES junto com o catálogo dele; a ordem da resolução já é a definitiva.
export const LOCALES = ['pt-BR'] as const
export type Locale = (typeof LOCALES)[number]
export const DEFAULT_LOCALE: Locale = 'pt-BR'

const LOCALE_KEY = 'tayet.locale'

let current: Locale = DEFAULT_LOCALE

// Tag BCP 47 → locale suportado: igual (sem caixa), senão pela língua ('pt' / 'pt-PT' → 'pt-BR').
function match(tag: string | null | undefined): Locale | null {
  if (!tag) return null
  const lower = tag.toLowerCase()
  const exact = LOCALES.find((l) => l.toLowerCase() === lower)
  if (exact) return exact
  const language = lower.split('-')[0]
  return LOCALES.find((l) => l.toLowerCase().split('-')[0] === language) ?? null
}

// tayet.locale (override por dispositivo) > navigator.language > pt-BR.
export function resolveLocale(): Locale {
  try {
    const stored = match(localStorage.getItem(LOCALE_KEY))
    if (stored) return stored
  } catch {
    // localStorage indisponível: segue para o browser.
  }
  if (typeof navigator !== 'undefined') {
    const browser = match(navigator.language)
    if (browser) return browser
  }
  return DEFAULT_LOCALE
}

export function applyLocale(locale: Locale): void {
  current = locale
  document.documentElement.lang = locale
}

export function getLocale(): Locale {
  return current
}
