// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useEffect } from 'react'
import { render, cleanup, screen, waitFor, fireEvent, act } from '@testing-library/react'

// O fluxo OIDC é mockado no nível do módulo app (../../src/ui/oidc): o Boot é o controlador, a
// máquina OIDC é exercida no test/oidc.test.ts. Default: NÃO é callback (isCallback → false).
vi.mock('../../src/ui/oidc', () => ({
  isCallback: vi.fn(() => false),
  beginLogin: vi.fn(async () => {}),
  completeLogin: vi.fn(async () => 'OIDC_BLOB' as unknown),
  scrubCallback: vi.fn(),
  isErrorCallback: vi.fn(() => false),
}))

import { Boot } from '../../src/ui/components/Boot'
import { isCallback, beginLogin, completeLogin, scrubCallback, isErrorCallback } from '../../src/ui/oidc'
import { ConnectionError, SessionExpiredError } from '../../src/acl'
import type { Acl, AclTelemetry, OpaqueSession } from '../../src/acl'
import { STORE_WIPE_BOUND_MS } from '../../src/acl/internal/matrix-client'

const noopTelemetry: AclTelemetry = { untranslated: () => {} }
const session = (v: string) => v as unknown as OpaqueSession
const READY = 'STUB_READY_SURFACE'
const renderReady = () => <div>{READY}</div>

// Props comuns que a fatia 2a tornou obrigatórias (clientId/ssoLabel).
const base = { serverUrl: 'http://x', clientId: 'TAYET', ssoLabel: 'Dex (local)', telemetry: noopTelemetry }

afterEach(() => {
  cleanup()
  vi.mocked(isCallback).mockReturnValue(false)
  vi.mocked(beginLogin).mockClear()
  vi.mocked(completeLogin).mockClear()
  vi.mocked(scrubCallback).mockClear()
  vi.mocked(isErrorCallback).mockReturnValue(false)
})

describe('Boot: o connect é estado React, não promise solta (issue #1)', () => {
  it('conexão OK → renderiza a superfície ready', async () => {
    const acl = { connect: vi.fn(async () => {}) } as unknown as Acl
    render(
      <Boot
        {...base}
        envToken="mct_ok"
        makeAcl={() => acl}
        resolve={(t) => (t ? session(t) : null)}
        renderReady={renderReady}
      />,
    )
    await waitFor(() => expect(screen.getByText(READY)).toBeTruthy())
    expect(acl.connect).toHaveBeenCalledTimes(1)
  })

  it('falha de auth → estado de erro renderiza (NUNCA tela branca) e o motivo não vaza', async () => {
    const acl = {
      connect: vi.fn(async () => {
        throw new Error('dead token')
      }),
    } as unknown as Acl
    const { container } = render(
      <Boot
        {...base}
        envToken="mct_dead"
        makeAcl={() => acl}
        resolve={(t) => (t ? session(t) : null)}
        renderReady={renderReady}
      />,
    )
    // Sem sinal de rede, a falha é local até prova em contrário (§8.9): estado neutro, não a copy
    // de conexão.
    await waitFor(() => expect(screen.getByText('Não foi possível iniciar')).toBeTruthy())
    expect(container.textContent).not.toContain('dead token')
    expect(screen.queryByText(READY)).toBeNull()
  })

  it('sem sessão → estado no-session com botão SSO; connect NÃO é chamado', async () => {
    const acl = { connect: vi.fn(async () => {}) } as unknown as Acl
    render(
      <Boot {...base} envToken={undefined} makeAcl={() => acl} resolve={() => null} renderReady={renderReady} />,
    )
    await waitFor(() => expect(screen.getByText('Entre no Tayet')).toBeTruthy())
    expect(screen.getByText('Continuar com Dex (local)')).toBeTruthy()
    expect(acl.connect).not.toHaveBeenCalled()
  })

  it('sessão persistida (warm) → reconecta sem SSO nem callback (D5/ADR-034)', async () => {
    // isCallback/isErrorCallback false (default); resolve devolve o blob persistido direto.
    const acl = { connect: vi.fn(async () => {}) } as unknown as Acl
    render(
      <Boot
        {...base}
        envToken={undefined}
        makeAcl={() => acl}
        resolve={() => session('PERSISTED_BLOB')}
        renderReady={renderReady}
      />,
    )
    await waitFor(() => expect(screen.getByText(READY)).toBeTruthy())
    expect(acl.connect).toHaveBeenCalledWith(session('PERSISTED_BLOB'))
    expect(beginLogin).not.toHaveBeenCalled()
    expect(completeLogin).not.toHaveBeenCalled()
  })

  it('boot com chave legada: sessão restaurada, chave legada removida, nova presente', async () => {
    // resolve DEFAULT (resolveBootSession real, sem env): lê o localStorage do jsdom. Um browser
    // que ainda tem a sessão sob a chave anterior ao rename reconecta sem SSO e migra a chave.
    localStorage.clear()
    localStorage.setItem('aurora.session', 'LEGACY_BLOB')
    const acl = { connect: vi.fn(async () => {}) } as unknown as Acl
    render(<Boot {...base} envToken={undefined} makeAcl={() => acl} renderReady={renderReady} />)
    await waitFor(() => expect(screen.getByText(READY)).toBeTruthy())
    expect(acl.connect).toHaveBeenCalledWith(session('LEGACY_BLOB'))
    expect(beginLogin).not.toHaveBeenCalled()
    expect(localStorage.getItem('tayet.session')).toBe('LEGACY_BLOB')
    expect(localStorage.getItem('aurora.session')).toBeNull()
    localStorage.clear()
  })

  it('retry re-tenta o connect', async () => {
    let calls = 0
    const acl = {
      connect: vi.fn(async () => {
        calls++
        if (calls === 1) throw new Error('x')
      }),
    } as unknown as Acl
    render(
      <Boot
        {...base}
        envToken="mct_x"
        makeAcl={() => acl}
        resolve={(t) => (t ? session(t) : null)}
        renderReady={renderReady}
      />,
    )
    await waitFor(() => expect(screen.getByText('Tentar novamente')).toBeTruthy())
    fireEvent.click(screen.getByText('Tentar novamente'))
    await waitFor(() => expect(screen.getByText(READY)).toBeTruthy())
    expect(acl.connect).toHaveBeenCalledTimes(2)
  })
})

