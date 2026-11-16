// @vitest-environment jsdom
import { describe, it, expect, afterAll } from 'vitest'
import { parseSessionBlob, renewOnBoot } from '../../src/acl/internal/oidc'
import type { OpaqueSession } from '../../src/acl'
import { HOMESERVER, synapseReachable } from '../support/synapse'
import { freshUsers } from '../support/fresh-users'
import { mintOidcSession } from '../support/mint-oidc'
import { killSessions } from '../support/synapse-admin'

// ── Refresh em voo × reload do "Usar aqui" (ADR-065 D4, adendo; PLANO-RELEASE-PUBLICA §8.29). ─────────
// ESTE TESTE É A REVERIFICAÇÃO DA DEPENDÊNCIA DO ADR-065 NO COMPORTAMENTO DO MAS. Rode-o a cada
// atualização da imagem do MAS (digest fixado em infra/dev-stack/compose.yaml, infra/deploy/compose.yaml
// e infra/deploy/deploy.sh). Se ele quebrar, o "Usar aqui" deixa de cortar um refresh em voo sem perda.
//
// O dono cede por reload sem esperar nada (ADR-065 D4). Se o reload cai com um POST /oauth2/token em
// voo, o MAS pode ter rotacionado o refresh token e a resposta morre com a página: o blob fica com o
// refresh token velho. Isso não perde a sessão porque o MAS 1.27.0 (crates/handlers/src/oauth2/token.rs,
// refresh_token_grant) reaceita um refresh token já consumido enquanto o par que ele emitiu não foi
// usado: nem o refresh token seguinte consumido (`if !next_refresh_token.is_valid()`), nem o access token
// seguinte usado (`if next_access_token.is_used()`; first_used_at é gravado na introspecção). O cliente
// grava o blob antes de usar o access token novo (refresh-inflight-order.test.ts), então o par perdido
// nunca foi usado.
//  a) refresh(RT0) com a resposta descartada → renewOnBoot com o blob de RT0 → sucesso, sem 'revoked';
//  b) AT1 usado uma vez → refresh(RT0) → invalid_grant (o outro lado: o token velho não é eterno).
//
// Sessão OIDC real (mat_/mar_) cunhada headless, mesmo regime de acl-sign-out-revoke: um mct_ do
// freshUsers não tem refresh grant. Sem mudança na config do MAS.

const SYNAPSE = synapseReachable()
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

// O POST /oauth2/token cru — o refresh que a página morta fez. O corpo volta só para o caso b) usar o
// par; no caso a) ele é descartado (a resposta "morreu com a página").
async function refreshWith(
  refreshToken: string,
): Promise<{ status: number; error?: string; accessToken?: string; refreshToken?: string }> {
  const res = await fetch(`${MAS_URL}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID }),
  })
  const body = (await res.json().catch(() => ({}))) as { error?: string; access_token?: string; refresh_token?: string }
  return { status: res.status, error: body.error, accessToken: body.access_token, refreshToken: body.refresh_token }
}

async function whoamiStatus(accessToken: string): Promise<number> {
  const res = await fetch(`${HOMESERVER}/_matrix/client/v3/account/whoami`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  return res.status
}

describe.skipIf(!SYNAPSE)('refresh em voo cortado pelo reload: o MAS reaceita o refresh token anterior (ADR-065 D4)', () => {
  const names: string[] = []

  afterAll(() => {
    for (const n of names) killSessions(n)
  })

  async function session(prefix: string) {
    const [u] = await freshUsers([prefix])
    names.push(u.name)
    return mintOidcSession(u.name, PASSWORD)
  }

  it('a) refresh com a resposta descartada → renewOnBoot com o blob de RT0 renova, sem revoked', async () => {
    const s = await session('rfa')

    // A página morta: o MAS rotacionou (RT0 consumido), a resposta nunca chegou ao blob.
    const lost = await refreshWith(s.refreshToken)
    expect(lost.status).toBe(200)

    // A aba nova: o blob persistido ainda carrega RT0.
    const blob = parseSessionBlob(oidcBlob(s))
    if (!blob.oidc) throw new Error('blob OIDC esperado')
    const renewed: OpaqueSession[] = []
    const out = await renewOnBoot(blob, s.refreshToken, (r) => renewed.push(r))

    expect(out).not.toBe('revoked')
    if (out === 'revoked') return
    expect(out.refreshToken).toBeDefined()
    expect(out.refreshToken).not.toBe(s.refreshToken)
    expect(out.refreshToken).not.toBe(lost.refreshToken)
    // O renewer re-emitiu o blob com o par novo (é o que o Boot grava), e o par novo vale no Synapse.
    expect(renewed).toHaveLength(1)
    const persisted = parseSessionBlob(renewed[0]!)
    expect(persisted).toMatchObject({ oidc: true, accessToken: out.accessToken, refreshToken: out.refreshToken })
    expect(await whoamiStatus(out.accessToken)).toBe(200)
    // O par perdido foi revogado pelo MAS (não sobram dois ramos).
    expect(await whoamiStatus(lost.accessToken!)).toBe(401)
  })

  it('b) AT1 usado uma vez → refresh(RT0) → invalid_grant; a cadeia de RT1 segue viva', async () => {
    const s = await session('rfb')

    const first = await refreshWith(s.refreshToken)
    expect(first.status).toBe(200)
    // O access token novo usado uma vez: a introspecção do Synapse grava first_used_at no MAS.
    expect(await whoamiStatus(first.accessToken!)).toBe(200)

    const replay = await refreshWith(s.refreshToken)
    expect(replay.status).toBe(400)
    expect(replay.error).toBe('invalid_grant')

    // A recusa não derruba a sessão: RT1 continua válido.
    const next = await refreshWith(first.refreshToken!)
    expect(next.status).toBe(200)
  })
})
