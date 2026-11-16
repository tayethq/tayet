import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ESCROW_URL, HS_URL, mintOidcSession, stackUp, startWellKnown, until, whoamiStatus } from '../support/stack'
import { evt, SIDECAR_ROOT, startSidecar, type SidecarProcess } from '../support/sidecar-process'
import { startHuman, type Human } from '../support/human'
import { idLeaks } from '../support/slack-world'
import { conversationToken, personToken } from '../../src/api/ids'

// S-f2 against the stack (PLANO-AGENTES §0.3.12, §0.3.3 item 6): dist/cli.js as the operator runs it and a
// Bolt 5.1.0 agent with no patch in its own process (test/support/bolt-agent.mjs), in Socket Mode over the
// sidecar's emulated WebSocket. alice (the operator) creates the agent and ONE encrypted room inviting it;
// she mentions the agent → Bolt gets `message` then `app_mention` and answers in the thread with say() →
// she decrypts the answer in the thread; she edits her message → Bolt gets `message_changed`. Every Bolt
// line and every sidecar line goes through the leak-scan. The one `a-` account is deleted at the end.

const STACK = stackUp()
const rand = (): string => Math.random().toString(36).slice(2, 8)
const BOLT = join(SIDECAR_ROOT, 'test', 'support', 'bolt-agent.mjs')

interface BoltLine {
  evt: string
  event?: Record<string, unknown>
  ts?: string
  thread_ts?: string
}

describe.skipIf(!STACK)('sidecar S-f2 ↔ stack: Bolt over the emulated Socket Mode (§0.3.12)', () => {
  let alice: string
  let agent: { userId: string; token: string; deviceId: string } | undefined
  let removed = false
  let created = 0
  let wellKnown: Awaited<ReturnType<typeof startWellKnown>>
  let store: string
  let person: Human
  let p: SidecarProcess | undefined
  let bolt: ChildProcess | undefined
  const boltLines: BoltLine[] = []
  let boltErr = ''
  let room = ''
  let conv = ''
  let agentU = ''
  let aliceU = ''
  let rootTs = ''
  let rootEvent = ''
  const name = `Sidecar Socket ${rand()}`

  const escrow = (method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${ESCROW_URL}/v1/agents${path}`, {
      method,
      headers: { Authorization: `Bearer ${alice}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })

  const boltWait = (pred: (l: BoltLine) => boolean, timeoutMs: number, what: string): Promise<BoltLine> => until(() => boltLines.find(pred), timeoutMs, what)

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
    store = await mkdtemp(join(tmpdir(), 'sidecar-socket-it-'))
    p = startSidecar(['--server', wellKnown.url, '--token', agent.token, '--store', store])
    const url = (await p.waitFor(evt('api-listening'), 90_000)).url as string
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
    // The account count of the run (declared in the §8 report); a leftover fails the suite.
    process.stderr.write(`[sidecar-socket-it] a- accounts created: ${created}, deleted: ${removed ? 1 : 0}\n`)
    expect(removed || agent === undefined).toBe(true)
    await wellKnown?.close()
    if (store !== undefined) await rm(store, { recursive: true, force: true })
  }, 60_000)

  it('1. the Bolt agent starts in Socket Mode against the sidecar (auth.test, apps.connections.open, hello)', async () => {
    await boltWait((l) => l.evt === 'started', 60_000, 'Bolt started')
    expect(p!.lines.find((l) => l.evt === 'socket-open')).toMatchObject({ connections: 1 })
    expect(boltErr).toBe('')
  }, 90_000)

  it('2. alice mentions the agent → Bolt gets message then app_mention, answers with say() in the thread, she decrypts it', async () => {
    room = await person.createEncryptedRoom([agent!.userId])
    conv = conversationToken(room, false)
    await p!.waitFor((l) => l.evt === 'joined' && l.conversation === conv, 60_000)
    await person.waitForMembership(room, agent!.userId, 'join')
    const marker = rand()
    rootEvent = await person.sendMention(room, `@${name} resuma o dia ${marker}`, [agent!.userId])
    const mention = await boltWait((l) => l.evt === 'app_mention' && String(l.event?.text).includes(marker), 90_000, 'app_mention in Bolt')
    expect(mention.event).toMatchObject({ type: 'app_mention', channel: conv, user: aliceU, text: `<@${agentU}> resuma o dia ${marker}` })
    rootTs = mention.event!.ts as string
    const message = boltLines.findIndex((l) => l.evt === 'message' && l.event?.ts === rootTs)
    expect(message).toBeGreaterThanOrEqual(0)
    expect(message).toBeLessThan(boltLines.indexOf(mention))
    expect(boltLines[message]!.event).toMatchObject({ type: 'message', channel: conv, channel_type: 'group', user: aliceU })
    const said = await boltWait((l) => l.evt === 'said' && l.thread_ts === rootTs, 60_000, 'say() answered')
    const got = await person.waitForMessage((m) => m.sender === agent!.userId && typeof m.body === 'string' && m.body.includes(`recebido ${marker}`), 60_000)
    expect(got.wireType).toBe('m.room.encrypted')
    expect(got.relation).toMatchObject({ rel_type: 'm.thread', event_id: rootEvent })
    // Its own answer comes back as a `message` with its user_id, and Bolt's ignoreSelf drops it.
    await new Promise((r) => setTimeout(r, 2_000))
    expect(boltLines.some((l) => l.evt === 'message' && l.event?.ts === said.ts)).toBe(false)
  }, 180_000)

  it('3. alice edits her message → Bolt gets message_changed with the new text', async () => {
    const marker = rand()
    await person.editText(room, rootEvent, `resuma a semana ${marker}`)
    const changed = await boltWait((l) => l.evt === 'message' && l.event?.subtype === 'message_changed' && JSON.stringify(l.event).includes(marker), 90_000, 'message_changed in Bolt')
    expect(changed.event).toMatchObject({
      type: 'message',
      subtype: 'message_changed',
      channel: conv,
      channel_type: 'group',
      message: { type: 'message', user: aliceU, ts: rootTs, text: `resuma a semana ${marker}` },
      previous_message: { ts: rootTs },
    })
  }, 120_000)

  it('4. the leak-scan over what Bolt received and over the sidecar log: no protocol id of anyone', () => {
    expect(boltLines.length).toBeGreaterThan(3)
    expect(idLeaks(boltLines)).toEqual([])
    const all = JSON.stringify(boltLines) + JSON.stringify(p!.lines)
    for (const raw of [agent!.userId, person.userId, room, rootEvent]) expect(all).not.toContain(raw)
    expect(idLeaks(p!.lines.map((l) => ({ ...l, ts: undefined })))).toEqual([])
  })
})
