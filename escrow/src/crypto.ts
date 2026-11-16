// Cifra at rest do escrow (ADR-017 / PLANO §3.4): AES-GCM-256 sob a chave de org,
// nonce de 96 bits aleatório por escrita, AAD = sujeito — um blob realocado entre
// sujeitos no storage falha a tag no decrypt. Blob = versão ‖ nonce ‖ ciphertext+tag.
// Módulo puro: nada de HTTP, storage ou log aqui.

import { createHash } from 'node:crypto'

const VERSION = 0x01
const NONCE_LENGTH = 12

const subtle = globalThis.crypto.subtle

// Etag derivado do blob at-rest (D1 §3.1): primeiros 16 bytes do SHA-256 do blob, em
// hex (32 chars). Derivado, nunca persistido — toda escrita gera nonce novo no seal(),
// logo blob novo e etag novo por construção. Identifica a VERSÃO do segredo, não o
// conteúdo; opaco para o cliente; nunca logado (D1 §2.3).
export function etagOf(blob: Uint8Array): string {
  return createHash('sha256').update(blob).digest('hex').slice(0, 32)
}

// Chave de org: 32 bytes em base64, vinda de env (ESCROW_ORG_KEY — jamais commitada).
// A mensagem de erro nunca ecoa o valor recebido.
export async function importOrgKey(rawBase64: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(Buffer.from(rawBase64, 'base64'))
  if (raw.length !== 32) throw new Error('org key must decode to exactly 32 bytes')
  return subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

export async function seal(key: CryptoKey, subject: string, secret: Uint8Array): Promise<Uint8Array> {
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(NONCE_LENGTH))
  const ciphertext = await subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: new TextEncoder().encode(subject) },
    key,
    Uint8Array.from(secret),
  )
  const blob = new Uint8Array(1 + NONCE_LENGTH + ciphertext.byteLength)
  blob[0] = VERSION
  blob.set(nonce, 1)
  blob.set(new Uint8Array(ciphertext), 1 + NONCE_LENGTH)
  return blob
}

// Falha de tag (tamper OU sujeito trocado) ou header desconhecido → throw limpo, sem
// bytes "melhor esforço" e sem material no erro. O chamador traduz para 500 interno.
export async function open(key: CryptoKey, subject: string, blob: Uint8Array): Promise<Uint8Array> {
  if (blob.length < 1 + NONCE_LENGTH + 16 || blob[0] !== VERSION) {
    throw new Error('unrecognized blob format')
  }
  const nonce = Uint8Array.from(blob.subarray(1, 1 + NONCE_LENGTH))
  const ciphertext = Uint8Array.from(blob.subarray(1 + NONCE_LENGTH))
  const plaintext = await subtle.decrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: new TextEncoder().encode(subject) },
    key,
    ciphertext,
  )
  return new Uint8Array(plaintext)
}
