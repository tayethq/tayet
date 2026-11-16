// In-memory read and write facades for the Slack layer's tests (no SDK, no stack): a small world of
// conversations, people and messages, tokenized as the core hands them out, plus the real local API
// server on an ephemeral port and the real @slack/web-api client pointed at it.
import { WebClient, type WebClientOptions } from '@slack/web-api'
import { PROTOCOL_PATTERNS } from '@tayet/shared/leak-scan'
import { createApiServer, type ApiServer } from '../../src/api/server'
import type { ApiConversation, ApiEvent, ApiMe, ApiMessage, ApiPerson } from '../../src/api/contract'
import { ReadError, type MessageQuery, type ReadFacade } from '../../src/core/read'
import { WriteError, type PostRequest, type UploadRequest, type WriteFacade } from '../../src/core/write'
import type { SlackMethods } from '../../src/api/slack/router'
import type { ApprovalFacade } from '../../src/core/approvals'
import type { EventBus } from '../../src/api/bus'
import type { SocketOptions } from '../../src/api/slack/socket'

export const TOKEN = 'tal_slackLayerTestToken_0123456789'
export const ME: ApiMe = { id: 'UAGENTAAAAA', workspace: 'TWORKSPACEA', name: 'Relatórios', kind: 'agent' }
export const BOT = 'BAGENTAAAAA'
export const ALICE: ApiPerson = { id: 'UALICEAAAAA', name: 'Alice Souza', kind: 'member' }
export const BOB: ApiPerson = { id: 'UBOBAAAAAAA', name: 'Bob', kind: 'member' }
// Someone who left: no current name (the native person() answers ''), a name seen on an old message.
export const GONE: ApiPerson = { id: 'UGONEAAAAAA', name: '', kind: 'member' }
export const GENERAL: ApiConversation = { id: 'CGENERALAAA', name: 'geral', kind: 'public', topic: 'Avisos', memberCount: 3 }
export const SECRET: ApiConversation = { id: 'CSECRETAAAA', name: 'diretoria', kind: 'private', memberCount: 2 }
export const DM: ApiConversation = { id: 'DALICEAAAAA', name: 'Alice Souza', kind: 'dm', peer: ALICE.id, memberCount: 2 }
// ADR-094: a group conversation (Slack's `mpim`) — only in a world that asks for it (createWorld({ group: true })).
export const GROUP: ApiConversation = { id: 'CGROUPAAAAA', name: 'Alice Souza, Bob', kind: 'group', memberCount: 3 }

export interface Call {
  op: string
  conversation?: string
  [k: string]: unknown
}

export interface World {
  read: ReadFacade
  write: WriteFacade
  calls: Call[]
  messages: Map<string, ApiMessage[]>
  // The next write effects throw these, in order (a rate limit, …).
  failNext: WriteError[]
  // The received files download() knows (the core's file map), by F… (S-f3).
  files: Map<string, { name: string; mimetype: string; bytes: Uint8Array }>
  emit(event: ApiEvent): void
}

let clock = 1_731_000_000_000
const nextTs = (): string => {
  clock += 1000
  const s = Math.floor(clock / 1000)
  return `${s}.${String(clock % 1000).padStart(3, '0')}000`
}

export const message = (over: Partial<ApiMessage> & Pick<ApiMessage, 'id'>): ApiMessage => ({
  conversation: GENERAL.id,
  author: ALICE.id,
  text: '',
  mentionsMe: false,
  reactions: [],
  ...over,
})

