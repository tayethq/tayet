import { HOMESERVER } from './synapse'
import { until } from './until'

// Readiness of a freshly connected client's key bootstrap, read from the SERVER (issue #7;
// PLANO-RELEASE-PUBLICA §8.99, §8.101). Shared by acl-session-revoked (kill only after the
// bootstrap) and reset-approval-probe (probe only after it).

/** Requests in flight, observed on the global fetch (the SDK resolves `globalThis.fetch` per request). */
export interface InFlightWire {
  busy: Set<string>
  /** Last start/end of a tracked request — the quiet window. */
  lastActivity: number
  /** The real fetch, under the wrapper: the readiness probes do not count as activity. */
  raw: typeof fetch
}

// Watches the global fetch without changing it: every homeserver request except the /sync long-poll.
export function watchInFlight(): { wire: InFlightWire; restore: () => void } {
  const real = globalThis.fetch
  const wire: InFlightWire = { busy: new Set(), lastActivity: Date.now(), raw: real }
  let seq = 0
  globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
    const url = typeof args[0] === 'string' ? args[0] : args[0] instanceof URL ? args[0].href : args[0].url
    const path = url.replace(HOMESERVER, '').split('?')[0] ?? ''
    const key = `${seq++} ${path}`
    const tracked = url.startsWith(HOMESERVER) && !path.endsWith('/sync')
    if (tracked) {
      wire.busy.add(key)
      wire.lastActivity = Date.now()
    }
    try {
      return await real(...args)
    } finally {
      if (tracked) {
        wire.busy.delete(key)
        wire.lastActivity = Date.now()
      }
    }
  }
  return { wire, restore: () => (globalThis.fetch = real) }
}

// The user's master cross-signing key as the server holds it (`keys/query`, own token), or
// undefined while there is none.
export async function masterKeyOnServer(
  token: string,
  mxid: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ keys?: Record<string, string> } | undefined> {
  const res = await fetchImpl(`${HOMESERVER}/_matrix/client/v3/keys/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_keys: { [mxid]: [] } }),
  })
  if (!res.ok) return undefined
  const body = (await res.json()) as { master_keys?: Record<string, { keys?: Record<string, string> }> }
  return body.master_keys?.[mxid]
}

// Whether the server already holds the user's master key. The local crypto reports its public keys
// before the upload lands, and Synapse only puts the replacement behind the approval once a master
// key exists (synapse/rest/client/keys.py:542).
export async function crossSigningOnServer(token: string, mxid: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  return (await masterKeyOnServer(token, mxid, fetchImpl)) !== undefined
}

// Idle = only the /sync long-poll in flight. `quietMs` > 0 also requires no tracked activity in
// that window (see bootstrapSettled).
export async function idle(wire: InFlightWire, label: string, quietMs = 0): Promise<void> {
  await until(
    `${label}: client ocioso${quietMs > 0 ? ` e quieto ${quietMs} ms` : ''}`,
    () => (wire.busy.size === 0 && Date.now() - wire.lastActivity >= quietMs ? true : undefined),
    { snapshot: () => `busy=[${[...wire.busy].join(', ')}] quiet=${Date.now() - wire.lastActivity}ms` },
  )
}

// idle() alone has a hole (issue #7; PLANO-RELEASE-PUBLICA §8.99): the key bootstrap of a fresh
// client is a SEQUENCE of one-at-a-time writes — device_signing/upload, signatures/upload, PUT
// account_data m.secret_storage.key.<id> → m.secret_storage.default_key → m.cross_signing.master →
// .user_signing → .self_signing, POST room_keys/version, m.megolm_backup.v1, GET room_keys/version —
// with ~5–7 ms of empty `busy` between one step and the next. A 120 ms poll can land in one of those
// gaps. Bootstrap finished = the server, read with the user's own token, already has
// m.cross_signing.user_signing AND the last measured write (m.megolm_backup.v1); and, after that,
// `busy` empty WITHOUT activity for QUIET_MS. The quiet window covers the GET room_keys/version that
// closes resetKeyBackup ~3 ms after the write (measured 1/10 locally). QUIET_MS ≫ the ~5–7 ms gaps.
export async function bootstrapSettled(wire: InFlightWire, token: string, mxid: string, label: string): Promise<void> {
  const QUIET_MS = 250
  const has = async (type: string) => {
    const res = await wire.raw(
      `${HOMESERVER}/_matrix/client/v3/user/${encodeURIComponent(mxid)}/account_data/${type}`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    return res.status
  }
  const last: Record<string, number> = {}
  await until(
    `${label}: bootstrap de cross-signing assentado`,
    async () => {
      for (const type of ['m.cross_signing.user_signing', 'm.megolm_backup.v1']) last[type] = await has(type)
      return Object.values(last).every((s) => s === 200) ? true : undefined
    },
    { snapshot: () => `${JSON.stringify(last)} busy=[${[...wire.busy].join(', ')}]` },
  )
  await idle(wire, label, QUIET_MS)
}
