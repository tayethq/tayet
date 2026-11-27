// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { useEffect } from 'react'
import { render, cleanup, fireEvent, waitFor, act } from '@testing-library/react'
import type { Editor } from '@tiptap/react'
import { Workspace } from '../../src/ui/components/Workspace'
import { SearchResults } from '../../src/ui/components/SearchResults'
import { agentColorOf } from '../../src/ui/components/AgentAvatar'
import { useSearch } from '../../src/ui/useSearch'
import { AdminPeople } from '../../src/ui/components/AdminPeople'
import { NewConversationDialog } from '../../src/ui/components/NewConversationDialog'
import { ChannelManagementPanel } from '../../src/ui/components/ChannelManagementPanel'
import { UserProfileDialog } from '../../src/ui/components/UserProfileDialog'
import { RichComposer } from '../../src/ui/composer/RichComposer'
import { createNotifier, type NotifierEnv } from '../../src/ui/notifier'
import type { Acl, Channel, ChannelId, Message, MessageId, Person, SearchHit, User, UserId, UserProfile } from '../../src/acl'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { copy, fill } from '../support/copy'

// Gate "agente sem marca" (PLANO-AGENTES §0.1 item 20; ADR-086 Proposto dec. 2; workspace.md §15,
// account-access.md §11). Every surface of the §0 F1 table is mounted with a member `kind: 'agent'`,
// and EVERY occurrence of the agent's name on screen must sit in a row (its nearest row-like
// container) that carries the agent avatar: `[data-agent-avatar]` with role="img" and the accessible
// label "Agente", holding the indicator `[data-agent-mark]`. The OS notification has no avatar: the
// mark is in its text. Negative proof: a PERSON with the same name gets no agent avatar and no
// indicator anywhere — the mark comes from the kind, never from the name.
//
// F1 rows → where they are mounted here: Timeline/ThreadPanel (MessageRow grouped + the thread panel),
// quoted reply preview, composer reply banner, DM header and DM sidebar row → Workspace; AdminPeople (the Admin's people
// list, which replaced the PeoplePanel of "Sua conta" in slice 1c);
// @-picker → RichComposer; search → SearchResults; NewConversationDialog (options, chips,
// suggestions); channel members + add-member picker → ChannelManagementPanel; UserProfileDialog;
// notification → createNotifier. Account/self: an agent never signs in to the client (no session of
// its own), so the self surfaces never show an agent. InvitePersonDialog renders no existing person.

const cid = (s: string): ChannelId => s as unknown as ChannelId
const uid = (s: string): UserId => s as unknown as UserId
const mid = (s: string): MessageId => s as unknown as MessageId
const tms = (n: number) => n as unknown as Message['sentAt']

const NAME = 'Relatório diário'
const AGENT_ID = uid('@a-abcdefghijkl:tayet.local')
const PERSON_ID = uid('@u-mnopqrstuvwx:tayet.local')
const ALICE_ID = uid('@alice:tayet.local')

const agent: User = { id: AGENT_ID, displayName: NAME, kind: 'agent', agentColor: 'malva', operatorName: 'Alice Souza' }
// The homonym: a person who chose the agent's name (the negative proof).
const person: User = { id: PERSON_ID, displayName: NAME, kind: 'member' }
const alice: User = { id: ALICE_ID, displayName: 'Alice Souza', kind: 'member' }

// The nearest row-like container of a name: the unit a reader takes as "this line".
const ROW = [
  'article',
  'li',
  '[role="row"]',
  // The conversation header's name: its row is the whole header, where the agent's block sits before
  // the heading.
  'h2:not(.channel-header__name)',
  '.channel-header',
  '[role="option"]',
  '.message__quote',
  '.composer__reply-label',
  '.search-hit',
  '.compose-dialog__chip',
  '.compose-dialog__suggest',
  '.user-profile__header',
].join(',')

