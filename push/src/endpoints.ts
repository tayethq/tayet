// The closed list of push services a subscription may point to. An entry is a host (`fcm.googleapis.com`),
// a wildcard over its subdomains (`*.push.apple.com`, which does not match `push.apple.com` itself), or,
// for a local test receiver only, `http://<host>`, which allows plain http on any port of that exact host.
// Every other entry is https on port 443.

export const DEFAULT_ALLOWED = [
  'fcm.googleapis.com',
  '*.push.apple.com',
  'updates.push.services.mozilla.com',
  '*.notify.windows.com',
]

interface Rule {
  scheme: 'https:' | 'http:'
  host: string
  wildcard: boolean
}

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/

export function parseAllowed(entries: string[]): Rule[] {
  return entries.map((raw) => {
    const e = raw.trim().toLowerCase()
    const http = e.startsWith('http://')
    const rest = http ? e.slice('http://'.length) : e
    const wildcard = rest.startsWith('*.')
    const host = wildcard ? rest.slice(2) : rest
    if (!HOST_RE.test(host) || (http && wildcard)) throw new Error(`invalid entry '${raw}'`)
    return { scheme: http ? 'http:' : 'https:', host, wildcard }
  })
}

// The endpoint as a URL when the list allows it, otherwise undefined.
export function allowedEndpoint(rules: Rule[], endpoint: string): URL | undefined {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return undefined
  }
  if (url.username || url.password) return undefined
  const host = url.hostname
  for (const r of rules) {
    if (url.protocol !== r.scheme) continue
    // URL drops the default port, so https on 443 has an empty port.
    if (r.scheme === 'https:' && url.port !== '') continue
    if (r.wildcard ? host.endsWith(`.${r.host}`) : host === r.host) return url
  }
  return undefined
}
