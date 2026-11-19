import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DM_ID,
  FILE_CLEAR,
  FILE_ID_NAME,
  FILE_TAMPERED,
  FILES_ID,
  LEFT_ID,
  PERSON,
  ROOM_ID,
  ROOM_MESSAGES,
  startFakeServer,
  type FakeServer,
} from '../support/fake-server'
import { evt, startSidecar, type SidecarProcess } from '../support/sidecar-process'
import { conversationToken, fileToken, messageTs, personToken, workspaceToken } from '../../src/api/ids'
import type { ApiConversationList, ApiMe, ApiMessage, ApiMessageList, ApiPeopleList } from '../../src/api/contract'
import { CONTRACT_VOCAB_DENY } from '../../contract-vocabulary.mjs'

// dist/cli.js against the fake server, through the local API over real HTTP (S-c1, §0.3.6): the
// token file and api.json, reads with opaque ids, the m.direct backfill, the SSE, an address in use
// (73), the revocation (SSE agent.revoked, 78), the rotation, and the local token in no stream.
// S-c2 (§0.3.7): the writes through the real SDK — the cases of the retired core entry (S-b2) over
// HTTP, and the edit/removal/reaction/upload/download paths.

const TOKEN = 'mpt_unitTestToken_DoNotLog_0123456789'
const USER = '@a-abcdefghijkl:fake.local'
let fake: FakeServer
let store: string
const procs: SidecarProcess[] = []

beforeEach(async () => {
  fake = await startFakeServer()
  store = await mkdtemp(join(tmpdir(), 'sidecar-api-'))
})
afterEach(async () => {
  for (const p of procs.splice(0)) await p.stop('SIGKILL')
  await fake.close()
  await rm(store, { recursive: true, force: true })
})

async function boot(extra: string[] = [], dir = store) {
  const p = startSidecar(['--server', fake.url, '--token', TOKEN, '--store', dir, ...extra])
  procs.push(p)
  const line = await p.waitFor(evt('api-listening'))
  const token = (await readFile(join(dir, 'local.token'), 'utf8')).trim()
  const url = line.url as string
  const get = async <T>(path: string): Promise<T> => {
    const res = await fetch(url + path, { headers: { authorization: `Bearer ${token}` } })
    expect(res.status).toBe(200)
    return (await res.json()) as T
  }
  // Any method, a JSON body (or raw bytes), the parsed answer.
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const raw = body instanceof Uint8Array ? body : body === undefined ? undefined : JSON.stringify(body)
    const res = await fetch(url + path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(typeof raw === 'string' && { 'content-type': 'application/json' }), ...headers },
      ...(raw !== undefined && { body: raw }),
    })
    const bytes = Buffer.from(await res.arrayBuffer())
    const isJson = (res.headers.get('content-type') ?? '').startsWith('application/json')
    return { status: res.status, headers: res.headers, bytes, json: (isJson && bytes.length > 0 ? JSON.parse(bytes.toString('utf8')) : {}) as Record<string, unknown> }
  }
  return { p, url, token, get, call }
}

const errorCode = (r: { json: Record<string, unknown> }): unknown => (r.json.error as { code?: string } | undefined)?.code
const ROOM = conversationToken(ROOM_ID, false)
const MESSAGES = `/v1/conversations/${ROOM}/messages`

// The agent's client joins from the first /sync: a write before it lands is not_member.
async function online(b: Awaited<ReturnType<typeof boot>>): Promise<void> {
  await until(async () => ((await b.call('GET', `/v1/conversations/${ROOM}`)).status === 200 ? true : undefined))
}

const until = async <T>(fn: () => Promise<T | undefined>, ms = 15_000): Promise<T> => {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v !== undefined) return v
    if (Date.now() > end) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 100))
  }
}

// Minimal SSE reader over fetch.
function events(url: string, token: string) {
  const got: Array<{ id?: string; event?: string; data?: Record<string, unknown> }> = []
  const ctrl = new AbortController()
  const done = (async () => {
    const res = await fetch(`${url}/v1/events`, { headers: { authorization: `Bearer ${token}` }, signal: ctrl.signal })
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
    let buf = ''
    for (;;) {
      const { value, done: end } = await reader.read()
      if (end) return
      buf += value
      let i
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, i)
        buf = buf.slice(i + 2)
        const f: (typeof got)[number] = {}
        for (const line of block.split('\n')) {
          if (line.startsWith('id: ')) f.id = line.slice(4)
          else if (line.startsWith('event: ')) f.event = line.slice(7)
          else if (line.startsWith('data: ')) f.data = JSON.parse(line.slice(6)) as Record<string, unknown>
        }
        if (f.event !== undefined) got.push(f)
      }
    }
  })().catch(() => {})
  return { got, done, close: () => ctrl.abort() }
}

