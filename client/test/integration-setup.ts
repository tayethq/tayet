// Integration setup — runs once per test file (vite.config.ts setupFiles), inert outside
// test/integration/. Tracks every fetch the file starts and, at the end of the file, waits for the
// ones still in flight to settle before the worker is released.
//
// Why: a request still in flight when the file ends (an SDK crypto keys/query or keys/upload after
// stopClient, a session join) logs on completion; if the worker is already closing, Vitest reports
// `EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending` as an unhandled error
// and the run exits 1 with every test green (PLANO-RELEASE-PUBLICA §8.36).
//
// Nothing is hidden: the wrapper returns the SAME promise the real fetch returned (rejections reach
// their caller unchanged), no log is filtered, and a file whose requests do not settle within the
// wait gets a warning naming how many were left — a leaked client shows up instead of hanging.
//
// Composition: a file that swaps globalThis.fetch captures this wrapper as its "real" fetch at module
// load (setup runs first), so its requests are tracked too.
import { afterAll, expect } from 'vitest'

// Upper bound for the end-of-file wait. A settled teardown drains in milliseconds; this only caps a
// leaked client's long-poll (/sync holds up to 30 s) so the file still ends.
const DRAIN_WAIT_MS = 10_000
const TRACKED = Symbol.for('aurora.integration.fetchTracked')

const testPath = expect.getState().testPath ?? ''
const isIntegration = testPath.includes('/test/integration/')

type TrackedFetch = typeof fetch & { [TRACKED]?: Set<Promise<Response>> }

if (isIntegration && typeof globalThis.fetch === 'function' && !(globalThis.fetch as TrackedFetch)[TRACKED]) {
  const base = globalThis.fetch
  const inflight = new Set<Promise<Response>>()
  const tracked: TrackedFetch = ((...args: Parameters<typeof fetch>) => {
    const pending = base(...args)
    inflight.add(pending)
    const done = (): void => {
      inflight.delete(pending)
    }
    pending.then(done, done)
    return pending
  }) as TrackedFetch
  tracked[TRACKED] = inflight
  globalThis.fetch = tracked

  // Registered before any hook of the file; Vitest runs afterAll hooks in stack order, so this one
  // runs LAST — after the file's own teardown (disconnect) has started the last requests' settle.
  afterAll(async () => {
    const deadline = Date.now() + DRAIN_WAIT_MS
    // Loop: a settled response can start the next request on a later tick (the SDK's outgoing
    // loop), and its completion log runs after the fetch promise resolves. Stop when a macrotask
    // turn passes with nothing in flight.
    for (;;) {
      if (inflight.size > 0) {
        const left = deadline - Date.now()
        if (left <= 0) break
        await Promise.race([Promise.allSettled([...inflight]), new Promise((r) => setTimeout(r, left))])
        continue
      }
      await new Promise((r) => setTimeout(r, 0))
      if (inflight.size === 0) break
    }
    if (inflight.size > 0) {
      console.warn(`[integration-setup] ${inflight.size} request(s) still in flight at the end of the file`)
    }
  }, DRAIN_WAIT_MS + 5_000)
}
