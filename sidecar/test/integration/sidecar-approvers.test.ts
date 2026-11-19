import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ESCROW_URL, HS_URL, mintOidcSession, stackUp, startWellKnown, until, whoamiStatus } from '../support/stack'
import { evt, startSidecar, type SidecarProcess } from '../support/sidecar-process'
import { startHuman, type Human } from '../support/human'
import { conversationToken, personToken } from '../../src/api/ids'
import type { ApiApprovalStatus, ApiMessage } from '../../src/api/contract'

// ADR-104 against the stack (PLANO-AGENTES §0.3.30, Aprovadores 2): the agent asks through POST
// /v1/conversations/:id/approvals of dist/cli.js with `needed: 3`; three people answer BY THE PROTOCOL (the
// shared builder, as the client's answerApproval) in an encrypted room → three `approval.answered` with
// `count` 1, 2 and 3 and `needed` 3, the card sealed after the third (one `APPROVERS_SEAL ms=<n>` line: the
// server instant of the seal minus the third answer's), GET state → answered with the three answers. Then a
// restart with a card holding one answer of three: the second answer given while the sidecar is down goes
// out after the boot with `count` 2, the first is not sent again; the agent closes short of N → `closed`.
// ONE encrypted room (the stack's createRoom limit is shared); one `a-` account per run is left
// deactivated on the stack, and one person per run is registered (no devices before the run).

const STACK = stackUp()
const rand = (): string => Math.random().toString(36).slice(2, 8)
const OPTIONS = [
  { id: 'approve', label: 'Aprovar', style: 'primary' },
  { id: 'reject', label: 'Rejeitar', style: 'danger' },
]
const MAS_CONTAINER = process.env.TAYET_MAS_CONTAINER ?? 'spike-mas-1'
const MAS_CONFIG = process.env.TAYET_MAS_CONFIG ?? '/config/config.yaml'

// A person of this run only (MAS-local, the dev stack's documented provisioning path), with a
// compatibility token that Synapse already accepts. Nothing of it reaches a log line.
async function freshPerson(prefix: string): Promise<string> {
  const name = `${prefix}${process.pid}${Math.floor(Math.random() * 1e6)}`
  execSync(`docker exec ${MAS_CONTAINER} mas-cli manage register-user -c ${MAS_CONFIG} --yes --ignore-password-complexity --password gatepass123 ${name} 2>&1`, { encoding: 'utf8' })
  const out = execSync(`docker exec ${MAS_CONTAINER} mas-cli manage issue-compatibility-token -c ${MAS_CONFIG} ${name} 2>&1`, { encoding: 'utf8' })
  const token = /mct_[A-Za-z0-9_]+/.exec(out)?.[0]
  if (token === undefined) throw new Error('could not mint the third person’s token')
  await until(async () => ((await whoamiStatus(token)) === 200 ? true : undefined), 30_000, 'the third person’s token active')
  return token
}

interface Frame {
  event?: string
  data?: Record<string, unknown>
}

// Minimal SSE reader (a copy of sidecar-approval.test.ts's).
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

