// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, within } from '@testing-library/react'
import { ChannelList } from '../../src/ui/components/ChannelList'
import { ChannelLabel, bareName } from '../../src/ui/components/ChannelLabel'
import { InvitePersonDialog } from '../../src/ui/components/InvitePersonDialog'
import { SearchResults } from '../../src/ui/components/SearchResults'
import { Workspace } from '../../src/ui/components/Workspace'
import { MediaProvider } from '../../src/ui/MediaContext'
import type { ResolvedHit } from '../../src/ui/useSearch'
import type { Channel, ChannelId, Message, MessageId, UserId } from '../../src/acl'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { copy, fill } from '../support/copy'

// ADR-094 (decisions 1, 4 and 13) and manifest workspace.md §22: the read side of a group conversation.
// The group lives with the DMs, on the DM row's geometry, with a numbered block (participants + the
// reader) in place of the avatar and, when an agent takes part, the agent's dot on the block. The
// header shows the block, the people and the agents in the topic's place, and the management button
// titled "Detalhes da conversa" (PR-5; the panel is tested in group-details-panel.test.tsx). The
// `participants` ids are protocol-shaped on purpose: they feed only
// the count, never the DOM (the leak scans below are the proof).

const cid = (s: string): ChannelId => s as unknown as ChannelId
const uid = (s: string): UserId => s as unknown as UserId
const mid = (s: string): MessageId => s as unknown as MessageId

const group = (over: Partial<Channel> = {}): Channel => ({
  id: cid('!grupo:tayet.local'),
  name: 'Ana Lima, Bruno Reis',
  kind: 'group',
  memberCount: 3,
  unread: { count: 0, mentions: 0 },
  participants: [uid('@ana:tayet.local'), uid('@bruno:tayet.local')],
  participantAgents: 0,
  ...over,
})
const general: Channel = {
  id: cid('!general:tayet.local'),
  name: '#general',
  kind: 'public',
  memberCount: 5,
  unread: { count: 0, mentions: 0 },
}
const dm: Channel = {
  id: cid('!dmcarol:tayet.local'),
  name: 'Carol Dias',
  kind: 'dm',
  memberCount: 2,
  unread: { count: 0, mentions: 0 },
}
const withAgent = group({
  name: 'Ana Lima, Robô',
  participants: [uid('@ana:tayet.local'), uid('@agent-robo:tayet.local')],
  participantAgents: 1,
})
const alone = group({ name: '', participants: [], participantAgents: 0, memberCount: 1 })

const media = async () => ({ url: '', release: () => {} })
const list = (channels: Channel[], selectedId?: ChannelId) =>
  render(
    <MediaProvider resolve={media}>
      <ChannelList channels={channels} selectedId={selectedId} onSelect={() => {}} onCompose={() => {}} />
    </MediaProvider>,
  )
const workspace = (current: Channel, onManageChannel?: (c: Channel) => void) =>
  render(
    <Workspace
      channels={[current, general]}
      selectedChannelId={current.id}
      messages={[]}
      usersById={{}}
      connection="connected"
      onSelectChannel={() => {}}
      onSend={() => {}}
      onManageChannel={onManageChannel ?? (() => {})}
    />,
  )
const blockName = (n: number) => fill(n === 1 ? copy.group.blockLabel.one : copy.group.blockLabel.other, { n })
const people = (n: number) => fill(n === 1 ? copy.group.people.one : copy.group.people.other, { n })
const agents = (n: number) => fill(n === 1 ? copy.group.agents.one : copy.group.agents.other, { n })

afterEach(cleanup)

