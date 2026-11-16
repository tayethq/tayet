// @vitest-environment jsdom
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClientEvent, createClient, OidcTokenRefresher, SyncState } from 'matrix-js-sdk'
import { TokenRefresher } from 'matrix-js-sdk/lib/http-api/refresh'

// ADR-065 D4 (adendo) — o "Usar aqui" recarrega o dono sem esperar um refresh em voo. Isso não perde
// a sessão porque (1) o MAS reaceita o refresh token anterior enquanto o par emitido não foi usado
// (provado contra o MAS real em integration/acl-refresh-inflight.test.ts) e (2) o cliente grava o
// blob ANTES de usar o access token novo. Este teste fixa (2): a cadeia
// getNewTokens → persistTokens → onSessionRenewed → saveSession assenta antes de o http-api do SDK
// adotar o access token novo. Se a ordem inverter, um reload entre a adoção e a gravação deixaria o
// par novo usado com o blob velho — e o MAS recusaria o token velho (invalid_grant).
//
// Diferente de device-list-requery.test.ts: o OidcTokenRefresher é o REAL do SDK (a ordem de
// tokenRefresher.js getNewTokens faz parte do que se fixa); só a rede é falsa — o oidcClient que o
// ensureInit instalaria vira um fake com a resposta adiada (o refresh "em voo"). O TokenRefresher do
// http-api também é o real: é ele quem adota o token novo (refresh.js, opts.accessToken = …).
vi.mock('matrix-js-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('matrix-js-sdk')>()
  return { ...actual, createClient: vi.fn() }
})

import { MatrixGateway } from '../src/acl/internal/matrix-client'
import { loadSession, saveSession } from '../src/ui/session-store'
import type { AclTelemetry, OpaqueSession } from '../src/acl'

const noopTelemetry: AclTelemetry = { untranslated: () => {} }

const BLOB = JSON.stringify({
  kind: 'oidc',
  accessToken: 'at0',
  refreshToken: 'rt0',
  issuer: 'https://mas.local/',
  clientId: 'TAYET',
  homeserverUrl: 'http://x',
  idTokenClaims: {},
}) as unknown as OpaqueSession

function makeClient() {
  const em = new EventEmitter()
  const crypto = {
    getOwnDeviceKeys: vi.fn().mockResolvedValue({ ed25519: 'K', curve25519: 'C' }),
    markAllTrackedUsersAsDirty: vi.fn().mockResolvedValue(undefined),
    checkKeyBackupAndEnable: vi.fn().mockResolvedValue(null),
  }
  return Object.assign(em, {
    initRustCrypto: vi.fn().mockResolvedValue(undefined),
    clearStores: vi.fn().mockResolvedValue(undefined),
    startClient: vi.fn(async () => {
      em.emit(ClientEvent.Sync, SyncState.Prepared)
    }),
    getRooms: vi.fn(() => []),
    getRoom: vi.fn(() => null),
    getUser: vi.fn(() => null),
    getUserId: vi.fn(() => '@alice:x.local'),
    getDeviceId: vi.fn(() => 'DEVICE'),
    getDomain: vi.fn(() => 'x.local'),
    getCrypto: vi.fn(() => crypto),
    getAccountData: vi.fn(() => undefined),
    getAccountDataFromServer: vi.fn().mockResolvedValue(null),
    getDevices: vi.fn().mockResolvedValue({ devices: [] }),
    downloadKeysForUsers: vi.fn().mockResolvedValue({ device_keys: {}, failures: {} }),
    joinRoom: vi.fn().mockRejectedValue(new Error('offline')),
    getRoomIdForAlias: vi.fn().mockRejectedValue(new Error('offline')),
    setDeviceDetails: vi.fn().mockResolvedValue(undefined),
    stopClient: vi.fn(),
  })
}

const probe = () => ({
  whoami: vi.fn().mockResolvedValue({ user_id: '@alice:x.local', device_id: 'DEVICE' }),
  clearStores: vi.fn().mockResolvedValue(undefined),
})

