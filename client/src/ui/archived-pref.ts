// ADR-076 dec. 7: whether the sidebar's Archived section is collapsed. App-side preference, NEVER
// domain — same posture as notifications-pref.ts (localStorage, neutral key, per origin, best-effort).
// Collapsed by default (manifesto §9 item 2): only 'true' | 'false' is ever written, and anything but
// 'false' reads as collapsed.
const ARCHIVED_COLLAPSED_KEY = 'tayet.archived-collapsed'

export function loadArchivedCollapsed(): boolean {
  try {
    return localStorage.getItem(ARCHIVED_COLLAPSED_KEY) !== 'false'
  } catch {
    return true
  }
}

export function saveArchivedCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(ARCHIVED_COLLAPSED_KEY, collapsed ? 'true' : 'false')
  } catch {
    // best-effort
  }
}
