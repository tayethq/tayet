// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, fireEvent, waitFor, within, act } from '@testing-library/react'
import { App } from '../../src/ui/App'
import { typeAndSend, editableIn } from '../support/editor'
import type {
  Acl,
  Channel,
  ChannelId,
  DomainEvent,
  Message,
  MessageId,
  PageCursor,
  User,
  UserId,
} from '../../src/acl'
import { copy } from '../support/copy'

// ADR-010×threads (PLANO-FASE-1-THREADS §4, commit 8): the optimistic echo of a thread send must
// appear in the THREAD panel (routed by threadParent), never in the main timeline, with the stable
// MessageId preserved. The UI never reconciles txn↔event — it just applies the domain delta the
// ACL emits. This drives App with a fake ACL that mimics the ACL's behavior: sendMessage with a
// thread opt emits a pending message.received carrying threadParent.

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
const root: Message = {
  id: mid('$root:tayet.local'),
  channelId: channel.id,
  author: me.id,
  body: { kind: 'text', text: 'thread root' },
  sentAt: tms(1),
  reactions: [],
  mine: true,
  mentionsMe: false,
}

function fakeAcl(): Acl {
  const channelHandlers = new Set<(e: DomainEvent) => void>()
  const noopUnsub = () => {}
  return {
    getChannels: async () => [channel],
    getArchivedChannels: async () => [],
    getChannel: async () => channel,
    getMembers: async () => [{ user: me, role: 'admin', state: 'active' as const, self: false }],
    getPresence: () => 'offline' as const,
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
    getTimeline: async (_id, opts) =>
      opts?.thread
        ? { items: [] as Message[], nextCursor: undefined as PageCursor | undefined }
        : { items: [root], nextCursor: undefined },
    subscribe: () => noopUnsub,
    subscribeChannel: (_id, handler) => {
      channelHandlers.add(handler)
      return () => channelHandlers.delete(handler)
    },
    // Mimic the ACL: a threaded send echoes a 'pending' message.received with threadParent set.
    sendMessage: async (_id, body, opts) => {
      const id = mid('txn-thread-1')
      if (opts?.thread && body.kind === 'text') {
        const echo: Message = {
          id,
          channelId: channel.id,
          author: me.id,
          body: { kind: 'text', text: body.text },
          sentAt: tms(2),
          reactions: [],
          threadParent: opts.thread,
          mine: true,
          mentionsMe: false,
          status: 'pending',
        }
        for (const h of channelHandlers) h({ t: 'message.received', channelId: channel.id, message: echo })
      }
      return id
    },
    answerApproval: async () => {},
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
    signOut: async () => {},
  }
}

afterEach(cleanup)

describe('optimistic thread echo (ADR-010×threads)', () => {
  it('routes the pending bubble into the thread panel, not the main timeline', async () => {
    const { container, findByText, getByLabelText } = render(<App acl={fakeAcl()} onSignOut={() => {}} />)

    // Root renders in the main timeline; open its thread.
    await findByText('thread root')
    fireEvent.click(getByLabelText(copy.timeline.replyInThread))

    const panel = (await findByText('Thread')).closest('.thread-panel') as HTMLElement
    expect(panel).toBeTruthy()

    // Compose into the thread (the panel's own composer — the WYSIWYG island).
    await act(async () => {
      typeAndSend(editableIn(panel), 'my reply')
    })

    // The pending echo appears INSIDE the thread panel…
    await waitFor(() => {
      expect(within(panel).getByText('my reply')).toBeTruthy()
      expect(within(panel).getByText(copy.timeline.sending)).toBeTruthy()
    })

    // …and NOT in the main timeline.
    const mainTimeline = container.querySelector('.timeline') as HTMLElement
    expect(within(mainTimeline).queryByText('my reply')).toBeNull()
  })
})
