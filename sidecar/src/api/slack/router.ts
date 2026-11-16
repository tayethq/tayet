// The Slack layer of the local API (ADR-087 dec. 6; PLANO-AGENTES §0.3.12): Slack's Web API over the
// core's facades, on the native API's own listener. A Slack SDK points its base URL here and uses the
// local token as its bot token:
//   POST|GET /slack/api/<method>   a Web API method (the first cut of S-f1)
//   POST     /slack/upload/<ticket> the upload_url of the upload v2 flow (slack/files.ts): one file
//                                   field of a multipart body; HTTP status codes, as a file host answers
//   GET      /slack/files/<F…>      a file's url_private (S-f3): the bytes of the native GET /v1/files/:id
//                                   (api/download.ts), with the local token as Bearer; HTTP status codes
//   GET      /slack/socket?ticket=  the emulated Socket Mode (slack/socket.ts, S-f2): an upgrade only
// With `actions` (`--slack-actions-url`), the approval card's clicks leave as signed HTTP POSTs to that URL
// (slack/http-actions.ts) instead of `interactive` envelopes; events and `/` commands stay on the sockets.
//   POST     /slack/response/<ticket> the response_url of an approval card's click (A3-4, slack/response.ts):
//                                   NO Bearer — Bolt's respond() sends none; the ticket is the credential
//                                   (30 min, 5 uses, memory only). JSON `{ replace_original: true, text?,
//                                   blocks? }` → the chat.update path (an `actions` block included) →
//                                   HTTP 200 `{ ok: true }`; HTTP status codes otherwise: no
//                                   `replace_original` or a `delete_original` → 400 `invalid_arguments`;
//                                   unknown, expired or spent → 404 `expired_url`; revoked → 503.
//                                   The response_url of a `/` command (A4-3, slack/commands.ts), same ticket
//                                   rules: JSON `{ text?, blocks? }` → a reply in the command's thread by the
//                                   chat.postMessage path → HTTP 200 `{ ok: true }` (nothing to write → 200,
//                                   nothing written); `replace_original`/`delete_original` ignored with a line
// Every request, in the native order (api/server.ts): Host → Origin (both answered by the server
// before this layer) → revoked → Bearer (the local token) → the method; the response route skips the Bearer.
//
// - Body: `application/x-www-form-urlencoded` (what @slack/web-api sends for every method, nested
//   fields as JSON strings), `application/json`, or the query of a GET (and of a POST, merged under the
//   body). A multipart body is refused here (`invalid_arguments`): only the upload route takes it.
// - `team_id` is optional; when present it must be this workspace's `T…` (`invalid_auth` otherwise).
// - Answers: always HTTP 200 `{ ok: true, … }` or `{ ok: false, error }`, as Slack does — except the
//   limit: HTTP 429 + a numeric `Retry-After` + `{ ok: false, error: 'ratelimited' }` (the core's
//   `rate_limited`), which @slack/web-api retries after the delay without duplicating the call.
// - The native edge scans every native value before it is translated; the Slack edge (slack/edge.ts)
//   scans the answer. A finding → `internal_error`.
//
// Only @tayet/shared's root (and its leak-scan) is imported here; never /internal (lint of src/api/**).
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { ApprovalFacade } from '../../core/approvals'
import { ReadError, type ReadFacade } from '../../core/read'
import { WriteError, type WriteFacade } from '../../core/write'
import type { BusEntry, EventBus, Opened } from '../bus'
import type { ApiMe } from '../contract'
import { sendDownload } from '../download'
import { logLeaks, scanEdge, scanWriteProbe } from '../edge'
import { SlackCards } from './cards'
import type { SlackErrorCode, SlackMetadata } from './contract'
import { scanSlack } from './edge'
import { SlackError } from './errors'
import { SOCKET_PATH, SocketTickets } from './connections'
import { boundaryOf } from './multipart'
import { createSlackEvents } from './events'
import { dispatchCommand, replyArgsOf, type ResponseVia } from './commands'
import { createHttpActions, type HttpActions } from './http-actions'
import { blockActionsOf, dispatchAnswered } from './interactive'
import { ResponseTickets, type CommandTarget } from './response'
import { createSocketHub, type SocketOptions } from './socket'
import { MULTIPART_OVERHEAD, UploadStaging } from './staging'