export function createWorld(opts: { group?: boolean } = {}): World {
  const conversations = opts.group === true ? [GENERAL, SECRET, DM, GROUP] : [GENERAL, SECRET, DM]
  const people = new Map([ME, ALICE, BOB, GONE].map((p) => [p.id, p]))
  const members = new Map([
    [GENERAL.id, [ME.id, ALICE.id, BOB.id]],
    [SECRET.id, [ME.id, BOB.id]],
    [DM.id, [ME.id, ALICE.id]],
  ])
  if (opts.group === true) members.set(GROUP.id, [ME.id, ALICE.id, BOB.id])
  // Newest first, as the native listing.
  const messages = new Map<string, ApiMessage[]>([
    [
      GENERAL.id,
      [
        message({ id: '1730000300.000300', author: ALICE.id, text: 'resposta da Alice', thread: '1730000100.000100' }),
        message({ id: '1730000200.000200', author: GONE.id, text: 'mensagem de quem saiu' }),
        message({
          id: '1730000100.000100',
          author: BOB.id,
          text: 'pergunta do Bob',
          reactions: [{ emoji: '👍', count: 2, mine: true }],
          threadSummary: { replyCount: 1, latestReplyAt: 1730000300000 },
        }),
      ],
    ],
    [SECRET.id, []],
    [DM.id, []],
  ])
  const calls: Call[] = []
  const failNext: WriteError[] = []
  const files = new Map<string, { name: string; mimetype: string; bytes: Uint8Array }>()
  let listener: ((e: ApiEvent) => void) | null = null
  const cursors = new Map<string, number>()
  let cursorN = 0

  const conv = (id: string): ApiConversation => {
    const c = conversations.find((x) => x.id === id)
    if (c === undefined) throw new ReadError('conversation_not_found')
    return c
  }
  const page = <T>(scope: string, all: T[], limit = 100, cursor?: string): { items: T[]; next?: string } => {
    let offset = 0
    if (cursor !== undefined) {
      const o = cursors.get(`${scope} ${cursor}`)
      if (o === undefined) throw new ReadError('invalid_cursor')
      offset = o
    }
    const items = all.slice(offset, offset + limit)
    if (offset + limit >= all.length) return { items }
    const next = `cur_${++cursorN}`
    cursors.set(`${scope} ${next}`, offset + limit)
    return { items, next }
  }
  const key = (ts: string): bigint => BigInt(ts.replace('.', ''))
  const find = (conversation: string, ts: string): ApiMessage => {
    conv(conversation)
    const m = (messages.get(conversation) ?? []).find((x) => x.id === ts)
    if (m === undefined) throw new ReadError('message_not_found')
    return m
  }
  const effect = (op: string, data: Omit<Call, 'op'>): void => {
    const fail = failNext.shift()
    if (fail !== undefined) throw fail
    calls.push({ op, ...data })
  }

  const read: ReadFacade = {
    me: () => Promise.resolve(ME),
    bot: () => BOT,
    conversations: (q) => {
      const p = page('conversations', conversations, q.limit, q.cursor)
      return p.next !== undefined ? { conversations: p.items, next: p.next } : { conversations: p.items }
    },
    conversation: (id) => conv(id),
    members: (id, q) => {
      conv(id)
      const p = page(`members ${id}`, (members.get(id) ?? []).map((u) => people.get(u) as ApiPerson), q.limit, q.cursor)
      return p.next !== undefined ? { people: p.items, next: p.next } : { people: p.items }
    },
    person: (id) => {
      const p = people.get(id)
      if (p === undefined) throw new ReadError('user_not_found')
      return p
    },
    messages: (id, q: MessageQuery) => {
      conv(id)
      let all = messages.get(id) ?? []
      all = q.thread !== undefined ? all.filter((m) => m.thread === q.thread) : all.filter((m) => m.thread === undefined)
      if (q.thread !== undefined) find(id, q.thread)
      if (q.oldest !== undefined) all = all.filter((m) => (q.inclusive ? key(m.id) >= key(q.oldest as string) : key(m.id) > key(q.oldest as string)))
      if (q.latest !== undefined) all = all.filter((m) => (q.inclusive ? key(m.id) <= key(q.latest as string) : key(m.id) < key(q.latest as string)))
      const p = page(`messages ${id} ${q.thread ?? ''}`, all, q.limit, q.cursor)
      return Promise.resolve(p.next !== undefined ? { messages: p.items, next: p.next } : { messages: p.items })
    },
    message: (id, ts) => Promise.resolve(find(id, ts)),
    subscribe: (l) => {
      listener = l
      return () => {
        listener = null
      }
    },
  }

  const add = (conversation: string, m: ApiMessage): ApiMessage => {
    messages.set(conversation, [m, ...(messages.get(conversation) ?? [])])
    return m
  }

  const write: WriteFacade = {
    post: (conversation, req: PostRequest) => {
      conv(conversation)
      if (req.thread !== undefined) find(conversation, req.thread)
      effect('post', { conversation, ...req })
      const m = message({
        id: nextTs(),
        conversation,
        author: ME.id,
        text: req.text,
        ...(req.rich !== undefined && { rich: req.rich as unknown as Record<string, unknown> }),
        ...(req.thread !== undefined && { thread: req.thread }),
        ...(req.mentions !== undefined && req.mentions.length > 0 && { mentions: req.mentions }),
      })
      return Promise.resolve(add(conversation, m))
    },
    edit: (conversation, ts, text, rich) => {
      const m = find(conversation, ts)
      if (m.author !== ME.id) throw new WriteError('not_own_message')
      effect('edit', { conversation, ts, text, ...(rich !== undefined && { rich }) })
      m.text = text
      if (rich !== undefined) m.rich = rich as unknown as Record<string, unknown>
      m.editedAt = clock
      return Promise.resolve(m)
    },
    remove: (conversation, ts) => {
      const m = find(conversation, ts)
      if (m.author !== ME.id) throw new WriteError('not_own_message')
      effect('remove', { conversation, ts })
      messages.set(conversation, (messages.get(conversation) ?? []).filter((x) => x.id !== ts))
      return Promise.resolve()
    },
    // Idempotent as the core: false (no effect) when the agent already has it / has none.
    react: (conversation, ts, emoji) => {
      const m = find(conversation, ts)
      const r = m.reactions.find((x) => x.emoji === emoji)
      if (r?.mine === true) return Promise.resolve(false)
      effect('react', { conversation, ts, emoji })
      if (r !== undefined) Object.assign(r, { count: r.count + 1, mine: true })
      else m.reactions.push({ emoji, count: 1, mine: true })
      return Promise.resolve(true)
    },
    unreact: (conversation, ts, emoji) => {
      const m = find(conversation, ts)
      const r = m.reactions.find((x) => x.emoji === emoji)
      if (r?.mine !== true) return Promise.resolve(false)
      effect('unreact', { conversation, ts, emoji })
      if (r.count > 1) Object.assign(r, { count: r.count - 1, mine: false })
      else m.reactions.splice(m.reactions.indexOf(r), 1)
      return Promise.resolve(true)
    },
    uploadLimit: () => Promise.resolve(1024 * 1024),
    upload: async (conversation, req: UploadRequest) => {
      conv(conversation)
      if (req.thread !== undefined) find(conversation, req.thread)
      const bytes = await req.body()
      effect('upload', { conversation, name: req.name, mimetype: req.mimetype, size: bytes.byteLength, bytes, ...(req.thread !== undefined && { thread: req.thread }) })
      const m = message({
        id: nextTs(),
        conversation,
        author: ME.id,
        files: [{ id: `FUPLOADAAA${'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[calls.length % 32]}`, name: req.name, mimetype: req.mimetype, size: bytes.byteLength }],
        ...(req.thread !== undefined && { thread: req.thread }),
      })
      return add(conversation, m)
    },
    download: (id) => {
      const f = files.get(id)
      if (f === undefined) return Promise.reject(new WriteError('file_not_found'))
      const fail = failNext.shift()
      return fail !== undefined ? Promise.reject(fail) : Promise.resolve({ bytes: f.bytes, mimetype: f.mimetype, name: f.name })
    },
  }

  return { read, write, calls, messages, failNext, files, emit: (e) => listener?.(e) }
}

