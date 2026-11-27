// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import {
  createNotifier,
  previewOf,
  shouldNotify,
  PREVIEW_MAX,
  UTD_WAIT_MS,
  type NotificationHandle,
  type NotifierDeps,
  type NotifierEnv,
  type NotificationPermissionState,
} from '../../src/ui/notifier'
import type { Channel, ChannelId, DomainEvent, Message, MessageBody, MessageId, User, UserId } from '../../src/acl'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'

// ADR-073: the notifier, driven by DomainEvents over a fake env (clock, timers, notify recorder) and
// fake deps (channels, selection, members). No DOM, no ACL.

const cid = (s: string): ChannelId => s as unknown as ChannelId
const uid = (s: string): UserId => s as unknown as UserId
const mid = (s: string): MessageId => s as unknown as MessageId

const ALICE = uid('@alice:tayet.local')
const DM = cid('!dm:tayet.local')
const ORG = cid('!org:tayet.local')
const PRIV = cid('!priv:tayet.local')

const channel = (id: ChannelId, kind: Channel['kind'], name: string): Channel => ({
  id,
  kind,
  name,
  memberCount: 2,
  unread: { count: 0, mentions: 0 },
})
const CHANNELS: Record<string, Channel> = {
  [DM]: channel(DM, 'dm', 'alice'),
  [ORG]: channel(ORG, 'public', '#all'),
  [PRIV]: channel(PRIV, 'private', '#core'),
}

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
const edited = (m: Message): DomainEvent => ({ t: 'message.edited', channelId: m.channelId, message: m })
const unavailable: MessageBody = { kind: 'unavailable', arrival: 'awaited' }

interface Shown {
  title: string
  body: string
  tag: string
  handle: NotificationHandle & { closed: boolean }
}

function harness(opts: { members?: () => Promise<User[]>; permission?: NotificationPermissionState } = {}) {
  let clock = 0
  let timers: Array<{ at: number; fn: () => void; id: number }> = []
  let nextTimer = 1
  const shown: Shown[] = []
  const state = {
    selected: undefined as ChannelId | undefined,
    visible: false,
    focused: false,
    permission: opts.permission ?? ('granted' as NotificationPermissionState),
    focusCalls: 0,
    selectCalls: [] as ChannelId[],
    jumpCalls: [] as Array<{ channelId: ChannelId; message: Message }>,
    membersCalls: 0,
  }
  const env: NotifierEnv = {
    permission: () => state.permission,
    notify: (title, { body, tag }) => {
      const handle = { onclick: null, closed: false, close: () => (handle.closed = true) } as Shown['handle']
      shown.push({ title, body, tag, handle })
      return handle
    },
    isVisible: () => state.visible,
    hasFocus: () => state.focused,
    focusWindow: () => void state.focusCalls++,
    now: () => clock,
    setTimeout: (fn, ms) => {
      const id = nextTimer++
      timers.push({ at: clock + ms, fn, id })
      return id
    },
    clearTimeout: (id) => {
      timers = timers.filter((t) => t.id !== id)
    },
  }
  const deps: NotifierDeps = {
    getChannel: (id) => CHANNELS[id],
    getSelectedId: () => state.selected,
    select: (id) => void state.selectCalls.push(id),
    jumpTo: (channelId, message) => void state.jumpCalls.push({ channelId, message }),
    getMembers: () => {
      state.membersCalls++
      return opts.members ? opts.members() : Promise.resolve([{ id: ALICE, displayName: 'Alice Souza', kind: 'member' }])
    },
  }
  const notifier = createNotifier(deps, env)
  // Advance the fake clock, firing due timers (only the clock — a hidden tab's throttling is
  // modelled by advancing `clock` without calling this).
  const advance = (ms: number) => {
    clock += ms
    const due = timers.filter((t) => t.at <= clock)
    timers = timers.filter((t) => t.at > clock)
    for (const t of due) t.fn()
  }
  const setClock = (ms: number) => (clock = ms)
  const flush = () => new Promise((r) => setTimeout(r, 0))
  return { notifier, shown, state, advance, setClock, flush, pendingTimers: () => timers.length }
}

describe('shouldNotify (ADR-073 dec. 1) — the §0 table', () => {
  it('channel without mention → no', () => {
    expect(shouldNotify(msg(ORG), CHANNELS[ORG]!)).toBe(false)
  })
  it('@-mention in a channel → yes', () => {
    expect(shouldNotify(msg(ORG, { mentionsMe: true }), CHANNELS[ORG]!)).toBe(true)
  })
  it('DM → yes', () => {
    expect(shouldNotify(msg(DM), CHANNELS[DM]!)).toBe(true)
  })
  it('own message → no (DM or mention alike)', () => {
    expect(shouldNotify(msg(DM, { mine: true }), CHANNELS[DM]!)).toBe(false)
    expect(shouldNotify(msg(ORG, { mine: true, mentionsMe: true }), CHANNELS[ORG]!)).toBe(false)
  })
  it('private channel without mention → no', () => {
    expect(shouldNotify(msg(PRIV), CHANNELS[PRIV]!)).toBe(false)
  })
})

