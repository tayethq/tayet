// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { ProfileEditor } from '../../src/ui/components/ProfileEditor'
import { MediaProvider } from '../../src/ui/MediaContext'
import type { MediaRef, MyProfile } from '../../src/acl'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'

// Editor de perfil (ADR-040) isolado: dirige o componente com onLoadProfile/onSaveProfile fakes e
// afirma o lifecycle de save EXPLÍCITO (gatilho = Salvar), a baseline pós-save, o erro inline, e o P1
// (nenhum shape de protocolo no DOM em ambos os estados — carregado e pós-save). Vocabulário de produto:
// "Apelido"/"Nome"/"Editar perfil"/"Gerenciado pela sua organização" — nunca displayName/mxid.

afterEach(cleanup)

const profile: MyProfile = { fullName: 'Alice Stone', nickname: 'Ali' }

describe('ProfileEditor (ADR-040) — drill-in isolado', () => {
  it('load: campo Apelido = nickname, caixa = fullName + "Gerenciado…"; Salvar desabilitado (não-dirty)', async () => {
    const onLoadProfile = vi.fn(async () => profile)
    const onSaveProfile = vi.fn(async () => {})
    const { container, getByLabelText, getByRole, getByText } = render(
      <ProfileEditor onBack={() => {}} onClose={() => {}} onLoadProfile={onLoadProfile} onSaveProfile={onSaveProfile} onSaveAvatar={async () => {}} onClearAvatar={async () => {}} />,
    )

    const input = (await waitFor(() => getByLabelText('Apelido'))) as HTMLInputElement
    expect(input.value).toBe('Ali')
    expect(getByText('Alice Stone')).toBeTruthy()
    expect(container.textContent).toContain('Gerenciado pela sua organização')

    // Não-dirty no load → Salvar desabilitado.
    expect((getByRole('button', { name: 'Salvar' }) as HTMLButtonElement).disabled).toBe(true)

    // P1 no estado carregado.
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  it('dirty → Salvar: editar habilita; clique chama onSaveProfile; "Salvando…" → "✓ Salvo"; desabilita de novo', async () => {
    const onSaveProfile = vi.fn(async () => {})
    const { container, getByLabelText, getByRole, getByText } = render(
      <ProfileEditor onBack={() => {}} onClose={() => {}} onLoadProfile={async () => profile} onSaveProfile={onSaveProfile} onSaveAvatar={async () => {}} onClearAvatar={async () => {}} />,
    )

    const input = (await waitFor(() => getByLabelText('Apelido'))) as HTMLInputElement
    const save = () => getByRole('button', { name: 'Salvar' }) as HTMLButtonElement

    fireEvent.change(input, { target: { value: 'Alira' } })
    expect(save().disabled).toBe(false)

    fireEvent.click(save())
    expect(onSaveProfile).toHaveBeenCalledWith({ nickname: 'Alira' })

    await waitFor(() => expect(getByText('✓ Salvo')).toBeTruthy())
    // Baseline atualizada → Salvar desabilita de novo.
    expect(save().disabled).toBe(true)
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  it('erro: onSaveProfile rejeita → "Não foi possível salvar", campo+botão permanecem', async () => {
    const onSaveProfile = vi.fn(async () => {
      throw new Error('boom')
    })
    const { getByLabelText, getByRole, getByText } = render(
      <ProfileEditor onBack={() => {}} onClose={() => {}} onLoadProfile={async () => profile} onSaveProfile={onSaveProfile} onSaveAvatar={async () => {}} onClearAvatar={async () => {}} />,
    )

    const input = (await waitFor(() => getByLabelText('Apelido'))) as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Alira' } })
    fireEvent.click(getByRole('button', { name: 'Salvar' }))

    await waitFor(() => expect(getByText('Não foi possível salvar')).toBeTruthy())
    // Campo + botão seguem montados (idioma do ChannelManagementPanel).
    expect(getByLabelText('Apelido')).toBeTruthy()
    expect(getByRole('button', { name: 'Salvar' })).toBeTruthy()
  })

  it('limpar: apagar o apelido é dirty → salvar chama onSaveProfile com string vazia', async () => {
    const onSaveProfile = vi.fn(async () => {})
    const { getByLabelText, getByRole } = render(
      <ProfileEditor onBack={() => {}} onClose={() => {}} onLoadProfile={async () => profile} onSaveProfile={onSaveProfile} onSaveAvatar={async () => {}} onClearAvatar={async () => {}} />,
    )

    const input = (await waitFor(() => getByLabelText('Apelido'))) as HTMLInputElement
    fireEvent.change(input, { target: { value: '' } })
    expect((getByRole('button', { name: 'Salvar' }) as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(getByRole('button', { name: 'Salvar' }))
    expect(onSaveProfile).toHaveBeenCalledWith({ nickname: '' })
  })

  it('pronomes: carrega do perfil → campo Pronomes mostra o valor salvo (self-visível, Slice 1)', async () => {
    const withPronouns: MyProfile = { fullName: 'Alice Stone', nickname: 'Ali', pronouns: 'ela/dela' }
    const { container, getByLabelText } = render(
      <ProfileEditor onBack={() => {}} onClose={() => {}} onLoadProfile={async () => withPronouns} onSaveProfile={async () => {}} onSaveAvatar={async () => {}} onClearAvatar={async () => {}} />,
    )

    const input = (await waitFor(() => getByLabelText('Pronomes'))) as HTMLInputElement
    expect(input.value).toBe('ela/dela')
    // Pronomes legítimo não dispara o leak-scan (não é shape de protocolo).
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  it('pronomes: editar só pronomes é dirty → salvar manda só { pronouns } (sem nickname)', async () => {
    const onSaveProfile = vi.fn(async () => {})
    const { getByLabelText, getByRole } = render(
      <ProfileEditor onBack={() => {}} onClose={() => {}} onLoadProfile={async () => profile} onSaveProfile={onSaveProfile} onSaveAvatar={async () => {}} onClearAvatar={async () => {}} />,
    )

    const pron = (await waitFor(() => getByLabelText('Pronomes'))) as HTMLInputElement
    fireEvent.change(pron, { target: { value: 'elu/delu' } })
    expect((getByRole('button', { name: 'Salvar' }) as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(getByRole('button', { name: 'Salvar' }))
    expect(onSaveProfile).toHaveBeenCalledWith({ pronouns: 'elu/delu' })
  })

  it('patch por presença: editar apelido E pronomes E recado → patch com os três', async () => {
    const onSaveProfile = vi.fn(async () => {})
    const { getByLabelText, getByRole } = render(
      <ProfileEditor onBack={() => {}} onClose={() => {}} onLoadProfile={async () => profile} onSaveProfile={onSaveProfile} onSaveAvatar={async () => {}} onClearAvatar={async () => {}} />,
    )

    const nick = (await waitFor(() => getByLabelText('Apelido'))) as HTMLInputElement
    const pron = getByLabelText('Pronomes') as HTMLInputElement
    const note = getByLabelText('Recado') as HTMLInputElement
    fireEvent.change(nick, { target: { value: 'Alira' } })
    fireEvent.change(pron, { target: { value: 'elu/delu' } })
    fireEvent.change(note, { target: { value: 'em foco' } })
    fireEvent.click(getByRole('button', { name: 'Salvar' }))
    expect(onSaveProfile).toHaveBeenCalledWith({ nickname: 'Alira', pronouns: 'elu/delu', note: 'em foco' })
  })

  it('pronomes: limpar (apagar) é dirty → salvar manda { pronouns: "" }', async () => {
    const withPronouns: MyProfile = { fullName: 'Alice Stone', nickname: 'Ali', pronouns: 'ela/dela' }
    const onSaveProfile = vi.fn(async () => {})
    const { getByLabelText, getByRole } = render(
      <ProfileEditor onBack={() => {}} onClose={() => {}} onLoadProfile={async () => withPronouns} onSaveProfile={onSaveProfile} onSaveAvatar={async () => {}} onClearAvatar={async () => {}} />,
    )

    const pron = (await waitFor(() => getByLabelText('Pronomes'))) as HTMLInputElement
    fireEvent.change(pron, { target: { value: '' } })
    expect((getByRole('button', { name: 'Salvar' }) as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(getByRole('button', { name: 'Salvar' }))
    expect(onSaveProfile).toHaveBeenCalledWith({ pronouns: '' })
  })

  // ADR-053: recado — mesmo idioma dos pronomes (self-visível no Slice 1, patch por presença de chave).
  it('recado: carrega do perfil → campo Recado mostra o valor salvo (self-visível, Slice 1)', async () => {
    const withNote: MyProfile = { fullName: 'Alice Stone', nickname: 'Ali', note: 'em foco até quinta' }
    const { container, getByLabelText } = render(
      <ProfileEditor onBack={() => {}} onClose={() => {}} onLoadProfile={async () => withNote} onSaveProfile={async () => {}} onSaveAvatar={async () => {}} onClearAvatar={async () => {}} />,
    )

    const input = (await waitFor(() => getByLabelText('Recado'))) as HTMLInputElement
    expect(input.value).toBe('em foco até quinta')
    // Recado legítimo não dispara o leak-scan (não é shape de protocolo).
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  it('recado: editar só recado é dirty → salvar manda só { note } (sem nickname/pronouns)', async () => {
    const onSaveProfile = vi.fn(async () => {})
    const { getByLabelText, getByRole } = render(
      <ProfileEditor onBack={() => {}} onClose={() => {}} onLoadProfile={async () => profile} onSaveProfile={onSaveProfile} onSaveAvatar={async () => {}} onClearAvatar={async () => {}} />,
    )

    const note = (await waitFor(() => getByLabelText('Recado'))) as HTMLInputElement
    fireEvent.change(note, { target: { value: 'em foco até quinta' } })
    expect((getByRole('button', { name: 'Salvar' }) as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(getByRole('button', { name: 'Salvar' }))
    expect(onSaveProfile).toHaveBeenCalledWith({ note: 'em foco até quinta' })
  })

  it('recado: limpar (apagar) é dirty → salvar manda { note: "" }', async () => {
    const withNote: MyProfile = { fullName: 'Alice Stone', nickname: 'Ali', note: 'em foco até quinta' }
    const onSaveProfile = vi.fn(async () => {})
    const { getByLabelText, getByRole } = render(
      <ProfileEditor onBack={() => {}} onClose={() => {}} onLoadProfile={async () => withNote} onSaveProfile={onSaveProfile} onSaveAvatar={async () => {}} onClearAvatar={async () => {}} />,
    )

    const note = (await waitFor(() => getByLabelText('Recado'))) as HTMLInputElement
    fireEvent.change(note, { target: { value: '' } })
    expect((getByRole('button', { name: 'Salvar' }) as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(getByRole('button', { name: 'Salvar' }))
    expect(onSaveProfile).toHaveBeenCalledWith({ note: '' })
  })

  it('foto (ADR-041): perfil com avatar → ProfilePhoto mostra <img> via URL resolvida; P1 verde', async () => {
    const ref = (s: string): MediaRef => s as unknown as MediaRef
    // Fixture mxc-shaped: se vazar pro DOM, o leak-scan acende.
    const withAvatar: MyProfile = { fullName: 'Alice Stone', nickname: 'Ali', avatar: ref('mxc://tayet.example/pic') }
    const resolve = vi.fn(async () => ({ url: 'blob:tayet/resolved', release: vi.fn() }))
    const { container } = render(
      <MediaProvider resolve={resolve}>
        <ProfileEditor
          onBack={() => {}}
          onClose={() => {}}
          onLoadProfile={async () => withAvatar}
          onSaveProfile={async () => {}}
          onSaveAvatar={async () => {}}
          onClearAvatar={async () => {}}
        />
      </MediaProvider>,
    )

    const img = (await waitFor(() => {
      const el = container.querySelector('.profile-photo__img') as HTMLImageElement | null
      if (!el) throw new Error('sem img ainda')
      return el
    })) as HTMLImageElement
    expect(img.getAttribute('src')).toBe('blob:tayet/resolved')
    // P1: o mr_*/mxc fica atrás do useMedia, nunca no DOM.
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })
})
