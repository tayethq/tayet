// ADR-073 dec. 6: whether the user dismissed the notifications prompt. App-side preference, NEVER
// domain — same posture as theme.ts (localStorage, neutral key, per origin, best-effort). It survives
// sign-out like the theme. Only 'dismissed' is ever written; anything else reads as not dismissed.
export type NotificationsPref = 'dismissed' | undefined

const NOTIFICATIONS_KEY = 'tayet.notifications'

export function loadNotificationsPref(): NotificationsPref {
  try {
    return localStorage.getItem(NOTIFICATIONS_KEY) === 'dismissed' ? 'dismissed' : undefined
  } catch {
    return undefined
  }
}

export function dismissNotifications(): void {
  try {
    localStorage.setItem(NOTIFICATIONS_KEY, 'dismissed')
  } catch {
    // best-effort
  }
}
