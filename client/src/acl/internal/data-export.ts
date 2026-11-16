import {
  ConnectionError,
  createExportBuilder,
  EXPORT_MANIFEST_PATH,
  readExportManifest,
  type Channel,
  type ExportConversationKind,
  type ExportItemInput,
  type ExportPersonInput,
  type ExportPersonKind,
  type MediaRef,
  type Message,
} from '@tayet/shared'
import { EDIT_REDACTION_FIELD, RESPONSE_REL_TYPE, genuineReplyTarget, userIdToRaw } from '@tayet/shared/internal'
import type { DataExportOptions, DataExportPart } from '../types'

// ADR-096: the export of one person's data, in the open format of shared/src/export. Pure: the gateway
// supplies the ports (conversations, the person's own events page by page, decryption, translation, the
// author of a card, media bytes, the clock), so the policy is unit-testable without the SDK — the mould of
// search-backfill.ts (PLANO-EXPORT-DADOS §0.3.5 item 8).
//
// Per conversation: walk backwards through the person's own events only (§0.3.3 B1), pages of
// EXPORT_PAGE_SIZE, to the start; classify the raw events before any translation (deleted markers, edits,
// answers to cards); wait a bounded time for keys that may still arrive (A7); then hand the builder one
// item at a time, fetching each attachment as it goes (E2). Every key handed to the builder is a raw id:
// it only correlates and is never written (the builder's rule).
//
// Failures (§0.3.5 item 4): a request that gets no answer from the server is repeated with a wait, and
// EXPORT_OFFLINE_WINDOW_MS of failed tries in a row ends the export with ConnectionError. The window starts at
// the first failure of a run and resets on any successful request; the time between requests does not count.
// A rate limit waits the time the server gave, inside the same window. An attachment gets
// EXPORT_ATTACHMENT_ATTEMPTS tries for a failure with an answer (or a failed decryption), then it is
// missing.

export const EXPORT_PAGE_SIZE = 100
// A7: the wait for keys that may still arrive, per conversation and summed over the export.
export const EXPORT_KEY_WAIT_PER_CONVERSATION_MS = 5_000
export const EXPORT_KEY_WAIT_TOTAL_MS = 60_000
// E3: tries per attachment for a failure with an answer from the server, or a failed decryption.
export const EXPORT_ATTACHMENT_ATTEMPTS = 2
export const EXPORT_ATTACHMENT_RETRY_WAIT_MS = 1_000
// G2: this long of failed tries in a row, counted from the first failure of the run, ends the export.
export const EXPORT_OFFLINE_WINDOW_MS = 120_000
// The wait before repeating a request that got no answer: doubles from the first to the last.
export const EXPORT_RETRY_FIRST_MS = 1_000
export const EXPORT_RETRY_LAST_MS = 8_000
// A rate limit that does not say how long (the backfill's default).
export const EXPORT_RATE_LIMIT_DEFAULT_MS = 5_000
// How often a wait re-checks for cancellation and for the session.
export const EXPORT_WAIT_SLICE_MS = 250

const ENVELOPE_MESSAGE = new Set(['m.room.message', 'm.room.encrypted'])

/** One raw event of the person, as the engine reads it. Every id here is raw and stays in the ACL. */
export interface ExportEventView {
  /** The event's own id (never the transaction id). */
  id: string
  /** The envelope type: `m.room.encrypted` for an encrypted event, decrypted or not. */
  type: string
  sentAt: number
  redacted: boolean
  /** Set while the event cannot be read: 'awaited' may still arrive, 'stalled' will not by waiting. */
  undecrypted?: 'awaited' | 'stalled'
  stateKey?: string
  /** The content as it travels: relations are in clear here even on an encrypted event. */
  wire: Record<string, unknown>
  /** The readable original content; absent while undecrypted. */
  content?: Record<string, unknown>
  /** The target of a redaction given at the top of the event (H5). */
  redacts?: string
  /** The product's own message types that never become a line (an answer to a card, a panel, a manifest). */
  folded?: 'response' | 'panel' | 'commands'
}

/** How the engine treats a failed request. */
export type ExportFailure = { kind: 'connection' } | { kind: 'rateLimit'; waitMs?: number } | { kind: 'other' }

export interface DataExportAccount {
  subject: ExportPersonInput
  profile: {
    fullName: string
    nickname?: string
    pronouns?: string
    note?: string
    jobTitle?: string
    workEmail?: string
    avatar?: MediaRef
  }
  /** `name` as the account has it; empty → the generic copy of the options. */
  accesses: Array<{ name: string; lastSeenAt?: number; current: boolean }>
  agents: ExportPersonInput[]
}

