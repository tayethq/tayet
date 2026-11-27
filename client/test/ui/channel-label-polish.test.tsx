// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, within, fireEvent, waitFor } from '@testing-library/react'
import { ChannelLabel, PRIVATE_MARK } from '../../src/ui/components/ChannelLabel'
import { ChannelManagementPanel } from '../../src/ui/components/ChannelManagementPanel'
import { UserProfileDialog } from '../../src/ui/components/UserProfileDialog'
import { Workspace } from '../../src/ui/components/Workspace'
import { MediaProvider } from '../../src/ui/MediaContext'
import type { Channel, ChannelId, ChannelPatch, UserId, UserProfile } from '../../src/acl'
import { copy, fill } from '../support/copy'

// PLANO-RELEASE-PUBLICA §8.66: the kind mark is its own span ('#' or the lock) set off from the name
// by a margin; the accessible names keep their shape ('#board', 'Canal privado board'); the management
// entry point names a private channel the way its label reads; the profile chip shows the lock; the
// rename field is seeded without the mark and does not send an untouched name.

const cid = (s: string): ChannelId => s as unknown as ChannelId
const uid = (s: string): UserId => s as unknown as UserId

const pub: Channel = {
  id: cid('!board-pub:tayet.local'),
  name: '#engineering',
  kind: 'public',
  topic: 'Builds',
  memberCount: 3,
  unread: { count: 0, mentions: 0 },
}
const priv: Channel = {
  id: cid('!board:tayet.local'),
  name: '#board',
  kind: 'private',
  topic: 'Diretoria',
  memberCount: 2,
  unread: { count: 0, mentions: 0 },
}
const dm: Channel = {
  id: cid('!dmcarol:tayet.local'),
  name: 'Carol Dias',
  kind: 'dm',
  memberCount: 2,
  unread: { count: 0, mentions: 0 },
}

afterEach(cleanup)

describe('ChannelLabel — the mark as its own span (§8.66)', () => {
  it('public: textContent and accessible name are "#engineering" exactly; the # is a span', () => {
    const { getByRole } = render(
      <h2>
        <ChannelLabel channel={pub} />
      </h2>,
    )
    const heading = getByRole('heading', { name: '#engineering' })
    expect(heading.textContent).toBe('#engineering')
    const mark = heading.querySelector('.channel-label__mark')
    expect(mark?.textContent).toBe('#')
    expect(within(heading).queryByRole('img')).toBeNull()
  })

  it('private: accessible name "Canal privado board"; the lock in place of the #; textContent " board"', () => {
    const { getByRole } = render(
      <h2>
        <ChannelLabel channel={priv} />
      </h2>,
    )
    const heading = getByRole('heading', { name: 'Canal privado board' })
    expect(within(heading).getByRole('img', { name: PRIVATE_MARK })).toBeTruthy()
    expect(heading.textContent).toBe(' board')
    expect(heading.querySelector('.channel-label__mark')).toBeNull()
  })

  it('DM: no mark at all', () => {
    const { getByRole } = render(
      <h2>
        <ChannelLabel channel={dm} />
      </h2>,
    )
    const heading = getByRole('heading', { name: 'Carol Dias' })
    expect(heading.textContent).toBe('Carol Dias')
    expect(heading.querySelector('.channel-label, .channel-label__mark, [role="img"]')).toBeNull()
  })
})

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
      onManageChannel={() => {}}
    />,
  )
}

function renderPanel(channel: Channel, onUpdateChannel: (id: ChannelId, patch: ChannelPatch) => Promise<void>) {
  return render(
    <MediaProvider resolve={async () => ({ url: '', release: () => {} })}>
      <ChannelManagementPanel
        abilities={{ rename: true, editTopic: true, addPeople: true, removePeople: true, setRoles: true, archive: true }}
        channel={channel}
        // The reader, admin, with every answer (ADR-115: the fields are editable behind rename and editTopic).
        members={[{ user: { id: 'me' as unknown as UserId, displayName: 'Eu', kind: 'member' }, role: 'admin', state: 'active', self: true }]}
        onUpdateChannel={onUpdateChannel}
        onArchiveChannel={async () => {}}
        onLeaveChannel={async () => {}}
        onSetRole={async () => {}}
        onRemoveMember={async () => {}}
        onAddMember={async () => {}}
        loadCandidates={async () => []}
        onClose={() => {}}
      />
    </MediaProvider>,
  )
}

