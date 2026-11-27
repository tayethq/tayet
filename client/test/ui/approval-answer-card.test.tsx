// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, within, waitFor, act } from '@testing-library/react'
import { App } from '../../src/ui/App'
import { Timeline } from '../../src/ui/components/Timeline'
import { ThreadPanel } from '../../src/ui/components/ThreadPanel'
import type { Acl, Channel, DomainEvent, Message, MessageBody, MessageId, ChannelId, User, UserId } from '../../src/acl'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { copy } from '../support/copy'

// ADR-091 (Proposto) dec. 14, A3-2 — answering from the card (manifest workspace.md §17.1 items 4–6,
// §17.3): the buttons answer; "Enviando…" with the chosen option dimmed in a pill; "Não enviado" ·
// "Tentar de novo", which answers again with the same option; focus moves to the card's group when the
// clicked control goes away; the footer becomes a polite live region only after the viewer's own click.
// Then useChat → acl.answerApproval through the App, and the thread's replies.

const uid = (s: string): UserId => s as unknown as UserId
const mid = (s: string): MessageId => s as unknown as MessageId
const cid = (s: string): ChannelId => s as unknown as ChannelId
const tms = (n: number) => n as unknown as Message['sentAt']

const AGENT: User = { id: uid('@a-abcdefghijkl:tayet.local'), displayName: 'Publicação', kind: 'agent', agentColor: 'ardosia' }
const ME: User = { id: uid('@me:tayet.local'), displayName: 'Marina', kind: 'member' }
const usersById: Record<string, User> = { [AGENT.id]: AGENT, [ME.id]: ME }

type Approval = Extract<MessageBody, { kind: 'approval' }>
const OPTIONS: Approval['options'] = [
  { id: 'approve', label: 'Aprovar', style: 'primary' },
  { id: 'later', label: 'Depois' },
  { id: 'reject', label: 'Rejeitar', style: 'danger' },
]
const channel: Channel = { id: cid('!r:tayet.local'), name: '#r', kind: 'public', memberCount: 2, unread: { count: 0, mentions: 0 } }
const card = (state: Approval['state'], over: Partial<Message> = {}): Message => ({
  id: mid('$card'),
  channelId: channel.id,
  author: AGENT.id,
  body: { kind: 'approval', text: 'Publicar a versão 2.4?', options: OPTIONS, state },
  sentAt: tms(1_000),
  reactions: [],
  mine: false,
  mentionsMe: false,
  ...over,
})

afterEach(cleanup)

const mount = (m: Message, onAnswer?: (message: Message, option: string) => void) =>
  render(<Timeline messages={[m]} usersById={usersById} selfId={ME.id} onAnswer={onAnswer} />)

