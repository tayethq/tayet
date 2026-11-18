import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { brandUserId, buildFormSubmissionContent, buildTextContent, readFormDefinition, readFormResult, submissionLabels, type FormDefinition } from '@tayet/shared/internal'
import type { FormValues } from '@tayet/shared'
import { ESCROW_URL, HS_URL, mintOidcSession, stackUp, startWellKnown, until, whoamiStatus } from '../support/stack'
import { evt, SIDECAR_ROOT, startSidecar, type SidecarProcess } from '../support/sidecar-process'
import { startHuman, type Human, type SeenEvent } from '../support/human'
import { idLeaks } from '../support/slack-world'
import { conversationToken, personToken } from '../../src/api/ids'
import { compose } from '../../src/api/slack/modal'

// An agent's forms through the Slack layer against the stack: dist/cli.js as the operator runs it, and a Bolt 5.1.0
// agent with no patch (test/support/bolt-forms-agent.mjs) that opens a modal with views.open. The person speaks the
// protocol with the shared builders and readers (the sidecar package cannot import the client).
// 1. Socket Mode, encrypted conversation: the click → views.open → the person reads the definition (trigger: her
//    answer) → a short reason → the app answers `errors` → a new submission → the app's empty ack → accepted.
// 2. Socket Mode, open channel: the command `/editar` → views.open → the same two rounds.
// 3. The 20 rounds of the measure, from the submission the server confirmed to the result the person reads:
//    one FORM_ROUNDTRIP line, no assertion of time.
// 4. HTTP (`--slack-actions-url`, the HTTP receiver with processBeforeResponse), the same encrypted conversation
//    after a restart of the sidecar on the same store: the click and the submission as signed POSTs.
// 5. The leak-scan over what Bolt received and over both logs.
// Two rooms (the stack's createRoom limit is shared); one `a-` account per run, deleted at the end.

const STACK = stackUp()
const rand = (): string => Math.random().toString(36).slice(2, 8)
const BOLT = join(SIDECAR_ROOT, 'test', 'support', 'bolt-forms-agent.mjs')
const WHY = compose('why', 'why_input')
const ROUNDS = 20

interface BoltLine {
  evt: string
  origin?: string
  error?: string
  ts?: string
  values?: Record<string, Record<string, Record<string, unknown>>>
  meta?: string
  user?: string
  view_id?: string
  private_metadata?: string
  ms?: number
}

async function freePort(): Promise<number> {
  const s = createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  const port = (s.address() as { port: number }).port
  await new Promise<void>((r) => s.close(() => r()))
  return port
}

