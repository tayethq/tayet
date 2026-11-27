// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { renderHook, act, cleanup, waitFor } from '@testing-library/react'
import { useChat } from '../../src/ui/useChat'
import type { Acl, AccessId, Device, DeviceId, DomainEvent, Timestamp, UserId } from '../../src/acl'

// ADR-018, complemento proativo: useChat carrega os acessos conhecidos no connect (getDevices →
// mapeado para KnownAccess, lastSeen descartado — §8.A2) e atualiza a lista quando account.newAccess
// dispara, para um acesso recém-aparecido entrar além do banner dispensável.

const did = (s: string): DeviceId => s as unknown as DeviceId
const tms = (n: number): Timestamp => n as unknown as Timestamp

// Fake Acl: stub inerte; getDevices retorna o fixture; subscribe captura o handler global p/ o teste
// dirigir account.newAccess. Modelado no fakeAcl de use-chat-create_test.tsx.
function fakeAcl(devices: () => Device[], emitRef: { emit?: (e: DomainEvent) => void }): Acl {
  const noopUnsub = () => {}
  return {
    getChannels: async () => [],
    getArchivedChannels: async () => [],
    getChannel: async () => undefined as never,
    getMembers: async () => [],
    getDevices: async () => devices(),
    currentUser: async () => ({ id: '@me:tayet.local' as unknown as UserId, displayName: 'Me' }),
    getThreadUnread: async () => ({ unread: false }),
    getTimeline: async () => ({ items: [], nextCursor: undefined }),
    getConnectionState: () => 'connecting' as const,
    getChannelAbilities: () => ({ rename: false, editTopic: false, addPeople: false, removePeople: false, setRoles: false, archive: false }),
    subscribe: (handler: (e: DomainEvent) => void) => {
      emitRef.emit = handler
      return noopUnsub
    },
    subscribeChannel: () => noopUnsub,
    sendMessage: async () => undefined as never,
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
    createChannel: async () => undefined as never,
    archiveChannel: async () => {},
    unarchiveChannel: async () => {},
    updateChannel: async () => {},
    leaveChannel: async () => {},
    addMember: async () => {},
    removeMember: async () => {},
    setRole: async () => {},
    openDirectMessage: async () => undefined as never,
    openGroupConversation: async () => {
      throw new Error('group verb not used in this test')
    },
    convertToChannel: async () => {
      throw new Error('group verb not used in this test')
    },
    connect: async () => {},
    disconnect: async () => {},
  } as unknown as Acl
}

afterEach(cleanup)

describe('useChat — acessos conhecidos (ADR-018, complemento proativo)', () => {
  it('carrega acessos no connect, mapeando Device → KnownAccess com lastSeen', async () => {
    const emitRef: { emit?: (e: DomainEvent) => void } = {}
    const acl = fakeAcl(
      () => [
        { id: did('DEVAAA'), friendlyName: 'Notebook', lastSeen: tms(1), current: false },
        { id: did('DEVBBB'), friendlyName: 'Celular', current: false },
      ],
      emitRef,
    )
    const { result } = renderHook(() => useChat(acl))
    await waitFor(() => expect(result.current.accesses.length).toBe(2))
    expect(result.current.accesses.map((a) => a.friendlyName)).toEqual(['Notebook', 'Celular'])
    // KnownAccess carrega id + friendlyName + current (§8.A3) + lastSeen (account-access §2).
    expect(Object.keys(result.current.accesses[0]!).sort()).toEqual(['current', 'friendlyName', 'id', 'lastSeen'])
    expect(result.current.accesses[0]!.lastSeen).toBe(tms(1))
    expect(result.current.accesses[1]!.lastSeen).toBeUndefined()
  })

  it('atualiza a lista de acessos quando account.newAccess dispara', async () => {
    const emitRef: { emit?: (e: DomainEvent) => void } = {}
    let roster: Device[] = [{ id: did('DEVAAA'), friendlyName: 'Notebook', current: false }]
    const acl = fakeAcl(() => roster, emitRef)
    const { result } = renderHook(() => useChat(acl))
    await waitFor(() => expect(result.current.accesses.length).toBe(1))

    // Um novo acesso surge; o evento chega → a lista faz APPEND INCREMENTAL do e.device (sem refetch
    // de getDevices — §8.L23) e passa a mostrá-lo. (roster atualizado por simetria; não é re-buscado.)
    roster = [
      { id: did('DEVAAA'), friendlyName: 'Notebook', current: false },
      { id: did('DEVCCC'), friendlyName: 'Tablet', current: false },
    ]
    act(() => {
      emitRef.emit?.({
        t: 'account.newAccess',
        access: 'ACC' as unknown as AccessId,
        device: { id: did('DEVCCC'), friendlyName: 'Tablet', current: false },
        at: tms(2),
      })
    })
    await waitFor(() => expect(result.current.accesses.length).toBe(2))
    expect(result.current.accesses.map((a) => a.friendlyName)).toContain('Tablet')
  })
})

describe('useChat — acesso reconhecido (ADR-063)', () => {
  const newAccess = (access: string, device: string): DomainEvent => ({
    t: 'account.newAccess',
    access: access as unknown as AccessId,
    device: { id: did(device), friendlyName: device, current: false },
    at: tms(1),
  })

  it('account.accessRecognized tira só o aviso daquele acesso; a lista de acessos fica', async () => {
    const emitRef: { emit?: (e: DomainEvent) => void } = {}
    const acl = fakeAcl(() => [], emitRef)
    const { result } = renderHook(() => useChat(acl))
    await waitFor(() => expect(emitRef.emit).toBeDefined())
    act(() => {
      emitRef.emit?.(newAccess('ACC_B', 'DEVBBB'))
      emitRef.emit?.(newAccess('ACC_C', 'DEVCCC'))
    })
    await waitFor(() => expect(result.current.newAccesses.length).toBe(2))

    act(() => emitRef.emit?.({ t: 'account.accessRecognized', access: 'ACC_B' as unknown as AccessId }))
    await waitFor(() => expect(result.current.newAccesses.map((a) => a.access)).toEqual(['ACC_C']))
    // Reconhecido continua sendo um acesso da conta.
    expect(result.current.accesses.map((a) => a.id)).toEqual([did('DEVBBB'), did('DEVCCC')])

    // Acesso que a UI nunca anunciou: no-op.
    act(() => emitRef.emit?.({ t: 'account.accessRecognized', access: 'ACC_Z' as unknown as AccessId }))
    expect(result.current.newAccesses.map((a) => a.access)).toEqual(['ACC_C'])
  })
})
