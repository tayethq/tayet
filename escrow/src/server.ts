// Superfície HTTP do escrow (ADR-017 / PLANO §3.2): node:http, três endpoints de segredo
// 4S + o par de custódia de sessão /v1/sessions (ADR-057 dec. 5) + a revogação dos outros
// acessos /v1/account/revoke-others (ADR-082 dec. 3) + o provisionamento /v1/people (ADR-083) +
// os agentes /v1/agents (ADR-086; PATCH nome/cor na fatia 3), limites e erros.
// Invariantes de contrato, todos provados por teste:
//   - identidade SÓ do token (não existe userId do chamador em path/query/corpo; corpo com campo
//     desconhecido é malformado → 400); o userId de DELETE /v1/people e de /v1/agents/:userId é o
//     ALVO, não a identidade;
//   - 401 indistinguível entre causas, decidido ANTES de tocar o storage;
//   - 503 quando o IdP não responde (o escrow não decide sem o MAS);
//   - nenhum material de segredo (nem token, nem sujeito) em resposta de erro ou log. A única
//     resposta com token é o 201 de /v1/agents (e do reissue): devolvido uma vez, nunca gravado.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { IdpUnavailableError, rfc7662Introspector, type Introspector } from './auth.ts'
import { errorReason, jsonlAudit, type AuditLog } from './audit.ts'
import { etagOf, importOrgKey, open, seal } from './crypto.ts'
import { fileSessionStore, type SessionStore } from './custody-store.ts'
import { masAdmin, OriginUnknownError, type AccessAdmin } from './mas-admin.ts'
import { createAgents, DEFAULT_AGENT_COLOR, isAgentColor, type AgentColor, type AgentPatch, type Agents } from './agents.ts'
import { createPeople, randomLocalpart, systemWriter, type InviteRequest, type People } from './people.ts'
import { fileStore, type SecretStore } from './store.ts'
import { homeserver } from './synapse.ts'

export const MAX_BODY_BYTES = 1024 // §3.2: corpo do PUT até 1 KiB → 413 acima disso
// Limite próprio do depósito de sessão (ADR-057 dec. 5): a entry do export Megolm é
// ordem de KB; 64 KiB dá folga sem abrir a porta de payloads arbitrários. 413 acima.
export const MAX_SESSION_BODY_BYTES = 64 * 1024

export interface EscrowDeps {
  store: SecretStore
  introspector: Introspector
  orgKey: CryptoKey
  audit: AuditLog
  sessionStore: SessionStore
  // Identidade de custódia (ADR-057 dec. 5 / F3): o ÚNICO username autorizado a
  // depositar em /v1/sessions. Default `cofre` no wiring do main.
  custodyUsername: string
  // ADR-082 dec. 3. Ausente (deployment sem o client admin) → revoke-others responde 503: o reset
  // termina não-concluído, sem burn; os demais endpoints não dependem dele.
  accessAdmin?: AccessAdmin
  // ADR-083. Ausente (deployment sem o client admin) → as rotas /v1/people não existem.
  people?: People
  // ADR-086. Mesmo regime: ausente → as rotas /v1/agents não existem.
  agents?: Agents
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

// Shape exato {"secret": "<base64 não-vazio>"} — campo extra é malformado por contrato
// (ADR-017: o campo de identidade NÃO existe; aceitar e ignorar abriria a porta dele).
function parseSecret(raw: Buffer): Uint8Array | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const keys = Object.keys(parsed)
  if (keys.length !== 1 || keys[0] !== 'secret') return null
  const value = (parsed as { secret: unknown }).secret
  if (typeof value !== 'string' || value.length === 0) return null
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null
  return Uint8Array.from(Buffer.from(value, 'base64'))
}

interface SessionDeposit {
  roomId: string
  sessionId: string
  addressed: string[]
  session: Record<string, unknown>
}

