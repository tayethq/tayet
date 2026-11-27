import { describe, it, expect, afterEach } from 'vitest'
import { createAcl } from '../../src/acl'
import { encryptedBirthState } from '../../src/acl/internal/custody'
import type { Acl, Channel, ChannelId, DomainEvent, UserId } from '../../src/acl'
import { HOMESERVER, synapseReachable, whoami, mintToken, createUnnamedRoom, leave } from '../support/synapse'
import { freshUsers } from '../support/fresh-users'
import { until } from '../support/until'

// Stack gate of ADR-116: the direct conversation is born with `io.tayet.conversation`
// `{ kind: 'direct' }`, and a marked room outside the direct-conversation map is still read as one.
//
// 1. Recovery: the conversation is opened by the product, its map entry is erased on the server for both
//    people, and both come back in new sessions (new devices: in Node the same device cannot reconnect, its
//    crypto store is in memory, ADR-062 D2). The conversation is direct on both sides with the right person,
//    opening it again returns the same room, and the map has the entry again (dec. 2, 4 and 5).
// 2. The first event. Through openDirectMessage, the room's first event on each side is its channel.added, already
//    direct with the right person, and no channel.changed re-classifies it: the creator's sync brings the room in
//    pieces (the creation and the join, then the marker, then the peer's invite), so its channel.added is held while
//    the opening is in flight (dec. 10). For a marked room created on the wire (no opening, no overlay or memo; the
//    invite without `is_direct`, so the invitee writes no map), nothing is held: the creator's first direct
//    classification arrives with the right peer, in the channel.added or in a channel.changed; the invitee's store
//    has the marker at its join (ADR-094 records that the stripped state of the invite does not carry it).
// 3. Negative control: a marked room with two other people is not a direct conversation (dec. 2).
// 4. The creator (PR #515 review, dec. 2): a third party creates a marked room, invites two people without
//    `is_direct` and leaves. Each of them has exactly one other person there, and the room is still not a direct
//    conversation for either: no map entry after 4 s, and opening a direct conversation between them makes another
//    room. The recovery case (1) is the positive side: the invitee reads the room as direct, so its store has the
//    `m.room.create` in the state.
// Fresh users per run (#32); auto-skip without the stack (issue #7).

const SYNAPSE = synapseReachable()
const MARKER = { type: 'io.tayet.conversation', state_key: '', content: { kind: 'direct' } }
const sessions: Acl[] = []

function session(): Acl {
  const acl = createAcl({ mode: 'strict', telemetry: { untranslated: () => {} }, serverUrl: HOMESERVER })
  sessions.push(acl)
  return acl
}

// Every channel.added and channel.changed this session emits, in order, with the channel as it was.
type Seen = { t: 'channel.added' | 'channel.changed'; channel: Channel }
function eventsOf(acl: Acl): Seen[] {
  const seen: Seen[] = []
  acl.subscribe((e: DomainEvent) => {
    if (e.t === 'channel.added' || e.t === 'channel.changed') seen.push({ t: e.t, channel: e.channel })
  })
  return seen
}
const ofRoom = (seen: Seen[], room: string) => seen.filter((e) => String(e.channel.id) === room)
// ADR-116 dec. 10: the room's first event is its channel.added, already direct with the peer, and no channel.changed
// after it re-classifies the room.
function directFromTheStart(seen: Seen[], room: string, peer: string): void {
  const events = ofRoom(seen, room)
  expect(events[0]?.t).toBe('channel.added')
  expect(events.filter((e) => e.t === 'channel.added')).toHaveLength(1)
  for (const e of events) {
    expect(e.channel.kind, `${e.t} re-classified the room`).toBe('dm')
    expect(String(e.channel.peer)).toBe(peer)
  }
}

async function connect(acl: Acl, token: string): Promise<void> {
  await acl.connect(token as Parameters<Acl['connect']>[0])
}

