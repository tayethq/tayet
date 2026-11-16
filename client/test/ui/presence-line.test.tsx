// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { Timeline } from '../../src/ui/components/Timeline'
import { ChannelManagementPanel } from '../../src/ui/components/ChannelManagementPanel'
import { MediaProvider } from '../../src/ui/MediaContext'
import type {
  Channel,
  ChannelId,
  Message,
  MessageId,
  Presence,
  User,
  UserId,
} from '../../src/acl'

// Superfícies de linha com presença (ADR-056 rollout, §8.4) — uma por regime: Timeline
// (cotidiano, dot 9) e roster do ChannelManagementPanel (gestão, dot 8 — cluster 22 herdado por
// referência, new-conversation.md §2). Estilo semântica-sobrevive-reestruturação: as queries
// ancoram em classe de conteúdo (.ui-avatar__dot) e aria (o botão de perfil com o nome limpo),
// nunca na árvore. Dot-só-online (workspace.md §7 item 3): offline/away = sem forma visual.

const cid = (s: string): ChannelId => s as unknown as ChannelId
const uid = (s: string): UserId => s as unknown as UserId
const mid = (s: string): MessageId => s as unknown as MessageId
const tms = (n: number) => n as unknown as Message['sentAt']

const alice: User = { id: uid('@alice:tayet.local'), displayName: 'Alice Anderson', kind: 'member' }
const bob: User = { id: uid('@bob:tayet.local'), displayName: 'Bob Brown', kind: 'member' }

// O caminho (b) do rollout: leitura síncrona mapa-primeiro composta no Workspace. Aqui o fake é a
// própria função — as superfícies só a chamam.
const presenceOf = (u: UserId): Presence => (u === alice.id ? 'online' : 'offline')

afterEach(cleanup)

// O dot do avatar da linha de `name`, ancorado no botão de perfil (aria com o nome limpo, P1).
function dotIn(container: HTMLElement, name: string): Element | null {
  const opener = container.querySelector(`button[aria-label="Ver perfil de ${name}"]`)!
  expect(opener).not.toBeNull()
  return opener.querySelector('.ui-avatar__dot')
}

describe('presença nas superfícies de linha (ADR-056 rollout)', () => {
  it('Timeline (cotidiano): dot no autor online, nenhum no offline', () => {
    const messages: Message[] = [
      {
        id: mid('$e1:tayet.local'),
        channelId: cid('!eng:tayet.local'),
        author: alice.id,
        body: { kind: 'text', text: 'Oi' },
        sentAt: tms(1),
        reactions: [],
      },
      {
        id: mid('$e2:tayet.local'),
        channelId: cid('!eng:tayet.local'),
        author: bob.id,
        body: { kind: 'text', text: 'Olá' },
        sentAt: tms(2),
        reactions: [],
      },
    ] as unknown as Message[]
    const { container } = render(
      <MediaProvider resolve={async () => ({ url: '', release: () => {} })}>
        <Timeline
          messages={messages}
          usersById={{ [alice.id as unknown as string]: alice, [bob.id as unknown as string]: bob }}
          presenceOf={presenceOf}
        />
      </MediaProvider>,
    )
    expect(dotIn(container, 'Alice Anderson')).not.toBeNull()
    expect(dotIn(container, 'Bob Brown')).toBeNull()
  })

  it('roster de gestão: dot no membro online, nenhum no offline', () => {
    const channel: Channel = {
      id: cid('!eng:tayet.local'),
      name: '#engineering',
      kind: 'public',
      memberCount: 2,
      unread: { count: 0, mentions: 0 },
    }
    const { container } = render(
      <MediaProvider resolve={async () => ({ url: '', release: () => {} })}>
        <ChannelManagementPanel
          channel={channel}
          members={[
            { user: alice, role: 'admin', state: 'active', self: false },
            { user: bob, role: 'member', state: 'active', self: false },
          ]}
          onUpdateChannel={async () => {}}
          onArchiveChannel={async () => {}}
          onLeaveChannel={async () => {}}
          onSetRole={async () => {}}
          onRemoveMember={async () => {}}
          onAddMember={async () => {}}
          loadCandidates={async () => []}
          presenceOf={presenceOf}
          onClose={() => {}}
        />
      </MediaProvider>,
    )
    expect(dotIn(container, 'Alice Anderson')).not.toBeNull()
    expect(dotIn(container, 'Bob Brown')).toBeNull()
  })

  it('sem presenceOf (harness bare): nenhum wrapper, nenhum dot — DOM do Avatar byte-idêntico', () => {
    const messages: Message[] = [
      {
        id: mid('$e1:tayet.local'),
        channelId: cid('!eng:tayet.local'),
        author: alice.id,
        body: { kind: 'text', text: 'Oi' },
        sentAt: tms(1),
        reactions: [],
      },
    ] as unknown as Message[]
    const { container } = render(
      <MediaProvider resolve={async () => ({ url: '', release: () => {} })}>
        <Timeline
          messages={messages}
          usersById={{ [alice.id as unknown as string]: alice }}
        />
      </MediaProvider>,
    )
    expect(container.querySelector('.ui-avatar')).not.toBeNull()
    expect(container.querySelector('.ui-avatar-wrap')).toBeNull()
    expect(container.querySelector('.ui-avatar__dot')).toBeNull()
  })
})
