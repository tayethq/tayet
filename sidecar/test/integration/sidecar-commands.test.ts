import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ESCROW_URL, HS_URL, mintOidcSession, stackUp, startWellKnown, until } from '../support/stack'
import { evt, startSidecar, type SidecarProcess } from '../support/sidecar-process'
import { startHuman, type CommandsRead, type Human } from '../support/human'
import { conversationToken } from '../../src/api/ids'
import type { ApiCommandsStatus, ApiMessage } from '../../src/api/contract'
import { buildPanelContent, buildPanelEditContent, buildTextContent } from '@tayet/shared/internal'
import type { UserId } from '@tayet/shared'

// A4-2a against the stack (ADR-093, Proposto; PLANO-AGENTES §0.3.22): the agent declares its commands through
// PUT/DELETE /v1/commands of dist/cli.js; the person reads the manifest BY THE PROTOCOL — the anchor's
// relations of the commands' type, decrypted, with readCommandsBlock (support/human.ts `readCommands`). 1. PUT →
// the person reads the manifest in the conversation; 2. a new PUT → an edit of the same message; 3. a second
// person joins → the re-edit lets her decrypt it; 4. DELETE → the clear mark. A4-2b (§0.3.23), on the SSE of the
// local API: 5. the person sends a declared command (buildTextContent with the command) → message.received and
// mention carry `command`; 6. a name outside the set → a mention without `command`; 7. the person edits the
// command → message.edited without `command`; 8. another agent edits its own panel → no message.edited (a
// person's message after it is the barrier: the live events are emitted in arrival order). ONE encrypted room;
// two `a-` accounts per run are left deactivated on the stack.

interface Frame {
  event?: string
  data?: Record<string, unknown>
}

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
          if (line.startsWith('event: ')) f.event = line.slice(7)
          else if (line.startsWith('data: ')) f.data = JSON.parse(line.slice(6)) as Record<string, unknown>
        }
        if (f.event !== undefined) frames.push(f)
      }
    }
  })().catch(() => {})
  return { frames, done, close: () => ctrl.abort() }
}

const STACK = stackUp()
const rand = (): string => Math.random().toString(36).slice(2, 8)

