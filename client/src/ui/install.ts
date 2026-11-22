import { isCoarsePointer, useNarrowWindow } from './narrow'

// The install sheet and the install row exist only in the iPhone's Safari outside the installed app, with a
// coarse pointer on a narrow window (PLANO-MOBILE M7 I1). The user agent is read here and goes nowhere else:
// never logged, never stored.
export interface InstallEnv {
  userAgent: string
  // Running as the installed app.
  standalone: boolean
  coarse: boolean
  narrow: boolean
}

// Safari's own shape, whole. The other browsers of the iPhone add a token or take the place of `Version/`
// (CriOS, FxiOS, EdgiOS, GSA, a suffix), and a web view has no `Safari/`.
const IPHONE_SAFARI =
  /^Mozilla\/5\.0 \(iPhone;[^)]*\) AppleWebKit\/[\d.]+ \(KHTML, like Gecko\) Version\/[\d.]+ Mobile\/\w+ Safari\/[\d.]+$/

export function canInstall({ userAgent, standalone, coarse, narrow }: InstallEnv): boolean {
  return narrow && coarse && !standalone && IPHONE_SAFARI.test(userAgent)
}

// `navigator.standalone` is WebKit's own; `display-mode` is the standard, and reads `fullscreen` in some home
// screen apps of the iPhone (WebKit bug 264218), so either answer counts.
function isStandalone(): boolean {
  if ((navigator as Navigator & { standalone?: boolean }).standalone === true) return true
  return typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches
}

// Can this window offer the install, following resizes and rotations.
export function useCanInstall(): boolean {
  const narrow = useNarrowWindow()
  return canInstall({ userAgent: navigator.userAgent, standalone: isStandalone(), coarse: isCoarsePointer(), narrow })
}

// "Continuar no navegador" (I2): the sheet does not come back on the sign-in screen of this browser. A flag
// and nothing else; signing out leaves it.
const DISMISSED_KEY = 'tayet.install-dismissed'

export function installDismissed(): boolean {
  try {
    return localStorage.getItem(DISMISSED_KEY) !== null
  } catch {
    return false
  }
}

export function saveInstallDismissed(): void {
  try {
    localStorage.setItem(DISMISSED_KEY, '1')
  } catch {
    // best-effort
  }
}
