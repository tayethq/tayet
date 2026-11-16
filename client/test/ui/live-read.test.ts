import { describe, it, expect, beforeEach } from 'vitest'
import { createLiveReader, type LiveReadDeps, type LiveReadEnv } from '../../src/ui/live-read'
import type { ChannelId, DomainEvent, Message, MessageBody, MessageId, UserId } from '../../src/acl'

// ADR-100: the open conversation is read as messages arrive. The reader is driven by DomainEvents
// over a fake env (visibility, focus, the return) and fake deps (selection, open thread, what the
// screen holds, a markRead whose promises the test settles). No DOM, no ACL.

const cid = (s: string): ChannelId => s as unknown as ChannelId
const uid = (s: string): UserId => s as unknown as UserId
const mid = (s: string): MessageId => s as unknown as MessageId

const ALICE = uid('@alice:tayet.local')
const DM = cid('!dm:tayet.local')
const OTHER = cid('!other:tayet.local')
const ROOT = mid('$root')

let seq = 0
const msg = (channelId: ChannelId, over: Partial<Message> = {}): Message => ({
  id: mid(`$m${++seq}`),
  channelId,
  author: ALICE,
  body: { kind: 'text', text: 'oi' },
  sentAt: 0 as unknown as Message['sentAt'],
  reactions: [],
  mine: false,
  mentionsMe: false,
  ...over,
})
const received = (m: Message): DomainEvent => ({ t: 'message.received', channelId: m.channelId, message: m })

interface Call {
  channelId: ChannelId
  target: MessageId
  resolve: () => void
  reject: () => void
}

function harness() {
  const state = {
    selected: DM as ChannelId | undefined,
    thread: undefined as MessageId | undefined,
    visible: true,
    focused: true,
    main: [] as Message[],
    replies: [] as Message[],
    threadReads: [] as Array<[ChannelId, MessageId]>,
  }
  const calls: Call[] = []
  let returnFn: (() => void) | undefined
  const deps: LiveReadDeps = {
    markRead: (channelId, target) =>
      new Promise<void>((resolve, reject) => calls.push({ channelId, target, resolve, reject: () => reject(new Error('x')) })),
    getSelectedId: () => state.selected,
    getOpenThread: () => state.thread,
    getMain: () => state.main,
    getReplies: () => state.replies,
    threadRead: (channelId, root) => state.threadReads.push([channelId, root]),
  }
  const env: LiveReadEnv = {
    isVisible: () => state.visible,
    hasFocus: () => state.focused,
    onReturn: (fn) => {
      returnFn = fn
      return () => {
        returnFn = undefined
      }
    },
  }
  const reader = createLiveReader(deps, env)
  const back = () => returnFn?.()
  const targets = () => calls.map((c) => c.target)
  return { state, calls, reader, back, targets, hasReturn: () => returnFn !== undefined }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

let h: ReturnType<typeof harness>
beforeEach(() => {
  h = harness()
})

describe('live read — dec. 1, arrival in the open conversation', () => {
  it('selected, visible and in focus: a receipt on that message, explicit target', () => {
    const m = msg(DM)
    h.reader.handle(received(m))
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]).toMatchObject({ channelId: DM, target: m.id })
  })

  it('hidden: no receipt', () => {
    h.state.visible = false
    h.reader.handle(received(msg(DM)))
    expect(h.calls).toHaveLength(0)
  })

  it('visible but without focus: no receipt', () => {
    h.state.focused = false
    h.reader.handle(received(msg(DM)))
    expect(h.calls).toHaveLength(0)
  })

  it('my own message: no receipt', () => {
    h.reader.handle(received(msg(DM, { mine: true })))
    expect(h.calls).toHaveLength(0)
  })

  it('another conversation: no receipt', () => {
    h.reader.handle(received(msg(OTHER)))
    expect(h.calls).toHaveLength(0)
  })

  it('an undecryptable arrival is read too', () => {
    const unavailable: MessageBody = { kind: 'unavailable', arrival: 'awaited' }
    const m = msg(DM, { body: unavailable })
    h.reader.handle(received(m))
    expect(h.targets()).toEqual([m.id])
  })

  it('only message.received counts (an edit is no arrival)', () => {
    const m = msg(DM)
    h.reader.handle({ t: 'message.edited', channelId: DM, message: m })
    expect(h.calls).toHaveLength(0)
  })
})

describe('live read — dec. 2, threads', () => {
  it('a reply of a closed thread: no receipt (ADR-067)', () => {
    h.reader.handle(received(msg(DM, { threadParent: ROOT })))
    expect(h.calls).toHaveLength(0)
  })

  it('a reply of another thread than the open one: no receipt', () => {
    h.state.thread = mid('$another')
    h.reader.handle(received(msg(DM, { threadParent: ROOT })))
    expect(h.calls).toHaveLength(0)
  })

  it('a reply in the open thread: a receipt on it, then the thread unread is re-read', async () => {
    h.state.thread = ROOT
    const r = msg(DM, { threadParent: ROOT })
    h.reader.handle(received(r))
    expect(h.targets()).toEqual([r.id])
    expect(h.state.threadReads).toHaveLength(0)
    h.calls[0]!.resolve()
    await flush()
    expect(h.state.threadReads).toEqual([[DM, ROOT]])
  })

  it('a reply in the open thread with the document hidden: no receipt', () => {
    h.state.thread = ROOT
    h.state.visible = false
    h.reader.handle(received(msg(DM, { threadParent: ROOT })))
    expect(h.calls).toHaveLength(0)
  })
})

