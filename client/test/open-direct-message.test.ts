import { describe, it, expect } from 'vitest'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import type { AclTelemetry, UserId } from '../src/acl'

// Self-DM guard (PLANO-PRESENCA §8.6 item 2), unit side — no Synapse. Fake-client idiom of
// auto-join-invite.test.ts: inject the SDK client via the `client` cast, record what the guard
// must NOT reach. Two claims:
//   (i)  openDirectMessage(self) rejects BEFORE any protocol write — no createRoom, no m.direct
//        write — with a neutral message (no mxid: the error can surface in UI copy).
//   (ii) a target != self follows the normal creation path untouched (createRoom + m.direct).

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const ME = '@me:server'
const PEER = '@peer:server'
const ROOM = '!dm:server'

interface Captured {
  createRoomCalls: unknown[]
  accountData: Array<Record<string, unknown>>
}

function harness(): { gateway: MatrixGateway; cap: Captured } {
  const cap: Captured = { createRoomCalls: [], accountData: [] }
  const fakeClient = {
    getUserId: () => ME,
    getRoom: () => null,
    createRoom: (opts: unknown) => {
      cap.createRoomCalls.push(opts)
      return Promise.resolve({ room_id: ROOM })
    },
    getAccountData: () => undefined,
    setAccountData: (_type: unknown, content: Record<string, unknown>) => {
      cap.accountData.push(content)
      return Promise.resolve(undefined)
    },
  }
  const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
  ;(gateway as unknown as { client: unknown }).client = fakeClient
  return { gateway, cap }
}

describe('openDirectMessage — self-DM guard (PLANO-PRESENCA §8.6 item 2)', () => {
  it('(i) self as target rejects before any write: no createRoom, no m.direct entry', async () => {
    const { gateway, cap } = harness()
    await expect(gateway.openDirectMessage(ME as UserId)).rejects.toThrow(
      'Cannot open a direct message with yourself',
    )
    // Neutral copy — the message never carries the mxid (P1: it can reach UI copy verbatim).
    await gateway.openDirectMessage(ME as UserId).catch((err: Error) => {
      expect(err.message).not.toContain('@')
    })
    expect(cap.createRoomCalls).toEqual([])
    expect(cap.accountData).toEqual([])
  })

  it('(ii) a target != self follows the normal path (createRoom + m.direct write)', async () => {
    const { gateway, cap } = harness()
    const id = await gateway.openDirectMessage(PEER as UserId)
    expect(String(id)).toBe(ROOM)
    expect(cap.createRoomCalls).toHaveLength(1)
    expect(cap.accountData).toEqual([{ [PEER]: [ROOM] }])
  })
})
