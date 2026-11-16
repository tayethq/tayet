// Tema é trabalho de APP (UI), NUNCA domínio — não cruza o barrel/ACL (espelha session-store.ts:
// localStorage, chave neutra, best-effort). O CSS dark já existe em tokens.css sob
// [data-theme="dark"]; este módulo só decide/aplica/persiste o atributo no documentElement. Light é
// o default = ausência de atributo (contrato de styles.css). Usado pelo boot (main.tsx, síncrono,
// sem FOUC) e pelo hook useTheme.
export type Theme = 'light' | 'dark'

const THEME_KEY = 'tayet.theme'
// Chave anterior ao rename — mesma migração read-old → write-new → remove-old da sessão.
const LEGACY_THEME_KEY = 'aurora.theme'

export function loadTheme(): Theme {
  try {
    let raw = localStorage.getItem(THEME_KEY)
    if (raw === null) {
      const legacy = localStorage.getItem(LEGACY_THEME_KEY)
      if (legacy !== null) {
        localStorage.setItem(THEME_KEY, legacy)
        localStorage.removeItem(LEGACY_THEME_KEY)
        raw = legacy
      }
    }
    return raw === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

export function saveTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_KEY, theme)
  } catch {
    // best-effort
  }
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement
  if (theme === 'dark') root.setAttribute('data-theme', 'dark')
  else root.removeAttribute('data-theme') // light = sem atributo (contrato de styles.css)
}
