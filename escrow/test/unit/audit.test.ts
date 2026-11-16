import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { jsonlAudit } from '../../src/audit.ts'

let base: string
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'escrow-audit-'))
})
afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('escrow audit log (PLANO §3.6)', () => {
  it('cria o diretório de destino se ausente (simetria com fileStore)', async () => {
    const storeDir = join(base, 'nao-existe-ainda') // sub-dir NÃO criado de propósito
    const audit = jsonlAudit(join(storeDir, 'audit.jsonl'))
    await audit.record({ verb: 'get', outcome: 'unauthorized' }) // o path 401 (sem sub)
    const text = await readFile(join(storeDir, 'audit.jsonl'), 'utf8')
    const line = JSON.parse(text.trim()) as Record<string, unknown>
    expect(line).toMatchObject({ verb: 'get', outcome: 'unauthorized' })
    expect(typeof line.ts).toBe('string')
  })
})
