// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { ProfilePhoto } from '../../src/ui/components/ProfilePhoto'
import { MediaProvider } from '../../src/ui/MediaContext'
import type { MediaRef } from '../../src/acl'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'

// Controle de foto de perfil (ADR-041 PR-3) isolado: dirige o ProfilePhoto com onSaveAvatar/
// onClearAvatar fakes + um MediaProvider stub, e afirma o monograma-fallback, o modo-imagem via URL
// resolvida, os verbos IMEDIATO-NA-AÇÃO (Trocar faz upload no pick, Remover limpa na hora), o erro
// inline, e o P1 (nenhum mr_*/mxc no DOM — a fixture MediaRef é mxc-shaped pra qualquer vazamento
// virar vermelho). Vocabulário de produto: "Adicionar foto"/"Trocar"/"Remover"/"Enviando…" — nunca
// avatar_url/mxc/upload.

afterEach(cleanup)

// Fixture MediaRef protocol-shaped (mxc): se vazar pro DOM, o leak-scan acende.
const ref = (s: string): MediaRef => s as unknown as MediaRef
const AVATAR = ref('mxc://tayet.example/abc123')

// jsdom não implementa createObjectURL/revokeObjectURL — stub determinístico.
beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:tayet/local-pick')
  URL.revokeObjectURL = vi.fn()
})

function filePicker(container: HTMLElement): HTMLInputElement {
  return container.querySelector('.profile-photo__file') as HTMLInputElement
}

describe('ProfilePhoto (ADR-041 PR-3) — controle isolado', () => {
  it('sem avatar: monograma das iniciais de name, botão "Adicionar foto", sem Remover', () => {
    const { container, getByText, queryByRole } = render(
      <ProfilePhoto name="Alice Stone" onSaveAvatar={async () => {}} onClearAvatar={async () => {}} />,
    )
    // Iniciais das duas primeiras palavras (convenção canônica do Timeline: "Rafael Souza" → "RS").
    expect(getByText('AS')).toBeTruthy()
    expect(getByText('Adicionar foto')).toBeTruthy()
    expect(queryByRole('button', { name: 'Remover' })).toBeNull()
    expect(container.querySelector('.profile-photo__img')).toBeNull()
  })

  it('com avatar: <img> via URL resolvida, botões Trocar + Remover; sem mr_*/mxc no DOM', async () => {
    const release = vi.fn()
    const resolve = vi.fn(async () => ({ url: 'blob:tayet/resolved', release }))
    const { container, getByText } = render(
      <MediaProvider resolve={resolve}>
        <ProfilePhoto
          avatar={AVATAR}
          name="Alice Stone"
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
    expect(getByText('Trocar')).toBeTruthy()
    expect(getByText('Remover')).toBeTruthy()
    // P1: o mr_*/mxc fica atrás do useMedia, nunca no DOM.
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  it('Trocar: pick chama onSaveAvatar com o File; "Enviando…" durante; preview vira a objectURL local', async () => {
    let resolveSave!: () => void
    const onSaveAvatar = vi.fn(
      () => new Promise<void>((res) => { resolveSave = res }),
    )
    const file = new File(['x'], 'me.png', { type: 'image/png' })
    const { container, getByText, queryByText } = render(
      <ProfilePhoto name="Alice Stone" onSaveAvatar={onSaveAvatar} onClearAvatar={async () => {}} />,
    )

    fireEvent.change(filePicker(container), { target: { files: [file] } })
    expect(onSaveAvatar).toHaveBeenCalledWith(file)

    // In-flight: "Enviando…" e o preview local já trocado.
    expect(getByText('Enviando…')).toBeTruthy()
    const img = container.querySelector('.profile-photo__img') as HTMLImageElement
    expect(img.getAttribute('src')).toBe('blob:tayet/local-pick')

    // Resolve → sai do busy, o botão volta a "Trocar" (agora há foto).
    resolveSave()
    await waitFor(() => expect(queryByText('Enviando…')).toBeNull())
    expect(getByText('Trocar')).toBeTruthy()
  })

  it('Remover: clique chama onClearAvatar; cai pro monograma', async () => {
    const onClearAvatar = vi.fn(async () => {})
    const resolve = vi.fn(async () => ({ url: 'blob:tayet/resolved', release: vi.fn() }))
    const { container, getByText } = render(
      <MediaProvider resolve={resolve}>
        <ProfilePhoto
          avatar={AVATAR}
          name="Alice Stone"
          onSaveAvatar={async () => {}}
          onClearAvatar={onClearAvatar}
        />
      </MediaProvider>,
    )
    await waitFor(() => expect(container.querySelector('.profile-photo__img')).toBeTruthy())

    fireEvent.click(getByText('Remover'))
    expect(onClearAvatar).toHaveBeenCalled()

    // Sem foto → monograma de volta, sem img.
    await waitFor(() => expect(getByText('AS')).toBeTruthy())
    expect(container.querySelector('.profile-photo__img')).toBeNull()
  })

  it('erro: onSaveAvatar rejeita → "Não foi possível atualizar a foto.", volta pra foto atual', async () => {
    const onSaveAvatar = vi.fn(async () => {
      throw new Error('boom')
    })
    const resolve = vi.fn(async () => ({ url: 'blob:tayet/resolved', release: vi.fn() }))
    const file = new File(['x'], 'me.png', { type: 'image/png' })
    const { container, getByText } = render(
      <MediaProvider resolve={resolve}>
        <ProfilePhoto
          avatar={AVATAR}
          name="Alice Stone"
          onSaveAvatar={onSaveAvatar}
          onClearAvatar={async () => {}}
        />
      </MediaProvider>,
    )
    await waitFor(() => expect(container.querySelector('.profile-photo__img')).toBeTruthy())

    fireEvent.change(filePicker(container), { target: { files: [file] } })
    await waitFor(() => expect(getByText('Não foi possível atualizar a foto.')).toBeTruthy())

    // Erro descartou o preview local → volta pra foto atual (URL resolvida).
    const img = container.querySelector('.profile-photo__img') as HTMLImageElement
    expect(img.getAttribute('src')).toBe('blob:tayet/resolved')
  })
})