type Log = (line: Record<string, unknown>) => void

// The JSON/form body limit of a method call (the native API's, §0.3.7 item 2).
export const SLACK_BODY_MAX = 256 * 1024
export const SLACK_TEXT_MAX = 32 * 1024

export type SlackArgs = Record<string, unknown>

export { SlackError }

export interface SlackLayerOptions {
  read: ReadFacade
  write: WriteFacade
  log: Log
  // The product URL the agent was started with (`--server`): `auth.test`'s `url`.
  productUrl: string
  // `<store>/uploads/`: the staging of the upload v2 flow (slack/files.ts).
  uploadsDir?: string
  // The listener's own base URL (the upload_url is built on it).
  baseUrl: () => string | null
  now?: () => number
  // The socket's clock and timings (slack/socket.ts; tests).
  socket?: SocketOptions
  // The local API's event bus (api/bus.ts): the Socket Mode's events (slack/events.ts). Absent → no events.
  bus?: EventBus
  // The approval cards (A3-4; core/approvals.ts), as the server hands them to the MCP: an `actions` block
  // becomes a card and its click a `block_actions`. Absent → `actions` is dropped, as before.
  approvals?: ApprovalFacade
  // `<store>/slack-cards.json` (slack/cards.ts); absent → memory only (tests).
  cardsFile?: string
  // The clicks over HTTP (`--slack-actions-url`; slack/http-actions.ts): the destination and the signing secret
  // (the local token). Absent → the clicks go to the sockets, as before.
  actions?: { url: string; secret: string; redeliveryMs?: number }
}

// What a method sees: the facades, the agent (cached), and the edge helpers.
export interface SlackCtx {
  read: ReadFacade
  write: WriteFacade
  log: Log
  productUrl: string
  uploadsDir: string | undefined
  baseUrl: () => string | null
  now: () => number
  me(): Promise<ApiMe>
  // Every native value passes the native edge before it is translated (§0.3.12 item 2).
  native<T>(value: T, where: string): T
  // A write whose answer the edge would withhold is refused before any effect (server.ts preflight).
  preflight(where: string, conversation: string, text: string, fileName?: string): void
  // The request itself, for the routes that read their own body (the upload); absent for a write the layer makes
  // on its own (the reply to a `/` command's ack, A4-3).
  req: IncomingMessage | undefined
  // The upload v2 staging (`<store>/uploads/`); null when the layer has no store (tests).
  staging: UploadStaging | null
  // The Socket Mode tickets (slack/connections.ts): apps.connections.open issues, the upgrade spends.
  tickets: SocketTickets
  // The approval cards (A3-4); undefined → no card.
  approvals: ApprovalFacade | undefined
  // The layer's file of cards (slack/cards.ts).
  cards: SlackCards
}

export type SlackResult = Record<string, unknown> & { response_metadata?: SlackMetadata }
export type SlackMethod = ((args: SlackArgs, ctx: SlackCtx) => Promise<SlackResult>) & { deprecated?: true }

// A method Slack retired: answered `method_deprecated` before its body is read (a v1 `files.upload`
// sends multipart, which no method route parses).
export const deprecatedMethod = (): SlackMethod => Object.assign(() => Promise.reject(new SlackError('method_deprecated')), { deprecated: true as const })
export type SlackMethods = Readonly<Record<string, SlackMethod>>

// The core's errors → Slack's codes (a method maps its own context first: `cant_update_message`, …).
export function slackCodeOf(err: unknown): SlackError | null {
  if (err instanceof SlackError) return err
  if (err instanceof ReadError) {
    switch (err.code) {
      case 'conversation_not_found':
        return new SlackError('channel_not_found')
      case 'user_not_found':
        return new SlackError('user_not_found')
      case 'message_not_found':
        return new SlackError('message_not_found')
      case 'invalid_cursor':
        return new SlackError('invalid_cursor')
      case 'invalid_argument':
        return new SlackError('invalid_arguments')
    }
  }
  if (err instanceof WriteError) {
    switch (err.code) {
      case 'rate_limited':
        return new SlackError('ratelimited', err.retryAfterMs)
      case 'not_member':
        return new SlackError('not_in_channel')
      case 'not_own_message':
      case 'not_editable':
      case 'not_approval':
        return new SlackError('cant_update_message')
      case 'invalid_argument':
        return new SlackError('invalid_arguments')
      case 'file_not_found':
        return new SlackError('file_not_found')
      case 'file_too_large':
        return new SlackError('file_too_large')
      case 'revoked':
        return new SlackError('token_revoked')
      case 'unavailable':
        return new SlackError('service_unavailable')
      case 'upstream_failed':
        return new SlackError('internal_error')
    }
  }
  return null
}

