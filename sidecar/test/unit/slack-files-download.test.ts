import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { App, LogLevel } from '@slack/bolt'
import { WriteError } from '../../src/core/write'
import { GENERAL, TOKEN, call, idLeaks, message, refusal, startSlack, type SlackHarness } from '../support/slack-world'

// files.info and the url_private download (S-f3; ADR-087 dec. 6, §0.3.12 item 7) through the real
// @slack/web-api 8.3.0 and a fetch with Bearer, as the README shows; the files[] of a read and of a
// `message` event carry the same URLs.

let h: SlackHarness
let app: App | undefined
beforeEach(async () => {
  h = await startSlack()
  h.world.files.set(PNG_ID, { name: 'gráfico (final).png', mimetype: 'image/png', bytes: PNG })
})
afterEach(async () => {
  await app?.stop().catch(() => {})
  app = undefined
  await h.close()
})

const PNG_ID = 'FPNGAAAAAAA'
const PNG = new Uint8Array(Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a5c50000000049454e44ae426082', 'hex'))
const urlOf = (id: string): string => `${h.url}/slack/files/${id}`
const get = (id: string, headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` }, method = 'GET') => fetch(urlOf(id), { method, headers })

describe('files.info', () => {
  it('a known F… → the file with url_private / url_private_download, absolute, on the listener', async () => {
    const res = await call(h.client(), 'files.info', { file: PNG_ID })
    expect(idLeaks(res)).toEqual([])
    expect(res).toMatchObject({ ok: true, comments: [], response_metadata: { next_cursor: '' } })
    expect(res.file).toEqual({
      id: PNG_ID,
      name: 'gráfico (final).png',
      title: 'gráfico (final).png',
      mimetype: 'image/png',
      filetype: 'png',
      size: PNG.byteLength,
      url_private: urlOf(PNG_ID),
      url_private_download: urlOf(PNG_ID),
    })
    expect(new URL((res.file as { url_private: string }).url_private).href).toBe(urlOf(PNG_ID))
    const typed = await h.client().files.info({ file: PNG_ID })
    expect(typed.file?.url_private).toBe(urlOf(PNG_ID))
  })

  it('an unknown F… → file_not_found; no file → file_not_found', async () => {
    expect(await refusal(h.client(), 'files.info', { file: 'FNOTHEREAAA' })).toBe('file_not_found')
    expect(await refusal(h.client(), 'files.info', {})).toBe('file_not_found')
  })

  it('a filename with a protocol id is withheld (internal_error); ordinary prose is content, not structure', async () => {
    h.world.files.set('FLEAKAAAAAA', { name: '@bob:server.example.png', mimetype: 'image/png', bytes: PNG })
    expect(await refusal(h.client(), 'files.info', { file: 'FLEAKAAAAAA' })).toBe('internal_error')
    expect(h.logs).toContainEqual(expect.objectContaining({ evt: 'leak-blocked' }))
    h.world.files.set('FPROSEAAAAA', { name: 'verificacao-do-cofre.txt', mimetype: 'text/plain', bytes: new Uint8Array([1]) })
    expect(await call(h.client(), 'files.info', { file: 'FPROSEAAAAA' })).toMatchObject({ ok: true })
  })
})

describe('GET /slack/files/<F…> (url_private)', () => {
  it('with the Bearer: the same bytes and headers as the native GET /v1/files/:id', async () => {
    const res = await get(PNG_ID)
    expect(res.status).toBe(200)
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''gr%C3%A1fico%20%28final%29.png")
    expect(res.headers.get('cache-control')).toBe('no-store')
    const native = await fetch(`${h.url}/v1/files/${PNG_ID}`, { headers: { authorization: `Bearer ${TOKEN}` } })
    expect(native.status).toBe(200)
    expect(new Uint8Array(await native.arrayBuffer())).toEqual(PNG)
    for (const k of ['content-type', 'content-disposition', 'cache-control', 'content-length']) expect(res.headers.get(k)).toBe(native.headers.get(k))
  })

  it('no Bearer → 401 not_authed; a wrong one → 401 invalid_auth (Slack’s codes, a file host’s status)', async () => {
    const none = await get(PNG_ID, {})
    expect(none.status).toBe(401)
    expect(await none.json()).toEqual({ ok: false, error: 'not_authed' })
    const wrong = await get(PNG_ID, { authorization: 'Bearer tal_wrong' })
    expect(wrong.status).toBe(401)
    expect(await wrong.json()).toEqual({ ok: false, error: 'invalid_auth' })
  })

  it('an unknown F… → 404 file_not_found; a rate limit → 429 + Retry-After; POST → 405', async () => {
    const unknown = await get('FNOTHEREAAA')
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toEqual({ ok: false, error: 'file_not_found' })
    h.world.failNext.push(new WriteError('rate_limited', 2500))
    const limited = await get(PNG_ID)
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toBe('3')
    expect(await limited.json()).toEqual({ ok: false, error: 'ratelimited' })
    const post = await get(PNG_ID, { authorization: `Bearer ${TOKEN}` }, 'POST')
    expect(post.status).toBe(405)
  })

  it('Host and Origin are the native refusals, before the layer', async () => {
    const origin = await get(PNG_ID, { authorization: `Bearer ${TOKEN}`, origin: 'https://evil.example' })
    expect(origin.status).toBe(403)
  })

  it('revoked → 503 token_revoked, before the Bearer', async () => {
    await h.api.revoke(10, 0)
    const res = await get(PNG_ID, {})
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ ok: false, error: 'token_revoked' })
  })

  it('a filename with a protocol id never reaches the header → 500', async () => {
    h.world.files.set('FLEAKAAAAAA', { name: '@bob:server.example.png', mimetype: 'image/png', bytes: PNG })
    const res = await get('FLEAKAAAAAA')
    expect(res.status).toBe(500)
    expect(res.headers.get('content-disposition')).toBeNull()
  })
})

describe('files[] of a read and of an event carry the URLs', () => {
  it('conversations.history: url_private / url_private_download per file, downloadable', async () => {
    h.world.messages.set(GENERAL.id, [message({ id: '1731000500.000500', files: [{ id: PNG_ID, name: 'gráfico (final).png', mimetype: 'image/png', size: PNG.byteLength, width: 1, height: 1 }] })])
    const res = await call(h.client(), 'conversations.history', { channel: GENERAL.id })
    expect(idLeaks(res)).toEqual([])
    const file = (res.messages as Array<{ files: Array<Record<string, unknown>> }>)[0]?.files[0]
    expect(file).toMatchObject({ id: PNG_ID, original_w: 1, original_h: 1, url_private: urlOf(PNG_ID), url_private_download: urlOf(PNG_ID) })
    const bytes = await get(PNG_ID)
    expect(new Uint8Array(await bytes.arrayBuffer())).toEqual(PNG)
  })

  it('the `message` event over Socket Mode (Bolt): the same URLs', async () => {
    app = new App({ token: TOKEN, appToken: TOKEN, socketMode: true, clientOptions: { slackApiUrl: `${h.url}/slack/api/` }, logLevel: LogLevel.ERROR })
    const got: Array<Record<string, unknown>> = []
    app.event('message', ({ event }) => {
      got.push(event as unknown as Record<string, unknown>)
      return Promise.resolve()
    })
    await app.start()
    h.world.emit({ type: 'message.received', conversation: GENERAL.id, message: message({ id: '1731000600.000600', files: [{ id: PNG_ID, name: 'gráfico (final).png', mimetype: 'image/png', size: PNG.byteLength }] }) })
    await expect.poll(() => got.length).toBe(1)
    expect(idLeaks(got[0])).toEqual([])
    expect((got[0] as { files: unknown[] }).files[0]).toMatchObject({ id: PNG_ID, url_private: urlOf(PNG_ID), url_private_download: urlOf(PNG_ID) })
  })
})
