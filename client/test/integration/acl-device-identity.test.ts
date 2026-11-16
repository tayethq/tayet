// @vitest-environment jsdom
import { describe, it, expect, afterAll } from 'vitest'
import type { MatrixClient } from 'matrix-js-sdk'
import { MatrixGateway } from '../../src/acl/internal/matrix-client'
import { SessionExpiredError, type AclTelemetry, type OpaqueSession } from '../../src/acl'
import { HOMESERVER, synapseReachable } from '../support/synapse'
import { freshUsers } from '../support/fresh-users'
import { mintOidcSession } from '../support/mint-oidc'
import { adminScopeReachable, killSessions, mintAdminToken, PROBE_USER } from '../support/synapse-admin'
import { until } from '../support/until'

// ── Identidade de device = conta Olm (ADR-062 D2; PLANO-RELEASE-PUBLICA §8.22). ─────────────────────
// O `eIrA0ZrBoZ` do dogfood: store de cripto apagado, sessão preservada → o rust-crypto cria conta
// Olm nova sob o MESMO device id, o Synapse aceita as device keys novas e recusa as OTKs (ids já
// usados pela conta velha) → todo claim dá InvalidSignature, para sempre.
//
// Regime de Node: sem IndexedDB o crypto store é de memória (matrix-client.ts, cryptoStoreOpts) e
// morre com o client. Um segundo connect com a MESMA sessão É, portanto, o wipe parcial da ADR-059
// (store sem conta, sessão viva) — o mesmo estado do browser do `eIrA0ZrBoZ`. O `clearStores()` do
// primeiro client abaixo documenta o passo (no-op para o store de memória do rust). O caminho
// "store íntegro" não sobrevive a um reconnect em Node; ele é exercido na conexão viva: a checagem
// roda de novo contra o servidor real com a MESMA conta Olm → segue, sem upload de device keys.
//
// Sessão OIDC real (mat_/mar_) cunhada headless, mesmo regime de acl-sign-out-revoke: no ramo
// divergente a sessão é revogada no emissor antes do wipe, e um mct_ não tem client OAuth a revogar.

const SYNAPSE = synapseReachable()
const ADMIN = SYNAPSE && adminScopeReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const MAS_URL = process.env.TAYET_MAS_URL ?? 'http://localhost:8080'
const CLIENT_ID = process.env.TAYET_SPA_CLIENT_ID ?? '000000000000000000000TAYET'
// Mesma senha do registerUser (escrow-harness.ts) que o freshUsers usa.
const PASSWORD = 'gatepass123'

function oidcBlob(s: { accessToken: string; refreshToken: string }): OpaqueSession {
  return JSON.stringify({
    kind: 'oidc',
    accessToken: s.accessToken,
    refreshToken: s.refreshToken,
    issuer: `${MAS_URL.replace(/\/$/, '')}/`,
    clientId: CLIENT_ID,
    homeserverUrl: HOMESERVER,
    idTokenClaims: {},
  }) as unknown as OpaqueSession
}

// Conta, por fase, os POST /keys/upload (separando os que carregam device_keys — identidade — dos que
// só sobem OTKs) e as chamadas ao revocation_endpoint. O SDK resolve `globalThis.fetch` por request
// (fetch.js), e o revokeSessionTokens usa o fetch global, então o wrapper vê tudo.
interface Wire {
  phase: string
  deviceKeys: Record<string, number>
  uploads: Record<string, number>
  revokes: Record<string, number>
}
function watchWire(): { wire: Wire; restore: () => void } {
  const wire: Wire = { phase: 'first', deviceKeys: {}, uploads: {}, revokes: {} }
  const bump = (m: Record<string, number>): void => {
    m[wire.phase] = (m[wire.phase] ?? 0) + 1
  }
  const real = globalThis.fetch
  globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
    const url = typeof args[0] === 'string' ? args[0] : args[0] instanceof URL ? args[0].href : args[0].url
    const path = url.split('?')[0]!
    if (path.endsWith('/oauth2/revoke')) bump(wire.revokes)
    if (url.startsWith(HOMESERVER) && path.endsWith('/keys/upload')) {
      bump(wire.uploads)
      const body = typeof args[1]?.body === 'string' ? (JSON.parse(args[1].body) as { device_keys?: unknown }) : {}
      if (body.device_keys) bump(wire.deviceKeys)
    }
    return real(...args)
  }
  return { wire, restore: () => (globalThis.fetch = real) }
}

