import { describe, it, expect, afterEach, vi } from 'vitest'
import { request } from 'node:http'
import { connect, createServer as createTcp, type Socket } from 'node:net'
import { createApiServer, type ApiServer } from '../../src/api/server'
import { AddressInUseError, startLocalApi } from '../../src/api/start'
import { ReadError, type ReadFacade } from '../../src/core/read'
import type { ApiEvent, ApiMessage } from '../../src/api/contract'
import type { Core } from '../../src/core/handle'
import { WriteError, type WriteFacade } from '../../src/core/write'
import type { ApprovalFacade } from '../../src/core/approvals'
import type { PanelFacade } from '../../src/core/panels'
import type { CommandsFacade } from '../../src/core/commands'

// The local API server (§0.3.6 adjs. 2, 4, 7, 8, 11) over a fake read facade: auth, Host/Origin,
// routes, errors, the edge scan, SSE (replay, resync, epoch, cut at 1 MB, ping), revocation.

const TOKEN = 'tal_' + 'k'.repeat(43)
const msg = (over: Partial<ApiMessage> = {}): ApiMessage => ({
  id: '1730900000.100123',
  conversation: 'CAAAAAAAAAA',
  author: 'UAAAAAAAAAA',
  text: 'please verify the backup; o contrato está no cofre',
  mentionsMe: false,
  reactions: [],
  ...over,
})

function fakeRead(over: Partial<ReadFacade> = {}) {
  let listener: ((e: ApiEvent) => void) | null = null
  const read: ReadFacade = {
    me: () => Promise.resolve({ id: 'UAGENTAAAAA', workspace: 'TAAAAAAAAAA', name: 'Relatórios', kind: 'agent' }),
    bot: () => 'BAAAAAAAAAA',
    conversations: () => ({ conversations: [{ id: 'CAAAAAAAAAA', name: 'produção', kind: 'public', memberCount: 2 }] }),
    conversation: (id) => {
      if (id !== 'CAAAAAAAAAA') throw new ReadError('conversation_not_found')
      return { id, name: 'produção', kind: 'public', memberCount: 2 }
    },
    members: () => ({ people: [] }),
    person: () => ({ id: 'UAAAAAAAAAA', name: 'Alice', kind: 'member' }),
    messages: () => Promise.resolve({ messages: [msg()] }),
    message: () => Promise.resolve(msg()),
    subscribe: (l) => {
      listener = l
      return () => {
        listener = null
      }
    },
    ...over,
  }
  return { read, emit: (e: ApiEvent) => listener?.(e) }
}

// A fake write facade: records the calls, answers per `over`.
function fakeWrite(over: Partial<WriteFacade> = {}) {
  const calls: Array<[string, ...unknown[]]> = []
  const write: WriteFacade = {
    post: (c, r) => {
      calls.push(['post', c, r])
      return Promise.resolve(msg({ id: '1730900001.000123', text: r.text }))
    },
    edit: (c, ts, text, rich) => {
      calls.push(rich === undefined ? ['edit', c, ts, text] : ['edit', c, ts, text, rich])
      return Promise.resolve(msg({ id: ts, text, editedAt: 1 }))
    },
    remove: (c, ts) => {
      calls.push(['remove', c, ts])
      return Promise.resolve()
    },
    react: (c, ts, e) => {
      calls.push(['react', c, ts, e])
      return Promise.resolve(true)
    },
    unreact: (c, ts, e) => {
      calls.push(['unreact', c, ts, e])
      return Promise.resolve(true)
    },
    uploadLimit: () => Promise.resolve(1024),
    upload: async (c, r) => {
      const { body, ...meta } = r
      const bytes = await body()
      calls.push(['upload', c, { ...meta, bytes: bytes.byteLength }])
      return msg({ text: '', files: [{ id: 'FAAAAAAAAAA', name: r.name, mimetype: r.mimetype, size: bytes.byteLength }] })
    },
    download: (id) => {
      calls.push(['download', id])
      return Promise.resolve({ bytes: new Uint8Array([1, 2, 3]), mimetype: 'application/pdf', name: 'relatório final.pdf' })
    },
    ...over,
  }
  return { write, calls }
}

let servers: ApiServer[] = []
const logs: Array<Record<string, unknown>> = []
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()))
  servers = []
  logs.length = 0
})

async function start(read: ReadFacade, extra: Partial<Parameters<typeof createApiServer>[0]> = {}) {
  const api = createApiServer({
    read,
    write: fakeWrite().write,
    state: () => 'online',
    token: TOKEN,
    listen: { host: '127.0.0.1', port: 0 },
    log: (l) => logs.push(l),
    ...extra,
  })
  servers.push(api)
  const url = await api.start()
  return { api, url, port: Number(new URL(url).port) }
}

interface Res {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: Record<string, unknown>
}

function call(port: number, path: string, opts: { method?: string; headers?: Record<string, string>; auth?: boolean } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { host: `127.0.0.1:${port}`, ...opts.headers }
    if (opts.auth !== false) headers.authorization = `Bearer ${TOKEN}`
    const req = request({ host: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers }, (res) => {
      let raw = ''
      res.setEncoding('utf8').on('data', (c: string) => (raw += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>) }))
    })
    req.on('error', reject)
    req.end()
  })
}

const code = (r: Res): unknown => (r.body.error as { code?: string } | undefined)?.code

describe('auth, Host, Origin, routes', () => {
  it('healthz needs no token; everything else 401 without it or with a wrong one (unknown routes too)', async () => {
    const { port } = await start(fakeRead().read)
    expect(await call(port, '/v1/healthz', { auth: false })).toMatchObject({ status: 200, body: { state: 'online' } })
    expect(code(await call(port, '/v1/me', { auth: false }))).toBe('unauthorized')
    expect((await call(port, '/v1/me', { auth: false })).status).toBe(401)
    expect(code(await call(port, '/v1/me', { auth: false, headers: { authorization: 'Bearer tal_wrong' } }))).toBe('unauthorized')
    expect((await call(port, '/v1/nope', { auth: false })).status).toBe(401)
    expect(await call(port, '/v1/me')).toMatchObject({ status: 200, body: { id: 'UAGENTAAAAA', kind: 'agent' } })
  })

  it('404 unknown route, 405 with Allow, error shape { error: { code, message } }', async () => {
    const { port } = await start(fakeRead().read)
    const nf = await call(port, '/v1/nope')
    expect(nf.status).toBe(404)
    expect(nf.body).toEqual({ error: { code: 'not_found', message: 'no such route' } })
    const na = await call(port, '/v1/me', { method: 'POST' })
    expect(na.status).toBe(405)
    expect(na.headers.allow).toBe('GET')
    expect(code(await call(port, '/v1/conversations/CBBBBBBBBBB'))).toBe('conversation_not_found')
    expect((await call(port, '/v1/conversations/CBBBBBBBBBB')).status).toBe(404)
    expect(code(await call(port, '/v1/conversations/CAAAAAAAAAA/messages?limit=abc'))).toBe('invalid_argument')
  })

  it('Origin present → 403; Host not the listen address → 421 (before auth)', async () => {
    const { port } = await start(fakeRead().read)
    const o = await call(port, '/v1/me', { headers: { origin: 'https://evil.example' } })
    expect([o.status, code(o)]).toEqual([403, 'forbidden_origin'])
    const h = await call(port, '/v1/me', { headers: { host: `localhost:${port}` } })
    expect([h.status, code(h)]).toEqual([421, 'misdirected'])
    const h2 = await call(port, '/v1/healthz', { auth: false, headers: { host: `evil.example:${port}` } })
    expect(h2.status).toBe(421)
  })

  it('query parameters reach the facade', async () => {
    let seen: unknown
    const { port } = await start(
      fakeRead({
        messages: (_id, q) => {
          seen = q
          return Promise.resolve({ messages: [] })
        },
      }).read,
    )
    await call(port, '/v1/conversations/CAAAAAAAAAA/messages?limit=5&cursor=cur_x&oldest=1.5&latest=2&inclusive=true&thread=1730900000.100123')
    expect(seen).toEqual({ limit: 5, cursor: 'cur_x', oldest: '1.5', latest: '2', inclusive: true, thread: '1730900000.100123' })
  })

  it('an unexpected error → 500 internal, logged without its message', async () => {
    const { port } = await start(fakeRead({ person: () => { throw new Error('GET https://hs/_matrix/client/v3/profile/@a:x failed') } }).read)
    const r = await call(port, '/v1/people/UAAAAAAAAAA')
    expect([r.status, code(r)]).toEqual([500, 'internal'])
    expect(JSON.stringify(logs)).not.toContain('@a:x')
    expect(logs).toContainEqual({ evt: 'api-error', name: 'Error' })
  })
})

