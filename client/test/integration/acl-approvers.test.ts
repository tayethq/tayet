import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createAcl } from '../../src/acl'
import type { Acl, AclTelemetry, ChannelId, DomainEvent, Message, MessageBody, MessageId } from '../../src/acl'
import { createRoom, HOMESERVER, invite, join, mintToken, redact, synapseReachable, whoami } from '../support/synapse'
import { registerUser } from '../support/escrow-harness'
import { freshUsers, type FreshUser } from '../support/fresh-users'
import { APPROVAL_BLOCK, APPROVAL_MSGTYPE, APPROVAL_RESPONSE_BLOCK, APPROVAL_RESPONSE_MSGTYPE, RESPONSE_REL_TYPE } from '@tayet/shared/internal'

// A card that declares how many answers it asks for, against the real server, in an encrypted
// conversation with three people and an agent account (the reserved `a-` localpart, born here only in the
// test). The agent sends the card and its close by the protocol; the people answer by the verb. Each
// person's client shows the answers that count, one per person, cut at N; a deleted answer leaves the count
// and its author answers again; a close short of N keeps the answers that came. Then a fourth person joins
// later and reads a card whose answers span more than one page of the server's relations (the default
// page is smaller than the cap on N). No id, token or body is ever in the output.
// Auto-skip without the stack (issue #7); fileParallelism:false serializes the gates.

const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'
const OPTIONS = [
  { id: 'approve', label: 'Aprovar', style: 'primary' },
  { id: 'reject', label: 'Recusar' },
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

function agentLocalpart(): string {
  let tail = ''
  for (let i = 0; i < 8; i++) tail += BASE32[Math.floor(Math.random() * BASE32.length)]
  return `a-mult${tail}`
}

let txn = 0
// A burst of sends from one account meets the server's message rate limit: wait as long as it says and send
// again with the same transaction id (the server dedupes it).
async function send(token: string, roomId: string, content: Record<string, unknown>): Promise<string> {
  txn += 1
  const url = `${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/mult${txn}_${process.pid}`
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(content),
    })
    if (res.status === 429 && attempt < 10) {
      const wait = ((await res.json().catch(() => ({}))) as { retry_after_ms?: number }).retry_after_ms ?? 1000
      await new Promise((r) => setTimeout(r, wait + 100))
      continue
    }
    if (!res.ok) throw new Error(`send -> ${res.status}`)
    return ((await res.json()) as { event_id: string }).event_id
  }
}

const rawAnswer = (cardId: string, option: string): Record<string, unknown> => ({
  msgtype: APPROVAL_RESPONSE_MSGTYPE,
  body: option,
  [APPROVAL_RESPONSE_BLOCK]: { option },
  'm.relates_to': { rel_type: RESPONSE_REL_TYPE, event_id: cardId },
})

type Multi = Extract<Extract<MessageBody, { kind: 'approval' }>['state'], { kind: 'multi' }>
const cardOf = (events: DomainEvent[], cardId: string): Message[] =>
  events.flatMap((e) => ((e.t === 'message.received' || e.t === 'message.edited') && e.message.id === (cardId as unknown as MessageId) ? [e.message] : []))
const lastMulti = (events: DomainEvent[], cardId: string): Multi | undefined => {
  const body = cardOf(events, cardId).at(-1)?.body
  return body?.kind === 'approval' && body.state.kind === 'multi' ? body.state : undefined
}
// Waits until the card shows exactly these answers (author and option, in order) and this closed flag.
const shows = (events: DomainEvent[], cardId: string, want: Array<{ by: string; option?: string }>, closed = false) =>
  until(() => {
    const s = lastMulti(events, cardId)
    if (!s || s.closed !== closed || s.own !== undefined || s.answers.length !== want.length) return undefined
    return s.answers.every((a, i) => a.by === want[i]!.by && a.option === want[i]!.option) ? s : undefined
  })

