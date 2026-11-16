// Auditoria append-only (ADR-017 / PLANO §3.6): uma linha JSONL por acesso — sujeito,
// verbo, desfecho, timestamp. Formato deliberadamente burro: é o insumo do SIEM
// prometido no ADR-014. NUNCA material de segredo, NUNCA token.

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { RevokedCounts } from './mas-admin.ts'

export interface AuditEntry {
  sub?: string // ausente no 401 (não há sujeito autenticado)
  // 'rotate': extensão aditiva (D1 §2.3); 'deposit'/'retrieve': custódia de sessão
  // (ADR-057 dec. 5); 'revoke-others': ADR-082 dec. 3 — mesmo idioma aditivo; formato intocado
  // 'people.*': ADR-083, sobre terceiros, com `actor` e `target`
  verb:
    | 'put'
    | 'get'
    | 'rotate'
    | 'deposit'
    | 'retrieve'
    | 'revoke-others'
    | 'people.me'
    | 'people.invite'
    | 'people.invite.partial'
    | 'people.invite.compensated'
    | 'people.remove'
    | 'agents.create' // ADR-086: mesmo regime de people.*, nunca o token nem o id da sessão
    | 'agents.create.compensated'
    | 'agents.remove'
    | 'agents.reissue'
    | 'agents.update' // nome e cor (fatia 3); nunca o nome nem o token
  outcome:
    | 'created'
    | 'conflict'
    | 'ok'
    | 'not_found'
    | 'unauthorized'
    | 'error'
    | 'rotated' // desfechos do rotate (D1 §2.3) — aditivos
    | 'stale'
    | 'missing_precondition'
    | 'exists' // desfechos da custódia (ADR-057 dec. 5) — aditivos: redepósito write-once
    | 'forbidden' // token válido sem a identidade de custódia (403, desfecho novo no serviço)
    | 'revoked' // desfechos do revoke-others (ADR-082 dec. 3) — aditivos
    | 'origin_unknown'
    | 'removed' // desfechos de people (ADR-083) — aditivos
    | 'bad_target'
    | 'completed'
    | 'reissued' // ADR-086 dec. 8 — aditivo
    | 'updated' // agents.update — aditivo
    | 'rate_limited' // agents.reissue self ≤ 1/60 s (ADR-087 dec. 9) — aditivo
  // Só contagens por tipo: nunca id de sessão, device ou token.
  revoked?: RevokedCounts
  // Só em people.*: username de quem chamou, mxid do alvo. Nunca o email.
  actor?: string
  target?: string
  kind?: 'member' | 'guest' | 'agent'
  step?: string // passo em que a operação parou
  completed?: string[] // passos que um reconvite completou
  by?: 'admin' | 'self' // agents.reissue: quem pediu
  concurrent?: true // agents.reissue: a chamada esperou o mutex do agente (ADR-087 dec. 9)
  fields?: string[] // agents.update: quais campos mudaram (nunca os valores)
  reason?: string // por que falhou (errorReason); nunca email, token ou corpo de resposta
}

export interface AuditLog {
  record(entry: AuditEntry): Promise<void>
}

export function jsonlAudit(file: string): AuditLog {
  // Simetria com o fileStore (store.ts): o diretório de destino é garantido na
  // construção (mkdir recursivo) e await-ado no primeiro record. Sem isto, o caminho
  // audit-only — o 401, que audita ANTES de qualquer toque no store (server.ts) —
  // estoura ENOENT contra um storeDir frio e vira 500 opaco. Achado do dogfood D3
  // (§8.ter). NÃO é mudança de contrato (ADR-017 intocado).
  const ready = mkdir(dirname(file), { recursive: true })
  return {
    async record(entry) {
      await ready
      // appendFile abre com O_APPEND; escritas pequenas são atômicas — offsets só crescem.
      await appendFile(file, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`)
    },
  }
}

// O motivo de uma falha para a auditoria. O fetch do Node diz só "fetch failed": o que distingue o
// serviço fora do ar está em `cause`.
export function errorReason(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  const code = err instanceof Error ? (err.cause as { code?: unknown } | undefined)?.code : undefined
  return (typeof code === 'string' ? `${message}: ${code}` : message).slice(0, 200)
}