describe('edge scan on responses (ADR-089 dec. 1)', () => {
  it('"verify" and "cofre" in a message text pass', async () => {
    const { port } = await start(fakeRead().read)
    const r = await call(port, '/v1/conversations/CAAAAAAAAAA/messages')
    expect(r.status).toBe(200)
    expect((r.body.messages as ApiMessage[])[0]?.text).toContain('cofre')
  })

  it('an mxid in a text → 200 with that message withheld and leak-blocked with path and pattern, never the value', async () => {
    const { port } = await start(fakeRead({ messages: () => Promise.resolve({ messages: [msg({ text: 'fale com @alice:tayet.local' })] }) }).read)
    const r = await call(port, '/v1/conversations/CAAAAAAAAAA/messages')
    expect(r.status).toBe(200)
    expect((r.body.messages as ApiMessage[])[0]).toEqual({ id: '1730900000.100123', conversation: 'CAAAAAAAAAA', author: 'UAAAAAAAAAA', text: '', mentionsMe: false, reactions: [], unavailable: true })
    expect(logs).toContainEqual({ evt: 'leak-blocked', where: 'GET messages', path: '$.messages[0].text', pattern: 'mxid' })
    expect(JSON.stringify(logs)).not.toContain('alice')
  })

  it('a listing withholds only the message whose content carries an id shape; its neighbours keep their text', async () => {
    const messages = [
      msg({ id: '1730900000.300000', text: 'primeira' }),
      msg({ id: '1730900000.200000', text: 'fale com @alice:tayet.local', files: [{ id: 'FAAAAAAAAAA', name: 'mxc://x/y', mimetype: 'text/plain', size: 1 }] }),
      msg({ id: '1730900000.100000', text: 'terceira' }),
    ]
    const { port } = await start(fakeRead({ messages: () => Promise.resolve({ messages, next: 'cur_1' }) }).read)
    const r = await call(port, '/v1/conversations/CAAAAAAAAAA/messages?thread=1730900000.050000')
    expect(r.status).toBe(200)
    const out = r.body.messages as ApiMessage[]
    expect(out.map((m) => [m.id, m.text, m.unavailable ?? false])).toEqual([
      ['1730900000.300000', 'primeira', false],
      ['1730900000.200000', '', true],
      ['1730900000.100000', 'terceira', false],
    ])
    expect(out[1]).not.toHaveProperty('files')
    expect(r.body.next).toBe('cur_1')
    expect(logs.filter((l) => l.evt === 'leak-blocked')).toEqual([
      { evt: 'leak-blocked', where: 'GET messages', path: '$.messages[1].text', pattern: 'mxid' },
      { evt: 'leak-blocked', where: 'GET messages', path: '$.messages[1].files[0].name', pattern: 'mxc-uri' },
    ])
    expect(JSON.stringify(logs)).not.toContain('alice')
    expect(JSON.stringify(logs)).not.toContain('mxc://')
  })

  it('a structural finding in a listed message (a raw id in author) still withholds the whole answer: 500 internal', async () => {
    const messages = [msg({ id: '1730900000.200000', text: 'fale com @bob:tayet.local' }), msg({ id: '1730900000.100000', author: '@alice:tayet.local' })]
    const { port } = await start(fakeRead({ messages: () => Promise.resolve({ messages }) }).read)
    const r = await call(port, '/v1/conversations/CAAAAAAAAAA/messages')
    expect([r.status, code(r)]).toEqual([500, 'internal'])
    expect(logs).toContainEqual({ evt: 'leak-blocked', where: 'GET messages', path: '$.messages[1].author', pattern: 'mxid' })
    expect(JSON.stringify(logs)).not.toContain('alice')
  })

  it('an mxid in a name → 500', async () => {
    const { port } = await start(fakeRead({ person: () => ({ id: 'UAAAAAAAAAA', name: '@alice:tayet.local', kind: 'member' }) }).read)
    const r = await call(port, '/v1/people/UAAAAAAAAAA')
    expect(r.status).toBe(500)
    expect(logs).toContainEqual({ evt: 'leak-blocked', where: 'GET person', path: '$.name', pattern: 'mxid' })
  })
})

// ── SSE ─────────────────────────────────────────────────────────────────────────────────────────
interface Stream {
  frames: Array<{ id?: string; event?: string; data?: string; comment?: string }>
  status: number
  ended: Promise<void>
  close: () => void
  socket: Socket
}

function sse(port: number, lastEventId?: string, paused = false): Promise<Stream> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1')
    const frames: Stream['frames'] = []
    let buf = ''
    let status = 0
    let resolved = false
    let endedResolve: () => void
    const ended = new Promise<void>((r) => (endedResolve = r))
    socket.on('close', () => endedResolve())
    socket.on('error', () => endedResolve())
    socket.setEncoding('utf8')
    socket.write(
      `GET /v1/events HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${TOKEN}\r\n${lastEventId !== undefined ? `Last-Event-ID: ${lastEventId}\r\n` : ''}\r\n`,
    )
    const stream: Stream = { frames, get status() { return status }, ended, close: () => socket.destroy(), socket }
    if (paused) {
      socket.once('data', (c: string) => {
        status = Number(/HTTP\/1\.1 (\d+)/.exec(c)?.[1] ?? 0)
        socket.pause()
        resolve(stream)
      })
      return
    }
    socket.on('data', (chunk: string) => {
      buf += chunk
      if (status === 0) {
        const head = buf.indexOf('\r\n\r\n')
        if (head === -1) return
        status = Number(/HTTP\/1\.1 (\d+)/.exec(buf)?.[1] ?? 0)
        buf = buf.slice(head + 4)
      }
      // Chunked transfer: strip the chunk-size lines.
      const text = buf.replace(/^[0-9a-f]+\r\n|\r\n[0-9a-f]+\r\n|\r\n$/gm, '')
      const blocks = text.split('\n\n')
      frames.length = 0
      for (const block of blocks.slice(0, -1)) {
        const f: Stream['frames'][number] = {}
        for (const line of block.split('\n')) {
          if (line.startsWith(':')) f.comment = line.slice(1).trim()
          else if (line.startsWith('id: ')) f.id = line.slice(4)
          else if (line.startsWith('event: ')) f.event = line.slice(7)
          else if (line.startsWith('data: ')) f.data = line.slice(6)
        }
        frames.push(f)
      }
      if (!resolved && frames.some((f) => f.comment === 'open')) {
        resolved = true
        resolve(stream)
      }
    })
  })
}

const until = async (pred: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('SSE (adj. 11)', () => {
  it('live events arrive with <epoch>-<seq> ids; a reconnect inside the ring replays what was missed', async () => {
    const f = fakeRead()
    const { api, port } = await start(f.read)
    const s1 = await sse(port)
    f.emit({ type: 'message.received', conversation: 'CAAAAAAAAAA', message: msg() })
    await until(() => s1.frames.some((x) => x.event === 'message.received'))
    const first = s1.frames.find((x) => x.event === 'message.received')!
    expect(first.id).toBe(`${api.bus.epoch}-1`)
    s1.close()
    f.emit({ type: 'conversation.removed', id: 'CBBBBBBBBBB' })
    f.emit({ type: 'conversation.removed', id: 'CCCCCCCCCCC' })
    const s2 = await sse(port, first.id)
    expect(s2.frames.filter((x) => x.event === 'conversation.removed').map((x) => x.id)).toEqual([`${api.bus.epoch}-2`, `${api.bus.epoch}-3`])
    s2.close()
  })

  it('another epoch (a restart) → resync carrying the head id', async () => {
    const f = fakeRead()
    const { api, port } = await start(f.read)
    f.emit({ type: 'conversation.removed', id: 'CBBBBBBBBBB' })
    const s = await sse(port, 'otherepoch-5')
    expect(s.frames[0]).toMatchObject({ event: 'resync', id: `${api.bus.epoch}-1` })
    s.close()
  })

  it('a leaky event goes out unavailable (same ids, no content) and is logged without the value', async () => {
    const f = fakeRead()
    const { port } = await start(f.read)
    const s = await sse(port)
    f.emit({ type: 'message.received', conversation: 'CAAAAAAAAAA', message: msg({ text: 'ping @bob:tayet.local' }) })
    await until(() => s.frames.some((x) => x.event === 'message.received'))
    const data = JSON.parse(s.frames.find((x) => x.event === 'message.received')!.data!) as { message: ApiMessage }
    expect(data.message).toMatchObject({ id: '1730900000.100123', text: '', unavailable: true })
    expect(logs).toContainEqual({ evt: 'leak-blocked', where: 'event:message.received', path: '$.message.text', pattern: 'mxid' })
    expect(JSON.stringify(logs)).not.toContain('bob')
    s.close()
  })

  it('a person’s scp address reaches the agent with its text; a user id still goes out unavailable', async () => {
    const f = fakeRead()
    const { port } = await start(f.read)
    const s = await sse(port)
    const text = 'scp dev@build-host:project/test/goldens/home.png .'
    f.emit({ type: 'message.received', conversation: 'CAAAAAAAAAA', message: msg({ id: '1730900000.100124', text }) })
    f.emit({ type: 'message.received', conversation: 'CAAAAAAAAAA', message: msg({ id: '1730900000.100125', text: 'ask @alice:tayet.local' }) })
    await until(() => s.frames.filter((x) => x.event === 'message.received').length === 2)
    const [a, b] = s.frames.filter((x) => x.event === 'message.received').map((x) => (JSON.parse(x.data!) as { message: ApiMessage }).message)
    expect(a).toMatchObject({ id: '1730900000.100124', text })
    expect(a).not.toHaveProperty('unavailable')
    expect(b).toMatchObject({ id: '1730900000.100125', text: '', unavailable: true })
    expect(logs.filter((l) => l.evt === 'leak-blocked')).toEqual([{ evt: 'leak-blocked', where: 'event:message.received', path: '$.message.text', pattern: 'mxid' }])
    s.close()
  })

  it('ping every pingMs', async () => {
    const { port } = await start(fakeRead().read, { pingMs: 30 })
    const s = await sse(port)
    await until(() => s.frames.some((x) => x.comment === 'ping'))
    s.close()
  })

  it('a client that does not read is cut once more than maxBuffer is queued', async () => {
    const f = fakeRead()
    const { port } = await start(f.read, { maxBuffer: 64 * 1024 })
    const s = await sse(port, undefined, true)
    expect(s.status).toBe(200)
    const big = msg({ text: 'x'.repeat(4000) })
    for (let i = 0; i < 2000 && !logs.some((l) => l.evt === 'sse-cut'); i++) {
      f.emit({ type: 'message.received', conversation: 'CAAAAAAAAAA', message: big })
      if (i % 50 === 0) await new Promise((r) => setTimeout(r, 5))
    }
    await until(() => logs.some((l) => l.evt === 'sse-cut'))
    expect(logs).toContainEqual({ evt: 'sse-cut', reason: 'buffer' })
    s.close()
  })

  it('a refused write without drain in drainMs is cut', async () => {
    const f = fakeRead()
    const { port } = await start(f.read, { drainMs: 100, maxBuffer: 1024 * 1024 * 64 })
    const s = await sse(port, undefined, true)
    const big = msg({ text: 'y'.repeat(4000) })
    // Keep producing until the kernel's socket buffers are full and no drain comes (bounded at ~40 MB).
    for (let i = 0; i < 10_000 && !logs.some((l) => l.evt === 'sse-cut'); i++) {
      f.emit({ type: 'message.received', conversation: 'CAAAAAAAAAA', message: big })
      if (i % 100 === 0) await new Promise((r) => setTimeout(r, 5))
    }
    await until(() => logs.some((l) => l.evt === 'sse-cut'))
    expect(logs).toContainEqual({ evt: 'sse-cut', reason: 'drain' })
    s.close()
  })
})

describe('revocation (adj. 8)', () => {
  it('streams get agent.revoked and end; every request 503 revoked, healthz included', async () => {
    const { api, port } = await start(fakeRead().read)
    const s = await sse(port)
    await api.revoke()
    await s.ended
    expect(s.frames.some((x) => x.event === 'agent.revoked')).toBe(true)
    for (const path of ['/v1/me', '/v1/healthz', '/v1/events']) {
      const r = await call(port, path)
      expect([r.status, code(r)]).toEqual([503, 'revoked'])
    }
  })
})

describe('listen (adj. 8)', () => {
  it('an address in use → AddressInUseError (cli.ts exits 73)', async () => {
    const blocker = createTcp()
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r))
    const port = (blocker.address() as { port: number }).port
    const core = { read: fakeRead().read, state: () => 'online', localToken: TOKEN, storeDir: '/nonexistent' } as unknown as Core
    await expect(startLocalApi(core, { host: '127.0.0.1', port }, () => {})).rejects.toBeInstanceOf(AddressInUseError)
    await new Promise<void>((r) => blocker.close(() => r()))
  })
})

