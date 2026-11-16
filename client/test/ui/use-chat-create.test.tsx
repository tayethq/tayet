// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook, act, cleanup, waitFor } from '@testing-library/react'
import { useChat } from '../../src/ui/useChat'
import type {
  Acl,
  Channel,
  ChannelId,
  DomainEvent,
  Message,
  PageCursor,
  Role,
  MemberState,
  User,
  UserId,
} from '../../src/acl'

// Track U/U3 — the creation seam in useChat (ADR-029). Three claims, all against a FAKE Acl that
// mimics the real one's stream contract (createChannel/openDirectMessage resolve to a ChannelId; the
// room then lands via a channel.added event):
//   (i)  listKnownContacts returns the union of visible members MINUS the operator (PLANO-PRESENCA
//        §8.6 item 2) — no managed-channel guard, no roster exclusion — distinct from
//        listCandidates (F4 sibling). With currentUser unresolved (boot/harness) it degrades to
//        the raw union: the ACL contract is the backstop.
//   (ii) createChannel arms the returned id and selects it ONLY after the matching channel.added
//        fires (seam S1: the room is not in the SDK store when the verb resolves).
//   (iii) openDirectMessage for a DM ALREADY in `channels` selects it immediately — no channel.added
//        is awaited (idempotent fast-path).
//   (iv) openDirectMessage for a DM ABSENT from `channels` (the memo fast-path's pre-sync case) arms
//        pendingSelect and selects on its channel.added — the same on-added path as (ii), so S1 is
//        the single uniform route covering both verbs, not merely defensive.

const cid = (s: string): ChannelId => s as unknown as ChannelId
const uid = (s: string): UserId => s as unknown as UserId

const alice: User = { id: uid('@alice:tayet.local'), displayName: 'Alice', kind: 'member' }
const bob: User = { id: uid('@bob:tayet.local'), displayName: 'Bob', kind: 'member' }
const carol: User = { id: uid('@carol:tayet.local'), displayName: 'Carol', kind: 'member' }

// chA = a normal channel (the managed one); chDm = a pre-existing DM already in the list.
const chA: Channel = {
  id: cid('!a:tayet.local'),
  name: '#engineering',
  kind: 'public',
  memberCount: 2,
  unread: { count: 0, mentions: 0 },
}
const chDm: Channel = {
  id: cid('!dm:tayet.local'),
  name: 'Carol',
  kind: 'dm',
  memberCount: 2,
  unread: { count: 0, mentions: 0 },
}

// Roster per channel: chA has alice+bob; chDm has carol. So the union of visible members is
// {alice, bob, carol}. chA's roster (members state, once managed) = {alice, bob}.
const rosterOf: Record<string, Array<{ user: User; role: Role; state: MemberState; self: boolean }>> = {
  '!a:tayet.local': [
    { user: alice, role: 'admin', state: 'active', self: false },
    { user: bob, role: 'member', state: 'active', self: false },
  ],
  '!dm:tayet.local': [{ user: carol, role: 'member', state: 'active', self: false }],
}