// A ed25519 que o servidor publica para o device, lida pela admin API (o token do usuário morre na
// revogação do ramo divergente).
async function serverEd25519(adminToken: string, userId: string, deviceId: string): Promise<string | undefined> {
  const res = await fetch(`${HOMESERVER}/_matrix/client/v3/keys/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_keys: { [userId]: [] } }),
  })
  if (!res.ok) throw new Error(`keys/query -> ${res.status}`)
  const body = (await res.json()) as {
    device_keys?: Record<string, Record<string, { keys?: Record<string, string> }>>
  }
  return body.device_keys?.[userId]?.[deviceId]?.keys?.[`ed25519:${deviceId}`]
}

async function deviceIds(adminToken: string, userId: string): Promise<string[]> {
  const res = await fetch(`${HOMESERVER}/_synapse/admin/v2/users/${encodeURIComponent(userId)}/devices`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  })
  if (!res.ok) throw new Error(`admin devices -> ${res.status}`)
  const body = (await res.json()) as { devices: Array<{ device_id: string }> }
  return body.devices.map((d) => d.device_id)
}

async function refreshWith(refreshToken: string): Promise<{ status: number; error?: string }> {
  const res = await fetch(`${MAS_URL}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID }),
  })
  const body = (await res.json().catch(() => ({}))) as { error?: string }
  return { status: res.status, error: body.error }
}

describe.skipIf(!SYNAPSE)('identidade de device no boot (ADR-062 D2)', () => {
  const names: string[] = []
  afterAll(() => {
    for (const n of names) killSessions(n)
    if (ADMIN) killSessions(PROBE_USER)
  })

  it.skipIf(!ADMIN)(
    'store apagado com a sessão preservada → SessionExpiredError, zero upload, sessão revogada e device fora do Synapse',
    async () => {
      const [u] = await freshUsers(['did'])
      names.push(u.name)
      const session = await mintOidcSession(u.name, PASSWORD)
      const blob = oidcBlob(session)
      const deviceId = session.deviceId
      const admin = mintAdminToken(PROBE_USER)
      const { wire, restore } = watchWire()
      try {
        // 1º connect: servidor sem chaves para o device → device novo, segue e publica a identidade.
        const gw1 = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
        await gw1.connect(blob)
        const client = (gw1 as unknown as { client: MatrixClient }).client
        const userId = client.getUserId()!
        await until('identidade publicada', () => serverEd25519(admin, userId, deviceId))
        expect(wire.deviceKeys.first ?? 0).toBeGreaterThanOrEqual(1)

        // Store íntegro (mesma conta Olm, conexão viva): a checagem contra o servidor real segue e
        // nada é reenviado.
        wire.phase = 'intact'
        const check = (
          gw1 as unknown as { assertDeviceIdentity: (c: MatrixClient, u: string, d: string) => Promise<void> }
        ).assertDeviceIdentity.bind(gw1)
        await expect(check(client, userId, deviceId)).resolves.toBeUndefined()
        expect(wire.deviceKeys.intact ?? 0).toBe(0)

        // Sem chaves no servidor (1º connect) e iguais (acima): nenhuma revogação.
        expect(wire.revokes.first ?? 0).toBe(0)
        expect(wire.revokes.intact ?? 0).toBe(0)

        // Wipe parcial: para o client e apaga o store, a sessão (o blob) fica.
        await gw1.disconnect()
        await client.clearStores()

        // 2º connect com a mesma sessão e store sem conta → identidade divergente → device novo.
        wire.phase = 'wiped'
        const gw2 = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
        await expect(gw2.connect(blob)).rejects.toBeInstanceOf(SessionExpiredError)
        await gw2.disconnect().catch(() => {})

        // Nada saiu sob o device id com identidade trocada: nem device keys, nem OTKs.
        expect(wire.deviceKeys.wiped ?? 0).toBe(0)
        expect(wire.uploads.wiped ?? 0).toBe(0)

        // A sessão divergente foi revogada no emissor: refresh e access token, o refresh antigo é
        // recusado e o MAS apagou o device no Synapse (SyncDevicesJob, assíncrono).
        expect(wire.revokes.wiped).toBe(2)
        const refreshed = await refreshWith(session.refreshToken)
        expect(refreshed.status).toBe(400)
        expect(refreshed.error).toBe('invalid_grant')
        await until('device apagado do Synapse', async () =>
          (await deviceIds(admin, userId)).includes(deviceId) ? undefined : true,
        )
      } finally {
        restore()
      }
    },
  )
})