// ── Write routes (S-c2, §0.3.7 items 1, 2, 7, 8) ─────────────────────────────────────────────────

interface RawRes {
  status: number
  headers: Record<string, string | string[] | undefined>
  raw: Buffer
  body: Record<string, unknown>
}

// A request with a body: `chunked` sends it without Content-Length, in pieces.
function send(port: number, path: string, opts: { method: string; body?: Buffer | string; headers?: Record<string, string>; chunked?: boolean }): Promise<RawRes> {
  return new Promise((resolve, reject) => {
    const body = opts.body === undefined ? undefined : Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body)
    const headers: Record<string, string> = { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}`, ...opts.headers }
    if (body !== undefined && opts.chunked !== true) headers['content-length'] = String(body.length)
    const req = request({ host: '127.0.0.1', port, path, method: opts.method, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const raw = Buffer.concat(chunks)
        let parsed: Record<string, unknown> = {}
        if (String(res.headers['content-type'] ?? '').startsWith('application/json') && raw.length > 0) parsed = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, raw, body: parsed })
      })
    })
    req.on('error', reject)
    if (body !== undefined && opts.chunked === true) {
      // Pieces of 4 KiB; a reset after the server answered is fine (it closed on purpose).
      req.on('error', () => {})
      for (let i = 0; i < body.length; i += 4096) req.write(body.subarray(i, i + 4096))
    } else if (body !== undefined) {
      req.write(body)
    }
    req.end()
  })
}

const errCode = (r: RawRes): unknown => (r.body.error as { code?: string } | undefined)?.code
const errRefused = (r: RawRes): unknown => (r.body.error as { refused?: unknown } | undefined)?.refused
const json = (v: unknown): { body: string; headers: Record<string, string> } => ({ body: JSON.stringify(v), headers: { 'content-type': 'application/json' } })

describe('write routes: messages (§0.3.7 items 1, 2)', () => {
  it('POST → 200 with the facade’s ApiMessage; the parsed request reaches the facade', async () => {
    const w = fakeWrite()
    const { port } = await start(fakeRead().read, { write: w.write })
    const r = await send(port, '/v1/conversations/CAAAAAAAAAA/messages', { method: 'POST', ...json({ text: 'oi', thread: '1.000001', mentions: ['UAAAAAAAAAA'] }) })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ id: '1730900001.000123', text: 'oi' })
    expect(w.calls).toEqual([['post', 'CAAAAAAAAAA', { text: 'oi', thread: '1.000001', mentions: ['UAAAAAAAAAA'] }]])
  })

  it('400 invalid_argument: a non-boolean markdown, an unknown field, empty or blank text, bad JSON, thread + replyTo, bad mentions', async () => {
    const w = fakeWrite()
    const { port } = await start(fakeRead().read, { write: w.write })
    const path = '/v1/conversations/CAAAAAAAAAA/messages'
    for (const body of [
      { text: 'oi', markdown: 'true' },
      { text: 'oi', markdown: 1 },
      { text: 'oi', markdown: null },
      { text: 'oi', blocks: [] },
      { text: '' },
      { text: '   ' },
      { thread: '1.000001' },
      { text: 'oi', thread: '1.000001', replyTo: '1.000002' },
      { text: 'oi', mentions: 'UAAAAAAAAAA' },
      { text: 'oi', mentions: [1] },
      ['oi'],
    ]) {
      const r = await send(port, path, { method: 'POST', ...json(body) })
      expect([r.status, errCode(r)], JSON.stringify(body)).toEqual([400, 'invalid_argument'])
    }
    const bad = await send(port, path, { method: 'POST', body: '{"text":', headers: { 'content-type': 'application/json' } })
    expect([bad.status, errCode(bad)]).toEqual([400, 'invalid_argument'])
    expect(w.calls).toEqual([])
  })

  it('413 payload_too_large: text over 32 KiB of UTF-8; a JSON body over 256 KiB is refused before reading', async () => {
    const w = fakeWrite()
    const { port } = await start(fakeRead().read, { write: w.write })
    const path = '/v1/conversations/CAAAAAAAAAA/messages'
    // 11 000 × "ç" (2 bytes) = 22 000 bytes is fine; 17 000 × 2 = 34 000 > 32 768 is not.
    expect((await send(port, path, { method: 'POST', ...json({ text: 'ç'.repeat(11_000) }) })).status).toBe(200)
    const long = await send(port, path, { method: 'POST', ...json({ text: 'ç'.repeat(17_000) }) })
    expect([long.status, errCode(long)]).toEqual([413, 'payload_too_large'])
    const huge = await send(port, path, { method: 'POST', ...json({ text: 'x'.repeat(300 * 1024) }) })
    expect([huge.status, errCode(huge)]).toEqual([413, 'payload_too_large'])
    expect(huge.headers.connection).toBe('close')
    expect(w.calls).toHaveLength(1)
  })

  // S-i (PLANO-AGENTES §0.3.15 item 2): `markdown` is opt-in on the native API.
  it('POST markdown: true → rich only when there is formatting; false or absent → no rich; text is the fallback', async () => {
    const w = fakeWrite()
    const { port } = await start(fakeRead().read, { write: w.write })
    const path = '/v1/conversations/CAAAAAAAAAA/messages'
    for (const body of [
      { text: '**pronto**', markdown: true },
      { text: 'pronto', markdown: true },
      { text: '**pronto**', markdown: false },
      { text: '**pronto**' },
    ]) expect((await send(port, path, { method: 'POST', ...json(body) })).status, JSON.stringify(body)).toBe(200)
    expect(w.calls).toEqual([
      ['post', 'CAAAAAAAAAA', { text: '**pronto**', rich: [{ t: 'p', children: [{ t: 'strong', children: [{ t: 'text', text: 'pronto' }] }] }] }],
      ['post', 'CAAAAAAAAAA', { text: 'pronto' }],
      ['post', 'CAAAAAAAAAA', { text: '**pronto**' }],
      ['post', 'CAAAAAAAAAA', { text: '**pronto**' }],
    ])
  })

  it('PATCH markdown: true → rich only when there is formatting; false → no rich; a non-boolean → 400', async () => {
    const w = fakeWrite()
    const { port } = await start(fakeRead().read, { write: w.write })
    const path = '/v1/conversations/CAAAAAAAAAA/messages/1730900000.100123'
    expect((await send(port, path, { method: 'PATCH', ...json({ text: '# novo', markdown: true }) })).status).toBe(200)
    expect((await send(port, path, { method: 'PATCH', ...json({ text: 'novo', markdown: true }) })).status).toBe(200)
    expect((await send(port, path, { method: 'PATCH', ...json({ text: '# novo', markdown: false }) })).status).toBe(200)
    for (const markdown of ['yes', 0, null, {}]) {
      const r = await send(port, path, { method: 'PATCH', ...json({ text: 'x', markdown }) })
      expect([r.status, errCode(r)], JSON.stringify(markdown)).toEqual([400, 'invalid_argument'])
    }
    expect(w.calls).toEqual([
      ['edit', 'CAAAAAAAAAA', '1730900000.100123', '# novo', [{ t: 'p', children: [{ t: 'strong', children: [{ t: 'text', text: 'novo' }] }] }]],
      ['edit', 'CAAAAAAAAAA', '1730900000.100123', 'novo'],
      ['edit', 'CAAAAAAAAAA', '1730900000.100123', '# novo'],
    ])
  })

  it('markdown: true with a matrix.to link: encoded → the rich has no link; raw → refused by the preflight', async () => {
    const w = fakeWrite()
    const { port } = await start(fakeRead().read, { write: w.write })
    const path = '/v1/conversations/CAAAAAAAAAA/messages'
    const encoded = 'oi [Alice](https://matrix.to/#/%40alice%3Atayet.local) **já**'
    expect((await send(port, path, { method: 'POST', ...json({ text: encoded, markdown: true }) })).status).toBe(200)
    const rich = (w.calls[0]![2] as { rich?: unknown }).rich
    expect(rich).toEqual([{ t: 'p', children: [{ t: 'text', text: 'oi ' }, { t: 'text', text: 'Alice' }, { t: 'text', text: ' ' }, { t: 'strong', children: [{ t: 'text', text: 'já' }] }] }])
    expect(JSON.stringify(rich)).not.toContain('matrix.to')
    const raw = await send(port, path, { method: 'POST', ...json({ text: 'oi [Alice](https://matrix.to/#/@alice:tayet.local)', markdown: true }) })
    expect([raw.status, errCode(raw)]).toEqual([422, 'content_refused'])
    expect(w.calls).toHaveLength(1)
  })

  it('PATCH → 200 with editedAt; DELETE → 204; the text of a PATCH is validated the same way', async () => {
    const w = fakeWrite()
    const { port } = await start(fakeRead().read, { write: w.write })
    const path = '/v1/conversations/CAAAAAAAAAA/messages/1730900000.100123'
    const edited = await send(port, path, { method: 'PATCH', ...json({ text: 'novo' }) })
    expect(edited.status).toBe(200)
    expect(edited.body).toMatchObject({ id: '1730900000.100123', text: 'novo', editedAt: 1 })
    expect((await send(port, path, { method: 'PATCH', ...json({ text: 'x', mentions: [] }) })).status).toBe(400)
    const removed = await send(port, path, { method: 'DELETE' })
    expect(removed.status).toBe(204)
    expect(removed.raw.length).toBe(0)
    expect(w.calls).toEqual([
      ['edit', 'CAAAAAAAAAA', '1730900000.100123', 'novo'],
      ['remove', 'CAAAAAAAAAA', '1730900000.100123'],
    ])
  })

  it('an id shape in the text is refused BEFORE the write (422 content_refused, leak-blocked, facade untouched); prose passes', async () => {
    const w = fakeWrite()
    const { port } = await start(fakeRead().read, { write: w.write })
    const path = '/v1/conversations/CAAAAAAAAAA/messages'
    const r = await send(port, path, { method: 'POST', ...json({ text: 'fale com @alice:tayet.local' }) })
    expect([r.status, errCode(r)]).toEqual([422, 'content_refused'])
    expect(errRefused(r)).toEqual([{ field: 'text', pattern: 'user_id' }])
    expect(r.raw.toString()).not.toContain('@alice')
    expect(logs).toContainEqual({ evt: 'leak-blocked', where: 'POST messages', path: '$.text', pattern: 'mxid' })
    expect(JSON.stringify(logs)).not.toContain('@alice')
    expect(w.calls).toEqual([])
    expect((await send(port, path, { method: 'POST', ...json({ text: 'please verify the backup; está no cofre' }) })).status).toBe(200)
  })

  it('an scp address in the text is not a user id: the write happens; a user id is still refused before it', async () => {
    const w = fakeWrite()
    const { port } = await start(fakeRead().read, { write: w.write })
    const path = '/v1/conversations/CAAAAAAAAAA/messages'
    const text = 'scp dev@build-host:project/test/goldens/home.png .'
    expect((await send(port, path, { method: 'POST', ...json({ text }) })).status).toBe(200)
    expect(w.calls).toMatchObject([['post', 'CAAAAAAAAAA', { text }]])
    expect(logs.filter((l) => l.evt === 'leak-blocked')).toEqual([])
    const r = await send(port, path, { method: 'POST', ...json({ text: 'ask @alice:tayet.local' }) })
    expect([r.status, errCode(r)]).toEqual([422, 'content_refused'])
    expect(w.calls).toHaveLength(1)
  })

  it('content_refused: PATCH is refused the same way; the four id shapes come out by their product names, one entry each', async () => {
    const w = fakeWrite()
    const { port } = await start(fakeRead().read, { write: w.write })
    const edit = await send(port, '/v1/conversations/CAAAAAAAAAA/messages/1730900000.100123', { method: 'PATCH', ...json({ text: 'novo @alice:tayet.local' }) })
    expect([edit.status, errCode(edit), errRefused(edit)]).toEqual([422, 'content_refused', [{ field: 'text', pattern: 'user_id' }]])
    expect(logs).toContainEqual({ evt: 'leak-blocked', where: 'PATCH message', path: '$.text', pattern: 'mxid' })
    const eventShape = '$' + 'E'.repeat(43)
    const text = `a @alice:tayet.local b !room:tayet.local c ${eventShape} d mxc://tayet.local/media`
    const four = await send(port, '/v1/conversations/CAAAAAAAAAA/messages', { method: 'POST', ...json({ text }) })
    expect([four.status, errCode(four)]).toEqual([422, 'content_refused'])
    expect(errRefused(four)).toEqual([
      { field: 'text', pattern: 'user_id' },
      { field: 'text', pattern: 'conversation_id' },
      { field: 'text', pattern: 'media_address' },
      { field: 'text', pattern: 'message_id' },
    ])
    expect((four.body.error as { message?: unknown }).message).toEqual(expect.any(String))
    for (const matched of ['@alice', '!room', eventShape, 'mxc://']) expect(four.raw.toString()).not.toContain(matched)
    expect(logs.filter((l) => l.evt === 'leak-blocked' && l.where === 'POST messages').map((l) => l.pattern)).toEqual(['mxid', 'room-id', 'mxc-uri', 'event-id'])
    expect(w.calls).toEqual([])
  })

  it('a probe finding that is not an id shape keeps 500 internal, even next to an id shape in the text', async () => {
    const w = fakeWrite()
    const { port } = await start(fakeRead().read, { write: w.write })
    // The conversation is a structural field of the probe: the whole deny list applies there.
    const word = await send(port, '/v1/conversations/verify-room/messages', { method: 'POST', ...json({ text: 'ok' }) })
    expect([word.status, errCode(word), errRefused(word)]).toEqual([500, 'internal', undefined])
    expect(logs).toContainEqual({ evt: 'leak-blocked', where: 'POST messages', path: '$.conversation', pattern: 'verify' })
    const mixed = await send(port, '/v1/conversations/verify-room/messages', { method: 'POST', ...json({ text: 'ask @alice:tayet.local' }) })
    expect([mixed.status, errCode(mixed), errRefused(mixed)]).toEqual([500, 'internal', undefined])
    expect(w.calls).toEqual([])
  })

  it('an id shape in the conversation (the structural scan) keeps 500 internal, alone or with an id shape in the text', async () => {
    const w = fakeWrite()
    const { port } = await start(fakeRead().read, { write: w.write })
    const path = `/v1/conversations/${encodeURIComponent('!abc:tayet.local')}/messages`
    const alone = await send(port, path, { method: 'POST', ...json({ text: 'ok' }) })
    expect([alone.status, errCode(alone), errRefused(alone)]).toEqual([500, 'internal', undefined])
    expect(logs).toContainEqual({ evt: 'leak-blocked', where: 'POST messages', path: '$.conversation', pattern: 'room-id' })
    const mixed = await send(port, path, { method: 'POST', ...json({ text: 'ask @alice:tayet.local' }) })
    expect([mixed.status, errCode(mixed), errRefused(mixed)]).toEqual([500, 'internal', undefined])
    expect(logs).toContainEqual({ evt: 'leak-blocked', where: 'POST messages', path: '$.text', pattern: 'mxid' })
    expect(w.calls).toEqual([])
  })

  it('an answer withheld after the write stays 500 internal (content or a structural field)', async () => {
    const inText = fakeWrite({ post: () => Promise.resolve(msg({ text: 'ver @bob:tayet.local' })) })
    const a = await start(fakeRead().read, { write: inText.write })
    const r = await send(a.port, '/v1/conversations/CAAAAAAAAAA/messages', { method: 'POST', ...json({ text: 'ok' }) })
    expect([r.status, errCode(r), errRefused(r)]).toEqual([500, 'internal', undefined])
    const inThread = fakeWrite({ post: () => Promise.resolve(msg({ text: 'ok', thread: '!abc:tayet.local' })) })
    const b = await start(fakeRead().read, { write: inThread.write })
    const t = await send(b.port, '/v1/conversations/CAAAAAAAAAA/messages', { method: 'POST', ...json({ text: 'ok' }) })
    expect([t.status, errCode(t), errRefused(t)]).toEqual([500, 'internal', undefined])
  })

  it('405 with the Allow of each route', async () => {
    const { port } = await start(fakeRead().read)
    const cases: Array<[string, string, string]> = [
      ['PUT', '/v1/conversations/CAAAAAAAAAA/messages', 'GET, POST'],
      ['GET', '/v1/conversations/CAAAAAAAAAA/messages/1.000001', 'PATCH, DELETE'],
      ['POST', '/v1/conversations/CAAAAAAAAAA/messages/1.000001/reactions/x', 'PUT, DELETE'],
      ['GET', '/v1/conversations/CAAAAAAAAAA/files', 'POST'],
      ['DELETE', '/v1/files/FAAAAAAAAAA', 'GET'],
    ]
    for (const [method, path, allow] of cases) {
      const r = await send(port, path, { method })
      expect([r.status, r.headers.allow], `${method} ${path}`).toEqual([405, allow])
    }
  })

  it('a malformed percent-encoding → 400 for an authorized caller, 401 otherwise', async () => {
    const { port } = await start(fakeRead().read)
    expect(errCode(await send(port, '/v1/conversations/%E0%A4%A/messages', { method: 'POST' }))).toBe('invalid_argument')
    expect((await call(port, '/v1/conversations/%E0%A4%A', { auth: false })).status).toBe(401)
  })
})

