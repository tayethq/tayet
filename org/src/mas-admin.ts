// MAS admin API client of the org service. People provisioning, which acts on other accounts when the
// caller is an organization admin (people.ts), and the admin role (admins.ts). The admin credential
// lives here and never reaches the client. The admin API is on the MAS internal listener; the token
// comes from /oauth2/token on the public listener, over the internal network. Revoking the other
// sign-ins stays in the escrow, with its own copy of this client.
// A second port, the agents' one, mints and revokes the credential of `a-` accounts: the only
// exception to the rule that the service never mints a session for another account.

export interface MasUser {
  id: string
  username: string
  deactivated: boolean
  locked: boolean
  admin: boolean
}

// Prefixo reservado de agente (ADR-086 dec. 1): `a-` + 12 do alfabeto base32 do `u-`.
export const AGENT_LOCALPART = /^a-[a-z2-7]{12}$/

export interface UpstreamLink {
  id: string
  providerId: string
  subject: string
}

export interface SystemSession {
  id: string
  token: string
}

export interface PeopleAdmin {
  createUser(username: string, displayname: string): Promise<MasUser>
  addEmail(userId: string, email: string): Promise<void>
  addUpstreamLink(userId: string, providerId: string, subject: string): Promise<void>
  linksOf(userId: string): Promise<UpstreamLink[]>
  deleteUpstreamLink(id: string): Promise<void>
  findUserByUsername(username: string): Promise<MasUser | null>
  findUserByEmail(email: string): Promise<MasUser | null>
  deactivate(userId: string, opts: { skipErase: true }): Promise<void>
  isAdmin(username: string): Promise<boolean>
  // Sessão de `system`, e só dele (ADR-083, addendum): nem o ator nem o escopo são parâmetros.
  mintSystemSession(expiresIn: number): Promise<SystemSession>
  revokeSession(id: string): Promise<void>
  reapExpiredSystemSessions(): Promise<number>
}

// The organization admin role: the MAS admin flag, written and read in bulk. Every list is
// active-only and walks every page.
export interface RoleAdmin {
  setAdmin(userId: string, admin: boolean): Promise<void>
  // `meta.count` of the active admins, one call.
  countActiveAdmins(): Promise<number>
  listActiveAdmins(): Promise<MasUser[]>
  listActiveUsers(): Promise<MasUser[]>
  // Owner user ids of the active OAuth2 and compat sessions; a session with no user (an admin client's
  // token) is dropped.
  listActiveOAuth2SessionUsers(): Promise<string[]>
  listActiveCompatSessionUsers(): Promise<string[]>
  // `actor_user_id` of the active personal sessions: the account the session acts as.
  listActivePersonalSessionActors(): Promise<string[]>
}

export interface AgentAdmin {
  // Personal session do agente com device e sem expiração (ADR-086 dec. 7). Recusa (lança) se a conta
  // não é `a-` ou está desativada: a exceção fica escopada no próprio verbo, não só no chamador.
  mintAgentSession(actorUserId: string, deviceId: string): Promise<SystemSession>
  // Revoga as personal sessions ativas do agente, por listagem: o escrow não guarda id de sessão.
  // `except`: o id que fica (a sessão que o reissue acabou de cunhar, ADR-087 dec. 9).
  revokeAgentSessions(actorUserId: string, opts?: { except: string }): Promise<number>
  // Sessão CURTA do próprio agente, sem device, só para o rename escrever o displayname da conta
  // (a admin API do MAS 1.27 não tem caminho de displayname: AddUserRequest é o único que o leva,
  // PLANO-PESSOAS §0). Mesma exceção escopada do mint: só conta `a-` ativa. O chamador revoga ESTA
  // sessão pelo id ao fim; o TTL fecha o que sobrar. Nunca toca a credencial em uso do agente.
  mintAgentProfileSession(actorUserId: string, expiresIn: number): Promise<SystemSession>
}

interface UserRow {
  id: string
  attributes: { username: string; admin?: boolean; deactivated_at?: string | null; locked_at?: string | null }
}

interface SessionRow {
  id: string
  attributes: { user_id?: string | null; actor_user_id?: string | null }
}

interface LinkRow {
  id: string
  attributes: { provider_id: string; subject: string }
}