function textHolders(root: Element, name: string): Element[] {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const out = new Set<Element>()
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.textContent?.includes(name) && n.parentElement) out.add(n.parentElement)
  }
  return [...out]
}

function expectEveryNameMarked(root: Element, name = NAME): number {
  const holders = textHolders(root, name)
  expect(holders.length).toBeGreaterThan(0)
  for (const holder of holders) {
    const row = holder.closest(ROW)
    expect(row, `no row around "${holder.outerHTML.slice(0, 120)}"`).not.toBeNull()
    const avatar = row!.querySelector('[data-agent-avatar]')
    expect(avatar, `name without the agent avatar in "${row!.outerHTML.slice(0, 200)}"`).not.toBeNull()
    expect(avatar!.getAttribute('role')).toBe('img')
    expect(avatar!.getAttribute('aria-label')).toBe(copy.agent.label)
    expect(avatar!.querySelector('[data-agent-mark]')).not.toBeNull()
  }
  // No text badge: "Agente" is the avatar's accessible name, never visible text beside the name.
  expect(root.textContent ?? '').not.toMatch(/\bagente\b/i)
  expect(findProtocolLeaksInText(root.innerHTML)).toEqual([])
  return holders.length
}

function expectNoAgentMark(root: Element): void {
  expect(textHolders(root, NAME).length).toBeGreaterThan(0)
  expect(root.querySelector('[data-agent-avatar]')).toBeNull()
  expect(root.querySelector('[data-agent-mark]')).toBeNull()
}

afterEach(cleanup)

// ── Workspace: timeline, thread, quoted preview, reply banner, DM row and header ─────────────────
const CHANNEL: Channel = { id: cid('!eng:tayet.local'), name: '#eng', kind: 'public', memberCount: 3, unread: { count: 0, mentions: 0 } }
const dmWith = (who: User): Channel => ({
  id: cid('!dm:tayet.local'),
  name: who.displayName,
  kind: 'dm',
  memberCount: 2,
  unread: { count: 0, mentions: 0 },
  peer: who.id,
  ...(who.kind === 'agent' ? { peerAgent: { color: who.agentColor!, operatorName: who.operatorName } } : {}),
})
const message = (id: string, author: UserId, over: Partial<Message> = {}): Message => ({
  id: mid(id),
  channelId: CHANNEL.id,
  author,
  body: { kind: 'text', text: `texto ${id}` },
  sentAt: tms(1),
  reactions: [],
  mine: false,
  mentionsMe: false,
  ...over,
})

function mountWorkspace(who: User, selected: 'channel' | 'dm') {
  const dm = dmWith(who)
  const root = message('$root', who.id)
  const messages = [root, message('$reply', ALICE_ID, { replyTo: root.id, mine: true })]
  return render(
    <Workspace
      channels={[CHANNEL, dm]}
      selectedChannelId={selected === 'dm' ? dm.id : CHANNEL.id}
      messages={selected === 'dm' ? [] : messages}
      usersById={{ [who.id]: who, [ALICE_ID]: alice }}
      connection="connected"
      onSelectChannel={() => {}}
      onSend={() => {}}
      replyTarget={selected === 'channel' ? root : undefined}
      onCancelReply={() => {}}
      threadRoot={selected === 'channel' ? root : undefined}
      threadMessages={selected === 'channel' ? [message('$t1', who.id, { threadParent: root.id })] : undefined}
      onCloseThread={() => {}}
      onSendThread={() => {}}
    />,
  )
}

