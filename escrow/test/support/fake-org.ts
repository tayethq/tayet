import { IdpUnavailableError, type Introspector } from '../../src/auth.ts'

// Um MAS e um Synapse falsos para /v1/people (ADR-083) e /v1/agents (ADR-086): o fetch injetado responde
// a admin API no shape medido no MAS 1.27 (`data.attributes`, 201 na criação, 409 na revogação repetida,
// `deactivated_at`, personal sessions por ator) e a client-API do Synapse. Tudo o que o escrow escreve
// fica no estado do fake.

export const SERVER = 'tayet.local'
export const PROVIDER = '01HFS6S2SVAR7Y7QYMZJ53ZDEX'
export const ROOM = '!all:tayet.local'
export const ME = 'io.tayet.member'

export interface Fake {
  users: Array<{ id: string; username: string; displayname?: string; admin?: boolean; deactivated?: boolean }>
  emails: Array<{ user_id: string; email: string }>
  links: Array<{ id: string; user_id: string; provider_id: string; subject: string }>
  sessions: Array<{ id: string; body: Record<string, unknown>; revoked?: boolean; revokedAt?: number }>
  state: Map<string, Record<string, unknown>>
  invites: string[]
  // PUT /profile/:mxid/displayname: quem escreveu (ator da sessão) e o quê.
  displaynames: Array<{ mxid: string; displayname: string; actor: unknown; session: string }>
  aliasCalls: number
  failing: Set<string> // `METHOD /pathname` que responde 500
  tokenStatus: number // resposta do token endpoint do MAS
  refused: boolean // o MAS recusa a conexão, como o fetch do Node a reporta
  rateLimit: number // 429s antes de o próximo write de state passar
  sleeps: number[]
  // Carência da introspecção (ADR-086 dec. 8: o MAS ainda vê o token revogado como ativo por < 1 s,
  // medido 4–319 ms): por essa janela, contada pelo `now` do fake, uma sessão revogada continua
  // introspectando como o seu ator. 0 = sem carência (o default).
  introspectionGraceMs: number
  now: () => number
}

export function seed(): Fake {
  return {
    users: [
      { id: 'U-sys', username: 'system' },
      { id: 'U-cofre', username: 'cofre' },
      { id: 'U-alice', username: 'alice', admin: true },
      { id: 'U-bob', username: 'bob' },
    ],
    emails: [],
    links: [],
    sessions: [],
    state: new Map(),
    invites: [],
    displaynames: [],
    aliasCalls: 0,
    failing: new Set(),
    tokenStatus: 200,
    refused: false,
    rateLimit: 0,
    sleeps: [],
    introspectionGraceMs: 0,
    now: () => Date.now(),
  }
}

