import { decryptAttachment, type EncryptedFileInfo } from '@tayet/shared/internal/attachment-crypto'

// Browser-only Web Worker wrapper around the PURE decrypt (ADR-016 / PF-2). The page posts
// { id, ciphertext, info }; the worker verifies + decrypts off the main thread and answers
// { id, ok, bytes? } with the plaintext as a transferable. Key material arrives via
// postMessage and NOTHING persists here — no envelope, no key, no bytes outlive the request.
// Failures carry no detail (ok: false): the domain-clean rejection is formed by the caller
// (resolveMedia), so no hash/cipher vocabulary can travel back through this seam.
//
// The wasm initializes in THIS context on first use (attachment-crypto's lazy initAsync) —
// a separate instance from the page's SDK wasm, still ACL-internal.

interface DecryptRequest {
  id: number
  ciphertext: ArrayBuffer
  info: EncryptedFileInfo
}

const scope = globalThis as unknown as {
  onmessage: ((e: MessageEvent<DecryptRequest>) => void) | null
  postMessage(msg: unknown, transfer?: Transferable[]): void
}

scope.onmessage = (e) => {
  const { id, ciphertext, info } = e.data
  decryptAttachment(ciphertext, info).then(
    (bytes) => scope.postMessage({ id, ok: true, bytes }, [bytes]),
    () => scope.postMessage({ id, ok: false }),
  )
}