// A fake Acl: captures the top-level subscribe handler so the test can drive channel.added, and lets
// each spec override createChannel/openDirectMessage. Everything else is an inert stub.
function fakeAcl(over: {
  createChannel?: Acl['createChannel']
  openDirectMessage?: Acl['openDirectMessage']
  openGroupConversation?: Acl['openGroupConversation']
  getMembers?: Acl['getMembers']
  currentUser?: Acl['currentUser']
  listOwnAgents?: Acl['listOwnAgents']
  emitRef?: { emit?: (e: DomainEvent) => void }
}): Acl {
  const noopUnsub = () => {}
  return {
    getChannels: async () => [chA, chDm],
    getArchivedChannels: async () => [],
    getChannel: async (id: ChannelId) => [chA, chDm].find((c) => c.id === id)!,
    getMembers: over.getMembers ?? (async (id: ChannelId) => rosterOf[id as unknown as string] ?? []),
    getDevices: async () => [],
    listOwnAgents: over.listOwnAgents ?? (() => []),
    currentUser: over.currentUser ?? (async () => ({ id: uid('@me:tayet.local'), displayName: 'Me' })),
    getThreadUnread: async () => ({ unread: false }),
    getTimeline: async () => ({ items: [] as Message[], nextCursor: undefined as PageCursor | undefined }),
    subscribe: (handler: (e: DomainEvent) => void) => {
      if (over.emitRef) over.emitRef.emit = handler
      return noopUnsub
    },
    subscribeChannel: () => noopUnsub,
    sendMessage: async () => uid('txn') as unknown as Message['id'],
    editMessage: async () => {},
    deleteMessage: async () => {},
    react: async () => {},
    removeReaction: async () => {},
    markRead: async () => {},
    acknowledgeAccess: () => {},
    resetAccess: async () => ({ t: 'done', historyPreserved: true }),
    resolveMedia: async () => ({ url: '', release: () => {} }),
    resolveChannel: async () => ({ ok: false, reason: 'not-found' }),
    resolveUser: async () => ({ ok: false, reason: 'not-found' }),
    createChannel: over.createChannel ?? (async () => cid('!new:tayet.local')),
    archiveChannel: async () => {},
    unarchiveChannel: async () => {},
    updateChannel: async () => {},
    leaveChannel: async () => {},
    addMember: async () => {},
    removeMember: async () => {},
    setRole: async () => {},
    openDirectMessage: over.openDirectMessage ?? (async () => chDm.id),
    openGroupConversation:
      over.openGroupConversation ??
      (async () => {
        throw new Error('group verb not used in this test')
      }),
    convertToChannel: async () => {
      throw new Error('group verb not used in this test')
    },
    connect: async () => {},
    disconnect: async () => {},
  } as unknown as Acl
}

afterEach(cleanup)

