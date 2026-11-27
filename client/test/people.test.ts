import { describe, it, expect } from 'vitest'
import { MatrixGateway } from '../src/acl/internal/matrix-client'
import type { PeopleClient, PersonInviteOutcome } from '../src/acl/internal/escrow-client'
import { LastAdminError, NotMemberError, OrgAccessDeniedError, PeopleUnavailableError, PersonExistsError } from '../src/acl'
import type { AclTelemetry, ChannelId, UserId } from '../src/acl'
import { findProtocolLeaks } from '@tayet/shared/leak-scan'
import { directInviteHttp } from './support/direct-invite'

// Os verbos de Pessoas (ADR-083) num gateway com SDK falso: a lista sai do state de #all, o pendente
// de membership, e o convite tem duas fases. O caminho real roda em integration/acl-people.test.ts.

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const ME = '@alice:tayet.local'
const ORG = '!all:tayet.local'

type Membership = 'join' | 'invite' | 'leave'

function fakeRoom(roomId: string, members: Record<string, Membership>, events: Array<[string, unknown]> = []) {
  const member = (userId: string) =>
    members[userId] === undefined
      ? null
      : { userId, membership: members[userId], rawDisplayName: userId, getMxcAvatarUrl: () => null }
  return {
    roomId,
    getMyMembership: () => members[ME] ?? 'leave',
    getCanonicalAlias: () => (roomId === ORG ? '#all:tayet.local' : null),
    getMember: member,
    currentState: {
      getStateEvents: (_type: string, key?: string) => {
        const all = events.map(([stateKey, content]) => ({ getStateKey: () => stateKey, getContent: () => content }))
        return key === undefined ? all : (all.find((e) => e.getStateKey() === key) ?? null)
      },
    },
  }
}

function gatewayWith(rooms: Array<ReturnType<typeof fakeRoom>>, invited: string[] = []) {
  const gateway = new MatrixGateway({ mode: 'strict', telemetry: noopTelemetry, serverUrl: 'http://x' })
  const client = {
    getUserId: () => ME,
    getRooms: () => rooms,
    getRoom: (id: string) => rooms.find((r) => r.roomId === id) ?? null,
    getAccountData: () => undefined,
    // The ACL invites by a direct call (ADR-057, addendum of 24/Nov/2026).
    http: directInviteHttp((channel: string) => {
      invited.push(channel)
      return channel === '!falha:tayet.local' ? Promise.reject(new Error('no')) : Promise.resolve({})
    }),
  }
  ;(gateway as unknown as { client: unknown }).client = client
  return gateway
}

const withPeople = (gateway: MatrixGateway, people: Partial<PeopleClient>): MatrixGateway => {
  ;(gateway as unknown as { people: Partial<PeopleClient> }).people = people
  return gateway
}

describe('listPeople', () => {
  const ana = '@ana:tayet.local'
  const gil = '@u-abcdefghij23:tayet.local'
  const org = fakeRoom(ORG, { [ME]: 'join', [ana]: 'invite', '@system:tayet.local': 'join' }, [
    ['alice:tayet.local', { kind: 'member', name: 'Alice', email: 'alice@tayet.local' }],
    ['ana:tayet.local', { kind: 'member', name: 'Ana Lima', email: 'ana@fora.com' }],
    ['u-abcdefghij23:tayet.local', { kind: 'guest', name: 'Gil', email: 'gil@fora.com' }],
    ['ivo:tayet.local', { kind: 'guest', name: 'Ivo' }],
    ['removido:tayet.local', {}],
    ['system:tayet.local', { kind: 'member' }],
    ['cofre:tayet.local', { kind: 'member' }],
  ])
  const shared = fakeRoom('!sala:tayet.local', { [ME]: 'join', [gil]: 'invite' })

  it('uma linha por evento, com nome digitado, email, kind e self; removido e contas de serviço fora', () => {
    const people = gatewayWith([org, shared]).listPeople()
    expect(people.map((p) => p.user.displayName)).toEqual(['Alice', 'Ana Lima', 'Gil', 'Ivo'])
    expect(people.map((p) => p.user.kind)).toEqual(['member', 'member', 'guest', 'guest'])
    expect(people[1]!.email).toBe('ana@fora.com')
    expect(people[3]!.email).toBeUndefined()
    expect(people.filter((p) => p.self).map((p) => p.user.displayName)).toEqual(['Alice'])
    expect(findProtocolLeaks(people)).toEqual([])
  })

  it('pendente: convite de #all para membro, convite em canal compartilhado para guest, senão não', () => {
    const pending = gatewayWith([org, shared]).listPeople().filter((p) => p.pending)
    expect(pending.map((p) => p.user.displayName)).toEqual(['Ana Lima', 'Gil'])
    expect(gatewayWith([org]).listPeople().some((p) => p.user.id === (gil as unknown as UserId) && p.pending)).toBe(false)
  })

  // ADR-086; account-access.md §11: a linha do agente é "operado por" e "Remover", nunca pendente —
  // o agente não aceita convite como uma pessoa, então o `invite` dele numa sala compartilhada não é estado.
  it('pendente por kind: agente em invite numa sala compartilhada não; convidado e membro em invite sim', () => {
    const agent = '@a-abcdefgh2345:tayet.local'
    const all = fakeRoom(ORG, { [ME]: 'join', [ana]: 'invite' }, [
      ['alice:tayet.local', { kind: 'member', name: 'Alice' }],
      ['ana:tayet.local', { kind: 'member', name: 'Ana Lima' }],
      ['u-abcdefghij23:tayet.local', { kind: 'guest', name: 'Gil' }],
      ['a-abcdefgh2345:tayet.local', { kind: 'agent', name: 'Relatórios', operator: 'alice' }],
    ])
    const room = fakeRoom('!sala:tayet.local', { [ME]: 'join', [gil]: 'invite', [agent]: 'invite' })
    const byName = new Map(gatewayWith([all, room]).listPeople().map((p) => [p.user.displayName, p]))
    expect(byName.get('Relatórios')).toMatchObject({ pending: false, user: { kind: 'agent', operatorName: 'Alice' } })
    expect(byName.get('Gil')?.pending).toBe(true)
    expect(byName.get('Ana Lima')?.pending).toBe(true)
  })

  it('fora de #all a lista é vazia', () => {
    expect(gatewayWith([fakeRoom(ORG, { [ME]: 'invite' }), shared]).listPeople()).toEqual([])
  })
})

