// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, within } from '@testing-library/react'
import { ChannelList } from '../../src/ui/components/ChannelList'
import { Workspace } from '../../src/ui/components/Workspace'
import type { Channel, ChannelId } from '../../src/acl'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'

// PLANO-RELEASE-PUBLICA §8.35: a private channel shows a lock in place of the '#', in the channel
// list and in the channel header; a public channel keeps the '#'; a DM is unchanged. The ACL
// contract is untouched (Channel.name is still '#'+name) — the swap is presentation only.
// Copy speaks of ACCESS, never of encryption (P1, ROTEIRO-U2 §0).

const cid = (s: string): ChannelId => s as unknown as ChannelId

const pub: Channel = {
  id: cid('!engineering:tayet.local'), // protocol-shaped on purpose: any DOM leak turns red
  name: '#engineering',
  kind: 'public',
  memberCount: 3,
  unread: { count: 0, mentions: 0 },
}
const priv: Channel = {
  id: cid('!board:tayet.local'),
  name: '#board',
  kind: 'private',
  topic: 'Decisões da diretoria',
  memberCount: 2,
  unread: { count: 2, mentions: 0 },
}
const dm: Channel = {
  id: cid('!dmcarol:tayet.local'),
  name: 'Carol Dias',
  kind: 'dm',
  memberCount: 2,
  unread: { count: 0, mentions: 0 },
}

// Words the access copy must never carry: the P1 crypto/verification vocabulary (ROTEIRO-U2 §0)
// plus anything that frames the public channel as less safe.
const FORBIDDEN_COPY = /cript|cifr|encrypt|E2E|chave|\bkey\b|verifica|verif|seguro|segura|secure|inseguro/i

afterEach(cleanup)

function renderWorkspace(selected: Channel) {
  return render(
    <Workspace
      channels={[pub, priv, dm]}
      selectedChannelId={selected.id}
      messages={[]}
      usersById={{}}
      connection="connected"
      onSelectChannel={() => {}}
      onSend={() => {}}
    />,
  )
}

describe('Private-channel indicator (§8.35)', () => {
  it('list: private row carries the lock named "Canal privado"; public keeps the #; DM unchanged', () => {
    const { getByRole } = render(<ChannelList channels={[pub, priv, dm]} onSelect={() => {}} />)
    const canais = getByRole('region', { name: 'Canais' })

    const privRow = within(canais).getByRole('button', { name: /^Canal privado board/ })
    expect(within(privRow).getByRole('img', { name: 'Canal privado' })).toBeTruthy()
    expect(privRow.textContent).not.toContain('#')

    // Public: the '#' idiom, no lock — and the accessible name the E2E relies on ('#all' shape).
    const pubRow = within(canais).getByRole('button', { name: '#engineering' })
    expect(within(pubRow).queryByRole('img')).toBeNull()

    const dmRow = within(getByRole('region', { name: 'Mensagens diretas' })).getByRole('button', {
      name: /Carol Dias/,
    })
    expect(within(dmRow).queryByRole('img', { name: 'Canal privado' })).toBeNull()
  })

  it('header: private shows the lock with the access tooltip; public shows the #', () => {
    const privView = renderWorkspace(priv)
    const privHeading = privView.getByRole('heading', { name: 'Canal privado board' })
    const lock = within(privHeading).getByRole('img', { name: 'Canal privado' })
    expect(lock.getAttribute('title')).toBe('Só quem foi adicionado vê este canal')
    expect(privHeading.textContent?.trim()).toBe('board')
    cleanup()

    const pubView = renderWorkspace(pub)
    const pubHeading = pubView.getByRole('heading', { name: '#engineering' })
    expect(within(pubHeading).queryByRole('img')).toBeNull()
  })

  it('render-scan (P1) with a private channel selected: no protocol shape, no crypto copy', () => {
    const { container } = renderWorkspace(priv)

    // Positive control: the private channel and its mark ARE on screen.
    expect(container.textContent).toContain('board')
    expect(container.innerHTML).toContain('Canal privado')
    expect(container.innerHTML).toContain('Só quem foi adicionado vê este canal')

    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
    expect(container.textContent ?? '').not.toMatch(FORBIDDEN_COPY)
    // Attributes too (aria-label, title): the access copy is the only one the mark carries.
    const attrCopy = Array.from(container.querySelectorAll('[aria-label],[title]'))
      .map((el) => `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('title') ?? ''}`)
      .join(' ')
    expect(attrCopy).not.toMatch(FORBIDDEN_COPY)
  })
})