describe('ApprovalCard — answering (§17.1 items 4–6)', () => {
  it('pending with the handler: the buttons are enabled; a click answers with that option, once', () => {
    const onAnswer = vi.fn()
    const m = card({ kind: 'open' })
    const { getByRole } = mount(m, onAnswer)
    const group = getByRole('group', { name: copy.approval.title })
    const buttons = within(group).getAllByRole('button')
    expect(buttons.every((b) => !(b as HTMLButtonElement).disabled)).toBe(true)
    fireEvent.click(within(group).getByRole('button', { name: 'Depois' }))
    expect(onAnswer).toHaveBeenCalledTimes(1)
    expect(onAnswer).toHaveBeenCalledWith(m, 'later')
  })

  it('the click moves focus to the card’s group and turns the footer into a polite live region; the next state keeps the focus', () => {
    const m = card({ kind: 'open' })
    const { getByRole, rerender, container } = mount(m, () => {})
    const group = getByRole('group', { name: copy.approval.title })
    const slot = container.querySelector('.approval__slot')!
    // Before the viewer's own click nothing is announced (a card resolving on load stays quiet).
    expect(slot.hasAttribute('aria-live')).toBe(false)
    fireEvent.click(within(group).getByRole('button', { name: 'Aprovar' }))
    expect(document.activeElement).toBe(group)
    expect(group.getAttribute('tabindex')).toBe('-1')
    expect(slot.getAttribute('aria-live')).toBe('polite')
    expect(slot.getAttribute('aria-atomic')).toBe('true')
    // The ACL's sending state replaces the buttons: the focus stays on the group, not on <body>.
    rerender(<Timeline messages={[card({ kind: 'sending', option: 'approve' })]} usersById={usersById} selfId={ME.id} onAnswer={() => {}} />)
    expect(document.activeElement).toBe(getByRole('group', { name: copy.approval.title }))
    expect(container.querySelector('.approval__slot')?.getAttribute('aria-live')).toBe('polite')
  })

  it('sending: the chosen option in a dimmed pill + "Enviando…"; no buttons', () => {
    const { container } = mount(card({ kind: 'sending', option: 'reject' }), () => {})
    const pill = container.querySelector('.approval__pill')!
    expect(pill.textContent).toBe('Rejeitar')
    expect(pill.classList.contains('approval__pill--sending')).toBe(true)
    expect(container.querySelector('.approval__by')?.textContent).toBe(copy.timeline.sending)
    expect(container.querySelectorAll('.approval button')).toHaveLength(0)
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  it('not sent: muted pill, "Não enviado" in danger · separator · "Tentar de novo" answers again with the same option', () => {
    const onAnswer = vi.fn()
    const m = card({ kind: 'failed', option: 'approve' })
    const { container, getByRole } = mount(m, onAnswer)
    const pill = container.querySelector('.approval__pill')!
    expect(pill.textContent).toBe('Aprovar')
    expect(pill.classList.contains('approval__pill--failed')).toBe(true)
    expect(container.querySelector('.approval .message__status--failed')?.textContent).toBe(copy.timeline.failed)
    const retry = within(getByRole('group', { name: copy.approval.title })).getByRole('button', { name: copy.timeline.retry })
    expect(retry.className).toBe('message__retry-inline')
    expect(container.querySelectorAll('.approval button')).toHaveLength(1)
    fireEvent.click(retry)
    expect(onAnswer).toHaveBeenCalledWith(m, 'approve')
    expect(document.activeElement).toBe(getByRole('group', { name: copy.approval.title }))
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  it('not sent without a handler: no retry offered', () => {
    const { container } = mount(card({ kind: 'failed', option: 'approve' }))
    expect(container.querySelectorAll('.approval button')).toHaveLength(0)
  })

  it('in the thread: the root card and a card among the replies both answer (§18 item 7)', () => {
    const onAnswer = vi.fn()
    const root = card({ kind: 'open' })
    const reply = card({ kind: 'open' }, { id: mid('$c2'), threadParent: root.id })
    const { container } = render(
      <ThreadPanel root={root} messages={[reply]} usersById={usersById} onClose={() => {}} onSend={() => {}} onAnswer={onAnswer} />,
    )
    const cards = container.querySelectorAll('.thread-panel .approval')
    expect(within(cards[0] as HTMLElement).getAllByRole('button').every((b) => !(b as HTMLButtonElement).disabled)).toBe(true)
    fireEvent.click(within(cards[0] as HTMLElement).getByRole('button', { name: 'Aprovar' }))
    expect(onAnswer).toHaveBeenLastCalledWith(root, 'approve')
    fireEvent.click(within(cards[1] as HTMLElement).getByRole('button', { name: 'Aprovar' }))
    expect(onAnswer).toHaveBeenLastCalledWith(reply, 'approve')
  })
})

// ── Through the App: useChat hands the click to acl.answerApproval; the card follows the ACL's emits ──
function fakeAcl(initial: Message, answer: Acl['answerApproval']): { acl: Acl; emit: (m: Message) => void } {
  const channelSubs: Array<(e: DomainEvent) => void> = []
  const noop = async (): Promise<void> => {}
  const emit = (m: Message): void => {
    for (const h of channelSubs) h({ t: 'message.edited', channelId: channel.id, message: m })
  }
  const acl: Acl = {
    getChannels: async () => [channel],
    getArchivedChannels: async () => [],
    getChannel: async () => channel,
    getTimeline: async () => ({ items: [initial] }),
    getMembers: async () => [{ user: ME, role: 'admin' as const, state: 'active' as const, self: true }],
    getPresence: () => 'offline' as const,
    getConnectionState: () => 'connecting' as const,
    getChannelAbilities: () => ({ rename: false, editTopic: false, addPeople: false, removePeople: false, setRoles: false, archive: false }),
    getDevices: async () => [],
    currentUser: async () => ME,
    getMyProfile: async () => ({ fullName: ME.displayName }),
    getUserProfile: async (u) => ({ id: u, displayName: 'User', kind: 'member' }),
    updateMyProfile: async () => {},
    setAvatar: async () => {
      throw new Error('unused')
    },
    removeAvatar: async () => {
      throw new Error('unused')
    },
    getAccountPreferences: async () => ({}),
    setAccountPreferences: async () => {},
    getThreadUnread: async () => ({ unread: false }),
    searchMessages: async () => [],
    getMessage: async () => undefined,
    subscribe: () => () => {},
    subscribeChannel: (_id, h) => {
      channelSubs.push(h)
      return () => {
        const i = channelSubs.indexOf(h)
        if (i >= 0) channelSubs.splice(i, 1)
      }
    },
    sendMessage: async () => mid('x'),
    answerApproval: answer,
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
      throw new Error('unused')
    },
    archiveChannel: noop,
    unarchiveChannel: noop,
    updateChannel: noop,
    leaveChannel: noop,
    addMember: noop,
    removeMember: noop,
    setRole: noop,
    openDirectMessage: async () => {
      throw new Error('unused')
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
    listOwnAgents: () => [],
    isOrgAdmin: async () => false,
    invitePerson: () => Promise.reject(new Error('unused')),
    removePerson: noop,
    createAgent: () => Promise.reject(new Error('unused')),
    updateAgent: noop,
    reissueAgent: () => Promise.reject(new Error('unused')),
    removeAgent: noop,
    getOrgAccess: () => Promise.reject(new Error('unused')),
    setOrgAdmin: noop,
    enableDeviceNotifications: noop,
    disableDeviceNotifications: noop,
    resolveNotificationTarget: async () => undefined,
    signOut: noop,
  }
  return { acl, emit }
}

describe('useChat → acl.answerApproval (App)', () => {
  it('the click calls the verb with the card and the option; a rejection is swallowed; the retry calls it again', async () => {
    const initial = card({ kind: 'open' })
    let emit: (m: Message) => void = () => {}
    const answer = vi.fn(async (_id: MessageId, option: string) => {
      emit(card({ kind: 'sending', option }))
      emit(card({ kind: 'failed', option }))
      throw new Error('offline')
    })
    const fake = fakeAcl(initial, answer)
    emit = fake.emit
    const { findByRole, container } = render(<App acl={fake.acl} onSignOut={() => {}} />)
    fireEvent.click(await findByRole('button', { name: 'Aprovar' }))
    expect(answer).toHaveBeenCalledWith(initial.id, 'approve')
    await waitFor(() => expect(container.querySelector('.approval .message__status--failed')).not.toBeNull())
    fireEvent.click(await findByRole('button', { name: copy.timeline.retry }))
    expect(answer).toHaveBeenCalledTimes(2)
    expect(answer.mock.calls[1]).toEqual([initial.id, 'approve'])
    // One line: the card. The send never became a row of its own.
    expect(container.querySelectorAll('.message')).toHaveLength(1)
  })
})

describe('the root card in the thread panel (App, A3-2 rodada 2)', () => {
  it('pending with active buttons; click → sending → answered, in the panel', async () => {
    const initial = card({ kind: 'open' }, { threadSummary: { replyCount: 1, latestReplyAt: tms(2_000) } })
    let emit: (m: Message) => void = () => {}
    let accept: () => void = () => {}
    const answer = vi.fn(
      (_id: MessageId, option: string) =>
        new Promise<void>((resolve) => {
          emit(card({ kind: 'sending', option }, { threadSummary: initial.threadSummary }))
          accept = () => {
            emit(card({ kind: 'answered', by: ME.id, at: tms(3_000), option }, { threadSummary: initial.threadSummary }))
            resolve()
          }
        }),
    )
    const fake = fakeAcl(initial, answer)
    emit = fake.emit
    const { findByLabelText, container } = render(<App acl={fake.acl} onSignOut={() => {}} />)
    fireEvent.click(await findByLabelText(copy.timeline.replyInThread))
    const panel = await waitFor(() => {
      const el = container.querySelector('.thread-panel')
      if (!el) throw new Error('no panel')
      return el as HTMLElement
    })
    const rootCard = () => panel.querySelector('.thread-panel__root .approval') as HTMLElement
    const approve = within(rootCard()).getByRole('button', { name: 'Aprovar' }) as HTMLButtonElement
    expect(approve.disabled).toBe(false)
    fireEvent.click(approve)
    expect(answer).toHaveBeenCalledWith(initial.id, 'approve')
    await waitFor(() => expect(rootCard().querySelector('.approval__by')?.textContent).toBe(copy.timeline.sending))
    expect(rootCard().querySelector('.approval__pill--sending')?.textContent).toBe('Aprovar')
    act(() => accept())
    await waitFor(() => expect(rootCard().querySelector('.approval__pill--sending')).toBeNull())
    expect(rootCard().querySelector('.approval__pill')?.textContent).toBe('Aprovar')
    expect(rootCard().querySelectorAll('button')).toHaveLength(0)
  })
})
