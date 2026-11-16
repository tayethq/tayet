// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook, act, cleanup, waitFor } from '@testing-library/react'
import { useChat } from '../../src/ui/useChat'
import type { Acl, DomainEvent, Person, UserId } from '../../src/acl'

// ADR-083: a lista de Pessoas no useChat. isOrgAdmin é lido uma vez; people.changed relê listPeople,
// e uma rajada vira uma releitura (PLANO-PESSOAS §8.3: o evento dispara por evento de estado).

const person = (name: string): Person => ({
  user: { id: name as unknown as UserId, displayName: name, kind: 'member' },
  pending: false,
  self: false,
})

// Built once per spec: an unstable fake in the renderHook callback would loop the effects.
function fakeAcl(admin: boolean | Error, listPeople: () => Promise<Person[]>) {
  const handlers = new Set<(e: DomainEvent) => void>()
  const isOrgAdmin = vi.fn(async () => {
    if (admin instanceof Error) throw admin
    return admin
  })
  const acl = {
    isOrgAdmin,
    listPeople,
    getChannels: async () => [],
    getArchivedChannels: async () => [],
    getDevices: async () => [],
    currentUser: async () => ({ id: 'me', displayName: 'Me', kind: 'member' }),
    subscribe: (handler: (e: DomainEvent) => void) => {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
    subscribeChannel: () => () => {},
  } as unknown as Acl
  return { acl, isOrgAdmin, emit: (e: DomainEvent) => handlers.forEach((h) => h(e)) }
}

afterEach(cleanup)

describe('useChat — pessoas (ADR-083)', () => {
  it('admin: lê a lista, e 100 people.changed em sequência disparam uma releitura', async () => {
    let list = [person('Ana')]
    const listPeople = vi.fn(async () => list)
    const { acl, isOrgAdmin, emit } = fakeAcl(true, listPeople)
    const { result } = renderHook(() => useChat(acl))
    await waitFor(() => expect(result.current.people).toHaveLength(1))
    expect(result.current.orgAdmin).toBe(true)
    expect(listPeople).toHaveBeenCalledTimes(1)

    list = [person('Ana'), person('Bia')]
    await act(async () => {
      for (let i = 0; i < 100; i++) emit({ t: 'people.changed' })
    })
    await waitFor(() => expect(result.current.people).toHaveLength(2))
    expect(listPeople).toHaveBeenCalledTimes(2)
    expect(isOrgAdmin).toHaveBeenCalledTimes(1)
  })

  it('quem não é admin não lê a lista nem assina o evento', async () => {
    const listPeople = vi.fn(async () => [person('Ana')])
    const { acl, isOrgAdmin, emit } = fakeAcl(false, listPeople)
    const { result } = renderHook(() => useChat(acl))
    await waitFor(() => expect(isOrgAdmin).toHaveBeenCalled())
    await act(async () => emit({ t: 'people.changed' }))
    expect(result.current.orgAdmin).toBe(false)
    expect(listPeople).not.toHaveBeenCalled()
  })

  it('falha do serviço deixa a seção ausente', async () => {
    const listPeople = vi.fn(async () => [])
    const { acl, isOrgAdmin } = fakeAcl(new Error('down'), listPeople)
    const { result } = renderHook(() => useChat(acl))
    await waitFor(() => expect(isOrgAdmin).toHaveBeenCalled())
    await act(async () => {})
    expect(result.current.orgAdmin).toBe(false)
  })
})
