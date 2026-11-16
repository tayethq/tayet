// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { Workspace } from '../../src/ui/components/Workspace'
import type {
  Channel,
  ChannelId,
  Message,
  MessageId,
  Role,
  MemberState,
  User,
  UserId,
  UserProfile,
} from '../../src/acl'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'

// Perfil-de-outro (ADR-043, Slice 2 PR-2): os DOIS entry points in-room abrem a sub-tela read-only.
// Aqui montamos o Workspace (estado openProfile + UserProfileDialog vivem nele) com onLoadUserProfile
// ligado e exercemos os dois affordances: o header de autor na Timeline e a linha de membro no
// ChannelManagementPanel. Ids de fixture carregam shape de protocolo de propósito (residual ADR-008)
// e NUNCA chegam ao DOM — o leak-scan prova; os aria-label carregam o nome limpo, nunca o id.

const cid = (s: string): ChannelId => s as unknown as ChannelId
const uid = (s: string): UserId => s as unknown as UserId
const mid = (s: string): MessageId => s as unknown as MessageId
const tms = (n: number) => n as unknown as Message['sentAt']

afterEach(cleanup)

const channel: Channel = {
  id: cid('!engineering:tayet.local'), // protocol-shaped de propósito
  name: '#engineering',
  kind: 'public',
  topic: '',
  memberCount: 2,
  unread: { count: 0, mentions: 0 },
}
const bob: User = { id: uid('@bob:tayet.local'), displayName: 'Bob Brown', kind: 'member' }
const alice: User = { id: uid('@alice:tayet.local'), displayName: 'Alice Stone', kind: 'member' }
const usersById: Record<string, User> = { [bob.id]: bob, [alice.id]: alice }

const message: Message = {
  id: mid('$m1:tayet.local'),
  channelId: channel.id,
  author: bob.id,
  body: { kind: 'text', text: 'Olá a todos' },
  sentAt: tms(1),
  reactions: [],
  mine: false,
  mentionsMe: false,
}

const bobProfile: UserProfile = { id: bob.id, displayName: 'Bob Brown', kind: 'member', pronouns: 'ele/dele' }
const aliceProfile: UserProfile = { id: alice.id, displayName: 'Alice Stone', kind: 'member' }

const DM_CTA = 'Enviar mensagem'

const noopVerb = () => Promise.resolve()
const members: Array<{ user: User; role: Role; state: MemberState; self: boolean }> = [
  { user: alice, role: 'member', state: 'active', self: false },
  { user: bob, role: 'admin', state: 'active', self: false },
]

