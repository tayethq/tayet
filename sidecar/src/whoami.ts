// whoami at boot, before the store is touched (§0.3.5 adj. 10): who the credential is, and its device.
// A refusal here (401/403 only) is the boot case of adj. 6/7 — exit 78 with no wipe and no sentinel: the token
// may simply be mistyped while the store's device is alive.
import { fetchSettled, type RetryOptions } from './http'

export type Whoami =
  | { kind: 'ok'; userId: string; deviceId: string }
  | { kind: 'refused'; status: number; errcode: string | undefined }
  | { kind: 'no-device'; userId: string }
  // Any other definitive answer (non-2xx but 401/403, unreadable body, 200 without a user_id string):
  // the discovered server does not answer as a homeserver should. A server problem, never a reason to
  // reissue a credential that may be valid (rodada 2 do #333).
  | { kind: 'bad-server'; status: number }

// Reserved agent localpart (ADR-086 dec. 1): `a-` + 12 of the base32 alphabet. Same pattern as
// escrow/src/mas-admin.ts AGENT_LOCALPART (copied: packages import nothing from each other).
export const AGENT_LOCALPART = /^a-[a-z2-7]{12}$/

export function localpartOf(userId: string): string {
  const colon = userId.indexOf(':')
  return userId.slice(1, colon === -1 ? undefined : colon)
}

export async function whoami(server: string, token: string, opts: RetryOptions): Promise<Whoami> {
  const res = await fetchSettled(
    `${server}/_matrix/client/v3/account/whoami`,
    { headers: { Authorization: `Bearer ${token}` } },
    opts,
  )
  if (res.status === 401 || res.status === 403) {
    const body = (await res.json().catch(() => ({}))) as { errcode?: unknown }
    return { kind: 'refused', status: res.status, errcode: typeof body.errcode === 'string' ? body.errcode : undefined }
  }
  if (!res.ok) return { kind: 'bad-server', status: res.status }
  const body = (await res.json().catch(() => null)) as { user_id?: unknown; device_id?: unknown } | null
  if (body === null || typeof body !== 'object' || typeof body.user_id !== 'string') {
    return { kind: 'bad-server', status: res.status }
  }
  if (typeof body.device_id !== 'string') return { kind: 'no-device', userId: body.user_id }
  return { kind: 'ok', userId: body.user_id, deviceId: body.device_id }
}
