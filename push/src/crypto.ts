// Web Push message encryption (RFC 8291, aes128gcm from RFC 8188) and VAPID (RFC 8292, ES256),
// with node:crypto only.
import { createCipheriv, createECDH, createHmac, createPrivateKey, randomBytes, sign, type KeyObject } from 'node:crypto'

export const b64url = (b: Uint8Array): string => Buffer.from(b).toString('base64url')

// Strict base64url decode: anything outside the alphabet, or padding, is refused.
export function fromB64url(s: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return undefined
  return Buffer.from(s, 'base64url')
}

const hmac = (key: Uint8Array, ...data: Uint8Array[]): Buffer => {
  const h = createHmac('sha256', key)
  for (const d of data) h.update(d)
  return h.digest()
}

const RECORD_SIZE = 4096

export interface EncryptOptions {
  // Fixed only by the RFC test vector; random otherwise.
  asPrivate?: Buffer
  salt?: Buffer
}

// One record: the whole payload fits (the caller caps it far below 4096 - 17 - 86).
export function encrypt(plaintext: Uint8Array, uaPublic: Buffer, authSecret: Buffer, opts: EncryptOptions = {}): Buffer {
  const ecdh = createECDH('prime256v1')
  if (opts.asPrivate) ecdh.setPrivateKey(opts.asPrivate)
  else ecdh.generateKeys()
  const asPublic = ecdh.getPublicKey()
  const salt = opts.salt ?? randomBytes(16)
  const ecdhSecret = ecdh.computeSecret(uaPublic)

  // HKDF-SHA-256 with a single 32-byte expand block, as the RFC writes it out.
  const prkKey = hmac(authSecret, ecdhSecret)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic])
  const ikm = hmac(prkKey, keyInfo, Buffer.of(1))
  const prk = hmac(salt, ikm)
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.of(1)).subarray(0, 16)
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0'), Buffer.of(1)).subarray(0, 12)

  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  // 0x02 marks the last (and only) record; no padding.
  const body = Buffer.concat([cipher.update(plaintext), cipher.update(Buffer.of(2)), cipher.final(), cipher.getAuthTag()])
  const rs = Buffer.alloc(4)
  rs.writeUInt32BE(RECORD_SIZE)
  return Buffer.concat([salt, rs, Buffer.of(asPublic.length), asPublic, body])
}

export interface Vapid {
  privateKey: KeyObject
  // Uncompressed P-256 point, base64url: the `k` of the Authorization header and the
  // applicationServerKey the client subscribes with.
  publicKey: string
  subject: string
}

// Builds the signing key from the raw base64url scalar and point, refusing a pair that does not
// match (createPrivateKey checks the point is on the curve; the round trip checks it is ours).
export function vapidKeys(privateB64: string, publicB64: string): KeyObject {
  const d = fromB64url(privateB64)
  const pub = fromB64url(publicB64)
  if (!d || d.length !== 32) throw new Error('private key must be 32 bytes, base64url')
  if (!pub || pub.length !== 65 || pub[0] !== 4) throw new Error('public key must be an uncompressed P-256 point, base64url')
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(d)
  if (!ecdh.getPublicKey().equals(pub)) throw new Error('public key does not match the private key')
  return createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: b64url(d), x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33)) },
    format: 'jwk',
  })
}

// ES256 JWT for one push service origin (RFC 8292 §2). JOSE wants the raw r||s signature.
export function vapidToken(vapid: Vapid, audience: string, expiresAt: number): string {
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64url(Buffer.from(JSON.stringify({ aud: audience, exp: expiresAt, sub: vapid.subject })))
  const input = `${header}.${claims}`
  const sig = sign('sha256', Buffer.from(input), { key: vapid.privateKey, dsaEncoding: 'ieee-p1363' })
  return `${input}.${b64url(sig)}`
}

const TOKEN_LIFETIME_S = 12 * 3600
// Reissued a little before it expires, so a token never reaches the push service already stale.
const TOKEN_MARGIN_S = 10 * 60

// One token per push service origin, reused while it has more than the margin left.
export class VapidCache {
  private readonly tokens = new Map<string, { value: string; exp: number }>()
  private readonly vapid: Vapid
  private readonly now: () => number
  constructor(vapid: Vapid, now: () => number = () => Date.now()) {
    this.vapid = vapid
    this.now = now
  }
  header(origin: string): string {
    const nowS = Math.floor(this.now() / 1000)
    let t = this.tokens.get(origin)
    if (!t || t.exp - nowS <= TOKEN_MARGIN_S) {
      const exp = nowS + TOKEN_LIFETIME_S
      t = { value: vapidToken(this.vapid, origin, exp), exp }
      this.tokens.set(origin, t)
    }
    return `vapid t=${t.value}, k=${this.vapid.publicKey}`
  }
}
