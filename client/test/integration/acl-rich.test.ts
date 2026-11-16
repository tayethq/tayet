import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createAcl } from '../../src/acl'
import type { Acl, AclTelemetry, DomainEvent, ChannelId, MessageId, RichDoc } from '../../src/acl'
import { HOMESERVER, synapseReachable, createRoom, findOwnEvent } from '../support/synapse'
import { freshUsers } from '../support/fresh-users'
import { findProtocolLeaks } from '@tayet/shared/leak-scan'

// Commit 6 (ADR-012): rich send + rich edit over a live Synapse (LOCAL gate, auto-skips in CI).
// Proves: (a) a rich send puts a plain `body` AND `formatted_body` on the wire (never only
// formatted_body); (b) the inbound stream/timeline carries the structured `rich` with NO protocol
// envelope crossing the barrel; (c) a rich edit flows through the same translateBody path.

const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const bold: RichDoc = [{ t: 'p', children: [{ t: 'strong', children: [{ t: 'text', text: 'bold' }] }] }]
const italic: RichDoc = [{ t: 'p', children: [{ t: 'em', children: [{ t: 'text', text: 'italic' }] }] }]

async function until<T>(get: () => T | undefined, timeoutMs = 150_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = get()
    if (v !== undefined) return v
    if (Date.now() - start > timeoutMs) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 60))
  }
}

describe.skipIf(!SYNAPSE)('ACL rich content (integration)', () => {
  let acl: Acl
  let token: string
  const events: DomainEvent[] = []

  beforeAll(async () => {
    const [user] = await freshUsers(['rch'])
    token = user.token
    acl = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await acl.connect(token as Parameters<Acl['connect']>[0])
    acl.subscribe((e) => events.push(e))
  }, 180_000)

  afterAll(async () => {
    await acl?.disconnect()
  })

  it('sends rich (plain body + formatted_body) and surfaces structured rich inbound', async () => {
    const name = `tayet-rich-${process.pid}-${Math.floor(Math.random() * 1e6)}`
    const roomId = await createRoom(token, { name })
    const id: ChannelId = await until(() => {
      const ev = events.find(
        (e): e is Extract<DomainEvent, { t: 'channel.changed' }> =>
          e.t === 'channel.changed' && e.channel.name === `#${name}`,
      )
      return ev?.channel.id
    })

    const messageId: MessageId = await acl.sendMessage(id, { kind: 'text', text: 'bold', rich: bold })
    const realId = await until(() =>
      events.find((e) => e.t === 'message.status' && e.messageId === messageId && e.status === 'sent') ? messageId : undefined,
    )
    expect(realId).toBe(messageId)

    // Wire shape: plain body present (fallback) AND formatted_body present — never only one.
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
    expect(settled.body.kind).toBe('text')
    if (settled.body.kind === 'text') {
      expect(settled.body.text).toBe('bold')
      expect(settled.body.rich).toEqual(bold)
    }
    // No protocol envelope crossed the barrel (recursive RichDoc scan, §5.1).
    expect(findProtocolLeaks(settled)).toEqual([])

    // The raw wire carries both body and formatted_body (asserted via the server's stored event).
    // ADR-010: an own message's stable MessageId is the TRANSACTION id, never the protocol event
    // id (it does not round-trip — GET /event/{txn} 404s, by design). The support helper locates
    // the stored event via unsigned.transaction_id, outside the barrel.
    const raw = await findOwnEvent(token, roomId, messageId as unknown as string)
    expect(raw.content['body']).toBe('bold')
    expect(raw.content['formatted_body']).toBe('<p><strong>bold</strong></p>')
    expect(raw.content['format']).toBe('org.matrix.custom.html')
  }, 180_000)

  it('rich-edits a message in place (rich flows through translateBody)', async () => {
    const name = `tayet-rich-edit-${process.pid}-${Math.floor(Math.random() * 1e6)}`
    await createRoom(token, { name })
    const id: ChannelId = await until(() => {
      const ev = events.find(
        (e): e is Extract<DomainEvent, { t: 'channel.changed' }> =>
          e.t === 'channel.changed' && e.channel.name === `#${name}`,
      )
      return ev?.channel.id
    })

    const messageId = await acl.sendMessage(id, { kind: 'text', text: 'bold', rich: bold })
    await until(() =>
      events.find((e) => e.t === 'message.status' && e.messageId === messageId && e.status === 'sent'),
    )

    await acl.editMessage(messageId, { kind: 'text', text: 'italic', rich: italic })
    const edited = await until(() =>
      events.find(
        (e) =>
          e.t === 'message.edited' &&
          e.message.id === messageId &&
          e.message.body.kind === 'text' &&
          e.message.body.rich !== undefined,
      ),
    )
    if (edited.t === 'message.edited' && edited.message.body.kind === 'text') {
      expect(edited.message.body.rich).toEqual(italic)
      expect(findProtocolLeaks(edited.message)).toEqual([])
    }
  }, 180_000)
})