describe.skipIf(!STACK)('sidecar A4-2a ↔ stack: commands (§0.3.22)', () => {
  let alice: string
  let agent: { userId: string; token: string } | undefined
  let wellKnown: Awaited<ReturnType<typeof startWellKnown>>
  let store: string
  let person: Human
  let second: Human | undefined
  let other: { userId: string; token: string } | undefined
  let otherHuman: Human | undefined
  let stream: ReturnType<typeof openEvents> | undefined
  let p: SidecarProcess | undefined
  let url = ''
  let local = ''
  let room = ''
  let conv = ''

  const escrow = (method: string, path: string, body?: unknown): Promise<Response> =>
    fetch(`${ESCROW_URL}/v1/agents${path}`, {
      method,
      headers: { Authorization: `Bearer ${alice}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(url + path, {
      method,
      headers: { authorization: `Bearer ${local}`, ...(body !== undefined && { 'content-type': 'application/json' }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
    const text = await res.text()
    return { status: res.status, json: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown> }
  }
  const status = async (): Promise<ApiCommandsStatus> => (await call('GET', '/v1/commands')).json as unknown as ApiCommandsStatus
  const readUntil = (who: Human, pred: (r: CommandsRead) => boolean, what: string, ms = 60_000): Promise<CommandsRead> =>
    until(async () => {
      const r = await who.readCommands(room, agent!.userId)
      return pred(r) ? r : undefined
    }, ms, what)
  const idle = (): Promise<true> => until(async () => ((await status()).pending === 0 ? true : undefined), 60_000, 'nothing pending')
  const names = (r: CommandsRead): string[] => (r.shown?.block?.commands ?? []).map((c) => c.name)

  beforeAll(async () => {
    alice = (await mintOidcSession('alice', 'alicepass123')).accessToken
    const res = await escrow('POST', '', { name: `Sidecar Commands ${rand()}` })
    expect(res.status).toBe(201)
    agent = (await res.json()) as { userId: string; token: string }
    person = await startHuman(alice)
    wellKnown = await startWellKnown(HS_URL)
    store = await mkdtemp(join(tmpdir(), 'sidecar-commands-it-'))
    p = startSidecar(['--server', wellKnown.url, '--token', agent.token, '--store', store])
    url = (await p.waitFor(evt('api-listening'), 90_000)).url as string
    local = (await readFile(join(store, 'local.token'), 'utf8')).trim()
    room = await person.createEncryptedRoom([agent.userId])
    conv = conversationToken(room, false)
    await p.waitFor((l) => l.evt === 'joined' && l.conversation === conv, 60_000)
    await person.waitForMembership(room, agent.userId, 'join')
    await until(async () => ((await call('GET', `/v1/conversations/${conv}`)).status === 200 ? true : undefined), 30_000, 'the conversation')
  }, 240_000)

  afterAll(async () => {
    stream?.close()
    await p?.stop()
    person?.stop()
    second?.stop()
    otherHuman?.stop()
    if (agent !== undefined) await escrow('DELETE', `/${encodeURIComponent(agent.userId)}`)
    if (other !== undefined) await escrow('DELETE', `/${encodeURIComponent(other.userId)}`)
    await wellKnown?.close()
    if (store !== undefined) await rm(store, { recursive: true, force: true })
  }, 60_000)

  it('1. PUT → 202 { pending: 1 }; the person reads the manifest in the conversation', async () => {
    const commands = [
      { name: 'deploy', description: 'Publicar o build', hint: '<ambiente>' },
      { name: 'status', description: 'O estado do deploy' },
    ]
    const put = await call('PUT', '/v1/commands', { commands })
    expect([put.status, put.json]).toEqual([202, { pending: 1 }])
    const read = await readUntil(person, (r) => names(r).length === 2, 'the manifest')
    expect(read).toMatchObject({ messages: 1, edits: 0, shown: { block: { commands, cleared: false } } })
    expect(read.shown!.body).toBe('/deploy — Publicar o build\n/status — O estado do deploy')
    await idle()
    expect(await status()).toEqual({ commands, pending: 0 })
  }, 120_000)

  it('2. a new PUT → an edit of the same message', async () => {
    const put = await call('PUT', '/v1/commands', { commands: [{ name: 'rollback', description: 'Voltar a versão' }] })
    expect(put.status).toBe(202)
    const read = await readUntil(person, (r) => names(r).join() === 'rollback', 'the edited manifest', 90_000)
    expect(read.messages).toBe(1)
    expect(read.edits).toBe(1)
    await idle()
  }, 150_000)

  it('3. a second person joins → within ~25 s she decrypts the manifest (the re-edit)', async () => {
    second = await startHuman((await mintOidcSession('bob', 'bobpass123')).accessToken)
    await person.invite(room, second.userId)
    await until(async () => second!.join(room).then(() => true, () => undefined), 30_000, 'bob joins')
    const t0 = Date.now()
    const read = await readUntil(second, (r) => names(r).join() === 'rollback', 'the re-edited manifest for the second person', 40_000)
    const ms = Date.now() - t0
    process.stderr.write(`commands-metric ${JSON.stringify({ step: 3, reeditMs: ms })}\n`)
    expect(ms).toBeLessThanOrEqual(25_000)
    expect(read.messages).toBe(1)
  }, 150_000)

  it('4. DELETE → 202; the manifest carries the clear mark; GET answers an empty set; a second DELETE → 204', async () => {
    await idle()
    const del = await call('DELETE', '/v1/commands')
    expect([del.status, del.json]).toEqual([202, { pending: 1 }])
    const read = await readUntil(person, (r) => r.shown?.block?.cleared === true, 'the cleared manifest', 60_000)
    expect(read.shown!.body).toBe('')
    expect(read.messages).toBe(1)
    await idle()
    expect(await status()).toEqual({ commands: [], pending: 0 })
    expect((await call('DELETE', '/v1/commands')).status).toBe(204)
  }, 120_000)

  // A4-2b (§0.3.23): what reaches the agent's SSE.
  const sendCommand = (text: string, name: string): Promise<string> =>
    person.sendContent(room, buildTextContent(text, undefined, undefined, undefined, { name, agent: agent!.userId as unknown as UserId }))
  const frameOf = (event: string, text: string, ms = 60_000): Promise<ApiMessage> =>
    until(() => stream!.frames.find((f) => f.event === event && (f.data?.message as ApiMessage | undefined)?.text === text)?.data?.message as ApiMessage | undefined, ms, `${event} of the text`)

  it('5. the person sends a declared command → message.received and mention carry { name, args }', async () => {
    const put = await call('PUT', '/v1/commands', { commands: [{ name: 'deploy', description: 'Publicar o build', hint: '<ambiente>' }] })
    expect(put.status).toBe(202)
    await idle()
    stream = openEvents(url, local)
    await sendCommand('/deploy produção', 'deploy')
    for (const event of ['message.received', 'mention']) {
      const m = await frameOf(event, '/deploy produção')
      expect(m.command).toEqual({ name: 'deploy', args: 'produção' })
      expect(m.mentionsMe).toBe(true)
    }
  }, 150_000)

  it('6. a name outside the declared set → a mention without command', async () => {
    await sendCommand('/rollback agora', 'rollback')
    const m = await frameOf('mention', '/rollback agora')
    expect(m.command).toBeUndefined()
    expect((await frameOf('message.received', '/rollback agora')).command).toBeUndefined()
    await p!.waitFor(evt('command-unknown'), 30_000)
  }, 120_000)

  it('7. the person edits the command → message.edited without command', async () => {
    const id = await sendCommand('/deploy homologação', 'deploy')
    expect((await frameOf('mention', '/deploy homologação')).command).toEqual({ name: 'deploy', args: 'homologação' })
    await person.editText(room, id, '/deploy staging')
    const edited = await frameOf('message.edited', '/deploy staging')
    expect(edited.command).toBeUndefined()
  }, 120_000)

  it('8. another agent edits its own panel → no message.edited reaches the agent', async () => {
    const res = await escrow('POST', '', { name: `Sidecar Commands Other ${rand()}` })
    expect(res.status).toBe(201)
    other = (await res.json()) as { userId: string; token: string }
    otherHuman = await startHuman(other.token)
    await person.invite(room, other.userId)
    await until(async () => otherHuman!.join(room).then(() => true, () => undefined), 30_000, 'the other agent joins')
    await until(() => otherHuman!.createEventOf(room), 30_000, 'the creation event')
    const panel = await otherHuman.sendContent(room, buildPanelContent('Estado: ok', undefined, 'Painel', otherHuman.createEventOf(room)!))
    await otherHuman.sendContent(room, buildPanelEditContent({ text: 'Estado: falhou', title: 'Painel' }, panel))
    // The barrier: a person's message after the edit.
    await person.sendText(room, 'barreira A4-2b')
    await frameOf('message.received', 'barreira A4-2b')
    // The only message.edited since step 5 is the person's edit of step 7.
    expect(stream!.frames.filter((f) => f.event === 'message.edited').map((f) => (f.data?.message as ApiMessage | undefined)?.text)).toEqual(['/deploy staging'])
    // Nor did the panel become a message.
    expect(stream!.frames.filter((f) => (f.data?.message as ApiMessage | undefined)?.text?.startsWith('Estado:') === true)).toEqual([])
  }, 180_000)
})
