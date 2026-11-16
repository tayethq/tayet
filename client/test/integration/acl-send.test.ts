import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createAcl } from '../../src/acl'
import type { Acl, AclTelemetry, ChannelId } from '../../src/acl'
import { findProtocolLeaks } from '@tayet/shared/leak-scan'
import { HOMESERVER, synapseReachable, createRoom } from '../support/synapse'
import { freshUsers } from '../support/fresh-users'

// Commit 6: text send resolves on accept with the real (stable) event id. No optimistic echo
// yet (commit 8). The returned MessageId must round-trip back through getTimeline.

const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }

async function asyncUntil<T>(get: () => Promise<T | undefined>, timeoutMs = 150_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await get()
    if (v !== undefined) return v
    if (Date.now() - start > timeoutMs) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 100))
  }
}

describe.skipIf(!SYNAPSE)('ACL sendMessage text (integration)', () => {
  let acl: Acl
  let token: string

  beforeAll(async () => {
    const [user] = await freshUsers(['snd'])
    token = user.token
    acl = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await acl.connect(token as Parameters<Acl['connect']>[0])
  }, 180_000)

  afterAll(async () => {
    await acl?.disconnect()
  })

  it('sends text and the returned id round-trips through getTimeline as clean domain', async () => {
    const name = `tayet-send-${process.pid}-${Math.floor(Math.random() * 1e6)}`
    await createRoom(token, { name })
    const channel = await asyncUntil(async () => {
      const chs = await acl.getChannels()
      return chs.find((c) => c.name === `#${name}`)
    })
    const id: ChannelId = channel.id

    const text = 'sent through the ACL'
    const messageId = await acl.sendMessage(id, { kind: 'text', text })
    expect(typeof messageId).toBe('string')

    const msg = await asyncUntil(async () => {
      const page = await acl.getTimeline(id)
      return page.items.find((m) => m.id === messageId)
    })
    expect(msg.body).toEqual({ kind: 'text', text })
    expect(findProtocolLeaks(msg)).toEqual([])
  }, 180_000)
})

describe('ACL send (availability)', () => {
  it(SYNAPSE ? 'stack reachable' : 'stack down — skipped', () => {
    expect(typeof SYNAPSE).toBe('boolean')
  })
})