describe('invitePerson', () => {
  const person = { name: 'Ana', email: 'ana@fora.com', kind: 'guest' as const, channels: [] as ChannelId[] }
  const answered = (outcome: PersonInviteOutcome): Partial<PeopleClient> => ({ invite: async () => outcome })
  const invited: PersonInviteOutcome = { kind: 'invited', userId: '@u-x:tayet.local', personKind: 'guest' }

  it('duas fases: canal que falha volta em failedChannels e o convite vale', async () => {
    const asked: string[] = []
    const channels = ['!ok:tayet.local', '!falha:tayet.local'] as unknown as ChannelId[]
    const result = await withPeople(gatewayWith([], asked), answered(invited)).invitePerson({ ...person, channels })
    expect(asked).toEqual(channels)
    expect(result.failedChannels).toEqual(['!falha:tayet.local'])
    expect(result.user).toMatchObject({ displayName: 'Ana', kind: 'guest' })
  })

  it('o kind gravado no servidor vence o pedido', async () => {
    const gateway = withPeople(gatewayWith([]), answered({ ...invited, personKind: 'member' }))
    expect((await gateway.invitePerson(person)).user.kind).toBe('member')
  })

  it('409 → PersonExistsError, sem tocar nos canais', async () => {
    const asked: string[] = []
    const channels = ['!ok:tayet.local'] as unknown as ChannelId[]
    const gateway = withPeople(gatewayWith([], asked), answered({ kind: 'exists' }))
    await expect(gateway.invitePerson({ ...person, channels })).rejects.toBeInstanceOf(PersonExistsError)
    expect(asked).toEqual([])
  })

  it('timeout, 504 ou escrow não provisionado → PeopleUnavailableError', async () => {
    const down = withPeople(gatewayWith([]), answered({ kind: 'unavailable' }))
    await expect(down.invitePerson(person)).rejects.toBeInstanceOf(PeopleUnavailableError)
    await expect(gatewayWith([]).invitePerson(person)).rejects.toBeInstanceOf(PeopleUnavailableError)
  })

  it('400 não é indisponibilidade', async () => {
    const gateway = withPeople(gatewayWith([]), answered({ kind: 'rejected' }))
    await expect(gateway.invitePerson(person)).rejects.not.toBeInstanceOf(PeopleUnavailableError)
  })

  it('403 é OrgAccessDeniedError e derruba o memo do isOrgAdmin (ADR-118 dec. 6)', async () => {
    const gateway = withPeople(gatewayWith([]), { ...answered({ kind: 'forbidden' }), isAdmin: async () => true })
    expect(await gateway.isOrgAdmin()).toBe(true)
    await expect(gateway.invitePerson(person)).rejects.toBeInstanceOf(OrgAccessDeniedError)
    expect(await gateway.isOrgAdmin()).toBe(false)
  })
})

