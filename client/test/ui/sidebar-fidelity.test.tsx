// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, fireEvent, within } from '@testing-library/react'
import { Workspace } from '../../src/ui/components/Workspace'
import { ChannelList } from '../../src/ui/components/ChannelList'
import { MediaProvider } from '../../src/ui/MediaContext'
import type { Channel, ChannelId, ConnectionState } from '../../src/acl'
import { copy, fill } from '../support/copy'
import { noExport } from '../support/data-export-fake'
import { idleLanguage } from '../support/language-fake'

// Manifest workspace.md §13 on screen: the brand block, the connection line only off `connected`, the
// unread dot and mention pill, the row's cut and the self footer as one button.

const cid = (s: string): ChannelId => s as unknown as ChannelId

const pub: Channel = {
  id: cid('!design:tayet.local'),
  name: '#design',
  kind: 'public',
  topic: 'Tudo sobre o design',
  memberCount: 3,
  unread: { count: 0, mentions: 0 },
}
const priv: Channel = { ...pub, id: cid('!board:tayet.local'), name: '#board', kind: 'private' }
const dm: Channel = {
  id: cid('!dmcarol:tayet.local'),
  name: 'Carol Dias',
  kind: 'dm',
  memberCount: 2,
  unread: { count: 0, mentions: 0 },
}

const shell = (connection: ConnectionState, extra: Partial<Parameters<typeof Workspace>[0]> = {}) =>
  render(
    <MediaProvider resolve={async () => ({ url: '', release: () => {} })}>
      <Workspace
        channels={[pub, dm]}
        selectedChannelId={pub.id}
        messages={[]}
        usersById={{}}
        connection={connection}
        onSelectChannel={() => {}}
        onSend={() => {}}
        onManageChannel={() => {}}
        {...extra}
      />
    </MediaProvider>,
  )

const list = (channels: Channel[]) =>
  render(
    <MediaProvider resolve={async () => ({ url: '', release: () => {} })}>
      <ChannelList channels={channels} onSelect={() => {}} />
    </MediaProvider>,
  )

afterEach(cleanup)

const css = readFileSync(resolve(__dirname, '../../src/ui/styles.css'), 'utf8')
// The stylesheet is the spec's carrier here: jsdom does not lay out, so the cut is pinned on the rule.
const rule = (selector: string): string => {
  const i = css.lastIndexOf(`\n${selector} {`)
  expect(i).toBeGreaterThanOrEqual(0)
  return css.slice(i, css.indexOf('}', i))
}

describe('brand block (workspace.md §13 items 1–2)', () => {
  it('is the tile and the h1, with no action and no chevron', () => {
    const { container, getByRole } = shell('connected')
    const brand = container.querySelector('.sidebar__brand') as HTMLElement
    expect(getByRole('heading', { level: 1 }).textContent).toBe('Tayet')
    expect(brand.querySelector('.sidebar__brand-tile')?.textContent).toBe('T')
    expect(brand.querySelector('.sidebar__brand-tile')?.getAttribute('aria-hidden')).toBe('true')
    expect(brand.tagName).not.toBe('BUTTON')
    expect(within(brand).queryByRole('button')).toBeNull()
    expect(brand.querySelector('svg')).toBeNull()
  })

  it('says nothing about the connection at rest', () => {
    const { container } = shell('connected')
    expect(container.querySelector('.connection')).toBeNull()
    // The orphan `shell.connected` left the catalog (§8.18 item 6): no "connected" copy exists.
    expect((copy.shell as Record<string, string>).connected).toBeUndefined()
    expect(container.querySelector('.sidebar__brand [role="status"]')).toBeNull()
  })

  it.each([
    ['connecting', copy.shell.connecting],
    ['reconnecting', copy.shell.reconnecting],
    ['offline', copy.shell.offline],
  ] as const)('shows %s under the name, in the brand block', (state, label) => {
    const { container } = shell(state)
    const line = container.querySelector('.sidebar__brand .connection') as HTMLElement
    expect(line.textContent).toBe(label)
    expect(line.classList.contains('connection--offline')).toBe(state === 'offline')
    // workspace.md §14 item 6 / fork 6: the line is a live status.
    expect(line.getAttribute('role')).toBe('status')
    expect(within(container.querySelector('.sidebar__brand') as HTMLElement).getByRole('status').textContent).toBe(label)
  })
})

