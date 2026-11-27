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
  verb:
    | 'put'
    | 'get'
    | 'rotate'
    | 'deposit'
    | 'retrieve'
    | 'revoke-others'
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
  // Só contagens por tipo: nunca id de sessão, device ou token.
  revoked?: RevokedCounts
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

