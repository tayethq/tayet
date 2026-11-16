// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { Workspace } from '../../src/ui/components/Workspace'
import type { Channel, ChannelId, Message, MessageId, User, UserId } from '../../src/acl'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { copy } from '../support/copy'

// P1 gate for the reply slice (PLANO-FASE-1-REPLY §5.1): the QUOTED PREVIEW is a new P1 surface — it
// renders content derived from ANOTHER message, so it gets its own DOM render-scan. Fixtures
// carry real protocol shapes in the opaque ids (ADR-008 residual) and a replyTo relation; the
// scan (extended with mx-reply + m.in_reply_to) sweeps the full innerHTML. Covers the loaded
// preview (incl. a RICH target), the DEGRADED preview (target outside the loaded window), and
// the composer in reply mode.

const cid = (s: string): ChannelId => s as unknown as ChannelId
const uid = (s: string): UserId => s as unknown as UserId
const mid = (s: string): MessageId => s as unknown as MessageId
const tms = (n: number) => n as unknown as Message['sentAt']

afterEach(cleanup)

const alice: User = { id: uid('@alice:tayet.local'), displayName: 'Alice Anderson', kind: 'member' }
const bob: User = { id: uid('@bob:tayet.local'), displayName: 'Bob Brown', kind: 'member' }
const usersById: Record<string, User> = { [alice.id]: alice, [bob.id]: bob }
const channel: Channel = {
  id: cid('!engineering:tayet.local'),
  name: '#engineering',
  kind: 'public',
  memberCount: 2,
  unread: { count: 0, mentions: 0 },
}

// The reply target carries RICH content (the preview must stay clean for a rich target too).
const target: Message = {
  id: mid('$target:tayet.local'),
  channelId: channel.id,
  author: alice.id,
  body: {
    kind: 'text',
    text: 'shall we **ship** it?',
    rich: [
      {
        t: 'p',
        children: [
          { t: 'text', text: 'shall we ' },
          { t: 'strong', children: [{ t: 'text', text: 'ship' }] },
          { t: 'text', text: ' it?' },
        ],
      },
    ],
  },
  sentAt: tms(1),
  reactions: [],
  mine: false,
  mentionsMe: false,
}
// A reply whose target IS loaded → full quoted preview (protocol-shaped replyTo stays opaque).
const reply: Message = {
  id: mid('$reply:tayet.local'),
  channelId: channel.id,
  author: bob.id,
  body: { kind: 'text', text: 'yes, ship it' },
  sentAt: tms(2),
  reactions: [],
  replyTo: target.id,
  mine: false,
  mentionsMe: false,
}
// A reply whose target is OUTSIDE the loaded window → degraded preview.
const degraded: Message = {
  id: mid('$degraded:tayet.local'),
  channelId: channel.id,
  author: bob.id,
  body: { kind: 'text', text: 'answering something old' },
  sentAt: tms(3),
  reactions: [],
  replyTo: mid('$outside-the-window:tayet.local'),
  mine: false,
  mentionsMe: false,
}

describe('Reply preview DOM render-scan (P1 on screen)', () => {
  it('renders loaded + degraded previews and the reply composer with NO protocol shape in the DOM', () => {
    const { container } = render(
      <Workspace
        channels={[channel]}
        selectedChannelId={channel.id}
        messages={[target, reply, degraded]}
        usersById={usersById}
        connection="connected"
        replyTarget={target}
        onSelectChannel={() => {}}
        onSend={() => {}}
        onReply={() => {}}
        onCancelReply={() => {}}
      />,
    )

    const text = container.textContent ?? ''
    // Positive controls — the preview DOES show clean content:
    expect(text).toContain('shall we ship it?') // quoted excerpt of the rich target (plain text)
    expect(text).toContain('Alice Anderson') // quoted author (display name, never the id)
    expect(text).toContain('yes, ship it') // the reply itself
    expect(text).toContain(copy.timeline.earlierMessage) // degraded preview label
    expect(text).toContain(copy.composer.replyingTo) // composer reply mode indicator

    // The loaded preview is clickable; the degraded one is NOT (no button).
    expect(container.querySelector('button.message__quote')).toBeTruthy()
    const unavailable = container.querySelector('.message__quote--unavailable')
    expect(unavailable).toBeTruthy()
    expect(unavailable!.tagName).not.toBe('BUTTON')

    // P1 gate: full rendered HTML (attributes included) free of every protocol pattern —
    // mxid/room-id/event-id/mxc/m.room.*/rel_type/m.thread + the reply vocabulary added by this
    // slice (m.in_reply_to, mx-reply). The protocol-shaped replyTo ids must never surface.
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  it('reply affordance is withheld from pending messages (target needs a real event id)', () => {
    const pending: Message = {
      id: mid('txn-pending-1'),
      channelId: channel.id,
      author: bob.id,
      body: { kind: 'text', text: 'still sending' },
      sentAt: tms(4),
      reactions: [],
      mine: true,
      mentionsMe: false,
      status: 'pending',
    }
    const { container, getAllByLabelText } = render(
      <Workspace
        channels={[channel]}
        selectedChannelId={channel.id}
        messages={[target, pending]}
        usersById={usersById}
        connection="connected"
        onSelectChannel={() => {}}
        onSend={() => {}}
        onReply={() => {}}
      />,
    )
    // The settled message offers Reply; the pending one does not.
    expect(getAllByLabelText(copy.timeline.reply)).toHaveLength(1)
    const pendingRow = (container.textContent ?? '').includes('still sending')
    expect(pendingRow).toBe(true)
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })
})
