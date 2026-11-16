import { describe, it, expect } from 'vitest'
import { decryptAttachment } from '@tayet/shared/internal/attachment-crypto'
import { mimetypeToMsgtype } from '@tayet/shared/internal'

// Commit 10 (ADR-009): the ENCRYPTED-media path proven deterministically — encrypt with
// WebCrypto, build a Matrix EncryptedFile descriptor, and decrypt via the ACL's decryptor.
// (Full live encrypted-room media — needing rust-crypto/key-sharing — is Fase 2 per PLANO §0;
// this proves the cipher code path so the "encrypted fresta" can't hide.)

function unpaddedBase64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/=+$/, '')
}

describe('encrypted media decryption (AES-CTR, v2)', () => {
  it('round-trips: encrypt → EncryptedFile → ACL decrypt yields the plaintext', async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-CTR', length: 256 }, true, [
      'encrypt',
      'decrypt',
    ])
    const jwk = await crypto.subtle.exportKey('jwk', key)
    const iv = crypto.getRandomValues(new Uint8Array(16))
    const plaintext = new TextEncoder().encode('secret media bytes 🔒 with unicode')
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-CTR', counter: iv as BufferSource, length: 64 },
      key,
      plaintext,
    )
    const sha256 = unpaddedBase64(await crypto.subtle.digest('SHA-256', ciphertext))

    const file = { url: 'mxc://tayet.local/abc', key: jwk, iv: unpaddedBase64(iv), hashes: { sha256 }, v: 'v2' }
    const decrypted = await decryptAttachment(ciphertext, file)
    expect(new TextDecoder().decode(decrypted)).toBe('secret media bytes 🔒 with unicode')
  })

  it('rejects on a tampered ciphertext (sha256 mismatch)', async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-CTR', length: 256 }, true, [
      'encrypt',
      'decrypt',
    ])
    const jwk = await crypto.subtle.exportKey('jwk', key)
    const iv = crypto.getRandomValues(new Uint8Array(16))
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-CTR', counter: iv as BufferSource, length: 64 },
      key,
      new TextEncoder().encode('data'),
    )
    const file = {
      url: 'mxc://tayet.local/abc',
      key: jwk,
      iv: unpaddedBase64(iv),
      hashes: { sha256: 'AAAAobviouslywrong' },
      v: 'v2',
    }
    await expect(decryptAttachment(ciphertext, file)).rejects.toThrow(/integrity/)
  })
})

describe('mimetype → msgtype inference (one-way, ACL-internal)', () => {
  it('maps by media class', () => {
    expect(mimetypeToMsgtype('image/png')).toBe('m.image')
    expect(mimetypeToMsgtype('image/jpeg')).toBe('m.image')
    expect(mimetypeToMsgtype('video/mp4')).toBe('m.video')
    expect(mimetypeToMsgtype('audio/mpeg')).toBe('m.audio')
    expect(mimetypeToMsgtype('application/pdf')).toBe('m.file')
    expect(mimetypeToMsgtype(undefined)).toBe('m.file')
  })
})
