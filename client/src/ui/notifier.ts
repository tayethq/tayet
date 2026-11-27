import type { Channel, ChannelId, DomainEvent, Message, MessageBody, MessageId, User, UserId } from '@tayet/client'
import { t } from './i18n'
import { clip } from './preview-text'
import { activeRegistration } from './service-worker'
import { loadNotificationsPref } from './notifications-pref'

// ADR-073: the attention signal outside the tab — a system notification raised by the LIVE tab (one
// tab per origin, ADR-065), owned by the app (ADR-030). The trigger is an app rule over two booleans
// that already cross the barrel (`mine`, `mentionsMe`) and the channel kind — no push rule, no new
// barrel field (dec. 1). Nothing here imports acl/internal; no UserId/ChannelId is ever interpolated
// into a visible string (P1): the channel id is only the notification `tag`, opaque to the user.

// Dec. 2: how long an undecryptable message may wait for its content (the message.edited of the
// same id) before it is given up on.
export const UTD_WAIT_MS = 10_000
// Dec. 5: preview length of a text body, before the ellipsis (shared with the service worker).
export { PREVIEW_MAX } from './preview-text'

export type NotificationPermissionState = 'default' | 'granted' | 'denied'

export interface NotificationHandle {
  onclick: ((ev: Event) => void) | null
  close(): void
}

export interface NotifierDeps {
  getChannel(id: ChannelId): Channel | undefined
  getSelectedId(): ChannelId | undefined
  select(id: ChannelId): void
  // Opens the conversation and the thread on the message, with the jump's mark (useChat's jumpTo).
  // The click on a thread reply's notification lands there (ADR-073 addendum, 2026-11-23).
  jumpTo(channelId: ChannelId, message: Message): void
  getMembers(id: ChannelId): Promise<User[]>
  // The thread that covers the conversation on a narrow window (the stack's thread screen). With it on
  // screen only that thread's replies are in view; absent or undefined, the whole conversation is.
  getThreadOnScreen?(): MessageId | undefined
}

