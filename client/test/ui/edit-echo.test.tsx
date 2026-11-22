// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { App } from '../../src/ui/App'
import type {
  Acl,
  Channel,
  DomainEvent,
  Message,
  User,
  UserId,
  MessageId,
  ChannelId,
} from '../../src/acl'
import { copy } from '../support/copy'

// Commit 8 (ADR-010 × edit): the optimistic edit reconciles IN PLACE under the same stable id — one
// bubble, no re-key, no duplicate. We drive useChat with a fake ACL whose editMessage echoes a
// message.edited (as the real ACL does optimistically) and assert the rendered bubble updates.
//
// ADR-051 PR-5b: the edit surface is now the WYSIWYG island (no <input>). This App-level test drives
// the rich editor by clicking Edit → Save; the seed carries the original FORMATTED body, and Save
// re-emits it — proving the reconcile AND that editing keeps formatting (does not flatten to plain).

const uid = (s: string): UserId => s as unknown as UserId
const mid = (s: string): MessageId => s as unknown as MessageId
const cid = (s: string): ChannelId => s as unknown as ChannelId
const tms = (n: number) => n as unknown as Message['sentAt']

const me: User = { id: uid('@me:tayet.local'), displayName: 'Me', kind: 'member' }
const channel: Channel = {
  id: cid('!r:tayet.local'),
  name: '#r',
  kind: 'public',
  memberCount: 1,
  unread: { count: 0, mentions: 0 },
}

afterEach(cleanup)

function fakeAcl(initial: Message): Acl {
  const channelSubs: Array<(e: DomainEvent) => void> = []
  let store: Message[] = [initial]
  const noop = async (): Promise<void> => {}
  return {
    getChannels: async () => [channel],
    getArchivedChannels: async () => [],
    getChannel: async () => channel,
    getTimeline: async () => ({ items: store }),
    getMembers: async () => [{ user: me, role: 'admin' as const, state: 'active' as const, self: false }],
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
    subscribe: () => () => {},
    subscribeChannel: (_id, h) => {
      channelSubs.push(h)
      return () => {
        const i = channelSubs.indexOf(h)
        if (i >= 0) channelSubs.splice(i, 1)
      }
    },
    sendMessage: async () => mid('x'),
    answerApproval: async () => {},
    submitForm: async () => ({ ok: true }),
    closeForm: () => {},
    listPanels: async () => [],
    listCommands: async () => [],
    editMessage: async (messageId, body) => {
      if (body.kind !== 'text') return
      const prev = store.find((m) => m.id === messageId)!
      const edited: Message = {
        ...prev,
        body: { kind: 'text', text: body.text, ...(body.rich ? { rich: body.rich } : {}) },
        editedAt: tms(99),
      }
      store = store.map((m) => (m.id === messageId ? edited : m))
      for (const h of channelSubs) h({ t: 'message.edited', channelId: channel.id, message: edited })
    },
    deleteMessage: async () => {},
    react: noop,
    removeReaction: noop,
    markRead: noop,
    acknowledgeAccess: noop,
    resetAccess: async () => ({ t: 'done', historyPreserved: true }),
    resolveMedia: async () => ({ url: '', release: () => {} }),
    exportMyData: () => (async function* () {})(),
    resolveChannel: async () => ({ ok: false, reason: 'not-found' as const }),
    resolveUser: async () => ({ ok: false, reason: 'not-found' as const }),
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
    connect: noop,
    disconnect: noop,
    listPeople: async () => [],
    listOwnAgents: () => [],
    isOrgAdmin: async () => false,
    invitePerson: () => Promise.reject(new Error('unused')),
    removePerson: async () => {},
    createAgent: () => Promise.reject(new Error('not wired')),
    updateAgent: async () => {},
    reissueAgent: () => Promise.reject(new Error('not wired')),
    removeAgent: async () => {},
    signOut: noop,
  }
}

describe('optimistic edit reconciles in place (ADR-010 × edit)', () => {
  it('re-saves my FORMATTED message; the SAME bubble stays rich, marked (edited), no duplicate', async () => {
    const rich: Message['body'] = {
      kind: 'text',
      text: 'stays bold',
      rich: [{ t: 'p', children: [{ t: 'strong', children: [{ t: 'text', text: 'stays bold' }] }] }],
    }
    const original: Message = {
      id: mid('$m1:tayet.local'),
      channelId: channel.id,
      author: me.id,
      body: rich,
      sentAt: tms(1),
      reactions: [],
      mine: true,
      mentionsMe: false,
      status: 'sent',
    }
    const { findByText, getByRole, getByText, getByLabelText, container } = render(
      <App acl={fakeAcl(original)} onSignOut={() => {}} />,
    )

    await findByText('stays bold')
    // Open the WYSIWYG edit surface, seeded with the bold body, then Save (no manual change — jsdom
    // cannot type into a contenteditable; the seed IS the content the round trip preserves).
    fireEvent.click(getByLabelText(copy.timeline.editMessage))
    fireEvent.click(getByRole('button', { name: copy.composer.editSave }))

    // The bubble still shows the rich content (NOT flattened), now marked (edited)…
    await waitFor(() => expect(getByText(copy.timeline.edited)).toBeTruthy())
    expect(container.querySelector('.message strong')?.textContent).toBe('stays bold')
    // …and there is still exactly ONE message bubble (reconciled in place, no re-key/duplicate).
    expect(container.querySelectorAll('.message')).toHaveLength(1)
    // The edit surface is gone (Save torn it down).
    expect(container.querySelector('.composer--edit')).toBeNull()
  })
})