describe('unread on a row (workspace.md §13 item 5)', () => {
  const row = (unread: Channel['unread']) => {
    const { getAllByRole } = list([{ ...pub, unread }])
    return getAllByRole('button').find((b) => b.classList.contains('channel')) as HTMLElement
  }

  it('nothing at count 0', () => {
    const r = row({ count: 0, mentions: 0 })
    expect(r.querySelector('.channel__unread-dot')).toBeNull()
    expect(r.querySelector('.badge')).toBeNull()
  })

  it('a dot without a number when nothing mentions me', () => {
    const r = row({ count: 4, mentions: 0 })
    const dot = r.querySelector('.channel__unread-dot') as HTMLElement
    expect(dot.textContent).toBe('')
    expect(dot.getAttribute('aria-label')).toBe(fill(copy.list.unread.other, { n: 4 }))
    expect(r.querySelector('.badge')).toBeNull()
  })

  it('the pill carries the mentions, not the count, and replaces the dot', () => {
    const r = row({ count: 9, mentions: 1 })
    const pill = r.querySelector('.badge--mention') as HTMLElement
    expect(pill.textContent).toBe('1')
    expect(pill.getAttribute('aria-label')).toBe(fill(copy.list.mentions.one, { n: 1 }))
    expect(r.querySelector('.channel__unread-dot')).toBeNull()
  })

  it('the same on a DM row', () => {
    const { container } = list([{ ...dm, unread: { count: 2, mentions: 2 } }])
    const pill = container.querySelector('.channel--dm .badge--mention') as HTMLElement
    expect(pill.textContent).toBe('2')
    expect(pill.getAttribute('aria-label')).toBe(fill(copy.list.mentions.other, { n: 2 }))
  })

  it('7 is the sidebar dot, apart from the thread one (ADR-067)', () => {
    expect(rule('.channel__unread-dot')).toContain('width: 7px')
    expect(rule('.unread-dot')).toContain('width: var(--space-8)')
  })
})

describe('rows (workspace.md §13 item 4)', () => {
  it('a long name cuts in both sections', () => {
    const name = rule('.channel .channel__name')
    expect(name).toContain('text-overflow: ellipsis')
    expect(name).toContain('white-space: nowrap')
    expect(name).toContain('min-width: 0')
    const { container } = list([{ ...pub, name: `#${'longo'.repeat(30)}` }, dm])
    expect(container.querySelectorAll('.channel > .channel__name')).toHaveLength(2)
  })

  it('reads the name state: read muted, unread and selected in the text color', () => {
    expect(rule('.channel .channel__name')).toContain('color: var(--color-muted)')
    expect(css).toMatch(
      /\.channel:has\(\.badge, \.channel__unread-dot\) \.channel__name \{\n {2}font-weight: var\(--font-weight-medium\);\n {2}color: var\(--color-text\);/,
    )
    expect(rule('.channel--selected .channel__name')).toContain('color: var(--color-text)')
  })

  it('the mark column is the avatar: 28 + the row gap, so names align between sections', () => {
    const both = css.slice(css.indexOf('\n.channel .channel-label__mark,'))
    expect(both.slice(0, both.indexOf('}'))).toContain('margin-right: var(--space-8)')
    expect(rule('.channel .channel-label__lock')).toContain('width: 28px')
    // The '#' is 1ch of mono plus this padding, and stays inline: a box would read "# all".
    expect(rule('.channel .channel-label__mark')).toContain('padding: 0 calc((var(--density-cotidiano-avatar) - 1ch) / 2)')
    expect(rule('.channel .channel-label__mark')).not.toContain('display')
  })

  it('the list-only mark does not reach the other ChannelLabel consumers', () => {
    // Byte-identical to main: the header's markup and the base rule the header reads.
    const { container } = shell('connected', { channels: [pub, priv], selectedChannelId: pub.id })
    expect(container.querySelector('.channel-header__name')?.innerHTML).toContain(
      '<span class="channel-label"><span class="channel-label__mark">#</span>design</span>',
    )
    expect(css).toContain(
      '.channel-label__mark,\n.channel-label__lock {\n  margin-right: var(--space-4);\n}',
    )
    // The header's only own rule on the label is the private lock's muted colour (workspace.md §14
    // item 5, fork 6 of §8.18); the '#' mark and the row metrics never reach it.
    expect(css.match(/^\.channel-header[^{]*channel-label[^{]*/gm)).toEqual([
      '.channel-header__name .channel-label__lock ',
    ])
  })
})

describe('self footer (workspace.md §13 item 6)', () => {
  it('is one button, named as the account, that opens it', () => {
    const { getByRole, queryByRole } = shell('connected', {
      onReset: async () => {},
      onSignOut: async () => {},
      onLoadProfile: async () => ({}) as never,
      onSaveProfile: async () => {},
      onSaveAvatar: async () => {},
      onClearAvatar: async () => {},
      onExportData: noExport,
      language: idleLanguage,
    })
    const footer = getByRole('button', { name: copy.shell.account })
    expect(footer.classList.contains('sidebar__footer')).toBe(true)
    expect(footer.querySelectorAll('button')).toHaveLength(0)
    expect(footer.querySelector('.sidebar__footer-icon')?.getAttribute('aria-hidden')).toBe('true')
    expect(queryByRole('dialog')).toBeNull()
    fireEvent.click(footer)
    expect(getByRole('dialog', { name: copy.account.title })).toBeTruthy()
  })
})