describe('local API (process)', () => {
  it('local.token and api.json 0600; me/conversations/messages with opaque ids; backfill makes the DM a D…', async () => {
    const { p, url, token, get } = await boot(['--debug'])
    expect(token).toMatch(/^tal_[A-Za-z0-9_-]{43}$/)
    expect(((await stat(join(store, 'local.token'))).mode & 0o777).toString(8)).toBe('600')
    const api = JSON.parse(await readFile(join(store, 'api.json'), 'utf8')) as Record<string, unknown>
    expect(api).toEqual({ url, pid: p.child.pid })
    expect(((await stat(join(store, 'api.json'))).mode & 0o777).toString(8)).toBe('600')

    expect(await get<ApiMe>('/v1/me')).toEqual({ id: personToken(USER), workspace: workspaceToken('fake.local'), name: 'Relatórios', kind: 'agent' })

    const list = await until(async () => {
      const l = await get<ApiConversationList>('/v1/conversations')
      return l.conversations.some((c) => c.kind === 'dm') ? l : undefined
    })
    expect(list.conversations).toContainEqual({ id: conversationToken(ROOM_ID, false), name: 'produção', kind: 'public', memberCount: 2 })
    expect(list.conversations).toContainEqual(expect.objectContaining({ id: conversationToken(DM_ID, true), kind: 'dm', peer: personToken(PERSON) }))
    expect(fake.direct()).toEqual({ [PERSON]: [DM_ID] })
    expect(p.lines).toContainEqual({ evt: 'direct-backfill', rooms: 1 })

    const page = await get<ApiMessageList>(`/v1/conversations/${conversationToken(ROOM_ID, false)}/messages`)
    expect(page.messages.map((m) => m.id)).toEqual([...ROOM_MESSAGES].reverse().map((m) => messageTs(m.origin_server_ts, m.event_id)))
    expect(page.messages[0]).toMatchObject({ author: personToken(PERSON), text: ROOM_MESSAGES[1]!.body, mentionsMe: true })
    expect(page.next).toBeUndefined()
    const limited = await get<ApiMessageList>(`/v1/conversations/${conversationToken(ROOM_ID, false)}/messages?limit=1`)
    expect(limited.messages).toHaveLength(1)
    const rest = await get<ApiMessageList>(`/v1/conversations/${conversationToken(ROOM_ID, false)}/messages?cursor=${limited.next!}`)
    expect(rest.messages.map((m) => m.text)).toEqual([ROOM_MESSAGES[0]!.body])
    const oldest = messageTs(ROOM_MESSAGES[0]!.origin_server_ts, ROOM_MESSAGES[0]!.event_id)
    const after = await get<ApiMessageList>(`/v1/conversations/${conversationToken(ROOM_ID, false)}/messages?oldest=${oldest}`)
    expect(after.messages.map((m) => m.text)).toEqual([ROOM_MESSAGES[1]!.body])

    // No protocol id and never the local token on either stream.
    expect(p.stdout()).not.toContain(token)
    expect(p.stderr()).not.toContain(token)
    expect(p.stdout()).not.toContain(TOKEN)
  })

  it('SSE: a live message that mentions the agent → message.received + mention; revocation → agent.revoked, 503, exit 78', async () => {
    const { p, url, token } = await boot()
    const stream = events(url, token)
    await new Promise((r) => setTimeout(r, 300))
    fake.push(ROOM_ID, {
      type: 'm.room.message',
      sender: PERSON,
      event_id: '$live' + 'a'.repeat(39),
      origin_server_ts: 1_730_900_001_000,
      content: { msgtype: 'm.text', body: 'agente, relatório?', 'm.mentions': { user_ids: [USER] } },
    })
    await until(() => Promise.resolve(stream.got.some((e) => e.event === 'mention') ? true : undefined))
    const received = stream.got.find((e) => e.event === 'message.received')!
    expect(received.data).toMatchObject({
      type: 'message.received',
      conversation: conversationToken(ROOM_ID, false),
      message: { author: personToken(PERSON), text: 'agente, relatório?', mentionsMe: true },
    })
    expect(stream.got.map((e) => e.event).slice(-2)).toEqual(['message.received', 'mention'])

    fake.revoke()
    const statuses: number[] = []
    await until(async () => {
      if (stream.got.some((e) => e.event === 'agent.revoked')) {
        const r = await fetch(`${url}/v1/me`, { headers: { authorization: `Bearer ${token}` } }).catch(() => null)
        if (r !== null) statuses.push(r.status)
        return true
      }
      return undefined
    })
    expect(await p.exited).toBe(78)
    expect(statuses.every((s) => s === 503)).toBe(true)
    stream.close()
  })

  it('the address of another running agent → exit 73, the core shut down cleanly', async () => {
    const first = await boot()
    const port = new URL(first.url).port
    const other = await mkdtemp(join(tmpdir(), 'sidecar-api-2-'))
    // The second process stands for ANOTHER agent (the fake has one device): with the first one's
    // published keys, its empty store would read as a lost store and self-reissue (S-h, §0.3.14 item 7).
    fake.set({ publishedKeys: false })
    try {
      const second = startSidecar(['--server', fake.url, '--token', TOKEN, '--store', other, '--listen', `127.0.0.1:${port}`])
      procs.push(second)
      expect(await second.exited).toBe(73)
      expect(second.lines.find((l) => l.stage === 'listen')).toMatchObject({ evt: 'fatal', address: `127.0.0.1:${port}` })
      // The first one still answers.
      expect((await fetch(`${first.url}/v1/healthz`)).status).toBe(200)
    } finally {
      await rm(other, { recursive: true, force: true })
    }
  })

  it('--rotate-local-token replaces the file and exits 0, printing no token', async () => {
    const a = await boot()
    const before = a.token
    expect(await a.p.stop()).toBe(0)
    const r = startSidecar(['--server', fake.url, '--token', TOKEN, '--store', store, '--rotate-local-token'])
    expect(await r.exited).toBe(0)
    const after = (await readFile(join(store, 'local.token'), 'utf8')).trim()
    expect(after).not.toBe(before)
    expect(after).toMatch(/^tal_/)
    expect(r.lines.find(evt('local-token-rotated'))).toBeDefined()
    expect(r.stdout() + r.stderr()).not.toContain(after)
  })
})

