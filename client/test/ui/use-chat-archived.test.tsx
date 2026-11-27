// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook, act, cleanup, waitFor } from '@testing-library/react'
import { useChat } from '../../src/ui/useChat'
import type { Acl, Channel, ChannelId, DomainEvent, Message, PageCursor, UserId } from '../../src/acl'

// ADR-076 dec. 4-5 — the archived list in useChat, against a FAKE Acl with a controllable stream:
//   (a) the initial snapshot splits active (getChannels) from archived (getArchivedChannels);
//   (b) channel.added routes by `archived`: true → archived list, omitted → active list — and an
//       un-armed channel.added (a restore) does NOT select it (§9 item 7);
//   (c) channel.removed drops the id from BOTH lists and re-snapshots getArchivedChannels;
//   (d) unarchiveChannel calls the Acl verb and its rejection propagates (the component owns it).

const cid = (s: string): ChannelId => s as unknown as ChannelId
const uid = (s: string): UserId => s as unknown as UserId

const ch = (id: string, name: string, archived?: true): Channel => ({
  id: cid(id),
  name,
  kind: 'public',
  memberCount: 2,
  unread: { count: 0, mentions: 0 },
  ...(archived && { archived }),
})

const chA = ch('!a:tayet.local', '#engineering')
const chB = ch('!b:tayet.local', '#design')
const chOld = ch('!old:tayet.local', '#old', true)

function fakeAcl(over: {
  archived?: () => Promise<Channel[]>
  unarchiveChannel?: Acl['unarchiveChannel']
  emitRef: { emit?: (e: DomainEvent) => void }
}): Acl {
  const noopUnsub = () => {}
  return {
    getChannels: async () => [chA, chB],
    getArchivedChannels: over.archived ?? (async () => [chOld]),
    getChannel: async (id: ChannelId) => [chA, chB, chOld].find((c) => c.id === id)!,
    getMembers: async () => [],
    getDevices: async () => [],
    currentUser: async () => ({ id: uid('@me:tayet.local'), displayName: 'Me' }),
    getThreadUnread: async () => ({ unread: false }),
    getTimeline: async () => ({ items: [] as Message[], nextCursor: undefined as PageCursor | undefined }),
    getConnectionState: () => 'connecting' as const,
    getChannelAbilities: () => ({ rename: false, editTopic: false, addPeople: false, removePeople: false, setRoles: false, archive: false }),
    subscribe: (handler: (e: DomainEvent) => void) => {
      over.emitRef.emit = handler
      return noopUnsub
    },
    subscribeChannel: () => noopUnsub,
    markRead: async () => {},
    acknowledgeAccess: () => {},
    archiveChannel: async () => {},
    unarchiveChannel: over.unarchiveChannel ?? (async () => {}),
    connect: async () => {},
    disconnect: async () => {},
  } as unknown as Acl
}

const ids = (cs: Channel[]) => cs.map((c) => c.id as unknown as string)

afterEach(cleanup)

describe('useChat — archived channels (ADR-076 dec. 4-5)', () => {
  it('(a) the initial snapshot splits active from archived', async () => {
    const acl = fakeAcl({ emitRef: {} })
    const { result } = renderHook(() => useChat(acl))
    await waitFor(() => expect(ids(result.current.archivedChannels)).toEqual(['!old:tayet.local']))
    expect(ids(result.current.channels)).toEqual(['!a:tayet.local', '!b:tayet.local'])
  })

  it('(b) channel.added routes by `archived`; a restore is not selected', async () => {
    const emitRef: { emit?: (e: DomainEvent) => void } = {}
    const acl = fakeAcl({ emitRef })
    const { result } = renderHook(() => useChat(acl))
    await waitFor(() => expect(result.current.archivedChannels.length).toBe(1))
    expect(result.current.selectedId).toBe(chA.id)

    // Entered an already-archived room (dec. 4): archived list, never the active one.
    const chInv = ch('!inv:tayet.local', '#invited-archived', true)
    act(() => emitRef.emit!({ t: 'channel.added', channel: chInv }))
    expect(ids(result.current.archivedChannels)).toEqual(['!old:tayet.local', '!inv:tayet.local'])
    expect(ids(result.current.channels)).not.toContain('!inv:tayet.local')

    // Restore: archived omitted → leaves the archived list, appended to the active one, not selected.
    const { archived: _drop, ...restored } = chOld
    act(() => emitRef.emit!({ t: 'channel.added', channel: restored }))
    expect(ids(result.current.channels)).toEqual(['!a:tayet.local', '!b:tayet.local', '!old:tayet.local'])
    expect(ids(result.current.archivedChannels)).toEqual(['!inv:tayet.local'])
    expect(result.current.selectedId).toBe(chA.id)
  })

  it('(c) channel.removed drops from both lists and re-snapshots the archived read', async () => {
    const emitRef: { emit?: (e: DomainEvent) => void } = {}
    // First call = boot snapshot; second = the re-snapshot after removal (chB was archived).
    const archived = vi
      .fn<() => Promise<Channel[]>>()
      .mockResolvedValueOnce([chOld])
      .mockResolvedValueOnce([chOld, ch('!b:tayet.local', '#design', true)])
    const acl = fakeAcl({ emitRef, archived })
    const { result } = renderHook(() => useChat(acl))
    await waitFor(() => expect(result.current.archivedChannels.length).toBe(1))

    act(() => emitRef.emit!({ t: 'channel.removed', channelId: chB.id }))
    expect(ids(result.current.channels)).toEqual(['!a:tayet.local'])
    await waitFor(() =>
      expect(ids(result.current.archivedChannels)).toEqual(['!old:tayet.local', '!b:tayet.local']),
    )
    expect(archived).toHaveBeenCalledTimes(2)

    // Removal of an archived channel (kicked from it): gone from the archived list at once.
    archived.mockResolvedValueOnce([ch('!b:tayet.local', '#design', true)])
    act(() => emitRef.emit!({ t: 'channel.removed', channelId: chOld.id }))
    expect(ids(result.current.archivedChannels)).toEqual(['!b:tayet.local'])
  })

  it('(d) unarchiveChannel calls the Acl verb; a rejection propagates', async () => {
    const verb = vi.fn<Acl['unarchiveChannel']>(async () => {})
    const acl = fakeAcl({ emitRef: {}, unarchiveChannel: verb })
    const { result } = renderHook(() => useChat(acl))
    await waitFor(() => expect(result.current.archivedChannels.length).toBe(1))

    await act(() => result.current.unarchiveChannel(chOld.id))
    expect(verb).toHaveBeenCalledWith(chOld.id)

    verb.mockRejectedValueOnce(new Error('forbidden'))
    await expect(result.current.unarchiveChannel(chOld.id)).rejects.toThrow('forbidden')
    // Not optimistic: nothing moved without the stream.
    expect(ids(result.current.archivedChannels)).toEqual(['!old:tayet.local'])
  })
})
