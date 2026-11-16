// Has this device already published keys? (PLANO-AGENTES §0.3.14 item 7.) Asked at boot when the store
// has no marker, BEFORE initRustCrypto and before any upload, with the token of the run:
// `POST /_matrix/client/v3/keys/query` for the agent's own user, naming its own device.
//
// - no keys for the device: a legitimate 1st boot (the escrow's mint uploads no keys) → go on;
// - keys published: the whole store was lost while the device lives — proceeding would upload new keys
//   for a device the server already knows (OTK 400, the server serving dead OTKs: the zombie of the
//   custody agent's A1) → a self-reissue trigger.
//
// Network errors, 5xx and 429 retry until the deadline (fetchSettled) and end in UnavailableError (69,
// like the other boot requests). Nothing here logs: no id, no key, no body.
import { fetchSettled, type RetryOptions } from './http'

export type DeviceKeys =
  | { kind: 'none' }
  | { kind: 'published' }
  | { kind: 'refused'; status: number }
  | { kind: 'bad-server'; status: number }

export async function deviceKeysPublished(
  server: string,
  token: string,
  identity: { userId: string; deviceId: string },
  opts: RetryOptions,
): Promise<DeviceKeys> {
  const res = await fetchSettled(
    `${server}/_matrix/client/v3/keys/query`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_keys: { [identity.userId]: [identity.deviceId] } }),
    },
    opts,
  )
  if (res.status === 401 || res.status === 403) return { kind: 'refused', status: res.status }
  if (!res.ok) return { kind: 'bad-server', status: res.status }
  const body = (await res.json().catch(() => null)) as { device_keys?: unknown } | null
  if (body === null || typeof body !== 'object' || body.device_keys === null || typeof body.device_keys !== 'object') {
    return { kind: 'bad-server', status: res.status }
  }
  const mine = (body.device_keys as Record<string, unknown>)[identity.userId]
  const device = mine !== null && typeof mine === 'object' ? (mine as Record<string, unknown>)[identity.deviceId] : undefined
  return device !== null && typeof device === 'object' ? { kind: 'published' } : { kind: 'none' }
}
