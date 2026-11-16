import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebClient } from '@slack/web-api'
import { ESCROW_URL, HS_URL, mintOidcSession, stackUp, startWellKnown, until, whoamiStatus } from '../support/stack'
import { evt, startSidecar, type SidecarProcess } from '../support/sidecar-process'
import { startHuman, type Human } from '../support/human'
import { idLeaks } from '../support/slack-world'
import { conversationToken, personToken } from '../../src/api/ids'
import type { EncryptedFile } from '@tayet/shared/internal/attachment-crypto'

// S-f1a against the stack (PLANO-AGENTES §0.3.12): dist/cli.js as the operator runs it, and the real
// @slack/web-api pointed at its Slack layer with the local token as the bot token. alice (the operator)
// creates the agent and ONE encrypted room inviting it; she mentions the agent and it reads `<@U_agent>`
// in conversations.history; it answers in the thread with mrkdwn and she decrypts the right rich text;
// conversations.replies carries the root; chat.update and chat.delete of its own message. S-f1b: it
// reacts with `thumbsup` and she sees 👍; filesUploadV2 of a PNG with initial_comment in the thread —
// she reads the comment, then decrypts the attachment (same sha256); users.info of her and of itself.
// S-f3: she sends a PNG → the agent sees the F… in conversations.history, calls files.info and fetches
// its url_private with the Bearer (same sha256); users.list carries her; she opens a DM with the agent
// and conversations.open with her U… answers that D….
// Every Slack answer and every log line goes through the leak-scan. The one `a-` account is deleted at
// the end.

const STACK = stackUp()
const rand = (): string => Math.random().toString(36).slice(2, 8)

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')
// A 1×1 PNG.
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a5c50000000049454e44ae426082', 'hex')

