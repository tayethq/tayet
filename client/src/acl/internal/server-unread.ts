import { MemoryStore, type ISyncResponse } from 'matrix-js-sdk'

// ADR-068: the channel count is the SERVER's count, read the same way in encrypted and cleartext
// rooms. In an encrypted room the SDK drops the server's non-zero totals (sync.ts:1293, room;
// sync.ts:1322, per thread) and recounts on decrypt, so no SDK getter returns them. The /sync response
// does carry them, for both kinds of room (PLANO-RELEASE-PUBLICA §8.32), and the createClient's public
// `store` option receives that response whole in setSyncData, AFTER the SDK processed it
// (sync.ts:906, `await this.client.store.setSyncData(data);`). This store keeps the default
// MemoryStore behaviour (every override calls super) and only reads the counts on the way.
//
// Rules (D2): a room absent from an incremental sync keeps its value; a thread absent from the room's
// map is 0 (and so is every thread when the map itself is absent); a left room is dropped. `onChanged` runs AFTER the capture with the
// rooms whose value changed (D3) — the SDK's RoomEvent.UnreadNotifications fires earlier, inside
// processSyncResponse, and would read the previous value. It must not throw (the caller guards it):
// setSyncData is awaited by the sync loop.

import type { ServerCounts, RoomServerUnread } from '@tayet/shared/internal'
export type { ServerCounts, RoomServerUnread }

type StoreOpts = ConstructorParameters<typeof MemoryStore>[0]

const ZERO: ServerCounts = { total: 0, highlight: 0 }

function countsOf(raw: unknown): ServerCounts | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as { notification_count?: unknown; highlight_count?: unknown }
  const total = typeof r.notification_count === 'number' ? r.notification_count : 0
  const highlight = typeof r.highlight_count === 'number' ? r.highlight_count : 0
  return { total, highlight }
}

function sameCounts(a: ServerCounts, b: ServerCounts): boolean {
  return a.total === b.total && a.highlight === b.highlight
}

function sameRoom(a: RoomServerUnread, b: RoomServerUnread): boolean {
  if (!sameCounts(a.room, b.room) || a.threads.size !== b.threads.size) return false
  for (const [id, c] of a.threads) {
    const other = b.threads.get(id)
    if (!other || !sameCounts(c, other)) return false
  }
  return true
}

export class ServerUnreadStore extends MemoryStore {
  private readonly byRoom = new Map<string, RoomServerUnread>()

  constructor(
    opts: StoreOpts,
    private readonly onChanged: (roomIds: string[]) => void,
  ) {
    super(opts)
  }

  override setSyncData(syncData: ISyncResponse): Promise<void> {
    const done = super.setSyncData(syncData)
    const changed = this.capture(syncData)
    if (changed.length > 0) this.onChanged(changed)
    return done
  }

  override deleteAllData(): Promise<void> {
    this.byRoom.clear()
    return super.deleteAllData()
  }

  /** The captured server counts of a room; undefined before the room appeared in any sync. */
  get(roomId: string): RoomServerUnread | undefined {
    return this.byRoom.get(roomId)
  }

  private capture(syncData: ISyncResponse): string[] {
    const changed: string[] = []
    for (const roomId of Object.keys(syncData.rooms?.leave ?? {})) this.byRoom.delete(roomId)
    for (const [roomId, joined] of Object.entries(syncData.rooms?.join ?? {})) {
      const raw = joined as unknown as Record<string, unknown>
      const prev = this.byRoom.get(roomId)
      const room = countsOf(raw.unread_notifications) ?? prev?.room ?? ZERO
      // Synapse omits unread_thread_notifications when no thread has a count (measured, §8.32): a
      // room present in the sync without the map has every thread at 0.
      const rawThreads = raw.unread_thread_notifications
      const threads = new Map<string, ServerCounts>()
      if (rawThreads && typeof rawThreads === 'object') {
        for (const [threadId, c] of Object.entries(rawThreads as Record<string, unknown>)) {
          const counts = countsOf(c)
          if (counts && (counts.total > 0 || counts.highlight > 0)) threads.set(threadId, counts)
        }
      }
      const value: RoomServerUnread = { room, threads }
      if (prev && sameRoom(prev, value)) continue
      this.byRoom.set(roomId, value)
      changed.push(roomId)
    }
    return changed
  }
}