describe('Boot: login OIDC cold (fatia 2a)', () => {
  it('callback → troca o código, persiste e conecta com o blob → ready', async () => {
    vi.mocked(isCallback).mockReturnValue(true)
    vi.mocked(completeLogin).mockResolvedValue(session('OIDC_BLOB'))
    const acl = { connect: vi.fn(async () => {}) } as unknown as Acl
    render(
      <Boot {...base} envToken={undefined} makeAcl={() => acl} renderReady={renderReady} />,
    )
    await waitFor(() => expect(screen.getByText(READY)).toBeTruthy())
    expect(completeLogin).toHaveBeenCalledTimes(1)
    expect(scrubCallback).toHaveBeenCalledTimes(1) // sucesso: o app limpa a URL (completeLogin é puro)
    expect(acl.connect).toHaveBeenCalledWith(session('OIDC_BLOB'))
  })

  it('callback → o primeiro paint já é o D4; "Conectando…" nunca aparece (ADR-031 addendum Out/2026)', async () => {
    vi.mocked(isCallback).mockReturnValue(true)
    let finishLogin: (s: OpaqueSession) => void = () => {}
    vi.mocked(completeLogin).mockReturnValueOnce(new Promise((r) => (finishLogin = r)))
    const acl = { connect: vi.fn(async () => {}) } as unknown as Acl
    const { container } = render(<Boot {...base} envToken={undefined} makeAcl={() => acl} renderReady={renderReady} />)
    // Primeiro commit, antes de qualquer microtask do run() (lock, exchange): já é o beat de preparo.
    expect(container.textContent).toContain('Preparando seu acesso seguro')
    expect(container.querySelector('[data-phase]')?.getAttribute('data-phase')).toBe('preparing')
    const seen: string[] = []
    const observer = new MutationObserver(() => seen.push(container.textContent ?? ''))
    observer.observe(container, { subtree: true, childList: true, characterData: true })
    finishLogin(session('OIDC_BLOB'))
    await waitFor(() => expect(screen.getByText(READY)).toBeTruthy())
    observer.disconnect()
    expect(seen.filter((t) => t.includes('Conectando'))).toEqual([])
  })

  it('ready → o app monta uma vez; a superfície do boot fica por cima inerte e escondida, e sai (§7 item 8)', async () => {
    // jsdom não carrega a folha: o token entra no :root para o timeout de segurança ter a duração real.
    document.documentElement.style.setProperty('--motion-duration-slow', '280ms')
    try {
      vi.mocked(isCallback).mockReturnValue(true)
      vi.mocked(completeLogin).mockResolvedValue(session('OIDC_BLOB'))
      const acl = { connect: vi.fn(async () => {}) } as unknown as Acl
      const mounts = vi.fn()
      function Ready() {
        useEffect(() => mounts(), [])
        return <div>{READY}</div>
      }
      const { container } = render(
        <Boot {...base} envToken={undefined} makeAcl={() => acl} renderReady={() => <Ready />} />,
      )
      await waitFor(() => expect(screen.getByText(READY)).toBeTruthy())
      const surface = container.querySelector('[data-phase]')
      expect(surface?.getAttribute('data-phase')).toBe('preparing')
      expect(surface?.hasAttribute('inert')).toBe(true)
      expect(surface?.getAttribute('aria-hidden')).toBe('true')
      expect(screen.queryByRole('status')).toBeNull() // fora da árvore de acessibilidade
      await waitFor(() => expect(container.querySelector('[data-phase]')).toBeNull())
      expect(screen.getByText(READY)).toBeTruthy()
      expect(mounts).toHaveBeenCalledTimes(1) // a saída não remonta o app
    } finally {
      document.documentElement.style.removeProperty('--motion-duration-slow')
    }
  })

  it('falha no exchange sem sinal de rede → estado neutro failed (nunca tela branca; motivo não vaza)', async () => {
    // §8 item 11 (S2): mesmo idioma do connect — sem sinal POSITIVO de rede, a falha é local até
    // prova em contrário; a copy de conexão seria mentira aqui.
    vi.mocked(isCallback).mockReturnValue(true)
    vi.mocked(completeLogin).mockRejectedValue(new Error('CodeExchangeFailed'))
    const acl = { connect: vi.fn(async () => {}) } as unknown as Acl
    const { container } = render(
      <Boot {...base} envToken={undefined} makeAcl={() => acl} renderReady={renderReady} />,
    )
    await waitFor(() => expect(screen.getByText('Não foi possível iniciar')).toBeTruthy())
    expect(container.textContent).not.toContain('CodeExchangeFailed')
    expect(screen.queryByText('Não foi possível conectar')).toBeNull()
    expect(acl.connect).not.toHaveBeenCalled()
    // Guard de uso único (§8.L33): o fail limpa ?code&state pra o retry não re-trocar o código.
    expect(scrubCallback).toHaveBeenCalledTimes(1)
  })

  it('falha no exchange COM sinal de rede (ConnectionError) → copy de conexão (error)', async () => {
    // §8 item 11 (S2): o ConnectionError nasce na ACL (completeLogin); a UI classifica por
    // instanceof, nunca por mensagem — "confira sua conexão" só quando é afirmação verdadeira.
    vi.mocked(isCallback).mockReturnValue(true)
    vi.mocked(completeLogin).mockRejectedValue(new ConnectionError())
    const acl = { connect: vi.fn(async () => {}) } as unknown as Acl
    render(<Boot {...base} envToken={undefined} makeAcl={() => acl} renderReady={renderReady} />)
    await waitFor(() => expect(screen.getByText('Não foi possível conectar')).toBeTruthy())
    expect(screen.getByText('Confira sua conexão e tente novamente.')).toBeTruthy()
    expect(acl.connect).not.toHaveBeenCalled()
    expect(scrubCallback).toHaveBeenCalledTimes(1)
  })

  it('?error do OP → tela idp-denied (não no-session), URL limpa, connect não roda', async () => {
    vi.mocked(isErrorCallback).mockReturnValue(true)
    const acl = { connect: vi.fn(async () => {}) } as unknown as Acl
    render(
      <Boot {...base} envToken={undefined} makeAcl={() => acl} resolve={() => null} renderReady={renderReady} />,
    )
    await waitFor(() => expect(screen.getByText('Não foi possível entrar')).toBeTruthy())
    expect(scrubCallback).toHaveBeenCalledTimes(1)
    expect(acl.connect).not.toHaveBeenCalled()
    // Guard: NÃO caiu no no-session genérico.
    expect(screen.queryByText('Entre no Tayet')).toBeNull()
  })

  it('no-session → clicar o botão SSO inicia o redirect (beginLogin) e mostra o beat redirecting', async () => {
    const acl = { connect: vi.fn(async () => {}) } as unknown as Acl
    render(
      <Boot {...base} envToken={undefined} makeAcl={() => acl} resolve={() => null} renderReady={renderReady} />,
    )
    await waitFor(() => expect(screen.getByText('Continuar com Dex (local)')).toBeTruthy())
    fireEvent.click(screen.getByText('Continuar com Dex (local)'))
    await waitFor(() => expect(beginLogin).toHaveBeenCalledTimes(1))
    expect(vi.mocked(beginLogin).mock.calls[0]![0]).toMatchObject({ serverUrl: 'http://x', clientId: 'TAYET' })
    await waitFor(() => expect(screen.getByText(/Levando você ao Dex \(local\)/)).toBeTruthy())
  })
})