// §0.3.6 adj. 12: the keys of REAL responses and events carry no protocol word (the deny list of the
// contract's lint, contract-vocabulary.mjs).
const DENY = new RegExp(CONTRACT_VOCAB_DENY, 'i')
function deniedKeys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) deniedKeys(x, out)
  else if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (DENY.test(k)) out.push(k)
      deniedKeys(x, out)
    }
  }
  return out
}

describe('contract vocabulary on the wire', () => {
  it('the scanner itself flags a protocol key (negative)', () => {
    expect(deniedKeys({ a: [{ roomId: 1 }], b: { homeserverUrl: 2 } })).toEqual(['roomId', 'homeserverUrl'])
  })

  it('no key of any real response or event matches the deny list', async () => {
    const { url, token, get } = await boot()
    const stream = events(url, token)
    await new Promise((r) => setTimeout(r, 300))
    const conv = conversationToken(ROOM_ID, false)
    const bodies: unknown[] = [
      await get<ApiMe>('/v1/me'),
      await get<ApiConversationList>('/v1/conversations'),
      await get(`/v1/conversations/${conv}`),
      await get<ApiPeopleList>(`/v1/conversations/${conv}/members`),
      await get<ApiMessageList>(`/v1/conversations/${conv}/messages`),
      await get(`/v1/people/${personToken(PERSON)}`),
      await (await fetch(`${url}/v1/healthz`)).json(),
      await (await fetch(`${url}/v1/conversations/CAAAAAAAAAA`, { headers: { authorization: `Bearer ${token}` } })).json(),
    ]
    fake.push(ROOM_ID, {
      type: 'm.room.message',
      sender: PERSON,
      event_id: '$vocab' + 'a'.repeat(38),
      origin_server_ts: 1_730_900_002_000,
      content: { msgtype: 'm.text', body: 'oi', 'm.mentions': { user_ids: [USER] } },
    })
    await until(() => Promise.resolve(stream.got.some((e) => e.event === 'mention') ? true : undefined))
    bodies.push(...stream.got.map((e) => e.data))
    stream.close()
    expect(bodies.length).toBeGreaterThan(9)
    expect(deniedKeys(bodies)).toEqual([])
  })
})