describe('Perfil-de-outro — entry points (ADR-043)', () => {
  it('clicar no autor (group-start) abre o perfil e dispara onLoadUserProfile(authorId)', async () => {
    const loaded: UserId[] = []
    const onLoadUserProfile = async (u: UserId): Promise<UserProfile> => {
      loaded.push(u)
      return bobProfile
    }
    const { getAllByRole, container } = render(
      <Workspace
        channels={[channel]}
        selectedChannelId={channel.id}
        messages={[message]}
        usersById={usersById}
        connection="connected"
        onLoadUserProfile={onLoadUserProfile}
        onSelectChannel={() => {}}
        onSend={() => {}}
      />,
    )

    // O header de autor expõe o affordance no avatar E no nome (mesmo handler).
    const authorBtns = getAllByRole('button', { name: 'Ver perfil de Bob Brown' })
    expect(authorBtns.length).toBe(2)
    fireEvent.click(authorBtns[0]!)

    // A sub-tela monta e dispara o load com o UserId do autor.
    await waitFor(() =>
      expect(container.querySelector('.user-profile__name')?.textContent).toBe('Bob Brown'),
    )
    expect(loaded).toEqual([bob.id])
    expect(container.textContent ?? '').toContain('ele/dele') // pronomes carregados
  })

  it('clicar numa linha de membro do roster abre o perfil e dispara onLoadUserProfile(memberId)', async () => {
    const loaded: UserId[] = []
    const onLoadUserProfile = async (u: UserId): Promise<UserProfile> => {
      loaded.push(u)
      return aliceProfile
    }
    const { getByRole, container } = render(
      <Workspace
        channels={[channel]}
        selectedChannelId={channel.id}
        messages={[]}
        usersById={{}}
        connection="connected"
        managing={channel}
        members={members}
        onManageChannel={() => {}}
        onCloseManage={() => {}}
        onUpdateChannel={noopVerb}
        onArchiveChannel={noopVerb}
        onLeaveChannel={noopVerb}
        onAddMember={noopVerb}
        onRemoveMember={noopVerb}
        onSetRole={noopVerb}
        loadCandidates={() => Promise.resolve([])}
        onLoadUserProfile={onLoadUserProfile}
        onSelectChannel={() => {}}
        onSend={() => {}}
      />,
    )

    fireEvent.click(getByRole('button', { name: 'Ver perfil de Alice Stone' }))

    await waitFor(() =>
      expect(container.querySelector('.user-profile__name')?.textContent).toBe('Alice Stone'),
    )
    expect(loaded).toEqual([alice.id])
  })

  it('render-scan: os dois affordances não vazam id no DOM; aria-label carrega o nome limpo', () => {
    const { container, getAllByRole, getByRole } = render(
      <Workspace
        channels={[channel]}
        selectedChannelId={channel.id}
        messages={[message]}
        usersById={usersById}
        connection="connected"
        managing={channel}
        members={members}
        onManageChannel={() => {}}
        onCloseManage={() => {}}
        onUpdateChannel={noopVerb}
        onArchiveChannel={noopVerb}
        onLeaveChannel={noopVerb}
        onAddMember={noopVerb}
        onRemoveMember={noopVerb}
        onSetRole={noopVerb}
        loadCandidates={() => Promise.resolve([])}
        onLoadUserProfile={async () => bobProfile}
        onSelectChannel={() => {}}
        onSend={() => {}}
      />,
    )

    // Header de autor clicável (avatar + nome) e linha de membro clicável presentes, com aria-label
    // pelo NOME limpo — nunca o id.
    expect(getAllByRole('button', { name: 'Ver perfil de Bob Brown' }).length).toBeGreaterThan(0)
    expect(getByRole('button', { name: 'Ver perfil de Alice Stone' })).toBeTruthy()

    // O id opaco (shape de protocolo) não chega ao DOM por nenhum dos affordances.
    expect(container.innerHTML).not.toContain('@bob:tayet.local')
    expect(container.innerHTML).not.toContain('@alice:tayet.local')
    expect(container.innerHTML).not.toContain('!engineering:tayet.local')
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })
})

