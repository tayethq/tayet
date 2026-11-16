import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createAcl } from '../../src/acl'
import type { Acl, AclTelemetry, DomainEvent, ChannelId, MessageId } from '../../src/acl'
import { HOMESERVER, synapseReachable, createRoom, invite, whoami } from '../support/synapse'
import { freshUsers } from '../support/fresh-users'
import { until as untilLabeled } from '../support/until'

// Commit 8 / ADR-010: optimistic local echo with a STABLE id. The same MessageId carries the
// message from 'pending' through 'sent', and getTimeline returns it under that same id — no
// re-key, no flicker. Reconciliation (txn↔event) is entirely inside the ACL.

const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }

async function until<T>(get: () => T | undefined, timeoutMs = 150_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = get()
    if (v !== undefined) return v
    if (Date.now() - start > timeoutMs) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 60))
  }
}

// Raise the level needed to send messages above the default member level, so a joined member
// cannot send (read-modify-write of the room's power levels, as the room creator).
async function raiseSendLevel(creatorToken: string, roomId: string): Promise<void> {
  const url = `${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.power_levels/`
  const headers = { Authorization: `Bearer ${creatorToken}`, 'Content-Type': 'application/json' }
  const current = (await (await fetch(url, { headers })).json()) as Record<string, unknown>
  const res = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ ...current, events_default: 50 }) })
  if (!res.ok) throw new Error(`power levels PUT failed: ${res.status} ${await res.text()}`)
}

describe.skipIf(!SYNAPSE)('ACL local echo + status (integration)', () => {
  let acl: Acl
  let token: string
  const events: DomainEvent[] = []

  beforeAll(async () => {
    const [user] = await freshUsers(['eco'])
    token = user.token
    acl = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await acl.connect(token as Parameters<Acl['connect']>[0])
    acl.subscribe((e) => events.push(e))
  }, 180_000)

  afterAll(async () => {
    await acl?.disconnect()
  })

  it('echoes as pending then settles to sent under ONE stable id', async () => {
    const name = `tayet-echo-${process.pid}-${Math.floor(Math.random() * 1e6)}`
    await createRoom(token, { name })
    const id: ChannelId = await until(() => {
      const ev = events.find(
        (e): e is Extract<DomainEvent, { t: 'channel.changed' }> =>
          e.t === 'channel.changed' && e.channel.name === `#${name}`,
      )
      return ev?.channel.id
    })

    const text = 'optimistic hello'
    const messageId: MessageId = await acl.sendMessage(id, { kind: 'text', text })

    // The optimistic 'pending' echo carries the SAME id sendMessage returns.
    const pending = events.find(
      (e) =>
        e.t === 'message.received' &&
        e.message.id === messageId &&
        e.message.status === 'pending' &&
        e.message.body.kind === 'text' &&
        e.message.body.text === text,
    )
    expect(pending, 'pending echo with the stable id was emitted').toBeDefined()

    // …then a 'sent' status for that same id.
    const sent = await until(() =>
      events.find((e) => e.t === 'message.status' && e.messageId === messageId && e.status === 'sent'),
    )
    expect(sent.t).toBe('message.status')

    // …and getTimeline returns the message under that SAME stable id (no re-key on settle).
    const settled = await (async () => {
      const start = Date.now()
      for (;;) {
        const page = await acl.getTimeline(id)
        const m = page.items.find((x) => x.id === messageId)
        if (m) return m
        if (Date.now() - start > 150_000) throw new Error('timed out for timeline')
        await new Promise((r) => setTimeout(r, 100))
      }
    })()
    expect(settled.id).toBe(messageId)
    expect(settled.body).toEqual({ kind: 'text', text })
  }, 180_000)

  it('rejects a send to a channel the session does not know, before any echo (ADR-058)', async () => {
    // A room alice is NOT a member of → unknown to her session → local rejection, no echo.
    const [bob] = await freshUsers(['ecb'])
    const bobToken = bob.token
    const bobRoom = await createRoom(bobToken, { name: `tayet-forbidden-${process.pid}` })
    const unknown = bobRoom as unknown as ChannelId
    const before = events.length
    await expect(acl.sendMessage(unknown, { kind: 'text', text: 'should fail' })).rejects.toThrow(
      'channel not found',
    )
    const caused = events
      .slice(before)
      .filter((e) => (e.t === 'message.status' || e.t === 'message.received') && e.channelId === unknown)
    expect(caused, 'echo/status emitted by the rejected send').toEqual([])
  }, 180_000)

  it('rejects on terminal failure from the server in a KNOWN channel, settling to failed (ADR-010)', async () => {
    // Alice joins bob's room but lacks the level to send messages: the channel is known (the
    // send passes the ADR-058 precondition and echoes as pending) and the SERVER refuses it.
    const [bob] = await freshUsers(['ecr'])
    const bobToken = bob.token
    const name = `tayet-refused-${process.pid}-${Math.floor(Math.random() * 1e6)}`
    const roomId = await createRoom(bobToken, { name })
    await raiseSendLevel(bobToken, roomId)
    await invite(bobToken, roomId, await whoami(token))
    const channelId = roomId as unknown as ChannelId
    // Auto-join of the invite (ADR-044) brings the channel into alice's session.
    await untilLabeled(
      'refusing channel known to sender before send',
      async () => ((await acl.getChannels()).some((c) => c.id === channelId) ? true : undefined),
      {
        snapshot: async () => {
          const chs = await acl.getChannels()
          return `known=${chs.length} hasChannelId=${chs.some((c) => c.id === channelId)}`
        },
      },
    )

    const text = 'refused by the server'
    await expect(acl.sendMessage(channelId, { kind: 'text', text })).rejects.toBeDefined()
    const pending = events.find(
      (e): e is Extract<DomainEvent, { t: 'message.received' }> =>
        e.t === 'message.received' &&
        e.channelId === channelId &&
        e.message.status === 'pending' &&
        e.message.body.kind === 'text' &&
        e.message.body.text === text,
    )
    expect(pending, 'pending echo of the refused send').toBeDefined()
    await untilLabeled(
      'failed status for the refused send',
      () =>
        events.find(
          (e) => e.t === 'message.status' && e.messageId === pending!.message.id && e.status === 'failed',
        ),
      {
        snapshot: () =>
          `statuses=[${events
            .filter((e) => e.t === 'message.status' && e.messageId === pending!.message.id)
            .map((e) => (e.t === 'message.status' ? e.status : ''))
            .join(',')}]`,
      },
    )
  }, 180_000)
})

describe('ACL echo (availability)', () => {
  it(SYNAPSE ? 'stack reachable' : 'stack down — skipped', () => {
    expect(typeof SYNAPSE).toBe('boolean')
  })
})
