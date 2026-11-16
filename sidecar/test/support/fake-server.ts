// A fake product + server for the unit tests that spawn dist/cli.js: the discovery document, whoami,
// and just enough of the client-server API for the SDK to reach SYNCING (versions, filter, push
// rules, keys upload/query, an empty /sync). `revoke()` flips every authenticated request to
// 401 M_UNKNOWN_TOKEN — the runtime revocation of ADR-087 dec. 8. S-b2: the first /sync has the
// agent joined to one unencrypted room (ROOM_ID), and PUT …/send/… answers per `sendPlan` (one entry
// consumed per request; empty = accept), recording each request in `sends`. S-c1: a name, the person
// and two messages in ROOM_ID; a direct room without m.direct (the backfill writes it); live events by
// `push`; account data echoed in the next batch; profile and an empty /messages. S-c2: every write
// (PUT …/send/<type>/… and …/redact/…) answers per `sendPlan` and is echoed in the next /sync with
// its transaction id; GET …/event/… serves what was sent; a room the agent LEFT; a room of files (one
// clear, one encrypted whose hash does not match, one whose name is an id); the media config, upload
// and authenticated download. Operator 1 (PLANO-AGENTES §0.3.10): the escrow at `/escrow` (the
// document's relative `account`) answers GET /escrow/v1/people/me per `escrow`, with `operator`. S-h
// (PLANO-AGENTES §0.3.14): POST /escrow/v1/agents/:id/reissue answers per `reissue`; a 201 kills the
// calling token (every authenticated request with it → 401 M_UNKNOWN_TOKEN, `kill()` does the same by
// hand), hands out a new token and moves the agent to a new device. keys/upload records the device
// that uploaded; keys/query naming a device answers that device's keys once it uploaded (the sidecar's
// own probe, device-keys.ts; the SDK's queries name no device and get nothing, as before).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FakeOptions {
  userId?: string
  deviceId?: string
  // 'json' serves the discovery document; 'html' answers like the product's SPA (200 text/html).
  wellKnown?: 'json' | 'html' | 'none'
  // Whether /_matrix/client/versions answers (the dev fallback).
  versions?: boolean
  whoami?: 'ok' | 'unknown-token' | 'forbidden' | 'no-device' | 'not-found' | 'html' | 'no-user'
  // Answers of the next sends, in order: 'ok' (200 with an event id), 'limit' (429 M_LIMIT_EXCEEDED
  // with retry_after_ms = limitMs), 'unknown-token' (401 M_UNKNOWN_TOKEN, then revoked for good).
  sendPlan?: Array<'ok' | 'limit' | 'unknown-token'>
  limitMs?: number
  // S-c2: the delay before a write is answered; m.upload.size of the media config.
  sendDelayMs?: number
  uploadSize?: number
  // The media endpoints' answer (round 2): 'unknown-token' = 401 M_UNKNOWN_TOKEN, then revoked for good.
  uploadAnswer?: 'ok' | 'unknown-token'
  downloadAnswer?: 'ok' | 'unknown-token'
  // GET /escrow/v1/people/me (step 3b): 'ok' = { admin, kind: 'agent', operator }; 'no-operator' = the
  // agent with nothing recorded; 'unknown-token' = 401; 'not-found' = 404; 'not-agent' = no `kind`.
  escrow?: 'ok' | 'no-operator' | 'unknown-token' | 'not-found' | 'not-agent'
  // The operator's mxid in the escrow's answer (default: the person, PERSON).
  operator?: string
  // Paths never answered (held open until close()): a stop while those requests are in flight
  // (PLANO-AGENTES §8.20).
  hold?: string[]
  // S-h: the answer of the self-reissue. '201' = { token, deviceId }, the caller's token killed.
  reissue?: '201' | 'too-soon' | 'session' | 'mint' | 'sweep' | '401' | '403' | '404' | 'not-agent' | 'network'
  // S-h: a pause before every whoami answer (the window between the pre-lock read and the lock).
  whoamiDelayMs?: number
  // S-h: whether keys/query naming a device answers the keys it uploaded (false = never, as for a
  // second agent of its own: the fake has one device).
  publishedKeys?: boolean
}

export interface FakeReissue {
  at: number
  // The token of the caller (the sidecar's credential of the run) and the one handed out (201 only).
  caller: string
  issued?: string
  deviceId?: string
}

