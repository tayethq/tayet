import type { Role, UserKind } from '../domain'

// Power level → Role. This mapping is LOSSY: Matrix power levels are a 0–100 continuum and
// Role is a 3-value enum, so the inverse is not well-defined.
//
// TODO(owner-review): PL→Role lossy, revisitar se precisar de 'moderator'
//
// MVP policy (local, reversible — a commit decision, NOT an ADR; see PLANO-FASE-1 §5):
//   PL >= 50 → 'admin', otherwise 'member'. Revisit if a distinct 'moderator' tier is ever needed.
// ADR-083 dec. 4: 'guest' comes from kind, never from PL — inside a channel a guest stays a guest,
// whatever PL they were given.
// ADR-086 (Proposto) dec. 5: an agent is never admin — whatever PL it holds, it reads 'member'.
export function roleOf(powerLevel: number, kind: UserKind): Role {
  switch (kind) {
    case 'guest':
      return 'guest'
    case 'agent':
      return 'member'
    case 'member':
      return powerLevel >= 50 ? 'admin' : 'member'
    default: {
      const unreachable: never = kind
      return unreachable
    }
  }
}

// Role → power level (PLANO-MEMBERSHIP-CANAIS / ADR-026 §0.2). The explicit inverse of the
// threshold above: admin → 50, member → 0. It does NOT model the owner tier (PL 100) — the
// owner's decision: ignore it in the demo. Measured in PR #508 (ADR-026 addendum): the server
// refuses EVERY role change made at PL 50, not only promoting above 50 or demoting the
// creator/100 — changing the power levels needs PL 100, so only the channel's creator changes
// roles. The screen no longer offers the control to whoever the server would refuse (ADR-115);
// a refusal still rejects honestly and is never worked around.
export function roleToPowerLevel(role: 'admin' | 'member'): number {
  return role === 'admin' ? 50 : 0
}
