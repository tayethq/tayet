// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, waitFor, within, act, screen } from '@testing-library/react'
import { App } from '../../src/ui/App'
import type {
  Acl,
  Channel,
  DomainEvent,
  ChannelId,
  UserId,
  MessageId,
  Role,
  MemberState,
  User,
  ChannelAbilities,
} from '../../src/acl'
import { RateLimitedError } from '../../src/acl'
import { ALL_ABILITIES, NO_ABILITIES } from '../support/narrow-shell'
import { channelLabel } from '../support/channel-label'
import { copy, fill } from '../support/copy'

// Track U/U1+U2 (ADR-029): channel management is await-and-close. We drive useChat (via App) with a
// fake ACL whose management verbs we control, and assert the wiring:
//  • U1 — open/DM-gating, edit (stays open), archive/leave (close, stream reconciles).
//  • U2 — the roster (displayName + role), the seam A1 (managing ≠ selectedId reconciles the MANAGED
//    channel), inline role change + rejection, remove-member confirm + rejection, the add-member
//    picker (candidate union minus roster + add wiring + rejection), and guest read-only.
// No Synapse here — the verbs against the real server (incl. the PL rejection guardrail) are gated in
// the integration suite (acl-membership: setRole(...).rejects.toThrow()).

const cid = (s: string): ChannelId => s as unknown as ChannelId
const uid = (s: string): UserId => s as unknown as UserId
const mid = (s: string): MessageId => s as unknown as MessageId

const eng: Channel = {
  id: cid('!engineering:tayet.local'),
  name: '#engineering',
  kind: 'public',
  topic: 'Builds and releases',
  memberCount: 3,
  unread: { count: 0, mentions: 0 },
}
const design: Channel = {
  id: cid('!design:tayet.local'),
  name: '#design',
  kind: 'public',
  topic: 'Pixels',
  memberCount: 2,
  unread: { count: 0, mentions: 0 },
}
const dm: Channel = {
  id: cid('!dm-ana:tayet.local'),
  name: 'Ana Lima',
  kind: 'dm',
  memberCount: 2,
  unread: { count: 0, mentions: 0 },
}

const ana: User = { id: uid('@ana:tayet.local'), displayName: 'Ana Lima', kind: 'member' }
const bruno: User = { id: uid('@bruno:tayet.local'), displayName: 'Bruno Sato', kind: 'member' }
const gisele: User = { id: uid('@gisele:tayet.local'), displayName: 'Gisele Rocha', kind: 'member' }
// The operator (sidebar footer identity, ADR-039) — distinct from any roster member so a footer
// name never collides with a member row in these queries.
const me: User = { id: uid('@me:tayet.local'), displayName: 'Eu Mesmo', kind: 'member' }

type Member = { user: User; role: Role; state: MemberState; self: boolean }

interface Handles {
  acl: Acl
  emitGlobal: (e: DomainEvent) => void
  emitChannel: (id: ChannelId, e: DomainEvent) => void
  setMembers: (id: ChannelId, list: Member[]) => void
  setAbilities: (next: ChannelAbilities) => void
  getChannelAbilities: ReturnType<typeof vi.fn>
  updateChannel: ReturnType<typeof vi.fn>
  archiveChannel: ReturnType<typeof vi.fn>
  leaveChannel: ReturnType<typeof vi.fn>
  addMember: ReturnType<typeof vi.fn>
  removeMember: ReturnType<typeof vi.fn>
  setRole: ReturnType<typeof vi.fn>
}

// Per-channel roster map + per-channel subscription capture, so a member.changed can be emitted on a
// SPECIFIC channel's handler (the seam A1 test fires it on the managed channel while another is
// selected). getMembers reads the mutable map, so setMembers + emit reconciles the roster.
function makeAcl(
  channels: Channel[],
  initialMembers: Record<string, Member[]> = {},
  opts: { reader?: Role | 'absent'; ownAgents?: User[]; abilities?: ChannelAbilities | 'unread' } = {},
): Handles {
  const globalSubs: Array<(e: DomainEvent) => void> = []
  const channelSubs = new Map<string, Array<(e: DomainEvent) => void>>()
  const members: Record<string, Member[]> = { ...initialMembers }
  const key = (id: ChannelId): string => id as unknown as string
  const noop = async (): Promise<void> => {}
  const updateChannel = vi.fn(async () => {})
  const archiveChannel = vi.fn(async () => {})
  const leaveChannel = vi.fn(async () => {})
  const addMember = vi.fn(async () => {})
  const removeMember = vi.fn(async () => {})
  const setRole = vi.fn(async () => {})
  // ADR-115: every verb for an admin reader (the default), none for anyone else, unless a test says otherwise;
  // 'unread' throws, which the screen takes as answers not read.
  let abilities = opts.abilities ?? ((opts.reader ?? 'admin') === 'admin' || opts.reader === 'absent' ? ALL_ABILITIES : NO_ABILITIES)
  const getChannelAbilities = vi.fn((): ChannelAbilities => {
    if (abilities === 'unread') throw new Error('not read')
    return abilities
  })
  const acl: Acl = {
    getChannels: async () => channels,
    getArchivedChannels: async () => [],
    getChannel: async () => channels[0]!,
    getTimeline: async () => ({ items: [] }),
    // The reader is admin of every channel unless a test says otherwise.
    getMembers: async (id) => {
      const list = members[key(id)] ?? []
      const reader = opts.reader ?? 'admin'
      if (list.some((m) => m.self) || reader === 'absent') return list
      return [...list, { user: me, role: reader, state: 'active' as MemberState, self: true }]
    },
    getPresence: () => 'offline' as const,
    getConnectionState: () => 'connecting' as const,
    getChannelAbilities,
    getDevices: async () => [],
    currentUser: async () => me,
    getMyProfile: async () => ({ fullName: me.displayName }),
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
      globalSubs.push(h)
      return () => {
        const i = globalSubs.indexOf(h)
        if (i >= 0) globalSubs.splice(i, 1)
      }
    },
    subscribeChannel: (id, h) => {
      const k = key(id)
      const list = channelSubs.get(k) ?? []
      list.push(h)
      channelSubs.set(k, list)
      return () => {
        const cur = channelSubs.get(k) ?? []
        const i = cur.indexOf(h)
        if (i >= 0) cur.splice(i, 1)
      }
    },
    sendMessage: async () => mid('x'),
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
    acknowledgeAccess: noop,
    resetAccess: async () => ({ t: 'done', historyPreserved: true }),
    resolveMedia: async () => ({ url: '', release: () => {} }),
    exportMyData: () => (async function* () {})(),
    resolveChannel: async () => ({ ok: false, reason: 'not-found' as const }),
    resolveUser: async () => ({ ok: false, reason: 'not-found' as const }),
    createChannel: async () => {
      throw new Error('membership verb not used in this test')
    },
    archiveChannel,
    unarchiveChannel: async () => {},
    updateChannel,
    leaveChannel,
    addMember,
    removeMember,
    setRole,
    openDirectMessage: async () => {
      throw new Error('membership verb not used in this test')
    },
    openGroupConversation: async () => {
      throw new Error('group verb not used in this test')
    },
    convertToChannel: async () => {
      throw new Error('group verb not used in this test')
    },
    connect: noop,
    disconnect: noop,
    listPeople: async () => [],
    listOwnAgents: () => opts.ownAgents ?? [],
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
  return {
    acl,
    emitGlobal: (e) => globalSubs.forEach((h) => h(e)),
    emitChannel: (id, e) => (channelSubs.get(key(id)) ?? []).forEach((h) => h(e)),
    setMembers: (id, list) => {
      members[key(id)] = list
    },
    setAbilities: (next) => {
      abilities = next
    },
    getChannelAbilities,
    updateChannel,
    archiveChannel,
    leaveChannel,
    addMember,
    removeMember,
    setRole,
  }
}

