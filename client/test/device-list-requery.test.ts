// @vitest-environment jsdom
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClientEvent, createClient, OidcTokenRefresher, SyncState } from 'matrix-js-sdk'

// PLANO-RELEASE-PUBLICA §8.24 — mitigação defensiva: uma sessão longa re-consulta as listas de devices
// rastreadas (markAllTrackedUsersAsDirty) depois de um refresh de token bem-sucedido e ao voltar de
// background após mais de 60 s oculta. O efeito no rust-crypto real (o próximo envio faz keys/query
// antes de compartilhar) é provado na integração acl-device-list-requery.test.ts; aqui, só o gatilho.
//
// Idioma de session-lost-signal.test.ts: mock só o createClient e o OidcTokenRefresher. Nenhuma rede.
vi.mock('matrix-js-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('matrix-js-sdk')>()
  return { ...actual, createClient: vi.fn(), OidcTokenRefresher: vi.fn() }
})

import { MatrixGateway, REQUERY_DEVICES_AFTER_HIDDEN_MS } from '../src/acl/internal/matrix-client'
import { guarded } from '../src/acl/internal/handler-guard'
import type { AclTelemetry, OpaqueSession } from '../src/acl'

const noopTelemetry: AclTelemetry = { untranslated: () => {} }

const BLOB = JSON.stringify({
  kind: 'oidc',
  accessToken: 'at',
  refreshToken: 'rt',
  issuer: 'https://mas.local/',
  clientId: 'TAYET',
  homeserverUrl: 'http://x',
  idTokenClaims: {},
}) as unknown as OpaqueSession

