// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, act, waitFor, within } from '@testing-library/react'
import { App } from '../../src/ui/App'
import type {
  Acl,
  Channel,
  ChannelId,
  DomainEvent,
  Message,
  MessageId,
  MediaRef,
  PageCursor,
  User,
  UserId,
} from '../../src/acl'
import { copy } from '../support/copy'

// PLANO-FASE-1-UPLOAD §3 (commit 5, the novel variable): the optimistic attachment bubble. The ACL
// emits a 'pending' message.received with a LOCAL MediaRef the instant the user sends — preview +
// indeterminate "Sending…" — under a stable id; message.status settles it without re-keying; a
// 'failed' send offers Retry that re-runs upload+send. The UI never reconciles txn↔event. Driven by
// a fake ACL that mimics the gateway's emit behavior.

const cid = (s: string): ChannelId => s as unknown as ChannelId
const uid = (s: string): UserId => s as unknown as UserId
const mid = (s: string): MessageId => s as unknown as MessageId
const ref = (s: string): MediaRef => s as unknown as MediaRef
const tms = (n: number) => n as unknown as Message['sentAt']

const me: User = { id: uid('@me:tayet.local'), displayName: 'Me', kind: 'member' }
const channel: Channel = {
  id: cid('!r:tayet.local'),
  name: '#engineering',
  kind: 'public',
  memberCount: 1,
  unread: { count: 0, mentions: 0 },
}

function fakeAcl() {
  const channelHandlers = new Set<(e: DomainEvent) => void>()
  const noopUnsub = () => {}
  let sendCount = 0
  let lastId: MessageId | undefined
  const emit = (e: DomainEvent): void => {
    for (const h of channelHandlers) h(e)
  }
  const acl: Acl = {
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
    getTimeline: async () => ({ items: [] as Message[], nextCursor: undefined as PageCursor | undefined }),
    subscribe: () => noopUnsub,
    subscribeChannel: (_id, handler) => {
      channelHandlers.add(handler)
      return () => channelHandlers.delete(handler)
    },
    // Mimic the gateway: an attachment send emits a 'pending' message.received with a LOCAL ref
    // (image body) synchronously, then resolves with the stable id.
    sendMessage: vi.fn(async (_id, body) => {
      if (body.kind === 'attachment') {
        sendCount += 1
        const id = mid(`txn-att-${sendCount}`)
        lastId = id
        emit({
          t: 'message.received',
          channelId: channel.id,
          message: {
            id,
            channelId: channel.id,
            author: me.id,
            body: { kind: 'image', media: ref(`mrl_${sendCount}`), alt: 'pixel.png' },
            sentAt: tms(sendCount + 1),
            reactions: [],
            mine: true,
            mentionsMe: false,
            status: 'pending',
          },
        })
        return id
      }
      return mid('txn-text')
    }),
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
    resolveMedia: async () => ({ url: 'blob:local/preview', release: () => {} }),
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
  return {
    acl,
    emitStatus: (id: MessageId, status: 'sent' | 'failed') =>
      act(() => emit({ t: 'message.status', channelId: channel.id, messageId: id, status })),
    lastId: () => lastId,
    sendMessage: acl.sendMessage as ReturnType<typeof vi.fn>,
  }
}

function pickFile(container: HTMLElement, name = 'pixel.png') {
  const input = container.querySelector('.composer__file') as HTMLInputElement
  const file = new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' })
  fireEvent.change(input, { target: { files: [file] } })
  return file
}

afterEach(cleanup)

describe('optimistic attachment bubble (ADR-010)', () => {
  it('shows an instant pending preview, then settles to sent under the same id (no flicker)', async () => {
    const f = fakeAcl()
    const { container, findByRole, findByText, queryByText } = render(<App acl={f.acl} onSignOut={() => {}} />)
    await waitFor(() => expect(container.querySelector('.composer__file')).toBeTruthy())

    pickFile(container)

    // Instant optimistic bubble: the LOCAL preview (resolved object URL) + the indeterminate
    // "Sending…" status, before any upload completes.
    const img = (await findByRole('img')) as HTMLImageElement
    expect(img.getAttribute('src')).toBe('blob:local/preview')
    expect(await findByText(copy.timeline.sending)).toBeTruthy()
    expect(container.querySelector('.message__spinner')).toBeNull()

    // Settle: message.status 'sent' clears the indicator; the preview stays (same stable id).
    f.emitStatus(f.lastId()!, 'sent')
    await waitFor(() => expect(queryByText(copy.timeline.sending)).toBeNull())
    expect((container.querySelector('img') as HTMLImageElement).getAttribute('src')).toBe('blob:local/preview')
  })

  it('a failed attachment offers Retry that re-runs upload+send', async () => {
    const f = fakeAcl()
    const { container, findByText, getByRole } = render(<App acl={f.acl} onSignOut={() => {}} />)
    await waitFor(() => expect(container.querySelector('.composer__file')).toBeTruthy())

    pickFile(container)
    await findByText(copy.timeline.sending)
    expect(f.sendMessage).toHaveBeenCalledTimes(1)

    f.emitStatus(f.lastId()!, 'failed')
    await findByText(copy.timeline.failed)

    fireEvent.click(getByRole('button', { name: copy.timeline.retry }))

    // Retry re-sent the attachment (a fresh send) — the ACL was asked to upload+send again.
    await waitFor(() => expect(f.sendMessage).toHaveBeenCalledTimes(2))
    const lastCall = f.sendMessage.mock.calls.at(-1)!
    expect(lastCall[1]).toMatchObject({ kind: 'attachment' })
    // A fresh pending bubble is shown; the old failed one is gone.
    expect(within(container).queryByText(copy.timeline.failed)).toBeNull()
  })
})