// ── Arguments ────────────────────────────────────────────────────────────────────────────────────

export function str(args: SlackArgs, key: string): string | undefined {
  const v = args[key]
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v === 'number') return String(v)
  if (typeof v !== 'string') throw new SlackError('invalid_arguments')
  return v
}

export function required(args: SlackArgs, key: string, missing: SlackErrorCode = 'invalid_arguments'): string {
  const v = str(args, key)
  if (v === undefined) throw new SlackError(missing)
  return v
}

// Slack's booleans: true/false, 1/0, "true"/"false", "1"/"0".
export function bool(args: SlackArgs, key: string, fallback: boolean): boolean {
  const v = args[key]
  if (v === undefined || v === null || v === '') return fallback
  if (v === true || v === 1 || v === 'true' || v === '1') return true
  if (v === false || v === 0 || v === 'false' || v === '0') return false
  throw new SlackError('invalid_arguments')
}

export function int(args: SlackArgs, key: string): number | undefined {
  const v = args[key]
  if (v === undefined || v === null || v === '') return undefined
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,9}$/.test(v) ? Number(v) : NaN
  if (!Number.isInteger(n) || n < 0) throw new SlackError('invalid_arguments')
  return n
}

// A nested field: an array/object in a JSON body, a JSON string in a form body (@slack/web-api).
export function nested(args: SlackArgs, key: string): unknown {
  const v = args[key]
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v !== 'string') return v
  try {
    return JSON.parse(v) as unknown
  } catch {
    throw new SlackError('invalid_arguments')
  }
}

// ── Bodies ───────────────────────────────────────────────────────────────────────────────────────

export function readBody(req: IncomingMessage, max: number, over: SlackErrorCode = 'invalid_arguments'): Promise<Buffer> {
  const declared = req.headers['content-length']
  if (declared !== undefined && Number(declared) > max) return Promise.reject(new SlackError(over))
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    req.on('data', (chunk: Buffer) => {
      if (done) return
      size += chunk.length
      if (size > max) {
        done = true
        req.pause()
        reject(new SlackError(over))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (done) return
      done = true
      resolve(Buffer.concat(chunks))
    })
    req.on('error', (err) => {
      if (done) return
      done = true
      reject(err)
    })
  })
}

const mediaType = (req: IncomingMessage): string => ((req.headers['content-type'] ?? '').split(';')[0] as string).trim().toLowerCase()

async function argsOf(req: IncomingMessage, query: URLSearchParams): Promise<SlackArgs> {
  const args: SlackArgs = Object.fromEntries(query.entries())
  if (req.method === 'GET' || req.method === 'HEAD') return args
  const type = mediaType(req)
  if (type === 'multipart/form-data') throw new SlackError('invalid_arguments')
  const raw = await readBody(req, SLACK_BODY_MAX)
  if (raw.length === 0) return args
  if (type === 'application/json') {
    let v: unknown
    try {
      v = JSON.parse(raw.toString('utf8'))
    } catch {
      throw new SlackError('invalid_arguments')
    }
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new SlackError('invalid_arguments')
    return { ...args, ...(v as SlackArgs) }
  }
  // Form (Slack's default, and what an absent type means for a POST).
  return { ...args, ...Object.fromEntries(new URLSearchParams(raw.toString('utf8')).entries()) }
}

// ── The layer ────────────────────────────────────────────────────────────────────────────────────

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const raw = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(raw)),
    ...headers,
  })
  res.end(raw)
}

