// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createAcl } from '../../src/acl'
import type { Acl, ChannelId, DomainEvent, Message, UserId } from '../../src/acl'
import { HOMESERVER, synapseReachable, whoami } from '../support/synapse'
import { freshUsers } from '../support/fresh-users'
import { until } from '../support/until'

// Stack gate of PR 5a of the push track (ADR-117 dec. 5): resolveNotificationTarget against the dev-stack.
// 1. A conversation the session is in resolves to it; with a thread reply's message and thread, the reply comes too.
// 2. The id of a room the session is not in (another person's private channel) resolves to nothing.
// The ids come from the session that is in the room, as a notification would carry them.
// Fresh users per run (#32); skips without the stack (issue #7).

const UP = synapseReachable()
const sessions: Acl[] = []

function session(): Acl {
  const acl = createAcl({ mode: 'strict', telemetry: { untranslated: () => {} }, serverUrl: HOMESERVER })
  sessions.push(acl)
  return acl
}
const connect = (acl: Acl, token: string) => acl.connect(token as Parameters<Acl['connect']>[0])
const channelOf = (acl: Acl, id: ChannelId) => async () => (await acl.getChannels()).find((c) => c.id === id)

describe.skipIf(!UP)('resolveNotificationTarget: ACL ↔ real stack (ADR-117 dec. 5)', () => {
  afterEach(async () => {
    for (const acl of sessions.splice(0)) await acl.disconnect().catch(() => {})
  })

  it('a conversation of the session resolves, with the thread reply; another person\'s room does not', async () => {
    const [a, b] = await freshUsers(['nta', 'ntb'])
    const mxidB = await whoami(b.token)
    const alice = session()
    const bob = session()
    await connect(alice, a.token)
    await connect(bob, b.token)
    const received: Message[] = []
    bob.subscribe((e: DomainEvent) => {
      if (e.t === 'message.received' && !e.message.mine) received.push(e.message)
    })
    const dm = await alice.openDirectMessage(mxidB as UserId)
    await until('B is in the DM', channelOf(bob, dm))
    const solo = await alice.createChannel({ name: 'Not for bob', kind: 'private' })

    expect(await bob.resolveNotificationTarget({ conversation: String(dm) })).toEqual({ channel: dm })

    const root = await alice.sendMessage(dm, { kind: 'text', text: 'root' })
    await alice.sendMessage(dm, { kind: 'text', text: 'reply' }, { thread: root })
    const reply = await until('B received the reply', async () => received.find((m) => m.threadParent !== undefined))
    const hit = await bob.resolveNotificationTarget({ conversation: String(dm), message: String(reply.id), thread: String(reply.threadParent) })
    expect(hit?.channel).toBe(dm)
    expect(hit?.message?.id).toBe(reply.id)
    expect(hit?.message?.threadParent).toBe(reply.threadParent)
    expect(hit?.message?.body).toEqual({ kind: 'text', text: 'reply' })

    expect(await bob.resolveNotificationTarget({ conversation: String(solo) })).toBeUndefined()
    expect(await bob.resolveNotificationTarget({ conversation: String(solo), message: String(root), thread: String(root) })).toBeUndefined()
    expect(await alice.resolveNotificationTarget({ conversation: String(solo) })).toEqual({ channel: solo })
  }, 180_000)
})
