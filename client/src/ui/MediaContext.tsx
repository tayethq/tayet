import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { MediaRef, MediaVariant, ResolvedMedia } from '@tayet/client'

type Resolver = (ref: MediaRef, variant?: MediaVariant) => Promise<ResolvedMedia>

const MediaContext = createContext<Resolver | undefined>(undefined)

// Provides the ACL's resolveMedia to the tree so useMedia stays decoupled from the Acl instance.
// The context value is STABLE across renders even when the caller passes a fresh function each time
// (App passes an inline arrow): useMedia keys its effect on the resolver, so an unstable one re-ran
// every resolution on every App render — revoking the blob URL, flashing the placeholder and
// re-downloading the bytes, which made an image row collapse and grow again on any state change
// (§8.27 B; the revoked blob also surfaced as ERR_FILE_NOT_FOUND in the E2E console ledger).
export function MediaProvider({ resolve, children }: { resolve: Resolver; children: ReactNode }) {
  const latest = useRef(resolve)
  useEffect(() => {
    latest.current = resolve
  }, [resolve])
  const stable = useCallback<Resolver>((ref, variant) => latest.current(ref, variant), [])
  return <MediaContext.Provider value={stable}>{children}</MediaContext.Provider>
}

// ADR-009 lifecycle: resolve on mount, release() on unmount (revokes the object URL — no leak).
// `status` tells waiting from failure (ADR-007 §3: content-carrying degradation is visible, never a
// silent drop): 'loading' while pending / with no provider, 'ready' with the per-session `url`,
// 'failed' when the resolver rejected. `retry()` re-runs the resolution.
export type MediaStatus = 'loading' | 'ready' | 'failed'
export interface MediaState {
  url?: string
  status: MediaStatus
  retry: () => void
}

export function useMedia(ref: MediaRef | undefined, variant?: MediaVariant): MediaState {
  const resolve = useContext(MediaContext)
  const [state, setState] = useState<{ url?: string; status: MediaStatus }>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!ref || !resolve) return
    let alive = true
    let release: (() => void) | undefined
    resolve(ref, variant)
      .then((m) => {
        if (alive) {
          setState({ url: m.url, status: 'ready' })
          release = m.release
        } else {
          m.release()
        }
      })
      .catch(() => {
        if (alive) setState({ status: 'failed' })
      })
    return () => {
      alive = false
      release?.()
      setState({ status: 'loading' })
    }
  }, [ref, resolve, variant, attempt])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  return { ...state, retry }
}
