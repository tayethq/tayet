// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, waitFor, act } from '@testing-library/react'
import { App } from '../../src/ui/App'
import { typeAndSend, editableIn } from '../support/editor'
import type {
  Acl,
  Channel,
  ChannelId,
  DomainEvent,
  Message,
  MessageId,
  SendOpts,
  User,
  UserId,
} from '../../src/acl'
import { copy } from '../support/copy'

// Reply compose flow (PLANO-FASE-1-REPLY commit 6): clicking Reply puts the composer in reply mode
// (indicator + cancel); sending passes ONLY the stable MessageId via SendOpts.replyTo (the UI
// never names a relation — ADR-011); the optimistic echo the ACL emits (already carrying replyTo,
// commit 3) renders with the quoted preview; clicking a loaded preview scrolls to the target.
// Driven through App with a fake ACL mimicking the real one's echo behavior.

const cid = (s: string): ChannelId => s as unknown as ChannelId
const uid = (s: string): UserId => s as unknown as UserId
const mid = (s: string): MessageId => s as unknown as MessageId
const tms = (n: number) => n as unknown as Message['sentAt']

const me: User = { id: uid('@me:tayet.local'), displayName: 'Me', kind: 'member' }
const channel: Channel = {
  id: cid('!r:tayet.local'),
  name: '#engineering',
  kind: 'public',
  memberCount: 1,
  unread: { count: 0, mentions: 0 },
}
const target: Message = {
  id: mid('$target:tayet.local'),
  channelId: channel.id,
  author: me.id,
  body: { kind: 'text', text: 'the original question' },
  sentAt: tms(1),
  reactions: [],
  mine: true,
  mentionsMe: false,
}

function fakeAcl(): { acl: Acl; sendOpts: () => Array<SendOpts | undefined> } {
  const channelHandlers = new Set<(e: DomainEvent) => void>()
  const sends: Array<SendOpts | undefined> = []
  const noopUnsub = () => {}
  const acl: Acl = {
    getChannels: async () => [channel],
    getArchivedChannels: async () => [],
    getChannel: async () => channel,
    getMembers: async () => [{ user: me, role: 'admin', state: 'active' as const, self: false }],
    getPresence: () => 'offline' as const,
    getConnectionState: () => 'connecting' as const,
    getChannelAbilities: () => ({ rename: false, editTopic: false, addPeople: false, removePeople: false, setRoles: false, archive: false }),
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
    getTimeline: async () => ({ items: [target], nextCursor: undefined }),
    subscribe: () => noopUnsub,
    subscribeChannel: (_id, handler) => {
      channelHandlers.add(handler)
      return () => channelHandlers.delete(handler)
    },
    // Mimic the real ACL (commit 3): a reply send echoes a 'pending' message.received whose
    // replyTo is already populated (the pending event carries the sent relation).
    sendMessage: async (_id, body, opts) => {
      sends.push(opts)
      const id = mid('txn-reply-1')
      if (body.kind === 'text') {
        const echo: Message = {
          id,
          channelId: channel.id,
          author: me.id,
          body: { kind: 'text', text: body.text },
          sentAt: tms(2),
          reactions: [],
          replyTo: opts?.replyTo,
          mine: true,
          mentionsMe: false,
          status: 'pending',
        }
        for (const h of channelHandlers) h({ t: 'message.received', channelId: channel.id, message: echo })
      }
      return id
    },
    answerApproval: async () => {},
    watchAwaitingApprovals: () => () => {},
    submitForm: async () => ({ ok: true }),
    closeForm: () => {},
    listPanels: async () => [],
    listCommands: async () => [],
    editMessage: async () => {},
    deleteMessage: async () => {},
    react: async () => {},
    removeReaction: async () => {},
    markRead: async () => {},
    acknowledgeAccess: () => {},
    resetAccess: async () => ({ t: 'done', historyPreserved: true }),
    resolveMedia: async () => ({ url: '', release: () => {} }),
    exportMyData: () => (async function* () {})(),
    resolveChannel: async () => ({ ok: false, reason: 'not-found' }),
    resolveUser: async () => ({ ok: false, reason: 'not-found' }),
createChannel: async () => { throw new Error('membership verb not used in this test') },
    archiveChannel: async () => {},
    unarchiveChannel: async () => {},
    updateChannel: async () => {},
    leaveChannel: async () => {},
    addMember: async () => {},
    removeMember: async () => {},
    setRole: async () => {},
    openDirectMessage: async () => { throw new Error('membership verb not used in this test') },
    openGroupConversation: async () => {
      throw new Error('group verb not used in this test')
    },
    convertToChannel: async () => {
      throw new Error('group verb not used in this test')
    },
    connect: async () => {},
    disconnect: async () => {},
    listPeople: async () => [],
    listOwnAgents: () => [],
    isOrgAdmin: async () => false,
    invitePerson: () => Promise.reject(new Error('unused')),
    removePerson: async () => {},
    createAgent: () => Promise.reject(new Error('not wired')),
    updateAgent: async () => {},
    reissueAgent: () => Promise.reject(new Error('not wired')),
    removeAgent: async () => {},
    getOrgAccess: () => Promise.reject(new Error('unused')),
    setOrgAdmin: async () => {},
    enableDeviceNotifications: async () => {},
    disableDeviceNotifications: async () => {},
    resolveNotificationTarget: async () => undefined,
    signOut: async () => {},
  }
  return { acl, sendOpts: () => sends }
}

afterEach(cleanup)

describe('reply compose flow', () => {
  it('reply mode → SendOpts.replyTo → echo renders with the quoted preview; cancel works', async () => {
    const { acl, sendOpts } = fakeAcl()
    const { container, findByText, getByText, getByLabelText, queryByText } = render(<App acl={acl} onSignOut={() => {}} />)

    await findByText('the original question')

    // Enter reply mode: the composer shows the indicator with the target's clean excerpt.
    fireEvent.click(getByLabelText(copy.timeline.reply))
    expect(getByText(copy.composer.replyingTo)).toBeTruthy()
    expect((container.querySelector('.composer__reply-excerpt') as HTMLElement).textContent).toBe(
      'the original question',
    )

    // Cancel leaves reply mode…
    fireEvent.click(getByLabelText(copy.composer.cancelReply))
    expect(queryByText(copy.composer.replyingTo)).toBeNull()

    // …and re-entering + sending passes ONLY the stable id via SendOpts.replyTo.
    fireEvent.click(getByLabelText(copy.timeline.reply))
    await act(async () => {
      typeAndSend(editableIn(container), 'my answer')
    })

    await waitFor(() => expect(sendOpts()).toEqual([{ replyTo: target.id }]))
    // Reply mode is left after sending.
    expect(queryByText(copy.composer.replyingTo)).toBeNull()

    // The optimistic echo (replyTo already populated by the ACL) renders with the quoted preview.
    await findByText('my answer')
    const quote = container.querySelector('button.message__quote') as HTMLElement
    expect(quote).toBeTruthy()
    expect(quote.textContent).toContain('the original question')

    // Clicking the loaded preview scrolls to the target row.
    const scrolled = vi.fn()
    window.HTMLElement.prototype.scrollIntoView = scrolled
    fireEvent.click(quote)
    expect(scrolled).toHaveBeenCalled()
  })
})
