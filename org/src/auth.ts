import { deviceOfScope } from './mas-admin.ts'

// Port de autenticação do escrow (ADR-017 / PLANO §3.3). A identidade vem
// EXCLUSIVAMENTE do token: o introspector resolve Bearer → sujeito estável do IdP
// (claim `sub` do MAS — PF-1 item 2), e nenhum outro canal de identidade existe.
// A impl real (RFC 7662 contra o MAS) entra no commit 6; units injetam um fake.

export interface Introspector {
  // Sujeito estável do token ativo; null = inativo/inválido/expirado/revogado —
  // o chamador responde 401 indistinguível entre causas.
  subjectOf(token: string): Promise<string | null>
  // Identidade completa para as rotas de custódia de sessão (ADR-057 dec. 5): além do
  // sub, o `username` do MAS — a chave de endereçamento do retrieve e o discriminador
  // da identidade de custódia (F3: `cofre`). null nas mesmas causas do subjectOf, e
  // também quando o response não traz username utilizável.
  identityOf(token: string): Promise<{ sub: string; username: string } | null>
  // Identidade + device da sessão de origem para o revoke-others (ADR-082 dec. 3): o device vem
  // do `scope` do próprio token. null nas mesmas causas do identityOf, e sem device no escopo.
  accessOf(token: string): Promise<{ sub: string; username: string; device: string } | null>
}

// O MAS não respondeu (timeout, rede, 5xx): o escrow NÃO decide sem o IdP → 503.
export class IdpUnavailableError extends Error {
  constructor() {
    super('identity provider unavailable')
    this.name = 'IdpUnavailableError'
  }
}

// Introspecção RFC 7662 contra o MAS, no shape provado pelo PF-1 (§8 do PLANO):
// POST x-www-form-urlencoded com client_secret_basic; token ativo → { active: true,
// sub, username, device_id, … } — o sujeito canônico é `sub` (ULID estável do usuário
// no MAS). Qualquer resposta 200 sem `active: true` + `sub` → null (401 no chamador).
// Resposta não-200, JSON inválido ou timeout → IdpUnavailableError (503): credencial
// de introspecção quebrada é indistinguível de MAS fora — em ambos o escrow não tem
// como decidir. Sem cache, deliberadamente (§0.2 item 6): cada request introspecta.
export function rfc7662Introspector(opts: {
  url: string
  clientId: string
  clientSecret: string
  timeoutMs?: number
}): Introspector {
  const basic = Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString('base64')
  async function introspect(
    token: string,
  ): Promise<{ active?: unknown; sub?: unknown; username?: unknown; scope?: unknown }> {
    let body: unknown
    try {
      const res = await fetch(opts.url, {
        method: 'POST',
        headers: {
          authorization: `Basic ${basic}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ token }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 2000),
      })
      if (!res.ok) throw new Error('non-200')
      body = await res.json()
    } catch {
      throw new IdpUnavailableError()
    }
    if (typeof body !== 'object' || body === null) throw new IdpUnavailableError()
    return body
  }
  return {
    async subjectOf(token) {
      const data = await introspect(token)
      if (data.active !== true) return null
      return typeof data.sub === 'string' && data.sub.length > 0 ? data.sub : null
    },
    // Mesmo response RFC 7662 (uma introspecção só): `username` vem ao lado do `sub`
    // (PF-1, comentário acima). 200 sem active/sub/username válidos → null (401).
    async identityOf(token) {
      const data = await introspect(token)
      if (data.active !== true) return null
      if (typeof data.sub !== 'string' || data.sub.length === 0) return null
      if (typeof data.username !== 'string' || data.username.length === 0) return null
      return { sub: data.sub, username: data.username }
    },
    async accessOf(token) {
      const data = await introspect(token)
      if (data.active !== true) return null
      if (typeof data.sub !== 'string' || data.sub.length === 0) return null
      if (typeof data.username !== 'string' || data.username.length === 0) return null
      const device = deviceOfScope(data.scope)
      return device === null ? null : { sub: data.sub, username: data.username, device }
    },
  }
}
