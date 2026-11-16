import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, realpathSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClassicLevel } from 'classic-level'
import { startFakeServer, type FakeServer } from '../support/fake-server'
import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'
import { options } from '../../build.mjs'
import { COUNT_HOOK, SIDECAR_ROOT, evt, startSidecar } from '../support/sidecar-process'
import { findProtocolLeaks, PROTOCOL_PATTERNS } from '@tayet/shared/leak-scan'
import { createHash } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { defaultStoreBase } from '../../src/store'

// The boot of dist/cli.js against a fake server (no stack): order, lock, sentinels, the 401
// discriminator (boot × runtime), redaction, and the one-SDK smoke. PLANO-AGENTES §0.3.5.

const TOKEN = 'mpt_unitTestToken_DoNotLog_0123456789'
const USER = '@a-abcdefghijkl:fake.local'
let fake: FakeServer
let store: string

beforeEach(async () => {
  fake = await startFakeServer()
  store = await mkdtemp(join(tmpdir(), 'sidecar-boot-'))
})

afterEach(async () => {
  await fake.close()
  await rm(store, { recursive: true, force: true })
})

const args = (extra: string[] = []): string[] => ['--server', fake.url, '--token', TOKEN, '--store', store, ...extra]

async function bootToSync(extra: string[] = [], nodeArgs: string[] = []) {
  const p = startSidecar(args(extra), { nodeArgs })
  await p.waitFor((l) => l.evt === 'sync-state' && (l.to === 'PREPARED' || l.to === 'SYNCING'))
  return p
}

// PLANO-AGENTES §0.3.12 item 9: no protocol id in a default log line. The id shapes of the leak-scan
// (mxid, room id, event id, media URI, the `u-`/`a-` localparts) over every stdout line; the device id
// and the ed25519 key appear only under --debug, and only in the fields declared below. The one
// exception, free text from `String(err)`, is provoked and declared in join.test.ts.
const LOG_ID_PATTERNS = PROTOCOL_PATTERNS.filter((p) =>
  ['mxid', 'room-id', 'event-id', 'mxc-uri', 'opaque-localpart', 'agent-localpart'].includes(p.name),
)
const DEBUG_ONLY_FIELDS = ['deviceId', 'previousDeviceId', 'ed25519']
const logLeaks = (lines: Array<Record<string, unknown>>) => findProtocolLeaks(lines, new Set(), LOG_ID_PATTERNS)

describe('logs — no protocol id by default (§0.3.12 item 9)', () => {
  it('without --debug: no id shape, no device id, no key; whoami is the bare event', async () => {
    const p = await bootToSync()
    await p.stop()
    expect(p.lines.length).toBeGreaterThan(5)
    expect(logLeaks(p.lines)).toEqual([])
    expect(p.lines.find(evt('whoami'))).toEqual({ evt: 'whoami' })
    expect(p.lines.find(evt('identity'))).toEqual({ evt: 'identity' })
    expect(p.stdout()).not.toContain('FAKEDEV001')
    for (const field of DEBUG_ONLY_FIELDS) expect(p.lines.some((l) => field in l)).toBe(false)
  })

  it('with --debug: the device id and the key come back, only in their declared fields', async () => {
    const p = await bootToSync(['--debug'])
    await p.stop()
    expect(p.lines.find(evt('whoami'))).toEqual({ evt: 'whoami', deviceId: 'FAKEDEV001' })
    const identity = p.lines.find(evt('identity'))
    expect(identity).toMatchObject({ deviceId: 'FAKEDEV001' })
    expect(typeof identity?.ed25519).toBe('string')
    const stripped = p.lines.map((l) => Object.fromEntries(Object.entries(l).filter(([k]) => !DEBUG_ONLY_FIELDS.includes(k))))
    expect(logLeaks(stripped)).toEqual([])
    expect(JSON.stringify(stripped)).not.toContain('FAKEDEV001')
  })
})

describe('boot — happy path', () => {
  it('discovers, whoami, lock, key, crypto, marker, sync; SIGTERM → 0', async () => {
    const p = await bootToSync()
    const evts = p.lines.map((l) => l.evt)
    expect(evts.slice(0, 7)).toEqual(['discovered', 'whoami', 'operator-known', 'store', 'storage-key-created', 'local-token-created', 'identity'])
    const marker = JSON.parse(await readFile(join(store, 'identity.json'), 'utf8')) as Record<string, unknown>
    expect(marker).toMatchObject({ deviceId: 'FAKEDEV001', userId: USER, server: fake.url })
    expect(((await stat(join(store, 'storage.key'))).mode & 0o777).toString(8)).toBe('600')
    expect(existsSync(join(store, 'indexeddb'))).toBe(true)
    expect(await p.stop()).toBe(0)
    expect(p.lines.find(evt('shutdown'))).toMatchObject({ signal: 'SIGTERM' })
  })

  // PLANO-AGENTES §8.19 item 19: SIGTERM with the first /sync still in flight (held by the fake) — the
  // stop aborts it; the exit is 0 and no rejection line is written.
  it('SIGTERM before the first sync → 0, no rejection line', async () => {
    fake.set({ hold: ['/_matrix/client/v3/sync'] })
    const p = startSidecar(args())
    await p.waitFor(evt('started'))
    for (let i = 0; i < 400 && !fake.requests.includes('GET /_matrix/client/v3/sync'); i++) await new Promise((r) => setTimeout(r, 25))
    expect(fake.requests).toContain('GET /_matrix/client/v3/sync')
    expect(await p.stop()).toBe(0)
    expect(p.lines.find(evt('sync-state'))).toEqual({ evt: 'sync-state', from: null, to: 'STOPPED' })
    expect(p.lines.filter((l) => l.stage === 'unhandled-rejection' || l.evt === 'sdk-orphan-rejection' || l.evt === 'shutdown-error')).toEqual([])
  })

  it('2nd boot reuses storage.key and identity (same ed25519)', async () => {
    const a = await bootToSync()
    const first = a.lines.find(evt('identity'))!.ed25519
    await a.stop()
    const b = await bootToSync()
    expect(b.lines.some(evt('storage-key-created'))).toBe(false)
    expect(b.lines.some(evt('local-token-created'))).toBe(false)
    expect(b.lines.find(evt('identity'))!.ed25519).toBe(first)
    await b.stop()
  })
})