export function failSlack(res: ServerResponse, err: SlackError): void {
  if (err.code === 'ratelimited') {
    const seconds = Math.max(Math.ceil(Math.max(err.retryAfterMs ?? 0, 0) / 1000), 1)
    return send(res, 429, { ok: false, error: 'ratelimited' }, { 'retry-after': String(seconds) })
  }
  send(res, 200, { ok: false, error: err.code, ...(err.warnings !== undefined && { response_metadata: { warnings: [...err.warnings] } }) })
}

export interface SlackLayer {
  // True when the path is this layer's (`/slack/…`); the server delegates the whole request.
  owns(path: string): boolean
  handle(req: IncomingMessage, res: ServerResponse, url: URL, auth: { revoked: boolean; header: string | undefined; authorized: boolean }): Promise<void>
  // The Socket Mode route (`/slack/socket`, slack/socket.ts): the only path that takes an upgrade.
  ownsSocket(path: string): boolean
  // An upgrade of that route, after Host → Origin → revoked (api/server.ts): the ticket, then the socket.
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL): void
  // The revocation (api/server.ts): the sockets get `link_disabled` and close; events stop.
  revoke(): Promise<void>
  // Clean shutdown: the sockets get `refresh_requested` and close; the upload staging is emptied.
  close(): Promise<void>
}

const METHOD_PATH = /^\/slack\/api\/([A-Za-z][A-Za-z0-9.]{0,63})$/
const UPLOAD_PATH = /^\/slack\/upload\/([^/]+)$/
const RESPONSE_ROUTE = /^\/slack\/response\/([^/]+)$/
const FILE_PATH = /^\/slack\/files\/([^/]+)$/

// The upload and file routes answer as a file host: an HTTP status (the WebClient checks for 200 on the
// upload; a fetch of url_private, for 200 too) + Slack's code.
const UPLOAD_STATUS: Partial<Record<SlackErrorCode, number>> = {
  not_authed: 401,
  invalid_auth: 401,
  token_revoked: 503,
  service_unavailable: 503,
  file_not_found: 404,
  file_too_large: 413,
  invalid_arguments: 400,
  ratelimited: 429,
  // The response_url (A3-4).
  expired_url: 404,
  invalid_blocks: 400,
  markdown_text_conflict: 400,
  no_text: 400,
  msg_too_long: 400,
  cant_update_message: 400,
  message_not_found: 404,
  channel_not_found: 404,
}

function failUpload(req: IncomingMessage, res: ServerResponse, code: SlackErrorCode, status = UPLOAD_STATUS[code] ?? 500, headers: Record<string, string> = {}): void {
  // What was not read is never read: the connection closes after the answer.
  if (!req.complete) res.once('finish', () => req.socket.destroy())
  send(res, status, { ok: false, error: code }, { ...headers, ...(req.complete ? {} : { connection: 'close' }) })
}

