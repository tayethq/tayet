import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EncryptedFile } from '@tayet/shared/internal/attachment-crypto'
import { richFromContent } from '@tayet/shared/internal'
import type { RichDoc } from '@tayet/shared'
import { ESCROW_URL, HS_URL, mintOidcSession, stackUp, startWellKnown, until } from '../support/stack'
import { evt, startSidecar, type SidecarProcess } from '../support/sidecar-process'
import { startHuman, type Human } from '../support/human'
import { conversationToken, personToken } from '../../src/api/ids'
import type { ApiMessage, ApiMessageList } from '../../src/api/contract'

// S-c2 against the stack, through the local API of dist/cli.js (PLANO-AGENTES §0.3.7; replaces the
// S-b2 file, whose test-only core entry is gone): alice creates an agent (/v1/agents) and ONE encrypted
// room inviting it (the stack's createRoom limit is shared by every run of the day); the agent writes
// only through POST/PATCH/DELETE/PUT /v1/* and the person — an SDK with rust crypto in memory —
// decrypts. The S-b2 cases 1–5 over HTTP, then mention, thread promotion, edit, removal, reaction,
// files both ways, the owner rule. One `a-` account per run is left deactivated on the stack.

const STACK = stackUp()
const rand = (): string => Math.random().toString(36).slice(2, 8)
const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')
// ADR-086 dec. 8 / §8.3 item 7: poll with a 30 s ceiling (introspection cache < 1 s).
const REVOKE_CEILING_MS = 30_000
const BURST = 20

interface Frame {
  id?: string
  event?: string
  data?: Record<string, unknown>
}

// Minimal SSE reader (a copy of the S-c1 file's).
function openEvents(url: string, token: string) {
  const frames: Frame[] = []
  const ctrl = new AbortController()
  const done = (async () => {
    const res = await fetch(`${url}/v1/events`, { headers: { authorization: `Bearer ${token}` }, signal: ctrl.signal })
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
    let buf = ''
    for (;;) {
      const { value, done: end } = await reader.read()
      if (end) break
      buf += value
      let i
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const block = buf.slice(0, i)
        buf = buf.slice(i + 2)
        const f: Frame = {}
        for (const line of block.split('\n')) {
          if (line.startsWith('id: ')) f.id = line.slice(4)
          else if (line.startsWith('event: ')) f.event = line.slice(7)
          else if (line.startsWith('data: ')) f.data = JSON.parse(line.slice(6)) as Record<string, unknown>
        }
        if (f.event !== undefined) frames.push(f)
      }
    }
  })().catch(() => {})
  return { frames, done, close: () => ctrl.abort() }
}