// Shape exato { room_id, session_id, addressed, session } — allowlist estrita no padrão
// do parseSecret: campo extra é malformado (400). `addressed` = localparts (sem '@' nem
// ':' — mxid não entra; a chave de endereçamento é o username do MAS, estável no
// diretório Tayet). `session` é a entry do export Megolm (shape provado no spike C2) e
// precisa ecoar room_id/session_id — mismatch entre endereço de depósito e conteúdo é
// malformação, não conflito.
function parseSessionDeposit(raw: Buffer): SessionDeposit | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  if (Object.keys(parsed).sort().join(',') !== 'addressed,room_id,session,session_id') return null
  const { room_id, session_id, addressed, session } = parsed as {
    room_id: unknown
    session_id: unknown
    addressed: unknown
    session: unknown
  }
  if (typeof room_id !== 'string' || room_id.length === 0) return null
  if (typeof session_id !== 'string' || session_id.length === 0) return null
  if (!Array.isArray(addressed) || addressed.length === 0) return null
  for (const entry of addressed) {
    if (typeof entry !== 'string' || entry.length === 0) return null
    if (entry.includes('@') || entry.includes(':')) return null
  }
  if (typeof session !== 'object' || session === null || Array.isArray(session)) return null
  const s = session as Record<string, unknown>
  if (s.room_id !== room_id || s.session_id !== session_id) return null
  return { roomId: room_id, sessionId: session_id, addressed: addressed as string[], session: s }
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

// Chave de armazenamento e subject (AAD) andam juntos por construção: o AAD amarra o
// blob à chave — swap de arquivo entre sessões falha no open (teste obrigatório).
const sessionKeyOf = (roomId: string, sessionId: string): string => `${roomId}\n${sessionId}`
const sessionSubjectOf = (roomId: string, sessionId: string): string =>
  `session:${roomId}:${sessionId}`

function bearerToken(req: IncomingMessage): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')
  return m ? m[1]! : null
}

