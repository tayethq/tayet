// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { renderHook, cleanup, waitFor } from '@testing-library/react'
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

// ADR-053 dec. 4 (PR-3) — loadCommonChannels: a interseção client-side dos canais visíveis com a
// membership do alvo. Derivação, não verbo de diretório (o barrel não ganha getCommonChannels). O
// alvo entra por ARGUMENTO. Cinco claims contra um FAKE Acl que espelha o contrato do real (getChannels
// devolve a lista visível; getMembers devolve o roster por-canal, síncrono/zero-rede no real):
//   (1) devolve só os canais onde o alvo é membro (interseção).
//   (2) um canal kind 'dm' onde o alvo é membro NÃO entra (o filtro é presentacional, ADR-026).
//   (3) preserva a ordem de `channels` — bate com a sidebar, não ordena por nome.
//   (4) alvo em nenhum canal → array vazio, sem throw.
//   (5) getMembers roda uma vez por canal NÃO-dm — o filtro de DM acontece ANTES do scan, não depois.

const cid = (s: string): ChannelId => s as unknown as ChannelId
const uid = (s: string): UserId => s as unknown as UserId

const alice: User = { id: uid('@alice:tayet.local'), displayName: 'Alice', kind: 'member' } // o ALVO
const bob: User = { id: uid('@bob:tayet.local'), displayName: 'Bob', kind: 'member' }
const me: User = { id: uid('@me:tayet.local'), displayName: 'Me', kind: 'member' } // o operador

// Ordem em `channels` deliberadamente NÃO-alfabética (#zulu, #alpha, #mike) para o teste 3: se a saída
// viesse ordenada por nome seria [#alpha?, #mike, #zulu]; preservada é [#zulu, #mike] (a ordem da entrada
// filtrada). chDm é um DM (kind 'dm') onde o alvo TAMBÉM é membro — o teste 2 prova que ele não entra.
const chZulu: Channel = {
  id: cid('!zulu:tayet.local'),
  name: '#zulu',
  kind: 'public',
  memberCount: 2,
  unread: { count: 0, mentions: 0 },
}
const chAlpha: Channel = {
  id: cid('!alpha:tayet.local'),
  name: '#alpha',
  kind: 'public',
  memberCount: 2,
  unread: { count: 0, mentions: 0 },
}
const chMike: Channel = {
  id: cid('!mike:tayet.local'),
  name: '#mike',
  kind: 'private',
  memberCount: 2,
  unread: { count: 0, mentions: 0 },
}
const chDm: Channel = {
  id: cid('!dm:tayet.local'),
  name: 'Alice',
  kind: 'dm',
  memberCount: 2,
  unread: { count: 0, mentions: 0 },
}

// Roster por canal. O alvo (alice) está em #zulu, #mike e no DM; ausente de #alpha.
const rosterOf: Record<string, Array<{ user: User; role: Role; state: MemberState; self: boolean }>> = {
  '!zulu:tayet.local': [
    { user: alice, role: 'member', state: 'active', self: false },
    { user: me, role: 'admin', state: 'active', self: true },
  ],
  '!alpha:tayet.local': [
    { user: bob, role: 'member', state: 'active', self: false },
    { user: me, role: 'admin', state: 'active', self: true },
  ],
  '!mike:tayet.local': [
    { user: alice, role: 'member', state: 'active', self: false },
    { user: bob, role: 'admin', state: 'active', self: false },
  ],
  '!dm:tayet.local': [
    { user: alice, role: 'member', state: 'active', self: false },
    { user: me, role: 'member', state: 'active', self: true },
  ],
}