async function directMap(token: string, mxid: string): Promise<Record<string, string[]>> {
  const res = await fetch(`${HOMESERVER}/_matrix/client/v3/user/${encodeURIComponent(mxid)}/account_data/m.direct`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (res.status === 404) return {}
  if (res.status !== 200) throw new Error(`m.direct read -> ${res.status}`)
  return (await res.json()) as Record<string, string[]>
}

async function eraseDirectMap(token: string, mxid: string): Promise<void> {
  const res = await fetch(`${HOMESERVER}/_matrix/client/v3/user/${encodeURIComponent(mxid)}/account_data/m.direct`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: '{}',
  })
  if (res.status !== 200) throw new Error(`m.direct erase -> ${res.status}`)
}

const channelOf = (acl: Acl, id: ChannelId) => async (): Promise<Channel | undefined> =>
  (await acl.getChannels()).find((c) => c.id === id)

describe.skipIf(!SYNAPSE)('direct conversation birth marker: ACL ↔ real stack (ADR-116)', () => {
  afterEach(async () => {
    for (const acl of sessions.splice(0)) await acl.disconnect().catch(() => {})
  })

  it('a marked conversation erased from both maps comes back direct on both sides, reopens the same room, and the map is rewritten', async () => {
    const [a, b] = await freshUsers(['dma', 'dmb'])
    const mxidA = await whoami(a.token)
    const mxidB = await whoami(b.token)
    const aliceFirst = session()
    const bobFirst = session()
    await connect(aliceFirst, a.token)
    await connect(bobFirst, b.token)
    const id = await aliceFirst.openDirectMessage(mxidB as UserId)
    await until('B sees the direct conversation', async () => ((await channelOf(bobFirst, id)())?.kind === 'dm' ? true : undefined))
    // Issue #421: B joined after its first sync, so its live window is the server's default 10 events, without the
    // room's creation (the birth marker is one event more); the first read fetches one page back and ends there.
    expect((await bobFirst.getTimeline(id)).nextCursor).toBeUndefined()
    await until('both maps have the room', async () =>
      (await directMap(a.token, mxidA))[mxidB]?.includes(String(id)) &&
      (await directMap(b.token, mxidB))[mxidA]?.includes(String(id))
        ? true
        : undefined,
    )
    await aliceFirst.disconnect()
    await bobFirst.disconnect()

    await eraseDirectMap(a.token, mxidA)
    await eraseDirectMap(b.token, mxidB)

    const tokenA2 = await mintToken(a.name)
    const tokenB2 = await mintToken(b.name)
    const alice = session()
    const bob = session()
    await connect(alice, tokenA2)
    await connect(bob, tokenB2)

    const onA = await until('A sees the room', channelOf(alice, id))
    const onB = await until('B sees the room', channelOf(bob, id))
    expect(onA.kind).toBe('dm')
    expect(String(onA.peer)).toBe(mxidB)
    expect(onB.kind).toBe('dm')
    expect(String(onB.peer)).toBe(mxidA)

    expect(String(await alice.openDirectMessage(mxidB as UserId))).toBe(String(id))

    await until('the maps have the room again', async () =>
      (await directMap(tokenA2, mxidA))[mxidB]?.includes(String(id)) &&
      (await directMap(tokenB2, mxidB))[mxidA]?.includes(String(id))
        ? true
        : undefined,
    )
  }, 240_000)

  it('the first event of a direct conversation is its channel.added, direct with the peer, on both sides; with two others it is not', async () => {
    const [a, b, c] = await freshUsers(['dmc', 'dmd', 'dme'])
    const mxidA = await whoami(a.token)
    const mxidB = await whoami(b.token)
    const mxidC = await whoami(c.token)
    const alice = session()
    const bob = session()
    const seenA = eventsOf(alice)
    const seenB = eventsOf(bob)
    await connect(alice, a.token)
    await connect(bob, b.token)
    const settled = (seen: Seen[], room: string, label: string) =>
      until(label, async () => (ofRoom(seen, room).some((e) => e.channel.kind === 'dm') ? true : undefined))

    // Through the product's verb.
    const opened = String(await alice.openDirectMessage(mxidB as UserId))
    await settled(seenA, opened, 'creator: the opened conversation')
    await settled(seenB, opened, 'invitee: the opened conversation')

    // Made on the wire, with the marker and nothing else from the product.
    const direct = await createUnnamedRoom(a.token, { invite: [mxidB], initialState: [...encryptedBirthState(), MARKER] })
    await settled(seenA, direct, 'creator: the room made on the wire')
    await settled(seenB, direct, 'invitee: the room made on the wire')

    // Room for a late re-classification to show up before reading.
    await new Promise((r) => setTimeout(r, 1_500))
    directFromTheStart(seenA, opened, mxidB)
    directFromTheStart(seenB, opened, mxidA)
    // Outside the verb nothing is held (dec. 10): the creator's first direct classification may come in a
    // channel.changed, once the peer's invite is in; the invitee's room is whole at its join.
    const firstDirect = ofRoom(seenA, direct).find((e) => e.channel.kind === 'dm')!
    expect(String(firstDirect.channel.peer)).toBe(mxidB)
    directFromTheStart(seenB, direct, mxidA)

    const crowded = await createUnnamedRoom(a.token, { invite: [mxidB, mxidC], initialState: [...encryptedBirthState(), MARKER] })
    const crowdedOnA = await until('creator channel.added (two others)', async () =>
      ofRoom(seenA, crowded).find((e) => e.t === 'channel.added'),
    )
    await new Promise((r) => setTimeout(r, 1_500))
    const last = ofRoom(seenA, crowded).at(-1)!
    expect(last.channel.kind).toBe('private')
    expect('peer' in last.channel).toBe(false)
    expect(crowdedOnA.channel.kind).toBe('private')
  }, 180_000)

  it('a marked room created by a third party who invited two people and left is a direct conversation for neither', async () => {
    const [c, v, b] = await freshUsers(['dmf', 'dmg', 'dmh'])
    const mxidC = await whoami(c.token)
    const mxidV = await whoami(v.token)
    const mxidB = await whoami(b.token)
    const vee = session()
    const bee = session()
    await connect(vee, v.token)
    await connect(bee, b.token)

    const room = (await createUnnamedRoom(c.token, {
      invite: [mxidV, mxidB],
      initialState: [...encryptedBirthState(), MARKER],
    })) as ChannelId
    // ADR-044: both sessions take the invite; the room is theirs once both have joined.
    const joinedBoth = (acl: Acl) => async () =>
      (await acl.getMembers(room)).filter((m) => m.state === 'active').length === 3 ? true : undefined
    await until('V sees the three joined', joinedBoth(vee))
    await until('B sees the three joined', joinedBoth(bee))
    await leave(c.token, room)
    const cGone = (acl: Acl) => async () =>
      (await acl.getMembers(room)).some((m) => String(m.user.id) === mxidC) ? undefined : true
    await until("V sees C's leave", cGone(vee))
    await until("B sees C's leave", cGone(bee))

    // Past the rewrite's wait (dec. 5): nothing may be written.
    await new Promise((r) => setTimeout(r, 4_000))
    expect((await channelOf(vee, room)())?.kind).not.toBe('dm')
    expect((await channelOf(bee, room)())?.kind).not.toBe('dm')
    expect(Object.values(await directMap(v.token, mxidV)).flat()).not.toContain(String(room))
    expect(Object.values(await directMap(b.token, mxidB)).flat()).not.toContain(String(room))

    expect(String(await vee.openDirectMessage(mxidB as UserId))).not.toBe(String(room))
  }, 180_000)
})

describe('direct conversation birth marker (availability)', () => {
  it(SYNAPSE ? 'stack reachable' : 'stack down — skipped', () => {
    expect(typeof SYNAPSE).toBe('boolean')
  })
})
