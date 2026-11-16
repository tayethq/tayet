// Minimal fetch wrapper over the escrow contract (ADR-017; PLANO-FASE-2-ESCROW-C2 §3.1).
// Confined to acl/internal — custody vocabulary never crosses the barrel (§3.5).
//
// Outcome mapping is TOTAL and exception-free by construction (§0.2 item 1): every transport
// or protocol failure folds into 'unavailable', which feeds the never-block-login policy in
// ensureKeyRecovery. 409 is NOT an error — it is the write-once race protocol (§0.2 item 2):
// the loser GETs and adopts the winning secret.
//
// The secret exists here only as in-flight bytes (raw in memory, base64 on the wire — ADR-017).
// Nothing in this module logs, throws, or persists; no token and no secret material ever leave
// through any channel but the authenticated request itself.

import type { AgentColor, UserKind } from '@tayet/shared'

// ADR-086 (Proposto) dec. 4: an agent never enters through /v1/people — the escrow refuses it at
// runtime (slice 2) and the client cannot even ask for it. Mirrors the escrow's own PersonKind.
export type PersonKind = Exclude<UserKind, 'agent'>

export type DepositOutcome =
  | { kind: 'deposited' } // 201 — this device won the first-login race
  | { kind: 'exists' } // 409 — lost the race (or already deposited): GET and adopt
  | { kind: 'unavailable' } // 401/4xx/5xx/network — custody unreachable; retry later

export type RetrieveOutcome =
  // 200 — the org-custodied secret. `etag` is the CURRENT version tag (ADDITIVE, D1 §2.2): the
  // If-Match input a later rotate needs. Optional for totality — a 200 that omits the header
  // (custody misbehaving) still yields the secret, only the rotate-driven reset cannot CAS.
  | { kind: 'secret'; secret: Uint8Array<ArrayBuffer>; etag?: string }
  | { kind: 'none' } // 404 — first login: nothing deposited yet
  | { kind: 'unavailable' } // 401/4xx/5xx/network — custody unreachable; retry later

// Rotate (D3 / ADR-019 §2 — the reset's rotate-first step). CAS the custodied secret behind an
// If-Match on the current etag: the escrow LINEARIZES two concurrent resets exactly as the
// write-once PUT linearized two first logins (C2 §8 obs. 5). Outcomes mirror the service (D1):
export type RotateOutcome =
  | { kind: 'rotated'; etag: string } // 200 — won the CAS; the NEW version tag
  | { kind: 'stale' } // 412 — another reset linearized first; re-read and re-decide
  | { kind: 'absent' } // 404 — nothing deposited (rotate never creates; that is deposit)
  | { kind: 'unavailable' } // 428/401/5xx/network — custody unreachable; retry later

// Custódia de sessão (ADR-057 dec. 5/6 — PR-5). GET /v1/sessions devolve as entries de export
// Megolm endereçadas ao usuário do token (filtro F5 no serviço; zero parâmetros de identidade).
// As entries são OPACAS aqui: o client não as parseia além do shape de transporte — elas seguem
// direto para importRoomKeysAsJson (ensureKeyRecovery). Zero matches é 200 com array vazio, um
// desfecho NORMAL ('sessions' com []), não 'unavailable' — a distinção alimenta o veredito
// definitivo da dec. 7 (consulta feita ≠ consulta falhou).
export type SessionsOutcome =
  | { kind: 'sessions'; sessions: unknown[] } // 200 — consulta feita; payload p/ import
  | { kind: 'unavailable' } // 401/4xx/5xx/network — custódia inalcançável; sem veredito

// Revogação dos outros acessos (ADR-082 dec. 3). Idempotente no serviço; o corpo é vazio e o alvo é
// o usuário do token. Qualquer outra resposta (503 sem client admin, 409 sem origem, MAS fora) é
// não-conclusão do reset, sem burn.
export type RevokeOthersOutcome = { kind: 'revoked' } | { kind: 'unavailable' }

// Pessoas (ADR-083). `completed` e `created` são o mesmo desfecho para o client: a pessoa está
// provisionada. 502 parcial e 504 são 'unavailable' porque reexecutar completa; 400/403 são 'rejected'.
export type PersonInviteOutcome =
  | { kind: 'invited'; userId: string; personKind: PersonKind }
  | { kind: 'exists' }
  | { kind: 'rejected' }
  | { kind: 'unavailable' }

export type PersonRemoveOutcome = { kind: 'removed' } | { kind: 'rejected' } | { kind: 'unavailable' }

// Agentes (ADR-086). O token sai daqui só no 201 de create/reissue, exibido uma vez pela UI; nunca
// logado nem guardado. 409 é colisão de nome (dec. 6); 502/504 'unavailable' (repetir conclui).
export type AgentCreateOutcome =
  | { kind: 'created'; userId: string; token: string }
  | { kind: 'name_taken' }
  | { kind: 'rejected' }
  | { kind: 'unavailable' }
