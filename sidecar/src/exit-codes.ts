// Exit codes of the sidecar (PLANO-AGENTES §0.3.5, adjudication 6). sysexits where one fits; an
// operator's restart policy can stop on the terminal ones (64, 65, 77, 78) instead of looping.
export const EXIT = {
  ok: 0,
  unexpected: 1,
  usage: 64,
  // The store belongs to another agent or server (marker). Nothing is deleted.
  storeMismatch: 65,
  // Discovery, the server or the escrow is unreachable after the deadline, the URL is not a product URL,
  // or no escrow was discovered (`direct` mode: the operator cannot be learned; §0.3.10 item 4).
  unavailable: 69,
  // REMEDIATION_NEEDED written (or present for the same device) and automatic recovery (self-reissue,
  // S-h) was not possible: refused (too soon, the local floor, a 2nd rotation in one run), failed
  // (network, the kill step) or not a trigger (storage.key / local.token unreadable): reissue in the product.
  remediation: 70,
  // The local API's address is taken (EADDRINUSE; PLANO-AGENTES §0.3.6 adj. 8): another agent on this
  // machine — give this one its own --listen. The core is shut down cleanly first.
  addressInUse: 73,
  // instance.lock held by another process. No sentinel. Also `credential-changed`: <store>/credential
  // read before the lock is not the same file under it (another process rotated it; S-h).
  locked: 75,
  // The credential is not an agent's (localpart not `a-`, or no device).
  notAgent: 77,
  // Credential refused (by the server at step 3 or the escrow at step 3b). At boot: no wipe, no
  // sentinel. At runtime (token accepted in this run): store wiped + REVOKED. Also the agent with no
  // operator recorded (`operator-unknown`, step 3b; §0.3.10 item 4): only an admin resolves it. Also a
  // self-reissue that killed the old credential without handing out a new one (`self-reissue-failed`
  // mint/sweep) or that the escrow refused (401/403/404): only an admin reissue in the product resolves it.
  credentialRefused: 78,
} as const

export type ExitCode = (typeof EXIT)[keyof typeof EXIT]

// A boot that ends the process: thrown by the core (boot.ts), turned into process.exit by the
// process host (cli.ts), which alone owns the process. `line` is the last log line (already
// written by the core when absent).
export class ExitError extends Error {
  constructor(
    readonly code: ExitCode,
    readonly line?: Record<string, unknown>,
  ) {
    super(`exit ${code}`)
    this.name = 'ExitError'
  }
}

// The boot rotated the credential (self-reissue, S-h; PLANO-AGENTES §0.3.14 item 4): the new one is in
// <store>/credential, the device was wiped, the client stopped and the lock released. cli.ts relaunches
// the process once (relaunch.ts); nothing of this run's in-process state (the node-indexeddb singleton,
// the SDK) survives into the next boot.
export class RelaunchError extends Error {
  constructor() {
    super('relaunch after a self-reissue')
    this.name = 'RelaunchError'
  }
}
