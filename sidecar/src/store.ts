// The agent's local store (ADR-087 dec. 3; PLANO-AGENTES §0.3.1 S2.2, §0.3.5 adjs. 4, 6, 7, 10).
//
//   <store>/instance.lock/      LevelDB directory held open for the life of the process (P-S1)
//   <store>/storage.key         32 random bytes, base64, created with O_EXCL and mode 0600 on 1st boot
//   <store>/identity.json       marker: device + its keys (as the custody agent's) + userId + server
//   <store>/indexeddb/          the crypto store (node-indexeddb over LevelDB), encrypted by storage.key
//   <store>/REMEDIATION_NEEDED  sentinel: the store is unusable for this device (reissue in the product)
//   <store>/REVOKED             sentinel: the credential was revoked while this process ran
//   <store>/checkpoint.json     last instant alive with a healthy sync
//   <store>/local.token         the local API's token (`tal_…`), O_EXCL + 0600, kept across wipes (S-c1)
//   <store>/api.json            { url, pid } of the running local API, 0600, never the token (S-c1)
//   <store>/credential          { token, seededFrom, rotatedAt }, 0600: only after a self-reissue (S-h,
//                               credential.ts); a secret like storage.key, kept across the device wipes
//   <store>/approvals.json      the agent's open approval cards (A3-3, core/approvals.ts), 0600: API
//                               tokens (conversation + ts) and the options, never a protocol id
//   <store>/slack-cards.json    the Slack layer's approval cards (A3-4, api/slack/cards.ts), 0600: API
//                               tokens and the agent's action_id/block_id/value per option
//   <store>/commands.json       the agent's declared `/` commands and, per conversation, the hash of the
//                               version written there (A4-2a, core/commands.ts), 0600: API tokens only;
//                               kept across the device wipes, as approvals.json
//
// Only the holder of instance.lock WRITES anything else here (adj. 10; PLANO-AGENTES §0.3.13 item 5). The
// stdio bridge (mcp/bridge.ts) reads api.json and local.token, and nothing else, without the lock. The
// boot reads `credential`, and nothing else, before the lock, only when the --token was refused, and
// reads it again under the lock (PLANO-AGENTES §0.3.14 item 2).
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ClassicLevel } from 'classic-level'

export const FILES = {
  lock: 'instance.lock',
  key: 'storage.key',
  marker: 'identity.json',
  indexeddb: 'indexeddb',
  remediation: 'REMEDIATION_NEEDED',
  revoked: 'REVOKED',
  checkpoint: 'checkpoint.json',
  localToken: 'local.token',
  api: 'api.json',
  credential: 'credential',
  approvals: 'approvals.json',
  // The Slack layer's approval cards (A3-4, api/slack/cards.ts): the `action_id`/`block_id`/`value` a
  // click gives back; API tokens only.
  slackCards: 'slack-cards.json',
  // The agent's declared commands and the hash written per conversation (A4-2a, core/commands.ts); API
  // tokens only.
  commands: 'commands.json',
} as const

// ── Default path (S2.2): one directory per (server, agent) ─────────────────────────────────

export function defaultStoreBase(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'tayet-agent')
  if (platform === 'win32') return join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'tayet-agent')
  const xdg = env.XDG_DATA_HOME
  return join(xdg !== undefined && xdg !== '' ? xdg : join(home, '.local', 'share'), 'tayet-agent')
}

// `agent` is the agent's person token (`U…`, api/ids.ts), never its localpart: the path reaches the
// `store` log line, and a log line carries no protocol id by default (PLANO-AGENTES §0.3.12 item 9).
export function defaultStoreDir(server: string, agent: string, base = defaultStoreBase()): string {
  const short = createHash('sha256').update(server).digest('hex').slice(0, 8)
  return join(base, `${short}-${agent}`)
}

// ── instance.lock ─────────────────────────────────────────────────────────────────────────

export class LockBusyError extends Error {}

export interface InstanceLock {
  close(): Promise<void>
}

// Explicit open() (the deferred open of `new Level()` hides the cause, P-S1). Only LEVEL_LOCKED is
// "another instance": any other failure to open the lock directory propagates as itself.
export async function acquireLock(storeDir: string): Promise<InstanceLock> {
  const db = new ClassicLevel(join(storeDir, FILES.lock))
  try {
    await db.open()
  } catch (err) {
    if ((err as { cause?: { code?: unknown } }).cause?.code === 'LEVEL_LOCKED') {
      throw new LockBusyError('another instance is using this store directory')
    }
    throw err
  }
  return { close: () => db.close() }
}

// ── storage.key ───────────────────────────────────────────────────────────────────────────

export class StorageKeyError extends Error {}

const STRICT_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

export async function ensureStorageKey(storeDir: string): Promise<{ key: Uint8Array; encoded: string; created: boolean }> {
  const file = join(storeDir, FILES.key)
  let created = false
  try {
    const handle = await open(file, 'wx', 0o600)
    try {
      await handle.writeFile(randomBytes(32).toString('base64'))
    } finally {
      await handle.close()
    }
    created = true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }
  const encoded = (await readFile(file, 'utf8')).trim()
  if (!STRICT_BASE64.test(encoded)) throw new StorageKeyError('storage.key: not valid base64')
  const key = Uint8Array.from(Buffer.from(encoded, 'base64'))
  if (key.length !== 32) throw new StorageKeyError(`storage.key: expected 32 bytes, got ${key.length}`)
  return { key, encoded, created }
}