export function createSlackLayer(opts: SlackLayerOptions, families: readonly SlackMethods[]): SlackLayer {
  const log = opts.log
  const methods: Record<string, SlackMethod> = Object.assign({}, ...families) as Record<string, SlackMethod>
  const now = opts.now ?? Date.now
  const staging = opts.uploadsDir !== undefined ? new UploadStaging(opts.uploadsDir, now, log) : null
  const tickets = new SocketTickets(now)
  const cards = new SlackCards(opts.cardsFile, log)
  const responses = new ResponseTickets(now)
  // The Slack bus consumer (A3-4): open while a socket is (slack/socket.ts hooks) — or, with the clicks over
  // HTTP, from the start for as long as the layer lives.
  let consumer: Opened | null = null
  const httpActions: HttpActions | null =
    opts.actions !== undefined && opts.approvals !== undefined
      ? createHttpActions({
          url: opts.actions.url,
          secret: opts.actions.secret,
          log,
          ...(opts.socket?.clock !== undefined && { clock: opts.socket.clock }),
          ...(opts.socket?.ackTimeoutMs !== undefined && { ackTimeoutMs: opts.socket.ackTimeoutMs }),
          ...(opts.actions.redeliveryMs !== undefined && { redeliveryMs: opts.actions.redeliveryMs }),
        })
      : null
  const hub = createSocketHub({
    ...opts.socket,
    tickets,
    log,
    appId: () => opts.read.bot(),
    onFirstOpen: () => openConsumer(),
    onLastClose: () => {
      if (httpActions === null) closeConsumer()
    },
  })
  let meCache: Promise<ApiMe> | null = null
  const me = (): Promise<ApiMe> => {
    meCache ??= opts.read.me().then(
      (v) => v,
      (err: unknown) => {
        meCache = null
        throw err
      },
    )
    return meCache
  }
  // Every native value passes the native edge before it is translated (§0.3.12 item 2).
  const native = <T>(value: T, where: string): T => {
    const leaks = scanEdge(value)
    if (leaks.length > 0) {
      logLeaks(log, `slack ${where}`, leaks)
      throw new SlackError('internal_error')
    }
    return value
  }
  const approvals = opts.approvals
  // A `/` command's response (A4-3, §0.3.25 item 6): an ordinary reply in the command's thread, by the
  // chat.postMessage method itself (the same path and preflight); nothing to write → nothing written.
  const replyToCommand = async (target: CommandTarget, body: Record<string, unknown>, via: ResponseVia): Promise<boolean> => {
    const args = replyArgsOf(target, body, log)
    if (args === null) return false
    const post = methods['chat.postMessage']
    if (post === undefined || !Object.hasOwn(methods, 'chat.postMessage')) throw new SlackError('internal_error')
    await post(args, ctxOf(undefined))
    log({ evt: 'slash-command-response', via })
    return true
  }
  const events = createSlackEvents({
    read: opts.read,
    me,
    log,
    baseUrl: opts.baseUrl,
    broadcast: (type, payload) => void hub.broadcast(type, payload),
    command: (e, agent, bot) =>
      dispatchCommand(e, agent, bot, {
        read: opts.read,
        log,
        tickets: responses,
        baseUrl: opts.baseUrl,
        native,
        broadcast: (type, payload) => hub.broadcast(type, payload),
        reply: async (target, body, via) => void (await replyToCommand(target, body, via)),
      }),
    ...(approvals !== undefined && {
      answered: (e, agent, bot, view) => {
        const interactive = { read: opts.read, log, cards, tickets: responses, baseUrl: opts.baseUrl, native }
        if (httpActions === null) return dispatchAnswered(e, agent, bot, view, { ...interactive, broadcast: (type, payload) => hub.broadcast(type, payload) })
        return httpActions.deliver({
          build: async () => (await blockActionsOf(e, agent, bot, view, interactive)) as unknown as Record<string, unknown>,
          acked: () => cards.remove(e.conversation, e.id),
        })
      },
    }),
  })
  // 0 → 1 sockets: the layer becomes a consumer of the bus (api/bus.ts `open`, no cursor) and handles what
  // nobody heard first, in order, then every publish; → 0: the consumer closes, and the bus keeps the next
  // `approval.answered` for whoever opens next (an SSE stream or a socket).
  // With the clicks over HTTP the consumer opens here, once, and stays open: every `approval.answered` goes to
  // the HTTP delivery, and the bus keeps none for a later consumer. The other events are handled only while a
  // socket is open, as without it.
  function openConsumer(): void {
    if (opts.bus === undefined || consumer !== null) return
    const push = (entry: BusEntry): void => {
      if (httpActions !== null && entry.event.type !== 'approval.answered' && hub.connections === 0) return
      events.push(entry)
    }
    consumer = opts.bus.open(undefined, push)
    for (const entry of consumer.unheard) push(entry)
  }
  if (httpActions !== null) openConsumer()
  function closeConsumer(): void {
    consumer?.close()
    consumer = null
  }
  const stopEvents = (): void => {
    closeConsumer()
    events.stop()
    httpActions?.stop()
    responses.clear()
  }

  const ctxOf = (req: IncomingMessage | undefined): SlackCtx => ({
    read: opts.read,
    write: opts.write,
    log,
    productUrl: opts.productUrl,
    uploadsDir: opts.uploadsDir,
    baseUrl: opts.baseUrl,
    now,
    req,
    staging,
    tickets,
    approvals,
    cards,
    me,
    native,
    // The probe of the native writes (api/edge.ts scanWriteProbe): one rule for every surface.
    preflight(where, conversation, text, fileName) {
      const leaks = scanWriteProbe(conversation, text, fileName)
      if (leaks.length > 0) {
        logLeaks(log, `slack ${where}`, leaks)
        throw new SlackError('internal_error')
      }
    },
  })

  const reply = (res: ServerResponse, method: string, result: SlackResult): void => {
    const body = { ok: true, ...result }
    const leaks = scanSlack(body)
    if (leaks.length > 0) {
      logLeaks(log, `slack ${method}`, leaks)
      return failSlack(res, new SlackError('internal_error'))
    }
    send(res, 200, body)
  }

  // POST /slack/upload/<ticket> (§0.3.12 item 6), after Host → Origin (the server) → revoked → Bearer.
  const upload = async (req: IncomingMessage, res: ServerResponse, ticket: string, auth: { revoked: boolean; header: string | undefined; authorized: boolean }): Promise<void> => {
    if (auth.revoked) return failUpload(req, res, 'token_revoked')
    if (auth.header === undefined) return failUpload(req, res, 'not_authed')
    if (!auth.authorized) return failUpload(req, res, 'invalid_auth')
    if (req.method !== 'POST') return failUpload(req, res, 'invalid_arguments', 405)
    if (staging === null) return failUpload(req, res, 'service_unavailable')
    try {
      const boundary = boundaryOf(req.headers['content-type'])
      const file = staging.open(ticket)
      if (boundary === undefined) throw new SlackError('invalid_arguments')
      const limit = await opts.write.uploadLimit()
      const body = await readBody(req, Math.min(file.length, limit) + MULTIPART_OVERHEAD, 'file_too_large')
      const size = await staging.store(file, body, boundary, limit)
      const raw = `OK - ${size}`
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'content-length': String(Buffer.byteLength(raw)) })
      res.end(raw)
    } catch (err) {
      if (err instanceof SlackError) return failUpload(req, res, err.code)
      const slack = slackCodeOf(err)
      if (slack === null) log({ evt: 'api-error', where: 'slack upload', name: err instanceof Error ? err.name : typeof err })
      failUpload(req, res, slack?.code ?? 'internal_error')
    }
  }

  // GET /slack/files/<F…> (S-f3), after Host → Origin (the server) → revoked → Bearer: the native
  // download's bytes and headers (api/download.ts); the decryption is the core's download(), once.
  const file = async (req: IncomingMessage, res: ServerResponse, id: string, auth: { revoked: boolean; header: string | undefined; authorized: boolean }): Promise<void> => {
    if (auth.revoked) return failUpload(req, res, 'token_revoked')
    if (auth.header === undefined) return failUpload(req, res, 'not_authed')
    if (!auth.authorized) return failUpload(req, res, 'invalid_auth')
    if (req.method !== 'GET' && req.method !== 'HEAD') return failUpload(req, res, 'invalid_arguments', 405, { allow: 'GET, HEAD' })
    try {
      const download = await opts.write.download(id)
      if (!sendDownload(res, download, log, 'slack file')) failUpload(req, res, 'internal_error')
    } catch (err) {
      const slack = slackCodeOf(err)
      if (slack === null) log({ evt: 'api-error', where: 'slack file', name: err instanceof Error ? err.name : typeof err })
      const code = slack?.code ?? 'internal_error'
      const retry: Record<string, string> = code === 'ratelimited' ? { 'retry-after': String(Math.max(Math.ceil(Math.max(slack?.retryAfterMs ?? 0, 0) / 1000), 1)) } : {}
      failUpload(req, res, code, undefined, retry)
    }
  }

  // POST /slack/response/<ticket> (A3-4), after Host → Origin (the server) → revoked; no Bearer.
  const respond = async (req: IncomingMessage, res: ServerResponse, ticket: string, revokedNow: boolean): Promise<void> => {
    if (revokedNow) return failUpload(req, res, 'token_revoked')
    if (req.method !== 'POST') return failUpload(req, res, 'invalid_arguments', 405, { allow: 'POST' })
    const target = responses.spend(ticket)
    if (target === null) return failUpload(req, res, 'expired_url')
    const update = methods['chat.update']
    try {
      let body: unknown
      try {
        body = JSON.parse((await readBody(req, SLACK_BODY_MAX)).toString('utf8'))
      } catch (err) {
        if (err instanceof SlackError) throw err
        throw new SlackError('invalid_arguments')
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new SlackError('invalid_arguments')
      const b = body as SlackArgs
      // A `/` command's ticket (A4-3): a reply in the command's thread.
      if (target.kind === 'command') {
        await replyToCommand(target, b, 'response_url')
        return send(res, 200, { ok: true })
      }
      if (update === undefined || !Object.hasOwn(methods, 'chat.update')) throw new SlackError('internal_error')
      const yes = (v: unknown): boolean => v === true || v === 'true'
      if (!yes(b.replace_original) || yes(b.delete_original)) throw new SlackError('invalid_arguments')
      const args: SlackArgs = { channel: target.conversation, ts: target.id }
      for (const k of ['text', 'blocks', 'mrkdwn'] as const) if (b[k] !== undefined) args[k] = b[k]
      await update(args, ctxOf(req))
      send(res, 200, { ok: true })
    } catch (err) {
      const slack = slackCodeOf(err)
      if (slack === null) log({ evt: 'api-error', where: 'slack response', name: err instanceof Error ? err.name : typeof err })
      const code = slack?.code ?? 'internal_error'
      const retry: Record<string, string> = code === 'ratelimited' ? { 'retry-after': String(Math.max(Math.ceil(Math.max(slack?.retryAfterMs ?? 0, 0) / 1000), 1)) } : {}
      failUpload(req, res, code, undefined, retry)
    }
  }

  return {
    owns: (path) => path.startsWith('/slack/'),

    ownsSocket: (path) => path === SOCKET_PATH,

    upgrade: (req, socket, head, url) => hub.upgrade(req, socket, head, url),

    async revoke() {
      stopEvents()
      await hub.revoke()
    },

    async close() {
      stopEvents()
      await hub.close()
      await staging?.clear()
      await cards.saved()
    },

    async handle(req, res, url, auth) {
      const ticket = UPLOAD_PATH.exec(url.pathname)?.[1]
      if (ticket !== undefined) return upload(req, res, ticket, auth)
      const fileId = FILE_PATH.exec(url.pathname)?.[1]
      if (fileId !== undefined) return file(req, res, fileId, auth)
      const response = RESPONSE_ROUTE.exec(url.pathname)?.[1]
      if (response !== undefined) return respond(req, res, response, auth.revoked)
      if (auth.revoked) return failSlack(res, new SlackError('token_revoked'))
      if (auth.header === undefined) return failSlack(res, new SlackError('not_authed'))
      if (!auth.authorized) return failSlack(res, new SlackError('invalid_auth'))
      const m = METHOD_PATH.exec(url.pathname)
      const name = m?.[1]
      const method = name !== undefined ? methods[name] : undefined
      if (name === undefined || method === undefined || !Object.hasOwn(methods, name)) {
        res.once('finish', () => req.resume())
        return failSlack(res, new SlackError('unknown_method'))
      }
      if (req.method !== 'POST' && req.method !== 'GET') return failSlack(res, new SlackError('invalid_arguments'))
      if (method.deprecated === true) {
        res.once('finish', () => req.resume())
        return failSlack(res, new SlackError('method_deprecated'))
      }
      try {
        const args = await argsOf(req, url.searchParams)
        const team = str(args, 'team_id')
        if (team !== undefined && team !== (await ctxOf(req).me()).workspace) throw new SlackError('invalid_auth')
        reply(res, name, await method(args, ctxOf(req)))
      } catch (err) {
        const slack = slackCodeOf(err)
        if (slack === null) {
          // Never the message: an SDK error may carry a protocol URL (server.ts, `api-error`).
          log({ evt: 'api-error', where: `slack ${name}`, name: err instanceof Error ? err.name : typeof err })
        }
        if (!req.complete) res.once('finish', () => req.socket.destroy())
        failSlack(res, slack ?? new SlackError('internal_error'))
      }
    },
  }
}
