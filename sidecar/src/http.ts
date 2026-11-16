// Bounded retry for the two pre-SDK requests of the boot (discovery, whoami). A definitive answer
// (any HTTP status but 429/5xx) returns at once; network errors, 5xx and 429 retry until the deadline
// (429 honours retry_after_ms, as the custody agent's authedJson does).
export class UnavailableError extends Error {}

export interface RetryOptions {
  deadlineMs: number
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export async function fetchSettled(url: string, init: RequestInit, opts: RetryOptions): Promise<Response> {
  const doFetch = opts.fetch ?? fetch
  const sleep = opts.sleep ?? defaultSleep
  const deadline = Date.now() + opts.deadlineMs
  let last: string
  for (;;) {
    let wait = 2_000
    try {
      const res = await doFetch(url, { ...init, signal: AbortSignal.timeout(15_000) })
      if (res.status === 429) {
        const body = (await res.json().catch(() => ({}))) as { retry_after_ms?: unknown }
        wait = (typeof body.retry_after_ms === 'number' ? body.retry_after_ms : 500) + 100
        last = 'HTTP 429'
      } else if (res.status >= 500) {
        last = `HTTP ${res.status}`
      } else {
        return res
      }
    } catch (err) {
      last = err instanceof Error ? err.message : String(err)
    }
    if (Date.now() + wait > deadline) throw new UnavailableError(`${new URL(url).pathname}: ${last}`)
    await sleep(wait)
  }
}
