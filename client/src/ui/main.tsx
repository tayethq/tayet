import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { AclTelemetry } from '@tayet/client'
import { Boot } from './components/Boot'
import { loadTheme, applyTheme } from './theme'
import { t, resolveLocale, applyLocale } from './i18n'
import { trackVisualViewport } from './visual-viewport'
import { registerServiceWorker } from './service-worker'
// Self-hosted fonts (ADR-027 / PLANO §0.2): bundled via @fontsource, NO third-party CDN — aligned
// with the privacy thesis. Hanken Grotesk is the variable upright axis (covers weights 400 + 500);
// IBM Plex Mono ships the two static weights we use. Family names are mapped in the token source
// (font.family.sans/mono → tokens.css). Imported before styles.css so the @font-face rules exist
// before the token-driven `font-family` declarations apply.
import '@fontsource-variable/hanken-grotesk/index.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import './styles.css'
import './styles.narrow.css'

// App bootstrap. Thin by design and NOT part of the CI gate (the render-scan is — see test/ui). The
// async connect now lives inside <Boot/> as React state, so any auth failure renders a neutral error
// state instead of a silent white screen (issue #1). The session is resolved from the env override
// (dogfood) or the persisted session (ADR-030); the token is never read or shown here.
const telemetry: AclTelemetry = {
  untranslated: (e) => console.warn('[tayet] untranslated concept', e.conceptKind, e.shape),
}

const serverUrl = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:8008'
const envToken = import.meta.env.VITE_SESSION_TOKEN
const clientId = import.meta.env.VITE_OIDC_CLIENT_ID ?? ''

applyTheme(loadTheme()) // antes do render: evita flash-of-wrong-theme
applyLocale(resolveLocale()) // antes do render: lang e copy no locale do dispositivo (ADR-080 D2)
trackVisualViewport() // the keyboard on the narrow window (visual-viewport.ts)
// ADR-117 dec. 5: push and click only; the dev server has no /sw.js.
if (import.meta.env.PROD) registerServiceWorker()
// After applyLocale: the fallback is copy, so it reads the device's language.
const ssoLabel = import.meta.env.VITE_SSO_LABEL ?? t('boot.accountFallback')
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Boot
      serverUrl={serverUrl}
      envToken={envToken}
      clientId={clientId}
      ssoLabel={ssoLabel}
      telemetry={telemetry}
    />
  </StrictMode>,
)
