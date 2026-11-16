// Relaunching the process after a self-reissue (PLANO-AGENTES §0.3.14 item 4). The boot cannot run a
// second time in the same process: node-indexeddb resolves `${cwd}/indexeddb` once, as a singleton, on
// import, and after the wipe its writes go nowhere on disk (the probe of §0.3.14). So the process is
// replaced:
// - `process.execve` (Node ≥ 22.15 on POSIX): same PID, same stdio — the operator's supervisor (systemd,
//   Docker's PID 1, a shell) sees one process that kept running;
// - fallback where it does not exist (Windows; older Node 22): a child with `stdio: 'inherit'`, SIGTERM
//   and SIGINT forwarded to it, and its exit code propagated as this process's.
// The new process gets TAYET_AGENT_ROTATED=1: its boot never rotates again (one rotation per run).
// It starts in the cwd the operator launched in, not the current one: step 8 of the boot chdirs into the
// store, and relative arguments (--store, paths in execArgv) belong to the launch cwd (§8.25, rodada 2).
//
// execve runs no exit handlers. Nothing is lost: log lines are written with fs.writeSync (log.ts), so
// every line of this run is already on fd 1 when this runs; the boot released the lock before.
import { spawn as nodeSpawn } from 'node:child_process'
import { constants } from 'node:os'

export const ROTATED_ENV = 'TAYET_AGENT_ROTATED'

export interface RelaunchPorts {
  execve: ((file: string, args?: readonly string[], env?: NodeJS.ProcessEnv) => never) | undefined
  spawn: typeof nodeSpawn
  execPath: string
  execArgv: readonly string[]
  argv: readonly string[]
  env: NodeJS.ProcessEnv
  exit: (code: number) => never
  onSignal: (signal: NodeJS.Signals, listener: () => void) => void
  // The launch cwd (cli.ts captures it before anything of the daemon runs) and how to go back to it.
  cwd: string
  chdir: (dir: string) => void
}

const defaultPorts = (cwd: string): RelaunchPorts => ({
  execve: typeof process.execve === 'function' ? process.execve.bind(process) : undefined,
  spawn: nodeSpawn,
  execPath: process.execPath,
  execArgv: process.execArgv,
  argv: process.argv,
  env: process.env,
  exit: (code) => process.exit(code),
  onSignal: (signal, listener) => void process.on(signal, listener),
  cwd,
  chdir: (dir) => process.chdir(dir),
})

export function relaunch(launchCwd: string, ports: RelaunchPorts = defaultPorts(launchCwd)): Promise<never> {
  const args = [...ports.execArgv, ...ports.argv.slice(1)]
  const env = { ...ports.env, [ROTATED_ENV]: '1' }
  if (ports.execve !== undefined) {
    ports.chdir(ports.cwd)
    ports.execve(ports.execPath, [ports.execPath, ...args], env)
  }
  return new Promise<never>(() => {
    const child = ports.spawn(ports.execPath, args, { stdio: 'inherit', env, cwd: ports.cwd })
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      ports.onSignal(signal, () => {
        if (child.exitCode === null) child.kill(signal)
      })
    }
    child.on('exit', (code, signal) => {
      ports.exit(code ?? (signal !== null ? 128 + (constants.signals[signal] ?? 0) : 1))
    })
    child.on('error', () => ports.exit(1))
  })
}
