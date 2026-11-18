// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, act, fireEvent } from '@testing-library/react'
import { ResetAccessBanner } from '../../src/ui/components/ResetAccessBanner'
import { AccountSettings } from '../../src/ui/components/AccountSettings'
import { App } from '../../src/ui/App'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import type { Acl, DomainEvent, Device, UserId } from '../../src/acl'
import { noExport } from '../support/data-export-fake'

afterEach(cleanup)

describe('ResetAccessBanner (ADR-019 §1)', () => {
  it('renders nothing when not present', () => {
    const { container } = render(<ResetAccessBanner present={false} onReset={() => {}} />)
    expect(container.textContent).toBe('')
  })

  it('offers the reset with product copy and calls onReset on click; render-scan green', () => {
    const onReset = vi.fn()
    const { container, getByRole } = render(<ResetAccessBanner present onReset={onReset} />)
    const text = container.textContent ?? ''
    expect(text).toContain('Esta sessão precisa de você')
    expect(text).toContain('redefina o acesso')
    fireEvent.click(getByRole('button', { name: /Redefinir o acesso/i }))
    expect(onReset).toHaveBeenCalledTimes(1)
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })
})

describe('estados do reset (ADR-082)', () => {
  const COPY = {
    pending: 'Confirme na janela que abriu. Esta tela segue sozinha depois.',
    done: 'Acesso redefinido. Entre de novo para continuar.',
    notDone: 'O acesso não foi redefinido. Você pode tentar de novo.',
  } as const

  it('banner: cada estado com a sua copy e a sua ação; render-scan verde', () => {
    const onReset = vi.fn()
    const onSignOut = vi.fn()
    const pending = render(<ResetAccessBanner present={false} status="pending" onReset={onReset} onSignOut={onSignOut} />)
    expect(pending.container.textContent).toBe(COPY.pending)
    expect(pending.queryByRole('button')).toBeNull()
    expect(findProtocolLeaksInText(pending.container.innerHTML)).toEqual([])
    cleanup()

    const notDone = render(<ResetAccessBanner present={false} status="notDone" onReset={onReset} onSignOut={onSignOut} />)
    expect(notDone.container.textContent).toContain(COPY.notDone)
    fireEvent.click(notDone.getByRole('button', { name: 'Tentar de novo' }))
    expect(onReset).toHaveBeenCalledTimes(1)
    expect(findProtocolLeaksInText(notDone.container.innerHTML)).toEqual([])
    cleanup()

    const done = render(<ResetAccessBanner present={false} status="done" onReset={onReset} onSignOut={onSignOut} />)
    expect(done.container.textContent).toContain(COPY.done)
    fireEvent.click(done.getByRole('button', { name: 'Entrar de novo' }))
    expect(onSignOut).toHaveBeenCalledTimes(1)
    expect(findProtocolLeaksInText(done.container.innerHTML)).toEqual([])
  })

  it('a confirmação da conta carrega os mesmos estados, sem URL nem termo de protocolo', () => {
    const onReset = vi.fn()
    const onSignOut = vi.fn()
    const account = (status: 'idle' | 'pending' | 'done' | 'notDone') => (
      <AccountSettings open accesses={[]} onLoadProfile={async () => ({ fullName: 'Alice Stone' })} onSaveProfile={async () => {}} onSaveAvatar={async () => {}} onClearAvatar={async () => {}} onExportData={noExport} onReset={onReset} resetStatus={status} onSignOut={onSignOut} theme="light" onThemeChange={() => {}} onClose={() => {}} />
    )
    const { getByRole, queryByRole, rerender, baseElement } = render(account('idle'))
    fireEvent.click(getByRole('button', { name: /Acessos à sua conta/i }))
    fireEvent.click(getByRole('button', { name: /Redefinir o acesso da conta/i }))

    rerender(account('pending'))
    expect(getByRole('status').textContent).toBe(COPY.pending)
    expect(queryByRole('button', { name: /^Redefinir o acesso$/i })).toBeNull()
    // §10 item 2: sem rodapé; varredura indeterminada sob o corpo (decorativa, fora da árvore a11y).
    expect(queryByRole('button', { name: 'Cancelar' })).toBeNull()
    expect(baseElement.querySelector('[role="dialog"] .sweep[aria-hidden="true"]')).not.toBeNull()
    expect(findProtocolLeaksInText(baseElement.innerHTML)).toEqual([])

    rerender(account('notDone'))
    expect(getByRole('status').textContent).toBe(COPY.notDone)
    // §10 item 3: Cancelar · "Tentar de novo" danger-fill; sem varredura.
    expect(getByRole('button', { name: 'Cancelar' })).toBeTruthy()
    expect(getByRole('button', { name: 'Tentar de novo' }).dataset.variant).toBe('danger-fill')
    expect(baseElement.querySelector('[role="dialog"] .sweep')).toBeNull()
    fireEvent.click(getByRole('button', { name: 'Tentar de novo' }))
    expect(onReset).toHaveBeenCalledTimes(1)

    rerender(account('done'))
    expect(getByRole('status').textContent).toBe(COPY.done)
    // §10 item 4: só "Entrar de novo", primário (não danger-fill); botões no tamanho gestao (fork 2).
    expect(queryByRole('button', { name: 'Cancelar' })).toBeNull()
    expect(getByRole('button', { name: 'Entrar de novo' }).dataset.variant).toBe('fill')
    expect(getByRole('button', { name: 'Entrar de novo' }).dataset.size).toBe('gestao')
    fireEvent.click(getByRole('button', { name: 'Entrar de novo' }))
    expect(onSignOut).toHaveBeenCalledTimes(1)
    expect(findProtocolLeaksInText(baseElement.innerHTML)).toEqual([])
  })
})