describe('list (workspace.md §22.1 items 1 to 3, 5)', () => {
  it('the group sits in "Mensagens diretas", in the section order, and not among the channels', () => {
    const { getByRole } = list([general, dm, group()])
    const channels = getByRole('region', { name: copy.list.channels })
    const dms = getByRole('region', { name: copy.list.dms })
    expect(within(channels).queryByText('Ana Lima, Bruno Reis')).toBeNull()
    expect(within(channels).getAllByRole('button').filter((b) => b.classList.contains('channel'))).toHaveLength(1)
    const rows = within(dms)
      .getAllByRole('button')
      .filter((b) => b.classList.contains('channel'))
    expect(rows.map((r) => r.querySelector('.channel__name')?.textContent)).toEqual(['Carol Dias', 'Ana Lima, Bruno Reis'])
  })

  it('the row: the block with participants + 1, its accessible name, the name with no mark, no presence', () => {
    const { getByRole, container } = list([group()])
    const row = getByRole('button', { name: /Ana Lima, Bruno Reis/ })
    const block = within(row).getByRole('img', { name: blockName(3) })
    expect(block.querySelector('.group-block')?.textContent).toBe('3')
    expect(block.querySelector('.group-block')?.getAttribute('data-size')).toBe('list')
    expect(row.querySelector('.channel__name')?.textContent).toBe('Ana Lima, Bruno Reis')
    expect(row.querySelector('.channel-label__mark, .channel-label__lock')).toBeNull()
    expect(row.querySelector('.ui-avatar, [data-presence]')).toBeNull()
    expect(row.querySelector('[data-group-agent]')).toBeNull()
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
    expect(container.innerHTML).not.toContain('@ana')
  })

  it('an agent among the participants: the block carries the agent dot; none without', () => {
    const { getByRole, container } = list([withAgent])
    const row = getByRole('button', { name: /Ana Lima, Robô/ })
    const block = within(row).getByRole('img', { name: blockName(3) })
    const dot = block.querySelector('[data-group-agent]')
    expect(dot).not.toBeNull()
    expect(dot?.getAttribute('aria-hidden')).toBe('true')
    // The agent mark of the group is the block's dot, not an agent avatar, and never presence.
    expect(row.querySelector('[data-agent-avatar], [data-presence]')).toBeNull()
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
    cleanup()
    const plain = list([group({ participantAgents: undefined })])
    expect(plain.container.querySelector('[data-group-agent]')).toBeNull()
  })

  it('unread and mention marks as in a DM', () => {
    const { getByRole } = list([group({ unread: { count: 2, mentions: 0 } }), group({ id: cid('!g2:tayet.local'), name: 'Caio, Duda', unread: { count: 3, mentions: 1 } })])
    expect(getByRole('button', { name: /Ana Lima, Bruno Reis/ }).querySelector('.channel__unread-dot')).not.toBeNull()
    expect(getByRole('button', { name: /Caio, Duda/ }).querySelector('.badge--mention')?.textContent).toBe('1')
  })

  it('alone: "Só você", quiet, and the block shows 1', () => {
    const { getByRole } = list([alone])
    const row = getByRole('button', { name: new RegExp(copy.group.alone) })
    const name = row.querySelector('.channel__name')!
    expect(name.textContent).toBe(copy.group.alone)
    expect(name.classList.contains('channel__name--alone')).toBe(true)
    expect(within(row).getByRole('img', { name: blockName(1) }).textContent).toBe('1')
  })

  it('alone: the block reads the singular accessible name, list and header', () => {
    const singular = 'Conversa em grupo, só você'
    const { getByRole } = list([alone])
    const row = getByRole('button', { name: new RegExp(copy.group.alone) })
    expect(row.querySelector('[data-group-block]')?.getAttribute('aria-label')).toBe(singular)
    cleanup()
    const { container } = workspace(alone)
    expect(container.querySelector('.channel-header [data-group-block]')?.getAttribute('aria-label')).toBe(singular)
  })

  it('a DM with an empty name reads "Só você" too, with no block', () => {
    const { getByRole } = list([{ ...dm, name: '' }])
    const row = getByRole('button', { name: new RegExp(copy.group.alone) })
    expect(row.querySelector('.channel__name')?.textContent).toBe(copy.group.alone)
    expect(row.querySelector('[data-group-block]')).toBeNull()
  })
})

describe('label (ChannelLabel, bareName)', () => {
  it('a group has no mark: the name as it comes; empty is "Só você"', () => {
    expect(bareName(group())).toBe('Ana Lima, Bruno Reis')
    expect(bareName(alone)).toBe(copy.group.alone)
    expect(bareName({ ...dm, name: '' })).toBe(copy.group.alone)
    const { container } = render(<ChannelLabel channel={group()} />)
    expect(container.innerHTML).toBe('Ana Lima, Bruno Reis')
  })
})

