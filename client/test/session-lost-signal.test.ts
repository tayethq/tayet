// @vitest-environment jsdom
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient, OidcTokenRefresher } from 'matrix-js-sdk'
import { HttpApiEvent, TokenRefreshLogoutError } from 'matrix-js-sdk/lib/http-api/index'

// ADR-059 D1: o sinal de sessão perdida é o evento canônico do SDK (Session.logged_out), com a falha
// terminal do refresh como segundo emissor. Os dois convergem no MESMO onSessionLost payload-free.
//
// Idioma de orphan-store.test.ts: mock só o createClient (e, para o emissor por refresh, o
// OidcTokenRefresher) — o resto do SDK fica real. Nenhuma rede.
vi.mock('matrix-js-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('matrix-js-sdk')>()
  return { ...actual, createClient: vi.fn(), OidcTokenRefresher: vi.fn() }
})

// SUT importado APÓS o mock estar registrado.
import { MatrixGateway, STORE_WIPE_BOUND_MS } from '../src/acl/internal/matrix-client'
import { makeRenewer } from '../src/acl/internal/oidc'
import * as barrel from '../src/acl'
import type { AclTelemetry, OpaqueSession } from '../src/acl'
import { PROTOCOL_PATTERNS } from '@tayet/shared/leak-scan'

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
// Blob legado: o connect vai direto ao whoami, sem renewer — o único emissor possível é o evento.
const SESSION = 'legacy-token' as unknown as OpaqueSession

class SentinelError extends Error {}

// O client real do connect como EventEmitter de verdade (o MatrixClient É o emitter do http-api,
// client.js:420). startClient rejeita com a sentinela: o listener já está ligado nesse ponto.
function makeClient(sentinel: SentinelError) {
  const em = new EventEmitter()
  return Object.assign(em, {
    initRustCrypto: vi.fn().mockResolvedValue(undefined),
    clearStores: vi.fn().mockResolvedValue(undefined),
    startClient: vi.fn().mockRejectedValue(sentinel),
    getRooms: vi.fn(() => []),
    getCrypto: vi.fn(() => undefined),
    // ADR-062 D2: servidor sem chaves para o device → device novo, o connect segue.
    downloadKeysForUsers: vi.fn().mockResolvedValue({ device_keys: {}, failures: {} }),
    stopClient: vi.fn(),
  })
}

const probe = () => ({
  whoami: vi.fn().mockResolvedValue({ user_id: '@alice:x.local', device_id: 'DEVICE' }),
  clearStores: vi.fn().mockResolvedValue(undefined),
})

beforeEach(() => {
  vi.mocked(createClient).mockReset()
  vi.mocked(OidcTokenRefresher).mockReset()
})

describe('SessionLoggedOut do SDK → onSessionLost (ADR-059 D1)', () => {
  it('cada emissão do evento chama onSessionLost uma vez (emissor burro, sem debounce)', async () => {
    const sentinel = new SentinelError('past-wire')
    const client = makeClient(sentinel)
    vi.mocked(createClient)
      .mockReturnValueOnce(probe() as never)
      .mockReturnValueOnce(client as never)
    const onSessionLost = vi.fn()
    const gw = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x', onSessionLost })

    await expect(gw.connect(SESSION)).rejects.toBe(sentinel)
    expect(onSessionLost).not.toHaveBeenCalled()

    client.emit(HttpApiEvent.SessionLoggedOut, new Error('dead'))
    expect(onSessionLost).toHaveBeenCalledTimes(1)
    // A idempotência é do consumidor (ADR-035 D3): a ACL reemite.
    client.emit(HttpApiEvent.SessionLoggedOut, new Error('dead'))
    expect(onSessionLost).toHaveBeenCalledTimes(2)
  })

  it('disconnect remove o listener: evento depois do teardown não chega ao onSessionLost', async () => {
    const sentinel = new SentinelError('past-wire')
    const client = makeClient(sentinel)
    vi.mocked(createClient)
      .mockReturnValueOnce(probe() as never)
      .mockReturnValueOnce(client as never)
    const onSessionLost = vi.fn()
    const gw = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x', onSessionLost })

    await expect(gw.connect(SESSION)).rejects.toBe(sentinel)
    await gw.disconnect()
    expect(client.listenerCount(HttpApiEvent.SessionLoggedOut)).toBe(0)
    client.emit(HttpApiEvent.SessionLoggedOut, new Error('dead'))
    expect(onSessionLost).not.toHaveBeenCalled()
  })
})

