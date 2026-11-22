import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createAcl } from '../../src/acl'
import type { Acl, AclTelemetry, DomainEvent, ChannelId, MessageId, Message } from '../../src/acl'
import { createMemorySearchStore, searchDbName } from '../../src/acl/internal/search-store'
import { HOMESERVER, synapseReachable, createRoom, invite, join, leave, whoami, findOwnEvent, sendText, sendThreadReply, getRelations } from '../support/synapse'
import { freshUsers } from '../support/fresh-users'
import { until } from '../support/until'

// A thread whose root this session sent itself: the root's stable id is the transaction id, so every
// reply — own text, own attachment, someone else's, and the thread page — must carry THAT id as its
// threadParent, or the open thread panel (which matches by the root's id) drops the reply.
// Ids never reach a failure message: the assertions compare, and report only which emission diverged.

const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
const settle = (ms = 2_000): Promise<void> => new Promise((r) => setTimeout(r, ms))

type MessageEvent = Extract<DomainEvent, { t: 'message.received' | 'message.edited' }>

describe.skipIf(!SYNAPSE)('ACL thread rooted at an own message of this session (integration)', () => {
  const nonce = `${process.pid}${Math.floor(Math.random() * 1e6)}`
  let acl: Acl
  let ownerToken: string
  let otherToken: string
  let ownerUserId: string
  let roomId: string
  let channelId: ChannelId
  let rootId: MessageId
  let rootEventId: string
  const events: DomainEvent[] = []

  const emissionsOf = (id: MessageId): MessageEvent[] =>
    events.filter(
      (e): e is MessageEvent => (e.t === 'message.received' || e.t === 'message.edited') && e.message.id === id,
    )
  // Labels (never values) of the emissions whose threadParent is not the root's id.
  const wrongParent = (id: MessageId): string[] =>
    emissionsOf(id)
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.message.threadParent !== rootId)
      .map(({ e, i }) => `${e.t}#${i} status=${e.message.status ?? 'none'}`)

  beforeAll(async () => {
    const [owner, other] = await freshUsers(['tor', 'tot'])
    ownerToken = owner.token
    otherToken = other.token
    ownerUserId = await whoami(ownerToken)
    acl = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await acl.connect(ownerToken as Parameters<Acl['connect']>[0])
    acl.subscribe((e) => events.push(e))

    roomId = await createRoom(ownerToken, { name: `tayet-own-root-${nonce}` })
    channelId = roomId as unknown as ChannelId
    await invite(ownerToken, roomId, await whoami(otherToken))
    await join(otherToken, roomId)
    await until('channel known to the owner before the root send', async () =>
      (await acl.getChannels()).some((c) => c.id === channelId) ? true : undefined,
    )

    // The root goes through the barrel; its id is the one the stream hands the UI.
    const rootText = `own root ${nonce}`
    await acl.sendMessage(channelId, { kind: 'text', text: rootText })
    const rootEv = await until('root message.received', () =>
      events.find(
        (e): e is Extract<DomainEvent, { t: 'message.received' }> =>
          e.t === 'message.received' &&
          e.channelId === channelId &&
          e.message.body.kind === 'text' &&
          e.message.body.text === rootText,
      ),
    )
    rootId = rootEv.message.id
    await until('root settles to sent', () =>
      events.find((e) => e.t === 'message.status' && e.messageId === rootId && e.status === 'sent'),
    )
    rootEventId = (await findOwnEvent(ownerToken, roomId, rootId as unknown as string)).event_id
  }, 180_000)

  afterAll(async () => {
    try {
      await leave(otherToken, roomId)
      await leave(ownerToken, roomId)
    } catch {
      /* best-effort */
    }
    await acl?.disconnect()
  })

  it('(a) own text reply: every emission carries the root id as threadParent', async () => {
    const replyId = await acl.sendMessage(channelId, { kind: 'text', text: `own reply ${nonce}` }, { thread: rootId })
    await until('own text reply settles to sent', () =>
      events.find((e) => e.t === 'message.status' && e.messageId === replyId && e.status === 'sent'),
    )
    await settle()
    expect(emissionsOf(replyId).length).toBeGreaterThan(0)
    expect(wrongParent(replyId)).toEqual([])
  }, 180_000)

  it('(b) own attachment reply: root id as threadParent, local media kept for the session', async () => {
    const file = new File([BYTES as BlobPart], `own-${nonce}.png`, { type: 'image/png' })
    const replyId = await acl.sendMessage(channelId, { kind: 'attachment', file }, { thread: rootId })
    await until('own attachment reply settles to sent', () =>
      events.find((e) => e.t === 'message.status' && e.messageId === replyId && e.status === 'sent'),
    )
    await settle()
    const emitted = emissionsOf(replyId)
    expect(emitted.length).toBeGreaterThan(0)
    expect(wrongParent(replyId)).toEqual([])
    const mediaOf = (m: Message): unknown => (m.body.kind === 'image' || m.body.kind === 'file' ? m.body.media : undefined)
    const localMedia = mediaOf(emitted[0]!.message)
    expect(localMedia).toBeDefined()
    const swapped = emitted
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => mediaOf(e.message) !== localMedia)
      .map(({ e, i }) => `${e.t}#${i} status=${e.message.status ?? 'none'}`)
    expect(swapped).toEqual([])
  }, 180_000)

  it("(c) someone else's reply to the own root carries the root id as threadParent", async () => {
    const text = `other reply ${nonce}`
    await sendThreadReply(otherToken, roomId, rootEventId, text)
    const ev = await until('other reply message.received', () =>
      events.find(
        (e): e is Extract<DomainEvent, { t: 'message.received' }> =>
          e.t === 'message.received' &&
          e.channelId === channelId &&
          e.message.body.kind === 'text' &&
          e.message.body.text === text,
      ),
    )
    await settle()
    expect(wrongParent(ev.message.id)).toEqual([])
  }, 180_000)

  it('(d) the thread page lists every reply with the root id as threadParent', async () => {
    const page = await until('thread page holds the three replies', async () => {
      const p = await acl.getTimeline(channelId, { thread: rootId })
      return p.items.length >= 3 ? p : undefined
    })
    const wrong = page.items.map((m, i) => ({ m, i })).filter(({ m }) => m.threadParent !== rootId).map(({ m, i }) => `item#${i} kind=${m.body.kind}`)
    expect(wrong).toEqual([])
  }, 180_000)

  it('(e) the search index stores the root by its event id, not the session id', async () => {
    const replyEventIds = (await getRelations(ownerToken, roomId, rootEventId))
      .filter((r) => typeof r.content.body === 'string' && (r.content.body as string).endsWith(`reply ${nonce}`))
      .map((r) => r.event_id)
    expect(replyEventIds).toHaveLength(2) // own text reply + the other person's
    const store = createMemorySearchStore(searchDbName(ownerUserId))
    const entries = await until('both text replies indexed', async () => {
      const all = (await store.load()).entries.filter((x) => replyEventIds.includes(x.eventId))
      return all.length === replyEventIds.length ? all : undefined
    })
    const wrong = entries
      .map((x, i) => ({ x, i }))
      .filter(({ x }) => x.threadRoot !== rootEventId || (x.snapshot.threadParent as unknown as string) !== rootEventId)
      .map(({ i }) => `entry#${i}`)
    expect(wrong).toEqual([])
  }, 180_000)

  // The root's summary counts each reply once. The thread is opened first (as the panel does), so the
  // session holds it whole. The browser race (aggregate before the reply's arrival) is not forced here.
  const summaryCount = async (id: MessageId): Promise<{ edited?: number; read?: number }> => {
    const edited = events.filter((e): e is Extract<DomainEvent, { t: 'message.edited' }> => e.t === 'message.edited' && e.message.id === id).at(-1)
    return { edited: edited?.message.threadSummary?.replyCount, read: (await acl.getMessage(channelId, id))?.threadSummary?.replyCount }
  }
  const settlesAt = async (id: MessageId, n: number): Promise<void> => {
    await until(`summary settles at ${n}`, async () => {
      const c = await summaryCount(id)
      return c.edited === n && c.read === n ? true : undefined
    })
    await settle()
    expect(await summaryCount(id)).toEqual({ edited: n, read: n })
  }
  const ownRootOpened = async (label: string): Promise<{ id: MessageId; eventId: string }> => {
    const text = `${label} root ${nonce}`
    await acl.sendMessage(channelId, { kind: 'text', text })
    const ev = await until(`${label} root received`, () =>
      events.find((e): e is Extract<DomainEvent, { t: 'message.received' }> => e.t === 'message.received' && e.message.body.kind === 'text' && e.message.body.text === text),
    )
    await acl.getTimeline(channelId, { thread: ev.message.id })
    await until(`${label} root sent`, () => events.find((e) => e.t === 'message.status' && e.messageId === ev.message.id && e.status === 'sent'))
    return { id: ev.message.id, eventId: (await findOwnEvent(ownerToken, roomId, ev.message.id as unknown as string)).event_id }
  }
  const ownReply = async (root: MessageId, label: string): Promise<void> => {
    const id = await acl.sendMessage(channelId, { kind: 'text', text: `${label} ${nonce}` }, { thread: root })
    await until(`${label} sent`, () => events.find((e) => e.t === 'message.status' && e.messageId === id && e.status === 'sent'))
  }

  it('(f) one own reply to an own root: the summary counts 1', async () => {
    const root = await ownRootOpened('f')
    await ownReply(root.id, 'f reply')
    await settlesAt(root.id, 1)
  }, 180_000)

  it('(g) two own replies in a row: the summary counts 2', async () => {
    const root = await ownRootOpened('g')
    await ownReply(root.id, 'g reply 1')
    await ownReply(root.id, 'g reply 2')
    await settlesAt(root.id, 2)
  }, 180_000)

  it("(h) someone else's reply and an own one: the summary counts 2", async () => {
    const root = await ownRootOpened('h')
    const otherText = `h other ${nonce}`
    await sendThreadReply(otherToken, roomId, root.eventId, otherText)
    await until('h other reply received', () =>
      events.find((e) => e.t === 'message.received' && e.message.body.kind === 'text' && e.message.body.text === otherText),
    )
    await ownReply(root.id, 'h reply')
    await settlesAt(root.id, 2)
  }, 180_000)

  it("(i) one own reply to someone else's root: the summary counts 1", async () => {
    const text = `i root ${nonce}`
    await sendText(otherToken, roomId, text)
    const ev = await until('i root received', () =>
      events.find((e): e is Extract<DomainEvent, { t: 'message.received' }> => e.t === 'message.received' && e.message.body.kind === 'text' && e.message.body.text === text),
    )
    await acl.getTimeline(channelId, { thread: ev.message.id })
    await ownReply(ev.message.id, 'i reply')
    await settlesAt(ev.message.id, 1)
  }, 180_000)
})

describe('ACL thread rooted at an own message (availability)', () => {
  it(SYNAPSE ? 'stack reachable' : 'stack down — skipped', () => {
    expect(typeof SYNAPSE).toBe('boolean')
  })
})