describe('management entry point — accessible name (§8.66 item 2)', () => {
  it('header button: "Gerenciar #engineering" for a public channel, "Gerenciar Canal privado board" for a private one', () => {
    renderWorkspace(pub).getByRole('button', { name: fill(copy.channel.manageNamed, { name: '#engineering' }) })
    cleanup()
    const view = renderWorkspace(priv)
    expect(view.getByRole('button', { name: fill(copy.channel.managePrivate, { mark: copy.channel.privateMark, name: 'board' }) })).toBeTruthy()
    expect(view.queryByRole('button', { name: fill(copy.channel.manageNamed, { name: '#board' }) })).toBeNull()
  })

  it('dialog: the same name as the button that opens it', () => {
    renderPanel(pub, async () => {}).getByRole('dialog', { name: fill(copy.channel.manageNamed, { name: '#engineering' }) })
    cleanup()
    expect(renderPanel(priv, async () => {}).getByRole('dialog', { name: fill(copy.channel.managePrivate, { mark: copy.channel.privateMark, name: 'board' }) })).toBeTruthy()
  })
})

describe('rename field (§8.66 item 4)', () => {
  it('is seeded without the kind mark, public and private', () => {
    expect((renderPanel(pub, async () => {}).getByLabelText(copy.channel.name) as HTMLInputElement).value).toBe('engineering')
    cleanup()
    expect((renderPanel(priv, async () => {}).getByLabelText(copy.channel.name) as HTMLInputElement).value).toBe('board')
  })

  it('marks the name field like the header: lock on private, never a #', () => {
    expect(within(renderPanel(priv, async () => {}).getByRole('dialog')).getAllByRole('img', { name: copy.channel.privateMark })).toHaveLength(2)
    cleanup()
    const dialog = renderPanel(pub, async () => {}).getByRole('dialog')
    expect(dialog.querySelector('.channel-management-panel__input-mark')?.textContent).toBe('#')
  })

  it('opening and saving only the topic sends no name in the patch', async () => {
    const update = vi.fn(async () => {})
    const { getByLabelText, findByText } = renderPanel(priv, update)
    fireEvent.change(getByLabelText(copy.channel.topic), { target: { value: 'Nova pauta' } })
    fireEvent.blur(getByLabelText(copy.channel.topic))
    await findByText(copy.channel.saved)
    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith(priv.id, { topic: 'Nova pauta' })
  })

  it('saves the name as typed: "board2" stays "board2", "#board2" stays "#board2"', async () => {
    const update = vi.fn(async () => {})
    const view = renderPanel(priv, update)
    fireEvent.change(view.getByLabelText(copy.channel.name), { target: { value: 'board2' } })
    fireEvent.keyDown(view.getByLabelText(copy.channel.name), { key: 'Enter' })
    await waitFor(() => expect(update).toHaveBeenLastCalledWith(priv.id, { name: 'board2' }))
    cleanup()

    const view2 = renderPanel(priv, update)
    fireEvent.change(view2.getByLabelText(copy.channel.name), { target: { value: '#board2' } })
    fireEvent.blur(view2.getByLabelText(copy.channel.name))
    await waitFor(() => expect(update).toHaveBeenLastCalledWith(priv.id, { name: '#board2' }))
  })
})

describe('profile chip (§8.66 item 3, manifest view-profile §4 item 6)', () => {
  it('public keeps the # span; private shows the lock, muted, named like the label', async () => {
    const bob: UserProfile = { id: uid('@bob:tayet.local'), displayName: 'Bob Brown', kind: 'member' }
    const { container } = render(
      <UserProfileDialog
        userId={bob.id}
        onLoadUserProfile={async () => bob}
        onLoadCommonChannels={async () => [pub, priv]}
        onSelectChannel={() => {}}
        onClose={() => {}}
      />,
    )
    const section = await waitFor(() => {
      const el = container.querySelector('[aria-label="Canais em comum"]')
      if (!el) throw new Error('sem seção ainda')
      return el as HTMLElement
    })
    const pubChip = within(section).getByRole('button', { name: '#engineering' })
    expect(pubChip.querySelector('.user-profile__chip-hash')?.textContent).toBe('#')
    expect(within(pubChip).queryByRole('img')).toBeNull()

    const privChip = within(section).getByRole('button', { name: 'Canal privado board' })
    expect(within(privChip).getByRole('img', { name: PRIVATE_MARK }).classList).toContain('user-profile__chip-lock')
    expect(privChip.querySelector('.user-profile__chip-hash')).toBeNull()
    expect(privChip.textContent).not.toContain('#')
  })
})
