// Checkpoint de vida do sidecar (copiado de agent/src/checkpoint.ts, PLANO-AGENTES §0.3.1 S1.1):
// o último instante vivo com sync saudável. Hoje só é escrito. O cursor de eventos da API NÃO o lê:
// o barramento da S-c1 vive em memória (`<época>-<seq>`, PLANO-AGENTES §0.3.6 adj. 11) e um id fora
// do ring vira `resync`.
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
