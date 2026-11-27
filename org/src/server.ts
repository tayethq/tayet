// HTTP surface of the org service: node:http, people provisioning (/v1/people), the admin role and
// agents (/v1/agents), with the same paths, bodies and responses they had in the escrow. The org
// service holds no organization key and has no access to the escrow's volume.
// Contract invariants, each proven by a test:
//   - identity ONLY from the token (no caller userId in path, query or body; a body with an unknown
//     field is malformed → 400); the userId of DELETE /v1/people, of /v1/people/:userId/admin and of
//     /v1/agents/:userId is the TARGET, not the identity;
//   - 401 indistinguishable between causes;
//   - 503 when the IdP does not answer (the org service does not decide without MAS);
//   - no secret material (no token, no subject) in an error response or a log. The only response
//     with a token is the 201 of /v1/agents (and of the reissue): returned once, never stored.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { IdpUnavailableError, rfc7662Introspector, type Introspector } from './auth.ts'
import { errorReason, jsonlAudit, type AuditLog } from './audit.ts'
import { masAdmin } from './mas-admin.ts'
import { adminLock, createAdmins, type Admins } from './admins.ts'
import { createAgents, DEFAULT_AGENT_COLOR, isAgentColor, type AgentColor, type AgentPatch, type Agents } from './agents.ts'
import { createPeople, randomLocalpart, systemWriter, type InviteRequest, type People } from './people.ts'
import { homeserver } from './synapse.ts'

export const MAX_BODY_BYTES = 1024

export interface OrgDeps {
  introspector: Introspector
  audit: AuditLog
  people: People
  agents: Agents
  admins: Admins
}

function send(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(body))
}

function fail(res: ServerResponse, status: number, error: string): void {
  send(res, status, { error })
}

// Corpo bruto até o limite; 'too_large' assim que o limite estoura (sem bufferizar o resto).
async function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Buffer | 'too_large'> {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > limit) return 'too_large'
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    total += (chunk as Buffer).length
    if (total > limit) return 'too_large'
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

// Shape exato { email, name, kind }, allowlist estrita no padrão do parseSecret. O email vai em
// minúsculas: é o `subject` do vínculo (ADR-083 dec. 1) e o match do MAS é exato.
function parseInvite(raw: Buffer): InviteRequest | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  if (Object.keys(parsed).sort().join(',') !== 'email,kind,name') return null
  const { email, name, kind } = parsed as { email: unknown; name: unknown; kind: unknown }
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(email)) return null
  if (typeof name !== 'string' || name.trim().length === 0) return null
  // `agent` nunca entra por aqui (ADR-086 dec. 4): nasce só por POST /v1/agents.
  if (kind !== 'member' && kind !== 'guest') return null
  return { email: email.toLowerCase(), name: name.trim(), kind }
}

// Shape { name, color? }. O nome é o display name do agente e o `name` do evento em #all; a cor é
// uma das 10 (ausente → `areia`; desconhecida → 400).
function parseAgent(raw: Buffer): { name: string; color: AgentColor } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const keys = Object.keys(parsed)
  if (!keys.includes('name') || keys.some((k) => k !== 'name' && k !== 'color')) return null
  const { name, color } = parsed as { name: unknown; color?: unknown }
  if (typeof name !== 'string' || name.trim().length === 0) return null
  if (color !== undefined && !isAgentColor(color)) return null
  return { name: name.trim(), color: color ?? DEFAULT_AGENT_COLOR }
}

// PATCH: { name?, color? }, pelo menos um; nada além (kind e operator não são editáveis).
function parseAgentPatch(raw: Buffer): AgentPatch | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const keys = Object.keys(parsed)
  if (keys.length === 0 || keys.some((k) => k !== 'name' && k !== 'color')) return null
  const { name, color } = parsed as { name?: unknown; color?: unknown }
  if (name !== undefined && (typeof name !== 'string' || name.trim().length === 0)) return null
  if (color !== undefined && !isAgentColor(color)) return null
  return { ...(name !== undefined ? { name: name.trim() } : {}), ...(color !== undefined ? { color } : {}) }
}

function bearerToken(req: IncomingMessage): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')
  return m ? m[1]! : null
}

