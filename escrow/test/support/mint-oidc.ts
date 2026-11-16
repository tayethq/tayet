// Headless OIDC token mint for the escrow↔MAS gate (#7). The gate previously authenticated with
// issue-compatibility-token (mct_), which MAS introspection reports active:false to a regular
// OAuth2 introspection client (ESCR0W) — proven live: the escrow 401s every mct_. A real OAuth2
// access token (mat_) introspects active and the escrow accepts it (proven: 200). This drives the
// auth-code + PKCE flow against MAS's local password login (register-user users are MAS-local; Dex
// only knows the static alice/bob), the same flow the browser does — headless, three hops:
//   GET /authorize → 303 /login?…&id=<G> → POST creds → 303 /consent/<G> → POST → 303 redirect?code
//   → POST /oauth2/token → { mat_, mar_ }.
// Node env only (undici getSetCookie for the cookie jar). NEVER logs token/secret material.

import { createHash, randomBytes } from 'node:crypto'

const MAS_URL = process.env.TAYET_MAS_URL ?? 'http://localhost:8080'
const CLIENT_ID = process.env.TAYET_SPA_CLIENT_ID ?? '000000000000000000000TAYET'
const REDIRECT_URI = process.env.TAYET_SPA_REDIRECT ?? 'http://localhost:5173/'
const MAX_HOPS = 10

export interface OidcSession {
  /** mat_… — introspects active for ESCR0W; the escrow accepts it. */
  accessToken: string
  /** mar_… — for the client gate's session refresh (consumed in PR2). */
  refreshToken: string
  deviceId: string
}

const b64url = (b: Buffer): string =>
  b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

class CookieJar {
  private jar = new Map<string, string>()
  absorb(res: Response): void {
    const list = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? []
    for (const c of list) {
      const nv = c.split(';')[0] ?? ''
      const i = nv.indexOf('=')
      if (i > 0) this.jar.set(nv.slice(0, i).trim(), nv.slice(i + 1).trim())
    }
  }
  header(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ')
  }
  get size(): number {
    return this.jar.size
  }
}

async function hop(jar: CookieJar, url: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(url, {
    redirect: 'manual',
    ...init,
    headers: { ...(init.headers ?? {}), ...(jar.size ? { cookie: jar.header() } : {}) },
  })
  jar.absorb(res)
  return res
}

// Any MAS-hosted form: hidden inputs + named buttons pass through unchanged; a login form
// (username+password present) gets the credentials injected. Proven sufficient for the two hops the
// flow uses — login [csrf, username, password] and consent [csrf, id, kind].
function fillForm(html: string, username: string, password: string): URLSearchParams {
  const body = new URLSearchParams()
  for (const m of html.matchAll(/<input\b[^>]*>/gi)) {
    const name = /\bname="([^"]*)"/.exec(m[0])?.[1]
    if (name) body.set(name, /\bvalue="([^"]*)"/.exec(m[0])?.[1] ?? '')
  }
  for (const m of html.matchAll(/<button\b[^>]*>/gi)) {
    const name = /\bname="([^"]*)"/.exec(m[0])?.[1]
    if (name && !body.has(name)) body.set(name, /\bvalue="([^"]*)"/.exec(m[0])?.[1] ?? '')
  }
  if (/name="username"/.test(html) && /name="password"/.test(html)) {
    body.set('username', username)
    body.set('password', password)
  }
  return body
}

// Drives auth-code + PKCE against MAS's local login, headless. Failures throw token-free messages.
export async function mintOidcSession(username: string, password: string): Promise<OidcSession> {
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  const deviceId = b64url(randomBytes(8)).slice(0, 10)
  const jar = new CookieJar()

  const scope = `openid urn:matrix:org.matrix.msc2967.client:api:* urn:matrix:org.matrix.msc2967.client:device:${deviceId}`
  const authUrl =
    `${MAS_URL}/authorize?` +
    new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      scope,
      code_challenge_method: 'S256',
      code_challenge: challenge,
      state: b64url(randomBytes(8)),
      nonce: b64url(randomBytes(8)),
    }).toString()

  let lastUrl = authUrl
  let res = await hop(jar, authUrl, { headers: { accept: 'text/html' } })
  let code: string | null = null

  for (let i = 0; i < MAX_HOPS && !code; i++) {
    if (res.status >= 300 && res.status < 400) {
      const target = new URL(res.headers.get('location') ?? '', lastUrl).toString()
      if (target.startsWith(REDIRECT_URI)) {
        code = new URL(target).searchParams.get('code')
        break
      }
      lastUrl = target
      res = await hop(jar, target, { headers: { accept: 'text/html' } })
      continue
    }
    if (res.status === 200) {
      const html = await res.text()
      if (!/<form\b/i.test(html)) throw new Error(`mint: 200 sem form (${lastUrl})`)
      res = await hop(jar, lastUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
        body: fillForm(html, username, password),
      })
      continue
    }
    throw new Error(`mint: hop inesperado ${res.status} (${lastUrl})`)
  }

  if (!code) throw new Error(`mint: fluxo não devolveu code para ${username}`)

  const tokRes = await fetch(`${MAS_URL}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: verifier,
    }),
  })
  const tok = (await tokRes.json()) as { access_token?: string; refresh_token?: string; error?: string }
  if (!tok.access_token || !tok.refresh_token) {
    throw new Error(`mint: token exchange falhou (${tok.error ?? tokRes.status})`)
  }
  return { accessToken: tok.access_token, refreshToken: tok.refresh_token, deviceId }
}
