import { ReceiptType, RelationType } from 'matrix-js-sdk'
import type { MatrixEvent, Room } from 'matrix-js-sdk'
import type { ThreadUnread } from '@tayet/shared'

// ── Per-thread unread from receipts (ADR-067) ──────────────────────────────────────────────
// One rule for encrypted and cleartext rooms. It never reads the per-thread notification counts:
// in an encrypted room the SDK recounts on decrypt and Thread.hasUserReadEvent treats every reply
// before the user's first threaded receipt in the room as read (thread.ts, beforeFirstThreadedReceipt;
// room.ts, oldestThreadedReceiptTs = Infinity), so the count stays 0 for a user who never read a
// thread there. Room.hasUserReadEvent goes through RoomReceipts and has no such heuristic.

// The latest reply of a thread, as the server's aggregation bundles it on the root (m.thread
// latest_event). Kept by the ACL for roots of a /messages page, which never enter the room and so
// never get an SDK Thread. Never crosses the barrel.
export type LatestReply = { id: string; sender: string; ts: number }

type BundledThread = { latest_event?: { event_id?: unknown; sender?: unknown; origin_server_ts?: unknown } }

export function latestReplyFromAggregation(root: MatrixEvent | undefined): LatestReply | undefined {
  const latest = root?.getServerAggregatedRelation<BundledThread>(RelationType.Thread)?.latest_event
  if (!latest) return undefined
  const { event_id: id, sender, origin_server_ts: ts } = latest
  if (typeof id !== 'string' || typeof sender !== 'string' || typeof ts !== 'number') return undefined
  return { id, sender, ts }
}

const READ_TYPES: string[] = [ReceiptType.Read, ReceiptType.ReadPrivate]

// Rule (ADR-067 dec. 2), with L = the thread's latest reply:
// - with the SDK's Thread: unread when L is not mine and the room's receipts say I have not read L;
// - without it (a paginated root nothing touched this session): L is the aggregation's latest_event,
//   and it is covered when my threaded receipt for this thread points at L, or when the newest of
//   that receipt and my unthreaded receipt is at or after L's timestamp. The timestamp comparison has
//   a race (a receipt on an earlier reply sent after L reached the server covers L) — accepted, dec. 2.
// - no L (no reply): not unread.
export function threadUnreadOf(room: Room, rootId: string, me: string, paged?: LatestReply): ThreadUnread {
  const thread = room.getThread(rootId)
  const last = thread?.lastReply()
  if (last) {
    const id = last.getId()
    if (!id || last.getSender() === me) return { unread: false }
    return { unread: !room.hasUserReadEvent(me, id) }
  }

  const latest = latestReplyFromAggregation(thread?.rootEvent ?? room.findEventById(rootId)) ?? paged
  if (!latest || latest.sender === me) return { unread: false }
  let threadedTs = 0
  for (const cached of room.cachedThreadReadReceipts.get(rootId) ?? []) {
    if (cached.userId !== me || !READ_TYPES.includes(cached.receiptType)) continue
    if (cached.eventId === latest.id) return { unread: false }
    threadedTs = Math.max(threadedTs, cached.receipt.ts)
  }
  const unthreadedTs = room.getLastUnthreadedReceiptFor(me)?.ts ?? 0
  return { unread: Math.max(threadedTs, unthreadedTs) < latest.ts }
}
