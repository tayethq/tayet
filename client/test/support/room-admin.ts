import { HOMESERVER } from './synapse'
import { killSessions, mintAdminToken, PROBE_USER } from './synapse-admin'

// Browser E2E tier hygiene (PLANO-RELEASE-PUBLICA §8.24): a spec deletes, before its first login, the
// rooms it creates itself. The tier users are reused across local runs; a room that survives carries
// the Megolm history of earlier runs, and every new device of the next run asks the key backup for
// those old sessions (room_keys 404) before any window of the console ledger expects it. With the room
// gone, the dev-stack needs no reset between E2E runs.
//
// Synapse admin "Delete Room" version 1 (DELETE /_synapse/admin/v1/rooms/{roomId}): blocks until the
// room is deleted; `purge: true` drops its history from the database too. Token: the fixed probe
// account's ephemeral admin token (synapse-admin.ts), never a token of a user under test.
export async function deleteRoom(roomId: string): Promise<void> {
  const token = mintAdminToken(PROBE_USER)
  try {
    const res = await fetch(`${HOMESERVER}/_synapse/admin/v1/rooms/${encodeURIComponent(roomId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ purge: true }),
    })
    if (!res.ok) throw new Error(`admin DELETE room -> ${res.status} ${await res.text()}`)
  } finally {
    killSessions(PROBE_USER)
  }
}
