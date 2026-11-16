import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createAcl } from '../../src/acl'
import type { Acl, AclTelemetry, DomainEvent, ChannelId, MessageId } from '../../src/acl'
import { findProtocolLeaks } from '@tayet/shared/leak-scan'
import {
  HOMESERVER,
  synapseReachable,
  createRoom,
  sendText,
  editText,
  redact,
  whoami,
  invite,
  join,
  findOwnEvent,
  getRelations,
  getMessages,
  getEvent,
} from '../support/synapse'
import { freshUsers } from '../support/fresh-users'
import { EDIT_REDACTION_FIELD } from '@tayet/shared/internal'

// P1 gate #1 (stream half, PLANO-FASE-1-TRADUTORES §3 commit 4): drive real /sync deltas and
// assert the domain stream emits clean branded events for received/edited/removed + lifecycle.

const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }

async function until<T>(get: () => T | undefined | Promise<T | undefined>, timeoutMs = 150_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await get()
    if (v !== undefined) return v
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 50))
  }
}

describe.skipIf(!SYNAPSE)('ACL domain stream (integration)', () => {
  let acl: Acl
  let token: string
  const events: DomainEvent[] = []

  beforeAll(async () => {
    const [user] = await freshUsers(['stm'])
    token = user.token
    acl = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await acl.connect(token as Parameters<Acl['connect']>[0])
    acl.subscribe((e) => events.push(e))
  }, 180_000)

  afterAll(async () => {
    await acl?.disconnect()
  })

  it('emits message.received / edited / removed as clean domain', async () => {
    const name = `tayet-stream-${process.pid}-${Math.floor(Math.random() * 1e6)}`
    const roomId = await createRoom(token, { name })

    // The new room becomes known via sync → channel.changed carries the domain Channel.
    const ch = await until<ChannelId>(() => {
      const ev = events.find(
        (e): e is Extract<DomainEvent, { t: 'channel.changed' }> =>
          e.t === 'channel.changed' && e.channel.name === `#${name}`,
      )
      return ev?.channel.id
    })

    // received
    const text = 'stream hello'
    const origId = await sendText(token, roomId, text)
    const received = await until(() =>
      events.find(
        (e) =>
          e.t === 'message.received' &&
          e.message.body.kind === 'text' &&
          e.message.body.text === text,
      ),
    )
    expect(received.t).toBe('message.received')
    if (received.t === 'message.received') {
      expect(received.channelId).toBe(ch)
      expect(findProtocolLeaks(received.message)).toEqual([])
    }

    // edited — same stable id, new body
    await editText(token, roomId, origId, 'stream edited')
    const edited = await until(() =>
      events.find(
        (e) =>
          e.t === 'message.edited' &&
          e.message.body.kind === 'text' &&
          e.message.body.text === 'stream edited',
      ),
    )
    if (edited.t === 'message.edited') {
      expect(edited.message.id).toBe(origId) // id is stable across the edit
      expect(edited.message.editedAt).toBeTypeOf('number')
      expect(findProtocolLeaks(edited.message)).toEqual([])
    }

    // removed
    await redact(token, roomId, origId)
    const removed = await until(() =>
      events.find((e) => e.t === 'message.removed' && e.messageId === origId),
    )
    expect(removed.t).toBe('message.removed')

    // removed by deleteMessage (ADR-075): the session's own send, deleted through the verb, is
    // removed under the STABLE id sendMessage returned (ADR-010), not the event id.
    const ownId = await acl.sendMessage(ch, { kind: 'text', text: 'stream to delete' })
    await acl.deleteMessage(ownId)
    const deleted = await until(() =>
      events.find((e) => e.t === 'message.removed' && e.messageId === ownId),
    )
    expect(deleted.t).toBe('message.removed')
    expect(findProtocolLeaks(deleted)).toEqual([])
  }, 180_000)

  it('emits connection.changed (connected) and member.changed (clean)', async () => {
    const connected = await until(() =>
      events.find((e) => e.t === 'connection.changed' && e.state === 'connected'),
    )
    expect(connected.t).toBe('connection.changed')

    const member = await until(() => events.find((e) => e.t === 'member.changed'))
    expect(findProtocolLeaks(member)).toEqual([])
    if (member.t === 'member.changed') {
      expect(['admin', 'member', 'guest', null]).toContain(member.role)
    }
  }, 180_000)
})

