// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import { App } from '../../src/ui/App'
import type {
  Acl,
  Channel,
  ChannelId,
  Message,
  MessageId,
  PageCursor,
  UserId,
} from '../../src/acl'
import { copy } from '../support/copy'

// Commit 11: scrollback wiring. getTimeline's first page carries a cursor; "Load older" fetches
// the older page and PREPENDS it (deduped). The cursor opacity is honoured end-to-end by the UI.

const cid = (s: string) => s as unknown as ChannelId
const mid = (s: string) => s as unknown as MessageId
const uid = (s: string) => s as unknown as UserId
const tms = (n: number) => n as unknown as Message['sentAt']

const channel: Channel = {
  id: cid('!c:tayet.local'),
  name: '#history',
  kind: 'public',
  memberCount: 1,
  unread: { count: 0, mentions: 0 },
}
const msg = (id: string, text: string): Message => ({
  id: mid(id),
  channelId: channel.id,
  author: uid('@me:tayet.local'),
  body: { kind: 'text', text },
  sentAt: tms(1),
  reactions: [],
  mine: true,
  mentionsMe: false,
})

// Minimal fake Acl: first getTimeline returns the recent page + a cursor; the cursored call
// returns the older page with no further cursor.
function fakeAcl(): Acl {
  const noopUnsub = () => {}
  return {
    getChannels: async () => [channel],
    getArchivedChannels: async () => [],
    getChannel: async () => channel,
    getMembers: async () => [],
    getPresence: () => 'offline' as const,
    getDevices: async () => [],
    currentUser: async () => ({ id: uid('@me:tayet.local'), displayName: 'Me', kind: 'member' }),
    getMyProfile: async () => ({ fullName: 'Me' }),
    getUserProfile: async (u) => ({ id: u, displayName: 'User', kind: 'member' }),
    updateMyProfile: async () => {},
    setAvatar: async () => { throw new Error('avatar verb not used in this test') },
    removeAvatar: async () => { throw new Error('avatar verb not used in this test') },
    getThreadUnread: async () => ({ unread: false }),
    searchMessages: async () => [],
    getMessage: async () => undefined,
    getTimeline: async (_id, opts) =>
      opts?.cursor
        ? { items: [msg('$old', 'older message')], nextCursor: undefined }
        : { items: [msg('$m2', 'recent two'), msg('$m3', 'recent three')], nextCursor: 'cur1' as unknown as PageCursor },
    subscribe: () => noopUnsub,
    subscribeChannel: () => noopUnsub,
    sendMessage: async () => mid('$x'),
    answerApproval: async () => {},
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

describe('scrollback (Load older)', () => {
  it('prepends the older page and hides the control when exhausted', async () => {
    render(<App acl={fakeAcl()} onSignOut={() => {}} />)

    // Recent page renders; the older message is not there yet.
    await screen.findByText('recent three')
    expect(screen.queryByText('older message')).toBeNull()

    // Load older → the older page is prepended.
    fireEvent.click(screen.getByText(copy.timeline.loadOlder))
    await screen.findByText('older message')

    // Cursor exhausted → the control disappears.
    await waitFor(() => expect(screen.queryByText(copy.timeline.loadOlder)).toBeNull())
  })
})
