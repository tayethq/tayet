import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WriteError } from '../../src/core/write'
import { MULTIPART_OVERHEAD, UPLOAD_TTL_MS, UploadStaging } from '../../src/api/slack/staging'
import { boundaryOf, parseFilePart } from '../../src/api/slack/multipart'
import { mimetypeOf } from '../../src/api/slack/files'
import { GENERAL, ME, TOKEN, call, createWorld, idLeaks, refusal, refusalData, startSlack, type SlackHarness } from '../support/slack-world'

// The upload v2 flow (PLANO-AGENTES §0.3.12 item 6) through the real @slack/web-api filesUploadV2: the
// local upload_url, the hand-written multipart parser, the staging (TTL, single-use tickets), and
// files.completeUploadExternal over the core's upload(). files.upload (v1) → method_deprecated.

let h: SlackHarness
let dir: string
// The upload limit of the fake world (1 MiB): the over-the-limit bodies run beside the process tests.
const LIMIT = 1024 * 1024
const start = (): Promise<SlackHarness> => {
  const world = createWorld()
  world.write.uploadLimit = () => Promise.resolve(LIMIT)
  return startSlack({ uploadsDir: dir, world })
}
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'slack-uploads-'))
  h = await start()
})
afterEach(async () => {
  await h.close()
  await rm(dir, { recursive: true, force: true })
})

const ROOT = '1730000100.000100'
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a5c50000000049454e44ae426082', 'hex')
const effects = () => h.world.calls.filter((c) => c.op === 'post' || c.op === 'upload')
const staged = async (): Promise<string[]> => readdir(dir).catch(() => [])

async function ticket(filename = 'a.txt', length = 5): Promise<{ upload_url: string; file_id: string }> {
  const res = await call(h.client(), 'files.getUploadURLExternal', { filename, length })
  expect(idLeaks(res)).toEqual([])
  return res as unknown as { upload_url: string; file_id: string }
}

