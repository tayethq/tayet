// resetAccess — the custody-backed reset of ADR-019 §2, revised by ADR-082. The emergency exit
// ADR-014 implies and does not detail: when cross-signing is irrecoverable (the residual claim of
// C2 §8 obs. 5, total device loss, deliberate compromise), this re-roots trust in a FRESH custodied
// secret and invalidates the old one. Confined to acl/internal — no custody/crypto vocabulary crosses
// the barrel (only the neutral ResetOutcome does; §3.5).
//
// TOTAL ÚNICO + RE-ENTRANT (ADR-019 §2/§3). One verb, one convergent outcome. It does NOT
// regenerate material blindly: it OBSERVES the world (custody etag + cross-signing status + 4S
// presence + the identity in 4S against the server) and resumes the pending step, so a re-call after
// an interrupted attempt, from any device, converges instead of double-resetting into a desync.
// The phase the observation yields is the resume point:
//   - 'fresh'  — healthy/consistent world, or a residual claim with nothing to adopt: rotate to a
//                NEW secret (burn the old custody), then reset identity + recreate 4S from it.
//   - 'resume' — a half-state, mine or another device's (the identity in 4S differs from the server
//                or cannot be read, ADR-082 dec. 2): finish from the secret ALREADY in custody — no
//                re-burn, no regenerate (the re-entrancy property).
//   - 'adopt'  — another reset linearized in front (CAS loser) or a foreign world to import:
//                recover identity + 4S from the custodied secret — a recovery, NOT a reset.
//   - 'unreachable' — custody down: fail-closed, re-offer via device.attention, no faked 'done'.
//
// Ordering (ADR-082 dec. 1 and 3): the approval window opens SYNCHRONOUSLY in the user's gesture;
// approval confirmed → revoke the other accesses → rotate → upload. The burn only happens with the
// approval in hand: giving up costs nothing. Rotate-first relative to the upload and the CAS as the
// arbiter stay (ADR-019 §3). History is best-effort and never re-encrypted (perda honesta).

import type { EscrowClient } from './escrow-client'
import type { ResetOutcome } from '../types'

// The observed resume point (computed from the live world by phaseOf; faked in units).
export type ResetPhase =
  | { kind: 'unreachable' } // custody down — cannot rotate; fail-closed
  | { kind: 'fresh'; secret?: Uint8Array<ArrayBuffer>; etag?: string } // start a reset (rotate)
  | { kind: 'resume'; secret: Uint8Array<ArrayBuffer> } // half-state: finish identity + 4S
  | { kind: 'adopt'; secret: Uint8Array<ArrayBuffer> } // CAS loser / foreign world: recover, not reset

// The master of cross-signing kept in 4S (read with the custodied secret) against the server
// identity (ADR-082 dec. 2). 'unreadable' = the 4S does not open with the custodied secret, or holds
// no master.
export type StoredIdentity = 'same' | 'different' | 'unreadable'

export function compareIdentity(storedPublic: string | undefined, serverPublic: string | undefined): StoredIdentity {
  if (storedPublic === undefined) return 'unreadable'
  return storedPublic === serverPublic ? 'same' : 'different'
}

// The re-entrancy table, pure: same observation → same phase.
export function phaseOf(world: {
  secret: Uint8Array<ArrayBuffer>
  etag?: string
  has4S: boolean
  crossSigningCached: boolean
  identity: StoredIdentity
}): ResetPhase {
  const { secret, etag, has4S, crossSigningCached } = world
  if (!has4S) {
    // No 4S: finish it if I hold the identity; otherwise residual claim / total loss → full reset.
    return crossSigningCached ? { kind: 'resume', secret } : { kind: 'fresh', secret, etag }
  }
  if (world.identity !== 'same') return { kind: 'resume', secret }
  // Healthy world → a deliberate reset; a consistent 4S I do not hold yet → recover, not reset.
  return crossSigningCached ? { kind: 'fresh', secret, etag } : { kind: 'adopt', secret }
}

// The approval step of the identity authority. The window exists from openApproval on, so the popup
// blocker sees it inside the gesture; everything that needs the network happens in wait().
export interface ResetApproval {
  // Resolves true once the approval is confirmed and false when the user gave up (window closed
  // without approving, popup blocked, time out). Never consumes the approval.
  wait(): Promise<boolean>
  close(): void
}

