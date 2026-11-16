import {
  createClient,
  generateOidcAuthorizationUrl,
  completeAuthorizationCodeGrant,
  OidcTokenRefresher,
} from 'matrix-js-sdk'
// ADR-035 D1: gatilho de sessão-morta. NÃO é re-exportado da raiz 'matrix-js-sdk' (só de http-api);
// importado do MESMO caminho público que AccessTokens abaixo (§8.L<n>), não um deep-import inventado.
import { TokenRefreshLogoutError } from 'matrix-js-sdk/lib/http-api/index'
import type { IdTokenClaims } from 'oidc-client-ts'
import type { AccessTokens } from 'matrix-js-sdk/lib/http-api/index'
import type { OpaqueSession } from '../session'
import { ConnectionError } from '@tayet/shared'

// ── OIDC login flow — the SDK-touching half of web login (ADR-032 / ADR-007). ────────────────────
// matrix-js-sdk may only be imported under acl/internal (the barrel boundary). Login is APP work
// (ADR-030: the app obtains the session and hands it to the ACL), but the OIDC machinery itself —
// discovery, PKCE/authorize-url, code-exchange, token refresh — is protocol and MUST live here. So
// the split is: this module does the protocol; the barrel re-exports two NEUTRAL functions
// (buildLoginUrl, completeLogin) whose signatures carry only primitives and the opaque OpaqueSession;
// no matrix-js-sdk type ever crosses index.ts (P1/ADR-015). The app's ui/oidc.ts holds only the
// browser-side bits (callback detection, the redirect, the opaque blob).

// The renewable OIDC session, serialized into the OpaqueSession (ADR-032 D2). Opaque to the app:
// completeLogin serializes it, connect (matrix-client.ts) deserializes it. The legacy bare token
// (env/dogfood, ADR-030) is the OTHER OpaqueSession shape — a raw string, no JSON.
//
// Deliberadamente SEM identidade (userId/deviceId): a identidade canônica vem do whoami no connect,
// não do token (§8.L25 — o sub do id token não é um MXID confiável). O blob carrega só o material que
// o refresh exige: tokens + issuer/clientId + homeserver + idTokenClaims (o refresher valida com ele).
interface OidcSessionBlob {
  accessToken: string
  refreshToken?: string
  issuer: string
  clientId: string
  homeserverUrl: string
  idTokenClaims: unknown
}

// Discriminated parse of an OpaqueSession: a serialized OIDC blob (kind: 'oidc') vs a legacy bare
// token (env/dogfood). The ACL is the ONLY layer that interprets the handle (acl/session.ts).
export type ParsedSession =
  | ({ oidc: true } & OidcSessionBlob)
  | { oidc: false; accessToken: string }

const BLOB_KIND = 'oidc'

// The redirect_uri must be byte-identical to the one registered on the MAS static client
// (`http://localhost:5173/` — #55). Trailing slash included; the SPA serves the app at origin root.
const redirectUri = (): string => `${window.location.origin}/`

function serializeBlob(blob: OidcSessionBlob): OpaqueSession {
  return JSON.stringify({ kind: BLOB_KIND, ...blob }) as OpaqueSession
}

// Distinguish the JSON OIDC blob from a legacy bare token: a legacy `mct_…`/env string is not JSON
// (or not our shape), so any parse failure or missing discriminant falls through to the legacy path.
export function parseSessionBlob(session: OpaqueSession): ParsedSession {
  const raw = session as string
  try {
    const obj = JSON.parse(raw) as Partial<OidcSessionBlob> & { kind?: string }
    if (obj && typeof obj === 'object' && obj.kind === BLOB_KIND && typeof obj.accessToken === 'string') {
      return {
        oidc: true,
        accessToken: obj.accessToken,
        refreshToken: obj.refreshToken,
        issuer: obj.issuer ?? '',
        clientId: obj.clientId ?? '',
        homeserverUrl: obj.homeserverUrl ?? '',
        idTokenClaims: obj.idTokenClaims,
      }
    }
  } catch {
    // not JSON → a legacy bare token (env/dogfood)
  }
  return { oidc: false, accessToken: raw }
}

// Ida (ADR-032 D3): discover the OP, build the authorize URL. The SDK stashes PKCE/state itself (in
// sessionStorage, prefix `mx_oidc_`) and generates the device scope with a fresh random device id.
// `serverUrl` is the neutral product name for the homeserver base url (the SDK needs it both to
// disco­ver and to re-establish the session on return). Returns just the URL; the redirect itself is
// app work (ui/oidc.ts → window.location.assign).
export async function buildLoginUrl(opts: {
  serverUrl: string
  clientId: string
  loginHint?: string
}): Promise<string> {
  const tmp = createClient({ baseUrl: opts.serverUrl })
  const metadata = await tmp.getAuthMetadata()
  return generateOidcAuthorizationUrl({
    metadata,
    clientId: opts.clientId,
    redirectUri: redirectUri(),
    homeserverUrl: opts.serverUrl,
    nonce: crypto.randomUUID(),
    loginHint: opts.loginHint,
  })
}