describe('write routes: error mapping (§0.3.7 item 2)', () => {
  it('each facade error → its status; rate_limited carries Retry-After (seconds, up) and retryAfterMs', async () => {
    const cases: Array<[Error, number, string]> = [
      [new WriteError('not_member'), 403, 'not_member'],
      [new WriteError('not_own_message'), 403, 'not_own_message'],
      [new WriteError('not_editable'), 400, 'not_editable'],
      [new WriteError('upstream_failed'), 502, 'upstream_failed'],
      [new WriteError('unavailable'), 503, 'unavailable'],
      [new WriteError('revoked'), 503, 'revoked'],
      [new WriteError('invalid_argument'), 400, 'invalid_argument'],
      [new ReadError('message_not_found'), 404, 'message_not_found'],
      [new ReadError('user_not_found'), 404, 'user_not_found'],
      [new ReadError('conversation_not_found'), 404, 'conversation_not_found'],
    ]
    for (const [err, status, c] of cases) {
      const { port } = await start(fakeRead().read, { write: fakeWrite({ edit: () => Promise.reject(err) }).write })
      const r = await send(port, '/v1/conversations/CAAAAAAAAAA/messages/1.000001', { method: 'PATCH', ...json({ text: 'x' }) })
      expect([r.status, errCode(r)]).toEqual([status, c])
    }
    const { port } = await start(fakeRead().read, { write: fakeWrite({ post: () => Promise.reject(new WriteError('rate_limited', 1_500)) }).write })
    const r = await send(port, '/v1/conversations/CAAAAAAAAAA/messages', { method: 'POST', ...json({ text: 'x' }) })
    expect(r.status).toBe(429)
    expect(r.headers['retry-after']).toBe('2')
    expect(r.body).toEqual({ error: { code: 'rate_limited', message: expect.any(String) as string, retryAfterMs: 1_500 } })
  })
})

