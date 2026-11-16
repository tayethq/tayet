import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createAcl } from '../../src/acl'
import type { Acl, AclTelemetry, DomainEvent, ChannelId, MessageId } from '../../src/acl'
import {
  HOMESERVER,
  synapseReachable,
  whoami,
  createRoom,
  invite,
  join,
  sendText,
  reactTo,
} from '../support/synapse'
import { freshUsers } from '../support/fresh-users'

// PLANO-FASE-1-TRADUTORES §1.4 / commit 9: aggregate m.reaction by EXACT key, redaction→
// decrement, and reaction.changed carries the new aggregated array (consumable directly).

const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }

async function until<T>(get: () => T | undefined, label = '?', timeoutMs = 150_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = get()
    if (v !== undefined) return v
    if (Date.now() - start > timeoutMs) throw new Error(`timed out: ${label}`)
    await new Promise((r) => setTimeout(r, 60))
  }
}
type ReactionChanged = Extract<DomainEvent, { t: 'reaction.changed' }>
const lastReaction = (events: DomainEvent[], id: MessageId): ReactionChanged | undefined =>
  [...events].reverse().find((e): e is ReactionChanged => e.t === 'reaction.changed' && e.messageId === id)

describe.skipIf(!SYNAPSE)('ACL reactions (integration)', () => {
  let acl: Acl
  let aliceToken: string
  let bobToken: string
  const events: DomainEvent[] = []

  beforeAll(async () => {
    const [alice, bob] = await freshUsers(['rea', 'reb'])
    aliceToken = alice.token
    bobToken = bob.token
    acl = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await acl.connect(aliceToken as Parameters<Acl['connect']>[0])
    acl.subscribe((e) => events.push(e))
  }, 180_000)

  afterAll(async () => {
    await acl?.disconnect()
  })

  it('aggregates by exact key, exposes mine, and decrements on redaction', async () => {
    const name = `tayet-react-${process.pid}-${Math.floor(Math.random() * 1e6)}`
    const roomId = await createRoom(aliceToken, { name })
    const bobId = await whoami(bobToken)
    await invite(aliceToken, roomId, bobId)
    await join(bobToken, roomId)

    // Send via REST so the test knows the real event id (also the stable MessageId here).
    const eventId = await sendText(aliceToken, roomId, 'react to me')
    const messageId = eventId as unknown as MessageId

    const channelId: ChannelId = await until(() => {
      const ev = events.find(
        (e): e is Extract<DomainEvent, { t: 'channel.changed' }> =>
          e.t === 'channel.changed' && e.channel.name === `#${name}`,
      )
      return ev?.channel.id
    }, 'channel.changed')
    // Wait until alice's client actually has the message (so react() can locate it).
    await (async () => {
      const start = Date.now()
      for (;;) {
        const page = await acl.getTimeline(channelId)
        if (page.items.some((m) => m.id === messageId)) return
        if (Date.now() - start > 150_000) throw new Error('message never synced')
        await new Promise((r) => setTimeout(r, 100))
      }
    })()

    // alice reacts 👍
    await acl.react(messageId, '👍')
    const r1 = await until(() => {
      const r = lastReaction(events, messageId)
      return r?.reactions.some((x) => x.emoji === '👍' && x.count === 1 && x.mine) ? r : undefined
    }, 'r1 alice 👍')
    expect(r1.reactions.find((x) => x.emoji === '👍')?.mine).toBe(true)

    // bob also reacts 👍 → count 2 (still mine)
    await reactTo(bobToken, roomId, eventId, '👍')
    await until(() => {
      const r = lastReaction(events, messageId)
      return r?.reactions.some((x) => x.emoji === '👍' && x.count === 2 && x.mine) ? r : undefined
    }, 'r2 bob 👍')

    // bob reacts 🎉 → a SEPARATE key (exact-key aggregation, no merging)
    await reactTo(bobToken, roomId, eventId, '🎉')
    const r3 = await until(() => {
      const r = lastReaction(events, messageId)
      return r?.reactions.some((x) => x.emoji === '🎉' && x.count === 1 && !x.mine) ? r : undefined
    }, 'r3 bob 🎉')
    expect(r3.reactions.map((x) => x.emoji).sort()).toEqual(['🎉', '👍'])

    // alice removes her 👍 → decrement to 1, no longer mine
    await acl.removeReaction(messageId, '👍')
    const r4 = await until(() => {
      const r = lastReaction(events, messageId)
      return r?.reactions.some((x) => x.emoji === '👍' && x.count === 1 && !x.mine) ? r : undefined
    }, 'r4 alice remove 👍')
    expect(r4.reactions.find((x) => x.emoji === '👍')?.mine).toBe(false)

    // getTimeline reflects the aggregate on the message.
    const page = await acl.getTimeline(channelId)
    const msg = page.items.find((m) => m.id === messageId)
    expect(msg?.reactions.find((x) => x.emoji === '🎉')?.count).toBe(1)
    expect(msg?.reactions.find((x) => x.emoji === '👍')?.count).toBe(1)
  }, 180_000)
})

describe('ACL reactions (availability)', () => {
  it(SYNAPSE ? 'stack reachable' : 'stack down — skipped', () => {
    expect(typeof SYNAPSE).toBe('boolean')
  })
})