// ── local.token (PLANO-AGENTES §0.3.6 adj. 2) ─────────────────────────────────────────────────
// The local API's bearer token: `tal_` + 32 random bytes in base64url, created with O_EXCL and mode
// 0600 on the 1st boot, kept across the revocation and reissue wipes (like storage.key), never
// printed. It is not the server credential: it opens the local API only.
export class LocalTokenError extends Error {}

const LOCAL_TOKEN = /^tal_[A-Za-z0-9_-]{43}$/

export async function ensureLocalToken(storeDir: string): Promise<{ token: string; created: boolean }> {
  const file = join(storeDir, FILES.localToken)
  let created = false
  try {
    const handle = await open(file, 'wx', 0o600)
    try {
      await handle.writeFile(`tal_${randomBytes(32).toString('base64url')}`)
    } finally {
      await handle.close()
    }
    created = true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }
  const token = (await readFile(file, 'utf8')).trim()
  if (!LOCAL_TOKEN.test(token)) throw new LocalTokenError('local.token: not a local token')
  return { token, created }
}

// --rotate-local-token, with the instance lock held (the agent is stopped).
export async function rotateLocalToken(storeDir: string): Promise<void> {
  await rm(join(storeDir, FILES.localToken), { force: true })
  await ensureLocalToken(storeDir)
}

// ── JSON files ────────────────────────────────────────────────────────────────────────────

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(value), { mode: 0o600 })
  await rename(tmp, file)
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown
  } catch {
    return null
  }
}

export interface IdentityMarker {
  deviceId: string
  ed25519: string
  curve25519: string
  userId: string
  server: string
}

export async function readMarker(storeDir: string): Promise<IdentityMarker | null> {
  const m = (await readJson(join(storeDir, FILES.marker))) as Partial<IdentityMarker> | null
  if (
    m !== null &&
    typeof m.deviceId === 'string' &&
    typeof m.ed25519 === 'string' &&
    typeof m.curve25519 === 'string' &&
    typeof m.userId === 'string' &&
    typeof m.server === 'string'
  ) {
    return m as IdentityMarker
  }
  return null
}

export type SentinelKind = 'remediation' | 'revoked'

export interface Sentinel {
  kind: SentinelKind
  // The device the sentinel was written for; undefined if the file is unreadable.
  deviceId: string | undefined
  raw: string
}

// REVOKED wins when both exist: it is terminal for that device.
export async function readSentinel(storeDir: string): Promise<Sentinel | null> {
  for (const kind of ['revoked', 'remediation'] as const) {
    const raw = await readFile(join(storeDir, FILES[kind]), 'utf8').catch(() => null)
    if (raw === null) continue
    let deviceId: string | undefined
    try {
      const parsed = JSON.parse(raw) as { deviceId?: unknown }
      deviceId = typeof parsed.deviceId === 'string' ? parsed.deviceId : undefined
    } catch {
      deviceId = undefined
    }
    return { kind, deviceId, raw: raw.trim() }
  }
  return null
}

export async function writeSentinel(
  storeDir: string,
  kind: SentinelKind,
  body: { deviceId: string; reason?: string; message?: string },
): Promise<void> {
  await writeJsonAtomic(join(storeDir, FILES[kind]), { ...body, at: new Date().toISOString() })
}

// The device's state: crypto store + marker (+ sentinels when clearing them). storage.key survives
// every wipe (adj. 4): it belongs to the directory, not to a device.
export async function wipeDevice(storeDir: string, opts: { sentinels: boolean }): Promise<void> {
  await rm(join(storeDir, FILES.indexeddb), { recursive: true, force: true })
  await rm(join(storeDir, FILES.marker), { force: true })
  if (opts.sentinels) {
    await rm(join(storeDir, FILES.remediation), { force: true })
    await rm(join(storeDir, FILES.revoked), { force: true })
  }
}

export async function ensureStoreDir(storeDir: string): Promise<void> {
  await mkdir(storeDir, { recursive: true, mode: 0o700 })
}

// ── Boot plan (pure): what the store says, given who the credential is ──────────────────────

export type BootPlan =
  | { action: 'proceed' }
  | { action: 'mismatch'; field: 'userId' | 'server' }
  | { action: 'halt'; sentinel: SentinelKind }
  | { action: 'wipe'; reason: 'device-changed' | 'sentinel-cleared'; previousDeviceId: string | undefined }

export function planBoot(input: {
  marker: IdentityMarker | null
  sentinel: Sentinel | null
  identity: { userId: string; deviceId: string }
  server: string
}): BootPlan {
  const { marker, sentinel, identity, server } = input
  // Another agent's or another server's store: an operator error. Nothing is deleted.
  if (marker !== null && marker.userId !== identity.userId) return { action: 'mismatch', field: 'userId' }
  if (marker !== null && marker.server !== server) return { action: 'mismatch', field: 'server' }
  if (sentinel !== null) {
    // The device the sentinel speaks of (REVOKED wipes the marker, so it carries the device itself).
    const known = sentinel.deviceId ?? marker?.deviceId
    // Same device, or a device we cannot tell (unreadable sentinel, no marker): never wipe — a wipe
    // with a live device is the zombie of the custody agent's A1. Exit with the sentinel's code.
    if (known === undefined || known === identity.deviceId) return { action: 'halt', sentinel: sentinel.kind }
    // A new device (the operator reissued in the product): the old store is dead, clear and go on.
    return { action: 'wipe', reason: 'sentinel-cleared', previousDeviceId: known }
  }
  if (marker !== null && marker.deviceId !== identity.deviceId) {
    return { action: 'wipe', reason: 'device-changed', previousDeviceId: marker.deviceId }
  }
  return { action: 'proceed' }
}