describe.skipIf(!STACK)('sidecar Aprovadores 2 ↔ stack: a card that asks for 3 answers (ADR-104)', () => {
  let alice: string
  let agent: { userId: string; token: string }
  let wellKnown: Awaited<ReturnType<typeof startWellKnown>>
  let store: string
  let people: Human[] = []
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
    p = startSidecar(['--server', wellKnown.url, '--token', agent.token, '--store', store])
    url = (await p.waitFor(evt('api-listening'), 90_000)).url as string
    local = (await readFile(join(store, 'local.token'), 'utf8')).trim()
    if (withStream) stream = openEvents(url, local)
  }
  const answeredOf = (id: string): Array<Record<string, unknown>> => stream!.frames.filter((f) => f.event === 'approval.answered' && f.data?.id === id).map((f) => f.data!)
  const sealOf = (card: string) =>
    people[0]!.waitForEvent((e) => {
      const next = e.content['m.new_content'] as Record<string, unknown> | undefined
      const block = next?.['io.tayet.approval'] as { closed?: unknown } | undefined
      return e.relation?.rel_type === 'm.replace' && e.relation.event_id === card && block?.closed === true
    }, 60_000)
  const fileCards = async (): Promise<Array<Record<string, unknown>>> => (JSON.parse(await readFile(join(store, 'approvals.json'), 'utf8')) as { cards: Array<Record<string, unknown>> }).cards
  const ask = async (text: string, needed: number): Promise<{ ts: string; card: string }> => {
    const r = await call('POST', approvals(), { text, options: OPTIONS, needed })
    expect(r.status).toBe(200)
    const msg = r.json as unknown as ApiMessage
    expect(msg).toMatchObject({ conversation: conv, text, approval: { options: OPTIONS, needed, answers: [], state: 'open' } })
    const got = await people[0]!.waitForMessage((m) => m.body === text)
    expect(got.wireType).toBe('m.room.encrypted')
    expect(got.content['io.tayet.approval']).toEqual({ options: OPTIONS, needed })
    return { ts: msg.id, card: got.eventId }
  }

  beforeAll(async () => {
    alice = (await mintOidcSession('alice', 'alicepass123')).accessToken
    const bob = (await mintOidcSession('bob', 'bobpass123')).accessToken
    const third = await freshPerson('apv')
    const res = await escrow('POST', '', { name: `Sidecar Approvers ${rand()}` })
    expect(res.status).toBe(201)
    agent = (await res.json()) as { userId: string; token: string }
    people = [await startHuman(alice), await startHuman(bob), await startHuman(third)]
    wellKnown = await startWellKnown(HS_URL)
    store = await mkdtemp(join(tmpdir(), 'sidecar-approvers-it-'))
    await boot()
  }, 240_000)

  afterAll(async () => {
    stream?.close()
    await p?.stop()
    for (const h of people) h.stop()
    if (agent !== undefined) await escrow('DELETE', `/${encodeURIComponent(agent.userId)}`)
    await wellKnown?.close()
    if (store !== undefined) await rm(store, { recursive: true, force: true })
  }, 60_000)

  it('1. alice invites the agent and two people to an encrypted room; all join', async () => {
    const [a, b, c] = people as [Human, Human, Human]
    room = await a.createEncryptedRoom([agent.userId, b.userId, c.userId])
    conv = conversationToken(room, false)
    await p!.waitFor((l) => l.evt === 'joined' && l.conversation === conv, 60_000)
    await b.join(room)
    await c.join(room)
    for (const u of [agent.userId, b.userId, c.userId]) await a.waitForMembership(room, u, 'join')
    await until(async () => ((await call('GET', `/v1/conversations/${conv}`)).status === 200 ? true : undefined), 30_000, 'the conversation')
  }, 120_000)

  it('2. a card that asks for 3: three answers → three events with count 1, 2, 3; no seal before the third; the seal after it', async () => {
    const { ts, card } = await ask(`Liberar a versão ${rand()}?`, 3)
    expect(await fileCards()).toEqual([{ conversation: conv, id: ts, options: OPTIONS, needed: 3, emitted: [] }])
    const choices = ['approve', 'reject', 'approve']
    for (let i = 0; i < 3; i++) {
      await people[i]!.answerApproval(room, card, choices[i]!, choices[i] === 'approve' ? 'Aprovar' : 'Rejeitar')
      await until(() => (answeredOf(ts).length === i + 1 ? true : undefined), 60_000, `event ${i + 1}`)
      if (i < 2) {
        // Not sealed short of N: the card is still open and on disk with what went out.
        expect(people[0]!.events().some((e) => e.relation?.rel_type === 'm.replace' && e.relation.event_id === card)).toBe(false)
        await until(async () => (((await fileCards())[0]?.emitted as unknown[] | undefined)?.length === i + 1 ? true : undefined), 30_000, 'the file after the event')
      }
    }
    const events = answeredOf(ts)
    expect(events).toEqual(
      people.map((h, i) => ({ type: 'approval.answered', conversation: conv, id: ts, option: choices[i], by: personToken(h.userId), at: expect.any(Number) as number, count: i + 1, needed: 3 })),
    )
    await sealOf(card)
    const state = await until(async () => {
      const s = (await call('GET', `${approvals()}/${ts}`)).json as unknown as ApiApprovalStatus
      return s.approval?.state === 'answered' ? s : undefined
    }, 30_000, 'the sealed state')
    expect(state.approval).toEqual({ options: OPTIONS, needed: 3, answers: events.map((e) => ({ option: e.option, by: e.by, at: e.at })), state: 'answered' })
    // The seal's server instant (the card's editedAt) minus the third answer's.
    const listing = (await call('GET', `/v1/conversations/${conv}/messages?limit=20`)).json as unknown as { messages: ApiMessage[] }
    const sealed = listing.messages.find((m) => m.id === ts)
    expect(sealed?.editedAt).toEqual(expect.any(Number))
    process.stderr.write(`APPROVERS_SEAL ms=${(sealed!.editedAt as number) - (events[2]!.at as number)}\n`)
    await until(async () => ((await fileCards()).length === 0 ? true : undefined), 30_000, 'the card out of the file')
    await new Promise((res) => setTimeout(res, 2_000))
    expect(answeredOf(ts)).toHaveLength(3)
    const closes = people[0]!.events().filter((e) => e.relation?.rel_type === 'm.replace' && e.relation.event_id === card)
    expect(closes).toHaveLength(1)
  }, 240_000)

  it('3. restart with a partial card: the answer given while down goes out with count 2, the first is not sent again; the close short of N', async () => {
    const { ts, card } = await ask(`Rodar a migração ${rand()}?`, 3)
    await people[0]!.answerApproval(room, card, 'approve', 'Aprovar')
    await until(() => (answeredOf(ts).length === 1 ? true : undefined), 60_000, 'the first event')
    await until(async () => (((await fileCards())[0]?.emitted as unknown[] | undefined)?.length === 1 ? true : undefined), 30_000, 'the first answer on disk')
    stream?.close()
    expect(await p!.stop()).toBe(0)
    await people[1]!.answerApproval(room, card, 'reject', 'Rejeitar')
    // No stream at the boot: the recovery emits with nobody listening; a stream opened after it gets it.
    await boot(false)
    await p!.waitFor(evt('approvals-loaded'), 60_000)
    await p!.waitFor((l) => l.evt === 'approval-answered' && l.count === 2, 90_000)
    stream = openEvents(url, local)
    await until(() => (answeredOf(ts).length >= 1 ? true : undefined), 60_000, 'the event after the boot')
    await new Promise((res) => setTimeout(res, 2_000))
    expect(answeredOf(ts)).toEqual([{ type: 'approval.answered', conversation: conv, id: ts, option: 'reject', by: personToken(people[1]!.userId), at: expect.any(Number) as number, count: 2, needed: 3 }])
    expect((await fileCards())[0]?.emitted).toEqual([
      { by: personToken(people[0]!.userId), at: expect.any(Number) as number },
      { by: personToken(people[1]!.userId), at: expect.any(Number) as number },
    ])
    const r = await call('POST', `${approvals()}/${ts}/close`, {})
    expect(r.status).toBe(200)
    expect(r.json).toMatchObject({ id: ts, approval: { needed: 3, state: 'closed', answers: [{ option: 'approve', by: personToken(people[0]!.userId) }, { option: 'reject', by: personToken(people[1]!.userId) }] } })
    const close = await sealOf(card)
    expect((close.content['m.new_content'] as Record<string, unknown>)['io.tayet.approval']).toEqual({ options: OPTIONS, needed: 3, closed: true })
    await until(async () => ((await fileCards()).length === 0 ? true : undefined), 30_000, 'the card out of the file')
    expect(answeredOf(ts)).toHaveLength(1)
  }, 300_000)
})