describe('notifier — the same table through handle()', () => {
  it('counts one notification per row that notifies', async () => {
    const h = harness()
    h.notifier.handle(received(msg(ORG)))
    h.notifier.handle(received(msg(PRIV)))
    h.notifier.handle(received(msg(DM, { mine: true })))
    await h.flush()
    expect(h.shown).toHaveLength(0)
    h.notifier.handle(received(msg(ORG, { mentionsMe: true })))
    await h.flush()
    expect(h.shown).toHaveLength(1)
    h.notifier.handle(received(msg(DM)))
    await h.flush()
    expect(h.shown).toHaveLength(2)
  })

  it('no notification unless permission is granted', async () => {
    for (const permission of ['default', 'denied'] as const) {
      const h = harness({ permission })
      h.notifier.handle(received(msg(DM)))
      await h.flush()
      expect(h.shown).toHaveLength(0)
    }
  })
})

describe('notifier — undecryptable messages (dec. 2)', () => {
  it('DM resolved before the cap → one notification with the real text', async () => {
    const h = harness()
    const m = msg(DM, { body: unavailable })
    h.notifier.handle(received(m))
    expect(h.shown).toHaveLength(0)
    h.advance(UTD_WAIT_MS - 1)
    h.notifier.handle(edited({ ...m, body: { kind: 'text', text: 'chegou' } }))
    h.advance(UTD_WAIT_MS)
    await h.flush()
    expect(h.shown.map((s) => s.body)).toEqual(['chegou'])
    expect(h.pendingTimers()).toBe(0)
  })

  it('DM expired → one notification "Nova mensagem"; the later content does not notify again', async () => {
    const h = harness()
    const m = msg(DM, { body: unavailable })
    h.notifier.handle(received(m))
    h.advance(UTD_WAIT_MS)
    await h.flush()
    expect(h.shown.map((s) => [s.title, s.body])).toEqual([['alice', 'Nova mensagem']])
    h.notifier.handle(edited({ ...m, body: { kind: 'text', text: 'tarde' } }))
    await h.flush()
    expect(h.shown).toHaveLength(1)
  })

  it('channel expired → nothing, even if the content later mentions me', async () => {
    const h = harness()
    const m = msg(ORG, { body: unavailable })
    h.notifier.handle(received(m))
    h.advance(UTD_WAIT_MS)
    h.notifier.handle(edited({ ...m, body: { kind: 'text', text: '@me' }, mentionsMe: true }))
    await h.flush()
    expect(h.shown).toHaveLength(0)
  })

  it('channel resolved in time applies dec. 1 with the real mentionsMe', async () => {
    const h = harness()
    const a = msg(ORG, { body: unavailable })
    const b = msg(ORG, { body: unavailable })
    h.notifier.handle(received(a))
    h.notifier.handle(received(b))
    h.notifier.handle(edited({ ...a, body: { kind: 'text', text: 'sem menção' } }))
    h.notifier.handle(edited({ ...b, body: { kind: 'text', text: 'com menção' }, mentionsMe: true }))
    await h.flush()
    expect(h.shown.map((s) => s.body)).toEqual(['com menção'])
  })

  it('a re-emit that is still unavailable keeps waiting', async () => {
    const h = harness()
    const m = msg(DM, { body: unavailable })
    h.notifier.handle(received(m))
    h.notifier.handle(edited({ ...m, body: { kind: 'unavailable', arrival: 'stalled' } }))
    h.notifier.handle(edited({ ...m, body: { kind: 'text', text: 'enfim' } }))
    await h.flush()
    expect(h.shown.map((s) => s.body)).toEqual(['enfim'])
  })

  it('content arriving past 10 s on the clock but before the timer fired (hidden tab) notifies with the content', async () => {
    const h = harness()
    const dm = msg(DM, { body: unavailable })
    const mentioned = msg(ORG, { body: unavailable })
    const plain = msg(ORG, { body: unavailable })
    for (const m of [dm, mentioned, plain]) h.notifier.handle(received(m))
    h.setClock(UTD_WAIT_MS + 5_000) // throttled: no timer has fired
    h.notifier.handle(edited({ ...dm, body: { kind: 'text', text: 'tarde' } }))
    h.notifier.handle(edited({ ...mentioned, body: { kind: 'text', text: 'com menção' }, mentionsMe: true }))
    h.notifier.handle(edited({ ...plain, body: { kind: 'text', text: 'sem menção' } }))
    await h.flush()
    expect(h.shown.map((s) => s.body).sort()).toEqual(['com menção', 'tarde'])
    expect(h.pendingTimers()).toBe(0)
  })

  it('timer expires, then the content arrives → exactly one notification (DM generic, channel none)', async () => {
    const h = harness()
    const dm = msg(DM, { body: unavailable })
    const ch = msg(ORG, { body: unavailable })
    h.notifier.handle(received(dm))
    h.notifier.handle(received(ch))
    h.advance(UTD_WAIT_MS)
    h.notifier.handle(edited({ ...dm, body: { kind: 'text', text: 'tarde' } }))
    h.notifier.handle(edited({ ...ch, body: { kind: 'text', text: '@me' }, mentionsMe: true }))
    await h.flush()
    expect(h.shown.map((s) => [s.title, s.body])).toEqual([['alice', 'Nova mensagem']])
  })

  it('an edit of a message that was never pending does not notify', async () => {
    const h = harness()
    h.notifier.handle(edited(msg(DM, { body: { kind: 'text', text: 'editada' } })))
    await h.flush()
    expect(h.shown).toHaveLength(0)
  })
})