// Volta (ADR-032 D3/D4): exchange the code (read from the current URL) for a renewable session and
// return the serialized OpaqueSession. URL hygiene (dropping ?code&state) is the APP's job now — Boot
// calls ui/oidc.scrubCallback (PR-B / §8.L31), so this SDK-facing module carries no address-bar
// side-effect. The app never sees the token structure (Fork G) — it only persists the opaque string.
export async function completeLogin(): Promise<OpaqueSession> {
  const params = new URLSearchParams(window.location.search)
  const code = params.get('code')
  const state = params.get('state')
  if (!code || !state) throw new Error('not an OIDC callback')
  // Classificação de rede do exchange (PLANO-BOOT-STORE-ORFAO §8 item 11), mesmo regime assimétrico
  // do connect (matrix-client.ts isNetworkFailure): rejeição de transporte é o único sinal POSITIVO
  // de rede; ausência dele = falha comum. O tipo não sobrevive ao SDK aqui — o catch de
  // completeAuthorizationCodeGrant relança qualquer erro não-OidcError como Error(CodeExchangeFailed)
  // (matrix-js-sdk src/oidc/authorize.ts), conflando rede com resposta inválida do OP — então o sinal
  // é capturado na ORIGEM: o oidc-client-ts resolve `fetch` no global a cada chamada, e o wrapper
  // abaixo (restaurado no finally) marca a rejeição (TypeError de rede, abort de timeout) antes de o
  // SDK a engolir. Janela restrita ao await do exchange; no callback OIDC nada mais toca a rede.
  let sawTransportFailure = false
  const realFetch = globalThis.fetch
  globalThis.fetch = async (...fetchArgs: Parameters<typeof fetch>) => {
    try {
      return await realFetch(...fetchArgs)
    } catch (e) {
      sawTransportFailure = true
      throw e
    }
  }
  let r: Awaited<ReturnType<typeof completeAuthorizationCodeGrant>>
  try {
    r = await completeAuthorizationCodeGrant(code, state)
  } catch {
    // P1: nenhum shape de erro do SDK/fetch atravessa a barrel. Rede → o tipo de domínio payload-free
    // que a UI já classifica por instanceof (L19); o resto (code/state inválido, resposta OIDC de
    // erro) → falha comum igualmente neutra. O detalhe pra debug fica no log do SDK (console ≠ DOM).
    throw sawTransportFailure ? new ConnectionError() : new Error('OIDC login failed')
  } finally {
    globalThis.fetch = realFetch
  }
  // SEM userId/deviceId: a identidade é resolvida via whoami no connect (§8.L25). Aqui guardamos só o
  // material de refresh; o sub do id token (não-canônico) deliberadamente NÃO entra no blob.
  return serializeBlob({
    accessToken: r.tokenResponse.access_token,
    refreshToken: r.tokenResponse.refresh_token,
    issuer: r.oidcClientSettings.issuer,
    clientId: r.oidcClientSettings.clientId,
    homeserverUrl: r.homeserverUrl,
    idTokenClaims: r.idTokenClaims,
  })
}

// A renewer for createClient's tokenRefreshFunction. Refresh is ACL work; persistence is APP work
// (ADR-030 / ADR-032 D2) — so we subclass OidcTokenRefresher only to override persistTokens, which
// re-serializes the blob with the rotated tokens and re-emits it via onSessionRenewed for the app to
// re-persist. issuer/clientId/idTokenClaims are stable across refresh, carried from the parsed blob.
// The `deviceId` is the CANONICAL device id from whoami (§8.L25) — passed in by connect, never read
// from the token: the OidcTokenRefresher constructor needs it, and it is not persisted in the blob
// (a reload re-derives it from whoami again).
export function makeRenewer(
  blob: Extract<ParsedSession, { oidc: true }>,
  deviceId: string,
  onSessionRenewed?: (session: OpaqueSession) => void,
  onSessionLost?: () => void,
): { doRefreshAccessToken: (refreshToken: string) => Promise<AccessTokens> } {
  class BlobRefresher extends OidcTokenRefresher {
    protected override async persistTokens(tokens: {
      accessToken: string
      refreshToken?: string
    }): Promise<void> {
      onSessionRenewed?.(
        serializeBlob({
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          issuer: blob.issuer,
          clientId: blob.clientId,
          homeserverUrl: blob.homeserverUrl,
          idTokenClaims: blob.idTokenClaims,
        }),
      )
    }
  }
  const refresher = new BlobRefresher(
    blob.issuer,
    blob.clientId,
    redirectUri(),
    deviceId,
    blob.idTokenClaims as IdTokenClaims,
  )
  // ADR-035 D1/D2: a falha TERMINAL do refresh (refresh grant revogado/expirado) é o gatilho de
  // sessão-morta. O SDK rejeita doRefreshAccessToken com TokenRefreshLogoutError; emitimos o sinal
  // neutro onSessionLost (payload-free) e RE-LANÇAMOS para o SDK seguir seu próprio teardown. O tipo
  // do SDK fica confinado AQUI (acl/internal) — não cruza o barrel (L19/ADR-007). Emissor burro: NÃO
  // debounça — a idempotência é do consumidor (Boot, ADR-035 D3).
  return {
    doRefreshAccessToken: (rt) =>
      refresher.doRefreshAccessToken(rt).catch((e: unknown) => {
        if (e instanceof TokenRefreshLogoutError) onSessionLost?.()
        throw e
      }),
  }
}

