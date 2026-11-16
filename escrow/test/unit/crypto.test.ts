import { describe, it, expect } from 'vitest'
import { etagOf, importOrgKey, seal, open } from '../../src/crypto.ts'

function freshKeyB64(): string {
  return Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString('base64')
}

describe('escrow crypto at rest (PLANO §3.4)', () => {
  it('round-trips a secret under the same subject', async () => {
    const key = await importOrgKey(freshKeyB64())
    const secret = globalThis.crypto.getRandomValues(new Uint8Array(48))
    const blob = await seal(key, 'subject-alice', secret)
    expect(Buffer.from(blob).includes(Buffer.from(secret))).toBe(false) // ciphertext, não passthrough
    const back = await open(key, 'subject-alice', blob)
    expect(Buffer.from(back).equals(Buffer.from(secret))).toBe(true)
  })

  it('rejects a 1-byte tamper anywhere in the blob', async () => {
    const key = await importOrgKey(freshKeyB64())
    const blob = await seal(key, 'subject-alice', new TextEncoder().encode('o segredo'))
    for (const i of [1, 13, blob.length - 1]) {
      const tampered = blob.slice()
      tampered[i] = tampered[i]! ^ 0x01
      await expect(open(key, 'subject-alice', tampered)).rejects.toThrow()
    }
  })

  it('rejects a blob sealed for another subject (AAD swap)', async () => {
    const key = await importOrgKey(freshKeyB64())
    const blob = await seal(key, 'subject-alice', new TextEncoder().encode('o segredo'))
    await expect(open(key, 'subject-bob', blob)).rejects.toThrow()
  })

  it('rejects an unknown version header without touching the cipher', async () => {
    const key = await importOrgKey(freshKeyB64())
    const blob = await seal(key, 'subject-alice', new TextEncoder().encode('x'))
    const wrong = blob.slice()
    wrong[0] = 0x02
    await expect(open(key, 'subject-alice', wrong)).rejects.toThrow(/unrecognized/)
  })

  it('never repeats a nonce across writes (statistical sanity, not proof)', async () => {
    const key = await importOrgKey(freshKeyB64())
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) {
      const blob = await seal(key, 's', new Uint8Array([1]))
      seen.add(Buffer.from(blob.subarray(1, 13)).toString('hex'))
    }
    expect(seen.size).toBe(200)
  })

  it('etagOf: duas escritas do MESMO segredo ⇒ etags distintos (nonce aleatório do seal)', async () => {
    const key = await importOrgKey(freshKeyB64())
    const secret = new TextEncoder().encode('o mesmo segredo')
    const a = etagOf(await seal(key, 'subject-alice', secret))
    const b = etagOf(await seal(key, 'subject-alice', secret))
    expect(a).toMatch(/^[0-9a-f]{32}$/) // primeiros 16 bytes do SHA-256, em hex (D1 §3.1)
    expect(b).toMatch(/^[0-9a-f]{32}$/)
    expect(a).not.toBe(b)
    // determinístico sobre o MESMO blob: derivado, nunca persistido
    const blob = await seal(key, 'subject-alice', secret)
    expect(etagOf(blob)).toBe(etagOf(blob.slice()))
  })

  it('refuses an org key that is not 32 bytes, without echoing it', async () => {
    await expect(importOrgKey(Buffer.from('short').toString('base64'))).rejects.toThrow(
      /32 bytes/,
    )
    await expect(importOrgKey(Buffer.from('short').toString('base64'))).rejects.not.toThrow(
      /c2hvcnQ|short/,
    )
  })
})