describe('AccountSettings (ADR-019 §3.4 — always available)', () => {
  it('renders the always-available reset action and (via confirm) calls onReset; render-scan green', () => {
    const onReset = vi.fn()
    const { container, getByRole } = render(
      <AccountSettings open accesses={[]} onLoadProfile={async () => ({ fullName: 'Alice Stone' })} onSaveProfile={async () => {}} onSaveAvatar={async () => {}} onClearAvatar={async () => {}} onExportData={noExport} onReset={onReset} onSignOut={() => {}} theme="light" onThemeChange={() => {}} onClose={() => {}} />,
    )
    expect(container.textContent ?? '').toContain('Sua conta')
    // A lista + reset vivem na sub-tela drill-in (addendum F4 ao ADR-038): navega antes de clicar.
    fireEvent.click(getByRole('button', { name: /Acessos à sua conta/i }))
    // A caixa de reset agora abre a confirmação (A4); só o danger-fill da confirmação chama onReset.
    fireEvent.click(getByRole('button', { name: /Redefinir o acesso da conta/i }))
    fireEvent.click(getByRole('button', { name: /^Redefinir o acesso$/i }))
    expect(onReset).toHaveBeenCalledTimes(1)
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  it('the confirmation gates the reset: the box opens it without resetting, Cancel backs out, only the danger resets', () => {
    const onReset = vi.fn()
    const { container, getByRole, queryByRole } = render(
      <AccountSettings open accesses={[]} onLoadProfile={async () => ({ fullName: 'Alice Stone' })} onSaveProfile={async () => {}} onSaveAvatar={async () => {}} onClearAvatar={async () => {}} onExportData={noExport} onReset={onReset} onSignOut={() => {}} theme="light" onThemeChange={() => {}} onClose={() => {}} />,
    )
    fireEvent.click(getByRole('button', { name: /Acessos à sua conta/i }))

    // Abrir a caixa NÃO reseta — só abre a confirmação (com o caveat F3).
    fireEvent.click(getByRole('button', { name: /Redefinir o acesso da conta/i }))
    expect(onReset).not.toHaveBeenCalled()
    expect(container.textContent ?? '').toContain('Conteúdos antigos podem se perder.')

    // Cancelar volta pra `access` sem resetar (o danger some, a caixa reaparece).
    fireEvent.click(getByRole('button', { name: /^Cancelar$/i }))
    expect(onReset).not.toHaveBeenCalled()
    expect(queryByRole('button', { name: /^Redefinir o acesso$/i })).toBeNull()
    expect(container.textContent ?? '').toContain('Recomeça do zero')

    // Reabrir e confirmar pelo danger-fill — só ENTÃO reseta.
    fireEvent.click(getByRole('button', { name: /Redefinir o acesso da conta/i }))
    fireEvent.click(getByRole('button', { name: /^Redefinir o acesso$/i }))
    expect(onReset).toHaveBeenCalledTimes(1)
  })
})

// ── App-level: both entry points drive the SAME verb ────────────────────────────────────────
function fakeAcl(
  resetAccess?: Acl['resetAccess'],
): { acl: Acl; emit: (e: DomainEvent) => void; resetCalls: () => number } {
  // Every global subscriber (useChat, useAgentForm…) — the App subscribes more than once.
  const handlers = new Set<(e: DomainEvent) => void>()
  let resets = 0
  const noop = async () => {}
  const acl: Acl = {
    getChannels: async () => [],
    getArchivedChannels: async () => [],
    getChannel: async () => {
      throw new Error('unused')
    },
    getTimeline: async () => ({ items: [] }),
    getMembers: async () => [],
    getPresence: () => 'offline' as const,
    getDevices: async () => [],
    currentUser: async () => ({ id: '@me:tayet.local' as unknown as UserId, displayName: 'Me', kind: 'member' }),
    getMyProfile: async () => ({ fullName: 'Me' }),
    getUserProfile: async (u) => ({ id: u, displayName: 'User', kind: 'member' }),
    updateMyProfile: async () => {},
    setAvatar: async () => { throw new Error('avatar verb not used in this test') },
    removeAvatar: async () => { throw new Error('avatar verb not used in this test') },
    getThreadUnread: async () => ({ unread: false }),
    searchMessages: async () => [],
    getMessage: async () => undefined,
    subscribe: (h) => {
      handlers.add(h)
      return () => {
        handlers.delete(h)
      }
    },
    subscribeChannel: () => () => {},
    sendMessage: async () => 'm' as never,
    answerApproval: async () => {},
    submitForm: async () => ({ ok: true }),
    closeForm: () => {},
    listPanels: async () => [],
    listCommands: async () => [],
    editMessage: noop,
    deleteMessage: noop,
    react: noop,
    removeReaction: noop,
    markRead: noop,
    acknowledgeAccess: () => {},
    resetAccess: async () => {
      resets++
      return resetAccess ? resetAccess() : { t: 'done', historyPreserved: true }
    },
    resolveMedia: async () => ({ url: '', release: () => {} }),
    exportMyData: () => (async function* () {})(),
    resolveChannel: async () => ({ ok: false, reason: 'not-found' }),
    resolveUser: async () => ({ ok: false, reason: 'not-found' }),
createChannel: async () => { throw new Error('membership verb not used in this test') },
    archiveChannel: async () => {},
    unarchiveChannel: async () => {},
    updateChannel: async () => {},
    leaveChannel: async () => {},
    addMember: async () => {},
    removeMember: async () => {},
    setRole: async () => {},
    openDirectMessage: async () => { throw new Error('membership verb not used in this test') },
    openGroupConversation: async () => {
      throw new Error('group verb not used in this test')
    },
    convertToChannel: async () => {
      throw new Error('group verb not used in this test')
    },
    connect: noop,
    disconnect: noop,
    listPeople: async () => [],
    listOwnAgents: () => [],
    isOrgAdmin: async () => false,
    invitePerson: () => Promise.reject(new Error('unused')),
    removePerson: async () => {},
    createAgent: () => Promise.reject(new Error('not wired')),
    updateAgent: async () => {},
    reissueAgent: () => Promise.reject(new Error('not wired')),
    removeAgent: async () => {},
    signOut: noop,
  }
  return { acl, emit: (e) => handlers.forEach((h) => h(e)), resetCalls: () => resets }
}

const dev = (id: string, friendlyName: string): Device => ({ id: id as Device['id'], friendlyName, current: false })

describe('App — reset entry points end to end (ADR-019)', () => {
  it('device.attention raises the actionable banner; clicking it drives resetAccess; render-scan green', async () => {
    const { acl, emit, resetCalls } = fakeAcl()
    const { container, getByRole, findByText } = render(<App acl={acl} onSignOut={() => {}} />)

    // No banner until the wall is hit.
    expect(container.textContent ?? '').not.toContain('Esta sessão precisa de você')

    await act(async () => {
      emit({ t: 'device.attention', device: dev('!spoofed:tayet.local', 'Ana — Laptop') })
    })

    await findByText(/Esta sessão precisa de você/)
    // The opaque device id never reaches the screen, and the whole app stays P1-clean.
    expect(container.textContent ?? '').not.toContain('!spoofed')
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /Redefinir o acesso$/i }))
    })
    expect(resetCalls()).toBe(1)
  })

  it('a rejeição do verbo vira o estado "não concluído", com nova tentativa (o catch mudo saiu)', async () => {
    let fail = true
    const { acl, emit, resetCalls } = fakeAcl(async () => {
      if (fail) throw new Error('deferred')
      return { t: 'done', historyPreserved: false }
    })
    const { getByRole, findByText } = render(<App acl={acl} onSignOut={() => {}} />)
    await act(async () => {
      emit({ t: 'device.attention', device: dev('d', 'Ana') })
    })
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /Redefinir o acesso$/i }))
    })
    await findByText('O acesso não foi redefinido. Você pode tentar de novo.')

    fail = false
    await act(async () => {
      fireEvent.click(getByRole('button', { name: 'Tentar de novo' }))
    })
    expect(resetCalls()).toBe(2)
    await findByText('Acesso redefinido. Entre de novo para continuar.')
  })

  it('o verbo é chamado no clique, antes de qualquer await (a janela depende do gesto)', async () => {
    const { acl, emit, resetCalls } = fakeAcl(() => new Promise(() => {}))
    const { getByRole, findByText } = render(<App acl={acl} onSignOut={() => {}} />)
    await act(async () => {
      emit({ t: 'device.attention', device: dev('d', 'Ana') })
    })
    await findByText(/Esta sessão precisa de você/)
    fireEvent.click(getByRole('button', { name: /Redefinir o acesso$/i }))
    expect(resetCalls()).toBe(1)
    await findByText('Confirme na janela que abriu. Esta tela segue sozinha depois.')
  })

  it('settings entry drives the SAME verb, available without any device.attention', async () => {
    const { acl, resetCalls } = fakeAcl()
    const { getByRole, findByRole } = render(<App acl={acl} onSignOut={() => {}} />)
    // A engrenagem do footer da sidebar (ADR-038) abre o modal de conta; o reset vive lá dentro.
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /Sua conta/i }))
    })
    await findByRole('dialog')
    // A lista + reset vivem na sub-tela drill-in (addendum F4 ao ADR-038): navega pela entry-row
    // (getDevices: [] → 0 acessos, mas a entry-row está sempre presente) antes de clicar o reset.
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /Acessos à sua conta/i }))
    })
    // Caixa de reset → confirmação → danger-fill (A4): só o danger dispara o verb.
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /Redefinir o acesso da conta/i }))
    })
    await act(async () => {
      fireEvent.click(getByRole('button', { name: /^Redefinir o acesso$/i }))
    })
    expect(resetCalls()).toBe(1)
  })
})
