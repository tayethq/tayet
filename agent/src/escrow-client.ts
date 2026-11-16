// Depositante da capability de custódia do escrow (contrato da PR-2, consumido — nunca
// alterado): PUT /v1/sessions com o corpo allowlist { room_id, session_id, addressed,
// session }. 201 created e 200 exists são AMBOS sucesso (write-once idempotente do
// escrow); qualquer outro status vira erro para o retry do loop. O erro carrega só o
// status — nunca corpo de resposta nem material (disciplina de log do escrow).

import type { SessionExportEntry } from './custody-loop.ts'

export function escrowDepositor(
  baseUrl: string,
  token: string,
): (entry: SessionExportEntry, addressed: string[]) => Promise<'created' | 'exists'> {
  return async (entry, addressed) => {
    const res = await fetch(`${baseUrl}/v1/sessions`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        room_id: entry.room_id,
        session_id: entry.session_id,
        addressed,
        session: entry,
      }),
    })
    if (res.status === 201) return 'created'
    if (res.status === 200) return 'exists'
    throw new Error(`escrow deposit -> ${res.status}`)
  }
}
