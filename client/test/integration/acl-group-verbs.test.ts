import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createAcl } from '../../src/acl'
import type { Acl, AclTelemetry, ChannelId, DomainEvent, UserId } from '../../src/acl'
import { findProtocolLeaks } from '@tayet/shared/leak-scan'
import { HOMESERVER, setDisplayName, synapseReachable, whoami } from '../support/synapse'
import { freshUsers } from '../support/fresh-users'
import { until } from '../support/until'

// ADR-094 (Proposto) dec. 6 to 9 — PR-2, the verbs through the real ACL (PLANO-CONVERSAS §8.2). Four virgin
// users, three connected ACLs (A, B, C). A opens a group with B and C: the three see kind 'group' with the
// right participants — for A, the creator, already on its channel.added, the first event of the id; A opens it again and gets the same id. B (not the creator, PL 50 from birth) converts
// it with a name: the three get channel.changed with kind 'private', '#name' and no `participants`. After the
// conversion B is an admin in the member list, and addMember works again in the room (B adds D).
// Auto-skip without the stack.

const SYNAPSE = synapseReachable()
const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const rand = (): string => Math.random().toString(36).slice(2, 8)

type Added = Extract<DomainEvent, { t: 'channel.added' }>
type Changed = Extract<DomainEvent, { t: 'channel.changed' }>

describe.skipIf(!SYNAPSE)('group conversation verbs through the ACL (ADR-094, C2)', () => {
  const people: { key: 'a' | 'b' | 'c'; id: string; acl: Acl; seen: DomainEvent[] }[] = []
  let dId = ''

  beforeAll(async () => {
    const [a, b, c, d] = await freshUsers(['gva', 'gvb', 'gvc', 'gvd'])
    const users = { a, b, c }
    for (const key of ['a', 'b', 'c'] as const) {
      const user = users[key]
      const id = await whoami(user.token)
      await setDisplayName(user.token, id, `${key.toUpperCase()} ${rand()}`)
      const acl = createAcl({ mode: 'strict', telemetry: noopTelemetry, serverUrl: HOMESERVER })
      const seen: DomainEvent[] = []
      await acl.connect(user.token as Parameters<Acl['connect']>[0])
      acl.subscribe((e) => seen.push(e))
      people.push({ key, id, acl, seen })
    }
    dId = await whoami(d.token)
  }, 240_000)

  afterAll(async () => {
    for (const p of people) await p.acl.disconnect()
  })

  it(
    'open → three see a group, reopen → same id, B converts → three see a private channel, B admin, addMember works',
    async () => {
      const [a, b, c] = people as [(typeof people)[0], (typeof people)[0], (typeof people)[0]]
      const id = await a.acl.openGroupConversation([b.id, c.id] as unknown as UserId[])
      const snapshot = (seen: DomainEvent[]) => () => seen.map((e) => e.t).join(',')

      for (const me of people) {
        const added = await until(
          'channel.added of the group',
          () => me.seen.find((e): e is Added => e.t === 'channel.added' && e.channel.id === id),
          { snapshot: snapshot(me.seen) },
        )
        // The channel.added may land before the others' invites are in this store: read it again.
        const group = await until(
          'group with both others as participants',
          async () => {
            const ch = await me.acl.getChannel(id)
            return ch.kind === 'group' && ch.participants?.length === 2 ? ch : undefined
          },
          { snapshot: snapshot(me.seen) },
        )
        // Every side, the creator included (ADR-094 dec. 3, round 2): the first lifecycle event of the id is a
        // channel.added already carrying the whole group — no channel.added/channel.changed of the id before it.
        const first = me.seen.find((e) => (e.t === 'channel.added' || e.t === 'channel.changed') && e.channel.id === id)
        expect(first).toBe(added)
        expect(added.channel.kind).toBe('group')
        if (me === a) expect(new Set(added.channel.participants as unknown as string[])).toEqual(new Set([b.id, c.id]))
        const others = people.filter((p) => p.id !== me.id).map((p) => p.id)
        expect(new Set(group.participants as unknown as string[])).toEqual(new Set(others))
        expect(findProtocolLeaks(group)).toEqual([])
      }

      expect(await a.acl.openGroupConversation([c.id, b.id] as unknown as UserId[])).toBe(id)

      const name = `projeto-${rand()}`
      await b.acl.convertToChannel(id as ChannelId, name)

      for (const me of people) {
        const changed = await until(
          'channel.changed private with the name',
          () =>
            me.seen.find(
              (e): e is Changed => e.t === 'channel.changed' && e.channel.id === id && e.channel.kind === 'private' && e.channel.name === `#${name}`,
            ),
          { snapshot: snapshot(me.seen) },
        )
        expect('participants' in changed.channel).toBe(false)
        expect(findProtocolLeaks(changed.channel)).toEqual([])
      }

      const roster = await a.acl.getMembers(id)
      expect(roster.find((r) => (r.user.id as unknown as string) === b.id)?.role).toBe('admin')

      await b.acl.addMember(id, dId as unknown as UserId)
      await until('D in the roster', async () => {
        const r = await a.acl.getMembers(id)
        return r.some((m) => (m.user.id as unknown as string) === dId) ? true : undefined
      })
    },
    300_000,
  )
})

// Marcador sempre-presente para o arquivo nunca ser suíte vazia com a stack down.
describe('group conversation verbs (availability)', () => {
  it(SYNAPSE ? 'stack reachable — integration ran' : 'stack down — integration skipped', () => {
    expect(typeof SYNAPSE).toBe('boolean')
  })
})