describe('Boot: classificação de erro de sessão (PR-B — §8.L30)', () => {
  it('connect rejeita SessionExpiredError → tela de revogação (re-login SSO), não retry', async () => {
    const acl = {
      connect: vi.fn(async () => {
        throw new SessionExpiredError()
      }),
    } as unknown as Acl
    render(
      <Boot
        {...base}
        envToken="mct_expired"
        makeAcl={() => acl}
        resolve={(t) => (t ? session(t) : null)}
        renderReady={renderReady}
      />,
    )
    // Controle positivo da tela 'revoked' (D8b): mensagem de revogação + verbo de re-login.
    await waitFor(() => expect(screen.getByText('Seu acesso foi encerrado')).toBeTruthy())
    expect(screen.getByText('Entrar de novo')).toBeTruthy()
    // Guarda: NÃO é a tela de erro/retry.
    expect(screen.queryByText('Tentar novamente')).toBeNull()
  })

  it('connect rejeita ConnectionError → copy de CONEXÃO com retry (o único sinal que a autoriza)', async () => {
    const acl = {
      connect: vi.fn(async () => {
        throw new ConnectionError()
      }),
    } as unknown as Acl
    render(
      <Boot
        {...base}
        envToken="mct_neterr"
        makeAcl={() => acl}
        resolve={(t) => (t ? session(t) : null)}
        renderReady={renderReady}
      />,
    )
    await waitFor(() => expect(screen.getByText('Não foi possível conectar')).toBeTruthy())
    expect(screen.getByText('Confira sua conexão e tente novamente.')).toBeTruthy()
    expect(screen.getByText('Tentar novamente')).toBeTruthy()
    // Guardas: nem revogação, nem o estado neutro.
    expect(screen.queryByText('Seu acesso foi encerrado')).toBeNull()
    expect(screen.queryByText('Não foi possível iniciar')).toBeNull()
  })

  it('connect rejeita Error genérico → estado NEUTRO com retry + saída (nunca a copy de conexão)', async () => {
    const acl = {
      connect: vi.fn(async () => {
        throw new Error('local store exploded')
      }),
    } as unknown as Acl
    render(
      <Boot
        {...base}
        envToken="mct_localfail"
        makeAcl={() => acl}
        resolve={(t) => (t ? session(t) : null)}
        renderReady={renderReady}
      />,
    )
    await waitFor(() => expect(screen.getByText('Não foi possível iniciar')).toBeTruthy())
    // As duas ações do estado: retry (primária) + escape hatch (secundária).
    expect(screen.getByText('Tentar novamente')).toBeTruthy()
    expect(screen.getByText('Entrar de novo')).toBeTruthy()
    // Guardas da inversão (§8.9): sem sinal de rede, NADA de mandar conferir a conexão; e falha
    // local NÃO é sessão encerrada.
    expect(screen.queryByText('Não foi possível conectar')).toBeNull()
    expect(screen.queryByText('Seu acesso foi encerrado')).toBeNull()
  })

  it('estado neutro → "Entrar de novo" reusa o signOut (wipe + sessão limpa) e aterrissa na revogação', async () => {
    localStorage.setItem('tayet.session', 'PERSISTED_BLOB')
    const signOut = vi.fn(async () => {})
    const acl = {
      connect: vi.fn(async () => {
        throw new Error('local store exploded')
      }),
      signOut,
    } as unknown as Acl
    render(
      <Boot
        {...base}
        envToken="mct_localfail"
        makeAcl={() => acl}
        resolve={(t) => (t ? session(t) : null)}
        renderReady={renderReady}
      />,
    )
    await waitFor(() => expect(screen.getByText('Entrar de novo')).toBeTruthy())
    fireEvent.click(screen.getByText('Entrar de novo'))

    // O escape hatch é o signOut EXISTENTE: ACL limpa, sessão do app some, tela de revogação.
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByText('Seu acesso foi encerrado')).toBeTruthy())
    expect(localStorage.getItem('tayet.session')).toBeNull()
  })
})

