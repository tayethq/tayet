import { decryptAttachment, type EncryptedFileInfo } from '@tayet/shared/internal/attachment-crypto'

// Environment dispatch for attachment decryption (PF-2 — BINDING): browser → Web Worker
// (hash check + wasm decrypt off the main thread, ADR-016); Node/vitest/jsdom (no Worker
// global) → direct call of the SAME pure function. The integration gate runs under Node and
// must never depend on Worker.
//
// The worker is a lazy singleton (spawning per call would re-init the wasm every time);
// requests are correlated by id. It holds no state between requests — key material flows
// through postMessage per call and is never retained (worker side enforces this). disconnect
// tears it down via disposeDecryptWorker().

interface DecryptResponse {
  id: number
  ok: boolean
  bytes?: ArrayBuffer
}

let worker: Worker | undefined
let nextId = 0
const pending = new Map<number, { resolve: (b: ArrayBuffer) => void; reject: (e: Error) => void }>()

// Domain-clean failure: no hash/cipher/protocol detail in the message (PLANO §3.2 / §2).
const failure = (): Error => new Error('media unavailable')

function rejectAllPending(): void {
  for (const { reject } of pending.values()) reject(failure())
  pending.clear()
}

function workerInstance(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./attachment-decrypt.worker.ts', import.meta.url), {
      type: 'module',
    })
    worker.onmessage = (e: MessageEvent<DecryptResponse>) => {
      const entry = pending.get(e.data.id)
      if (!entry) return
      pending.delete(e.data.id)
      if (e.data.ok && e.data.bytes) entry.resolve(e.data.bytes)
      else entry.reject(failure())
    }
    // A worker-level error (script load, uncaught) fails every in-flight request cleanly.
    worker.onerror = () => rejectAllPending()
  }
  return worker
}

// Verify + decrypt a downloaded ciphertext. The ciphertext buffer is TRANSFERRED on the
// worker path (it is single-use: fetched, decrypted, discarded).
export function decryptAttachmentBytes(
  ciphertext: ArrayBuffer,
  info: EncryptedFileInfo,
): Promise<ArrayBuffer> {
  if (typeof Worker === 'undefined') return decryptAttachment(ciphertext, info)
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    workerInstance().postMessage({ id, ciphertext, info }, [ciphertext])
  })
}

// Session teardown (mirror of the media registries): terminate the worker and fail any
// in-flight resolution. Safe no-op when no worker was ever spawned (Node path).
export function disposeDecryptWorker(): void {
  worker?.terminate()
  worker = undefined
  rejectAllPending()
}
