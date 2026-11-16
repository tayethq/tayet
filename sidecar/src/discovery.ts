// Discovery by the product URL (ADR-087 dec. 2, §0.3.5 adj. 5). The operator gives the product URL;
// the proxy of the deploy serves `/.well-known/tayet/agent` → {"server": …, "account": …}. Only an
// application/json answer with a `server` string counts: the product's SPA answers every unknown path
// with 200 text/html (measured on chat.tayet.app), so a status check alone would accept the app page.
// Dev fallback: on a loopback URL with no well-known (the dev-stack has no proxy), the URL itself is
// tried as the server (`/_matrix/client/versions`), with a warning. Never on a non-loopback URL.
// `account` is the escrow (PLANO-AGENTES §0.3.10 item 4: the operator is learned there at boot): a
// relative path (production, `/escrow`) is resolved against the product URL, an absolute http(s) URL is
// taken as is; absent or unusable → no escrow (and so the `direct` fallback never has one).
import { fetchSettled, UnavailableError, type RetryOptions } from './http'

export interface Discovery {
  server: string
  // The escrow's base URL, resolved (no trailing slash); undefined = none discovered.
  account: string | undefined
  via: 'well-known' | 'direct'
}

export class DiscoveryError extends Error {}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

export function resolveAccount(account: unknown, product: URL): string | undefined {
  if (typeof account !== 'string' || account.trim() === '') return undefined
  let url: URL
  try {
    url = new URL(account, product)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  return trimSlash(url.href)
}

function isJson(res: Response): boolean {
  return (res.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')
}

async function wellKnown(product: URL, opts: RetryOptions): Promise<Discovery | null> {
  const res = await fetchSettled(new URL('/.well-known/tayet/agent', product).href, {}, opts)
  if (!res.ok || !isJson(res)) return null
  const body = (await res.json().catch(() => null)) as { server?: unknown; account?: unknown } | null
  if (body === null || typeof body.server !== 'string') return null
  let server: URL
  try {
    server = new URL(body.server)
  } catch {
    return null
  }
  if (server.protocol !== 'https:' && server.protocol !== 'http:') return null
  return {
    server: trimSlash(server.href),
    account: resolveAccount(body.account, product),
    via: 'well-known',
  }
}

async function direct(product: URL, opts: RetryOptions): Promise<Discovery | null> {
  const res = await fetchSettled(new URL('/_matrix/client/versions', product).href, {}, opts)
  if (!res.ok || !isJson(res)) return null
  const body = (await res.json().catch(() => null)) as { versions?: unknown } | null
  if (body === null || !Array.isArray(body.versions)) return null
  return { server: trimSlash(product.origin), account: undefined, via: 'direct' }
}

export async function discover(productUrl: string, opts: RetryOptions): Promise<Discovery> {
  const product = new URL(productUrl)
  try {
    const found = await wellKnown(product, opts)
    if (found !== null) return found
    if (LOOPBACK.has(product.hostname)) {
      const fallback = await direct(product, opts)
      if (fallback !== null) return fallback
    }
  } catch (err) {
    if (err instanceof UnavailableError) throw new DiscoveryError(`server unreachable (${err.message})`)
    throw err
  }
  throw new DiscoveryError('this is not the URL of a Tayet product (no agent discovery document)')
}
