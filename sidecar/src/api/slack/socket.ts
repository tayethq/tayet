// The emulated Socket Mode (ADR-087 dec. 5; PLANO-AGENTES §0.3.12 items 5, 10, 11, S-f2; §0.3.3 item 6):
// the event transport of the Slack layer (the approval card's clicks leave over HTTP instead when
// `--slack-actions-url` is set, slack/http-actions.ts). A Slack SDK in Socket Mode calls apps.connections.open
// (slack/connections.ts), then opens the `ws://…/slack/socket?ticket=…` it got, on this same listener.
//
// The upgrade, in the native order (api/server.ts answers the first three):
//   1. Host — the listen address; a Host with NO port is accepted only on this route and only when its
//      hostname is loopback and is the listener's own (§0.3.12 item 5) → otherwise 421;
//   2. Origin present → 403 (a web page is never a client; the Python `websocket-client` adapter sends
//      one and is not supported — README);
//   3. revoked → 503;
//   4. the ticket — absent, malformed, expired or already spent → 401.
// A refusal is one short HTTP status line written on the socket, then the socket is destroyed.
//
// On the socket (§0.3.3 item 6; P-S3 adj. 6):
// - `hello` right after the upgrade (`num_connections`, `debug_info.host`, `connection_info.app_id` = the
//   agent's `B…`); the SDK reads only `type`, the shape is Slack's;
// - a WebSocket ping every 10 s from the server (the SDK's watchdog cuts after 30 s without one); every
//   ping of the client is answered with a pong (ws does it); no pong of the client for 30 s → the
//   connection is cut and cleaned up.
// - envelopes (slack/envelopes.ts): one per open connection, each with its own `envelope_id` and ack; the
//   frames a client sends are its acks;
// - the layer's bus consumer (A3-4, slack/router.ts): the first connection that opens (0 → 1), right after
//   its `hello`, makes the layer a consumer of the bus (`onFirstOpen`); the last one that closes (→ 0) ends
//   it (`onLastClose`) — from then on an `approval.answered` is kept by the bus for the next consumer. With
//   the clicks over HTTP the layer is a consumer from the start and stays one; the hooks change nothing.
// - `disconnect` then close: `refresh_requested` on a clean shutdown (the SDK reopens with a new ticket),
//   `link_disabled` on the revocation (from then on apps.connections.open answers `token_revoked` and
//   the upgrade 503). A client that does not close within 1 s is cut.
// Every frame that goes out passes the Slack edge (slack/edge.ts) first: a finding → the frame is not
// sent, one `leak-blocked` line. The clock is injectable (unit tests).
//
// `ws` in `noServer` mode: no listener of its own, no per-message deflate, a small frame limit (what a
// client sends is acks). Nothing here logs a protocol id, a ticket or a token.
import { STATUS_CODES, type IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { logLeaks } from '../edge'
import type { SocketTickets } from './connections'
import type { SlackDisconnect, SlackEnvelope, SlackHello } from './contract'
import { scanSlack } from './edge'
import { createEnvelopeDispatcher, type AckOutcome, type EnvelopeDispatcher, type EnvelopeTarget, type EnvelopeTiming } from './envelopes'

type Log = (line: Record<string, unknown>) => void

// What a client may send in one frame: an ack, with the response payload of an interactive envelope (A3-4:
// read and ignored, `ack-payload-ignored`).
export const SOCKET_MAX_PAYLOAD = 256 * 1024

// One short status line, then the socket is gone (what the client sent is never read).
export function refuseUpgrade(socket: Duplex, status: number): void {
  socket.on('error', () => {})
  socket.once('finish', () => socket.destroy())
  socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

export const SOCKET_PING_MS = 10_000
export const SOCKET_PONG_TIMEOUT_MS = 30_000
export const SOCKET_DEBUG_HOST = 'tayet-agent'
export const SOCKET_CLOSE_GRACE_MS = 1_000

// The timers of the socket layer, injectable for the unit tests.
export interface SocketClock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

export const SYSTEM_CLOCK: SocketClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
}

// The tunables of the socket (tests shorten or drive them).
export interface SocketOptions {
  clock?: SocketClock
  pingMs?: number
  pongTimeoutMs?: number
  ackTimeoutMs?: number
}

export interface SocketHubOptions extends SocketOptions {
  tickets: SocketTickets
  log: Log
  // The agent's `B…` (`connection_info.app_id`, the envelopes' `api_app_id`).
  appId: () => string
  // 0 → 1 open connections, after the first `hello` (A3-4: the layer opens its bus consumer).
  onFirstOpen?: () => void
  // → 0 open connections (A3-4: the layer closes its bus consumer).
  onLastClose?: () => void
}

export interface SocketHub {
  // After Host → Origin → revoked (api/server.ts): the ticket, then the WebSocket.
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): void
  readonly connections: number
  // The envelope kinds and their acks (A3 registers its own kind here).
  readonly envelopes: EnvelopeDispatcher
  // One envelope to every open connection (each with its own id and ack); `timing` as in the dispatcher.
  broadcast(type: string, payload: Record<string, unknown>, timing?: EnvelopeTiming): Array<{ id: string; outcome: Promise<AckOutcome> }>
  // The revocation: `link_disabled` to every socket, then they close; no ticket is valid any more.
  revoke(): Promise<void>
  // Clean shutdown: `refresh_requested` to every socket, then they close.
  close(): Promise<void>
}

