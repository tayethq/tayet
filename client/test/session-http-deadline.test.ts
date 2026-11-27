import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient, type MatrixClient } from 'matrix-js-sdk'

// Issue #421, lote "Nova conversa": F2 (the session client's HTTP deadline) and R2 (past the deadline is a
// connection failure; a session that is ending is not). Idiom of orphan-store.test.ts: mock only createClient so the
// connect's options can be read; the requests themselves go through a REAL SDK client whose fetch accepts the request
// and never answers (it only honours the abort signal), on fake timers.
vi.mock('matrix-js-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('matrix-js-sdk')>()
  return { ...actual, createClient: vi.fn() }
})

import { MatrixGateway, SESSION_HTTP_TIMEOUT_MS } from '../src/acl/internal/matrix-client'
import { ConnectionError, type AclTelemetry, type ChannelId, type OpaqueSession } from '../src/acl'

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const SESSION = 'legacy-token' as unknown as OpaqueSession
const makeGateway = () => new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })

// The server takes the connection and never answers: the request settles only when its signal aborts.
function silentFetch(): typeof fetch {
  return ((_url: unknown, init?: { signal?: AbortSignal }) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')))
    })) as typeof fetch
}

async function realClient(): Promise<MatrixClient> {
  const actual = await vi.importActual<typeof import('matrix-js-sdk')>('matrix-js-sdk')
  return actual.createClient({
    baseUrl: 'http://x',
    accessToken: 't',
    userId: '@me:x',
    deviceId: 'DEV',
    fetchFn: silentFetch(),
    localTimeoutMs: SESSION_HTTP_TIMEOUT_MS,
  })
}

beforeEach(() => {
  vi.mocked(createClient).mockReset()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('F2: the deadline is on the session client only', () => {
  it('the session createClient carries localTimeoutMs = 30 s; the boot probe does not', async () => {
    const probe = {
      whoami: vi.fn().mockResolvedValue({ user_id: '@me:x', device_id: 'DEV' }),
      clearStores: vi.fn().mockResolvedValue(undefined),
    }
    const sentinel = new Error('sentinel')
    const session = {
      initRustCrypto: vi.fn().mockResolvedValue(undefined),
      clearStores: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      off: vi.fn(),
      startClient: vi.fn().mockRejectedValue(sentinel),
      getRooms: vi.fn(() => []),
      getCrypto: vi.fn(() => undefined),
      stopClient: vi.fn(),
    }
    vi.mocked(createClient).mockReturnValueOnce(probe as never).mockReturnValue(session as never)
    await expect(makeGateway().connect(SESSION)).rejects.toBe(sentinel)
    const calls = vi.mocked(createClient).mock.calls.map(([opts]) => opts as { localTimeoutMs?: number; store?: unknown })
    expect(calls[0]!.localTimeoutMs).toBeUndefined()
    const sessionCall = calls.find((o) => o.store !== undefined)!
    expect(sessionCall.localTimeoutMs).toBe(30_000)
  })

  it('a server that takes the connection and never answers: createChannel rejects within the deadline', async () => {
    vi.useFakeTimers()
    const gateway = makeGateway()
    ;(gateway as unknown as { client: unknown }).client = await realClient()
    let failure: unknown
    const verb = gateway.createChannel({ name: 'novo', kind: 'public' }).catch((e: unknown) => (failure = e))
    await vi.advanceTimersByTimeAsync(SESSION_HTTP_TIMEOUT_MS - 1)
    expect(failure).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    await verb
    expect((failure as Error | undefined)?.name).toBe('AbortError')
  })
})

describe("R2: past the deadline is a connection failure; a session that is ending is not", () => {
  // The boot's device-identity check (ADR-062 D2) over the real client's keys/query.
  async function identityCheck(gateway: MatrixGateway, client: MatrixClient): Promise<unknown> {
    const shell = {
      getCrypto: () => ({ getOwnDeviceKeys: async () => ({ ed25519: 'k', curve25519: 'c' }) }),
      downloadKeysForUsers: (users: string[]) => client.downloadKeysForUsers(users),
    }
    ;(gateway as unknown as { client: unknown }).client = shell
    const check = (gateway as unknown as { assertDeviceIdentity: (c: unknown, u: string, d: string) => Promise<void> })
      .assertDeviceIdentity(shell, '@me:x', 'DEV')
    return check.then(
      () => 'resolved',
      (e: unknown) => e,
    )
  }

  it("the boot's keys/query past the deadline rejects with the domain's connection error (retry, not failed)", async () => {
    vi.useFakeTimers()
    const gateway = makeGateway()
    const outcome = identityCheck(gateway, await realClient())
    await vi.advanceTimersByTimeAsync(SESSION_HTTP_TIMEOUT_MS)
    expect(await outcome).toBeInstanceOf(ConnectionError)
  })

  it('a request aborted by the disconnect is not a connection failure', async () => {
    vi.useFakeTimers()
    const gateway = makeGateway()
    const client = await realClient()
    const outcome = identityCheck(gateway, client)
    // disconnect() clears this.client before stopClient(). The SDK's stopClient() does not abort a request already
    // in flight (41.6.0: only the sync, and logout(true) through http.abort(), do): it ends at its own deadline,
    // after the session is gone. Both endings are the same AbortError; the session's state tells them apart.
    ;(gateway as unknown as { client: unknown }).client = undefined
    client.stopClient()
    client.http.abort()
    await vi.advanceTimersByTimeAsync(SESSION_HTTP_TIMEOUT_MS)
    const error = await outcome
    expect(error).not.toBeInstanceOf(ConnectionError)
    expect((error as Error).name).toBe('AbortError')
  })

  it('getMessage past the deadline rejects with the connection error', async () => {
    vi.useFakeTimers()
    const gateway = makeGateway()
    ;(gateway as unknown as { client: unknown }).client = await realClient()
    const outcome = gateway.getMessage('!r:x' as ChannelId, '$e' as never).then(
      () => 'resolved',
      (e: unknown) => e,
    )
    await vi.advanceTimersByTimeAsync(SESSION_HTTP_TIMEOUT_MS)
    expect(await outcome).toBeInstanceOf(ConnectionError)
  })
})
