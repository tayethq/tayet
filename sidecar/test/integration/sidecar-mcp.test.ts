import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import type { Readable } from 'node:stream'
import { ESCROW_URL, HS_URL, mintOidcSession, stackUp, startWellKnown, until, whoamiStatus } from '../support/stack'
import { DIST_CLI, evt, SIDECAR_ROOT, startSidecar, type SidecarProcess } from '../support/sidecar-process'
import { startHuman, type Human } from '../support/human'
import { idLeaks } from '../support/slack-world'
import { idShapeLeaks } from '../support/mcp-world'
import { conversationToken, personToken } from '../../src/api/ids'

// S-g1 against the stack (PLANO-AGENTES §0.3.13): dist/cli.js as the operator runs it, and the real MCP
// client (`Client` + `StreamableHTTPClientTransport`) on its `POST /mcp` with the local token as Bearer,
// in both protocol eras. alice (the operator) creates the agent and ONE encrypted room inviting it;
// list_conversations and list_members carry the conversation and her; she mentions the agent →
// wait_for_mention answers it → send_message replies in the thread with a mention and she decrypts it;
// react (she sees 👍; again → changed false) and get_person. Every answer and every log line goes through
// the leak-scan. The one `a-` account is deleted at the end.
// S-g2 (§0.3.13 items 3, 5): the same through the stdio bridge — `dist/cli.js mcp --store <dir>` as a child of
// the real `StdioClientTransport`, finding the daemon through the store: she mentions → wait_for_mention →
// send_message → she decrypts.

const STACK = stackUp()
const rand = (): string => Math.random().toString(36).slice(2, 8)

interface Answer {
  isError?: boolean
  content: Array<{ type: string; text: string }>
  structuredContent?: Record<string, unknown>
}
type Msg = { id: string; author: string; text: string; thread?: string; mentionsMe: boolean; mentions?: string[] }

