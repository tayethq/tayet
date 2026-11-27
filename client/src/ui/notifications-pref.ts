// ADR-073 dec. 6 and ADR-117 (addendum of 26/Nov/2026, F4): this device's notifications preference and the dismissal
// of the list's prompt. App-side preferences, NEVER domain — same posture as theme.ts (localStorage, neutral keys, per
// origin, best-effort).
//
// - The preference is `on` or `off`, or empty when the person never chose. Signing out clears it (F5).
// - The dismissal of the prompt has a key of its own and survives sign-out, like the theme.
// - A `dismissed` written by the earlier version under the preference's key moves to the dismissal's key, and the
//   preference's key is freed.
export type NotificationsPref = 'on' | 'off' | undefined

const PREF_KEY = 'tayet.notifications'
const DISMISSED_KEY = 'tayet.notifications-dismissed'
const LEGACY_DISMISSED = 'dismissed'

function migrate(): void {
  if (localStorage.getItem(PREF_KEY) !== LEGACY_DISMISSED) return
  localStorage.setItem(DISMISSED_KEY, '1')
  localStorage.removeItem(PREF_KEY)
}

export function loadNotificationsPref(): NotificationsPref {
  try {
    migrate()
    const value = localStorage.getItem(PREF_KEY)
    return value === 'on' || value === 'off' ? value : undefined
  } catch {
    return undefined
  }
}

export function saveNotificationsPref(pref: 'on' | 'off'): void {
  try {
    localStorage.setItem(PREF_KEY, pref)
  } catch {
    // best-effort
  }
}

export function clearNotificationsPref(): void {
  try {
    localStorage.removeItem(PREF_KEY)
  } catch {
    // best-effort
  }
}

export function notificationsPromptDismissed(): boolean {
  try {
    migrate()
    return localStorage.getItem(DISMISSED_KEY) !== null
  } catch {
    return false
  }
}

export function dismissNotificationsPrompt(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, '1')
  } catch {
    // best-effort
  }
}
