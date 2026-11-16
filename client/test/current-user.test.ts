import { describe, it, expect, vi } from 'vitest'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import type { AclTelemetry } from '../src/acl'
import { findProtocolLeaks } from '@tayet/shared/leak-scan'

// P1 boundary assert for currentUser() (ADR-039). The self-identity read derives a domain User from
// the internal whoami (client.getUserId()) by the SAME path as getMembers — so the only thing that
// crosses is the opaque User (branded UserId + clean displayName + opaque avatar). This is a UNIT
// harness with a fake SDK client (mirrors reply-envelope.test.ts), so it runs in CI; the live
// read-back against a real Synapse rides the flaky integration suite (#7), not this gate.
//
// findProtocolLeaks SKIPS the opaque-id key `id` (ADR-008 residual: a branded UserId's runtime value
// IS the mxid, defended by opacity) and asserts everything renderable (displayName, avatar) is free
// of protocol shapes — exactly the P1 line for self-identity.

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const MXID = '@alice:tayet.local'

function gatewayWith(
  profile: { rawDisplayName?: string; avatarUrl?: string } | null,
  userId: string | null = MXID,
  getProfileInfo: () => Promise<{ displayname?: string; avatar_url?: string }> = () => Promise.reject(new Error('down')),
): MatrixGateway {
  const fakeClient = {
    getUserId: () => userId,
    getRooms: () => [],
    getUser: (_id: string) => profile,
    getProfileInfo,
    getAccountData: () => undefined, // ctx() → dmRoomIds() reads m.direct; none here
  }
  const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
  ;(gateway as unknown as { client: unknown }).client = fakeClient
  return gateway
}

describe('currentUser() boundary (ADR-039)', () => {
  it('derives a User with a non-empty displayName and an opaque id — no protocol leak', async () => {
    const user = await gatewayWith({ rawDisplayName: 'Alice' }).currentUser()

    expect(user.displayName).toBe('Alice')
    expect(user.displayName.length).toBeGreaterThan(0)
    // The renderable surface carries no mxid/whoami/protocol shape. The branded id is the accepted
    // ADR-008 residual (skipped by the scanner) — never an mxid the UI could render verbatim.
    expect(findProtocolLeaks(user)).toEqual([])
    expect(user.displayName).not.toContain('@')
    expect(user.displayName).not.toContain(':')
  })

  it('never surfaces the mxid as the displayName — an mxid-shaped or missing name collapses to localpart', async () => {
    // A profile name that IS an mxid (SDK disambiguation, raw mxid as name) must not render verbatim.
    const named = await gatewayWith({ rawDisplayName: MXID }).currentUser()
    expect(named.displayName).toBe('alice')
    expect(findProtocolLeaks(named)).toEqual([])

    // No profile cached yet (getUser → null): falls back to the localpart, never an empty/`@…` name.
    const fallback = await gatewayWith(null).currentUser()
    expect(fallback.displayName).toBe('alice')
    expect(fallback.displayName).not.toContain('@')
    expect(findProtocolLeaks(fallback)).toEqual([])
  })

  it('the avatar crosses as an opaque MediaRef, never a raw mxc:// (ADR-009)', async () => {
    const user = await gatewayWith({ rawDisplayName: 'Alice', avatarUrl: 'mxc://tayet.local/abc123' }).currentUser()

    expect(user.avatar).toBeDefined()
    expect(String(user.avatar)).not.toContain('mxc://')
    expect(findProtocolLeaks(user)).toEqual([])
  })

  it('throws pre-ready (no whoami id yet) — never a silent empty-id User', async () => {
    await expect(gatewayWith({ rawDisplayName: 'Alice' }, null).currentUser()).rejects.toThrow()
  })

  it('first boot (ADR-083): the SDK holds the mxid until a room is joined, so the name comes from the profile', async () => {
    const opaque = '@u-abcdefghij23:tayet.local'
    const profile = async (): Promise<{ displayname: string }> => ({ displayname: 'Ana Lima' })
    for (const cached of [{ rawDisplayName: opaque }, null]) {
      const user = await gatewayWith(cached, opaque, profile).currentUser()
      expect(user.displayName).toBe('Ana Lima')
    }
  })

  it('a name the SDK already has costs no profile read', async () => {
    const read = vi.fn(async () => ({ displayname: 'Outra' }))
    expect((await gatewayWith({ rawDisplayName: 'Alice' }, MXID, read).currentUser()).displayName).toBe('Alice')
    expect(read).not.toHaveBeenCalled()
  })
})