afterEach(cleanup)

describe('channel management — open + DM gating', () => {
  it('opens the panel from the header entry point, prefilled with name/topic', async () => {
    const { acl } = makeAcl([eng])
    const { findByRole, getByRole, getByLabelText } = render(<App acl={acl} onSignOut={() => {}} />)

    const entry = await findByRole('button', { name: fill(copy.channel.manageNamed, { name: '#engineering' }) })
    fireEvent.click(entry)
    await screen.findByLabelText(copy.channel.name) // §15 item 1: the field opens with the answers

    const panel = getByRole('dialog', { name: fill(copy.channel.manageNamed, { name: '#engineering' }) })
    expect(panel).toBeTruthy()
    // Seeded WITHOUT the kind mark (§8.66): the field edits the name; the '#' is the label's.
    expect((getByLabelText(copy.channel.name) as HTMLInputElement).value).toBe('engineering')
    expect((getByLabelText(copy.channel.topic) as HTMLInputElement).value).toBe('Builds and releases')
  })

  it('hides the entry point for a DM channel (ADR-029 scope)', async () => {
    const { acl } = makeAcl([dm])
    const { findByRole, queryByRole } = render(<App acl={acl} onSignOut={() => {}} />)
    await findByRole('heading', { name: 'Ana Lima' })
    expect(queryByRole('button', { name: fill(copy.channel.manageNamed, { name: 'Ana Lima' }) })).toBeNull()
  })
})

