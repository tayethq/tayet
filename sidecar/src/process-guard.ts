// Unhandled rejections in the sidecar's process (installed by the process host, cli.ts).
//
// matrix-js-sdk 41.6.0 starts `doProcessOutgoingRequests()` "in background" without a catch when it
// encrypts for a room whose members are already loaded (src/rust-crypto/RoomEncryptor.ts:241), and
// `stopClient()` rejects that promise ("OutgoingRequestsManager was stopped") with nobody listening.
// In a browser that is a console line; under Node's default it kills the process — measured in the
// S-b2 integration: a revocation with an encrypted send in flight exited 1 before REVOKED was
// written.
//
// The same `stopClient()` aborts the SDK's HTTP requests in flight; one whose promise nobody holds
// rejects with the abort itself (a DOMException named `AbortError`, "This operation was aborted").
// Measured in the unit (PLANO-AGENTES §8.19 item 19, issue #7): a SIGTERM before the first sync, or the
// exit 73 of an address in use, exited 1 instead of 0/73. That rejection was caused by the stop itself:
// it is dropped without a line and the exit code stays the shutdown's.
//
// `stopClient()` also frees the rust crypto machine; a crypto call still in flight then rejects with
// wasm-bindgen's "null pointer passed to rust", with nobody listening. Measured in the S-h integration
// (PLANO-AGENTES §8.25, rodada 2): the self-reissue stops the client right after initRustCrypto (keys
// diverged), and the rejection exited 1 before the POST answered.
//
// All three are tolerated only AFTER the core called `stopClient()` (revocation or shutdown: boot.ts calls
// `markClientStopping()` immediately before each one; PLANO-AGENTES §0.3.6 adj. 12). The orphan is
// matched by its exact message, the abort by its error name — never by a generic message. Before the
// stop, either is a real failure of a running client and stays fatal, like any other rejection
// (logged, exit 1), as Node's default would be.
import { EXIT } from './exit-codes'
import { log } from './log'

export const SDK_ORPHAN_REJECTION = 'OutgoingRequestsManager was stopped'
export const FREED_CRYPTO_REJECTION = 'null pointer passed to rust'
const ORPHANS = new Set([SDK_ORPHAN_REJECTION, FREED_CRYPTO_REJECTION])

let clientStopping = false

// Called by the core immediately before each `client.stopClient()`.
export function markClientStopping(): void {
  clientStopping = true
}

export interface RejectionPorts {
  stopping: () => boolean
  log: (line: Record<string, unknown>) => void
  exit: (code: number) => void
}

// The abort of a fetch (undici: DOMException, an Error in Node, `name === 'AbortError'`).
const isAbort = (reason: unknown): boolean => reason instanceof Error && reason.name === 'AbortError'

export function handleRejection(reason: unknown, ports: RejectionPorts): void {
  if (ports.stopping() && isAbort(reason)) return
  if (ports.stopping() && reason instanceof Error && ORPHANS.has(reason.message)) {
    ports.log({ evt: 'sdk-orphan-rejection', message: reason.message })
    return
  }
  ports.log({ evt: 'fatal', stage: 'unhandled-rejection', message: reason instanceof Error ? reason.message : String(reason) })
  ports.exit(EXIT.unexpected)
}

export function installRejectionGuard(): void {
  process.on('unhandledRejection', (reason) => {
    handleRejection(reason, { stopping: () => clientStopping, log, exit: (code) => process.exit(code) })
  })
}