describe.skipIf(!STACK)('sidecar S-f1a/S-f1b ↔ stack: the Slack Web API (§0.3.12)', () => {
  let alice: string
  let agent: { userId: string; token: string; deviceId: string } | undefined
  let removed = false
  let created = 0
  let wellKnown: Awaited<ReturnType<typeof startWellKnown>>
  let store: string
  let person: Human
  let p: SidecarProcess | undefined
  let slack: WebClient
  let room = ''
  let conv = ''
  let agentU = ''
  let aliceU = ''
  let rootTs = ''
  let rootEvent = ''
  let replyTs = ''
  let replyEvent = ''
  let local = ''
  let dm = ''
  const name = `Sidecar Slack ${rand()}`

  const escrow = (method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${ESCROW_URL}/v1/agents${path}`, {
      method,
      headers: { Authorization: `Bearer ${alice}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })

  // One Slack call; the answer through the tests' leak-scan.
  const ok = async (method: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const res = (await slack.apiCall(method, args)) as unknown as Record<string, unknown>
    expect(idLeaks(res)).toEqual([])
    expect(JSON.stringify(res)).not.toContain(agent!.userId)
    expect(JSON.stringify(res)).not.toContain(person.userId)
    return res
  }
  type SlackMsg = { ts: string; user: string; text: string; thread_ts?: string }
  const history = async (): Promise<SlackMsg[]> => (await ok('conversations.history', { channel: conv })).messages as SlackMsg[]

  beforeAll(async () => {
    alice = (await mintOidcSession('alice', 'alicepass123')).accessToken
    const res = await escrow('POST', '', { name })
    expect(res.status).toBe(201)
    agent = (await res.json()) as NonNullable<typeof agent>
    created++
    person = await startHuman(alice)
    agentU = personToken(agent.userId)
    aliceU = personToken(person.userId)
    wellKnown = await startWellKnown(HS_URL)
    store = await mkdtemp(join(tmpdir(), 'sidecar-slack-it-'))
    p = startSidecar(['--server', wellKnown.url, '--token', agent.token, '--store', store])
    const url = (await p.waitFor(evt('api-listening'), 90_000)).url as string
    local = (await readFile(join(store, 'local.token'), 'utf8')).trim()
    slack = new WebClient(local, { slackApiUrl: `${url}/slack/api/`, retryConfig: { retries: 3, factor: 1, minTimeout: 100, maxTimeout: 1000 } })
  }, 180_000)

  afterAll(async () => {
    await p?.stop()
    person?.stop()
    if (agent !== undefined && !removed) {
      const del = await escrow('DELETE', `/${encodeURIComponent(agent.userId)}`)
      if (del.status < 300) {
        await until(async () => ((await whoamiStatus(agent!.token)) === 401 ? true : undefined), 30_000, 'whoami 401 after DELETE')
        removed = true
      }
    }
    // The account count of the run (declared in the §8 report); a leftover fails the suite.
    process.stderr.write(`[sidecar-slack-it] a- accounts created: ${created}, deleted: ${removed ? 1 : 0}\n`)
    expect(removed || agent === undefined).toBe(true)
    await wellKnown?.close()
    if (store !== undefined) await rm(store, { recursive: true, force: true })
  }, 60_000)

  it('1. auth.test through the real WebClient: the agent’s U…, its B…, the workspace T…', async () => {
    const me = await ok('auth.test', {})
    expect(me).toMatchObject({ ok: true, user_id: agentU, user: name })
    expect(me.bot_id).toMatch(/^B[A-Z2-7]{10}$/)
    expect(me.team_id).toMatch(/^T[A-Z2-7]{10}$/)
  })

  it('2. alice invites the agent; she mentions it and it reads <@U_agent> in conversations.history', async () => {
    room = await person.createEncryptedRoom([agent!.userId])
    conv = conversationToken(room, false)
    await p!.waitFor((l) => l.evt === 'joined' && l.conversation === conv, 60_000)
    await person.waitForMembership(room, agent!.userId, 'join')
    await until(async () => ((await ok('conversations.list', { types: 'private_channel' })).channels as Array<{ id: string }>).some((c) => c.id === conv) || undefined, 30_000, 'the conversation')
    const marker = rand()
    rootEvent = await person.sendMention(room, `@${name} pode olhar o deploy ${marker}?`, [agent!.userId])
    const seen = await until(async () => (await history()).find((m) => m.text.includes(marker)), 60_000, 'the mention in conversations.history')
    expect(seen).toMatchObject({ user: aliceU, text: `<@${agentU}> pode olhar o deploy ${marker}?` })
    rootTs = seen.ts
  }, 120_000)

  it('3. the agent answers in the thread with mrkdwn; alice decrypts the rich text, the mention and the thread', async () => {
    const res = await ok('chat.postMessage', { channel: conv, thread_ts: rootTs, text: `<@${aliceU}> o *deploy* saiu, veja <https://example.com/run|o log> e \`npm test\`` })
    replyTs = res.ts as string
    expect(res).toMatchObject({ channel: conv, message: { user: agentU, thread_ts: rootTs } })
    const got = await person.waitForMessage((m) => m.sender === agent!.userId && typeof m.body === 'string' && m.body.includes('saiu'), 60_000)
    replyEvent = got.eventId
    expect(got.wireType).toBe('m.room.encrypted')
    expect(got.relation).toMatchObject({ rel_type: 'm.thread', event_id: rootEvent })
    expect(got.content['m.mentions']).toEqual({ user_ids: [person.userId] })
    expect(got.content.formatted_body).toContain('<strong>deploy</strong>')
    expect(got.content.formatted_body).toContain('<a href="https://example.com/run">o log</a>')
    expect(got.content.formatted_body).toContain('<code>npm test</code>')
    expect(got.body).not.toContain('*deploy*')
  }, 120_000)

  it('4. conversations.replies: the root first, then the agent’s reply', async () => {
    const replies = await until(async () => {
      const r = (await ok('conversations.replies', { channel: conv, ts: rootTs })).messages as SlackMsg[]
      return r.length >= 2 ? r : undefined
    }, 60_000, 'the reply in the thread')
    expect(replies.map((m) => m.ts)).toEqual([rootTs, replyTs])
    expect(replies[0]).toMatchObject({ user: aliceU, thread_ts: rootTs })
    expect(replies[1]).toMatchObject({ user: agentU, thread_ts: rootTs, text: expect.stringContaining('*deploy*') as unknown })
    // The main listing has no thread replies.
    expect((await history()).some((m) => m.ts === replyTs)).toBe(false)
  }, 90_000)

  it('5. chat.update of its own message (alice sees the edit); someone else’s → cant_update_message', async () => {
    const res = await ok('chat.update', { channel: conv, ts: replyTs, text: 'versão _final_' })
    expect(res).toMatchObject({ channel: conv, ts: replyTs, text: 'versão _final_' })
    const edit = await person.waitForEvent((e) => e.sender === agent!.userId && e.relation?.rel_type === 'm.replace' && e.relation.event_id === replyEvent, 60_000)
    expect((edit.content['m.new_content'] as Record<string, unknown>).formatted_body).toContain('<em>final</em>')
    await expect(slack.apiCall('chat.update', { channel: conv, ts: rootTs, text: 'x' })).rejects.toMatchObject({ data: { error: 'cant_update_message' } })
  }, 90_000)

  it('6. chat.delete of its own message (alice sees the removal); someone else’s → cant_delete_message', async () => {
    await expect(slack.apiCall('chat.delete', { channel: conv, ts: rootTs })).rejects.toMatchObject({ data: { error: 'cant_delete_message' } })
    expect(await ok('chat.delete', { channel: conv, ts: replyTs })).toMatchObject({ channel: conv, ts: replyTs })
    await person.waitForEvent((e) => e.type === 'm.room.redaction' && e.redacts === replyEvent, 60_000)
  }, 90_000)

  it('7. reactions.add name=thumbsup on alice’s message: she sees 👍 from the agent; the read shows +1; again → already_reacted', async () => {
    expect(await ok('reactions.add', { channel: conv, timestamp: rootTs, name: 'thumbsup' })).toMatchObject({ ok: true })
    const reaction = await person.waitForEvent((e) => e.type === 'm.reaction' && e.relation?.event_id === rootEvent && e.relation.key === '👍', 60_000)
    expect(reaction.sender).toBe(agent!.userId)
    await expect(slack.apiCall('reactions.add', { channel: conv, timestamp: rootTs, name: '+1' })).rejects.toMatchObject({ data: { error: 'already_reacted' } })
    const root = await until(async () => (await history()).find((m) => m.ts === rootTs && (m as { reactions?: unknown[] }).reactions !== undefined), 30_000, 'the reaction on the read')
    expect((root as unknown as { reactions: unknown[] }).reactions).toEqual([{ name: '+1', count: 1, users: [agentU] }])
  }, 90_000)

  it('8. filesUploadV2 of a PNG with initial_comment in the thread: alice reads the comment, then decrypts the PNG', async () => {
    const marker = rand()
    const filename = `grafico-${marker}.png`
    const res = await slack.filesUploadV2({ channel_id: conv, thread_ts: rootTs, initial_comment: `o *gráfico* ${marker}`, file: PNG, filename, title: 'Gráfico' })
    expect(idLeaks(res)).toEqual([])
    for (const id of [agent!.userId, person.userId, room]) expect(JSON.stringify(res)).not.toContain(id)
    const files = (res as unknown as { files: Array<{ files: Array<Record<string, unknown>> }> }).files[0]?.files
    expect(files).toEqual([{ id: expect.stringMatching(/^F[A-Z2-7]{10}$/) as unknown, name: filename, title: 'Gráfico', mimetype: 'image/png', size: PNG.length }])
    const comment = await person.waitForMessage((m) => m.sender === agent!.userId && typeof m.body === 'string' && m.body.includes(marker) && m.body !== filename, 60_000)
    expect(comment.wireType).toBe('m.room.encrypted')
    expect(comment.relation).toMatchObject({ rel_type: 'm.thread', event_id: rootEvent })
    expect(comment.content.formatted_body).toContain('<strong>gráfico</strong>')
    const file = await person.waitForMessage((m) => m.sender === agent!.userId && m.body === filename, 60_000)
    expect(file.wireType).toBe('m.room.encrypted')
    expect(file.relation).toMatchObject({ rel_type: 'm.thread', event_id: rootEvent })
    expect(file.content.url).toBeUndefined()
    expect(sha256(await person.downloadEncrypted(file.content.file as EncryptedFile))).toBe(sha256(new Uint8Array(PNG)))
    // The comment went out before the file.
    const order = person.events().filter((e) => e.eventId === comment.eventId || e.eventId === file.eventId).map((e) => e.eventId)
    expect(order).toEqual([comment.eventId, file.eventId])
  }, 120_000)

  it('9. users.info of alice and of the agent itself; never an email', async () => {
    const her = (await ok('users.info', { user: aliceU })).user as Record<string, unknown>
    expect(her).toMatchObject({ id: aliceU, is_bot: false, deleted: false })
    expect(typeof her.name).toBe('string')
    const self = (await ok('users.info', { user: agentU })).user as Record<string, unknown>
    expect(self).toMatchObject({ id: agentU, is_bot: true, name })
    expect(JSON.stringify([her, self])).not.toMatch(/email/)
  }, 60_000)

  it('10. S-f3: alice sends a PNG → the F… in conversations.history, files.info, and its url_private fetched with the Bearer', async () => {
    const filename = `foto-${rand()}.png`
    await person.sendEncryptedFile(room, filename, 'image/png', new Uint8Array(PNG))
    type FileMsg = { files?: Array<{ id: string; name: string; url_private?: string }> }
    const seen = await until(async () => ((await history()) as unknown as FileMsg[]).find((m) => m.files?.[0]?.name === filename), 60_000, 'the file in conversations.history')
    const listed = seen.files![0]!
    expect(listed.id).toMatch(/^F[A-Z2-7]{10}$/)
    const info = (await ok('files.info', { file: listed.id })).file as { id: string; name: string; mimetype: string; size: number; url_private: string; url_private_download: string }
    expect(info).toMatchObject({ id: listed.id, name: filename, mimetype: 'image/png', size: PNG.length })
    expect(info.url_private).toBe(listed.url_private)
    expect(info.url_private).toMatch(/^http:\/\/[^/]+\/slack\/files\/F[A-Z2-7]{10}$/)
    const res = await fetch(info.url_private, { headers: { Authorization: `Bearer ${local}` } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(sha256(new Uint8Array(await res.arrayBuffer()))).toBe(sha256(new Uint8Array(PNG)))
    expect((await fetch(info.url_private)).status).toBe(401)
  }, 120_000)

  it('11. S-f3: users.list carries alice and the agent, once each', async () => {
    const members: Array<{ id: string; is_bot: boolean }> = []
    for await (const page of slack.paginate('users.list', { limit: 50 })) {
      expect(idLeaks(page)).toEqual([])
      members.push(...(page as unknown as { members: Array<{ id: string; is_bot: boolean }> }).members)
    }
    expect(members.find((u) => u.id === aliceU)).toMatchObject({ is_bot: false })
    expect(members.find((u) => u.id === agentU)).toMatchObject({ is_bot: true })
    expect(new Set(members.map((u) => u.id)).size).toBe(members.length)
    expect(JSON.stringify(members)).not.toContain(person.userId)
  }, 60_000)

  it('12. S-f3: alice opens a DM with the agent; conversations.open with her U… answers that D…', async () => {
    dm = await person.createDirect(agent!.userId)
    const d = conversationToken(dm, true)
    await until(async () => ((await ok('conversations.list', { types: 'im' })).channels as Array<{ id: string }>).some((c) => c.id === d) || undefined, 90_000, 'the DM')
    expect(await ok('conversations.open', { users: aliceU })).toMatchObject({ ok: true, channel: { id: d } })
    expect((await ok('conversations.open', { users: aliceU, return_im: true })).channel).toMatchObject({ id: d, is_im: true, user: aliceU })
  }, 120_000)

  it('13. the leak-scan over the log: no protocol id of anyone in a default line', () => {
    const out = p!.stdout()
    for (const id of [agent!.userId, person.userId, room, rootEvent, replyEvent, dm]) expect(out).not.toContain(id)
    expect(idLeaks(p!.lines.map((l) => ({ ...l, ts: undefined })))).toEqual([])
  })
})
