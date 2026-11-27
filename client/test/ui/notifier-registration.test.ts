// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel, ChannelId, DomainEvent, Message, MessageId, UserId } from '../../src/acl'

// ADR-117 dec. 5 (PR 5a of the push track, fork 6): where the service worker is registered, the live tab notifies
// through its registration, with the click target in the data; with no registration, or when it refuses, it falls
// back to `new Notification` and today's onclick.

const registration = { current: undefined as undefined | { showNotification: ReturnType<typeof vi.fn> } }
vi.mock('../../src/ui/service-worker', () => ({ activeRegistration: () => registration.current }))

const { browserNotifierEnv, createNotifier } = await import('../../src/ui/notifier')

const built: Array<{ title: string; options: unknown; onclick: unknown; closed: boolean }> = []
class FakeNotification {
  static permission = 'granted'
  onclick: ((ev: Event) => void) | null = null
  constructor(title: string, options: unknown) {
    built.push(Object.assign(this, { title, options, closed: false }) as never)
  }
  close(): void {
    ;(this as unknown as { closed: boolean }).closed = true
  }
}

beforeEach(() => {
  built.length = 0
  registration.current = undefined
  vi.stubGlobal('Notification', FakeNotification)
})
afterEach(() => vi.unstubAllGlobals())

const DATA = { conversation: '!c:x', message: '$m' }

describe('browserNotifierEnv().notify', () => {
  it('no registration: new Notification with body and tag, as before', () => {
    const handle = browserNotifierEnv().notify('T', { body: 'B', tag: 'g', data: DATA })
    expect(handle).toBeInstanceOf(FakeNotification)
    expect(built.map((b) => [b.title, b.options])).toEqual([['T', { body: 'B', tag: 'g' }]])
  })

  it('a registration: showNotification with the data, and no handle (the click is the worker\'s)', async () => {
    registration.current = { showNotification: vi.fn(async () => undefined) }
    const out = browserNotifierEnv().notify('T', { body: 'B', tag: 'g', data: DATA })
    expect(out).toBeInstanceOf(Promise)
    expect(await out).toBeUndefined()
    expect(registration.current.showNotification).toHaveBeenCalledWith('T', { body: 'B', tag: 'g', data: DATA })
    expect(built).toEqual([])
  })

  it('a registration that refuses (no permission in the worker): new Notification', async () => {
    registration.current = { showNotification: vi.fn(async () => Promise.reject(new TypeError('no permission'))) }
    const handle = await browserNotifierEnv().notify('T', { body: 'B', tag: 'g', data: DATA })
    expect(handle).toBeInstanceOf(FakeNotification)
    expect(built.map((b) => b.options)).toEqual([{ body: 'B', tag: 'g' }])
  })
})

describe('the notifier over an async notify', () => {
  const DM = '!dm:x' as unknown as ChannelId
  const dm: Channel = { id: DM, kind: 'dm', name: 'alice', memberCount: 2, unread: { count: 0, mentions: 0 } }
  const message = (over: Partial<Message> = {}): Message => ({
    id: '$m1' as unknown as MessageId,
    channelId: DM,
    author: '@a:x' as unknown as UserId,
    body: { kind: 'text', text: 'oi' },
    sentAt: 0 as unknown as Message['sentAt'],
    reactions: [],
    mine: false,
    mentionsMe: false,
    ...over,
  })

  function run(notify: ReturnType<typeof browserNotifierEnv>['notify']) {
    const calls: Array<{ data: unknown }> = []
    const selects: ChannelId[] = []
    const jumps: Message[] = []
    const env = {
      ...browserNotifierEnv(),
      permission: () => 'granted' as const,
      isVisible: () => false,
      hasFocus: () => false,
      focusWindow: () => {},
      notify: (title: string, options: { body: string; tag: string; data?: unknown }) => {
        calls.push({ data: options.data })
        return notify(title, options as never)
      },
    }
    const n = createNotifier(
      { getChannel: () => dm, getSelectedId: () => undefined, select: (id) => void selects.push(id), jumpTo: (_c, m) => void jumps.push(m), getMembers: async () => [] },
      env,
    )
    return { n, calls, selects, jumps }
  }

  it('passes the click target as data: the conversation, the message and the thread', () => {
    const { n, calls } = run(() => undefined)
    n.handle({ t: 'message.received', channelId: DM, message: message() } as DomainEvent)
    n.handle({ t: 'message.received', channelId: DM, message: message({ id: '$m2' as never, threadParent: '$root' as never }) } as DomainEvent)
    expect(calls.map((c) => c.data)).toEqual([
      { conversation: '!dm:x', message: '$m1' },
      { conversation: '!dm:x', message: '$m2', thread: '$root' },
    ])
  })

  it('the fallback handle, arriving later, still gets today\'s click', async () => {
    const handle = { onclick: null as null | ((e: Event) => void), closed: false, close() { this.closed = true } }
    const { n, selects } = run(() => Promise.resolve(handle))
    n.handle({ t: 'message.received', channelId: DM, message: message() } as DomainEvent)
    await Promise.resolve()
    await Promise.resolve()
    handle.onclick?.(new Event('click'))
    expect(selects).toEqual([DM])
    expect(handle.closed).toBe(true)
  })

  it('through the registration there is no handle and nothing to click here', async () => {
    const { n, selects } = run(() => Promise.resolve(undefined))
    n.handle({ t: 'message.received', channelId: DM, message: message() } as DomainEvent)
    await Promise.resolve()
    expect(selects).toEqual([])
  })
})