describe('Boot: logout deste navegador (fatia 2b — ADR-034)', () => {
  it('signOut → ACL para+limpa, sessão do app some, tela de revogação; "Entrar de novo" reinicia o SSO', async () => {
    // A sessão persistida que o logout deve apagar (clearSession real escreve no localStorage do jsdom).
    localStorage.setItem('tayet.session', 'PERSISTED_BLOB')
    const signOut = vi.fn(async () => {})
    const acl = { connect: vi.fn(async () => {}), signOut } as unknown as Acl
    // O renderReady recebe o onSignOut que o Boot injeta e o expõe num botão de teste.
    const ready = (_acl: Acl, onSignOut: () => void) => <button onClick={onSignOut}>SAIR</button>
    render(
      <Boot
        {...base}
        envToken="mct_ok"
        makeAcl={() => acl}
        resolve={(t) => (t ? session(t) : null)}
        renderReady={ready}
      />,
    )
    await waitFor(() => expect(screen.getByText('SAIR')).toBeTruthy())
    fireEvent.click(screen.getByText('SAIR'))

    // (1) o signOut da ACL é chamado exatamente uma vez (para o cliente + apaga cripto, local-only).
    await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1))
    // (3) a tela passou à revogação (D8b).
    await waitFor(() => expect(screen.getByText('Seu acesso foi encerrado')).toBeTruthy())
    // (2) a sessão persistida do app foi limpa.
    expect(localStorage.getItem('tayet.session')).toBeNull()

    // (4) "Entrar de novo" reinicia o login cold (beginLogin).
    fireEvent.click(screen.getByText('Entrar de novo'))
    await waitFor(() => expect(beginLogin).toHaveBeenCalledTimes(1))
  })
})