// Injected like TabLockEnv (tab-lock.ts): the unit tests drive a fake clock and record notify calls.
export interface NotifierEnv {
  permission(): NotificationPermissionState
  // Through the service worker's registration when there is one (ADR-117 dec. 5): then nothing comes back, the click
  // is the worker's. Else, or when the registration refuses, `new Notification` and its handle.
  notify(
    title: string,
    options: { body: string; tag: string; data?: NotificationData },
  ): NotificationHandle | undefined | Promise<NotificationHandle | undefined>
  isVisible(): boolean
  hasFocus(): boolean
  focusWindow(): void
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

// Where the click leads, as opaque strings in the notification's data (never in its title or body).
export interface NotificationData {
  conversation: string
  message: string
  thread?: string
}

export interface Notifier {
  handle(e: DomainEvent): void
  dispose(): void
}

export function browserNotifierEnv(): NotifierEnv {
  const supported = typeof window !== 'undefined' && 'Notification' in window
  return {
    // ADR-117, addendum of 26/Nov/2026 (F4): the live tab notifies only with the permission granted AND this device's
    // preference on. Read at each notification, so the row of "Your account" takes effect without a new notifier.
    permission: () => {
      if (!supported) return 'denied'
      const granted = Notification.permission
      return granted === 'granted' && loadNotificationsPref() !== 'on' ? 'default' : granted
    },
    notify: (title, { body, tag, data }) => {
      if (!supported) return undefined
      const fallback = (): NotificationHandle => new Notification(title, { body, tag })
      const registration = activeRegistration()
      if (!registration) return fallback()
      return registration.showNotification(title, { body, tag, data }).then(() => undefined, fallback)
    },
    isVisible: () => document.visibilityState === 'visible',
    hasFocus: () => document.hasFocus(),
    focusWindow: () => window.focus(),
    now: () => Date.now(),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (handle) => window.clearTimeout(handle as number),
  }
}

// Dec. 1. A group conversation notifies every message, like a DM (ADR-094 dec. 10).
export function shouldNotify(message: Message, channel: Channel): boolean {
  return !message.mine && (everyMessage(channel) || message.mentionsMe)
}

// The conversations where every message is for the reader: a DM and a group (ADR-094 dec. 10).
const everyMessage = (channel: Channel): boolean => channel.kind === 'dm' || channel.kind === 'group'


// Dec. 5: what the notification says about the body — product copy, never a payload.
export function previewOf(body: MessageBody): string {
  switch (body.kind) {
    case 'text':
      return clip(body.text)
    // ADR-091: a card notifies under the agents' title, with the first line of its request.
    case 'approval':
      return t('notifications.approvalRequest', { text: clip(body.text.trim().split('\n')[0] ?? '') })
    case 'image':
      return t('notifications.image')
    case 'file':
      return t('notifications.file')
    case 'unsupported':
      return t('notifications.unsupported')
    case 'unavailable':
      return t('notifications.generic')
  }
}

interface Pending {
  channelId: ChannelId
  timer: unknown
}

export function createNotifier(deps: NotifierDeps, env: NotifierEnv = browserNotifierEnv()): Notifier {
  // Dec. 2: undecryptable messages waiting for their content, by stable id.
  const pending = new Map<MessageId, Pending>()
  // Dec. 5: display names per channel, best-effort; dropped on that channel's member.changed.
  const names = new Map<ChannelId, Promise<Map<UserId, User>>>()
  let disposed = false

  // ADR-086: the name travels with the kind — an agent's title says so in text (no avatar in an OS
  // notification, PLANO-AGENTES §0 F2).
  const namesOf = (channelId: ChannelId): Promise<Map<UserId, User>> => {
    let p = names.get(channelId)
    if (!p) {
      p = deps
        .getMembers(channelId)
        .then((users) => new Map(users.map((u): [UserId, User] => [u.id, u])))
        .catch(() => new Map<UserId, User>())
      names.set(channelId, p)
    }
    return p
  }

  // The user is looking at this very channel (with the narrow stack's thread on screen, at that
  // thread: a message of the conversation's timeline is not in view and notifies as usual).
  const suppressed = (channelId: ChannelId, message: Message): boolean => {
    if (deps.getSelectedId() !== channelId || !env.isVisible() || !env.hasFocus()) return false
    const thread = deps.getThreadOnScreen?.()
    return thread === undefined || message.threadParent === thread
  }

  // The click opens where the message is: a thread reply's thread on the reply (ADR-073 addendum,
  // 2026-11-23); a message of the conversation only selects the channel (dec. 4).
  const show = (channelId: ChannelId, message: Message, title: string, body: string): void => {
    if (disposed) return
    const data: NotificationData = { conversation: String(channelId), message: String(message.id) }
    if (message.threadParent !== undefined) data.thread = String(message.threadParent)
    const clickable = (handle: NotificationHandle | undefined): void => {
      if (!handle) return
      handle.onclick = () => {
        env.focusWindow()
        if (message.threadParent !== undefined) deps.jumpTo(channelId, message)
        else deps.select(channelId)
        handle.close()
      }
    }
    const shown = env.notify(title, { body, tag: String(channelId), data })
    if (shown instanceof Promise) void shown.then(clickable, () => undefined)
    else clickable(shown)
  }

  // `body` overrides the preview (the expired-UTD DM of dec. 2).
  const notify = (channelId: ChannelId, message: Message, body?: string): void => {
    const channel = deps.getChannel(channelId)
    if (!channel || channel.archived) return
    if (body === undefined && !shouldNotify(message, channel)) return
    if (env.permission() !== 'granted' || suppressed(channelId, message)) return
    const text = body ?? previewOf(message.body)
    if (channel.kind === 'dm') {
      show(channelId, message, channel.peerAgent ? t('notifications.titleDmAgent', { name: channel.name }) : channel.name, text)
      return
    }
    void namesOf(channelId).then((byId) => {
      const user = byId.get(message.author)
      const author = user?.displayName.trim()
      const agent = user?.kind === 'agent'
      // ADR-094 dec. 10 (PLANO-CONVERSAS §0.3.4 item 2): a group's name holds the author, so its title
      // says "in a group conversation" instead.
      const group = channel.kind === 'group'
      const title = !author
        ? channel.name
        : group
          ? t(agent ? 'notifications.titleInGroupAgent' : 'notifications.titleInGroup', { author })
          : agent
            ? t('notifications.titleInAgent', { author, channel: channel.name })
            : t('notifications.titleIn', { author, channel: channel.name })
      show(channelId, message, title, text)
    })
  }

  // Dec. 2, expiry (the timer only): a DM or a group (ADR-094 dec. 10) still notifies, generically; a
  // channel cannot know if it was mentioned. The entry is gone, so content arriving later does not notify
  // a second time.
  const expire = (id: MessageId, entry: Pending, message: Message): void => {
    pending.delete(id)
    env.clearTimeout(entry.timer)
    const channel = deps.getChannel(entry.channelId)
    if (channel && everyMessage(channel)) notify(entry.channelId, message, t('notifications.generic'))
  }

  const handle = (e: DomainEvent): void => {
    if (disposed) return
    if (e.t === 'message.received') {
      const message = e.message
      if (message.mine) return
      if (message.body.kind === 'unavailable') {
        if (pending.has(message.id)) return
        const entry: Pending = { channelId: e.channelId, timer: undefined }
        entry.timer = env.setTimeout(() => {
          if (pending.get(message.id) === entry) expire(message.id, entry, message)
        }, UTD_WAIT_MS)
        pending.set(message.id, entry)
        return
      }
      notify(e.channelId, message)
    } else if (e.t === 'message.edited') {
      const entry = pending.get(e.message.id)
      if (!entry) return
      // Still without content (only its arrival grade moved): keep waiting.
      if (e.message.body.kind === 'unavailable') return
      pending.delete(e.message.id)
      env.clearTimeout(entry.timer)
      notify(entry.channelId, e.message)
    } else if (e.t === 'member.changed') {
      names.delete(e.channelId)
    } else if (e.t === 'channel.removed') {
      names.delete(e.channelId)
    }
  }

  const dispose = (): void => {
    disposed = true
    for (const entry of pending.values()) env.clearTimeout(entry.timer)
    pending.clear()
    names.clear()
  }

  return { handle, dispose }
}
