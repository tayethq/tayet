import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileStore } from '../../src/store.ts'
import { etagOf } from '../../src/crypto.ts'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'escrow-store-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('escrow file store (PLANO §3.5)', () => {
  it('round-trips a blob and reports absence as null', async () => {
    const store = fileStore(dir)
    expect(await store.get('alice')).toBeNull()
    const blob = globalThis.crypto.getRandomValues(new Uint8Array(64))
    expect(await store.put('alice', blob)).toBe(true)
    const back = await store.get('alice')
    expect(back && Buffer.from(back).equals(Buffer.from(blob))).toBe(true)
  })

  it('is write-once: a second put for the same subject is refused and keeps the first blob', async () => {
    const store = fileStore(dir)
    const first = new TextEncoder().encode('first')
    expect(await store.put('alice', first)).toBe(true)
    expect(await store.put('alice', new TextEncoder().encode('second'))).toBe(false)
    const back = await store.get('alice')
    expect(back && Buffer.from(back).equals(Buffer.from(first))).toBe(true)
  })

  it('survives a put race: N concurrent writers, exactly one wins', async () => {
    const store = fileStore(dir)
    const results = await Promise.all(
      Array.from({ length: 16 }, (_, i) => store.put('alice', new Uint8Array([i]))),
    )
    expect(results.filter(Boolean)).toHaveLength(1)
    // o blob persistido é o do vencedor, intacto
    const winner = results.findIndex(Boolean)
    const back = await store.get('alice')
    expect(back && back[0]).toBe(winner)
  })

  it('isolates subjects', async () => {
    const store = fileStore(dir)
    await store.put('alice', new Uint8Array([1]))
    expect(await store.get('bob')).toBeNull()
    await store.put('bob', new Uint8Array([2]))
    expect((await store.get('alice'))![0]).toBe(1)
    expect((await store.get('bob'))![0]).toBe(2)
  })

  it('does not leak the subject in directory listings (file name = hash)', async () => {
    const store = fileStore(dir)
    const subject = '01KTW95XRNB4KPFKRFGYFV7BY7'
    await store.put(subject, new Uint8Array([1]))
    const names = await readdir(dir)
    expect(names).toHaveLength(1)
    expect(names[0]).not.toContain(subject)
    expect(names[0]).toMatch(/^[0-9a-f]{64}$/)
  })

  it('leaves no temp files behind, including after a refused put', async () => {
    const store = fileStore(dir)
    await store.put('alice', new Uint8Array([1]))
    await store.put('alice', new Uint8Array([2]))
    const names = await readdir(dir)
    expect(names).toHaveLength(1)
  })
})

describe('escrow file store — replace/CAS (D1 §3.2)', () => {
  it('replace nunca cria: sujeito ausente → absent, zero escrita no diretório', async () => {
    const store = fileStore(dir)
    expect(await store.replace('alice', new Uint8Array([9]), etagOf(new Uint8Array([0])))).toBe(
      'absent',
    )
    expect(await readdir(dir)).toHaveLength(0)
  })

  it('replace com etag corrente substitui; com etag divergente → stale e blob intocado', async () => {
    const store = fileStore(dir)
    const first = new Uint8Array([1, 2, 3])
    await store.put('alice', first)
    const next = new Uint8Array([4, 5, 6])
    expect(await store.replace('alice', next, etagOf(first))).toBe('replaced')
    expect(Buffer.from((await store.get('alice'))!).equals(Buffer.from(next))).toBe(true)
    // etag velho (do blob substituído) → stale, byte a byte intocado
    expect(await store.replace('alice', new Uint8Array([7]), etagOf(first))).toBe('stale')
    expect(Buffer.from((await store.get('alice'))!).equals(Buffer.from(next))).toBe(true)
    // nenhum tmp sobrando em nenhum desfecho
    expect(await readdir(dir)).toHaveLength(1)
  })

  it('CAS race: N replaces concorrentes com o MESMO etag → exatamente um replaced', async () => {
    const store = fileStore(dir)
    const first = new Uint8Array([0])
    await store.put('alice', first)
    const etag = etagOf(first)
    const results = await Promise.all(
      Array.from({ length: 16 }, (_, i) => store.replace('alice', new Uint8Array([i + 1]), etag)),
    )
    expect(results.filter((r) => r === 'replaced')).toHaveLength(1)
    expect(results.filter((r) => r === 'stale')).toHaveLength(15)
    // o blob final é o do vencedor, intacto
    const winner = results.findIndex((r) => r === 'replaced')
    expect((await store.get('alice'))![0]).toBe(winner + 1)
  })

  it('write-once do put permanece intacto após um replace (put → false)', async () => {
    const store = fileStore(dir)
    const first = new Uint8Array([1])
    await store.put('alice', first)
    await store.replace('alice', new Uint8Array([2]), etagOf(first))
    expect(await store.put('alice', new Uint8Array([3]))).toBe(false)
    expect((await store.get('alice'))![0]).toBe(2)
  })
})
