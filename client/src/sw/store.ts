// ADR-117 dec. 4 and 5: what the page and the service worker share, in one Cache API cache of this origin — the
// language the page applied (the push text is built in it) and the click target waiting for the app to open. No
// conversation, no page, no request is cached here (dec. 5): two small JSON entries under keys of our own.
// Imported by the page (src/ui) and by the service worker (src/sw/sw.ts); nothing here touches the ACL.

const CACHE = 'tayet-sw'
const LOCALE_KEY = '/__tayet-sw/locale'
const PENDING_KEY = '/__tayet-sw/pending'
// Fork 3: a pending target older than this is not followed.
export const PENDING_MAX_AGE_MS = 5 * 60_000
// The message the service worker posts to an open window when a notification is clicked.
export const CLICK_MESSAGE = 'tayet.notification-click'

// Where a click leads, as the notification's data carries it. Opaque strings, checked by the ACL before use.
export interface ClickTarget {
  conversation: string
  message?: string
  thread?: string
}

const MAX_ID = 255
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_ID

// A notification's data (or a message's payload) → a target, or undefined when it does not have the shape.
export function clickTargetOf(data: unknown): ClickTarget | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const { conversation, message, thread } = data as Record<string, unknown>
  if (!isId(conversation)) return undefined
  if ((message !== undefined && !isId(message)) || (thread !== undefined && !isId(thread))) return undefined
  const target: ClickTarget = { conversation }
  if (message !== undefined) target.message = message
  if (thread !== undefined) target.thread = thread
  return target
}

async function open(): Promise<Cache | undefined> {
  if (typeof caches === 'undefined') return undefined
  return caches.open(CACHE)
}

async function write(key: string, value: unknown): Promise<void> {
  const cache = await open()
  await cache?.put(key, new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } }))
}

async function read(cache: Cache, key: string): Promise<unknown> {
  const res = await cache.match(key)
  return res ? res.json() : undefined
}

// Best-effort: without the Cache API (or with it refused) the worker falls back to the device's language.
export async function saveWorkerLocale(locale: string): Promise<void> {
  await write(LOCALE_KEY, locale).catch(() => undefined)
}

export async function workerLocale(): Promise<string | undefined> {
  try {
    const cache = await open()
    const value = cache ? await read(cache, LOCALE_KEY) : undefined
    return typeof value === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

export async function savePendingTarget(target: ClickTarget, now: number): Promise<void> {
  await write(PENDING_KEY, { target, at: now })
}

// Sign-out (ADR-117, addendum of 26/Nov/2026, F5): only the pending target goes; the worker's language stays.
export async function clearPendingTarget(): Promise<void> {
  try {
    const cache = await open()
    await cache?.delete(PENDING_KEY)
  } catch {
    // best-effort
  }
}

// Read once: the entry is deleted whether or not it is still fresh, so a target is followed at most once.
export async function takePendingTarget(now: number): Promise<ClickTarget | undefined> {
  try {
    const cache = await open()
    if (!cache) return undefined
    const entry = (await read(cache, PENDING_KEY)) as { target?: unknown; at?: unknown } | undefined
    await cache.delete(PENDING_KEY)
    if (!entry || typeof entry.at !== 'number' || now - entry.at > PENDING_MAX_AGE_MS || entry.at > now) return undefined
    return clickTargetOf(entry.target)
  } catch {
    return undefined
  }
}
