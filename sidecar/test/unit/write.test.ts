import { describe, it, expect, vi } from 'vitest'
import { encryptAttachment } from '@tayet/shared/internal/attachment-crypto'
import { ReadError, type FileRef, type Resolver } from '../../src/core/read'
import type { SendResult } from '../../src/core/queue'
import type { WriteJob } from '../../src/core/send'
import { createWriteFacade, UPLOAD_CEILING, WriteError, writeErrorOf, type WriteClient } from '../../src/core/write'

// The write facade (core/write.ts, §0.3.7 items 2–8) over fakes: tokens in, raw ids to the queue,
// tokens out; the targets (thread promotion, thread + replyTo, mentions), the owner rule, the
// idempotent reactions, the ts of the accepted event, the upload limit and paths, the download.

const ME = '@a-abcdefghijkl:test.local'
const ALICE = '@alice:test.local'
const ROOM = '!room:test.local'
const LEFT = '!left:test.local'
const CONV = 'CAAAAAAAAAA'
const CONV_LEFT = 'CBBBBBBBBBB'

interface Ev {
  id: string
  sender: string
  type?: string
  content?: Record<string, unknown>
  wire?: Record<string, unknown>
  redacted?: boolean
  utd?: boolean
  ts?: number
  key?: string
}

function event(e: Ev) {
  return {
    getId: () => e.id,
    getSender: () => e.sender,
    getType: () => e.type ?? 'm.room.message',
    getContent: () => e.content ?? { msgtype: 'm.text', body: 'x' },
    getWireContent: () => e.wire ?? e.content ?? {},
    isRedacted: () => e.redacted === true,
    localRedactionEvent: () => null,
    isDecryptionFailure: () => e.utd === true,
    getTs: () => e.ts ?? 1_000,
    getRelation: () => (e.key !== undefined ? { key: e.key } : null),
    status: null,
  }
}

interface Setup {
  events?: Ev[]
  reactions?: Ev[]
  encrypted?: boolean
  plan?: SendResult[]
  remote?: Record<string, { origin_server_ts: number }>
  mediaConfig?: () => Promise<Record<string, unknown>>
  download?: () => Promise<Blob>
  enqueue?: (job: WriteJob) => Promise<SendResult>
}

function setup(s: Setup = {}) {
  const local = new Map((s.events ?? []).map((e) => [e.id, event(e)]))
  const reactions = (s.reactions ?? []).map(event)
  const mkRoom = (roomId: string, membership: string) => ({
    roomId,
    getMyMembership: () => membership,
    findEventById: (id: string) => local.get(id),
    getPendingEvents: () => [],
    hasEncryptionStateEvent: () => s.encrypted === true,
    relations: {
      getChildEventsForEvent: (target: string) =>
        local.has(target) ? { getRelations: () => reactions, getSortedAnnotationsByKey: () => [] } : undefined,
    },
  })
  const rooms: Record<string, ReturnType<typeof mkRoom>> = { [CONV]: mkRoom(ROOM, 'join'), [CONV_LEFT]: mkRoom(LEFT, 'leave') }
  const people: Record<string, string> = { UALICE00000: ALICE, UME00000000: ME }
  const files = new Map<string, FileRef>()
  const resolver: Resolver = {
    roomAnyOf: (t) => {
      const r = rooms[t]
      if (r === undefined) throw new ReadError('conversation_not_found')
      return r as never
    },
    userOf: (t) => {
      const u = people[t]
      if (u === undefined) throw new ReadError('user_not_found')
      return u
    },
    eventOf: (_room, ts) => {
      if (!ts.startsWith('ts-')) return Promise.reject(new ReadError('message_not_found'))
      return Promise.resolve(ts.slice(3))
    },
    tsOf: (_r, eventId) => `ts-${eventId}`,
    tsOfRelated: (_r, eventId) => Promise.resolve(`ts-${eventId}`),
    tokenOfRoom: (roomId) => (roomId === ROOM ? CONV : CONV_LEFT),
    tokenOfPerson: (u) => Object.entries(people).find(([, v]) => v === u)?.[0] ?? 'U??????????',
    file: (t) => files.get(t),
    noteFile: (ref) => {
      files.set('FNEW0000000', ref)
      return 'FNEW0000000'
    },
  }
  const jobs: WriteJob[] = []
  const plan = [...(s.plan ?? [])]
  const uploads: Array<{ bytes: Uint8Array; opts: unknown }> = []
  const client = {
    getUserId: () => ME,
    fetchRoomEvent: vi.fn((_r: string, id: string) => {
      const raw = s.remote?.[id]
      return raw !== undefined ? Promise.resolve({ event_id: id, ...raw }) : Promise.reject(new Error('404'))
    }),
    decryptEventIfNeeded: () => Promise.resolve(),
    relations: vi.fn(() => Promise.resolve({ events: [] })),
    uploadContent: vi.fn((bytes: Uint8Array, opts: unknown) => {
      uploads.push({ bytes, opts })
      return Promise.resolve({ content_uri: 'mxc://test.local/up1' })
    }),
    getMediaConfig: vi.fn(s.mediaConfig ?? (() => Promise.resolve({ 'm.upload.size': 1024 }))),
    http: { authedRequest: vi.fn(s.download ?? (() => Promise.reject(new Error('no download')))) },
  } as unknown as WriteClient
  const logs: Array<Record<string, unknown>> = []
  let n = 0
  const revokes = { n: 0 }
  const facade = createWriteFacade({
    client,
    resolver,
    enqueue: (job) => {
      jobs.push(job)
      if (s.enqueue !== undefined) return s.enqueue(job)
      return Promise.resolve(plan.shift() ?? { ok: true, messageId: `$sent${++n}` })
    },
    onRevoked: () => {
      revokes.n += 1
    },
    log: (l) => logs.push(l),
  })
  return { facade, jobs, client, uploads, logs, files, local, revokes }
}