describe('writes through the real SDK (S-c2; the S-b2 cases of the retired core entry, over HTTP)', () => {
  it('POST answers only after the server accepted, with the accepted ts; the text and the tokens never reach a stream', async () => {
    const TEXT = 'secret-payload-Zq81-must-not-appear-in-logs'
    fake.set({ sendDelayMs: 400 })
    const b = await boot(['--debug'])
    await online(b)
    const t0 = Date.now()
    const r = await b.call('POST', MESSAGES, { text: TEXT, mentions: [personToken(PERSON)] })
    expect(r.status).toBe(200)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400)
    expect(fake.sends).toHaveLength(1)
    expect(fake.sends[0]!.body).toMatchObject({ msgtype: 'm.text', body: TEXT, 'm.mentions': { user_ids: [PERSON] } })
    const msg = r.json as unknown as ApiMessage
    expect(msg).toMatchObject({ conversation: ROOM, author: personToken(USER), text: TEXT, mentionsMe: false, mentions: [personToken(PERSON)], reactions: [] })
    expect(msg.id).toMatch(/^\d+\.\d{6}$/)
    expect(await b.p.stop()).toBe(0)
    expect(b.p.stdout()).not.toContain(TEXT)
    expect(b.p.stderr()).not.toContain(TEXT)
    expect(b.p.stderr()).toContain('FetchHttpApi')
    for (const secret of [TOKEN, b.token]) {
      expect(b.p.stdout()).not.toContain(secret)
      expect(b.p.stderr()).not.toContain(secret)
    }
  })

  it('429 inside the deadline: cancel, wait retry_after + 1 s, retry with a new transaction → 200', async () => {
    fake.set({ sendPlan: ['limit'], limitMs: 300 })
    const b = await boot()
    await online(b)
    expect((await b.call('POST', MESSAGES, { text: 'after a limit' })).status).toBe(200)
    expect(fake.sends).toHaveLength(2)
    expect(fake.sends[1]!.txnId).not.toBe(fake.sends[0]!.txnId)
    expect(fake.sends[1]!.at - fake.sends[0]!.at).toBeGreaterThanOrEqual(300 + 1_000)
    expect(b.p.lines.find(evt('send-ratelimited'))).toMatchObject({ retryAfterMs: 300 })
  })

  it('429 beyond the deadline → 429 rate_limited with Retry-After at once, and the SDK scheduler never retries', async () => {
    fake.set({ sendPlan: ['limit', 'limit', 'limit'], limitMs: 40_000 })
    const b = await boot()
    await online(b)
    const t0 = Date.now()
    const r = await b.call('POST', MESSAGES, { text: 'limited' })
    expect([r.status, errorCode(r)]).toEqual([429, 'rate_limited'])
    expect(r.headers.get('retry-after')).toBe('40')
    expect((r.json.error as { retryAfterMs: number }).retryAfterMs).toBe(40_000)
    expect(Date.now() - t0).toBeLessThan(5_000)
    // The default MatrixScheduler would retry by itself: with `() => -1` exactly one request.
    await new Promise((r2) => setTimeout(r2, 2_000))
    expect(fake.sends).toHaveLength(1)
  })

  it('a conversation the agent left → 403 not_member; thread + replyTo → 400; nothing on the wire', async () => {
    const b = await boot()
    await online(b)
    const left = await b.call('POST', `/v1/conversations/${conversationToken(LEFT_ID, false)}/messages`, { text: 'x' })
    expect([left.status, errorCode(left)]).toEqual([403, 'not_member'])
    const ts = messageTs(ROOM_MESSAGES[0]!.origin_server_ts, ROOM_MESSAGES[0]!.event_id)
    const both = await b.call('POST', MESSAGES, { text: 'x', thread: ts, replyTo: ts })
    expect([both.status, errorCode(both)]).toEqual([400, 'invalid_argument'])
    expect(fake.sends).toHaveLength(0)
  })

  it('M_UNKNOWN_TOKEN on a write → it and the one behind it 503 revoked, then exit 78 with REVOKED', async () => {
    fake.set({ sendPlan: ['unknown-token'], sendDelayMs: 200 })
    const b = await boot()
    await online(b)
    const [r1, r2] = await Promise.all([b.call('POST', MESSAGES, { text: 'first' }), b.call('POST', MESSAGES, { text: 'queued' })])
    expect([r1.status, errorCode(r1)]).toEqual([503, 'revoked'])
    expect([r2.status, errorCode(r2)]).toEqual([503, 'revoked'])
    expect(await b.p.exited).toBe(78)
    expect(fake.sends).toHaveLength(1)
    expect(b.p.lines.find(evt('credential-refused'))).toMatchObject({ stage: 'runtime' })
    expect(JSON.parse(await readFile(join(store, 'REVOKED'), 'utf8'))).toMatchObject({ deviceId: 'FAKEDEV001' })
    expect(existsSync(join(store, 'indexeddb'))).toBe(false)
  })

  it('SIGTERM with nothing pending exits 0 (the core never exits by itself)', async () => {
    const b = await boot()
    expect(await b.p.stop()).toBe(0)
    expect(b.p.lines.find(evt('shutdown'))).toMatchObject({ signal: 'SIGTERM' })
  })
})

