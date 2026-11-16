// Incremental, pure builder of a format-v1 export (ADR-096 dec. 2, 3, 4, 5, 7 and 8). No I/O: it takes
// the person's data, then one conversation at a time, and hands back each file as a path plus its text.
// Attachment bytes never pass through here: `add` returns the path the caller writes them at.
//
// Memory: closing a conversation drops its items; the builder keeps only the person registry and one
// summary line per conversation, so a caller never has to hold the whole export.
//
// Identifiers: `p<n>`, `c<n>`, `m<n>` in the order the builder first sees each person, conversation and
// message. The caller's keys only correlate; none of them is ever written, and no error message carries
// one (a key is a protocol identifier at runtime).
//
// Bytes: every object is built in a fixed key order and serialized with two-space indentation and one
// final newline; instants are ISO 8601 UTC. The same input yields the same bytes.

import type { RichBlock, RichDoc, RichInline } from '../domain'
import { extensionForMimetype, sanitizeExportFileName } from './file-name'
import {
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
  type ExportAccount,
  type ExportAttachment,
  type ExportConversationEntry,
  type ExportConversationFile,
  type ExportConversationInput,
  type ExportCounts,
  type ExportFile,
  type ExportItem,
  type ExportItemInput,
  type ExportManifest,
  type ExportPersonEntry,
  type ExportPersonInput,
  type ExportProfile,
  type ExportStartInput,
} from './types'

/** Writes one conversation file. Obtained from `ExportBuilder.openConversation`. */
export interface ExportConversationWriter {
  /** The conversation's synthetic id (`c<n>`). */
  readonly id: string
  /**
   * Adds one item. Returns the path to write the attachment bytes at when the item is a message with an
   * available attachment; undefined otherwise.
   */
  add(item: ExportItemInput): string | undefined
  /** Closes the conversation and returns its file. The conversation's items are released. */
  close(): ExportFile
}

export interface ExportBuilder {
  /** Where to write the profile picture, when the profile has one. */
  readonly avatarPath: string | undefined
  openConversation(conversation: ExportConversationInput): ExportConversationWriter
  /**
   * Ends the export and returns `README.txt`, `manifest.json` and `account.json`, in that order. The
   * README text is the caller's (it is product copy, not format) and must not be empty. Every
   * conversation must be closed first.
   */
  finish(readme: string): ExportFile[]
}

export const EXPORT_README_PATH = 'README.txt'
export const EXPORT_MANIFEST_PATH = 'manifest.json'
export const EXPORT_ACCOUNT_PATH = 'account.json'

function serialize(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n'
}

function iso(ms: number): string {
  if (!Number.isFinite(ms)) throw new TypeError('export: an instant is not a finite number')
  return new Date(ms).toISOString()
}

function requireKey(key: unknown, what: string): string {
  if (typeof key !== 'string' || key === '') throw new TypeError(`export: ${what} needs a non-empty key`)
  return key
}

// RichDoc rebuilt node by node in a fixed key order: the output does not depend on the key order of
// the caller's objects, and nothing outside the node set reaches the file.
function canonicalInline(n: RichInline): RichInline {
  switch (n.t) {
    case 'text':
      return { t: 'text', text: n.text }
    case 'code':
      return { t: 'code', text: n.text }
    case 'strong':
    case 'em':
    case 'strike':
      return { t: n.t, children: n.children.map(canonicalInline) }
    case 'link':
      return { t: 'link', href: n.href, children: n.children.map(canonicalInline) }
  }
}

function canonicalBlock(b: RichBlock): RichBlock {
  switch (b.t) {
    case 'p':
      return { t: 'p', children: b.children.map(canonicalInline) }
    case 'ul':
    case 'ol':
      return { t: b.t, items: b.items.map((item) => item.map(canonicalBlock)) }
    case 'quote':
      return { t: 'quote', children: b.children.map(canonicalBlock) }
    case 'codeblock':
      return b.lang === undefined ? { t: 'codeblock', text: b.text } : { t: 'codeblock', text: b.text, lang: b.lang }
  }
}

function canonicalRich(doc: RichDoc): RichDoc {
  return doc.map(canonicalBlock)
}