describe('channel management — edit (await-and-close, panel stays open)', () => {
  it('submits the changed fields as a patch and shows discreet success', async () => {
    const handles = makeAcl([eng])
    const { findByRole, getByRole, getByLabelText, findByText } = render(<App acl={handles.acl} onSignOut={() => {}} />)

    fireEvent.click(await findByRole('button', { name: fill(copy.channel.manageNamed, { name: '#engineering' }) }))
    await screen.findByLabelText(copy.channel.name) // §15 item 1: the field opens with the answers
    fireEvent.change(getByLabelText(copy.channel.name), { target: { value: '#eng-renamed' } })
    fireEvent.blur(getByLabelText(copy.channel.name))

    await waitFor(() =>
      expect(handles.updateChannel).toHaveBeenCalledWith(eng.id, { name: '#eng-renamed' }),
    )
    await findByText(copy.channel.saved)
    expect(getByRole('dialog', { name: fill(copy.channel.manageNamed, { name: '#engineering' }) })).toBeTruthy()
  })

  it('keeps the panel open with an inline error when the verb rejects', async () => {
    const handles = makeAcl([eng])
    handles.updateChannel.mockRejectedValueOnce(new Error('boom'))
    const { findByRole, getByRole, getByLabelText } = render(<App acl={handles.acl} onSignOut={() => {}} />)

    fireEvent.click(await findByRole('button', { name: fill(copy.channel.manageNamed, { name: '#engineering' }) }))
    await screen.findByLabelText(copy.channel.name) // §15 item 1: the field opens with the answers
    fireEvent.change(getByLabelText(copy.channel.name), { target: { value: '#nope' } })
    fireEvent.keyDown(getByLabelText(copy.channel.name), { key: 'Enter' })

    await findByRole('alert')
    expect(getByRole('dialog', { name: fill(copy.channel.manageNamed, { name: '#engineering' }) })).toBeTruthy()
  })

  it('does not commit an unchanged field', async () => {
    const handles = makeAcl([eng])
    const { findByRole, getByLabelText } = render(<App acl={handles.acl} onSignOut={() => {}} />)

    fireEvent.click(await findByRole('button', { name: fill(copy.channel.manageNamed, { name: '#engineering' }) }))
    await screen.findByLabelText(copy.channel.name) // §15 item 1: the field opens with the answers
    fireEvent.blur(getByLabelText(copy.channel.name))
    fireEvent.keyDown(getByLabelText(copy.channel.topic), { key: 'Enter' })
    await act(async () => {})

    expect(handles.updateChannel).not.toHaveBeenCalled()
  })

  it('never overlaps two commits: the second waits for the first', async () => {
    const handles = makeAcl([eng])
    let finishFirst = () => {}
    handles.updateChannel.mockImplementationOnce(() => new Promise<void>((resolve) => (finishFirst = resolve)))
    const { findByRole, findByText, getByLabelText } = render(<App acl={handles.acl} onSignOut={() => {}} />)

    fireEvent.click(await findByRole('button', { name: fill(copy.channel.manageNamed, { name: '#engineering' }) }))
    await screen.findByLabelText(copy.channel.name) // §15 item 1: the field opens with the answers
    fireEvent.change(getByLabelText(copy.channel.name), { target: { value: 'eng' } })
    fireEvent.keyDown(getByLabelText(copy.channel.name), { key: 'Enter' })
    await findByText(copy.channel.saving)
    fireEvent.change(getByLabelText(copy.channel.topic), { target: { value: 'Nova' } })
    fireEvent.blur(getByLabelText(copy.channel.topic))
    await act(async () => {})
    expect(handles.updateChannel).toHaveBeenCalledTimes(1)

    await act(async () => finishFirst())
    await waitFor(() => expect(handles.updateChannel).toHaveBeenLastCalledWith(eng.id, { topic: 'Nova' }))
    expect(handles.updateChannel).toHaveBeenCalledTimes(2)
  })

  it('Esc on a changed field restores it and keeps focus; the next Esc closes the panel', async () => {
    const handles = makeAcl([eng])
    const { findByRole, getByLabelText, queryByRole } = render(<App acl={handles.acl} onSignOut={() => {}} />)
    const dialogName = fill(copy.channel.manageNamed, { name: '#engineering' })

    fireEvent.click(await findByRole('button', { name: dialogName }))
    const field = (await screen.findByLabelText(copy.channel.name)) as HTMLInputElement
    expect(document.activeElement).toBe(getByLabelText(copy.channel.name))
    fireEvent.change(field, { target: { value: 'outro' } })
    fireEvent.keyDown(field, { key: 'Escape' })

    expect(field.value).toBe('engineering')
    expect(document.activeElement).toBe(field)
    expect(queryByRole('dialog', { name: dialogName })).toBeTruthy()

    fireEvent.keyDown(field, { key: 'Escape' })
    await waitFor(() => expect(queryByRole('dialog', { name: dialogName })).toBeNull())
    expect(handles.updateChannel).not.toHaveBeenCalled()
  })

  it('Esc on a clean field closes the panel', async () => {
    const { acl } = makeAcl([eng])
    const { findByRole, getByLabelText, queryByRole } = render(<App acl={acl} onSignOut={() => {}} />)
    const dialogName = fill(copy.channel.manageNamed, { name: '#engineering' })

    fireEvent.click(await findByRole('button', { name: dialogName }))
    await screen.findByLabelText(copy.channel.name)
    fireEvent.keyDown(getByLabelText(copy.channel.name), { key: 'Escape' })

    await waitFor(() => expect(queryByRole('dialog', { name: dialogName })).toBeNull())
  })

  it('heads the panel with the channel label and keeps the dialog name', async () => {
    const { acl } = makeAcl([eng])
    const { findByRole } = render(<App acl={acl} onSignOut={() => {}} />)
    const dialogName = fill(copy.channel.manageNamed, { name: '#engineering' })

    fireEvent.click(await findByRole('button', { name: dialogName }))

    const dialog = await findByRole('dialog', { name: dialogName })
    expect(within(dialog).getByRole('heading', { level: 3, name: '#engineering' })).toBeTruthy()
  })
})

