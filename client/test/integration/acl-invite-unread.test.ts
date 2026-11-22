import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createAcl } from '../../src/acl'
import type { Acl, AclTelemetry, ChannelId, DomainEvent, UserId } from '../../src/acl'
import { HOMESERVER, synapseReachable, whoami } from '../support/synapse'
import { freshUsers } from '../support/fresh-users'
import { until } from '../support/until'

// The invite a person enters automatically must not stay in that person's unread count. The server
// records a push action for the invite; once its periodic consolidation folds an action that came after
// the entry, the invite rides along in the count until the first read. Two connected ACLs: the creator
// and the invitee. Three conversations born through the product's verbs (direct, group, private channel
// with the invitee as a member). In each: a first message, one shared wait past a consolidation period,
// a second message. The invitee must read 2 in each, never 3. Auto-skip without the stack.

const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }

// The server consolidates its unread counters every 30 s. One blind wait of a full period plus a margin,
// shared by the three conversations, guarantees a consolidation falls between the two messages.
const CONSOLIDATION_WAIT_MS = 35_000

async function withRetry<T>(fn: () => Promise<T>, attempts = 20): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      const retryAfter = (err as { data?: { retry_after_ms?: number } }).data?.retry_after_ms
      if (retryAfter === undefined || attempt >= attempts) throw err
      await new Promise((r) => setTimeout(r, retryAfter + 200))
    }
  }
}

type Kind = 'direct' | 'group' | 'private'

describe.skipIf(!SYNAPSE)('automatic entry leaves no extra unread after consolidation', () => {
  let creator: Acl
  let invitee: Acl
  let inviteeId: UserId
  let thirdId: UserId
  const seen: DomainEvent[] = []

  beforeAll(async () => {
    const [a, b, c] = await freshUsers(['iua', 'iub', 'iuc'])
    inviteeId = (await whoami(b.token)) as unknown as UserId
    thirdId = (await whoami(c.token)) as unknown as UserId
    creator = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await creator.connect(a.token as Parameters<Acl['connect']>[0])
    invitee = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await invitee.connect(b.token as Parameters<Acl['connect']>[0])
    invitee.subscribe((e) => seen.push(e))
  }, 240_000)

  afterAll(async () => {
    await creator?.disconnect()
    await invitee?.disconnect()
  })

  const received = (text: string) => () =>
    seen.some((e) => e.t === 'message.received' && e.message.body.kind === 'text' && e.message.body.text === text) ? true : undefined

  async function send(ch: ChannelId, text: string): Promise<void> {
    await withRetry(() => creator.sendMessage(ch, { kind: 'text', text }))
    await until(`the invitee receives "${text}"`, received(text))
  }

  it(
    'direct, group and private channel: two messages around a consolidation read as 2',
    async () => {
      const tag = `${process.pid}-${Date.now()}`
      const channels = new Map<Kind, ChannelId>()
      channels.set('direct', await withRetry(() => creator.openDirectMessage(inviteeId)))
      channels.set('group', await withRetry(() => creator.openGroupConversation([inviteeId, thirdId])))
      channels.set(
        'private',
        await withRetry(() => creator.createChannel({ name: `iu-priv-${tag}`, kind: 'private', members: [inviteeId] })),
      )
      for (const [kind, ch] of channels)
        await until(`the invitee entered the ${kind} conversation`, async () =>
          (await invitee.getChannels()).some((c) => c.id === ch) ? true : undefined,
        )

      for (const [kind, ch] of channels) await send(ch, `${kind} first ${tag}`)
      await new Promise((r) => setTimeout(r, CONSOLIDATION_WAIT_MS))
      for (const [kind, ch] of channels) await send(ch, `${kind} second ${tag}`)

      const counts: Record<string, number> = {}
      for (const [kind, ch] of channels) {
        counts[kind] = await until(`the ${kind} count reflects the second message`, async () => {
          const n = (await invitee.getChannel(ch)).unread.count
          return n >= 2 ? n : undefined
        })
      }
      expect(counts).toEqual({ direct: 2, group: 2, private: 2 })
    },
    300_000,
  )
})

// Always-present marker so the file is never an empty suite with the stack down.
describe('automatic entry unread (availability)', () => {
  it(SYNAPSE ? 'stack reachable — integration ran' : 'stack down — integration skipped', () => {
    expect(typeof SYNAPSE).toBe('boolean')
  })
})
