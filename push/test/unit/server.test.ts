import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createECDH } from 'node:crypto'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { vapidKeys } from '../../src/crypto.ts'
import { parseAllowed } from '../../src/endpoints.ts'
import { createPushServer, loadConfig } from '../../src/server.ts'
import { topicOf } from '../../src/send.ts'
import { decrypt, makeSubscription, verifyVapid } from '../support/webpush.ts'

// A local fake push service: records what it receives and answers with `status`.
let vendor: Server
let vendorPort: number
let status = 201
let received: Array<{ url: string; headers: IncomingHttpHeaders; body: Buffer }> = []

const kp = createECDH('prime256v1')
kp.generateKeys()
const PUB = kp.getPublicKey('base64url')
const config = {
  vapid: { privateKey: vapidKeys(kp.getPrivateKey('base64url'), PUB), publicKey: PUB, subject: 'https://chat.example.org' },
  allowed: parseAllowed(['fcm.googleapis.com', 'http://localhost']),
}

let logs: string[] = []
let push: Server
let base: string

async function listen(s: Server): Promise<number> {
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  return (s.address() as AddressInfo).port
}

beforeAll(async () => {
  vendor = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      received.push({ url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) })
      if (status === 302) res.writeHead(302, { location: 'http://evil.example/' }).end()
      else res.writeHead(status).end()
    })
  })
  vendorPort = await listen(vendor)
  push = createPushServer(config, { log: (l) => logs.push(l) })
  base = `http://127.0.0.1:${await listen(push)}`
})

afterAll(async () => {
  push.closeAllConnections()
  vendor.closeAllConnections()
  await new Promise((r) => push.close(r))
  await new Promise((r) => vendor.close(r))
})

beforeEach(() => {
  status = 201
  received = []
  logs = []
})

const sub = makeSubscription()
const device = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  app_id: 'app',
  pushkey: sub.p256dh,
  data: { endpoint: `http://localhost:${vendorPort}/sub/secret-token`, auth: sub.auth },
  tweaks: { 'io.tayet.push': 'direct' },
  ...over,
})
const notify = async (notification: Record<string, unknown>): Promise<{ status: number; body: unknown }> => {
  const res = await fetch(`${base}/_matrix/push/v1/notify`, { method: 'POST', body: JSON.stringify({ notification }) })
  return { status: res.status, body: await res.json() }
}
const marked = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  event_id: '$e1',
  room_id: '!room:example.org',
  type: 'm.room.encrypted',
  sender: '@ana:example.org',
  sender_display_name: 'Ana',
  content: { ciphertext: 'secret-ciphertext', algorithm: 'm.megolm.v1.aes-sha2' },
  counts: { unread: 1 },
  devices: [device()],
  ...over,
})

describe('routes', () => {
  it('healthz', async () => {
    const res = await fetch(`${base}/healthz`)
    expect(res.status).toBe(200)
  })
  it('anything else is 404', async () => {
    expect((await fetch(`${base}/`)).status).toBe(404)
    expect((await fetch(`${base}/_matrix/push/v1/notify`)).status).toBe(404)
    expect((await fetch(`${base}/_matrix/push/v1/other`, { method: 'POST', body: '{}' })).status).toBe(404)
  })
  it('a body that is not a notification is 400', async () => {
    expect((await fetch(`${base}/_matrix/push/v1/notify`, { method: 'POST', body: 'nope' })).status).toBe(400)
    expect((await fetch(`${base}/_matrix/push/v1/notify`, { method: 'POST', body: '{}' })).status).toBe(400)
  })
})

