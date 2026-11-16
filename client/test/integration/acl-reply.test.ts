import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createAcl } from '../../src/acl'
import type { Acl, AclTelemetry, DomainEvent, ChannelId, MessageId } from '../../src/acl'
import { findProtocolLeaks } from '@tayet/shared/leak-scan'
import {
  HOMESERVER,
  synapseReachable,
  whoami,
  createRoom,
  invite,
  join,
  sendText,
  sendLegacyReply,
  getMessages,
} from '../support/synapse'
import { freshUsers } from '../support/fresh-users'

// P1 gate for the reply slice (PLANO-FASE-1-REPLY, gate local — case (a)): send a reply through the
// barrel and assert (1) the SENDER's optimistic echo is born with replyTo (no new path — the
// pending event carries the sent relation), (2) the RECIPIENT's stream surfaces message.received
// with replyTo populated and no protocol leak, and (3) the wire event the server stored carries
// EXACTLY the clean m.in_reply_to envelope — the sibling of the only-thread read-back assert in
// acl-threads.test.ts (m.in_reply_to is not a rel_type, so we scan /messages instead of
// /relations). Auto-skips without the dev stack (issue #7 tracks moving this to CI).

const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }

async function until<T>(get: () => T | undefined, timeoutMs = 150_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = get()
    if (v !== undefined) return v
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 50))
  }
}

async function asyncUntil<T>(get: () => Promise<T | undefined>, timeoutMs = 150_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await get()
    if (v !== undefined) return v
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 120))
  }
}