describe.skipIf(!STACK)('sidecar forms ↔ stack: views.open and view_submission through Bolt, over the sockets and over HTTP', () => {
  let alice: string
  let agent: { userId: string; token: string; deviceId: string } | undefined
  let removed = false
  let created = 0
  let wellKnown: Awaited<ReturnType<typeof startWellKnown>>
  let store: string
  let manifestDir: string
  let manifest = ''
  let person: Human
  const runs: SidecarProcess[] = []
  let p: SidecarProcess | undefined
  let bolt: ChildProcess | undefined
  let url = ''
  let local = ''
  const boltLines: BoltLine[] = []
  let boltErr = ''
  let room = ''
  let conv = ''
  let channel = ''
  let cardEvent = ''
  let cardDef: { id: string; definition: FormDefinition } | undefined
  const marker = rand()
  const name = `Sidecar Slack Forms ${rand()}`

  const escrow = (method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${ESCROW_URL}/v1/agents${path}`, {
      method,
      headers: { Authorization: `Bearer ${alice}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  const boltWait = (pred: (l: BoltLine) => boolean, timeoutMs: number, what: string): Promise<BoltLine> => until(() => boltLines.find(pred), timeoutMs, what)
  const lines = (evtName: string) => p!.lines.filter((l) => l.evt === evtName)

  const startBolt = async (env: Record<string, string>): Promise<void> => {
    const from = boltLines.length
    bolt = spawn(process.execPath, [BOLT], { env: { ...process.env, SIDECAR_URL: url, SIDECAR_TOKEN: local, CONVERSATION: conv, MARKER: marker, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
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
    await until(() => boltLines.slice(from).find((l) => l.evt === 'started'), 60_000, 'Bolt started')
  }
  const stopBolt = async (): Promise<void> => {
    if (bolt === undefined || bolt.exitCode !== null) return
    const exited = new Promise((r) => bolt!.once('exit', r))
    bolt.kill('SIGTERM')
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))])
    if (bolt.exitCode === null) bolt.kill('SIGKILL')
  }
  const startRun = async (extra: string[]): Promise<void> => {
    p = startSidecar(['--server', wellKnown.url, '--token', agent!.token, '--store', store, '--slack-manifest', manifest, ...extra])
    runs.push(p)
    url = (await p.waitFor(evt('api-listening'), 90_000)).url as string
    local = (await readFile(join(store, 'local.token'), 'utf8')).trim()
  }

  const formEvent = (anchor: string, msgtype: string, pred: (e: SeenEvent) => boolean = () => true) =>
    person.waitForEvent((e) => e.relation?.rel_type === 'io.tayet.form' && e.relation.event_id === anchor && e.content.msgtype === msgtype && pred(e), 60_000)
  // The definition the person's client opens: from the agent, for the trigger this person sent.
  const definitionFor = async (anchor: string, trigger: string): Promise<{ id: string; definition: FormDefinition }> => {
    const def = await formEvent(anchor, 'io.tayet.form', (e) => readFormDefinition(e.content)?.trigger === trigger)
    expect(def.sender).toBe(agent!.userId)
    return { id: def.eventId, definition: readFormDefinition(def.content)! }
  }
  // A submission, then the result the person reads; the time from the server's confirmation to that read.
  const submit = async (where: string, anchor: string, form: { id: string; definition: FormDefinition }, values: FormValues) => {
    const content = buildFormSubmissionContent(anchor, form.id, form.definition.title, values, submissionLabels(form.definition.fields, values))
    const id = await person.sendContent(where, content)
    const confirmed = performance.now()
    const res = await formEvent(anchor, 'io.tayet.form.result', (e) => readFormResult(e.content)?.submission === id)
    return { id, result: readFormResult(res.content), ms: performance.now() - confirmed, sender: res.sender }
  }
  // The two rounds of a form: a short reason → errors on the reason; a long one → accepted.
  const twoRounds = async (where: string, anchor: string, form: { id: string; definition: FormDefinition }, origin: string) => {
    expect(form.definition).toMatchObject({ title: 'Editar decisão', submitLabel: 'Salvar' })
    expect(form.definition.fields.map((f) => f.kind)).toEqual(['context', 'longText', 'radio'])
    const before = boltLines.filter((l) => l.evt === 'submission').length
    const first = await submit(where, anchor, form, { [WHY]: 'Não' })
    expect(first.sender).toBe(agent!.userId)
    expect(first.result).toEqual({ submission: first.id, errors: { [WHY]: 'Escreva mais.' } })
    const second = await submit(where, anchor, form, { [WHY]: `Porque o prazo mudou ${marker}`, [compose('level', 'pick')]: 'high' })
    expect(second.result).toEqual({ submission: second.id, ok: true })
    const seen = boltLines.filter((l) => l.evt === 'submission').slice(before)
    expect(seen).toHaveLength(2)
    expect(seen[1]).toMatchObject({
      values: { why: { why_input: { type: 'plain_text_input', value: `Porque o prazo mudou ${marker}` } }, level: { pick: { type: 'radio_buttons', selected_option: { value: 'high' } } } },
      meta: JSON.stringify({ origin, marker }),
      user: personToken(person.userId),
    })
  }

  beforeAll(async () => {
    alice = (await mintOidcSession('alice', 'alicepass123')).accessToken
    const res = await escrow('POST', '', { name })
    expect(res.status).toBe(201)
    agent = (await res.json()) as NonNullable<typeof agent>
    created++
    person = await startHuman(alice)
    wellKnown = await startWellKnown(HS_URL)
    store = await mkdtemp(join(tmpdir(), 'sidecar-slack-forms-it-'))
    manifestDir = await mkdtemp(join(tmpdir(), 'sidecar-slack-forms-manifest-it-'))
    manifest = join(manifestDir, 'manifest.json')
    await writeFile(manifest, JSON.stringify({ display_information: { name: 'Forms bot' }, features: { slash_commands: [{ command: '/editar', description: 'Editar a decisão' }] }, settings: { socket_mode_enabled: true } }))
    await startRun([])
    room = await person.createEncryptedRoom([agent.userId])
    conv = conversationToken(room, false)
    await p!.waitFor((l) => l.evt === 'joined' && l.conversation === conv, 60_000)
    await person.waitForMembership(room, agent.userId, 'join')
    await startBolt({ MODE: 'socket' })
  }, 240_000)

  afterAll(async () => {
    await stopBolt()
    await p?.stop()
    person?.stop()
    if (agent !== undefined && !removed) {
      const del = await escrow('DELETE', `/${encodeURIComponent(agent.userId)}`)
      if (del.status < 300) {
        await until(async () => ((await whoamiStatus(agent!.token)) === 401 ? true : undefined), 30_000, 'whoami 401 after DELETE')
        removed = true
      }
    }
    process.stderr.write(`[sidecar-slack-forms-it] a- accounts created: ${created}, deleted: ${removed ? 1 : 0}\n`)
    expect(removed || agent === undefined).toBe(true)
    await wellKnown?.close()
    if (store !== undefined) await rm(store, { recursive: true, force: true })
    if (manifestDir !== undefined) await rm(manifestDir, { recursive: true, force: true })
  }, 60_000)

  it('1. Socket Mode, encrypted conversation: the click opens the form; errors, then accepted', async () => {
    const card = await person.waitForMessage((m) => m.sender === agent!.userId && m.body === `Mudar a decisão ${marker}?`, 90_000)
    expect(card.wireType).toBe('m.room.encrypted')
    cardEvent = card.eventId
    const answer = await person.answerApproval(room, cardEvent, 'b1', 'Editar')
    const opened = await boltWait((l) => l.evt === 'opened' || l.evt === 'open-failed', 60_000, 'views.open in Bolt')
    expect(opened).toMatchObject({ evt: 'opened', origin: 'card', private_metadata: JSON.stringify({ origin: 'card', marker }) })
    cardDef = await definitionFor(cardEvent, answer)
    await twoRounds(room, cardEvent, cardDef, 'card')
    expect(lines('view-opened')).toEqual([{ evt: 'view-opened', origin: 'card' }])
    expect(lines('view-submission-answered').map((l) => l.outcome)).toEqual(['errors', 'ok'])
  }, 240_000)

  it('2. Socket Mode, open channel: the command opens the form; errors, then accepted', async () => {
    channel = await person.createPublicChannel()
    await person.invite(channel, agent!.userId)
    await p!.waitFor((l) => l.evt === 'joined' && l.conversation === conversationToken(channel, false), 60_000)
    await person.waitForMembership(channel, agent!.userId, 'join')
    await until(async () => ((await person.readCommands(channel, agent!.userId)).shown?.block?.commands?.length === 1 ? true : undefined), 90_000, 'the manifest in the channel')
    const command = await person.sendContent(channel, buildTextContent(`/editar ${marker}`, undefined, [brandUserId(agent!.userId)], undefined, { name: 'editar', agent: brandUserId(agent!.userId) }))
    const opened = await boltWait((l) => (l.evt === 'opened' || l.evt === 'open-failed') && l.origin === 'command', 60_000, 'views.open from the command')
    expect(opened).toMatchObject({ evt: 'opened' })
    const form = await definitionFor(command, command)
    await twoRounds(channel, command, form, 'command')
  }, 240_000)

  it(`3. ${ROUNDS} rounds, from the submission the server confirmed to the result the person reads`, async () => {
    const times: number[] = []
    for (let i = 1; i <= ROUNDS; i++) {
      const r = await submit(room, cardEvent, cardDef!, { [WHY]: `round ${i} ${marker}` })
      expect(r.result).toEqual({ submission: r.id, errors: { [WHY]: 'Escreva mais.' } })
      times.push(r.ms)
    }
    const sorted = [...times].sort((a, b) => a - b)
    const p50 = sorted[Math.floor((sorted.length - 1) / 2)] as number
    process.stderr.write(`FORM_ROUNDTRIP n=${times.length} p50_ms=${Math.round(p50)} max_ms=${Math.round(sorted.at(-1) as number)}\n`)
  }, 600_000)

  it('4. HTTP: after a restart with --slack-actions-url, the click and the submission as signed POSTs', async () => {
    await stopBolt()
    await p!.stop()
    const port = await freePort()
    await startRun(['--slack-actions-url', `http://127.0.0.1:${port}/slack/actions`])
    const from = boltLines.length
    await startBolt({ MODE: 'http', ACTIONS_PORT: String(port), MARKER: `${marker}-http` })
    const posted = await until(() => boltLines.slice(from).find((l) => l.evt === 'card'), 90_000, 'the second card')
    const card = await person.waitForMessage((m) => m.sender === agent!.userId && m.body === `Mudar a decisão ${marker}-http?`, 90_000)
    expect(posted.ts).toBeDefined()
    const answer = await person.answerApproval(room, card.eventId, 'b1', 'Editar')
    // views.open answers once the server accepted the definition. Under the send limit that can pass the 3 s in
    // which Bolt's HTTP receiver answers: the click is then sent again, and that run's views.open finds the
    // trigger_id in use (exchanged_trigger_id) while the first one opens the form. That case only, and logged.
    await until(() => boltLines.slice(from).find((l) => l.evt === 'opened'), 60_000, 'views.open over HTTP')
    const opens = boltLines.slice(from).filter((l) => l.evt === 'opened' || l.evt === 'open-failed')
    process.stderr.write(`[sidecar-slack-forms-it] views.open over HTTP ${JSON.stringify(opens.map((l) => ({ evt: l.evt, error: l.error, ms: l.ms })))} retried ${lines('slack-action-retried').length} limited ${lines('send-ratelimited').length}\n`)
    const retried = lines('slack-action-retried').length > 0
    expect(opens.filter((l) => l.evt === 'opened')).toHaveLength(1)
    expect(opens.filter((l) => l.evt === 'open-failed').map((l) => l.error)).toEqual(retried ? opens.filter((l) => l.evt === 'open-failed').map(() => 'exchanged_trigger_id') : [])
    const form = await definitionFor(card.eventId, answer)
    const before = boltLines.filter((l) => l.evt === 'submission').length
    const first = await submit(room, card.eventId, form, { [WHY]: 'Não' })
    expect(first.result).toEqual({ submission: first.id, errors: { [WHY]: 'Escreva mais.' } })
    const second = await submit(room, card.eventId, form, { [WHY]: `Porque o prazo mudou ${marker}` })
    expect(second.result).toEqual({ submission: second.id, ok: true })
    expect(boltLines.filter((l) => l.evt === 'submission').slice(before).map((l) => l.meta)).toEqual([JSON.stringify({ origin: 'card', marker: `${marker}-http` }), JSON.stringify({ origin: 'card', marker: `${marker}-http` })])
    expect(lines('socket-open')).toEqual([])
    expect(lines('slack-action-delivered').length).toBeGreaterThan(0)
    expect(lines('view-submission-answered').map((l) => l.outcome)).toEqual(['errors', 'ok'])
  }, 300_000)

  it('5. the leak-scan over what Bolt received and over both logs: no protocol id, no token, no content in a line', () => {
    // Bolt's own warning of the case described in 4 (a click answered after its 3 s), and nothing else.
    expect(boltErr.split('\n').filter((l) => l.trim() !== '' && !l.includes('not acknowledged within 3 seconds'))).toEqual([])
    expect(boltLines.filter((l) => l.evt === 'open-failed' && l.error !== 'exchanged_trigger_id')).toEqual([])
    expect(idLeaks(boltLines)).toEqual([])
    const logs = runs.flatMap((r) => r.lines)
    const all = JSON.stringify(boltLines) + JSON.stringify(logs)
    for (const raw of [agent!.userId, person.userId, room, channel, cardEvent, local, agent!.token]) expect(all).not.toContain(raw)
    expect(idLeaks(logs.map((l) => ({ ...l, ts: undefined })))).toEqual([])
    const log = JSON.stringify(logs)
    for (const word of ['/slack/response/', 'Porque o prazo', 'Curto', 'Escreva mais', 'Editar decisão', 'Motivo', `"origin":"card","marker"`]) expect(log).not.toContain(word)
    expect(logs.filter((l) => l.evt === 'leak-blocked')).toEqual([])
  })
})