describe('gate "agente sem marca" — Workspace (timeline, thread, quote, reply banner, DM)', () => {
  it('channel: every occurrence of the agent name carries the agent avatar', () => {
    const { container } = mountWorkspace(agent, 'channel')
    // Timeline row, thread root, thread reply, quoted preview, reply banner, DM sidebar row.
    expect(expectEveryNameMarked(container)).toBeGreaterThanOrEqual(6)
    expect(container.querySelector('.message__quote [data-agent-avatar]')).not.toBeNull()
    expect(container.querySelector('.composer__reply-label [data-agent-avatar]')).not.toBeNull()
    expect(container.querySelector('.thread-panel [data-agent-avatar]')).not.toBeNull()
    expect(container.querySelector('.channel--dm [data-agent-avatar]')).not.toBeNull()
    // The colour travels to the token trio; never the green presence.
    expect(container.querySelector('[data-agent-avatar]')!.getAttribute('data-agent-color')).toBe('malva')
    expect(container.querySelector('.channel--dm [data-presence]')).toBeNull()
  })

  it('DM with the agent: the header carries the avatar and "operado por"', () => {
    const { container } = mountWorkspace(agent, 'dm')
    expectEveryNameMarked(container)
    // A block before the name, not inside its line.
    const block = container.querySelector('.channel-header > .channel-header__agent')
    expect(block?.querySelector('[data-agent-avatar]')).not.toBeNull()
    expect(block?.nextElementSibling?.classList.contains('channel-header__heading')).toBe(true)
    expect(container.querySelector('.channel-header__name [data-agent-avatar]')).toBeNull()
    expect(container.querySelector('[data-agent-operator]')?.textContent).toBe(
      fill(copy.agent.operatedBy, { name: 'Alice Souza' }),
    )
  })

  it('negative: the homonym person gets no agent avatar anywhere', () => {
    expectNoAgentMark(mountWorkspace(person, 'channel').container)
    cleanup()
    const { container } = mountWorkspace(person, 'dm')
    expectNoAgentMark(container)
    expect(container.querySelector('[data-agent-operator]')).toBeNull()
  })
})

// ── Approval card (ADR-091 Proposto, A3-1; PLANO-AGENTES §0.1 item 20) ─────────────────────────────
// The agent's card carries the mark in its row header; the answer line ("{nome} às {hora}") names a
// PERSON — the card holds no agent avatar and no indicator, even when that person bears the agent's name.
const approvalCard = (by: UserId, over: Partial<Message> = {}): Message =>
  message('$card', AGENT_ID, {
    body: {
      kind: 'approval',
      text: 'Publicar a versão 2.4?',
      options: [{ id: 'approve', label: 'Aprovar', style: 'primary' }],
      state: { kind: 'answered', by, at: tms(1), option: 'approve' },
    },
    ...over,
  })

function mountApproval(by: UserId) {
  const root = approvalCard(by)
  return render(
    <Workspace
      channels={[CHANNEL]}
      selectedChannelId={CHANNEL.id}
      messages={[root]}
      usersById={{ [AGENT_ID]: agent, [PERSON_ID]: person, [ALICE_ID]: alice }}
      connection="connected"
      onSelectChannel={() => {}}
      onSend={() => {}}
      threadRoot={root}
      threadMessages={[approvalCard(by, { id: mid('$card2'), threadParent: root.id })]}
      onCloseThread={() => {}}
      onSendThread={() => {}}
    />,
  )
}

