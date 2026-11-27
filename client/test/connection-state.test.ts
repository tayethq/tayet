// @vitest-environment jsdom
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClientEvent, createClient, OidcTokenRefresher, SyncState } from 'matrix-js-sdk'

// ADR-114 (Proposto): the point read of the connection state (getConnectionState) and the browser's
// network signal. The screen subscribes after connect resolves, so the states reported during the
// first sync reach no subscriber; the point read answers it. While the browser says it is offline,
// the reported state is 'offline' and a 'connected' from the sync is held back.
//
// Idiom of device-list-requery.test.ts: mock only createClient and OidcTokenRefresher. No network.
vi.mock('matrix-js-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('matrix-js-sdk')>()
  return { ...actual, createClient: vi.fn(), OidcTokenRefresher: vi.fn() }
})

import { MatrixGateway } from '../src/acl/internal/matrix-client'
import type { AclTelemetry, ConnectionState, DomainEvent, OpaqueSession } from '../src/acl'

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

// The real client of connect as an EventEmitter. startClient does NOT emit on its own: the test
// drives every sync state, so the window before the first PREPARED is observable.
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
    startClient: vi.fn(async () => {}),
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

let online = true
beforeEach(() => {
  vi.mocked(createClient).mockReset()
  vi.mocked(OidcTokenRefresher).mockReset()
  online = true
  vi.spyOn(navigator, 'onLine', 'get').mockImplementation(() => online)
})
afterEach(() => {
  vi.restoreAllMocks()
})

function newGateway() {
  const client = makeClient()
  vi.mocked(createClient)
    .mockReturnValueOnce(probe() as never)
    .mockReturnValueOnce(client as never)
  const gw = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
  return { gw, client }
}

// connect up to the first PREPARED followed by SYNCING, as the SDK does it (sync.js: Prepared, then
// Syncing in the same pass, before the next request).
async function connected() {
  const { gw, client } = newGateway()
  const done = gw.connect(BLOB)
  await vi.waitFor(() => expect(client.startClient).toHaveBeenCalled())
  client.emit(ClientEvent.Sync, SyncState.Prepared, null)
  client.emit(ClientEvent.Sync, SyncState.Syncing, SyncState.Prepared)
  await done
  return { gw, client }
}

function record(gw: MatrixGateway): ConnectionState[] {
  const seen: ConnectionState[] = []
  gw.subscribe((e: DomainEvent) => {
    if (e.t === 'connection.changed') seen.push(e.state)
  })
  return seen
}

function setNetwork(up: boolean): void {
  online = up
  window.dispatchEvent(new Event(up ? 'online' : 'offline'))
}

describe('ADR-114 dec. 1 — getConnectionState', () => {
  it("'connecting' before the first sync, on a fresh gateway and while connect waits", async () => {
    const { gw, client } = newGateway()
    expect(gw.getConnectionState()).toBe('connecting')
    const done = gw.connect(BLOB)
    await vi.waitFor(() => expect(client.startClient).toHaveBeenCalled())
    expect(gw.getConnectionState()).toBe('connecting')
    client.emit(ClientEvent.Sync, SyncState.Prepared, null)
    await done
  })

  it("'connected' after PREPARED — the subscriber that comes after connect reads it, nothing is re-delivered", async () => {
    const { gw } = await connected()
    const seen = record(gw)
    expect(gw.getConnectionState()).toBe('connected')
    expect(seen).toEqual([])
  })

  it("'reconnecting' after RECONNECTING and 'offline' after ERROR, each on the stream too", async () => {
    const { gw, client } = await connected()
    const seen = record(gw)
    client.emit(ClientEvent.Sync, SyncState.Reconnecting, SyncState.Syncing)
    expect(gw.getConnectionState()).toBe('reconnecting')
    client.emit(ClientEvent.Sync, SyncState.Error, SyncState.Reconnecting)
    expect(gw.getConnectionState()).toBe('offline')
    expect(seen).toEqual(['reconnecting', 'offline'])
  })
})

describe('ADR-114 dec. 4 — the browser network signal', () => {
  it("browser offline → 'offline' at once; a 'connected' from the sync is held back", async () => {
    const { gw, client } = await connected()
    const seen = record(gw)
    setNetwork(false)
    expect(seen).toEqual(['offline'])
    expect(gw.getConnectionState()).toBe('offline')
    // the request in flight at the cut comes back fine — still offline, nothing emitted
    client.emit(ClientEvent.Sync, SyncState.Syncing, SyncState.Syncing)
    expect(seen).toEqual(['offline'])
    expect(gw.getConnectionState()).toBe('offline')
    // a sync that fails while offline still reports 'offline'
    client.emit(ClientEvent.Sync, SyncState.Reconnecting, SyncState.Syncing)
    expect(seen).toEqual(['offline', 'offline'])
    expect(gw.getConnectionState()).toBe('offline')
  })

  it('browser online → the state the sync has at that moment', async () => {
    const { gw, client } = await connected()
    const seen = record(gw)
    setNetwork(false)
    client.emit(ClientEvent.Sync, SyncState.Reconnecting, SyncState.Syncing)
    setNetwork(true)
    expect(seen).toEqual(['offline', 'offline', 'reconnecting'])
    expect(gw.getConnectionState()).toBe('reconnecting')
    client.emit(ClientEvent.Sync, SyncState.Syncing, SyncState.Reconnecting)
    expect(gw.getConnectionState()).toBe('connected')

    setNetwork(false)
    client.emit(ClientEvent.Sync, SyncState.Syncing, SyncState.Syncing) // held back
    setNetwork(true)
    expect(seen.slice(-2)).toEqual(['offline', 'connected'])
    expect(gw.getConnectionState()).toBe('connected')
  })

  it("navigator.onLine false at connect → 'offline', and the first PREPARED does not say connected", async () => {
    online = false
    const { gw } = await connected()
    expect(gw.getConnectionState()).toBe('offline')
    setNetwork(true)
    expect(gw.getConnectionState()).toBe('connected')
  })
})

describe('ADR-114 — a runtime without browser events', () => {
  it('a partial window (no addEventListener) connects; the state follows the sync alone', async () => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost:5173' } })
    try {
      const { gw, client } = await connected()
      expect(gw.getConnectionState()).toBe('connected')
      client.emit(ClientEvent.Sync, SyncState.Reconnecting, SyncState.Syncing)
      expect(gw.getConnectionState()).toBe('reconnecting')
      await gw.disconnect()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('ADR-114 — disconnect', () => {
  it("removes the network listeners and returns the state to 'connecting'", async () => {
    const { gw } = await connected()
    setNetwork(false)
    expect(gw.getConnectionState()).toBe('offline')
    const seen = record(gw)
    await gw.disconnect()
    expect(gw.getConnectionState()).toBe('connecting')
    setNetwork(true)
    setNetwork(false)
    expect(seen).toEqual([])
    expect(gw.getConnectionState()).toBe('connecting')
  })
})