describe('removePerson e isOrgAdmin', () => {
  it('remove pelo id do domínio; serviço fora → PeopleUnavailableError', async () => {
    const removed: string[] = []
    const gateway = withPeople(gatewayWith([]), {
      remove: async (id) => {
        removed.push(id)
        return { kind: 'removed' }
      },
    })
    await gateway.removePerson('@u-x:tayet.local' as unknown as UserId)
    expect(removed).toEqual(['@u-x:tayet.local'])
    const down = withPeople(gatewayWith([]), { remove: async () => ({ kind: 'unavailable' }) })
    await expect(down.removePerson('@u-x:tayet.local' as unknown as UserId)).rejects.toBeInstanceOf(
      PeopleUnavailableError,
    )
  })

  it('isOrgAdmin pergunta uma vez por connect; sem escrow é false', async () => {
    let asked = 0
    const gateway = withPeople(gatewayWith([]), {
      isAdmin: async () => {
        asked += 1
        return true
      },
    })
    expect(await gateway.isOrgAdmin()).toBe(true)
    expect(await gateway.isOrgAdmin()).toBe(true)
    expect(asked).toBe(1)
    expect(await gatewayWith([]).isOrgAdmin()).toBe(false)
  })
})

// ADR-118 dec. 4 a 6 (fatia 1c): a leitura do papel, o verbo e a queda do memo.
describe('getOrgAccess, setOrgAdmin e a R6', () => {
  const ana = '@ana:tayet.local' as unknown as UserId
  const admin = (extra: Partial<PeopleClient>): MatrixGateway => {
    let asked = 0
    const gateway = withPeople(gatewayWith([]), {
      isAdmin: async () => {
        asked += 1
        return true
      },
      ...extra,
    })
    ;(gateway as unknown as { asked: () => number }).asked = () => asked
    return gateway
  }

  it('lê os dois conjuntos com ids do domínio', async () => {
    const gateway = admin({ access: async () => ({ kind: 'access', admins: [ME], withoutAccess: ['@ana:tayet.local'] }) })
    expect(await gateway.getOrgAccess()).toEqual({ admins: [ME], withoutAccess: ['@ana:tayet.local'] })
  })

  it.each([
    ['forbidden', OrgAccessDeniedError],
    ['unavailable', PeopleUnavailableError],
  ] as const)('leitura %s → %s', async (kind, Err) => {
    const gateway = admin({ access: async () => ({ kind }) })
    await expect(gateway.getOrgAccess()).rejects.toBeInstanceOf(Err)
    await expect(gatewayWith([]).getOrgAccess()).rejects.toBeInstanceOf(PeopleUnavailableError)
  })

  it('403 na leitura derruba o memo, sem pergunta nova', async () => {
    const gateway = admin({ access: async () => ({ kind: 'forbidden' }) })
    expect(await gateway.isOrgAdmin()).toBe(true)
    await expect(gateway.getOrgAccess()).rejects.toBeInstanceOf(OrgAccessDeniedError)
    expect(await gateway.isOrgAdmin()).toBe(false)
    expect((gateway as unknown as { asked: () => number }).asked()).toBe(1)
  })

  it.each([
    ['last_admin', LastAdminError],
    ['not_member', NotMemberError],
    ['forbidden', OrgAccessDeniedError],
    ['unavailable', PeopleUnavailableError],
  ] as const)('verbo %s → %s', async (kind, Err) => {
    const gateway = admin({ setAdmin: async () => ({ kind }) })
    await expect(gateway.setOrgAdmin(ana, true)).rejects.toBeInstanceOf(Err)
  })

  it('verbo rejeitado é erro comum, sem derrubar o memo', async () => {
    const gateway = admin({ setAdmin: async () => ({ kind: 'rejected' }) })
    expect(await gateway.isOrgAdmin()).toBe(true)
    const err = await gateway.setOrgAdmin(ana, true).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(PeopleUnavailableError)
    expect(await gateway.isOrgAdmin()).toBe(true)
  })

  it('promove e rebaixa outra pessoa pelo id cru; o memo fica', async () => {
    const calls: Array<[string, boolean]> = []
    const gateway = admin({
      setAdmin: async (id, on) => {
        calls.push([id, on])
        return { kind: 'done' }
      },
    })
    expect(await gateway.isOrgAdmin()).toBe(true)
    await gateway.setOrgAdmin(ana, true)
    await gateway.setOrgAdmin(ana, false)
    expect(calls).toEqual([
      ['@ana:tayet.local', true],
      ['@ana:tayet.local', false],
    ])
    expect(await gateway.isOrgAdmin()).toBe(true)
  })

  it('rebaixar a si mesmo derruba o memo na hora (C6)', async () => {
    const gateway = admin({ setAdmin: async () => ({ kind: 'done' }) })
    expect(await gateway.isOrgAdmin()).toBe(true)
    await gateway.setOrgAdmin(ME as unknown as UserId, false)
    expect(await gateway.isOrgAdmin()).toBe(false)
  })
})