export const ROOM_ID = '!room:fake.local'
// S-c1: a direct conversation with the person, joined from a direct invite (prev_content) but with no
// m.direct entry — the boot backfill writes it (PUT account_data, echoed in the next /sync).
export const DM_ID = '!dm:fake.local'
export const PERSON = '@alice:fake.local'
// Two messages of the person in ROOM_ID's first batch (oldest first); the second mentions the agent.
export const ROOM_MESSAGES = [
  { event_id: '$m1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', origin_server_ts: 1_730_900_000_100, body: 'bom dia' },
  { event_id: '$m2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', origin_server_ts: 1_730_900_000_200, body: 'please verify the backup; o contrato está no cofre' },
]

// S-c2: a room the agent left (known to its client, not joined) and a room of files.
export const LEFT_ID = '!left:fake.local'
export const FILES_ID = '!files:fake.local'
export const FILE_CLEAR = { uri: 'mxc://fake.local/clear1', name: 'relatorio.txt', bytes: Buffer.from('conteúdo do relatório\n') }
export const FILE_TAMPERED = { uri: 'mxc://fake.local/enc1', name: 'cifrado.bin' }
export const FILE_ID_NAME = { uri: 'mxc://fake.local/leak1', name: '@mallory:fake.local' }

export interface FakeSend {
  at: number
  txnId: string
  // The event type (m.room.message, m.reaction, m.room.redaction).
  type: string
  body: Record<string, unknown>
}

export interface FakeUpload {
  at: number
  contentType: string | undefined
  query: string
  size: number
}

export interface FakeServer {
  url: string
  requests: string[]
  sends: FakeSend[]
  uploads: FakeUpload[]
  // The m.direct the sidecar wrote (null until it writes).
  direct: () => Record<string, unknown> | null
  set(opts: Partial<FakeOptions>): void
  // A live timeline event for the next /sync batch.
  push(roomId: string, event: Record<string, unknown>): void
  revoke(): void
  // S-h.
  reissues: FakeReissue[]
  kill(token: string): void
  revive(token: string): void
  // The devices that uploaded keys (keys/upload) and the keys/query bodies that named a device.
  uploadedKeys: Set<string>
  close(): Promise<void>
}

const UNKNOWN_TOKEN = { errcode: 'M_UNKNOWN_TOKEN', error: 'Token is not active', soft_logout: false }

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

// The agent joined to one unencrypted room: create + its own membership; S-c1 adds a name, the person
// and two messages of hers.
function joinedRoom(userId: string): Record<string, unknown> {
  const state = [
    { type: 'm.room.create', state_key: '', sender: userId, event_id: '$create', origin_server_ts: 1, content: { room_version: '10' } },
    { type: 'm.room.member', state_key: userId, sender: userId, event_id: '$member', origin_server_ts: 2, content: { membership: 'join' } },
    { type: 'm.room.name', state_key: '', sender: userId, event_id: '$name', origin_server_ts: 3, content: { name: 'produção' } },
    { type: 'm.room.join_rules', state_key: '', sender: userId, event_id: '$rules', origin_server_ts: 4, content: { join_rule: 'public' } },
    { type: 'm.room.member', state_key: PERSON, sender: PERSON, event_id: '$alice', origin_server_ts: 5, content: { membership: 'join', displayname: 'Alice' } },
  ]
  const timeline = ROOM_MESSAGES.map((m, i) => ({
    type: 'm.room.message',
    sender: PERSON,
    event_id: m.event_id,
    origin_server_ts: m.origin_server_ts,
    content: { msgtype: 'm.text', body: m.body, ...(i === 1 ? { 'm.mentions': { user_ids: [userId] } } : {}) },
  }))
  return {
    state: { events: state },
    timeline: { events: timeline, limited: false },
    ephemeral: { events: [] },
    account_data: { events: [] },
    unread_notifications: {},
    summary: { 'm.joined_member_count': 1, 'm.invited_member_count': 0 },
  }
}

