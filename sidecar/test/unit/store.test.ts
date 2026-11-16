import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { personToken } from '../../src/api/ids'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultStoreBase,
  defaultStoreDir,
  ensureStorageKey,
  planBoot,
  readMarker,
  readSentinel,
  StorageKeyError,
  type IdentityMarker,
  type Sentinel,
} from '../../src/store'

// The store's pure rules (PLANO-AGENTES §0.3.1 S2.2, §0.3.5 adjs. 4, 6, 10). The process-level
// behaviour (lock, wipes on disk, exits) is in boot.test.ts.

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sidecar-store-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('default path (S2.2): one directory per (server, agent)', () => {
  it('per OS base', () => {
    expect(defaultStoreBase({}, 'linux', '/h')).toBe('/h/.local/share/tayet-agent')
    expect(defaultStoreBase({ XDG_DATA_HOME: '/x' }, 'linux', '/h')).toBe('/x/tayet-agent')
    expect(defaultStoreBase({}, 'darwin', '/h')).toBe('/h/Library/Application Support/tayet-agent')
    expect(defaultStoreBase({ LOCALAPPDATA: 'C:/L' }, 'win32', '/h')).toBe(join('C:/L', 'tayet-agent'))
  })

  it('<short hash of the server>-<agent token U…>; two agents or two servers never collide (§0.3.12 item 9)', () => {
    const one = personToken('@a-abcdefghijkl:matrix.one')
    const two = personToken('@a-mnopqrstuvwx:matrix.one')
    const a = defaultStoreDir('https://matrix.one', one, '/b')
    expect(a).toMatch(/^\/b\/[0-9a-f]{8}-U[A-Z2-7]{10}$/)
    expect(a).not.toContain('a-abcdefghijkl')
    expect(defaultStoreDir('https://matrix.one', two, '/b')).not.toBe(a)
    expect(defaultStoreDir('https://matrix.two', one, '/b')).not.toBe(a)
    expect(defaultStoreDir('https://matrix.one', one, '/b')).toBe(a)
  })
})

describe('storage.key', () => {
  it('created once with O_EXCL and 0600; later boots read the same key', async () => {
    const first = await ensureStorageKey(dir)
    expect(first.created).toBe(true)
    expect(first.key).toHaveLength(32)
    expect(((await stat(join(dir, 'storage.key'))).mode & 0o777).toString(8)).toBe('600')
    const again = await ensureStorageKey(dir)
    expect(again.created).toBe(false)
    expect(Buffer.from(again.key).equals(Buffer.from(first.key))).toBe(true)
  })

  it('a key that is not strict base64 or not 32 bytes is refused (never regenerated in place)', async () => {
    for (const raw of ['not base64!', Buffer.alloc(16).toString('base64')]) {
      await writeFile(join(dir, 'storage.key'), raw)
      await expect(ensureStorageKey(dir)).rejects.toBeInstanceOf(StorageKeyError)
      expect(await readFile(join(dir, 'storage.key'), 'utf8')).toBe(raw)
    }
  })
})

describe('marker and sentinels on disk', () => {
  it('a marker missing userId/server reads as null', async () => {
    await writeFile(join(dir, 'identity.json'), JSON.stringify({ deviceId: 'D', ed25519: 'e', curve25519: 'c' }))
    expect(await readMarker(dir)).toBeNull()
  })

  it('REVOKED wins over REMEDIATION_NEEDED; an unreadable sentinel has no device', async () => {
    await writeFile(join(dir, 'REMEDIATION_NEEDED'), '{rasgado')
    expect(await readSentinel(dir)).toMatchObject({ kind: 'remediation', deviceId: undefined })
    await writeFile(join(dir, 'REVOKED'), JSON.stringify({ deviceId: 'D1' }))
    expect(await readSentinel(dir)).toMatchObject({ kind: 'revoked', deviceId: 'D1' })
  })
})

describe('planBoot (adj. 4) — with the whoami of the boot', () => {
  const server = 'https://matrix.one'
  const identity = { userId: '@a-abcdefghijkl:one', deviceId: 'D2' }
  const marker = (over: Partial<IdentityMarker> = {}): IdentityMarker => ({
    deviceId: 'D2', ed25519: 'e', curve25519: 'c', userId: identity.userId, server, ...over,
  })
  const sentinel = (kind: Sentinel['kind'], deviceId: string | undefined): Sentinel => ({ kind, deviceId, raw: '' })

  it.each([
    ['empty store', null, null, { action: 'proceed' }],
    ['same device', marker(), null, { action: 'proceed' }],
    ['marker of another agent', marker({ userId: '@a-zzzzzzzzzzzz:one' }), null, { action: 'mismatch', field: 'userId' }],
    ['marker of another server', marker({ server: 'https://matrix.two' }), null, { action: 'mismatch', field: 'server' }],
    ['mismatch wins over a sentinel', marker({ userId: '@a-zzzzzzzzzzzz:one' }), sentinel('revoked', 'D1'), { action: 'mismatch', field: 'userId' }],
    ['marker of another device', marker({ deviceId: 'D1' }), null, { action: 'wipe', reason: 'device-changed', previousDeviceId: 'D1' }],
    ['REMEDIATION same device', marker(), sentinel('remediation', 'D2'), { action: 'halt', sentinel: 'remediation' }],
    ['REVOKED same device, no marker', null, sentinel('revoked', 'D2'), { action: 'halt', sentinel: 'revoked' }],
    ['REVOKED of another device, no marker', null, sentinel('revoked', 'D1'), { action: 'wipe', reason: 'sentinel-cleared', previousDeviceId: 'D1' }],
    ['REMEDIATION of another device', marker({ deviceId: 'D1' }), sentinel('remediation', 'D1'), { action: 'wipe', reason: 'sentinel-cleared', previousDeviceId: 'D1' }],
    ['unreadable sentinel, marker of the same device', marker(), sentinel('remediation', undefined), { action: 'halt', sentinel: 'remediation' }],
    ['unreadable sentinel, marker of another device', marker({ deviceId: 'D1' }), sentinel('remediation', undefined), { action: 'wipe', reason: 'sentinel-cleared', previousDeviceId: 'D1' }],
    ['unreadable sentinel, no marker: never wipe blind', null, sentinel('revoked', undefined), { action: 'halt', sentinel: 'revoked' }],
  ] as const)('%s', (_name, m, s, expected) => {
    expect(planBoot({ marker: m, sentinel: s, identity, server })).toEqual(expected)
  })
})