const ADMIN_TOKEN_SCOPE = 'urn:mas:admin'
const SYSTEM_USERNAME = 'system'
// O mínimo com que o Synapse aceita o token; escopo vazio é 400 no MAS (medido em 02/Nov). Jamais
// urn:synapse:admin:*: o MAS não valida o escopo pedido pelo client admin (ADR-083, addendum).
const SYSTEM_SESSION_SCOPE = 'urn:matrix:client:api:*'
const AGENT_SESSION_NAME = 'tayet-agent'
const AGENT_PROFILE_SESSION_NAME = 'escrow agent profile'
const PAGE_SIZE = 100
// Page size of the whole-instance listings (accounts and sessions). MAS 1.27.0 does not cap
// `page[first]`, so the caller picks it.
const BULK_PAGE_SIZE = 1000
// Page ceiling for any paginated listing. MAS 1.27.0 builds `links.next` of user-sessions from the
// owner's id instead of the session's (fixed in 1.29.0), so following it never ends; a broken cursor
// must fail loudly instead of hanging or returning a silently truncated list. 500 pages is 50,000
// rows per listing at PAGE_SIZE (far above any one account: the largest measured is ~500 browser
// sessions) and 500,000 rows at BULK_PAGE_SIZE (far above any instance), and still a bounded number
// of requests before giving up.
const MAX_PAGES = 500
const ACTIVE_ADMINS = '/api/admin/v1/users?filter[admin]=true&filter[status]=active'
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
  now?: () => Date
}): PeopleAdmin & AgentAdmin & RoleAdmin {
  const fetchFn = opts.fetchFn ?? globalThis.fetch
  const timeoutMs = opts.timeoutMs ?? 5000
  const now = opts.now ?? (() => new Date())
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

  const userOf = (row: UserRow): MasUser => ({
    id: row.id,
    username: row.attributes.username,
    deactivated: typeof row.attributes.deactivated_at === 'string',
    locked: typeof row.attributes.locked_at === 'string',
    admin: row.attributes.admin === true,
  })

  const sessionUsers = async (resource: string, field: 'user_id' | 'actor_user_id'): Promise<string[]> =>
    (await listAll<SessionRow>(`/api/admin/v1/${resource}?filter[status]=active&page[first]=${BULK_PAGE_SIZE}`)).flatMap(
      (row) => {
        const id = row.attributes[field]
        return typeof id === 'string' ? [id] : []
      },
    )

  async function userById(id: string): Promise<MasUser> {
    const res = await call('GET', `/api/admin/v1/users/${encodeURIComponent(id)}`)
    if (!res.ok) throw new Error(`user lookup: ${res.status}`)
    return userOf(((await res.json()) as { data: UserRow }).data)
  }

  async function userRowByUsername(username: string): Promise<UserRow | null> {
    const res = await call('GET', `/api/admin/v1/users/by-username/${encodeURIComponent(username)}`)
    if (res.status === 404) return null
    if (!res.ok) throw new Error(`user lookup: ${res.status}`)
    return ((await res.json()) as { data: UserRow }).data
  }

  async function findUserByUsername(username: string): Promise<MasUser | null> {
    const row = await userRowByUsername(username)
    return row === null ? null : userOf(row)
  }

  // Sessão já revogada (409) ou inexistente (404): nada a fazer.
  async function revokeSession(id: string): Promise<void> {
    const res = await call('POST', `/api/admin/v1/personal-sessions/${encodeURIComponent(id)}/revoke`)
    if (!res.ok && res.status !== 404 && res.status !== 409) throw new Error(`revoke session: ${res.status}`)
  }

  return {
    async createUser(username, displayname) {
      const res = await call('POST', '/api/admin/v1/users', { username, displayname })
      if (!res.ok) throw new Error(`create user: ${res.status}`)
      return userOf(((await res.json()) as { data: UserRow }).data)
    },

    async addEmail(userId, email) {
      const res = await call('POST', '/api/admin/v1/user-emails', { user_id: userId, email })
      if (!res.ok) throw new Error(`add email: ${res.status}`)
    },

    async addUpstreamLink(userId, providerId, subject) {
      const res = await call('POST', '/api/admin/v1/upstream-oauth-links', {
        user_id: userId,
        provider_id: providerId,
        subject,
      })
      if (!res.ok) throw new Error(`add link: ${res.status}`)
    },

    async linksOf(userId) {
      const rows = await listAll<LinkRow>(
        `/api/admin/v1/upstream-oauth-links?filter[user]=${encodeURIComponent(userId)}&page[first]=${PAGE_SIZE}`,
      )
      return rows.map((r) => ({ id: r.id, providerId: r.attributes.provider_id, subject: r.attributes.subject }))
    },

    async deleteUpstreamLink(id) {
      const res = await call('DELETE', `/api/admin/v1/upstream-oauth-links/${encodeURIComponent(id)}`)
      if (!res.ok && res.status !== 404) throw new Error(`delete link: ${res.status}`)
    },

    findUserByUsername,

    async findUserByEmail(email) {
      const res = await call('GET', `/api/admin/v1/user-emails?filter[email]=${encodeURIComponent(email)}`)
      if (!res.ok) throw new Error(`email lookup: ${res.status}`)
      const [row] = ((await res.json()) as { data: Array<{ attributes: { user_id: string } }> }).data
      if (row === undefined) return null
      return userById(row.attributes.user_id)
    },

    async deactivate(userId, { skipErase }) {
      const res = await call('POST', `/api/admin/v1/users/${encodeURIComponent(userId)}/deactivate`, {
        skip_erase: skipErase,
      })
      if (!res.ok) throw new Error(`deactivate: ${res.status}`)
    },

    async isAdmin(username) {
      return (await userRowByUsername(username))?.attributes.admin === true
    },

    async mintSystemSession(expiresIn) {
      const system = await findUserByUsername(SYSTEM_USERNAME)
      if (system === null) throw new Error('system account missing')
      const res = await call('POST', '/api/admin/v1/personal-sessions', {
        actor_user_id: system.id,
        human_name: 'escrow people',
        scope: SYSTEM_SESSION_SCOPE,
        expires_in: expiresIn,
      })
      if (!res.ok) throw new Error(`mint session: ${res.status}`)
      const { data } = (await res.json()) as { data: { id: string; attributes: { access_token: string } } }
      return { id: data.id, token: data.attributes.access_token }
    },

    revokeSession,

    // O sweep do `up` não alcança personal session (ADR-083, addendum): a revogação best-effort que
    // falhou fica "ativa" no MAS depois de expirar, e é aqui que ela sai.
    async reapExpiredSystemSessions() {
      const system = await findUserByUsername(SYSTEM_USERNAME)
      if (system === null) return 0
      const before = encodeURIComponent(now().toISOString())
      const rows = await listAll<{ id: string }>(
        `/api/admin/v1/personal-sessions?filter[actor_user]=${encodeURIComponent(system.id)}&filter[status]=active&filter[expires_before]=${before}&page[first]=${PAGE_SIZE}`,
      )
      for (const row of rows) await revokeSession(row.id)
      return rows.length
    },

    // ADR-086 dec. 7: a exceção escopada. `actor_user_id` é o agente, o escopo leva o device que o
    // escrow gerou e não há `expires_in` (sessão longeva por desenho; o reaper acima filtra o ator
    // `system` e nunca a alcança, dec. 8). Medido no MAS 1.27 (PLANO-AGENTES §0.2.1 P-B1 (b)).
    async mintAgentSession(actorUserId, deviceId) {
      const agent = await userById(actorUserId)
      if (!AGENT_LOCALPART.test(agent.username) || agent.deactivated) throw new Error('mint agent: not an active agent')
      const res = await call('POST', '/api/admin/v1/personal-sessions', {
        actor_user_id: actorUserId,
        human_name: AGENT_SESSION_NAME,
        scope: `urn:matrix:client:api:* urn:matrix:client:device:${deviceId}`,
      })
      if (!res.ok) throw new Error(`mint agent session: ${res.status}`)
      const { data } = (await res.json()) as { data: { id: string; attributes: { access_token: string } } }
      return { id: data.id, token: data.attributes.access_token }
    },

    async mintAgentProfileSession(actorUserId, expiresIn) {
      const agent = await userById(actorUserId)
      if (!AGENT_LOCALPART.test(agent.username) || agent.deactivated) throw new Error('mint agent: not an active agent')
      const res = await call('POST', '/api/admin/v1/personal-sessions', {
        actor_user_id: actorUserId,
        human_name: AGENT_PROFILE_SESSION_NAME,
        scope: SYSTEM_SESSION_SCOPE,
        expires_in: expiresIn,
      })
      if (!res.ok) throw new Error(`mint agent profile session: ${res.status}`)
      const { data } = (await res.json()) as { data: { id: string; attributes: { access_token: string } } }
      return { id: data.id, token: data.attributes.access_token }
    },

    async setAdmin(userId, admin) {
      const res = await call('POST', `/api/admin/v1/users/${encodeURIComponent(userId)}/set-admin`, { admin })
      if (!res.ok) throw new Error(`set admin: ${res.status}`)
    },

    async countActiveAdmins() {
      const res = await call('GET', `${ACTIVE_ADMINS}&page[first]=1`)
      if (!res.ok) throw new Error(`count admins: ${res.status}`)
      const count = ((await res.json()) as { meta?: { count?: unknown } }).meta?.count
      if (typeof count !== 'number') throw new Error('count admins: malformed')
      return count
    },

    async listActiveAdmins() {
      return (await listAll<UserRow>(`${ACTIVE_ADMINS}&page[first]=${BULK_PAGE_SIZE}`)).map(userOf)
    },

    async listActiveUsers() {
      return (await listAll<UserRow>(`/api/admin/v1/users?filter[status]=active&page[first]=${BULK_PAGE_SIZE}`)).map(userOf)
    },

    listActiveOAuth2SessionUsers: () => sessionUsers('oauth2-sessions', 'user_id'),
    listActiveCompatSessionUsers: () => sessionUsers('compat-sessions', 'user_id'),
    listActivePersonalSessionActors: () => sessionUsers('personal-sessions', 'actor_user_id'),

    async revokeAgentSessions(actorUserId, opts) {
      const rows = (
        await listAll<{ id: string }>(
          `/api/admin/v1/personal-sessions?filter[actor_user]=${encodeURIComponent(actorUserId)}&filter[status]=active&page[first]=${PAGE_SIZE}`,
        )
      ).filter((row) => row.id !== opts?.except)
      for (const row of rows) await revokeSession(row.id)
      return rows.length
    },
  }
}
