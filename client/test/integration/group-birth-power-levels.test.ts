import { describe, it, expect, beforeAll } from 'vitest'
import { createUnnamedRoom, getState, join, putState, synapseReachable, whoami } from '../support/synapse'
import { freshUsers } from '../support/fresh-users'

// ADR-094 (Proposto) dec. 6 — the wire proof, BEFORE any verb (PLANO-CONVERSAS §0.3.2 item 8). Raw
// requests only, no ACL: A creates the room with exactly the body openGroupConversation will send — private
// preset, no name, invites to B, C and D, encryption and the { kind: 'group' } marker in the initial state,
// and a power-levels override whose `users` map has A at 100, B and C at 50 (D left out, as a guest or an
// agent would be). Four claims:
//   1. with B still in `invite`, the room's power levels have A 100, B 50, C 50, and the `events` map is the
//      preset's (compared with the same room created without the override);
//   2. B joins and sends the room name, then the { kind: 'channel' } marker: both accepted;
//   3. in another identical room, D joins and tries to send the marker: refused with 403;
//   4. A is still at 100 (the override did not take the creator's power away).
// Auto-skip without the stack.

const SYNAPSE = synapseReachable()
const MARKER = 'io.tayet.conversation'
const rand = (): string => Math.random().toString(36).slice(2, 8)

interface PowerLevels {
  users?: Record<string, number>
  events?: Record<string, number>
}

describe.skipIf(!SYNAPSE)('group birth power levels on the wire (ADR-094 dec. 6, C2)', () => {
  const ids = { a: '', b: '', c: '', d: '' }
  const tokens = { a: '', b: '', c: '', d: '' }

  beforeAll(async () => {
    const [a, b, c, d] = await freshUsers(['gpa', 'gpb', 'gpc', 'gpd'])
    const [aId, bId, cId, dId] = await Promise.all([whoami(a.token), whoami(b.token), whoami(c.token), whoami(d.token)])
    Object.assign(ids, { a: aId, b: bId, c: cId, d: dId })
    Object.assign(tokens, { a: a.token, b: b.token, c: c.token, d: d.token })
  }, 240_000)

  const birthState = () => [
    { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
    { type: 'm.room.history_visibility', state_key: '', content: { history_visibility: 'shared' } },
    { type: MARKER, state_key: '', content: { kind: 'group' } },
  ]
  const createGroup = (override: boolean) =>
    createUnnamedRoom(tokens.a, {
      invite: [ids.b, ids.c, ids.d],
      initialState: birthState(),
      ...(override && { powerLevelOverride: { users: { [ids.a]: 100, [ids.b]: 50, [ids.c]: 50 } } }),
    })

  it(
    'the users override holds for invitees, a PL 50 member converts, a member outside the map cannot, the creator keeps 100',
    async () => {
      const room = await createGroup(true)
      const plain = await createGroup(false)

      // 1. B is still in `invite` here (nobody joined yet).
      const born = await getState<PowerLevels>(tokens.a, room, 'm.room.power_levels')
      const reference = await getState<PowerLevels>(tokens.a, plain, 'm.room.power_levels')
      expect(born.users).toEqual({ [ids.a]: 100, [ids.b]: 50, [ids.c]: 50 })
      expect(born.events).toEqual(reference.events)

      // 2. B joins, sends the name, then the marker.
      await join(tokens.b, room)
      await putState(tokens.b, room, 'm.room.name', { name: `projeto-${rand()}` })
      await putState(tokens.b, room, MARKER, { kind: 'channel' })
      expect((await getState<{ kind?: string }>(tokens.a, room, MARKER)).kind).toBe('channel')

      // 3. Another identical room: D (outside the users map) joins and tries the marker.
      const other = await createGroup(true)
      await join(tokens.d, other)
      await expect(putState(tokens.d, other, MARKER, { kind: 'channel' })).rejects.toThrow(/-> 403 /)
      expect((await getState<{ kind?: string }>(tokens.a, other, MARKER)).kind).toBe('group')

      // 4. The creator is still at 100.
      const after = await getState<PowerLevels>(tokens.a, room, 'm.room.power_levels')
      expect(after.users?.[ids.a]).toBe(100)
    },
    300_000,
  )
})

// Marcador sempre-presente para o arquivo nunca ser suíte vazia com a stack down.
describe('group birth power levels (availability)', () => {
  it(SYNAPSE ? 'stack reachable — integration ran' : 'stack down — integration skipped', () => {
    expect(typeof SYNAPSE).toBe('boolean')
  })
})
