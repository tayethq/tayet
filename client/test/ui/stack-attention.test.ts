import { describe, it, expect } from 'vitest'
import { createLiveReader, type LiveReadDeps, type LiveReadEnv } from '../../src/ui/live-read'
import { createNotifier, type NotificationHandle, type NotifierDeps, type NotifierEnv } from '../../src/ui/notifier'
import type { Channel, ChannelId, DomainEvent, Message, MessageId, UserId } from '../../src/acl'

// On a narrow window the open thread is the screen in front and covers the
// conversation's timeline. The live read and the notifier get the thread on screen through a new,
// optional dependency; absent (the wide window) they behave as before — their own suites, unchanged,
// keep proving that. Fake deps and env, no DOM, no ACL.

const cid = (s: string): ChannelId => s as unknown as ChannelId
const uid = (s: string): UserId => s as unknown as UserId
const mid = (s: string): MessageId => s as unknown as MessageId

const ALICE = uid('@alice:tayet.local')
const DM = cid('!dm:tayet.local')
const ROOT = mid('$root')

let seq = 0
const msg = (over: Partial<Message> = {}): Message => ({
  id: mid(`$s${++seq}`),
  channelId: DM,
  author: ALICE,
  body: { kind: 'text', text: 'oi' },
  sentAt: 0 as unknown as Message['sentAt'],
  reactions: [],
  mine: false,
  mentionsMe: false,
  ...over,
})
const received = (m: Message): DomainEvent => ({ t: 'message.received', channelId: m.channelId, message: m })
const flush = () => new Promise((r) => setTimeout(r, 0))

function reader() {
  const state = {
    thread: ROOT as MessageId | undefined,
    screenThread: ROOT as MessageId | undefined,
    main: [] as Message[],
    replies: [] as Message[],
  }
  const targets: MessageId[] = []
  let returnFn: (() => void) | undefined
  const deps: LiveReadDeps = {
    markRead: (_c, target) => {
      targets.push(target)
      return Promise.resolve()
    },
    getSelectedId: () => DM,
    getOpenThread: () => state.thread,
    getMain: () => state.main,
    getReplies: () => state.replies,
    threadRead: () => {},
    getThreadOnScreen: () => state.screenThread,
  }
  const env: LiveReadEnv = {
    isVisible: () => true,
    hasFocus: () => true,
    onReturn: (fn) => {
      returnFn = fn
      return () => (returnFn = undefined)
    },
  }
  return { state, targets, live: createLiveReader(deps, env), back: () => returnFn?.() }
}

describe('live read with the thread on screen (narrow)', () => {
  it('a message of the main timeline is not receipted on arrival', () => {
    const r = reader()
    r.live.handle(received(msg()))
    expect(r.targets).toEqual([])
  })

  it('a reply of the thread on screen is receipted as today', async () => {
    const r = reader()
    const reply = msg({ threadParent: ROOT })
    r.live.handle(received(reply))
    await flush()
    expect(r.targets).toEqual([reply.id])
  })

  it('the return reads the thread, never the covered timeline', async () => {
    const r = reader()
    const main = msg()
    const reply = msg({ threadParent: ROOT })
    r.state.main = [main]
    r.state.replies = [reply]
    r.back()
    await flush()
    expect(r.targets).toEqual([reply.id])
  })

  it('back to the conversation (resume): the timeline is read up to what the screen holds', async () => {
    const r = reader()
    const main = msg()
    r.state.main = [main]
    r.live.handle(received(main))
    expect(r.targets).toEqual([])
    // The thread screen closed.
    r.state.thread = undefined
    r.state.screenThread = undefined
    r.live.resume()
    await flush()
    expect(r.targets).toEqual([main.id])
  })
})

function notifier() {
  const state = { screenThread: ROOT as MessageId | undefined }
  const shown: string[] = []
  const channel: Channel = { id: DM, kind: 'dm', name: 'alice', memberCount: 2, unread: { count: 0, mentions: 0 } }
  const deps: NotifierDeps = {
    getChannel: (id) => (id === DM ? channel : undefined),
    getSelectedId: () => DM,
    select: () => {},
    jumpTo: () => {},
    getMembers: () => Promise.resolve([]),
    getThreadOnScreen: () => state.screenThread,
  }
  const env: NotifierEnv = {
    permission: () => 'granted',
    notify: (title, { body }) => {
      shown.push(`${title}: ${body}`)
      return { onclick: null, close: () => {} } as NotificationHandle
    },
    isVisible: () => true,
    hasFocus: () => true,
    focusWindow: () => {},
    now: () => 0,
    setTimeout: () => 0,
    clearTimeout: () => {},
  }
  return { state, shown, n: createNotifier(deps, env) }
}

describe('notifier with the thread on screen (narrow)', () => {
  it('a message of the conversation timeline notifies by the usual rule', () => {
    const h = notifier()
    h.n.handle(received(msg({ body: { kind: 'text', text: 'na conversa' } })))
    expect(h.shown).toEqual(['alice: na conversa'])
  })

  it('a reply of the thread on screen is suppressed', () => {
    const h = notifier()
    h.n.handle(received(msg({ threadParent: ROOT })))
    expect(h.shown).toEqual([])
  })

  it('a reply of another thread notifies', () => {
    const h = notifier()
    h.n.handle(received(msg({ threadParent: mid('$other'), body: { kind: 'text', text: 'outra' } })))
    expect(h.shown).toEqual(['alice: outra'])
  })

  it('without the thread on screen the whole conversation is in view (the wide rule)', () => {
    const h = notifier()
    h.state.screenThread = undefined
    h.n.handle(received(msg()))
    h.n.handle(received(msg({ threadParent: ROOT })))
    expect(h.shown).toEqual([])
  })
})