const ok = (id: string): SendResult => ({ ok: true, messageId: id })
const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p
    return 'resolved'
  } catch (err) {
    return (err as WriteError | ReadError).code
  }
}

describe('write facade: post (§0.3.7 items 1, 5, 6)', () => {
  it('raw ids to the queue; the answer is built from the request with the ts of the accepted event', async () => {
    const t = setup({ plan: [ok('$acc')], remote: { $acc: { origin_server_ts: 5_000 } } })
    const msg = await t.facade.post(CONV, { text: 'oi', mentions: ['UALICE00000'] })
    expect(t.jobs).toEqual([{ kind: 'text', req: { channel: ROOM, text: 'oi', mentions: [ALICE] } }])
    expect(msg).toEqual({ id: 'ts-$acc', conversation: CONV, author: 'UME00000000', text: 'oi', mentionsMe: false, mentions: ['UALICE00000'], reactions: [] })
  })

  it('the ts comes from the local timeline when the remote echo is there (no /event)', async () => {
    const t = setup({ events: [{ id: '$acc', sender: ME, ts: 7_000 }], plan: [ok('$acc')] })
    expect((await t.facade.post(CONV, { text: 'oi' })).id).toBe('ts-$acc')
    expect(t.client.fetchRoomEvent).not.toHaveBeenCalled()
  })

  it('a thread named by one of its replies is promoted to the root; replyTo resolves to its event', async () => {
    const t = setup({
      events: [
        { id: '$root', sender: ALICE },
        { id: '$reply', sender: ALICE, wire: { 'm.relates_to': { rel_type: 'm.thread', event_id: '$root' } } },
      ],
      remote: { $sent1: { origin_server_ts: 1 }, $sent2: { origin_server_ts: 2 } },
    })
    const inThread = await t.facade.post(CONV, { text: 'a', thread: 'ts-$reply' })
    expect(t.jobs[0]).toEqual({ kind: 'text', req: { channel: ROOM, text: 'a', thread: '$root' } })
    expect(inThread.thread).toBe('ts-$root')
    await t.facade.post(CONV, { text: 'b', replyTo: 'ts-$root' })
    expect(t.jobs[1]).toEqual({ kind: 'text', req: { channel: ROOM, text: 'b', replyTo: '$root' } })
  })

  it('refusals before the queue: thread + replyTo, repeated or too many mentions, unknown person, unknown or redacted target, not joined', async () => {
    const t = setup({ events: [{ id: '$gone', sender: ALICE, redacted: true }] })
    expect(await code(t.facade.post(CONV, { text: 'x', thread: 'ts-$a', replyTo: 'ts-$b' }))).toBe('invalid_argument')
    expect(await code(t.facade.post(CONV, { text: 'x', mentions: ['UALICE00000', 'UALICE00000'] }))).toBe('invalid_argument')
    expect(await code(t.facade.post(CONV, { text: 'x', mentions: Array.from({ length: 101 }, (_, i) => `U${i}`) }))).toBe('invalid_argument')
    expect(await code(t.facade.post(CONV, { text: 'x', mentions: ['UNOBODY0000'] }))).toBe('user_not_found')
    expect(await code(t.facade.post(CONV, { text: 'x', replyTo: 'nope' }))).toBe('message_not_found')
    expect(await code(t.facade.post(CONV, { text: 'x', replyTo: 'ts-$gone' }))).toBe('message_not_found')
    expect(await code(t.facade.post(CONV_LEFT, { text: 'x' }))).toBe('not_member')
    expect(await code(t.facade.post('CZZZZZZZZZZ', { text: 'x' }))).toBe('conversation_not_found')
    expect(t.jobs).toEqual([])
  })

  it('queue failures map to the API errors; `failed` logs errcode/status only', async () => {
    const t = setup({
      plan: [
        { ok: false, error: { kind: 'rate-limited', retryAfterMs: 1234 } },
        { ok: false, error: { kind: 'revoked' } },
        { ok: false, error: { kind: 'stopped' } },
        { ok: false, error: { kind: 'failed', errcode: 'M_FORBIDDEN', status: 403 } },
      ],
    })
    const limited = await t.facade.post(CONV, { text: 'x' }).catch((e: unknown) => e as WriteError)
    expect(limited).toMatchObject({ code: 'rate_limited', retryAfterMs: 1234 })
    expect(await code(t.facade.post(CONV, { text: 'x' }))).toBe('revoked')
    expect(await code(t.facade.post(CONV, { text: 'secret' }))).toBe('unavailable')
    expect(await code(t.facade.post(CONV, { text: 'secret' }))).toBe('upstream_failed')
    expect(t.logs).toEqual([{ evt: 'write-failed', op: 'post', errcode: 'M_FORBIDDEN', status: 403 }])
    expect(writeErrorOf({ kind: 'not-member' }, () => {}, 'x').code).toBe('not_member')
    expect(writeErrorOf({ kind: 'reply-in-thread' }, () => {}, 'x').code).toBe('invalid_argument')
  })
})

