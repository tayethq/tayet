// @vitest-environment jsdom
import { describe, it, expect, afterEach, afterAll } from 'vitest'
import type { MatrixClient } from 'matrix-js-sdk'
import { MatrixGateway, REVOKE_BOUND_MS } from '../../src/acl/internal/matrix-client'
import type { AclTelemetry, OpaqueSession } from '../../src/acl'
import { HOMESERVER, synapseReachable } from '../support/synapse'
import { freshUsers } from '../support/fresh-users'
import { mintOidcSession } from '../support/mint-oidc'
import { adminScopeReachable, killSessions, mintAdminToken, PROBE_USER } from '../support/synapse-admin'
import { until } from '../support/until'

// ── Sair revoga no emissor (ADR-062 D1; PLANO-RELEASE-PUBLICA §8.22). ────────────────────────────────
// O signOut revoga os tokens desta sessão no MAS por RFC 7009 (revocation_endpoint dos metadados)
// antes do wipe local. Provas:
//  - o refresh token antigo é recusado pelo MAS (invalid_grant) e o device some do Synapse (o MAS
//    encerra a sessão e o SyncDevicesJob apaga o device — assíncrono, daí o until);
//  - emissor inalcançável (rejeita) ou pendurado (nunca responde): o signOut resolve dentro do
//    bound e o wipe local acontece mesmo assim;
//  - sessão PERDIDA (ADR-059 D2): o signOut que o Boot dispara depois do onSessionLost não faz
//    nenhuma request de descoberta nem de revogação.
//
// Sessão OIDC real (mat_/mar_) cunhada headless, mesmo regime de acl-session-revoked: um mct_ do
// freshUsers não tem client OAuth nem refresh grant a revogar.

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

const urlOf = (input: Parameters<typeof fetch>[0]): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
const isRevoke = (url: string): boolean => url.split('?')[0]!.endsWith('/oauth2/revoke')
const isDiscovery = (url: string): boolean => url.includes('/auth_metadata') || url.includes('openid-configuration')

// Intercepta o fetch global: `mode` decide o destino das chamadas ao revocation_endpoint; todas as
// chamadas de descoberta/revogação a partir de `after` são contadas.
function interceptRevoke(mode: 'pass' | 'reject' | 'hang') {
  const seen = { after: Number.POSITIVE_INFINITY, revoke: 0, discovery: 0 }
  const real = globalThis.fetch
  globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
    const url = urlOf(args[0])
    if (Date.now() >= seen.after) {
      if (isRevoke(url)) seen.revoke++
      if (isDiscovery(url)) seen.discovery++
    }
    if (isRevoke(url) && mode === 'reject') throw new TypeError('fetch failed')
    if (isRevoke(url) && mode === 'hang') return new Promise<Response>(() => {})
    return real(...args)
  }
  return { seen, restore: () => (globalThis.fetch = real) }
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

async function deviceIds(adminToken: string, userId: string): Promise<string[]> {
  const res = await fetch(`${HOMESERVER}/_synapse/admin/v2/users/${encodeURIComponent(userId)}/devices`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  })
  if (!res.ok) throw new Error(`admin devices -> ${res.status}`)
  const body = (await res.json()) as { devices: Array<{ device_id: string }> }
  return body.devices.map((d) => d.device_id)
}

// Conta as chamadas a clearStores do client conectado (o wipe local). O SDK não expõe outro sinal
// em Node: o store do rust é de memória e o wipe dele é no-op aqui.
function spyWipe(gw: MatrixGateway): { calls: number } {
  const client = (gw as unknown as { client: MatrixClient }).client
  const spy = { calls: 0 }
  const real = client.clearStores.bind(client)
  client.clearStores = ((...a: Parameters<MatrixClient['clearStores']>) => {
    spy.calls++
    return real(...a)
  }) as MatrixClient['clearStores']
  return spy
}

describe.skipIf(!SYNAPSE)('signOut revoga a sessão no emissor (ADR-062 D1)', () => {
  const names: string[] = []
  let restore: (() => void) | undefined
  let gw: MatrixGateway | undefined

  afterEach(async () => {
    await gw?.disconnect().catch(() => {})
    gw = undefined
    restore?.()
    restore = undefined
  })
  afterAll(() => {
    for (const n of names) killSessions(n)
    if (ADMIN) killSessions(PROBE_USER)
  })

  async function connected(prefix: string, mode: 'pass' | 'reject' | 'hang', onSessionLost?: () => void) {
    const [u] = await freshUsers([prefix])
    names.push(u.name)
    const session = await mintOidcSession(u.name, PASSWORD)
    const icpt = interceptRevoke(mode)
    restore = icpt.restore
    gw = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER, onSessionLost })
    await gw.connect(oidcBlob(session))
    const userId = (gw as unknown as { client: MatrixClient }).client.getUserId()!
    return { name: u.name, userId, session, seen: icpt.seen, gateway: gw }
  }

  it.skipIf(!ADMIN)('após signOut: refresh antigo → invalid_grant e o device some do Synapse', async () => {
    const { userId, session, seen, gateway } = await connected('sor', 'pass')
    const admin = mintAdminToken(PROBE_USER)
    expect(await deviceIds(admin, userId)).toContain(session.deviceId)

    seen.after = Date.now()
    await gateway.signOut()
    gw = undefined
    expect(seen.revoke).toBe(2) // refresh_token + access_token

    const refreshed = await refreshWith(session.refreshToken)
    expect(refreshed.status).toBe(400)
    expect(refreshed.error).toBe('invalid_grant')
    await until('device apagado do Synapse', async () =>
      (await deviceIds(admin, userId)).includes(session.deviceId) ? undefined : true,
    )
  })

  it('emissor inalcançável (fetch rejeita) → signOut resolve e o wipe local acontece', async () => {
    const { seen, gateway } = await connected('sox', 'reject')
    const wipe = spyWipe(gateway)
    seen.after = Date.now()
    const t0 = Date.now()
    await gateway.signOut()
    gw = undefined
    expect(Date.now() - t0).toBeLessThan(REVOKE_BOUND_MS)
    expect(seen.revoke).toBeGreaterThanOrEqual(1)
    expect(wipe.calls).toBe(1)
  })

  it('emissor pendurado (nunca responde) → signOut resolve no bound e o wipe local acontece', async () => {
    const { seen, gateway } = await connected('soh', 'hang')
    const wipe = spyWipe(gateway)
    seen.after = Date.now()
    const t0 = Date.now()
    await gateway.signOut()
    gw = undefined
    const took = Date.now() - t0
    expect(took).toBeGreaterThanOrEqual(REVOKE_BOUND_MS - 50)
    expect(took).toBeLessThan(REVOKE_BOUND_MS + 1_500)
    expect(seen.revoke).toBeGreaterThanOrEqual(1)
    expect(wipe.calls).toBe(1)
  })

  it('sessão perdida (o caminho revoked→signOut do Boot) → nenhuma descoberta nem revogação', async () => {
    const lost: number[] = []
    const { name, seen, gateway } = await connected('sol', 'pass', () => lost.push(Date.now()))
    killSessions(name)
    await until('onSessionLost', () => (lost.length > 0 ? true : undefined))
    seen.after = Date.now()
    await gateway.signOut()
    gw = undefined
    expect(seen.discovery).toBe(0)
    expect(seen.revoke).toBe(0)
  })
})
