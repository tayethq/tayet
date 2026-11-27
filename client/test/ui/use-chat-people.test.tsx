// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook, act, cleanup, waitFor } from '@testing-library/react'
import { useChat } from '../../src/ui/useChat'
import type { Acl, DomainEvent, Person, UserId } from '../../src/acl'
import { OrgAccessDeniedError } from '../../src/acl'

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
    getConnectionState: () => 'connecting' as const,
    getChannelAbilities: () => ({ rename: false, editTopic: false, addPeople: false, removePeople: false, setRoles: false, archive: false }),
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

// ADR-118 dec. 6 (R6, C2, C6; fatia 1c): o orgAdmin cai sem recarregar num 403 de leitura ou de verbo de
// organização, e depois de rebaixar a si mesmo; a ACL já derrubou o memo, o estado segue.
describe('useChat — R6', () => {
  function roleAcl(over: Partial<Acl>) {
    let admin = true
    const { acl } = fakeAcl(true, async () => [person('Ana')])
    const full = Object.assign(acl, {
      isOrgAdmin: vi.fn(async () => admin),
      ...over,
    }) as Acl
    return { acl: full, drop: () => (admin = false) }
  }
  const denied = (drop: () => void) => () => {
    drop()
    return Promise.reject(new OrgAccessDeniedError())
  }

  it('403 na leitura do papel: orgAdmin cai e o erro chega a quem chamou', async () => {
    const box: { drop?: () => void } = {}
    const { acl, drop } = roleAcl({ getOrgAccess: () => denied(box.drop!)() })
    box.drop = drop
    const { result } = renderHook(() => useChat(acl))
    await waitFor(() => expect(result.current.orgAdmin).toBe(true))
    await act(async () => {
      await expect(result.current.getOrgAccess()).rejects.toBeInstanceOf(OrgAccessDeniedError)
    })
    expect(result.current.orgAdmin).toBe(false)
  })

  it.each(['setOrgAdmin', 'invitePerson', 'removePerson', 'createAgent', 'removeAgent'] as const)(
    '403 no verbo %s: orgAdmin cai',
    async (verb) => {
      const box: { drop?: () => void } = {}
      const { acl, drop } = roleAcl({ [verb]: () => denied(box.drop!)() } as Partial<Acl>)
      box.drop = drop
      const { result } = renderHook(() => useChat(acl))
      await waitFor(() => expect(result.current.orgAdmin).toBe(true))
      const call = (result.current[verb] as (...a: unknown[]) => Promise<unknown>)('@x:t', true)
      await act(async () => {
        await expect(call).rejects.toBeInstanceOf(OrgAccessDeniedError)
      })
      expect(result.current.orgAdmin).toBe(false)
    },
  )

  it('outros erros não derrubam', async () => {
    const { acl } = roleAcl({ getOrgAccess: () => Promise.reject(new Error('down')) })
    const { result } = renderHook(() => useChat(acl))
    await waitFor(() => expect(result.current.orgAdmin).toBe(true))
    await act(async () => {
      await expect(result.current.getOrgAccess()).rejects.toThrow('down')
    })
    expect(result.current.orgAdmin).toBe(true)
  })

  it('C6: rebaixar a si mesmo derruba no 200 (a ACL respondeu isOrgAdmin false)', async () => {
    const box: { drop?: () => void } = {}
    const { acl, drop } = roleAcl({
      setOrgAdmin: async () => {
        box.drop!()
      },
    })
    box.drop = drop
    const { result } = renderHook(() => useChat(acl))
    await waitFor(() => expect(result.current.orgAdmin).toBe(true))
    await act(async () => {
      await result.current.setOrgAdmin('@me:t' as unknown as UserId, false)
    })
    expect(result.current.orgAdmin).toBe(false)
  })

  it('promover ou rebaixar outra pessoa não mexe no orgAdmin', async () => {
    const { acl } = roleAcl({ setOrgAdmin: async () => {} })
    const { result } = renderHook(() => useChat(acl))
    await waitFor(() => expect(result.current.orgAdmin).toBe(true))
    await act(async () => {
      await result.current.setOrgAdmin('@ana:t' as unknown as UserId, false)
    })
    expect(result.current.orgAdmin).toBe(true)
  })
})
