import { tIn, type Key } from '../ui/i18n/catalog'
import { APP_NAME } from '../ui/i18n/constants'
import { activeLocaleOf, deviceLocale, type Locale } from '../ui/i18n/locale'
import { clip } from '../ui/preview-text'
import type { ClickTarget } from './store'

// ADR-117 dec. 4 and 5, pure: the push service's JSON → what the notification says, and whether to show it at all
// (fork S3). The copy is the live tab's catalog in the language the page wrote for the worker; no identifier ever
// reaches a title or a body (P1) — the ids travel only in the notification's data and tag.

export interface PushPayload {
  kind: 'direct' | 'group' | 'channel'
  invite: boolean
  conversation: string
  message: string
  thread?: string
  author: string
  channelName?: string
  body?: { type: string; text?: string }
  agent: boolean
}

export interface Shown {
  title: string
  body: string
  data?: ClickTarget
}

export interface WindowState {
  focused: boolean
  visible: boolean
}

// A notification already on screen under the push's tag.
export interface Existing {
  title: string
  body: string
  data: unknown
}

const KINDS = new Set(['direct', 'group', 'channel'])
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

// Only `v: 1` with a conversation is a push of ours; anything else shows the generic notification.
export function parsePayload(raw: unknown): PushPayload | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const p = raw as Record<string, unknown>
  const conversation = str(p.conversation)
  if (p.v !== 1 || !conversation) return undefined
  const body = typeof p.body === 'object' && p.body !== null ? (p.body as Record<string, unknown>) : undefined
  return {
    kind: KINDS.has(p.kind as string) ? (p.kind as PushPayload['kind']) : 'channel',
    invite: p.invite === true,
    conversation,
    message: str(p.message) ?? '',
    thread: str(p.thread) || undefined,
    author: (str(p.author) ?? '').trim(),
    channelName: str(p.channelName)?.trim() || undefined,
    body: body && typeof body.type === 'string' ? { type: body.type, text: str(body.text) } : undefined,
    agent: p.agent === true,
  }
}

// The language the page wrote, else the device's (resolveLocale's rule without the page's localStorage).
export function workerLanguage(stored: string | undefined): Locale {
  return activeLocaleOf(stored) ?? deviceLocale()
}

function bodyOf(p: PushPayload, locale: Locale): string {
  const t = (key: Key, params?: Record<string, string>): string => tIn(locale, key, params)
  if (p.kind !== 'channel' || p.invite || !p.body) return t('notifications.generic')
  const text = p.body.text ?? ''
  switch (p.body.type) {
    case 'text':
      return clip(text)
    case 'approval':
      return t('notifications.approvalRequest', { text: clip(text.trim().split('\n')[0] ?? '') })
    case 'image':
      return t('notifications.image')
    case 'file':
      return t('notifications.file')
    default:
      return t('notifications.unsupported')
  }
}

function titleOf(p: PushPayload, locale: Locale): string {
  const t = (key: Key, params?: Record<string, string>): string => tIn(locale, key, params)
  const author = p.author
  // Fork 8: without the sender's name, a channel says its name; a direct conversation and a group say "New message".
  if (!author) return p.kind === 'channel' && p.channelName ? p.channelName : t('notifications.generic')
  if (p.kind === 'direct') return p.agent ? t('notifications.titleDmAgent', { name: author }) : author
  if (p.kind === 'group') return t(p.agent ? 'notifications.titleInGroupAgent' : 'notifications.titleInGroup', { author })
  if (!p.channelName) return author
  return t(p.agent ? 'notifications.titleInAgent' : 'notifications.titleIn', { author, channel: p.channelName })
}

export function compose(p: PushPayload | undefined, locale: Locale): Shown {
  if (!p) return { title: APP_NAME, body: tIn(locale, 'notifications.generic') }
  const data: ClickTarget = { conversation: p.conversation }
  if (p.message) data.message = p.message
  if (p.thread) data.thread = p.thread
  return { title: titleOf(p, locale), body: bodyOf(p, locale), data }
}

// Fork S3: a visible and focused window of the app → nothing; the notification of this very message already there
// (the live tab's, with the content it decrypted) → shown again as it is; else the push's own.
export function decide(p: PushPayload | undefined, windows: WindowState[], existing: Existing[], locale: Locale): Shown | undefined {
  if (windows.some((w) => w.visible && w.focused)) return undefined
  const same = p?.message ? existing.find((n) => (n.data as { message?: unknown } | null)?.message === p.message) : undefined
  if (same) return { title: same.title, body: same.body, data: same.data as ClickTarget | undefined }
  return compose(p, locale)
}
