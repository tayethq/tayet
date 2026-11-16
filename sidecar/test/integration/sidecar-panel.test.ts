import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ESCROW_URL, HS_URL, mintOidcSession, stackUp, startWellKnown, until } from '../support/stack'
import { evt, startSidecar, type SidecarProcess } from '../support/sidecar-process'
import { startHuman, type Human, type PanelRead } from '../support/human'
import { conversationToken } from '../../src/api/ids'
import type { ApiMessageList, ApiPanelStatus } from '../../src/api/contract'

// A3-6 against the stack (ADR-091, Proposto, dec. 13; PLANO-AGENTES §0.3.16 items 15–17): the agent writes its
// pinned panel through PUT/DELETE /v1/conversations/:id/panel of dist/cli.js; the person reads it BY THE
// PROTOCOL — the anchor's relations, decrypted, with readPanelBlock (support/human.ts `readPanel`). 1. the
// panel arrives with its title and no new row in the agent's timeline; 2. three PUTs in a row → only the last
// version arrives, in at most two writes; 3. a second person joins → the re-edit lets her decrypt it; 4. DELETE
// → the clear mark, GET `panel: null`; 5. the sidecar restarts and takes a PUT → still ONE panel message of the
// agent (nothing at rest: found again through the anchor). ONE encrypted room; one `a-` account per run is
// left deactivated on the stack.

const STACK = stackUp()
const rand = (): string => Math.random().toString(36).slice(2, 8)

