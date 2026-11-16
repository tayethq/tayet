// Escrow spawn harness for the C2 integration gate (PLANO-FASE-2-ESCROW-C2 §0.6 / PF-4):
// the same machinery the C1 gate proved (escrow/test/integration — PF-3 daquele PLANO):
// child process via `node --experimental-strip-types`, port 0 + stdout readback, /healthz
// poll, best-effort teardown. Duplicated knowingly from the C1 harness (same gatilho de
// extração: um terceiro consumidor); the C2 additions are kill/respawn on a FIXED port for
// the P4 assert (escrow down → up → retry recovers).

import { execSync, spawn, type ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { MAS_CONFIG, MAS_CONTAINER, MAS_URL } from './stack-env'

export { MAS_URL }
// Throwaway introspection client from infra/dev-stack/mas/config.yaml (C1 §3.7) — README class.
export const CLIENT_ID = '00000000000000000000ESCR0W'
export const CLIENT_SECRET = 'tayet-dev-stack-throwaway-escrow-introspection'

export interface EscrowProcess {
  base: string
  port: number
  storeDir: string
  kill(): Promise<void>
}

// Resolvido a partir do root do vitest (client/) — import.meta.url não é file: sob jsdom.
const SERVER_PATH = resolve(process.cwd(), '../escrow/src/server.ts')

// Spawns the real escrow service. `port` 0 (default) lets the kernel pick; passing the previous
// port (and the same storeDir) is the respawn path of the P4 assert — same URL, same secrets.
export async function spawnEscrow(storeDir: string, orgKeyB64: string, port = 0): Promise<EscrowProcess> {
  const child: ChildProcess = spawn(process.execPath, ['--experimental-strip-types', SERVER_PATH], {
    env: {
      ...process.env,
      ESCROW_PORT: String(port),
      ESCROW_STORE_DIR: storeDir,
      ESCROW_ORG_KEY: orgKeyB64,
      ESCROW_INTROSPECTION_URL: `${MAS_URL}/oauth2/introspect`,
      ESCROW_CLIENT_ID: CLIENT_ID,
      ESCROW_CLIENT_SECRET: CLIENT_SECRET,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  const boundPort = await new Promise<number>((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error('escrow did not report a port')), 15_000)
    child.stdout!.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const line = buffer.split('\n')[0]
      if (buffer.includes('\n') && line) {
        clearTimeout(timer)
        resolve((JSON.parse(line) as { listening: number }).listening)
      }
    })
    child.on('exit', (code) => reject(new Error(`escrow exited early (${code})`)))
  })
  const base = `http://127.0.0.1:${boundPort}`
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).status === 200) break
    } catch {
      /* ainda subindo */
    }
    if (i > 50) throw new Error('escrow /healthz never came up')
    await new Promise((r) => setTimeout(r, 100))
  }
  return {
    base,
    port: boundPort,
    storeDir,
    async kill() {
      // Best-effort, never fails the suite (C1 PF-3 / hygiene #18).
      try {
        if (!child.killed) {
          const gone = new Promise((resolve) => child.once('exit', resolve))
          child.kill('SIGTERM')
          await Promise.race([gone, new Promise((r) => setTimeout(r, 3_000))])
          if (child.exitCode === null) child.kill('SIGKILL')
        }
      } catch {
        /* best-effort */
      }
    },
  }
}

// `ts` sempre existe na linha gravada (jsonlAudit carimba ISO no record) — exposto aqui
// para o dump de mismatch do warm=cold (S3a): o delta impresso nomeia QUANDO cada entrada
// de fundo aterrissou, não só quem/o quê.
export async function readAudit(
  storeDir: string,
): Promise<Array<{ ts?: string; sub?: string; verb: string; outcome: string }>> {
  const raw = await readFile(join(storeDir, 'audit.jsonl'), 'utf8').catch(() => '')
  return raw
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { ts?: string; sub?: string; verb: string; outcome: string })
}

// Per-run virgin MAS users (gate §5.2 "mundo virgem"): the C2 bootstrap asserts need users whose
// 4S/cross-signing/escrow worlds never existed — alice/bob of the shared stack accumulate state
// across runs. register-user is the documented browserless provisioning path (dev-stack README);
// "User already exists" is tolerated for idempotence.
export function registerUser(username: string, password = 'gatepass123'): void {
  try {
    execSync(
      `docker exec ${MAS_CONTAINER} mas-cli manage register-user -c ${MAS_CONFIG} --yes --ignore-password-complexity --password ${password} ${username} 2>&1`,
      { encoding: 'utf8' },
    )
  } catch (err) {
    const out = String((err as { stdout?: unknown }).stdout ?? err)
    if (!out.includes('User already exists')) throw err
  }
}
