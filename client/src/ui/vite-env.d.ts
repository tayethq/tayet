/// <reference types="vite/client" />

// Typed app config injected at build/dev time. vite/client also declares `*.css` module imports.
interface ImportMetaEnv {
  readonly VITE_SERVER_URL?: string
  readonly VITE_SESSION_TOKEN?: string
  // Custody service for automatic key recovery (fatia C2; PF-2 item 4). Unset = not
  // provisioned: the client connects and works; history recovery is simply inactive.
  readonly VITE_ESCROW_URL?: string
  // OIDC login (ADR-032): the static MAS client id for the SPA (#55) and the deployment SSO label
  // (ADR-031 D1 — the SPA never enumerates the MAS providers; §8.L21).
  readonly VITE_OIDC_CLIENT_ID?: string
  readonly VITE_SSO_LABEL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
