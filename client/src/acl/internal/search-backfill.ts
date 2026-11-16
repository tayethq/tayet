import type { SearchCursor } from './search-store'

// ADR-074 dec. 3/4: the idle backfill of the local search index. Conversation by conversation (most
// recent activity first), backwards from the persisted cursor (or, the first time, from the live
// timeline, whose window is indexed first), at most BACKFILL_PAGES_PER_BOOT pages per conversation per
// boot, one request in flight. Pure: the gateway supplies the ports (rooms, pages, cursors, the user's
// activity, the clock), so the policy is unit-testable without the SDK.

export const BACKFILL_PAGES_PER_BOOT = 10
export const BACKFILL_PAGE_SIZE = 30
// A getTimeline/sendMessage of the user postpones the next step by at least this long after it ends.
export const BACKFILL_IDLE_MS = 2_000
// The wait on a rate limit that does not say how long.
export const BACKFILL_RATE_LIMIT_DEFAULT_MS = 5_000
// How often a wait re-checks for cancellation (a disconnect must not sit behind a long sleep).
const WAIT_SLICE_MS = 250

export interface SearchState {
  preparing: boolean
  partial: boolean
}

export interface BackfillPorts {
  // The conversations the session is in, with their latest activity (ms).
  rooms(): Array<{ roomId: string; lastActive: number }>
  cursor(roomId: string): SearchCursor | undefined
  setCursor(cursor: SearchCursor): void
  // Index the live timeline's window and return the token to go older from it (undefined = nothing older).
  liveStart(roomId: string): Promise<string | undefined>
  // Fetch and index one older page; `end` undefined = the start of the conversation was reached.
  fetchOlder(roomId: string, token: string): Promise<{ end?: string }>
  // A rate-limit failure → how long to wait before retrying the same page; anything else → undefined.
  rateLimitWait(err: unknown): number | undefined
  // How long the user's activity still holds the backfill back (0 = free to go).
  busyFor(): number
  sleep(ms: number): Promise<void>
  cancelled(): boolean
  publish(state: SearchState): void
}

export async function runSearchBackfill(p: BackfillPorts): Promise<void> {
  const spent = new Map<string, number>()
  const pending = (roomId: string): boolean => !p.cursor(roomId)?.done
  const hasBudget = (roomId: string): boolean => (spent.get(roomId) ?? 0) < BACKFILL_PAGES_PER_BOOT

  // Dec. 4, over the conversations as they are now.
  const state = (): SearchState => {
    let preparing = false
    let partial = false
    for (const { roomId } of p.rooms()) {
      if (!pending(roomId)) continue
      if (hasBudget(roomId)) preparing = true
      else partial = true
    }
    return { preparing, partial }
  }

  const wait = async (ms: number): Promise<void> => {
    for (let left = ms; left > 0 && !p.cancelled(); left -= WAIT_SLICE_MS) await p.sleep(Math.min(left, WAIT_SLICE_MS))
  }

  p.publish(state())
  let current: string | undefined
  while (!p.cancelled()) {
    const rooms = p.rooms().sort((a, b) => b.lastActive - a.lastActive)
    const eligible = (roomId: string): boolean => pending(roomId) && hasBudget(roomId)
    // Stay on a conversation until it is done or out of budget; then the most active one left.
    if (!current || !eligible(current) || !rooms.some((r) => r.roomId === current)) {
      current = rooms.find((r) => eligible(r.roomId))?.roomId
    }
    if (!current) break

    for (let busy = p.busyFor(); busy > 0 && !p.cancelled(); busy = p.busyFor()) await wait(busy)
    if (p.cancelled()) break

    const roomId = current
    try {
      let token = p.cursor(roomId)?.token
      if (token === undefined) {
        token = await p.liveStart(roomId)
        if (p.cancelled()) break
        if (token === undefined) {
          p.setCursor({ roomId, done: true })
          p.publish(state())
          continue
        }
        p.setCursor({ roomId, token, done: false })
      }
      const { end } = await p.fetchOlder(roomId, token)
      if (p.cancelled()) break
      spent.set(roomId, (spent.get(roomId) ?? 0) + 1)
      p.setCursor(end === undefined ? { roomId, done: true } : { roomId, token: end, done: false })
    } catch (err) {
      if (p.cancelled()) break
      const retryIn = p.rateLimitWait(err)
      if (retryIn !== undefined) {
        await wait(retryIn)
        continue
      }
      // Any other failure ends this conversation's turn for this boot (no hot loop); the cursor stays.
      spent.set(roomId, BACKFILL_PAGES_PER_BOOT)
    }
    p.publish(state())
  }
}
