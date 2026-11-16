import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileSessionStore } from '../../src/custody-store.ts'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'escrow-custody-store-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const KEY_A = '!salaA:example.test\nsessao-aaa'
const KEY_B = '!salaB:example.test\nsessao-bbb'

async function allEntries(store: ReturnType<typeof fileSessionStore>) {
  const out: Array<{ key: string; blob: Uint8Array }> = []
  for await (const entry of store.entries()) out.push(entry)
  return out
}

describe('custody file store (ADR-057 dec. 5)', () => {
  it('round-trips key and blob through entries(); empty store yields nothing', async () => {
    const store = fileSessionStore(dir)
    expect(await allEntries(store)).toHaveLength(0)
    const blob = globalThis.crypto.getRandomValues(new Uint8Array(96))
    expect(await store.putOnce(KEY_A, blob)).toBe(true)
    const entries = await allEntries(store)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.key).toBe(KEY_A)
    expect(Buffer.from(entries[0]!.blob).equals(Buffer.from(blob))).toBe(true)
  })

  it('is write-once per key: a second putOnce is refused and keeps the first blob', async () => {
    const store = fileSessionStore(dir)
    const first = new TextEncoder().encode('first')
    expect(await store.putOnce(KEY_A, first)).toBe(true)
    expect(await store.putOnce(KEY_A, new TextEncoder().encode('second'))).toBe(false)
    const [entry] = await allEntries(store)
    expect(Buffer.from(entry!.blob).equals(Buffer.from(first))).toBe(true)
  })

  it('survives a putOnce race: N concurrent writers for one key, exactly one wins', async () => {
    const store = fileSessionStore(dir)
    const results = await Promise.all(
      Array.from({ length: 16 }, (_, i) => store.putOnce(KEY_A, new Uint8Array([i]))),
    )
    expect(results.filter(Boolean)).toHaveLength(1)
    const winner = results.findIndex(Boolean)
    const [entry] = await allEntries(store)
    expect(entry!.blob[0]).toBe(winner)
  })

  it('isolates keys: distinct (room, session) pairs coexist and keep their blobs', async () => {
    const store = fileSessionStore(dir)
    await store.putOnce(KEY_A, new Uint8Array([1]))
    await store.putOnce(KEY_B, new Uint8Array([2]))
    const byKey = new Map((await allEntries(store)).map((e) => [e.key, e.blob[0]]))
    expect(byKey.get(KEY_A)).toBe(1)
    expect(byKey.get(KEY_B)).toBe(2)
  })

  it('does not leak room/session ids in directory listings (file name = hash)', async () => {
    const store = fileSessionStore(dir)
    await store.putOnce(KEY_A, new Uint8Array([1]))
    const names = await readdir(dir)
    expect(names).toHaveLength(1)
    expect(names[0]).toMatch(/^[0-9a-f]{64}$/)
    expect(names[0]).not.toContain('salaA')
    expect(names[0]).not.toContain('sessao-aaa')
  })

  it('leaves no temp files behind, including after a refused putOnce', async () => {
    const store = fileSessionStore(dir)
    await store.putOnce(KEY_A, new Uint8Array([1]))
    await store.putOnce(KEY_A, new Uint8Array([2]))
    expect(await readdir(dir)).toHaveLength(1)
  })
})
