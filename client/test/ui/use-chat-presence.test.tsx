// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { renderHook, act, cleanup, waitFor } from '@testing-library/react'
import { useChat } from '../../src/ui/useChat'
import type { Acl, DomainEvent, UserId } from '../../src/acl'

// ADR-056 rollout (PLANO-PRESENCA §8.4): o useChat mantém o mapa único `presenceByUser`,
// alimentado por UMA assinatura do stream global (user.presence → merge imutável). Os
// pass-throughs getPresence/subscribePresence permanecem intactos (o UserProfileDialog não
// migra pro mapa) — este arquivo prova só o mapa.

const uid = (s: string): UserId => s as unknown as UserId

// Fake Acl: stub inerte; subscribe captura o handler global p/ o teste dirigir user.presence.
// Modelado no fakeAcl de use-chat-access.test.tsx.
function fakeAcl(emitRef: { emit?: (e: DomainEvent) => void }): Acl {
  const noopUnsub = () => {}
  return {
    getChannels: async () => [],
    getArchivedChannels: async () => [],
    getChannel: async () => undefined as never,
    getMembers: async () => [],
    getDevices: async () => [],
    currentUser: async () => ({ id: uid('@me:tayet.local'), displayName: 'Me' }),
    getThreadUnread: async () => ({ unread: false }),
    getTimeline: async () => ({ items: [], nextCursor: undefined }),
    getPresence: () => 'offline' as const,
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
    connect: async () => {},
    disconnect: async () => {},
  } as unknown as Acl
}

afterEach(cleanup)

describe('useChat — mapa presenceByUser (ADR-056 rollout, §8.4)', () => {
  it('começa vazio e mergeia eventos user.presence por usuário', async () => {
    const emitRef: { emit?: (e: DomainEvent) => void } = {}
    const acl = fakeAcl(emitRef)
    const { result } = renderHook(() => useChat(acl))
    await waitFor(() => expect(emitRef.emit).toBeDefined())
    expect(result.current.presenceByUser).toEqual({})

    act(() => {
      emitRef.emit?.({ t: 'user.presence', user: uid('@ana:tayet.local'), presence: 'online' })
      emitRef.emit?.({ t: 'user.presence', user: uid('@bruno:tayet.local'), presence: 'away' })
    })
    expect(result.current.presenceByUser[uid('@ana:tayet.local')]).toBe('online')
    expect(result.current.presenceByUser[uid('@bruno:tayet.local')]).toBe('away')

    // Transição do mesmo usuário substitui a entrada (merge, não append).
    act(() => {
      emitRef.emit?.({ t: 'user.presence', user: uid('@ana:tayet.local'), presence: 'offline' })
    })
    expect(result.current.presenceByUser[uid('@ana:tayet.local')]).toBe('offline')
    expect(Object.keys(result.current.presenceByUser)).toHaveLength(2)
  })

  it('evento de mesmo valor preserva a identidade do mapa (nenhum re-render em vão)', async () => {
    const emitRef: { emit?: (e: DomainEvent) => void } = {}
    const acl = fakeAcl(emitRef)
    const { result } = renderHook(() => useChat(acl))
    await waitFor(() => expect(emitRef.emit).toBeDefined())

    act(() => {
      emitRef.emit?.({ t: 'user.presence', user: uid('@ana:tayet.local'), presence: 'online' })
    })
    const before = result.current.presenceByUser
    act(() => {
      emitRef.emit?.({ t: 'user.presence', user: uid('@ana:tayet.local'), presence: 'online' })
    })
    expect(result.current.presenceByUser).toBe(before)
  })
})