describe('notifier — suppression and click (dec. 4)', () => {
  it('selected + visible + focused → suppressed; selected + hidden → notifies', async () => {
    const h = harness()
    h.state.selected = DM
    h.state.visible = true
    h.state.focused = true
    h.notifier.handle(received(msg(DM)))
    await h.flush()
    expect(h.shown).toHaveLength(0)
    h.state.visible = false
    h.notifier.handle(received(msg(DM)))
    await h.flush()
    expect(h.shown).toHaveLength(1)
  })

  it('selected + visible but without focus → notifies; another channel selected → notifies', async () => {
    const h = harness()
    h.state.selected = DM
    h.state.visible = true
    h.notifier.handle(received(msg(DM)))
    h.state.focused = true
    h.state.selected = ORG
    h.notifier.handle(received(msg(DM)))
    await h.flush()
    expect(h.shown).toHaveLength(2)
  })

  it('click focuses the window, selects the channel and closes the notification', async () => {
    const h = harness()
    h.notifier.handle(received(msg(DM)))
    await h.flush()
    h.shown[0]!.handle.onclick?.(new Event('click'))
    expect(h.state.focusCalls).toBe(1)
    expect(h.state.selectCalls).toEqual([DM])
    expect(h.state.jumpCalls).toEqual([])
    expect(h.shown[0]!.handle.closed).toBe(true)
  })

  // ADR-073 addendum (2026-11-23): a thread reply's notification opens the thread on the reply.
  it('click on a thread reply jumps to it (message and channel), without selecting; focus and close stay', async () => {
    const h = harness()
    const reply = msg(DM, { threadParent: mid('$root') })
    h.notifier.handle(received(reply))
    await h.flush()
    h.shown[0]!.handle.onclick?.(new Event('click'))
    expect(h.state.jumpCalls).toEqual([{ channelId: DM, message: reply }])
    expect(h.state.selectCalls).toEqual([])
    expect(h.state.focusCalls).toBe(1)
    expect(h.shown[0]!.handle.closed).toBe(true)
  })

  it('click on a thread reply mentioning me in a channel jumps; a channel message mentioning me selects', async () => {
    const h = harness()
    const reply = msg(ORG, { threadParent: mid('$root'), mentionsMe: true })
    h.notifier.handle(received(reply))
    h.notifier.handle(received(msg(ORG, { mentionsMe: true })))
    await h.flush()
    expect(h.shown).toHaveLength(2)
    for (const s of h.shown) s.handle.onclick?.(new Event('click'))
    expect(h.state.jumpCalls).toEqual([{ channelId: ORG, message: reply }])
    expect(h.state.selectCalls).toEqual([ORG])
  })

  it('expired UTD: the generic notification of a thread reply jumps; of a conversation message, selects', async () => {
    const h = harness()
    const reply = msg(DM, { body: unavailable, threadParent: mid('$root') })
    h.notifier.handle(received(reply))
    h.notifier.handle(received(msg(DM, { body: unavailable })))
    h.advance(UTD_WAIT_MS)
    await h.flush()
    expect(h.shown.map((s) => s.body)).toEqual(['Nova mensagem', 'Nova mensagem'])
    for (const s of h.shown) s.handle.onclick?.(new Event('click'))
    expect(h.state.jumpCalls).toEqual([{ channelId: DM, message: reply }])
    expect(h.state.selectCalls).toEqual([DM])
  })

  it('suppression is unchanged for a thread reply: selected + visible + focused, no thread screen → nothing', async () => {
    const h = harness()
    h.state.selected = DM
    h.state.visible = true
    h.state.focused = true
    h.notifier.handle(received(msg(DM, { threadParent: mid('$root') })))
    await h.flush()
    expect(h.shown).toHaveLength(0)
  })
})

