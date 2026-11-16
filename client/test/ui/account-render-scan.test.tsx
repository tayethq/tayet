// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, waitFor, act } from '@testing-library/react'
import { AccountSettings } from '../../src/ui/components/AccountSettings'
import type { KnownAccess } from '../../src/ui/components/AccountSettings'
import { MediaProvider } from '../../src/ui/MediaContext'
import type { DeviceId, MediaRef, MyProfile, Timestamp } from '../../src/acl'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { noExport } from '../support/data-export-fake'

// P1 gate (espelha test/ui/render-scan): monta a superfície de conta ABERTA (agora um Dialog, ADR-038)
// e escaneia o DOM renderizado por shapes de protocolo. AccountSettings é o PRIMEIRO chrome de
// nível-App trazido ao gate de render-scan (os banners NewAccess/ResetAccess seguem fora — §8.A1). O id
// de fixture carrega de propósito um shape de protocolo (o residual do ADR-008: o valor de runtime de
// um id É o id de protocolo); a lista usa-o como key mas NUNCA o renderiza — provado abaixo. Campos
// limpos (friendlyName) devem renderizar, e o vocabulário fica "acesso", nunca "dispositivo"/crypto.
//
// A lista + reset agora vivem numa sub-tela drill-in (addendum F4 ao ADR-038); todo assert sobre eles
// navega pela entry-row primeiro. O leak-scan P1 roda em AMBAS as views.

const did = (s: string): DeviceId => s as unknown as DeviceId

afterEach(cleanup)

