import { describe, it, expect } from 'vitest'
import {
  encryptAttachment,
  decryptAttachment,
  type EncryptedFileInfo,
} from '../src/internal/attachment-crypto'

// Commit 4 (PLANO-FASE-2-MEDIA §3.1 — PF-1 fork (a)): the attachment cipher primitive,
// anchored on the OFFICIAL ecosystem test vectors (PF-1 item 3, §8 of the PLANO):
//  - matrix-org/matrix-encrypt-attachment (the Foundation's reference lib, used by Element):
//    the three v2 vectors of test/decrypt.Spec.js, verbatim;
//  - the embedded rust source's own fixture (matrix-sdk-crypto file_encryption/attachments.rs).
// Plus: local round-trip (encrypt → decrypt), envelope-shape asserts (fresh key/IV per
// attachment — never reused), tamper → clean rejection, and missing hash → rejection
// (hash is verified BEFORE decrypt, ALWAYS).

function b64ToBytes(b64: string): Uint8Array {
  const norm = b64.replace(/-/g, '+').replace(/_/g, '/')
  const padded = norm + '='.repeat((4 - (norm.length % 4)) % 4)
  const bin = atob(padded)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function bytesToB64(buf: ArrayBuffer): string {
  let bin = ''
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b)
  return btoa(bin).replace(/=+$/, '')
}

// The three v2 vectors of matrix-org/matrix-encrypt-attachment test/decrypt.Spec.js,
// verbatim (ciphertext, envelope, expected plaintext — all unpadded base64).
const OFFICIAL_V2_VECTORS: Array<[string, EncryptedFileInfo, string]> = [
  [
    '',
    {
      iv: 'AAAAAAAAAAAAAAAAAAAAAA',
      key: {
        kty: 'oct',
        key_ops: ['encrypt', 'decrypt'],
        k: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        alg: 'A256CTR',
      },
      v: 'v2',
      hashes: { sha256: '47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU' },
    },
    '',
  ],
  [
    '5xJZTt5cQicm+9f4',
    {
      iv: '//////////8AAAAAAAAAAA',
      key: {
        kty: 'oct',
        key_ops: ['encrypt', 'decrypt'],
        k: '__________________________________________8',
        alg: 'A256CTR',
      },
      v: 'v2',
      hashes: { sha256: 'YzF08lARDdOCzJpzuSwsjTNlQc4pHxpdHcXiD/wpK6k' },
    },
    'SGVsbG8sIFdvcmxk',
  ],
  [
    'zhtFStAeFx0s+9L/sSQO+WQMtldqYEHqTxMduJrCIpnkyer09kxJJuA4K+adQE4w+7jZe/vR9kIcqj9rOhDR8Q',
    {
      iv: '//////////8AAAAAAAAAAA',
      key: {
        kty: 'oct',
        key_ops: ['encrypt', 'decrypt'],
        k: '__________________________________________8',
        alg: 'A256CTR',
      },
      v: 'v2',
      hashes: { sha256: 'IOq7/dHHB+mfHfxlRY5XMeCWEwTPmlf4cJcgrkf6fVU' },
    },
    'YWxwaGFudW1lcmljYWxseWFscGhhbnVtZXJpY2FsbHlhbHBoYW51bWVyaWNhbGx5YWxwaGFudW1lcmljYWxseQ',
  ],
]

// The pinned rust source's own fixture (matrix-sdk-crypto 0.18.0, attachments.rs test module).
const RUST_VECTOR_CIPHERTEXT = new Uint8Array([
  179, 154, 118, 127, 186, 127, 110, 33, 203, 33, 33, 134, 67, 100, 173, 46, 235, 27, 215, 172,
  36, 26, 75, 47, 33, 160,
])
const RUST_VECTOR_INFO: EncryptedFileInfo = {
  v: 'v2',
  key: {
    kty: 'oct',
    alg: 'A256CTR',
    ext: true,
    k: 'Voq2nkPme_x8no5-Tjq_laDAdxE6iDbxnlQXxwFPgE4',
    key_ops: ['decrypt', 'encrypt'],
  },
  iv: 'i0DovxYdJEcAAAAAAAAAAA',
  hashes: { sha256: 'ANdt819a8bZl4jKy3Z+jcqtiNICa2y0AW4BBJ/iQRAU' },
}

describe('attachment cipher primitive (fork (a) — official vectors)', () => {
  it.each(OFFICIAL_V2_VECTORS.map((v, i) => [i, v] as const))(
    'decrypts matrix-encrypt-attachment v2 vector #%d',
    async (_i, [ciphertextB64, info, wantB64]) => {
      const plain = await decryptAttachment(b64ToBytes(ciphertextB64).buffer as ArrayBuffer, info)
      expect(bytesToB64(plain)).toBe(wantB64)
    },
  )

  it('decrypts the pinned rust source fixture', async () => {
    const plain = await decryptAttachment(RUST_VECTOR_CIPHERTEXT.buffer as ArrayBuffer, RUST_VECTOR_INFO)
    expect(new TextDecoder().decode(plain)).toBe("It's a secret to everybody")
  })
})

describe('attachment cipher primitive (round-trip + envelope shape)', () => {
  it('round-trips and emits the spec envelope (v2, A256CTR JWK, 8-byte IV + zeroed counter)', async () => {
    const plaintext = new TextEncoder().encode('tayet round-trip 🔒 bytes')
    const { ciphertext, info } = await encryptAttachment(plaintext)

    expect(info.v).toBe('v2')
    expect(info.key.alg).toBe('A256CTR')
    expect(info.key.kty).toBe('oct')
    expect(info.hashes.sha256).toBeTruthy()
    // IV: 16 bytes, counter half zeroed (spec: 8 random bytes + zeroed counter).
    const iv = b64ToBytes(info.iv)
    expect(iv.length).toBe(16)
    expect([...iv.slice(8)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
    // Ciphertext is not the plaintext.
    expect([...ciphertext]).not.toEqual([...plaintext])

    const decrypted = await decryptAttachment(ciphertext.slice().buffer as ArrayBuffer, info)
    expect([...new Uint8Array(decrypted)]).toEqual([...plaintext])
  })

  it('never reuses key or IV: each encrypt mints fresh material', async () => {
    const bytes = new TextEncoder().encode('same plaintext')
    const a = await encryptAttachment(bytes)
    const b = await encryptAttachment(bytes)
    expect(a.info.key.k).not.toBe(b.info.key.k)
    expect(a.info.iv).not.toBe(b.info.iv)
  })
})

describe('attachment cipher primitive (integrity — hash BEFORE decrypt, always)', () => {
  it('rejects a tampered ciphertext cleanly', async () => {
    const { ciphertext, info } = await encryptAttachment(new TextEncoder().encode('payload'))
    const tampered = ciphertext.slice()
    tampered[0]! ^= 0xff
    await expect(decryptAttachment(tampered.buffer as ArrayBuffer, info)).rejects.toThrow(/integrity/)
  })

  it('rejects an envelope with NO sha256 hash (never best-effort bytes)', async () => {
    const { ciphertext, info } = await encryptAttachment(new TextEncoder().encode('payload'))
    const noHash: EncryptedFileInfo = { ...info, hashes: {} }
    await expect(decryptAttachment(ciphertext.slice().buffer as ArrayBuffer, noHash)).rejects.toThrow(
      /integrity/,
    )
  })
})