describe('write facade: edit and removal — only the agent’s own (§0.3.7 items 2, 3)', () => {
  const events: Ev[] = [
    { id: '$mine', sender: ME },
    { id: '$theirs', sender: ALICE },
    { id: '$file', sender: ME, content: { msgtype: 'm.file', body: 'a.pdf' } },
    { id: '$utd', sender: ME, utd: true },
    { id: '$gone', sender: ME, redacted: true },
    { id: '$inthread', sender: ME, wire: { msgtype: 'm.text', 'm.relates_to': { rel_type: 'm.thread', event_id: '$root' } } },
  ]

  it('edit of an own text → an edit job; the answer carries editedAt (the edit event’s instant) and the target ts', async () => {
    const t = setup({ events, plan: [ok('$edit')], remote: { $edit: { origin_server_ts: 9_000 } } })
    const msg = await t.facade.edit(CONV, 'ts-$mine', 'novo')
    expect(t.jobs).toEqual([{ kind: 'edit', channel: ROOM, target: '$mine', text: 'novo' }])
    expect(msg).toEqual({ id: 'ts-$mine', conversation: CONV, author: 'UME00000000', text: 'novo', mentionsMe: false, reactions: [], editedAt: 9_000 })
  })

  it('an edited thread reply keeps its thread', async () => {
    const t = setup({ events, plan: [ok('$edit')], remote: { $edit: { origin_server_ts: 9_000 } } })
    expect((await t.facade.edit(CONV, 'ts-$inthread', 'novo')).thread).toBe('ts-$root')
  })

  it('someone else’s → not_own_message; an attachment or unreadable → not_editable; redacted → message_not_found', async () => {
    const t = setup({ events })
    expect(await code(t.facade.edit(CONV, 'ts-$theirs', 'x'))).toBe('not_own_message')
    expect(await code(t.facade.remove(CONV, 'ts-$theirs'))).toBe('not_own_message')
    expect(await code(t.facade.edit(CONV, 'ts-$file', 'x'))).toBe('not_editable')
    expect(await code(t.facade.edit(CONV, 'ts-$utd', 'x'))).toBe('not_editable')
    expect(await code(t.facade.edit(CONV, 'ts-$gone', 'x'))).toBe('message_not_found')
    expect(await code(t.facade.remove(CONV, 'ts-$gone'))).toBe('message_not_found')
    expect(t.jobs).toEqual([])
  })

  it('a message outside the timeline is read from the server (sender checked there)', async () => {
    const t = setup()
    t.client.fetchRoomEvent = vi.fn(() => Promise.resolve({ event_id: '$old', type: 'm.room.message', sender: ALICE, content: { msgtype: 'm.text', body: 'x' } }))
    expect(await code(t.facade.remove(CONV, 'ts-$old'))).toBe('not_own_message')
    expect(t.client.fetchRoomEvent).toHaveBeenCalledWith(ROOM, '$old')
  })

  it('removal of an own message → a redact job', async () => {
    const t = setup({ events })
    await t.facade.remove(CONV, 'ts-$mine')
    expect(t.jobs).toEqual([{ kind: 'redact', channel: ROOM, target: '$mine' }])
  })
})

