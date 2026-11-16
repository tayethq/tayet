import { Attachment, EncryptedAttachment, initAsync } from '@matrix-org/matrix-sdk-crypto-wasm'

// ── Attachment cipher primitive (ADR-016 / PLANO-FASE-2-MEDIA §3.1 — PF-1 fork (a)) ────────
// The PINNED stack exposes the spec's attachment scheme through the crypto-wasm binding
// (Attachment.encrypt/decrypt): AES-256-CTR with a FRESH key per attachment, a 16-byte IV
// whose first 8 bytes are random and whose counter half starts zeroed, SHA-256 of the
// ciphertext, envelope `v: "v2"` — verified in the embedded rust source (PF-1, §8 of the
// PLANO). So this primitive WRAPS the stack utility instead of reimplementing the spec
// (§0.2 decision rule: stack utility when exposed). Confined to the protocol side — the envelope
// (JWK/iv/hashes) never crosses the barrel; the leak-scan covers its keys.
//
// Home (PLANO-AGENTES §0.3.7 item 8): shared/src/internal, reached ONLY through the subpath
// `@tayet/shared/internal/attachment-crypto` and deliberately OUT of the internal barrel
// (internal/index.ts pulls the SDK through the translator; the client's decrypt worker imports
// this module and must stay SDK-free). Consumers: the client's acl/internal and the sidecar core.
//
// Integrity invariant (§3.1/§6): the SHA-256 is verified BEFORE decrypting, ALWAYS — and a
// missing hash is a rejection, never a best-effort decrypt. The wasm utility re-checks
// internally at EOF (one-shot API: a mismatch throws and no byte escapes the binding), but
// the explicit pre-check keeps the invariant literal and the failure mode clean.
//
// decryptAttachment is deliberately PURE — (ciphertext, envelope) → bytes, no gateway/DOM
// dependency — so the same function runs directly under Node/vitest and inside the browser
// Web Worker wrapper (PF-2 dispatch; the worker is wired in the inbound slice, not here).

// The EncryptedFile shape lives in @tayet/shared (the translator reads it too, ADR-088).
import type { EncryptedFile } from './wire-types'
export type { EncryptedFile }

// The envelope minted by encryptAttachment — everything but the mxc, which only exists
// after the ciphertext upload (the caller adds `url` to form the event's `file`).
export type EncryptedFileInfo = Omit<EncryptedFile, 'url'>

// The wasm loads lazily in the browser entry (initAsync is idempotent and cached by us; the
// SDK's own initRustCrypto shares the same module instance). The Node entry initializes the
// wasm at import, where initAsync resolves immediately.
let wasmReady: Promise<void> | undefined
function ensureWasm(): Promise<void> {
  return (wasmReady ??= initAsync())
}

function bytesToUnpaddedBase64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/=+$/, '')
}

// Canonical envelope JSON for the wasm (its parser validates every field). Two spec-mandated
// fields are NORMALIZED when an interoperating client omitted them — the spec fixes their
// values, so this fills in what MUST be true, never guesses: `ext` ("Must be true") and
// `key_ops` ("Must at least contain encrypt and decrypt"). Extra fields (e.g. url) are
// stripped: only the four envelope fields go in.
function envelopeJson(file: EncryptedFileInfo): string {
  const { kty, key_ops, alg, k, ext } = file.key
  return JSON.stringify({
    v: file.v,
    key: { kty, key_ops: key_ops ?? ['encrypt', 'decrypt'], alg, k, ext: ext ?? true },
    iv: file.iv,
    hashes: file.hashes,
  })
}

// Encrypt bytes for upload. Fresh key + IV are generated INSIDE the stack utility per call
// (never reused — CTR breaks catastrophically under reuse); the returned envelope is the
// event's `file` minus the mxc.
export async function encryptAttachment(
  bytes: Uint8Array,
): Promise<{ ciphertext: Uint8Array<ArrayBuffer>; info: EncryptedFileInfo }> {
  await ensureWasm()
  const encrypted = Attachment.encrypt(bytes)
  const infoJson = encrypted.mediaEncryptionInfo
  if (!infoJson) throw new Error('attachment encryption yielded no envelope')
  // The wasm hands back a standalone copy; the cast just narrows the buffer generic.
  return {
    ciphertext: encrypted.encryptedData as Uint8Array<ArrayBuffer>,
    info: JSON.parse(infoJson) as EncryptedFileInfo,
  }
}

// Decrypt a downloaded ciphertext against its envelope. Hash first, always; then the stack
// utility (a fresh EncryptedAttachment per call — the wasm consumes the envelope on decrypt,
// so the stored descriptor is never handed over directly).
export async function decryptAttachment(
  ciphertext: ArrayBuffer,
  file: EncryptedFileInfo,
): Promise<ArrayBuffer> {
  const expected = file.hashes?.sha256
  if (!expected) throw new Error('media integrity check failed (no sha256 hash)')
  const digest = await crypto.subtle.digest('SHA-256', ciphertext)
  if (bytesToUnpaddedBase64(digest) !== expected) {
    throw new Error('media integrity check failed (sha256 mismatch)')
  }
  await ensureWasm()
  const attachment = new EncryptedAttachment(new Uint8Array(ciphertext), envelopeJson(file))
  const plaintext = Attachment.decrypt(attachment)
  // The wasm hands back a standalone copy, but only its exact view is the plaintext.
  return plaintext.byteOffset === 0 && plaintext.byteLength === plaintext.buffer.byteLength
    ? (plaintext.buffer as ArrayBuffer)
    : (plaintext.slice().buffer as ArrayBuffer)
}
