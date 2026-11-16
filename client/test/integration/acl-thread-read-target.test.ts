import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { MatrixGateway } from '../../src/acl/internal/matrix-client'
import type { Acl, AclTelemetry, ChannelId, DomainEvent, Message, MessageId, UserId } from '../../src/acl'
import { HOMESERVER, synapseReachable, whoami, sendText } from '../support/synapse'
import { freshUsers } from '../support/fresh-users'
import { until } from '../support/until'

// PLANO-RELEASE-PUBLICA §8.37: markRead(ch, id) targets the event it was given, never the main
// timeline's tail. Before the fix, an encrypted thread reply delivered to the UI before the SDK's
// Thread timeline held it (the Thread fills on the root's GET /relations) made markRead fall back to
// the main tail with thread_id "main", and the thread never cleared (ADR-067). Both cases below hold
// a response in this test's fetch wrapper (the SDK resolves globalThis.fetch per request).
//  T1: GET /relations held 3 s → the receipt goes to the reply, with thread_id = the root, and the
//      thread clears.
//  T2: an explicit target the room does not know sends no receipt; a target that reaches the room
//      later (the reader's /sync held) gets its receipt then.

const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const RELATIONS_HOLD_MS = 3_000

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

type Receipt = { target: string; body: Record<string, unknown> }

describe.skipIf(!SYNAPSE)('ACL markRead targets the given event (§8.37)', () => {
  let A: MatrixGateway
  let B: MatrixGateway
  let aToken: string
  let bToken: string
  let bId: UserId
  const bEvents: DomainEvent[] = []
  const bReceipts: Receipt[] = []
  const realFetch = globalThis.fetch
  let holdRelations = false
  let releaseBSync: (() => void) | undefined
  let bSyncGate: Promise<void> | undefined

  const authOf = (init?: RequestInit): string | null => new Headers(init?.headers).get('Authorization')

  beforeAll(async () => {
    const [a, b] = await freshUsers(['rta', 'rtb'])
    aToken = a.token
    bToken = b.token
    await whoami(a.token)
    bId = (await whoami(b.token)) as unknown as UserId
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const path = decodeURIComponent(new URL(url).pathname)
      const isB = authOf(init) === `Bearer ${bToken}`
      if (isB && path.includes('/receipt/')) {
        const target = path.split('/receipt/m.read/')[1] ?? ''
        bReceipts.push({ target, body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> })
      }
      const method = init?.method ?? 'GET'
      if (holdRelations && method === 'GET' && path.includes('/relations/'))
        return new Promise((r) => setTimeout(r, RELATIONS_HOLD_MS)).then(() => realFetch(input as RequestInfo, init))
      if (isB && path.endsWith('/sync') && bSyncGate) {
        const gate = bSyncGate
        return realFetch(input as RequestInfo, init).then(async (res) => {
          await gate
          return res
        })
      }
      return realFetch(input as RequestInfo, init)
    }) as typeof fetch
    A = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await A.connect(a.token as Parameters<Acl['connect']>[0])
    B = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await B.connect(b.token as Parameters<Acl['connect']>[0])
    B.subscribe((e) => bEvents.push(e))
  }, 240_000)

  afterAll(async () => {
    holdRelations = false
    releaseBSync?.()
    globalThis.fetch = realFetch
    await A?.disconnect()
    await B?.disconnect()
  })

  async function bKnows(id: ChannelId): Promise<void> {
    await until('B knows the channel', async () => ((await B.getChannels()).some((c) => c.id === id) ? true : undefined))
  }

  function bReceived(text: string): Promise<Message> {
    return until(`B receives "${text}"`, () => {
      for (const e of bEvents)
        if (e.t === 'message.received' && e.message.body.kind === 'text' && e.message.body.text === text) return e.message
      return undefined
    })
  }

  it('T1: with /relations held, the receipt targets the encrypted reply in its thread and the thread clears', async () => {
    const ch = await withRetry(() => A.openDirectMessage(bId))
    await bKnows(ch)
    await withRetry(() => A.sendMessage(ch, { kind: 'text', text: 't1 root' }))
    const root = await bReceived('t1 root')
    await B.markRead(ch)

    holdRelations = true
    try {
      await withRetry(() => A.sendMessage(ch, { kind: 'text', text: 't1 reply' }, { thread: root.id }))
      const reply = await bReceived('t1 reply')
      await until('unread after the reply', () => (B.getThreadUnread(ch, root.id).unread ? true : undefined))
      const before = bReceipts.length
      await B.markRead(ch, reply.id)
      const sent = bReceipts.slice(before)
      expect(sent).toEqual([{ target: reply.id, body: { thread_id: root.id } }])
      await until('cleared after markRead on the reply', () => (B.getThreadUnread(ch, root.id).unread ? undefined : true), {
        timeoutMs: 30_000,
        snapshot: () => JSON.stringify({ threadUnread: B.getThreadUnread(ch, root.id), sent }),
      })
    } finally {
      holdRelations = false
    }
  })

  it('T2: an explicit target the room does not know sends no receipt, and the receipt goes when it arrives', async () => {
    const ch = await withRetry(() => A.createChannel({ name: `rt-pub-${process.pid}-${Date.now()}`, kind: 'public', members: [bId] }))
    await bKnows(ch)
    await withRetry(() => A.sendMessage(ch, { kind: 'text', text: 't2 first' }))
    await bReceived('t2 first')

    // Unknown everywhere: no receipt at all (no fallback to the main timeline's tail).
    const before = bReceipts.length
    await B.markRead(ch, '$t2-never-sent' as unknown as MessageId)
    await new Promise((r) => setTimeout(r, 2_000))
    expect(bReceipts.slice(before)).toEqual([])

    // Known to the caller before the reader's /sync delivers it: deferred, then sent on arrival.
    bSyncGate = new Promise<void>((r) => (releaseBSync = r))
    try {
      const lateId = await sendText(aToken, ch as unknown as string, 't2 late')
      await B.markRead(ch, lateId as unknown as MessageId)
      expect(bReceipts.slice(before)).toEqual([])
    } finally {
      releaseBSync?.()
      bSyncGate = undefined
    }
    const late = await bReceived('t2 late')
    await until('receipt sent on arrival', () => (bReceipts.slice(before).some((r) => r.target === late.id) ? true : undefined), {
      timeoutMs: 30_000,
      snapshot: () => JSON.stringify(bReceipts.slice(before)),
    })
    expect(bReceipts.slice(before).map((r) => r.target)).toEqual([late.id])
  })
})