export interface DataExportPorts<E> {
  /** Holds the search backfill back; the returned function lets go (§0.3.5 item 3). */
  hold(): () => void
  /** false once the session that started the export is gone (signed out, replaced). */
  alive(): boolean
  /** Active conversations, then archived ones, in the order of the product's lists. `key` is raw. */
  conversations(): Array<{ key: string; channel: Channel }>
  account(): Promise<DataExportAccount>
  /** One page of the person's own events, newest first; `end` absent = the start was reached. */
  page(conversation: string, from: string | undefined, signal: AbortSignal | undefined): Promise<{ events: E[]; end?: string }>
  /** Settles the decryption of a page (failures included; never rejects). */
  decrypt(events: E[]): Promise<void>
  view(event: E): ExportEventView
  /** The message as the product shows it, with `edit` applied when given. Never feeds the search index. */
  translate(conversation: string, target: E, edit: E | undefined): Message | null
  /**
   * The sender of a card: what the session has, else the envelope from the server. undefined = unreadable,
   * only when the server says the card is not found or not allowed; any other failure rejects as is.
   */
  cardAuthor(conversation: string, cardId: string, signal: AbortSignal | undefined): Promise<string | undefined>
  /** Name and kind from the conversation's own state; undefined when it has no name. */
  person(conversation: string, key: string): { name: string; kind: ExportPersonKind } | undefined
  media(ref: MediaRef, signal: AbortSignal | undefined): Promise<Blob>
  /** The media descriptor's type, when known. */
  mediaType(ref: MediaRef): string | undefined
  classify(err: unknown): ExportFailure
  now(): number
  sleep(ms: number): Promise<void>
}

type Relation = { rel_type?: unknown; event_id?: unknown }

function relationOf(v: ExportEventView): Relation | undefined {
  const r = (v.wire['m.relates_to'] ?? v.content?.['m.relates_to']) as Relation | undefined
  return r && typeof r === 'object' ? r : undefined
}

function conversationKind(channel: Channel): ExportConversationKind {
  return channel.kind
}