describe.skipIf(!STACK)('sidecar S-g1 ↔ stack: the MCP tools (§0.3.13)', () => {
  let alice: string
  let agent: { userId: string; token: string; deviceId: string } | undefined
  let removed = false
  let created = 0
  let wellKnown: Awaited<ReturnType<typeof startWellKnown>>
  let store: string
  let person: Human
  let p: SidecarProcess | undefined
  let url = ''
  let local = ''
  let mcp: Client
  let room = ''
  let conv = ''
  let agentU = ''
  let aliceU = ''
  let rootEvent = ''
  let rootTs = ''
  const name = `Sidecar MCP ${rand()}`

  const escrow = (method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${ESCROW_URL}/v1/agents${path}`, {
      method,
      headers: { Authorization: `Bearer ${alice}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })

  const connect = async (era: 'legacy' | 'modern'): Promise<Client> => {
    const client = new Client({ name: 'sidecar-mcp-it', version: '0.0.0' }, era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {})
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { authorization: `Bearer ${local}` } } }))
    return client
  }

  // One tool call; the answer through the tests' leak-scan (no id shape, no raw id of anyone).
  const ok = async (tool: string, args: Record<string, unknown> = {}, client: Client = mcp): Promise<Record<string, unknown>> => {
    const a = (await client.callTool({ name: tool, arguments: args })) as unknown as Answer
    expect(a.isError, a.content[0]?.text).not.toBe(true)
    expect(JSON.parse(a.content[0]?.text ?? 'null')).toEqual(a.structuredContent)
    expect(idShapeLeaks(a.structuredContent)).toEqual([])
    for (const id of [agent!.userId, person.userId, room]) expect(JSON.stringify(a)).not.toContain(id)
    return a.structuredContent as Record<string, unknown>
  }

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
    store = await mkdtemp(join(tmpdir(), 'sidecar-mcp-it-'))
    p = startSidecar(['--server', wellKnown.url, '--token', agent.token, '--store', store])
    url = (await p.waitFor(evt('api-listening'), 90_000)).url as string
    local = (await readFile(join(store, 'local.token'), 'utf8')).trim()
    mcp = await connect('legacy')
  }, 180_000)

  afterAll(async () => {
    await mcp?.close().catch(() => {})
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
    process.stderr.write(`[sidecar-mcp-it] a- accounts created: ${created}, deleted: ${removed ? 1 : 0}\n`)
    expect(removed || agent === undefined).toBe(true)
    await wellKnown?.close()
    if (store !== undefined) await rm(store, { recursive: true, force: true })
  }, 60_000)

  it('1. both eras connect; the instructions name the agent; the fourteen tools', async () => {
    expect(mcp.getProtocolEra()).toBe('legacy')
    expect(mcp.getInstructions()).toContain(`"${name}" (${agentU})`)
    const modern = await connect('modern')
    expect(modern.getProtocolEra()).toBe('modern')
    expect((await modern.listTools()).tools).toHaveLength(14)
    await modern.close()
  })

  it('2. alice invites the agent: list_conversations carries the conversation, list_members carries her and the agent', async () => {
    room = await person.createEncryptedRoom([agent!.userId])
    conv = conversationToken(room, false)
    await p!.waitFor((l) => l.evt === 'joined' && l.conversation === conv, 60_000)
    await person.waitForMembership(room, agent!.userId, 'join')
    await until(async () => ((await ok('list_conversations')).conversations as Array<{ id: string }>).some((c) => c.id === conv) || undefined, 30_000, 'the conversation')
    const people = await until(async () => {
      const list = (await ok('list_members', { conversation: conv })).people as Array<{ id: string; kind: string }>
      return list.some((x) => x.id === aliceU) && list.some((x) => x.id === agentU) ? list : undefined
    }, 30_000, 'the members')
    expect(people.find((x) => x.id === agentU)).toMatchObject({ kind: 'agent' })
  }, 120_000)

  it('3. she mentions the agent → wait_for_mention answers it (decrypted) with a cursor', async () => {
    // The cursor before the mention: nothing is missed between this call and the next one.
    const start = (await ok('wait_for_mention', { timeout_s: 0 })) as { timedOut: true; cursor: string }
    expect(start.timedOut).toBe(true)
    const marker = rand()
    rootEvent = await person.sendMention(room, `@${name} roda o relatório ${marker}?`, [agent!.userId])
    let cursor = start.cursor
    const got = await until(async () => {
      const v = (await ok('wait_for_mention', { after: cursor, timeout_s: 50 })) as { mention?: { conversation: string; message: Msg }; cursor: string }
      cursor = v.cursor
      return v.mention?.message.text.includes(marker) === true ? v.mention : undefined
    }, 150_000, 'the mention')
    expect(got.conversation).toBe(conv)
    expect(got.message).toMatchObject({ author: aliceU, mentionsMe: true })
    rootTs = got.message.id
  }, 180_000)

  it('4. send_message replies in the thread with a mention; alice decrypts it', async () => {
    const m = (await ok('send_message', { conversation: conv, text: 'relatório pronto', thread: rootTs, mentions: [aliceU] })) as unknown as Msg
    expect(m).toMatchObject({ author: agentU, thread: rootTs, mentions: [aliceU] })
    const got = await person.waitForMessage((x) => x.sender === agent!.userId && x.body === 'relatório pronto', 60_000)
    expect(got.wireType).toBe('m.room.encrypted')
    expect(got.relation).toMatchObject({ rel_type: 'm.thread', event_id: rootEvent })
    expect(got.content['m.mentions']).toEqual({ user_ids: [person.userId] })
    // read_messages of the thread carries the reply.
    const thread = await until(async () => {
      const r = (await ok('read_messages', { conversation: conv, thread: rootTs })).messages as Msg[]
      return r.some((x) => x.id === m.id) ? r : undefined
    }, 30_000, 'the reply in the thread')
    expect(thread.find((x) => x.id === m.id)).toMatchObject({ text: 'relatório pronto' })
  }, 120_000)

  it('5. react: alice sees 👍 from the agent; again → changed false', async () => {
    expect(await ok('react', { conversation: conv, message: rootTs, emoji: '👍' })).toEqual({ changed: true })
    const reaction = await person.waitForEvent((e) => e.type === 'm.reaction' && e.relation?.event_id === rootEvent && e.relation.key === '👍', 60_000)
    expect(reaction.sender).toBe(agent!.userId)
    await until(async () => ((await ok('react', { conversation: conv, message: rootTs, emoji: '👍' })).changed === false ? true : undefined), 30_000, 'idempotent react')
  }, 90_000)

  it('6. get_person of alice and of the agent; read_messages with after; an unknown conversation → isError', async () => {
    expect(await ok('get_person', { id: aliceU })).toMatchObject({ id: aliceU, kind: 'member' })
    expect(await ok('get_person', { id: agentU })).toMatchObject({ id: agentU, kind: 'agent', name })
    const after = (await ok('read_messages', { conversation: conv, after: rootTs })).messages as Msg[]
    expect(after.every((x) => x.id !== rootTs)).toBe(true)
    const a = (await mcp.callTool({ name: 'read_messages', arguments: { conversation: 'CNOPEAAAAAA' } })) as unknown as Answer
    expect(a.isError).toBe(true)
    expect(a.content[0]?.text).toBe('conversation_not_found')
  }, 60_000)

  it('7. the stdio bridge (S-g2): she mentions → wait_for_mention → send_message, all through the bridge; she decrypts', async () => {
    const transport = new StdioClientTransport({ command: process.execPath, args: [DIST_CLI, 'mcp', '--store', store], stderr: 'pipe', cwd: SIDECAR_ROOT })
    let bridgeErr = ''
    ;(transport.stderr as Readable | null)?.setEncoding('utf8').on('data', (c: string) => (bridgeErr += c))
    const bridged = new Client({ name: 'sidecar-mcp-bridge-it', version: '0.0.0' })
    await bridged.connect(transport)
    try {
      expect(bridged.getInstructions()).toContain(`"${name}" (${agentU})`)
      expect((await bridged.listTools()).tools).toHaveLength(14)
      const start = (await ok('wait_for_mention', { timeout_s: 0 }, bridged)) as { timedOut: true; cursor: string }
      const marker = rand()
      await person.sendMention(room, `@${name} pela ponte ${marker}?`, [agent!.userId])
      let cursor = start.cursor
      const got = await until(async () => {
        const v = (await ok('wait_for_mention', { after: cursor, timeout_s: 50 }, bridged)) as { mention?: { conversation: string; message: Msg }; cursor: string }
        cursor = v.cursor
        return v.mention?.message.text.includes(marker) === true ? v.mention : undefined
      }, 150_000, 'the mention through the bridge')
      expect(got).toMatchObject({ conversation: conv, message: { author: aliceU, mentionsMe: true } })
      const reply = `pela ponte ${marker}`
      const m = (await ok('send_message', { conversation: conv, text: reply }, bridged)) as unknown as Msg
      expect(m).toMatchObject({ author: agentU, text: reply })
      const seen = await person.waitForMessage((x) => x.sender === agent!.userId && x.body === reply, 60_000)
      expect(seen.wireType).toBe('m.room.encrypted')
    } finally {
      await bridged.close()
    }
    // The bridge's stderr: no token, no protocol id.
    for (const secret of [local, agent!.userId, person.userId, room]) expect(bridgeErr).not.toContain(secret)
  }, 240_000)

  it('8. the leak-scan over the log: no protocol id of anyone in a default line', () => {
    const out = p!.stdout()
    for (const id of [agent!.userId, person.userId, room, rootEvent]) expect(out).not.toContain(id)
    expect(idLeaks(p!.lines.map((l) => ({ ...l, ts: undefined })))).toEqual([])
    expect(out).not.toContain(local)
  })
})