interface Conn {
  ws: WebSocket
  lastPong: number
  ping: unknown
  reason: string
  target: EnvelopeTarget
}

export function createSocketHub(opts: SocketHubOptions): SocketHub {
  const log = opts.log
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: SOCKET_MAX_PAYLOAD, clientTracking: false })
  const conns = new Set<Conn>()
  const clock = opts.clock ?? SYSTEM_CLOCK
  const pingMs = opts.pingMs ?? SOCKET_PING_MS
  const pongTimeoutMs = opts.pongTimeoutMs ?? SOCKET_PONG_TIMEOUT_MS
  const envelopes = createEnvelopeDispatcher({ log, timers: clock, ...(opts.ackTimeoutMs !== undefined && { ackTimeoutMs: opts.ackTimeoutMs }) })

  // Every outgoing frame through the Slack edge; false when it was not sent.
  const wire = (conn: Conn, frame: object, where: string): boolean => {
    const leaks = scanSlack(frame)
    if (leaks.length > 0) {
      logLeaks(log, `slack socket ${where}`, leaks)
      return false
    }
    if (conn.ws.readyState !== conn.ws.OPEN) return false
    conn.ws.send(JSON.stringify(frame))
    return true
  }

  const cut = (conn: Conn, reason: string): void => {
    conn.reason = reason
    conn.ws.terminate()
  }

  // `disconnect`, then the close; a socket still open after the grace is cut.
  const disconnectAll = async (reason: SlackDisconnect['reason']): Promise<void> => {
    opts.tickets.clear()
    const frame: SlackDisconnect = { type: 'disconnect', reason, debug_info: { host: SOCKET_DEBUG_HOST } }
    const closing = [...conns].map(
      (c) =>
        new Promise<void>((resolve) => {
          if (c.ws.readyState === c.ws.CLOSED) return resolve()
          c.ws.once('close', () => resolve())
          c.reason = reason
          wire(c, frame, 'disconnect')
          c.ws.close(1000)
          setTimeout(() => cut(c, reason), SOCKET_CLOSE_GRACE_MS).unref()
        }),
    )
    await Promise.all(closing)
  }

  const open = (ws: WebSocket): void => {
    const conn: Conn = { ws, lastPong: clock.now(), ping: undefined, reason: 'client', target: { send: (frame: SlackEnvelope) => wire(conn, frame, 'envelope') } }
    conns.add(conn)
    log({ evt: 'socket-open', connections: conns.size })
    ws.on('error', () => {})
    ws.on('pong', () => {
      conn.lastPong = clock.now()
    })
    ws.on('message', (data, isBinary) => envelopes.ack(isBinary ? null : (data as Buffer).toString('utf8')))
    ws.on('close', () => {
      clock.clearInterval(conn.ping)
      envelopes.drop(conn.target)
      if (!conns.delete(conn)) return
      log({ evt: 'socket-close', connections: conns.size, reason: conn.reason })
      if (conns.size === 0) opts.onLastClose?.()
    })
    conn.ping = clock.setInterval(() => {
      if (clock.now() - conn.lastPong >= pongTimeoutMs) return cut(conn, 'pong-timeout')
      ws.ping()
    }, pingMs)
    const hello: SlackHello = { type: 'hello', num_connections: conns.size, debug_info: { host: SOCKET_DEBUG_HOST }, connection_info: { app_id: opts.appId() } }
    wire(conn, hello, 'hello')
    if (conns.size === 1) opts.onFirstOpen?.()
  }

  return {
    get connections() {
      return conns.size
    },

    envelopes,

    broadcast: (type, payload, timing) => [...conns].map((c) => envelopes.dispatch(c.target, type, payload, timing)),

    upgrade(req, socket, head, url) {
      if (!opts.tickets.spend(url.searchParams.get('ticket'))) return refuseUpgrade(socket, 401)
      wss.handleUpgrade(req, socket, head, open)
    },

    revoke: () => disconnectAll('link_disabled'),

    async close() {
      await disconnectAll('refresh_requested')
      wss.close()
    },
  }
}