// The real client of connect as an EventEmitter. startClient reaches the first PREPARED sync, so the
// connect runs to the end (the fire-and-forget tails find nothing and settle quietly).
function makeClient(markDirty: ReturnType<typeof vi.fn>) {
  const em = new EventEmitter()
  const crypto = {
    getOwnDeviceKeys: vi.fn().mockResolvedValue({ ed25519: 'K', curve25519: 'C' }),
    markAllTrackedUsersAsDirty: markDirty,
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

// The renewer subclasses OidcTokenRefresher; the fake's refresh rotates the tokens through the
// subclass's persistTokens, as the SDK's does on success.
function mockRefresher() {
  vi.mocked(OidcTokenRefresher).mockImplementation(function (this: {
    doRefreshAccessToken: unknown
    persistTokens: (t: { accessToken: string; refreshToken?: string }) => Promise<void>
  }) {
    this.doRefreshAccessToken = async () => {
      await this.persistTokens({ accessToken: 'at2', refreshToken: 'rt2' })
      return { accessToken: 'at2', refreshToken: 'rt2' }
    }
  } as never)
}

let visibility: DocumentVisibilityState = 'visible'
beforeEach(() => {
  vi.mocked(createClient).mockReset()
  vi.mocked(OidcTokenRefresher).mockReset()
  visibility = 'visible'
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function setVisibility(v: DocumentVisibilityState): void {
  visibility = v
  document.dispatchEvent(new Event('visibilitychange'))
}

async function connected(opts: { onSessionRenewed?: (s: OpaqueSession) => void; mode?: 'strict' | 'lenient' } = {}) {
  const markDirty = vi.fn().mockResolvedValue(undefined)
  const client = makeClient(markDirty)
  mockRefresher()
  vi.mocked(createClient)
    .mockReturnValueOnce(probe() as never)
    .mockReturnValueOnce(client as never)
  const { mode = 'strict', ...rest } = opts
  const gw = new MatrixGateway({ mode, telemetry: noopTelemetry, serverUrl: 'http://x', ...rest })
  await gw.connect(BLOB)
  const refresh = (vi.mocked(createClient).mock.calls[1]![0] as { tokenRefreshFunction: (rt: string) => Promise<unknown> })
    .tokenRefreshFunction
  return { gw, client, markDirty, refresh }
}

describe('§8.24 — refresh de token bem-sucedido re-consulta as listas de devices', () => {
  it('refresh → markAllTrackedUsersAsDirty 1x, e a sessão renovada segue para o app', async () => {
    const onSessionRenewed = vi.fn()
    const { markDirty, refresh } = await connected({ onSessionRenewed })
    expect(markDirty).not.toHaveBeenCalled()

    await refresh('rt')
    expect(onSessionRenewed).toHaveBeenCalledTimes(1)
    expect(markDirty).toHaveBeenCalledTimes(1)
  })

  it('refresh que falha não marca nada', async () => {
    const { markDirty } = await connected()
    vi.mocked(OidcTokenRefresher).mockImplementation(function (this: { doRefreshAccessToken: unknown }) {
      this.doRefreshAccessToken = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    } as never)
    // a new connect builds a new renewer over the failing fake
    const failing = makeClient(markDirty)
    vi.mocked(createClient)
      .mockReturnValueOnce(probe() as never)
      .mockReturnValueOnce(failing as never)
    const gw = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
    await gw.connect(BLOB)
    const refresh = (vi.mocked(createClient).mock.calls[3]![0] as { tokenRefreshFunction: (rt: string) => Promise<unknown> })
      .tokenRefreshFunction
    await expect(refresh('rt')).rejects.toBeInstanceOf(TypeError)
    expect(markDirty).not.toHaveBeenCalled()
  })

  it('markAllTrackedUsersAsDirty que rejeita não vaza (best-effort)', async () => {
    const { markDirty, refresh } = await connected()
    markDirty.mockRejectedValueOnce(new Error('olm machine gone'))
    await expect(refresh('rt')).resolves.toBeDefined()
  })
})

describe('§8.24 — volta de background após mais de 60 s re-consulta as listas de devices', () => {
  it(`oculta por mais de ${REQUERY_DEVICES_AFTER_HIDDEN_MS} ms → visível: markAllTrackedUsersAsDirty 1x`, async () => {
    const { markDirty } = await connected()
    vi.useFakeTimers({ toFake: ['Date'] })
    setVisibility('hidden')
    vi.advanceTimersByTime(REQUERY_DEVICES_AFTER_HIDDEN_MS + 1)
    setVisibility('visible')
    expect(markDirty).toHaveBeenCalledTimes(1)
  })

  it('troca de aba curta (≤ 60 s) não paga keys/query', async () => {
    const { markDirty } = await connected()
    vi.useFakeTimers({ toFake: ['Date'] })
    setVisibility('hidden')
    vi.advanceTimersByTime(REQUERY_DEVICES_AFTER_HIDDEN_MS)
    setVisibility('visible')
    expect(markDirty).not.toHaveBeenCalled()
  })

  it('disconnect remove o listener: visibilidade depois do teardown não marca nada', async () => {
    const { gw, markDirty } = await connected()
    await gw.disconnect()
    vi.useFakeTimers({ toFake: ['Date'] })
    setVisibility('hidden')
    vi.advanceTimersByTime(REQUERY_DEVICES_AFTER_HIDDEN_MS + 1)
    setVisibility('visible')
    expect(markDirty).not.toHaveBeenCalled()
  })
})

// §8.24 hipótese (4): o loop de sync do SDK avança o token antes de processar o lote (sync.js:756) e
// trata device_lists por último (sync.js:1394); um listener que lança no meio vira "Caught /sync
// error" e a mudança de devices do lote se perde. O lote é simulado como o SDK o faz: eventos emitidos
// em sequência, device_lists no fim.
describe('§8.24 H4 — nenhum handler da ACL lança para dentro do lote de sync', () => {
  function batch(client: EventEmitter, deviceLists: () => void): void {
    client.emit(ClientEvent.Sync, SyncState.Syncing, SyncState.Prepared)
    deviceLists()
  }

  it('lenient: assinante do domínio que lança não impede o device_lists do mesmo lote', async () => {
    const { gw, client } = await connected({ mode: 'lenient' })
    gw.subscribe(() => {
      throw new Error('subscriber bug')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const deviceLists = vi.fn()
    expect(() => batch(client, deviceLists)).not.toThrow()
    expect(deviceLists).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('[acl] handler failed: onSync')
  })

  it('strict: o lote segue, e a exceção é re-lançada num microtask (o teste ainda a vê)', async () => {
    const { gw, client } = await connected({ mode: 'strict' })
    const bug = new Error('subscriber bug')
    gw.subscribe(() => {
      throw bug
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const scheduled: Array<() => void> = []
    vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((cb) => void scheduled.push(cb))
    const deviceLists = vi.fn()
    expect(() => batch(client, deviceLists)).not.toThrow()
    expect(deviceLists).toHaveBeenCalledTimes(1)
    expect(scheduled).toHaveLength(1)
    expect(() => scheduled[0]!()).toThrow(bug)
  })

  it('guarded: o sinal é neutro — só o nome do site, nunca o erro', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    guarded('onTimeline', 'lenient', () => {
      throw new Error('@alice:x.local !room:x.local secret body')
    })()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]).toEqual(['[acl] handler failed: onTimeline'])
  })
})

describe('§8.24 H4 — SyncUnexpectedError re-consulta as listas de devices', () => {
  it('lote que lançou no SDK → markAllTrackedUsersAsDirty 1x, sinal neutro sem o erro', async () => {
    const { client, markDirty } = await connected()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    client.emit(ClientEvent.SyncUnexpectedError, new Error('@bob:x.local !room:x.local'))
    expect(markDirty).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls).toEqual([['[acl] sync batch failed']])
  })

  it('disconnect remove o listener', async () => {
    const { gw, client, markDirty } = await connected()
    await gw.disconnect()
    client.emit(ClientEvent.SyncUnexpectedError, new Error('x'))
    expect(markDirty).not.toHaveBeenCalled()
  })
})