// ADR-053 dec. 5: o guard do CTA de DM. Estes testes montam o WORKSPACE — é aqui que o canDm existe,
// e portanto é aqui que a DECISÃO fica provada. O render-scan do Dialog prova só que o componente
// obedece a prop (burro por construção); ele passaria igual se o canDm estivesse errado.
//
// Ligar onOpenDirectMessage sozinho NÃO aciona o canCompose (guard é `&&` de três: onCreateChannel &&
// onOpenDirectMessage && loadKnownContacts), então o NewConversationDialog continua fora do mount e
// não contamina as queries.
describe('Perfil-de-outro — CTA de DM gated pelo Workspace (ADR-053 dec. 5)', () => {
  it('perfil de OUTRO com currentUser resolvido → o CTA aparece', async () => {
    const { getAllByRole, findByRole, container } = render(
      <Workspace
        channels={[channel]}
        selectedChannelId={channel.id}
        messages={[message]} // autoria do bob
        usersById={usersById}
        connection="connected"
        currentUser={alice} // o operador é a alice; o alvo é o bob
        onLoadUserProfile={async () => bobProfile}
        onOpenDirectMessage={noopVerb}
        onSelectChannel={() => {}}
        onSend={() => {}}
      />,
    )

    fireEvent.click(getAllByRole('button', { name: 'Ver perfil de Bob Brown' })[0]!)

    await waitFor(() =>
      expect(container.querySelector('.user-profile__name')?.textContent).toBe('Bob Brown'),
    )
    expect(await findByRole('button', { name: DM_CTA })).toBeTruthy()
  })

  // O teste que guarda a decisão: sem ele, um canDm que ignorasse a comparação passaria em tudo.
  // DM consigo mesmo cria sala — e não há verbo de apagar.
  it('perfil do PRÓPRIO operador → o CTA NÃO aparece', async () => {
    const { getByRole, queryByRole, container } = render(
      <Workspace
        channels={[channel]}
        selectedChannelId={channel.id}
        messages={[]}
        usersById={{}}
        connection="connected"
        currentUser={alice} // o operador é a alice…
        managing={channel}
        members={members}
        onManageChannel={() => {}}
        onCloseManage={() => {}}
        onUpdateChannel={noopVerb}
        onArchiveChannel={noopVerb}
        onLeaveChannel={noopVerb}
        onAddMember={noopVerb}
        onRemoveMember={noopVerb}
        onSetRole={noopVerb}
        loadCandidates={() => Promise.resolve([])}
        onLoadUserProfile={async () => aliceProfile} // …e o alvo é a alice
        onOpenDirectMessage={noopVerb}
        onSelectChannel={() => {}}
        onSend={() => {}}
      />,
    )

    fireEvent.click(getByRole('button', { name: 'Ver perfil de Alice Stone' }))

    await waitFor(() =>
      expect(container.querySelector('.user-profile__name')?.textContent).toBe('Alice Stone'),
    )
    expect(queryByRole('button', { name: DM_CTA })).toBeNull()
  })

  // A janela de boot (ADR-039): currentUser ainda não resolveu. Sem id não há comparação — e sem
  // comparação o CTA não aparece. O custo aceito é o botão vir um beat atrasado.
  it('currentUser null (boot) → o CTA NÃO aparece, mesmo com o verbo ligado', async () => {
    const { getAllByRole, queryByRole, container } = render(
      <Workspace
        channels={[channel]}
        selectedChannelId={channel.id}
        messages={[message]}
        usersById={usersById}
        connection="connected"
        currentUser={null} // identidade ainda não resolvida
        onLoadUserProfile={async () => bobProfile}
        onOpenDirectMessage={noopVerb}
        onSelectChannel={() => {}}
        onSend={() => {}}
      />,
    )

    fireEvent.click(getAllByRole('button', { name: 'Ver perfil de Bob Brown' })[0]!)

    await waitFor(() =>
      expect(container.querySelector('.user-profile__name')?.textContent).toBe('Bob Brown'),
    )
    expect(queryByRole('button', { name: DM_CTA })).toBeNull()
  })
})

