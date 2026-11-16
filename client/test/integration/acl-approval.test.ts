import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createAcl } from '../../src/acl'
import type { Acl, AclTelemetry, ChannelId, DomainEvent, Message, MessageId } from '../../src/acl'
import { createRoom, getEvent, getRelations, HOMESERVER, invite, join, mintToken, sendText, synapseReachable, whoami } from '../support/synapse'
import { registerUser } from '../support/escrow-harness'
import { freshUsers, type FreshUser } from '../support/fresh-users'
import {
  APPROVAL_BLOCK,
  APPROVAL_MSGTYPE,
  APPROVAL_RESPONSE_BLOCK,
  APPROVAL_RESPONSE_MSGTYPE,
  RESPONSE_REL_TYPE,
} from '@tayet/shared/internal'
import { FOLD_RULES } from '../../src/acl/internal/fold-rules'

// ADR-091 (Proposto), A3-1 — the approval card read side against the real server, both sides proved.
// An agent account (the reserved `a-` localpart, born here by `mas-cli register-user` ONLY in the test,
// as in acl-agent-kind.test.ts) sends a card by the protocol; an agent answer, a forged close by another
// member and a person's answer follow, all by the protocol, all accepted by the server (shown by reading
// them back). The viewer's ACL folds them: the card becomes `answered` by the person, no answer becomes a
// line, the forged close changes nothing and the server's unread count does not rise for the answers
// (the viewer's ACL wrote the two rules on connect). The viewer is a GUEST (not admitted to the org): the
// same run shows whether a guest's account takes the rules (PLANO-AGENTES §8.31).
// Auto-skip without the stack (issue #7); fileParallelism:false serializes the gates.

const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'
const OPTIONS = [
  { id: 'approve', label: 'Aprovar', style: 'primary' },
  { id: 'reject', label: 'Rejeitar', style: 'danger' },
]

async function until<T>(get: () => T | undefined | Promise<T | undefined>, timeoutMs = 150_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = await get()
    if (v !== undefined) return v
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 100))
  }
}

// `a-appr` + 8 of base32 = `a-` + 12, the exact format of ADR-086 dec. 1.
function agentLocalpart(): string {
  let tail = ''
  for (let i = 0; i < 8; i++) tail += BASE32[Math.floor(Math.random() * BASE32.length)]
  return `a-appr${tail}`
}