export interface SlackHarness {
  world: World
  api: ApiServer
  url: string
  logs: Array<Record<string, unknown>>
  client(opts?: WebClientOptions, token?: string): WebClient
  // A raw call (fetch), for what WebClient cannot send (JSON bodies, a wrong Origin, …).
  raw(method: string, init?: RequestInit & { query?: Record<string, string> }): Promise<{ status: number; headers: Headers; body: Record<string, unknown> }>
  close(): Promise<void>
}

export interface SlackStart {
  methods?: readonly SlackMethods[]
  uploadsDir?: string
  world?: World
  now?: () => number
  // The listen address (the socket tests restart on the same port).
  port?: number
  socket?: SocketOptions
  // The approval cards (A3-4): the facade, the layer's file, the bus (to read the unheard).
  approvals?: ApprovalFacade
  cardsFile?: string
  bus?: EventBus
}

export async function startSlack(opts: SlackStart = {}): Promise<SlackHarness> {
  const world = opts.world ?? createWorld()
  const logs: Array<Record<string, unknown>> = []
  const api = createApiServer({
    read: world.read,
    write: world.write,
    state: () => 'online',
    token: TOKEN,
    listen: { host: '127.0.0.1', port: opts.port ?? 0 },
    log: (l) => logs.push(l),
    ...(opts.approvals !== undefined && { approvals: opts.approvals }),
    ...(opts.bus !== undefined && { bus: opts.bus }),
    slack: {
      productUrl: 'https://chat.example.com',
      ...(opts.cardsFile !== undefined && { cardsFile: opts.cardsFile }),
      ...(opts.now !== undefined && { now: opts.now }),
      ...(opts.socket !== undefined && { socket: opts.socket }),
      ...(opts.uploadsDir !== undefined && { uploadsDir: opts.uploadsDir }),
      ...(opts.methods !== undefined && { methods: opts.methods }),
    },
  })
  const url = await api.start()
  return {
    world,
    api,
    url,
    logs,
    client: (o = {}, token = TOKEN) =>
      new WebClient(token, { slackApiUrl: `${url}/slack/api/`, retryConfig: { retries: 0 }, logLevel: undefined, ...o }),
    async raw(method, init = {}) {
      const { query, ...rest } = init
      const qs = query !== undefined ? `?${new URLSearchParams(query).toString()}` : ''
      const res = await fetch(`${url}/slack/api/${method}${qs}`, { method: 'POST', ...rest, headers: { authorization: `Bearer ${TOKEN}`, ...(rest.headers as Record<string, string>) } })
      return { status: res.status, headers: res.headers, body: (await res.json()) as Record<string, unknown> }
    },
    close: () => api.close(),
  }
}