// §0.3.5 item 7: the name without the mark of its kind; a group with nobody else stays ''.
function conversationName(channel: Channel): string {
  return channel.kind === 'public' || channel.kind === 'private' ? channel.name.replace(/^#/, '') : channel.name
}

// One planned item of a conversation, before its attachment is fetched.
type Planned =
  | { kind: 'ready'; item: ExportItemInput }
  | { kind: 'attachment'; item: Extract<ExportItemInput, { type: 'message' }>; ref: MediaRef; bodySize: number | undefined }

export async function* runDataExport<E>(p: DataExportPorts<E>, opts: DataExportOptions): AsyncGenerator<DataExportPart, void, undefined> {
  const signal = opts.signal
  const release = p.hold()
  try {
    const step = (): void => {
      if (signal?.aborted) throw signal.reason
      if (!p.alive()) throw new Error('export: the session ended')
    }
    const sleep = async (ms: number): Promise<void> => {
      for (let left = ms; left > 0; left -= EXPORT_WAIT_SLICE_MS) {
        step()
        await p.sleep(Math.min(left, EXPORT_WAIT_SLICE_MS))
      }
      step()
    }

    // G2 over every request of the export: the window counts from the first failure of the current run of
    // failures and resets on any success, so time spent between requests never eats it.
    let failingSince: number | undefined
    const request = async <T>(work: () => Promise<T>): Promise<T> => {
      let backoff = EXPORT_RETRY_FIRST_MS
      for (;;) {
        step()
        try {
          const out = await work()
          failingSince = undefined
          return out
        } catch (err) {
          step()
          const failure = p.classify(err)
          if (failure.kind === 'other') throw err
          failingSince ??= p.now()
          const idle = p.now() - failingSince
          if (idle >= EXPORT_OFFLINE_WINDOW_MS) throw new ConnectionError()
          let wait: number
          if (failure.kind === 'rateLimit') wait = failure.waitMs ?? EXPORT_RATE_LIMIT_DEFAULT_MS
          else {
            wait = backoff
            backoff = Math.min(backoff * 2, EXPORT_RETRY_LAST_MS)
          }
          await sleep(Math.max(EXPORT_WAIT_SLICE_MS, Math.min(wait, EXPORT_OFFLINE_WINDOW_MS - idle)))
        }
      }
    }

    // E3 on top of G2: a failure with an answer (or a failed decryption) spends a try; no answer does not.
    const fetchMedia = async (ref: MediaRef): Promise<Blob | undefined> => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await request(() => p.media(ref, signal))
        } catch (err) {
          step()
          if (p.classify(err).kind !== 'other') throw err // the window ran out
          if (attempt >= EXPORT_ATTACHMENT_ATTEMPTS) return undefined
          await sleep(EXPORT_ATTACHMENT_RETRY_WAIT_MS)
        }
      }
    }

    const account = await request(() => p.account())
    const conversations = p.conversations()
    step()

    // Fork 6: the picture is obtained before the builder exists; not obtained = the profile goes without it.
    const avatarRef = account.profile.avatar
    const avatar = avatarRef ? await fetchMedia(avatarRef) : undefined
    const builder = createExportBuilder({
      createdAt: p.now(),
      subject: account.subject,
      profile: {
        fullName: account.profile.fullName,
        nickname: account.profile.nickname,
        pronouns: account.profile.pronouns,
        note: account.profile.note,
        jobTitle: account.profile.jobTitle,
        workEmail: account.profile.workEmail,
        ...(avatar && avatarRef && { avatar: { mimetype: p.mediaType(avatarRef) ?? (avatar.type || 'application/octet-stream') } }),
      },
      accesses: account.accesses.map((a) => ({
        name: a.name.trim() === '' ? opts.unnamedAccess : a.name,
        lastSeenAt: a.lastSeenAt,
        current: a.current,
      })),
      agents: account.agents,
    })

    const me = account.subject.key
    const total = conversations.length
    yield { t: 'progress', done: 0, total }

    let keyWaitSpent = 0
    const cardAuthors = new Map<string, Promise<string | undefined>>()

    for (const [index, { key, channel }] of conversations.entries()) {
      // 1. The person's own events, to the start of the conversation, each page decrypted as it arrives.
      const events: E[] = []
      let from: string | undefined
      for (;;) {
        const page = await request(() => p.page(key, from, signal))
        step()
        await p.decrypt(page.events)
        events.push(...page.events)
        if (page.end === undefined || page.end === from) break
        from = page.end
      }
      step()

      // 2–3. Classification over the raw events, before any translation.
      const views = new Map<E, ExportEventView>(events.map((e) => [e, p.view(e)]))
      let joinedAt: number | undefined
      const editRedacted = new Set<string>()
      for (const v of views.values()) {
        if (v.type === 'm.room.member' && v.stateKey === me && v.content?.membership === 'join') {
          if (joinedAt === undefined || v.sentAt < joinedAt) joinedAt = v.sentAt
        }
        if (v.type === 'm.room.redaction' && !v.redacted && v.content?.[EDIT_REDACTION_FIELD] === true) {
          const target = v.redacts ?? v.content.redacts
          if (typeof target === 'string') editRedacted.add(target)
        }
      }

      const deleted: ExportItemInput[] = []
      const messages: E[] = []
      const responses: E[] = []
      const edits = new Map<string, E[]>()
      for (const [e, v] of views) {
        if (!ENVELOPE_MESSAGE.has(v.type)) continue
        if (v.redacted) {
          if (!editRedacted.has(v.id)) deleted.push({ type: 'deleted', key: v.id, sentAt: v.sentAt })
          continue
        }
        const rel = relationOf(v)
        if (rel?.rel_type === 'm.replace') {
          if (typeof rel.event_id === 'string') edits.set(rel.event_id, [...(edits.get(rel.event_id) ?? []), e])
          continue
        }
        if (v.folded === 'response') responses.push(e)
        else if (v.folded === undefined) messages.push(e)
      }
      // A live edit applies to a live message of the person in this walk, the most recent one only; an
      // edit of a deleted or absent message is dropped.
      const latestEdit = new Map<E, E>()
      for (const e of messages) {
        const own = edits.get(views.get(e)!.id)
        if (!own) continue
        latestEdit.set(e, own.reduce((a, b) => (views.get(b)!.sentAt >= views.get(a)!.sentAt ? b : a)))
      }

      // 5. A7: wait only when something of this conversation may still arrive.
      const awaited = (): boolean =>
        [...messages, ...responses, ...latestEdit.values()].some((e) => {
          const v = p.view(e)
          return v.undecrypted === 'awaited'
        })
      if (keyWaitSpent < EXPORT_KEY_WAIT_TOTAL_MS && awaited()) {
        const budget = Math.min(EXPORT_KEY_WAIT_PER_CONVERSATION_MS, EXPORT_KEY_WAIT_TOTAL_MS - keyWaitSpent)
        const start = p.now()
        while (p.now() - start < budget && awaited()) await sleep(EXPORT_WAIT_SLICE_MS)
        keyWaitSpent += Math.min(budget, p.now() - start)
      }

      // The items, from a fresh look at each event (a key may have arrived).
      const planned: Planned[] = deleted.map((item) => ({ kind: 'ready', item }))
      const unreadable = (v: ExportEventView): Planned => ({ kind: 'ready', item: { type: 'unreadable', key: v.id, sentAt: v.sentAt } })

      for (const e of messages) {
        const v = p.view(e)
        const edit = latestEdit.get(e)
        if (v.undecrypted || (edit && p.view(edit).undecrypted)) {
          planned.push(unreadable(v)) // fork 5: never the earlier version
          continue
        }
        const msg = p.translate(key, e, edit)
        if (!msg) continue
        const body = msg.body
        if (body.kind === 'unavailable') {
          planned.push(unreadable(v))
          continue
        }
        if (body.kind !== 'text' && body.kind !== 'image' && body.kind !== 'file') {
          planned.push({ kind: 'ready', item: { type: 'unsupported', key: v.id, sentAt: v.sentAt } })
          continue
        }
        const rel = relationOf(v)
        const threadRoot = rel?.rel_type === 'm.thread' && typeof rel.event_id === 'string' ? rel.event_id : undefined
        const replyTo = genuineReplyTarget({ 'm.relates_to': rel })
        const mentions = (msg.mentions ?? []).flatMap((u) => {
          const raw = userIdToRaw(u)
          const who = p.person(key, raw)
          return who ? [{ key: raw, name: who.name, kind: who.kind }] : []
        })
        const item: Extract<ExportItemInput, { type: 'message' }> = {
          type: 'message',
          key: v.id,
          sentAt: v.sentAt,
          ...(edit && { editedAt: p.view(edit).sentAt }),
          text: body.kind === 'text' ? body.text : '',
          ...(body.kind === 'text' && body.rich && { rich: body.rich }),
          ...(mentions.length > 0 && { mentions }),
          ...(threadRoot !== undefined && { threadRoot }),
          ...(replyTo !== undefined && { replyTo }),
        }
        if (body.kind === 'text') {
          planned.push({ kind: 'ready', item })
        } else if (body.kind === 'image') {
          const name = body.alt || 'image'
          planned.push({ kind: 'attachment', item: { ...item, attachment: { name, mimetype: '', available: false } }, ref: body.media, bodySize: undefined })
        } else {
          planned.push({
            kind: 'attachment',
            item: { ...item, attachment: { name: body.name, mimetype: body.mimetype, available: false } },
            ref: body.media,
            bodySize: body.size > 0 ? body.size : undefined,
          })
        }
      }

      for (const e of responses) {
        const v = p.view(e)
        const option = v.content?.body
        const cardId = relationOf(v)?.event_id
        if (v.undecrypted || typeof option !== 'string' || typeof cardId !== 'string' || relationOf(v)?.rel_type !== RESPONSE_REL_TYPE) {
          planned.push(unreadable(v))
          continue
        }
        let author = cardAuthors.get(cardId)
        if (!author) {
          author = request(() => p.cardAuthor(key, cardId, signal))
          cardAuthors.set(cardId, author)
        }
        const sender = await author
        const who = sender === undefined ? undefined : p.person(key, sender)
        if (sender === undefined || !who) {
          planned.push(unreadable(v))
          continue
        }
        planned.push({
          kind: 'ready',
          item: { type: 'approvalResponse', key: v.id, sentAt: v.sentAt, option, requestedBy: { key: sender, name: who.name, kind: who.kind } },
        })
      }

      // 6. One conversation in the builder, in the order the items were sent (the walk came newest first,
      // and the builder numbers items in the order it receives them), one attachment at a time.
      planned.sort((a, b) => a.item.sentAt - b.item.sentAt)
      const writer = builder.openConversation({
        key,
        name: conversationName(channel),
        kind: conversationKind(channel),
        ...(joinedAt !== undefined && { joinedAt }),
      })
      for (const entry of planned) {
        if (entry.kind === 'ready') {
          writer.add(entry.item)
          continue
        }
        const data = await fetchMedia(entry.ref)
        const declared = entry.item.attachment!
        const mimetype = declared.mimetype || p.mediaType(entry.ref) || data?.type || 'application/octet-stream'
        const size = entry.bodySize ?? data?.size
        const path = writer.add({
          ...entry.item,
          attachment: { name: declared.name, mimetype, ...(size !== undefined && { size }), available: data !== undefined },
        })
        if (data && path) yield { t: 'attachment', path, data }
      }
      const file = writer.close()
      yield { t: 'file', path: file.path, content: file.content }
      yield { t: 'progress', done: index + 1, total }
    }

    if (avatar && builder.avatarPath) yield { t: 'attachment', path: builder.avatarPath, data: avatar }
    const files = builder.finish(opts.readme)
    for (const f of files) yield { t: 'file', path: f.path, content: f.content }

    // The totals and the gaps are the manifest's, matched to the conversations by the order they were opened.
    const manifest = readExportManifest(files.find((f) => f.path === EXPORT_MANIFEST_PATH)!.content)
    const incomplete = manifest.conversations.flatMap((c, i) => {
      const channel = conversations[i]?.channel
      return c.gaps > 0 && channel ? [{ channel, gaps: c.gaps }] : []
    })
    yield { t: 'done', totals: { ...manifest.totals }, incomplete }
  } finally {
    release()
  }
}
