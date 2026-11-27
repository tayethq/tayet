// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MatrixGateway, PUSH_OFF_BOUND_MS, REVOKE_BOUND_MS } from '../src/acl/internal/matrix-client'
import { PUSH_APP_ID, PUSH_SERVICE_URL } from '../src/acl/internal/device-notifications'
import type { AclTelemetry, DeviceNotificationSubscription } from '../src/acl'

// ADR-117 dec. 6 (PR 3 of the push track): this access's subscription. The shape is checked before any request;
// enable reads the account's subscriptions and writes only when this one is missing or differs; disable removes the
// one this session registered; signOut removes it before the disconnect, bounded, and never with a lost session.
// The gateway's live state is set by hand (no SDK, no network): the client is a fake.

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
// Low-entropy values of the right shape: 65 and 16 bytes, unpadded base64url.
const KEY = 'B' + 'A'.repeat(86)
const SECRET = 'C'.repeat(22)
const SUB: DeviceNotificationSubscription = { endpoint: 'https://push.example.test/send/one', keys: { p256dh: KEY, auth: SECRET } }

function fakeClient(pushers: unknown[] = []) {
  const order: string[] = []
  const client = {
    http: {
      authedRequest: vi.fn(async (method: string, path: string) => {
        order.push(`${method} ${path}`)
        return { pushers }
      }),
    },
    setPusher: vi.fn(async () => {
      order.push('setPusher')
      return {}
    }),
    removePusher: vi.fn(async () => {
      order.push('removePusher')
      return {}
    }),
    getCrypto: vi.fn(() => undefined),
    stopClient: vi.fn(() => order.push('stopClient')),
    clearStores: vi.fn(async () => {}),
  }
  return { client, order }
}

function connected(client: unknown): MatrixGateway {
  const gw = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
  Object.assign(gw as unknown as Record<string, unknown>, { client, live: true })
  return gw
}

const existing = (over: Record<string, unknown> = {}, data: Record<string, unknown> = {}) => ({
  kind: 'http',
  app_id: PUSH_APP_ID,
  pushkey: KEY,
  data: { url: PUSH_SERVICE_URL, endpoint: SUB.endpoint, auth: SECRET, ...data },
  ...over,
})

afterEach(() => vi.useRealTimers())

describe('enableDeviceNotifications: the shape', () => {
  const bad: Array<[string, unknown]> = [
    ['endpoint is not a URL', { ...SUB, endpoint: 'not a url' }],
    ['endpoint is not http(s)', { ...SUB, endpoint: 'ftp://push.example.test/x' }],
    ['endpoint is too long', { ...SUB, endpoint: 'https://push.example.test/' + 'a'.repeat(2049 - 26) }],
    ['endpoint is missing', { keys: SUB.keys }],
    ['p256dh is 64 bytes', { ...SUB, keys: { p256dh: KEY.slice(0, 86), auth: SECRET } }],
    ['p256dh is not base64url', { ...SUB, keys: { p256dh: KEY.slice(0, 86) + '+', auth: SECRET } }],
    ['p256dh is padded', { ...SUB, keys: { p256dh: KEY.slice(0, 86) + '=', auth: SECRET } }],
    ['auth is 15 bytes', { ...SUB, keys: { p256dh: KEY, auth: SECRET.slice(0, 20) } }],
    ['auth is not base64url', { ...SUB, keys: { p256dh: KEY, auth: SECRET.slice(0, 21) + '/' } }],
    ['keys are missing', { endpoint: SUB.endpoint }],
    ['not an object', null],
  ]
  it.each(bad)('rejects (%s) without any request', async (_label, sub) => {
    const { client } = fakeClient()
    const gw = connected(client)
    const err = await gw.enableDeviceNotifications(sub as DeviceNotificationSubscription).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(String((err as Error).message)).not.toContain('example')
    expect(client.http.authedRequest).not.toHaveBeenCalled()
    expect(client.setPusher).not.toHaveBeenCalled()
  })

  it('an endpoint of exactly 2048 characters and an http endpoint are accepted', async () => {
    const { client } = fakeClient()
    const gw = connected(client)
    const long = 'https://push.example.test/' + 'a'.repeat(2048 - 26)
    expect(long).toHaveLength(2048)
    await gw.enableDeviceNotifications({ ...SUB, endpoint: long })
    await gw.enableDeviceNotifications({ ...SUB, endpoint: 'http://host.docker.internal:4000/r' })
    expect(client.setPusher).toHaveBeenCalledTimes(2)
  })
})

