import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createAcl } from '../../src/acl'
import type { Acl, AclTelemetry, Channel } from '../../src/acl'
import {
  HOMESERVER,
  synapseReachable,
  whoami,
  createRoom,
  invite,
  join,
  sendText,
} from '../support/synapse'
import { freshUsers } from '../support/fresh-users'

// PLANO-FASE-1-TRADUTORES §1.5 / commit 5: unread comes from the SERVER's notification counts
// (the ACL tracks no receipts of its own), and markRead closes the loop so unread can zero.

const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }

async function asyncUntil<T>(get: () => Promise<T | undefined>, timeoutMs = 150_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await get()
    if (v !== undefined) return v
    if (Date.now() - start > timeoutMs) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 120))
  }
}

describe.skipIf(!SYNAPSE)('ACL unread + markRead (integration)', () => {
  let acl: Acl
  let aliceToken: string
  let bobToken: string
  let bobId: string

  beforeAll(async () => {
    const [alice, bob] = await freshUsers(['una', 'unb'])
    aliceToken = alice.token
    bobToken = bob.token
    bobId = await whoami(bobToken)
    acl = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await acl.connect(aliceToken as Parameters<Acl['connect']>[0])
  }, 180_000)

  afterAll(async () => {
    await acl?.disconnect()
  })

  it('unread reflects the server count for an unread peer message; markRead zeroes it', async () => {
    const name = `tayet-unread-${process.pid}-${Math.floor(Math.random() * 1e6)}`
    const roomId = await createRoom(aliceToken, { name })
    await invite(aliceToken, roomId, bobId)
    await join(bobToken, roomId)
    // A message from bob that alice has NOT read → alice's server unread count climbs.
    await sendText(bobToken, roomId, 'unread me please')

    const unread: Channel = await asyncUntil(async () => {
      const chs = await acl.getChannels()
      const ch = chs.find((c) => c.name === `#${name}`)
      return ch && ch.unread.count >= 1 ? ch : undefined
    })
    expect(unread.unread.count).toBeGreaterThanOrEqual(1)
    expect(typeof unread.unread.mentions).toBe('number')

    // Close the read loop. Without markRead, unread never zeroes (the UX silent-break the plan warns of).
    await acl.markRead(unread.id)

    const zeroed: Channel = await asyncUntil(async () => {
      const ch = await acl.getChannel(unread.id)
      return ch.unread.count === 0 ? ch : undefined
    })
    expect(zeroed.unread.count).toBe(0)
  }, 180_000)
})

describe('ACL unread (availability)', () => {
  it(SYNAPSE ? 'stack reachable' : 'stack down — skipped', () => {
    expect(typeof SYNAPSE).toBe('boolean')
  })
})
