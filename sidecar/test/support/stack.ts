// Stack harness of the sidecar's integration tests (PLANO-AGENTES §0.3.5, S-b1). Own copy: the
// sidecar imports nothing from client/ (cross-import gate). Env and reachability follow
// client/test/support/{stack-env,synapse}.ts; the OIDC mint below is the client's
// test/support/mint-oidc.ts (itself a copy of the escrow's), unchanged but for the imports.
// NEVER logs token material.
import { execSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export const HS_URL = process.env.TAYET_HS_URL ?? 'http://localhost:8008'
export const MAS_URL = process.env.TAYET_MAS_URL ?? 'http://localhost:8080'
export const ESCROW_URL = process.env.TAYET_ESCROW_URL ?? 'http://localhost:8090'
const APP_URL = `http://localhost:${process.env.TAYET_SPA_PORT ?? '5173'}`
const CLIENT_ID = process.env.TAYET_SPA_CLIENT_ID ?? '000000000000000000000TAYET'
const REDIRECT_URI = process.env.TAYET_SPA_REDIRECT ?? `${APP_URL}/`
const REQUIRE_STACK = process.env.TAYET_REQUIRE_STACK === '1'

// Auto-skip without a homeserver (the light CI job points TAYET_HS_URL at a dead port, ADR-071
// dec. 1); with TAYET_REQUIRE_STACK=1 a missing stack is fatal instead of a silent skip.
export function stackUp(): boolean {
  try {
    execSync(`curl -sf -m 3 ${HS_URL}/_matrix/client/versions`, { stdio: 'ignore' })
    return true
  } catch {
    if (REQUIRE_STACK) {
      throw new Error(`TAYET_REQUIRE_STACK=1 but the homeserver is unreachable at ${HS_URL}`)
    }
    return false
  }
}

// The product's discovery document, served locally (the dev-stack has no proxy; §0.3.5 adj. 5).
export async function startWellKnown(server: string): Promise<{ url: string; close: () => Promise<void> }> {
  const srv: Server = createServer((req, res) => {
    if (req.url === '/.well-known/tayet/agent') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ server, account: ESCROW_URL }))
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  return {
    url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
    close: () =>
      new Promise((r) => {
        srv.closeAllConnections()
        srv.close(() => r())
      }),
  }
}

export async function whoamiStatus(token: string): Promise<number> {
  const res = await fetch(`${HS_URL}/_matrix/client/v3/account/whoami`, { headers: { Authorization: `Bearer ${token}` } })
  return res.status
}

export async function until<T>(get: () => T | undefined | Promise<T | undefined>, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await get()
    if (v !== undefined) return v
    if (Date.now() > deadline) throw new Error(`timeout (${timeoutMs} ms): ${what}`)
    await new Promise((r) => setTimeout(r, 250))
  }
}

// ── Headless OIDC mint (copy of client/test/support/mint-oidc.ts) ──────────────────────────
const MAX_HOPS = 10

export interface OidcSession {
  /** mat_… — introspects active for the escrow; accepted end-to-end. */
  accessToken: string
  /** mar_… — reserved (a future refresh path; unused by these gates given the raised TTL). */
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

// Any MAS-hosted form: hidden inputs + named buttons pass through; a login form (username+password
// present) gets the credentials injected. Proven sufficient for login [csrf, username, password]
// and consent [csrf, id, kind]. Index guards satisfy noUncheckedIndexedAccess.
function fillForm(html: string, username: string, password: string): URLSearchParams {
  const body = new URLSearchParams()
  for (const m of html.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0]
    if (tag === undefined) continue
    const name = /\bname="([^"]*)"/.exec(tag)?.[1]
    if (name) body.set(name, /\bvalue="([^"]*)"/.exec(tag)?.[1] ?? '')
  }
  for (const m of html.matchAll(/<button\b[^>]*>/gi)) {
    const tag = m[0]
    if (tag === undefined) continue
    const name = /\bname="([^"]*)"/.exec(tag)?.[1]
    if (name && !body.has(name)) body.set(name, /\bvalue="([^"]*)"/.exec(tag)?.[1] ?? '')
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