describe('Boot: sessão morta mid-session (ADR-035 D3)', () => {
  it('sessão perdida em runtime → teardown único (idempotente) e revoked, mesmo em rajada (ADR-035 D3)', async () => {
    let fireLost: () => void = () => {}
    const acl = {
      connect: vi.fn(async () => {}),
      signOut: vi.fn(async () => {}),
    } as unknown as Acl
    render(
      <Boot
        {...base}
        envToken={undefined}
        resolve={() => session('PERSISTED_BLOB')}
        makeAcl={(_s, _t, _onRenewed, onLost) => {
          fireLost = onLost
          return acl
        }}
        renderReady={renderReady}
      />,
    )
    await waitFor(() => expect(screen.getByText(READY)).toBeTruthy())

    // A tempestade: o mesmo sinal dispara N vezes (sync/keys/turnServer/createRoom no real).
    fireLost()
    fireLost()
    fireLost()

    await waitFor(() => expect(acl.signOut).toHaveBeenCalledTimes(1)) // 1º vence; resto no-op
    await waitFor(() => expect(screen.getByText('Seu acesso foi encerrado')).toBeTruthy()) // revoked
  })

  it('signOut da ACL que nunca resolve (wipe bloqueado) → revoked dentro do bound (ADR-059 D2)', async () => {
    let fireLost: () => void = () => {}
    // O wipe preso por outra aba: a promise do signOut nunca assenta.
    const signOut = vi.fn(() => new Promise<void>(() => {}))
    const acl = { connect: vi.fn(async () => {}), signOut } as unknown as Acl
    render(
      <Boot
        {...base}
        envToken={undefined}
        resolve={() => session('PERSISTED_BLOB')}
        makeAcl={(_s, _t, _onRenewed, onLost) => {
          fireLost = onLost
          return acl
        }}
        renderReady={renderReady}
      />,
    )
    await waitFor(() => expect(screen.getByText(READY)).toBeTruthy())

    vi.useFakeTimers()
    try {
      act(() => fireLost())
      act(() => {
        vi.advanceTimersByTime(STORE_WIPE_BOUND_MS)
      })
      expect(screen.getByText('Seu acesso foi encerrado')).toBeTruthy()
      expect(signOut).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
