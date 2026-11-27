// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { useState } from 'react'
import { render, cleanup, fireEvent, waitFor, within } from '@testing-library/react'
import { Workspace } from '../../src/ui/components/Workspace'
import { GroupDetailsPanel } from '../../src/ui/components/GroupDetailsPanel'
import type { Channel, ChannelId, Presence, RosterEntry, User, UserId } from '../../src/acl'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { copy, fill } from '../support/copy'

// ADR-094 dec. 9 and 13; manifest channel-management.md §10: the group conversation's details panel.
// Its own component on the management panel's casca and confirm: the participants read-only (the reader
// first, then `participants` order; "· você"; presence; the agent with its operator), convert (only for
// a reader whose role is known and admin, with the channel name field) and leave. The ids are
// protocol-shaped on purpose — the render-scan at the end is the proof that none reaches the DOM.

const cid = (s: string): ChannelId => s as unknown as ChannelId
const uid = (s: string): UserId => s as unknown as UserId

const marina: User = { id: uid('@marina:tayet.local'), displayName: 'Marina Alves', kind: 'member' }
const bruna: User = { id: uid('@bruna:tayet.local'), displayName: 'Bruna Lima', kind: 'member' }
const rafael: User = { id: uid('@rafael:tayet.local'), displayName: 'Rafael Souza', kind: 'member' }
const robo: User = {
  id: uid('@a-abcdefghijkl:tayet.local'),
  displayName: 'Relatório diário',
  kind: 'agent',
  agentColor: 'argila',
  operatorName: 'Marina Alves',
}

const group: Channel = {
  id: cid('!grupo:tayet.local'),
  name: 'Bruna Lima, Rafael Souza',
  kind: 'group',
  memberCount: 3,
  unread: { count: 0, mentions: 0 },
  participants: [bruna.id, rafael.id],
  participantAgents: 0,
}
const withAgent: Channel = { ...group, participants: [bruna.id, rafael.id, robo.id], participantAgents: 1 }
const general: Channel = {
  id: cid('!general:tayet.local'),
  name: '#general',
  kind: 'public',
  memberCount: 5,
  unread: { count: 0, mentions: 0 },
}

const entry = (user: User, role: RosterEntry['role'], self = false): RosterEntry => ({ user, role, state: 'active', self })
// The roster comes in its own order (the ACL's); the panel sorts it.
const roster = (selfRole: RosterEntry['role'] = 'admin'): RosterEntry[] => [
  entry(rafael, 'admin'),
  entry(marina, selfRole, true),
  entry(bruna, 'admin'),
]

const online = (who: UserId[]) => (u: UserId): Presence => (who.includes(u) ? 'online' : 'offline')

afterEach(cleanup)

function panel(over: Partial<Parameters<typeof GroupDetailsPanel>[0]> = {}) {
  const props = {
    channel: group,
    members: roster(),
    onConvertToChannel: vi.fn(async () => {}),
    onLeaveChannel: vi.fn(async () => {}),
    onClose: vi.fn(),
    ...over,
  }
  return { props, ui: render(<GroupDetailsPanel {...props} />) }
}

const rowNames = (container: HTMLElement): string[] =>
  Array.from(container.querySelectorAll('.channel-management-panel__member-name')).map((n) => n.textContent ?? '')

