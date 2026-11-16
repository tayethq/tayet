import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildTextContent } from '@tayet/shared/internal'
import type { UserId } from '@tayet/shared'
import { ESCROW_URL, HS_URL, mintOidcSession, stackUp, startWellKnown, until, whoamiStatus } from '../support/stack'
import { evt, SIDECAR_ROOT, startSidecar, type SidecarProcess } from '../support/sidecar-process'
import { startHuman, type CommandsRead, type Human } from '../support/human'
import { idLeaks } from '../support/slack-world'
import { conversationToken, personToken } from '../../src/api/ids'

// A4-3 against the stack (ADR-093; ADR-087 dec. 6; PLANO-AGENTES §0.3.25): dist/cli.js started with
// `--slack-manifest <file>` (a Slack app manifest in JSON) and a Bolt 5.1.0 agent with no patch
// (test/support/bolt-agent.mjs) in Socket Mode. alice (the operator) creates the agent and ONE encrypted room
// inviting it. 1. the manifest's slash commands are declared: she reads the manifest in the conversation BY THE
// PROTOCOL (support/human.ts `readCommands`); 2. she sends `/deploy <args>` with the command marker (the shared
// builder) → Bolt's app.command gets `slash_commands`, and no `message`/`app_mention` of that message (a plain
// mention after it is the barrier); 3. the ack's text is a reply in the command's thread; 4. respond() through the
// response_url is another reply in the same thread. Every Bolt line and every sidecar line goes through the
// leak-scan; no sidecar line carries the command's args. The one `a-` account is deleted at the end.

const STACK = stackUp()
const rand = (): string => Math.random().toString(36).slice(2, 8)
const BOLT = join(SIDECAR_ROOT, 'test', 'support', 'bolt-agent.mjs')

interface BoltLine {
  evt: string
  event?: Record<string, unknown>
  command?: Record<string, unknown>
  ts?: string
  thread_ts?: string
}