export function createOrgServer(deps: OrgDeps): Server {
  const { introspector, audit, people, agents, admins } = deps

  // ── Pessoas (ADR-083): GET /v1/people/me, POST /v1/people, DELETE /v1/people/:userId ───
  // O chamador vem SÓ do token; ser admin da org quem decide é o people.ts. :userId é o mxid do alvo,
  // o id que o client tem (state_key de io.tayet.member). 502 cobre MAS ou Synapse fora.
  async function peopleActor(
    verb:
      | 'people.me'
      | 'people.invite'
      | 'people.remove'
      | 'people.promote'
      | 'people.demote'
      | 'org.access'
      | 'agents.create'
      | 'agents.remove'
      | 'agents.reissue'
      | 'agents.update',
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<{ sub: string; username: string } | null> {
    const token = bearerToken(req)
    let identity: { sub: string; username: string } | null = null
    if (token !== null) {
      try {
        identity = await introspector.identityOf(token)
      } catch (err) {
        if (err instanceof IdpUnavailableError) {
          fail(res, 503, 'idp_unavailable')
          return null
        }
        throw err
      }
    }
    if (identity === null) {
      await audit.record({ verb, outcome: 'unauthorized' })
      fail(res, 401, 'unauthorized')
    }
    return identity
  }

  async function handlePeopleMe(service: People, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const verb = 'people.me'
    const actor = await peopleActor(verb, req, res)
    if (actor === null) return
    try {
      const result = await service.me(actor)
      send(res, result.status, result.body)
    } catch (err) {
      await audit.record({ sub: actor.sub, actor: actor.username, verb, outcome: 'error', reason: errorReason(err) })
      fail(res, 502, 'admin_unavailable')
    }
  }

  async function handlePeople(
    service: People,
    target: string | null,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const verb = target === null ? 'people.invite' : 'people.remove'
    const actor = await peopleActor(verb, req, res)
    if (actor === null) return
    const badRequest = async (): Promise<void> => {
      await audit.record({ sub: actor.sub, actor: actor.username, verb, outcome: 'error' })
      fail(res, 400, 'bad_request')
    }
    try {
      if (target !== null) {
        const raw = await readBody(req)
        if (raw === 'too_large' || raw.length > 0) {
          await badRequest()
          return
        }
        const result = await service.removePerson(target, actor)
        send(res, result.status, result.body)
        return
      }
      const raw = await readBody(req)
      if (raw === 'too_large' || req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
        await badRequest()
        return
      }
      const invite = parseInvite(raw)
      if (invite === null) {
        await badRequest()
        return
      }
      const result = await service.invitePerson(invite, actor)
      send(res, result.status, result.body)
    } catch (err) {
      // Falha antes de qualquer escrita (autorização, consulta): nada a reexecutar além da chamada.
      await audit.record({ sub: actor.sub, actor: actor.username, verb, outcome: 'error', reason: errorReason(err) })
      fail(res, 502, 'admin_unavailable')
    }
  }

  // ── Admin role: PUT and DELETE /v1/people/:userId/admin, GET /v1/org/access ───
  // Same regime as the people verbs: the caller only from the token, :userId is the target's mxid, an
  // empty body, and 502 when MAS or Synapse is down.
  async function handleAdmins(
    route: { verb: 'org.access' } | { verb: 'people.promote' | 'people.demote'; target: string },
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const { verb } = route
    const actor = await peopleActor(verb, req, res)
    if (actor === null) return
    try {
      const raw = await readBody(req)
      if (raw === 'too_large' || raw.length > 0) {
        await audit.record({ sub: actor.sub, actor: actor.username, verb, outcome: 'error' })
        fail(res, 400, 'bad_request')
        return
      }
      const result =
        route.verb === 'org.access'
          ? await admins.access(actor)
          : route.verb === 'people.promote'
            ? await admins.promote(route.target, actor)
            : await admins.demote(route.target, actor)
      send(res, result.status, result.body)
    } catch (err) {
      await audit.record({ sub: actor.sub, actor: actor.username, verb, outcome: 'error', reason: errorReason(err) })
      fail(res, 502, 'admin_unavailable')
    }
  }

  // ── Agentes (ADR-086): POST /v1/agents, DELETE /v1/agents/:userId, POST /v1/agents/:userId/reissue ──
  // Mesmo regime de /v1/people: chamador SÓ do token, :userId é o mxid do alvo, 502 com MAS/Synapse fora.
  async function handleAgents(
    service: Agents,
    route:
      | { verb: 'agents.create' }
      | { verb: 'agents.remove' | 'agents.reissue' | 'agents.update'; target: string },
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const { verb } = route
    const actor = await peopleActor(verb, req, res)
    if (actor === null) return
    const badRequest = async (): Promise<void> => {
      await audit.record({ sub: actor.sub, actor: actor.username, verb, outcome: 'error' })
      fail(res, 400, 'bad_request')
    }
    try {
      const raw = await readBody(req)
      if (raw === 'too_large') {
        await badRequest()
        return
      }
      const isJson = req.headers['content-type']?.split(';')[0]?.trim() === 'application/json'
      if (route.verb === 'agents.update') {
        const patch = isJson ? parseAgentPatch(raw) : null
        if (patch === null) {
          await badRequest()
          return
        }
        const result = await service.updateAgent(route.target, patch, actor)
        send(res, result.status, result.body)
        return
      }
      if (route.verb !== 'agents.create') {
        if (raw.length > 0) {
          await badRequest()
          return
        }
        const result =
          route.verb === 'agents.remove'
            ? await service.removeAgent(route.target, actor)
            : await service.reissueAgent(route.target, actor)
        send(res, result.status, result.body, result.headers)
        return
      }
      const agent = isJson ? parseAgent(raw) : null
      if (agent === null) {
        await badRequest()
        return
      }
      const result = await service.createAgent(agent.name, agent.color, actor)
      send(res, result.status, result.body)
    } catch (err) {
      await audit.record({ sub: actor.sub, actor: actor.username, verb, outcome: 'error', reason: errorReason(err) })
      fail(res, 502, 'admin_unavailable')
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://org.invalid')

    // Liveness: no authentication, no introspection, no audit.
    if (req.method === 'GET' && url.pathname === '/healthz') {
      send(res, 200, { ok: true })
      return
    }

    if (req.method === 'GET' && url.pathname === '/v1/people/me') {
      await handlePeopleMe(people, req, res)
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/people') {
      await handlePeople(people, null, req, res)
      return
    }
    const removal = /^\/v1\/people\/([^/]+)$/.exec(url.pathname)
    if (req.method === 'DELETE' && removal) {
      await handlePeople(people, decodeURIComponent(removal[1]!), req, res)
      return
    }

    const role = /^\/v1\/people\/([^/]+)\/admin$/.exec(url.pathname)
    if (role && (req.method === 'PUT' || req.method === 'DELETE')) {
      const target = decodeURIComponent(role[1]!)
      await handleAdmins({ verb: req.method === 'PUT' ? 'people.promote' : 'people.demote', target }, req, res)
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/org/access') {
      await handleAdmins({ verb: 'org.access' }, req, res)
      return
    }

    if (req.method === 'POST' && url.pathname === '/v1/agents') {
      await handleAgents(agents, { verb: 'agents.create' }, req, res)
      return
    }
    const one = /^\/v1\/agents\/([^/]+)$/.exec(url.pathname)
    if (req.method === 'DELETE' && one) {
      await handleAgents(agents, { verb: 'agents.remove', target: decodeURIComponent(one[1]!) }, req, res)
      return
    }
    if (req.method === 'PATCH' && one) {
      await handleAgents(agents, { verb: 'agents.update', target: decodeURIComponent(one[1]!) }, req, res)
      return
    }
    const reissue = /^\/v1\/agents\/([^/]+)\/reissue$/.exec(url.pathname)
    if (req.method === 'POST' && reissue) {
      await handleAgents(agents, { verb: 'agents.reissue', target: decodeURIComponent(reissue[1]!) }, req, res)
      return
    }

    fail(res, 404, 'not_found')
  }

  return createServer((req, res) => {
    handle(req, res).catch(() => {
      // Falha inesperada: resposta opaca, log genérico sem request/token/material.
      console.error('org: unhandled request error')
      if (!res.headersSent) fail(res, 500, 'internal')
      else res.end()
    })
  })
}

// ── Entry point: `node --experimental-strip-types src/server.ts` ──────────────────────
// Env: ORG_PORT (0 = ephemeral port), ORG_BIND (default 127.0.0.1), ORG_STORE_DIR (only audit.jsonl),
// ORG_INTROSPECTION_URL, ORG_CLIENT_ID, ORG_CLIENT_SECRET, ORG_MAS_ADMIN_URL,
// ORG_MAS_ADMIN_CLIENT_ID, ORG_MAS_ADMIN_CLIENT_SECRET (MAS internal listener and admin client),
// ORG_HS_URL, ORG_SERVER_NAME, ORG_PEOPLE_PROVIDER_ID (homeserver on the internal network, server_name
// and the id of the link's provider), ORG_CUSTODY_USERNAME (optional, default `cofre`). Without the
// admin API the service has no function: every other one is required. Ready = ONE JSON line
// {"listening": port} on stdout.

export function envOrThrow(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`missing env: ${name}`)
  return value
}

// The MAS admin client, the audit, the homeserver and the `system` writer from the ORG_* env: shared
// by the server and the command line (cli.ts).
export function orgBackendFromEnv() {
  const storeDir = envOrThrow('ORG_STORE_DIR')
  const introspectionUrl = envOrThrow('ORG_INTROSPECTION_URL')
  // The admin API lives on the internal listener, which serves no OAuth: the token comes from the
  // introspection host.
  const admin = masAdmin({
    url: envOrThrow('ORG_MAS_ADMIN_URL'),
    tokenUrl: new URL('/oauth2/token', introspectionUrl).href,
    clientId: envOrThrow('ORG_MAS_ADMIN_CLIENT_ID'),
    clientSecret: envOrThrow('ORG_MAS_ADMIN_CLIENT_SECRET'),
  })
  const audit = jsonlAudit(join(storeDir, 'audit.jsonl'))
  const custodyUsername = process.env.ORG_CUSTODY_USERNAME ?? 'cofre'
  // Pessoas e agentes dividem o Synapse e a escrita do `system` (o alias resolve uma vez por boot).
  const synapse = homeserver({ url: envOrThrow('ORG_HS_URL') })
  const serverName = envOrThrow('ORG_SERVER_NAME')
  const org = { synapse, serverName, asSystem: systemWriter({ masAdmin: admin, synapse, serverName }) }
  return { introspectionUrl, admin, audit, custodyUsername, org }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  const { introspectionUrl, admin, audit, custodyUsername, org } = orgBackendFromEnv()
  // One lock for the verbs that can leave the organization without an admin.
  const serialize = adminLock()
  const server = createOrgServer({
    introspector: rfc7662Introspector({
      url: introspectionUrl,
      clientId: envOrThrow('ORG_CLIENT_ID'),
      clientSecret: envOrThrow('ORG_CLIENT_SECRET'),
    }),
    audit,
    people: createPeople({
      masAdmin: admin,
      ...org,
      audit,
      randomId: randomLocalpart,
      providerId: envOrThrow('ORG_PEOPLE_PROVIDER_ID'),
      custodyUsername,
      serialize,
    }),
    admins: createAdmins({ masAdmin: admin, ...org, audit, serialize, custodyUsername }),
    agents: createAgents({ masAdmin: admin, ...org, audit, randomId: randomLocalpart }),
  })
  // Best-effort e fora do caminho do listen: MAS ainda subindo não segura o boot, e a próxima
  // reinicialização recolhe o que sobrou.
  admin.reapExpiredSystemSessions().catch(() => {
    console.error('org: expired system sessions not reaped')
  })
  // ORG_BIND: default 127.0.0.1 (host process, units); the compose files set 0.0.0.0.
  server.listen(Number(process.env.ORG_PORT ?? '0'), process.env.ORG_BIND ?? '127.0.0.1', () => {
    console.log(JSON.stringify({ listening: (server.address() as AddressInfo).port }))
  })
  // Orderly shutdown (SIGTERM from compose; stop_grace_period covers the drain), as in the escrow.
  // As PID 1 of the container, without a handler node IGNORES SIGTERM and docker kills it with
  // SIGKILL at the end of the grace period (measured: exit 137). Here server.close() stops accepting
  // connections, closes the idle ones (Caddy's keep-alive) and waits for the requests in flight. Cap
  // SHUTDOWN_CAP_MS < stop_grace_period of the compose files (contract): past it,
  // closeAllConnections() drops what is left and close() resolves. Exit 0 either way: the only state
  // on disk is the audit, in O_APPEND.
  const SHUTDOWN_CAP_MS = 5_000
  let shuttingDown = false
  function shutdown(signal: string): void {
    if (shuttingDown) return
    shuttingDown = true
    console.log(JSON.stringify({ evt: 'shutdown', signal }))
    const cap = setTimeout(() => {
      console.log(JSON.stringify({ evt: 'shutdown-cap', capMs: SHUTDOWN_CAP_MS }))
      server.closeAllConnections()
    }, SHUTDOWN_CAP_MS)
    server.close(() => {
      clearTimeout(cap)
      process.exit(0)
    })
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}
