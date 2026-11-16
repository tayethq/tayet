import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createAcl } from '../../src/acl'
import type { Acl, AclTelemetry, DomainEvent, ChannelId, MessageId } from '../../src/acl'
import { findProtocolLeaks } from '@tayet/shared/leak-scan'
import { HOMESERVER, synapseReachable, createRoom } from '../support/synapse'
import { freshUsers } from '../support/fresh-users'
import { until } from '../support/until'

// PLANO-FASE-1-UPLOAD §3/§5.1 (commit 5, the novel variable): the optimistic ATTACHMENT echo. The
// instant 'pending' message.received carries a LOCAL MediaRef (opaque, never an mxc) under a stable
// id; the same id then settles to 'sent' via message.status; and getTimeline returns it under that
// SAME id (no re-key). The pending event must not leak any protocol shape across the barrel.

const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 5, 6, 7, 8])

describe.skipIf(!SYNAPSE)('ACL optimistic attachment echo (integration)', () => {
  let acl: Acl
  let token: string
  const events: DomainEvent[] = []

  beforeAll(async () => {
    const [user] = await freshUsers(['ate'])
    token = user.token
    acl = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await acl.connect(token as Parameters<Acl['connect']>[0])
    acl.subscribe((e) => events.push(e))
  }, 180_000)

  afterAll(async () => {
    await acl?.disconnect()
  })

  it('echoes pending with a LOCAL ref, settles to sent under ONE stable id, no leak', async () => {
    const name = `tayet-att-echo-${process.pid}-${Math.floor(Math.random() * 1e6)}`
    const roomId = await createRoom(token, { name })
    const channelId = roomId as unknown as ChannelId
    // PLANO-GATES §8.12: without a known Room the SDK keeps no local echo, so 'sent' never fires.
    // Wait until the sender's ACL knows the channel before the first send.
    await until(
      'channel known to sender before attachment echo send',
      async () => ((await acl.getChannels()).some((c) => c.id === channelId) ? true : undefined),
      {
        snapshot: async () => {
          const chs = await acl.getChannels()
          return `known=${chs.length} hasChannelId=${chs.some((c) => c.id === channelId)}`
        },
      },
    )

    const file = new File([BYTES as BlobPart], 'pixel.png', { type: 'image/png' })
    const messageId: MessageId = await acl.sendMessage(channelId, { kind: 'attachment', file })

    // The optimistic pending echo carries the SAME id and an IMAGE body with an opaque local ref.
    const pending = until(
      'pending echo with image body for messageId',
      () =>
        events.find(
          (e) =>
            e.t === 'message.received' &&
            e.message.id === messageId &&
            e.message.status === 'pending' &&
            e.message.body.kind === 'image',
        ),
      { pollMs: 80 },
    )
    const pendingEv = await pending
    expect(pendingEv.t).toBe('message.received')
    // The pending event — the new P1 surface — must cross the barrel free of protocol shapes
    // (the local MediaRef is an opaque token, NOT an mxc).
    expect(findProtocolLeaks(pendingEv)).toEqual([])

    // resolveMedia of the LOCAL ref must NOT need the network and must not leak the mxc.
    if (pendingEv.t === 'message.received' && pendingEv.message.body.kind === 'image') {
      const localRef = pendingEv.message.body.media
      let createdLocally = false
      const realCreate = (globalThis.URL as unknown as { createObjectURL?: unknown }).createObjectURL
      ;(globalThis.URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => {
        createdLocally = true
        return 'blob:tayet-local'
      }
      try {
        const resolved = await acl.resolveMedia(localRef)
        expect(resolved.url).toBe('blob:tayet-local')
        expect(createdLocally).toBe(true)
        resolved.release()
      } finally {
        ;(globalThis.URL as unknown as Record<string, unknown>).createObjectURL = realCreate
      }
    }

    // …then a 'sent' status for that same id (the upload + send settled).
    const sent = await until(
      'sent status for messageId',
      () =>
        events.find(
          (e) => e.t === 'message.status' && e.messageId === messageId && e.status === 'sent',
        ),
      {
        pollMs: 100,
        // Settle-class instrumentation (PLANO-GATES §8.2): which statuses DID arrive for this id.
        snapshot: () => {
          const statuses = events
            .filter((e) => e.t === 'message.status' && e.messageId === messageId)
            .map((e) => (e.t === 'message.status' ? e.status : ''))
          return `statuses seen for messageId=[${statuses.join(',')}]`
        },
      },
    )
    expect(sent.t).toBe('message.status')

    // …and getTimeline returns the message under the SAME stable id (no re-key on settle).
    const settled = await until(
      'settled message under same id in timeline',
      async () => {
        const page = await acl.getTimeline(channelId)
        return page.items.find((x) => x.id === messageId)
      },
      {
        // Settle-class instrumentation (PLANO-GATES §8.2): partial timeline state on overflow.
        snapshot: async () => {
          const page = await acl.getTimeline(channelId)
          return `items=${page.items.length} kinds=[${page.items.map((x) => x.body.kind).join(',')}] hasMessageId=${page.items.some((x) => x.id === messageId)}`
        },
      },
    )
    expect(settled.id).toBe(messageId)
    expect(settled.body.kind).toBe('image')
    expect(findProtocolLeaks(settled)).toEqual([])
    // PUT won the race here: the later remote echo (status null, oldStatus SENT) must NOT repeat it.
    expect(events.filter((e) => e.t === 'message.status' && e.messageId === messageId)).toHaveLength(1)
  }, 180_000)

  // PLANO-RELEASE-PUBLICA §8.21 (dogfood 2.1): the remote echo arrives via /sync BEFORE the PUT
  // /send resolves. The SDK reconciles it (handleRemoteEcho → status null) and the later PUT
  // resolution is a no-op — SENT never fires. The bubble must still settle to 'sent', once.
  it('settles to sent once when the remote echo beats the PUT /send (sync-first race)', async () => {
    const name = `tayet-att-race-${process.pid}-${Math.floor(Math.random() * 1e6)}`
    const roomId = await createRoom(token, { name })
    const channelId = roomId as unknown as ChannelId
    await until(
      'channel known to sender before race send',
      async () => ((await acl.getChannels()).some((c) => c.id === channelId) ? true : undefined),
    )

    // Hold the PUT /send response client-side (the server already has the event) until a /sync
    // response carrying that event id was returned AND processed (= the next /sync started).
    const realFetch = globalThis.fetch
    let sentEventId: string | undefined
    let echoSynced = false
    let echoProcessed = false
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.includes('/sync')) {
        if (echoSynced) echoProcessed = true
        const res = await realFetch(input, init)
        if (sentEventId && !echoSynced && (await res.clone().text()).includes(sentEventId)) echoSynced = true
        return res
      }
      if (init?.method === 'PUT' && url.includes('/send/m.room.message/')) {
        const res = await realFetch(input, init)
        sentEventId = ((await res.clone().json()) as { event_id: string }).event_id
        await until('remote echo processed by sync before PUT resolves', () => (echoProcessed ? true : undefined), {
          pollMs: 20,
        })
        return res
      }
      return realFetch(input, init)
    }) as typeof fetch

    let messageId: MessageId
    try {
      const file = new File([BYTES as BlobPart], 'race.png', { type: 'image/png' })
      messageId = await acl.sendMessage(channelId, { kind: 'attachment', file })
    } finally {
      globalThis.fetch = realFetch
    }
    expect(echoProcessed).toBe(true) // the race really happened in the sync-first order

    await until(
      'sent status for the raced messageId',
      () => events.find((e) => e.t === 'message.status' && e.messageId === messageId && e.status === 'sent'),
      { pollMs: 100 },
    )
    // Give any straggler emission a beat, then assert exactly-once semantics.
    await new Promise((r) => setTimeout(r, 500))
    const statuses = events.filter((e) => e.t === 'message.status' && e.messageId === messageId)
    expect(statuses).toEqual([{ t: 'message.status', channelId, messageId, status: 'sent' }])
    const received = events.filter((e) => e.t === 'message.received' && e.message.id === messageId)
    expect(received).toHaveLength(1) // only the optimistic pending echo; the remote echo is suppressed
  }, 180_000)
})

describe('ACL attachment echo (availability)', () => {
  it(SYNAPSE ? 'stack reachable' : 'stack down — skipped', () => {
    expect(typeof SYNAPSE).toBe('boolean')
  })
})
