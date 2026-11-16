// The local HTTP API of the sidecar (ADR-087 dec. 5(a); PLANO-AGENTES §0.3.6 adjs. 1, 2, 4, 7, 8, 11, 12;
// §0.3.7). `node:http` only (adj. 1). Read routes (S-c1) and write routes (S-c2):
//   POST   /v1/conversations/:id/messages                     { text, thread?, replyTo?, mentions? } → 200
//   PATCH  /v1/conversations/:id/messages/:ts                 { text } → 200 (own text messages)
//   DELETE /v1/conversations/:id/messages/:ts                 → 204 (own messages)
//   PUT    /v1/conversations/:id/messages/:ts/reactions/:emoji → 204 (idempotent)
//   DELETE /v1/conversations/:id/messages/:ts/reactions/:emoji → 204 (idempotent)
//   POST   /v1/conversations/:id/files?name=&thread=          body = the bytes → 200
//   GET    /v1/files/:id                                       → the decrypted bytes
// Approval cards (ADR-091, A3-3; core/approvals.ts), when the core hands the facade:
//   POST   /v1/conversations/:id/approvals        { text, markdown?, options, thread?, mentions? } → 200
//   POST   /v1/conversations/:id/approvals/:ts/close  { text?, markdown? } → 200 (own cards; idempotent)
//   GET    /v1/conversations/:id/approvals/:ts    → { conversation, id, approval } (own cards)
// The PATCH of a message also edits the agent's own card (the request only). No route answers a card.
// The pinned panel (ADR-091 dec. 13, A3-6; core/panels.ts), when the core hands the facade:
//   PUT    /v1/conversations/:id/panel            { text, markdown?, title? } → 202 { conversation, pending }
//   DELETE /v1/conversations/:id/panel            → 202 { conversation, pending }; 204 with nothing to clear
//   GET    /v1/conversations/:id/panel            → { conversation, panel, pending, unreadable? }
// The PUT and the DELETE answer when queued: one panel write every 10 s per agent, messages first. A panel
// `text` over 8 KiB is 413 `payload_too_large`; `thread` and `mentions` are refused (400).
// The agent's `/` commands (ADR-093, A4-2a; core/commands.ts), when the core hands the facade:
//   PUT    /v1/commands                            { commands: [{ name, description, hint? }] } → 202 { pending }
//   DELETE /v1/commands                            → 202 { pending }; 204 with nothing to clear
//   GET    /v1/commands                            → { commands, pending }
// One set for every conversation the agent is a member of, written there under the panel's budget (`pending`
// counts the conversations still to write). A rule broken, a repeated name or an unknown field is 400; a
// manifest over 8 KiB is 413 `payload_too_large`; an id shape in a name, description or hint is 500 `internal`.
// A JSON body over 256 KiB or a `text` over 32 KiB is 413 `payload_too_large`; a file over the upload
// limit is 413 `file_too_large` (before reading, when Content-Length says so; otherwise the body is cut
// as soon as it passes the limit). The connection is closed after either 413.
//
// Every request, in this order:
//   1. `Host` must be the listen address (421 `misdirected`) — DNS rebinding;
//   2. a request carrying `Origin` is refused (403 `forbidden_origin`) — a web page is never a client;
//   3. after a revocation, everything answers 503 `revoked` (adj. 8);
//   4. `GET /v1/healthz` needs no token;
//   5. `Authorization: Bearer <local token>`, compared in constant time over sha256 (401 `unauthorized`);
//   6. the route (404 `not_found`, 405 `method_not_allowed` with `Allow`).
// Errors are `{ error: { code, message } }`. Every body and every event goes through the edge scan
// (api/edge.ts) first: a finding answers 500 `internal` (an event goes out `unavailable`).
//
// A write whose answer would be withheld at the edge (an id shape in the text or the file name) is
// refused BEFORE any effect, with the same 500 `internal` and `leak-blocked` line: an answer withheld
// after the send would invite a retry and a duplicate.
//
// This module imports neither the SDK nor @tayet/shared/internal (lint): it sees only the core's read
// and write facades, which take and hand out opaque tokens.
//
// The Slack layer (S-f, api/slack/router.ts) shares this listener: `/slack/…` is delegated to it after
// the Host and Origin checks, and it keeps the rest of the order (revoked → Bearer → method).
//
// The MCP server (S-g1, api/mcp/handler.ts; PLANO-AGENTES §0.3.13) shares this listener too: `/mcp` comes
// right after the Slack layer, with the same order — Host → Origin (here) → revoked (503) → Bearer (401)
// → POST only (405) → the body under JSON_MAX (413) — and its refusals carry a JSON-RPC error body.
//
// An upgrade is taken on one path only, the Slack layer's `/slack/socket` (S-f2, api/slack/socket.ts):
// Host (a Host with no port is accepted there, and only there, when its hostname is loopback and is the
// listener's own — §0.3.12 item 5) → Origin → revoked → the path (404) → the ticket (the layer). Every
// refusal is one short status line on the socket, then the socket is destroyed.
import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import type { ListenAddress } from '../args'
import type { CoreState } from '../core/handle'
import { ReadError, type ReadFacade } from '../core/read'
import { WriteError, type WriteFacade } from '../core/write'
import { approvalOptionsOf, type ApprovalFacade } from '../core/approvals'
import { PANEL_TEXT_MAX, type PanelFacade } from '../core/panels'
import { validateCommands, type CommandsFacade } from '../core/commands'
import { parseCompose, type RichDoc } from '@tayet/shared'
import { EventBus, type BusEntry } from './bus'
import type { ApiCloseApproval, ApiCommand, ApiEditMessage, ApiError, ApiErrorCode, ApiEvent, ApiMessage, ApiPostApproval, ApiPostMessage, ApiPutPanel } from './contract'
import { MIMETYPE, sendDownload } from './download'
import { isEmojiArgument } from './emoji'
import { logLeaks, scanApprovalProbe, scanCommandsProbe, scanEdge, scanPanelProbe, scanWriteProbe } from './edge'
import { createMcpLayer, type McpLayer } from './mcp/handler'
import type { SetTimer } from './mcp/wait'
import { createSlackLayer, type SlackLayer, type SlackMethods } from './slack/router'
import { SLACK_METHODS } from './slack/methods'
import { refuseUpgrade, type SocketOptions } from './slack/socket'

