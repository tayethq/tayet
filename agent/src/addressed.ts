// Extração do conjunto de endereçados a partir do `state` de GET /context/{eventId}
// (estado da sala NAQUELE evento — com limit=0 é exatamente o snapshot do nascimento
// da sessão, F5/F7 opção C). O critério é o do fan-out provado no spike C1
// (room.js getEncryptionTargetMembers): membros `join` + `invite` — leave/ban/knock
// ficam fora. A chave de endereçamento é o LOCALPART (contrato do PUT /v1/sessions da
// PR-2: mxid com `@`/`:` é 400), estável no diretório Tayet.
//
// Shape defensivo de propósito: o response vem do homeserver e o depósito é a rede de
// cobertura — entrada estranha é ignorada, nunca inferida.

const MEMBERSHIP_IN = new Set(['join', 'invite'])

export function addressedOf(state: unknown): string[] {
  if (!Array.isArray(state)) return []
  const out = new Set<string>()
  for (const ev of state) {
    if (typeof ev !== 'object' || ev === null) continue
    const { type, state_key, content } = ev as {
      type?: unknown
      state_key?: unknown
      content?: unknown
    }
    if (type !== 'm.room.member') continue
    if (typeof state_key !== 'string' || !state_key.startsWith('@')) continue
    if (typeof content !== 'object' || content === null) continue
    const membership = (content as { membership?: unknown }).membership
    if (typeof membership !== 'string' || !MEMBERSHIP_IN.has(membership)) continue
    const colon = state_key.indexOf(':')
    const localpart = colon === -1 ? state_key.slice(1) : state_key.slice(1, colon)
    if (localpart.length === 0) continue
    out.add(localpart)
  }
  return [...out].sort()
}
