import { describe, it, expect, vi } from 'vitest'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import type { AclTelemetry, ChannelId, MessageId } from '../src/acl'

// #243 (PLANO-RELEASE-PUBLICA §8.58): no read receipt ever goes on a local echo. Measured before the
// fix: cid sends three messages and opens a thread with no replies yet; the thread's markRead carries
// no target (`last?.id` of an empty page), the no-target branch took the live timeline's last event —
// the third send, still pending (`~<room>:<txn>`) — and the server answered 400. The local echo sits on
// the live timeline because pendingEventOrdering stays 'chronological'. Unit harness with a fake SDK
// client (same shape as own-send-receipt); the tier proof is account.spec test 2 with no cap on it.

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const ME = '@me:tayet.local'
const ROOM_ID = '!r:tayet.local'
const CH = ROOM_ID as unknown as ChannelId

const settled = (id: string) => ({ getId: () => id, status: null, isSending: () => false })
const echo = (txn: string) => ({ getId: () => `~${ROOM_ID}:${txn}`, status: 'sending', isSending: () => true })

function harness(timeline: unknown[]) {
  const room = {
    roomId: ROOM_ID,
    getMyMembership: () => 'join',
    findEventById: (id: string) => timeline.find((e) => (e as { getId(): string }).getId() === id),
    getLiveTimeline: () => ({ getEvents: () => timeline }),
  }
  const effects = { sendReadReceipt: vi.fn(async () => ({})) }
  const fakeClient = {
    getRooms: () => [room],
    getRoom: (id: string) => (id === ROOM_ID ? room : null),
    getUserId: () => ME,
    getAccountData: () => undefined,
    ...effects,
  }
  const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
  ;(gateway as unknown as { client: unknown }).client = fakeClient
  return { gateway, effects }
}

describe('a read receipt never targets a local echo (#243)', () => {
  it('markRead with no target: the receipt goes on the last settled event, past the trailing echo', async () => {
    const last = settled('$settled')
    const { gateway, effects } = harness([settled('$older'), last, echo('m1.1')])
    await gateway.markRead(CH)
    expect(effects.sendReadReceipt).toHaveBeenCalledTimes(1)
    expect(effects.sendReadReceipt).toHaveBeenCalledWith(last)
  })

  it('markRead with no target and only echoes on the timeline: no receipt at all', async () => {
    const { gateway, effects } = harness([echo('m1.1'), echo('m1.2')])
    await gateway.markRead(CH)
    expect(effects.sendReadReceipt).not.toHaveBeenCalled()
  })

  it('markRead with an explicit target that is still an echo: deferred, nothing sent', async () => {
    const pending = echo('m1.1')
    const { gateway, effects } = harness([settled('$settled'), pending])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await gateway.markRead(CH, pending.getId() as unknown as MessageId)
    expect(effects.sendReadReceipt).not.toHaveBeenCalled()
    const deferred = (gateway as unknown as { pendingReadTarget: Map<string, string> }).pendingReadTarget
    expect(deferred.get(ROOM_ID)).toBe(pending.getId())
    warn.mockRestore()
  })
})