// A holder of <store>/instance.lock that is not the sidecar: lets the test seed the store freely.
async function holdLock(dir: string): Promise<ClassicLevel> {
  const db = new ClassicLevel(join(dir, 'instance.lock'))
  await db.open()
  return db
}

describe('instance.lock (ADR-087 dec. 3, P-S1)', () => {
  it('2nd process on the same store → 75, no sentinel; the 1st keeps syncing and shuts down 0', async () => {
    const first = await bootToSync()
    const second = startSidecar(args())
    expect(await second.exited).toBe(75)
    expect(second.lines.at(-1)).toMatchObject({ evt: 'lock-busy' })
    expect(existsSync(join(store, 'REMEDIATION_NEEDED'))).toBe(false)
    expect(first.child.exitCode).toBeNull()
    expect(await first.stop()).toBe(0)
  })

  it('order (adj. 10): with the lock busy, whoami and 3b run and the exit is 75 before sentinel, marker or indexeddb', async () => {
    // Seed a store that would exit 70 (sentinel of the same device) or 65 (marker of another
    // agent) if read before the lock — the exit code itself proves the order.
    await writeFile(join(store, 'REMEDIATION_NEEDED'), JSON.stringify({ deviceId: 'FAKEDEV001', reason: 'seed' }))
    await writeFile(
      join(store, 'identity.json'),
      JSON.stringify({ deviceId: 'OTHER', ed25519: 'x', curve25519: 'y', userId: '@a-zzzzzzzzzzzz:fake.local', server: fake.url }),
    )
    const before = await Promise.all(['REMEDIATION_NEEDED', 'identity.json'].map((f) => stat(join(store, f))))
    const holder = await holdLock(store)
    try {
      const p = startSidecar(args())
      expect(await p.exited).toBe(75)
      expect(fake.requests).toContain('GET /_matrix/client/v3/account/whoami')
      expect(p.lines.map((l) => l.evt)).toEqual(['discovered', 'whoami', 'operator-known', 'lock-busy'])
      expect(existsSync(join(store, 'indexeddb'))).toBe(false)
      expect(existsSync(join(store, 'storage.key'))).toBe(false)
      const after = await Promise.all(['REMEDIATION_NEEDED', 'identity.json'].map((f) => stat(join(store, f))))
      expect(after.map((s) => s.mtimeMs)).toEqual(before.map((s) => s.mtimeMs))
    } finally {
      await holder.close()
    }
  })

  it('the lock dies with its holder: SIGKILL of the 1st, the next boot acquires it', async () => {
    const first = await bootToSync()
    await first.stop('SIGKILL')
    const next = await bootToSync()
    expect(await next.stop()).toBe(0)
  })
})

describe('sentinels at boot (adj. 4) — decided with the whoami of the boot', () => {
  it('REMEDIATION_NEEDED of the same device, self-reissue refused (too soon) → 70, nothing deleted', async () => {
    const a = await bootToSync()
    await a.stop()
    await writeFile(join(store, 'REMEDIATION_NEEDED'), JSON.stringify({ deviceId: 'FAKEDEV001', reason: 'store-unusable' }))
    fake.set({ reissue: 'too-soon' })
    const p = startSidecar(args())
    expect(await p.exited).toBe(70)
    expect(existsSync(join(store, 'indexeddb'))).toBe(true)
    expect(existsSync(join(store, 'identity.json'))).toBe(true)
    expect(existsSync(join(store, 'REMEDIATION_NEEDED'))).toBe(true)
    expect(fake.requests.filter((r) => r.includes('/keys/upload'))).toHaveLength(1) // only the first boot's
  })

  it('REVOKED of the same device → 78', async () => {
    await writeFile(join(store, 'REVOKED'), JSON.stringify({ deviceId: 'FAKEDEV001' }))
    const p = startSidecar(args())
    expect(await p.exited).toBe(78)
    expect(existsSync(join(store, 'REVOKED'))).toBe(true)
  })

  it('a sentinel of another device (reissued) → wipe indexeddb/marker/sentinel, keep storage.key, go on', async () => {
    const a = await bootToSync()
    await a.stop()
    const key = await readFile(join(store, 'storage.key'), 'utf8')
    await writeFile(join(store, 'REVOKED'), JSON.stringify({ deviceId: 'FAKEDEV001' }))
    fake.set({ deviceId: 'FAKEDEV002' })
    // The device ids of the reset line are --debug fields (§0.3.12 item 9).
    const p = await bootToSync(['--debug'])
    expect(p.lines.find(evt('identity-reset'))).toMatchObject({ reason: 'sentinel-cleared', previousDeviceId: 'FAKEDEV001', deviceId: 'FAKEDEV002' })
    expect(existsSync(join(store, 'REVOKED'))).toBe(false)
    expect(await readFile(join(store, 'storage.key'), 'utf8')).toBe(key)
    expect(JSON.parse(await readFile(join(store, 'identity.json'), 'utf8'))).toMatchObject({ deviceId: 'FAKEDEV002' })
    await p.stop()
  })

  it('no sentinel, marker of another device → device-changed wipe', async () => {
    const a = await bootToSync()
    await a.stop()
    fake.set({ deviceId: 'FAKEDEV003' })
    const p = await bootToSync()
    // Without --debug the reset line names the reason only.
    expect(p.lines.find(evt('identity-reset'))).toEqual({ evt: 'identity-reset', reason: 'device-changed' })
    await p.stop()
  })

  it('marker of another agent → 65, nothing deleted', async () => {
    const a = await bootToSync()
    await a.stop()
    fake.set({ userId: '@a-mnopqrstuvwx:fake.local' })
    const p = startSidecar(args())
    expect(await p.exited).toBe(65)
    expect(p.lines.at(-1)).toMatchObject({ stage: 'store', field: 'userId' })
    expect(existsSync(join(store, 'indexeddb'))).toBe(true)
    expect(existsSync(join(store, 'identity.json'))).toBe(true)
  })
})

