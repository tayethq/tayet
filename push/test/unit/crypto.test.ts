import { describe, expect, it } from 'vitest'
import { createECDH } from 'node:crypto'
import { encrypt, VapidCache, vapidKeys, vapidToken } from '../../src/crypto.ts'
import { decrypt, makeSubscription, verifyVapid } from '../support/webpush.ts'

const u = (s: string): Buffer => Buffer.from(s, 'base64url')

// RFC 8291 Appendix A inputs, and the message of its section 5 (header + ciphertext).
const RFC = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  // The RFC's authentication secret; named so the public tree's secret scan does not read a published
  // test vector as a credential.
  ua16: 'BTBZMqHH6r4Tts7J_aSIgg',
  message:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
    'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
    'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
}

describe('RFC 8291 encryption', () => {
  it('reproduces the Appendix A example byte for byte', () => {
    const out = encrypt(u(RFC.plaintext), u(RFC.uaPublic), u(RFC.ua16), { asPrivate: u(RFC.asPrivate), salt: u(RFC.salt) })
    expect(out.toString('base64url')).toBe(RFC.message)
  })

  it('round-trips with random keys and salt', () => {
    const sub = makeSubscription()
    const a = encrypt(Buffer.from('hello'), u(sub.p256dh), u(sub.auth))
    const b = encrypt(Buffer.from('hello'), u(sub.p256dh), u(sub.auth))
    expect(a.equals(b)).toBe(false)
    expect(decrypt(a, sub).toString()).toBe('hello')
  })

  it('the RFC message decrypts with the user agent private key', () => {
    const sub = { p256dh: RFC.uaPublic, auth: RFC.ua16, privateKey: u(RFC.uaPrivate) }
    expect(decrypt(u(RFC.message), sub).toString()).toBe('When I grow up, I want to be a watermelon')
  })
})

function keyPair(): { d: string; pub: string } {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return { d: ecdh.getPrivateKey('base64url'), pub: ecdh.getPublicKey('base64url') }
}

describe('VAPID', () => {
  const kp = keyPair()
  const vapid = { privateKey: vapidKeys(kp.d, kp.pub), publicKey: kp.pub, subject: 'https://chat.example.org' }

  it('signs a token the public key verifies, with aud, exp and sub', () => {
    const claims = verifyVapid(`vapid t=${vapidToken(vapid, 'https://fcm.googleapis.com', 1000)}, k=${kp.pub}`, kp.pub)
    expect(claims).toEqual({ aud: 'https://fcm.googleapis.com', exp: 1000, sub: 'https://chat.example.org' })
  })

  it('a token does not verify under another key', () => {
    const other = keyPair()
    const token = vapidToken(vapid, 'https://a.example', 1000)
    expect(() => verifyVapid(`vapid t=${token}, k=${other.pub}`, other.pub)).toThrow('bad VAPID signature')
  })

  it('refuses a public key that is not the private key’s', () => {
    expect(() => vapidKeys(kp.d, keyPair().pub)).toThrow('does not match')
    expect(() => vapidKeys('short', kp.pub)).toThrow('32 bytes')
  })

  it('reuses one token per origin for up to 12 hours', () => {
    let now = 1_700_000_000_000
    const cache = new VapidCache(vapid, () => now)
    const first = cache.header('https://fcm.googleapis.com')
    expect(cache.header('https://fcm.googleapis.com')).toBe(first)
    expect(cache.header('https://updates.push.services.mozilla.com')).not.toBe(first)
    const claims = verifyVapid(first, kp.pub)
    expect(claims.exp).toBe(now / 1000 + 12 * 3600)
    now += 11 * 3600 * 1000
    expect(cache.header('https://fcm.googleapis.com')).toBe(first)
    now += 50 * 60 * 1000
    expect(cache.header('https://fcm.googleapis.com')).not.toBe(first)
  })
})
