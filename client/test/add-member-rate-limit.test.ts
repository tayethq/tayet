import { describe, it, expect } from 'vitest'
import { MatrixError } from 'matrix-js-sdk'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import { RateLimitedError } from '../src/acl'
import type { AclTelemetry, ChannelId, UserId } from '../src/acl'

// Unit: the addMember seam maps the server's rate limit (M_LIMIT_EXCEEDED, e.g. rc_invites.per_user)
// to the payload-free domain error RateLimitedError, in the fake-client idiom of auto-join-invite.
// Narrow of purpose (mirrors M_UNKNOWN_TOKEN → SessionExpiredError): ONLY that errcode is remapped;
// every other failure propagates as-is so the panel's generic inline error still fires. The SDK
// errcode is discarded here (acl/internal) and never crosses the barrel — P1 (L19/ADR-007).

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const CH = '!c:server' as unknown as ChannelId
const U = '@u:server' as unknown as UserId

function gatewayWithInvite(invite: () => Promise<unknown>): MatrixGateway {
  const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
  // getRoom: the ADR-094 group check reads the room first; unknown here, so a channel.
  ;(gateway as unknown as { client: unknown }).client = { invite, getRoom: () => null }
  return gateway
}

describe('addMember — rate-limit mapping (M_LIMIT_EXCEEDED → RateLimitedError)', () => {
  it('M_LIMIT_EXCEEDED → RateLimitedError, payload-free (no errcode crosses)', async () => {
    const gw = gatewayWithInvite(() =>
      Promise.reject(new MatrixError({ errcode: 'M_LIMIT_EXCEEDED', error: 'Too Many Requests' })),
    )
    const err = (await gw.addMember(CH, U).catch((e: unknown) => e)) as Error
    expect(err).toBeInstanceOf(RateLimitedError)
    expect(err.message).toBe('Rate limited')
    // P1: the domain error carries no protocol errcode.
    expect((err as unknown as { errcode?: unknown }).errcode).toBeUndefined()
  })

  it('a different errcode propagates as-is (generic inline error still fires)', async () => {
    const other = new MatrixError({ errcode: 'M_FORBIDDEN', error: 'nope' })
    const gw = gatewayWithInvite(() => Promise.reject(other))
    await expect(gw.addMember(CH, U)).rejects.toBe(other)
  })

  it('a non-Matrix error propagates as-is', async () => {
    const boom = new Error('network down')
    const gw = gatewayWithInvite(() => Promise.reject(boom))
    await expect(gw.addMember(CH, U)).rejects.toBe(boom)
  })
})