// ADR-062 D1 — sair revoga no emissor. RFC 7009 direto no `revocation_endpoint` dos metadados OIDC
// (o SDK já o exige na validação — oidc/validate.d.ts:7), com o `client_id` do blob (cliente público,
// sem segredo). Vocabulário OAuth, não Matrix: NÃO é o /logout do homeserver nem o end_session
// (RP-initiated, com redirect de página). Revoga o refresh e o access token desta sessão; no MAS
// qualquer um encerra a sessão, e o MAS apaga o device no Synapse. Lança em qualquer falha (descoberta,
// transporte, HTTP != 2xx) com mensagem sem token; o bound e o engolir são do caller (signOut).
export async function revokeSessionTokens(opts: {
  homeserverUrl: string
  clientId: string
  accessToken?: string
  refreshToken?: string
}): Promise<void> {
  const metadata = await createClient({ baseUrl: opts.homeserverUrl }).getAuthMetadata()
  const endpoint = metadata.revocation_endpoint
  const revoke = async (token: string, hint: 'refresh_token' | 'access_token'): Promise<void> => {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token, token_type_hint: hint, client_id: opts.clientId }),
    })
    if (!res.ok) throw new Error(`token revocation failed (${res.status})`)
  }
  const pending: Promise<void>[] = []
  if (opts.refreshToken) pending.push(revoke(opts.refreshToken, 'refresh_token'))
  if (opts.accessToken) pending.push(revoke(opts.accessToken, 'access_token'))
  await Promise.all(pending)
}

// ADR-059 D3 — expiração renova, revogação encerra. No boot, um M_UNKNOWN_TOKEN no probe com blob
// renovável é, no caso comum, só o access token vencido (TTL curto do MAS) com o refresh grant vivo.
// Tenta o refresh UMA vez antes de declarar a sessão morta:
//  - sucesso → as credenciais novas (o persistTokens do renewer já re-emitiu o blob via
//    onSessionRenewed);
//  - TokenRefreshLogoutError (invalid_grant: grant revogado/expirado) → 'revoked' — o caller mantém
//    o caminho de sessão expirada (wipe + SessionExpiredError);
//  - rejeição de transporte → ConnectionError, pelo mesmo regime de captura na origem do
//    completeLogin (o OidcTokenRefresher troca a falha de descoberta por um Error genérico, então o
//    tipo não sobrevive ao SDK); o resto propaga como está.
// O onSessionLost NÃO é ligado aqui: o boot não dispara o caminho mid-session. O deviceId vai vazio:
// o OidcTokenRefresher só o usa no `scope` das settings do OidcClient (tokenRefresher.js:97,
// generateScope), e o refresh não envia scope (getNewTokens monta o state sem scope; o oidc-client-ts
// 3.5.0 usa `state.scope` quando `refreshTokenAllowedScope` não está definido) — o grant mantém o
// escopo da sessão, inclusive o device. O device canônico vem do whoami que o caller refaz.
export async function renewOnBoot(
  blob: Extract<ParsedSession, { oidc: true }>,
  refreshToken: string,
  onSessionRenewed?: (session: OpaqueSession) => void,
): Promise<{ accessToken: string; refreshToken?: string } | 'revoked'> {
  const renewer = makeRenewer(blob, '', onSessionRenewed)
  let sawTransportFailure = false
  const realFetch = globalThis.fetch
  globalThis.fetch = async (...fetchArgs: Parameters<typeof fetch>) => {
    try {
      return await realFetch(...fetchArgs)
    } catch (e) {
      sawTransportFailure = true
      throw e
    }
  }
  try {
    const tokens = await renewer.doRefreshAccessToken(refreshToken)
    return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken }
  } catch (e) {
    if (e instanceof TokenRefreshLogoutError) return 'revoked'
    if (sawTransportFailure) throw new ConnectionError()
    throw e
  } finally {
    globalThis.fetch = realFetch
  }
}