describe('write routes: reactions (§0.3.7 item 1)', () => {
  it('PUT/DELETE → 204 with the decoded character; a :name: or blank → 400', async () => {
    const w = fakeWrite()
    const { port } = await start(fakeRead().read, { write: w.write })
    const base = '/v1/conversations/CAAAAAAAAAA/messages/1.000001/reactions/'
    expect((await send(port, base + encodeURIComponent('👍'), { method: 'PUT' })).status).toBe(204)
    expect((await send(port, base + encodeURIComponent('👍'), { method: 'DELETE' })).status).toBe(204)
    expect((await send(port, base + encodeURIComponent(':thumbsup:'), { method: 'PUT' })).status).toBe(400)
    expect((await send(port, base + '%20', { method: 'PUT' })).status).toBe(400)
    expect(w.calls).toEqual([
      ['react', 'CAAAAAAAAAA', '1.000001', '👍'],
      ['unreact', 'CAAAAAAAAAA', '1.000001', '👍'],
    ])
  })
})

describe('write routes: files (§0.3.7 items 1, 7, 8)', () => {
  const path = '/v1/conversations/CAAAAAAAAAA/files'

  it('POST bytes → 200 with files[0]; Content-Type is the mimetype (absent → octet-stream); thread passes', async () => {
    const w = fakeWrite()
    const { port } = await start(fakeRead().read, { write: w.write })
    const r = await send(port, `${path}?name=${encodeURIComponent('nota fiscal.pdf')}&thread=1.000001`, {
      method: 'POST',
      body: Buffer.alloc(100, 7),
      headers: { 'content-type': 'application/pdf; charset=binary' },
    })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ files: [{ id: 'FAAAAAAAAAA', name: 'nota fiscal.pdf', mimetype: 'application/pdf', size: 100 }] })
    await send(port, `${path}?name=x.bin`, { method: 'POST', body: Buffer.alloc(3) })
    expect(w.calls).toEqual([
      ['upload', 'CAAAAAAAAAA', { name: 'nota fiscal.pdf', mimetype: 'application/pdf', bytes: 100, thread: '1.000001' }],
      ['upload', 'CAAAAAAAAAA', { name: 'x.bin', mimetype: 'application/octet-stream', bytes: 3 }],
    ])
  })

  it('a declared Content-Length over the limit → 413 file_too_large before reading; nothing reaches the facade', async () => {
    const w = fakeWrite()
    const { port } = await start(fakeRead().read, { write: w.write })
    const r = await send(port, `${path}?name=big.bin`, { method: 'POST', body: Buffer.alloc(2048) })
    expect([r.status, errCode(r)]).toEqual([413, 'file_too_large'])
    expect(r.headers.connection).toBe('close')
    expect(w.calls).toEqual([])
  })

  it('a body without Content-Length is cut as soon as it passes the limit → 413', async () => {
    const w = fakeWrite()
    const { port } = await start(fakeRead().read, { write: w.write })
    const r = await send(port, `${path}?name=big.bin`, { method: 'POST', body: Buffer.alloc(64 * 1024), chunked: true })
    expect([r.status, errCode(r)]).toEqual([413, 'file_too_large'])
    expect(w.calls).toEqual([])
    // Under the limit, chunked is fine.
    expect((await send(port, `${path}?name=ok.bin`, { method: 'POST', body: Buffer.alloc(500), chunked: true })).status).toBe(200)
  })

  it('a missing or bad name, or a bad Content-Type → 400; an id shape in the name → 422 content_refused before any upload', async () => {
    const w = fakeWrite()
    const { port } = await start(fakeRead().read, { write: w.write })
    for (const q of ['', '?name=', '?name=a%2Fb', `?name=${'x'.repeat(256)}`]) {
      expect((await send(port, path + q, { method: 'POST', body: Buffer.alloc(1) })).status).toBe(400)
    }
    expect((await send(port, `${path}?name=a`, { method: 'POST', body: Buffer.alloc(1), headers: { 'content-type': 'not a type' } })).status).toBe(400)
    const leak = await send(port, `${path}?name=${encodeURIComponent('@bob:tayet.local.txt')}`, { method: 'POST', body: Buffer.alloc(1) })
    expect([leak.status, errCode(leak)]).toEqual([422, 'content_refused'])
    expect(errRefused(leak)).toEqual([{ field: 'files[0].name', pattern: 'user_id' }])
    expect(logs).toContainEqual({ evt: 'leak-blocked', where: 'POST files', path: '$.files[0].name', pattern: 'mxid' })
    expect(leak.raw.toString()).not.toContain('@bob')
    expect(w.calls).toEqual([])
  })

  it('two concurrent uploads: the 2nd body is not read until the 1st releases the slot; both 200 (§0.3.7 item 4)', async () => {
    const SIZE = 32 * 1024 * 1024
    let releaseFirst!: () => void
    const firstHeld = new Promise<void>((r) => (releaseFirst = r))
    const reads: string[] = []
    let tail: Promise<unknown> = Promise.resolve()
    // A facade with the real slot discipline: one upload at a time, the body read inside it.
    const w = fakeWrite({
      uploadLimit: () => Promise.resolve(64 * 1024 * 1024),
      upload: (_c, r) => {
        const run = tail.then(async () => {
          reads.push(`start ${r.name}`)
          const bytes = await r.body()
          reads.push(`read ${r.name} ${bytes.byteLength}`)
          if (r.name === 'first.bin') await firstHeld
          return msg({ text: '', files: [{ id: 'FAAAAAAAAAA', name: r.name, mimetype: r.mimetype, size: bytes.byteLength }] })
        })
        tail = run.catch(() => undefined)
        return run
      },
    })
    const { port } = await start(fakeRead().read, { write: w.write })
    const upload = (name: string) => {
      const req = request({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: `/v1/conversations/CAAAAAAAAAA/files?name=${name}`,
        headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}`, 'content-length': String(SIZE) },
      })
      const status = new Promise<number>((resolve, reject) => {
        req.on('response', (res) => {
          res.resume()
          res.on('end', () => resolve(res.statusCode ?? 0))
        })
        req.on('error', reject)
      })
      req.end(Buffer.alloc(SIZE, 1))
      return { req, status }
    }
    const first = upload('first.bin')
    await vi.waitFor(() => expect(reads).toEqual(['start first.bin', `read first.bin ${SIZE}`]))
    const second = upload('second.bin')
    await new Promise((r) => setTimeout(r, 500))
    // The slot is held: the 2nd body was not read, and the client still holds bytes it could not
    // push (TCP backpressure: nobody on the server side is reading them).
    expect(reads).toEqual(['start first.bin', `read first.bin ${SIZE}`])
    expect(second.req.socket?.writableLength ?? 0).toBeGreaterThan(0)
    releaseFirst()
    expect(await first.status).toBe(200)
    expect(await second.status).toBe(200)
    expect(reads).toEqual(['start first.bin', `read first.bin ${SIZE}`, 'start second.bin', `read second.bin ${SIZE}`])
  })

  it('GET /v1/files/:id → the bytes with Content-Type, Content-Length and an RFC 5987 Content-Disposition', async () => {
    const w = fakeWrite()
    const { port } = await start(fakeRead().read, { write: w.write })
    const r = await send(port, '/v1/files/FAAAAAAAAAA', { method: 'GET' })
    expect(r.status).toBe(200)
    expect([...r.raw]).toEqual([1, 2, 3])
    expect(r.headers['content-type']).toBe('application/pdf')
    expect(r.headers['content-length']).toBe('3')
    expect(r.headers['content-disposition']).toBe("attachment; filename*=UTF-8''relat%C3%B3rio%20final.pdf")
    expect(w.calls).toEqual([['download', 'FAAAAAAAAAA']])
  })

  it('a file name with an id shape → 500 at the header (leak-blocked, no value); file_not_found → 404', async () => {
    const leaky = fakeWrite({ download: () => Promise.resolve({ bytes: new Uint8Array([1]), mimetype: 'text/plain', name: '@carol:tayet.local' }) })
    const { port } = await start(fakeRead().read, { write: leaky.write })
    const r = await send(port, '/v1/files/FAAAAAAAAAA', { method: 'GET' })
    expect([r.status, errCode(r)]).toEqual([500, 'internal'])
    expect(logs).toContainEqual({ evt: 'leak-blocked', where: 'GET file', path: '$.name', pattern: 'mxid' })
    const missing = fakeWrite({ download: () => Promise.reject(new WriteError('file_not_found')) })
    const s2 = await start(fakeRead().read, { write: missing.write })
    expect(errCode(await send(s2.port, '/v1/files/FBBBBBBBBBB', { method: 'GET' }))).toBe('file_not_found')
  })
})

// ADR-091 (A3-3): the approval routes over a fake facade — the body's shape and the option rules, the
// preflight of labels, close and state, and the 404 when the core hands no facade.
describe('write routes: approval cards (A3-3)', () => {
  const card = (over: Partial<ApiMessage> = {}): ApiMessage =>
    msg({ id: '1730900002.000123', text: 'Publicar?', approval: { options: [{ id: 'ok', label: 'Verificar' }], state: 'open' }, ...over })
  const fakeApprovals = () => {
    const calls: unknown[] = []
    const approvals: ApprovalFacade = {
      request: (c, r) => {
        calls.push(['request', c, r])
        return Promise.resolve(card({ text: r.text }))
      },
      close: (c, ts, text, rich) => {
        calls.push(['close', c, ts, text, rich])
        return Promise.resolve(card({ id: ts, approval: { options: [{ id: 'ok', label: 'Verificar' }], state: 'closed' } }))
      },
      state: (c, ts) => {
        calls.push(['state', c, ts])
        return Promise.resolve({ conversation: c, id: ts, approval: { options: [{ id: 'ok', label: 'Verificar' }], state: 'answered', answer: { option: 'ok', by: 'UBBBBBBBBBB', at: 5 } } })
      },
    }
    return { approvals, calls }
  }
  const path = '/v1/conversations/CAAAAAAAAAA/approvals'

  it('POST → 200 with the card (a denied word in a label passes); the parsed request reaches the facade', async () => {
    const a = fakeApprovals()
    const { port } = await start(fakeRead().read, { approvals: a.approvals })
    const options = [{ id: 'ok', label: 'Verificar', style: 'primary' }, { id: 'no', label: 'Não', style: 'danger' }]
    const r = await send(port, path, { method: 'POST', ...json({ text: 'Publicar?', options, thread: '1.000001', mentions: ['UAAAAAAAAAA'] }) })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ id: '1730900002.000123', approval: { options: [{ id: 'ok', label: 'Verificar' }], state: 'open' } })
    expect(a.calls).toEqual([['request', 'CAAAAAAAAAA', { text: 'Publicar?', options, thread: '1.000001', mentions: ['UAAAAAAAAAA'] }]])
  })

  it('400 invalid_argument for each option rule; more than one primary is refused, never demoted', async () => {
    const a = fakeApprovals()
    const { port } = await start(fakeRead().read, { approvals: a.approvals })
    const o = (id: string, label = 'L', style?: string) => ({ id, label, ...(style !== undefined && { style }) })
    for (const options of [
      undefined,
      [],
      Array.from({ length: 26 }, (_, n) => o(`o${n}`)),
      [o('A')],
      [o('a b')],
      [o('x'.repeat(33))],
      [o('a'), o('a')],
      [o('a', '')],
      [o('a', '   ')],
      [o('a', 'x'.repeat(76))],
      [o('a', 'L', 'warning')],
      [o('a', 'L', 'primary'), o('b', 'L', 'primary')],
      [{ id: 'a', label: 'L', value: 1 }],
      ['a'],
    ]) {
      const r = await send(port, path, { method: 'POST', ...json({ text: 'x', ...(options !== undefined && { options }) }) })
      expect([r.status, errCode(r)], JSON.stringify(options)).toEqual([400, 'invalid_argument'])
    }
    // 75 characters (by code point) and 32-character ids are the limits, not past them.
    const edge = await send(port, path, { method: 'POST', ...json({ text: 'x', options: [o('x'.repeat(32), 'ç'.repeat(75))] }) })
    expect(edge.status).toBe(200)
    // 25 options are the limit (26 is refused above).
    const many = Array.from({ length: 25 }, (_, n) => o(`o${n}`))
    expect((await send(port, path, { method: 'POST', ...json({ text: 'x', options: many }) })).status).toBe(200)
    expect(a.calls.at(-1)).toEqual(['request', 'CAAAAAAAAAA', { text: 'x', options: many }])
    expect((await send(port, path, { method: 'POST', ...json({ text: 'x', options: [o('a')], replyTo: '1.1' }) })).status).toBe(400)
    expect(a.calls).toHaveLength(2)
  })

  it('an id shape in a label is refused BEFORE the send (422 content_refused, leak-blocked, facade untouched)', async () => {
    const a = fakeApprovals()
    const { port } = await start(fakeRead().read, { approvals: a.approvals })
    const r = await send(port, path, { method: 'POST', ...json({ text: 'x', options: [{ id: 'a', label: 'com @alice:tayet.local' }] }) })
    expect([r.status, errCode(r)]).toEqual([422, 'content_refused'])
    expect(errRefused(r)).toEqual([{ field: 'approval.options[0].label', pattern: 'user_id' }])
    expect(r.raw.toString()).not.toContain('@alice')
    expect(a.calls).toEqual([])
    expect(logs).toContainEqual({ evt: 'leak-blocked', where: 'POST approvals', path: '$.approval.options[0].label', pattern: 'mxid' })
  })

  it('close with an id shape in the new text → 422 content_refused before the close; two findings → two entries', async () => {
    const a = fakeApprovals()
    const { port } = await start(fakeRead().read, { approvals: a.approvals })
    const closed = await send(port, `${path}/1.000001/close`, { method: 'POST', ...json({ text: 'feito com @alice:tayet.local' }) })
    expect([closed.status, errCode(closed), errRefused(closed)]).toEqual([422, 'content_refused', [{ field: 'text', pattern: 'user_id' }]])
    expect(logs).toContainEqual({ evt: 'leak-blocked', where: 'POST approval close', path: '$.text', pattern: 'mxid' })
    const two = await send(port, path, { method: 'POST', ...json({ text: 'ver !abc:tayet.local', options: [{ id: 'a', label: 'com @alice:tayet.local' }] }) })
    expect([two.status, errCode(two)]).toEqual([422, 'content_refused'])
    expect(errRefused(two)).toEqual([
      { field: 'text', pattern: 'conversation_id' },
      { field: 'approval.options[0].label', pattern: 'user_id' },
    ])
    expect(a.calls).toEqual([])
  })

  it('close: no body keeps the request; text (+markdown) replaces it; GET state; no route answers a card', async () => {
    const a = fakeApprovals()
    const { port } = await start(fakeRead().read, { approvals: a.approvals })
    expect((await send(port, `${path}/1.000001/close`, { method: 'POST' })).status).toBe(200)
    expect((await send(port, `${path}/1.000002/close`, { method: 'POST', ...json({ text: '**Encerrado**', markdown: true }) })).status).toBe(200)
    const s = await call(port, `${path}/1.000003`)
    expect(s.body).toEqual({ conversation: 'CAAAAAAAAAA', id: '1.000003', approval: { options: [{ id: 'ok', label: 'Verificar' }], state: 'answered', answer: { option: 'ok', by: 'UBBBBBBBBBB', at: 5 } } })
    expect(a.calls[0]).toEqual(['close', 'CAAAAAAAAAA', '1.000001', undefined, undefined])
    expect(a.calls[1]).toMatchObject(['close', 'CAAAAAAAAAA', '1.000002', '**Encerrado**', [{ t: 'p' }]])
    expect((await send(port, `${path}/1.000001/close`, { method: 'POST', ...json({ text: '' }) })).status).toBe(400)
    expect((await send(port, `${path}/1.000001/close`, { method: 'POST', ...json({ option: 'ok' }) })).status).toBe(400)
    expect((await call(port, `${path}/1.000001/answer`, { method: 'POST' })).status).toBe(404)
    expect((await call(port, `${path}/1.000001`, { method: 'POST' })).headers.allow).toBe('GET')
    expect((await call(port, path)).headers.allow).toBe('POST')
  })

  it('the facade’s refusals map to their codes (not_approval 400, not_own_message 403)', async () => {
    const a = fakeApprovals()
    a.approvals.close = () => Promise.reject(new WriteError('not_approval'))
    a.approvals.state = () => Promise.reject(new WriteError('not_own_message'))
    const { port } = await start(fakeRead().read, { approvals: a.approvals })
    expect([(await send(port, `${path}/1.000001/close`, { method: 'POST' })).status]).toEqual([400])
    expect(code(await call(port, `${path}/1.000001`))).toBe('not_own_message')
  })

  it('without the facade the approval routes answer 404', async () => {
    const { port } = await start(fakeRead().read)
    expect(errCode(await send(port, path, { method: 'POST', ...json({ text: 'x', options: [{ id: 'a', label: 'A' }] }) }))).toBe('not_found')
    expect(code(await call(port, `${path}/1.000001`))).toBe('not_found')
  })
})

describe('write routes: pinned panel (A3-6)', () => {
  const path = '/v1/conversations/CAAAAAAAAAA/panel'
  const fakePanels = (over: Partial<PanelFacade> = {}) => {
    const calls: unknown[] = []
    let pending = false
    const panels: PanelFacade = {
      set: (c, w) => {
        calls.push(['set', c, w])
        pending = true
        return Promise.resolve({ conversation: c, pending: true })
      },
      clear: (c) => {
        calls.push(['clear', c])
        return Promise.resolve(pending ? { conversation: c, pending: true as const } : { conversation: c, pending: false as const })
      },
      get: (c) => {
        calls.push(['get', c])
        return Promise.resolve({ conversation: c, panel: { title: 'Verificar o cofre', text: 'please verify the backup', updatedAt: 5 }, pending })
      },
      ...over,
    }
    return { panels, calls }
  }

  it('PUT → 202 at the enqueue (a denied word in text and title passes); GET carries `pending`; DELETE 202, or 204 with nothing to clear', async () => {
    const p = fakePanels()
    const { port } = await start(fakeRead().read, { panels: p.panels })
    expect(await send(port, path, { method: 'DELETE' }).then((r) => [r.status, r.raw.length])).toEqual([204, 0])
    const put = await send(port, path, { method: 'PUT', ...json({ text: '**Backup** ok', markdown: true, title: 'Verificar o cofre' }) })
    expect([put.status, put.body]).toEqual([202, { conversation: 'CAAAAAAAAAA', pending: true }])
    expect(p.calls[1]).toMatchObject(['set', 'CAAAAAAAAAA', { text: '**Backup** ok', title: 'Verificar o cofre', rich: [{ t: 'p' }] }])
    const plain = await send(port, path, { method: 'PUT', ...json({ text: 'sem markdown' }) })
    expect(plain.status).toBe(202)
    expect(p.calls[2]).toEqual(['set', 'CAAAAAAAAAA', { text: 'sem markdown' }])
    const got = await call(port, path)
    expect([got.status, got.body]).toEqual([200, { conversation: 'CAAAAAAAAAA', panel: { title: 'Verificar o cofre', text: 'please verify the backup', updatedAt: 5 }, pending: true }])
    const del = await send(port, path, { method: 'DELETE' })
    expect([del.status, del.body]).toEqual([202, { conversation: 'CAAAAAAAAAA', pending: true }])
    expect((await call(port, path, { method: 'POST' })).headers.allow).toBe('GET, PUT, DELETE')
  })

  it('400 for the body (thread, mentions, unknown field, empty text, non-string title, bad markdown); 413 over 8 KiB; nothing queued', async () => {
    const p = fakePanels()
    const { port } = await start(fakeRead().read, { panels: p.panels })
    for (const body of [{ text: 'x', thread: '1.000001' }, { text: 'x', mentions: ['UAAAAAAAAAA'] }, { text: 'x', color: 'red' }, { text: '  ' }, {}, { text: 'x', title: 3 }, { text: 'x', markdown: 'yes' }]) {
      const r = await send(port, path, { method: 'PUT', ...json(body) })
      expect([r.status, errCode(r)], JSON.stringify(body)).toEqual([400, 'invalid_argument'])
    }
    const big = await send(port, path, { method: 'PUT', ...json({ text: 'x'.repeat(8 * 1024 + 1) }) })
    expect([big.status, errCode(big)]).toEqual([413, 'payload_too_large'])
    expect(p.calls).toEqual([])
    const edge = await send(port, path, { method: 'PUT', ...json({ text: 'x'.repeat(8 * 1024) }) })
    expect(edge.status).toBe(202)
  })

  it('the core’s refusals map as the message routes (title rule 400, not_member 403, unknown 404); GET as the reads', async () => {
    const p = fakePanels({
      set: (c, w) => Promise.reject(w.title !== undefined ? new WriteError('invalid_argument') : c === 'CBBBBBBBBBB' ? new WriteError('not_member') : new ReadError('conversation_not_found')),
      get: () => Promise.reject(new ReadError('conversation_not_found')),
      clear: () => Promise.reject(new WriteError('not_member')),
    })
    const { port } = await start(fakeRead().read, { panels: p.panels })
    expect(errCode(await send(port, path, { method: 'PUT', ...json({ text: 'x', title: 'a'.repeat(76) }) }))).toBe('invalid_argument')
    expect(await send(port, '/v1/conversations/CBBBBBBBBBB/panel', { method: 'PUT', ...json({ text: 'x' }) }).then((r) => [r.status, errCode(r)])).toEqual([403, 'not_member'])
    expect(await send(port, '/v1/conversations/CZZZZZZZZZZ/panel', { method: 'PUT', ...json({ text: 'x' }) }).then((r) => [r.status, errCode(r)])).toEqual([404, 'conversation_not_found'])
    expect(await call(port, path).then((r) => [r.status, code(r)])).toEqual([404, 'conversation_not_found'])
    expect(await send(port, path, { method: 'DELETE' }).then((r) => [r.status, errCode(r)])).toEqual([403, 'not_member'])
  })

  it('an id shape in the text or the title is refused BEFORE anything is queued (422 content_refused, leak-blocked)', async () => {
    const p = fakePanels()
    const { port } = await start(fakeRead().read, { panels: p.panels })
    const inText = await send(port, path, { method: 'PUT', ...json({ text: 'falar com @alice:tayet.local' }) })
    const inTitle = await send(port, path, { method: 'PUT', ...json({ text: 'ok', title: 'sala !abc:tayet.local' }) })
    expect([inText.status, errCode(inText), inTitle.status, errCode(inTitle)]).toEqual([422, 'content_refused', 422, 'content_refused'])
    expect([errRefused(inText), errRefused(inTitle)]).toEqual([[{ field: 'panel.text', pattern: 'user_id' }], [{ field: 'panel.title', pattern: 'conversation_id' }]])
    expect(p.calls).toEqual([])
    expect(logs).toContainEqual({ evt: 'leak-blocked', where: 'PUT panel', path: '$.panel.text', pattern: 'mxid' })
    expect(logs.filter((l) => l.where === 'PUT panel').map((l) => l.path)).toContain('$.panel.title')
  })

  it('a GET whose panel carries an id shape is withheld at the edge (500 internal)', async () => {
    const p = fakePanels({ get: (c) => Promise.resolve({ conversation: c, panel: { text: 'ver @bob:tayet.local', updatedAt: 1 }, pending: false }) })
    const { port } = await start(fakeRead().read, { panels: p.panels })
    expect(await call(port, path).then((r) => [r.status, code(r)])).toEqual([500, 'internal'])
  })

  it('without the facade the panel routes answer 404, as the cards’', async () => {
    const { port } = await start(fakeRead().read)
    expect(errCode(await send(port, path, { method: 'PUT', ...json({ text: 'x' }) }))).toBe('not_found')
    expect(errCode(await send(port, path, { method: 'DELETE' }))).toBe('not_found')
    expect(code(await call(port, path))).toBe('not_found')
  })
})

describe('write routes: commands (A4-2a)', () => {
  const path = '/v1/commands'
  const deploy = { name: 'deploy', description: 'Verificar o cofre e publicar', hint: '<ambiente>' }
  const fakeCommands = (over: Partial<CommandsFacade> = {}) => {
    const calls: unknown[] = []
    let set: unknown[] = []
    const commands: CommandsFacade = {
      set: (c) => {
        calls.push(['set', c])
        set = c as unknown[]
        return Promise.resolve({ pending: 2 })
      },
      clear: () => {
        calls.push(['clear'])
        const had = set.length > 0
        set = []
        return Promise.resolve(had ? { pending: 2 } : null)
      },
      get: () => ({ commands: set as never, pending: 0 }),
      ...over,
    }
    return { commands, calls }
  }

  it('PUT → 202 { pending } (a denied word passes as content; normalized); GET → { commands, pending }; DELETE 202, or 204 with nothing to clear', async () => {
    const f = fakeCommands()
    const { port } = await start(fakeRead().read, { commands: f.commands })
    expect(await send(port, path, { method: 'DELETE' }).then((r) => [r.status, r.raw.length])).toEqual([204, 0])
    const put = await send(port, path, { method: 'PUT', ...json({ commands: [{ ...deploy, description: ' Verificar o cofre e publicar ' }, { name: 'status', description: 'O estado', hint: '  ' }] }) })
    expect([put.status, put.body]).toEqual([202, { pending: 2 }])
    expect(f.calls[1]).toEqual(['set', [deploy, { name: 'status', description: 'O estado' }]])
    const got = await call(port, path)
    expect([got.status, got.body]).toEqual([200, { commands: [deploy, { name: 'status', description: 'O estado' }], pending: 0 }])
    const del = await send(port, path, { method: 'DELETE' })
    expect([del.status, del.body]).toEqual([202, { pending: 2 }])
    expect((await call(port, path, { method: 'POST' })).headers.allow).toBe('GET, PUT, DELETE')
  })

  it('400 for each rule, a repeated name, an unknown field and more than 25; 413 over 8 KiB; nothing reaches the facade', async () => {
    const f = fakeCommands()
    const { port } = await start(fakeRead().read, { commands: f.commands })
    const one = (over: Record<string, unknown>) => ({ commands: [{ name: 'ok', description: 'ok', ...over }] })
    const bodies: unknown[] = [
      {},
      { commands: 'deploy' },
      { commands: [], extra: 1 },
      one({ name: '/deploy' }),
      one({ name: 'Deploy' }),
      one({ name: '-x' }),
      one({ name: 'a'.repeat(33) }),
      one({ name: 'açaí' }),
      one({ description: '' }),
      one({ description: 'a'.repeat(101) }),
      one({ description: 'duas\nlinhas' }),
      one({ hint: 'a'.repeat(61) }),
      one({ hint: 'x\ny' }),
      one({ hint: 3 }),
      one({ hint: null }),
      one({ color: 'red' }),
      { commands: [{ name: 'a', description: 'x' }, { name: 'a', description: 'y' }] },
      { commands: Array.from({ length: 26 }, (_, i) => ({ name: `c${i}`, description: 'x' })) },
      { commands: ['deploy'] },
    ]
    for (const body of bodies) {
      const r = await send(port, path, { method: 'PUT', ...json(body) })
      expect([r.status, errCode(r)], JSON.stringify(body)).toEqual([400, 'invalid_argument'])
    }
    // 25 commands at the limits of each field: within the 8 KiB in ASCII, over it in multi-byte text.
    const full = (ch: string) => ({ commands: Array.from({ length: 25 }, (_, i) => ({ name: `c${i}`.padEnd(32, 'x'), description: ch.repeat(100), hint: ch.repeat(60) })) })
    expect((await send(port, path, { method: 'PUT', ...json({ commands: full('a').commands.slice(0, 1) }) })).status).toBe(202)
    f.calls.length = 0
    const big = await send(port, path, { method: 'PUT', ...json(full('é')) })
    expect([big.status, errCode(big)]).toEqual([413, 'payload_too_large'])
    expect(f.calls).toEqual([])
  })

  it('an id shape in a name, a description or a hint is refused BEFORE the facade (422 content_refused, leak-blocked); a GET carrying one is withheld', async () => {
    const f = fakeCommands()
    const { port } = await start(fakeRead().read, { commands: f.commands })
    const inDescription = await send(port, path, { method: 'PUT', ...json({ commands: [{ name: 'ping', description: 'falar com @alice:tayet.local' }] }) })
    const inHint = await send(port, path, { method: 'PUT', ...json({ commands: [{ name: 'ping', description: 'ok', hint: '!abc:tayet.local' }] }) })
    expect([inDescription.status, errCode(inDescription), inHint.status, errCode(inHint)]).toEqual([422, 'content_refused', 422, 'content_refused'])
    expect([errRefused(inDescription), errRefused(inHint)]).toEqual([[{ field: 'commands[0].description', pattern: 'user_id' }], [{ field: 'commands[0].hint', pattern: 'conversation_id' }]])
    expect(f.calls).toEqual([])
    expect(logs).toContainEqual({ evt: 'leak-blocked', where: 'PUT commands', path: '$.commands[0].description', pattern: 'mxid' })
    expect(logs).toContainEqual({ evt: 'leak-blocked', where: 'PUT commands', path: '$.commands[0].hint', pattern: 'room-id' })
    const withheld = fakeCommands({ get: () => ({ commands: [{ name: 'ping', description: 'ver @bob:tayet.local' }], pending: 0 }) })
    const second = await start(fakeRead().read, { commands: withheld.commands })
    expect(await call(second.port, path).then((r) => [r.status, code(r)])).toEqual([500, 'internal'])
  })

  it('the core’s refusals keep their codes (503 unavailable); without the facade the routes answer 404', async () => {
    const f = fakeCommands({ set: () => Promise.reject(new WriteError('unavailable')), clear: () => Promise.reject(new WriteError('unavailable')) })
    const { port } = await start(fakeRead().read, { commands: f.commands })
    expect(await send(port, path, { method: 'PUT', ...json({ commands: [] }) }).then((r) => [r.status, errCode(r)])).toEqual([503, 'unavailable'])
    expect(await send(port, path, { method: 'DELETE' }).then((r) => [r.status, errCode(r)])).toEqual([503, 'unavailable'])
    const bare = await start(fakeRead().read)
    expect(errCode(await send(bare.port, path, { method: 'PUT', ...json({ commands: [] }) }))).toBe('not_found')
    expect(errCode(await send(bare.port, path, { method: 'DELETE' }))).toBe('not_found')
    expect(code(await call(bare.port, path))).toBe('not_found')
  })
})

// Names written by people at the edge of the local API: the vocabulary in a conversation's name or topic, a person's
// name or the agent's own name no longer withholds the answer; an id shape there still does.
describe('names written by people (edge)', () => {
  const VERIFICACAO = { id: 'CAAAAAAAAAA', name: 'Verificação de contas', kind: 'public' as const, topic: 'decrypt e escrow', memberCount: 2 }
  const VERONICA = { id: 'UBBBBBBBBBB', name: 'Verônica (verificação)', kind: 'member' as const }

  it('the conversations listing and the conversation answer 200 with a channel named "Verificação de contas"', async () => {
    const { port } = await start(fakeRead({ conversations: () => ({ conversations: [VERIFICACAO] }), conversation: () => VERIFICACAO }).read)
    const list = await call(port, '/v1/conversations')
    expect(list.status).toBe(200)
    expect(list.body).toEqual({ conversations: [VERIFICACAO] })
    expect(await call(port, '/v1/conversations/CAAAAAAAAAA')).toMatchObject({ status: 200, body: VERIFICACAO })
    expect(logs.filter((l) => l.evt === 'leak-blocked')).toEqual([])
  })

  it('members, a person and the agent’s own answer 200 with the vocabulary in the names', async () => {
    const { port } = await start(
      fakeRead({
        members: () => ({ people: [VERONICA] }),
        person: () => VERONICA,
        me: () => Promise.resolve({ id: 'UAGENTAAAAA', workspace: 'TAAAAAAAAAA', name: 'Verificador de contas', kind: 'agent' }),
      }).read,
    )
    expect(await call(port, '/v1/conversations/CAAAAAAAAAA/members')).toMatchObject({ status: 200, body: { people: [VERONICA] } })
    expect(await call(port, '/v1/people/UBBBBBBBBBB')).toMatchObject({ status: 200, body: VERONICA })
    expect(await call(port, '/v1/me')).toMatchObject({ status: 200, body: { name: 'Verificador de contas' } })
  })

  it('conversation.added and member.changed with the vocabulary in the names reach the stream', async () => {
    const f = fakeRead()
    const { port } = await start(f.read)
    const s = await sse(port)
    f.emit({ type: 'conversation.added', conversation: VERIFICACAO })
    f.emit({ type: 'member.changed', conversation: 'CAAAAAAAAAA', person: VERONICA, state: 'joined' })
    await until(() => s.frames.some((x) => x.event === 'member.changed'))
    expect(JSON.parse(s.frames.find((x) => x.event === 'conversation.added')!.data!)).toEqual({ type: 'conversation.added', conversation: VERIFICACAO })
    expect(JSON.parse(s.frames.find((x) => x.event === 'member.changed')!.data!)).toEqual({ type: 'member.changed', conversation: 'CAAAAAAAAAA', person: VERONICA, state: 'joined' })
    s.close()
  })

  it('an id shape in a name still withholds the whole answer: 500 internal', async () => {
    const { port } = await start(fakeRead({ conversations: () => ({ conversations: [{ ...VERIFICACAO, name: 'u-abcdefghij23' }] }) }).read)
    const r = await call(port, '/v1/conversations')
    expect([r.status, code(r)]).toEqual([500, 'internal'])
    expect(logs).toContainEqual({ evt: 'leak-blocked', where: 'GET conversations', path: '$.conversations[0].name', pattern: 'opaque-localpart' })
    expect(JSON.stringify(logs)).not.toContain('u-abcdefghij23')
  })
})

// A reaction's emoji is user content; the withheld form of a message keeps its thread.
describe('reactions and threads in the withheld form (edge)', () => {
  it('a reaction with the vocabulary passes; one with an id shape withholds only its message in a listing', async () => {
    const messages = [
      msg({ id: '1730900000.300000', reactions: [{ emoji: 'verificado', count: 1, mine: false }] }),
      msg({ id: '1730900000.200000', reactions: [{ emoji: '@alice:tayet.local', count: 1, mine: false }] }),
    ]
    const { port } = await start(fakeRead({ messages: () => Promise.resolve({ messages }) }).read)
    const r = await call(port, '/v1/conversations/CAAAAAAAAAA/messages')
    expect(r.status).toBe(200)
    const out = r.body.messages as ApiMessage[]
    expect(out[0]).toEqual(messages[0])
    expect(out[1]).toMatchObject({ id: '1730900000.200000', text: '', reactions: [], unavailable: true })
    expect(logs.filter((l) => l.evt === 'leak-blocked')).toEqual([{ evt: 'leak-blocked', where: 'GET messages', path: '$.messages[1].reactions[0].emoji', pattern: 'mxid' }])
    expect(JSON.stringify(logs)).not.toContain('alice')
  })

  it('a reaction.changed with an id shape in the emoji is not delivered (one leak-blocked line); one with the vocabulary is', async () => {
    const f = fakeRead()
    const { port } = await start(f.read)
    const s = await sse(port)
    f.emit({ type: 'reaction.changed', conversation: 'CAAAAAAAAAA', id: '1730900000.100123', reactions: [{ emoji: '@alice:tayet.local', count: 1, mine: false }] })
    f.emit({ type: 'reaction.changed', conversation: 'CAAAAAAAAAA', id: '1730900000.100124', reactions: [{ emoji: 'verificado', count: 1, mine: false }] })
    await until(() => s.frames.some((x) => x.event === 'reaction.changed'))
    expect(s.frames.filter((x) => x.event === 'reaction.changed').map((x) => (JSON.parse(x.data!) as { id: string }).id)).toEqual(['1730900000.100124'])
    expect(logs).toContainEqual({ evt: 'leak-blocked', where: 'event:reaction.changed', path: '$.reactions[0].emoji', pattern: 'mxid' })
    s.close()
  })

  it('a withheld reply keeps its thread, in the listing and in the event', async () => {
    const reply = msg({ id: '1730900000.200000', text: 'fale com @alice:tayet.local', thread: '1730900000.100000' })
    const f = fakeRead({ messages: () => Promise.resolve({ messages: [reply] }) })
    const { port } = await start(f.read)
    const r = await call(port, '/v1/conversations/CAAAAAAAAAA/messages')
    expect((r.body.messages as ApiMessage[])[0]).toEqual({ id: reply.id, conversation: reply.conversation, author: reply.author, text: '', mentionsMe: false, reactions: [], unavailable: true, thread: '1730900000.100000' })
    const s = await sse(port)
    f.emit({ type: 'message.received', conversation: 'CAAAAAAAAAA', message: reply })
    await until(() => s.frames.some((x) => x.event === 'message.received'))
    const data = JSON.parse(s.frames.find((x) => x.event === 'message.received')!.data!) as { message: ApiMessage }
    expect(data.message).toEqual({ id: reply.id, conversation: reply.conversation, author: reply.author, text: '', mentionsMe: false, reactions: [], unavailable: true, thread: '1730900000.100000' })
    s.close()
  })
})