let txn = 0
async function send(token: string, roomId: string, content: Record<string, unknown>): Promise<string> {
  txn += 1
  const res = await fetch(`${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/appr${txn}_${process.pid}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(content),
  })
  if (!res.ok) throw new Error(`send -> ${res.status} ${await res.text()}`)
  return ((await res.json()) as { event_id: string }).event_id
}

const answer = (cardId: string, option: string): Record<string, unknown> => ({
  msgtype: APPROVAL_RESPONSE_MSGTYPE,
  body: option,
  [APPROVAL_RESPONSE_BLOCK]: { option },
  'm.relates_to': { rel_type: RESPONSE_REL_TYPE, event_id: cardId },
})

async function overrideRule(token: string, ruleId: string): Promise<{ actions: unknown[]; conditions: unknown[]; enabled: boolean } | undefined> {
  const res = await fetch(`${HOMESERVER}/_matrix/client/v3/pushrules/global/override/${encodeURIComponent(ruleId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  return res.ok ? ((await res.json()) as { actions: unknown[]; conditions: unknown[]; enabled: boolean }) : undefined
}

// Issue #7: the unread proof reads what the server counted, not a fixed total — a total also counts
// events outside the subject (a membership event from another person once made it 3). The list is the
// proof itself: exactly one card, exactly one barrier, no answer. Only shapes leave here — the event type,
// the sender's role in the test, the envelope's relation type, the msgtype when in clear and which known
// event it is. No id, token or body is ever in the output.
type Role = 'alice' | 'bob' | 'agent' | 'viewer' | 'person' | 'other'
type Known = 'card' | 'barrier' | 'answer' | 'unknown'
type Notified = { type: string; sender: Role; relType: string; msgtype: string; is: Known }
async function notifiedEvents(token: string, roomId: string, roles: Map<string, Role>, known: Map<string, Known>): Promise<Notified[]> {
  const out: Notified[] = []
  let from: string | undefined
  for (;;) {
    const q = from === undefined ? '' : `&from=${encodeURIComponent(from)}`
    const res = await fetch(`${HOMESERVER}/_matrix/client/v3/notifications?limit=100${q}`, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) throw new Error(`notifications -> ${res.status}`)
    const page = (await res.json()) as {
      notifications: Array<{ room_id: string; event: { event_id: string; type: string; sender: string; content?: Record<string, unknown> } }>
      next_token?: string
    }
    for (const n of page.notifications) {
      if (n.room_id !== roomId) continue
      const content = n.event.content ?? {}
      const rel = content['m.relates_to'] as { rel_type?: unknown } | undefined
      out.push({
        type: n.event.type,
        sender: roles.get(n.event.sender) ?? 'other',
        relType: typeof rel?.rel_type === 'string' ? rel.rel_type : 'none',
        msgtype: typeof content.msgtype === 'string' ? content.msgtype : 'none',
        is: known.get(n.event.event_id) ?? 'unknown',
      })
    }
    if (!page.next_token || page.notifications.length === 0) return out
    from = page.next_token
  }
}

describe.skipIf(!SYNAPSE)('approval card — read side (ADR-091, A3-1)', () => {
  let viewer: FreshUser
  let person: FreshUser
  let agentToken: string
  let acl: Acl
  const events: DomainEvent[] = []

  beforeAll(async () => {
    ;[viewer, person] = await freshUsers(['aprv', 'aprp'])
    const localpart = agentLocalpart()
    registerUser(localpart)
    agentToken = await mintToken(localpart)
    acl = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    acl.subscribe((e) => events.push(e))
    await acl.connect(viewer.token as Parameters<Acl['connect']>[0])
  }, 180_000)

  afterAll(async () => {
    await acl?.disconnect()
  })

  it('the viewer’s ACL writes the two rules on its (guest) account: override, no actions, exact condition', async () => {
    for (const { ruleId, relType } of FOLD_RULES) {
      const rule = await until(() => overrideRule(viewer.token, ruleId), 60_000)
      expect(rule).toMatchObject({
        enabled: true,
        actions: [],
        conditions: [{ kind: 'event_property_is', key: 'content.m\\.relates_to.rel_type', value: relType }],
      })
    }
  }, 120_000)

  it('a person’s answer resolves the card; an agent’s answer and a forged close are ignored; no answer is a line or an unread', async () => {
    const name = `tayet-approval-${process.pid}-${Math.floor(Math.random() * 1e6)}`
    const roomId = await createRoom(viewer.token, { name })
    const personId = await whoami(person.token)
    const agentId = await whoami(agentToken)
    for (const token of [person.token, agentToken]) {
      await invite(viewer.token, roomId, await whoami(token))
      await join(token, roomId)
    }
    const channelId: ChannelId = await until(() => {
      const ev = events.find((e): e is Extract<DomainEvent, { t: 'channel.changed' }> => e.t === 'channel.changed' && e.channel.name === `#${name}`)
      return ev?.channel.id
    })
    // The rules are in place before anything that could count.
    for (const { ruleId } of FOLD_RULES) await until(() => overrideRule(viewer.token, ruleId), 60_000)

    const cardId = await send(agentToken, roomId, {
      msgtype: APPROVAL_MSGTYPE,
      body: 'Publicar a versão 2.4?',
      format: 'org.matrix.custom.html',
      formatted_body: '<p>Publicar a versão <strong>2.4</strong>?</p>',
      [APPROVAL_BLOCK]: { options: OPTIONS },
    })
    const received = await until(() =>
      events.find((e): e is Extract<DomainEvent, { t: 'message.received' }> => e.t === 'message.received' && e.message.id === (cardId as unknown as MessageId)),
    )
    expect(received.message.body).toMatchObject({ kind: 'approval', options: OPTIONS, state: { kind: 'open' } })
    expect(received.message.author).toBe(agentId)

    // The agent answers its own card, then another member forges the close, then the person answers.
    const agentAnswerId = await send(agentToken, roomId, answer(cardId, 'approve'))
    const forgedCloseId = await send(person.token, roomId, {
      msgtype: APPROVAL_MSGTYPE,
      body: '* Publicar a versão 2.4?',
      'm.new_content': { msgtype: APPROVAL_MSGTYPE, body: 'Publicar a versão 2.4?', [APPROVAL_BLOCK]: { options: OPTIONS, closed: true } },
      'm.relates_to': { rel_type: 'm.replace', event_id: cardId },
    })
    const personAnswerId = await send(person.token, roomId, answer(cardId, 'reject'))

    // The server accepted all three (the other side of the proof).
    const relations = await getRelations(viewer.token, roomId, cardId, RESPONSE_REL_TYPE)
    expect(relations.map((r) => r.event_id).sort()).toEqual([agentAnswerId, personAnswerId].sort())
    expect((await getEvent(viewer.token, roomId, forgedCloseId)).content['m.relates_to']).toEqual({ rel_type: 'm.replace', event_id: cardId })

    // The card resolves to the person, with the option; never closed by the forged close.
    const cardEdits = (): Message[] =>
      events.flatMap((e) => (e.t === 'message.edited' && e.message.id === (cardId as unknown as MessageId) ? [e.message] : []))
    const answered = await until(() =>
      cardEdits().find((m) => m.body.kind === 'approval' && m.body.state.kind === 'answered' && m.body.state.option !== undefined),
    )
    expect(answered.body.kind === 'approval' && answered.body.state).toMatchObject({ kind: 'answered', by: personId, option: 'reject' })

    // A barrier from the person: once it is here, every earlier event was seen.
    const barrierId = await sendText(person.token, roomId, 'barreira')
    await until(() => events.find((e) => e.t === 'message.received' && e.message.id === (barrierId as unknown as MessageId)))
    const lineIds = events.flatMap((e) => (e.t === 'message.received' ? [e.message.id as unknown as string] : []))
    expect(lineIds).not.toContain(agentAnswerId)
    expect(lineIds).not.toContain(personAnswerId)
    expect(lineIds).not.toContain(forgedCloseId)
    expect(cardEdits().some((m) => m.body.kind === 'approval' && m.body.state.kind === 'closed')).toBe(false)

    // The page agrees: the card answered by the person, no answer row.
    const page = await acl.getTimeline(channelId)
    const card = page.items.find((m) => m.id === (cardId as unknown as MessageId))
    expect(card?.body.kind === 'approval' && card.body.options).toEqual(OPTIONS)
    const pageIds = page.items.map((m) => m.id as unknown as string)
    expect(pageIds).not.toContain(agentAnswerId)
    expect(pageIds).not.toContain(personAnswerId)
    const settled = await until(async () => {
      const again = (await acl.getTimeline(channelId)).items.find((m) => m.id === (cardId as unknown as MessageId))
      return again?.body.kind === 'approval' && again.body.state.kind === 'answered' ? again : undefined
    })
    expect(settled.body.kind === 'approval' && settled.body.state).toMatchObject({ by: personId, option: 'reject' })

    // What the server counted as unread: the card and the barrier, never an answer — the two answers do
    // not count (by the rules the ACL wrote; the forged edit by the server's own default rule). The wait on
    // the count is only the time barrier; the proof is the list of what notified, not its total.
    await until(async () => {
      const ch = (await acl.getChannels()).find((c) => c.id === channelId)
      return ch && ch.unread.count >= 2 ? ch.unread.count : undefined
    })
    const notified = await notifiedEvents(
      viewer.token,
      roomId,
      new Map<string, Role>([[await whoami(viewer.token), 'viewer'], [personId, 'person'], [agentId, 'agent']]),
      new Map<string, Known>([[cardId, 'card'], [barrierId, 'barrier'], [agentAnswerId, 'answer'], [personAnswerId, 'answer']]),
    )
    expect(notified.filter((n) => n.is === 'card'), `the server counted: ${JSON.stringify(notified)}`).toHaveLength(1)
    expect(notified.filter((n) => n.is === 'barrier'), `the server counted: ${JSON.stringify(notified)}`).toHaveLength(1)
    expect(notified.filter((n) => n.is === 'answer'), `the server counted: ${JSON.stringify(notified)}`).toHaveLength(0)
  }, 300_000)
})

// A3-2 — answering from the client (ADR-091 dec. 14), against the real server. Two people, each with
// their own ACL, in an ENCRYPTED conversation with an agent: one answers by the verb and the other's
// client sees the card answered with the right author and option, no new line and no unread; the relation
// type of the encrypted answer is in clear on the server (the relation read finds it, envelope and all).
// Then both answer at nearly the same time and the two clients agree on who was first — the first in the
// server's forward relation order.
describe.skipIf(!SYNAPSE)('approval card — answering from the client (ADR-091 dec. 14, A3-2)', () => {
  let alice: FreshUser
  let bob: FreshUser
  let agentToken: string
  let aliceAcl: Acl
  let bobAcl: Acl
  const aliceEvents: DomainEvent[] = []
  const bobEvents: DomainEvent[] = []
  let roomId: string
  let aliceChannel: ChannelId
  let bobChannel: ChannelId

  const cardOf = (events: DomainEvent[], cardId: string): Message[] =>
    events.flatMap((e) => ((e.t === 'message.received' || e.t === 'message.edited') && e.message.id === (cardId as unknown as MessageId) ? [e.message] : []))
  const answeredWithOption = (events: DomainEvent[], cardId: string) =>
    until(() => {
      const last = cardOf(events, cardId).at(-1)
      return last?.body.kind === 'approval' && last.body.state.kind === 'answered' && last.body.state.option !== undefined ? last.body.state : undefined
    })
  const sendCard = (body: string): Promise<string> =>
    send(agentToken, roomId, { msgtype: APPROVAL_MSGTYPE, body, [APPROVAL_BLOCK]: { options: OPTIONS } })
  const forwardRelations = async (cardId: string): Promise<Array<{ event_id: string; sender: string; type: string; content: Record<string, unknown> }>> => {
    const res = await fetch(
      `${HOMESERVER}/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/relations/${encodeURIComponent(cardId)}/${encodeURIComponent(RESPONSE_REL_TYPE)}?dir=f`,
      { headers: { Authorization: `Bearer ${alice.token}` } },
    )
    if (!res.ok) throw new Error(`relations -> ${res.status}`)
    return ((await res.json()) as { chunk: Array<{ event_id: string; sender: string; type: string; content: Record<string, unknown> }> }).chunk
  }

  beforeAll(async () => {
    ;[alice, bob] = await freshUsers(['apra', 'aprb'])
    const localpart = agentLocalpart()
    registerUser(localpart)
    agentToken = await mintToken(localpart)
    aliceAcl = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    bobAcl = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    aliceAcl.subscribe((e) => aliceEvents.push(e))
    bobAcl.subscribe((e) => bobEvents.push(e))
    await aliceAcl.connect(alice.token as Parameters<Acl['connect']>[0])
    await bobAcl.connect(bob.token as Parameters<Acl['connect']>[0])

    const name = `tayet-approval-answer-${process.pid}-${Math.floor(Math.random() * 1e6)}`
    roomId = await createRoom(alice.token, {
      name,
      initialState: [{ type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }],
    })
    for (const token of [bob.token, agentToken]) {
      await invite(alice.token, roomId, await whoami(token))
      await join(token, roomId)
    }
    const channelOf = (events: DomainEvent[]) =>
      until(() => {
        const ev = events.find((e): e is Extract<DomainEvent, { t: 'channel.changed' }> => e.t === 'channel.changed' && e.channel.name === `#${name}`)
        return ev?.channel.id
      })
    aliceChannel = await channelOf(aliceEvents)
    bobChannel = await channelOf(bobEvents)
    for (const { ruleId } of FOLD_RULES) await until(() => overrideRule(bob.token, ruleId), 60_000)
  }, 240_000)

  afterAll(async () => {
    await aliceAcl?.disconnect()
    await bobAcl?.disconnect()
  })

  it('one person answers by the verb; the other’s client sees the card answered by her with the option — no line, no unread; the relation is in clear', async () => {
    const aliceId = await whoami(alice.token)
    const cardId = await sendCard('Publicar a versão 2.5?')
    for (const events of [aliceEvents, bobEvents]) await until(() => cardOf(events, cardId)[0])

    await aliceAcl.answerApproval(cardId as unknown as MessageId, 'approve')
    // Her own card went through 'sending' and resolves by the rule — never a line of hers.
    expect(cardOf(aliceEvents, cardId).some((m) => m.body.kind === 'approval' && m.body.state.kind === 'sending')).toBe(true)
    expect(await answeredWithOption(aliceEvents, cardId)).toMatchObject({ kind: 'answered', by: aliceId, option: 'approve' })
    expect(await answeredWithOption(bobEvents, cardId)).toMatchObject({ kind: 'answered', by: aliceId, option: 'approve' })

    // The server holds one answer, encrypted, its relation type in clear on the envelope.
    const relations = await forwardRelations(cardId)
    expect(relations).toHaveLength(1)
    expect(relations[0]).toMatchObject({ sender: aliceId, type: 'm.room.encrypted' })
    expect(relations[0]!.content['m.relates_to']).toEqual({ rel_type: RESPONSE_REL_TYPE, event_id: cardId })
    const answerId = relations[0]!.event_id

    // A barrier from Alice: once Bob has it, every earlier event reached him.
    const barrierId = await sendText(alice.token, roomId, 'barreira')
    await until(() => bobEvents.find((e) => e.t === 'message.received' && e.message.id === (barrierId as unknown as MessageId)))
    for (const events of [aliceEvents, bobEvents]) {
      const lineIds = events.flatMap((e) => (e.t === 'message.received' ? [e.message.id as unknown as string] : []))
      expect(lineIds).not.toContain(answerId)
    }
    // Bob's page agrees, and what the server counted as unread for him is the card and the barrier, never
    // the answer. The wait on the count is only the time barrier; the proof is the list, not its total.
    const page = await bobAcl.getTimeline(bobChannel)
    expect(page.items.map((m) => m.id as unknown as string)).not.toContain(answerId)
    await until(async () => {
      const ch = (await bobAcl.getChannels()).find((c) => c.id === bobChannel)
      return ch && ch.unread.count >= 2 ? ch.unread.count : undefined
    })
    const notified = await notifiedEvents(
      bob.token,
      roomId,
      new Map<string, Role>([[aliceId, 'alice'], [await whoami(bob.token), 'bob'], [await whoami(agentToken), 'agent']]),
      new Map<string, Known>([[cardId, 'card'], [barrierId, 'barrier'], [answerId, 'answer']]),
    )
    expect(notified.filter((n) => n.is === 'card'), `the server counted: ${JSON.stringify(notified)}`).toHaveLength(1)
    expect(notified.filter((n) => n.is === 'barrier'), `the server counted: ${JSON.stringify(notified)}`).toHaveLength(1)
    expect(notified.filter((n) => n.is === 'answer'), `the server counted: ${JSON.stringify(notified)}`).toHaveLength(0)
  }, 300_000)

  it('two people answer at nearly the same time: both clients agree on who was first — the server’s first', async () => {
    const cardId = await sendCard('Reverter o deploy?')
    for (const events of [aliceEvents, bobEvents]) await until(() => cardOf(events, cardId)[0])

    await Promise.allSettled([
      aliceAcl.answerApproval(cardId as unknown as MessageId, 'approve'),
      bobAcl.answerApproval(cardId as unknown as MessageId, 'reject'),
    ])
    const relations = await until(async () => {
      const r = await forwardRelations(cardId)
      return r.length === 2 ? r : undefined
    })
    const first = relations[0]!
    const expected = { kind: 'answered', by: first.sender, option: first.sender === (await whoami(alice.token)) ? 'approve' : 'reject' }
    // Each settles on the server's first, whatever arrived first locally (the page is the authority).
    const settled = async (events: DomainEvent[]) =>
      until(() => {
        const last = cardOf(events, cardId).at(-1)
        const state = last?.body.kind === 'approval' ? last.body.state : undefined
        return state?.kind === 'answered' && state.by === expected.by && state.option === expected.option ? state : undefined
      })
    expect(await settled(aliceEvents)).toMatchObject(expected)
    expect(await settled(bobEvents)).toMatchObject(expected)
    // And their pages agree.
    for (const [acl, channel] of [[aliceAcl, aliceChannel], [bobAcl, bobChannel]] as const) {
      const state = await until(async () => {
        const item = (await acl.getTimeline(channel)).items.find((m) => m.id === (cardId as unknown as MessageId))
        return item?.body.kind === 'approval' && item.body.state.kind === 'answered' && item.body.state.option !== undefined ? item.body.state : undefined
      })
      expect(state).toMatchObject(expected)
    }
  }, 300_000)
})

describe('ACL approval (availability)', () => {
  it(SYNAPSE ? 'stack reachable' : 'stack down — skipped', () => {
    expect(typeof SYNAPSE).toBe('boolean')
  })
})