describe.skipIf(!STACK)('sidecar A4-3 ↔ stack: slash commands through Bolt (--slack-manifest, slash_commands, ack, respond)', () => {
  let alice: string
  let agent: { userId: string; token: string; deviceId: string } | undefined
  let removed = false
  let created = 0
  let wellKnown: Awaited<ReturnType<typeof startWellKnown>>
  let store: string
  let manifestDir: string
  let person: Human
  let p: SidecarProcess | undefined
  let bolt: ChildProcess | undefined
  let url = ''
  const boltLines: BoltLine[] = []
  let boltErr = ''
  let room = ''
  let conv = ''
  let aliceU = ''
  let commandEvent = ''
  let messageTs = ''
  const marker = rand()
  const args = `produção ${marker}`
  const name = `Sidecar Slack Commands ${rand()}`

  const escrow = (method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${ESCROW_URL}/v1/agents${path}`, {
      method,
      headers: { Authorization: `Bearer ${alice}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  const boltWait = (pred: (l: BoltLine) => boolean, timeoutMs: number, what: string): Promise<BoltLine> => until(() => boltLines.find(pred), timeoutMs, what)
  const names = (r: CommandsRead): string[] => (r.shown?.block?.commands ?? []).map((c) => c.name)

  beforeAll(async () => {
    alice = (await mintOidcSession('alice', 'alicepass123')).accessToken
    const res = await escrow('POST', '', { name })
    expect(res.status).toBe(201)
    agent = (await res.json()) as NonNullable<typeof agent>
    created++
    person = await startHuman(alice)
    aliceU = personToken(person.userId)
    wellKnown = await startWellKnown(HS_URL)
    store = await mkdtemp(join(tmpdir(), 'sidecar-slack-commands-it-'))
    manifestDir = await mkdtemp(join(tmpdir(), 'sidecar-slack-manifest-it-'))
    const manifest = join(manifestDir, 'manifest.json')
    await writeFile(
      manifest,
      JSON.stringify({
        display_information: { name: 'Deploy bot' },
        features: {
          bot_user: { display_name: 'deploy' },
          slash_commands: [
            { command: '/deploy', description: 'Publicar o build', usage_hint: '<ambiente>', should_escape: false },
            { command: '/Status', description: 'O estado do deploy' },
          ],
        },
        settings: { socket_mode_enabled: true },
      }),
    )
    p = startSidecar(['--server', wellKnown.url, '--token', agent.token, '--store', store, '--slack-manifest', manifest])
    url = (await p.waitFor(evt('api-listening'), 90_000)).url as string
    const local = (await readFile(join(store, 'local.token'), 'utf8')).trim()
    bolt = spawn(process.execPath, [BOLT], { env: { ...process.env, SIDECAR_URL: url, SIDECAR_TOKEN: local }, stdio: ['ignore', 'pipe', 'pipe'] })
    let buffer = ''
    bolt.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      buffer += chunk
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        try {
          boltLines.push(JSON.parse(line) as BoltLine)
        } catch {
          // Not one of the agent's lines.
        }
      }
    })
    bolt.stderr?.setEncoding('utf8').on('data', (chunk: string) => (boltErr += chunk))
    await boltWait((l) => l.evt === 'started', 60_000, 'Bolt started')
  }, 180_000)

  afterAll(async () => {
    if (bolt !== undefined && bolt.exitCode === null) {
      const exited = new Promise((r) => bolt!.once('exit', r))
      bolt.kill('SIGTERM')
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))])
      if (bolt.exitCode === null) bolt.kill('SIGKILL')
    }
    await p?.stop()
    person?.stop()
    if (agent !== undefined && !removed) {
      const del = await escrow('DELETE', `/${encodeURIComponent(agent.userId)}`)
      if (del.status < 300) {
        await until(async () => ((await whoamiStatus(agent!.token)) === 401 ? true : undefined), 30_000, 'whoami 401 after DELETE')
        removed = true
      }
    }
    process.stderr.write(`[sidecar-slack-commands-it] a- accounts created: ${created}, deleted: ${removed ? 1 : 0}\n`)
    expect(removed || agent === undefined).toBe(true)
    await wellKnown?.close()
    if (store !== undefined) await rm(store, { recursive: true, force: true })
    if (manifestDir !== undefined) await rm(manifestDir, { recursive: true, force: true })
  }, 60_000)

  it('1. the sidecar starts with the manifest; the person reads its commands in the conversation', async () => {
    await p!.waitFor((l) => l.evt === 'slack-manifest-declared' && l.commands === 2, 90_000)
    room = await person.createEncryptedRoom([agent!.userId])
    conv = conversationToken(room, false)
    await p!.waitFor((l) => l.evt === 'joined' && l.conversation === conv, 60_000)
    await person.waitForMembership(room, agent!.userId, 'join')
    const read = await until(async () => {
      const r = await person.readCommands(room, agent!.userId)
      return names(r).length === 2 ? r : undefined
    }, 90_000, 'the manifest in the conversation')
    expect(read.shown!.block).toEqual({
      commands: [
        { name: 'deploy', description: 'Publicar o build', hint: '<ambiente>' },
        { name: 'status', description: 'O estado do deploy' },
      ],
      cleared: false,
    })
  }, 240_000)

  it('2. the person sends the command → Bolt gets slash_commands, and no message nor app_mention of that message', async () => {
    commandEvent = await person.sendContent(room, buildTextContent(`/deploy ${args}`, undefined, undefined, undefined, { name: 'deploy', agent: agent!.userId as unknown as UserId }))
    const got = await boltWait((l) => l.evt === 'command', 90_000, 'slash_commands in Bolt')
    expect(got.command).toMatchObject({ command: '/deploy', text: args, channel_id: conv, user_id: aliceU, team_id: expect.stringMatching(/^T/) as unknown })
    expect(got.command!.thread_ts).toBeUndefined()
    messageTs = got.command!.message_ts as string
    expect(messageTs).toMatch(/^\d+\.\d{6}$/)
    expect(got.command!.response_url).toMatch(new RegExp(`^${url}/slack/response/[0-9a-f]{64}$`))
    // The barrier: a plain mention after it reaches Bolt; nothing of the command's message did.
    const barrier = `barreira ${marker}`
    await person.sendMention(room, `@${name} ${barrier}`, [agent!.userId])
    await boltWait((l) => l.evt === 'app_mention' && String(l.event?.text).includes(barrier), 90_000, 'the barrier mention')
    const ofCommand = boltLines.filter((l) => (l.evt === 'message' || l.evt === 'app_mention') && l.event?.ts === messageTs)
    expect(ofCommand).toEqual([])
    expect(boltLines.filter((l) => l.evt === 'command')).toHaveLength(1)
  }, 240_000)

  it('3–4. the ack’s text and respond() become replies in the command’s thread', async () => {
    const inThread = (body: string) =>
      person.waitForMessage((m) => m.sender === agent!.userId && m.body === body && m.relation?.rel_type === 'm.thread' && m.relation.event_id === commandEvent, 60_000)
    const ack = await inThread(`ack ${args}`)
    expect(ack.wireType).toBe('m.room.encrypted')
    await boltWait((l) => l.evt === 'command-responded', 60_000, 'respond() answered')
    await inThread(`respondido ${args}`)
    const via = p!.lines.filter((l) => l.evt === 'slash-command-response').map((l) => l.via)
    expect(via.sort()).toEqual(['ack', 'response_url'])
    expect(boltErr).toBe('')
  }, 180_000)

  it('5. the leak-scan over what Bolt received and over the sidecar log; no sidecar line carries the args', () => {
    expect(boltLines.length).toBeGreaterThan(3)
    expect(idLeaks(boltLines)).toEqual([])
    const all = JSON.stringify(boltLines) + JSON.stringify(p!.lines)
    for (const raw of [agent!.userId, person.userId, room, commandEvent]) expect(all).not.toContain(raw)
    expect(idLeaks(p!.lines.map((l) => ({ ...l, ts: undefined })))).toEqual([])
    expect(JSON.stringify(p!.lines)).not.toContain(marker)
  })
})
