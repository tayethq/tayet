// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import type { MatrixClient } from 'matrix-js-sdk'
import { MatrixGateway } from '../../src/acl/internal/matrix-client'
import type { AclTelemetry, OpaqueSession } from '../../src/acl'
import { HOMESERVER, synapseReachable, whoami } from '../support/synapse'
import { freshUsers } from '../support/fresh-users'
import { mintOidcSession } from '../support/mint-oidc'
import { killSessions } from '../support/synapse-admin'
import { until } from '../support/until'
import { bootstrapSettled, type InFlightWire } from '../support/cross-signing-ready'

// ── Revogação pelo admin com client conectado (ADR-059; PLANO-RELEASE-PUBLICA §8.4 achado 1). ──
// `mas-cli manage kill-sessions` encerra a sessão OAuth2 do client conectado; o Synapse passa a
// responder 401 e o SDK conclui "sessão acabou" por um de dois braços (refresh.js):
//  - A: o SDK ainda não conhece o `expiry` do token (nenhum refresh nesta conexão) → tenta o
//    refresh → MAS responde invalid_grant → TokenRefreshLogoutError → onSessionLost (oidc.ts);
//  - B: o SDK conhece o `expiry` e faltam >= 60 s → `Logout` SEM refresh → só o evento
//    SessionLoggedOut → onSessionLost (o fix do ADR-059 D1; antes dele, silêncio).
//
// Sessão OIDC real (mat_/mar_), cunhada headless contra o MAS — o blob renovável é o que monta o
// renewer; um mct_ do freshUsers não tem refresh grant. O dev-stack sobe o access_token_ttl para
// 3600 s (infra/dev-stack/mas/config.yaml), então o expiry do braço B fica longe dos 60 s.
//
// Contagem de 401: o access log do Synapse não atribui 401 a usuário nem device (a auth falhou), e
// num run paralelo outras suítes também geram 401 — a contagem lá não é deste client. Contamos do
// lado do client, com um wrapper no fetch global (o SDK resolve `globalThis.fetch` por request,
// fetch.js:49-52; o refresh do oidc-client-ts também), na janela do kill até o fim do disconnect.
//
// O disconnect é PARTE do assert, não do teardown: matar sessão com client conectado no teardown
// era o storm do PLANO-GATES §8.10. O afterEach só existe para o caminho de FALHA (assert estourou
// antes do disconnect) — nunca roda kill.

const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const MAS_URL = process.env.TAYET_MAS_URL ?? 'http://localhost:8080'
const CLIENT_ID = process.env.TAYET_SPA_CLIENT_ID ?? '000000000000000000000TAYET'
// Mesma senha do registerUser (escrow-harness.ts) que o freshUsers usa.
const PASSWORD = 'gatepass123'
// Teto de 401 na janela kill → fim do disconnect, client ocioso (§8.6, errata do §0/§8.4: 2 → 3).
// Medido 6/6: a deleção do device pelo SyncDevicesJob é um evento de sync do próprio usuário (a
// device list mudou) e devolve o long-poll em voo com 200; o crypto dispara keys/upload + keys/query
// em paralelo ao /sync seguinte, e os três batem no device já apagado — um 401 cada, zero retry
// (o Logout não repete a request, fetch.js:153-158). Acima disso é storm.
const N_401_MAX = 3

// Blob no formato do oidc.ts (kind 'oidc'); o issuer é o do MAS do dev-stack.
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

interface Wire extends InFlightWire {
  after: number
  status401: number
  tokenCalls: number
  /** Requests autenticadas em voo que NÃO são o long-poll do /sync (o k do N_401 = 1 + k, §8.4). */
  busy: Set<string>
  /** Último início/fim de request rastreada (mesmo critério do `busy`) — a janela de quietude. */
  lastActivity: number
  /** O fetch real, por baixo do wrapper: a sonda do bootstrapSettled não conta como atividade. */
  raw: typeof fetch
}

// Observa o fetch global sem alterá-lo. `after` marca o instante do kill: só conta o que sai depois.
function watchFetch(): { wire: Wire; restore: () => void } {
  const real = globalThis.fetch
  const wire: Wire = {
    after: Number.POSITIVE_INFINITY,
    status401: 0,
    tokenCalls: 0,
    busy: new Set(),
    lastActivity: Date.now(),
    raw: real,
  }
  let seq = 0
  globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
    const url = typeof args[0] === 'string' ? args[0] : args[0] instanceof URL ? args[0].href : args[0].url
    const counting = Date.now() >= wire.after
    if (counting && url.includes('/oauth2/token')) wire.tokenCalls++
    const path = url.replace(HOMESERVER, '').split('?')[0] ?? ''
    const key = `${seq++} ${path}`
    const tracked = url.startsWith(HOMESERVER) && !path.endsWith('/sync')
    if (tracked) {
      wire.busy.add(key)
      wire.lastActivity = Date.now()
    }
    try {
      const res = await real(...args)
      if (counting && res.status === 401 && url.startsWith(HOMESERVER)) {
        wire.status401++
        console.info(`[2b-fix] 401 +${Date.now() - wire.after}ms ${path}`)
      }
      return res
    } finally {
      if (tracked) {
        wire.busy.delete(key)
        wire.lastActivity = Date.now()
      }
    }
  }
  return { wire, restore: () => (globalThis.fetch = real) }
}

