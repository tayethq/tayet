// Storage do escrow (ADR-017 / PLANO §3.5): port plugável + implementação file-based
// de dev, zero dependências. O 409 do write-once é decidido AQUI, por exclusividade
// atômica no filesystem — não numa checagem read-then-write. Nome de arquivo = hash do
// sujeito (o sujeito não vaza em listagem de diretório).

import { createHash } from 'node:crypto'
import { link, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { etagOf } from './crypto.ts'

export interface SecretStore {
  // true = gravado; false = já existia (write-once). Corrida de dois puts simultâneos
  // do mesmo sujeito produz exatamente um true.
  put(subject: string, blob: Uint8Array): Promise<boolean>
  get(subject: string): Promise<Uint8Array | null>
  // CAS da rotação (D1 §3.2): substitui o blob SE o etag corrente bate com ifMatchEtag.
  // 'absent' = não existe segredo (rotate NUNCA cria — D1 §0.2.4); 'stale' = etag
  // divergente, storage intocado. Dois replaces concorrentes com o mesmo etag produzem
  // exatamente um 'replaced'.
  replace(
    subject: string,
    blob: Uint8Array,
    ifMatchEtag: string,
  ): Promise<'replaced' | 'stale' | 'absent'>
}

function fileFor(dir: string, subject: string): string {
  return join(dir, createHash('sha256').update(subject).digest('hex'))
}

export function fileStore(dir: string): SecretStore {
  const ready = mkdir(dir, { recursive: true })
  // Mutex assíncrono em processo (D1 §0.2.5, provado no PF-1): fila FIFO por cadeia de
  // promises. Cobre a janela INTEIRA read→compare→write-tmp→rename do replace — compare
  // fora do mutex seria TOCTOU. Serialização suficiente porque o serviço é
  // single-process por desenho desde C1; multi-réplica → lock no storage (ledger, ❓2).
  let casTail: Promise<unknown> = Promise.resolve()
  const withCasLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = casTail.then(fn)
    casTail = run.catch(() => undefined)
    return run
  }
  return {
    async put(subject, blob) {
      await ready
      const final = fileFor(dir, subject)
      // Escrita atômica + exclusividade: o blob nasce num arquivo temporário e é
      // publicado via link(2), que falha com EEXIST se o destino existe — ao contrário
      // de rename(2), que sobrescreveria em silêncio. Sufixo aleatório no tmp: dois
      // puts concorrentes não disputam o mesmo arquivo temporário.
      const tmp = `${final}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
      await writeFile(tmp, blob, { flag: 'wx' })
      try {
        await link(tmp, final)
        return true
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
        throw err
      } finally {
        await unlink(tmp).catch(() => undefined)
      }
    },
    async get(subject) {
      await ready
      try {
        return new Uint8Array(await readFile(fileFor(dir, subject)))
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw err
      }
    },
    async replace(subject, blob, ifMatchEtag) {
      await ready
      return withCasLock(async () => {
        const final = fileFor(dir, subject)
        let current: Buffer
        try {
          current = await readFile(final)
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'
          throw err
        }
        if (etagOf(new Uint8Array(current)) !== ifMatchEtag) return 'stale'
        // Publicação via rename(2): substituição atômica sobre destino existente
        // (PF-1) — ao contrário do put, que publica via link(2) e falha se existe.
        // Tmp no MESMO diretório, sufixo aleatório (padrão do put).
        const tmp = `${final}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
        await writeFile(tmp, blob, { flag: 'wx' })
        try {
          await rename(tmp, final)
        } catch (err) {
          await unlink(tmp).catch(() => undefined)
          throw err
        }
        return 'replaced'
      })
    },
  }
}
