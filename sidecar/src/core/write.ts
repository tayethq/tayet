// Write path of the sidecar core (ADR-087 dec. 7; PLANO-AGENTES §0.3.7): the tokenized facade the local
// API's write routes call — the mirror of the read facade (core/read.ts). It takes conversation tokens
// (`C…`/`D…`), message `ts`, person tokens (`U…`) and file tokens (`F…`), resolves them through the read
// side's reverse lookups (one Resolver, so a token the API handed out resolves the same way here), and
// hands raw ids to the queue (core/queue.ts) and the gateway (core/send.ts). What it returns is
// tokenized: src/api/** never sees a protocol id.
//
// - Every write effect is a job of the single queue (§0.3.7 item 4): text, edit, removal, reaction,
//   and the message of an attachment. The upload of the bytes is OUTSIDE the queue (another server
//   bucket, P-H2), serialized by its own slot (one upload at a time). The slot covers the whole of it
//   — reading the request body, the cipher, the upload — so a request waiting for the slot has not
//   read its body (TCP backpressure holds the client); it is released when the bytes are up, BEFORE
//   the message is enqueued (a 429 of the queue never holds the next upload). The queue's 30 s
//   deadline counts from that enqueue. Downloads: one at a time too.
// - Targets (item 5): `thread`/`replyTo` are `ts` → event through the index; a `thread` naming a thread
//   reply is promoted to that thread's root (the relation is cleartext even in an encrypted event).
// - Only the agent's own messages are edited or removed (item 3): the server would let an edit of
//   someone else's message through; the sidecar refuses it.
// - Reactions are idempotent: a PUT of a reaction the agent already has, or a DELETE of one it does
//   not have, sends nothing (the local aggregation — pending echoes included — or, for a message
//   outside the loaded timeline, the server's relations).
// - The answer of a send (item 6): the `ts` of the accepted event (the local timeline when it has the
//   remote echo, otherwise the raw `/event` — `origin_server_ts` needs no decryption) and the
//   ApiMessage built from the request (`mentionsMe: false`, `reactions: []`).
// - The message text and the file bytes never reach a log line; a refusal logs errcode/status only.
import type { MatrixClient, MatrixEvent, Room } from 'matrix-js-sdk'
import { ClientPrefix, EventType, MatrixEvent as SdkEvent, Method, RelationType } from 'matrix-js-sdk'
import { aggregateReactions, APPROVAL_MSGTYPE, buildAttachmentContent, mimetypeToMsgtype, type AttachmentMedia } from '@tayet/shared/internal'
import { decryptAttachment, encryptAttachment, type EncryptedFileInfo } from '@tayet/shared/internal/attachment-crypto'
import type { RichDoc } from '@tayet/shared'
import type { ApiMessage, ApiRich } from '../api/contract'
import { classifySendError, type SendFailure, type SendResult } from './queue'
import { ReadError, type Resolver } from './read'
import type { WriteJob } from './send'

type Log = (line: Record<string, unknown>) => void

export const MENTIONS_MAX = 100
// §0.3.7 item 7: min(m.upload.size, 100 MiB); a failed config read → 100 MiB.
export const UPLOAD_CEILING = 100 * 1024 * 1024
export const NAME_MAX = 255
const FILE_TOKEN = /^F[A-Z2-7]{10}$/
const EDITABLE: ReadonlySet<unknown> = new Set(['m.text', 'm.notice', 'm.emote'])
const T_MESSAGE: string = EventType.RoomMessage

export type WriteErrorCode =
  | 'not_member'
  | 'not_own_message'
  | 'not_editable'
  // ADR-091 (A3-3): the message is not one of the agent's approval cards (close, state).
  | 'not_approval'
  | 'rate_limited'
  | 'upstream_failed'
  | 'unavailable'
  | 'revoked'
  | 'invalid_argument'
  | 'file_not_found'
  | 'file_too_large'
  // ADR-093 (A4-2a): the commands manifest is over 8 KiB.
  | 'payload_too_large'

