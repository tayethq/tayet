// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { ThreadPanel } from '../../src/ui/components/ThreadPanel'
import type { Message, User, ChannelId, UserId, MessageId } from '../../src/acl'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { copy } from '../support/copy'

// P1 gate #2 for threads (PLANO-FASE-1-THREADS §5.2): the thread panel is a NEW P1 surface. Mount
// it with fixtures whose ids carry REAL protocol shapes (the ADR-008 residual: the runtime id value
// IS the protocol id, and threadParent is a protocol-shaped event id) and scan the rendered DOM. If
// any component ever rendered an id/author/threadParent or leaked an m.thread/rel_type, the scan
// turns red. Clean fields (display names, text) must still render.

const cid = (s: string): ChannelId => s as unknown as ChannelId
const uid = (s: string): UserId => s as unknown as UserId
const mid = (s: string): MessageId => s as unknown as MessageId
const tms = (n: number) => n as unknown as Message['sentAt']

afterEach(cleanup)

describe('Thread panel DOM render-scan (P1 on screen)', () => {
  const alice: User = { id: uid('@alice:tayet.local'), displayName: 'Alice Anderson', kind: 'member' }
  const bob: User = { id: uid('@bob:tayet.local'), displayName: 'Bob Brown', kind: 'member' }
  const usersById: Record<string, User> = { [alice.id]: alice, [bob.id]: bob }
  const channelId = cid('!engineering:tayet.local')

  const root: Message = {
    id: mid('$root:tayet.local'),
    channelId,
    author: alice.id,
    body: { kind: 'text', text: 'Should we ship on Friday?' },
    sentAt: tms(1),
    reactions: [],
    mine: false,
    mentionsMe: false,
  }
  // Replies carry a protocol-shaped threadParent (the root's id) — must NOT reach the DOM.
  const replies: Message[] = [
    {
      id: mid('$r1:tayet.local'),
      channelId,
      author: bob.id,
      body: { kind: 'text', text: 'Yes, lets do it' },
      sentAt: tms(2),
      reactions: [],
      threadParent: root.id,
      mine: false,
      mentionsMe: false,
    },
    {
      id: mid('$r2:tayet.local'),
      channelId,
      author: alice.id,
      body: { kind: 'text', text: 'Agreed' },
      sentAt: tms(3),
      editedAt: tms(4),
      reactions: [],
      threadParent: root.id,
      mine: false,
      mentionsMe: false,
      status: 'pending',
    },
  ]

  it('renders root + replies and leaks NO protocol shape into the DOM', () => {
    const { container } = render(
      <ThreadPanel
        root={root}
        messages={replies}
        usersById={usersById}
        unread={{ unread: true }}
        onClose={() => {}}
        onSend={() => {}}
        onOpenProfile={() => {}}
      />,
    )

    const text = container.textContent ?? ''
    // Positive controls: clean, user-facing content IS on screen.
    expect(text).toContain('Thread')
    expect(text).toContain('Should we ship on Friday?') // root
    expect(text).toContain('Bob Brown') // reply author
    expect(text).toContain('Yes, lets do it') // reply
    expect(text).toContain(copy.timeline.edited)
    // Per-thread unread (ADR-067): a dot named "Unread replies", no number.
    expect(container.querySelector(`[aria-label="${copy.thread.unreadReplies}"]`)?.textContent).toBe('')

    // Grouped layout parity with the main timeline: the group-start row carries a wall-clock
    // timestamp (absent in the old flat author-per-message layout).
    expect(container.querySelector('.message__timestamp')).toBeTruthy()

    // P1 gate: the full rendered HTML (incl. attributes) carries no mxid/room-id/event-id/mxc/
    // m.room.* and no leaked relation (m.thread/rel_type). The protocol-shaped threadParent must
    // never surface.
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })
})