describe('write facade: idempotent reactions (§0.3.7 item 1)', () => {
  const events: Ev[] = [{ id: '$msg', sender: ALICE }]

  it('PUT of a reaction the agent already has sends nothing; a new one is a react job', async () => {
    const t = setup({ events, reactions: [{ id: '$r1', sender: ME, type: 'm.reaction', key: '👍' }] })
    expect(await t.facade.react(CONV, 'ts-$msg', '👍')).toBe(false)
    expect(t.jobs).toEqual([])
    expect(await t.facade.react(CONV, 'ts-$msg', '🎉')).toBe(true)
    expect(t.jobs).toEqual([{ kind: 'react', channel: ROOM, target: '$msg', key: '🎉' }])
  })

  it('someone else’s or a redacted own reaction does not count as the agent’s', async () => {
    const t = setup({
      events,
      reactions: [
        { id: '$r1', sender: ALICE, key: '👍' },
        { id: '$r2', sender: ME, key: '👍', redacted: true },
      ],
    })
    await t.facade.react(CONV, 'ts-$msg', '👍')
    expect(t.jobs).toHaveLength(1)
  })

  it('the server already having it (M_DUPLICATE_ANNOTATION) is success', async () => {
    const t = setup({ events, plan: [{ ok: false, error: { kind: 'failed', errcode: 'M_DUPLICATE_ANNOTATION', status: 400 } }] })
    await expect(t.facade.react(CONV, 'ts-$msg', '👍')).resolves.toBe(false)
  })

  it('DELETE without the reaction sends nothing; with it → the redaction of that reaction', async () => {
    const t = setup({ events, reactions: [{ id: '$r1', sender: ME, key: '👍' }] })
    expect(await t.facade.unreact(CONV, 'ts-$msg', '🎉')).toBe(false)
    expect(t.jobs).toEqual([])
    expect(await t.facade.unreact(CONV, 'ts-$msg', '👍')).toBe(true)
    expect(t.jobs).toEqual([{ kind: 'unreact', channel: ROOM, reaction: '$r1' }])
  })

  it('a message outside the loaded timeline asks the server’s relations', async () => {
    const t = setup({ remote: { $old: { origin_server_ts: 1 } } })
    // The raw fetch yields an event of type m.room.message only if the raw carries it; give it one.
    t.client.fetchRoomEvent = vi.fn(() => Promise.resolve({ event_id: '$old', type: 'm.room.message', sender: ALICE, content: { msgtype: 'm.text', body: 'x' } }))
    await t.facade.react(CONV, 'ts-$old', '👍')
    expect(t.client.relations).toHaveBeenCalledWith(ROOM, '$old', 'm.annotation', 'm.reaction', { limit: 100 })
    expect(t.jobs).toHaveLength(1)
  })
})