describe('edit, removal and reactions through the real SDK (§0.3.7 items 1, 3)', () => {
  const theirs = messageTs(ROOM_MESSAGES[0]!.origin_server_ts, ROOM_MESSAGES[0]!.event_id)

  // The agent learns a ts by reading (the listing feeds the ts index; the fake server has no
  // timestamp→event lookup).
  const read = (b: Awaited<ReturnType<typeof boot>>) => b.get<ApiMessageList>(MESSAGES)

  it('someone else’s message: PATCH and DELETE → 403 not_own_message, nothing on the wire', async () => {
    const b = await boot()
    await online(b)
    await read(b)
    const edit = await b.call('PATCH', `${MESSAGES}/${theirs}`, { text: 'not mine' })
    expect([edit.status, errorCode(edit)]).toEqual([403, 'not_own_message'])
    const del = await b.call('DELETE', `${MESSAGES}/${theirs}`)
    expect([del.status, errorCode(del)]).toEqual([403, 'not_own_message'])
    expect(fake.sends).toEqual([])
  })

  it('own message: PATCH → m.replace with editedAt; DELETE → the redaction; then 404', async () => {
    const b = await boot()
    await online(b)
    const posted = (await b.call('POST', MESSAGES, { text: 'v1' })).json as unknown as ApiMessage
    const edit = await b.call('PATCH', `${MESSAGES}/${posted.id}`, { text: 'v2' })
    expect(edit.status).toBe(200)
    expect(edit.json).toMatchObject({ id: posted.id, text: 'v2', editedAt: expect.any(Number) as number })
    expect(fake.sends[1]).toMatchObject({ type: 'm.room.message', body: { 'm.new_content': { body: 'v2' }, 'm.relates_to': { rel_type: 'm.replace', event_id: '$sent1' } } })
    expect((await b.call('DELETE', `${MESSAGES}/${posted.id}`)).status).toBe(204)
    expect(fake.sends[2]).toMatchObject({ type: 'm.room.redaction', body: { redacts: '$sent1' } })
    // Gone at once (the accepted removal counts before the sync brings it back), and after the sync.
    expect(errorCode(await b.call('DELETE', `${MESSAGES}/${posted.id}`))).toBe('message_not_found')
    expect(errorCode(await b.call('PATCH', `${MESSAGES}/${posted.id}`, { text: 'v3' }))).toBe('message_not_found')
    await new Promise((r) => setTimeout(r, 1_200))
    expect(errorCode(await b.call('DELETE', `${MESSAGES}/${posted.id}`))).toBe('message_not_found')
    expect(fake.sends).toHaveLength(3)
  })

  it('a duplicated PUT of a reaction sends once; DELETE once; a second DELETE nothing', async () => {
    const b = await boot()
    await online(b)
    await read(b)
    const path = `${MESSAGES}/${theirs}/reactions/${encodeURIComponent('👍')}`
    expect((await b.call('PUT', path)).status).toBe(204)
    expect((await b.call('PUT', path)).status).toBe(204)
    const reactions = fake.sends.filter((x) => x.type === 'm.reaction')
    expect(reactions).toHaveLength(1)
    expect(reactions[0]!.body).toEqual({ 'm.relates_to': { rel_type: 'm.annotation', event_id: ROOM_MESSAGES[0]!.event_id, key: '👍' } })
    expect((await b.call('DELETE', path)).status).toBe(204)
    expect((await b.call('DELETE', path)).status).toBe(204)
    expect(fake.sends.map((x) => x.type)).toEqual(['m.reaction', 'm.room.redaction'])
  })
})