export function createEscrowServer(deps: EscrowDeps): Server {
  const { store, introspector, orgKey, audit, sessionStore, custodyUsername, accessAdmin, people, agents } = deps

  // ── Custódia de sessão (ADR-057 dec. 5): PUT/GET /v1/sessions ──────────────────────
  // Rotas ADITIVAS: os handlers de /v1/secret abaixo não mudam. Identidade SÓ do token
  // (ADR-017), agora com username (identityOf) — a chave de endereçamento do retrieve.
  async function handleSessions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const verb = req.method === 'PUT' ? 'deposit' : req.method === 'GET' ? 'retrieve' : null
    if (verb === null) {
      fail(res, 404, 'not_found')
      return
    }
    const token = bearerToken(req)
    let identity: { sub: string; username: string } | null = null
    if (token !== null) {
      try {
        identity = await introspector.identityOf(token)
      } catch (err) {
        if (err instanceof IdpUnavailableError) {
          fail(res, 503, 'idp_unavailable')
          return
        }
        throw err
      }
    }
    if (identity === null) {
      await audit.record({ verb, outcome: 'unauthorized' })
      fail(res, 401, 'unauthorized')
      return
    }

    if (verb === 'deposit') {
      // Depósito é EXCLUSIVO da identidade de custódia (F3: `cofre`). Token VÁLIDO de
      // outro usuário → 403 — desfecho NOVO no serviço: /v1/secret não o tem (lá todo
      // autenticado opera o próprio segredo; aqui depositar é um papel, não um direito
      // de qualquer sujeito).
      if (identity.username !== custodyUsername) {
        await audit.record({ sub: identity.sub, verb, outcome: 'forbidden' })
        fail(res, 403, 'forbidden')
        return
      }
      const raw = await readBody(req, MAX_SESSION_BODY_BYTES)
      if (raw === 'too_large') {
        await audit.record({ sub: identity.sub, verb, outcome: 'error' })
        fail(res, 413, 'payload_too_large')
        return
      }
      if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
        await audit.record({ sub: identity.sub, verb, outcome: 'error' })
        fail(res, 400, 'bad_request')
        return
      }
      const deposit = parseSessionDeposit(raw)
      if (deposit === null) {
        await audit.record({ sub: identity.sub, verb, outcome: 'error' })
        fail(res, 400, 'bad_request')
        return
      }
      // Envelope ÚNICO { addressed, session }, selado com subject = chave de
      // armazenamento: endereçados DENTRO do envelope (membership não fica em claro at
      // rest) e AAD amarrando o blob ao (room_id, session_id).
      const envelope = new TextEncoder().encode(
        JSON.stringify({ addressed: deposit.addressed, session: deposit.session }),
      )
      const blob = await seal(orgKey, sessionSubjectOf(deposit.roomId, deposit.sessionId), envelope)
      const written = await sessionStore.putOnce(
        sessionKeyOf(deposit.roomId, deposit.sessionId),
        blob,
      )
      if (!written) {
        // Redepósito → 200 exists SEM comparação de conteúdo: blobs selados divergem
        // por nonce a cada seal; a unicidade do session_id (Megolm) garante a
        // equivalência do material. Trade registrado no §8.2.
        await audit.record({ sub: identity.sub, verb, outcome: 'exists' })
        send(res, 200, { outcome: 'exists' })
        return
      }
      await audit.record({ sub: identity.sub, verb, outcome: 'created' })
      send(res, 201, { outcome: 'created' })
      return
    }

    // A identidade de custódia deposita e NUNCA lê (ADR-069, Proposto). Ela é membro ao
    // nascimento de toda sala cifrada (ADR-057 dec. 2), logo está em `addressed` de toda
    // sessão que depositou: sem esta guarda o token dela — longevo, num arquivo do host —
    // leria a custódia inteira pelo /escrow público. O agente não chama retrieve (só PUT,
    // agent/src/escrow-client.ts). Mesmo regime dos outros 403: audit com sub, corpo burro.
    if (identity.username === custodyUsername) {
      await audit.record({ sub: identity.sub, verb, outcome: 'forbidden' })
      fail(res, 403, 'forbidden')
      return
    }

    // Retrieve: qualquer usuário autenticado; o filtro é `username ∈ addressed` do
    // envelope — o snapshot do NASCIMENTO da sessão (F5). NUNCA "sessões das salas onde
    // sou membro": sob history_visibility shared (ADR-057 dec. 3) isso entregaria
    // pré-entrada a late joiner e quebraria a norma 1 por baixo. Ausência de match é
    // resposta normal (200 + array vazio), não 404.
    const sessions: unknown[] = []
    try {
      for await (const { key, blob } of sessionStore.entries()) {
        const split = key.indexOf('\n')
        const subject = sessionSubjectOf(key.slice(0, split), key.slice(split + 1))
        const envelope = JSON.parse(
          new TextDecoder().decode(await open(orgKey, subject, blob)),
        ) as { addressed: string[]; session: unknown }
        if (envelope.addressed.includes(identity.username)) sessions.push(envelope.session)
      }
    } catch {
      // Tamper/realocação/registro corrompido: rejeição limpa do retrieve INTEIRO —
      // nem material "melhor esforço", nem detalhe de cripto no erro (500 genérico).
      await audit.record({ sub: identity.sub, verb, outcome: 'error' })
      fail(res, 500, 'internal')
      return
    }
    await audit.record({ sub: identity.sub, verb, outcome: 'ok' })
    send(res, 200, { sessions })
  }

  // ── Revogação dos outros acessos (ADR-082 dec. 3): POST /v1/account/revoke-others ──────
  // Identidade SÓ do token (ADR-017): o corpo é vazio e o alvo é o usuário do token; a origem é o
  // device do escopo dele. Idempotente — o reset chama antes do rotate e de novo ao concluir.
  async function handleRevokeOthers(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const verb = 'revoke-others'
    const token = bearerToken(req)
    let access: { sub: string; username: string; device: string } | null = null
    if (token !== null) {
      try {
        access = await introspector.accessOf(token)
      } catch (err) {
        if (err instanceof IdpUnavailableError) {
          fail(res, 503, 'idp_unavailable')
          return
        }
        throw err
      }
    }
    if (access === null) {
      await audit.record({ verb, outcome: 'unauthorized' })
      fail(res, 401, 'unauthorized')
      return
    }
    const raw = await readBody(req)
    if (raw === 'too_large' || raw.length > 0) {
      await audit.record({ sub: access.sub, verb, outcome: 'error' })
      fail(res, 400, 'bad_request')
      return
    }
    if (accessAdmin === undefined) {
      await audit.record({ sub: access.sub, verb, outcome: 'error' })
      fail(res, 503, 'admin_unavailable')
      return
    }
    try {
      const revoked = await accessAdmin.revokeOthers(access.username, access.device)
      await audit.record({ sub: access.sub, verb, outcome: 'revoked', revoked })
      send(res, 200, { revoked })
    } catch (err) {
      if (err instanceof OriginUnknownError) {
        await audit.record({ sub: access.sub, verb, outcome: 'origin_unknown' })
        fail(res, 409, 'origin_unknown')
        return
      }
      // MAS fora ou resposta inesperada: pode ter encerrado parte, nunca reportado como sucesso.
      await audit.record({ sub: access.sub, verb, outcome: 'error' })
      fail(res, 502, 'admin_unavailable')
    }
  }

  // ── Pessoas (ADR-083): GET /v1/people/me, POST /v1/people, DELETE /v1/people/:userId ───
  // O chamador vem SÓ do token; ser admin da org quem decide é o people.ts. :userId é o mxid do alvo,
  // o id que o client tem (state_key de io.tayet.member). 502 cobre MAS ou Synapse fora.
  async function peopleActor(
    verb: 'people.me' | 'people.invite' | 'people.remove' | 'agents.create' | 'agents.remove' | 'agents.reissue' | 'agents.update',
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
    const url = new URL(req.url ?? '/', 'http://escrow.invalid')

    // §3.2: vida sem autenticação, sem introspecção, sem auditoria (gate assert 8).
    if (req.method === 'GET' && url.pathname === '/healthz') {
      send(res, 200, { ok: true })
      return
    }

    if (url.pathname === '/v1/sessions') {
      await handleSessions(req, res)
      return
    }

    if (req.method === 'POST' && url.pathname === '/v1/account/revoke-others') {
      await handleRevokeOthers(req, res)
      return
    }

    if (people !== undefined) {
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
    }

    if (agents !== undefined) {
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
    }

    const verb =
      req.method === 'PUT' && url.pathname === '/v1/secret'
        ? 'put'
        : req.method === 'GET' && url.pathname === '/v1/secret'
          ? 'get'
          : req.method === 'POST' && url.pathname === '/v1/secret/rotate'
            ? 'rotate'
            : null
    if (verb === null) {
      fail(res, 404, 'not_found')
      return
    }

    // Autenticação antes de qualquer toque no storage (§3.3). 401 não distingue
    // ausente/inválido/expirado/revogado; só o 503 (IdP fora) é uma classe à parte.
    const token = bearerToken(req)
    let subject: string | null = null
    if (token !== null) {
      try {
        subject = await introspector.subjectOf(token)
      } catch (err) {
        if (err instanceof IdpUnavailableError) {
          fail(res, 503, 'idp_unavailable')
          return
        }
        throw err
      }
    }
    if (subject === null) {
      await audit.record({ verb, outcome: 'unauthorized' })
      fail(res, 401, 'unauthorized')
      return
    }

    if (verb === 'put') {
      const raw = await readBody(req)
      if (raw === 'too_large') {
        await audit.record({ sub: subject, verb, outcome: 'error' })
        fail(res, 413, 'payload_too_large')
        return
      }
      if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
        await audit.record({ sub: subject, verb, outcome: 'error' })
        fail(res, 400, 'bad_request')
        return
      }
      const secret = parseSecret(raw)
      if (secret === null) {
        await audit.record({ sub: subject, verb, outcome: 'error' })
        fail(res, 400, 'bad_request')
        return
      }
      const blob = await seal(orgKey, subject, secret)
      const written = await store.put(subject, blob)
      if (!written) {
        await audit.record({ sub: subject, verb, outcome: 'conflict' })
        fail(res, 409, 'conflict')
        return
      }
      await audit.record({ sub: subject, verb, outcome: 'created' })
      // ETag aditivo (D1 §2.2): o primeiro depositante já sai com o etag do blob
      // corrente para um eventual rotate. Corpo e código intocados.
      send(res, 201, { created: true }, { ETag: etagOf(blob) })
      return
    }

    if (verb === 'rotate') {
      // D1 §3.3 — ordem dos guards: If-Match presente (senão 428, antes de ler o
      // corpo) → corpo válido (mesma validação do PUT) → seal → CAS no storage.
      const ifMatch = req.headers['if-match']
      if (typeof ifMatch !== 'string' || ifMatch === '') {
        await audit.record({ sub: subject, verb, outcome: 'missing_precondition' })
        fail(res, 428, 'precondition_required')
        return
      }
      const raw = await readBody(req)
      if (raw === 'too_large') {
        await audit.record({ sub: subject, verb, outcome: 'error' })
        fail(res, 413, 'payload_too_large')
        return
      }
      if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
        await audit.record({ sub: subject, verb, outcome: 'error' })
        fail(res, 400, 'bad_request')
        return
      }
      const secret = parseSecret(raw)
      if (secret === null) {
        await audit.record({ sub: subject, verb, outcome: 'error' })
        fail(res, 400, 'bad_request')
        return
      }
      const blob = await seal(orgKey, subject, secret)
      const result = await store.replace(subject, blob, ifMatch)
      if (result === 'absent') {
        // Rotate NUNCA cria (D1 §0.2.4): criar é PUT; nenhuma escrita aconteceu.
        await audit.record({ sub: subject, verb, outcome: 'not_found' })
        fail(res, 404, 'not_found')
        return
      }
      if (result === 'stale') {
        // CAS falhou: outro reset venceu a linearização; storage intocado (D1 §0.2.2).
        await audit.record({ sub: subject, verb, outcome: 'stale' })
        fail(res, 412, 'precondition_failed')
        return
      }
      await audit.record({ sub: subject, verb, outcome: 'rotated' })
      send(res, 200, { rotated: true }, { ETag: etagOf(blob) })
      return
    }

    const blob = await store.get(subject)
    if (blob === null) {
      await audit.record({ sub: subject, verb, outcome: 'not_found' })
      fail(res, 404, 'not_found')
      return
    }
    let secret: Uint8Array
    try {
      secret = await open(orgKey, subject, blob)
    } catch {
      // Tamper/realocação no storage: rejeição limpa, nunca bytes "melhor esforço".
      await audit.record({ sub: subject, verb, outcome: 'error' })
      fail(res, 500, 'internal')
      return
    }
    await audit.record({ sub: subject, verb, outcome: 'ok' })
    // ETag aditivo (D1 §2.2): etag do blob corrente — o insumo do If-Match do rotate.
    send(res, 200, { secret: Buffer.from(secret).toString('base64') }, { ETag: etagOf(blob) })
  }

  return createServer((req, res) => {
    handle(req, res).catch(() => {
      // Falha inesperada: resposta opaca, log genérico sem request/token/material.
      console.error('escrow: unhandled request error')
      if (!res.headersSent) fail(res, 500, 'internal')
      else res.end()
    })
  })
}

