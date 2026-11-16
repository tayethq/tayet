import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  findCredential,
  parseCredential,
  readCredential,
  removeCredential,
  ROTATION_FLOOR_MS,
  seedHash,
  underFloor,
  writeCredential,
} from '../../src/credential'
import { defaultStoreDir, FILES } from '../../src/store'
import { relaunch, type RelaunchPorts } from '../../src/relaunch'
import { EventEmitter } from 'node:events'

// <store>/credential (S-h, PLANO-AGENTES §0.3.14 items 2–3) and the relaunch ports (item 4).

const SERVER = 'https://hs.example.com'
const SEED = 'mpt_seed_DoNotLog_0123456789'
let base: string

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'sidecar-cred-'))
})
afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

const cred = (token: string, seed = SEED, rotatedAt = new Date().toISOString()) => ({ token, seededFrom: seedHash(seed), rotatedAt })

describe('credential file', () => {
  it('written by tmp+rename with mode 0600, read back with its exact bytes; removal', async () => {
    await writeCredential(base, cred('mpt_new_1'))
    expect(((await stat(join(base, FILES.credential))).mode & 0o777).toString(8)).toBe('600')
    const read = await readCredential(base)
    expect(read?.credential).toMatchObject({ token: 'mpt_new_1', seededFrom: seedHash(SEED) })
    expect(read?.raw).toBe(await readFile(join(base, FILES.credential), 'utf8'))
    await removeCredential(base)
    expect(await readCredential(base)).toBeNull()
  })

  it('parse refuses a missing token, a seededFrom that is not sha256 hex, an unparsable instant, non-JSON', () => {
    expect(parseCredential('nope')).toBeNull()
    expect(parseCredential(JSON.stringify({ seededFrom: seedHash(SEED), rotatedAt: new Date().toISOString() }))).toBeNull()
    expect(parseCredential(JSON.stringify({ token: 't', seededFrom: 'abc', rotatedAt: new Date().toISOString() }))).toBeNull()
    expect(parseCredential(JSON.stringify({ token: 't', seededFrom: seedHash(SEED), rotatedAt: 'yesterday' }))).toBeNull()
  })

  it('the floor: under 10 min since rotatedAt', () => {
    const now = Date.parse('2026-11-09T12:00:00Z')
    expect(underFloor(cred('t', SEED, new Date(now - ROTATION_FLOOR_MS + 1000).toISOString()), now)).toBe(true)
    expect(underFloor(cred('t', SEED, new Date(now - ROTATION_FLOOR_MS - 1000).toISOString()), now)).toBe(false)
  })
})

describe('findCredential', () => {
  it('with --store: <store>/credential, only when seeded from this token', async () => {
    await writeCredential(base, cred('mpt_new_1'))
    expect((await findCredential({ store: base, server: SERVER, seed: SEED }))?.credential.token).toBe('mpt_new_1')
    expect(await findCredential({ store: base, server: SERVER, seed: 'mpt_other_seed_0123' })).toBeNull()
  })

  it("without --store: only this server's directories, only the one seeded from this token", async () => {
    const mine = defaultStoreDir(SERVER, 'UAAAAAAAAAA', base)
    const otherAgent = defaultStoreDir(SERVER, 'UBBBBBBBBBB', base)
    const otherServer = defaultStoreDir('https://elsewhere.example.com', 'UCCCCCCCCCC', base)
    for (const d of [mine, otherAgent, otherServer]) await mkdir(d, { recursive: true })
    await writeCredential(mine, cred('mpt_mine'))
    await writeCredential(otherAgent, cred('mpt_other_agent', 'mpt_other_seed_0123'))
    // Same seed but another server: never scanned.
    await writeCredential(otherServer, cred('mpt_other_server'))
    const found = await findCredential({ store: undefined, server: SERVER, seed: SEED, base })
    expect(found?.credential.token).toBe('mpt_mine')
    expect(found?.dir).toBe(mine)
    // A seed with no file of its own: nothing.
    expect(await findCredential({ store: undefined, server: SERVER, seed: 'mpt_unknown_seed_99', base })).toBeNull()
  })

  it('without --store: two directories seeded from the same token → none is taken', async () => {
    const a = defaultStoreDir(SERVER, 'UAAAAAAAAAA', base)
    const b = defaultStoreDir(SERVER, 'UBBBBBBBBBB', base)
    for (const d of [a, b]) await mkdir(d, { recursive: true })
    await writeCredential(a, cred('mpt_a'))
    await writeCredential(b, cred('mpt_b'))
    expect(await findCredential({ store: undefined, server: SERVER, seed: SEED, base })).toBeNull()
  })

  it('without --store and no base directory yet: nothing, no throw', async () => {
    expect(await findCredential({ store: undefined, server: SERVER, seed: SEED, base: join(base, 'missing') })).toBeNull()
  })

  it('an unreadable credential is not taken', async () => {
    await writeFile(join(base, FILES.credential), '{"token":')
    expect(await findCredential({ store: base, server: SERVER, seed: SEED })).toBeNull()
  })
})

