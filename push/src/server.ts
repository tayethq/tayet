// HTTP entry point: the homeserver posts each push notification to /_matrix/push/v1/notify (Push
// Gateway API); the service answers with the pushkeys to delete in `rejected`, or 502 to have the
// homeserver retry with backoff. No state on disk.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { pathToFileURL } from 'node:url'
import { VapidCache, vapidKeys, type Vapid } from './crypto.ts'
import { DEFAULT_ALLOWED, parseAllowed } from './endpoints.ts'
import { buildPayload, decide, serialize, type Device, type Notification } from './filter.ts'
import { deliver, subscriptionOf, type SendDeps } from './send.ts'

// A notification is about 1 KiB (measured up to 1031 bytes); anything far larger is not one.
const MAX_REQUEST_BYTES = 64 * 1024

export interface Config {
  vapid: Vapid
  allowed: ReturnType<typeof parseAllowed>
}

export interface Deps {
  fetch?: typeof fetch
  log?: (line: string) => void
  now?: () => number
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > MAX_REQUEST_BYTES) throw new Error('too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

export function createPushServer(config: Config, deps: Deps = {}): Server {
  const sendDeps: SendDeps = { vapid: new VapidCache(config.vapid, deps.now), fetch: deps.fetch, log: deps.log }

  async function notify(n: Notification): Promise<{ status: number; rejected: string[] }> {
    const devices = Array.isArray(n.devices) ? (n.devices as Device[]) : []
    const rejected: string[] = []
    let retry = false
    for (const raw of devices) {
      const d: Device = typeof raw === 'object' && raw !== null ? raw : {}
      const verdict = decide(n, d)
      if (!verdict) continue
      const sub = subscriptionOf(config.allowed, d.pushkey, d.data)
      if (!sub) {
        if (typeof d.pushkey === 'string') rejected.push(d.pushkey)
        continue
      }
      const payload = serialize(buildPayload(n, verdict.kind, verdict.invite))
      if (!payload) {
        ;(deps.log ?? console.error)(JSON.stringify({ evt: 'push-payload-too-large' }))
        continue
      }
      const outcome = await deliver(sendDeps, sub, payload, { urgent: n.prio === 'high', conversation: typeof n.room_id === 'string' ? n.room_id : '' })
      if (outcome === 'gone' || outcome === 'invalid') rejected.push(d.pushkey as string)
      else if (outcome === 'retry') retry = true
    }
    return { status: retry ? 502 : 200, rejected }
  }

  return createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://push.invalid').pathname
    if (req.method === 'GET' && path === '/healthz') {
      send(res, 200, { ok: true })
      return
    }
    if (req.method !== 'POST' || path !== '/_matrix/push/v1/notify') {
      send(res, 404, { errcode: 'M_UNRECOGNIZED' })
      return
    }
    readBody(req)
      .then(async (body) => {
        const n = (body as { notification?: unknown } | null)?.notification
        if (typeof n !== 'object' || n === null) {
          send(res, 400, { errcode: 'M_BAD_JSON' })
          return
        }
        const { status, rejected } = await notify(n)
        send(res, status, status === 200 ? { rejected } : { errcode: 'M_UNKNOWN' })
      })
      .catch(() => {
        if (!res.headersSent) send(res, 400, { errcode: 'M_BAD_JSON' })
      })
  })
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (value === undefined || value === '') throw new Error(`missing env: ${name}`)
  return value
}

// Every PUSH_* variable, checked before listening; the error names the variable.
export function loadConfig(env: NodeJS.ProcessEnv): Config & { port: number; bind: string } {
  const privateKey = required(env, 'PUSH_VAPID_PRIVATE_KEY')
  const publicKey = required(env, 'PUSH_VAPID_PUBLIC_KEY')
  const subject = required(env, 'PUSH_VAPID_SUBJECT')
  let key
  try {
    key = vapidKeys(privateKey, publicKey)
  } catch (err) {
    throw new Error(`invalid env: PUSH_VAPID_PRIVATE_KEY / PUSH_VAPID_PUBLIC_KEY (${(err as Error).message})`, { cause: err })
  }
  if (!/^(https:\/\/|mailto:)\S+$/.test(subject)) throw new Error('invalid env: PUSH_VAPID_SUBJECT (https: or mailto: URL)')
  const list = env.PUSH_ALLOWED_ENDPOINTS
  let allowed
  try {
    allowed = parseAllowed(list === undefined || list === '' ? DEFAULT_ALLOWED : list.split(','))
  } catch (err) {
    throw new Error(`invalid env: PUSH_ALLOWED_ENDPOINTS (${(err as Error).message})`, { cause: err })
  }
  const port = Number(env.PUSH_PORT ?? '0')
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('invalid env: PUSH_PORT')
  return { vapid: { privateKey: key, publicKey, subject }, allowed, port, bind: env.PUSH_BIND ?? '127.0.0.1' }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  let config
  try {
    config = loadConfig(process.env)
  } catch (err) {
    console.error(`push: ${(err as Error).message}`)
    process.exit(1)
  }
  const server = createPushServer(config)
  server.listen(config.port, config.bind, () => {
    console.log(JSON.stringify({ listening: (server.address() as AddressInfo).port }))
  })
  // As PID 1 in the container, node ignores SIGTERM without a handler and Docker kills it at the end
  // of the grace period. close() stops accepting, closes idle connections and waits for the requests
  // in flight; past the cap (below the compose stop_grace_period) the rest is cut. An undelivered
  // notification is retried by the homeserver, so exit 0 either way.
  const SHUTDOWN_CAP_MS = 5_000
  let shuttingDown = false
  const shutdown = (signal: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(JSON.stringify({ evt: 'shutdown', signal }))
    const cap = setTimeout(() => {
      console.log(JSON.stringify({ evt: 'shutdown-cap', capMs: SHUTDOWN_CAP_MS }))
      server.closeAllConnections()
    }, SHUTDOWN_CAP_MS)
    server.close(() => {
      clearTimeout(cap)
      process.exit(0)
    })
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}