describe('gate "agente sem marca" — approval card', () => {
  it('the agent’s card: the mark on the row header (timeline and thread); the answer line is a person’s', () => {
    const { container } = mountApproval(ALICE_ID)
    expect(expectEveryNameMarked(container)).toBeGreaterThanOrEqual(3)
    const cards = container.querySelectorAll('.approval')
    expect(cards.length).toBe(3)
    for (const c of cards) {
      expect(c.querySelector('.approval__by')?.textContent).toContain('Alice Souza')
      expect(c.querySelector('[data-agent-avatar]')).toBeNull()
      expect(c.querySelector('[data-agent-mark]')).toBeNull()
      expect(c.closest('article')?.querySelector('.message__avatar [data-agent-avatar], :scope > [data-agent-avatar]')).not.toBeNull()
    }
  })

  it('negative: the homonym person answering — the answer line has no agent avatar and no indicator', () => {
    const { container } = mountApproval(PERSON_ID)
    const lines = [...container.querySelectorAll('.approval__by')]
    expect(lines.length).toBe(3)
    for (const line of lines) {
      expect(line.textContent).toContain(NAME)
      const card = line.closest('.approval')!
      expect(card.querySelector('[data-agent-avatar]')).toBeNull()
      expect(card.querySelector('[data-agent-mark]')).toBeNull()
    }
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  it('OS notification of the card: the agents’ title, "Pede aprovação: {primeira linha}"', async () => {
    const shown: Array<{ title: string; body: string }> = []
    const notifier = createNotifier(
      { getChannel: () => CHANNEL, getSelectedId: () => undefined, select: () => {}, jumpTo: () => {}, getMembers: async () => [agent, alice] },
      {
        permission: () => 'granted',
        notify: (title, { body }) => {
          shown.push({ title, body })
          return { onclick: null, close: () => {} }
        },
        isVisible: () => false,
        hasFocus: () => false,
        focusWindow: () => {},
        now: () => 0,
        setTimeout: () => 0,
        clearTimeout: () => {},
      },
    )
    notifier.handle({ t: 'message.received', channelId: CHANNEL.id, message: approvalCard(ALICE_ID, { mentionsMe: true }) })
    await new Promise((r) => setTimeout(r, 0))
    expect(shown).toEqual([
      {
        title: fill(copy.notifications.titleInAgent, { author: NAME, channel: '#eng' }),
        body: fill(copy.notifications.approvalRequest, { text: 'Publicar a versão 2.4?' }),
      },
    ])
  })
})

// ── AdminPeople ──────────────────────────────────────────────────────────────────────────────────
const asPerson = (user: User): Person => ({ user, pending: false, self: false })

describe('gate "agente sem marca" — AdminPeople', () => {
  const mount = (who: User) =>
    render(
      <AdminPeople
        people={[asPerson(alice), asPerson(who)]}
        access={{ status: 'ready', admins: new Set([ALICE_ID]), withoutAccess: new Set(), adminCount: 1 }}
        onInvite={() => {}}
        onAction={() => {}}
      />,
    )
  it('the agent line: avatar, "operado por", no kind word', () => {
    const { container } = mount(agent)
    expectEveryNameMarked(container)
    expect(container.textContent).toContain(fill(copy.agent.operatedBy, { name: 'Alice Souza' }))
  })
  // ADR-086; account-access.md §11: listPeople never marks an agent pending (even in `invite`), so its
  // row's verb is "Remover", never "Cancelar convite".
  it('the agent line: the verb is "Remover", never "Cancelar convite"', () => {
    const { container, getByRole } = mount(agent)
    fireEvent.click(getByRole('button', { name: fill(copy.admin.actionsFor, { name: NAME }) }))
    expect(getByRole('menuitem', { name: copy.agent.remove })).toBeTruthy()
    expect(container.textContent).not.toContain(copy.people.cancelInvite)
    expect(container.textContent).not.toContain(copy.people.pending)
  })
  it('negative: the homonym person', () => {
    expectNoAgentMark(mount(person).container)
  })
})

// ── @-picker ─────────────────────────────────────────────────────────────────────────────────────
describe('gate "agente sem marca" — @-picker', () => {
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
  async function mount(who: User) {
    let editor: Editor | null = null
    const utils = render(<RichComposer onSend={() => {}} users={[who, alice]} onEditor={(e) => (editor = e)} />)
    await act(async () => {
      editor!.commands.focus()
      editor!.commands.insertContent('@rel')
      await flush()
    })
    return utils
  }
  it('the agent candidate carries the avatar', async () => {
    const { container, getByRole } = await mount(agent)
    expectEveryNameMarked(getByRole('listbox', { name: copy.composer.mention }))
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(1)
  })
  it('negative: the homonym person', async () => {
    const { getByRole } = await mount(person)
    expectNoAgentMark(getByRole('listbox', { name: copy.composer.mention }))
  })
})

// ── Search ───────────────────────────────────────────────────────────────────────────────────────
describe('gate "agente sem marca" — search results', () => {
  const mount = (who: User, channel: Channel, mine = false) =>
    render(
      <SearchResults
        hits={[
          {
            hit: { message: message('$s1', mine ? ALICE_ID : who.id, { mine, channelId: channel.id }), channel: channel.id, excerpt: { before: 'o ', match: 'relatório', after: ' saiu' } },
            author: mine ? alice.displayName : who.displayName,
            ...(!mine && agentColorOf(who) !== undefined && { authorAgent: agentColorOf(who) }),
          },
        ]}
        searched="relatório"
        preparing={false}
        channels={[channel]}
        onPick={() => {}}
        onClear={() => {}}
      />,
    )
  it('an agent author, and my message in a DM with the agent (the "where")', () => {
    expectEveryNameMarked(mount(agent, CHANNEL).container)
    cleanup()
    expectEveryNameMarked(mount(agent, dmWith(agent), true).container)
  })
  it('negative: the homonym person', () => {
    expectNoAgentMark(mount(person, CHANNEL).container)
    cleanup()
    expectNoAgentMark(mount(person, dmWith(person), true).container)
  })
})

// ── The agent who left (PLANO-AGENTES §0.3.11): out of the member map, the portrait carries the mark ─
// A removed agent is no longer in usersById (the roster is join/invite only); its messages keep the
// name and the mark through Message.authorAt, on every surface that resolves an author.
const DEPARTED: Message['authorAt'] = { name: NAME, agent: true, color: 'malva' }

function mountDeparted(authorAt: Message['authorAt']) {
  const root = message('$root', AGENT_ID, { authorAt })
  const messages = [root, message('$reply', ALICE_ID, { replyTo: root.id, mine: true })]
  return render(
    <Workspace
      channels={[CHANNEL]}
      selectedChannelId={CHANNEL.id}
      messages={messages}
      usersById={{ [ALICE_ID]: alice }}
      connection="connected"
      onSelectChannel={() => {}}
      onSend={() => {}}
      replyTarget={root}
      onCancelReply={() => {}}
      threadRoot={root}
      threadMessages={[message('$t1', AGENT_ID, { threadParent: root.id, authorAt })]}
      onCloseThread={() => {}}
      onSendThread={() => {}}
    />,
  )
}

function SearchHarness({ acl }: { acl: Acl }) {
  const s = useSearch(acl, undefined)
  const { setQuery } = s
  useEffect(() => setQuery('relatório'), [setQuery])
  return <SearchResults hits={s.hits} searched={s.searched} preparing={false} channels={[CHANNEL]} onPick={() => {}} onClear={() => {}} />
}

function departedSearch(authorAt: Message['authorAt']) {
  const hit: SearchHit = {
    message: message('$s1', AGENT_ID, { authorAt }),
    channel: CHANNEL.id,
    excerpt: { before: 'o ', match: 'relatório', after: ' saiu' },
  }
  const acl = {
    searchMessages: async () => [hit],
    // The agent is not among the conversation's members anymore.
    getMembers: async () => [{ user: alice, role: 'member', state: 'joined' }],
    subscribe: () => () => {},
  } as unknown as Acl
  return render(<SearchHarness acl={acl} />)
}

function expectNoIdOf(root: Element): void {
  expect(root.innerHTML).not.toContain('a-abcdefghijkl')
  expect(findProtocolLeaksInText(root.innerHTML)).toEqual([])
  expect(findProtocolLeaksInText(root.textContent ?? '')).toEqual([])
}

describe('gate "agente sem marca" — the agent who left (authorAt)', () => {
  it('timeline row, quoted preview, thread and reply banner keep the name and the mark', () => {
    const { container } = mountDeparted(DEPARTED)
    expect(expectEveryNameMarked(container)).toBeGreaterThanOrEqual(5)
    expect(container.querySelector('.message__quote [data-agent-avatar]')).not.toBeNull()
    expect(container.querySelector('.composer__reply-label [data-agent-avatar]')).not.toBeNull()
    expect(container.querySelector('.thread-panel [data-agent-avatar]')).not.toBeNull()
    expect(container.querySelector('[data-agent-avatar]')!.getAttribute('data-agent-color')).toBe('malva')
    expectNoIdOf(container)
  })

  it('no explicit name and no colour: "Alguém" with the mark in areia — never the localpart or the id', () => {
    const { container } = mountDeparted({ agent: true })
    expectEveryNameMarked(container, copy.timeline.someone)
    expect(container.querySelector('[data-agent-avatar]')!.getAttribute('data-agent-color')).toBe('areia')
    expectNoIdOf(container)
  })

  it('a person who left: the portrait name, no mark', () => {
    const { container } = mountDeparted({ name: NAME, agent: false })
    expectNoAgentMark(container)
    expectNoIdOf(container)
  })

  it('search: a result of the agent who left keeps the name and the mark', async () => {
    const { container } = departedSearch(DEPARTED)
    await waitFor(() => expect(container.querySelector('.search-hit')).not.toBeNull())
    expectEveryNameMarked(container)
    expectNoIdOf(container)
  })

  it('search: no name in the portrait → "Alguém" with the mark, no id', async () => {
    const { container } = departedSearch({ agent: true })
    await waitFor(() => expect(container.querySelector('.search-hit')).not.toBeNull())
    expectEveryNameMarked(container, copy.search.unknownAuthor)
    expectNoIdOf(container)
  })
})

// ── NewConversationDialog ────────────────────────────────────────────────────────────────────────
describe('gate "agente sem marca" — NewConversationDialog', () => {
  const mount = (who: User, mode: 'dm' | 'channel') =>
    render(
      <NewConversationDialog
        initialMode={mode}
        onCreateChannel={async () => {}}
        onOpenDirectMessage={async () => {}}
        onOpenGroupConversation={async () => {}}
        loadKnownContacts={async () => [who, alice]}
        onClose={() => {}}
      />,
    )
  it('DM options; channel suggestions and the chip once added', async () => {
    const dm = mount(agent, 'dm')
    await waitFor(() => expect(dm.container.querySelector('.compose-dialog__picker-list')).not.toBeNull())
    expectEveryNameMarked(dm.container)
    cleanup()
    const ch = mount(agent, 'channel')
    const suggest = await waitFor(() => ch.getByRole('button', { name: fill(copy.newConversation.suggestPerson, { name: NAME }) }))
    expectEveryNameMarked(ch.container)
    fireEvent.click(suggest)
    expect(ch.container.querySelector('.compose-dialog__chip [data-agent-avatar]')).not.toBeNull()
    expectEveryNameMarked(ch.container)
  })
  it('negative: the homonym person', async () => {
    const dm = mount(person, 'dm')
    await waitFor(() => expect(dm.container.querySelector('.compose-dialog__picker-list')).not.toBeNull())
    expectNoAgentMark(dm.container)
  })
})

// ── Channel members and the add-member picker ────────────────────────────────────────────────────
describe('gate "agente sem marca" — channel members', () => {
  const mount = (who: User) =>
    render(
      <ChannelManagementPanel
        abilities={{ rename: true, editTopic: true, addPeople: true, removePeople: true, setRoles: true, archive: true }}
        channel={CHANNEL}
        members={[
          { user: alice, role: 'admin', state: 'active', self: true },
          { user: who, role: 'member', state: 'active', self: false },
        ]}
        onUpdateChannel={async () => {}}
        onArchiveChannel={async () => {}}
        onLeaveChannel={async () => {}}
        onSetRole={async () => {}}
        onRemoveMember={async () => {}}
        onAddMember={async () => {}}
        loadCandidates={async () => [{ ...who, id: uid(`${String(who.id)}-2`) }]}
        onClose={() => {}}
      />,
    )
  it('the roster line and the candidate of the picker', async () => {
    const r = mount(agent)
    expectEveryNameMarked(r.container)
    fireEvent.click(r.getByRole('button', { name: copy.channel.addMember }))
    await waitFor(() => expect(r.container.querySelector('.channel-management-panel__picker-option')).not.toBeNull())
    expectEveryNameMarked(r.container)
  })
  it('negative: the homonym person', () => {
    expectNoAgentMark(mount(person).container)
  })
})

// ── UserProfileDialog ────────────────────────────────────────────────────────────────────────────
describe('gate "agente sem marca" — UserProfileDialog', () => {
  const mount = (who: User) =>
    render(
      <UserProfileDialog
        userId={who.id}
        onLoadUserProfile={async () => ({ ...who }) as UserProfile}
        onGetPresence={() => 'online'}
        onClose={() => {}}
      />,
    )
  it('the agent profile: avatar, operator, never presence', async () => {
    const { container } = mount(agent)
    await waitFor(() => expect(container.querySelector('.user-profile__header')).not.toBeNull())
    expectEveryNameMarked(container)
    expect(container.querySelector('[data-agent-operator]')?.textContent).toBe(
      fill(copy.agent.operatedBy, { name: 'Alice Souza' }),
    )
    expect(container.querySelector('[data-presence]')).toBeNull()
  })
  it('negative: the homonym person', async () => {
    const { container } = mount(person)
    await waitFor(() => expect(container.querySelector('.user-profile__header')).not.toBeNull())
    expectNoAgentMark(container)
  })
})

// ── OS notification: the mark in text ────────────────────────────────────────────────────────────
describe('gate "agente sem marca" — OS notification (text)', () => {
  function harness(who: User) {
    const shown: string[] = []
    const env: NotifierEnv = {
      permission: () => 'granted',
      notify: (title) => {
        shown.push(title)
        return { onclick: null, close: () => {} }
      },
      isVisible: () => false,
      hasFocus: () => false,
      focusWindow: () => {},
      now: () => 0,
      setTimeout: () => 0,
      clearTimeout: () => {},
    }
    const dm = dmWith(who)
    const channels: Record<string, Channel> = { [CHANNEL.id]: CHANNEL, [dm.id]: dm }
    const notifier = createNotifier(
      {
        getChannel: (id) => channels[id],
        getSelectedId: () => undefined,
        select: () => {},
        jumpTo: () => {},
        getMembers: async () => [who, alice],
      },
      env,
    )
    return { notifier, shown, dm }
  }
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

  it('channel mention and DM: the title says "(agente)"', async () => {
    const { notifier, shown, dm } = harness(agent)
    const inChannel = message('$n1', AGENT_ID, { mentionsMe: true })
    notifier.handle({ t: 'message.received', channelId: CHANNEL.id, message: inChannel })
    notifier.handle({ t: 'message.received', channelId: dm.id, message: message('$n2', AGENT_ID, { channelId: dm.id }) })
    await flush()
    expect(shown).toEqual([
      fill(copy.notifications.titleDmAgent, { name: NAME }),
      fill(copy.notifications.titleInAgent, { author: NAME, channel: '#eng' }),
    ])
  })
  it('negative: the homonym person keeps the plain titles', async () => {
    const { notifier, shown, dm } = harness(person)
    notifier.handle({ t: 'message.received', channelId: CHANNEL.id, message: message('$n3', PERSON_ID, { mentionsMe: true }) })
    notifier.handle({ t: 'message.received', channelId: dm.id, message: message('$n4', PERSON_ID, { channelId: dm.id }) })
    await flush()
    expect(shown).toEqual([NAME, fill(copy.notifications.titleIn, { author: NAME, channel: '#eng' })])
  })
})
