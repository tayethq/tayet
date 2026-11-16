// ACL contract types the translator needs (ADR-088). Re-exported unchanged by client/src/acl/types.ts.
import type { User, Role, MemberState, UnsupportedShape } from './domain'

// ADR-081: a roster entry. `self` is resolved in the ACL against the session; the id never crosses for it.
export type RosterEntry = { user: User; role: Role; state: MemberState; self: boolean }

// ── D3 fail-closed (contract-level) ──────────────────────────────────────────────────────
export type AclMode = 'strict' | 'lenient'

// Category of an untranslatable concept. Drives degradation (content-carrying → visible
// 'unsupported'; noise → silent discard) and is the only structured field telemetry carries.
export type ConceptKind =
  | 'message-content'
  | 'member'
  | 'channel'
  | 'reaction'
  | 'protocol-event'

// Type-safe against leakage: there is no free-form payload field, so it is impossible to
// pass a payload, PII, or a protocol id through telemetry (ADR-007 §3).
export interface AclTelemetry {
  untranslated(e: { conceptKind: ConceptKind; shape: UnsupportedShape }): void
}
