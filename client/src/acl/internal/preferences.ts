// The account's interface preferences, persisted in account data under their own key, apart from the
// profile (which holds identity data). Pure helpers — no SDK, no protocol object — so they are
// unit-testable without the live stack; matrix-client wires them to the account-data endpoint. The KEY
// is a protocol detail and never crosses the acl/index.ts barrel.

// Custom account-data key (per account, private to its owner, the same on every device).
export const PREFERENCES_KEY = 'io.tayet.preferences'

interface PreferencesContent {
  language?: unknown
}

// Read the preferences from raw account-data content. Tolerant of absent or malformed content (an
// account that never chose anything has no such key): a language that is not a non-empty string is
// absent. The value is opaque here; the UI decides what it means.
export function readPreferences(content: unknown): { language?: string } {
  const c = content as PreferencesContent | null | undefined
  const language = typeof c?.language === 'string' && c.language.length > 0 ? c.language : undefined
  return language === undefined ? {} : { language }
}

// Read-union-write: apply the patch over the persisted content, keeping every unknown field. A patch
// works by key presence: `language` absent from the patch leaves it as it is; present but empty (or
// undefined) removes it.
export function writePreferences(content: unknown, patch: { language?: string }): Record<string, unknown> {
  const base: Record<string, unknown> =
    content && typeof content === 'object' && !Array.isArray(content) ? { ...(content as Record<string, unknown>) } : {}
  if ('language' in patch) {
    if (patch.language && patch.language.length > 0) base.language = patch.language
    else delete base.language
  }
  return base
}
