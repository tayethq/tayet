import { buildLoginUrl } from '@tayet/client'

// ── OIDC login — the APP half (ADR-032 / ADR-031). ───────────────────────────────────────────────
// Login is app work (ADR-030): the app decides WHEN to start login and detects the return, then hands
// the resulting session to the ACL. The protocol machinery (discovery, PKCE, code-exchange, refresh)
// lives behind the barrel in acl/internal — see buildLoginUrl/completeLogin. This module holds only
// the browser-side bits the ACL has no business owning: reading the callback off the URL and the
// top-level redirect. `completeLogin` is re-exported from the barrel so the Boot controller has one
// import surface for the whole flow.
export { completeLogin } from '@tayet/client'

// Did the OP redirect us back here? (ADR-032 D3: the callback lands on the SPA root with ?code&state;
// the Boot controller detects it instead of a router.) Reads only the address bar — no protocol.
export function isCallback(): boolean {
  const p = new URLSearchParams(window.location.search)
  return p.has('code') && p.has('state')
}

// Drop the callback params from the address bar without a reload. Browser-side hygiene that belongs to
// the app — this module owns the address bar (ADR-030/ADR-032), so the SDK-facing completeLogin is now
// side-effect-free (PR-B / §8.L31). Boot calls this on success (post-exchange), on exchange failure, and
// on the error-callback, so a reload/retry/bfcache never re-feeds a single-use code. P1: pure address
// bar, zero protocol, zero SDK.
export function scrubCallback(): void {
  window.history.replaceState({}, '', window.location.pathname)
}

// Did the OP bounce us back with a denial instead of a code? An IdP refusal / user cancel comes back as
// ?error=…&state=… — OAuth-standard params, NOT Matrix, so this stays app-side and never crosses the
// barrel. Requiring `state` distinguishes a real callback from arbitrary ?error noise. Address bar only.
export function isErrorCallback(): boolean {
  const p = new URLSearchParams(window.location.search)
  return p.has('error') && p.has('state')
}

// Ida (ADR-032 D3): build the authorize URL behind the barrel, then navigate top-level to the OP.
// `serverUrl` is the neutral product name (never homeserverUrl on this surface — P1). On success the
// browser leaves this page; if it returns without navigating, the caller treats it as a failure.
export async function beginLogin(opts: { serverUrl: string; clientId: string; loginHint?: string }): Promise<void> {
  const url = await buildLoginUrl(opts)
  window.location.assign(url)
}
