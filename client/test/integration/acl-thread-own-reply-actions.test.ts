import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createAcl } from '../../src/acl'
import type { Acl, AclTelemetry, DomainEvent, ChannelId, MessageId } from '../../src/acl'
import { HOMESERVER, synapseReachable, createRoom, invite, join, leave, whoami, findOwnEvent, reactTo } from '../support/synapse'
import { freshUsers } from '../support/fresh-users'
import { until } from '../support/until'

// Actions on one's own thread reply sent in this session (#421, PLANO-MOBILE §8.15): the reply's stable id is
// the transaction id and its echo lives in the thread's timeline, not the room's. Same session, same client,
// no reload: each action goes by the id the send returned. Each case uses its own reply, so one red case
// never makes another pass. Ids never reach a failure message.

const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }
// After the action: the local server answers in seconds; a red case fails well inside the test's timeout.
const AFTER = { timeoutMs: 60_000 }

type ReactionChanged = Extract<DomainEvent, { t: 'reaction.changed' }>

describe.skipIf(!SYNAPSE)("ACL actions on one's own thread reply sent this session (integration)", () => {
  const nonce = `${process.pid}${Math.floor(Math.random() * 1e6)}`
  let acl: Acl
  let ownerToken: string
  let otherToken: string
  let roomId: string
  let channelId: ChannelId
  let rootId: MessageId
  const events: DomainEvent[] = []

  const lastReaction = (id: MessageId): ReactionChanged | undefined =>
    [...events].reverse().find((e): e is ReactionChanged => e.t === 'reaction.changed' && e.messageId === id)

  // A reply in the thread, through the barrel, waited until the server accepted it.
  const ownReply = async (label: string): Promise<MessageId> => {
    const id = await acl.sendMessage(channelId, { kind: 'text', text: `${label} ${nonce}` }, { thread: rootId })
    await until(`${label} sent`, () => events.find((e) => e.t === 'message.status' && e.messageId === id && e.status === 'sent'))
    return id
  }

  beforeAll(async () => {
    const [owner, other] = await freshUsers(['tra', 'trb'])
    ownerToken = owner.token
    otherToken = other.token
    acl = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    await acl.connect(ownerToken as Parameters<Acl['connect']>[0])
    acl.subscribe((e) => events.push(e))

    roomId = await createRoom(ownerToken, { name: `tayet-own-reply-${nonce}` })
    channelId = roomId as unknown as ChannelId
    await invite(ownerToken, roomId, await whoami(otherToken))
    await join(otherToken, roomId)
    await until('channel known before the root send', async () =>
      (await acl.getChannels()).some((c) => c.id === channelId) ? true : undefined,
    )

    rootId = await acl.sendMessage(channelId, { kind: 'text', text: `root ${nonce}` })
    await until('root sent', () => events.find((e) => e.t === 'message.status' && e.messageId === rootId && e.status === 'sent'))
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

  it('(a) react: the reaction is aggregated on the reply', async () => {
    const replyId = await ownReply('react')
    await acl.react(replyId, '👍')
    const r = await until('own 👍 aggregated', () => {
      const last = lastReaction(replyId)
      return last?.reactions.some((x) => x.emoji === '👍' && x.count === 1 && x.mine) ? last : undefined
    }, AFTER)
    expect(r.reactions.map((x) => x.emoji)).toEqual(['👍'])
  }, 180_000)

  it('(b) removeReaction: the aggregation goes empty', async () => {
    const replyId = await ownReply('unreact')
    // The own reaction is placed outside react(), by the real event id, so this case stands on its own.
    const realId = (await findOwnEvent(ownerToken, roomId, replyId as unknown as string)).event_id
    await reactTo(ownerToken, roomId, realId, '🎉')
    await until('own 🎉 seen by the session', () => {
      const last = lastReaction(replyId)
      return last?.reactions.some((x) => x.emoji === '🎉' && x.mine) ? true : undefined
    })
    await acl.removeReaction(replyId, '🎉')
    const r = await until('aggregation empty', () => {
      const last = lastReaction(replyId)
      return last && last.reactions.length === 0 ? last : undefined
    }, AFTER)
    expect(r.reactions).toEqual([])
  }, 180_000)

  it('(c) editMessage: the reply carries the new text', async () => {
    const replyId = await ownReply('edit')
    const text = `edited ${nonce}`
    await acl.editMessage(replyId, { kind: 'text', text })
    // The emission the open thread applies: the new text under the root's id. An edit made before the
    // reply's remote echo arrives has an optimistic emission without threadParent (the original is not in
    // any timeline yet), which no list applies; the synced edit carries it.
    const edited = await until('message.edited with the new text in the thread', () =>
      events.find(
        (e): e is Extract<DomainEvent, { t: 'message.edited' }> =>
          e.t === 'message.edited' &&
          e.message.id === replyId &&
          e.message.threadParent === rootId &&
          e.message.body.kind === 'text' &&
          e.message.body.text === text,
      ),
      AFTER,
    )
    expect(edited.message.mine).toBe(true)
  }, 180_000)

  it('(d) deleteMessage: message.removed for the reply', async () => {
    const replyId = await ownReply('delete')
    await acl.deleteMessage(replyId)
    const removed = await until('message.removed', () =>
      events.find((e) => e.t === 'message.removed' && e.messageId === replyId),
      AFTER,
    )
    expect(removed.t).toBe('message.removed')
  }, 180_000)
})

describe("ACL actions on one's own thread reply (availability)", () => {
  it(SYNAPSE ? 'stack reachable' : 'stack down — skipped', () => {
    expect(typeof SYNAPSE).toBe('boolean')
  })
})
