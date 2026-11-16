import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The agent sidecar as the operator runs it (PLANO-AGENTES §0.3.9 item 2): the spec reads the command
// the AgentDialog shows and runs exactly its arguments. Only the launcher changes — `npx tayet-agent` →
// `node sidecar/dist/cli.js` (the tarball's npx was proven in S-d) — and two flags are added, declared:
// `--store <tmp>` (one throwaway store per process) and `--listen 127.0.0.1:0` (the runners share a host:
// an ephemeral port, read from the `api-listening` line, S7.2 item 4).
//
// Secrets: the credential and the local token never reach a log line, a report or an attachment. Every
// text this module hands out (stdout, stderr, error messages) goes through `redact` first, which also
// masks protocol user ids (the sidecar's own `whoami` line carries the agent's).

const SIDECAR_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'sidecar')
const DIST_CLI = join(SIDECAR_ROOT, 'dist', 'cli.js')
const LAUNCHER = 'npx tayet-agent'

// The exit code of a revoked agent (sidecar src/exit-codes.ts, EX_CONFIG).
export const EXIT_REVOKED = 78

export interface ApiReply {
  status: number
  json: Record<string, unknown>
}

export interface SseFrame {
  event: string
  data: Record<string, unknown>
}

export interface SidecarRun {
  /** The local API's base URL (loopback, ephemeral port). */
  url: string
  /** A local API call with the local token. */
  call: (method: string, path: string, body?: unknown) => Promise<ApiReply>
  /** `GET /v1/events` with the local token: the frames received so far (comments dropped), and its close. */
  events: () => { frames: SseFrame[]; close: () => void }
  /** First log line matching `pred`, waiting for it. */
  waitFor: (pred: (line: Record<string, unknown>) => boolean, timeoutMs?: number) => Promise<Record<string, unknown>>
  /** The process exit: its code and when it happened (Date.now()). */
  exited: Promise<{ code: number | null; at: number }>
  /** stdout + stderr, secrets redacted. */
  output: () => string
  /** SIGTERM (if still running), then the store is deleted. Idempotent. */
  stop: () => Promise<void>
}

// The arguments of the command the dialog shows, without its launcher. The dialog's command is
// `npx tayet-agent --server <origin> --token <credential>` (§0.3.8 item 1); anything else is refused.
export function commandArgs(command: string): string[] {
  const text = command.trim()
  if (!text.startsWith(`${LAUNCHER} `)) throw new Error('the command shown does not start with the npx launcher')
  return text.slice(LAUNCHER.length).trim().split(/\s+/)
}

export async function startSidecar(command: string, secrets: string[]): Promise<SidecarRun> {
  if (!existsSync(DIST_CLI)) {
    throw new Error('sidecar/dist/cli.js missing: build the sidecar first (cd sidecar && npm run build)')
  }
  const hidden = [...secrets]
  const redact = (text: string): string =>
    hidden.reduce((t, s) => (s.length > 0 ? t.split(s).join('[redacted]') : t), text).replace(/@[a-z0-9._=/+-]+:[A-Za-z0-9.-]+(?::\d+)?/g, '[user]')

  const store = await mkdtemp(join(tmpdir(), 'e2e-agent-sidecar-'))
  const args = [...commandArgs(command), '--store', store, '--listen', '127.0.0.1:0']
  const child: ChildProcess = spawn(process.execPath, [DIST_CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })

  let out = ''
  let err = ''
  let buffer = ''
  const lines: Array<Record<string, unknown>> = []
  const waiters = new Set<() => void>()
  child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
    out += chunk
    buffer += chunk
    let nl
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const raw = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      try {
        lines.push(JSON.parse(raw) as Record<string, unknown>)
      } catch {
        // not a log line
      }
    }
    for (const w of waiters) w()
  })
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
    err += chunk
  })
  const exited = new Promise<{ code: number | null; at: number }>((resolve) =>
    child.on('exit', (code) => {
      const at = Date.now()
      for (const w of waiters) w()
      resolve({ code, at })
    }),
  )
  const output = (): string => redact(`--- stdout\n${out}\n--- stderr\n${err}`)

  const waitFor: SidecarRun['waitFor'] = (pred, timeoutMs = 60_000) =>
    new Promise((resolve, reject) => {
      const check = (): void => {
        const hit = lines.find(pred)
        if (hit !== undefined) {
          done()
          resolve(hit)
        } else if (child.exitCode !== null) {
          done()
          reject(new Error(`sidecar exited ${child.exitCode} before the expected log line`))
        }
      }
      const timer = setTimeout(() => {
        done()
        reject(new Error(`timeout (${timeoutMs} ms) waiting for a sidecar log line`))
      }, timeoutMs)
      const done = (): void => {
        clearTimeout(timer)
        waiters.delete(check)
      }
      waiters.add(check)
      check()
    })

  let stopped = false
  const stop = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))])
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
    await rm(store, { recursive: true, force: true })
  }

  try {
    const listening = await waitFor((l) => l.evt === 'api-listening', 120_000)
    const url = String(listening.url)
    const local = (await readFile(join(store, 'local.token'), 'utf8')).trim()
    hidden.push(local)
    const api = JSON.parse(await readFile(join(store, 'api.json'), 'utf8')) as { url?: string }
    if (api.url !== url) throw new Error('api.json and the api-listening line disagree on the URL')
    const call: SidecarRun['call'] = async (method, path, body) => {
      const res = await fetch(url + path, {
        method,
        headers: { authorization: `Bearer ${local}`, ...(body !== undefined && { 'content-type': 'application/json' }) },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      })
      const text = await res.text()
      const isJson = (res.headers.get('content-type') ?? '').startsWith('application/json')
      return { status: res.status, json: (isJson && text.length > 0 ? JSON.parse(text) : {}) as Record<string, unknown> }
    }
    const events: SidecarRun['events'] = () => {
      const frames: SseFrame[] = []
      const ctrl = new AbortController()
      void (async () => {
        const res = await fetch(`${url}/v1/events`, { headers: { authorization: `Bearer ${local}` }, signal: ctrl.signal })
        const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
        let buf = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buf += value
          let i
          while ((i = buf.indexOf('\n\n')) !== -1) {
            const block = buf.slice(0, i)
            buf = buf.slice(i + 2)
            let event: string | undefined
            let data: Record<string, unknown> | undefined
            for (const line of block.split('\n')) {
              if (line.startsWith('event: ')) event = line.slice(7)
              else if (line.startsWith('data: ')) data = JSON.parse(line.slice(6)) as Record<string, unknown>
            }
            if (event !== undefined && data !== undefined) frames.push({ event, data })
          }
        }
      })().catch(() => {})
      return { frames, close: () => ctrl.abort() }
    }
    return { url, call, events, waitFor, exited, output, stop }
  } catch (e) {
    await stop()
    // The causes raised above (waitFor, the store reads) carry no log text, so no secret.
    throw new Error(redact(`${(e as Error).message}\n${output()}`), { cause: e })
  }
}