function fakeAcl(over: {
  channels?: Channel[]
  getMembers?: Acl['getMembers']
}): Acl {
  const noopUnsub = () => {}
  return {
    getChannels: async () => over.channels ?? [chZulu, chAlpha, chMike, chDm],
    getArchivedChannels: async () => [],
    getChannel: async (id: ChannelId) =>
      (over.channels ?? [chZulu, chAlpha, chMike, chDm]).find((c) => c.id === id)!,
    getMembers:
      over.getMembers ?? (async (id: ChannelId) => rosterOf[id as unknown as string] ?? []),
    getDevices: async () => [],
    currentUser: async () => me,
    getThreadUnread: async () => ({ unread: false }),
    getTimeline: async () => ({ items: [] as Message[], nextCursor: undefined as PageCursor | undefined }),
    subscribe: (_handler: (e: DomainEvent) => void) => noopUnsub,
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
    createChannel: async () => cid('!new:tayet.local'),
    archiveChannel: async () => {},
    unarchiveChannel: async () => {},
    updateChannel: async () => {},
    leaveChannel: async () => {},
    addMember: async () => {},
    removeMember: async () => {},
    setRole: async () => {},
    openDirectMessage: async () => chDm.id,
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

describe('useChat — loadCommonChannels (ADR-053 dec. 4, PR-3)', () => {
  it('interseção: devolve só os canais onde o alvo é membro', async () => {
    const acl = fakeAcl({})
    const { result } = renderHook(() => useChat(acl))
    await waitFor(() => expect(result.current.channels.length).toBe(4))

    const common = await result.current.loadCommonChannels(alice.id)
    // O gate DESTE teste é o filtro de MEMBERSHIP, isolado do filtro de DM (teste 2): a alice é membro
    // de #zulu e #mike, NÃO de #alpha. Asserção robusta a um DM vazado — se o filtro de DM sumisse,
    // este continua verde e o teste 2 acusa. Ver o read-back de load-bearing.
    const names = common.map((c) => c.name)
    expect(names).toContain('#zulu')
    expect(names).toContain('#mike')
    expect(names).not.toContain('#alpha') // não-membro nunca entra
  })

  it("filtra DMs: canal com kind 'dm' onde o alvo é membro NÃO entra", async () => {
    const acl = fakeAcl({})
    const { result } = renderHook(() => useChat(acl))
    await waitFor(() => expect(result.current.channels.length).toBe(4))

    const common = await result.current.loadCommonChannels(alice.id)
    // O DM ('Alice') tem a alice no roster, mas kind 'dm' → fora. Sua ausência é o gate.
    expect(common.some((c) => c.kind === 'dm')).toBe(false)
    expect(common.map((c) => c.name)).not.toContain('Alice')
  })

  it('preserva a ordem de channels', async () => {
    const acl = fakeAcl({})
    const { result } = renderHook(() => useChat(acl))
    await waitFor(() => expect(result.current.channels.length).toBe(4))

    const common = await result.current.loadCommonChannels(alice.id)
    // A entrada é #zulu antes de #mike; ordenada por nome seria #mike antes de #zulu. Asserção de ordem
    // RELATIVA (índice de #zulu < índice de #mike) — o gate é a preservação da ordem, isolado do filtro
    // de DM: robusta a um DM vazado, então só os testes 2/5 caem se o filtro sumir.
    const names = common.map((c) => c.name)
    expect(names.indexOf('#zulu')).toBeLessThan(names.indexOf('#mike'))
    expect(names.indexOf('#zulu')).toBeGreaterThanOrEqual(0) // ambos presentes (não -1)
  })

  it('alvo em nenhum canal → array vazio, sem throw', async () => {
    const acl = fakeAcl({})
    const { result } = renderHook(() => useChat(acl))
    await waitFor(() => expect(result.current.channels.length).toBe(4))

    // Um alvo que não aparece em roster nenhum → a interseção é vazia; nada explode no `.some`.
    const common = await result.current.loadCommonChannels(uid('@ninguem:tayet.local'))
    expect(common).toEqual([])
  })

  it('chama getMembers uma vez por canal NÃO-dm', async () => {
    const getMembers = vi.fn(async (id: ChannelId) => rosterOf[id as unknown as string] ?? [])
    const acl = fakeAcl({ getMembers })
    const { result } = renderHook(() => useChat(acl))
    await waitFor(() => expect(result.current.channels.length).toBe(4))

    getMembers.mockClear() // o load inicial de canais pode ter chamado getMembers; medimos só a derivação.
    await result.current.loadCommonChannels(alice.id)
    // 4 canais na lista, 1 é DM → 3 chamadas. Prova que o filtro de kind acontece ANTES do scan de roster.
    expect(getMembers).toHaveBeenCalledTimes(3)
  })
})

// ADR-094 dec. 13: a group conversation is not a channel in common, even with the target among its people.
describe('useChat — loadCommonChannels sem conversa em grupo (ADR-094 dec. 13)', () => {
  const chGroup: Channel = {
    id: cid('!grupo:tayet.local'),
    name: 'Alice, Bob',
    kind: 'group',
    memberCount: 3,
    unread: { count: 0, mentions: 0 },
    participants: [alice.id, bob.id],
    participantAgents: 0,
  }
  const roster = (id: ChannelId) =>
    id === chGroup.id
      ? [
          { user: alice, role: 'member' as Role, state: 'active' as MemberState, self: false },
          { user: me, role: 'admin' as Role, state: 'active' as MemberState, self: true },
        ]
      : (rosterOf[id as unknown as string] ?? [])

  it('o grupo onde o alvo está não entra, e não é varrido', async () => {
    const getMembers = vi.fn(async (id: ChannelId) => roster(id))
    const acl = fakeAcl({ channels: [chZulu, chGroup, chMike], getMembers })
    const { result } = renderHook(() => useChat(acl))
    await waitFor(() => expect(result.current.channels.length).toBe(3))

    getMembers.mockClear()
    const common = await result.current.loadCommonChannels(alice.id)
    expect(common.map((c) => c.name)).toEqual(['#zulu', '#mike'])
    expect(getMembers).toHaveBeenCalledTimes(2)
  })
})