describe('useChat — creation seam (Track U/U3, ADR-029)', () => {
  it('(i) listKnownContacts is the union minus self; listCandidates layers guard + roster exclusion', async () => {
    const acl = fakeAcl({}) // built once: a stable identity, like App's injected acl (no render churn)
    const { result } = renderHook(() => useChat(acl))
    // Let the initial channel load settle.
    await waitFor(() => expect(result.current.channels.length).toBe(2))

    // Union over both channels' members, deduped + sorted by displayName (the operator is not in
    // any roster here — the exclusion itself is claim (v)).
    const known = await result.current.listKnownContacts()
    expect(known.map((u) => u.displayName)).toEqual(['Alice', 'Bob', 'Carol'])

    // Without a managed channel, listCandidates is empty (guard). It is genuinely a DIFFERENT path.
    expect(await result.current.listCandidates()).toEqual([])

    // Manage chA → its roster (alice, bob) loads → listCandidates excludes them, listKnownContacts
    // still returns the full union. This is the F4 distinction made observable.
    act(() => result.current.manageChannel(chA))
    await waitFor(() => expect(result.current.members.length).toBe(2))

    const candidates = await result.current.listCandidates()
    expect(candidates.map((u) => u.displayName)).toEqual(['Carol'])
    const knownAgain = await result.current.listKnownContacts()
    expect(knownAgain.map((u) => u.displayName)).toEqual(['Alice', 'Bob', 'Carol'])
  })

  it('(ii) createChannel selects the new id ONLY after its channel.added arrives (seam S1)', async () => {
    const newId = cid('!new:tayet.local')
    const emitRef: { emit?: (e: DomainEvent) => void } = {}
    const created = vi.fn(async () => newId)
    const acl = fakeAcl({ createChannel: created, emitRef })
    const { result } = renderHook(() => useChat(acl))
    await waitFor(() => expect(result.current.channels.length).toBe(2))

    await act(async () => {
      await result.current.createChannel({ name: 'launch', kind: 'public' })
    })
    expect(created).toHaveBeenCalledWith({ name: 'launch', kind: 'public' })
    // S1: the room is not in the store yet → the new id is NOT selected.
    expect(result.current.selectedId).not.toBe(newId)

    // The room lands via the stream → NOW the armed id is selected.
    const newChannel: Channel = { ...chA, id: newId, name: '#launch' }
    act(() => emitRef.emit?.({ t: 'channel.added', channel: newChannel }))
    await waitFor(() => expect(result.current.selectedId).toBe(newId))
  })

  it('(iii) openDirectMessage for an already-present DM selects immediately (no channel.added)', async () => {
    const emitRef: { emit?: (e: DomainEvent) => void } = {}
    const opened = vi.fn(async () => chDm.id) // returns a DM already in `channels`
    const acl = fakeAcl({ openDirectMessage: opened, emitRef })
    const { result } = renderHook(() => useChat(acl))
    await waitFor(() => expect(result.current.channels.length).toBe(2))

    await act(async () => {
      await result.current.openDirectMessage(carol.id)
    })
    expect(opened).toHaveBeenCalledWith(carol.id)
    // Idempotent fast-path: the DM was already in the list, so it is selected without any stream event.
    expect(result.current.selectedId).toBe(chDm.id)
  })

  it('(iv) openDirectMessage for an ABSENT DM arms pendingSelect and selects on its channel.added (seam S1)', async () => {
    // A FRESH id, guaranteed ABSENT from the fake's `channels` seed [chA, chDm] — otherwise it would
    // fall into (iii)'s immediate fast-path. dave is likewise outside every roster.
    const newDmId = cid('!dm2:tayet.local')
    const dave = uid('@dave:tayet.local')
    const emitRef: { emit?: (e: DomainEvent) => void } = {}
    const opened = vi.fn(async () => newDmId)
    const acl = fakeAcl({ openDirectMessage: opened, emitRef })
    const { result } = renderHook(() => useChat(acl))
    await waitFor(() => expect(result.current.channels.length).toBe(2))

    await act(async () => {
      await result.current.openDirectMessage(dave)
    })
    expect(opened).toHaveBeenCalledWith(dave)
    // The DM is NOT in `channels` → the id is ARMED (pendingSelect), not selected yet. Same read as
    // (ii): selectedId stays on the initial-load pick (chA), never the absent DM.
    expect(result.current.selectedId).not.toBe(newDmId)

    // Its channel.added lands → the armed id is selected, via the SAME on-added path as createChannel.
    const newDmChannel: Channel = { ...chDm, id: newDmId, name: 'Dave' }
    act(() => emitRef.emit?.({ t: 'channel.added', channel: newDmChannel }))
    await waitFor(() => expect(result.current.selectedId).toBe(newDmId))
  })

  it('(vi) openGroupConversation for a set that already has a group selects it immediately (ADR-094 dec. 8)', async () => {
    const emitRef: { emit?: (e: DomainEvent) => void } = {}
    const opened = vi.fn(async () => chDm.id) // the verb returns a conversation already in `channels`
    const acl = fakeAcl({ openGroupConversation: opened, emitRef })
    const { result } = renderHook(() => useChat(acl))
    await waitFor(() => expect(result.current.channels.length).toBe(2))

    await act(async () => {
      await result.current.openGroupConversation([carol.id, bob.id])
    })
    expect(opened).toHaveBeenCalledWith([carol.id, bob.id])
    expect(result.current.selectedId).toBe(chDm.id)
  })

  it('(vii) openGroupConversation for a NEW group arms pendingSelect and selects on its channel.added (seam S1)', async () => {
    const newGroupId = cid('!grupo:tayet.local')
    const emitRef: { emit?: (e: DomainEvent) => void } = {}
    const opened = vi.fn(async () => newGroupId)
    const acl = fakeAcl({ openGroupConversation: opened, emitRef })
    const { result } = renderHook(() => useChat(acl))
    await waitFor(() => expect(result.current.channels.length).toBe(2))

    await act(async () => {
      await result.current.openGroupConversation([alice.id, bob.id])
    })
    expect(result.current.selectedId).not.toBe(newGroupId)

    const newGroup: Channel = {
      ...chDm,
      id: newGroupId,
      name: 'Alice, Bob',
      kind: 'group',
      participants: [alice.id, bob.id],
      participantAgents: 0,
    }
    act(() => emitRef.emit?.({ t: 'channel.added', channel: newGroup }))
    await waitFor(() => expect(result.current.selectedId).toBe(newGroupId))
  })

  it('(v) listKnownContacts excludes the operator when a roster includes them (§8.6 item 2)', async () => {
    // chA's roster now includes the operator (the realistic case: the self is a member of every
    // visible channel). The picker offer must not contain them.
    const me: User = { id: uid('@me:tayet.local'), displayName: 'Me', kind: 'member' }
    const acl = fakeAcl({
      getMembers: async (id: ChannelId) =>
        id === chA.id
          ? [...rosterOf['!a:tayet.local']!, { user: me, role: 'member' as Role, state: 'active' as MemberState, self: true }]
          : (rosterOf[id as unknown as string] ?? []),
    })
    const { result } = renderHook(() => useChat(acl))
    await waitFor(() => expect(result.current.channels.length).toBe(2))
    // The filter keys off currentUser — wait for the self-identity read to settle first.
    await waitFor(() => expect(result.current.currentUser).not.toBeNull())

    const known = await result.current.listKnownContacts()
    expect(known.map((u) => u.displayName)).toEqual(['Alice', 'Bob', 'Carol'])
  })

  it('(vi) with currentUser unresolved, listKnownContacts degrades to the raw union (backstop is the contract)', async () => {
    // currentUser rejecting leaves useChat's currentUser null (the boot/harness window) — the
    // filter degrades gracefully and the ACL guard remains the backstop.
    const me: User = { id: uid('@me:tayet.local'), displayName: 'Me', kind: 'member' }
    const acl = fakeAcl({
      currentUser: async () => Promise.reject(new Error('unavailable')),
      getMembers: async (id: ChannelId) =>
        id === chA.id
          ? [...rosterOf['!a:tayet.local']!, { user: me, role: 'member' as Role, state: 'active' as MemberState, self: true }]
          : (rosterOf[id as unknown as string] ?? []),
    })
    const { result } = renderHook(() => useChat(acl))
    await waitFor(() => expect(result.current.channels.length).toBe(2))

    const known = await result.current.listKnownContacts()
    expect(known.map((u) => u.displayName)).toEqual(['Alice', 'Bob', 'Carol', 'Me'])
  })

  it('(vii) ADR-090: agents in the union are dropped; own agents are offered, roster-excluded in listCandidates', async () => {
    const mine: User = { id: uid('@a-mineaaaa2345:tayet.local'), displayName: 'Bot meu', kind: 'agent', agentColor: 'ardosia' }
    const theirs: User = { id: uid('@a-theirsaa2345:tayet.local'), displayName: 'Bot alheio', kind: 'agent', agentColor: 'malva' }
    const mineElsewhere: User = { id: uid('@a-minebbbb2345:tayet.local'), displayName: 'Agenda', kind: 'agent', agentColor: 'ocre' }
    const row = (user: User, self = false) => ({ user, role: 'member' as Role, state: 'active' as MemberState, self })
    const acl = fakeAcl({
      // chA has alice, bob, MY agent (already in the roster) and someone else's agent; chDm has carol.
      getMembers: async (id: ChannelId) =>
        id === chA.id
          ? [...rosterOf['!a:tayet.local']!, row(mine), row(theirs)]
          : (rosterOf[id as unknown as string] ?? []),
      // Own agents: the one in chA and one in no visible channel (offered anyway — it is mine).
      listOwnAgents: () => [mine, mineElsewhere],
    })
    const { result } = renderHook(() => useChat(acl))
    await waitFor(() => expect(result.current.channels.length).toBe(2))
    await waitFor(() => expect(result.current.currentUser).not.toBeNull())

    // Deduped (mine appears once), someone else's agent gone, sorted with the union's comparator.
    const known = await result.current.listKnownContacts()
    expect(known.map((u) => u.displayName)).toEqual(['Agenda', 'Alice', 'Bob', 'Bot meu', 'Carol'])

    act(() => result.current.manageChannel(chA))
    await waitFor(() => expect(result.current.members.length).toBe(4))
    // chA's roster (alice, bob, mine, theirs) is excluded; mineElsewhere stays offered.
    const candidates = await result.current.listCandidates()
    expect(candidates.map((u) => u.displayName)).toEqual(['Agenda', 'Carol'])

    expect(result.current.isOwnAgent(mine.id)).toBe(true)
    expect(result.current.isOwnAgent(theirs.id)).toBe(false)
  })
})
