// The receiving side of Web Push, for tests: a subscription (P-256 pair and auth secret), decryption
// of an aes128gcm body (RFC 8291) and verification of the VAPID Authorization header (RFC 8292).
import { createDecipheriv, createECDH, createHmac, createPublicKey, randomBytes, verify } from 'node:crypto'

export interface TestSubscription {
  p256dh: string
  auth: string
  privateKey: Buffer
}

export function makeSubscription(): TestSubscription {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return { p256dh: ecdh.getPublicKey('base64url'), auth: randomBytes(16).toString('base64url'), privateKey: ecdh.getPrivateKey() }
}

const hmac = (key: Uint8Array, ...data: Uint8Array[]): Buffer => {
  const h = createHmac('sha256', key)
  for (const d of data) h.update(d)
  return h.digest()
}

export function decrypt(body: Buffer, sub: TestSubscription): Buffer {
  const salt = body.subarray(0, 16)
  const idlen = body[20]!
  const asPublic = body.subarray(21, 21 + idlen)
  const ciphertext = body.subarray(21 + idlen)
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(sub.privateKey)
  const uaPublic = ecdh.getPublicKey()
  const secret = ecdh.computeSecret(asPublic)
  const prkKey = hmac(Buffer.from(sub.auth, 'base64url'), secret)
  const ikm = hmac(prkKey, Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.of(1))
  const prk = hmac(salt, ikm)
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.of(1)).subarray(0, 16)
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0'), Buffer.of(1)).subarray(0, 12)
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16))
  const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()])
  // Strip the padding delimiter (0x02 for the last record) and any zero padding after it.
  let end = plain.length - 1
  while (end >= 0 && plain[end] === 0) end -= 1
  if (plain[end] !== 2) throw new Error('missing last-record delimiter')
  return plain.subarray(0, end)
}

// Checks `vapid t=<jwt>, k=<key>` against the expected public key; returns the JWT claims.
export function verifyVapid(header: string | undefined, publicKey: string): Record<string, unknown> {
  const m = /^vapid t=([^,]+), k=(\S+)$/.exec(header ?? '')
  if (!m) throw new Error('not a vapid Authorization header')
  const [, token, k] = m
  if (k !== publicKey) throw new Error('k is not the expected public key')
  const [h, c, s] = token!.split('.')
  const pub = Buffer.from(publicKey, 'base64url')
  const key = createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') },
    format: 'jwk',
  })
  const ok = verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s!, 'base64url'))
  if (!ok) throw new Error('bad VAPID signature')
  const header0 = JSON.parse(Buffer.from(h!, 'base64url').toString()) as Record<string, unknown>
  if (header0.alg !== 'ES256') throw new Error('alg is not ES256')
  return JSON.parse(Buffer.from(c!, 'base64url').toString()) as Record<string, unknown>
}