describe.skipIf(!SYNAPSE)('approval card with several answers — three people, encrypted conversation', () => {
  let people: readonly FreshUser[]
  let ids: string[]
  let acls: Acl[]
  const events: DomainEvent[][] = [[], [], []]
  let agentToken: string
  let roomId: string
  let name: string

  const sendCard = (body: string, needed: number): Promise<string> =>
    send(agentToken, roomId, { msgtype: APPROVAL_MSGTYPE, body, [APPROVAL_BLOCK]: { options: OPTIONS, needed } })
  const closeCard = (cardId: string, body: string, needed: number): Promise<string> =>
    send(agentToken, roomId, {
      msgtype: APPROVAL_MSGTYPE,
      body: `* ${body}`,
      'm.new_content': { msgtype: APPROVAL_MSGTYPE, body, [APPROVAL_BLOCK]: { options: OPTIONS, needed, closed: true } },
      'm.relates_to': { rel_type: 'm.replace', event_id: cardId },
    })
  const forwardRelations = async (cardId: string, token: string): Promise<Array<{ event_id: string; sender: string }>> => {
    const res = await fetch(
      `${HOMESERVER}/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/relations/${encodeURIComponent(cardId)}/${encodeURIComponent(RESPONSE_REL_TYPE)}?dir=f&limit=50`,
      { headers: { Authorization: `Bearer ${token}` } },
    )
    if (!res.ok) throw new Error(`relations -> ${res.status}`)
    return ((await res.json()) as { chunk: Array<{ event_id: string; sender: string }> }).chunk
  }
  const seenByAll = async (cardId: string): Promise<void> => {
    for (const ev of events) await until(() => cardOf(ev, cardId)[0])
  }

  beforeAll(async () => {
    people = await freshUsers(['mlta', 'mltb', 'mltc'])
    ids = await Promise.all(people.map((p) => whoami(p.token)))
    const localpart = agentLocalpart()
    registerUser(localpart)
    agentToken = await mintToken(localpart)
    acls = people.map(() => createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER }))
    acls.forEach((acl, i) => acl.subscribe((e) => events[i]!.push(e)))
    for (let i = 0; i < acls.length; i++) await acls[i]!.connect(people[i]!.token as Parameters<Acl['connect']>[0])

    name = `tayet-approvers-${process.pid}-${Math.floor(Math.random() * 1e6)}`
    roomId = await createRoom(people[0]!.token, {
      name,
      initialState: [{ type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }],
    })
    for (const token of [people[1]!.token, people[2]!.token, agentToken]) {
      await invite(people[0]!.token, roomId, await whoami(token))
      await join(token, roomId)
    }
    for (const ev of events) {
      await until(() => ev.find((e) => e.t === 'channel.changed' && e.channel.name === `#${name}`))
    }
  }, 300_000)

  afterAll(async () => {
    for (const acl of acls ?? []) await acl.disconnect()
  })

  it('N = 2: the first two people count, in the server order; the third answer is on the server and appears nowhere', async () => {
    const cardId = await sendCard('Publicar o layout novo?', 2)
    await seenByAll(cardId)
    for (const ev of events) expect(lastMulti(ev, cardId)).toMatchObject({ needed: 2, answers: [], closed: false })

    await acls[0]!.answerApproval(cardId as unknown as MessageId, 'approve')
    for (const ev of events) await shows(ev, cardId, [{ by: ids[0]!, option: 'approve' }])
    await acls[1]!.answerApproval(cardId as unknown as MessageId, 'reject')
    const two = [
      { by: ids[0]!, option: 'approve' },
      { by: ids[1]!, option: 'reject' },
    ]
    for (const ev of events) await shows(ev, cardId, two)

    // The third person's client refuses the verb on a complete card; an answer sent by the protocol
    // reaches the server and still does not appear.
    await expect(acls[2]!.answerApproval(cardId as unknown as MessageId, 'approve')).rejects.toThrow('approval card not open')
    await send(people[2]!.token, roomId, rawAnswer(cardId, 'approve'))
    await until(async () => ((await forwardRelations(cardId, people[0]!.token)).length === 3 ? true : undefined))
    // A barrier: a later card reaches everyone, so the third answer did too.
    const barrier = await sendCard('Barreira', 2)
    await seenByAll(barrier)
    for (const ev of events) expect(lastMulti(ev, cardId)?.answers.map((a) => a.by)).toEqual([ids[0], ids[1]])
  }, 300_000)

  it('a deleted answer leaves the count, and its author answers again', async () => {
    const cardId = await sendCard('Trocar o fornecedor?', 2)
    await seenByAll(cardId)
    await acls[0]!.answerApproval(cardId as unknown as MessageId, 'approve')
    for (const ev of events) await shows(ev, cardId, [{ by: ids[0]!, option: 'approve' }])

    const [mine] = await forwardRelations(cardId, people[0]!.token)
    await redact(people[0]!.token, roomId, mine!.event_id)
    for (const ev of events) await shows(ev, cardId, [])

    await acls[0]!.answerApproval(cardId as unknown as MessageId, 'reject')
    for (const ev of events) await shows(ev, cardId, [{ by: ids[0]!, option: 'reject' }])
  }, 300_000)

  it('closed short of N: the answers that came, closed; nobody can answer', async () => {
    const body = 'Renovar o contrato?'
    const cardId = await sendCard(body, 3)
    await seenByAll(cardId)
    await acls[1]!.answerApproval(cardId as unknown as MessageId, 'approve')
    for (const ev of events) await shows(ev, cardId, [{ by: ids[1]!, option: 'approve' }])
    await closeCard(cardId, body, 3)
    for (const ev of events) await shows(ev, cardId, [{ by: ids[1]!, option: 'approve' }], true)
    await expect(acls[2]!.answerApproval(cardId as unknown as MessageId, 'reject')).rejects.toThrow('approval card not open')
  }, 300_000)

  it('the answers span more than one page: a person who joins later reads past the first page', async () => {
    const cardId = await sendCard('Abrir a vaga?', 3)
    await seenByAll(cardId)
    // Five answers of the same person fill the first page (only the first counts); the next two people
    // land on the second.
    await send(people[0]!.token, roomId, rawAnswer(cardId, 'approve'))
    for (let i = 0; i < 4; i++) await send(people[0]!.token, roomId, rawAnswer(cardId, 'reject'))
    await send(people[1]!.token, roomId, rawAnswer(cardId, 'reject'))
    await send(people[2]!.token, roomId, rawAnswer(cardId, 'approve'))
    const want = [
      { by: ids[0]!, option: 'approve' },
      { by: ids[1]!, option: 'reject' },
      { by: ids[2]!, option: 'approve' },
    ]
    for (const ev of events) await shows(ev, cardId, want)

    const [late] = await freshUsers(['mltd'])
    await invite(people[0]!.token, roomId, await whoami(late!.token))
    await join(late!.token, roomId)
    const lateEvents: DomainEvent[] = []
    const lateAcl = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
    lateAcl.subscribe((e) => lateEvents.push(e))
    try {
      await lateAcl.connect(late!.token as Parameters<Acl['connect']>[0])
      const channel = await until(() => {
        const ev = lateEvents.find((e): e is Extract<DomainEvent, { t: 'channel.changed' }> => e.t === 'channel.changed' && e.channel.name === `#${name}`)
        return ev?.channel.id as ChannelId | undefined
      })
      // The first translation starts the read; the resolution arrives as an edit of the card.
      await until(async () => {
        const items = (await lateAcl.getTimeline(channel)).items
        return items.some((m) => m.id === (cardId as unknown as MessageId)) ? true : undefined
      })
      await shows(lateEvents, cardId, want)
    } finally {
      await lateAcl.disconnect()
    }
  }, 300_000)
})

describe('ACL approvers (availability)', () => {
  it(SYNAPSE ? 'stack reachable' : 'stack down — skipped', () => {
    expect(typeof SYNAPSE).toBe('boolean')
  })
})
