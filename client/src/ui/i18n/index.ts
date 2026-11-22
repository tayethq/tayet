// Entrada única do catálogo de copy (ADR-080). Componentes importam daqui.
export { t, type Key, type Params } from './catalog'
export { APP_NAME, APP_WORDMARK, EXPORT_FILE, GLYPH, KEY_HINT } from './constants'
export {
  getLocale,
  resolveLocale,
  applyLocale,
  activeLocaleOf,
  storedLocale,
  saveStoredLocale,
  deviceLocale,
  type Locale,
} from './locale'
