import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ESCROW_URL, HS_URL, mintOidcSession, stackUp, startWellKnown, until, whoamiStatus } from '../support/stack'
import { evt, SIDECAR_ROOT, startSidecar, type SidecarProcess } from '../support/sidecar-process'
import { startHuman, type Human } from '../support/human'
import { idLeaks } from '../support/slack-world'
import { conversationToken, personToken } from '../../src/api/ids'

// The approval card's click over HTTP against the stack: dist/cli.js as the operator runs it, with
// `--slack-actions-url` pointing at a Bolt 5.1.0 agent with no patch in HTTP mode (test/support/bolt-http-agent.mjs:
// no Socket Mode, signingSecret = the local token, listening on a loopback port). alice (the operator) creates the
// agent and one encrypted room inviting it; the agent posts a card of two buttons in that conversation (given
// through the environment); alice decrypts it and answers by the protocol → Bolt's app.action gets the
// `block_actions` (the signature checked by Bolt itself) with the original action_id and value and her `U…` →
// respond() replaces the request → she decrypts the new text. Every Bolt line and every sidecar line goes through
// the leak-scan. The one `a-` account is deleted at the end.

const STACK = stackUp()
const rand = (): string => Math.random().toString(36).slice(2, 8)
const BOLT = join(SIDECAR_ROOT, 'test', 'support', 'bolt-http-agent.mjs')

interface BoltLine {
  evt: string
  action?: Record<string, unknown>
  ts?: string
  user?: string
  channel?: string
  message_ts?: string
  card_ts?: string
  retry_num?: number | null
  text?: string
  warnings?: string[]
}

// A loopback port the OS picked, free when this returns (Bolt listens on it after the sidecar has started).
async function freePort(): Promise<number> {
  const s = createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  const port = (s.address() as { port: number }).port
  await new Promise<void>((r) => s.close(() => r()))
  return port
}

describe.skipIf(!STACK)('sidecar ↔ stack: the approval card\'s click as a signed HTTP POST to a Bolt app in HTTP mode', () => {
  let alice: string
  let agent: { userId: string; token: string; deviceId: string } | undefined
  let removed = false
  let created = 0
  let wellKnown: Awaited<ReturnType<typeof startWellKnown>>
  let store: string
  let person: Human
  let p: SidecarProcess | undefined
  let bolt: ChildProcess | undefined
  let url = ''
  let local = ''
  let port = 0
  const boltLines: BoltLine[] = []
  let boltErr = ''
  let room = ''
  let conv = ''
  let aliceU = ''
  let cardTs = ''
  let cardEvent = ''
  const marker = rand()
  const name = `Sidecar Slack HTTP ${rand()}`

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
    aliceU = personToken(person.userId)
    wellKnown = await startWellKnown(HS_URL)
    store = await mkdtemp(join(tmpdir(), 'sidecar-slack-actions-http-it-'))
    port = await freePort()
    p = startSidecar(['--server', wellKnown.url, '--token', agent.token, '--store', store, '--slack-actions-url', `http://127.0.0.1:${port}/slack/actions`])
    url = (await p.waitFor(evt('api-listening'), 90_000)).url as string
    local = (await readFile(join(store, 'local.token'), 'utf8')).trim()
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
    process.stderr.write(`[sidecar-slack-actions-http-it] a- accounts created: ${created}, deleted: ${removed ? 1 : 0}\n`)
    expect(removed || agent === undefined).toBe(true)
    await wellKnown?.close()
    if (store !== undefined) await rm(store, { recursive: true, force: true })
  }, 60_000)

  it('1. the Bolt agent (HTTP mode) posts text + an actions block → the person decrypts a card', async () => {
    room = await person.createEncryptedRoom([agent!.userId])
    conv = conversationToken(room, false)
    await p!.waitFor((l) => l.evt === 'joined' && l.conversation === conv, 60_000)
    await person.waitForMembership(room, agent!.userId, 'join')
    bolt = spawn(process.execPath, [BOLT], {
      env: { ...process.env, SIDECAR_URL: url, SIDECAR_TOKEN: local, ACTIONS_PORT: String(port), CONVERSATION: conv, MARKER: marker },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
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
    const card = await boltWait((l) => l.evt === 'card', 90_000, 'the card posted by Bolt')
    expect(card.warnings).toEqual([])
    cardTs = card.ts as string
    const got = await person.waitForMessage((m) => m.sender === agent!.userId && m.body === `Publicar a versão ${marker}?`, 60_000)
    expect(got.wireType).toBe('m.room.encrypted')
    expect(got.content.msgtype).toBe('io.tayet.approval')
    expect(got.content['io.tayet.approval']).toEqual({
      options: [
        { id: 'b1', label: 'Aprovar', style: 'primary' },
        { id: 'b2', label: 'Rejeitar', style: 'danger' },
      ],
    })
    cardEvent = got.eventId
  }, 240_000)

  it('2. the person answers → Bolt\'s app.action gets block_actions over HTTP with the original action_id and value and her U…', async () => {
    await person.answerApproval(room, cardEvent, 'b1', 'Aprovar')
    const action = await boltWait((l) => l.evt === 'action', 90_000, 'block_actions in Bolt')
    expect(action.action).toMatchObject({ type: 'button', action_id: 'Approve.Release', block_id: 'release', value: `release-${marker}`, text: { type: 'plain_text', text: 'Aprovar' } })
    expect(action).toMatchObject({ user: aliceU, channel: conv, message_ts: cardTs, card_ts: cardTs, retry_num: null })
    await boltWait((l) => l.evt === 'responded', 60_000, 'respond() answered')
    await p!.waitFor(evt('slack-action-delivered'), 30_000)
    // No socket was involved: nothing was sent as an envelope.
    expect(p!.lines.filter((l) => l.evt === 'socket-open')).toEqual([])
  }, 180_000)

  it('3. respond() replaced the request: the person decrypts the new text; the card left the layer\'s file', async () => {
    const text = `respondido release-${marker}`
    const edit = await person.waitForEvent((e) => {
      const next = e.content['m.new_content'] as Record<string, unknown> | undefined
      return e.relation?.rel_type === 'm.replace' && e.relation.event_id === cardEvent && next?.body === text
    }, 60_000)
    expect(edit.type).toBe('m.room.message')
    await until(async () => ((JSON.parse(await readFile(join(store, 'slack-cards.json'), 'utf8')) as { cards: unknown[] }).cards.length === 0 ? true : undefined), 30_000, 'the card out of slack-cards.json')
    expect(boltErr).toBe('')
  }, 180_000)

  it('4. the leak-scan over what Bolt received and over the sidecar log: no protocol id, no token', () => {
    expect(boltLines.length).toBeGreaterThan(3)
    expect(idLeaks(boltLines)).toEqual([])
    const all = JSON.stringify(boltLines) + JSON.stringify(p!.lines)
    for (const raw of [agent!.userId, person.userId, room, cardEvent, local, agent!.token]) expect(all).not.toContain(raw)
    expect(idLeaks(p!.lines.map((l) => ({ ...l, ts: undefined })))).toEqual([])
    expect(JSON.stringify(p!.lines)).not.toContain('/slack/response/')
  })
})
