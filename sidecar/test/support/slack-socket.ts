// Raw Socket Mode clients for the Slack layer's unit tests (no Bolt): the `ws` client, with the headers a
// test needs (Host, Origin), and the frames it received.
import WebSocket from 'ws'
import type { SocketClock } from '../../src/api/slack/socket'
import { call, type SlackHarness } from './slack-world'

export type Frame = Record<string, unknown>

export interface RawSocket {
  ws: WebSocket
  frames: Frame[]
  // Resolves with the first frame (already received or not) that matches.
  next(match: (f: Frame) => boolean, timeoutMs?: number): Promise<Frame>
  send(v: unknown): void
  closed: Promise<{ code: number }>
}

// A fresh `ws://…/slack/socket?ticket=…` through apps.connections.open.
export async function socketUrl(h: SlackHarness): Promise<string> {
  return (await call(h.client(), 'apps.connections.open')).url as string
}

// The upgrade's outcome: an open socket, or the HTTP status of the refusal.
export function connect(url: string, opts: { headers?: Record<string, string>; origin?: string; autoPong?: boolean } = {}): Promise<RawSocket | { status: number }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: opts.headers, autoPong: opts.autoPong ?? true, ...(opts.origin !== undefined && { origin: opts.origin }) })
    const frames: Frame[] = []
    const waiters = new Set<{ match: (f: Frame) => boolean; resolve: (f: Frame) => void }>()
    ws.on('message', (data) => {
      const f = JSON.parse((data as Buffer).toString('utf8')) as Frame
      frames.push(f)
      for (const w of [...waiters]) {
        if (w.match(f)) {
          waiters.delete(w)
          w.resolve(f)
        }
      }
    })
    const closed = new Promise<{ code: number }>((r) => ws.once('close', (code) => r({ code })))
    ws.once('unexpected-response', (_req, res) => {
      resolve({ status: res.statusCode ?? 0 })
      ws.terminate()
    })
    ws.once('error', (err) => {
      // A socket destroyed after the status line can also surface as an error first.
      if (ws.readyState !== WebSocket.OPEN) reject(err)
    })
    ws.once('open', () =>
      resolve({
        ws,
        frames,
        closed,
        send: (v) => ws.send(JSON.stringify(v)),
        next: (match, timeoutMs = 5_000) => {
          const seen = frames.find(match)
          if (seen !== undefined) return Promise.resolve(seen)
          return new Promise((res, rej) => {
            const w = { match, resolve: (f: Frame) => (clearTimeout(t), res(f)) }
            const t = setTimeout(() => (waiters.delete(w), rej(new Error('no matching frame'))), timeoutMs)
            waiters.add(w)
          })
        },
      }),
    )
  })
}

export const isOpen = (r: RawSocket | { status: number }): r is RawSocket => 'ws' in r

export async function open(h: SlackHarness, opts: Parameters<typeof connect>[1] = {}): Promise<RawSocket> {
  const r = await connect(await socketUrl(h), opts)
  if (!isOpen(r)) throw new Error(`upgrade refused: ${r.status}`)
  return r
}

// A clock the test drives: timers fire only on `advance`, in time order.
export interface ManualClock extends SocketClock {
  advance(ms: number): void
}

export function manualClock(start = 1_000_000): ManualClock {
  let now = start
  let next = 1
  const timers = new Map<number, { at: number; every?: number; fn: () => void }>()
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = next++
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimeout: (h) => void timers.delete(h as number),
    setInterval: (fn, ms) => {
      const id = next++
      timers.set(id, { at: now + ms, every: ms, fn })
      return id
    },
    clearInterval: (h) => void timers.delete(h as number),
    advance(ms) {
      const end = now + ms
      for (;;) {
        let due: [number, { at: number; every?: number; fn: () => void }] | undefined
        for (const e of timers) if (e[1].at <= end && (due === undefined || e[1].at < due[1].at)) due = e
        if (due === undefined) break
        const [id, t] = due
        now = t.at
        if (t.every !== undefined) t.at += t.every
        else timers.delete(id)
        t.fn()
      }
      now = end
    },
  }
}