// The errors of the write path, mapped by the API layer to its codes (§0.3.7 item 2). The read
// side's ReadError (conversation/user/message not found, invalid argument) is reused as is.
export class WriteError extends Error {
  constructor(
    readonly code: WriteErrorCode,
    readonly retryAfterMs?: number,
  ) {
    super(code)
    this.name = 'WriteError'
  }
}

export interface PostRequest {
  text: string
  // The formatted text (PLANO-AGENTES §0.3.12 item 4): set by the Slack layer (mrkdwn → RichDoc), and
  // by the native API and the MCP from markdown (S-i, §0.3.15 item 2).
  rich?: RichDoc
  thread?: string
  replyTo?: string
  mentions?: string[]
}

export interface UploadRequest {
  name: string
  mimetype: string
  // The file's bytes, read only once the upload slot is held (the API layer's body reader; its
  // refusals — over the limit — propagate as they are).
  body: () => Promise<Uint8Array>
  thread?: string
}

export interface Download {
  bytes: Uint8Array
  mimetype: string
  name: string
}

export interface WriteFacade {
  post(conversation: string, req: PostRequest): Promise<ApiMessage>
  edit(conversation: string, ts: string, text: string, rich?: RichDoc): Promise<ApiMessage>
  remove(conversation: string, ts: string): Promise<void>
  // Idempotent; the answer says whether this call changed anything (false: the agent already had the
  // reaction / had none) — the Slack layer's `already_reacted` / `no_reaction`; the native API ignores it.
  react(conversation: string, ts: string, emoji: string): Promise<boolean>
  unreact(conversation: string, ts: string, emoji: string): Promise<boolean>
  // The largest file an upload may carry (read once, then kept).
  uploadLimit(): Promise<number>
  upload(conversation: string, req: UploadRequest): Promise<ApiMessage>
  download(file: string): Promise<Download>
}

export type WriteClient = Pick<MatrixClient, 'getUserId' | 'fetchRoomEvent' | 'decryptEventIfNeeded' | 'relations' | 'uploadContent' | 'getMediaConfig'> & {
  http: Pick<MatrixClient['http'], 'authedRequest'>
}

export interface WriteDeps {
  client: WriteClient
  resolver: Resolver
  enqueue(job: WriteJob): Promise<SendResult>
  // ADR-087 dec. 8: M_UNKNOWN_TOKEN on a request OUTSIDE the queue (upload, download) revokes the
  // core — the same trigger the queue's onRevoked pulls. (The SDK's http-api also emits
  // SessionLoggedOut for it, which boot.ts turns into the same idempotent revoke; this does not rely
  // on that.)
  onRevoked: () => void
  log: Log
  // ADR-091 (A3-3): the PATCH of one of the agent's own approval cards (core/approvals.ts). Absent → a
  // card is `not_editable`, as before.
  editCard?: (room: Room, eventId: string, ev: MatrixEvent, text: string, rich: RichDoc | undefined) => Promise<ApiMessage>
}

// A failure of the queue → the error of the API (the errcode/status of `failed` go to the log only).
export function writeErrorOf(failure: SendFailure, log: Log, op: string): WriteError {
  switch (failure.kind) {
    case 'rate-limited':
      return new WriteError('rate_limited', failure.retryAfterMs)
    case 'revoked':
      return new WriteError('revoked')
    case 'not-member':
      return new WriteError('not_member')
    case 'reply-in-thread':
      return new WriteError('invalid_argument')
    case 'stopped':
      return new WriteError('unavailable')
    case 'failed':
      log({ evt: 'write-failed', op, errcode: failure.errcode, status: failure.status })
      return new WriteError('upstream_failed')
  }
}

// One at a time (the upload and the download mutexes).
function mutex(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task)
    tail = run.catch(() => undefined)
    return run
  }
}