describe('relaunch (§0.3.14 item 4)', () => {
  const ports = (over: Partial<RelaunchPorts>) => {
    const calls: Array<{ how: string; file: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = []
    const signals = new Map<string, () => void>()
    const base: RelaunchPorts = {
      execve: undefined,
      spawn: () => {
        throw new Error('spawn not expected')
      },
      execPath: '/usr/bin/node',
      execArgv: ['--import', 'hook.mjs'],
      argv: ['/usr/bin/node', '/opt/tayet-agent/dist/cli.js', '--server', 'https://x', '--store', '/s'],
      env: { PATH: '/bin', TAYET_AGENT_TOKEN: 'mpt_seed' },
      exit: (code: number): never => {
        throw Object.assign(new Error('exit'), { code })
      },
      onSignal: (signal, listener) => void signals.set(signal, listener),
      cwd: '/home/op/agents',
      chdir: (dir: string) => void calls.push({ how: 'chdir', file: dir, args: [], env: {} }),
      ...over,
    }
    return { calls, signals, ports: base }
  }

  it('execve present: the same binary, execArgv and argv, TAYET_AGENT_ROTATED=1 added', () => {
    const t = ports({})
    t.ports.execve = (file: string, args?: readonly string[], env?: NodeJS.ProcessEnv): never => {
      t.calls.push({ how: 'execve', file, args: args ?? [], env: env ?? {} })
      throw new Error('replaced')
    }
    expect(() => relaunch(t.ports.cwd, t.ports)).toThrow('replaced')
    // Back to the launch cwd BEFORE execve (the boot chdirs into the store at step 8).
    expect(t.calls).toEqual([
      { how: 'chdir', file: '/home/op/agents', args: [], env: {} },
      {
        how: 'execve',
        file: '/usr/bin/node',
        args: ['/usr/bin/node', '--import', 'hook.mjs', '/opt/tayet-agent/dist/cli.js', '--server', 'https://x', '--store', '/s'],
        env: { PATH: '/bin', TAYET_AGENT_TOKEN: 'mpt_seed', TAYET_AGENT_ROTATED: '1' },
      },
    ])
  })

  it('execve absent: a child with stdio inherit, signals forwarded, its exit code propagated', () => {
    const t = ports({})
    const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, killed: [] as string[], kill(s: string) { this.killed.push(s) } })
    let spawned: { file: string; args: readonly string[]; opts: { stdio?: unknown; env?: NodeJS.ProcessEnv; cwd?: string } } | undefined
    t.ports.spawn = ((file: string, args: readonly string[], opts: { stdio?: unknown; env?: NodeJS.ProcessEnv; cwd?: string }) => {
      spawned = { file, args, opts }
      return child
    }) as unknown as RelaunchPorts['spawn']
    let exited: number | undefined
    t.ports.exit = ((code: number) => {
      exited = code
    }) as RelaunchPorts['exit']
    void relaunch(t.ports.cwd, t.ports)
    expect(spawned).toMatchObject({
      file: '/usr/bin/node',
      args: ['--import', 'hook.mjs', '/opt/tayet-agent/dist/cli.js', '--server', 'https://x', '--store', '/s'],
      opts: { stdio: 'inherit', env: { TAYET_AGENT_ROTATED: '1' }, cwd: '/home/op/agents' },
    })
    t.signals.get('SIGTERM')!()
    expect(child.killed).toEqual(['SIGTERM'])
    child.emit('exit', 70, null)
    expect(exited).toBe(70)
    child.emit('exit', null, 'SIGKILL')
    expect(exited).toBe(137)
  })
})