export type AgentUpdateOutcome = { kind: 'updated' } | { kind: 'name_taken' } | { kind: 'rejected' } | { kind: 'unavailable' }
export type AgentReissueOutcome = { kind: 'reissued'; token: string } | { kind: 'rejected' } | { kind: 'unavailable' }

export interface EscrowClient {
  deposit(secret: Uint8Array): Promise<DepositOutcome>
  retrieve(): Promise<RetrieveOutcome>
  // ifMatchEtag is echoed verbatim into If-Match — the client never parses the opaque tag.
  rotate(secret: Uint8Array, ifMatchEtag: string): Promise<RotateOutcome>
  retrieveSessions(): Promise<SessionsOutcome>
  revokeOthers(): Promise<RevokeOthersOutcome>
}

export interface EscrowClientOpts {
  baseUrl: string
  // The MAS token the client already holds (identity is derived from it server-side; ADR-017 —
  // there is no user field anywhere in the contract). A getter follows the refresh: the access
  // token lives minutes in production, and the reset comes long after the connect (ADR-082).
  token: string | (() => string)
  // Injectable for the in-memory fake of the unit tests (§0.2 item 4); defaults to global fetch.
  fetchFn?: typeof fetch
}

export interface PeopleClient {
  isAdmin(): Promise<boolean>
  invite(person: { email: string; name: string; kind: PersonKind }): Promise<PersonInviteOutcome>
  remove(userId: string): Promise<PersonRemoveOutcome>
  createAgent(agent: { name: string; color: AgentColor }): Promise<AgentCreateOutcome>
  updateAgent(userId: string, patch: { name?: string; color?: AgentColor }): Promise<AgentUpdateOutcome>
  reissueAgent(userId: string): Promise<AgentReissueOutcome>
  removeAgent(userId: string): Promise<PersonRemoveOutcome>
}

// O escrow espera até 20 s por escrita sob 429 (ADR-083, addendum), e um convite faz mais de uma.
const PEOPLE_TIMEOUT_MS = 45_000