describe('previewOf (dec. 5)', () => {
  it('text collapses whitespace and is truncated at PREVIEW_MAX with an ellipsis', () => {
    expect(previewOf({ kind: 'text', text: '  oi\n\n  tudo\tbem  ' })).toBe('oi tudo bem')
    const long = 'a'.repeat(PREVIEW_MAX + 30)
    expect(previewOf({ kind: 'text', text: long })).toBe(`${'a'.repeat(PREVIEW_MAX)}…`)
    expect(previewOf({ kind: 'text', text: 'b'.repeat(PREVIEW_MAX) })).toBe('b'.repeat(PREVIEW_MAX))
  })
  it('text ignores rich and uses the plain fallback', () => {
    expect(previewOf({ kind: 'text', text: 'plano', rich: [{ t: 'p', children: [{ t: 'text', text: 'rico' }] }] } as MessageBody)).toBe('plano')
  })
  it('one product line per non-text kind', () => {
    expect(previewOf({ kind: 'image', media: 'mr_1' as never })).toBe('Enviou uma imagem')
    expect(previewOf({ kind: 'file', media: 'mr_2' as never, name: 'a.pdf', size: 1, mimetype: 'application/pdf' })).toBe('Enviou um arquivo')
    expect(previewOf({ kind: 'unsupported', shape: { eventType: 'x' } })).toBe('Enviou uma mensagem')
    expect(previewOf(unavailable)).toBe('Nova mensagem')
  })
})

describe('notifier — title and author (dec. 5)', () => {
  it('DM: title is the channel name, body the preview', async () => {
    const h = harness()
    h.notifier.handle(received(msg(DM, { body: { kind: 'text', text: 'olá' } })))
    await h.flush()
    expect(h.shown.map((s) => [s.title, s.body])).toEqual([['alice', 'olá']])
  })

  it('channel: "<author> em <channel>", names cached per channel until member.changed', async () => {
    const h = harness()
    h.notifier.handle(received(msg(ORG, { mentionsMe: true })))
    h.notifier.handle(received(msg(ORG, { mentionsMe: true })))
    await h.flush()
    expect(h.shown.map((s) => s.title)).toEqual(['Alice Souza em #all', 'Alice Souza em #all'])
    expect(h.state.membersCalls).toBe(1)
    h.notifier.handle({ t: 'member.changed', channelId: ORG, user: ALICE, role: 'member' })
    h.notifier.handle(received(msg(ORG, { mentionsMe: true })))
    await h.flush()
    expect(h.state.membersCalls).toBe(2)
  })

  it('channel: getMembers failing or without the author → title is the channel name', async () => {
    const failing = harness({ members: () => Promise.reject(new Error('x')) })
    failing.notifier.handle(received(msg(ORG, { mentionsMe: true })))
    await failing.flush()
    expect(failing.shown.map((s) => s.title)).toEqual(['#all'])
    const absent = harness({ members: async () => [] })
    absent.notifier.handle(received(msg(ORG, { mentionsMe: true })))
    await absent.flush()
    expect(absent.shown.map((s) => s.title)).toEqual(['#all'])
  })

  it('P1: no title or body carries the raw author or channel id; the id is only the tag', async () => {
    const h = harness({ members: async () => [] })
    h.notifier.handle(received(msg(DM)))
    h.notifier.handle(received(msg(ORG, { mentionsMe: true })))
    const utd = msg(DM, { body: unavailable })
    h.notifier.handle(received(utd))
    h.advance(UTD_WAIT_MS)
    await h.flush()
    expect(h.shown).toHaveLength(3)
    for (const s of h.shown) {
      for (const raw of [String(ALICE), String(DM), String(ORG)]) {
        expect(s.title).not.toContain(raw)
        expect(s.body).not.toContain(raw)
      }
      expect(findProtocolLeaksInText(`${s.title}\n${s.body}`)).toEqual([])
    }
    expect(h.shown.map((s) => s.tag).sort()).toEqual([String(DM), String(DM), String(ORG)])
  })
})

describe('notifier — dispose', () => {
  it('drops pending waits and stops notifying', async () => {
    const h = harness()
    h.notifier.handle(received(msg(DM, { body: unavailable })))
    h.notifier.handle(received(msg(ORG, { mentionsMe: true })))
    h.notifier.dispose()
    h.advance(UTD_WAIT_MS)
    h.notifier.handle(received(msg(DM)))
    await h.flush()
    expect(h.shown).toHaveLength(0)
    expect(h.pendingTimers()).toBe(0)
  })
})
