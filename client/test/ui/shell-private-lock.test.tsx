// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, within } from '@testing-library/react'
import { ChannelList } from '../../src/ui/components/ChannelList'
import { ThreadPanel } from '../../src/ui/components/ThreadPanel'
import { Workspace } from '../../src/ui/components/Workspace'
import { PRIVATE_MARK } from '../../src/ui/components/ChannelLabel'
import { MediaProvider } from '../../src/ui/MediaContext'
import type { Channel, ChannelId, Message, MessageId, User, UserId } from '../../src/acl'
import { copy } from '../support/copy'

// workspace.md §14 items 4–5, §6.7 (forks 6 and 8 of PLANO-DESIGN-MIGRACAO §8.18): the private lock is
// 13 in the list row, 14 in the header with the `shell.privateHint` tooltip, and the thread panel's
// subtitle carries the same tooltip.

const cid = (s: string): ChannelId => s as unknown as ChannelId
const uid = (s: string): UserId => s as unknown as UserId
const mid = (s: string): MessageId => s as unknown as MessageId

const priv: Channel = {
  id: cid('!board:tayet.local'),
  name: '#board',
  kind: 'private',
  memberCount: 2,
  unread: { count: 0, mentions: 0 },
}

const lockSvg = (scope: HTMLElement) =>
  within(scope).getByRole('img', { name: PRIVATE_MARK }).querySelector('svg') as SVGElement

afterEach(cleanup)

describe('private lock on the shell (workspace.md §14 items 4–5)', () => {
  it('list row: lock 13, no tooltip', () => {
    const { getByRole } = render(
      <MediaProvider resolve={async () => ({ url: '', release: () => {} })}>
        <ChannelList channels={[priv]} onSelect={() => {}} />
      </MediaProvider>,
    )
    const row = getByRole('button', { name: /board/ })
    expect(lockSvg(row).getAttribute('width')).toBe('13')
    expect(within(row).getByRole('img', { name: PRIVATE_MARK }).getAttribute('title')).toBeNull()
  })

  it('header: lock 14 with the privateHint tooltip', () => {
    const { getByRole } = render(
      <Workspace
        channels={[priv]}
        selectedChannelId={priv.id}
        messages={[]}
        usersById={{}}
        connection="connected"
        onSelectChannel={() => {}}
        onSend={() => {}}
      />,
    )
    const heading = getByRole('heading', { level: 2, name: /board/ })
    expect(lockSvg(heading).getAttribute('width')).toBe('14')
    expect(within(heading).getByRole('img', { name: PRIVATE_MARK }).getAttribute('title')).toBe(
      copy.shell.privateHint,
    )
  })

  it('thread subtitle: the same privateHint tooltip (fork 8)', () => {
    const alice: User = { id: uid('@alice:tayet.local'), displayName: 'Alice Anderson', kind: 'member' }
    const root: Message = {
      id: mid('$root:tayet.local'),
      channelId: priv.id,
      author: alice.id,
      body: { kind: 'text', text: 'Pauta' },
      sentAt: 1 as unknown as Message['sentAt'],
      reactions: [],
      mine: false,
      mentionsMe: false,
    }
    const { getByRole } = render(
      <ThreadPanel
        root={root}
        messages={[]}
        usersById={{ [alice.id]: alice }}
        channel={priv}
        onClose={() => {}}
        onSend={() => {}}
        onOpenProfile={() => {}}
      />,
    )
    const panel = getByRole('complementary', { name: copy.thread.title })
    expect(within(panel).getByRole('img', { name: PRIVATE_MARK }).getAttribute('title')).toBe(
      copy.shell.privateHint,
    )
  })
})