describe('header (workspace.md §22.1 items 4, 5 and 7)', () => {
  const header = (c: HTMLElement) => c.querySelector('.channel-header') as HTMLElement

  it('only people: the block before the name, "3 pessoas" in the topic place, no presence, no topic', () => {
    const { container } = workspace(group({ topic: 'não aparece' }))
    const h = header(container)
    const block = within(h).getByRole('img', { name: blockName(3) })
    expect(block.querySelector('.group-block')?.getAttribute('data-size')).toBe('header')
    expect(block.compareDocumentPosition(within(header(container)).getByRole('heading', { level: 2 })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(header(container)).getByRole('heading', { level: 2 }).textContent).toBe('Ana Lima, Bruno Reis')
    expect(h.querySelector('[data-group-count]')?.textContent).toBe(people(3))
    expect(h.textContent).not.toContain('não aparece')
    expect(h.querySelector('[data-presence], [data-group-agent]')).toBeNull()
    expect(findProtocolLeaksInText(h.innerHTML)).toEqual([])
  })

  it('with one agent: people without the agent, " · ", and "1 agente"; the block has the dot', () => {
    const { container } = workspace(withAgent)
    const h = header(container)
    expect(h.querySelector('[data-group-count]')?.textContent).toBe(`${people(2)} · ${agents(1)}`)
    expect(within(h).getByRole('img', { name: blockName(3) }).querySelector('[data-group-agent]')).not.toBeNull()
  })

  it('with two agents: "2 agentes"', () => {
    const two = group({
      name: 'Ana Lima, Robô A, Robô B',
      participants: [uid('@ana:tayet.local'), uid('@agent-a:tayet.local'), uid('@agent-b:tayet.local')],
      participantAgents: 2,
    })
    const { container } = workspace(two)
    expect(header(container).querySelector('[data-group-count]')?.textContent).toBe(`${people(2)} · ${agents(2)}`)
  })

  it('singular: the reader and one agent → "1 pessoa · 1 agente"', () => {
    const one = group({ name: 'Robô', participants: [uid('@agent-robo:tayet.local')], participantAgents: 1 })
    const { container } = workspace(one)
    expect(header(container).querySelector('[data-group-count]')?.textContent).toBe(`${people(1)} · ${agents(1)}`)
  })

  it('alone: "Só você", quiet, no count line; the block shows 1', () => {
    const { container } = workspace(alone)
    const heading = within(header(container)).getByRole('heading', { level: 2 })
    expect(heading.textContent).toBe(copy.group.alone)
    expect(heading.classList.contains('channel-header__name--alone')).toBe(true)
    expect(header(container).querySelector('[data-group-count]')).toBeNull()
    expect(within(header(container)).getByRole('img', { name: blockName(1) }).textContent).toBe('1')
  })

  it('the management button: "Detalhes da conversa" in a group (PR-5), the channel\'s in a channel', () => {
    const { container } = workspace(group())
    const manage = header(container).querySelector('.channel-header__manage')
    expect(manage?.getAttribute('aria-label')).toBe(copy.group.details)
    expect(manage?.getAttribute('title')).toBe(copy.group.details)
    cleanup()
    const ch = workspace(general)
    expect(header(ch.container).querySelector('.channel-header__manage')).not.toBeNull()
    expect(header(ch.container).querySelector('[data-group-block], [data-group-count]')).toBeNull()
  })
})

describe('exclusions (ADR-094 dec. 13) and search', () => {
  it('InvitePersonDialog does not offer a group', () => {
    const ui = render(<InvitePersonDialog channels={[general, group()]} onInvite={async () => ({ user: { id: uid('@x:tayet.local'), displayName: 'X', kind: 'member' }, failedChannels: [] })} onClose={() => {}} />)
    expect(ui.getByRole('button', { name: '#general' })).toBeTruthy()
    expect(ui.container.textContent).not.toContain('Ana Lima')
  })

  it('a search hit in a group shows the group name, with no mark', () => {
    const message: Message = {
      id: mid('$g:tayet.local'),
      channelId: group().id,
      author: uid('@ana:tayet.local'),
      body: { kind: 'text', text: 'Subi o protótipo.' },
      sentAt: Date.now() as never,
      reactions: [],
      mine: false,
      mentionsMe: false,
    }
    const hit: ResolvedHit = {
      hit: { message, channel: group().id, excerpt: { before: 'Subi o ', match: 'protótipo', after: '.' } },
      author: 'Ana Lima',
    }
    const { container } = render(
      <SearchResults hits={[hit]} searched="protótipo" preparing={false} channels={[group()]} onPick={() => {}} onClear={() => {}} />,
    )
    const where = container.querySelector('.search-hit__where')
    expect(where?.textContent).toContain('Ana Lima, Bruno Reis')
    expect(where?.querySelector('.channel-label__mark, .channel-label__lock, [data-group-block]')).toBeNull()
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })
})

// PLANO-CONVERSAS §0.3.5 item 4 (PR-4): a conversation with an empty name takes the composer's generic
// placeholder, never "Mensagem para Só você".
describe('composer placeholder of an empty-named conversation', () => {
  const hint = (c: HTMLElement) => c.querySelector('.composer [data-placeholder]')?.getAttribute('data-placeholder')

  it('a group alone and a DM without its person: the generic placeholder', () => {
    expect(hint(workspace(alone).container)).toBe(copy.composer.placeholder)
    cleanup()
    expect(hint(workspace({ ...dm, name: '' }).container)).toBe(copy.composer.placeholder)
  })

  it('a group with people: the people', () => {
    expect(hint(workspace(group()).container)).toBe(fill(copy.composer.placeholderFor, { name: 'Ana Lima, Bruno Reis' }))
  })
})
