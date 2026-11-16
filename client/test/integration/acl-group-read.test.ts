import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createAcl } from '../../src/acl'
import type { Acl, AclTelemetry, Channel, ChannelId, DomainEvent } from '../../src/acl'
import { findProtocolLeaks } from '@tayet/shared/leak-scan'
import { HOMESERVER, createUnnamedRoom, putState, setDisplayName, synapseReachable, whoami } from '../support/synapse'
import { freshUsers } from '../support/fresh-users'
import { until } from '../support/until'

// ADR-094 (Proposto) dec. 1 to 5 — PR-1, read side (PLANO-CONVERSAS §8.1). A group born OUTSIDE the
// product: three virgin users; the creator makes, by raw requests, a private-preset encrypted room with the
// conversation marker in the initial state and the two others invited. Both invitees (connected ACLs,
// ADR-044 auto-join) get channel.added with kind 'group', two participants and the people-derived name.
// Then, still from outside, the marker becomes { kind: 'channel' } and the room gets a name: both see
// channel.changed with kind 'private', a '#' name and no `participants` key. Auto-skip without the stack.

const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const MARKER = 'io.tayet.conversation'
const rand = (): string => Math.random().toString(36).slice(2, 8)

describe.skipIf(!SYNAPSE)('group conversation read side — a group born outside the product (ADR-094, C1)', () => {
  const acls: Acl[] = []
  const events = new Map<string, DomainEvent[]>()
  let creator: { token: string; id: string }
  let invitees: { name: string; id: string }[] = []
  const names = { creator: `Ana ${rand()}`, b: `Bruno ${rand()}`, c: `Caio ${rand()}` }

  beforeAll(async () => {
    const [a, b, c] = await freshUsers(['gra', 'grb', 'grc'])
    const [aId, bId, cId] = await Promise.all([whoami(a.token), whoami(b.token), whoami(c.token)])
    await setDisplayName(a.token, aId, names.creator)
    await setDisplayName(b.token, bId, names.b)
    await setDisplayName(c.token, cId, names.c)
    creator = { token: a.token, id: aId }
    invitees = [
      { name: names.b, id: bId },
      { name: names.c, id: cId },
    ]
    for (const [user, id] of [
      [b, bId],
      [c, cId],
    ] as const) {
      const acl = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
      const seen: DomainEvent[] = []
      await acl.connect(user.token as Parameters<Acl['connect']>[0])
      acl.subscribe((e) => seen.push(e))
      acls.push(acl)
      events.set(id, seen)
    }
  }, 240_000)

  afterAll(async () => {
    for (const acl of acls) await acl.disconnect()
  })

  it(
    'both invitees see channel.added as a group; the marker turned channel and a name → channel.changed private',
    async () => {
      const roomId = await createUnnamedRoom(creator.token, {
        invite: invitees.map((p) => p.id),
        initialState: [
          { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
          { type: MARKER, state_key: '', content: { kind: 'group' } },
        ],
      })
      const id = roomId as unknown as ChannelId
      const snapshot = (seen: DomainEvent[]) => () => seen.map((e) => e.t).join(',')

      for (const me of invitees) {
        const seen = events.get(me.id)!
        const added = await until(
          'channel.added of the group',
          () => seen.find((e): e is Extract<DomainEvent, { t: 'channel.added' }> => e.t === 'channel.added' && e.channel.id === id),
          { snapshot: snapshot(seen) },
        )
        const other = invitees.find((p) => p.id !== me.id)!
        const people = [names.creator, other.name].sort((x, y) => x.localeCompare(y, undefined, { sensitivity: 'base' }))
        expect(added.channel.kind).toBe('group')
        // The other invitee may still be in `invite`: still a participant (dec. 4).
        expect(added.channel.participants).toHaveLength(2)
        expect(new Set(added.channel.participants as unknown as string[])).toEqual(new Set([creator.id, other.id]))
        expect(added.channel.name).toBe(people.join(', '))
        expect('peer' in added.channel).toBe(false)
        expect(findProtocolLeaks(added.channel)).toEqual([])
      }

      // From outside: the marker becomes a channel, then the room gets a name.
      const channelName = `projeto-${rand()}`
      await putState(creator.token, roomId, MARKER, { kind: 'channel' })
      await putState(creator.token, roomId, 'm.room.name', { name: channelName })

      for (const me of invitees) {
        const seen = events.get(me.id)!
        const changed = await until(
          'channel.changed private with the name',
          () =>
            seen.find(
              (e): e is Extract<DomainEvent, { t: 'channel.changed' }> =>
                e.t === 'channel.changed' && e.channel.id === id && e.channel.kind === 'private' && e.channel.name === `#${channelName}`,
            ),
          { snapshot: snapshot(seen) },
        )
        const channel: Channel = changed.channel
        expect('participants' in channel).toBe(false)
        expect(findProtocolLeaks(channel)).toEqual([])
      }
    },
    300_000,
  )
})

// Marcador sempre-presente para o arquivo nunca ser suíte vazia com a stack down.
describe('group conversation read side (availability)', () => {
  it(SYNAPSE ? 'stack reachable — integration ran' : 'stack down — integration skipped', () => {
    expect(typeof SYNAPSE).toBe('boolean')
  })
})