describe('enableDeviceNotifications: the write', () => {
  it('does not write when the account already has this subscription', async () => {
    const { client, order } = fakeClient([existing()])
    await connected(client).enableDeviceNotifications(SUB)
    expect(order).toEqual(['GET /pushers'])
  })

  it('writes when it is missing, with the exact body', async () => {
    const { client, order } = fakeClient([existing({ app_id: 'other.app' }), existing({ pushkey: 'B' + 'Q'.repeat(86) })])
    await connected(client).enableDeviceNotifications(SUB)
    expect(order).toEqual(['GET /pushers', 'setPusher'])
    expect(client.setPusher).toHaveBeenCalledWith({
      kind: 'http',
      app_id: 'io.tayet.web',
      pushkey: KEY,
      app_display_name: 'Tayet',
      device_display_name: 'Tayet',
      lang: 'en',
      data: { url: 'http://push:8095/_matrix/push/v1/notify', endpoint: SUB.endpoint, auth: SECRET },
      append: false,
    })
  })

  it('writes when the endpoint or the auth secret differ', async () => {
    for (const data of [{ endpoint: 'https://push.example.test/send/two' }, { auth: 'D'.repeat(22) }]) {
      const { client } = fakeClient([existing({}, data)])
      await connected(client).enableDeviceNotifications(SUB)
      expect(client.setPusher).toHaveBeenCalledTimes(1)
    }
  })

  it('a failure rejects with a neutral error that carries neither the subscription nor the SDK error', async () => {
    const { client } = fakeClient()
    client.setPusher.mockRejectedValueOnce(Object.assign(new Error(`bad ${SUB.endpoint}`), { httpStatus: 400 }))
    const err = (await connected(client).enableDeviceNotifications(SUB).catch((e: unknown) => e)) as Error
    expect(err.message).toBe('device notifications failed')
    expect(JSON.stringify({ m: err.message, c: (err as { cause?: unknown }).cause ?? null })).not.toContain('example')
  })
})

describe('disableDeviceNotifications', () => {
  it('removes the subscription this session registered and forgets it', async () => {
    const { client } = fakeClient()
    const gw = connected(client)
    await gw.enableDeviceNotifications(SUB)
    await gw.disableDeviceNotifications()
    expect(client.removePusher).toHaveBeenCalledWith(KEY, 'io.tayet.web')
    await gw.disableDeviceNotifications()
    expect(client.removePusher).toHaveBeenCalledTimes(1)
  })

  it('with nothing registered in this session, resolves without a request', async () => {
    const { client } = fakeClient([existing()])
    await connected(client).disableDeviceNotifications()
    expect(client.removePusher).not.toHaveBeenCalled()
    expect(client.http.authedRequest).not.toHaveBeenCalled()
    // Not even connected.
    await new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' }).disableDeviceNotifications()
  })
})

describe('signOut and the subscription', () => {
  it('the bound is the revocation bound', () => {
    expect(PUSH_OFF_BOUND_MS).toBe(REVOKE_BOUND_MS)
  })

  it('removes the subscription before the disconnect', async () => {
    const { client, order } = fakeClient()
    const gw = connected(client)
    await gw.enableDeviceNotifications(SUB)
    await gw.signOut()
    expect(order).toEqual(['GET /pushers', 'setPusher', 'removePusher', 'stopClient'])
  })

  it('a removal that never answers does not hold the sign-out past the bound', async () => {
    const { client, order } = fakeClient()
    const gw = connected(client)
    await gw.enableDeviceNotifications(SUB)
    client.removePusher.mockImplementationOnce(() => new Promise(() => {}))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.useFakeTimers()
    let settled = false
    const done = gw.signOut().then(() => (settled = true))
    await vi.advanceTimersByTimeAsync(PUSH_OFF_BOUND_MS - 1)
    expect(order).not.toContain('stopClient')
    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(10_000)
    await done
    expect(settled).toBe(true)
    expect(order).toContain('stopClient')
    expect(warn).toHaveBeenCalledWith('[acl] notifications off timed out')
    warn.mockRestore()
  })

  it('a removal that fails does not hold the sign-out', async () => {
    const { client, order } = fakeClient()
    const gw = connected(client)
    await gw.enableDeviceNotifications(SUB)
    client.removePusher.mockRejectedValueOnce(new Error('down'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await gw.signOut()
    expect(order.at(-1)).toBe('stopClient')
    warn.mockRestore()
  })

  it('a lost session makes no request', async () => {
    const { client } = fakeClient()
    const gw = connected(client)
    await gw.enableDeviceNotifications(SUB)
    Object.assign(gw as unknown as Record<string, unknown>, { sessionLost: true })
    await gw.signOut()
    expect(client.removePusher).not.toHaveBeenCalled()
  })
})