describe('credential refused: boot × runtime (adjs. 6, 7)', () => {
  it('401 at boot → 78, no wipe, no sentinel (store of a previous run intact)', async () => {
    const a = await bootToSync()
    await a.stop()
    fake.set({ whoami: 'unknown-token' })
    const p = startSidecar(args())
    expect(await p.exited).toBe(78)
    expect(p.lines.at(-1)).toMatchObject({ evt: 'credential-refused', stage: 'boot', errcode: 'M_UNKNOWN_TOKEN' })
    expect(existsSync(join(store, 'indexeddb'))).toBe(true)
    expect(existsSync(join(store, 'identity.json'))).toBe(true)
    expect(existsSync(join(store, 'REVOKED'))).toBe(false)
  })

  it('401 at boot with no store yet → 78 and the lock was never taken', async () => {
    fake.set({ whoami: 'unknown-token' })
    const p = startSidecar(args())
    expect(await p.exited).toBe(78)
    expect(existsSync(join(store, 'instance.lock'))).toBe(false)
  })

  it('M_UNKNOWN_TOKEN at runtime (token accepted in this run) → wipe + REVOKED (with the device) + 78', async () => {
    const p = await bootToSync()
    const key = await readFile(join(store, 'storage.key'), 'utf8')
    fake.revoke()
    expect(await p.exited).toBe(78)
    expect(p.lines.find(evt('credential-refused'))).toMatchObject({ stage: 'runtime' })
    expect(existsSync(join(store, 'indexeddb'))).toBe(false)
    expect(existsSync(join(store, 'identity.json'))).toBe(false)
    expect(JSON.parse(await readFile(join(store, 'REVOKED'), 'utf8'))).toMatchObject({ deviceId: 'FAKEDEV001' })
    expect(await readFile(join(store, 'storage.key'), 'utf8')).toBe(key)
    expect(existsSync(join(store, 'REMEDIATION_NEEDED'))).toBe(false)
    // ADR-087 dec. 8: a revocation never reissues.
    expect(fake.reissues).toEqual([])
  })

  it('a non-agent account → 77 before the store is touched', async () => {
    fake.set({ userId: '@u-abcdefghijkl:fake.local' })
    const p = startSidecar(args())
    expect(await p.exited).toBe(77)
    expect(existsSync(join(store, 'instance.lock'))).toBe(false)
  })

  it('a credential with no device → 77', async () => {
    fake.set({ whoami: 'no-device' })
    expect(await startSidecar(args()).exited).toBe(77)
  })
})

describe('whoami at boot: refused × server problem (rodada 2 do #333)', () => {
  it.each([
    ['not-found', 69],
    ['html', 69],
    ['no-user', 69],
    ['unknown-token', 78],
    ['forbidden', 78],
    ['no-device', 77],
  ] as const)('whoami %s → %i, before the store is touched', async (mode, code) => {
    fake.set({ whoami: mode })
    const p = startSidecar(args())
    expect(await p.exited).toBe(code)
    expect(existsSync(join(store, 'instance.lock'))).toBe(false)
    const last = p.lines.at(-1)!
    if (code === 69) {
      expect(last).toMatchObject({ evt: 'fatal', stage: 'whoami' })
      expect(String(last.message)).not.toMatch(/reissue/i)
    }
    if (code === 78) expect(last).toMatchObject({ evt: 'credential-refused', stage: 'boot' })
  })
})

describe('discovery exits (adj. 5)', () => {
  it('product answering text/html with no dev fallback → 69', async () => {
    fake.set({ wellKnown: 'html', versions: false })
    const p = startSidecar(args())
    expect(await p.exited).toBe(69)
    expect(p.lines.at(-1)).toMatchObject({ stage: 'discovery' })
  })

  it('loopback URL with no document but a live server → direct, with a warning; no escrow → 69 (§0.3.10 item 4)', async () => {
    fake.set({ wellKnown: 'none' })
    const p = startSidecar(args())
    expect(await p.exited).toBe(69)
    expect(p.lines.find(evt('discovery-direct'))).toBeDefined()
    expect(p.lines.find(evt('discovered'))).toMatchObject({ via: 'direct' })
    expect(p.lines.at(-1)).toMatchObject({ evt: 'fatal', stage: 'operator' })
    expect(String(p.lines.at(-1)!.message)).toMatch(/account service/)
    expect(existsSync(join(store, 'instance.lock'))).toBe(false)
    expect(fake.requests.some((r) => r.includes('/escrow/'))).toBe(false)
  })
})