export interface ResetPorts {
  escrow: EscrowClient
  // SYNCHRONOUS on purpose: the FIRST thing the verb does, before any await (ADR-082 dec. 1).
  openApproval(): ResetApproval
  // Read the live world and decide the resume point. Re-entrancy lives here: same observation →
  // same phase, so the flow is idempotent from any intermediate state.
  observe(): Promise<ResetPhase>
  // Fresh 32-byte secret for a clean-start reset (never on the resume/adopt paths).
  generateSecret(): Uint8Array<ArrayBuffer>
  // Write a NEW 4S key descriptor from `secret` (ADR-082 dec. 5). Happens before the identity, so
  // the SDK's own write of the new private keys lands under it.
  recreate4S(secret: Uint8Array<ArrayBuffer>): Promise<void>
  // Replace the cross-signing identity. Needs the approval; a rejection here (approval expired,
  // consumed elsewhere) leaves the half-state observe() reads as 'resume'.
  resetIdentity(secret: Uint8Array<ArrayBuffer>): Promise<void>
  // Create the new key backup and keep its key in the new 4S.
  resetBackup(): Promise<void>
  // Import identity + 4S from the custodied secret (the recovery branch — no new identity, no burn).
  adoptWorld(secret: Uint8Array<ArrayBuffer>): Promise<void>
  // Best-effort, BEFORE the new backup exists (ADR-082 dec. 5): pull in what the previous backup
  // holds, so ResetOutcome.historyPreserved says what was really restored. NEVER re-encrypts.
  restoreHistory(): Promise<boolean>
  // Re-raise device.attention when the world needs the reset (fail-closed re-offer).
  raiseAttention(): void
  // Bootstrap-memory holder the SDK callbacks read; cleared per pass.
  setSecret(secret: Uint8Array<ArrayBuffer>): void
  clearSecret(): void
}

// Internal, NOT on the barrel: signals a non-conclusion (custody unreachable, CAS write blocked,
// approval abandoned). The verb has no error outcome (ADR-019 §2) — the caller treats this as "the
// reset did not converge". Mirrors acknowledgeAccess's degrade.
export class ResetDeferredError extends Error {
  constructor() {
    super('reset deferred')
    this.name = 'ResetDeferredError'
  }
}

export async function resetAccess(ports: ResetPorts): Promise<ResetOutcome> {
  const approval = ports.openApproval()
  try {
    return await run(ports, approval)
  } finally {
    approval.close()
  }
}

async function run(ports: ResetPorts, approval: ResetApproval): Promise<ResetOutcome> {
  let approved = false
  // Loop to RE-OBSERVE after the approval (minutes may have passed) and after losing the rotate CAS
  // (412): the winner linearized in front, so the next observation yields 'adopt'.
  for (;;) {
    const phase = await ports.observe()

    if (phase.kind === 'unreachable') {
      approval.close()
      ports.raiseAttention()
      throw new ResetDeferredError()
    }

    if (phase.kind === 'adopt') {
      approval.close()
      ports.setSecret(phase.secret)
      try {
        await ports.adoptWorld(phase.secret)
        return { t: 'done', historyPreserved: await ports.restoreHistory() }
      } finally {
        ports.clearSecret()
      }
    }

    if (!approved) {
      // Giving up is a plain non-conclusion: nothing burned, no attention on a healthy account.
      if (!(await approval.wait())) throw new ResetDeferredError()
      if ((await ports.escrow.revokeOthers()).kind !== 'revoked') throw new ResetDeferredError()
      approved = true
      continue
    }

    if (phase.kind === 'resume') return await buildFromReset(ports, phase.secret, await restoredWith(ports, phase.secret))

    const historyPreserved = phase.secret ? await restoredWith(ports, phase.secret) : false
    const fresh = ports.generateSecret()
    if (phase.secret !== undefined && phase.etag !== undefined) {
      const w = await ports.escrow.rotate(fresh, phase.etag)
      if (w.kind === 'stale') continue // CAS lost → re-observe → 'adopt' the winner's world
      if (w.kind !== 'rotated') {
        ports.raiseAttention()
        throw new ResetDeferredError()
      }
    } else {
      // Nothing custodied yet (or no etag) — deposit is the first write (write-once).
      const d = await ports.escrow.deposit(fresh)
      if (d.kind === 'exists') continue // raced a first deposit → re-observe → adopt
      if (d.kind !== 'deposited') {
        ports.raiseAttention()
        throw new ResetDeferredError()
      }
    }
    return await buildFromReset(ports, fresh, historyPreserved)
  }
}

async function restoredWith(ports: ResetPorts, secret: Uint8Array<ArrayBuffer>): Promise<boolean> {
  ports.setSecret(secret)
  try {
    return await ports.restoreHistory()
  } finally {
    ports.clearSecret()
  }
}

// New 4S from `secret` + new identity + new backup, then the final sweep. Any failure here leaves a
// half-state: attention stays up and the next call resumes it. The sweep is best-effort: the reset
// already happened, and the first sweep covered every access that existed before the approval.
async function buildFromReset(
  ports: ResetPorts,
  secret: Uint8Array<ArrayBuffer>,
  historyPreserved: boolean,
): Promise<ResetOutcome> {
  ports.setSecret(secret)
  try {
    await ports.recreate4S(secret)
    await ports.resetIdentity(secret)
    await ports.resetBackup()
  } catch {
    ports.raiseAttention()
    throw new ResetDeferredError()
  } finally {
    ports.clearSecret()
  }
  await ports.escrow.revokeOthers()
  return { t: 'done', historyPreserved }
}
