// MAS admin API client. One port: revoking the other sign-ins, which ends at the issuer everything of
// the account except the originating sign-in and acts ONLY on the token's user (server.ts). The admin
// credential lives here and never reaches the client. The admin API is on the MAS internal listener;
// the token comes from /oauth2/token on the public listener, over the internal network. People and
// agents belong to the org service, with its own copy of this client.

export interface RevokedCounts {
  oauth: number
  compat: number
  browser: number
}

export interface AccessAdmin {
  // Encerra as sessões ATIVAS (OAuth, compat, browser) do usuário exceto a de origem e a browser
  // session dela. Idempotente: a segunda chamada só conta o que ainda estava ativo.
  revokeOthers(username: string, originDevice: string): Promise<RevokedCounts>
}

// O device do token não está entre as sessões ativas: encerrar "todas as outras" derrubaria a
// própria origem no meio do reset. Nada é encerrado (409 no chamador).
export class OriginUnknownError extends Error {
  constructor() {
    super('origin access not found')
    this.name = 'OriginUnknownError'
  }
}

interface SessionRow {
  id: string
  attributes: { scope?: string; device_id?: string | null; user_session_id?: string | null }
}

const ADMIN_TOKEN_SCOPE = 'urn:mas:admin'
const PAGE_SIZE = 100
// Page ceiling for any paginated listing. MAS 1.27.0 builds `links.next` of user-sessions from the
// owner's id instead of the session's (fixed in 1.29.0), so following it never ends; a broken cursor
// must fail loudly instead of hanging or returning a silently truncated list. 500 pages = 50,000
// rows per listing: far above any account we hold (the largest measured is ~500 browser sessions),
// and still a bounded number of requests before giving up.
const MAX_PAGES = 500
// Re-read ceiling for draining browser sessions on reset. Each read finishes up to PAGE_SIZE - 1
// sessions (the origin's own may sit in the page), so 200 reads clear ~19,800 sessions: dozens of
// times the largest measured account. Past it the reset fails (502) instead of looping.
const MAX_DRAIN_READS = 200
// Margem para o token não expirar entre o cache e o uso.
const TOKEN_EXPIRY_MARGIN_MS = 30_000
const DEVICE_SCOPE = /^urn:matrix:(?:org\.matrix\.msc2967\.)?client:device:(.+)$/

// O mesmo escopo OAuth do token do usuário e da oauth2-session (stable e unstable do MSC2967).
export function deviceOfScope(scope: unknown): string | null {
  if (typeof scope !== 'string') return null
  for (const token of scope.split(' ')) {
    const m = DEVICE_SCOPE.exec(token)
    if (m) return m[1]!
  }
  return null
}