// PLANO-AGENTES §0.3.10 item 4: step 3b, after whoami and before the store.
describe('operator at boot (step 3b)', () => {
  it.each([
    ['unknown-token', 78, { evt: 'credential-refused', stage: 'operator', status: 401 }],
    ['no-operator', 78, { evt: 'operator-unknown' }],
    ['not-found', 69, { evt: 'fatal', stage: 'operator', status: 404 }],
    ['not-agent', 69, { evt: 'fatal', stage: 'operator' }],
  ] as const)('escrow %s → %i, before the store is touched', async (mode, code, last) => {
    fake.set({ escrow: mode })
    const p = startSidecar(args())
    expect(await p.exited).toBe(code)
    expect(p.lines.at(-1)).toMatchObject(last)
    expect(p.lines.map((l) => l.evt)).toContain('whoami')
    expect(existsSync(join(store, 'instance.lock'))).toBe(false)
    expect(existsSync(join(store, 'REVOKED'))).toBe(false)
  })

  it('401 of the escrow with a previous store → 78 with no wipe and no sentinel', async () => {
    const a = await bootToSync()
    await a.stop()
    fake.set({ escrow: 'unknown-token' })
    const p = startSidecar(args())
    expect(await p.exited).toBe(78)
    expect(existsSync(join(store, 'indexeddb'))).toBe(true)
    expect(existsSync(join(store, 'identity.json'))).toBe(true)
    expect(existsSync(join(store, 'REVOKED'))).toBe(false)
    expect(existsSync(join(store, 'REMEDIATION_NEEDED'))).toBe(false)
  })

  it('asks the escrow once, at the relative account of the document, with the agent token; the operator is never logged', async () => {
    const OPERATOR = '@opsecretlocalpart:fake.local'
    fake.set({ operator: OPERATOR })
    const p = await bootToSync(['--debug'])
    expect(fake.requests.filter((r) => r === 'GET /escrow/v1/people/me')).toHaveLength(1)
    expect(await p.stop()).toBe(0)
    expect(p.stdout()).not.toContain('opsecretlocalpart')
    expect(p.stderr()).not.toContain('opsecretlocalpart')
  })
})

describe('logs (adj. 8)', () => {
  it('token and storage.key never appear in stdout or stderr, with and without --debug, across boot and revocation', async () => {
    // A known storage.key, seeded before the 1st boot.
    const knownKey = Buffer.alloc(32, 7).toString('base64')
    await mkdir(store, { recursive: true })
    await writeFile(join(store, 'storage.key'), knownKey, { mode: 0o600 })
    const quiet = await bootToSync()
    await quiet.stop()
    const loud = await bootToSync(['--debug'])
    fake.revoke()
    expect(await loud.exited).toBe(78)
    for (const p of [quiet, loud]) {
      for (const stream of [p.stdout(), p.stderr()]) {
        expect(stream).not.toContain(TOKEN)
        expect(stream).not.toContain(knownKey)
      }
    }
    // Without --debug the SDK is silent; with it, its diagnostics go to stderr, never stdout.
    expect(quiet.stderr()).toBe('')
    expect(loud.stderr()).toContain('FetchHttpApi')
    for (const raw of loud.stdout().trim().split('\n')) expect(() => JSON.parse(raw) as unknown).not.toThrow()
  })
})

describe('TAYET_AGENT_TOKEN (§0.3.8 item 3)', () => {
  it('boots from the variable alone; with --debug the credential is in neither stream', async () => {
    const p = startSidecar(['--server', fake.url, '--store', store, '--debug'], { env: { TAYET_AGENT_TOKEN: TOKEN } })
    await p.waitFor(evt('api-listening'))
    expect(p.lines.find(evt('whoami'))).toBeDefined()
    expect(await p.stop()).toBe(0)
    expect(p.stderr()).toContain('FetchHttpApi')
    for (const stream of [p.stdout(), p.stderr()]) expect(stream).not.toContain(TOKEN)
  })

  it('no --token and no variable → 64, the usage names both', async () => {
    const p = startSidecar(['--server', fake.url, '--store', store], { env: { TAYET_AGENT_TOKEN: '' } })
    expect(await p.exited).toBe(64)
    expect(p.stderr()).toContain('missing --token (or TAYET_AGENT_TOKEN)')
  })
})

describe('dist smoke (adjs. 1, 2)', () => {
  it('--help runs from dist and exits 0', async () => {
    const p = startSidecar(['--help'])
    expect(await p.exited).toBe(0)
    expect(p.stdout()).toContain('Usage: tayet-agent')
  })

  it('@tayet/shared/internal, bundled with the options of build.mjs, runs under node with one SDK', async () => {
    const outfile = join(SIDECAR_ROOT, '.smoke', 'shared-probe.js')
    await build(options(join(SIDECAR_ROOT, 'test', 'support', 'shared-probe.ts'), outfile))
    const run = spawnSync(process.execPath, ['--import', COUNT_HOOK, outfile], { encoding: 'utf8' })
    expect(run.status, run.stderr).toBe(0)
    expect(JSON.parse(run.stdout.trim())).toEqual({
      evt: 'shared-probe', eventToMessage: 'function', stableMessageId: 'function',
      content: { msgtype: 'm.text', body: 'oi' }, sdk: 'function',
    })
    const bundle = await readFile(outfile, 'utf8')
    expect(bundle).toContain('from "matrix-js-sdk/lib/crypto-api/index.js"')
    expect(run.stderr.split('\n').filter((l) => l.includes('matrix-js-sdk/lib/client.js'))).toHaveLength(1)
  })

  it('a full boot from dist loads exactly one SDK and one crypto wasm', async () => {
    const p = await bootToSync([], ['--import', COUNT_HOOK])
    await p.stop()
    const loads = p.stderr().split('\n').filter((l) => l.startsWith('[sb-load] '))
    expect(loads.filter((l) => l.includes('matrix-js-sdk/lib/client.js'))).toHaveLength(1)
    expect(loads.filter((l) => l.includes('matrix-sdk-crypto-wasm/node.mjs'))).toHaveLength(1)
  })
})