// ADR-075 addendum: deleting a message through the verb also redacts the person's edits, each with the edit-redaction
// field; the other account's stream sees exactly one message.removed for it. An encrypted conversation and a public
// channel.
describe.skipIf(!SYNAPSE)('deleteMessage takes the edits along (integration)', () => {
  let me: Acl
  let other: Acl
  let meToken: string
  let otherToken: string
  const meEvents: DomainEvent[] = []
  const otherEvents: DomainEvent[] = []

  beforeAll(async () => {
    const [meUser, otherUser] = await freshUsers(['dlm', 'dlo'])
    meToken = meUser.token
    otherToken = otherUser.token
    me = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    other = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await me.connect(meToken as Parameters<Acl['connect']>[0])
    await other.connect(otherToken as Parameters<Acl['connect']>[0])
    me.subscribe((e) => meEvents.push(e))
    other.subscribe((e) => otherEvents.push(e))
  }, 180_000)

  afterAll(async () => {
    await me?.disconnect()
    await other?.disconnect()
  })

  async function createChannel(kind: 'private' | 'public'): Promise<ChannelId> {
    const name = `tayet-del-edits-${kind}-${process.pid}-${Math.floor(Math.random() * 1e6)}`
    for (let attempt = 0; ; attempt++) {
      try {
        return await me.createChannel({ name, kind })
      } catch (err) {
        const retryAfter = (err as { data?: { retry_after_ms?: number } }).data?.retry_after_ms
        if (retryAfter === undefined || attempt >= 10) throw err
        await new Promise((r) => setTimeout(r, retryAfter + 200))
      }
    }
  }

  const textOf = (e: DomainEvent): string | undefined =>
    (e.t === 'message.received' || e.t === 'message.edited') && e.message.body.kind === 'text' ? e.message.body.text : undefined

  for (const kind of ['private', 'public'] as const) {
    it(`${kind === 'private' ? 'encrypted conversation' : 'public channel'}: the message and both edits are redacted`, async () => {
      const ch = await createChannel(kind)
      const roomId = ch as unknown as string
      await invite(meToken, roomId, await whoami(otherToken))
      await join(otherToken, roomId)
      await until(async () => ((await me.getChannels()).some((c) => c.id === ch) ? true : undefined))
      await until(async () => ((await other.getChannels()).some((c) => c.id === ch) ? true : undefined))

      const id: MessageId = await me.sendMessage(ch, { kind: 'text', text: `del ${kind} v0` })
      await until(() => meEvents.find((e) => e.t === 'message.status' && e.messageId === id && e.status === 'sent'))
      await me.editMessage(id, { kind: 'text', text: `del ${kind} v1` })
      await me.editMessage(id, { kind: 'text', text: `del ${kind} v2` })
      await until(() => otherEvents.find((e) => e.t === 'message.edited' && textOf(e) === `del ${kind} v2`))

      const original = await findOwnEvent(meToken, roomId, id as unknown as string)
      const editIds = (await getRelations(meToken, roomId, original.event_id, 'm.replace')).map((e) => e.event_id)
      expect(editIds).toHaveLength(2)

      const mark = otherEvents.length
      await me.deleteMessage(id)
      // A sentinel after the delete: once the other account has it, every redaction before it has synced too.
      await me.sendMessage(ch, { kind: 'text', text: `del ${kind} sentinel` })
      await until(() => otherEvents.slice(mark).find((e) => textOf(e) === `del ${kind} sentinel`))

      // On the server: the message and both edits are redacted; exactly the two edit redactions carry the field.
      for (const target of [original.event_id, ...editIds]) {
        const ev = (await getEvent(meToken, roomId, target)) as { unsigned?: { redacted_because?: unknown } }
        expect(ev.unsigned?.redacted_because).toBeDefined()
      }
      const redactions = (await getMessages(meToken, roomId, 100)).filter((e) => e.type === 'm.room.redaction') as Array<{
        redacts?: string
        content: Record<string, unknown>
      }>
      const targetOf = (r: { redacts?: string; content: Record<string, unknown> }) => r.redacts ?? (r.content.redacts as string | undefined)
      const withField = redactions.filter((r) => r.content[EDIT_REDACTION_FIELD] === true).map(targetOf)
      expect(withField.sort()).toEqual([...editIds].sort())
      expect(redactions.filter((r) => targetOf(r) === original.event_id && r.content[EDIT_REDACTION_FIELD] === undefined)).toHaveLength(1)

      // In the other account's stream: exactly one message.removed for this conversation after the delete, clean.
      const removedAfter = otherEvents.slice(mark).filter((e) => e.t === 'message.removed' && e.channelId === ch)
      expect(removedAfter).toHaveLength(1)
      expect(findProtocolLeaks(removedAfter)).toEqual([])
      // And none of the message's earlier texts came back.
      expect(otherEvents.slice(mark).some((e) => /^del \S+ v\d$/.test(textOf(e) ?? ''))).toBe(false)
    }, 300_000)
  }
})

describe('ACL stream (availability)', () => {
  it(SYNAPSE ? 'stack reachable' : 'stack down — skipped', () => {
    expect(typeof SYNAPSE).toBe('boolean')
  })
})