describe('channel management — archive/leave (confirm → await → stream reconciles)', () => {
  it('dresses only the main view: the confirm is the plain gestao Dialog', async () => {
    const { acl } = makeAcl([eng])
    const { findByRole, getByRole } = render(<App acl={acl} onSignOut={() => {}} />)
    const dialogName = fill(copy.channel.manageNamed, { name: '#engineering' })

    fireEvent.click(await findByRole('button', { name: dialogName }))
    const main = await findByRole('dialog', { name: dialogName })
    expect(main.classList.contains('channel-management-panel--main')).toBe(true)

    fireEvent.click(getByRole('button', { name: copy.channel.archiveTitle }))
    const confirm = await findByRole('dialog', { name: copy.channel.archiveTitle })
    expect(confirm.classList.contains('channel-management-panel--main')).toBe(false)
    expect(confirm.getAttribute('data-size')).toBe('gestao')
  })

  it('archives: verb called, panel closes, channel.removed drops it from the list', async () => {
    const handles = makeAcl([eng])
    const { findByRole, getByRole, queryByRole, queryByText } = render(<App acl={handles.acl} onSignOut={() => {}} />)

    fireEvent.click(await findByRole('button', { name: fill(copy.channel.manageNamed, { name: '#engineering' }) }))
    await screen.findByLabelText(copy.channel.name) // §15 item 1: the field opens with the answers
    fireEvent.click(getByRole('button', { name: copy.channel.archiveTitle }))
    fireEvent.click(getByRole('button', { name: copy.channel.archive }))

    await waitFor(() => expect(handles.archiveChannel).toHaveBeenCalledWith(eng.id))
    await waitFor(() => expect(queryByRole('dialog', { name: fill(copy.channel.manageNamed, { name: '#engineering' }) })).toBeNull())
    act(() => handles.emitGlobal({ t: 'channel.removed', channelId: eng.id }))
    await waitFor(() => expect(queryByText(channelLabel('#engineering'))).toBeNull())
  })

  it('leaves: verb called, panel closes, channel.removed drops it from the list', async () => {
    const handles = makeAcl([eng])
    const { findByRole, getByRole, queryByRole, queryByText } = render(<App acl={handles.acl} onSignOut={() => {}} />)

    fireEvent.click(await findByRole('button', { name: fill(copy.channel.manageNamed, { name: '#engineering' }) }))
    await screen.findByLabelText(copy.channel.name) // §15 item 1: the field opens with the answers
    fireEvent.click(getByRole('button', { name: copy.channel.leaveTitle }))
    fireEvent.click(getByRole('button', { name: copy.channel.leave }))

    await waitFor(() => expect(handles.leaveChannel).toHaveBeenCalledWith(eng.id))
    await waitFor(() => expect(queryByRole('dialog', { name: fill(copy.channel.manageNamed, { name: '#engineering' }) })).toBeNull())
    act(() => handles.emitGlobal({ t: 'channel.removed', channelId: eng.id }))
    await waitFor(() => expect(queryByText(channelLabel('#engineering'))).toBeNull())
  })

  it('a failed archive keeps the dialog open and the channel present', async () => {
    const handles = makeAcl([eng])
    handles.archiveChannel.mockRejectedValueOnce(new Error('denied'))
    const { findByRole, getByRole, getAllByText } = render(<App acl={handles.acl} onSignOut={() => {}} />)

    fireEvent.click(await findByRole('button', { name: fill(copy.channel.manageNamed, { name: '#engineering' }) }))
    await screen.findByLabelText(copy.channel.name) // §15 item 1: the field opens with the answers
    fireEvent.click(getByRole('button', { name: copy.channel.archiveTitle }))
    fireEvent.click(getByRole('button', { name: copy.channel.archive }))

    await findByRole('alert')
    expect(getByRole('dialog', { name: copy.channel.archiveTitle })).toBeTruthy()
    expect(getAllByText(channelLabel('#engineering')).length).toBeGreaterThan(0)
  })
})

