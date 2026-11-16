// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient, MatrixError, OidcTokenRefresher } from 'matrix-js-sdk'
import { TokenRefreshLogoutError } from 'matrix-js-sdk/lib/http-api/index'

// ADR-059 D3 — expiração renova, revogação encerra. O probe de boot recebe M_UNKNOWN_TOKEN; com blob
// renovável, o connect tenta o refresh UMA vez antes de declarar a sessão morta.
//
// Idioma de orphan-store.test.ts: mock só o createClient e o OidcTokenRefresher; o resto do SDK
// (MatrixError, enums) fica real. Nenhuma rede.
vi.mock('matrix-js-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('matrix-js-sdk')>()
  return { ...actual, createClient: vi.fn(), OidcTokenRefresher: vi.fn() }
})

// SUT importado APÓS o mock estar registrado.
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import { ConnectionError, SessionExpiredError, type AclTelemetry, type OpaqueSession } from '../src/acl'

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const blob = (fields: Record<string, unknown>) =>
  JSON.stringify({
    kind: 'oidc',
    accessToken: 'old-at',
    issuer: 'https://mas.local/',
    clientId: 'TAYET',
    homeserverUrl: 'http://x',
    idTokenClaims: {},
    ...fields,
  }) as unknown as OpaqueSession
const RENEWABLE = blob({ refreshToken: 'rt-1' })

const dead = () => new MatrixError({ errcode: 'M_UNKNOWN_TOKEN', error: 'Token is not active' })
const probe = (whoami: ReturnType<typeof vi.fn>) => ({ whoami, clearStores: vi.fn().mockResolvedValue(undefined) })
const okWhoami = () => vi.fn().mockResolvedValue({ user_id: '@alice:x.local', device_id: 'DEVICE' })

class SentinelError extends Error {}
// O client real do connect: startClient rejeita com a sentinela — a testemunha de "passou do boot e
// da cripto" sem fake do mundo todo.
function cryptoClient(sentinel: SentinelError, initRustCrypto = vi.fn().mockResolvedValue(undefined)) {
  return {
    initRustCrypto,
    clearStores: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    off: vi.fn(),
    startClient: vi.fn().mockRejectedValue(sentinel),
    getRooms: vi.fn(() => []),
    // Sem crypto API no fake: a checagem de identidade do ADR-062 D2 não tem o que comparar.
    getCrypto: vi.fn(() => undefined),
    stopClient: vi.fn(),
  }
}

// O renewer subclassa OidcTokenRefresher; o fake chama o persistTokens da subclasse como o real faz
// (tokenRefresher.js getNewTokens → persistTokens) e devolve as credenciais rotacionadas.
function mockRefresh(impl: (self: { persistTokens: (t: unknown) => Promise<void> }) => Promise<unknown>) {
  vi.mocked(OidcTokenRefresher).mockImplementation(function (this: {
    doRefreshAccessToken: unknown
    persistTokens: (t: unknown) => Promise<void>
  }) {
    this.doRefreshAccessToken = vi.fn(() => impl(this))
  } as never)
}

const realFetch = globalThis.fetch
beforeEach(() => {
  vi.mocked(createClient).mockReset()
  vi.mocked(OidcTokenRefresher).mockReset()
})
afterEach(() => {
  globalThis.fetch = realFetch
})

