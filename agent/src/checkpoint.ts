// Checkpoint de vida do agente — o limite da busca do catch-up pós-downtime: sessões
// nascidas no downtime têm o primeiro evento DEPOIS do último instante em que o agente
// esteve vivo, logo paginar /messages para trás até o checkpoint encontra o nascimento
// de qualquer sessão pendente (arquitetura do PR-3; a fila to_device o Synapse drena
// sozinho mesmo em initial sync — S2.3 (ii)).
//
// Escrita via tmp+rename no MESMO diretório (atomicidade de rename POSIX): um SIGKILL
// no meio da escrita deixa o checkpoint anterior intacto, nunca um JSON rasgado.
// Corrompido/ausente lê como null — o chamador degrada para busca limitada por páginas.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface Checkpoint {
  lastAliveTs: number
}

export async function readCheckpoint(file: string): Promise<Checkpoint | null> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as { lastAliveTs?: unknown }
    if (typeof parsed.lastAliveTs !== 'number' || !Number.isFinite(parsed.lastAliveTs)) return null
    return { lastAliveTs: parsed.lastAliveTs }
  } catch {
    return null
  }
}

export async function writeCheckpoint(file: string, checkpoint: Checkpoint): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = join(dirname(file), `.${Date.now()}-${process.pid}.checkpoint.tmp`)
  await writeFile(tmp, JSON.stringify(checkpoint))
  await rename(tmp, file)
}
