import { describe, it, expect, vi } from 'vitest'
import { ReceiptType } from 'matrix-js-sdk'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import type { AclTelemetry } from '../src/acl'

// An automatic entry (an invite accepted by the ACL) leaves the room read up to the session's own join
// event, with a private receipt: the server otherwise keeps the invite in the unread count once it
// consolidates an action that came after the join. Unit harness with a fake SDK client (same shape as
// own-send-receipt); the server side lives in test/integration/acl-invite-unread.test.ts.

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const ME = '@me:tayet.local'
const ROOM_ID = '!room:tayet.local'

function harness(opts: { joinId?: string; receiptFails?: boolean; joinFails?: boolean; joinedOnResolve?: boolean } = {}) {
  const inviteEvent = { getId: () => '$invite', getSender: () => '@peer:tayet.local', getContent: () => ({ membership: 'invite' }) }
  const joinEvent = { getId: () => opts.joinId ?? '$join', getContent: () => ({ membership: 'join' }) }
  let membership: 'invite' | 'join' = 'invite'
  const room = {
    roomId: ROOM_ID,
    getMember: () => ({ events: { member: membership === 'invite' ? inviteEvent : joinEvent } }),
    currentState: { getStateEvents: () => (membership === 'invite' ? inviteEvent : joinEvent) },
  }
  const effects = {
    joinRoom: vi.fn(async () => {
      if (opts.joinFails) throw new Error('join 500')
      if (opts.joinedOnResolve !== false) membership = 'join'
      return room
    }),
    sendReadReceipt: vi.fn(async () => (opts.receiptFails ? Promise.reject(new Error('receipt 500')) : {})),
  }
  const fakeClient = {
    getRooms: () => [room],
    getRoom: (id: string) => (id === ROOM_ID ? room : null),
    getUserId: () => ME,
    getAccountData: () => undefined,
    ...effects,
  }
  const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
  ;(gateway as unknown as { client: unknown }).client = fakeClient
  const internals = gateway as unknown as {
    autoJoinInvite(room: unknown): Promise<void>
    sendEntryReceipt(room: unknown): void
  }
  return {
    effects,
    joinEvent,
    autoJoin: () => internals.autoJoinInvite(room),
    // What the ->join branch of the membership listener does for every room this session enters.
    onJoined: () => internals.sendEntryReceipt(room),
    syncDeliversJoin: () => {
      membership = 'join'
    },
  }
}

describe('automatic entry leaves the room read up to the join (private receipt)', () => {
  it('an automatic entry sends one private receipt on its own join event', async () => {
    const { effects, joinEvent, autoJoin, onJoined } = harness()
    await autoJoin()
    onJoined()
    expect(effects.sendReadReceipt).toHaveBeenCalledTimes(1)
    expect(effects.sendReadReceipt).toHaveBeenCalledWith(joinEvent, ReceiptType.ReadPrivate)
    expect(effects.sendReadReceipt.mock.invocationCallOrder[0]!).toBeGreaterThan(effects.joinRoom.mock.invocationCallOrder[0]!)
  })

  it('the join reaching the room after joinRoom resolves: the receipt goes with the ->join transition, once', async () => {
    const { effects, joinEvent, autoJoin, onJoined, syncDeliversJoin } = harness({ joinedOnResolve: false })
    await autoJoin()
    expect(effects.sendReadReceipt).not.toHaveBeenCalled()
    syncDeliversJoin()
    onJoined()
    onJoined()
    expect(effects.sendReadReceipt).toHaveBeenCalledTimes(1)
    expect(effects.sendReadReceipt).toHaveBeenCalledWith(joinEvent, ReceiptType.ReadPrivate)
  })

  it("the creator's own entry (never an automatic entry) sends no receipt", () => {
    const { effects, onJoined, syncDeliversJoin } = harness()
    syncDeliversJoin()
    onJoined()
    expect(effects.sendReadReceipt).not.toHaveBeenCalled()
  })

  it('a join event without its server id sends no receipt', async () => {
    const { effects, autoJoin, onJoined } = harness({ joinId: '~local' })
    await autoJoin()
    onJoined()
    expect(effects.sendReadReceipt).not.toHaveBeenCalled()
  })

  it('a failed receipt does not become an error', async () => {
    const { effects, autoJoin } = harness({ receiptFails: true })
    await expect(autoJoin()).resolves.toBeUndefined()
    expect(effects.sendReadReceipt).toHaveBeenCalledTimes(1)
  })

  it('a failed join owes no receipt', async () => {
    const { effects, autoJoin, onJoined, syncDeliversJoin } = harness({ joinFails: true })
    await autoJoin()
    syncDeliversJoin()
    onJoined()
    expect(effects.sendReadReceipt).not.toHaveBeenCalled()
  })
})