export function fakeFetch(fake: Fake): typeof fetch {
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const userRow = (u: Fake['users'][number]): unknown => ({
    id: u.id,
    attributes: { username: u.username, admin: u.admin === true, deactivated_at: u.deactivated === undefined ? null : '2026-11-04T00:00:00Z' },
  })
  const route = (input: string, init?: RequestInit): Response => {
    const url = new URL(input)
    const method = init?.method ?? 'GET'
    const path = decodeURIComponent(url.pathname)
    if (fake.refused) {
      const cause = Object.assign(new Error('connect ECONNREFUSED 172.18.0.5:8081'), { code: 'ECONNREFUSED' })
      throw new TypeError('fetch failed', { cause })
    }
    if (path === '/oauth2/token') {
      return fake.tokenStatus === 200 ? json(200, { access_token: 'adm', expires_in: 3600 }) : json(fake.tokenStatus, {})
    }
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {}
    if (fake.failing.has(`${method} ${path}`)) return json(500, {})

    if (path.startsWith('/_matrix/')) {
      if (path === `/_matrix/client/v3/directory/room/#all:${SERVER}`) {
        fake.aliasCalls += 1
        return json(200, { room_id: ROOM })
      }
      const token = (init?.headers as Record<string, string>).authorization?.slice('Bearer '.length)
      if (!fake.sessions.some((s) => s.id === `sess-of-${token}` && !s.revoked)) return json(401, {})
      if (/^\/_matrix\/client\/v3\/rooms\/[^/]+\/state$/.test(path)) {
        return json(
          200,
          [...fake.state].map(([k, content]) => {
            const [type, ...stateKey] = k.split('|')
            return { type, state_key: stateKey.join('|'), content }
          }),
        )
      }
      const state = /^\/_matrix\/client\/v3\/rooms\/[^/]+\/state\/([^/]+)\/(.+)$/.exec(path)
      if (state) {
        const key = `${state[1]!}|${state[2]!}`
        if (method === 'GET') {
          const event = fake.state.get(key)
          return event ? json(200, event) : json(404, {})
        }
        if (fake.rateLimit > 0) {
          fake.rateLimit -= 1
          return json(429, { retry_after_ms: 1000 })
        }
        fake.state.set(key, body)
        return json(200, { event_id: '$e' })
      }
      const profile = /^\/_matrix\/client\/v3\/profile\/([^/]+)\/displayname$/.exec(path)
      if (profile && method === 'PUT') {
        const session = fake.sessions.find((s) => s.id === `sess-of-${token}`)!
        // O Synapse só deixa a conta do token escrever o próprio displayname.
        const owner = fake.users.find((u) => u.id === session.body.actor_user_id)
        if (`@${owner?.username}:${SERVER}` !== profile[1]) return json(403, {})
        fake.displaynames.push({ mxid: profile[1], displayname: String(body.displayname), actor: session.body.actor_user_id, session: session.id })
        return json(200, {})
      }
      if (path.endsWith('/invite')) {
        fake.invites.push(body.user_id as string)
        fake.state.set(`m.room.member|${String(body.user_id)}`, { membership: 'invite' })
        return json(200, {})
      }
      return json(404, {})
    }

    if ((init?.headers as Record<string, string>).authorization !== 'Bearer adm') return json(401, {})
    const byName = /^\/api\/admin\/v1\/users\/by-username\/(.+)$/.exec(path)
    if (byName) {
      const user = fake.users.find((u) => u.username === byName[1])
      return user ? json(200, { data: userRow(user) }) : json(404, {})
    }
    const deactivate = /^\/api\/admin\/v1\/users\/([^/]+)\/deactivate$/.exec(path)
    if (deactivate) {
      const user = fake.users.find((u) => u.id === deactivate[1])
      if (!user) return json(404, {})
      user.deactivated = body.skip_erase === true
      fake.emails = fake.emails.filter((e) => e.user_id !== user.id)
      return json(200, { data: userRow(user) })
    }
    const byId = /^\/api\/admin\/v1\/users\/([^/]+)$/.exec(path)
    if (byId) {
      const user = fake.users.find((u) => u.id === byId[1])
      return user ? json(200, { data: userRow(user) }) : json(404, {})
    }
    if (path === '/api/admin/v1/users') {
      const user = { id: `U-${String(body.username)}`, username: body.username as string, displayname: body.displayname as string }
      fake.users.push(user)
      return json(201, { data: userRow(user) })
    }
    if (path === '/api/admin/v1/user-emails') {
      if (method === 'POST') {
        fake.emails.push(body as Fake['emails'][number])
        return json(201, {})
      }
      const email = url.searchParams.get('filter[email]')
      return json(200, {
        data: fake.emails.filter((e) => e.email === email).map((e) => ({ attributes: { user_id: e.user_id } })),
      })
    }
    if (path === '/api/admin/v1/upstream-oauth-links') {
      if (method === 'POST') {
        const link = { id: `L${fake.links.length}`, ...(body as Omit<Fake['links'][number], 'id'>) }
        fake.links.push(link)
        return json(201, {})
      }
      const user = url.searchParams.get('filter[user]')
      return json(200, {
        data: fake.links.filter((l) => l.user_id === user).map((l) => ({ id: l.id, attributes: l })),
      })
    }
    const link = /^\/api\/admin\/v1\/upstream-oauth-links\/(.+)$/.exec(path)
    if (link && method === 'DELETE') {
      fake.links = fake.links.filter((l) => l.id !== link[1])
      return new Response(null, { status: 204 })
    }
    if (path === '/api/admin/v1/personal-sessions') {
      if (method === 'POST') {
        const n = fake.sessions.length
        fake.sessions.push({ id: `sess-of-mpt${n}`, body })
        return json(201, { data: { id: `sess-of-mpt${n}`, attributes: { access_token: `mpt${n}` } } })
      }
      // Filtro por ator e status ativo como no MAS; `expires_before` casa só as fixtures `expired-*`
      // (sessão sem `expires_in` tem `expires_at: null`, que nunca casa — medido, PLANO-AGENTES §0.2.1).
      const actor = url.searchParams.get('filter[actor_user]')
      const rows = fake.sessions.filter(
        (s) =>
          !s.revoked &&
          (actor === null || s.body.actor_user_id === actor) &&
          (!url.searchParams.has('filter[expires_before]') || s.id.startsWith('expired')),
      )
      return json(200, { data: rows.map((s) => ({ id: s.id })), query: url.search })
    }
    const revoke = /^\/api\/admin\/v1\/personal-sessions\/(.+)\/revoke$/.exec(path)
    if (revoke) {
      const session = fake.sessions.find((s) => s.id === revoke[1])
      if (!session) return json(404, {})
      if (session.revoked) return json(409, {})
      session.revoked = true
      session.revokedAt = fake.now()
      return json(200, {})
    }
    return json(404, {})
  }
  return ((input: string, init?: RequestInit) => Promise.resolve(route(input, init))) as typeof fetch
}

// Tokens fixos para as pessoas; um token cunhado pelo fake (`mptN`) introspecta como o ator da sessão
// enquanto ela não for revogada (mais a carência `introspectionGraceMs`, se houver) — é assim que o
// agente se autentica no reissue por self.
export function fakeIntrospector(fake?: Fake): Introspector {
  const identities: Record<string, { sub: string; username: string }> = {
    'tok-alice': { sub: 'sub-alice', username: 'alice' },
    'tok-bob': { sub: 'sub-bob', username: 'bob' },
  }
  const minted = (token: string): { sub: string; username: string } | null => {
    const live = (s: Fake['sessions'][number]): boolean =>
      !s.revoked || (fake !== undefined && s.revokedAt !== undefined && fake.now() - s.revokedAt < fake.introspectionGraceMs)
    const session = fake?.sessions.find((s) => s.id === `sess-of-${token}` && live(s))
    const user = fake?.users.find((u) => u.id === session?.body.actor_user_id)
    return user === undefined ? null : { sub: `sub-${user.id}`, username: user.username }
  }
  return {
    subjectOf: () => Promise.resolve(null),
    accessOf: () => Promise.resolve(null),
    identityOf(token) {
      if (token === 'tok-idp-down') return Promise.reject(new IdpUnavailableError())
      return Promise.resolve(identities[token] ?? minted(token))
    },
  }
}