describe('live read — dec. 3, the return', () => {
  it('back in view: one receipt on the last main message the screen holds', () => {
    const a = msg(DM)
    const b = msg(DM)
    h.state.main = [a, b]
    h.state.visible = false
    h.reader.handle(received(b))
    expect(h.calls).toHaveLength(0)
    h.state.visible = true
    h.back()
    expect(h.targets()).toEqual([b.id])
  })

  it('a return while still hidden or unfocused does nothing', () => {
    h.state.main = [msg(DM)]
    h.state.visible = false
    h.back()
    h.state.visible = true
    h.state.focused = false
    h.back()
    expect(h.calls).toHaveLength(0)
  })

  it('skips our pending or failed echo at the tail (no server id yet)', () => {
    const a = msg(DM)
    h.state.main = [a, msg(DM, { mine: true, status: 'pending' }), msg(DM, { mine: true, status: 'failed' })]
    h.back()
    expect(h.targets()).toEqual([a.id])
  })

  it('also the last reply of the open thread, after the main receipt', async () => {
    const a = msg(DM)
    const r = msg(DM, { threadParent: ROOT })
    h.state.main = [a]
    h.state.thread = ROOT
    h.state.replies = [r]
    h.back()
    // One receipt in flight per conversation (dec. 5): the thread's waits for the main one.
    expect(h.targets()).toEqual([a.id])
    h.calls[0]!.resolve()
    await flush()
    expect(h.targets()).toEqual([a.id, r.id])
    h.calls[1]!.resolve()
    await flush()
    expect(h.state.threadReads).toEqual([[DM, ROOT]])
  })

  it('does not re-send what it already receipted', async () => {
    const a = msg(DM)
    h.state.main = [a]
    h.reader.handle(received(a))
    h.calls[0]!.resolve()
    await flush()
    h.back()
    expect(h.calls).toHaveLength(1)
  })

  it('a failed receipt is sent again on the next return', async () => {
    const a = msg(DM)
    h.state.main = [a]
    h.reader.handle(received(a))
    h.calls[0]!.reject()
    await flush()
    h.back()
    expect(h.targets()).toEqual([a.id, a.id])
    h.calls[1]!.resolve()
    await flush()
    h.back()
    expect(h.calls).toHaveLength(2)
  })

  it('a return while the same target is in flight does not queue a second receipt', async () => {
    const a = msg(DM)
    h.state.main = [a]
    h.reader.handle(received(a))
    h.back()
    h.calls[0]!.resolve()
    await flush()
    expect(h.targets()).toEqual([a.id])
  })

  it('no selection: nothing', () => {
    h.state.selected = undefined
    h.state.main = [msg(DM)]
    h.back()
    expect(h.calls).toHaveLength(0)
  })
})

describe('live read — dec. 5, one receipt at a time', () => {
  it('three arrivals with a receipt in flight: two receipts, the second on the newest', async () => {
    const [a, b, c] = [msg(DM), msg(DM), msg(DM)]
    h.reader.handle(received(a))
    h.reader.handle(received(b))
    h.reader.handle(received(c))
    expect(h.targets()).toEqual([a.id])
    h.calls[0]!.resolve()
    await flush()
    expect(h.targets()).toEqual([a.id, c.id])
    h.calls[1]!.resolve()
    await flush()
    expect(h.calls).toHaveLength(2)
  })

  it('a failed receipt is swallowed and the waiting one still goes', async () => {
    const [a, b] = [msg(DM), msg(DM)]
    h.reader.handle(received(a))
    h.reader.handle(received(b))
    h.calls[0]!.reject()
    await flush()
    expect(h.targets()).toEqual([a.id, b.id])
  })

  it('the conversation switched mid-flight: nothing more for the old one', async () => {
    const [a, b] = [msg(DM), msg(DM)]
    h.reader.handle(received(a))
    h.reader.handle(received(b))
    h.state.selected = OTHER
    h.calls[0]!.resolve()
    await flush()
    expect(h.targets()).toEqual([a.id])
  })

  it('the open thread receipt does not re-read a thread of a conversation no longer selected', async () => {
    h.state.thread = ROOT
    h.reader.handle(received(msg(DM, { threadParent: ROOT })))
    h.state.selected = OTHER
    h.calls[0]!.resolve()
    await flush()
    expect(h.state.threadReads).toHaveLength(0)
  })
})

describe('live read — dispose', () => {
  it('unsubscribes the return and ignores later arrivals', () => {
    expect(h.hasReturn()).toBe(true)
    h.reader.dispose()
    expect(h.hasReturn()).toBe(false)
    h.reader.handle(received(msg(DM)))
    expect(h.calls).toHaveLength(0)
  })
})
