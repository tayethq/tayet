import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { EventType, type MatrixClient } from 'matrix-js-sdk'
import { MatrixGateway } from '../../src/acl/internal/matrix-client'
import type { SearchIndex } from '../../src/acl/internal/search-index'
import type { AclTelemetry, AwaitingApproval, DomainEvent, MessageId, OpaqueSession } from '../../src/acl'
import { createRoom, getEvent, getRelations, HOMESERVER, invite, join, mintToken, redact, sendText, synapseReachable, whoami } from '../support/synapse'
import { registerUser } from '../support/escrow-harness'
import { freshUsers, type FreshUser } from '../support/fresh-users'
import { until } from '../support/until'
import { findProtocolLeaks, OPAQUE_ID_KEYS } from '@tayet/shared/leak-scan'
import { APPROVAL_BLOCK, APPROVAL_MSGTYPE, RESPONSE_REL_TYPE } from '@tayet/shared/internal'

// ADR-099 — the cards awaiting the person, against the real server, in a public conversation in clear
// and an encrypted one (there the agent's cards and close and the people's answers really are encrypted).
//
// The viewer has two sessions. The first is online while the cards are seeded: it fills the account's
// local index and holds the keys. It leaves, one card is deleted behind its back, and the second session
// starts with the index and the keys (a Node session keeps neither crypto store nor device across
// instances, so the keys cross by the SDK's export and import) and no backfill:
//  (a) it lists the open card of both conversations, not the answered nor the closed one;
//  (b) the card older than the window comes by the index, and answering it works;
//  (c) the deleted card left in the index is out, and leaves the index;
//  (d) live: a new card, another person's answer, its deletion, one's own answer, a close, a deletion;
//  (e) the first read: at most 4 in flight, at most 3 requests a card, no 429.
// The fillers are split among three accounts and every send honours the server's wait.
// Auto-skip without the stack (issue #7); fileParallelism:false serializes the gates.

const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const OPTS = { mode: 'strict' as const, telemetry: noopTelemetry, serverUrl: HOMESERVER }
const OPTIONS = [
  { id: 'approve', label: 'Aprovar' },
  { id: 'reject', label: 'Recusar' },
]
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'
// More than the boot's window (30) after the old cards.
const FILLERS = 33
const ITEM_OPAQUE_KEYS = new Set([...OPAQUE_ID_KEYS, 'channel'])

type Internals = { client: MatrixClient; search: SearchIndex }
const inside = (gw: MatrixGateway): Internals => gw as unknown as Internals
const asSession = (token: string): OpaqueSession => token as unknown as OpaqueSession
const asId = (id: string): MessageId => id as unknown as MessageId

function agentLocalpart(): string {
  let tail = ''
  for (let i = 0; i < 8; i++) tail += BASE32[Math.floor(Math.random() * BASE32.length)]
  return `a-wait${tail}`
}

// The SDK's sends do not retry: wait as long as the server says and send again.
async function patient<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await work()
    } catch (err) {
      const wait = (err as { data?: { retry_after_ms?: number } }).data?.retry_after_ms
      if (wait === undefined || attempt >= 25) throw err
      await new Promise((r) => setTimeout(r, wait + 100))
    }
  }
}