describe('boot: token vencido com refresh grant vivo renova e segue (ADR-059 D3)', () => {
  it('M_UNKNOWN_TOKEN + refresh 200 → re-persiste, refaz o whoami e conecta com o token novo; sem wipe', async () => {
    const tokens = { accessToken: 'new-at', refreshToken: 'rt-2' }
    mockRefresh(async (self) => {
      await self.persistTokens(tokens)
      return tokens
    })
    const first = probe(vi.fn().mockRejectedValue(dead()))
    const second = probe(okWhoami())
    const sentinel = new SentinelError('past-boot')
    const client = cryptoClient(sentinel)
    vi.mocked(createClient)
      .mockReturnValueOnce(first as never)
      .mockReturnValueOnce(second as never)
      .mockReturnValueOnce(client as never)
    const onSessionRenewed = vi.fn()
    const onSessionLost = vi.fn()
    const gw = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x', onSessionRenewed, onSessionLost })

    await expect(gw.connect(RENEWABLE)).rejects.toBe(sentinel)

    expect(first.clearStores).not.toHaveBeenCalled()
    expect(onSessionRenewed).toHaveBeenCalledTimes(1)
    const persisted = JSON.parse(onSessionRenewed.mock.calls[0]![0] as string) as Record<string, unknown>
    expect(persisted).toMatchObject({ kind: 'oidc', accessToken: 'new-at', refreshToken: 'rt-2' })
    // O segundo whoami e o client real usam as credenciais rotacionadas.
    expect(vi.mocked(createClient).mock.calls[1]![0]).toMatchObject({ accessToken: 'new-at' })
    expect(vi.mocked(createClient).mock.calls[2]![0]).toMatchObject({ accessToken: 'new-at', refreshToken: 'rt-2' })
    // O boot não dispara o caminho mid-session.
    expect(onSessionLost).not.toHaveBeenCalled()
  })

  it('M_UNKNOWN_TOKEN + refresh invalid_grant → SessionExpiredError e wipe (revogação encerra)', async () => {
    mockRefresh(async () => {
      throw new TokenRefreshLogoutError(new Error('invalid_grant'))
    })
    const first = probe(vi.fn().mockRejectedValue(dead()))
    vi.mocked(createClient).mockReturnValueOnce(first as never)
    const onSessionLost = vi.fn()
    const gw = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x', onSessionLost })

    await expect(gw.connect(RENEWABLE)).rejects.toBeInstanceOf(SessionExpiredError)
    expect(first.clearStores).toHaveBeenCalledTimes(1)
    expect(onSessionLost).not.toHaveBeenCalled()
  })

  it('blob sem refresh token → comportamento anterior: SessionExpiredError + wipe, sem tentar refresh', async () => {
    const first = probe(vi.fn().mockRejectedValue(dead()))
    vi.mocked(createClient).mockReturnValueOnce(first as never)
    const gw = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })

    await expect(gw.connect(blob({}))).rejects.toBeInstanceOf(SessionExpiredError)
    expect(first.clearStores).toHaveBeenCalledTimes(1)
    expect(OidcTokenRefresher).not.toHaveBeenCalled()
  })

  it('refresh falha por transporte → ConnectionError (regime existente), sem wipe', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed')) as never
    mockRefresh(async () => {
      await fetch('https://mas.local/oauth2/token')
      return {}
    })
    const first = probe(vi.fn().mockRejectedValue(dead()))
    vi.mocked(createClient).mockReturnValueOnce(first as never)
    const gw = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })

    const err = await gw.connect(RENEWABLE).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ConnectionError)
    expect((err as Error).message).not.toContain('fetch failed')
    expect(first.clearStores).not.toHaveBeenCalled()
  })

  it('renovado + store órfão de outro device → resgate do connect (wipe + 1 retry) e segue sem revoked', async () => {
    const tokens = { accessToken: 'new-at', refreshToken: 'rt-2' }
    mockRefresh(async (self) => {
      await self.persistTokens(tokens)
      return tokens
    })
    const sentinel = new SentinelError('past-crypto')
    const initRustCrypto = vi
      .fn()
      .mockRejectedValueOnce(new Error("the account in the store doesn't match the account in the constructor"))
      .mockResolvedValueOnce(undefined)
    const client = cryptoClient(sentinel, initRustCrypto)
    vi.mocked(createClient)
      .mockReturnValueOnce(probe(vi.fn().mockRejectedValue(dead())) as never)
      .mockReturnValueOnce(probe(okWhoami()) as never)
      .mockReturnValueOnce(client as never)
    const gw = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x', onSessionRenewed: vi.fn() })

    await expect(gw.connect(RENEWABLE)).rejects.toBe(sentinel)
    expect(client.clearStores).toHaveBeenCalledTimes(1)
    expect(initRustCrypto).toHaveBeenCalledTimes(2)
  })
})