interface Relates {
  rel_type?: unknown
  event_id?: unknown
  'm.in_reply_to'?: { event_id?: unknown }
}
// The relation of an event, from its WIRE content: cleartext even in an encrypted event.
const relatesOf = (ev: MatrixEvent): Relates => {
  const rel: unknown = ev.getWireContent()['m.relates_to']
  return rel !== null && typeof rel === 'object' ? rel : {}
}

// The lookups and the send step every write shares — the write facade below and the approval cards'
// (core/approvals.ts): the same membership rule, the same message lookup, the same accepted `ts`.
export function writeHelpers(deps: WriteDeps) {
  const { client, resolver, log } = deps
  const enqueue = (job: WriteJob): Promise<SendResult> => deps.enqueue(job)

  const me = (): string => {
    const id = client.getUserId()
    if (id === null) throw new Error('no user id')
    return id
  }

  const joined = (token: string): Room => {
    const room = resolver.roomAnyOf(token)
    if (room.getMyMembership() !== 'join') throw new WriteError('not_member')
    return room
  }

  // The event, from the local timeline, the agent's own accepted sends not yet back in the sync (the
  // detached pending list: it carries a local removal too), or the server (decrypted when it can be).
  const loadEvent = async (room: Room, eventId: string): Promise<MatrixEvent | null> => {
    const local = room.findEventById(eventId) ?? room.getPendingEvents().find((e) => e.getId() === eventId)
    if (local !== undefined) return local
    try {
      const ev = new SdkEvent(await client.fetchRoomEvent(room.roomId, eventId))
      await client.decryptEventIfNeeded(ev).catch(() => undefined)
      return ev
    } catch {
      return null
    }
  }

  // A message row of the conversation by its ts: not redacted (nor being redacted by this agent — a
  // removal accepted but not yet back in the sync), not an edit.
  const messageAt = async (room: Room, ts: string): Promise<{ eventId: string; ev: MatrixEvent }> => {
    const eventId = await resolver.eventOf(room, ts)
    const ev = await loadEvent(room, eventId)
    if (
      ev === null ||
      ev.isRedacted() ||
      ev.localRedactionEvent() !== null ||
      ev.getType() !== T_MESSAGE ||
      relatesOf(ev).rel_type === RelationType.Replace
    ) {
      throw new ReadError('message_not_found')
    }
    return { eventId, ev }
  }

  // §0.3.7 item 5: a thread named by one of its replies → the thread's root.
  const threadRoot = async (room: Room, ts: string): Promise<string> => {
    const { eventId, ev } = await messageAt(room, ts)
    const rel = relatesOf(ev)
    return rel.rel_type === RelationType.Thread && typeof rel.event_id === 'string' ? rel.event_id : eventId
  }

  const instantOf = async (room: Room, eventId: string): Promise<number> => {
    const local = room.findEventById(eventId)
    if (local !== undefined && local.status === null) return local.getTs()
    try {
      const raw = await client.fetchRoomEvent(room.roomId, eventId)
      if (typeof raw.origin_server_ts === 'number') return raw.origin_server_ts
    } catch {
      // below
    }
    log({ evt: 'write-instant-missing' })
    throw new WriteError('upstream_failed')
  }

  const acceptedTs = async (room: Room, eventId: string): Promise<string> => {
    const ts = resolver.tsOf(room.roomId, eventId, await instantOf(room, eventId))
    if (ts === null) throw new WriteError('upstream_failed')
    return ts
  }

  const run = async (job: WriteJob, op: string): Promise<string> => {
    const result = await enqueue(job)
    if (!result.ok) throw writeErrorOf(result.error, log, op)
    return result.messageId
  }

  const owned = (ev: MatrixEvent): void => {
    if (ev.getSender() !== me()) throw new WriteError('not_own_message')
  }

  // The agent's own live reaction `key` on the target: its event id, a marker for a pending one, or null.
  const ownReaction = async (room: Room, target: string, key: string): Promise<string | null> => {
    const mine = me()
    const container = room.relations.getChildEventsForEvent(target, RelationType.Annotation, EventType.Reaction)
    if (container !== undefined || room.findEventById(target) !== undefined) {
      const hit = container?.getRelations().find((e) => e.getSender() === mine && e.getRelation()?.key === key && !e.isRedacted())
      return hit?.getId() ?? null
    }
    // A message outside the loaded timeline: the server's relations (reactions are never encrypted).
    try {
      const res = await client.relations(room.roomId, target, RelationType.Annotation, EventType.Reaction, { limit: 100 })
      const hit = res.events.find((e) => e.getSender() === mine && e.getRelation()?.key === key && !e.isRedacted())
      return hit?.getId() ?? null
    } catch {
      return null
    }
  }

  const tsOfRelation = async (room: Room, ev: MatrixEvent): Promise<Pick<ApiMessage, 'thread' | 'replyTo'>> => {
    const rel = relatesOf(ev)
    const out: Pick<ApiMessage, 'thread' | 'replyTo'> = {}
    if (rel.rel_type === RelationType.Thread && typeof rel.event_id === 'string') {
      const thread = await resolver.tsOfRelated(room, rel.event_id)
      if (thread !== undefined) out.thread = thread
    }
    const reply = rel['m.in_reply_to']?.event_id
    if (rel.rel_type !== RelationType.Thread && typeof reply === 'string') {
      const replyTo = await resolver.tsOfRelated(room, reply)
      if (replyTo !== undefined) out.replyTo = replyTo
    }
    return out
  }

  return { me, joined, loadEvent, messageAt, threadRoot, instantOf, acceptedTs, run, owned, ownReaction, tsOfRelation, enqueue }
}

