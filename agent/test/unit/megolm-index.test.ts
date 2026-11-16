import { describe, it, expect } from 'vitest'
import { firstKnownIndexOf } from '../../src/megolm-index.ts'

// Formato provado no spike C2: 1 byte de versão + índice u32 BIG-endian nos bytes
// iniciais do blob `session_key` do export Megolm.

function blobWithIndex(index: number, extra = 160): string {
  const buf = Buffer.alloc(5 + extra, 0xab)
  buf.writeUInt8(1, 0)
  buf.writeUInt32BE(index, 1)
  return buf.toString('base64')
}

describe('firstKnownIndexOf — decodificação do índice inicial do export', () => {
  it('índice 0 (sessão do nascimento) decodifica 0', () => {
    expect(firstKnownIndexOf(blobWithIndex(0))).toBe(0)
  })

  it('índice N>0 (sessão recebida mid-ratchet) decodifica N', () => {
    expect(firstKnownIndexOf(blobWithIndex(1))).toBe(1)
    expect(firstKnownIndexOf(blobWithIndex(7))).toBe(7)
  })

  it('big-endian de verdade: 0x00010003 → 65539, não 50331904', () => {
    expect(firstKnownIndexOf(blobWithIndex(65_539))).toBe(65_539)
  })

  it('blob curto/vazio/indecodificável → null (nunca depositar o que não se sabe ler)', () => {
    expect(firstKnownIndexOf('')).toBeNull()
    expect(firstKnownIndexOf(Buffer.from([1, 0, 0]).toString('base64'))).toBeNull()
    expect(firstKnownIndexOf('!!!!')).toBeNull()
  })
})