// One multipart body by hand (what the WebClient sends: a `body` field with a filename).
function multipart(parts: Array<{ name: string; filename?: string; data: string | Buffer }>, boundary = 'XyZbOuNdArY'): { body: Buffer; type: string } {
  const chunks: Buffer[] = []
  for (const p of parts) {
    const disp = `form-data; name="${p.name}"${p.filename !== undefined ? `; filename="${p.filename}"` : ''}`
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: ${disp}\r\nContent-Type: application/octet-stream\r\n\r\n`), Buffer.from(p.data), Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return { body: Buffer.concat(chunks), type: `multipart/form-data; boundary=${boundary}` }
}

async function post(url: string, body: Buffer, type: string | undefined, token = TOKEN): Promise<{ status: number; text: string }> {
  try {
    const res = await fetch(url, { method: 'POST', body, headers: { authorization: `Bearer ${token}`, ...(type !== undefined && { 'content-type': type }) } })
    return { status: res.status, text: await res.text() }
  } catch {
    // The server may close the connection right after a refusal of a body it did not read.
    return { status: 0, text: 'closed' }
  }
}

describe('filesUploadV2 end to end (the real WebClient)', () => {
  it('one PNG with initial_comment in a thread: the comment first (mrkdwn → rich), then the file; the definitive F…', async () => {
    const res = await h.client().filesUploadV2({ channel_id: GENERAL.id, thread_ts: ROOT, initial_comment: 'o *relatório*', file: PNG, filename: 'grafico.png', title: 'Gráfico' })
    expect(idLeaks(res)).toEqual([])
    expect(effects()).toEqual([
      expect.objectContaining({ op: 'post', conversation: GENERAL.id, text: 'o relatório', thread: ROOT, rich: [{ t: 'p', children: [{ t: 'text', text: 'o ' }, { t: 'strong', children: [{ t: 'text', text: 'relatório' }] }] }] }),
      expect.objectContaining({ op: 'upload', conversation: GENERAL.id, name: 'grafico.png', mimetype: 'image/png', size: PNG.length, thread: ROOT }),
    ])
    expect((effects()[1] as unknown as { bytes: Uint8Array }).bytes).toEqual(new Uint8Array(PNG))
    const files = (res as unknown as { files: Array<{ files: unknown[] }> }).files[0]?.files
    expect(files).toEqual([{ id: expect.stringMatching(/^FUPLOADAAA[A-Z2-7]$/) as unknown, name: 'grafico.png', title: 'Gráfico', mimetype: 'image/png', size: PNG.length }])
    // The staging is gone after the send.
    expect(await staged()).toEqual([])
  })

  it('two files in one completion, no comment: two uploads, in order, title defaulting to the filename', async () => {
    const res = await h.client().filesUploadV2({
      channel_id: GENERAL.id,
      file_uploads: [
        { file: Buffer.from('primeiro'), filename: 'um.txt' },
        { file: Buffer.from('segundo!'), filename: 'dois.csv' },
      ],
    })
    expect(effects().map((c) => [c.op, c.name, c.mimetype])).toEqual([
      ['upload', 'um.txt', 'text/plain'],
      ['upload', 'dois.csv', 'text/csv'],
    ])
    const files = (res as unknown as { files: Array<{ files: Array<Record<string, unknown>> }> }).files[0]?.files
    expect(files?.map((f) => [f.name, f.title, f.size])).toEqual([
      ['um.txt', 'um.txt', 8],
      ['dois.csv', 'dois.csv', 8],
    ])
    expect(await staged()).toEqual([])
  })

  it('two files with initial_comment: one comment, then both files', async () => {
    await h.client().filesUploadV2({
      channel_id: GENERAL.id,
      initial_comment: 'segue',
      file_uploads: [
        { file: Buffer.from('a'), filename: 'a.txt' },
        { file: Buffer.from('b'), filename: 'b.txt' },
      ],
    })
    expect(effects().map((c) => c.op)).toEqual(['post', 'upload', 'upload'])
  })
})

describe('files.getUploadURLExternal', () => {
  it('an absolute upload_url on the listener with a single-use ticket, and a provisional F…', async () => {
    const t = await ticket()
    expect(t.upload_url).toMatch(new RegExp(`^${h.url}/slack/upload/[A-Za-z0-9_-]{43}$`))
    expect(t.file_id).toMatch(/^F[A-Z2-7]{10}$/)
  })

  it('a length over the upload limit → file_too_large; no filename / no length / a path → invalid_arguments', async () => {
    expect(await refusal(h.client(), 'files.getUploadURLExternal', { filename: 'big.bin', length: LIMIT + 1 })).toBe('file_too_large')
    expect(await refusal(h.client(), 'files.getUploadURLExternal', { length: 3 })).toBe('invalid_arguments')
    expect(await refusal(h.client(), 'files.getUploadURLExternal', { filename: 'a.txt' })).toBe('invalid_arguments')
    expect(await refusal(h.client(), 'files.getUploadURLExternal', { filename: 'x/../a.txt', length: 3 })).toBe('invalid_arguments')
  })
})

describe('the upload route (POST /slack/upload/<ticket>)', () => {
  it('Bearer first: no token → 401, wrong token → 401, and neither spends the ticket', async () => {
    const t = await ticket()
    const { body, type } = multipart([{ name: 'body', filename: 'a.txt', data: 'hello' }])
    expect((await fetch(t.upload_url, { method: 'POST', body, headers: { 'content-type': type } })).status).toBe(401)
    expect((await post(t.upload_url, body, type, 'wrong')).status).toBe(401)
    expect(await post(t.upload_url, body, type)).toEqual({ status: 200, text: 'OK - 5' })
  })

  it('a reused ticket → 404 file_not_found', async () => {
    const t = await ticket()
    const { body, type } = multipart([{ name: 'body', filename: 'a.txt', data: 'hello' }])
    expect((await post(t.upload_url, body, type)).status).toBe(200)
    const again = await post(t.upload_url, body, type)
    expect(again.status === 404 || again.status === 0).toBe(true)
    if (again.status === 404) expect(JSON.parse(again.text)).toEqual({ ok: false, error: 'file_not_found' })
    expect((await post(`${h.url}/slack/upload/unknown`, body, type)).status === 404).toBe(true)
  })

  it('two file fields → 400; no boundary → 400; malformed framing → 400 (the ticket is spent)', async () => {
    const two = multipart([
      { name: 'body', filename: 'a.txt', data: 'hel' },
      { name: 'other', filename: 'b.txt', data: 'lo' },
    ])
    expect((await post((await ticket()).upload_url, two.body, two.type)).status).toBe(400)
    const one = multipart([{ name: 'body', filename: 'a.txt', data: 'hello' }])
    expect((await post((await ticket()).upload_url, one.body, 'multipart/form-data')).status).toBe(400)
    expect((await post((await ticket()).upload_url, one.body, undefined)).status).toBe(400)
    expect((await post((await ticket()).upload_url, Buffer.from('--XyZbOuNdArY\r\nno headers here'), one.type)).status).toBe(400)
    const t = await ticket()
    expect((await post(t.upload_url, Buffer.from('nothing multipart'), one.type)).status).toBe(400)
    const retry = await post(t.upload_url, one.body, one.type)
    expect(retry.status === 404 || retry.status === 0).toBe(true)
    expect(await staged()).toEqual([])
  })

  it('a body over the declared length → 413; over the upload limit → 413 (or the connection closes)', async () => {
    const t = await ticket('a.txt', 3)
    const { body, type } = multipart([{ name: 'body', filename: 'a.txt', data: 'hello' }])
    expect((await post(t.upload_url, body, type)).status).toBe(413)
    // Declared at the limit, sent far over it: cut at the limit + framing, before the whole body is read.
    const big = await ticket('big.bin', LIMIT)
    const over = multipart([{ name: 'body', filename: 'big.bin', data: Buffer.alloc(LIMIT + MULTIPART_OVERHEAD + 1) }])
    expect([413, 0]).toContain((await post(big.upload_url, over.body, over.type)).status)
    expect(await staged()).toEqual([])
  })

  it('a completion naming a provisional id that was never uploaded → file_not_found, nothing sent', async () => {
    const t = await ticket()
    expect(await refusal(h.client(), 'files.completeUploadExternal', { files: JSON.stringify([{ id: t.file_id }]), channel_id: GENERAL.id })).toBe('file_not_found')
    expect(await refusal(h.client(), 'files.completeUploadExternal', { files: JSON.stringify([{ id: 'FNOTSTAGEDA' }]), channel_id: GENERAL.id })).toBe('file_not_found')
    expect(effects()).toEqual([])
  })
})

describe('files.completeUploadExternal — partial failure', () => {
  it('stops at the first failure, answers its code, keeps what went out, and drops every staged file', async () => {
    const ids: string[] = []
    for (const name of ['a.txt', 'b.txt']) {
      const t = await ticket(name, 1)
      const { body, type } = multipart([{ name: 'body', filename: name, data: 'x' }])
      expect((await post(t.upload_url, body, type)).status).toBe(200)
      ids.push(t.file_id)
    }
    expect((await staged()).length).toBe(2)
    // The comment and the first file go out; the second upload is refused upstream.
    const original = h.world.write.upload.bind(h.world.write)
    let n = 0
    h.world.write.upload = (c, r) => (++n === 2 ? Promise.reject(new WriteError('upstream_failed')) : original(c, r))
    const files = JSON.stringify(ids.map((id) => ({ id })))
    expect(await refusal(h.client(), 'files.completeUploadExternal', { files, channel_id: GENERAL.id, initial_comment: 'dois' })).toBe('internal_error')
    expect(effects().map((c) => c.op)).toEqual(['post', 'upload'])
    expect(h.logs).toContainEqual({ evt: 'slack-upload-partial', sent: 2, total: 3 })
    expect(await staged()).toEqual([])
    // Consumed: the same ids again → file_not_found.
    expect(await refusal(h.client(), 'files.completeUploadExternal', { files, channel_id: GENERAL.id })).toBe('file_not_found')
  })

  it('an unknown thread → thread_not_found before any effect; the staging is dropped', async () => {
    const t = await ticket('a.txt', 1)
    const { body, type } = multipart([{ name: 'body', filename: 'a.txt', data: 'x' }])
    await post(t.upload_url, body, type)
    expect(await refusal(h.client(), 'files.completeUploadExternal', { files: JSON.stringify([{ id: t.file_id }]), channel_id: GENERAL.id, thread_ts: '1730009999.000999' })).toBe('thread_not_found')
    expect(effects()).toEqual([])
    expect(await staged()).toEqual([])
  })

  it('an id shape in the comment or the filename → invalid_arguments before any effect', async () => {
    const t = await ticket('a.txt', 1)
    const { body, type } = multipart([{ name: 'body', filename: 'a.txt', data: 'x' }])
    await post(t.upload_url, body, type)
    expect(await refusal(h.client(), 'files.completeUploadExternal', { files: JSON.stringify([{ id: t.file_id }]), channel_id: GENERAL.id, initial_comment: 'fale com @bob:server.example' })).toBe('invalid_arguments')
    const named = await ticket('@bob:server.example.txt', 1)
    await post(named.upload_url, body, type)
    const data = await refusalData(h.client(), 'files.completeUploadExternal', { files: JSON.stringify([{ id: named.file_id }]), channel_id: GENERAL.id })
    // The title defaults to the filename: two findings, two lines.
    expect(data).toEqual({
      ok: false,
      error: 'invalid_arguments',
      response_metadata: { messages: ['[ERROR] content looks like an internal id: user_id', '[ERROR] content looks like an internal id: user_id'] },
    })
    expect(JSON.stringify(data)).not.toContain('@bob')
    expect(h.logs.filter((l) => l.evt === 'leak-blocked' && l.where === 'slack files.completeUploadExternal').map((l) => l.path)).toContain('$.files[0].name')
    expect(effects()).toEqual([])
  })

  it('ordinary prose in a filename is content, not structure (the top-level files of the answer)', async () => {
    await h.client().filesUploadV2({ channel_id: GENERAL.id, file: Buffer.from('ok'), filename: 'verificacao-do-cofre.txt' })
    expect(effects().map((c) => c.name)).toEqual(['verificacao-do-cofre.txt'])
  })
})

describe('files.upload (v1)', () => {
  it('→ method_deprecated, multipart body and all, and a form call', async () => {
    // A Buffer argument makes the WebClient send multipart, as the v1 helper of older SDKs did.
    expect(await refusal(h.client(), 'files.upload', { channels: GENERAL.id, file: Buffer.from('x'), filename: 'a.txt' })).toBe('method_deprecated')
    expect(await refusal(h.client(), 'files.upload', { channels: GENERAL.id, content: 'x' })).toBe('method_deprecated')
    expect(effects()).toEqual([])
  })
})

describe('the staging (relógio injetado)', () => {
  // The tests that build their own UploadStaging take a directory of their own: the harness's staging (the
  // server of the beforeEach) owns `dir`, and its boot sweep, which nobody awaits, may still be running —
  // under load it can read the file these tests wrote and delete it, logging to the harness (issue #7).
  let own: string
  beforeEach(async () => {
    own = await mkdtemp(join(tmpdir(), 'slack-staging-'))
  })
  afterEach(async () => {
    await rm(own, { recursive: true, force: true })
  })

  it('a ticket expires after 10 min: the upload and the completion → file_not_found; the sweep deletes it', async () => {
    let now = 1_000_000
    const logs: Array<Record<string, unknown>> = []
    const s = new UploadStaging(own, () => now, (l) => logs.push(l))
    const { body, type } = multipart([{ name: 'body', filename: 'a.txt', data: 'abc' }])
    const boundary = boundaryOf(type) as string
    const late = s.issue('late.txt', 3)
    now += UPLOAD_TTL_MS
    expect(() => s.open(late.ticket)).toThrow('file_not_found')
    const done = s.issue('done.txt', 3)
    await s.store(s.open(done.ticket), body, boundary, 1024)
    expect(s.take([done.id])).toHaveLength(1)
    expect(await readdir(own)).toEqual([done.ticket])
    now += UPLOAD_TTL_MS - 1
    expect(s.take([done.id])).toHaveLength(1)
    now += 1
    expect(() => s.take([done.id])).toThrow('file_not_found')
    s.sweep()
    await new Promise((r) => setTimeout(r, 20))
    expect(await readdir(own)).toEqual([])
  })

  it('the boot sweep empties what an earlier run left; clear() empties it on a clean shutdown', async () => {
    const now = () => 1
    const first = new UploadStaging(own, now, () => {})
    const { body, type } = multipart([{ name: 'body', filename: 'a.txt', data: 'abc' }])
    const t = first.issue('a.txt', 3)
    await first.store(first.open(t.ticket), body, boundaryOf(type) as string, 1024)
    expect(await readdir(own)).toHaveLength(1)
    const logs: Array<Record<string, unknown>> = []
    const second = new UploadStaging(own, now, (l) => logs.push(l))
    await second.clear()
    expect(await readdir(own)).toEqual([])
    expect(logs).toContainEqual({ evt: 'upload-staging-swept', when: 'boot', files: 1 })
  })

  it('the server’s close() empties the staging', async () => {
    const t = await ticket('a.txt', 1)
    const { body, type } = multipart([{ name: 'body', filename: 'a.txt', data: 'x' }])
    await post(t.upload_url, body, type)
    expect((await staged()).length).toBe(1)
    await h.api.close()
    expect(await staged()).toEqual([])
    h = await start()
  })
})

describe('multipart parser and mimetype', () => {
  it('boundary: only multipart/form-data with one; quoted boundaries', () => {
    expect(boundaryOf('multipart/form-data; boundary=abc')).toBe('abc')
    expect(boundaryOf('multipart/form-data; boundary="a b"')).toBe('a b')
    expect(boundaryOf('multipart/form-data')).toBeUndefined()
    expect(boundaryOf('application/json; boundary=abc')).toBeUndefined()
    expect(boundaryOf(undefined)).toBeUndefined()
  })

  it('one file field among plain fields; binary bytes kept as they are', () => {
    const bytes = Buffer.from([0, 13, 10, 45, 45, 255])
    const { body } = multipart([
      { name: 'note', data: 'plain' },
      { name: 'body', filename: 'b.bin', data: bytes },
    ])
    expect(parseFilePart(body, 'XyZbOuNdArY')).toMatchObject({ filename: 'b.bin', data: bytes })
  })

  it('no file field, no closing delimiter → invalid_arguments', () => {
    expect(() => parseFilePart(multipart([{ name: 'note', data: 'plain' }]).body, 'XyZbOuNdArY')).toThrow('invalid_arguments')
    const cut = multipart([{ name: 'body', filename: 'a', data: 'x' }]).body
    expect(() => parseFilePart(cut.subarray(0, cut.length - 20), 'XyZbOuNdArY')).toThrow('invalid_arguments')
  })

  it('mimetype by extension, then the part’s own type', () => {
    expect(mimetypeOf('a.PNG', undefined)).toBe('image/png')
    expect(mimetypeOf('a', 'image/heic')).toBe('image/heic')
    expect(mimetypeOf('a', 'application/octet-stream')).toBe('application/octet-stream')
    expect(mimetypeOf('a.weird', 'not a type')).toBe('application/octet-stream')
  })
})

describe('leak-scan over every answer of the flow', () => {
  it('the getUploadURL, upload and completion answers carry tokens only', async () => {
    const res = await h.client().filesUploadV2({ channel_id: GENERAL.id, initial_comment: `para <@${ME.id}>`, file: PNG, filename: 'p.png' })
    expect(idLeaks(res)).toEqual([])
    expect(h.logs.filter((l) => l.evt === 'leak-blocked')).toEqual([])
  })
})