type TokenResponse = { access_token: string; refresh_token: string; expires_in: number }

// O oidcClient falso: cada useRefreshToken fica pendente até o teste resolvê-lo (o refresh em voo).
function fakeOidcClient() {
  const pending: { refreshToken: string; resolve: (r: TokenResponse) => void }[] = []
  const client = {
    useRefreshToken: vi.fn(
      ({ state }: { state: { refresh_token: string } }) =>
        new Promise<TokenResponse>((resolve) => pending.push({ refreshToken: state.refresh_token, resolve })),
    ),
  }
  return { client, pending }
}

const persisted = (): { accessToken?: string; refreshToken?: string } =>
  JSON.parse((loadSession() as unknown as string | null) ?? '{}') as { accessToken?: string; refreshToken?: string }

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

beforeEach(() => {
  vi.mocked(createClient).mockReset()
  localStorage.clear()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('refresh em voo × reload do "Usar aqui" (ADR-065 D4, adendo)', () => {
  it('o blob é gravado antes de o access token novo ser adotado; em voo, o blob segue com o par velho', async () => {
    const oidc = fakeOidcClient()
    // ensureInit é privado no SDK: instala o fake no lugar da descoberta + OidcClient reais.
    vi.spyOn(OidcTokenRefresher.prototype as unknown as { ensureInit: () => Promise<void> }, 'ensureInit')
      .mockImplementation(async function (this: { oidcClient?: unknown }) {
        this.oidcClient = oidc.client
      })

    const order: string[] = []
    const onSessionRenewed = (s: OpaqueSession): void => {
      saveSession(s) // o mesmo saveSession que o Boot liga (Boot.tsx, makeAcl)
      order.push(`saveSession:${persisted().refreshToken}`)
    }

    vi.mocked(createClient)
      .mockReturnValueOnce(probe() as never)
      .mockReturnValueOnce(makeClient() as never)
    saveSession(BLOB)
    const gw = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x', onSessionRenewed })
    await gw.connect(BLOB)
    const { tokenRefreshFunction } = vi.mocked(createClient).mock.calls[1]![0] as {
      tokenRefreshFunction: (rt: string) => Promise<{ accessToken: string; refreshToken?: string }>
    }

    // O http-api real do SDK, com um espião na adoção do access token (refresh.js: opts.accessToken = …).
    let accessToken = 'at0'
    const opts = { refreshToken: 'rt0', tokenRefreshFunction } as {
      accessToken: string
      refreshToken: string
      tokenRefreshFunction: typeof tokenRefreshFunction
    }
    Object.defineProperty(opts, 'accessToken', {
      get: () => accessToken,
      set: (v: string) => {
        order.push(`adopt:${v} blob=${persisted().accessToken}/${persisted().refreshToken}`)
        accessToken = v
      },
      enumerable: true,
    })
    const refresher = new TokenRefresher(opts as never)

    const outcome = refresher.handleUnknownToken({ accessToken: 'at0', refreshToken: 'rt0' }, 1)
    await flush()

    // Em voo: o MAS já pode ter rotacionado, mas nada foi gravado nem adotado — o blob tem o par velho.
    expect(oidc.pending).toHaveLength(1)
    expect(oidc.pending[0]!.refreshToken).toBe('rt0')
    expect(persisted()).toMatchObject({ accessToken: 'at0', refreshToken: 'rt0' })
    expect(opts.accessToken).toBe('at0')
    expect(order).toEqual([])

    oidc.pending[0]!.resolve({ access_token: 'at1', refresh_token: 'rt1', expires_in: 300 })
    await expect(outcome).resolves.toBe('success') // TokenRefreshOutcome.Success (const enum ambiente)

    // A ordem: grava primeiro; quando o http-api adota o at1, o blob já carrega o par novo.
    expect(order).toEqual(['saveSession:rt1', 'adopt:at1 blob=at1/rt1'])
    expect(opts.refreshToken).toBe('rt1')
    await gw.disconnect().catch(() => {})
  })
})