export function createWriteFacade(deps: WriteDeps): WriteFacade {
  const { client, resolver, log } = deps
  const { me, joined, messageAt, threadRoot, instantOf, acceptedTs, run, owned, ownReaction, tsOfRelation, enqueue } = writeHelpers(deps)
  const uploads = mutex()
  const downloads = mutex()
  let limit: Promise<number> | null = null

  return {
    async post(conversation, req) {
      if (req.thread !== undefined && req.replyTo !== undefined) throw new WriteError('invalid_argument')
      const tokens = req.mentions ?? []
      if (tokens.length > MENTIONS_MAX || new Set(tokens).size !== tokens.length) throw new WriteError('invalid_argument')
      const room = joined(conversation)
      const mentions = tokens.map((t) => resolver.userOf(t))
      let thread: string | undefined
      let threadTs: string | undefined
      if (req.thread !== undefined) {
        thread = await threadRoot(room, req.thread)
        threadTs = await resolver.tsOfRelated(room, thread)
      }
      const replyTo = req.replyTo !== undefined ? (await messageAt(room, req.replyTo)).eventId : undefined
      const eventId = await run(
        {
          kind: 'text',
          req: {
            channel: room.roomId,
            text: req.text,
            ...(req.rich !== undefined && { rich: req.rich }),
            ...(mentions.length > 0 && { mentions }),
            ...(thread !== undefined && { thread }),
            ...(replyTo !== undefined && { replyTo }),
          },
        },
        'post',
      )
      return {
        id: await acceptedTs(room, eventId),
        conversation: resolver.tokenOfRoom(room.roomId),
        author: resolver.tokenOfPerson(me()),
        text: req.text,
        ...(req.rich !== undefined && { rich: req.rich as unknown as ApiRich }),
        ...(threadTs !== undefined && { thread: threadTs }),
        ...(req.replyTo !== undefined && { replyTo: req.replyTo }),
        mentionsMe: false,
        ...(tokens.length > 0 && { mentions: tokens }),
        reactions: [],
      }
    },

    async edit(conversation, ts, text, rich) {
      const room = joined(conversation)
      const { eventId, ev } = await messageAt(room, ts)
      owned(ev)
      // ADR-091 (A3-3): the agent's own approval card — only the request changes (core/approvals.ts).
      if (!ev.isDecryptionFailure() && ev.getContent().msgtype === APPROVAL_MSGTYPE && deps.editCard !== undefined) {
        return deps.editCard(room, eventId, ev, text, rich)
      }
      // An attachment (or what cannot be read) is not edited: the client edits text only.
      if (ev.isDecryptionFailure() || !EDITABLE.has(ev.getContent().msgtype)) throw new WriteError('not_editable')
      const editId = await run({ kind: 'edit', channel: room.roomId, target: eventId, text, ...(rich !== undefined && { rich }) }, 'edit')
      const editedAt = await instantOf(room, editId)
      return {
        id: ts,
        conversation: resolver.tokenOfRoom(room.roomId),
        author: resolver.tokenOfPerson(me()),
        text,
        ...(rich !== undefined && { rich: rich as unknown as ApiRich }),
        ...(await tsOfRelation(room, ev)),
        mentionsMe: false,
        reactions: aggregateReactions(room, eventId, me()).map((r) => ({ emoji: r.emoji, count: r.count, mine: r.mine })),
        editedAt,
      }
    },

    async remove(conversation, ts) {
      const room = joined(conversation)
      const { eventId, ev } = await messageAt(room, ts)
      owned(ev)
      await run({ kind: 'redact', channel: room.roomId, target: eventId }, 'remove')
    },

    async react(conversation, ts, emoji) {
      const room = joined(conversation)
      const { eventId } = await messageAt(room, ts)
      if ((await ownReaction(room, eventId, emoji)) !== null) return false
      const result = await enqueue({ kind: 'react', channel: room.roomId, target: eventId, key: emoji })
      // The server already has it (a reaction this run had not seen yet): the PUT is idempotent.
      if (!result.ok && result.error.kind === 'failed' && result.error.errcode === 'M_DUPLICATE_ANNOTATION') return false
      if (!result.ok) throw writeErrorOf(result.error, log, 'react')
      return true
    },

    async unreact(conversation, ts, emoji) {
      const room = joined(conversation)
      const { eventId } = await messageAt(room, ts)
      const reaction = await ownReaction(room, eventId, emoji)
      if (reaction === null) return false
      // A reaction still pending (no event id yet) is not removed — as before; it exists, so `true`.
      if (!reaction.startsWith('$')) return true
      await run({ kind: 'unreact', channel: room.roomId, reaction }, 'unreact')
      return true
    },

    uploadLimit() {
      limit ??= client.getMediaConfig(true).then(
        (cfg) => {
          const max = cfg['m.upload.size']
          return typeof max === 'number' && max > 0 ? Math.min(max, UPLOAD_CEILING) : UPLOAD_CEILING
        },
        () => UPLOAD_CEILING,
      )
      return limit
    },

    async upload(conversation, req) {
      if (req.name === '' || req.name.length > NAME_MAX || req.name.includes('/')) throw new WriteError('invalid_argument')
      const room = joined(conversation)
      const max = await this.uploadLimit()
      let thread: string | undefined
      let threadTs: string | undefined
      if (req.thread !== undefined) {
        thread = await threadRoot(room, req.thread)
        threadTs = await resolver.tsOfRelated(room, thread)
      }
      const encrypted = room.hasEncryptionStateEvent()
      // The slot: body read → cipher → upload. Released when the bytes are up (before the enqueue).
      const { media, size } = await uploads(async (): Promise<{ media: AttachmentMedia; size: number }> => {
        const bytes = await req.body()
        if (bytes.byteLength > max) throw new WriteError('file_too_large')
        try {
          if (encrypted) {
            // ADR-016 (the client's path): the CIPHERTEXT goes up with no name and an opaque type; the
            // event's `file` carries the envelope + the upload's URI, all inside the encrypted payload.
            const { ciphertext, info } = await encryptAttachment(bytes)
            const up = await client.uploadContent(ciphertext, { includeFilename: false, type: 'application/octet-stream' })
            return { media: { encrypted: info, url: up.content_uri }, size: bytes.byteLength }
          }
          const up = await client.uploadContent(bytes, { name: req.name, type: req.mimetype })
          return { media: { url: up.content_uri }, size: bytes.byteLength }
        } catch (err) {
          const verdict = classifySendError(err)
          if (verdict.kind === 'revoked') {
            deps.onRevoked()
            throw new WriteError('revoked')
          }
          if (verdict.kind === 'rate-limited') throw new WriteError('rate_limited', verdict.retryAfterMs ?? undefined)
          if (verdict.failure.kind === 'failed' && verdict.failure.status === 413) throw new WriteError('file_too_large')
          throw writeErrorOf(verdict.failure, log, 'upload')
        }
      })
      const content = buildAttachmentContent(mimetypeToMsgtype(req.mimetype), req.name, req.mimetype, size, media, thread)
      const eventId = await run({ kind: 'attachment', channel: room.roomId, content, ...(thread !== undefined && { thread }) }, 'upload')
      const id = resolver.noteFile({
        uri: media.url,
        ...('encrypted' in media && { encrypted: { ...media.encrypted, url: media.url } }),
        mimetype: req.mimetype,
        name: req.name,
      })
      return {
        id: await acceptedTs(room, eventId),
        conversation: resolver.tokenOfRoom(room.roomId),
        author: resolver.tokenOfPerson(me()),
        text: '',
        ...(threadTs !== undefined && { thread: threadTs }),
        mentionsMe: false,
        reactions: [],
        files: [{ id, name: req.name, mimetype: req.mimetype, size }],
      }
    },

    async download(file) {
      const ref = FILE_TOKEN.test(file) ? resolver.file(file) : undefined
      if (ref === undefined) throw new WriteError('file_not_found')
      const parts = /^mxc:\/\/([^/]+)\/([^/?#]+)$/.exec(ref.uri)
      if (parts === null) throw new WriteError('file_not_found')
      const path = `/media/download/${encodeURIComponent(parts[1] as string)}/${encodeURIComponent(parts[2] as string)}`
      return downloads(async () => {
        let bytes: Uint8Array
        try {
          // Authenticated media v1 through the SDK's http-api — the client's resolveMedia.
          // (`priority` is optional at runtime; Node's RequestInit types declare it required.)
          const opts = { prefix: ClientPrefix.V1, rawResponseBody: true } as Parameters<WriteClient['http']['authedRequest']>[4]
          const blob = await client.http.authedRequest<Blob>(Method.Get, path, { allow_redirect: 'true' }, undefined, opts)
          bytes = new Uint8Array(await blob.arrayBuffer())
        } catch (err) {
          const verdict = classifySendError(err)
          if (verdict.kind === 'revoked') {
            deps.onRevoked()
            throw new WriteError('revoked')
          }
          if (verdict.kind === 'rate-limited') throw new WriteError('rate_limited', verdict.retryAfterMs ?? undefined)
          if (verdict.failure.kind === 'failed' && verdict.failure.status === 404) throw new WriteError('file_not_found')
          throw writeErrorOf(verdict.failure, log, 'download')
        }
        if (ref.encrypted !== undefined) {
          // Hash first, always (attachment-crypto.ts); a mismatch never yields bytes.
          try {
            const plain = await decryptAttachment(bytes.slice().buffer, ref.encrypted as EncryptedFileInfo)
            bytes = new Uint8Array(plain)
          } catch {
            log({ evt: 'download-integrity-failed' })
            throw new WriteError('upstream_failed')
          }
        }
        return { bytes, mimetype: ref.mimetype ?? 'application/octet-stream', name: ref.name ?? 'file' }
      })
    },
  }
}
