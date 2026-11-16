// Storage de custódia de sessão (ADR-057 dec. 5 / PLANO-CRIPTO-COBERTURA §8.2): port
// plugável + implementação file-based no idioma do fileStore (store.ts). O write-once
// por (room_id, session_id) é decidido AQUI, por exclusividade atômica no filesystem —
// não numa checagem read-then-write. Nome de arquivo = hash da chave: os IDs de sala e
// sessão não vazam em listagem de diretório. O arquivo carrega a chave em prefixo
// length-prefixed porque o retrieve varre o diretório e precisa recuperá-la para derivar
// o subject (AAD) do open — só os IDs ficam legíveis no registro; endereçados e material
// de sessão seguem DENTRO do envelope selado (membership não fica em claro at rest).

import { createHash } from 'node:crypto'
import { link, mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface SessionStore {
  // true = gravado; false = já existia (write-once por chave). Corrida de dois putOnce
  // simultâneos da mesma chave produz exatamente um true.
  putOnce(key: string, blob: Uint8Array): Promise<boolean>
  // Varredura completa do store: cada entrada devolve a chave original e o blob selado,
  // em ordem não especificada. Linear O(n) por desenho no grão atual; índice por
  // usuário é deferido-com-gatilho (§8.2).
  entries(): AsyncIterable<{ key: string; blob: Uint8Array }>
}

function fileFor(dir: string, key: string): string {
  return join(dir, createHash('sha256').update(key).digest('hex'))
}

// Formato do registro: u32be (bytes da chave) ‖ chave utf8 ‖ blob selado.
function encode(key: string, blob: Uint8Array): Buffer {
  const keyBytes = Buffer.from(key, 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32BE(keyBytes.length, 0)
  return Buffer.concat([header, keyBytes, Buffer.from(blob)])
}

// Registro que não decodifica → throw limpo; o chamador (retrieve) trata como falha de
// integridade do store inteiro, nunca "pula e segue".
function decode(raw: Buffer): { key: string; blob: Uint8Array } {
  if (raw.length < 4) throw new Error('unrecognized session record')
  const keyLen = raw.readUInt32BE(0)
  if (raw.length < 4 + keyLen) throw new Error('unrecognized session record')
  return {
    key: raw.subarray(4, 4 + keyLen).toString('utf8'),
    blob: new Uint8Array(raw.subarray(4 + keyLen)),
  }
}

export function fileSessionStore(dir: string): SessionStore {
  const ready = mkdir(dir, { recursive: true })
  return {
    async putOnce(key, blob) {
      await ready
      const final = fileFor(dir, key)
      // Idêntico ao put do fileStore: o registro nasce num arquivo temporário e é
      // publicado via link(2), que falha com EEXIST se o destino existe. Sufixo
      // aleatório no tmp: dois putOnce concorrentes não disputam o mesmo arquivo.
      const tmp = `${final}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
      await writeFile(tmp, encode(key, blob), { flag: 'wx' })
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
    async *entries() {
      await ready
      // Só registros publicados (nome = hash completo); tmps em trânsito ficam de fora.
      for (const name of (await readdir(dir)).filter((n) => /^[0-9a-f]{64}$/.test(n))) {
        yield decode(await readFile(join(dir, name)))
      }
    },
  }
}