// ── Entry point (PF-3): `node --experimental-strip-types src/server.ts` ──────────────
// Env (§3.1): ESCROW_PORT (0 = porta efêmera), ESCROW_BIND (default 127.0.0.1),
// ESCROW_STORE_DIR, ESCROW_ORG_KEY (32 bytes base64, env-only — JAMAIS commitada),
// ESCROW_INTROSPECTION_URL, ESCROW_CLIENT_ID, ESCROW_CLIENT_SECRET,
// ESCROW_CUSTODY_USERNAME (opcional, default `cofre` — F3/ADR-057 dec. 5),
// ESCROW_MAS_ADMIN_URL + ESCROW_MAS_ADMIN_CLIENT_ID + ESCROW_MAS_ADMIN_CLIENT_SECRET (opcionais,
// tudo-ou-nada — ADR-082 dec. 3: listener interno do MAS e client admin), com eles ESCROW_HS_URL,
// ESCROW_SERVER_NAME e ESCROW_PEOPLE_PROVIDER_ID (ADR-083: Synapse pela rede interna, server_name e
// id do provider do vínculo). Pronto = UMA
// linha JSON {"listening": porta} no stdout (readback de porta do harness);
// localhost-only por default, sem TLS (forma operacional deferida — ADR-017).

function envOrThrow(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`missing env: ${name}`)
  return value
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  const storeDir = envOrThrow('ESCROW_STORE_DIR')
  const introspectionUrl = envOrThrow('ESCROW_INTROSPECTION_URL')
  const masAdminUrl = process.env.ESCROW_MAS_ADMIN_URL
  // A admin API vive no listener interno, que não serve OAuth: o token vem do mesmo host da
  // introspecção. URL presente sem o client é erro de deploy: falha no boot.
  const admin = masAdminUrl
    ? masAdmin({
        url: masAdminUrl,
        tokenUrl: new URL('/oauth2/token', introspectionUrl).href,
        clientId: envOrThrow('ESCROW_MAS_ADMIN_CLIENT_ID'),
        clientSecret: envOrThrow('ESCROW_MAS_ADMIN_CLIENT_SECRET'),
      })
    : undefined
  const audit = jsonlAudit(join(storeDir, 'audit.jsonl'))
  const custodyUsername = process.env.ESCROW_CUSTODY_USERNAME ?? 'cofre'
  // Pessoas e agentes dividem o Synapse e a escrita do `system` (o alias resolve uma vez por boot).
  const org = admin
    ? (() => {
        const synapse = homeserver({ url: envOrThrow('ESCROW_HS_URL') })
        const serverName = envOrThrow('ESCROW_SERVER_NAME')
        return { synapse, serverName, asSystem: systemWriter({ masAdmin: admin, synapse, serverName }) }
      })()
    : undefined
  const server = createEscrowServer({
    store: fileStore(storeDir),
    introspector: rfc7662Introspector({
      url: introspectionUrl,
      clientId: envOrThrow('ESCROW_CLIENT_ID'),
      clientSecret: envOrThrow('ESCROW_CLIENT_SECRET'),
    }),
    orgKey: await importOrgKey(envOrThrow('ESCROW_ORG_KEY')),
    audit,
    // Subdiretório próprio: registros de sessão não se misturam aos blobs 4S nem ao
    // audit.jsonl no mesmo nível do store dir.
    sessionStore: fileSessionStore(join(storeDir, 'sessions')),
    custodyUsername,
    ...(admin && org
      ? {
          accessAdmin: admin,
          people: createPeople({
            masAdmin: admin,
            ...org,
            audit,
            randomId: randomLocalpart,
            providerId: envOrThrow('ESCROW_PEOPLE_PROVIDER_ID'),
            custodyUsername,
          }),
          agents: createAgents({ masAdmin: admin, ...org, audit, randomId: randomLocalpart }),
        }
      : {}),
  })
  // Best-effort e fora do caminho do listen: MAS ainda subindo não segura o boot, e a próxima
  // reinicialização recolhe o que sobrou.
  admin?.reapExpiredSystemSessions().catch(() => {
    console.error('escrow: expired system sessions not reaped')
  })
  // ESCROW_BIND: default 127.0.0.1 preserva a postura localhost-only do uso host-process
  // (harness/units — ADR-017). O dev-stack conteinerizado seta 0.0.0.0: bind em loopback do
  // container não é alcançável via porta publicada nem container-a-container. NÃO resolve a
  // forma operacional de produção (TLS/exposição), deferida no ADR-017. Ver ADR-021.
  server.listen(Number(process.env.ESCROW_PORT ?? '0'), process.env.ESCROW_BIND ?? '127.0.0.1', () => {
    console.log(JSON.stringify({ listening: (server.address() as AddressInfo).port }))
  })
  // Shutdown ordenado (SIGTERM do compose; stop_grace_period cobre o drain) — idioma do
  // agent/src/main.ts. Como PID 1 do container, sem handler o node IGNORA o SIGTERM e o docker
  // mata com SIGKILL no fim do grace (medido: exit 137, PLANO-RELEASE-PUBLICA §8.41). Aqui:
  // server.close() para de aceitar conexões, fecha as ociosas (keep-alive do Caddy) e espera as
  // requests em voo — um depósito a meio caminho completa (store + audit + resposta). Teto
  // SHUTDOWN_CAP_MS < stop_grace_period dos compose (contrato): estourou, closeAllConnections()
  // derruba o que sobrou e o close() resolve. Exit 0 nos dois casos: o estado em disco é seguro
  // por construção (tmp+link/rename, O_APPEND no audit).
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
