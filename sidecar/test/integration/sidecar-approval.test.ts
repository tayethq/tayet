import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ESCROW_URL, HS_URL, mintOidcSession, stackUp, startWellKnown, until } from '../support/stack'
import { evt, startSidecar, type SidecarProcess } from '../support/sidecar-process'
import { startHuman, type Human } from '../support/human'
import { conversationToken, personToken } from '../../src/api/ids'
import type { ApiApprovalStatus, ApiMessage } from '../../src/api/contract'

// A3-3 against the stack (ADR-091, Proposto; PLANO-AGENTES §0.3.16 items 6, 7, 12): the agent asks through
// POST /v1/conversations/:id/approvals of dist/cli.js; the person answers BY THE PROTOCOL (the shared
// builder, as the client's answerApproval) → `approval.answered` with the option and the person, and the
// card sealed (the person sees the agent's closing edit; GET state → answered). Another agent's answer is
// ignored (log, no event). The sidecar stops, the person answers, the sidecar comes back and emits (the
// open cards live in <store>/approvals.json); a stream opened after that boot gets the event (A3-3b). The agent closes a card a person has just answered: the close
// answers `answered`, the event goes out once — whether the watch or the close's own read gets there first
// (the sidecar reaches the client's conclusion, §8.33). ONE encrypted room (the stack's createRoom limit is shared);
// two `a-` accounts per run are left deactivated on the stack.

const STACK = stackUp()
const rand = (): string => Math.random().toString(36).slice(2, 8)
const OPTIONS = [
  { id: 'approve', label: 'Aprovar', style: 'primary' },
  { id: 'reject', label: 'Rejeitar', style: 'danger' },
]

interface Frame {
  event?: string
  data?: Record<string, unknown>
}

