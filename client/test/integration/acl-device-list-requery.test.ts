// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost:5173/"}
import { describe, it, expect, afterEach } from 'vitest'
import { MatrixGateway } from '../../src/acl/internal/matrix-client'
import type { AclTelemetry, ChannelId, OpaqueSession } from '../../src/acl'
import { HOMESERVER, synapseReachable, whoami, invite, join, sendText } from '../support/synapse'
import { freshUsers } from '../support/fresh-users'
import { mintOidcSession } from '../support/mint-oidc'
import { until } from '../support/until'

// PLANO-RELEASE-PUBLICA §8.24 — mitigação defensiva, no rust-crypto real: depois de um refresh de token
// bem-sucedido, a ACL marca todos os usuários rastreados como desatualizados, e o PRÓXIMO envio cifrado
// faz keys/query (com o par) antes de compartilhar a chave da sala. Sem a mitigação, nada muda na lista
// do par entre o refresh e o envio, e nenhum keys/query sai nessa janela.
//
// alice é uma sessão OIDC real (mat_/mar_, cunhada headless — idioma de acl-media/acl-session-revoked):
// o refresh é um round-trip real ao /oauth2/token do MAS, disparado por UM 401 sintético na próxima
// request autenticada dela (wrapper de fetch; o SDK resolve globalThis.fetch por request). bob é um
// cliente de token compat (mct_): os bearers separam o tráfego dos dois no mesmo processo.

const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const MAS_URL = process.env.TAYET_MAS_URL ?? 'http://localhost:8080'
const CLIENT_ID = process.env.TAYET_SPA_CLIENT_ID ?? '000000000000000000000TAYET'
const PASSWORD = 'gatepass123' // registerUser (escrow-harness.ts), usado pelo freshUsers

describe.skipIf(!SYNAPSE)('§8.24 — re-query das listas de devices após refresh (integração)', () => {
  const realFetch = globalThis.fetch
  let alice: MatrixGateway | undefined
  let bob: MatrixGateway | undefined

  afterEach(async () => {
    globalThis.fetch = realFetch
    await alice?.disconnect()
    await bob?.disconnect()
  })

  it('após um refresh, o próximo envio cifrado faz keys/query com o par antes de compartilhar', async () => {
    const [a, b] = await freshUsers(['dlq', 'dlr'])
    const session = await mintOidcSession(a!.name, PASSWORD)
    alice = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await alice.connect(
      JSON.stringify({
        kind: 'oidc',
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        issuer: `${MAS_URL.replace(/\/$/, '')}/`,
        clientId: CLIENT_ID,
        homeserverUrl: HOMESERVER,
        idTokenClaims: {},
      }) as unknown as OpaqueSession,
    )
    bob = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await bob.connect(b!.token as unknown as OpaqueSession)

    // Sala cifrada por padrão criada pela ACL (§4.4); retry no rate limiter da stack compartilhada.
    const g = alice
    const channelId: ChannelId = await (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await g.createChannel({ name: `tayet-dlq-${process.pid}-${Math.floor(Math.random() * 1e6)}`, kind: 'private' })
        } catch (err) {
          const retryAfter = (err as { data?: { retry_after_ms?: number } }).data?.retry_after_ms
          if (retryAfter === undefined || attempt >= 10) throw err
          await new Promise((r) => setTimeout(r, retryAfter + 200))
        }
      }
    })()
    const roomId = channelId as unknown as string
    const bobId = await whoami(b!.token)
    await invite(session.accessToken, roomId, bobId)
    await join(b!.token, roomId)
    await until('bob is an active member on alice’s side', async () =>
      (await g.getMembers(channelId)).filter((m) => m.state === 'active').length === 2 ? true : undefined,
    )

    // Primeiro envio: bob passa a ser rastreado e consultado; a sessão de saída nasce. Depois disso a
    // lista de bob está fresca — nada a consultar até alguém marcá-la como desatualizada.
    await alice.sendMessage(channelId, { kind: 'text', text: 'um' })

    // Fio: o tráfego de alice (bearer mat_) a partir daqui, em ordem.
    const seq: string[] = []
    let injected = false
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const auth = new Headers(init?.headers).get('Authorization') ?? ''
      if (url.includes('/oauth2/token')) {
        const res = await realFetch(input, init)
        if (res.ok) seq.push('refresh')
        return res
      }
      if (!auth.startsWith('Bearer mat_')) return realFetch(input, init)
      if (!injected && url.includes('/_matrix/client/')) {
        injected = true
        seq.push('401')
        return new Response(JSON.stringify({ errcode: 'M_UNKNOWN_TOKEN', error: 'expired', soft_logout: false }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      if (url.includes('/keys/query')) {
        const asked = Object.keys((JSON.parse(String(init?.body ?? '{}')) as { device_keys?: object }).device_keys ?? {})
        seq.push(asked.includes(bobId) ? 'keys/query+peer' : 'keys/query')
      } else if (url.includes('/send/m.room.encrypted/')) {
        seq.push('send')
      }
      return realFetch(input, init)
    }) as typeof fetch

    // bob escreve: acorda o long-poll de alice, e o /sync seguinte dela leva o 401 → refresh real.
    await sendText(b!.token, roomId, 'acorda')
    await until('alice refreshed', async () => (seq.includes('refresh') ? true : undefined), { timeoutMs: 90_000 })

    await alice.sendMessage(channelId, { kind: 'text', text: 'dois' })
    await until('alice’s second message on the wire', async () => (seq.includes('send') ? true : undefined))

    const window = seq.slice(seq.indexOf('refresh'), seq.indexOf('send'))
    expect(window, `alice's traffic from the refresh to the send: ${JSON.stringify(seq)}`).toContain('keys/query+peer')
  }, 240_000)
})

describe('§8.24 re-query (availability)', () => {
  it(SYNAPSE ? 'stack reachable' : 'stack down — skipped', () => {
    expect(typeof SYNAPSE).toBe('boolean')
  })
})
