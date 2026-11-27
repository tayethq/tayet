import { execSync } from 'node:child_process'
import { createECDH, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { DeviceNotificationSubscription } from '../../src/acl'
import { PUSH_URL, REQUIRE_STACK } from './stack-env'

// ADR-117 (PR 3 of the push track): a Web Push subscription made here, as a browser would hand it over
// (PushSubscription.toJSON: an uncompressed P-256 point and a 16-byte secret, unpadded base64url), and a receiver
// in this process standing for the push vendor. The push service reaches it from its container as
// host.docker.internal (the dev-stack allows that destination). Nothing is decrypted: a request reaching the
// receiver is the delivery. Imports nothing from push/ (cross-import gate).

export function fabricatedSubscription(endpoint: string): DeviceNotificationSubscription {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } }
}

export interface PushReceiver {
  // Request paths in arrival order.
  arrivals: string[]
  endpoint: (tag: string) => string
  close: () => Promise<void>
}

export async function startPushReceiver(): Promise<PushReceiver> {
  const arrivals: string[] = []
  const server: Server = createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      arrivals.push(req.url ?? '')
      res.writeHead(201).end()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as AddressInfo).port
  return {
    arrivals,
    endpoint: (tag) => `http://host.docker.internal:${port}/sub/${tag}`,
    close: async () => {
      server.closeAllConnections()
      await new Promise((r) => server.close(r))
    },
  }
}

// Collection-time probe of the push service's health endpoint; with TAYET_REQUIRE_STACK=1 a miss is fatal.
export function pushServiceReachable(): boolean {
  try {
    execSync(`curl -sf -m 3 ${PUSH_URL}/healthz`, { stdio: 'ignore' })
    return true
  } catch {
    if (REQUIRE_STACK) throw new Error(`TAYET_REQUIRE_STACK=1 but the push service is unreachable at ${PUSH_URL}`)
    return false
  }
}
