// Spawns the built sidecar (dist/cli.js, built by `pretest`) and collects its JSON log lines,
// stderr and exit code. The same harness serves the unit tests (fake server) and the integration
// tests (the stack).
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SIDECAR_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ROOT = SIDECAR_ROOT
export const DIST_CLI = join(ROOT, 'dist', 'cli.js')
export const COUNT_HOOK = join(ROOT, 'test', 'support', 'count-hook.mjs')

export interface SidecarProcess {
  child: ChildProcess
  lines: Array<Record<string, unknown>>
  stdout: () => string
  stderr: () => string
  exited: Promise<number | null>
  waitFor: (pred: (line: Record<string, unknown>) => boolean, timeoutMs?: number) => Promise<Record<string, unknown>>
  stop: (signal?: NodeJS.Signals) => Promise<number | null>
}

// The product binary is the only way in: its local API (S-c). The test-only core entry of S-b2 is
// gone (§0.3.7 item 10).
export function startSidecar(args: string[], opts: { nodeArgs?: string[]; env?: NodeJS.ProcessEnv; cwd?: string } = {}): SidecarProcess {
  if (!existsSync(DIST_CLI)) throw new Error(`${DIST_CLI} missing: run npm run build (pretest)`)
  // The product binary listens on 127.0.0.1:7878 by default; tests run in parallel, so each spawn of
  // it gets an ephemeral port unless the test chose one (S-c1).
  const listen = !args.includes('--listen') && !args.includes('--help') ? ['--listen', '127.0.0.1:0'] : []
  const child = spawn(process.execPath, [...(opts.nodeArgs ?? []), DIST_CLI, ...args, ...listen], {
    env: { ...process.env, ...opts.env },
    ...(opts.cwd !== undefined && { cwd: opts.cwd }),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let out = ''
  let err = ''
  const lines: Array<Record<string, unknown>> = []
  const waiters = new Set<() => void>()
  let buffer = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    out += chunk
    buffer += chunk
    let nl
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const raw = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      try {
        lines.push(JSON.parse(raw) as Record<string, unknown>)
      } catch {
        // --help prints plain text; not a log line.
      }
    }
    for (const w of waiters) w()
  })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    err += chunk
  })
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => {
    for (const w of waiters) w()
    resolve(code)
  }))

  const waitFor: SidecarProcess['waitFor'] = (pred, timeoutMs = 30_000) =>
    new Promise((resolve, reject) => {
      const check = (): void => {
        const hit = lines.find(pred)
        if (hit !== undefined) {
          done()
          resolve(hit)
        } else if (child.exitCode !== null) {
          done()
          reject(new Error(`sidecar exited ${child.exitCode} before the expected line; log:\n${out}\nstderr:\n${err}`))
        }
      }
      const timer = setTimeout(() => {
        done()
        reject(new Error(`timeout waiting for a log line; log:\n${out}\nstderr:\n${err}`))
      }, timeoutMs)
      const done = (): void => {
        clearTimeout(timer)
        waiters.delete(check)
      }
      waiters.add(check)
      check()
    })

  return {
    child,
    lines,
    stdout: () => out,
    stderr: () => err,
    exited,
    waitFor,
    stop: async (signal = 'SIGTERM') => {
      if (child.exitCode === null) child.kill(signal)
      return exited
    },
  }
}

export const evt = (name: string) => (line: Record<string, unknown>): boolean => line.evt === name