describe('files through the real SDK (§0.3.7 items 7, 8)', () => {
  const FILES = `/v1/conversations/${conversationToken(FILES_ID, false)}`

  it('upload in a clear room → the bytes go up with name and type, the message carries files[0]; GET returns the same bytes', async () => {
    const b = await boot()
    await online(b)
    const bytes = Buffer.from('linha 1\nlinha 2\n')
    const up = await b.call('POST', `/v1/conversations/${ROOM}/files?name=${encodeURIComponent('notas da reunião.txt')}`, bytes, { 'content-type': 'text/plain' })
    expect(up.status).toBe(200)
    const file = (up.json as unknown as ApiMessage).files![0]!
    expect(file).toMatchObject({ name: 'notas da reunião.txt', mimetype: 'text/plain', size: bytes.length })
    expect(fake.uploads).toHaveLength(1)
    expect(fake.uploads[0]).toMatchObject({ contentType: 'text/plain', size: bytes.length })
    expect(fake.sends[0]).toMatchObject({ type: 'm.room.message', body: { msgtype: 'm.file', body: 'notas da reunião.txt', url: 'mxc://fake.local/up1' } })
    const got = await b.call('GET', `/v1/files/${file.id}`)
    expect(got.status).toBe(200)
    expect(got.bytes.equals(bytes)).toBe(true)
    expect(got.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''notas%20da%20reuni%C3%A3o.txt")
  })

  it('over the limit: a declared Content-Length → 413 with no byte on the wire; without Content-Length → cut, 413', async () => {
    fake.set({ uploadSize: 4096 })
    const b = await boot()
    await online(b)
    const big = await b.call('POST', `/v1/conversations/${ROOM}/files?name=big.bin`, new Uint8Array(8192))
    expect([big.status, errorCode(big)]).toEqual([413, 'file_too_large'])
    // Chunked: no Content-Length; the server answers 413 as soon as the body passes the limit.
    const port = Number(new URL(b.url).port)
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, method: 'POST', path: `/v1/conversations/${ROOM}/files?name=stream.bin`, headers: { authorization: `Bearer ${b.token}` } },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        },
      )
      req.on('error', (err) => (req.writableEnded ? undefined : reject(err)))
      for (let i = 0; i < 8; i++) req.write(Buffer.alloc(2048, i))
      req.end()
    })
    expect(status).toBe(413)
    expect(fake.uploads).toEqual([])
    expect(fake.sends).toEqual([])
  })

  it('an unknown F… → 404; a tampered ciphertext → 502; a file named with an id → 500 at the header', async () => {
    const b = await boot()
    await online(b)
    expect(errorCode(await b.call('GET', `/v1/files/${fileToken('mxc://fake.local/nothing')}`))).toBe('file_not_found')
    // The listing registers the files (the message whose file name is an id comes back withheld, the rest with their files).
    const listing = await b.call('GET', `${FILES}/messages`)
    expect(listing.status).toBe(200)
    const listed = (listing.json as { messages: Array<{ unavailable?: true; files?: unknown[] }> }).messages
    expect(listed.map((m) => [m.unavailable ?? false, m.files?.length ?? 0])).toEqual([
      [true, 0],
      [false, 1],
      [false, 1],
    ])
    expect(b.p.lines).toContainEqual({ evt: 'leak-blocked', where: 'GET messages', path: '$.messages[0].files[0].name', pattern: 'mxid' })
    const tampered = await b.call('GET', `/v1/files/${fileToken(FILE_TAMPERED.uri)}`)
    expect([tampered.status, errorCode(tampered)]).toEqual([502, 'upstream_failed'])
    expect(b.p.lines).toContainEqual(expect.objectContaining({ evt: 'download-integrity-failed' }))
    const leaky = await b.call('GET', `/v1/files/${fileToken(FILE_ID_NAME.uri)}`)
    expect([leaky.status, errorCode(leaky)]).toEqual([500, 'internal'])
    expect(b.p.lines).toContainEqual({ evt: 'leak-blocked', where: 'GET file', path: '$.name', pattern: 'mxid' })
    const clear = await b.call('GET', `/v1/files/${fileToken(FILE_CLEAR.uri)}`)
    expect(clear.bytes.equals(FILE_CLEAR.bytes)).toBe(true)
    expect(b.p.stdout()).not.toContain(FILE_ID_NAME.name)
  })

  it('a JSON body over 256 KiB → 413; a non-boolean markdown → 400; nothing on the wire', async () => {
    const b = await boot()
    await online(b)
    const huge = await b.call('POST', MESSAGES, { text: 'x'.repeat(300 * 1024) })
    expect([huge.status, errorCode(huge)]).toEqual([413, 'payload_too_large'])
    const md = await b.call('POST', MESSAGES, { text: '*oi*', markdown: 'yes' })
    expect([md.status, errorCode(md)]).toEqual([400, 'invalid_argument'])
    expect(fake.sends).toEqual([])
  })

  it('markdown: true (S-i) → the formatted body goes on the wire next to the plain one', async () => {
    const b = await boot()
    await online(b)
    const md = await b.call('POST', MESSAGES, { text: '*oi*', markdown: true })
    expect(md.status).toBe(200)
    expect(fake.sends).toHaveLength(1)
    expect(fake.sends[0]!.body).toMatchObject({ msgtype: 'm.text', body: '*oi*', format: 'org.matrix.custom.html', formatted_body: '<p><em>oi</em></p>' })
  })

  it('a live message that mentions people → the read carries mentions as U… tokens', async () => {
    const b = await boot()
    await online(b)
    fake.push(ROOM_ID, {
      type: 'm.room.message',
      sender: PERSON,
      event_id: '$ment' + 'a'.repeat(39),
      origin_server_ts: 1_730_900_003_000,
      content: { msgtype: 'm.text', body: 'olá', 'm.mentions': { user_ids: [USER, PERSON] } },
    })
    const page = await until(async () => {
      const l = await b.get<ApiMessageList>(MESSAGES)
      return l.messages.some((m) => m.text === 'olá') ? l : undefined
    })
    expect(page.messages.find((m) => m.text === 'olá')).toMatchObject({ mentionsMe: true, mentions: [personToken(USER), personToken(PERSON)] })
  })
})