describe.skipIf(!SYNAPSE)('approvals awaiting the person (ADR-099)', () => {
  let viewer: FreshUser
  let person: FreshUser
  let agentToken: string
  let agent: MatrixGateway
  let personGw: MatrixGateway
  let session: MatrixGateway | undefined
  let stop: (() => void) | undefined
  const personEvents: DomainEvent[] = []
  const lists: AwaitingApproval[][] = []
  let publicRoom: string
  let encryptedRoom: string
  const seeded = { old: '', deleted: '', openPublic: '', answeredPublic: '', closedPublic: '', openEncrypted: '', answeredEncrypted: '', closedEncrypted: '' }
  // The requests of the first read, by card.
  const perCard = new Map<string, number>()
  let maxInFlight = 0
  let rateLimited = 0

  const listed = (): string[] | undefined => lists.at(-1)?.map((i) => i.message.id as unknown as string)
  const agentSend = (roomId: string, content: Record<string, unknown>): Promise<string> =>
    patient(async () => {
      const { client } = inside(agent)
      return (await client.sendEvent(roomId, EventType.RoomMessage, content as never, client.makeTxnId())).event_id
    })
  const card = (roomId: string, body: string): Promise<string> =>
    agentSend(roomId, { msgtype: APPROVAL_MSGTYPE, body, [APPROVAL_BLOCK]: { options: OPTIONS } })
  const close = (roomId: string, cardId: string): Promise<string> =>
    agentSend(roomId, {
      msgtype: APPROVAL_MSGTYPE,
      body: '* Encerrado',
      'm.new_content': { msgtype: APPROVAL_MSGTYPE, body: 'Encerrado', [APPROVAL_BLOCK]: { options: OPTIONS, closed: true } },
      'm.relates_to': { rel_type: 'm.replace', event_id: cardId },
    })
  const personAnswers = async (roomId: string, cardId: string): Promise<string> => {
    await until('the person holds the card', () =>
      personEvents.some((e) => (e.t === 'message.received' || e.t === 'message.edited') && e.message.id === asId(cardId) && e.message.body.kind === 'approval')
        ? true
        : undefined,
    )
    await patient(() => personGw.answerApproval(asId(cardId), 'approve'))
    const [answer] = await getRelations(person.token, roomId, cardId, RESPONSE_REL_TYPE)
    return answer!.event_id
  }

  beforeAll(async () => {
    const users = await freshUsers(['awtv', 'awtp', 'awtf', 'awtg', 'awth'])
    viewer = users[0]
    person = users[1]
    const fillers = [users[2], users[3], users[4]]
    const localpart = agentLocalpart()
    registerUser(localpart)
    agentToken = await mintToken(localpart)

    const first = new MatrixGateway(OPTS, { searchBackfill: false })
    agent = new MatrixGateway(OPTS, { searchBackfill: false })
    personGw = new MatrixGateway(OPTS, { searchBackfill: false })
    const firstEvents: DomainEvent[] = []
    first.subscribe((e) => firstEvents.push(e))
    personGw.subscribe((e) => personEvents.push(e))
    await first.connect(asSession(viewer.token))
    await agent.connect(asSession(agentToken))
    await personGw.connect(asSession(person.token))

    const nonce = `${process.pid}-${Math.floor(Math.random() * 1e6)}`
    publicRoom = await createRoom(viewer.token, {
      name: `tayet-awaiting-pub-${nonce}`,
      initialState: [{ type: 'm.room.join_rules', state_key: '', content: { join_rule: 'public' } }],
    })
    encryptedRoom = await createRoom(viewer.token, {
      name: `tayet-awaiting-e2e-${nonce}`,
      initialState: [{ type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }],
    })
    // Public: joined with no invite.
    for (const token of [person.token, agentToken]) await join(token, publicRoom)
    for (const token of [person.token, agentToken, ...fillers.map((f) => f.token)]) {
      await invite(viewer.token, encryptedRoom, await whoami(token))
      await join(token, encryptedRoom)
    }
    const everyone = await Promise.all([viewer.token, person.token, agentToken].map((t) => whoami(t)))
    for (const gw of [first, agent, personGw]) {
      await until('each session knows both conversations and who is in them', () =>
        [publicRoom, encryptedRoom].every((id) => {
          const room = inside(gw).client.getRoom(id)
          return room?.getMyMembership() === 'join' && everyone.every((u) => room.getMember(u)?.membership === 'join')
        })
          ? true
          : undefined,
      )
    }

    seeded.old = await card(encryptedRoom, 'Pedido antigo')
    seeded.deleted = await card(encryptedRoom, 'Pedido que sera apagado')
    for (let i = 0; i < FILLERS; i++) await sendText(fillers[i % fillers.length]!.token, encryptedRoom, `conversa ${i}`)
    seeded.openPublic = await card(publicRoom, 'Aberto em claro')
    seeded.answeredPublic = await card(publicRoom, 'Respondido em claro')
    seeded.closedPublic = await card(publicRoom, 'Fechado em claro')
    seeded.openEncrypted = await card(encryptedRoom, 'Aberto cifrado')
    seeded.answeredEncrypted = await card(encryptedRoom, 'Respondido cifrado')
    seeded.closedEncrypted = await card(encryptedRoom, 'Fechado cifrado')
    await personAnswers(publicRoom, seeded.answeredPublic)
    await personAnswers(encryptedRoom, seeded.answeredEncrypted)
    await close(publicRoom, seeded.closedPublic)
    await close(encryptedRoom, seeded.closedEncrypted)
    expect((await getEvent(viewer.token, encryptedRoom, seeded.old)).type).toBe('m.room.encrypted')

    await until('the first session indexed every card', () => {
      const ids = new Set(inside(first).search.approvals().map((e) => e.eventId))
      return Object.values(seeded).every((id) => ids.has(id)) ? true : undefined
    })
    await until('the first session read the last close', () =>
      firstEvents.some(
        (e) => e.t === 'message.edited' && e.message.id === asId(seeded.closedEncrypted) && e.message.body.kind === 'approval' && e.message.body.state.kind === 'closed',
      )
        ? true
        : undefined,
    )
    const keys = await inside(first).client.getCrypto()!.exportRoomKeys()
    await first.disconnect()
    await redact(agentToken, encryptedRoom, seeded.deleted)

    const token = await mintToken(viewer.name)
    const second = new MatrixGateway(OPTS, { searchBackfill: false })
    session = second
    second.subscribe((e) => {
      if (e.t === 'approvals.awaiting') lists.push(e.items)
    })
    await second.connect(asSession(token))
    await inside(second).client.getCrypto()!.importRoomKeys(keys)
    await inside(second).search.ready
    // The premises of (b) and (c): out of the window, in the index.
    for (const id of [seeded.old, seeded.deleted]) {
      expect(inside(second).client.getRoom(encryptedRoom)!.findEventById(id)).toBeUndefined()
      expect(inside(second).search.get(id)).toBeDefined()
    }

    const ids = Object.values(seeded)
    const realFetch = globalThis.fetch
    let inFlight = 0
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = decodeURIComponent(new URL(String(input instanceof Request ? input.url : input)).pathname)
      const target = /\/(event|relations)\//.test(url) ? ids.find((id) => url.includes(id)) : undefined
      if (target === undefined) return realFetch(input, init)
      perCard.set(target, (perCard.get(target) ?? 0) + 1)
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      try {
        const res = await realFetch(input, init)
        if (res.status === 429) rateLimited += 1
        return res
      } finally {
        inFlight -= 1
      }
    })
    try {
      stop = second.watchAwaitingApprovals()
      await until('the first list', () => (lists.length > 0 ? true : undefined), { timeoutMs: 120_000 })
    } finally {
      spy.mockRestore()
    }
  }, 600_000)

  afterAll(async () => {
    stop?.()
    await session?.disconnect()
    await personGw?.disconnect()
    await agent?.disconnect()
  })

  it('(a) a new session lists the open card of both conversations, newest first, not the answered nor the closed', () => {
    expect(lists[0]!.map((i) => i.message.id)).toEqual([seeded.openEncrypted, seeded.openPublic, seeded.old])
    const [encrypted, inClear] = lists[0]!
    expect(encrypted).toMatchObject({ channel: encryptedRoom, message: { body: { kind: 'approval', text: 'Aberto cifrado', state: { kind: 'open' } } } })
    expect(inClear).toMatchObject({ channel: publicRoom, message: { body: { kind: 'approval', text: 'Aberto em claro', state: { kind: 'open' } } } })
    for (const item of lists[0]!) expect(findProtocolLeaks(item, ITEM_OPAQUE_KEYS)).toEqual([])
  })

  it('(c) the deleted card left in the index is out, and its entry left the index', () => {
    expect(lists.flat().map((i) => i.message.id)).not.toContain(seeded.deleted)
    expect(inside(session!).search.get(seeded.deleted)).toBeUndefined()
  })

  it('(e) at most 4 in flight, at most 3 requests a card, no rate limit', () => {
    expect(rateLimited).toBe(0)
    expect(maxInFlight).toBeLessThanOrEqual(4)
    expect(maxInFlight).toBeGreaterThan(1)
    expect([...perCard.keys()].sort()).toEqual(Object.values(seeded).sort())
    // The event and the answers; the edits only for the closed ones; the deleted one stops at the event.
    expect(Object.fromEntries(Object.entries(seeded).map(([name, id]) => [name, perCard.get(id)]))).toEqual({
      old: 2,
      deleted: 1,
      openPublic: 2,
      answeredPublic: 2,
      closedPublic: 3,
      openEncrypted: 2,
      answeredEncrypted: 2,
      closedEncrypted: 3,
    })
  })

  it('(b) the card older than the window came by the index, and answering it works', async () => {
    const item = lists[0]!.find((i) => i.message.id === asId(seeded.old))!
    expect(item.message.body).toMatchObject({ kind: 'approval', text: 'Pedido antigo' })
    await patient(() => session!.answerApproval(item.message.id, 'approve'))
    await until('the answered old card left', () => (!listed()!.includes(seeded.old) ? true : undefined))
    const answers = await getRelations(viewer.token, encryptedRoom, seeded.old, RESPONSE_REL_TYPE)
    expect(answers).toHaveLength(1)
    expect(answers[0]).toMatchObject({ sender: await whoami(viewer.token), type: 'm.room.encrypted' })
  }, 180_000)

  for (const kind of ['public', 'encrypted'] as const) {
    it(`(d) live, ${kind}: new card, another's answer, its deletion, one's own, a close, a deletion`, async () => {
      const roomId = kind === 'public' ? publicRoom : encryptedRoom
      // The agent shares the key with the second session's device before it sends.
      const viewerId = await whoami(viewer.token)
      const device = inside(session!).client.getDeviceId()!
      await until('the agent knows the new device', async () =>
        (await inside(agent).client.getCrypto()!.getUserDeviceInfo([viewerId], true)).get(viewerId)?.has(device) ? true : undefined,
      )
      const isListed = (id: string): Promise<true> => until('the card is listed', () => (listed()!.includes(id) ? true : undefined))
      const isOut = (id: string): Promise<true> => until('the card is out', () => (!listed()!.includes(id) ? true : undefined))

      const asked = await card(roomId, 'Pedido ao vivo')
      await isListed(asked)
      expect(listed()![0]).toBe(asked)
      const answerId = await personAnswers(roomId, asked)
      await isOut(asked)
      await redact(person.token, roomId, answerId)
      await isListed(asked)
      await patient(() => session!.answerApproval(asId(asked), 'reject'))
      await isOut(asked)

      const toClose = await card(roomId, 'Pedido que fecha')
      await isListed(toClose)
      await close(roomId, toClose)
      await isOut(toClose)

      const toDelete = await card(roomId, 'Pedido que some')
      await isListed(toDelete)
      await redact(agentToken, roomId, toDelete)
      await isOut(toDelete)
    }, 300_000)
  }
})

describe('ACL awaiting approvals (availability)', () => {
  it(SYNAPSE ? 'stack reachable' : 'stack down — skipped', () => {
    expect(typeof SYNAPSE).toBe('boolean')
  })
})
