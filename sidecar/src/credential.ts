// The credential the agent reissued for itself (ADR-087 decs. 3 and 9, addendum S-h; PLANO-AGENTES
// §0.3.14). It exists only after a self-reissue: `<store>/credential` = { token, seededFrom, rotatedAt }.
//
// - `token`: the credential the escrow answered in the 201 of the reissue. A secret of the same class
//   as storage.key: 0600, written by tmp+rename (writeJsonAtomic), never logged.
// - `seededFrom`: sha256 hex of the seed token (the --token / TAYET_AGENT_TOKEN in use when the FIRST
//   rotation happened), kept across later rotations. It ties the file to the operator's configuration
//   without storing the seed: the default store is found by it (findCredential below).
// - `rotatedAt`: ISO instant of the last rotation (the local floor of 10 min).
//
// The --token is always tried first; the file is read only when the server refuses it. That read
// (readCredential / findCredential) is the ONLY read of the store before instance.lock, and it only
// reads; the boot reads the file again under the lock and requires the same bytes (else 75). Every
// write and removal happens with the lock held (store.ts header).
import { createHash } from 'node:crypto'
import { readdir, readFile, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { defaultStoreBase, defaultStoreDir, FILES, writeJsonAtomic } from './store'

export interface StoredCredential {
  token: string
  seededFrom: string
  rotatedAt: string
}

// What was read: the parsed credential and the exact bytes (re-checked under the lock).
export interface CredentialRead {
  credential: StoredCredential
  raw: string
  dir: string
}

export const ROTATION_FLOOR_MS = 10 * 60_000

export const seedHash = (token: string): string => createHash('sha256').update(token).digest('hex')

const SHA256_HEX = /^[0-9a-f]{64}$/

export function parseCredential(raw: string): StoredCredential | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (value === null || typeof value !== 'object') return null
  const c = value as Partial<Record<keyof StoredCredential, unknown>>
  if (typeof c.token !== 'string' || c.token.length === 0) return null
  if (typeof c.seededFrom !== 'string' || !SHA256_HEX.test(c.seededFrom)) return null
  if (typeof c.rotatedAt !== 'string' || Number.isNaN(Date.parse(c.rotatedAt))) return null
  return { token: c.token, seededFrom: c.seededFrom, rotatedAt: c.rotatedAt }
}

// The raw bytes of <dir>/credential, or null when absent or unreadable.
export async function readCredentialRaw(dir: string): Promise<string | null> {
  return readFile(join(dir, FILES.credential), 'utf8').catch(() => null)
}

export async function readCredential(dir: string): Promise<CredentialRead | null> {
  const raw = await readCredentialRaw(dir)
  if (raw === null) return null
  const credential = parseCredential(raw)
  return credential === null ? null : { credential, raw, dir }
}

// The credential of a refused --token (boot step 3), read-only and before the lock:
// - with --store: <store>/credential;
// - without: only the directories of defaultStoreBase() that carry this server's prefix (the one
//   defaultStoreDir uses), and only if exactly one of them holds a credential seeded from this token.
// In both cases the file must have been seeded from this --token: a credential of another seed is not
// this configuration's (PLANO-AGENTES §8.25).
export async function findCredential(input: {
  store: string | undefined
  server: string
  seed: string
  base?: string
}): Promise<CredentialRead | null> {
  const want = seedHash(input.seed)
  if (input.store !== undefined) {
    const found = await readCredential(input.store)
    return found !== null && found.credential.seededFrom === want ? found : null
  }
  const base = input.base ?? defaultStoreBase()
  // defaultStoreDir(server, X) = <base>/<8 hex of the server>-X: the prefix alone, from the same function.
  const prefix = basename(defaultStoreDir(input.server, '', base))
  const entries = await readdir(base, { withFileTypes: true }).catch(() => [])
  const matches: CredentialRead[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue
    const found = await readCredential(join(base, entry.name))
    if (found !== null && found.credential.seededFrom === want) matches.push(found)
  }
  return matches.length === 1 ? (matches[0] as CredentialRead) : null
}

// With instance.lock held. Written BEFORE the device is wiped (a crash in between leaves the new
// credential on disk and the old store, which the new device's boot wipes as device-changed).
export async function writeCredential(dir: string, credential: StoredCredential): Promise<void> {
  await writeJsonAtomic(join(dir, FILES.credential), credential)
}

// With instance.lock held: the admin reissued in the product and the new --token is accepted.
export async function removeCredential(dir: string): Promise<void> {
  await rm(join(dir, FILES.credential), { force: true })
}

export function underFloor(credential: StoredCredential, now: number = Date.now()): boolean {
  return now - Date.parse(credential.rotatedAt) < ROTATION_FLOOR_MS
}
