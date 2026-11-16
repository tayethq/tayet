// Opaque pagination cursors of the local API (PLANO-AGENTES §0.3.6 adj. 7): `cur_` + 16 random bytes,
// kept in memory with the listing's state (which may hold the server's own token — it never leaves
// the process). TTL 15 min, LRU of 1000. A cursor can be repeated (a retried request gets the same
// page): `take` hands out a copy and leaves the entry. Unknown or expired → `invalid_cursor`.
import { randomBytes } from 'node:crypto'

export const CURSOR_TTL_MS = 15 * 60_000
export const CURSOR_MAX = 1_000

export class CursorStore<T> {
  private readonly map = new Map<string, { at: number; value: T }>()
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly max: number

  constructor(opts: { now?: () => number; ttlMs?: number; max?: number } = {}) {
    this.now = opts.now ?? Date.now
    this.ttlMs = opts.ttlMs ?? CURSOR_TTL_MS
    this.max = opts.max ?? CURSOR_MAX
  }

  put(value: T): string {
    const id = `cur_${randomBytes(16).toString('base64url')}`
    this.map.set(id, { at: this.now(), value })
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string)
    return id
  }

  take(id: string): T | undefined {
    const entry = this.map.get(id)
    if (entry === undefined) return undefined
    if (this.now() - entry.at > this.ttlMs) {
      this.map.delete(id)
      return undefined
    }
    return structuredClone(entry.value)
  }

  get size(): number {
    return this.map.size
  }
}