describe.skipIf(!SYNAPSE)('revogação pelo admin alcança onSessionLost nos dois braços (ADR-059)', () => {
  let gw: MatrixGateway | undefined
  let restore: (() => void) | undefined

  afterEach(async () => {
    // Caminho de falha apenas: o corpo do teste já desconectou no caminho feliz.
    await gw?.disconnect().catch(() => {})
    gw = undefined
    restore?.()
    restore = undefined
  })

  async function connected(prefix: string) {
    const [u] = await freshUsers([prefix])
    const session = await mintOidcSession(u.name, PASSWORD)
    const watch = watchFetch()
    restore = watch.restore
    const lost: number[] = []
    gw = new MatrixGateway({
      mode: 'strict',
      telemetry: noopTelemetry,
      serverUrl: HOMESERVER,
      onSessionLost: () => lost.push(Date.now()),
    })
    await gw.connect(oidcBlob(session))
    const mxid = await whoami(session.accessToken)
    return { name: u.name, mxid, token: session.accessToken, wire: watch.wire, lost, gateway: gw }
  }

  // N_401_MAX vale para o client OCIOSO (PLANO-RELEASE-PUBLICA §8.6, errata do §8.4): logo após o
  // connect, o join do canal da org e keys/upload/keys/query ainda estão em voo e cada um levaria um
  // 401 a mais. Esperar o ocioso — e, antes, o bootstrap de chaves assentado no servidor (§8.99) — é a
  // condição do critério, não um afrouxamento dele: `bootstrapSettled` em ../support/cross-signing-ready.

  it('braço A — sem refresh prévio: invalid_grant no refresh → onSessionLost; 401 na janela ≤ N_401_MAX', async () => {
    const { name, mxid, token, wire, lost, gateway } = await connected('rva')

    await bootstrapSettled(wire, token, mxid, 'arm A')
    wire.after = Date.now()
    killSessions(name)
    await until('arm A: onSessionLost', () => (lost.length > 0 ? true : undefined))
    const t = (lost[0] ?? 0) - wire.after
    await gateway.disconnect()
    gw = undefined

    // O braço A passa pelo refresh (é o emissor por TokenRefreshLogoutError).
    expect(wire.tokenCalls).toBeGreaterThanOrEqual(1)
    expect(wire.status401).toBeLessThanOrEqual(N_401_MAX)
    console.info(`[2b-fix] arm A: T=${t}ms 401=${wire.status401} token=${wire.tokenCalls}`)
  })

  it('braço B — expiry conhecido: Logout sem refresh → evento → onSessionLost; zero /oauth2/token', async () => {
    const { name, mxid, wire, lost, gateway } = await connected('rvb')

    // Refresh REAL para o SDK ganhar o `expiry` (refresh.js:153). Determinístico: o handler de
    // M_UNKNOWN_TOKEN do TokenRefresher sem snapshot cai direto no doTokenRefresh (refresh.js:111-114),
    // o mesmo caminho que um 401 de token vencido percorre. Campo interno do SDK, só neste teste —
    // esperar um refresh natural exigiria esperar o TTL de 3600 s do dev-stack.
    const sdk = (gateway as unknown as { client: MatrixClient }).client
    const http = sdk.http as unknown as {
      tokenRefresher: { handleUnknownToken: (snapshot?: unknown, attempt?: number) => Promise<string> }
    }
    expect(await http.tokenRefresher.handleUnknownToken(undefined, 1)).toBe('success')

    // A sonda lê com o token renovado (o que o SDK usa agora), não com o cunhado antes do refresh.
    await bootstrapSettled(wire, sdk.getAccessToken() ?? '', mxid, 'arm B')
    wire.after = Date.now()
    killSessions(name)
    await until('arm B: onSessionLost', () => (lost.length > 0 ? true : undefined))
    const t = (lost[0] ?? 0) - wire.after
    await gateway.disconnect()
    gw = undefined

    // O emissor foi o evento: nenhuma tentativa de refresh depois do kill.
    expect(wire.tokenCalls).toBe(0)
    expect(wire.status401).toBeLessThanOrEqual(N_401_MAX)
    console.info(`[2b-fix] arm B: T=${t}ms 401=${wire.status401} token=${wire.tokenCalls}`)
  })
})