describe('the management button in a group (workspace.md §22.1 item 4)', () => {
  // Workspace with the managing state lifted, so the header button opens the real panel.
  function Harness({ current }: { current: Channel }) {
    const [managing, setManaging] = useState<Channel | undefined>(undefined)
    const verb = () => Promise.resolve()
    return (
      <Workspace
        channels={[current]}
        selectedChannelId={current.id}
        messages={[]}
        usersById={{}}
        connection="connected"
        onSelectChannel={() => {}}
        onSend={() => {}}
        managing={managing}
        members={roster()}
        channelAbilities={{ rename: true, editTopic: true, addPeople: true, removePeople: true, setRoles: true, archive: true }}
        onManageChannel={setManaging}
        onCloseManage={() => setManaging(undefined)}
        onUpdateChannel={verb}
        onArchiveChannel={verb}
        onLeaveChannel={verb}
        onConvertToChannel={verb}
        onAddMember={verb}
        onRemoveMember={verb}
        onSetRole={verb}
        loadCandidates={() => Promise.resolve([])}
      />
    )
  }

  it('a group: "Detalhes da conversa" names the button and opens the group panel', () => {
    const { getByRole, queryByLabelText } = render(<Harness current={group} />)
    fireEvent.click(getByRole('button', { name: copy.group.details }))
    const dialog = getByRole('dialog', { name: copy.group.details })
    expect(within(dialog).getByRole('heading', { name: copy.group.details })).toBeTruthy()
    expect(within(dialog).getByRole('region', { name: copy.group.participants })).toBeTruthy()
    // Not the channel's panel: no name or topic field, no archive.
    expect(queryByLabelText(copy.channel.name)).toBeNull()
    expect(queryByLabelText(copy.channel.topic)).toBeNull()
    expect(within(dialog).queryByRole('button', { name: copy.channel.archiveTitle })).toBeNull()
  })

  it('a channel still opens the channel panel', () => {
    const { getByRole } = render(<Harness current={general} />)
    fireEvent.click(getByRole('button', { name: fill(copy.channel.manageNamed, { name: '#general' }) }))
    const dialog = getByRole('dialog', { name: fill(copy.channel.manageNamed, { name: '#general' }) })
    expect(within(dialog).getByLabelText(copy.channel.name)).toBeTruthy()
    expect(within(dialog).queryByRole('region', { name: copy.group.participants })).toBeNull()
  })
})

describe('participants (§10.1 items 1 and 2)', () => {
  it('counts the reader, lists the reader first then participants order, marks "· você"', () => {
    const { ui } = panel()
    expect(ui.getByRole('heading', { name: `${copy.group.participants} · 3` })).toBeTruthy()
    expect(rowNames(ui.container)).toEqual([`Marina Alves ${copy.channel.you}`, 'Bruna Lima', 'Rafael Souza'])
  })

  it('the picker\'s presence dot on whoever is online, none on the others', () => {
    const { ui } = panel({ presenceOf: online([rafael.id]) })
    const rows = ui.container.querySelectorAll('.channel-management-panel__member')
    expect(rows[2]!.querySelector('[data-presence="online"]')).not.toBeNull()
    expect(rows[0]!.querySelector('[data-presence="online"]')).toBeNull()
    expect(rows[1]!.querySelector('[data-presence="online"]')).toBeNull()
  })

  it('an agent: the agent avatar, its operator on a second line (§13.1 item 4), no presence', () => {
    const { ui } = panel({
      channel: withAgent,
      members: [...roster(), entry(robo, 'member')],
      presenceOf: online([robo.id]),
    })
    expect(ui.getByRole('heading', { name: `${copy.group.participants} · 4` })).toBeTruthy()
    const row = ui.container.querySelectorAll('.channel-management-panel__member')[3]!
    expect(row.querySelector('[data-agent-avatar]')).not.toBeNull()
    expect(row.querySelector('[data-presence]')).toBeNull()
    const operator = row.querySelector('[data-agent-operator]')!
    expect(operator.textContent).toBe(fill(copy.agent.operatedBy, { name: 'Marina Alves' }))
    expect(operator.classList.contains('channel-management-panel__member-sub')).toBe(true)
  })

  it('no role, no remove, no add', () => {
    const { ui } = panel()
    expect(ui.queryByRole('combobox')).toBeNull()
    expect(ui.container.querySelector('.channel-management-panel__member-role')).toBeNull()
    expect(ui.queryByRole('button', { name: fill(copy.channel.removeNamed, { name: 'Bruna Lima' }) })).toBeNull()
    expect(ui.queryByRole('button', { name: copy.channel.addMember })).toBeNull()
    expect(ui.container.textContent).not.toContain(copy.channel.roleAdmin)
  })
})

