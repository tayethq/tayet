import { describe, it, expect } from 'vitest'
import type { RoomMember } from 'matrix-js-sdk'
import { memberToUserRole } from '../src/internal'

// Unit: memberToUserRole stamps MemberState from the RoomMember's membership (PLANO §8.CONVITE).
// 'invite' → 'invited' (role still computed from PL); 'join' → 'active'. The raw membership string
// never leaves acl/internal — only { user, role, state, self } crosses.

function fakeMember(membership: string, powerLevel = 0): RoomMember {
  return {
    userId: '@u:server',
    rawDisplayName: 'U',
    powerLevel,
    membership,
    getMxcAvatarUrl: () => null,
  } as unknown as RoomMember
}

// ctx: only ctx.mediaRefFor is read (optional-chained) — an empty ctx is safe at runtime.
const ctx = {} as Parameters<typeof memberToUserRole>[1]

describe('memberToUserRole — MemberState (PLANO §8.CONVITE)', () => {
  it("membership 'join' → state 'active'", () => {
    const r = memberToUserRole(fakeMember('join'), ctx, false)
    expect(r.state).toBe('active')
    expect(r.role).toBe('member')
  })
  it("membership 'invite' → state 'invited', role still from PL", () => {
    const r = memberToUserRole(fakeMember('invite'), ctx, false)
    expect(r.state).toBe('invited')
    expect(r.role).toBe('member')
  })
})

describe('memberToUserRole — self (ADR-081)', () => {
  it('carries the boolean the gateway resolved against the session', () => {
    expect(memberToUserRole(fakeMember('join'), ctx, true).self).toBe(true)
    expect(memberToUserRole(fakeMember('join'), ctx, false).self).toBe(false)
  })
})
