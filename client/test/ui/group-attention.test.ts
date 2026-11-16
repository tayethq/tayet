// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { titleFor } from '../../src/ui/document-title'
import {
  createNotifier,
  shouldNotify,
  UTD_WAIT_MS,
  type NotificationHandle,
  type NotifierEnv,
} from '../../src/ui/notifier'
import type { Channel, ChannelId, DomainEvent, Message, MessageId, User, UserId } from '../../src/acl'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { copy, fill } from '../support/copy'

// ADR-094 dec. 10 (and ADR-073 dec. 1, 2, 5 and 7, which it extends): a group conversation notifies every
// message and counts every unread, like a DM. Its notification title is the author and "em conversa em
// grupo" (the group's name holds the author), with the agent's variant; with no known author, the
// group's name, as for a channel. An undecryptable message that expires in a group notifies generically.

const cid = (s: string): ChannelId => s as unknown as ChannelId
const uid = (s: string): UserId => s as unknown as UserId
const mid = (s: string): MessageId => s as unknown as MessageId

const ANA = uid('@ana:tayet.local')
const ROBO = uid('@agent-robo:tayet.local')
const GROUP = cid('!grupo:tayet.local')
const CHAN = cid('!chan:tayet.local')

const group: Channel = {
  id: GROUP,
  kind: 'group',
  name: 'Ana Lima, Robô',
  memberCount: 3,
  unread: { count: 0, mentions: 0 },
  participants: [ANA, ROBO],
  participantAgents: 1,
}
const channel: Channel = { id: CHAN, kind: 'public', name: '#all', memberCount: 9, unread: { count: 0, mentions: 0 } }
const CHANNELS: Record<string, Channel> = { [GROUP]: group, [CHAN]: channel }

let seq = 0
const msg = (channelId: ChannelId, over: Partial<Message> = {}): Message => ({
  id: mid(`$g${++seq}`),
  channelId,
  author: ANA,
  body: { kind: 'text', text: 'oi' },
  sentAt: 0 as unknown as Message['sentAt'],
  reactions: [],
  mine: false,
  mentionsMe: false,
  ...over,
})
const received = (m: Message): DomainEvent => ({ t: 'message.received', channelId: m.channelId, message: m })
const edited = (m: Message): DomainEvent => ({ t: 'message.edited', channelId: m.channelId, message: m })

function harness(members: User[] = [
  { id: ANA, displayName: 'Ana Lima', kind: 'member' },
  { id: ROBO, displayName: 'Robô', kind: 'agent', agentColor: 'areia' },
]) {
  let timers: Array<{ fn: () => void; id: number }> = []
  let next = 1
  const shown: Array<{ title: string; body: string; tag: string }> = []
  const env: NotifierEnv = {
    permission: () => 'granted',
    notify: (title, { body, tag }) => {
      shown.push({ title, body, tag })
      return { onclick: null, close: () => {} } as NotificationHandle
    },
    isVisible: () => false,
    hasFocus: () => false,
    focusWindow: () => {},
    now: () => 0,
    setTimeout: (fn) => {
      const id = next++
      timers.push({ fn, id })
      return id
    },
    clearTimeout: (id) => {
      timers = timers.filter((t) => t.id !== id)
    },
  }
  const notifier = createNotifier(
    {
      getChannel: (id) => CHANNELS[id],
      getSelectedId: () => undefined,
      select: () => {},
      getMembers: async () => members,
    },
    env,
  )
  const fire = () => {
    const due = timers
    timers = []
    for (const t of due) t.fn()
  }
  const flush = () => new Promise((r) => setTimeout(r, 0))
  return { notifier, shown, fire, flush }
}

describe('tab title (ADR-073 dec. 7, ADR-094 dec. 10)', () => {
  it('a group counts every unread, like a DM; a channel only its mentions', () => {
    expect(titleFor([{ ...group, unread: { count: 4, mentions: 0 } }, { ...channel, unread: { count: 7, mentions: 1 } }])).toBe(
      '(5) Tayet',
    )
  })
  it('an archived group does not count', () => {
    expect(titleFor([{ ...group, unread: { count: 4, mentions: 0 }, archived: true }])).toBe('Tayet')
  })
})

describe('notifier (ADR-073 dec. 1, 2, 5; ADR-094 dec. 10)', () => {
  it('a group notifies a message without a mention; never the session\'s own', () => {
    expect(shouldNotify(msg(GROUP), group)).toBe(true)
    expect(shouldNotify(msg(GROUP, { mine: true }), group)).toBe(false)
    expect(shouldNotify(msg(CHAN), channel)).toBe(false)
  })

  it('a person author: "{author} em conversa em grupo", no group name, no id', async () => {
    const h = harness()
    h.notifier.handle(received(msg(GROUP)))
    await h.flush()
    expect(h.shown).toHaveLength(1)
    expect(h.shown[0]!.title).toBe(fill(copy.notifications.titleInGroup, { author: 'Ana Lima' }))
    expect(h.shown[0]!.body).toBe('oi')
    expect(findProtocolLeaksInText(`${h.shown[0]!.title} ${h.shown[0]!.body}`)).toEqual([])
  })

  it('an agent author: the agent variant', async () => {
    const h = harness()
    h.notifier.handle(received(msg(GROUP, { author: ROBO })))
    await h.flush()
    expect(h.shown[0]!.title).toBe(fill(copy.notifications.titleInGroupAgent, { author: 'Robô' }))
  })

  it('no known author: the title in force for that case (the conversation name)', async () => {
    const h = harness([])
    h.notifier.handle(received(msg(GROUP)))
    await h.flush()
    expect(h.shown[0]!.title).toBe(group.name)
  })

  it('an undecryptable message that expires in a group notifies generically, once', async () => {
    const h = harness()
    const m = msg(GROUP, { body: { kind: 'unavailable', arrival: 'awaited' } })
    h.notifier.handle(received(m))
    expect(h.shown).toHaveLength(0)
    h.fire()
    await h.flush()
    expect(h.shown).toHaveLength(1)
    expect(h.shown[0]!.body).toBe(copy.notifications.generic)
    h.notifier.handle(edited({ ...m, body: { kind: 'text', text: 'tarde' } }))
    await h.flush()
    expect(h.shown).toHaveLength(1)
    expect(UTD_WAIT_MS).toBe(10_000)
  })

  it('in a channel the expiry still says nothing (unchanged)', async () => {
    const h = harness()
    h.notifier.handle(received(msg(CHAN, { body: { kind: 'unavailable', arrival: 'awaited' } })))
    h.fire()
    await h.flush()
    expect(h.shown).toHaveLength(0)
  })
})