describe('delivery', () => {
  it('sends the encrypted payload with the Web Push headers', async () => {
    expect(await notify(marked())).toEqual({ status: 200, body: { rejected: [] } })
    expect(received).toHaveLength(1)
    const r = received[0]!
    expect(r.url).toBe('/sub/secret-token')
    expect(r.headers['content-encoding']).toBe('aes128gcm')
    expect(r.headers.ttl).toBe('259200')
    expect(r.headers.urgency).toBe('normal')
    expect(r.headers.topic).toBe(topicOf(Buffer.from(sub.auth, 'base64url'), '!room:example.org'))
    expect(r.headers.topic).toMatch(/^[A-Za-z0-9_-]{32}$/)
    const claims = verifyVapid(r.headers.authorization, PUB)
    expect(claims.aud).toBe(`http://localhost:${vendorPort}`)
    expect(claims.sub).toBe('https://chat.example.org')
    const payload = decrypt(r.body, sub).toString()
    expect(JSON.parse(payload)).toEqual({ v: 1, kind: 'direct', invite: false, conversation: '!room:example.org', message: '$e1', author: 'Ana' })
    expect(payload).not.toContain('ciphertext')
    expect(payload).not.toContain('@ana')
  })

  it('prio high is Urgency high', async () => {
    await notify(marked({ prio: 'high' }))
    expect(received[0]!.headers.urgency).toBe('high')
  })

  it('a dropped notification sends nothing', async () => {
    expect(await notify(marked({ devices: [device({ tweaks: {} })] }))).toEqual({ status: 200, body: { rejected: [] } })
    expect(await notify({ room_id: '!r', counts: { unread: 0 }, devices: [device()] })).toEqual({ status: 200, body: { rejected: [] } })
    expect(received).toHaveLength(0)
  })

  it('an endpoint outside the list, or a malformed subscription, is rejected without sending', async () => {
    const bad = [
      device({ data: { endpoint: 'https://evil.example/x', auth: sub.auth } }),
      device({ data: { endpoint: `http://localhost:${vendorPort}/x` } }),
      device({ data: { endpoint: `http://localhost:${vendorPort}/x`, auth: 'short' } }),
      device({ pushkey: 'bad+b64' }),
      device({ pushkey: Buffer.alloc(65, 4).toString('base64url') }),
    ]
    for (const d of bad) {
      expect(await notify(marked({ devices: [d] }))).toEqual({ status: 200, body: { rejected: [d.pushkey] } })
    }
    expect(received).toHaveLength(0)
  })
})

describe('the push service answer', () => {
  const rows: Array<[number, number, string[]]> = [
    [201, 200, []],
    [204, 200, []],
    [404, 200, ['key']],
    [410, 200, ['key']],
    [429, 502, []],
    [500, 502, []],
    [503, 502, []],
    [400, 200, []],
    [401, 200, []],
    [403, 200, []],
    [413, 200, []],
    [302, 200, []],
  ]
  for (const [vendorStatus, want, rejected] of rows) {
    it(`${vendorStatus} → ${want}${rejected.length ? ' with the pushkey rejected' : ''}`, async () => {
      status = vendorStatus
      const res = await notify(marked())
      expect(res.status).toBe(want)
      if (want === 200) expect(res.body).toEqual({ rejected: rejected.map(() => sub.p256dh) })
      expect(received).toHaveLength(1)
    })
  }

  it('an error status logs the status and host, never the endpoint', async () => {
    status = 403
    await notify(marked())
    expect(logs).toHaveLength(1)
    expect(logs[0]).toContain('403')
    expect(logs[0]).toContain('localhost')
    expect(logs[0]).not.toContain('secret-token')
  })

  it('a network error is 502', async () => {
    const d = device({ data: { endpoint: 'http://localhost:1/x', auth: sub.auth } })
    expect((await notify(marked({ devices: [d] }))).status).toBe(502)
  })

  it('a timeout is 502', async () => {
    const timeout: typeof fetch = () => Promise.reject(new DOMException('timed out', 'TimeoutError'))
    const s = createPushServer(config, { fetch: timeout, log: () => {} })
    const port = await listen(s)
    const res = await fetch(`http://127.0.0.1:${port}/_matrix/push/v1/notify`, { method: 'POST', body: JSON.stringify({ notification: marked() }) })
    expect(res.status).toBe(502)
    s.close()
  })
})

describe('config', () => {
  const env = {
    PUSH_VAPID_PRIVATE_KEY: kp.getPrivateKey('base64url'),
    PUSH_VAPID_PUBLIC_KEY: PUB,
    PUSH_VAPID_SUBJECT: 'https://chat.example.org',
  }
  it('names the missing variable', () => {
    for (const name of Object.keys(env)) {
      expect(() => loadConfig({ ...env, [name]: undefined })).toThrow(`missing env: ${name}`)
    }
  })
  it('refuses a bad subject, list or key pair', () => {
    expect(() => loadConfig({ ...env, PUSH_VAPID_SUBJECT: 'chat.example.org' })).toThrow('PUSH_VAPID_SUBJECT')
    expect(() => loadConfig({ ...env, PUSH_ALLOWED_ENDPOINTS: 'https://x.example' })).toThrow('PUSH_ALLOWED_ENDPOINTS')
    expect(() => loadConfig({ ...env, PUSH_VAPID_PUBLIC_KEY: makeSubscription().p256dh })).toThrow('PUSH_VAPID_PUBLIC_KEY')
  })
  it('defaults to the vendor list', () => {
    const c = loadConfig(env)
    expect(c.allowed.map((r) => r.host)).toEqual(['fcm.googleapis.com', 'push.apple.com', 'updates.push.services.mozilla.com', 'notify.windows.com'])
    expect(c.bind).toBe('127.0.0.1')
  })
})