function emptyCounts(): ExportCounts {
  return { messages: 0, deleted: 0, attachments: 0, gaps: 0 }
}

// An item before its references are resolved. A message keeps its fields apart and is assembled at
// close, in the format's key order, once every item of the conversation is known.
type PendingItem =
  | { kind: 'ready'; sentAt: number; item: ExportItem }
  | {
      kind: 'message'
      sentAt: number
      head: { type: 'message'; id: string; sentAt: string }
      editedAt?: string
      text: string
      rich?: RichDoc
      mentions?: string[]
      attachment?: ExportAttachment
      threadRootKey?: string
      replyToKey?: string
    }

function opt<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V }
}

/** Opens a format-v1 export of one person. */
export function createExportBuilder(start: ExportStartInput): ExportBuilder {
  const createdAt = iso(start.createdAt)
  const people = new Map<string, ExportPersonEntry>()
  const conversationKeys = new Set<string>()
  // One summary line per conversation, indexed by open order; filled at close.
  const entries: (ExportConversationEntry | undefined)[] = []
  let openCount = 0
  let messageCount = 0
  let finished = false

  function person(who: ExportPersonInput): string {
    const key = requireKey(who.key, 'a person')
    const known = people.get(key)
    if (known) return known.id
    const entry: ExportPersonEntry = { id: `p${people.size + 1}`, name: who.name, kind: who.kind }
    people.set(key, entry)
    return entry.id
  }

  const p = start.profile
  if (typeof p.fullName !== 'string' || p.fullName === '') throw new TypeError('export: the profile needs a full name')

  const subject = person(start.subject)
  const agents = start.agents.map((a) => ({ person: person(a) }))

  const avatarExt = p.avatar ? extensionForMimetype(p.avatar.mimetype) : undefined
  const avatarPath = p.avatar ? `attachments/account/avatar${avatarExt ? `.${avatarExt}` : ''}` : undefined

  const profile: ExportProfile = {
    fullName: p.fullName,
    ...opt('nickname', p.nickname),
    ...opt('pronouns', p.pronouns),
    ...opt('note', p.note),
    ...opt('jobTitle', p.jobTitle),
    ...opt('workEmail', p.workEmail),
    ...opt('avatar', avatarPath),
  }
  const account: ExportAccount = {
    formatVersion: EXPORT_FORMAT_VERSION,
    profile,
    accesses: start.accesses.map((a) => ({
      name: a.name,
      ...opt('lastSeenAt', a.lastSeenAt === undefined ? undefined : iso(a.lastSeenAt)),
      current: a.current,
    })),
    agents,
  }

  function openConversation(input: ExportConversationInput): ExportConversationWriter {
    if (finished) throw new Error('export: the export is already finished')
    const key = requireKey(input.key, 'a conversation')
    if (conversationKeys.has(key)) throw new Error('export: a conversation was opened twice')
    conversationKeys.add(key)

    const slot = entries.length
    entries.push(undefined)
    openCount += 1
    const id = `c${slot + 1}`
    const file = `conversations/${id}.json`
    const joinedAt = input.joinedAt === undefined ? undefined : iso(input.joinedAt)

    let pending: PendingItem[] = []
    const ids = new Map<string, string>() // item key → m<n>, this conversation only
    const counts = emptyCounts()
    let closed = false

    function add(item: ExportItemInput): string | undefined {
      if (closed) throw new Error('export: the conversation is already closed')
      const itemKey = requireKey(item.key, 'an item')
      if (ids.has(itemKey)) throw new Error('export: an item was added twice to a conversation')
      messageCount += 1
      const mid = `m${messageCount}`
      ids.set(itemKey, mid)
      const sentAt = iso(item.sentAt)

      switch (item.type) {
        case 'deleted':
        case 'unreadable':
        case 'unsupported':
          if (item.type === 'deleted') counts.deleted += 1
          if (item.type === 'unreadable') counts.gaps += 1
          pending.push({ kind: 'ready', sentAt: item.sentAt, item: { type: item.type, id: mid, sentAt } })
          return undefined
        case 'approvalResponse':
          counts.messages += 1
          pending.push({
            kind: 'ready',
            sentAt: item.sentAt,
            item: { type: 'approvalResponse', id: mid, sentAt, option: item.option, requestedBy: person(item.requestedBy) },
          })
          return undefined
        case 'message': {
          counts.messages += 1
          let attachment: ExportAttachment | undefined
          let path: string | undefined
          const a = item.attachment
          if (a?.available) {
            path = `attachments/${id}/${mid}-${sanitizeExportFileName(a.name, a.mimetype)}`
            attachment = { file: path, name: a.name, mimetype: a.mimetype, ...opt('size', a.size) }
            counts.attachments += 1
          } else if (a) {
            attachment = { name: a.name, mimetype: a.mimetype, ...opt('size', a.size), missing: true }
            counts.gaps += 1
          }
          const mentions = item.mentions?.map(person)
          pending.push({
            kind: 'message',
            sentAt: item.sentAt,
            head: { type: 'message', id: mid, sentAt },
            editedAt: item.editedAt === undefined ? undefined : iso(item.editedAt),
            text: item.text,
            rich: item.rich === undefined ? undefined : canonicalRich(item.rich),
            mentions: mentions !== undefined && mentions.length > 0 ? mentions : undefined,
            attachment,
            threadRootKey: item.threadRoot,
            replyToKey: item.replyTo,
          })
          return path
        }
      }
    }

    function close(): ExportFile {
      if (closed) throw new Error('export: the conversation is already closed')
      closed = true
      // Stable sort: ties keep the order the items came in.
      const ordered = pending
        .map((entry, i) => ({ entry, i }))
        .sort((x, y) => x.entry.sentAt - y.entry.sentAt || x.i - y.i)
        .map(({ entry }) => entry)

      const items: ExportItem[] = ordered.map((e) => {
        if (e.kind === 'ready') return e.item
        // A reference survives only when its target is the person's own item in this file; otherwise
        // only the flag remains.
        return {
          ...e.head,
          ...opt('editedAt', e.editedAt),
          text: e.text,
          ...opt('rich', e.rich),
          ...opt('mentions', e.mentions),
          ...opt('attachment', e.attachment),
          inThread: e.threadRootKey !== undefined,
          ...opt('threadRoot', e.threadRootKey === undefined ? undefined : ids.get(e.threadRootKey)),
          isReply: e.replyToKey !== undefined,
          ...opt('replyTo', e.replyToKey === undefined ? undefined : ids.get(e.replyToKey)),
        }
      })

      const out: ExportConversationFile = { formatVersion: EXPORT_FORMAT_VERSION, conversation: id, items }
      entries[slot] = { id, file, name: input.name, kind: input.kind, ...opt('joinedAt', joinedAt), ...counts }
      openCount -= 1
      pending = []
      ids.clear()
      return { path: file, content: serialize(out) }
    }

    return { id, add, close }
  }

  function finish(readme: string): ExportFile[] {
    if (finished) throw new Error('export: the export is already finished')
    if (typeof readme !== 'string' || readme.trim() === '') throw new TypeError('export: the README text is required')
    if (openCount > 0) throw new Error('export: a conversation is still open')
    finished = true

    const conversations = entries.filter((e): e is ExportConversationEntry => e !== undefined)
    const totals = { conversations: conversations.length, ...emptyCounts() }
    for (const c of conversations) {
      totals.messages += c.messages
      totals.deleted += c.deleted
      totals.attachments += c.attachments
      totals.gaps += c.gaps
    }
    const manifest: ExportManifest = {
      format: EXPORT_FORMAT,
      formatVersion: EXPORT_FORMAT_VERSION,
      scope: 'person',
      createdAt,
      subject,
      people: [...people.values()].map((x) => ({ id: x.id, name: x.name, kind: x.kind })),
      conversations,
      totals,
    }
    return [
      { path: EXPORT_README_PATH, content: readme.endsWith('\n') ? readme : readme + '\n' },
      { path: EXPORT_MANIFEST_PATH, content: serialize(manifest) },
      { path: EXPORT_ACCOUNT_PATH, content: serialize(account) },
    ]
  }

  return { avatarPath, openConversation, finish }
}
