// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { UserProfileDialog } from '../../src/ui/components/UserProfileDialog'
import { MediaProvider } from '../../src/ui/MediaContext'
import type { Channel, ChannelId, MediaRef, UserId, UserProfile } from '../../src/acl'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'

// P1 gate da sub-tela de perfil-de-outro (ADR-043, Slice 2 PR-2). O componente é montado isolado com
// um UserProfile de fixture cujo id carrega um shape de protocolo de propósito (o residual ADR-008: o
// valor de runtime do id É o id de protocolo) — e que NUNCA é renderizado. O leak-scan varre o
// innerHTML (texto + atributos) por mxid/mxc/m.room.*: se o id, o avatar opaco (mxc) ou qualquer
// vocabulário de protocolo vazasse, o scan fica vermelho. Campos limpos (nome, pronomes) renderizam.

const uid = (s: string): UserId => s as unknown as UserId
const ref = (s: string): MediaRef => s as unknown as MediaRef

afterEach(cleanup)

describe('UserProfileDialog DOM render-scan (P1 na tela)', () => {
  it('com avatar + pronomes + recado: renderiza nome/foto/pronomes/recado; id/mxc fora do DOM (P1)', async () => {
    const profile: UserProfile = {
      id: uid('@bob:tayet.local'), // shape de protocolo de propósito — nunca renderizado
      displayName: 'Bob Brown', kind: 'member',
      avatar: ref('mxc://tayet.example/bob'),
      pronouns: 'ele/dele',
      note: 'em foco até quinta',
    }
    const resolve = async () => ({ url: 'blob:tayet/bob', release: () => {} })
    const { container } = render(
      <MediaProvider resolve={resolve}>
        <UserProfileDialog
          userId={profile.id}
          onLoadUserProfile={async () => profile}
          onClose={() => {}}
        />
      </MediaProvider>,
    )

    // Espera o load assíncrono — o nome limpo aparece na linha de nome do corpo.
    await waitFor(() =>
      expect(container.querySelector('.user-profile__name')?.textContent).toBe('Bob Brown'),
    )

    const text = container.textContent ?? ''
    expect(text).toContain('Bob Brown') // nome
    expect(text).toContain('ele/dele') // linha de pronomes
    expect(text).toContain('em foco até quinta') // corpo do recado

    // A seção Recado com o rótulo. O texto é autorado em caixa normal — o maiúsculo é do CSS
    // (text-transform), então o textContent lê 'Recado'.
    expect(container.querySelector('.user-profile__section-label')?.textContent).toBe('Recado')
    expect(container.querySelector('.user-profile__note')?.textContent).toBe('em foco até quinta')

    // A foto resolvida está no DOM (blob:), o mxc não. Avatar bespoke em escala de perfil (ADR-041
    // ratificação ii) — não o primitivo, por isso a classe é do namespace da tela.
    const img = (await waitFor(() => {
      const el = container.querySelector('.user-profile__avatar-img') as HTMLImageElement | null
      if (!el) throw new Error('sem img ainda')
      return el
    })) as HTMLImageElement
    expect(img.getAttribute('src')).toBe('blob:tayet/bob')

    // P1 gate: nem o id (@bob:tayet.local) nem o mxc chegam ao DOM.
    expect(container.innerHTML).not.toContain('@bob:tayet.local')
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  it('sem pronomes: não renderiza linha de pronomes, sem vazar protocolo', async () => {
    const profile: UserProfile = {
      id: uid('@alice:tayet.local'),
      displayName: 'Alice Stone', kind: 'member',
      // pronouns ausente → a linha de pronomes não renderiza nada (sem promessa)
    }
    const { container } = render(
      <UserProfileDialog
        userId={profile.id}
        onLoadUserProfile={async () => profile}
        onClose={() => {}}
      />,
    )

    await waitFor(() =>
      expect(container.querySelector('.user-profile__name')?.textContent).toBe('Alice Stone'),
    )

    expect(container.querySelector('.user-profile__pronouns')).toBeNull()
    expect(container.innerHTML).not.toContain('@alice:tayet.local')
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  // Espelha o teste de pronomes ausentes: ausente = não informado, não uma promessa vazia. Aqui o
  // gate é mais forte — some a SEÇÃO INTEIRA (rótulo incluso), não só o valor. Um rótulo RECADO sobre
  // o nada seria pior que nada.
  it('sem recado: nem o rótulo nem a seção renderizam, sem vazar protocolo', async () => {
    const profile: UserProfile = {
      id: uid('@alice:tayet.local'),
      displayName: 'Alice Stone', kind: 'member',
      pronouns: 'ela/dela', // pronomes presentes: o que some é só a seção do recado
      // note ausente → a seção Recado inteira não renderiza
    }
    const { container } = render(
      <UserProfileDialog
        userId={profile.id}
        onLoadUserProfile={async () => profile}
        onClose={() => {}}
      />,
    )

    await waitFor(() =>
      expect(container.querySelector('.user-profile__name')?.textContent).toBe('Alice Stone'),
    )

    expect(container.querySelector('.user-profile__section-label')).toBeNull() // sem rótulo órfão
    expect(container.querySelector('.user-profile__section')).toBeNull() // sem espaço morto
    expect(container.querySelector('.user-profile__note')).toBeNull()
    expect(container.textContent ?? '').not.toContain('Recado')
    expect(container.querySelector('.user-profile__pronouns')?.textContent).toBe('ela/dela') // vizinho intacto
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  // Presença (ADR-056): o cluster (badge no avatar + linha na pilha) renderiza nos 3 estados sem
  // vazar protocolo — o DOM só carrega o vocabulário do protótipo (data-presence
  // online/ausente/offline; 'away' do domínio nunca aparece) e a copy plana. O comportamento vivo
  // está no user-profile-presence.test.tsx; aqui é só o scan do DOM.
  it('com presença: cluster renderiza nos 3 estados; só vocabulário de produto no DOM (P1)', async () => {
    const profile: UserProfile = { id: uid('@bob:tayet.local'), displayName: 'Bob Brown', kind: 'member' }
    for (const state of ['online', 'away', 'offline'] as const) {
      const { container, unmount } = render(
        <UserProfileDialog
          userId={profile.id}
          onLoadUserProfile={async () => profile}
          onGetPresence={() => state}
          onSubscribePresence={() => () => {}}
          onClose={() => {}}
        />,
      )
      await waitFor(() =>
        expect(container.querySelector('.user-profile__presence')).not.toBeNull(),
      )
      expect(container.querySelector('.user-profile__presence-badge')).not.toBeNull()
      // O atributo carrega o vocabulário do PROTÓTIPO — o valor 'away' do domínio não chega ao DOM.
      expect(['online', 'ausente', 'offline']).toContain(
        container.querySelector('.user-profile')?.getAttribute('data-presence'),
      )
      expect(container.innerHTML).not.toContain('away')
      expect(container.innerHTML).not.toContain('@bob:tayet.local')
      expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
      unmount()
    }
  })

  // ADR-053 dec. 5: o Dialog é BURRO — prop presente → CTA, ausente → sem CTA. Quem decide é o
  // Workspace (canDm); a prova da DECISÃO está no open-profile.test.tsx, não aqui. Estes três provam
  // só o componente: que ele obedece a prop, chama o verbo com o alvo, e fecha no sucesso.
  it('com onOpenDirectMessage: renderiza o CTA; o userId não vaza pro botão nem pro aria-label (P1)', async () => {
    const profile: UserProfile = {
      id: uid('@bob:tayet.local'), // shape de protocolo de propósito
      displayName: 'Bob Brown', kind: 'member',
    }
    const { container, findByRole } = render(
      <UserProfileDialog
        userId={profile.id}
        onLoadUserProfile={async () => profile}
        onOpenDirectMessage={async () => {}}
        onClose={() => {}}
      />,
    )

    const btn = await findByRole('button', { name: 'Enviar mensagem' })
    expect(btn).toBeTruthy()
    // P1: o id viaja na closure, nunca no DOM — nem no botão, nem em atributo nenhum.
    expect(btn.outerHTML).not.toContain('@bob:tayet.local')
    expect(container.innerHTML).not.toContain('@bob:tayet.local')
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  it('sem onOpenDirectMessage: o CTA não renderiza', async () => {
    const profile: UserProfile = { id: uid('@bob:tayet.local'), displayName: 'Bob Brown', kind: 'member' }
    const { container, queryByRole } = render(
      <UserProfileDialog
        userId={profile.id}
        onLoadUserProfile={async () => profile}
        onClose={() => {}}
      />,
    )

    await waitFor(() =>
      expect(container.querySelector('.user-profile__name')?.textContent).toBe('Bob Brown'),
    )
    expect(queryByRole('button', { name: 'Enviar mensagem' })).toBeNull()
  })

  it('clicar no CTA chama o verbo com o userId do alvo e fecha o Dialog no resolve', async () => {
    const profile: UserProfile = { id: uid('@bob:tayet.local'), displayName: 'Bob Brown', kind: 'member' }
    const opened: UserId[] = []
    let closed = 0
    const { findByRole } = render(
      <UserProfileDialog
        userId={profile.id}
        onLoadUserProfile={async () => profile}
        onOpenDirectMessage={async (u) => {
          opened.push(u)
        }}
        onClose={() => {
          closed += 1
        }}
      />,
    )

    fireEvent.click(await findByRole('button', { name: 'Enviar mensagem' }))

    // await-and-close: o verbo recebe o alvo; o sucesso fecha. Rotear é do useChat (seam S1).
    await waitFor(() => expect(closed).toBe(1))
    expect(opened).toEqual([profile.id])
  })
})

// Canais em comum (ADR-053 dec. 4, PR-3). A seção é alimentada por onLoadCommonChannels; a fixture de
// Channel é protocol-shaped DE PROPÓSITO (o ChannelId carrega `!…:tayet.local`, o residual ADR-008) e
// NUNCA é renderizada — vive só como key de React. O leak-scan varre o innerHTML e prova que nenhum
// ChannelId chega à tela. Aqui os chips são INERTES (o clique é o commit 3).
const cid = (s: string): ChannelId => s as unknown as ChannelId
const chan = (idStr: string, name: string, kind: Channel['kind'] = 'public'): Channel => ({
  id: cid(idStr),
  name,
  kind,
  memberCount: 2,
  unread: { count: 0, mentions: 0 },
})

describe('UserProfileDialog — canais em comum (ADR-053 dec. 4)', () => {
  const bob: UserProfile = { id: uid('@bob:tayet.local'), displayName: 'Bob Brown', kind: 'member' }

  it('com canais em comum: a seção renderiza com o rótulo e os chips; nenhum ChannelId no DOM (P1)', async () => {
    const common = [
      chan('!engineering:tayet.local', '#engineering'),
      chan('!design:tayet.local', '#design'),
    ]
    const { container } = render(
      <UserProfileDialog
        userId={bob.id}
        onLoadUserProfile={async () => bob}
        onLoadCommonChannels={async () => common}
        onClose={() => {}}
      />,
    )

    const section = await waitFor(() => {
      const el = container.querySelector('[aria-label="Canais em comum"]')
      if (!el) throw new Error('sem seção ainda')
      return el
    })
    // Rótulo autorado em caixa normal (o maiúsculo é do CSS) + contador = TOTAL.
    expect(section.querySelector('.user-profile__section-label')?.textContent).toBe(
      'Canais em comum · 2',
    )
    // Nomes LIMPOS nos chips; nenhum overflow (2 ≤ 8).
    const chips = section.querySelectorAll('.user-profile__chip')
    expect(Array.from(chips).map((c) => c.textContent)).toEqual(['#engineering', '#design'])

    // P1: os ChannelId protocol-shaped não chegam ao DOM (nem como texto, nem em atributo).
    expect(container.innerHTML).not.toContain('!engineering:tayet.local')
    expect(container.innerHTML).not.toContain('!design:tayet.local')
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  it('sem a prop onLoadCommonChannels: a seção não existe', async () => {
    const { container } = render(
      <UserProfileDialog userId={bob.id} onLoadUserProfile={async () => bob} onClose={() => {}} />,
    )
    await waitFor(() =>
      expect(container.querySelector('.user-profile__name')?.textContent).toBe('Bob Brown'),
    )
    expect(container.querySelector('[aria-label="Canais em comum"]')).toBeNull()
    expect(container.textContent ?? '').not.toContain('Canais em comum')
  })

  it('prop presente mas nenhum canal em comum: a seção não existe (sem placeholder)', async () => {
    const { container } = render(
      <UserProfileDialog
        userId={bob.id}
        onLoadUserProfile={async () => bob}
        onLoadCommonChannels={async () => []}
        onClose={() => {}}
      />,
    )
    await waitFor(() =>
      expect(container.querySelector('.user-profile__name')?.textContent).toBe('Bob Brown'),
    )
    // [] colapsa igual a null: sem rótulo órfão, sem "Nenhum canal em comum".
    expect(container.querySelector('[aria-label="Canais em comum"]')).toBeNull()
    expect(container.textContent ?? '').not.toContain('Canais em comum')
  })

  it('mais de 8: 8 chips + o chip de overflow; o contador mostra o TOTAL', async () => {
    const common = Array.from({ length: 14 }, (_, i) =>
      chan(`!c${i}:tayet.local`, `#canal-${i}`),
    )
    const { container } = render(
      <UserProfileDialog
        userId={bob.id}
        onLoadUserProfile={async () => bob}
        onLoadCommonChannels={async () => common}
        onClose={() => {}}
      />,
    )

    const section = await waitFor(() => {
      const el = container.querySelector('[aria-label="Canais em comum"]')
      if (!el) throw new Error('sem seção ainda')
      return el
    })
    // Contador = TOTAL (14), mesmo com só 8 na tela.
    expect(section.querySelector('.user-profile__section-label')?.textContent).toBe(
      'Canais em comum · 14',
    )
    // 8 chips de canal + 1 chip de overflow.
    expect(section.querySelectorAll('.user-profile__chip:not(.user-profile__chip--more)').length).toBe(8)
    const more = section.querySelector('.user-profile__chip--more')
    expect(more?.textContent).toBe('+6') // 14 - 8
  })

  it('clique no +N: todos os chips aparecem, o overflow some, o contador não muda', async () => {
    const common = Array.from({ length: 14 }, (_, i) =>
      chan(`!c${i}:tayet.local`, `#canal-${i}`),
    )
    const { container } = render(
      <UserProfileDialog
        userId={bob.id}
        onLoadUserProfile={async () => bob}
        onLoadCommonChannels={async () => common}
        onClose={() => {}}
      />,
    )

    const more = await waitFor(() => {
      const el = container.querySelector('.user-profile__chip--more') as HTMLButtonElement | null
      if (!el) throw new Error('sem overflow ainda')
      return el
    })
    fireEvent.click(more)

    const section = container.querySelector('[aria-label="Canais em comum"]')!
    // Todos os 14 chips de canal; o overflow sumiu; o contador continua 14 (o TOTAL nunca muda).
    expect(section.querySelectorAll('.user-profile__chip:not(.user-profile__chip--more)').length).toBe(14)
    expect(section.querySelector('.user-profile__chip--more')).toBeNull()
    expect(section.querySelector('.user-profile__section-label')?.textContent).toBe(
      'Canais em comum · 14',
    )
  })

  // ADR-053 dec. 4 (commit 3): a navegação. Prop presente → o chip é <button>; clicar seleciona o
  // canal com o ChannelId (na closure) e FECHA — mesmo formato do CTA de DM. Ausente → etiqueta inerte.
  it('com onSelectChannel: o chip é <button>; clicar chama com o ChannelId e fecha o Dialog (P1)', async () => {
    const common = [chan('!engineering:tayet.local', '#engineering')]
    const selected: ChannelId[] = []
    let closed = 0
    const { container } = render(
      <UserProfileDialog
        userId={bob.id}
        onLoadUserProfile={async () => bob}
        onLoadCommonChannels={async () => common}
        onSelectChannel={(id) => {
          selected.push(id)
        }}
        onClose={() => {
          closed += 1
        }}
      />,
    )

    const chip = (await waitFor(() => {
      const el = container.querySelector('.user-profile__chip')
      if (!el) throw new Error('sem chip ainda')
      return el
    })) as HTMLElement
    expect(chip.tagName).toBe('BUTTON')

    fireEvent.click(chip)
    expect(selected).toEqual([common[0]!.id]) // o ChannelId certo, vindo da closure
    expect(closed).toBe(1) // seleciona e fecha

    // P1: nem o texto nem o clique vazam o ChannelId pro DOM.
    expect(container.innerHTML).not.toContain('!engineering:tayet.local')
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  it('sem onSelectChannel: os chips são etiquetas inertes (<span>), não <button>', async () => {
    const common = [chan('!engineering:tayet.local', '#engineering')]
    const { container } = render(
      <UserProfileDialog
        userId={bob.id}
        onLoadUserProfile={async () => bob}
        onLoadCommonChannels={async () => common}
        onClose={() => {}}
      />,
    )

    const chip = (await waitFor(() => {
      const el = container.querySelector('.user-profile__chip')
      if (!el) throw new Error('sem chip ainda')
      return el
    })) as HTMLElement
    expect(chip.tagName).toBe('SPAN')
    expect(container.querySelector('.user-profile__chips button')).toBeNull()
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })
})

// Da organização (ADR-054, PR-3). O bloco só existe com CONTEÚDO; cada campo colapsa sozinho; o
// `authority` NUNCA chega ao DOM. A fixture carrega `authority: 'directory'` (o único valor real) de
// propósito — a prova é que essa string, e 'self' (o outro valor do enum), e a própria palavra
// 'authority' não aparecem no innerHTML em NENHUM caso.
describe('UserProfileDialog — Da organização (ADR-054)', () => {
  const withOrg = (org: UserProfile['org']): UserProfile => ({
    id: uid('@bob:tayet.local'), // shape de protocolo de propósito — nunca renderizado
    displayName: 'Bob Brown', kind: 'member',
    org,
  })

  const renderProfile = (profile: UserProfile) =>
    render(
      <UserProfileDialog
        userId={profile.id}
        onLoadUserProfile={async () => profile}
        onClose={() => {}}
      />,
    )

  const expectNoAuthorityLeak = (html: string) => {
    expect(html).not.toContain('authority')
    expect(html).not.toContain('directory') // o valor real de authority — nunca renderizado
    expect(html).not.toContain('self') // o outro valor do enum
  }

  it('org completo: as três linhas renderizam com os rótulos certos; sem vazar protocolo/authority', async () => {
    const { container } = renderProfile(
      withOrg({
        authority: 'directory',
        fullName: 'Roberta Barros',
        jobTitle: 'Gerente de Produto',
        workEmail: 'roberta@empresa.example',
      }),
    )
    const section = await waitFor(() => {
      const el = container.querySelector('[aria-label="Da organização"]')
      if (!el) throw new Error('sem seção ainda')
      return el
    })
    expect(section.querySelector('.user-profile__section-label')?.textContent).toBe('Da organização')
    const labels = Array.from(section.querySelectorAll('.user-profile__org-label')).map(
      (e) => e.textContent,
    )
    expect(labels).toEqual(['Nome', 'Cargo', 'Email de trabalho'])
    const values = Array.from(section.querySelectorAll('.user-profile__org-value')).map(
      (e) => e.textContent,
    )
    expect(values).toEqual(['Roberta Barros', 'Gerente de Produto', 'roberta@empresa.example'])

    expectNoAuthorityLeak(container.innerHTML)
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  it('org sem jobTitle (o caso do bob): Nome e Email renderizam, "Cargo" ausente do DOM', async () => {
    const { container } = renderProfile(
      withOrg({
        authority: 'directory',
        fullName: 'Bob Barros',
        // jobTitle ausente — a org não afirma o cargo (chave apagada no diretório)
        workEmail: 'bob@empresa.example',
      }),
    )
    const section = await waitFor(() => {
      const el = container.querySelector('[aria-label="Da organização"]')
      if (!el) throw new Error('sem seção ainda')
      return el
    })
    const labels = Array.from(section.querySelectorAll('.user-profile__org-label')).map(
      (e) => e.textContent,
    )
    expect(labels).toEqual(['Nome', 'Email de trabalho']) // sem a linha Cargo
    // Ausência do RÓTULO, não só do valor — um "Cargo" órfão seria pior que nada.
    expect(container.textContent ?? '').not.toContain('Cargo')

    expectNoAuthorityLeak(container.innerHTML)
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  it('org ausente: nem o rótulo da seção nem nenhum dos três rótulos de campo existem', async () => {
    const { container } = renderProfile({
      id: uid('@bob:tayet.local'),
      displayName: 'Bob Brown', kind: 'member',
      // org ausente → o bloco inteiro não renderiza
    })
    await waitFor(() =>
      expect(container.querySelector('.user-profile__name')?.textContent).toBe('Bob Brown'),
    )
    expect(container.querySelector('[aria-label="Da organização"]')).toBeNull() // sem seção
    expect(container.querySelector('.user-profile__org-field')).toBeNull() // sem linha
    const text = container.textContent ?? ''
    expect(text).not.toContain('Da organização') // sem rótulo de seção órfão
    expect(text).not.toContain('Cargo')
    expect(text).not.toContain('Email de trabalho')

    expectNoAuthorityLeak(container.innerHTML)
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })
})
