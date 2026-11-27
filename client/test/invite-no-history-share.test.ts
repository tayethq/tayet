import { describe, it, expect } from 'vitest'
import { MatrixError } from 'matrix-js-sdk'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import type { AclTelemetry, ChannelId, UserId } from '../src/acl'
import { directInviteHttp, type DirectInviteCall } from './support/direct-invite'

// ADR-057 norm 1 by construction (addendum of 24/Nov/2026, issue #421): in matrix-js-sdk 41.6.0 the
// client's `invite` calls `shareRoomHistoryWithUser` before the membership change whenever the room's
// visibility is `shared` (ours, norm 3), so the inviter's device builds and uploads a bundle with the
// history keys. Every invite the ACL sends goes out as a direct `POST /rooms/{roomId}/invite` with
// `{ user_id }` (the same request the SDK's membershipChange sends), and nothing builds a bundle.
// Three call sites: addMember, the immediate custody invite and the deferred custody drain.

const ME = '@me:tayet.local'
const COFRE = '@cofre:tayet.local'
const ROOM = '!room:tayet.local'
const PEER = '@peer:tayet.local'

interface Spies {
  sdkInvite: string[]
  historyShare: string[]
  http: DirectInviteCall[]
  invited: Array<{ roomId: string; userId: string }>
}

function harness(script: Array<'ok' | MatrixError> = []): { gateway: MatrixGateway; spies: Spies } {
  const spies: Spies = { sdkInvite: [], historyShare: [], http: [], invited: [] }
  const telemetry: AclTelemetry = { untranslated: () => {} }
  const shareRoomHistoryWithUser = (roomId: string, userId: string): Promise<void> => {
    spies.historyShare.push(`${roomId} ${userId}`)
    return Promise.resolve()
  }
  const fakeClient = {
    getUserId: () => ME,
    getRoom: () => ({
      roomId: ROOM,
      // No group marker: a channel (the ADR-094 check in addMember reads it first).
      currentState: { getStateEvents: () => undefined },
      getMember: (uid: string) => (uid === COFRE ? { userId: COFRE, membership: 'invite' } : null),
    }),
    createRoom: () => Promise.resolve({ room_id: ROOM }),
    // The SDK verb, recorded instead of failing: the assertion is what reproves it.
    invite: (roomId: string, userId: string) => {
      spies.sdkInvite.push(`${roomId} ${userId}`)
      return shareRoomHistoryWithUser(roomId, userId)
    },
    cryptoBackend: { shareRoomHistoryWithUser },
    getCrypto: () => ({ shareRoomHistoryWithUser }),
    http: directInviteHttp((roomId, userId) => {
      spies.invited.push({ roomId, userId })
      const next = script.shift() ?? 'ok'
      return next === 'ok' ? Promise.resolve({}) : Promise.reject(next)
    }, spies.http),
    getAccountData: () => undefined,
    setAccountData: () => Promise.resolve(undefined),
  }
  const gateway = new MatrixGateway({ mode: 'strict', telemetry, serverUrl: 'http://x' })
  ;(gateway as unknown as { client: unknown }).client = fakeClient
  return { gateway, spies }
}

const directInvite = (roomId: string, userId: string): DirectInviteCall => ({
  method: 'POST',
  path: `/rooms/${encodeURIComponent(roomId)}/invite`,
  body: { user_id: userId },
})

function expectNoBundle(spies: Spies): void {
  expect(spies.sdkInvite, 'the SDK invite was called').toEqual([])
  expect(spies.historyShare, 'a history bundle was built').toEqual([])
}

async function until(probe: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now()
  while (!probe()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe('invite without the SDK history share (ADR-057 norm 1, addendum of 24/Nov/2026)', () => {
  it('addMember: direct POST /rooms/{roomId}/invite with { user_id }, no bundle', async () => {
    const { gateway, spies } = harness()
    await gateway.addMember(ROOM as unknown as ChannelId, PEER as unknown as UserId)
    expectNoBundle(spies)
    expect(spies.http).toEqual([directInvite(ROOM, PEER)])
  })

  it('custody invite at birth: direct call, no bundle', async () => {
    const { gateway, spies } = harness()
    await gateway.createChannel({ name: 'privado', kind: 'private' })
    expectNoBundle(spies)
    expect(spies.http).toEqual([directInvite(ROOM, COFRE)])
  })

  it('deferred custody invite (drain after 429): direct call, no bundle', async () => {
    const limited = new MatrixError({ errcode: 'M_LIMIT_EXCEEDED', error: 'Too Many Requests', retry_after_ms: 20 }, 429)
    const { gateway, spies } = harness([limited])
    await gateway.createChannel({ name: 'privado', kind: 'private' })
    await until(() => spies.invited.length >= 2 || spies.sdkInvite.length >= 1, 'deferred custody invite')
    expectNoBundle(spies)
    expect(spies.http).toEqual([directInvite(ROOM, COFRE), directInvite(ROOM, COFRE)])
  }, 15_000)
})
