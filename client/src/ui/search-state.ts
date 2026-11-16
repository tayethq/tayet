import type { Acl } from '@tayet/client'

// ADR-074 dec. 4: the search.state of the account's local index, as the UI last saw it. The ACL emits
// it only on transitions, and the first one (the backfill starting) goes out DURING connect — before
// App mounts and useChat/useSearch subscribe. So the Boot starts this watcher right before connect and
// the search hook reads the latest value from it; no barrel read verb is needed (U3, §8.45).
// Addendum 2026-10-28 (#240): `persisting`/`degraded` are carried, not rendered yet (the notice is a
// later slice with its own design rite).
export interface SearchState {
  preparing: boolean
  partial: boolean
  persisting: boolean
  degraded: boolean
}

export interface SearchStateFeed {
  get(): SearchState
  subscribe(listener: (state: SearchState) => void): () => void
}

const IDLE: SearchState = { preparing: false, partial: false, persisting: false, degraded: false }
const feeds = new WeakMap<Acl, SearchStateFeed>()

// Idempotent per Acl: one global subscription for its whole life (the Boot reuses the instance across
// reconnects). A partial Acl without a stream (the Boot's test seams) gets no feed.
export function watchSearchState(acl: Acl): SearchStateFeed | undefined {
  const known = feeds.get(acl)
  if (known) return known
  if (typeof acl.subscribe !== 'function') return undefined
  let state = IDLE
  const listeners = new Set<(state: SearchState) => void>()
  acl.subscribe((e) => {
    if (e.t !== 'search.state') return
    state = { preparing: e.preparing, partial: e.partial, persisting: e.persisting, degraded: e.degraded }
    for (const listener of listeners) listener(state)
  })
  const feed: SearchStateFeed = {
    get: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  feeds.set(acl, feed)
  return feed
}

// The feed the Boot started for this Acl, if any. Never subscribes by itself: a second global handler
// added after useChat's would replace it in the single-handler fakes of the App tests.
export function searchStateOf(acl: Acl): SearchStateFeed | undefined {
  return feeds.get(acl)
}