function toBase64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> | undefined {
  try {
    const bin = atob(b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return undefined
  }
}

export function createEscrowClient(opts: EscrowClientOpts): EscrowClient {
  const fetchFn = opts.fetchFn ?? globalThis.fetch
  const base = opts.baseUrl.replace(/\/+$/, '')
  const url = `${base}/v1/secret`
  const sessionsUrl = `${base}/v1/sessions`
  const revokeOthersUrl = `${base}/v1/account/revoke-others`
  const token = opts.token
  const authHeader = (): { Authorization: string } => ({
    Authorization: `Bearer ${typeof token === 'function' ? token() : token}`,
  })

  return {
    async deposit(secret: Uint8Array): Promise<DepositOutcome> {
      try {
        const res = await fetchFn(url, {
          method: 'PUT',
          headers: { ...authHeader(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ secret: toBase64(secret) }),
        })
        if (res.status === 201) return { kind: 'deposited' }
        if (res.status === 409) return { kind: 'exists' }
        return { kind: 'unavailable' }
      } catch {
        return { kind: 'unavailable' }
      }
    },

    async retrieve(): Promise<RetrieveOutcome> {
      try {
        const res = await fetchFn(url, { method: 'GET', headers: authHeader() })
        if (res.status === 404) return { kind: 'none' }
        if (res.status !== 200) return { kind: 'unavailable' }
        const body = (await res.json()) as { secret?: unknown }
        const secret = typeof body.secret === 'string' ? fromBase64(body.secret) : undefined
        // A 200 whose body does not decode is custody misbehaving — fold into 'unavailable'
        // (defensive totality; never throw past this boundary).
        if (!secret) return { kind: 'unavailable' }
        return { kind: 'secret', secret, etag: etagOf(res) }
      } catch {
        return { kind: 'unavailable' }
      }
    },

    async rotate(secret: Uint8Array, ifMatchEtag: string): Promise<RotateOutcome> {
      try {
        const res = await fetchFn(`${url}/rotate`, {
          method: 'POST',
          headers: { ...authHeader(), 'Content-Type': 'application/json', 'If-Match': ifMatchEtag },
          body: JSON.stringify({ secret: toBase64(secret) }),
        })
        if (res.status === 200) {
          const etag = etagOf(res)
          // 200 without an etag is custody misbehaving — fold into 'unavailable' (the CAS chain
          // cannot continue without the next version tag), never a half-believed 'rotated'.
          return etag !== undefined ? { kind: 'rotated', etag } : { kind: 'unavailable' }
        }
        if (res.status === 412) return { kind: 'stale' }
        if (res.status === 404) return { kind: 'absent' }
        return { kind: 'unavailable' }
      } catch {
        return { kind: 'unavailable' }
      }
    },

    async retrieveSessions(): Promise<SessionsOutcome> {
      try {
        const res = await fetchFn(sessionsUrl, { method: 'GET', headers: authHeader() })
        if (res.status !== 200) return { kind: 'unavailable' }
        const body = (await res.json()) as { sessions?: unknown }
        // 200 cujo corpo não tem o array é custódia se comportando mal — 'unavailable'
        // (totalidade defensiva, mesmo trade do retrieve): um veredito de perda não pode
        // nascer de uma resposta malformada.
        if (!Array.isArray(body.sessions)) return { kind: 'unavailable' }
        return { kind: 'sessions', sessions: body.sessions }
      } catch {
        return { kind: 'unavailable' }
      }
    },

    async revokeOthers(): Promise<RevokeOthersOutcome> {
      try {
        const res = await fetchFn(revokeOthersUrl, { method: 'POST', headers: authHeader() })
        return res.status === 200 ? { kind: 'revoked' } : { kind: 'unavailable' }
      } catch {
        return { kind: 'unavailable' }
      }
    },
  }
}

// Sem cripto: quem convida não depende da recuperação de chaves, por isso o client é separado do de
// custódia. Mesma totalidade: nada aqui lança.
export function createPeopleClient(opts: EscrowClientOpts & { timeoutMs?: number }): PeopleClient {
  const fetchFn = opts.fetchFn ?? globalThis.fetch
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/v1/people`
  const agentsUrl = `${opts.baseUrl.replace(/\/+$/, '')}/v1/agents`
  const token = opts.token
  const timeoutMs = opts.timeoutMs ?? PEOPLE_TIMEOUT_MS
  const request = (target: string, init: { method: string; body?: string }): Promise<Response> =>
    fetchFn(target, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Authorization: `Bearer ${typeof token === 'function' ? token() : token}`,
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
    })
  const failure = (res: Response): 'rejected' | 'unavailable' => (res.status >= 500 ? 'unavailable' : 'rejected')

  return {
    async isAdmin(): Promise<boolean> {
      try {
        const res = await request(`${url}/me`, { method: 'GET' })
        return res.status === 200 && ((await res.json()) as { admin?: unknown }).admin === true
      } catch {
        return false
      }
    },

    async invite(person): Promise<PersonInviteOutcome> {
      try {
        const res = await request(url, { method: 'POST', body: JSON.stringify(person) })
        if (res.status === 409) return { kind: 'exists' }
        if (res.status !== 201) return { kind: failure(res) }
        const body = (await res.json()) as { userId?: unknown; kind?: unknown }
        if (typeof body.userId !== 'string' || (body.kind !== 'member' && body.kind !== 'guest')) {
          return { kind: 'unavailable' }
        }
        return { kind: 'invited', userId: body.userId, personKind: body.kind }
      } catch {
        return { kind: 'unavailable' }
      }
    },

    async remove(userId): Promise<PersonRemoveOutcome> {
      try {
        const res = await request(`${url}/${encodeURIComponent(userId)}`, { method: 'DELETE' })
        return res.status === 200 ? { kind: 'removed' } : { kind: failure(res) }
      } catch {
        return { kind: 'unavailable' }
      }
    },

    async createAgent(agent): Promise<AgentCreateOutcome> {
      try {
        const res = await request(agentsUrl, { method: 'POST', body: JSON.stringify(agent) })
        if (res.status === 409) return { kind: 'name_taken' }
        if (res.status !== 201) return { kind: failure(res) }
        const body = (await res.json()) as { userId?: unknown; token?: unknown }
        if (typeof body.userId !== 'string' || typeof body.token !== 'string') return { kind: 'unavailable' }
        return { kind: 'created', userId: body.userId, token: body.token }
      } catch {
        return { kind: 'unavailable' }
      }
    },

    async updateAgent(userId, patch): Promise<AgentUpdateOutcome> {
      try {
        const res = await request(`${agentsUrl}/${encodeURIComponent(userId)}`, { method: 'PATCH', body: JSON.stringify(patch) })
        if (res.status === 409) return { kind: 'name_taken' }
        return res.status === 200 ? { kind: 'updated' } : { kind: failure(res) }
      } catch {
        return { kind: 'unavailable' }
      }
    },

    async reissueAgent(userId): Promise<AgentReissueOutcome> {
      try {
        const res = await request(`${agentsUrl}/${encodeURIComponent(userId)}/reissue`, { method: 'POST' })
        if (res.status !== 201) return { kind: failure(res) }
        const body = (await res.json()) as { token?: unknown }
        return typeof body.token === 'string' ? { kind: 'reissued', token: body.token } : { kind: 'unavailable' }
      } catch {
        return { kind: 'unavailable' }
      }
    },

    async removeAgent(userId): Promise<PersonRemoveOutcome> {
      try {
        const res = await request(`${agentsUrl}/${encodeURIComponent(userId)}`, { method: 'DELETE' })
        return res.status === 200 ? { kind: 'removed' } : { kind: failure(res) }
      } catch {
        return { kind: 'unavailable' }
      }
    },
  }
}

// The opaque version tag (D1 §2.2). The service emits an unquoted hex; we never parse it, only
// echo it back in If-Match. Header name is case-insensitive per the spec.
function etagOf(res: Response): string | undefined {
  return res.headers.get('ETag') ?? res.headers.get('etag') ?? undefined
}