// Minimal SSE reader (a copy of the S-c2 file's).
function openEvents(url: string, token: string) {
  const frames: Frame[] = []
  const ctrl = new AbortController()
  void (async () => {
    const res = await fetch(`${url}/v1/events`, { headers: { authorization: `Bearer ${token}` }, signal: ctrl.signal })
    const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader()
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
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
  return { frames, close: () => ctrl.abort() }
}

describe.skipIf(!STACK)('sidecar A3-3 ↔ stack: approval card, answered event, seal (§0.3.16)', () => {
  let alice: string
  const agents: Array<{ userId: string; token: string }> = []
  let wellKnown: Awaited<ReturnType<typeof startWellKnown>>
  let store: string
  let person: Human
  let otherAgent: Human
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
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(url + path, {
      method,
      headers: { authorization: `Bearer ${local}`, ...(body !== undefined && { 'content-type': 'application/json' }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
    const text = await res.text()
    return { status: res.status, json: (text === '' ? {} : JSON.parse(text)) as Record<string, unknown> }
  }
  const approvals = (): string => `/v1/conversations/${conv}/approvals`
  const boot = async (withStream = true): Promise<void> => {
    p = startSidecar(['--server', wellKnown.url, '--token', agents[0]!.token, '--store', store])
    url = (await p.waitFor(evt('api-listening'), 90_000)).url as string
    local = (await readFile(join(store, 'local.token'), 'utf8')).trim()
    if (withStream) stream = openEvents(url, local)
  }
  const answered = (id: string): Promise<Record<string, unknown>> =>
    until(() => stream!.frames.find((f) => f.event === 'approval.answered' && f.data?.id === id)?.data, 60_000, 'approval.answered on the stream')
  // The agent's seal, as the person sees it: an edit of the card carrying the closing mark.
  const sealOf = (card: string) =>
    person.waitForEvent((e) => {
      const rel = e.relation
      const next = e.content['m.new_content'] as Record<string, unknown> | undefined
      const block = next?.['io.tayet.approval'] as { closed?: unknown } | undefined
      return rel?.rel_type === 'm.replace' && rel.event_id === card && block?.closed === true
    }, 60_000)
  const ask = async (text: string): Promise<{ ts: string; card: string }> => {
    const r = await call('POST', approvals(), { text, options: OPTIONS })
    expect(r.status).toBe(200)
    const msg = r.json as unknown as ApiMessage
    expect(msg).toMatchObject({ conversation: conv, author: personToken(agents[0]!.userId), text, approval: { options: OPTIONS, state: 'open' } })
    const got = await person.waitForMessage((m) => m.body === text)
    expect(got.wireType).toBe('m.room.encrypted')
    expect(got.content.msgtype).toBe('io.tayet.approval')
    expect(got.content['io.tayet.approval']).toEqual({ options: OPTIONS })
    return { ts: msg.id, card: got.eventId }
  }

  beforeAll(async () => {
    alice = (await mintOidcSession('alice', 'alicepass123')).accessToken
    for (const name of [`Sidecar Approval ${rand()}`, `Other Agent ${rand()}`]) {
      const res = await escrow('POST', '', { name })
      expect(res.status).toBe(201)
      agents.push((await res.json()) as { userId: string; token: string })
    }
    person = await startHuman(alice)
    otherAgent = await startHuman(agents[1]!.token)
    wellKnown = await startWellKnown(HS_URL)
    store = await mkdtemp(join(tmpdir(), 'sidecar-approval-it-'))
    await boot()
  }, 180_000)

  afterAll(async () => {
    stream?.close()
    await p?.stop()
    person?.stop()
    otherAgent?.stop()
    for (const a of agents) await escrow('DELETE', `/${encodeURIComponent(a.userId)}`)
    await wellKnown?.close()
    if (store !== undefined) await rm(store, { recursive: true, force: true })
  }, 60_000)

  it('1. alice invites both agents to an encrypted room; the sidecar joins, the other agent joins by hand', async () => {
    room = await person.createEncryptedRoom([agents[0]!.userId, agents[1]!.userId])
    conv = conversationToken(room, false)
    await p!.waitFor((l) => l.evt === 'joined' && l.conversation === conv, 60_000)
    await otherAgent.join(room)
    await person.waitForMembership(room, agents[0]!.userId, 'join')
    await person.waitForMembership(room, agents[1]!.userId, 'join')
    await until(async () => ((await call('GET', `/v1/conversations/${conv}`)).status === 200 ? true : undefined), 30_000, 'the conversation')
  }, 120_000)

  it('2. the agent asks; another agent’s answer is ignored (log, no event); the person’s → approval.answered and the seal', async () => {
    const { ts, card } = await ask(`Publicar a versão ${rand()}?`)
    expect(JSON.parse(await readFile(join(store, 'approvals.json'), 'utf8'))).toEqual({ cards: [{ conversation: conv, id: ts, options: OPTIONS }] })

    await otherAgent.answerApproval(room, card, 'approve', 'Aprovar')
    await p!.waitFor((l) => l.evt === 'approval-answer-ignored' && l.reason === 'not-a-person', 60_000)
    expect(stream!.frames.some((f) => f.event === 'approval.answered')).toBe(false)

    await person.answerApproval(room, card, 'reject', 'Rejeitar')
    const e = await answered(ts)
    expect(e).toEqual({ type: 'approval.answered', conversation: conv, id: ts, option: 'reject', by: personToken(person.userId), at: expect.any(Number) as number })
    await sealOf(card)
    const state = await until(async () => {
      const r = await call('GET', `${approvals()}/${ts}`)
      const s = r.json as unknown as ApiApprovalStatus
      return s.approval?.state === 'answered' ? s : undefined
    }, 30_000, 'the sealed state')
    expect(state).toEqual({ conversation: conv, id: ts, approval: { options: OPTIONS, state: 'answered', answer: { option: 'reject', by: personToken(person.userId), at: e.at } } })
    await until(async () => (JSON.parse(await readFile(join(store, 'approvals.json'), 'utf8')) as { cards: unknown[] }).cards.length === 0 || undefined, 30_000, 'the card out of the file')
    expect(stream!.frames.filter((f) => f.event === 'approval.answered')).toHaveLength(1)
  }, 180_000)

  it('3. the person answers and the agent closes at once → the close answers `answered`, one event, one close', async () => {
    const { ts, card } = await ask(`Liberar o acesso ${rand()}?`)
    await person.answerApproval(room, card, 'approve', 'Aprovar')
    // The answer is on the server; the close re-reads before it writes.
    const r = await call('POST', `${approvals()}/${ts}/close`, {})
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ id: ts, approval: { state: 'answered', answer: { option: 'approve', by: personToken(person.userId) } } })
    await answered(ts)
    await sealOf(card)
    await new Promise((res) => setTimeout(res, 2_000))
    expect(stream!.frames.filter((f) => f.event === 'approval.answered' && f.data?.id === ts)).toHaveLength(1)
    const closes = person.events().filter((e) => e.relation?.rel_type === 'm.replace' && e.relation.event_id === card)
    expect(closes).toHaveLength(1)
  }, 180_000)

  it('4. the sidecar stops, the person answers, the sidecar comes back → a stream opened AFTER the boot gets the event; seal', async () => {
    const { ts, card } = await ask(`Rodar a migração ${rand()}?`)
    stream?.close()
    expect(await p!.stop()).toBe(0)
    await person.answerApproval(room, card, 'approve', 'Aprovar')
    // No stream at the boot: the recovery decides the answer with nobody listening (A3-3b).
    await boot(false)
    await p!.waitFor(evt('approvals-loaded'), 60_000)
    await p!.waitFor(evt('approval-answered'), 90_000)
    stream = openEvents(url, local)
    const e = await answered(ts)
    expect(e).toEqual({ type: 'approval.answered', conversation: conv, id: ts, option: 'approve', by: personToken(person.userId), at: expect.any(Number) as number })
    await sealOf(card)
    // Delivered once: a second fresh stream does not get it again.
    const second = openEvents(url, local)
    await new Promise((res) => setTimeout(res, 2_000))
    expect(second.frames.filter((f) => f.event === 'approval.answered')).toEqual([])
    second.close()
    const r = await call('GET', `${approvals()}/${ts}`)
    expect(r.json).toMatchObject({ approval: { state: 'answered', answer: { option: 'approve', by: personToken(person.userId) } } })
  }, 240_000)
})
