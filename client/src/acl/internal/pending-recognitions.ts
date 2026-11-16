// Dismissals whose write may not have reached the server yet (ADR-063, adendo 2; PLANO-RELEASE-PUBLICA
// §8.38). acknowledgeAccess records the access here, synchronously, BEFORE the PUT leaves: a reload or a
// close right after the click can lose the write (unload) or let it land after the next boot's server
// read. The next boot of the same account merges this list into the in-memory recognized set before any
// scan, and writes again what the server still lacks.
//
// A hint, never the truth: the server set (account data, ADR-018 §4) stays the source. An entry leaves
// the list once the server read or a sync echo contains it; nothing here ever removes an access from the
// recognized set. Storage unavailable (private mode, quota, Node) = the behaviour before this list.
// Pure helpers, no SDK. The key name carries no protocol term and no raw account id (a short hash of it).

const PREFIX = 'tayet.pending-recognitions.'
// Small cap, oldest dropped: the list only bridges a reload, it is not a store of the set.
export const PENDING_RECOGNITIONS_CAP = 64

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage ?? undefined
  } catch {
    return undefined
  }
}

// FNV-1a, 32 bits: scopes the key per account without writing the account id in it.
export function accountHash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

const keyFor = (account: string): string => PREFIX + accountHash(account)

export function readPendingRecognitions(account: string): string[] {
  try {
    const raw = storage()?.getItem(keyFor(account))
    const list: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? list.filter((d): d is string => typeof d === 'string') : []
  } catch {
    return []
  }
}

function write(account: string, list: string[]): void {
  try {
    const s = storage()
    if (!s) return
    if (list.length === 0) s.removeItem(keyFor(account))
    else s.setItem(keyFor(account), JSON.stringify(list))
  } catch {
    // best-effort: without the list, a late write degrades to the benign re-notification (ADR-018 §4)
  }
}

export function addPendingRecognition(account: string, id: string): void {
  const list = readPendingRecognitions(account).filter((d) => d !== id)
  list.push(id)
  write(account, list.slice(-PENDING_RECOGNITIONS_CAP))
}

// Drop the entries the server is known to hold (its read, or a sync echo).
export function settlePendingRecognitions(account: string, onServer: ReadonlySet<string>): void {
  const list = readPendingRecognitions(account)
  const left = list.filter((d) => !onServer.has(d))
  if (left.length !== list.length) write(account, left)
}

// Every account's list: called where the session's local state is wiped (sign-out, dead session,
// diverged device). One session per browser (session-store.ts), so no other account's list survives.
export function clearAllPendingRecognitions(): void {
  try {
    const s = storage()
    if (!s) return
    const keys: string[] = []
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i)
      if (k?.startsWith(PREFIX)) keys.push(k)
    }
    for (const k of keys) s.removeItem(k)
  } catch {
    // best-effort, like the store wipe it accompanies
  }
}
