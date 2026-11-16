import { describe, it, expect } from 'vitest'
import { loadConfig } from '../../src/config.ts'

// Fail-closed do boot (S2.1): sem AGENT_STORAGE_KEY o crypto store nasceria em claro
// em disco — o processo NÃO pode subir. O main chama loadConfig antes de tocar rede ou
// disco, então provar o throw aqui prova o gate do boot.

const KEY_32 = Buffer.alloc(32, 7).toString('base64')

function validEnv(): Record<string, string | undefined> {
  return {
    AGENT_HS_URL: 'http://synapse:8008',
    AGENT_TOKEN_FILE: '/secrets/token',
    AGENT_ESCROW_URL: 'http://escrow:8090',
    AGENT_STORAGE_KEY: KEY_32,
    AGENT_STORE_DIR: '/data',
  }
}

describe('loadConfig — fail-closed, sem defaults de produção', () => {
  it('env completo → config com a chave decodificada (32 bytes)', () => {
    const config = loadConfig(validEnv())
    expect(config.hsUrl).toBe('http://synapse:8008')
    expect(config.tokenFile).toBe('/secrets/token')
    expect(config.escrowUrl).toBe('http://escrow:8090')
    expect(config.storeDir).toBe('/data')
    expect(config.storageKey).toBeInstanceOf(Uint8Array)
    expect(config.storageKey).toHaveLength(32)
    expect([...config.storageKey]).toEqual(Array(32).fill(7))
  })

  it('AGENT_STORAGE_KEY ausente ou vazia → throw (o processo não sobe)', () => {
    for (const value of [undefined, '']) {
      const env = { ...validEnv(), AGENT_STORAGE_KEY: value }
      expect(() => loadConfig(env)).toThrow(/AGENT_STORAGE_KEY/)
    }
  })

  it('chave com tamanho errado (31/33 bytes) → throw com o tamanho no erro', () => {
    for (const size of [31, 33]) {
      const env = { ...validEnv(), AGENT_STORAGE_KEY: Buffer.alloc(size, 1).toString('base64') }
      expect(() => loadConfig(env)).toThrow(new RegExp(`32 bytes, got ${size}`))
    }
  })

  it('base64 inválido → throw (Buffer.from leniente não passa por baixo)', () => {
    for (const bad of ['not base64!!', 'abc', '====']) {
      const env = { ...validEnv(), AGENT_STORAGE_KEY: bad }
      expect(() => loadConfig(env)).toThrow(/not valid base64/)
    }
  })

  it('cada env obrigatório ausente → throw nomeando a variável', () => {
    for (const name of ['AGENT_HS_URL', 'AGENT_TOKEN_FILE', 'AGENT_ESCROW_URL', 'AGENT_STORE_DIR']) {
      const env = { ...validEnv(), [name]: undefined }
      expect(() => loadConfig(env)).toThrow(new RegExp(name))
    }
  })
})