// The leak-scan of the tests over a whole Slack answer: no protocol id shape anywhere (mxid, room id,
// event id, media URI, the `u-`/`a-` localparts), and every id-valued field a token of its kind.
const ID_KEYS: Record<string, RegExp> = {
  id: /^[CDUTFB][A-Z2-7]{10}$/,
  user: /^U[A-Z2-7]{10}$/,
  user_id: /^U[A-Z2-7]{10}$/,
  bot_id: /^B[A-Z2-7]{10}$/,
  team: /^T[A-Z2-7]{10}$/,
  team_id: /^T[A-Z2-7]{10}$/,
  channel: /^[CD][A-Z2-7]{10}$/,
  ts: /^\d+\.\d{6}$/,
  thread_ts: /^\d+\.\d{6}$/,
  file_id: /^F[A-Z2-7]{10}$/,
}
export function idLeaks(body: unknown): string[] {
  const out: string[] = []
  const walk = (v: unknown, path: string, key: string | null): void => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`, key === 'members' || key === 'users' ? 'user' : null))
    if (typeof v === 'string') {
      for (const p of LOG_PATTERNS) if (p.re.test(v)) out.push(`${path}: ${p.name}`)
      // auth.test's top-level `user` is the agent's name (Slack's handle), not an id.
      const shape = key !== null && path !== '$.user' ? ID_KEYS[key] : undefined
      if (shape !== undefined && !shape.test(v)) out.push(`${path}: not a token`)
      return
    }
    if (v === null || typeof v !== 'object') return
    for (const [k, val] of Object.entries(v)) walk(val, `${path}.${k}`, k)
  }
  walk(body, '$', null)
  return out
}
const LOG_PATTERNS = PROTOCOL_PATTERNS.filter((p) => ['mxid', 'room-id', 'event-id', 'mxc-uri', 'opaque-localpart', 'agent-localpart'].includes(p.name))

// One method call through the real client; the answer as a plain record (asserted with toMatchObject).
export async function call(client: WebClient, method: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return (await client.apiCall(method, args)) as unknown as Record<string, unknown>
}

// The `error` of a refused call (the SDK throws a platform error for `{ ok: false }`).
export async function refusal(client: WebClient, method: string, args: Record<string, unknown> = {}): Promise<string> {
  try {
    await client.apiCall(method, args)
  } catch (err) {
    return (err as { data?: { error?: string } }).data?.error ?? String(err)
  }
  return 'ok'
}
