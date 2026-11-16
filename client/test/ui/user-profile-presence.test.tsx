// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, waitFor, act } from '@testing-library/react'
import { UserProfileDialog } from '../../src/ui/components/UserProfileDialog'
import type { Presence, UserId, UserProfile } from '../../src/acl'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'

// Presença no perfil-de-outro (ADR-056, PR-2). O Dialog lê o point read na abertura e ASSINA o
// stream (estreitado pelo useChat em (user, presence)) pelo tempo de vida — a subscription é o
// ponto do ADR-056, não ler-uma-vez-e-só. O filtro pelo alvo é do Dialog: evento de OUTRO usuário
// não muda nada. O DOM carrega o vocabulário do PROTÓTIPO ('away' → data-presence="ausente",
// manifesto §5) e a copy plana adjudicada (ADR-056 dec. 5.ii) — sem "ativa há…"/"visto…".

const uid = (s: string): UserId => s as unknown as UserId
const bob: UserProfile = { id: uid('@bob:tayet.local'), displayName: 'Bob Brown', kind: 'member' }

afterEach(cleanup)

// Fake local no idioma das props (o arranjo é DESTE arquivo — os fakes compartilhados de Acl não
// mudam): onGetPresence devolve o estado inicial; onSubscribePresence captura o handler pra emitir
// depois e conta os unsubscribes.
function renderWithPresence(initial: Presence) {
  let handler: ((user: UserId, presence: Presence) => void) | null = null
  let unsubscribes = 0
  const utils = render(
    <UserProfileDialog
      userId={bob.id}
      onLoadUserProfile={async () => bob}
      onGetPresence={() => initial}
      onSubscribePresence={(h) => {
        handler = h
        return () => {
          unsubscribes += 1
        }
      }}
      onClose={() => {}}
    />,
  )
  const emit = (user: UserId, presence: Presence) => {
    act(() => handler?.(user, presence))
  }
  return { ...utils, emit, unsubscribes: () => unsubscribes }
}

const rootAttr = (container: HTMLElement) =>
  container.querySelector('.user-profile')?.getAttribute('data-presence')

const lineLabel = (container: HTMLElement) =>
  container.querySelector('.user-profile__presence')?.textContent

describe('UserProfileDialog — presença (ADR-056)', () => {
  // (i) cada estado do domínio → label plano + data-presence no vocabulário do protótipo.
  it.each([
    ['online', 'online', 'Online'],
    ['away', 'ausente', 'Ausente'],
    ['offline', 'offline', 'Offline'],
  ] as const)('estado %s: data-presence="%s" na raiz e label "%s"', async (domain, attr, label) => {
    const { container } = renderWithPresence(domain)
    await waitFor(() => expect(lineLabel(container)).toBe(label))

    expect(rootAttr(container)).toBe(attr) // raiz cascateia pros dois dots (protótipo)
    expect(container.querySelector('.user-profile__presence-badge')).not.toBeNull() // dot do avatar
    expect(container.querySelector('.user-profile__presence-dot')).not.toBeNull() // dot da linha
    // Copy plana adjudicada: nunca o "último-ativo" do protótipo (deferido, ADR-056 dec. 5.ii).
    expect(container.textContent ?? '').not.toContain('ativa há')
    expect(container.textContent ?? '').not.toContain('visto')
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  // (ii) evento do usuário ABERTO → o label atualiza ao vivo (a subscription é o ponto).
  it('evento user.presence do alvo atualiza o label e o data-presence ao vivo', async () => {
    const { container, emit, unmount, unsubscribes } = renderWithPresence('offline')
    await waitFor(() => expect(lineLabel(container)).toBe('Offline'))

    emit(bob.id, 'online')
    expect(lineLabel(container)).toBe('Online')
    expect(rootAttr(container)).toBe('online')

    emit(bob.id, 'away')
    expect(lineLabel(container)).toBe('Ausente')
    expect(rootAttr(container)).toBe('ausente')

    // Vivo ENQUANTO aberto: o unmount desliga a subscription (idioma do useChat).
    unmount()
    expect(unsubscribes()).toBe(1)
  })

  // (iii) evento de OUTRO usuário → nada muda.
  it('evento de outro usuário não muda nada', async () => {
    const { container, emit } = renderWithPresence('offline')
    await waitFor(() => expect(lineLabel(container)).toBe('Offline'))

    emit(uid('@carol:tayet.local'), 'online')
    expect(lineLabel(container)).toBe('Offline')
    expect(rootAttr(container)).toBe('offline')
  })

  // Props ausentes (harness bare): nenhum cluster, nenhuma promessa — nem o atributo na raiz.
  it('sem as props de presença: sem dots, sem linha, sem data-presence', async () => {
    const { container } = render(
      <UserProfileDialog userId={bob.id} onLoadUserProfile={async () => bob} onClose={() => {}} />,
    )
    await waitFor(() =>
      expect(container.querySelector('.user-profile__name')?.textContent).toBe('Bob Brown'),
    )
    expect(container.querySelector('.user-profile__presence')).toBeNull()
    expect(container.querySelector('.user-profile__presence-badge')).toBeNull()
    expect(rootAttr(container)).toBeNull()
  })
})