// Canais em comum — navegação (ADR-053 dec. 4, PR-3). O Workspace threada onLoadCommonChannels +
// onSelectChannel pro Dialog. É AQUI que o wiring fica provado (o render-scan prova só o componente,
// isolado): abrir o perfil → o chip renderiza → clicar → o verbo do Workspace (onSelectChannel) é
// chamado com o ChannelId e o Dialog FECHA (openProfile → null). O harness monta o Workspace SEM
// useChat, então onLoadCommonChannels é um fake — a derivação real mora no use-chat-common-channels.
describe('Canais em comum — navegação pelo Workspace (ADR-053 dec. 4)', () => {
  it('abrir perfil → clicar num chip → onSelectChannel(canalId) e o Dialog fecha', async () => {
    const selected: ChannelId[] = []
    const { getAllByRole, container } = render(
      <Workspace
        channels={[channel]}
        selectedChannelId={channel.id}
        messages={[message]} // autoria do bob → o header de autor abre o perfil
        usersById={usersById}
        connection="connected"
        onLoadUserProfile={async () => bobProfile}
        onLoadCommonChannels={async () => [channel]} // fake: o canal em comum é o #engineering
        onSelectChannel={(id) => {
          selected.push(id)
        }}
        onSend={() => {}}
      />,
    )

    fireEvent.click(getAllByRole('button', { name: 'Ver perfil de Bob Brown' })[0]!)
    await waitFor(() =>
      expect(container.querySelector('.user-profile__name')?.textContent).toBe('Bob Brown'),
    )

    // O chip do canal em comum aparece (nome limpo, sem :server).
    const chip = (await waitFor(() => {
      const el = container.querySelector('.user-profile__chip')
      if (!el) throw new Error('sem chip ainda')
      return el
    })) as HTMLElement
    expect(chip.textContent).toBe('#engineering')

    fireEvent.click(chip)
    // O verbo do Workspace recebe o ChannelId do canal e o Dialog fecha (o nome some do DOM).
    expect(selected).toEqual([channel.id])
    await waitFor(() => expect(container.querySelector('.user-profile__name')).toBeNull())

    // P1: o ChannelId protocol-shaped não vaza pelo affordance.
    expect(container.innerHTML).not.toContain('!engineering:tayet.local')
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })
})

// ADR-090 (Proposto) dec. 3: o CTA de DM no perfil de um AGENTE só para o operador dele. O kind vem de
// usersById; "meu" vem de isOwnAgent (useChat → acl.listOwnAgents()). Sem isOwnAgent (harness) o
// gate fecha para agente; pessoa segue com o CTA.
describe('Perfil de agente — CTA de DM só para o operador (ADR-090 dec. 3)', () => {
  const agent: User = { id: uid('@a-abcdefgh2345:tayet.local'), displayName: 'Relatórios', kind: 'agent', agentColor: 'ardosia' }
  const agentProfile: UserProfile = { id: agent.id, displayName: 'Relatórios', kind: 'agent', agentColor: 'ardosia' }
  const agentMessage: Message = { ...message, id: mid('$m2:tayet.local'), author: agent.id }

  const mount = (isOwnAgent?: (u: UserId) => boolean, target: 'agent' | 'person' = 'agent') =>
    render(
      <Workspace
        channels={[channel]}
        selectedChannelId={channel.id}
        messages={[target === 'agent' ? agentMessage : message]}
        usersById={{ ...usersById, [agent.id]: agent }}
        connection="connected"
        currentUser={alice}
        onLoadUserProfile={async () => (target === 'agent' ? agentProfile : bobProfile)}
        onOpenDirectMessage={noopVerb}
        isOwnAgent={isOwnAgent}
        onSelectChannel={() => {}}
        onSend={() => {}}
      />,
    )

  const openAndSettle = async (r: ReturnType<typeof mount>, name: string) => {
    fireEvent.click(r.getAllByRole('button', { name: `Ver perfil de ${name}` })[0]!)
    await waitFor(() => expect(r.container.querySelector('.user-profile__name')?.textContent).toBe(name))
  }

  it('agente de outro operador → o CTA NÃO aparece', async () => {
    const r = mount(() => false)
    await openAndSettle(r, 'Relatórios')
    expect(r.queryByRole('button', { name: DM_CTA })).toBeNull()
  })

  it('sem isOwnAgent (harness) → fail-closed para agente', async () => {
    const r = mount(undefined)
    await openAndSettle(r, 'Relatórios')
    expect(r.queryByRole('button', { name: DM_CTA })).toBeNull()
  })

  it('agente MEU → o CTA aparece', async () => {
    const r = mount((u) => u === agent.id)
    await openAndSettle(r, 'Relatórios')
    expect(await r.findByRole('button', { name: DM_CTA })).toBeTruthy()
  })

  it('pessoa → o CTA aparece, qualquer que seja isOwnAgent', async () => {
    const r = mount(() => false, 'person')
    await openAndSettle(r, 'Bob Brown')
    expect(await r.findByRole('button', { name: DM_CTA })).toBeTruthy()
  })
})