function filesRoom(userId: string): Record<string, unknown> {
  const state = [
    { type: 'm.room.create', state_key: '', sender: userId, event_id: '$fcreate', origin_server_ts: 20, content: { room_version: '10' } },
    { type: 'm.room.member', state_key: userId, sender: userId, event_id: '$fmember', origin_server_ts: 21, content: { membership: 'join' } },
    { type: 'm.room.name', state_key: '', sender: userId, event_id: '$fname', origin_server_ts: 22, content: { name: 'arquivos' } },
    { type: 'm.room.member', state_key: PERSON, sender: PERSON, event_id: '$falice', origin_server_ts: 23, content: { membership: 'join', displayname: 'Alice' } },
  ]
  const file = (id: string, ts: number, content: Record<string, unknown>) => ({ type: 'm.room.message', sender: PERSON, event_id: id, origin_server_ts: ts, content })
  const timeline = [
    file('$f1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1_730_900_000_300, {
      msgtype: 'm.file',
      body: FILE_CLEAR.name,
      url: FILE_CLEAR.uri,
      info: { mimetype: 'text/plain', size: FILE_CLEAR.bytes.length },
    }),
    file('$f2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1_730_900_000_400, {
      msgtype: 'm.file',
      body: FILE_TAMPERED.name,
      // A well-formed envelope whose hash matches nothing the server serves.
      file: {
        v: 'v2',
        url: FILE_TAMPERED.uri,
        key: { kty: 'oct', key_ops: ['encrypt', 'decrypt'], alg: 'A256CTR', k: 'qcHVMSgYg-71CauWBezXI5qkaRb0LuIy-Wx5kIaHMIA', ext: true },
        iv: 'X85+XgHN+HEAAAAAAAAAAA',
        hashes: { sha256: 'LYG5Uz4oxyQRGNRJlCPKtArYYxZEuZQY6xV2wQh9Yl4' },
      },
      info: { mimetype: 'application/octet-stream', size: 16 },
    }),
    file('$f3aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1_730_900_000_500, {
      msgtype: 'm.file',
      body: FILE_ID_NAME.name,
      url: FILE_ID_NAME.uri,
      info: { mimetype: 'text/plain', size: 3 },
    }),
  ]
  return {
    state: { events: state },
    timeline: { events: timeline, limited: false },
    ephemeral: { events: [] },
    account_data: { events: [] },
    unread_notifications: {},
    summary: { 'm.joined_member_count': 2, 'm.invited_member_count': 0 },
  }
}

function leftRoom(userId: string): Record<string, unknown> {
  const state = [
    { type: 'm.room.create', state_key: '', sender: PERSON, event_id: '$lcreate', origin_server_ts: 30, content: { room_version: '10' } },
    { type: 'm.room.name', state_key: '', sender: PERSON, event_id: '$lname', origin_server_ts: 31, content: { name: 'antiga' } },
  ]
  const timeline = [{ type: 'm.room.member', state_key: userId, sender: userId, event_id: '$lleave', origin_server_ts: 33, content: { membership: 'leave' } }]
  return { state: { events: state }, timeline: { events: timeline, limited: false }, account_data: { events: [] } }
}

function directRoom(userId: string): Record<string, unknown> {
  const state = [
    { type: 'm.room.create', state_key: '', sender: PERSON, event_id: '$dmcreate', origin_server_ts: 10, content: { room_version: '10' } },
    { type: 'm.room.member', state_key: PERSON, sender: PERSON, event_id: '$dmalice', origin_server_ts: 11, content: { membership: 'join', displayname: 'Alice' } },
    {
      type: 'm.room.member',
      state_key: userId,
      sender: userId,
      event_id: '$dmjoin',
      origin_server_ts: 13,
      content: { membership: 'join' },
      unsigned: { prev_content: { membership: 'invite', is_direct: true }, replaces_state: '$dminvite' },
    },
  ]
  return {
    state: { events: state },
    timeline: { events: [], limited: false },
    ephemeral: { events: [] },
    account_data: { events: [] },
    unread_notifications: {},
    summary: { 'm.joined_member_count': 2, 'm.invited_member_count': 0 },
  }
}

