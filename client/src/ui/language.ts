import type { Acl } from '@tayet/client'
import { type Locale, activeLocaleOf, deviceLocale, getLocale, saveStoredLocale, storedLocale } from './i18n'

// The account's language against this device's copy. The choice lives in the account; the copy
// (tayet.locale) serves everything that runs before a session exists. Both directions go through here:
// the boot makes the copy equal to the account, and a change in "Your account" writes the account and
// then the copy. Either one reloads the page so the whole app comes up in the new language, and only
// after reading the copy back: a copy that did not take would reload into the same language forever.

// Past this the boot carries on in the language already applied.
export const LANGUAGE_READ_TIMEOUT_MS = 3_000
// Past this a change counts as failed, even if the server answers later.
export const LANGUAGE_SAVE_TIMEOUT_MS = 10_000

export function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (e: unknown) => {
        clearTimeout(timer)
        reject(e instanceof Error ? e : new Error(String(e)))
      },
    )
  })
}

// Write the copy (or remove it on Automatic) and read it back: true only when it took.
export function saveCopy(locale: Locale | null): boolean {
  saveStoredLocale(locale)
  return storedLocale() === locale
}

// Right after connecting. The server is asked only when the synced cache shows the account has
// preferences, or when this device has a copy (which may be stale against the account); an account
// that never chose anything costs no request. The target is the account's language when it is one we
// have, else what Automatic gives this device. True when the page is reloading into the target.
export async function reconcileLanguage(
  acl: Pick<Acl, 'getAccountPreferences'>,
  reload: () => void,
): Promise<boolean> {
  let language: string | undefined
  try {
    const preferences = await withTimeout(
      acl.getAccountPreferences({ fresh: storedLocale() !== null }),
      LANGUAGE_READ_TIMEOUT_MS,
    )
    language = preferences.language
  } catch (e) {
    // A warning, not an error: the boot goes on in the language it has, and the copy stays as it is.
    console.warn('[boot] language not read', e)
    return false
  }
  const account = activeLocaleOf(language)
  const target = account ?? deviceLocale()
  const copied = saveCopy(account)
  if (target === getLocale() || !copied) return false
  reload()
  return true
}