describe.skipIf(!STACK)('sidecar A3-6 ↔ stack: pinned panel (§0.3.16 items 15–17)', () => {
  let alice: string
  let agent: { userId: string; token: string } | undefined
  let wellKnown: Awaited<ReturnType<typeof startWellKnown>>
  let store: string
  let person: Human
  let second: Human | undefined
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
  const panel = (): string => `/v1/conversations/${conv}/panel`
  const boot = async (): Promise<void> => {
    p = startSidecar(['--server', wellKnown.url, '--token', agent!.token, '--store', store])
    url = (await p.waitFor(evt('api-listening'), 90_000)).url as string
    local = (await readFile(join(store, 'local.token'), 'utf8')).trim()
  }
  const status = async (): Promise<ApiPanelStatus> => (await call('GET', panel())).json as unknown as ApiPanelStatus
  // The person's reading until it matches (keys may arrive after the event).
  const readUntil = (who: Human, pred: (r: PanelRead) => boolean, what: string, ms = 60_000): Promise<PanelRead> =>
    until(async () => {
      const r = await who.readPanel(room, agent!.userId)
      return pred(r) ? r : undefined
    }, ms, what)
  const idle = (): Promise<true> => until(async () => ((await status()).pending ? undefined : true), 60_000, 'nothing pending')

  beforeAll(async () => {
    alice = (await mintOidcSession('alice', 'alicepass123')).accessToken
    const res = await escrow('POST', '', { name: `Sidecar Panel ${rand()}` })
    expect(res.status).toBe(201)
    agent = (await res.json()) as { userId: string; token: string }
    person = await startHuman(alice)
    wellKnown = await startWellKnown(HS_URL)
    store = await mkdtemp(join(tmpdir(), 'sidecar-panel-it-'))
    await boot()
    room = await person.createEncryptedRoom([agent.userId])
    conv = conversationToken(room, false)
    await p!.waitFor((l) => l.evt === 'joined' && l.conversation === conv, 60_000)
    await person.waitForMembership(room, agent.userId, 'join')
    await until(async () => ((await call('GET', `/v1/conversations/${conv}`)).status === 200 ? true : undefined), 30_000, 'the conversation')
  }, 240_000)

  afterAll(async () => {
    await p?.stop()
    person?.stop()
    second?.stop()
    if (agent !== undefined) await escrow('DELETE', `/${encodeURIComponent(agent.userId)}`)
    await wellKnown?.close()
    if (store !== undefined) await rm(store, { recursive: true, force: true })
  }, 60_000)

  it('1. PUT → 202; the person reads the title and the body; the agent’s timeline gains no row', async () => {
    const before = ((await call('GET', `/v1/conversations/${conv}/messages`)).json as unknown as ApiMessageList).messages.length
    const text = `Build **verde** ${rand()}`
    const put = await call('PUT', panel(), { text, markdown: true, title: 'Estado do deploy' })
    expect([put.status, put.json]).toEqual([202, { conversation: conv, pending: true }])
    const read = await readUntil(person, (r) => r.shown?.body === text, 'the panel')
    expect(read).toMatchObject({ messages: 1, edits: 0, shown: { block: { title: 'Estado do deploy', cleared: false } } })
    await idle()
    expect(await status()).toEqual({ conversation: conv, panel: { title: 'Estado do deploy', text, updatedAt: read.shown!.at }, pending: false })
    const after = ((await call('GET', `/v1/conversations/${conv}/messages`)).json as unknown as ApiMessageList).messages.length
    expect(after).toBe(before)
  }, 120_000)

  it('2. three PUTs in a row → only the last version arrives, in at most two writes', async () => {
    const start = await person.readPanel(room, agent!.userId)
    const writesBefore = start.messages + start.edits
    const v = [1, 2, 3].map((n) => `versão ${n} ${rand()}`)
    for (const text of v) expect((await call('PUT', panel(), { text })).status).toBe(202)
    const read = await readUntil(person, (r) => r.shown?.body === v[2], 'the last version', 90_000)
    await idle()
    const final = await person.readPanel(room, agent!.userId)
    const writes = final.messages + final.edits - writesBefore
    process.stderr.write(`panel-metric ${JSON.stringify({ step: 2, writes })}\n`)
    expect(writes).toBeGreaterThanOrEqual(1)
    expect(writes).toBeLessThanOrEqual(2)
    expect(read.messages).toBe(1)
    // The middle version never reached the server.
    expect(final.bodies).not.toContain(v[1])
  }, 150_000)

  it('3. a second person joins → within ~25 s she decrypts the panel (the re-edit)', async () => {
    const shown = (await person.readPanel(room, agent!.userId)).shown!.body
    second = await startHuman((await mintOidcSession('bob', 'bobpass123')).accessToken)
    await person.invite(room, second.userId)
    await until(async () => second!.join(room).then(() => true, () => undefined), 30_000, 'bob joins')
    const t0 = Date.now()
    const read = await readUntil(second, (r) => r.shown?.body === shown, 'the re-edited panel for the second person', 40_000)
    const ms = Date.now() - t0
    process.stderr.write(`panel-metric ${JSON.stringify({ step: 3, reeditMs: ms })}\n`)
    expect(ms).toBeLessThanOrEqual(25_000)
    expect(read.messages).toBe(1)
    expect(read.shown!.block).toMatchObject({ cleared: false })
  }, 150_000)

  it('4. DELETE → 202; the panel carries the clear mark; GET answers `panel: null`; a second DELETE → 204', async () => {
    await idle()
    const del = await call('DELETE', panel())
    expect([del.status, del.json]).toEqual([202, { conversation: conv, pending: true }])
    const read = await readUntil(person, (r) => r.shown?.block?.cleared === true, 'the cleared panel', 60_000)
    expect(read.shown!.body).toBe('')
    await idle()
    expect(await status()).toEqual({ conversation: conv, panel: null, pending: false })
    expect((await call('DELETE', panel())).status).toBe(204)
  }, 120_000)

  it('5. the sidecar restarts and takes a PUT → still ONE panel message of the agent', async () => {
    expect(await p!.stop()).toBe(0)
    await boot()
    await until(async () => ((await call('GET', `/v1/conversations/${conv}`)).status === 200 ? true : undefined), 60_000, 'the conversation after the restart')
    const text = `depois do reinício ${rand()}`
    expect((await call('PUT', panel(), { text, title: 'De volta' })).status).toBe(202)
    const read = await readUntil(person, (r) => r.shown?.body === text, 'the panel after the restart', 60_000)
    expect(read.messages).toBe(1)
    expect(read.shown!.block).toEqual({ title: 'De volta', cleared: false })
  }, 180_000)
})
