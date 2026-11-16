import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createAcl } from '../../src/acl'
import type { Acl, AclTelemetry, ChannelId, DomainEvent } from '../../src/acl'
import { HOMESERVER, synapseReachable, createRoom } from '../support/synapse'
import { freshUsers } from '../support/fresh-users'
import { until } from '../support/until'

// ADR-058 / PLANO-GATES §8.14: an attachment to an ENCRYPTED channel the sender's
// session does not know must be rejected before any effect. Before ADR-058 the ACL resolved
// "not encrypted" for lack of data and uploaded the bytes in clear (§8.12 item 5). Here the
// channel is a `private` (encrypted) one created by ANOTHER user's ACL; the sender is not a member.
// Upload requests are counted at globalThis.fetch — a positive control first proves the counter
// sees a real upload, so the zero below has meaning.

const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }

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

// Count media upload requests issued while `fn` runs; the real fetch is restored in finally.
async function countUploads(fn: () => Promise<unknown>): Promise<number> {
  const realFetch = globalThis.fetch
  let uploads = 0
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('/media/') && url.includes('/upload')) uploads++
    return realFetch(input, init)
  }) as typeof fetch
  try {
    await fn().catch(() => {})
  } finally {
    globalThis.fetch = realFetch
  }
  return uploads
}

const file = (): File => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])], 'x.png', { type: 'image/png' })

describe.skipIf(!SYNAPSE)('ACL send to an unknown encrypted channel (integration, ADR-058)', () => {
  let sender: Acl
  let owner: Acl
  let senderToken: string
  const events: DomainEvent[] = []

  beforeAll(async () => {
    const [snd, own] = await freshUsers(['unk', 'uno'])
    senderToken = snd.token
    sender = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await sender.connect(snd.token as Parameters<Acl['connect']>[0])
    sender.subscribe((e) => events.push(e))
    owner = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await owner.connect(own.token as Parameters<Acl['connect']>[0])
  }, 180_000)

  afterAll(async () => {
    await sender?.disconnect()
    await owner?.disconnect()
  })

  it('rejects an attachment to an unknown encrypted channel: no pending, no upload', async () => {
    // Positive control: a send to a channel the sender knows goes through the counted fetch.
    const name = `tayet-unk-ctl-${process.pid}-${Math.floor(Math.random() * 1e6)}`
    const ownRoom = (await createRoom(senderToken, { name })) as unknown as ChannelId
    await until(
      'control channel known to sender before attachment send',
      async () => ((await sender.getChannels()).some((c) => c.id === ownRoom) ? true : undefined),
      {
        snapshot: async () => {
          const chs = await sender.getChannels()
          return `known=${chs.length} hasChannelId=${chs.some((c) => c.id === ownRoom)}`
        },
      },
    )
    const controlUploads = await countUploads(() => sender.sendMessage(ownRoom, { kind: 'attachment', file: file() }))
    expect(controlUploads, 'the counter sees the upload of a valid send').toBeGreaterThanOrEqual(1)

    // The encrypted channel belongs to another user; the sender is not a member.
    const secret = await withRetry(() =>
      owner.createChannel({ name: `tayet-unk-${process.pid}-${Math.floor(Math.random() * 1e6)}`, kind: 'private' }),
    )
    const before = events.length
    let rejection: unknown
    const uploads = await countUploads(() =>
      sender.sendMessage(secret, { kind: 'attachment', file: file() }).catch((err: unknown) => {
        rejection = err
      }),
    )
    expect(String(rejection)).toContain('channel not found')
    expect(uploads, 'upload requests during the rejected send').toBe(0)
    const caused = events
      .slice(before)
      .filter((e) => (e.t === 'message.received' || e.t === 'message.status') && e.channelId === secret)
    expect(caused, 'pending/status emitted by the rejected send').toEqual([])
  }, 180_000)
})

describe('ACL send unknown channel (availability)', () => {
  it(SYNAPSE ? 'stack reachable' : 'stack down — skipped', () => {
    expect(typeof SYNAPSE).toBe('boolean')
  })
})