export const PING_MS = 10_000
export const SSE_MAX_BUFFER = 1024 * 1024
export const SSE_DRAIN_MS = 30_000
// After a revocation the API keeps answering 503 `revoked` at least this long before the process exits
// with 78, so a client between two requests sees the reason instead of a refused connection.
export const REVOKED_HOLD_MS = 250
// §0.3.7 item 2.
export const JSON_MAX = 256 * 1024
export const TEXT_MAX = 32 * 1024

type Log = (line: Record<string, unknown>) => void

export interface ApiServerOptions {
  read: ReadFacade
  write: WriteFacade
  // The approval cards (A3-3): absent → their routes answer 404.
  approvals?: ApprovalFacade
  // The pinned panel (A3-6): absent → its routes answer 404, as the cards'.
  panels?: PanelFacade
  // The agent's commands (A4-2a): absent → their routes answer 404, as the panel's.
  commands?: CommandsFacade
  state: () => CoreState
  token: string
  listen: ListenAddress
  log: Log
  bus?: EventBus
  pingMs?: number
  drainMs?: number
  maxBuffer?: number
  // The Slack layer (S-f, PLANO-AGENTES §0.3.12): absent → no `/slack/…` route. `methods` overrides the
  // method table (tests).
  slack?: { productUrl: string; uploadsDir?: string; cardsFile?: string; methods?: readonly SlackMethods[]; now?: () => number; socket?: SocketOptions }
  // The MCP server (S-g1, §0.3.13): absent → no `/mcp` route. `setTimer` is wait_for_mention's clock (tests).
  mcp?: { setTimer?: SetTimer }
}

export interface ApiServer {
  // Resolves with the URL once listening; rejects with the listen error (EADDRINUSE included).
  start(): Promise<string>
  readonly url: string | null
  readonly bus: EventBus
  // Revocation (adj. 8): every request 503 from now on; the streams get `agent.revoked` and end.
  // Resolves once the streams flushed (or after `graceMs`) and at least `holdMs` passed.
  revoke(graceMs?: number, holdMs?: number): Promise<void>
  close(): Promise<void>
}

const STATUS: Record<ApiErrorCode, number> = {
  unauthorized: 401,
  forbidden_origin: 403,
  misdirected: 421,
  not_found: 404,
  method_not_allowed: 405,
  conversation_not_found: 404,
  user_not_found: 404,
  message_not_found: 404,
  invalid_cursor: 400,
  invalid_argument: 400,
  not_member: 403,
  not_own_message: 403,
  not_editable: 400,
  not_approval: 400,
  rate_limited: 429,
  payload_too_large: 413,
  file_too_large: 413,
  file_not_found: 404,
  upstream_failed: 502,
  revoked: 503,
  unavailable: 503,
  internal: 500,
}

const MESSAGES: Record<ApiErrorCode, string> = {
  unauthorized: 'missing or wrong local token',
  forbidden_origin: 'requests from web pages are refused',
  misdirected: 'the Host header is not the address this API listens on',
  not_found: 'no such route',
  method_not_allowed: 'method not allowed on this route',
  conversation_not_found: 'no such conversation for this agent',
  user_not_found: 'no such person',
  message_not_found: 'no such message in this conversation',
  invalid_cursor: 'unknown or expired cursor',
  invalid_argument: 'invalid argument',
  not_member: 'the agent is not a member of this conversation',
  not_own_message: 'only the agent’s own messages can be changed',
  not_editable: 'only text messages and approval cards can be edited',
  not_approval: 'the message is not one of the agent’s approval cards',
  rate_limited: 'the server is limiting the agent; retry later',
  payload_too_large: 'the request body is too large',
  file_too_large: 'the file is larger than the upload limit',
  file_not_found: 'no such file for this agent; re-read the listing that showed it',
  upstream_failed: 'the server refused or could not be reached',
  revoked: 'the agent credential was revoked',
  unavailable: 'the agent is not ready',
  internal: 'internal error',
}