describe('DOM render-scan — AccountSettings (P1 na tela)', () => {
  const accesses: KnownAccess[] = [
    { id: did('@alice:tayet.local'), friendlyName: 'Notebook do trabalho', current: true },
    { id: did('!device:tayet.local'), friendlyName: '   ', current: false }, // em branco → copy genérica
  ]

  it('main mostra resumo; a sub-tela renderiza a lista limpa e NÃO vaza shape de protocolo', () => {
    const { container, getByRole } = render(
      <AccountSettings open accesses={accesses} displayName="Alice Stone" avatarUrl="https://media.local/resolved/thumb.png" onLoadProfile={async () => ({ fullName: 'Alice Stone' })} onSaveProfile={async () => {}} onSaveAvatar={async () => {}} onClearAvatar={async () => {}} onExportData={noExport} onReset={() => {}} onSignOut={() => {}} theme="light" onThemeChange={() => {}} onClose={() => {}} />,
    )

    // ── view 'main' ──
    // A superfície agora é um Dialog (ADR-038), não mais uma <section> bare.
    expect(getByRole('dialog')).toBeTruthy()

    const mainText = container.textContent ?? ''
    expect(mainText).toContain('Sua conta')
    expect(mainText).toContain('Alice Stone') // nome no header de identidade
    expect(mainText).toContain('Editar') // botão do header (abre a view profile)
    expect(mainText).toContain('Acessos à sua conta') // entry-row
    expect(mainText).toContain('2 acessos') // resumo: 2 acessos, 1 em branco
    expect(mainText).toContain('1 desconhecido')
    expect(mainText).toContain('Sair deste navegador') // ação de logout deste navegador (ADR-034)

    // Seção Aparência (slice 1): seletor de tema Claro|Escuro.
    expect(mainText).toContain('Aparência')
    expect(mainText).toContain('Claro')
    expect(mainText).toContain('Escuro')

    // A lista e o reset NÃO estão na main ainda — vivem na sub-tela.
    expect(mainText).not.toContain('Notebook do trabalho')
    expect(mainText).not.toContain('Redefinir o acesso da conta')

    // P1 gate na main: nada de shape de protocolo no DOM antes de navegar.
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])

    // ── navega pra sub-tela ──
    fireEvent.click(getByRole('button', { name: /Acessos à sua conta/i }))

    const accessText = container.textContent ?? ''
    expect(accessText).toContain('Notebook do trabalho')
    expect(accessText).toContain('Este navegador') // badge no acesso current (§8.A3)
    expect(accessText).toContain('Acesso desconhecido') // friendlyName em branco → copy genérica
    expect(accessText).toContain('Redefinir o acesso da conta') // título da caixa de reset
    expect(accessText).toContain('Recomeça do zero') // teaser da caixa (A4)

    // P1: nenhuma vocabulário "dispositivo"/crypto na superfície de segurança.
    expect(accessText).not.toMatch(/dispositiv/i)

    // P1 gate na sub-tela: o id opaco (aqui um shape de protocolo) nunca chega ao DOM.
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])

    // ── caixa → confirmação (A4): o caveat F3 aparece e a cópia de produto segue limpa ──
    fireEvent.click(getByRole('button', { name: /Redefinir o acesso da conta/i }))
    const confirmText = container.textContent ?? ''
    expect(confirmText).toContain('Conteúdos antigos podem se perder.') // caveat F3
    expect(confirmText).not.toMatch(/dispositiv/i)
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  // Regressão §8.L22/L24: o caminho SEM display_name (onde o id cru vazava) nunca era exercido —
  // toda fixture tinha nome. Um device_id REAL do OIDC não tem `:server`, então o leak-scan (que casa
  // @user:server / !room:server) NÃO o pegaria; por isso afirmamos diretamente que a string-canário do
  // id está AUSENTE do HTML. Esse é o teste que teria pego o bug antes do dogfood.
  it('device sem display_name → "Acesso desconhecido", e o device_id cru NÃO vaza no DOM', () => {
    const nameless: KnownAccess[] = [{ id: did('LEAKCANARY00'), current: false }] // friendlyName ausente (não em branco)
    const { container, getByRole } = render(
      <AccountSettings open accesses={nameless} onLoadProfile={async () => ({ fullName: 'Alice Stone' })} onSaveProfile={async () => {}} onSaveAvatar={async () => {}} onClearAvatar={async () => {}} onExportData={noExport} onReset={() => {}} onSignOut={() => {}} theme="light" onThemeChange={() => {}} onClose={() => {}} />,
    )

    // O id não vaza na main (antes de navegar).
    expect(container.innerHTML).not.toContain('LEAKCANARY00')
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])

    // Navega pra sub-tela e reafirma na view que de fato renderiza a lista.
    fireEvent.click(getByRole('button', { name: /Acessos à sua conta/i }))
    const html = container.innerHTML
    expect(container.textContent ?? '').toContain('Acesso desconhecido')
    expect(html).not.toContain('LEAKCANARY00') // o id opaco jamais vira "nome" na tela
    expect(findProtocolLeaksInText(html)).toEqual([])
  })

  it('sem acessos: main tem a entry-row (0 acessos); sub-tela tem o reset sempre-disponível', () => {
    const { container, getByRole } = render(
      <AccountSettings open accesses={[]} onLoadProfile={async () => ({ fullName: 'Alice Stone' })} onSaveProfile={async () => {}} onSaveAvatar={async () => {}} onClearAvatar={async () => {}} onExportData={noExport} onReset={() => {}} onSignOut={() => {}} theme="light" onThemeChange={() => {}} onClose={() => {}} />,
    )

    // ── view 'main' ──
    const mainText = container.textContent ?? ''
    expect(mainText).toContain('Sua conta')
    expect(getByRole('button', { name: /Acessos à sua conta/i })).toBeTruthy() // entry-row presente
    expect(mainText).toContain('0 acessos')
    expect(container.querySelector('.account-settings__list')).toBeNull()

    // ── navega pra sub-tela ──
    fireEvent.click(getByRole('button', { name: /Acessos à sua conta/i }))
    const accessText = container.textContent ?? ''
    expect(accessText).toContain('Redefinir o acesso da conta') // sempre-disponível (ADR-019 §3.4)
    expect(container.querySelector('.account-settings__list')).toBeNull() // 0 acessos → sem lista
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  // Manifesto account-access §2: o cargo sob o nome vem do perfil, e sem ele a linha não existe.
  const profileWith = (jobTitle?: string) => async () => ({
    fullName: 'Alice Stone',
    org: { authority: 'directory' as const, jobTitle },
  })
  const renderAccount = (accesses: KnownAccess[], onLoadProfile: () => Promise<MyProfile>) =>
    render(
      <AccountSettings open accesses={accesses} displayName="Alice Stone" onLoadProfile={onLoadProfile} onSaveProfile={async () => {}} onSaveAvatar={async () => {}} onClearAvatar={async () => {}} onExportData={noExport} onReset={() => {}} onSignOut={() => {}} theme="light" onThemeChange={() => {}} onClose={() => {}} />,
    )

  it('cargo presente: a linha aparece sob o nome', async () => {
    const { findByText, container } = renderAccount([], profileWith('Engenheira de Plataforma'))
    await findByText('Engenheira de Plataforma')
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  it('sem cargo ou com falha de leitura: a linha não existe, em silêncio', async () => {
    const absent = vi.fn(profileWith(undefined))
    const first = renderAccount([], absent)
    await waitFor(() => expect(absent).toHaveBeenCalled())
    await act(async () => {})
    expect(first.container.querySelector('.account-settings__identity-role')).toBeNull()
    first.unmount()

    const failing = vi.fn(async (): Promise<MyProfile> => {
      throw new Error('leitura falhou')
    })
    const second = renderAccount([], failing)
    await waitFor(() => expect(failing).toHaveBeenCalled())
    await act(async () => {})
    expect(second.container.querySelector('.account-settings__identity-role')).toBeNull()
    expect(second.container.textContent ?? '').toContain('Alice Stone')
  })

  it('linhas da sub-tela: atual com "agora", demais com "Ativo", sem lastSeen só o nome', async () => {
    const twoHoursAgo = (Date.now() - 2 * 3_600_000) as unknown as Timestamp
    const { container, getByRole } = renderAccount(
      [
        { id: did('a'), friendlyName: 'Notebook do trabalho', current: true },
        { id: did('b'), friendlyName: 'Celular pessoal', current: false, lastSeen: twoHoursAgo },
        { id: did('c'), friendlyName: 'iMac', current: false },
        { id: did('d'), friendlyName: ' ', current: false, lastSeen: twoHoursAgo },
        { id: did('e'), friendlyName: 'Tayet (web) on Chrome', current: false },
      ],
      profileWith(undefined),
    )
    await act(async () => {})
    fireEvent.click(getByRole('button', { name: /Acessos à sua conta/i }))

    const rows = Array.from(container.querySelectorAll('.account-settings__access'))
    const meta = (row: Element) => row.querySelector('.account-settings__access-meta')?.textContent
    const mono = (row: Element) => row.querySelector('.account-settings__access-mono')
    expect(meta(rows[0]!)).toBe('Este navegador · agora')
    expect(rows[0]!.querySelector('.account-settings__access-badge')).toBeTruthy()
    expect(mono(rows[0]!)?.textContent).toBe('ND')
    expect(meta(rows[1]!)).toBe('Ativo há 2 horas')
    expect(mono(rows[1]!)?.textContent).toBe('CP')
    expect(meta(rows[2]!)).toBeUndefined()
    expect(mono(rows[2]!)?.textContent).toBe('IM')
    expect(rows[3]!.textContent).toContain('Acesso desconhecido')
    expect(mono(rows[3]!)?.classList.contains('account-settings__access-mono--unknown')).toBe(true)
    expect(mono(rows[3]!)?.textContent).toBe('')
    expect(mono(rows[4]!)?.textContent).toBe('TW')
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  it('a linha atual vem primeiro mesmo quando a ACL a entrega no meio; as demais mantêm a ordem', async () => {
    const { container, getByRole } = renderAccount(
      [
        { id: did('a'), friendlyName: 'Primeiro', current: false },
        { id: did('b'), friendlyName: 'Atual', current: true },
        { id: did('c'), friendlyName: 'Terceiro', current: false },
      ],
      profileWith(undefined),
    )
    await act(async () => {})
    fireEvent.click(getByRole('button', { name: /Acessos à sua conta/i }))

    const names = Array.from(container.querySelectorAll('.account-settings__access-name')).map((n) => n.textContent)
    expect(names).toEqual(['Atual', 'Primeiro', 'Terceiro'])
  })

  // ADR-040: a 4ª view drill-in. Navega pela entry-row "Editar perfil", espera o load, e escaneia o
  // DOM da view profile — o leak-scan P1 roda agora nas QUATRO views (main/access/confirm/profile).
  it('entry-row "Editar perfil" → view profile renderiza fullName + "Gerenciado…", sem vazar protocolo', async () => {
    const { container, getByRole, getByText } = render(
      <AccountSettings open accesses={[]} onLoadProfile={async () => ({ fullName: 'Alice Stone' })} onSaveProfile={async () => {}} onSaveAvatar={async () => {}} onClearAvatar={async () => {}} onExportData={noExport} onReset={() => {}} onSignOut={() => {}} theme="light" onThemeChange={() => {}} onClose={() => {}} />,
    )

    // ── view 'main' ── a entry-row de perfil existe junto da de acessos.
    expect(getByRole('button', { name: /^Editar$/ })).toBeTruthy()

    // ── navega pra view profile e espera o load assíncrono ──
    fireEvent.click(getByRole('button', { name: /^Editar$/ }))
    await waitFor(() => expect(getByText('Alice Stone')).toBeTruthy())

    const profileText = container.textContent ?? ''
    expect(profileText).toContain('Editar perfil') // título do Dialog
    expect(profileText).toContain('Gerenciado pela sua organização')

    // P1 gate na 4ª view: nada de shape de protocolo no DOM da view profile.
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  // ADR-041: a view profile com foto. O perfil carrega um avatar opaco (mxc-shaped); o ProfilePhoto o
  // resolve via useMedia (MediaProvider stub → blob:) e renderiza só a URL — o mr_*/mxc nunca chega ao
  // DOM. O leak-scan P1 fecha o loop nas 4 views, agora com a foto montada.
  it('view profile com avatar → a foto resolvida renderiza; mr_*/mxc fora do DOM (P1)', async () => {
    const ref = (s: string): MediaRef => s as unknown as MediaRef
    const resolve = async () => ({ url: 'blob:tayet/resolved', release: () => {} })
    const { container, getByRole, getByText } = render(
      <MediaProvider resolve={resolve}>
        <AccountSettings
          open
          accesses={[]}
          onLoadProfile={async () => ({ fullName: 'Alice Stone', avatar: ref('mxc://tayet.example/pic') })}
          onSaveProfile={async () => {}}
          onSaveAvatar={async () => {}}
          onClearAvatar={async () => {}} onExportData={noExport}
          onReset={() => {}}
          onSignOut={() => {}}
          theme="light"
          onThemeChange={() => {}}
          onClose={() => {}}
        />
      </MediaProvider>,
    )

    fireEvent.click(getByRole('button', { name: /^Editar$/ }))
    await waitFor(() => expect(getByText('Alice Stone')).toBeTruthy())

    const img = (await waitFor(() => {
      const el = container.querySelector('.profile-photo__img') as HTMLImageElement | null
      if (!el) throw new Error('sem img ainda')
      return el
    })) as HTMLImageElement
    expect(img.getAttribute('src')).toBe('blob:tayet/resolved')
    // P1: a foto resolvida está no DOM, mas o mr_*/mxc não.
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  // ADR-054: a camada organizacional na view profile. Com `org`, Cargo e Email aparecem read-only na
  // seção que já existe; a copy "Gerenciado…" permanece. O `authority` nunca chega ao DOM.
  it('view profile com org completo: Cargo e Email renderizam; a copy "Gerenciado…" permanece', async () => {
    const { container, getByRole, getByText } = render(
      <AccountSettings
        open
        accesses={[]}
        onLoadProfile={async () => ({
          fullName: 'Alice Stone',
          org: {
            authority: 'directory',
            fullName: 'Alice Alves',
            jobTitle: 'Engenheira de Plataforma',
            workEmail: 'alice@empresa.example',
          },
        })}
        onSaveProfile={async () => {}}
        onSaveAvatar={async () => {}}
        onClearAvatar={async () => {}} onExportData={noExport}
        onReset={() => {}}
        onSignOut={() => {}}
        theme="light"
        onThemeChange={() => {}}
        onClose={() => {}}
      />,
    )

    fireEvent.click(getByRole('button', { name: /^Editar$/ }))
    await waitFor(() => expect(getByText('Alice Stone')).toBeTruthy())

    const profileText = container.textContent ?? ''
    expect(profileText).toContain('Cargo')
    expect(profileText).toContain('Engenheira de Plataforma')
    expect(profileText).toContain('Email de trabalho')
    expect(profileText).toContain('alice@empresa.example')
    expect(profileText).toContain('Gerenciado pela sua organização') // copy permanece

    // `authority` nunca vai pro DOM (nem o valor 'directory', nem a palavra).
    expect(container.innerHTML).not.toContain('authority')
    expect(container.innerHTML).not.toContain('directory')
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  // Assimetria do §2.2: SEM org a seção CONTINUA (Nome incondicional + copy); só Cargo e Email colapsam.
  // Prova-a, não a presume.
  it('view profile SEM org: a seção continua (Nome + copy); Cargo e Email ausentes', async () => {
    const { container, getByRole, getByText } = render(
      <AccountSettings open accesses={[]} onLoadProfile={async () => ({ fullName: 'Alice Stone' })} onSaveProfile={async () => {}} onSaveAvatar={async () => {}} onClearAvatar={async () => {}} onExportData={noExport} onReset={() => {}} onSignOut={() => {}} theme="light" onThemeChange={() => {}} onClose={() => {}} />,
    )

    fireEvent.click(getByRole('button', { name: /^Editar$/ }))
    await waitFor(() => expect(getByText('Alice Stone')).toBeTruthy())

    const profileText = container.textContent ?? ''
    // A seção org continua montada com o Nome e a copy.
    expect(container.querySelector('.profile-editor__org')).toBeTruthy()
    expect(profileText).toContain('Alice Stone') // Nome incondicional
    expect(profileText).toContain('Gerenciado pela sua organização')
    // Cargo e Email colapsam individualmente.
    expect(profileText).not.toContain('Cargo')
    expect(profileText).not.toContain('Email de trabalho')

    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })
})