export function masAdmin(opts: {
  url: string
  tokenUrl: string
  clientId: string
  clientSecret: string
  timeoutMs?: number
  fetchFn?: typeof fetch
}): AccessAdmin {
  const fetchFn = opts.fetchFn ?? globalThis.fetch
  const timeoutMs = opts.timeoutMs ?? 5000
  const basic = Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString('base64')
  const base = opts.url.replace(/\/+$/, '')
  let cached: { token: string; expiresAt: number } | undefined

  async function adminToken(): Promise<string> {
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.token
    const res = await fetchFn(opts.tokenUrl, {
      method: 'POST',
      headers: {
        authorization: `Basic ${basic}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: ADMIN_TOKEN_SCOPE }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) throw new Error(`admin token: ${res.status}`)
    const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown }
    if (typeof body.access_token !== 'string') throw new Error('admin token: malformed')
    const ttlMs = typeof body.expires_in === 'number' ? body.expires_in * 1000 : 0
    cached = { token: body.access_token, expiresAt: Date.now() + ttlMs - TOKEN_EXPIRY_MARGIN_MS }
    return body.access_token
  }

  async function call(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<Response> {
    const res = await fetchFn(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await adminToken()}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (res.status === 401) cached = undefined
    return res
  }

  // Follows `links.next`, but never trusts it: a repeated cursor, a row seen twice or too many pages
  // is an error, never a hang or a truncated list. Errors name only the resource, never the query
  // (it carries user ids) or the cursor.
  async function listAll<T extends { id: string }>(first: string): Promise<T[]> {
    const resource = first.split('?')[0]!
    const rows: T[] = []
    const seenIds = new Set<string>()
    const seenCursors = new Set<string>()
    let next: string | undefined = first
    let pages = 0
    while (next !== undefined) {
      if (++pages > MAX_PAGES) throw new Error(`list ${resource}: page ceiling exceeded`)
      const res = await call('GET', next)
      if (!res.ok) throw new Error(`list ${resource}: ${res.status}`)
      const body = (await res.json()) as { data: T[]; links?: { next?: string } }
      for (const row of body.data) {
        if (seenIds.has(row.id)) throw new Error(`list ${resource}: repeated row`)
        seenIds.add(row.id)
        rows.push(row)
      }
      next = body.links?.next
      if (next !== undefined) {
        const cursor = new URL(next, 'http://cursor.invalid').searchParams.get('page[after]') ?? next
        if (seenCursors.has(cursor)) throw new Error(`list ${resource}: repeated cursor`)
        seenCursors.add(cursor)
      }
    }
    return rows
  }

  const activeSessionsPath = (kind: string, userId: string): string =>
    `/api/admin/v1/${kind}?filter[user]=${encodeURIComponent(userId)}&filter[status]=active&page[first]=${PAGE_SIZE}`

  const activeSessions = (kind: string, userId: string): Promise<SessionRow[]> =>
    listAll(activeSessionsPath(kind, userId))

  // Browser sessions are drained, not paged: the user-sessions cursor of MAS 1.27.0 loops (see
  // MAX_PAGES). A finished session leaves `filter[status]=active` before the 200, so re-reading the
  // first page and finishing what is not the origin's empties the list without a cursor.
  async function drainBrowserSessions(userId: string, keep: string | undefined): Promise<number> {
    const path = activeSessionsPath('user-sessions', userId)
    let done = 0
    for (let reads = 0; reads < MAX_DRAIN_READS; reads++) {
      const res = await call('GET', path)
      if (!res.ok) throw new Error(`list /api/admin/v1/user-sessions: ${res.status}`)
      const body = (await res.json()) as { data: SessionRow[]; links?: { next?: string } }
      const rows = body.data.filter((s) => s.id !== keep)
      if (rows.length === 0) {
        // Nothing left to finish on this page, yet the server says there is more: the drain cannot
        // progress without a cursor, and reporting success would leave sessions alive.
        if (body.links?.next !== undefined) throw new Error('drain /api/admin/v1/user-sessions: stalled page')
        return done
      }
      done += await finishAll('user-sessions', rows)
    }
    throw new Error('drain /api/admin/v1/user-sessions: read ceiling exceeded')
  }

  // 400 (já encerrada) e 404 são a corrida de outra varredura ou da expiração: nada a contar.
  async function finish(kind: string, id: string): Promise<number> {
    const res = await call('POST', `/api/admin/v1/${kind}/${encodeURIComponent(id)}/finish`)
    if (res.ok) return 1
    if (res.status === 400 || res.status === 404) return 0
    throw new Error(`finish ${kind}: ${res.status}`)
  }

  async function finishAll(kind: string, rows: SessionRow[]): Promise<number> {
    let done = 0
    for (const row of rows) done += await finish(kind, row.id)
    return done
  }

  return {
    async revokeOthers(username, originDevice) {
      const res = await call('GET', `/api/admin/v1/users/by-username/${encodeURIComponent(username)}`)
      if (!res.ok) throw new Error(`user lookup: ${res.status}`)
      const userId = ((await res.json()) as { data: { id: string } }).data.id

      const oauth = await activeSessions('oauth2-sessions', userId)
      const compat = await activeSessions('compat-sessions', userId)

      const origin =
        oauth.find((s) => deviceOfScope(s.attributes.scope) === originDevice) ??
        compat.find((s) => s.attributes.device_id === originDevice)
      if (origin === undefined) throw new OriginUnknownError()
      const originBrowser = origin.attributes.user_session_id ?? undefined

      // Browser por último: encerrá-la antes deixaria uma janela em que o acesso revogado ainda
      // renova o token sem passar pelo IdP.
      return {
        oauth: await finishAll('oauth2-sessions', oauth.filter((s) => s.id !== origin.id)),
        compat: await finishAll('compat-sessions', compat.filter((s) => s.id !== origin.id)),
        browser: await drainBrowserSessions(userId, originBrowser),
      }
    },
  }
}
