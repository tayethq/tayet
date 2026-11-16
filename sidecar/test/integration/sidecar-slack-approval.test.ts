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

// A3-4 against the stack (ADR-087 dec. 6; ADR-091; PLANO-AGENTES §0.3.16 item 14, §0.3.17): dist/cli.js as the
// operator runs it and a Bolt 5.1.0 agent with no patch (test/support/bolt-agent.mjs) in Socket Mode. alice
// (the operator) creates the agent and ONE encrypted room inviting it; she mentions it with `cartão` → Bolt
// posts `text` + an `actions` block of two buttons (action_ids off the option rule, with values) → she
// decrypts the card (positional options b1/b2) and answers it by the protocol (the shared builder) → Bolt's
// app.action gets `block_actions` with the ORIGINAL action_id and value and her `U…` → respond() replaces the
// request → she decrypts the new text; the card is answered and closed. Then two approvers (alice, then bob): a
// card in the mention's thread; after alice's answer the handler's chat.update with the same buttons posts a new
// card in that thread (the old one stays sealed with her answer); bob's click comes with the origin's ts; a final
// chat.update with no buttons edits the new card. And a card of 25 buttons, answered on the 25th. Every Bolt line
// and every sidecar line goes through the leak-scan. The one `a-` account is deleted at the end.

const STACK = stackUp()
const rand = (): string => Math.random().toString(36).slice(2, 8)
const BOLT = join(SIDECAR_ROOT, 'test', 'support', 'bolt-agent.mjs')

interface BoltLine {
  evt: string
  event?: Record<string, unknown>
  action?: Record<string, unknown>
  ts?: string
  user?: string
  channel?: string
  message_ts?: string
  card_ts?: string
  thread_ts?: string
  step?: number
  live?: string
  text?: string
  warnings?: string[]
}

