// What "this machine" means for the sidecar: the local API's listen address and the Slack layer's click
// destination (`--slack-actions-url`) use the same rule. A URL's IPv6 hostname comes in brackets; they are
// dropped before the check. A `127.` prefix counts only on an IPv4 literal (`127.example.com` is a name
// that resolves anywhere).
import { isIPv4 } from 'node:net'

export const isLoopback = (host: string): boolean => {
  const h = host.replace(/^\[|\]$/g, '')
  return h === '127.0.0.1' || h === '::1' || h === 'localhost' || (h.startsWith('127.') && isIPv4(h))
}
