// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, act, fireEvent } from '@testing-library/react'
import { NewAccessBanner } from '../../src/ui/components/NewAccessBanner'
import { App } from '../../src/ui/App'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import type { Acl, AccessId, DomainEvent, Device, Timestamp, UserId } from '../../src/acl'

const aid = (s: string): AccessId => s as unknown as AccessId

afterEach(cleanup)

describe('NewAccessBanner (ADR-018 §3.3, colapsado — PR-S2)', () => {
  it('N=1: renders product copy with the friendlyName when present', () => {
    const { container } = render(
      <NewAccessBanner accesses={[{ access: aid('DEV1'), friendlyName: 'iPhone de Ana' }]} onDismiss={() => {}} />,
    )
    const text = container.textContent ?? ''
    expect(text).toContain('Novo acesso à sua conta')
    expect(text).toContain('iPhone de Ana')
  })

  it('N=1: falls back to generic copy when the friendlyName is absent or blank', () => {
    const { container } = render(
      <NewAccessBanner accesses={[{ access: aid('DEV1'), friendlyName: '   ' }]} onDismiss={() => {}} />,
    )
    const text = container.textContent ?? ''
    expect(text).toContain('Novo acesso à sua conta')
    expect(text).toContain('acessada recentemente')
  })

  it('renders nothing when there are no accesses', () => {
    const { container } = render(<NewAccessBanner accesses={[]} onDismiss={() => {}} />)
    expect(container.textContent).toBe('')
  })

  // Colapso (PR-S2): N>1 vira UMA linha-resumo de contagem — sem stacking, sem cap — e SEM nome de
  // dispositivo (o detalhe por-acesso vive no modal de conta; o nome só aparece no caso único).
  it('N>1: collapses to a single count line and never shows a device name', () => {
    const accesses = [
      { access: aid('DEV0'), friendlyName: 'Ana — iPad' },
      { access: aid('DEV1'), friendlyName: 'Ana — Laptop' },
      { access: aid('DEV2') },
    ]
    const { container } = render(<NewAccessBanner accesses={accesses} onDismiss={() => {}} />)
    expect(container.querySelectorAll('.new-access-banner').length).toBe(1)
    const text = container.textContent ?? ''
    expect(text).toContain('3 novos acessos à sua conta')
    expect(text).not.toContain('Ana — iPad')
    expect(text).not.toContain('Ana — Laptop')
  })

  it('dismissing acknowledges the whole batch — every AccessId, opaque', () => {
    const onDismiss = vi.fn()
    const accesses = Array.from({ length: 4 }, (_, i) => ({ access: aid(`DEV${i}`) }))
    const { getByRole } = render(<NewAccessBanner accesses={accesses} onDismiss={onDismiss} />)
    fireEvent.click(getByRole('button', { name: /dispensar/i }))
    expect(onDismiss).toHaveBeenCalledTimes(4)
    accesses.forEach((a) => expect(onDismiss).toHaveBeenCalledWith(a.access))
  })

  it('hands the OPAQUE AccessId back to onDismiss and never renders it', () => {
    // The AccessId value is itself protocol-shaped (the ADR-008 residual). Dismiss hands it back —
    // and the scan proves it never reached the DOM. (N=1 → the friendlyName is product vocab and may
    // render; the scan flags protocol shapes, not names.)
    const onDismiss = vi.fn()
    const access = aid('@spoof:tayet.local')
    const { container, getByRole } = render(
      <NewAccessBanner accesses={[{ access, friendlyName: 'Ana — Laptop' }]} onDismiss={onDismiss} />,
    )
    fireEvent.click(getByRole('button', { name: /dispensar/i }))
    expect(onDismiss).toHaveBeenCalledWith(access)
    expect(container.textContent ?? '').not.toContain('@spoof')
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })
})

// ── App-level: the event→banner→verb path through useChat ──────────────────────────────────
// A fake Acl that captures the global subscribe handler so the test can emit an account.newAccess,
// and spies acknowledgeAccess to prove dismiss calls it with the opaque id.
function fakeAcl(): { acl: Acl; emit: (e: DomainEvent) => void; acked: AccessId[] } {
  // Every global subscriber (useChat, useAgentForm…) — the App subscribes more than once.
  const handlers = new Set<(e: DomainEvent) => void>()
  const acked: AccessId[] = []
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
    getConnectionState: () => 'connecting' as const,
    getChannelAbilities: () => ({ rename: false, editTopic: false, addPeople: false, removePeople: false, setRoles: false, archive: false }),
    getDevices: async () => [],
    currentUser: async () => ({ id: '@me:tayet.local' as unknown as UserId, displayName: 'Me', kind: 'member' }),
    getMyProfile: async () => ({ fullName: 'Me' }),
    getUserProfile: async (u) => ({ id: u, displayName: 'User', kind: 'member' }),
    updateMyProfile: async () => {},
    setAvatar: async () => { throw new Error('avatar verb not used in this test') },
    removeAvatar: async () => { throw new Error('avatar verb not used in this test') },
    getAccountPreferences: async () => ({}),
    setAccountPreferences: async () => {},
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
    watchAwaitingApprovals: () => () => {},
    submitForm: async () => ({ ok: true }),
    closeForm: () => {},
    listPanels: async () => [],
    listCommands: async () => [],
    editMessage: noop,
    deleteMessage: noop,
    react: noop,
    removeReaction: noop,
    markRead: noop,
    acknowledgeAccess: (access) => {
      acked.push(access)
    },
    resetAccess: async () => ({ t: 'done', historyPreserved: true }),
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
    getOrgAccess: () => Promise.reject(new Error('unused')),
    setOrgAdmin: async () => {},
    enableDeviceNotifications: noop,
    disableDeviceNotifications: noop,
    resolveNotificationTarget: async () => undefined,
    signOut: noop,
  }
  return { acl, emit: (e) => handlers.forEach((h) => h(e)), acked }
}

const dev = (id: string, friendlyName: string): Device => ({ id: id as Device['id'], friendlyName, current: false })

describe('App — new-access notification end to end (ADR-018)', () => {
  it('shows a banner on account.newAccess and acknowledges with the opaque id on dismiss', async () => {
    const { acl, emit, acked } = fakeAcl()
    const { container, getByRole, findByText } = render(<App acl={acl} onSignOut={() => {}} />)

    await act(async () => {
      emit({
        t: 'account.newAccess',
        access: aid('@spoof:tayet.local'),
        device: dev('!spoofed:tayet.local', 'Ana — iPad'),
        at: 1 as Timestamp,
      })
    })

    await findByText(/Novo acesso à sua conta/)
    expect(container.textContent ?? '').toContain('Ana — iPad')
    // The whole rendered app stays P1-clean (the opaque id never leaks onto the screen).
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])

    await act(async () => {
      fireEvent.click(getByRole('button', { name: /dispensar/i }))
    })
    expect(acked).toEqual([aid('@spoof:tayet.local')])
    // Banner is gone after dismiss.
    expect(container.textContent ?? '').not.toContain('Novo acesso à sua conta')
  })
})