// ── S-h: self-reissue (PLANO-AGENTES §0.3.14; the response map of §8.25) ──────────────────────────
const NO_EXECVE = join(SIDECAR_ROOT, 'test', 'support', 'no-execve.mjs')
const sha256 = (t: string): string => createHash('sha256').update(t).digest('hex')
const readJson = async (file: string): Promise<Record<string, unknown>> => JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
const sentinel = (deviceId = 'FAKEDEV001') => writeFile(join(store, 'REMEDIATION_NEEDED'), JSON.stringify({ deviceId, reason: 'store-unusable' }))
// A healthy 1st boot, stopped: the device uploaded keys and wrote its marker.
async function seeded(): Promise<void> {
  const a = await bootToSync()
  expect(await a.stop()).toBe(0)
}
const ready = (l: Record<string, unknown>): boolean => l.evt === 'api-listening'
const idx = (p: { lines: Array<Record<string, unknown>> }, name: string): number => p.lines.findIndex(evt(name))

describe('self-reissue — 201: credential, wipe, relaunch (S-h)', () => {
  it('sentinel of the same device → POST once, credential written 0600 before the wipe, relaunch by execve (same PID) before the API listens', async () => {
    await seeded()
    const key = await readFile(join(store, 'storage.key'), 'utf8')
    const local = await readFile(join(store, 'local.token'), 'utf8')
    await sentinel()
    const p = startSidecar(args())
    await p.waitFor(ready, 60_000)
    expect(fake.reissues).toHaveLength(1)
    const issued = fake.reissues[0]!
    expect(issued.caller).toBe(TOKEN)
    expect(p.lines.find(evt('self-reissue-started'))).toEqual({ evt: 'self-reissue-started', reason: 'sentinel' })
    // The rotation happens inside the boot, before startLocalApi: no api-listening before the relaunch.
    const rotated = idx(p, 'credential-rotated')
    expect(rotated).toBeGreaterThan(0)
    expect(idx(p, 'api-listening')).toBeGreaterThan(rotated)
    expect(p.lines.slice(0, rotated).some(ready)).toBe(false)
    // The relaunched boot: --token refused, the stored credential accepted.
    expect(p.lines.slice(rotated + 1).map((l) => l.evt).slice(0, 3)).toEqual(['discovered', 'credential-from-store', 'whoami'])
    // execve keeps the PID: the local API's pid is the spawned process's.
    expect((await readJson(join(store, 'api.json'))).pid).toBe(p.child.pid)
    const cred = await readJson(join(store, 'credential'))
    expect(cred).toEqual({ token: issued.issued, seededFrom: sha256(TOKEN), rotatedAt: cred.rotatedAt })
    expect(((await stat(join(store, 'credential'))).mode & 0o777).toString(8)).toBe('600')
    expect(existsSync(join(store, 'REMEDIATION_NEEDED'))).toBe(false)
    expect(await readFile(join(store, 'storage.key'), 'utf8')).toBe(key)
    expect(await readFile(join(store, 'local.token'), 'utf8')).toBe(local)
    await p.waitFor((l) => l.evt === 'sync-state' && (l.to === 'PREPARED' || l.to === 'SYNCING'))
    expect(await readJson(join(store, 'identity.json'))).toMatchObject({ deviceId: issued.deviceId })
    expect(await p.stop()).toBe(0)
    // No token (old or new), no protocol id, no device id in the default log.
    for (const stream of [p.stdout(), p.stderr()]) {
      expect(stream).not.toContain(TOKEN)
      expect(stream).not.toContain(issued.issued!)
    }
    expect(logLeaks(p.lines)).toEqual([])
    expect(p.stdout()).not.toContain('FAKEDEV001')
    expect(p.stdout()).not.toContain(issued.deviceId!)
    const rotatedLine = p.lines.find(evt('credential-rotated'))!
    expect(Object.keys(rotatedLine).sort()).toEqual(['evt', 'file', 'message'])
    expect(rotatedLine.file).toBe(join(store, 'credential'))
    expect(String(rotatedLine.message)).toContain('--token in your configuration is no longer valid')
  })

  it('relaunch fallback (no process.execve): a child process, signals forwarded, exit code propagated', async () => {
    await seeded()
    await sentinel()
    const p = startSidecar(args(), { nodeArgs: ['--import', NO_EXECVE] })
    await p.waitFor(ready, 60_000)
    expect(fake.reissues).toHaveLength(1)
    // The child writes api.json with its own pid.
    expect((await readJson(join(store, 'api.json'))).pid).not.toBe(p.child.pid)
    expect(p.lines.slice(0, idx(p, 'credential-rotated')).some(ready)).toBe(false)
    expect(await p.stop()).toBe(0)
    expect(p.lines.find(evt('shutdown'))).toMatchObject({ signal: 'SIGTERM' })
  })

  it('with --debug the rotated line carries the new device id', async () => {
    await seeded()
    await sentinel()
    const p = startSidecar(args(['--debug']))
    await p.waitFor(ready, 60_000)
    expect(p.lines.find(evt('credential-rotated'))).toMatchObject({ deviceId: fake.reissues[0]!.deviceId })
    await p.stop()
  })

  it('F7: no marker and no published keys → a 1st boot (keys asked before any upload)', async () => {
    const p = await bootToSync()
    await p.stop()
    const query = fake.requests.indexOf('POST /_matrix/client/v3/keys/query')
    expect(query).toBeGreaterThanOrEqual(0)
    expect(query).toBeLessThan(fake.requests.indexOf('POST /_matrix/client/v3/keys/upload'))
    expect(fake.reissues).toEqual([])
  })

  it('F7: the whole store lost while the device has published keys → self-reissue store-lost → relaunch → sync', async () => {
    await seeded()
    expect(fake.uploadedKeys.has('FAKEDEV001')).toBe(true)
    await rm(store, { recursive: true, force: true })
    const before = fake.requests.length
    const p = startSidecar(args())
    await p.waitFor((l) => l.evt === 'sync-state' && (l.to === 'PREPARED' || l.to === 'SYNCING'), 60_000)
    expect(p.lines.find(evt('self-reissue-started'))).toEqual({ evt: 'self-reissue-started', reason: 'store-lost' })
    expect(fake.reissues).toHaveLength(1)
    // Nothing uploaded for the old device between the restart and the reissue.
    const run = fake.requests.slice(before)
    const post = run.findIndex((r) => r.startsWith('POST /escrow/v1/agents/') && r.endsWith('/reissue'))
    expect(post).toBeGreaterThan(0)
    expect(run.slice(0, post).filter((r) => r.includes('/keys/upload'))).toEqual([])
    expect(run.slice(0, post)).toContain('POST /_matrix/client/v3/keys/query')
    expect(await readJson(join(store, 'identity.json'))).toMatchObject({ deviceId: fake.reissues[0]!.deviceId })
    await p.stop()
  })

  it('keys diverged (indexeddb/ deleted, marker kept) → self-reissue keys-diverged', async () => {
    await seeded()
    await rm(join(store, 'indexeddb'), { recursive: true, force: true })
    fake.set({ reissue: 'too-soon' })
    const p = startSidecar(args())
    expect(await p.exited).toBe(70)
    expect(p.lines.find(evt('self-reissue-started'))).toEqual({ evt: 'self-reissue-started', reason: 'keys-diverged' })
    expect(JSON.parse(await readFile(join(store, 'REMEDIATION_NEEDED'), 'utf8'))).toMatchObject({ deviceId: 'FAKEDEV001', reason: 'keys-diverged' })
  })

  it('loadCache fails (indexeddb is not a directory) → self-reissue store-unusable', async () => {
    await seeded()
    await rm(join(store, 'indexeddb'), { recursive: true, force: true })
    await writeFile(join(store, 'indexeddb'), 'not a store')
    fake.set({ reissue: 'too-soon' })
    const p = startSidecar(args())
    expect(await p.exited).toBe(70)
    expect(p.lines.find(evt('self-reissue-started'))).toEqual({ evt: 'self-reissue-started', reason: 'store-unusable' })
  })

  it('step 6 (storage.key unreadable) is not a trigger: 70 remediation-needed, no POST', async () => {
    await seeded()
    await writeFile(join(store, 'storage.key'), 'not base64 !!')
    const p = startSidecar(args())
    expect(await p.exited).toBe(70)
    expect(p.lines.at(-1)).toMatchObject({ evt: 'remediation-needed', reason: 'store-unusable' })
    expect(fake.reissues).toEqual([])
  })
})