describe('write facade: upload (§0.3.7 item 7)', () => {
  it('limit = min(m.upload.size, 100 MiB), read once; a failed read → 100 MiB', async () => {
    const t = setup({ mediaConfig: () => Promise.resolve({ 'm.upload.size': 500 * 1024 * 1024 }) })
    expect(await t.facade.uploadLimit()).toBe(UPLOAD_CEILING)
    expect(await t.facade.uploadLimit()).toBe(UPLOAD_CEILING)
    expect(t.client.getMediaConfig).toHaveBeenCalledOnce()
    expect(await setup().facade.uploadLimit()).toBe(1024)
    expect(await setup({ mediaConfig: () => Promise.reject(new Error('x')) }).facade.uploadLimit()).toBe(UPLOAD_CEILING)
  })

  it('a clear room uploads with the name and type, then an attachment job; the file is registered with its name', async () => {
    const t = setup({ plan: [ok('$file')], remote: { $file: { origin_server_ts: 3 } } })
    const msg = await t.facade.upload(CONV, { name: 'nota.txt', mimetype: 'text/plain', body: () => Promise.resolve(new Uint8Array([1, 2, 3])) })
    expect(t.uploads[0]!.opts).toEqual({ name: 'nota.txt', type: 'text/plain' })
    expect(t.jobs[0]).toMatchObject({ kind: 'attachment', channel: ROOM, content: { msgtype: 'm.file', body: 'nota.txt', url: 'mxc://test.local/up1', info: { mimetype: 'text/plain', size: 3 } } })
    expect(msg).toEqual({
      id: 'ts-$file',
      conversation: CONV,
      author: 'UME00000000',
      text: '',
      mentionsMe: false,
      reactions: [],
      files: [{ id: 'FNEW0000000', name: 'nota.txt', mimetype: 'text/plain', size: 3 }],
    })
    expect(t.files.get('FNEW0000000')).toEqual({ uri: 'mxc://test.local/up1', mimetype: 'text/plain', name: 'nota.txt' })
  })

  it('an encrypted room uploads the CIPHERTEXT, nameless and opaque; the event carries `file`', async () => {
    const t = setup({ encrypted: true, plan: [ok('$file')], remote: { $file: { origin_server_ts: 3 } } })
    const bytes = new Uint8Array([7, 7, 7, 7])
    await t.facade.upload(CONV, { name: 'x.png', mimetype: 'image/png', body: () => Promise.resolve(bytes) })
    expect(t.uploads[0]!.opts).toEqual({ includeFilename: false, type: 'application/octet-stream' })
    expect(Buffer.from(t.uploads[0]!.bytes).equals(Buffer.from(bytes))).toBe(false)
    const content = (t.jobs[0] as { content: Record<string, unknown> }).content
    expect(content).toMatchObject({ msgtype: 'm.image', body: 'x.png', file: { url: 'mxc://test.local/up1', v: 'v2' } })
    expect(content.url).toBeUndefined()
  })

  it('the slot covers the body read: a 2nd upload does not read its body until the 1st bytes are up; released before the enqueue', async () => {
    const order: string[] = []
    let releaseBody1!: (b: Uint8Array) => void
    // The 1st message never leaves the queue (a long 429, say): it must not hold the slot.
    const t = setup({ enqueue: () => new Promise<SendResult>(() => {}) })
    void t.facade.upload(CONV, {
      name: 'a.bin',
      mimetype: 'x/y',
      body: () => {
        order.push('body1')
        return new Promise((r) => (releaseBody1 = r))
      },
    })
    void t.facade.upload(CONV, {
      name: 'b.bin',
      mimetype: 'x/y',
      body: () => {
        order.push('body2')
        return Promise.resolve(new Uint8Array([2]))
      },
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(order).toEqual(['body1'])
    releaseBody1(new Uint8Array([1]))
    await vi.waitFor(() => expect(t.uploads).toHaveLength(2))
    expect(order).toEqual(['body1', 'body2'])
    // Both enqueued; the 1st is still in the queue while the 2nd went through the slot.
    expect(t.jobs).toHaveLength(2)
  })

  it('a refusal of the body read (over the limit) propagates as it is and frees the slot', async () => {
    const t = setup({ plan: [ok('$f')], remote: { $f: { origin_server_ts: 1 } } })
    const refusal = Object.assign(new Error('too large'), { code: 'file_too_large' })
    await expect(t.facade.upload(CONV, { name: 'a', mimetype: 'x/y', body: () => Promise.reject(refusal) })).rejects.toBe(refusal)
    expect((await t.facade.upload(CONV, { name: 'b', mimetype: 'x/y', body: () => Promise.resolve(new Uint8Array([1])) })).files?.[0]?.size).toBe(1)
  })

  it('too large → file_too_large; a bad name → invalid_argument; nothing uploaded', async () => {
    const t = setup()
    expect(await code(t.facade.upload(CONV, { name: 'a', mimetype: 'x/y', body: () => Promise.resolve(new Uint8Array(1025)) }))).toBe('file_too_large')
    for (const name of ['', 'a/b', 'x'.repeat(256)]) {
      expect(await code(t.facade.upload(CONV, { name, mimetype: 'x/y', body: () => Promise.resolve(new Uint8Array(1)) }))).toBe('invalid_argument')
    }
    expect(t.uploads).toEqual([])
  })
})

describe('write facade: download (§0.3.7 item 8)', () => {
  it('unknown or malformed token → file_not_found', async () => {
    const t = setup()
    expect(await code(t.facade.download('FAAAAAAAAAA'))).toBe('file_not_found')
    expect(await code(t.facade.download('../etc'))).toBe('file_not_found')
  })

  it('encrypted: the hash is checked, the bytes decrypted; a tampered ciphertext → upstream_failed', async () => {
    const plain = new Uint8Array([10, 20, 30, 40])
    const { ciphertext, info } = await encryptAttachment(plain)
    let served = ciphertext
    const t = setup({ download: () => Promise.resolve(new Blob([served])) })
    t.files.set('FENCAAAAAAA', { uri: 'mxc://test.local/enc', encrypted: { ...info, url: 'mxc://test.local/enc' }, mimetype: 'image/png', name: 'p.png' })
    const got = await t.facade.download('FENCAAAAAAA')
    expect([...got.bytes]).toEqual([...plain])
    expect(got).toMatchObject({ mimetype: 'image/png', name: 'p.png' })
    expect(t.client.http.authedRequest).toHaveBeenCalledWith('GET', '/media/download/test.local/enc', { allow_redirect: 'true' }, undefined, expect.objectContaining({ rawResponseBody: true }))
    served = ciphertext.slice()
    served[0] = served[0]! ^ 0xff
    expect(await code(t.facade.download('FENCAAAAAAA'))).toBe('upstream_failed')
    expect(t.logs).toContainEqual({ evt: 'download-integrity-failed' })
  })

  it('the server’s 404 → file_not_found; another failure → upstream_failed', async () => {
    const t404 = setup({ download: () => Promise.reject(Object.assign(new Error('x'), { errcode: 'M_NOT_FOUND', httpStatus: 404 })) })
    t404.files.set('FCLRAAAAAAA', { uri: 'mxc://test.local/c' })
    expect(await code(t404.facade.download('FCLRAAAAAAA'))).toBe('file_not_found')
    const t500 = setup({ download: () => Promise.reject(Object.assign(new Error('x'), { httpStatus: 500 })) })
    t500.files.set('FCLRAAAAAAA', { uri: 'mxc://test.local/c' })
    expect(await code(t500.facade.download('FCLRAAAAAAA'))).toBe('upstream_failed')
  })
})

describe('write facade: M_UNKNOWN_TOKEN outside the queue revokes the core (ADR-087 dec. 8)', () => {
  const unknownToken = (): Error => Object.assign(new Error('x'), { errcode: 'M_UNKNOWN_TOKEN', httpStatus: 401 })

  it('upload → onRevoked, then revoked; nothing enqueued', async () => {
    const t = setup()
    t.client.uploadContent = vi.fn(() => Promise.reject(unknownToken()))
    expect(await code(t.facade.upload(CONV, { name: 'a', mimetype: 'x/y', body: () => Promise.resolve(new Uint8Array([1])) }))).toBe('revoked')
    expect(t.revokes.n).toBe(1)
    expect(t.jobs).toEqual([])
  })

  it('download → onRevoked, then revoked; another failure does not revoke', async () => {
    const t = setup({ download: () => Promise.reject(unknownToken()) })
    t.files.set('FCLRAAAAAAA', { uri: 'mxc://test.local/c' })
    expect(await code(t.facade.download('FCLRAAAAAAA'))).toBe('revoked')
    expect(t.revokes.n).toBe(1)
    const other = setup({ download: () => Promise.reject(Object.assign(new Error('x'), { httpStatus: 500 })) })
    other.files.set('FCLRAAAAAAA', { uri: 'mxc://test.local/c' })
    expect(await code(other.facade.download('FCLRAAAAAAA'))).toBe('upstream_failed')
    expect(other.revokes.n).toBe(0)
  })
})