describe('teardown de sessão perdida sem rede e com wipe limitado (ADR-059 D2)', () => {
  afterEach(() => vi.useRealTimers())

  async function connected(crypto: { checkKeyBackupAndEnable: ReturnType<typeof vi.fn> }) {
    const sentinel = new SentinelError('past-wire')
    const client = makeClient(sentinel)
    const ownKeys = vi.fn().mockResolvedValue({ ed25519: 'K', curve25519: 'C' })
    client.getCrypto = vi.fn(() => ({ getOwnDeviceKeys: ownKeys, ...crypto })) as never
    vi.mocked(createClient)
      .mockReturnValueOnce(probe() as never)
      .mockReturnValueOnce(client as never)
    const gw = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x', onSessionLost: vi.fn() })
    await expect(gw.connect(SESSION)).rejects.toBe(sentinel)
    return { gw, client }
  }

  it('com a sessão perdida, disconnect NÃO consulta o backup (nenhuma request autenticada)', async () => {
    const crypto = { checkKeyBackupAndEnable: vi.fn().mockResolvedValue(null) }
    const { gw, client } = await connected(crypto)
    client.emit(HttpApiEvent.SessionLoggedOut, new Error('dead'))
    await gw.disconnect()
    expect(crypto.checkKeyBackupAndEnable).not.toHaveBeenCalled()
    expect(client.stopClient).toHaveBeenCalledTimes(1)
  })

  it('controle: sessão viva, disconnect segue drenando o check de backup', async () => {
    const crypto = { checkKeyBackupAndEnable: vi.fn().mockResolvedValue(null) }
    const { gw } = await connected(crypto)
    await gw.disconnect()
    expect(crypto.checkKeyBackupAndEnable).toHaveBeenCalledTimes(1)
  })

  it('wipe que nunca resolve (onblocked) → signOut resolve no bound e loga no console', async () => {
    const crypto = { checkKeyBackupAndEnable: vi.fn().mockResolvedValue(null) }
    const { gw, client } = await connected(crypto)
    client.clearStores = vi.fn(() => new Promise<void>(() => {})) as never
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.useFakeTimers()
    let settled = false
    const done = gw.signOut().then(() => {
      settled = true
    })
    await vi.advanceTimersByTimeAsync(STORE_WIPE_BOUND_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await done
    expect(settled).toBe(true)
    expect(warn).toHaveBeenCalledWith('[acl] store wipe timed out')
    warn.mockRestore()
  })
})

describe('emissor por falha terminal do refresh continua (regressão do oidc.ts)', () => {
  const blob = {
    oidc: true as const,
    accessToken: 'at',
    refreshToken: 'rt',
    issuer: 'https://mas.local/',
    clientId: 'TAYET',
    homeserverUrl: 'http://x',
    idTokenClaims: {},
  }

  // O renewer subclassa OidcTokenRefresher; o fake é uma classe extensível cujo refresh é o stub.
  function mockRefresher(doRefreshAccessToken: ReturnType<typeof vi.fn>) {
    vi.mocked(OidcTokenRefresher).mockImplementation(function (this: { doRefreshAccessToken: unknown }) {
      this.doRefreshAccessToken = doRefreshAccessToken
    } as never)
  }

  it('TokenRefreshLogoutError → onSessionLost 1x e o erro é relançado para o SDK', async () => {
    const err = new TokenRefreshLogoutError(new Error('invalid_grant'))
    mockRefresher(vi.fn().mockRejectedValue(err))
    const onSessionLost = vi.fn()
    const r = makeRenewer(blob as never, 'DEVICE', undefined, onSessionLost)

    await expect(r.doRefreshAccessToken('rt')).rejects.toBe(err)
    expect(onSessionLost).toHaveBeenCalledTimes(1)
  })

  it('falha transitória (não-logout) → onSessionLost NÃO chamado', async () => {
    mockRefresher(vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    const onSessionLost = vi.fn()
    const r = makeRenewer(blob as never, 'DEVICE', undefined, onSessionLost)

    await expect(r.doRefreshAccessToken('rt')).rejects.toBeInstanceOf(TypeError)
    expect(onSessionLost).not.toHaveBeenCalled()
  })
})

describe('vocabulário do sinal não cruza o barrel', () => {
  it('nenhum export do barrel carrega HttpApiEvent/Session.logged_out/TokenRefreshLogoutError', () => {
    const names = Object.keys(barrel)
    expect(names.some((n) => /HttpApiEvent|TokenRefresh|logged_?out/i.test(n))).toBe(false)
    const runtimeValues = Object.values(barrel).filter((v) => typeof v === 'string') as string[]
    expect(runtimeValues).not.toContain('Session.logged_out')
  })

  it('o leak-scan pega os dois termos (deny-list estendida)', () => {
    const hits = (s: string) => PROTOCOL_PATTERNS.filter((p) => p.re.test(s)).map((p) => p.name)
    expect(hits('HttpApiEvent.SessionLoggedOut')).toContain('http-api-event')
    expect(hits('Session.logged_out')).toContain('session-logged-out')
    // Copy de produto da tela revoked não dispara (sem falso positivo).
    expect(hits('Seu acesso foi encerrado. Este acesso não está mais ativo.')).toEqual([])
  })
})