describe('M_UNKNOWN_TOKEN outside the queue revokes the core (ADR-087 dec. 8; round 2)', () => {
  const expectRevoked = async (b: Awaited<ReturnType<typeof boot>>, r: { status: number; json: Record<string, unknown> }) => {
    expect([r.status, errorCode(r)]).toEqual([503, 'revoked'])
    expect(await b.p.exited).toBe(78)
    expect(b.p.lines.find(evt('credential-refused'))).toMatchObject({ stage: 'runtime' })
    expect(JSON.parse(await readFile(join(store, 'REVOKED'), 'utf8'))).toMatchObject({ deviceId: 'FAKEDEV001' })
    expect(existsSync(join(store, 'indexeddb'))).toBe(false)
  }

  it('POST /files with the upload answering 401 M_UNKNOWN_TOKEN → 503 revoked, exit 78, REVOKED, store wiped', async () => {
    fake.set({ uploadAnswer: 'unknown-token' })
    const b = await boot()
    await online(b)
    const r = await b.call('POST', `/v1/conversations/${ROOM}/files?name=a.txt`, new Uint8Array([1, 2, 3]), { 'content-type': 'text/plain' })
    await expectRevoked(b, r)
    expect(fake.sends).toEqual([])
  })

  it('GET /files with the download answering 401 M_UNKNOWN_TOKEN → 503 revoked, exit 78, REVOKED, store wiped', async () => {
    fake.set({ downloadAnswer: 'unknown-token' })
    const b = await boot()
    await online(b)
    // Register the clear file of the files room (the listing answers 500 itself: a name there is an id).
    await b.call('GET', `/v1/conversations/${conversationToken(FILES_ID, false)}/messages`)
    const r = await b.call('GET', `/v1/files/${fileToken(FILE_CLEAR.uri)}`)
    await expectRevoked(b, r)
  })
})