describe.skipIf(!STACK)('sidecar A3-4 ↔ stack: the approval card through Bolt (block_actions, respond)', () => {
  let alice: string
  let agent: { userId: string; token: string; deviceId: string } | undefined
  let removed = false
  let created = 0
  let wellKnown: Awaited<ReturnType<typeof startWellKnown>>
  let store: string
  let person: Human
  let second: Human
  let bobU = ''
  const seenEvents: string[] = []
  let p: SidecarProcess | undefined
  let bolt: ChildProcess | undefined
  let url = ''
  let local = ''
  const boltLines: BoltLine[] = []
  let boltErr = ''
  let room = ''
  let conv = ''
  let aliceU = ''
  let cardTs = ''
  let cardEvent = ''
  const marker = rand()
  const name = `Sidecar Slack Card ${rand()}`

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
    second = await startHuman((await mintOidcSession('bob', 'bobpass123')).accessToken)
    bobU = personToken(second.userId)
    wellKnown = await startWellKnown(HS_URL)
    store = await mkdtemp(join(tmpdir(), 'sidecar-slack-approval-it-'))
    p = startSidecar(['--server', wellKnown.url, '--token', agent.token, '--store', store])
    url = (await p.waitFor(evt('api-listening'), 90_000)).url as string
    local = (await readFile(join(store, 'local.token'), 'utf8')).trim()
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
    second?.stop()
    if (agent !== undefined && !removed) {
      const del = await escrow('DELETE', `/${encodeURIComponent(agent.userId)}`)
      if (del.status < 300) {
        await until(async () => ((await whoamiStatus(agent!.token)) === 401 ? true : undefined), 30_000, 'whoami 401 after DELETE')
        removed = true
      }
    }
    process.stderr.write(`[sidecar-slack-approval-it] a- accounts created: ${created}, deleted: ${removed ? 1 : 0}\n`)
    expect(removed || agent === undefined).toBe(true)
    await wellKnown?.close()
    if (store !== undefined) await rm(store, { recursive: true, force: true })
  }, 60_000)

  it('1. the Bolt agent posts text + an actions block → the person decrypts a card with positional options', async () => {
    room = await person.createEncryptedRoom([agent!.userId, second.userId])
    conv = conversationToken(room, false)
    await p!.waitFor((l) => l.evt === 'joined' && l.conversation === conv, 60_000)
    await person.waitForMembership(room, agent!.userId, 'join')
    await until(async () => second.join(room).then(() => true, () => undefined), 30_000, 'bob joins')
    await person.waitForMembership(room, second.userId, 'join')
    await person.sendMention(room, `@${name} cartão ${marker}`, [agent!.userId])
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
    // The layer's own file holds the agent's action_ids and values (API tokens only).
    const file = JSON.parse(await readFile(join(store, 'slack-cards.json'), 'utf8')) as { cards: unknown[] }
    expect(file.cards).toEqual([
      {
        conversation: conv,
        id: cardTs,
        block_id: 'release',
        actions: [
          { option: 'b1', action_id: 'Approve.Release', value: `release-${marker}` },
          { option: 'b2', action_id: 'Reject.Release', value: `reject-${marker}` },
        ],
        at: expect.any(Number) as number,
      },
    ])
  }, 180_000)

  it('2–3. the person answers → Bolt gets block_actions with the original action_id and value and her U…', async () => {
    await person.answerApproval(room, cardEvent, 'b1', 'Aprovar')
    const action = await boltWait((l) => l.evt === 'action', 90_000, 'block_actions in Bolt')
    expect(action.action).toMatchObject({ type: 'button', action_id: 'Approve.Release', block_id: 'release', value: `release-${marker}`, text: { type: 'plain_text', text: 'Aprovar' } })
    expect(action).toMatchObject({ user: aliceU, channel: conv, message_ts: cardTs })
    await boltWait((l) => l.evt === 'responded', 60_000, 'respond() answered')
  }, 180_000)

  it('4. respond() replaced the request: the person decrypts the new text; the card is answered and closed', async () => {
    const text = `respondido release-${marker}`
    const edit = await person.waitForEvent((e) => {
      const next = e.content['m.new_content'] as Record<string, unknown> | undefined
      return e.relation?.rel_type === 'm.replace' && e.relation.event_id === cardEvent && next?.body === text
    }, 60_000)
    expect(edit.type).toBe('m.room.message')
    const state = await until(async () => {
      const res = await fetch(`${url}/v1/conversations/${conv}/approvals/${cardTs}`, { headers: { authorization: `Bearer ${local}` } })
      const body = (await res.json()) as { approval?: { state?: string } }
      return body.approval?.state === 'answered' ? body : undefined
    }, 30_000, 'the answered state')
    expect(state).toMatchObject({ conversation: conv, id: cardTs, approval: { state: 'answered', answer: { option: 'b1', by: aliceU } } })
    // Closed: the seal (or the layer) wrote the closing mark.
    await person.waitForEvent((e) => {
      const next = e.content['m.new_content'] as Record<string, unknown> | undefined
      const block = next?.['io.tayet.approval'] as { closed?: unknown } | undefined
      return e.relation?.rel_type === 'm.replace' && e.relation.event_id === cardEvent && block?.closed === true
    }, 60_000)
    // The ack took the card out of the layer's file.
    await until(async () => ((JSON.parse(await readFile(join(store, 'slack-cards.json'), 'utf8')) as { cards: unknown[] }).cards.length === 0 ? true : undefined), 30_000, 'the card out of slack-cards.json')
    expect(boltErr).toBe('')
  }, 180_000)

  // Two approvers (the chain): the origin, the new card and the server's view of both.
  const marker2 = rand()
  let twoTs = ''
  let liveTs = ''
  let originEvent = ''
  let mentionEvent = ''
  let newCard = ''
  const approvalOf = async (ts: string) => {
    const res = await fetch(`${url}/v1/conversations/${conv}/approvals/${ts}`, { headers: { authorization: `Bearer ${local}` } })
    return (await res.json()) as { approval?: { state?: string; answer?: { option?: string; by?: string } } }
  }
  const closedMark = (event: string) => (e: { relation: { rel_type?: string; event_id?: string } | null; content: Record<string, unknown> }) => {
    const next = e.content['m.new_content'] as Record<string, unknown> | undefined
    const block = next?.['io.tayet.approval'] as { closed?: unknown } | undefined
    return e.relation?.rel_type === 'm.replace' && e.relation.event_id === event && block?.closed === true
  }

  it('5. two approvers: A answers; the handler\'s chat.update with the same buttons posts a new encrypted card in the same thread; the old one stays sealed with A\'s answer', async () => {
    mentionEvent = await person.sendMention(room, `@${name} dupla ${marker2}`, [agent!.userId])
    const two = await boltWait((l) => l.evt === 'two-card', 90_000, 'the two-approver card')
    expect(two.warnings).toEqual([])
    twoTs = two.ts as string
    const origin = await person.waitForMessage((m) => m.sender === agent!.userId && m.body === `Primeira aprovação ${marker2}?`, 60_000)
    expect(origin.relation).toMatchObject({ rel_type: 'm.thread', event_id: mentionEvent })
    originEvent = origin.eventId
    seenEvents.push(mentionEvent, originEvent)
    await person.answerApproval(room, originEvent, 'b1', 'Aprovar')
    const action = await boltWait((l) => l.evt === 'action' && l.action?.action_id === 'Two.Approve', 90_000, 'the first click')
    expect(action).toMatchObject({ user: aliceU, channel: conv, message_ts: twoTs, card_ts: twoTs })
    const updated = await boltWait((l) => l.evt === 'two-updated' && l.step === 1, 60_000, 'the first chat.update')
    expect(updated.ts).toBe(twoTs)
    liveTs = updated.live as string
    expect(liveTs).not.toBe(twoTs)
    // The new card: encrypted, an approval card with the same options, in the origin's thread.
    const fresh = await person.waitForMessage((m) => m.sender === agent!.userId && m.body === `Segunda aprovação ${marker2}?`, 60_000)
    expect(fresh.wireType).toBe('m.room.encrypted')
    expect(fresh.content.msgtype).toBe('io.tayet.approval')
    expect(fresh.content['io.tayet.approval']).toEqual({
      options: [
        { id: 'b1', label: 'Aprovar', style: 'primary' },
        { id: 'b2', label: 'Rejeitar', style: 'danger' },
      ],
    })
    expect(fresh.relation).toMatchObject({ rel_type: 'm.thread', event_id: mentionEvent })
    newCard = fresh.eventId
    seenEvents.push(newCard)
    // The old card: sealed (the closing mark) with A's answer, and never edited to the new request.
    await person.waitForEvent(closedMark(originEvent), 60_000)
    const old = await until(async () => {
      const b = await approvalOf(twoTs)
      return b.approval?.state === 'answered' ? b : undefined
    }, 30_000, 'the old card answered')
    expect(old.approval).toMatchObject({ state: 'answered', answer: { option: 'b1', by: aliceU } })
    const edited = person.events().filter((e) => e.relation?.rel_type === 'm.replace' && e.relation.event_id === originEvent)
    expect(edited.every((e) => (e.content['m.new_content'] as { body?: unknown } | undefined)?.body === `Primeira aprovação ${marker2}?`)).toBe(true)
  }, 240_000)

  it('6. B answers the new card → block_actions with container.message_ts = the origin; a final chat.update with no buttons edits the new card, which closes', async () => {
    await second.answerApproval(room, newCard, 'b2', 'Rejeitar')
    const action = await boltWait((l) => l.evt === 'action' && l.action?.action_id === 'Two.Reject', 90_000, 'the second click')
    expect(action).toMatchObject({ user: bobU, channel: conv, message_ts: twoTs, card_ts: liveTs })
    expect(action.action).toMatchObject({ block_id: 'two', value: `two-${marker2}` })
    const updated = await boltWait((l) => l.evt === 'two-updated' && l.step === 2, 60_000, 'the final chat.update')
    expect(updated).toMatchObject({ ts: twoTs, live: liveTs })
    await person.waitForEvent((e) => {
      const next = e.content['m.new_content'] as Record<string, unknown> | undefined
      return e.relation?.rel_type === 'm.replace' && e.relation.event_id === newCard && next?.body === `Aprovado por duas pessoas ${marker2}`
    }, 60_000)
    await person.waitForEvent(closedMark(newCard), 60_000)
    const fresh = await until(async () => {
      const b = await approvalOf(liveTs)
      return b.approval?.state === 'answered' ? b : undefined
    }, 30_000, 'the new card answered')
    expect(fresh.approval).toMatchObject({ state: 'answered', answer: { option: 'b2', by: bobU } })
    // The chain in the layer's file: API tokens only.
    const file = JSON.parse(await readFile(join(store, 'slack-cards.json'), 'utf8')) as { aliases: unknown[] }
    expect(file.aliases).toEqual([{ conversation: conv, origin: twoTs, live: liveTs, at: expect.any(Number) as number }])
    expect(boltErr).toBe('')
  }, 240_000)

  it('7. 25 buttons: Bolt posts them; the person answers the 25th; Bolt gets its action_id and value', async () => {
    const marker3 = rand()
    await person.sendMention(room, `@${name} vinte ${marker3}`, [agent!.userId])
    const posted = await boltWait((l) => l.evt === 'card25', 90_000, 'the 25-button card')
    expect(posted.warnings).toEqual([])
    const got = await person.waitForMessage((m) => m.sender === agent!.userId && m.body === `Escolha uma opção ${marker3}`, 60_000)
    expect(got.wireType).toBe('m.room.encrypted')
    const options = (got.content['io.tayet.approval'] as { options: Array<{ id: string; label: string }> }).options
    expect(options).toEqual(Array.from({ length: 25 }, (_, i) => ({ id: `b${i + 1}`, label: `Opção ${i + 1}` })))
    seenEvents.push(got.eventId)
    await person.answerApproval(room, got.eventId, 'b25', 'Opção 25')
    const action = await boltWait((l) => l.evt === 'action' && l.action?.action_id === 'Pick.25', 90_000, 'the click on the 25th')
    expect(action).toMatchObject({ user: aliceU, channel: conv, message_ts: posted.ts })
    expect(action.action).toMatchObject({ block_id: 'pick', value: `pick-25-${marker3}`, text: { type: 'plain_text', text: 'Opção 25' } })
    await boltWait((l) => l.evt === 'responded' && l.text === `respondido pick-25-${marker3}`, 60_000, 'respond() on the 25-button card')
    expect(boltErr).toBe('')
  }, 240_000)

  it('8. the leak-scan over what Bolt received and over the sidecar log: no protocol id of anyone', () => {
    expect(boltLines.length).toBeGreaterThan(3)
    expect(idLeaks(boltLines)).toEqual([])
    const all = JSON.stringify(boltLines) + JSON.stringify(p!.lines)
    for (const raw of [agent!.userId, person.userId, second.userId, room, cardEvent, ...seenEvents]) expect(all).not.toContain(raw)
    expect(idLeaks(p!.lines.map((l) => ({ ...l, ts: undefined })))).toEqual([])
  })
})