const isLoopback = (host: string): boolean => host === '127.0.0.1' || host === '::1' || host === 'localhost' || host.startsWith('127.')
const isWildcard = (host: string): boolean => host === '0.0.0.0' || host === '::'
const hostHeader = (host: string, port: number): string => (host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`)
const digest = (s: string): Buffer => createHash('sha256').update(s).digest()

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

function fail(res: ServerResponse, code: ApiErrorCode, headers?: Record<string, string>, retryAfterMs?: number): void {
  const body: ApiError = { error: { code, message: MESSAGES[code], ...(retryAfterMs !== undefined && { retryAfterMs }) } }
  send(res, STATUS[code], body, headers)
}

// A refusal of this layer (the body, the parameters), with its code.
class ApiFail extends Error {
  constructor(readonly code: ApiErrorCode) {
    super(code)
    this.name = 'ApiFail'
  }
}

type Route =
  | { name: 'me' }
  | { name: 'conversations' }
  | { name: 'conversation'; id: string }
  | { name: 'members'; id: string }
  | { name: 'messages'; id: string }
  | { name: 'message'; id: string; ts: string }
  | { name: 'reaction'; id: string; ts: string; emoji: string }
  | { name: 'files'; id: string }
  | { name: 'file'; id: string }
  | { name: 'person'; id: string }
  | { name: 'approvals'; id: string }
  | { name: 'approval'; id: string; ts: string }
  | { name: 'approvalClose'; id: string; ts: string }
  | { name: 'panel'; id: string }
  | { name: 'commands' }
  | { name: 'events' }
  | { name: 'healthz' }

// The methods of each route (the 405's `Allow`); a GET route answers HEAD too.
const ALLOW: Record<Route['name'], readonly string[]> = {
  me: ['GET'],
  conversations: ['GET'],
  conversation: ['GET'],
  members: ['GET'],
  messages: ['GET', 'POST'],
  message: ['PATCH', 'DELETE'],
  reaction: ['PUT', 'DELETE'],
  files: ['POST'],
  file: ['GET'],
  person: ['GET'],
  approvals: ['POST'],
  approval: ['GET'],
  approvalClose: ['POST'],
  panel: ['GET', 'PUT', 'DELETE'],
  commands: ['GET', 'PUT', 'DELETE'],
  events: ['GET'],
  healthz: ['GET'],
}

const segment = (raw: string): string => {
  try {
    return decodeURIComponent(raw)
  } catch {
    throw new ApiFail('invalid_argument')
  }
}

function route(path: string): Route | null {
  if (path === '/v1/healthz') return { name: 'healthz' }
  if (path === '/v1/me') return { name: 'me' }
  if (path === '/v1/conversations') return { name: 'conversations' }
  if (path === '/v1/events') return { name: 'events' }
  if (path === '/v1/commands') return { name: 'commands' }
  let m = /^\/v1\/conversations\/([^/]+)$/.exec(path)
  if (m !== null) return { name: 'conversation', id: segment(m[1] as string) }
  m = /^\/v1\/conversations\/([^/]+)\/members$/.exec(path)
  if (m !== null) return { name: 'members', id: segment(m[1] as string) }
  m = /^\/v1\/conversations\/([^/]+)\/messages$/.exec(path)
  if (m !== null) return { name: 'messages', id: segment(m[1] as string) }
  m = /^\/v1\/conversations\/([^/]+)\/messages\/([^/]+)$/.exec(path)
  if (m !== null) return { name: 'message', id: segment(m[1] as string), ts: segment(m[2] as string) }
  m = /^\/v1\/conversations\/([^/]+)\/messages\/([^/]+)\/reactions\/([^/]+)$/.exec(path)
  if (m !== null) return { name: 'reaction', id: segment(m[1] as string), ts: segment(m[2] as string), emoji: segment(m[3] as string) }
  m = /^\/v1\/conversations\/([^/]+)\/files$/.exec(path)
  if (m !== null) return { name: 'files', id: segment(m[1] as string) }
  m = /^\/v1\/files\/([^/]+)$/.exec(path)
  if (m !== null) return { name: 'file', id: segment(m[1] as string) }
  m = /^\/v1\/conversations\/([^/]+)\/approvals$/.exec(path)
  if (m !== null) return { name: 'approvals', id: segment(m[1] as string) }
  m = /^\/v1\/conversations\/([^/]+)\/approvals\/([^/]+)$/.exec(path)
  if (m !== null) return { name: 'approval', id: segment(m[1] as string), ts: segment(m[2] as string) }
  m = /^\/v1\/conversations\/([^/]+)\/approvals\/([^/]+)\/close$/.exec(path)
  if (m !== null) return { name: 'approvalClose', id: segment(m[1] as string), ts: segment(m[2] as string) }
  m = /^\/v1\/conversations\/([^/]+)\/panel$/.exec(path)
  if (m !== null) return { name: 'panel', id: segment(m[1] as string) }
  m = /^\/v1\/people\/([^/]+)$/.exec(path)
  if (m !== null) return { name: 'person', id: segment(m[1] as string) }
  return null
}

// ── Bodies ───────────────────────────────────────────────────────────────────────────────────────

// Reads the body up to `max` bytes. Over it — declared by Content-Length, or as soon as the stream
// passes it — `ApiFail(code)`; nothing more is read and the caller closes the connection.
function readBody(req: IncomingMessage, max: number, code: ApiErrorCode): Promise<Buffer> {
  const declared = req.headers['content-length']
  if (declared !== undefined && Number(declared) > max) return Promise.reject(new ApiFail(code))
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
        reject(new ApiFail(code))
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

function jsonObject(raw: Buffer, allowed: readonly string[]): Record<string, unknown> {
  let v: unknown
  try {
    v = JSON.parse(raw.toString('utf8'))
  } catch {
    throw new ApiFail('invalid_argument')
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new ApiFail('invalid_argument')
  // Unknown fields are refused: nothing is silently dropped.
  for (const k of Object.keys(v)) if (!allowed.includes(k)) throw new ApiFail('invalid_argument')
  return v as Record<string, unknown>
}

function textOf(body: Record<string, unknown>): string {
  const text = body.text
  if (typeof text !== 'string' || text.trim() === '') throw new ApiFail('invalid_argument')
  if (Buffer.byteLength(text, 'utf8') > TEXT_MAX) throw new ApiFail('payload_too_large')
  return text
}

const optionalString = (v: unknown): string | undefined => {
  if (v === undefined) return undefined
  if (typeof v !== 'string' || v === '') throw new ApiFail('invalid_argument')
  return v
}

// `markdown` (S-i, §0.3.15 item 2): opt-in on the native API; only a boolean is accepted.
function markdownOf(body: Record<string, unknown>): boolean | undefined {
  const v = body.markdown
  if (v === undefined) return undefined
  if (typeof v !== 'boolean') throw new ApiFail('invalid_argument')
  return v
}

function postOf(raw: Buffer): ApiPostMessage {
  const body = jsonObject(raw, ['text', 'thread', 'replyTo', 'mentions', 'markdown'])
  const out: ApiPostMessage = { text: textOf(body) }
  const markdown = markdownOf(body)
  if (markdown !== undefined) out.markdown = markdown
  const thread = optionalString(body.thread)
  const replyTo = optionalString(body.replyTo)
  if (thread !== undefined && replyTo !== undefined) throw new ApiFail('invalid_argument')
  if (thread !== undefined) out.thread = thread
  if (replyTo !== undefined) out.replyTo = replyTo
  if (body.mentions !== undefined) {
    if (!Array.isArray(body.mentions) || !body.mentions.every((m): m is string => typeof m === 'string')) throw new ApiFail('invalid_argument')
    out.mentions = body.mentions
  }
  return out
}

function editOf(raw: Buffer): ApiEditMessage {
  const body = jsonObject(raw, ['text', 'markdown'])
  const out: ApiEditMessage = { text: textOf(body) }
  const markdown = markdownOf(body)
  if (markdown !== undefined) out.markdown = markdown
  return out
}

// ADR-091 (A3-3): the card's body. `options` are checked by the core's rule (the same one the MCP uses).
function postApprovalOf(raw: Buffer): ApiPostApproval {
  const body = jsonObject(raw, ['text', 'markdown', 'options', 'thread', 'mentions'])
  const out: ApiPostApproval = { text: textOf(body), options: approvalOptionsOf(body.options) }
  const markdown = markdownOf(body)
  if (markdown !== undefined) out.markdown = markdown
  const thread = optionalString(body.thread)
  if (thread !== undefined) out.thread = thread
  if (body.mentions !== undefined) {
    if (!Array.isArray(body.mentions) || !body.mentions.every((m): m is string => typeof m === 'string')) throw new ApiFail('invalid_argument')
    out.mentions = body.mentions
  }
  return out
}

function closeApprovalOf(raw: Buffer): ApiCloseApproval {
  // An empty body is `{}`.
  const body = raw.length === 0 ? {} : jsonObject(raw, ['text', 'markdown'])
  const out: ApiCloseApproval = {}
  if (body.text !== undefined) out.text = textOf(body)
  const markdown = markdownOf(body)
  if (markdown !== undefined) out.markdown = markdown
  return out
}

// ADR-091 dec. 13 (A3-6): the panel's body. `thread` and `mentions` are unknown fields (400); the title's
// rule is the core's (the shared one).
function putPanelOf(raw: Buffer): ApiPutPanel {
  const body = jsonObject(raw, ['text', 'markdown', 'title'])
  const text = body.text
  if (typeof text !== 'string' || text.trim() === '') throw new ApiFail('invalid_argument')
  if (Buffer.byteLength(text, 'utf8') > PANEL_TEXT_MAX) throw new ApiFail('payload_too_large')
  const out: ApiPutPanel = { text }
  const markdown = markdownOf(body)
  if (markdown !== undefined) out.markdown = markdown
  if (body.title !== undefined) {
    if (typeof body.title !== 'string') throw new ApiFail('invalid_argument')
    out.title = body.title
  }
  return out
}

// ADR-093 (A4-2a): the commands' body. Any other field, in the body or in a command, is 400; the rules of each
// field, the count, the repeated name and the 8 KiB are the core's (validateCommands), before the leak-scan.
function putCommandsOf(raw: Buffer): ApiCommand[] {
  const body = jsonObject(raw, ['commands'])
  try {
    return validateCommands(body.commands)
  } catch (err) {
    if (err instanceof WriteError) throw new ApiFail(err.code === 'payload_too_large' ? 'payload_too_large' : 'invalid_argument')
    throw err
  }
}

// `markdown: true` → the parser (@tayet/shared, the same one the client's composer tests use); the
// formatted version only when there is formatting. The raw text stays the fallback.
function richOf(text: string, markdown: boolean | undefined): RichDoc | undefined {
  return markdown === true ? parseCompose(text).rich : undefined
}

// The emoji is the character itself (percent-encoded in the path); a `:name:` is S-f's.
function emojiOf(raw: string): string {
  if (!isEmojiArgument(raw)) throw new ApiFail('invalid_argument')
  return raw
}

function mimetypeOf(header: string | undefined): string {
  if (header === undefined || header.trim() === '') return 'application/octet-stream'
  const type = (header.split(';')[0] as string).trim().toLowerCase()
  if (!MIMETYPE.test(type)) throw new ApiFail('invalid_argument')
  return type
}

function intParam(q: URLSearchParams, key: string): number | undefined {
  const v = q.get(key)
  if (v === null) return undefined
  if (!/^\d{1,6}$/.test(v)) throw new ReadError('invalid_argument')
  return Number(v)
}

function strParam(q: URLSearchParams, key: string): string | undefined {
  const v = q.get(key)
  return v === null || v === '' ? undefined : v
}

// The error of a failed request → its answer (a 429 carries Retry-After in seconds, rounded up).
function failWith(res: ServerResponse, err: unknown): boolean {
  if (err instanceof ReadError || err instanceof ApiFail) {
    fail(res, err.code)
    return true
  }
  if (err instanceof WriteError) {
    if (err.code === 'rate_limited') {
      const ms = Math.max(err.retryAfterMs ?? 0, 0)
      fail(res, 'rate_limited', { 'retry-after': String(Math.max(Math.ceil(ms / 1000), 1)) }, ms)
    } else {
      fail(res, err.code)
    }
    return true
  }
  return false
}

// A message withheld at the edge: same ids, no content.
function withheld(m: ApiMessage): ApiMessage {
  return { id: m.id, conversation: m.conversation, author: m.author, text: '', mentionsMe: m.mentionsMe, reactions: [], unavailable: true }
}

// The answer a write would give, before the write: what the edge would withhold is refused now.
function preflight(log: Log, where: string, conversation: string, text: string, fileName?: string): void {
  const leaks = scanWriteProbe(conversation, text, fileName)
  if (leaks.length > 0) {
    logLeaks(log, where, leaks)
    throw new ApiFail('internal')
  }
}

export function createApiServer(opts: ApiServerOptions): ApiServer {
  const log = opts.log
  const bus = opts.bus ?? new EventBus({ log })
  const pingMs = opts.pingMs ?? PING_MS
  const drainMs = opts.drainMs ?? SSE_DRAIN_MS
  const maxBuffer = opts.maxBuffer ?? SSE_MAX_BUFFER
  const expected = digest(opts.token)
  let url: string | null = null
  let expectedHost: string | null = null
  let revoked = false
  const streams = new Set<{ res: ServerResponse; close: (final?: string) => void }>()

  const authorized = (header: string | undefined): boolean => {
    if (header === undefined || !header.startsWith('Bearer ')) return false
    return timingSafeEqual(digest(header.slice('Bearer '.length)), expected)
  }

  // ── Events: core → edge → bus (one scan per event, for every subscriber) ──
  const unsubscribeRead = opts.read.subscribe((event) => {
    const leaks = scanEdge(event)
    if (leaks.length === 0) {
      bus.publish(event)
      return
    }
    logLeaks(log, `event:${event.type}`, leaks)
    if ('message' in event) {
      const safe = { ...event, message: withheld(event.message) } as ApiEvent
      if (scanEdge(safe).length === 0) bus.publish(safe)
    }
  })

  const frame = (entry: BusEntry): string => `id: ${entry.id}\nevent: ${entry.event.type}\ndata: ${JSON.stringify(entry.event)}\n\n`
  const unheardFrame = (entry: BusEntry): string => `event: ${entry.event.type}\ndata: ${JSON.stringify(entry.event)}\n\n`

  const openStream = (req: IncomingMessage, res: ServerResponse): void => {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    let drainTimer: ReturnType<typeof setTimeout> | undefined
    let closed = false
    const stream = {
      res,
      close: (final?: string) => {
        if (closed) return
        closed = true
        clearInterval(ping)
        clearTimeout(drainTimer)
        unsubscribe()
        streams.delete(stream)
        if (final !== undefined) res.end(final)
        else res.destroy()
      },
    }
    // Backpressure (adj. 11): never wait for a slow client. A write the socket refuses starts a 30 s
    // window for `drain`; more than 1 MB buffered, or no drain in time → the connection is cut and the
    // client reconnects with Last-Event-ID.
    const write = (chunk: string): void => {
      if (closed) return
      const ok = res.write(chunk)
      if (res.writableLength > maxBuffer) {
        log({ evt: 'sse-cut', reason: 'buffer' })
        stream.close()
        return
      }
      if (!ok && drainTimer === undefined) {
        drainTimer = setTimeout(() => {
          log({ evt: 'sse-cut', reason: 'drain' })
          stream.close()
        }, drainMs)
        res.once('drain', () => {
          clearTimeout(drainTimer)
          drainTimer = undefined
        })
      }
    }
    // A consumer of the bus (api/bus.ts `open`): the replay of Last-Event-ID, the subscription, and — with
    // no valid cursor of this run — the events nobody heard (A3-3b), right after the `resync` (or first).
    // Those go without an `id:` line: the stream's cursor never moves back.
    const opened = bus.open(req.headers['last-event-id'] as string | undefined, (entry) => write(frame(entry)))
    const unsubscribe = opened.close
    const replay = opened.replay
    if (replay.kind === 'resync') {
      write(`id: ${replay.head}\nevent: resync\ndata: ${JSON.stringify({ type: 'resync' })}\n\n`)
    } else {
      for (const entry of replay.entries) write(frame(entry))
    }
    for (const entry of opened.unheard) write(unheardFrame(entry))
    write(': open\n\n')
    const ping = setInterval(() => write(': ping\n\n'), pingMs)
    streams.add(stream)
    req.on('close', () => stream.close())
  }

  const slack: SlackLayer | null =
    opts.slack !== undefined
      ? createSlackLayer(
          {
            read: opts.read,
            write: opts.write,
            log,
            productUrl: opts.slack.productUrl,
            uploadsDir: opts.slack.uploadsDir,
            baseUrl: () => url,
            bus,
            // The approval cards (A3-4): an `actions` block becomes a card, its click a `block_actions`.
            ...(opts.approvals !== undefined && { approvals: opts.approvals }),
            ...(opts.slack.cardsFile !== undefined && { cardsFile: opts.slack.cardsFile }),
            ...(opts.slack.now !== undefined && { now: opts.slack.now }),
            ...(opts.slack.socket !== undefined && { socket: opts.slack.socket }),
          },
          opts.slack.methods ?? SLACK_METHODS,
        )
      : null

  const mcp: McpLayer | null = opts.mcp !== undefined ? createMcpLayer({ read: opts.read, write: opts.write, log, bus, setTimer: opts.mcp.setTimer, ...(opts.approvals !== undefined && { approvals: opts.approvals }), ...(opts.panels !== undefined && { panels: opts.panels }), ...(opts.commands !== undefined && { commands: opts.commands }) }) : null

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (expectedHost !== null && req.headers.host !== expectedHost) return fail(res, 'misdirected')
    if (req.headers.origin !== undefined) return fail(res, 'forbidden_origin')
    const parsed = new URL(req.url ?? '/', 'http://local')
    // The Slack layer (§0.3.12): the same order from here — revoked → Bearer → the method — answered
    // in Slack's shape.
    if (slack !== null && slack.owns(parsed.pathname)) {
      const header = req.headers.authorization
      return slack.handle(req, res, parsed, { revoked, header, authorized: authorized(header) })
    }
    // The MCP server (§0.3.13): the same order, answered with JSON-RPC error bodies.
    if (mcp !== null && mcp.owns(parsed.pathname)) {
      if (revoked) return mcp.refuse(res, 'revoked')
      if (!authorized(req.headers.authorization)) return mcp.refuse(res, 'unauthorized')
      if (req.method !== 'POST') return mcp.refuse(res, 'method_not_allowed')
      let body: Buffer
      try {
        body = await readBody(req, JSON_MAX, 'payload_too_large')
      } catch (err) {
        if (err instanceof ApiFail && !req.complete) return tooLarge(req, res, err.code)
        throw err
      }
      return mcp.handle(req, res, body)
    }
    if (revoked) return fail(res, 'revoked')
    let r: Route | null
    try {
      r = route(parsed.pathname)
    } catch (err) {
      // A malformed percent-encoding: only an authorized caller learns it is a bad argument.
      if (!authorized(req.headers.authorization)) return fail(res, 'unauthorized')
      throw err
    }
    if (r?.name !== 'healthz' && !authorized(req.headers.authorization)) return fail(res, 'unauthorized')
    if (r === null) return fail(res, 'not_found')
    const allow = ALLOW[r.name]
    const method = req.method === 'HEAD' && allow.includes('GET') ? 'GET' : (req.method ?? '')
    if (!allow.includes(method)) return fail(res, 'method_not_allowed', { allow: allow.join(', ') })
    if (r.name === 'events') return openStream(req, res)
    if (method !== 'GET') return handleWrite(r, method, req, res, parsed.searchParams)
    if (r.name === 'file') return handleDownload(r.id, res)

    const q = parsed.searchParams
    let body: unknown
    switch (r.name) {
      case 'healthz':
        body = { state: opts.state() }
        break
      case 'me':
        body = await opts.read.me()
        break
      case 'conversations':
        body = opts.read.conversations({ limit: intParam(q, 'limit'), cursor: strParam(q, 'cursor') })
        break
      case 'conversation':
        body = opts.read.conversation(r.id)
        break
      case 'members':
        body = opts.read.members(r.id, { limit: intParam(q, 'limit'), cursor: strParam(q, 'cursor') })
        break
      case 'person':
        body = opts.read.person(r.id)
        break
      case 'approval':
        if (opts.approvals === undefined) return fail(res, 'not_found')
        body = await opts.approvals.state(r.id, r.ts)
        break
      case 'panel':
        if (opts.panels === undefined) return fail(res, 'not_found')
        body = await opts.panels.get(r.id)
        break
      case 'commands':
        if (opts.commands === undefined) return fail(res, 'not_found')
        body = opts.commands.get()
        break
      case 'message':
      case 'reaction':
      case 'files':
      case 'approvals':
      case 'approvalClose':
        // Not GET routes (ALLOW above).
        return fail(res, 'method_not_allowed', { allow: allow.join(', ') })
      case 'messages': {
        const inclusive = q.get('inclusive')
        body = await opts.read.messages(r.id, {
          limit: intParam(q, 'limit'),
          cursor: strParam(q, 'cursor'),
          oldest: strParam(q, 'oldest'),
          latest: strParam(q, 'latest'),
          inclusive: inclusive === 'true' || inclusive === '1',
          thread: strParam(q, 'thread'),
        })
        break
      }
    }
    reply(res, 200, body, `GET ${r.name}`)
  }

  // Every JSON answer through the edge (adj. 4).
  const reply = (res: ServerResponse, status: number, body: unknown, where: string): void => {
    const leaks = scanEdge(body)
    if (leaks.length > 0) {
      logLeaks(log, where, leaks)
      return fail(res, 'internal')
    }
    send(res, status, body)
  }

  const noContent = (res: ServerResponse): void => {
    res.writeHead(204, { 'cache-control': 'no-store' })
    res.end()
  }

  // A body over its limit: answer 413 and close the connection (what was not read is never read).
  const tooLarge = (req: IncomingMessage, res: ServerResponse, code: ApiErrorCode): void => {
    res.once('finish', () => req.socket.destroy())
    fail(res, code, { connection: 'close' })
  }

  const handleWrite = async (r: Route, method: string, req: IncomingMessage, res: ServerResponse, q: URLSearchParams): Promise<void> => {
    const write = opts.write
    try {
      if (r.name === 'messages' && method === 'POST') {
        const { markdown, ...post } = postOf(await readBody(req, JSON_MAX, 'payload_too_large'))
        preflight(log, 'POST messages', r.id, post.text)
        const rich = richOf(post.text, markdown)
        return reply(res, 200, await write.post(r.id, rich ? { ...post, rich } : post), 'POST messages')
      }
      if (r.name === 'message' && method === 'PATCH') {
        const edit = editOf(await readBody(req, JSON_MAX, 'payload_too_large'))
        preflight(log, 'PATCH message', r.id, edit.text)
        const rich = richOf(edit.text, edit.markdown)
        return reply(res, 200, await (rich ? write.edit(r.id, r.ts, edit.text, rich) : write.edit(r.id, r.ts, edit.text)), 'PATCH message')
      }
      if (r.name === 'approvals' || r.name === 'approvalClose') {
        const approvals = opts.approvals
        if (approvals === undefined) return fail(res, 'not_found')
        if (r.name === 'approvals') {
          const { markdown, ...post } = postApprovalOf(await readBody(req, JSON_MAX, 'payload_too_large'))
          const leaks = scanApprovalProbe(r.id, post.text, post.options)
          if (leaks.length > 0) {
            logLeaks(log, 'POST approvals', leaks)
            throw new ApiFail('internal')
          }
          const rich = richOf(post.text, markdown)
          return reply(res, 200, await approvals.request(r.id, rich ? { ...post, rich } : post), 'POST approvals')
        }
        const close = closeApprovalOf(await readBody(req, JSON_MAX, 'payload_too_large'))
        if (close.text !== undefined) preflight(log, 'POST approval close', r.id, close.text)
        const rich = close.text !== undefined ? richOf(close.text, close.markdown) : undefined
        return reply(res, 200, await approvals.close(r.id, r.ts, close.text, rich), 'POST approval close')
      }
      if (r.name === 'panel') {
        const panels = opts.panels
        if (panels === undefined) return fail(res, 'not_found')
        if (method === 'PUT') {
          const { markdown, ...put } = putPanelOf(await readBody(req, JSON_MAX, 'payload_too_large'))
          // Before anything is queued: an id shape in the text or the title never leaves.
          const leaks = scanPanelProbe(r.id, put.text, put.title)
          if (leaks.length > 0) {
            logLeaks(log, 'PUT panel', leaks)
            throw new ApiFail('internal')
          }
          const rich = richOf(put.text, markdown)
          return reply(res, 202, await panels.set(r.id, rich ? { ...put, rich } : put), 'PUT panel')
        }
        const cleared = await panels.clear(r.id)
        if (!cleared.pending) return noContent(res)
        return reply(res, 202, cleared, 'DELETE panel')
      }
      if (r.name === 'commands') {
        const commands = opts.commands
        if (commands === undefined) return fail(res, 'not_found')
        if (method === 'PUT') {
          const set = putCommandsOf(await readBody(req, JSON_MAX, 'payload_too_large'))
          // Before anything is kept or queued: an id shape in a name, a description or a hint never leaves.
          const leaks = scanCommandsProbe(set)
          if (leaks.length > 0) {
            logLeaks(log, 'PUT commands', leaks)
            throw new ApiFail('internal')
          }
          return reply(res, 202, await commands.set(set), 'PUT commands')
        }
        const cleared = await commands.clear()
        if (cleared === null) return noContent(res)
        return reply(res, 202, cleared, 'DELETE commands')
      }
      if (r.name === 'message' && method === 'DELETE') {
        await write.remove(r.id, r.ts)
        return noContent(res)
      }
      if (r.name === 'reaction') {
        const emoji = emojiOf(r.emoji)
        if (method === 'PUT') await write.react(r.id, r.ts, emoji)
        else await write.unreact(r.id, r.ts, emoji)
        return noContent(res)
      }
      if (r.name === 'files' && method === 'POST') {
        const name = q.get('name') ?? ''
        if (name === '' || name.length > 255 || name.includes('/')) throw new ApiFail('invalid_argument')
        const thread = strParam(q, 'thread')
        const mimetype = mimetypeOf(req.headers['content-type'])
        preflight(log, 'POST files', r.id, '', name)
        // A declared length over the limit is refused here, before the upload slot; the body itself is
        // read only once the slot is held (§0.3.7 item 4: one upload at a time, body included).
        const max = await write.uploadLimit()
        const declared = req.headers['content-length']
        if (declared !== undefined && Number(declared) > max) throw new ApiFail('file_too_large')
        const body = async (): Promise<Uint8Array> => new Uint8Array(await readBody(req, max, 'file_too_large'))
        const uploaded = await write.upload(r.id, { name, mimetype, body, ...(thread !== undefined && { thread }) })
        return reply(res, 200, uploaded, 'POST files')
      }
      return fail(res, 'method_not_allowed', { allow: ALLOW[r.name].join(', ') })
    } catch (err) {
      if (err instanceof ApiFail && (err.code === 'payload_too_large' || err.code === 'file_too_large') && !req.complete) {
        return tooLarge(req, res, err.code)
      }
      if (failWith(res, err)) return
      throw err
    }
  }

  const handleDownload = async (id: string, res: ServerResponse): Promise<void> => {
    let file
    try {
      file = await opts.write.download(id)
    } catch (err) {
      if (failWith(res, err)) return
      throw err
    }
    if (!sendDownload(res, file, log, 'GET file')) fail(res, 'internal')
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (failWith(res, err)) return
      // Never the message: an SDK error may carry a protocol URL.
      log({ evt: 'api-error', name: err instanceof Error ? err.name : typeof err })
      if (!res.headersSent) fail(res, 'internal')
      else res.destroy()
    })
  })

  // A Host with no port: only on the socket route, only the listener's own hostname, only loopback.
  const portlessLoopback = (header: string | undefined): boolean => {
    if (header === undefined) return false
    const host = /^\[(.+)\]$/.exec(header)?.[1] ?? (header.includes(':') ? null : header)
    return host !== null && host === opts.listen.host && isLoopback(host)
  }

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let parsed: URL
    try {
      parsed = new URL(req.url ?? '/', 'http://local')
    } catch {
      return refuseUpgrade(socket, 400)
    }
    const isSocket = slack !== null && slack.ownsSocket(parsed.pathname)
    const host = req.headers.host
    if (expectedHost !== null && host !== expectedHost && !(isSocket && portlessLoopback(host))) return refuseUpgrade(socket, 421)
    if (req.headers.origin !== undefined) return refuseUpgrade(socket, 403)
    if (revoked) return refuseUpgrade(socket, 503)
    if (slack === null || !isSocket) return refuseUpgrade(socket, 404)
    slack.upgrade(req, socket, head, parsed)
  })

  return {
    bus,
    get url() {
      return url
    },
    start() {
      return new Promise<string>((resolve, reject) => {
        const onError = (err: Error): void => reject(err)
        server.once('error', onError)
        server.listen(opts.listen.port, opts.listen.host, () => {
          server.off('error', onError)
          const port = (server.address() as AddressInfo).port
          // A wildcard address has no single Host to check (an agent in another container reaches it
          // by its own name); the local token still guards it.
          expectedHost = isWildcard(opts.listen.host) ? null : hostHeader(opts.listen.host, port)
          url = `http://${hostHeader(opts.listen.host, port)}`
          if (!isLoopback(opts.listen.host)) {
            log({ evt: 'listen-non-loopback', warning: 'the local API listens beyond this machine; the local token is the only guard' })
          }
          resolve(url)
        })
      })
    },
    async revoke(graceMs = 500, holdMs = REVOKED_HOLD_MS) {
      if (revoked) return
      revoked = true
      const hold = new Promise<void>((r) => setTimeout(r, holdMs))
      unsubscribeRead()
      // Every open stream writes it through its own subscription, then ends.
      bus.publish({ type: 'agent.revoked' })
      // The Slack sockets get `link_disabled` and close (S-f2).
      const sockets = slack?.revoke() ?? Promise.resolve()
      const finals = [...streams].map(
        (s) =>
          new Promise<void>((resolve) => {
            s.res.once('finish', () => resolve())
            s.close('')
          }),
      )
      await Promise.race([Promise.all([...finals, sockets]), new Promise<void>((r) => setTimeout(r, graceMs))])
      await hold
    },
    async close() {
      unsubscribeRead()
      await slack?.close()
      await mcp?.close()
      for (const s of [...streams]) s.close()
      await new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
    },
  }
}