describe.skipIf(!STACK)('sidecar S-c2 ↔ stack: local write API, files and mentions (§0.3.7)', () => {
  let alice: string
  let agent: { userId: string; token: string; deviceId: string } | undefined
  let removed = false
  let wellKnown: Awaited<ReturnType<typeof startWellKnown>>
  let store: string
  let person: Human
  let p: SidecarProcess | undefined
  let url = ''
  let local = ''
  let room = ''
  let conv = ''
  let stream: ReturnType<typeof openEvents> | undefined

  const escrow = (method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${ESCROW_URL}/v1/agents${path}`, {
      method,
      headers: { Authorization: `Bearer ${alice}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })

  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const raw = body instanceof Uint8Array ? body : body === undefined ? undefined : JSON.stringify(body)
    const res = await fetch(url + path, {
      method,
      headers: { authorization: `Bearer ${local}`, ...(typeof raw === 'string' && { 'content-type': 'application/json' }), ...headers },
      ...(raw !== undefined && { body: raw }),
    })
    const bytes = new Uint8Array(await res.arrayBuffer())
    const isJson = (res.headers.get('content-type') ?? '').startsWith('application/json')
    const json = (isJson && bytes.length > 0 ? JSON.parse(Buffer.from(bytes).toString('utf8')) : {}) as Record<string, unknown>
    return { status: res.status, headers: res.headers, bytes, json }
  }
  const errorCode = (r: { json: Record<string, unknown> }): unknown => (r.json.error as { code?: string } | undefined)?.code
  const messages = (): string => `/v1/conversations/${conv}/messages`
  // The ts of a person's message, as the agent sees it (SSE message.received, matched by text).
  const tsOfText = (text: string): Promise<string> =>
    until(
      () => (stream!.frames.find((f) => f.event === 'message.received' && (f.data?.message as { text?: string })?.text === text)?.data?.message as { id?: string } | undefined)?.id,
      60_000,
      'the message in the agent stream',
    )

  beforeAll(async () => {
    alice = (await mintOidcSession('alice', 'alicepass123')).accessToken
    const res = await escrow('POST', '', { name: `Sidecar Write ${rand()}` })
    expect(res.status).toBe(201)
    agent = (await res.json()) as NonNullable<typeof agent>
    person = await startHuman(alice)
    wellKnown = await startWellKnown(HS_URL)
    store = await mkdtemp(join(tmpdir(), 'sidecar-write-it-'))
    p = startSidecar(['--server', wellKnown.url, '--token', agent.token, '--store', store])
    const line = await p.waitFor(evt('api-listening'), 90_000)
    url = line.url as string
    local = (await readFile(join(store, 'local.token'), 'utf8')).trim()
    stream = openEvents(url, local)
  }, 180_000)

  afterAll(async () => {
    stream?.close()
    await p?.stop()
    person?.stop()
    if (agent !== undefined && !removed) await escrow('DELETE', `/${encodeURIComponent(agent.userId)}`)
    await wellKnown?.close()
    if (store !== undefined) await rm(store, { recursive: true, force: true })
  }, 60_000)

  it('1. alice invites the agent to an encrypted room → the agent joins; the conversation is readable', async () => {
    room = await person.createEncryptedRoom([agent!.userId])
    conv = conversationToken(room, false)
    await p!.waitFor((l) => l.evt === 'joined' && l.conversation === conv, 60_000)
    await person.waitForMembership(room, agent!.userId, 'join')
    await until(async () => ((await call('GET', `/v1/conversations/${conv}`)).status === 200 ? true : undefined), 30_000, 'the conversation')
  }, 120_000)

  it('2. POST text → the person decrypts it from the `a-` sender; the answer is the accepted ts', async () => {
    const text = `sidecar hello ${rand()}`
    const r = await call('POST', messages(), { text })
    expect(r.status).toBe(200)
    const msg = r.json as unknown as ApiMessage
    expect(msg).toMatchObject({ conversation: conv, author: personToken(agent!.userId), text, mentionsMe: false, reactions: [] })
    const got = await person.waitForMessage((m) => m.body === text)
    expect(got.wireType).toBe('m.room.encrypted')
    expect(got.sender).toBe(agent!.userId)
    expect(got.sender.slice(1).startsWith('a-')).toBe(true)
    // The ts is the server's instant of that very event.
    const page = await until(async () => {
      const l = (await call('GET', messages())).json as unknown as ApiMessageList
      return l.messages.find((m) => m.text === text)
    }, 30_000, 'the sent message in the listing')
    expect(page.id).toBe(msg.id)
  }, 120_000)

  it('3. mention + thread → the person sees m.mentions with her id and the thread; the read carries mentions', async () => {
    const rootText = `root ${rand()}`
    const root = await person.sendText(room, rootText)
    const rootTs = await tsOfText(rootText)
    const text = `in thread ${rand()}`
    const r = await call('POST', messages(), { text, thread: rootTs, mentions: [personToken(person.userId)] })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ thread: rootTs, mentions: [personToken(person.userId)] })
    const got = await person.waitForMessage((m) => m.body === text)
    expect(got.content['m.mentions']).toEqual({ user_ids: [person.userId] })
    expect(got.relation).toMatchObject({ rel_type: 'm.thread', event_id: root })
    const replies = await until(async () => {
      const l = (await call('GET', `${messages()}?thread=${rootTs}`)).json as unknown as ApiMessageList
      return l.messages.find((m) => m.text === text)
    }, 30_000, 'the reply in the thread listing')
    expect(replies.mentions).toEqual([personToken(person.userId)])
  }, 120_000)

  it('4. thread named by a REPLY → promoted to the root (the person sees the relation on the root)', async () => {
    const rootText = `root2 ${rand()}`
    const root = await person.sendText(room, rootText)
    await tsOfText(rootText)
    const replyText = `reply ${rand()}`
    await person.sendInThread(room, root, replyText)
    const replyTs = await tsOfText(replyText)
    const text = `promoted ${rand()}`
    expect((await call('POST', messages(), { text, thread: replyTs })).status).toBe(200)
    const got = await person.waitForMessage((m) => m.body === text)
    expect(got.relation).toMatchObject({ rel_type: 'm.thread', event_id: root })
  }, 120_000)

  it('5. a conversation the agent does not know → 404, nothing sent', async () => {
    const r = await call('POST', `/v1/conversations/${conversationToken(`!nope${rand()}:${agent!.userId.split(':')[1]}`, false)}/messages`, { text: 'nope' })
    expect([r.status, errorCode(r)]).toEqual([404, 'conversation_not_found'])
  }, 30_000)

  it('6. PATCH → the person sees the edit (m.new_content) and the stream carries message.edited', async () => {
    const posted = (await call('POST', messages(), { text: `v1 ${rand()}` })).json as unknown as ApiMessage
    const original = await person.waitForMessage((m) => m.body === posted.text)
    const v2 = `v2 ${rand()}`
    const r = await call('PATCH', `${messages()}/${posted.id}`, { text: v2 })
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ id: posted.id, text: v2, editedAt: expect.any(Number) as number })
    const edit = await person.waitForMessage((m) => m.relation?.rel_type === 'm.replace' && m.relation.event_id === original.eventId)
    expect(edit.content['m.new_content']).toMatchObject({ body: v2 })
    await until(
      () => stream!.frames.find((f) => f.event === 'message.edited' && (f.data?.message as { id?: string; text?: string })?.id === posted.id && (f.data?.message as { text?: string }).text === v2),
      60_000,
      'message.edited',
    )
  }, 120_000)

  it('7. DELETE → the person sees the removal; the message is then 404', async () => {
    const posted = (await call('POST', messages(), { text: `to remove ${rand()}` })).json as unknown as ApiMessage
    const original = await person.waitForMessage((m) => m.body === posted.text)
    expect((await call('DELETE', `${messages()}/${posted.id}`)).status).toBe(204)
    await person.waitForEvent((e) => e.type === 'm.room.redaction' && e.redacts === original.eventId)
    expect(errorCode(await call('DELETE', `${messages()}/${posted.id}`))).toBe('message_not_found')
  }, 120_000)

  it('8. PUT/DELETE of a reaction → the person sees the annotation come and go; a repeated PUT sends nothing', async () => {
    const text = `react to me ${rand()}`
    const target = await person.sendText(room, text)
    const ts = await tsOfText(text)
    const path = `${messages()}/${ts}/reactions/${encodeURIComponent('👍')}`
    expect((await call('PUT', path)).status).toBe(204)
    expect((await call('PUT', path)).status).toBe(204)
    const reaction = await person.waitForEvent((e) => e.type === 'm.reaction' && e.relation?.event_id === target && e.relation.key === '👍')
    expect(reaction.sender).toBe(agent!.userId)
    expect((await call('DELETE', path)).status).toBe(204)
    await person.waitForEvent((e) => e.type === 'm.room.redaction' && e.redacts === reaction.eventId)
    // One annotation by the agent on that message: the repeated PUT sent nothing.
    await new Promise((r) => setTimeout(r, 1_000))
    expect(person.events().filter((e) => e.type === 'm.reaction' && e.sender === agent!.userId && e.relation?.event_id === target)).toHaveLength(1)
  }, 120_000)

  it('9. upload into the encrypted room → the person downloads, decrypts and gets the same sha256', async () => {
    const bytes = new Uint8Array(200_000).map((_, i) => (i * 31 + 7) % 256)
    const name = `relatório ${rand()}.bin`
    const r = await call('POST', `/v1/conversations/${conv}/files?name=${encodeURIComponent(name)}`, bytes, { 'content-type': 'application/octet-stream' })
    expect(r.status).toBe(200)
    expect((r.json as unknown as ApiMessage).files?.[0]).toMatchObject({ name, size: bytes.byteLength })
    const got = await person.waitForMessage((m) => m.body === name)
    expect(got.wireType).toBe('m.room.encrypted')
    expect(got.content.url).toBeUndefined()
    const plain = await person.downloadEncrypted(got.content.file as EncryptedFile)
    expect(sha256(plain)).toBe(sha256(bytes))
  }, 120_000)

  it('10. the person sends an encrypted file → GET /v1/files/F… returns the same bytes', async () => {
    const bytes = new Uint8Array(50_000).map((_, i) => (i * 17 + 3) % 256)
    const name = `planilha ${rand()}.csv`
    await person.sendEncryptedFile(room, name, 'text/csv', bytes)
    const frame = await until(
      () => stream!.frames.find((f) => f.event === 'message.received' && (f.data?.message as ApiMessage | undefined)?.files?.[0]?.name === name),
      60_000,
      'the file in the agent stream',
    )
    const file = (frame.data!.message as ApiMessage).files![0]!
    expect(file.id).toMatch(/^F[A-Z2-7]{10}$/)
    const r = await call('GET', `/v1/files/${file.id}`)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('text/csv')
    expect(sha256(r.bytes)).toBe(sha256(bytes))
  }, 120_000)

  it('11. an edit of the person’s message → 403 not_own_message', async () => {
    const text = `hers ${rand()}`
    await person.sendText(room, text)
    const ts = await tsOfText(text)
    const r = await call('PATCH', `${messages()}/${ts}`, { text: 'hijack' })
    expect([r.status, errorCode(r)]).toEqual([403, 'not_own_message'])
  }, 60_000)

  // S-i (PLANO-AGENTES §0.3.15): the agent posts Markdown; the person decrypts it and the client's
  // translator (richFromContent, the path translateBody takes) hands back the expected RichDoc — the
  // heading degraded into a strong, no heading node.
  it('12. POST markdown: true → the person decrypts it; the translator gives the RichDoc (heading → strong)', async () => {
    const tag = rand()
    const text = `## Resumo ${tag}\n\nO deploy de **hoje**:\n\n- build\n- publicar`
    const r = await call('POST', messages(), { text, markdown: true })
    expect(r.status).toBe(200)
    expect((r.json as unknown as ApiMessage).text).toBe(text)
    const got = await person.waitForMessage((m) => m.body === text)
    expect(got.wireType).toBe('m.room.encrypted')
    expect(got.content.format).toBe('org.matrix.custom.html')
    expect(richFromContent(got.content)).toEqual<RichDoc>([
      { t: 'p', children: [{ t: 'strong', children: [{ t: 'text', text: `Resumo ${tag}` }] }] },
      { t: 'p', children: [{ t: 'text', text: 'O deploy de ' }, { t: 'strong', children: [{ t: 'text', text: 'hoje' }] }, { t: 'text', text: ':' }] },
      { t: 'ul', items: [[{ t: 'p', children: [{ t: 'text', text: 'build' }] }], [{ t: 'p', children: [{ t: 'text', text: 'publicar' }] }]] },
    ])
  }, 120_000)

  it('13. revocation with writes in the queue → they answer (200, 503 revoked; at most one 502), exit 78 with REVOKED', async () => {
    const a = agent!
    const replies = Array.from({ length: BURST }, (_, i) => call('POST', messages(), { text: `burst ${i}` }).catch(() => null))
    const t0 = Date.now()
    expect((await escrow('DELETE', `/${encodeURIComponent(a.userId)}`)).status).toBeLessThan(300)
    removed = true
    const code = await Promise.race([p!.exited, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), REVOKE_CEILING_MS))])
    const results = await Promise.all(replies)
    const statuses = results.map((r) => (r === null ? 'none' : `${r.status}${r.status === 200 ? '' : `:${String(errorCode(r))}`}`))
    console.log(
      `[sidecar-write-it] DELETE → exit ${String(code)} in ${Date.now() - t0} ms; burst: ${statuses.join(',')}; ` +
        `sdk-orphan-rejection: ${p!.lines.filter(evt('sdk-orphan-rejection')).length}`,
    )
    expect(code, `log tail:\n${p!.stdout().slice(-4000)}\nstderr tail:\n${p!.stderr().slice(-2000)}`).toBe(78)
    // Every write answered before the exit (REVOKED_HOLD_MS); what went out precedes the revocation.
    expect(statuses).not.toContain('none')
    expect(statuses.every((s) => s === '200' || s === '503:revoked' || s === '502:upstream_failed')).toBe(true)
    expect(statuses).toContain('503:revoked')
    // The write in flight while the server deactivates the account may get a 5xx (the server's answer).
    expect(statuses.filter((s) => s === '502:upstream_failed').length).toBeLessThanOrEqual(1)
    expect(p!.lines.find(evt('credential-refused'))).toMatchObject({ stage: 'runtime' })
    expect(JSON.parse(await readFile(join(store, 'REVOKED'), 'utf8'))).toMatchObject({ deviceId: a.deviceId })
    expect(existsSync(join(store, 'indexeddb'))).toBe(false)
  }, 90_000)
})
