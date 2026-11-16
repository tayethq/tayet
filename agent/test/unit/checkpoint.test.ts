import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readCheckpoint, writeCheckpoint } from '../../src/checkpoint.ts'

// O checkpoint limita a busca do catch-up: escrito a cada sync, lido no boot.
// Corrompido/ausente lê null (degrada para busca limitada por páginas, nunca crash).

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'agent-checkpoint-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('checkpoint — last-alive do agente', () => {
  it('roundtrip: escreve e lê o mesmo instante', async () => {
    const file = join(dir, 'checkpoint.json')
    await writeCheckpoint(file, { lastAliveTs: 1_785_336_741_000 })
    expect(await readCheckpoint(file)).toEqual({ lastAliveTs: 1_785_336_741_000 })
  })

  it('re-escrita substitui (o checkpoint é um instante, não um log)', async () => {
    const file = join(dir, 'checkpoint.json')
    await writeCheckpoint(file, { lastAliveTs: 1 })
    await writeCheckpoint(file, { lastAliveTs: 2 })
    expect(await readCheckpoint(file)).toEqual({ lastAliveTs: 2 })
    // tmp+rename não deixa temporários órfãos no caminho feliz
    expect((await readdir(dir)).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })

  it('arquivo ausente → null', async () => {
    expect(await readCheckpoint(join(dir, 'nao-existe.json'))).toBeNull()
  })

  it('arquivo corrompido/shape errado → null, nunca throw', async () => {
    const file = join(dir, 'checkpoint.json')
    for (const raw of ['{rasgado', '"string"', '{}', '{"lastAliveTs":"texto"}', '{"lastAliveTs":null}']) {
      await writeFile(file, raw)
      expect(await readCheckpoint(file)).toBeNull()
    }
  })
})