export async function startFakeServer(initial: FakeOptions = {}): Promise<FakeServer> {
  const opts: Required<FakeOptions> = {
    userId: '@a-abcdefghijkl:fake.local',
    deviceId: 'FAKEDEV001',
    wellKnown: 'json',
    versions: true,
    whoami: 'ok',
    sendPlan: [],
    limitMs: 200,
    sendDelayMs: 0,
    uploadSize: 1024 * 1024,
    uploadAnswer: 'ok',
    downloadAnswer: 'ok',
    escrow: 'ok',
    operator: PERSON,
    hold: [],
    reissue: '201',
    whoamiDelayMs: 0,
    publishedKeys: true,
    ...initial,
  }
  const dead = new Set<string>()
  const reissues: FakeReissue[] = []
  const uploadedKeys = new Set<string>()
  let revoked = false
  let batch = 0
  const requests: string[] = []
  const sends: FakeSend[] = []
  const uploads: FakeUpload[] = []
  // Everything the server holds by event id (the first batch and what was sent), for GET …/event/….
  const events = new Map<string, Record<string, unknown>>()
  const media = new Map<string, Buffer>([
    [FILE_CLEAR.uri, FILE_CLEAR.bytes],
    [FILE_TAMPERED.uri, Buffer.alloc(16, 9)],
    [FILE_ID_NAME.uri, Buffer.from('abc')],
  ])
  let url = ''
  let sent = 0
  let direct: Record<string, unknown> | null = null
  const pendingAccountData: Array<Record<string, unknown>> = []
  const pendingTimeline = new Map<string, Array<Record<string, unknown>>>()

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const path = (req.url ?? '/').split('?')[0] ?? '/'
    // A whoami answered after `whoamiDelayMs` comes back here once: recorded the first time only.
    if (!(req as { delayed?: boolean }).delayed) requests.push(`${req.method} ${path}`)
    if (opts.hold.includes(path)) return
    const authed = typeof req.headers.authorization === 'string'
    const bearer = authed ? (req.headers.authorization as string).replace(/^Bearer /, '') : ''
    if (authed && dead.has(bearer)) {
      return path.startsWith('/escrow/') ? json(res, 401, { error: 'unauthorized' }) : json(res, 401, UNKNOWN_TOKEN)
    }

    if (path === '/.well-known/tayet/agent') {
      if (opts.wellKnown === 'json') return json(res, 200, { server: url, account: '/escrow' })
      if (opts.wellKnown === 'html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        return void res.end('<!doctype html><html></html>')
      }
      return json(res, 404, { errcode: 'M_NOT_FOUND' })
    }
    if (path === '/_matrix/client/versions') {
      if (!opts.versions) return json(res, 404, { errcode: 'M_UNRECOGNIZED' })
      return json(res, 200, { versions: ['v1.11'], unstable_features: {} })
    }
    const reissue = /^\/escrow\/v1\/agents\/([^/]+)\/reissue$/.exec(path)
    if (reissue !== null && req.method === 'POST') {
      if (!authed || revoked) return json(res, 401, { error: 'unauthorized' })
      const entry: FakeReissue = { at: Date.now(), caller: bearer }
      reissues.push(entry)
      if (decodeURIComponent(reissue[1] ?? '') !== opts.userId) return json(res, 403, { error: 'forbidden' })
      switch (opts.reissue) {
        case 'network':
          return void req.socket.destroy()
        case 'too-soon':
          res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '60' })
          return void res.end(JSON.stringify({ error: 'reissue_too_soon' }))
        case 'session':
        case 'mint':
        case 'sweep':
          if (opts.reissue !== 'session') dead.add(bearer)
          return json(res, 502, { error: 'partial', step: opts.reissue })
        case '401':
          return json(res, 401, { error: 'unauthorized' })
        case '403':
          return json(res, 403, { error: 'forbidden' })
        case '404':
          return json(res, 404, { error: 'not_found' })
        case 'not-agent':
          return json(res, 400, { error: 'not_agent' })
        default: {
          dead.add(bearer)
          entry.issued = `mpt_rotated${reissues.length}_DoNotLog_abcdefghijklmnop`
          entry.deviceId = `FAKEROT${String(reissues.length).padStart(3, '0')}`
          opts.deviceId = entry.deviceId
          return json(res, 201, { token: entry.issued, deviceId: entry.deviceId })
        }
      }
    }
    if (path === '/escrow/v1/people/me') {
      if (!authed || revoked || opts.escrow === 'unknown-token') return json(res, 401, { error: 'unauthorized' })
      if (opts.escrow === 'not-found') return json(res, 404, { error: 'not_found' })
      if (opts.escrow === 'not-agent') return json(res, 200, { admin: false })
      if (opts.escrow === 'no-operator') return json(res, 200, { admin: false, kind: 'agent' })
      return json(res, 200, { admin: false, kind: 'agent', operator: opts.operator })
    }
    if (authed && revoked) return json(res, 401, UNKNOWN_TOKEN)
    if (path === '/_matrix/client/v3/account/whoami' && opts.whoamiDelayMs > 0 && !(req as { delayed?: boolean }).delayed) {
      ;(req as { delayed?: boolean }).delayed = true
      return void setTimeout(() => handle(req, res), opts.whoamiDelayMs)
    }
    if (path === '/_matrix/client/v3/account/whoami') {
      if (opts.whoami === 'unknown-token') return json(res, 401, UNKNOWN_TOKEN)
      if (opts.whoami === 'no-device') return json(res, 200, { user_id: opts.userId, is_guest: false })
      if (opts.whoami === 'forbidden') return json(res, 403, { errcode: 'M_FORBIDDEN', error: 'forbidden' })
      if (opts.whoami === 'not-found') return json(res, 404, { errcode: 'M_UNRECOGNIZED' })
      if (opts.whoami === 'no-user') return json(res, 200, { device_id: opts.deviceId })
      if (opts.whoami === 'html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        return void res.end('<!doctype html><html></html>')
      }
      return json(res, 200, { user_id: opts.userId, device_id: opts.deviceId, is_guest: false })
    }
    if (path.endsWith('/filter')) return json(res, 200, { filter_id: '1' })
    if (path.startsWith('/_matrix/client/v3/pushrules')) return json(res, 200, { global: {} })
    if (path === '/_matrix/client/v3/capabilities') return json(res, 200, { capabilities: {} })
    if (path === '/_matrix/client/v3/keys/upload') {
      uploadedKeys.add(opts.deviceId)
      return json(res, 200, { one_time_key_counts: { signed_curve25519: 50 } })
    }
    if (path === '/_matrix/client/v3/keys/query') {
      let raw = ''
      req.setEncoding('utf8').on('data', (c: string) => (raw += c))
      req.on('end', () => {
        const asked = ((JSON.parse(raw || '{}') as { device_keys?: Record<string, string[]> }).device_keys ?? {})[opts.userId] ?? []
        const mine = Object.fromEntries(
          asked.filter((d) => opts.publishedKeys && uploadedKeys.has(d)).map((d) => [d, { user_id: opts.userId, device_id: d, algorithms: [], keys: {}, signatures: {} }]),
        )
        json(res, 200, { device_keys: Object.keys(mine).length > 0 ? { [opts.userId]: mine } : {}, failures: {} })
      })
      return
    }
    // Every write: …/send/<type>/<txn> and …/redact/<event>/<txn> (S-c2), answered per sendPlan,
    // echoed in the next /sync with its transaction id.
    const write =
      /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/send\/([^/]+)\/([^/]+)$/.exec(path) ??
      /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/(redact)\/([^/]+)\/([^/]+)$/.exec(path)
    if (write !== null && req.method === 'PUT') {
      const roomId = decodeURIComponent(write[1] ?? '')
      const redaction = write[2] === 'redact'
      const type = redaction ? 'm.room.redaction' : decodeURIComponent(write[2] ?? '')
      const txnId = decodeURIComponent((redaction ? write[4] : write[3]) ?? '')
      let raw = ''
      req.setEncoding('utf8').on('data', (c: string) => (raw += c))
      req.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>
        sends.push({ at: Date.now(), txnId, type, body: redaction ? { ...body, redacts: decodeURIComponent(write[3] ?? '') } : body })
        const next = opts.sendPlan.shift() ?? 'ok'
        setTimeout(() => {
          if (next === 'limit') {
            return json(res, 429, { errcode: 'M_LIMIT_EXCEEDED', error: 'Too Many Requests', retry_after_ms: opts.limitMs })
          }
          if (next === 'unknown-token') {
            revoked = true
            return json(res, 401, UNKNOWN_TOKEN)
          }
          sent += 1
          const eventId = `$sent${sent}`
          const ev: Record<string, unknown> = {
            type,
            sender: opts.userId,
            event_id: eventId,
            origin_server_ts: Date.now(),
            content: body,
            room_id: roomId,
            unsigned: { transaction_id: txnId },
            ...(redaction && { redacts: decodeURIComponent(write[3] ?? '') }),
          }
          events.set(eventId, ev)
          const list = pendingTimeline.get(roomId) ?? []
          list.push(ev)
          pendingTimeline.set(roomId, list)
          json(res, 200, { event_id: eventId })
        }, opts.sendDelayMs)
      })
      return
    }
    const fetchEvent = /^\/_matrix\/client\/v3\/rooms\/[^/]+\/event\/([^/]+)$/.exec(path)
    if (fetchEvent !== null) {
      const ev = events.get(decodeURIComponent(fetchEvent[1] ?? ''))
      return ev !== undefined ? json(res, 200, ev) : json(res, 404, { errcode: 'M_NOT_FOUND', error: 'not found' })
    }
    if (path === '/_matrix/client/v1/media/config') return json(res, 200, { 'm.upload.size': opts.uploadSize })
    if (path === '/_matrix/media/v3/upload' && req.method === 'POST') {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        if (opts.uploadAnswer === 'unknown-token') {
          revoked = true
          return json(res, 401, UNKNOWN_TOKEN)
        }
        const bytes = Buffer.concat(chunks)
        uploads.push({ at: Date.now(), contentType: req.headers['content-type'], query: (req.url ?? '').split('?')[1] ?? '', size: bytes.length })
        const uri = `mxc://fake.local/up${uploads.length}`
        media.set(uri, bytes)
        json(res, 200, { content_uri: uri })
      })
      return
    }
    const download = /^\/_matrix\/client\/v1\/media\/download\/([^/]+)\/([^/]+)$/.exec(path)
    if (download !== null) {
      if (opts.downloadAnswer === 'unknown-token') {
        revoked = true
        return json(res, 401, UNKNOWN_TOKEN)
      }
      const bytes = media.get(`mxc://${decodeURIComponent(download[1] ?? '')}/${decodeURIComponent(download[2] ?? '')}`)
      if (bytes === undefined) return json(res, 404, { errcode: 'M_NOT_FOUND', error: 'not found' })
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) })
      return void res.end(bytes)
    }
    const accountData = /^\/_matrix\/client\/v3\/user\/[^/]+\/account_data\/([^/]+)$/.exec(path)
    if (accountData !== null && req.method === 'PUT') {
      let raw = ''
      req.setEncoding('utf8').on('data', (c: string) => (raw += c))
      req.on('end', () => {
        const type = decodeURIComponent(accountData[1] ?? '')
        const content = JSON.parse(raw) as Record<string, unknown>
        if (type === 'm.direct') direct = content
        pendingAccountData.push({ type, content })
        json(res, 200, {})
      })
      return
    }
    if (/^\/_matrix\/client\/v3\/profile\/[^/]+$/.test(path)) return json(res, 200, { displayname: 'Relatórios' })
    if (/^\/_matrix\/client\/v3\/rooms\/[^/]+\/messages$/.test(path)) return json(res, 200, { chunk: [], start: 't0' })
    if (path === '/_matrix/client/v3/sync') {
      // Long-poll stand-in: answer a batch after a short pause.
      setTimeout(() => {
        if (revoked) return json(res, 401, UNKNOWN_TOKEN)
        batch += 1
        const join: Record<string, unknown> =
          batch === 1 ? { [ROOM_ID]: joinedRoom(opts.userId), [DM_ID]: directRoom(opts.userId), [FILES_ID]: filesRoom(opts.userId) } : {}
        const leave: Record<string, unknown> = batch === 1 ? { [LEFT_ID]: leftRoom(opts.userId) } : {}
        for (const [roomId, events] of pendingTimeline) {
          join[roomId] = { timeline: { events, limited: false }, state: { events: [] }, ephemeral: { events: [] }, account_data: { events: [] } }
        }
        pendingTimeline.clear()
        const account = pendingAccountData.splice(0)
        json(res, 200, { next_batch: `s${batch}`, rooms: { join, leave }, account_data: { events: account }, to_device: { events: [] } })
      }, batch === 0 ? 0 : 500)
      return
    }
    return json(res, 404, { errcode: 'M_UNRECOGNIZED', error: 'fake server' })
  }

  const server: Server = createServer(handle)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    url,
    requests,
    sends,
    uploads,
    direct: () => direct,
    set: (next) => Object.assign(opts, next),
    push: (roomId, event) => {
      const list = pendingTimeline.get(roomId) ?? []
      list.push(event)
      pendingTimeline.set(roomId, list)
    },
    revoke: () => {
      revoked = true
    },
    reissues,
    kill: (token) => void dead.add(token),
    revive: (token) => void dead.delete(token),
    uploadedKeys,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections()
        server.close(() => r())
      }),
  }
}