describe.skipIf(!SYNAPSE)('ACL reply send + inbound (integration)', () => {
  let aclAlice: Acl
  let aclBob: Acl
  let aliceToken: string
  let bobToken: string
  let bobId: string
  const aliceEvents: DomainEvent[] = []
  const bobEvents: DomainEvent[] = []

  beforeAll(async () => {
    const [alice, bob] = await freshUsers(['rpa', 'rpb'])
    aliceToken = alice.token
    bobToken = bob.token
    bobId = await whoami(bobToken)
    aclAlice = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    aclBob = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await aclAlice.connect(aliceToken as Parameters<Acl['connect']>[0])
    await aclBob.connect(bobToken as Parameters<Acl['connect']>[0])
    aclAlice.subscribe((e) => aliceEvents.push(e))
    aclBob.subscribe((e) => bobEvents.push(e))
  }, 180_000)

  afterAll(async () => {
    await aclAlice?.disconnect()
    await aclBob?.disconnect()
  })

  it('reply through the barrel: echo born with replyTo, recipient gets replyTo, wire is clean', async () => {
    const name = `tayet-reply-${process.pid}-${Math.floor(Math.random() * 1e6)}`
    const roomId = await createRoom(aliceToken, { name })
    await invite(aliceToken, roomId, bobId)
    await join(bobToken, roomId)

    // Both sides must know the channel (scoped to THIS run's room — per-run fresh users start
    // in zero prior rooms, so the scope is exact by construction).
    const channelId = await until<ChannelId>(() => {
      const ev = aliceEvents.find(
        (e): e is Extract<DomainEvent, { t: 'channel.changed' }> =>
          e.t === 'channel.changed' && e.channel.name === `#${name}`,
      )
      return ev?.channel.id
    })
    // Bob's side: a room that became joinable after an invite does not re-emit channel.changed,
    // so poll the getter (same approach as acl-unread).
    await asyncUntil(async () =>
      (await aclBob.getChannels()).some((c) => c.id === channelId) ? true : undefined,
    )

    // The reply target, sent over REST (a "received" message from the ACL clients' viewpoint:
    // its stable id IS the event id).
    const targetEventId = await sendText(aliceToken, roomId, 'reply target')
    const targetMessageId = targetEventId as unknown as MessageId
    await until(() =>
      aliceEvents.find(
        (e) =>
          e.t === 'message.received' &&
          e.channelId === channelId &&
          e.message.body.kind === 'text' &&
          e.message.body.text === 'reply target',
      ),
    )

    // Send the reply THROUGH THE BARREL: only the stable MessageId crosses; the ACL builds the
    // envelope by hand (PLANO-FASE-1-REPLY §0.4).
    await aclAlice.sendMessage(
      channelId,
      { kind: 'text', text: 'a genuine reply' },
      { replyTo: targetMessageId },
    )

    // (1) Sender side: the optimistic echo was BORN with replyTo (ADR-010 — same stable id,
    // pending → sent, no re-key).
    const echo = aliceEvents.find(
      (e) =>
        e.t === 'message.received' &&
        e.channelId === channelId &&
        e.message.body.kind === 'text' &&
        e.message.body.text === 'a genuine reply' &&
        e.message.status === 'pending',
    )
    expect(echo, 'optimistic reply echo (pending) not seen on the sender stream').toBeTruthy()
    if (echo?.t === 'message.received') {
      expect(echo.message.replyTo).toBe(targetMessageId)
      expect(echo.message.threadParent).toBeUndefined()
      expect(findProtocolLeaks(echo.message)).toEqual([])
    }

    // (2) Recipient side: message.received with replyTo populated (case (a) of the local gate).
    const received = await until(() =>
      bobEvents.find(
        (e) =>
          e.t === 'message.received' &&
          e.channelId === channelId &&
          e.message.body.kind === 'text' &&
          e.message.body.text === 'a genuine reply',
      ),
    )
    if (received.t === 'message.received') {
      expect(received.message.replyTo).toBe(targetMessageId)
      expect(received.message.threadParent).toBeUndefined()
      expect(findProtocolLeaks(received.message)).toEqual([])
    }

    // (3) Wire read-back (sibling of the only-thread envelope assert): the server-stored event
    // carries EXACTLY { m.in_reply_to: { event_id } } — no rel_type, no is_falling_back, and no
    // legacy fallback in either representation (PLANO-FASE-1-REPLY §5.3).
    const stored = (await getMessages(aliceToken, roomId)).find(
      (e) => (e.content as { body?: string }).body === 'a genuine reply',
    )
    expect(stored, 'sent reply not found in /messages').toBeTruthy()
    expect(stored!.content['m.relates_to']).toEqual({ 'm.in_reply_to': { event_id: targetEventId } })
    const wire = JSON.stringify(stored!.content)
    expect(wire).not.toContain('rel_type')
    expect(wire).not.toContain('is_falling_back')
    expect(wire).not.toContain('mx-reply')
    expect(/^> /m.test(String(stored!.content['body']))).toBe(false)
  }, 180_000)

  it('a LEGACY-client reply (full fallback) reaches the domain clean (case (b))', async () => {
    const name = `tayet-reply-legacy-${process.pid}-${Math.floor(Math.random() * 1e6)}`
    const roomId = await createRoom(aliceToken, { name })
    await invite(aliceToken, roomId, bobId)
    await join(bobToken, roomId)

    const channelId = await until<ChannelId>(() => {
      const ev = aliceEvents.find(
        (e): e is Extract<DomainEvent, { t: 'channel.changed' }> =>
          e.t === 'channel.changed' && e.channel.name === `#${name}`,
      )
      return ev?.channel.id
    })

    const targetEventId = await sendText(aliceToken, roomId, 'legacy reply target')
    // Bob replies the way Element does: m.in_reply_to + <mx-reply> in formatted_body + '> ' lines
    // in body (PLANO-FASE-1-REPLY §2.3).
    await sendLegacyReply(bobToken, roomId, targetEventId, {
      quotedText: 'legacy reply target',
      quotedSender: bobId,
      text: 'legacy styled answer',
    })

    const received = await until(() =>
      aliceEvents.find(
        (e) =>
          e.t === 'message.received' &&
          e.channelId === channelId &&
          e.message.body.kind === 'text' &&
          e.message.body.text.includes('legacy styled answer'),
      ),
    )
    if (received.t === 'message.received') {
      expect(received.message.replyTo).toBe(targetEventId)
      // The plain fallback was stripped — no duplicated quote, no '> ' prefix, no quoted sender.
      if (received.message.body.kind === 'text') {
        expect(received.message.body.text).toBe('legacy styled answer')
        // The rich side dropped the <mx-reply> subtree wholesale.
        expect(JSON.stringify(received.message.body.rich ?? [])).not.toContain('legacy reply target')
      }
      expect(findProtocolLeaks(received.message)).toEqual([])
    }
  }, 180_000)
})

describe('ACL reply (availability)', () => {
  it(SYNAPSE ? 'stack reachable' : 'stack down — skipped', () => {
    expect(typeof SYNAPSE).toBe('boolean')
  })
})