describe('channel management — roster + membership (U2)', () => {
  // 1) Roster renders members (displayName + role).
  it('renders the roster: display names + role controls/labels', async () => {
    const handles = makeAcl([eng], {
      [eng.id as unknown as string]: [
        { user: ana, role: 'admin', state: 'active', self: false },
        { user: bruno, role: 'member', state: 'active', self: false },
      ],
    })
    const { findByRole, findByText, getByLabelText } = render(<App acl={handles.acl} onSignOut={() => {}} />)

    fireEvent.click(await findByRole('button', { name: fill(copy.channel.manageNamed, { name: '#engineering' }) }))
    await screen.findByLabelText(copy.channel.name) // §15 item 1: the field opens with the answers
    await findByText('Ana Lima')
    await findByText('Bruno Sato')
    // admin/member get an admin↔member control reflecting their current role.
    expect((getByLabelText(fill(copy.channel.roleFor, { name: 'Ana Lima' })) as HTMLSelectElement).value).toBe('admin')
    expect((getByLabelText(fill(copy.channel.roleFor, { name: 'Bruno Sato' })) as HTMLSelectElement).value).toBe('member')
  })

  // 2) Seam A1: open the panel for X, select Y, emit member.changed on X's handler → the MANAGED
  //    channel X's roster reconciles even though selectedId is now Y (managing ≠ selectedId).
  it('reconciles the MANAGED channel roster while a DIFFERENT channel is selected (A1)', async () => {
    const handles = makeAcl([eng, design], {
      [eng.id as unknown as string]: [{ user: ana, role: 'admin', state: 'active', self: false }],
      [design.id as unknown as string]: [],
    })
    const { findByRole, getByRole, findByText, queryByText } = render(<App acl={handles.acl} onSignOut={() => {}} />)

    // Open the panel for the selected channel (#engineering = X).
    fireEvent.click(await findByRole('button', { name: fill(copy.channel.manageNamed, { name: '#engineering' }) }))
    await screen.findByLabelText(copy.channel.name) // §15 item 1: the field opens with the answers
    await findByText('Ana Lima')

    // Select a DIFFERENT channel (#design = Y). `select` does NOT clear `managing`.
    fireEvent.click(getByRole('button', { name: '#design' }))
    await findByRole('heading', { name: '#design' }) // header now on Y…
    expect(getByRole('dialog', { name: fill(copy.channel.manageNamed, { name: '#engineering' }) })).toBeTruthy() // …panel still X

    // A member changes on X. The roster (keyed on managing.id = X) re-fetches and shows the new member,
    // proving the managed-channel subscription is independent of selectedId.
    handles.setMembers(eng.id, [
      { user: ana, role: 'admin', state: 'active', self: false },
      { user: bruno, role: 'member', state: 'active', self: false },
    ])
    act(() =>
      handles.emitChannel(eng.id, {
        t: 'member.changed',
        channelId: eng.id,
        user: bruno.id,
        role: 'member',
      }),
    )
    await findByText('Bruno Sato')
    expect(queryByText('Bruno Sato')).toBeTruthy()
  })

  // ADR-081: the own row reads "· você" and offers no mutation on oneself; the others keep theirs.
  it('marks the own row and offers no role control or remove on it', async () => {
    const handles = makeAcl([eng], {
      [eng.id as unknown as string]: [
        { user: ana, role: 'admin', state: 'active', self: true },
        { user: bruno, role: 'member', state: 'active', self: false },
      ],
    })
    const { findByRole, getByRole, queryByRole, getByText } = render(<App acl={handles.acl} onSignOut={() => {}} />)

    fireEvent.click(await findByRole('button', { name: fill(copy.channel.manageNamed, { name: '#engineering' }) }))
    await screen.findByLabelText(copy.channel.name) // §15 item 1: the field opens with the answers
    await findByRole('combobox', { name: fill(copy.channel.roleFor, { name: 'Bruno Sato' }) })

    expect(getByText(copy.channel.you).closest('li')?.textContent).toContain('Ana Lima')
    expect(getByRole('heading', { name: fill(copy.channel.membersCount, { n: 2 }) })).toBeTruthy()
    expect(queryByRole('combobox', { name: fill(copy.channel.roleFor, { name: 'Ana Lima' }) })).toBeNull()
    expect(queryByRole('button', { name: fill(copy.channel.removeNamed, { name: 'Ana Lima' }) })).toBeNull()
    expect(getByRole('button', { name: fill(copy.channel.removeNamed, { name: 'Bruno Sato' }) })).toBeTruthy()
  })

  it('puts Remove before the role, so the role aligns right on every row', async () => {
    const handles = makeAcl([eng], {
      [eng.id as unknown as string]: [{ user: bruno, role: 'member', state: 'active', self: false }],
    })
    const { findByRole, getByRole } = render(<App acl={handles.acl} onSignOut={() => {}} />)

    fireEvent.click(await findByRole('button', { name: fill(copy.channel.manageNamed, { name: '#engineering' }) }))
    await screen.findByLabelText(copy.channel.name) // §15 item 1: the field opens with the answers
    const role = await findByRole('combobox', { name: fill(copy.channel.roleFor, { name: 'Bruno Sato' }) })
    const remove = getByRole('button', { name: fill(copy.channel.removeNamed, { name: 'Bruno Sato' }) })

    expect(remove.compareDocumentPosition(role) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  // 3) setRole rejects → inline error on that row, roster unchanged (the controlled select reverts).
  it('keeps the row intact with an inline error when setRole rejects', async () => {
    const handles = makeAcl([eng], {
      [eng.id as unknown as string]: [{ user: ana, role: 'member', state: 'active', self: false }],
    })
    handles.setRole.mockRejectedValueOnce(new Error('denied')) // mirrors the PL guardrail
    const { findByRole, getByLabelText } = render(<App acl={handles.acl} onSignOut={() => {}} />)

    fireEvent.click(await findByRole('button', { name: fill(copy.channel.manageNamed, { name: '#engineering' }) }))
    await screen.findByLabelText(copy.channel.name) // §15 item 1: the field opens with the answers
    const control = (await findByRole('combobox', { name: fill(copy.channel.roleFor, { name: 'Ana Lima' }) })) as HTMLSelectElement
    fireEvent.change(control, { target: { value: 'admin' } })

    await findByRole('alert') // inline, per-row
    expect(handles.setRole).toHaveBeenCalledWith(eng.id, ana.id, 'admin')
    expect((getByLabelText(fill(copy.channel.roleFor, { name: 'Ana Lima' })) as HTMLSelectElement).value).toBe('member') // unchanged
  })

  // 4) removeMember rejects → the dialog stays open with an inline error, the member stays present.
  it('keeps the remove dialog open with an inline error when removeMember rejects', async () => {
    const handles = makeAcl([eng], {
      [eng.id as unknown as string]: [{ user: ana, role: 'admin', state: 'active', self: false }],
    })
    handles.removeMember.mockRejectedValueOnce(new Error('denied'))
    const { findByRole, getByRole, getByText } = render(<App acl={handles.acl} onSignOut={() => {}} />)

    fireEvent.click(await findByRole('button', { name: fill(copy.channel.manageNamed, { name: '#engineering' }) }))
    await screen.findByLabelText(copy.channel.name) // §15 item 1: the field opens with the answers
    fireEvent.click(await findByRole('button', { name: fill(copy.channel.removeNamed, { name: 'Ana Lima' }) }))
    fireEvent.click(getByRole('button', { name: copy.channel.remove })) // dialog confirm

    await waitFor(() => expect(handles.removeMember).toHaveBeenCalledWith(eng.id, ana.id))
    await findByRole('alert')
    expect(getByRole('dialog', { name: copy.channel.removeTitle })).toBeTruthy() // stays open
    // View-swap (ADR-038): the confirm replaces the roster (not overlays it), so the roster row is
    // hidden while the dialog is open. Cancel back to the main view and assert the member survived
    // the rejected removal — it reconciles only via the member.changed stream (no optimistic splice).
    fireEvent.click(getByRole('button', { name: copy.channel.cancel }))
    expect(getByText('Ana Lima')).toBeTruthy() // member still present
  })

  // 5) Picker: candidates = union of the visible channels minus the current roster; selecting calls
  //    addMember with the right (channel.id, user.id); a rejection shows an inline error in the picker.
  it('builds the candidate union (minus roster), wires addMember, surfaces rejection inline', async () => {
    const handles = makeAcl([eng, design], {
      [eng.id as unknown as string]: [{ user: ana, role: 'admin', state: 'active', self: false }], // managed roster: Ana
      [design.id as unknown as string]: [
        { user: ana, role: 'admin', state: 'active', self: false },
        { user: bruno, role: 'member', state: 'active', self: false },
      ],
    })
    handles.addMember.mockRejectedValueOnce(new Error('denied'))
    const { findByRole, getByRole, findByText, queryByRole } = render(<App acl={handles.acl} onSignOut={() => {}} />)

    fireEvent.click(await findByRole('button', { name: fill(copy.channel.manageNamed, { name: '#engineering' }) }))
    await screen.findByLabelText(copy.channel.name) // §15 item 1: the field opens with the answers
    // Let the managed roster settle (Ana present) BEFORE opening the picker, so listCandidates sees
    // the roster and excludes her from the union (it reads the `members` state).
    await findByText('Ana Lima')
    fireEvent.click(getByRole('button', { name: copy.channel.addMember }))
    await findByRole('dialog', { name: copy.channel.addMember })

    // Union {ana, bruno} minus roster {ana} = {bruno}. Ana (already in the roster) is NOT a candidate.
    await findByText('Bruno Sato')
    expect(queryByRole('button', { name: 'Ana Lima' })).toBeNull()

    fireEvent.click(getByRole('button', { name: 'Bruno Sato' }))
    await waitFor(() => expect(handles.addMember).toHaveBeenCalledWith(eng.id, bruno.id))
    await findByRole('alert') // rejection inline
    expect(getByRole('dialog', { name: copy.channel.addMember })).toBeTruthy() // picker stays open
  })

  // 5b) Picker: the server's rate limit (M_LIMIT_EXCEEDED → RateLimitedError at the seam) gets its
  //     OWN copy — one that does not invite an immediate retry into the same limit — distinct from
  //     the generic rejection. The panel classifies on the domain error TYPE (P1), never an errcode.
  it('surfaces a dedicated rate-limit copy (not the generic error) when addMember is rate-limited', async () => {
    const handles = makeAcl([eng, design], {
      [eng.id as unknown as string]: [{ user: ana, role: 'admin', state: 'active', self: false }],
      [design.id as unknown as string]: [
        { user: ana, role: 'admin', state: 'active', self: false },
        { user: bruno, role: 'member', state: 'active', self: false },
      ],
    })
    handles.addMember.mockRejectedValueOnce(new RateLimitedError())
    const { findByRole, getByRole, findByText, queryByText } = render(<App acl={handles.acl} onSignOut={() => {}} />)

    fireEvent.click(await findByRole('button', { name: fill(copy.channel.manageNamed, { name: '#engineering' }) }))
    await screen.findByLabelText(copy.channel.name) // §15 item 1: the field opens with the answers
    await findByText('Ana Lima')
    fireEvent.click(getByRole('button', { name: copy.channel.addMember }))
    await findByRole('dialog', { name: copy.channel.addMember })
    fireEvent.click(await findByRole('button', { name: 'Bruno Sato' }))

    await waitFor(() => expect(handles.addMember).toHaveBeenCalledWith(eng.id, bruno.id))
    await findByText(copy.channel.rateLimited) // dedicated copy
    expect(queryByText(copy.channel.failed)).toBeNull() // NOT the generic one
    expect(getByRole('dialog', { name: copy.channel.addMember })).toBeTruthy() // picker stays open
  })

  // 5c) Invited: a pending member surfaces a chip + a READ-ONLY role (no control) — setRole on a
  //     not-yet-connected member is meaningless. An active member keeps the editable control.
  it('renders an invited member with a pending chip and read-only role; active stays editable', async () => {
    const handles = makeAcl([eng], {
      [eng.id as unknown as string]: [
        { user: ana, role: 'admin', state: 'active', self: false },
        { user: bruno, role: 'member', state: 'invited', self: false },
      ],
    })
    const { findByRole, findByText, getByText, getByLabelText, queryByLabelText } = render(
      <App acl={handles.acl} onSignOut={() => {}} />,
    )
    fireEvent.click(await findByRole('button', { name: fill(copy.channel.manageNamed, { name: '#engineering' }) }))
    await screen.findByLabelText(copy.channel.name) // §15 item 1: the field opens with the answers
    await findByText('Bruno Sato')
    expect(getByText(copy.channel.awaiting)).toBeTruthy() // pending chip
    expect(queryByLabelText(fill(copy.channel.roleFor, { name: 'Bruno Sato' }))).toBeNull() // invited: no editable control
    expect(getByLabelText(fill(copy.channel.roleFor, { name: 'Ana Lima' }))).toBeTruthy() // active: editable control intact
  })

  // 6) Guest: read-only role label, no role-change control (setRole accepts only admin|member).
  it('renders a guest role read-only (no role control)', async () => {
    const handles = makeAcl([eng], {
      [eng.id as unknown as string]: [{ user: gisele, role: 'guest', state: 'active', self: false }],
    })
    const { findByRole, findByText, getByText, queryByLabelText } = render(<App acl={handles.acl} onSignOut={() => {}} />)

    fireEvent.click(await findByRole('button', { name: fill(copy.channel.manageNamed, { name: '#engineering' }) }))
    await screen.findByLabelText(copy.channel.name) // §15 item 1: the field opens with the answers
    await findByText('Gisele Rocha')
    expect(getByText(copy.channel.roleGuest)).toBeTruthy() // read-only label
    expect(queryByLabelText(fill(copy.channel.roleFor, { name: 'Gisele Rocha' }))).toBeNull() // no control for guest
  })
})

// channel-management.md §13.1 and §9 items 4–6 (PLANO-MOBILE §0.22 I1, I4, P3, P4): the picker in the 360 casca with
// the ✕ and the filter, staying open after adding; the agent in two lines; who is not admin reads.
describe('channel management — §13.1 (wide)', () => {
  const robo: User = { id: uid('@a-abcdefghijkl:tayet.local'), displayName: 'Relatório diário', kind: 'agent', agentColor: 'argila', operatorName: 'Eu Mesmo' }
  const mute: User = { id: uid('@a-mnopqrstuvwx:tayet.local'), displayName: 'Resumo semanal', kind: 'agent', agentColor: 'argila' }
  const openPanel = async (handles: Handles) => {
    const ui = render(<App acl={handles.acl} onSignOut={() => {}} />)
    fireEvent.click(await ui.findByRole('button', { name: fill(copy.channel.manageNamed, { name: '#engineering' }) }))
    return ui
  }
  const twoChannels = (reader?: Role | 'absent', ownAgents?: User[]) =>
    makeAcl(
      [eng, design],
      {
        [eng.id as unknown as string]: [{ user: ana, role: 'admin', state: 'active', self: false }],
        [design.id as unknown as string]: [
          { user: ana, role: 'admin', state: 'active', self: false },
          { user: bruno, role: 'member', state: 'active', self: false },
          { user: gisele, role: 'member', state: 'active', self: false },
        ],
      },
      { reader, ownAgents },
    )

  it('item 5: who is not admin reads — name and topic as text, no add, no role control, no Remove, no archive; leave stays', async () => {
    const ui = await openPanel(twoChannels('member'))
    await ui.findByText(copy.channel.you.replace('· ', ''), { exact: false })
    const dialog = ui.getByRole('dialog', { name: fill(copy.channel.manageNamed, { name: '#engineering' }) })
    expect(within(dialog).queryByLabelText(copy.channel.name)).toBeNull()
    expect(dialog.querySelectorAll('.channel-management-panel__value')[0]!.textContent).toBe('#engineering')
    expect(dialog.querySelectorAll('.channel-management-panel__value')[1]!.textContent).toBe(eng.topic)
    expect(within(dialog).queryByRole('button', { name: copy.channel.addMember })).toBeNull()
    expect(within(dialog).queryByRole('combobox')).toBeNull()
    expect(within(dialog).queryByRole('button', { name: fill(copy.channel.removeNamed, { name: 'Ana Lima' }) })).toBeNull()
    expect(within(dialog).queryByRole('button', { name: copy.channel.archiveTitle })).toBeNull()
    const footer = dialog.querySelector('.channel-management-panel__footer')!
    expect([...footer.querySelectorAll('button')].map((b) => b.textContent)).toEqual([copy.channel.leaveTitle])
    expect(within(dialog).getByRole('button', { name: fill(copy.channel.viewProfile, { name: 'Ana Lima' }) })).toBeTruthy()
    // The Dialog still hears Esc: the focus is inside it.
    expect(dialog.contains(document.activeElement)).toBe(true)
  })

  it('item 5: an empty topic has no line', async () => {
    const handles = makeAcl([{ ...eng, topic: undefined }], {}, { reader: 'member' })
    const ui = await openPanel(handles)
    await ui.findByText(copy.channel.leaveTitle)
    await waitFor(() => expect(ui.container.querySelectorAll('.channel-management-panel__value')).toHaveLength(1))
    expect(ui.queryByText(copy.channel.topic)).toBeNull()
  })

  it('§15 item 1: closed while the answers have not been read, even with an admin own row', async () => {
    const ui = await openPanel(makeAcl([eng], {}, { abilities: 'unread' }))
    await ui.findByText(copy.channel.you.replace('· ', ''), { exact: false })
    expect(ui.queryByLabelText(copy.channel.name)).toBeNull()
    expect(ui.queryByLabelText(copy.channel.topic)).toBeNull()
    expect(ui.queryByRole('button', { name: copy.channel.addMember })).toBeNull()
    expect(ui.queryByRole('button', { name: copy.channel.archiveTitle })).toBeNull()
  })

  it('§9 items 4–6: the picker in the compose casca, ✕ and filter; adding keeps it open and the person leaves the list', async () => {
    const handles = twoChannels()
    const ui = await openPanel(handles)
    await screen.findByLabelText(copy.channel.name)
    await ui.findByText('Ana Lima')
    fireEvent.click(ui.getByRole('button', { name: copy.channel.addMember }))
    const picker = await ui.findByRole('dialog', { name: copy.channel.addMember })
    expect(picker.classList.contains('compose-dialog')).toBe(true)
    expect(picker.getAttribute('data-size')).toBe('cotidiano')
    await within(picker).findByText('Bruno Sato')
    // The filter reads the name only; nothing found → people.noResults.
    const filter = within(picker).getByRole('textbox', { name: copy.newConversation.filterPeople })
    fireEvent.change(filter, { target: { value: 'gisé' } })
    expect(within(picker).queryByText('Bruno Sato')).toBeNull()
    expect(within(picker).getByText('Gisele Rocha')).toBeTruthy()
    fireEvent.change(filter, { target: { value: 'zz' } })
    expect(within(picker).getByText(fill(copy.people.noResults, { term: 'zz' }))).toBeTruthy()
    fireEvent.click(within(picker).getByRole('button', { name: copy.people.clearFilter }))
    fireEvent.click(within(picker).getByRole('button', { name: 'Bruno Sato' }))
    await waitFor(() => expect(handles.addMember).toHaveBeenCalledWith(eng.id, bruno.id))
    await waitFor(() => expect(within(picker).queryByText('Bruno Sato')).toBeNull())
    expect(ui.getByRole('dialog', { name: copy.channel.addMember })).toBe(picker)
    expect(within(picker).getByText('Gisele Rocha')).toBeTruthy()
    // The ✕ goes back to the main view.
    fireEvent.click(within(picker).getAllByRole('button', { name: copy.channel.close })[0]!)
    expect(await ui.findByRole('dialog', { name: fill(copy.channel.manageNamed, { name: '#engineering' }) })).toBeTruthy()
  })

  it('§9 item 4: Esc in the picker goes back to the main view', async () => {
    const ui = await openPanel(twoChannels())
    await screen.findByLabelText(copy.channel.name)
    fireEvent.click(ui.getByRole('button', { name: copy.channel.addMember }))
    const picker = await ui.findByRole('dialog', { name: copy.channel.addMember })
    fireEvent.keyDown(within(picker).getByRole('textbox', { name: copy.newConversation.filterPeople }), { key: 'Escape' })
    expect(await ui.findByRole('dialog', { name: fill(copy.channel.manageNamed, { name: '#engineering' }) })).toBeTruthy()
  })

  it('items 1–2: the agent in two lines in the roster and in the picker; without operatorName, one line', async () => {
    const handles = makeAcl(
      [eng],
      {
        [eng.id as unknown as string]: [
          { user: ana, role: 'admin', state: 'active', self: false },
          { user: robo, role: 'member', state: 'active', self: false },
        ],
      },
      { ownAgents: [robo, mute] },
    )
    const ui = await openPanel(handles)
    await screen.findByLabelText(copy.channel.name)
    const line = (await ui.findByText('Relatório diário')).closest('.channel-management-panel__member')!
    expect(line.querySelector('.channel-management-panel__member-sub')!.textContent).toBe(fill(copy.agent.operatedBy, { name: 'Eu Mesmo' }))
    expect(ui.getByRole('heading', { name: fill(copy.channel.membersCount, { n: 3 }) })).toBeTruthy()
    fireEvent.click(ui.getByRole('button', { name: copy.channel.addMember }))
    const picker = await ui.findByRole('dialog', { name: copy.channel.addMember })
    const option = (await within(picker).findByText('Resumo semanal')).closest('button')!
    expect(option.querySelector('[data-agent-avatar]')).not.toBeNull()
    expect(option.querySelector('.channel-management-panel__member-sub')).toBeNull()
  })
})

// ADR-115 (Proposto); channel-management.md §15 item 1: each control follows its own answer, not the role of the
// reader's own row. The roster: the reader (admin row), Ana (admin) and Bruno (member).
describe('channel management — the answers, control by control (ADR-115)', () => {
  const roster = () => ({
    [eng.id as unknown as string]: [
      { user: ana, role: 'admin' as Role, state: 'active' as MemberState, self: false },
      { user: bruno, role: 'member' as Role, state: 'active' as MemberState, self: false },
      { user: me, role: 'admin' as Role, state: 'active' as MemberState, self: true },
    ],
  })
  const openWith = async (abilities: ChannelAbilities | 'unread') => {
    const handles = makeAcl([eng], roster(), { abilities })
    const ui = render(<App acl={handles.acl} onSignOut={() => {}} />)
    fireEvent.click(await ui.findByRole('button', { name: fill(copy.channel.manageNamed, { name: '#engineering' }) }))
    const dialog = await ui.findByRole('dialog', { name: fill(copy.channel.manageNamed, { name: '#engineering' }) })
    await within(dialog).findByText('Bruno Sato')
    return { ui, dialog, handles }
  }
  const shown = (dialog: HTMLElement) => ({
    rename: within(dialog).queryByLabelText(copy.channel.name) !== null,
    editTopic: within(dialog).queryByLabelText(copy.channel.topic) !== null,
    addPeople: within(dialog).queryByRole('button', { name: copy.channel.addMember }) !== null,
    removePeople: within(dialog).queryByRole('button', { name: fill(copy.channel.removeNamed, { name: 'Bruno Sato' }) }) !== null,
    setRoles: within(dialog).queryByRole('combobox', { name: fill(copy.channel.roleFor, { name: 'Bruno Sato' }) }) !== null,
    archive: within(dialog).queryByRole('button', { name: copy.channel.archiveTitle }) !== null,
  })

  for (const key of Object.keys(NO_ABILITIES) as Array<keyof ChannelAbilities>) {
    it(`${key} alone opens only its control`, async () => {
      const { dialog } = await openWith({ ...NO_ABILITIES, [key]: true })
      expect(shown(dialog)).toEqual({ ...NO_ABILITIES, [key]: true })
    })
    it(`every answer but ${key} closes only its control`, async () => {
      const { dialog } = await openWith({ ...ALL_ABILITIES, [key]: false })
      expect(shown(dialog)).toEqual({ ...ALL_ABILITIES, [key]: false })
    })
  }

  it('the name editable and the topic as text, and the other way round', async () => {
    const a = await openWith({ ...NO_ABILITIES, rename: true })
    expect(within(a.dialog).getByLabelText(copy.channel.name)).toBeTruthy()
    expect(within(a.dialog).getByText(eng.topic!).tagName).toBe('P')
    cleanup()
    const b = await openWith({ ...NO_ABILITIES, editTopic: true })
    expect((within(b.dialog).getByLabelText(copy.channel.topic) as HTMLInputElement).value).toBe(eng.topic)
    expect(b.dialog.querySelector('.channel-management-panel__value')!.textContent).toBe('#engineering')
  })

  it('never a Remove nor a role control on the own row', async () => {
    const { dialog } = await openWith(ALL_ABILITIES)
    const own = within(dialog).getByText(copy.channel.you.replace('· ', ''), { exact: false }).closest('.channel-management-panel__member')!
    expect(own.querySelector('.channel-management-panel__member-remove')).toBeNull()
    expect(own.querySelector('select')).toBeNull()
  })

  it('ADR-115 dec. 5: read on opening, and again on a member.changed of the managed channel', async () => {
    const { dialog, handles } = await openWith(NO_ABILITIES)
    expect(handles.getChannelAbilities).toHaveBeenCalledWith(eng.id)
    expect(shown(dialog)).toEqual(NO_ABILITIES)
    handles.setAbilities(ALL_ABILITIES)
    act(() => handles.emitChannel(eng.id, { t: 'member.changed', channelId: eng.id, user: bruno.id, role: 'admin' } as DomainEvent))
    await waitFor(() => expect(shown(dialog)).toEqual(ALL_ABILITIES))
  })
})
