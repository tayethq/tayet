import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest'
import { createAcl } from '../../src/acl'
import { encryptedBirthState } from '../../src/acl/internal/custody'
import type { Acl, AclTelemetry, ChannelId } from '../../src/acl'
import { HOMESERVER, synapseReachable, whoami, createUnnamedRoom, findOwnEvent } from '../support/synapse'
import { freshUsers } from '../support/fresh-users'
import { until } from '../support/until'
import { bootstrapSettled, watchInFlight } from '../support/cross-signing-ready'

// Stack gate of ADR-112 (Proposto), in the shape of acl-custody-birth.test.ts. What only the stack
// can prove: the server takes the repair's invite (from the creator and from a member who did not
// create the room), and a message sent after the repair has its session deposited by the custody
// agent, proven as the birth gate proves the first session. A message sent before it stays out.
//
// The room is born outside the product, without the custody: raw fetch with the creator's token and
// the birth's own initial_state. The opener runs as the product does, with the escrow configured and
// the key bootstrap settled: on a verified device the SDK's invite first runs shareRoomHistoryWithUser,
// which at birth has no keys to share and here has the room's history. Auto-skips without the stack.

const SYNAPSE = synapseReachable()
const ESCROW = process.env.TAYET_ESCROW_URL ?? 'http://localhost:8090'
const COFRE = '@cofre:tayet.local'
const BUDGET = { timeoutMs: 120_000, pollMs: 500 }

async function custodyMembership(token: string, roomId: string): Promise<string | null> {
  const res = await fetch(
    `${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.member/${encodeURIComponent(COFRE)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  )
  if (res.status === 404) return null
  if (res.status !== 200) throw new Error(`membership -> ${res.status}`)
  return ((await res.json()) as { membership?: string }).membership ?? null
}

async function custodiedSessionIds(token: string): Promise<string[]> {
  const res = await fetch(`${ESCROW}/v1/sessions`, { headers: { Authorization: `Bearer ${token}` } })
  if (res.status !== 200) throw new Error(`retrieve -> ${res.status}`)
  const { sessions } = (await res.json()) as { sessions: Array<{ session_id?: string }> }
  return sessions.map((s) => s.session_id ?? '')
}

// The session of a sent message, read from the envelope on the wire.
async function sendAndReadSession(acl: Acl, token: string, id: ChannelId, text: string): Promise<string> {
  const messageId = await acl.sendMessage(id, { kind: 'text', text })
  const event = await findOwnEvent(token, String(id), String(messageId))
  const content = event.content as { algorithm?: string; session_id?: string }
  expect(content.algorithm).toBe('m.megolm.v1.aes-sha2')
  expect(typeof content.session_id).toBe('string')
  return content.session_id!
}

describe.skipIf(!SYNAPSE)('custody repair on open: ACL ↔ real stack (ADR-112)', () => {
  let acl: Acl | undefined
  // The recovery's config channel is the env (as in acl-invariant-coverage).
  let previousEscrow: string | undefined
  beforeAll(() => {
    previousEscrow = process.env.TAYET_ESCROW_URL
    process.env.TAYET_ESCROW_URL = ESCROW
  })
  afterAll(() => {
    if (previousEscrow === undefined) delete process.env.TAYET_ESCROW_URL
    else process.env.TAYET_ESCROW_URL = previousEscrow
  })
  afterEach(async () => {
    await acl?.disconnect()
    acl = undefined
  })

  it.each([
    ['the creator', 0],
    ['a member who did not create it', 1],
  ] as const)(
    'opened by %s: custody is a member and the next session is custodied',
    async (_label, openerIndex) => {
      const users = await freshUsers(['cra', 'crb'])
      const creator = users[0]
      const opener = users[openerIndex]
      const roomId = await createUnnamedRoom(creator.token, {
        invite: [await whoami(users[1].token)],
        initialState: encryptedBirthState(),
      })
      const id = roomId as ChannelId

      const signals: string[] = []
      const telemetry: AclTelemetry = { untranslated: (e) => signals.push(e.shape.eventType) }
      acl = createAcl({ mode: 'strict', telemetry, serverUrl: HOMESERVER })
      const session = acl
      const openerId = await whoami(opener.token)
      const watch = watchInFlight()
      try {
        await session.connect(opener.token as Parameters<Acl['connect']>[0])
        await bootstrapSettled(watch.wire, opener.token, openerId, 'opener')
      } finally {
        watch.restore()
      }
      await until('conversation known to the session', async () =>
        (await session.getChannels()).some((c) => c.id === id) ? true : undefined,
      )

      const before = await sendAndReadSession(session, opener.token, id, 'before the repair')
      expect(await custodyMembership(creator.token, roomId)).toBeNull()

      const unsubscribe = session.subscribeChannel(id, () => {})
      await until(
        'custody is a member on the server',
        async () => {
          const membership = await custodyMembership(creator.token, roomId)
          return membership === 'invite' || membership === 'join' ? true : undefined
        },
        { timeoutMs: 30_000, pollMs: 500, snapshot: () => `signals=[${signals.join(', ')}]` },
      )

      // The barrel has no event for the custody, so "after the repair" is observed on the wire: the
      // first message whose session is not the one from before.
      const after = await until(
        'a message in a new session',
        async () => {
          const sent = await sendAndReadSession(session, opener.token, id, 'after the repair')
          return sent === before ? undefined : sent
        },
        { timeoutMs: 30_000, pollMs: 1_000 },
      )

      await until(
        'deposit of the session sent after the repair',
        async () => ((await custodiedSessionIds(opener.token)).includes(after) ? true : undefined),
        { ...BUDGET, snapshot: async () => `custodied=${(await custodiedSessionIds(opener.token)).length}` },
      )
      expect(await custodiedSessionIds(opener.token)).not.toContain(before)
      expect(signals.filter((s) => s.startsWith('io.tayet.custody.invite-'))).toEqual([])
      unsubscribe()
    },
    300_000,
  )
})