describe('convert is offered only to an admin reader (§10.1 item 3)', () => {
  it('absent while the reader\'s role is not known; leave takes the width', () => {
    const { ui } = panel({ members: [] })
    expect(ui.queryByRole('button', { name: copy.group.convert })).toBeNull()
    expect(ui.container.querySelectorAll('.channel-management-panel__footer .ui-button')).toHaveLength(1)
    expect(ui.getByRole('button', { name: copy.group.leave })).toBeTruthy()
  })

  it('absent for a reader who is not admin', () => {
    const { ui } = panel({ members: roster('member') })
    expect(ui.queryByRole('button', { name: copy.group.convert })).toBeNull()
  })

  it('present for an admin reader, neutral beside the danger leave', () => {
    const { ui } = panel()
    const convert = ui.getByRole('button', { name: copy.group.convert })
    const leave = ui.getByRole('button', { name: copy.group.leave })
    expect(convert.getAttribute('data-variant')).toBe('secondary')
    expect(leave.getAttribute('data-variant')).toBe('danger')
    expect(convert.compareDocumentPosition(leave) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe('convert (§10.1 item 4)', () => {
  const open = (over: Partial<Parameters<typeof GroupDetailsPanel>[0]> = {}) => {
    const r = panel(over)
    fireEvent.click(r.ui.getByRole('button', { name: copy.group.convert }))
    return r
  }

  it('the confirm: title, body, the name field, the primary action disabled without a name', () => {
    const { ui } = open()
    const dialog = ui.getByRole('dialog', { name: copy.group.convert })
    expect(dialog.getAttribute('data-size')).toBe('gestao')
    expect(within(dialog).getByText(copy.group.convertBody)).toBeTruthy()
    const field = ui.getByLabelText(copy.group.convertName) as HTMLInputElement
    expect(document.activeElement).toBe(field)
    const action = within(dialog).getByRole('button', { name: copy.group.convert }) as HTMLButtonElement
    expect(action.getAttribute('data-variant')).toBe('fill')
    expect(action.disabled).toBe(true)
    fireEvent.change(field, { target: { value: '   ' } })
    expect(action.disabled).toBe(true)
    fireEvent.change(field, { target: { value: 'lançamento' } })
    expect(action.disabled).toBe(false)
  })

  it('calls the verb with the trimmed name, pending, then closes on success', async () => {
    let resolve!: () => void
    const onConvertToChannel = vi.fn(() => new Promise<void>((r) => (resolve = r)))
    const { ui, props } = open({ onConvertToChannel })
    fireEvent.change(ui.getByLabelText(copy.group.convertName), { target: { value: '  lançamento-q3 ' } })
    fireEvent.click(ui.getByRole('button', { name: copy.group.convert }))
    expect(onConvertToChannel).toHaveBeenCalledWith(group.id, 'lançamento-q3')
    const busy = ui.getByRole('button', { name: copy.channel.working }) as HTMLButtonElement
    expect(busy.disabled).toBe(true)
    expect((ui.getByRole('button', { name: copy.channel.cancel }) as HTMLButtonElement).disabled).toBe(true)
    resolve()
    await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1))
  })

  it('Enter in the field confirms', async () => {
    const { ui, props } = open()
    const field = ui.getByLabelText(copy.group.convertName)
    fireEvent.change(field, { target: { value: 'produto' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    await waitFor(() => expect(props.onConvertToChannel).toHaveBeenCalledWith(group.id, 'produto'))
  })

  it('an error keeps the confirm open with the inline error and the name', async () => {
    const onConvertToChannel = vi.fn(async () => {
      throw new Error('denied')
    })
    const { ui, props } = open({ onConvertToChannel })
    fireEvent.change(ui.getByLabelText(copy.group.convertName), { target: { value: 'produto' } })
    fireEvent.click(ui.getByRole('button', { name: copy.group.convert }))
    expect((await ui.findByRole('alert')).textContent).toBe(copy.channel.failed)
    expect(ui.getByRole('dialog', { name: copy.group.convert })).toBeTruthy()
    expect((ui.getByLabelText(copy.group.convertName) as HTMLInputElement).value).toBe('produto')
    expect((ui.getByRole('button', { name: copy.group.convert }) as HTMLButtonElement).disabled).toBe(false)
    expect(props.onClose).not.toHaveBeenCalled()
  })
})

describe('leave (§10.1 item 5)', () => {
  it('the danger confirm with group.leaveBody, calls leaveChannel, closes on success', async () => {
    const { ui, props } = panel()
    fireEvent.click(ui.getByRole('button', { name: copy.group.leave }))
    const dialog = ui.getByRole('dialog', { name: copy.group.leave })
    expect(within(dialog).getByText(copy.group.leaveBody)).toBeTruthy()
    expect(dialog.querySelector('.manage-dialog__dot')?.getAttribute('data-tone')).toBe('danger')
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: copy.channel.cancel }))
    const action = within(dialog).getByRole('button', { name: copy.channel.leave })
    expect(action.getAttribute('data-variant')).toBe('danger-fill')
    fireEvent.click(action)
    await waitFor(() => expect(props.onLeaveChannel).toHaveBeenCalledWith(group.id))
    await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1))
  })

  it('a failed leave keeps the confirm open', async () => {
    const onLeaveChannel = vi.fn(async () => {
      throw new Error('denied')
    })
    const { ui, props } = panel({ onLeaveChannel })
    fireEvent.click(ui.getByRole('button', { name: copy.group.leave }))
    fireEvent.click(ui.getByRole('button', { name: copy.channel.leave }))
    await ui.findByRole('alert')
    expect(ui.getByRole('dialog', { name: copy.group.leave })).toBeTruthy()
    expect(props.onClose).not.toHaveBeenCalled()
  })
})

describe('Esc', () => {
  it('in the confirm returns to the panel; in the panel closes it', () => {
    const { ui, props } = panel()
    fireEvent.click(ui.getByRole('button', { name: copy.group.convert }))
    fireEvent.keyDown(ui.getByRole('dialog', { name: copy.group.convert }), { key: 'Escape' })
    const main = ui.getByRole('dialog', { name: copy.group.details })
    expect(props.onClose).not.toHaveBeenCalled()
    fireEvent.click(ui.getByRole('button', { name: copy.group.leave }))
    fireEvent.keyDown(ui.getByRole('dialog', { name: copy.group.leave }), { key: 'Escape' })
    fireEvent.keyDown(ui.getByRole('dialog', { name: copy.group.details }), { key: 'Escape' })
    expect(props.onClose).toHaveBeenCalledTimes(1)
    expect(main).toBeTruthy()
  })
})

describe('DOM render-scan (P1) — the group details panel', () => {
  it('panel, convert and leave carry no protocol vocabulary nor id', () => {
    const { ui } = panel({ channel: withAgent, members: [...roster(), entry(robo, 'member')], presenceOf: online([rafael.id]) })
    expect(ui.container.textContent).toContain('Bruna Lima')
    expect(findProtocolLeaksInText(ui.container.innerHTML)).toEqual([])
    fireEvent.click(ui.getByRole('button', { name: copy.group.convert }))
    fireEvent.change(ui.getByLabelText(copy.group.convertName), { target: { value: 'produto' } })
    expect(findProtocolLeaksInText(ui.container.innerHTML)).toEqual([])
    fireEvent.click(ui.getByRole('button', { name: copy.channel.cancel }))
    fireEvent.click(ui.getByRole('button', { name: copy.group.leave }))
    expect(findProtocolLeaksInText(ui.container.innerHTML)).toEqual([])
  })
})
