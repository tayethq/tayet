import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createAcl } from '../../src/acl'
import type { Acl, AclTelemetry, DomainEvent, ChannelId, MessageId } from '../../src/acl'
import { HOMESERVER, synapseReachable, createRoom, editText, getEvent, invite, join, sendText, whoami } from '../support/synapse'
import { freshUsers } from '../support/fresh-users'

// Commit 3 (editMessage, text): the outbound edit verb. acl.editMessage drives an m.replace whose
// inbound branch (already present) surfaces as message.edited under the SAME stable id (ADR-010) —
// no re-key. The verb REUSES locate() (the react machine), so edit-of-pending needs no new path.

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

describe.skipIf(!SYNAPSE)('ACL editMessage text (integration)', () => {
  let acl: Acl
  let token: string
  const events: DomainEvent[] = []

  beforeAll(async () => {
    const [user] = await freshUsers(['edt'])
    token = user.token
    acl = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await acl.connect(token as Parameters<Acl['connect']>[0])
    acl.subscribe((e) => events.push(e))
  }, 180_000)

  afterAll(async () => {
    await acl?.disconnect()
  })

  it('edits a sent message in place under the SAME stable id', async () => {
    const name = `tayet-edit-${process.pid}-${Math.floor(Math.random() * 1e6)}`
    await createRoom(token, { name })
    const id: ChannelId = await until(() => {
      const ev = events.find(
        (e): e is Extract<DomainEvent, { t: 'channel.changed' }> =>
          e.t === 'channel.changed' && e.channel.name === `#${name}`,
      )
      return ev?.channel.id
    })

    const messageId: MessageId = await acl.sendMessage(id, { kind: 'text', text: 'before' })
    await until(() =>
      events.find((e) => e.t === 'message.status' && e.messageId === messageId && e.status === 'sent'),
    )

    await acl.editMessage(messageId, { kind: 'text', text: 'after' })

    const edited = await until(() =>
      events.find(
        (e) =>
          e.t === 'message.edited' &&
          e.message.id === messageId &&
          e.message.body.kind === 'text' &&
          e.message.body.text === 'after',
      ),
    )
    expect(edited.t).toBe('message.edited')
    if (edited.t === 'message.edited') expect(edited.message.editedAt).toBeDefined()
  }, 180_000)
})

// PLANO-AGENTES §8.30: only the author edits. A second member sends, by the protocol, an m.replace of
// the first member's message; the server accepts it (the protocol lets any member send one), and the
// first member's ACL drops it — no message.edited, the page keeps the original — while the author's
// own edit still applies. Both sides proved: the forged edit exists on the server, and it never shows.
describe.skipIf(!SYNAPSE)('ACL edit — only the author edits (integration)', () => {
  let acl: Acl
  let owner: { token: string }
  let forger: { token: string }
  const events: DomainEvent[] = []

  beforeAll(async () => {
    const [own, frg] = await freshUsers(['eao', 'eaf'])
    owner = own
    forger = frg
    acl = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await acl.connect(own.token as Parameters<Acl['connect']>[0])
    acl.subscribe((e) => events.push(e))
  }, 180_000)

  afterAll(async () => {
    await acl?.disconnect()
  })

  it("another member's edit never rewrites the author's message; the author's own edit does", async () => {
    const name = `tayet-edit-author-${process.pid}-${Math.floor(Math.random() * 1e6)}`
    const roomId = await createRoom(owner.token, { name })
    await invite(owner.token, roomId, await whoami(forger.token))
    await join(forger.token, roomId)
    const id: ChannelId = await until(() => {
      const ev = events.find(
        (e): e is Extract<DomainEvent, { t: 'channel.changed' }> =>
          e.t === 'channel.changed' && e.channel.name === `#${name}`,
      )
      return ev?.channel.id
    })

    const targetId = await sendText(owner.token, roomId, 'original')
    await until(() => events.find((e) => e.t === 'message.received' && e.message.id === (targetId as unknown as MessageId)))
    const editsOfTarget = () =>
      events.filter((e) => e.t === 'message.edited' && e.message.id === (targetId as unknown as MessageId))

    // The forged edit: accepted by the server (the other side of the proof).
    const forgedId = await editText(forger.token, roomId, targetId, 'forged')
    const forged = await getEvent(owner.token, roomId, forgedId)
    expect(forged.content['m.relates_to']).toEqual({ rel_type: 'm.replace', event_id: targetId })

    // A later message of the same sync stream as a barrier: once it is here, the forged edit was seen.
    const barrierId = await sendText(owner.token, roomId, 'barrier')
    await until(() => events.find((e) => e.t === 'message.received' && e.message.id === (barrierId as unknown as MessageId)))
    expect(editsOfTarget()).toEqual([])
    const page = await acl.getTimeline(id)
    const shown = page.items.find((m) => m.id === (targetId as unknown as MessageId))
    expect(shown?.body).toEqual({ kind: 'text', text: 'original' })
    expect(shown?.editedAt).toBeUndefined()

    // The author's own edit still applies.
    await editText(owner.token, roomId, targetId, 'fixed by the author')
    const legit = await until(() =>
      editsOfTarget().find((e) => e.t === 'message.edited' && e.message.body.kind === 'text' && e.message.body.text === 'fixed by the author'),
    )
    expect(editsOfTarget()).toHaveLength(1)
    if (legit.t === 'message.edited') expect(legit.message.author).toBe(await whoami(owner.token))
  }, 180_000)
})

describe('ACL edit (availability)', () => {
  it(SYNAPSE ? 'stack reachable' : 'stack down — skipped', () => {
    expect(typeof SYNAPSE).toBe('boolean')
  })
})