// The boot chdirs into the store at step 8; a relaunch after a rotation at steps 9/10 must resolve
// relative arguments from the cwd the operator launched in (§8.25, rodada 2). Here the relative argument
// is in execArgv (`--import ./noop-hook.mjs`); --store stays absolute (a relative --store is a separate
// finding: §8.25, rodada 2).
describe('self-reissue — relaunch from the launch cwd', () => {
  it.each([
    ['execve', [] as string[]],
    ['spawn fallback', ['--import', NO_EXECVE]],
  ])('%s: keys-diverged → rotated → relaunched with a relative --import from the launch cwd', async (_how, extra) => {
    const cwd = await mkdtemp(join(tmpdir(), 'sidecar-cwd-'))
    try {
      await writeFile(join(cwd, 'noop-hook.mjs'), '// relative --import for the relaunch test\n')
      const nodeArgs = [...extra, '--import', './noop-hook.mjs']
      const synced = (l: Record<string, unknown>): boolean => l.evt === 'sync-state' && (l.to === 'PREPARED' || l.to === 'SYNCING')
      const a = startSidecar(args(), { cwd, nodeArgs })
      await a.waitFor(synced)
      expect(await a.stop()).toBe(0)
      await rm(join(store, 'indexeddb'), { recursive: true, force: true })
      const p = startSidecar(args(), { cwd, nodeArgs })
      await p.waitFor(synced, 60_000)
      expect(p.lines.find(evt('self-reissue-started'))).toEqual({ evt: 'self-reissue-started', reason: 'keys-diverged' })
      const rotated = idx(p, 'credential-rotated')
      expect(rotated).toBeGreaterThan(0)
      expect(p.lines.slice(rotated).some(evt('credential-from-store'))).toBe(true)
      expect(existsSync(join(store, 'credential'))).toBe(true)
      expect(await p.stop()).toBe(0)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})

// The boot chdirs into the store at step 8; a relaunch after a rotation at steps 9/10 must resolve the
// relative arguments (here --store) from the cwd the operator launched in (§8.25, rodada 2).
describe('self-reissue — relaunch from the launch cwd (relative --store)', () => {
  it('1st boot with a relative --store: the marker lands in <cwd>/agent/identity.json and the sync starts', async () => {
    const cwd = store
    const p = startSidecar(['--server', fake.url, '--token', TOKEN, '--store', 'agent'], { cwd })
    await p.waitFor((l) => l.evt === 'sync-state' && (l.to === 'PREPARED' || l.to === 'SYNCING'))
    expect(JSON.parse(await readFile(join(cwd, 'agent', 'identity.json'), 'utf8'))).toMatchObject({ deviceId: 'FAKEDEV001' })
    expect(existsSync(join(cwd, 'agent', 'agent'))).toBe(false)
    // The child's cwd is the real path (macOS: /var → /private/var).
    expect(p.lines.find(evt('store'))).toEqual({ evt: 'store', store: join(realpathSync(cwd), 'agent') })
    expect(await p.stop()).toBe(0)
  })

  it.each([
    ['execve', [] as string[]],
    ['spawn fallback', ['--import', NO_EXECVE]],
  ])('%s: keys-diverged → rotated → relaunched with credential-from-store in <cwd>/agent', async (_how, nodeArgs) => {
    const cwd = store
    const rel = ['--server', fake.url, '--token', TOKEN, '--store', 'agent']
    const synced = (l: Record<string, unknown>): boolean => l.evt === 'sync-state' && (l.to === 'PREPARED' || l.to === 'SYNCING')
    const a = startSidecar(rel, { cwd })
    await a.waitFor(synced)
    expect(await a.stop()).toBe(0)
    await rm(join(cwd, 'agent', 'indexeddb'), { recursive: true, force: true })
    const p = startSidecar(rel, { cwd, nodeArgs })
    await p.waitFor(synced, 60_000)
    expect(p.lines.find(evt('self-reissue-started'))).toEqual({ evt: 'self-reissue-started', reason: 'keys-diverged' })
    const rotated = idx(p, 'credential-rotated')
    expect(rotated).toBeGreaterThan(0)
    expect(p.lines.slice(rotated).some(evt('credential-from-store'))).toBe(true)
    expect(existsSync(join(cwd, 'agent', 'credential'))).toBe(true)
    expect(existsSync(join(cwd, 'agent', 'agent'))).toBe(false)
    expect(await p.stop()).toBe(0)
  })
})

describe('self-reissue — the response map (§8.25)', () => {
  it.each([
    ['too-soon', 70, { evt: 'self-reissue-refused', reason: 'too-soon' }, true],
    ['session', 70, { evt: 'self-reissue-failed', step: 'session' }, true],
    ['mint', 78, { evt: 'self-reissue-failed', step: 'mint' }, true],
    ['sweep', 78, { evt: 'self-reissue-failed', step: 'sweep' }, true],
    ['401', 78, { evt: 'self-reissue-refused', status: 401 }, true],
    ['403', 78, { evt: 'self-reissue-refused', status: 403 }, true],
    ['404', 78, { evt: 'self-reissue-refused', status: 404 }, true],
    ['not-agent', 70, { evt: 'self-reissue-refused', status: 400 }, true],
    ['network', 70, { evt: 'self-reissue-failed', stage: 'network' }, true],
  ] as const)('escrow %s → %i', async (answer, code, last, keepsSentinel) => {
    await seeded()
    await sentinel()
    fake.set({ reissue: answer })
    const p = startSidecar(args())
    expect(await p.exited).toBe(code)
    expect(p.lines.at(-1)).toMatchObject(last)
    expect(fake.reissues).toHaveLength(1)
    expect(existsSync(join(store, 'REMEDIATION_NEEDED'))).toBe(keepsSentinel)
    expect(existsSync(join(store, 'credential'))).toBe(false)
    expect(existsSync(join(store, 'indexeddb'))).toBe(true)
    if (answer === 'mint' || answer === 'sweep') expect(String(p.lines.at(-1)!.message)).toMatch(/admin to reissue/)
    expect(p.stdout()).not.toContain(TOKEN)
  })
})

describe('self-reissue — guards', () => {
  it('TAYET_AGENT_ROTATED=1 → 70 remediation-needed, no POST', async () => {
    await seeded()
    await sentinel()
    const p = startSidecar(args(), { env: { TAYET_AGENT_ROTATED: '1' } })
    expect(await p.exited).toBe(70)
    expect(p.lines.at(-1)).toMatchObject({ evt: 'remediation-needed' })
    expect(fake.reissues).toEqual([])
  })

  it('the 10 min floor: a 2nd trigger right after a rotation → 70 self-reissue-refused floor, no 2nd POST', async () => {
    await seeded()
    await sentinel()
    const a = startSidecar(args())
    await a.waitFor(ready, 60_000)
    await a.stop()
    await sentinel(fake.reissues[0]!.deviceId)
    const p = startSidecar(args())
    expect(await p.exited).toBe(70)
    expect(p.lines.find(evt('credential-from-store'))).toBeDefined()
    expect(p.lines.at(-1)).toMatchObject({ evt: 'self-reissue-refused', reason: 'floor' })
    expect(fake.reissues).toHaveLength(1)
  })

  it('M_UNKNOWN_TOKEN at runtime after a rotation: REVOKED + 78, no POST', async () => {
    await seeded()
    await sentinel()
    const p = startSidecar(args())
    await p.waitFor(ready, 60_000)
    fake.revoke()
    expect(await p.exited).toBe(78)
    expect(fake.reissues).toHaveLength(1)
    expect(existsSync(join(store, 'REVOKED'))).toBe(true)
  })
})

describe('self-reissue — the stored credential at the next boots', () => {
  async function rotateOnce(): Promise<string> {
    await seeded()
    await sentinel()
    const a = startSidecar(args())
    await a.waitFor(ready, 60_000)
    expect(await a.stop()).toBe(0)
    return fake.reissues[0]!.issued!
  }

  it('a restart with the old --token: refused, the stored credential is used (credential-from-store)', async () => {
    await rotateOnce()
    const p = await bootToSync()
    expect(p.lines.map((l) => l.evt).slice(0, 3)).toEqual(['discovered', 'credential-from-store', 'whoami'])
    expect(fake.reissues).toHaveLength(1)
    await p.stop()
  })

  it('a stored credential of another seed is not used: 78 as before', async () => {
    await rotateOnce()
    const other = 'mpt_another_seed_DoNotLog_42'
    fake.kill(other)
    const p = startSidecar(['--server', fake.url, '--token', other, '--store', store])
    expect(await p.exited).toBe(78)
    expect(p.lines.at(-1)).toMatchObject({ evt: 'credential-refused', stage: 'boot' })
    expect(p.lines.some(evt('credential-from-store'))).toBe(false)
  })

  it('the stored credential refused too → 78, nothing removed', async () => {
    const issued = await rotateOnce()
    fake.kill(issued)
    const p = startSidecar(args())
    expect(await p.exited).toBe(78)
    expect(existsSync(join(store, 'credential'))).toBe(true)
    expect(existsSync(join(store, 'instance.lock'))).toBe(true)
  })

  it('the admin reissued in the product: the new --token is accepted, the stale file is removed under the lock', async () => {
    const issued = await rotateOnce()
    fake.kill(issued)
    fake.set({ deviceId: 'FAKEADM001' })
    const admin = 'mpt_admin_reissued_DoNotLog_77'
    const p = startSidecar(['--server', fake.url, '--token', admin, '--store', store])
    await p.waitFor(ready, 60_000)
    expect(p.lines.map((l) => l.evt)).toContain('credential-stale-removed')
    expect(idx(p, 'credential-stale-removed')).toBeGreaterThan(idx(p, 'store'))
    expect(existsSync(join(store, 'credential'))).toBe(false)
    expect(await readJson(join(store, 'identity.json'))).toMatchObject({ deviceId: 'FAKEADM001' })
    await p.stop()
  })

  it('the seed --token still accepted (introspection grace) while the file holds the live credential: the file is used, not removed', async () => {
    await rotateOnce()
    fake.revive(TOKEN)
    const p = await bootToSync()
    expect(p.lines.find(evt('credential-from-store'))).toBeDefined()
    expect(p.lines.some(evt('credential-stale-removed'))).toBe(false)
    expect(existsSync(join(store, 'credential'))).toBe(true)
    await p.stop()
  })

  it('the file changed between the pre-lock read and the lock → 75 credential-changed', async () => {
    await rotateOnce()
    fake.set({ whoamiDelayMs: 1_500 })
    const before = fake.requests.length
    const p = startSidecar(args())
    // The 2nd whoami of this run is the stored credential's: rewrite the file while it is held.
    const whoamis = (): number => fake.requests.slice(before).filter((r) => r.endsWith('/account/whoami')).length
    for (let i = 0; i < 400 && whoamis() < 2; i++) await new Promise((r) => setTimeout(r, 10))
    expect(whoamis()).toBe(2)
    const cred = await readJson(join(store, 'credential'))
    await writeFile(join(store, 'credential'), JSON.stringify({ ...cred, rotatedAt: new Date(0).toISOString() }))
    expect(await p.exited).toBe(75)
    expect(p.lines.at(-1)).toMatchObject({ evt: 'credential-changed' })
  })

  it('without --store: the default store is found by the seed, among this server\'s directories only', async () => {
    const home = await mkdtemp(join(tmpdir(), 'sidecar-home-'))
    try {
      const env = { HOME: home, XDG_DATA_HOME: join(home, 'xdg'), LOCALAPPDATA: join(home, 'local') }
      const base = defaultStoreBase(env, process.platform, home)
      const noStore = ['--server', fake.url, '--token', TOKEN]
      const a = startSidecar(noStore, { env })
      await a.waitFor(ready, 60_000)
      await a.stop()
      const [dir] = await readdir(base)
      const agentDir = join(base, dir!)
      await writeFile(join(agentDir, 'REMEDIATION_NEEDED'), JSON.stringify({ deviceId: 'FAKEDEV001', reason: 'seed' }))
      // A decoy of this server seeded from another token.
      const decoy = join(base, `${dir!.split('-')[0]}-UDECOYDECOY`)
      await mkdir(decoy, { recursive: true })
      await writeFile(join(decoy, 'credential'), JSON.stringify({ token: 'mpt_decoy', seededFrom: sha256('mpt_not_this_seed'), rotatedAt: new Date().toISOString() }))
      const b = startSidecar(noStore, { env })
      await b.waitFor(ready, 60_000)
      expect(fake.reissues).toHaveLength(1)
      expect(b.lines.slice(idx(b, 'credential-rotated')).some(evt('credential-from-store'))).toBe(true)
      expect(await readJson(join(agentDir, 'credential'))).toMatchObject({ seededFrom: sha256(TOKEN) })
      await b.stop()
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
