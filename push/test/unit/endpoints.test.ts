import { describe, expect, it } from 'vitest'
import { allowedEndpoint, DEFAULT_ALLOWED, parseAllowed } from '../../src/endpoints.ts'

const rules = parseAllowed([...DEFAULT_ALLOWED, 'http://host.docker.internal'])
const ok = (e: string): boolean => allowedEndpoint(rules, e) !== undefined

describe('allowed endpoints', () => {
  it('exact hosts on https', () => {
    expect(ok('https://fcm.googleapis.com/fcm/send/abc')).toBe(true)
    expect(ok('https://updates.push.services.mozilla.com/wpush/v2/abc')).toBe(true)
  })
  it('wildcards match subdomains only', () => {
    expect(ok('https://web.push.apple.com/abc')).toBe(true)
    expect(ok('https://a.b.push.apple.com/abc')).toBe(true)
    expect(ok('https://push.apple.com/abc')).toBe(false)
    expect(ok('https://wns2-par02p.notify.windows.com/w/?token=x')).toBe(true)
  })
  it('lookalike hosts do not match', () => {
    expect(ok('https://evilpush.apple.com/abc')).toBe(false)
    expect(ok('https://web.push.apple.com.evil.example/abc')).toBe(false)
    expect(ok('https://fcm.googleapis.com.evil.example/x')).toBe(false)
    expect(ok('https://xfcm.googleapis.com/x')).toBe(false)
    expect(ok('https://evil.example/fcm.googleapis.com')).toBe(false)
  })
  it('https only, port 443 only', () => {
    expect(ok('http://fcm.googleapis.com/x')).toBe(false)
    expect(ok('https://fcm.googleapis.com:443/x')).toBe(true)
    expect(ok('https://fcm.googleapis.com:8443/x')).toBe(false)
    expect(ok('wss://fcm.googleapis.com/x')).toBe(false)
  })
  it('no credentials, no garbage', () => {
    expect(ok('https://user:pw@fcm.googleapis.com/x')).toBe(false)
    expect(ok('not a url')).toBe(false)
    expect(ok('')).toBe(false)
  })
  it('the http entry allows any port of that exact host, and nothing else', () => {
    expect(ok('http://host.docker.internal:41234/r')).toBe(true)
    expect(ok('https://host.docker.internal/r')).toBe(false)
    expect(ok('http://x.host.docker.internal:1/r')).toBe(false)
    expect(ok('http://localhost:41234/r')).toBe(false)
  })
  it('the default list has no http entry', () => {
    expect(allowedEndpoint(parseAllowed(DEFAULT_ALLOWED), 'http://host.docker.internal:1/r')).toBeUndefined()
  })
  it('refuses malformed entries', () => {
    expect(() => parseAllowed(['https://fcm.googleapis.com'])).toThrow('invalid entry')
    expect(() => parseAllowed(['http://*.example.com'])).toThrow('invalid entry')
    expect(() => parseAllowed(['*'])).toThrow('invalid entry')
    expect(() => parseAllowed(['a.com/path'])).toThrow('invalid entry')
  })
})
