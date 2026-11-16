// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { MessageRow, Timeline } from '../../src/ui/components/Timeline'
import { ThreadPanel } from '../../src/ui/components/ThreadPanel'
import type { Message, User, UserId, MessageId, ChannelId } from '../../src/acl'
import { GLYPH } from '../../src/ui/i18n'
import { copy } from '../support/copy'

// ADR-010 UI: optimistic 'pending' row + 'failed' state with a Retry action (manifest workspace.md
// §10 items 5–6: no spinner, no alert background, Retry as always-visible text).

const uid = (s: string): UserId => s as unknown as UserId
const mid = (s: string): MessageId => s as unknown as MessageId
const cid = (s: string): ChannelId => s as unknown as ChannelId
const tms = (n: number) => n as unknown as Message['sentAt']

const me: User = { id: uid('@me:tayet.local'), displayName: 'Me', kind: 'member' }
const usersById: Record<string, User> = { [me.id]: me }

function msg(status: Message['status'], text = 'hi', id = 'txn-abc'): Message {
  return {
    id: mid(id),
    channelId: cid('!r:tayet.local'),
    author: me.id,
    body: { kind: 'text', text },
    sentAt: tms(1),
    reactions: [],
    mine: true,
    mentionsMe: false,
    status,
  }
}

afterEach(cleanup)

describe('message status UI (ADR-010)', () => {
  it('shows a pending row (Sending…, aria-busy), without a spinner', () => {
    const { container, getByText } = render(<Timeline messages={[msg('pending')]} usersById={usersById} />)
    expect(getByText(copy.timeline.sending)).toBeTruthy()
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy()
    expect(container.querySelector('.message--pending')).toBeTruthy()
    expect(container.querySelector('.message__spinner')).toBeNull()
  })

  it('shows a failed row with a visible Retry text button that calls back', () => {
    const onRetry = vi.fn()
    const failed = msg('failed')
    const { getByText, getByRole, container } = render(
      <Timeline messages={[failed]} usersById={usersById} onRetry={onRetry} />,
    )
    expect(getByText(copy.timeline.failed)).toBeTruthy()
    const retry = getByRole('button', { name: copy.timeline.retry })
    expect(retry.textContent).toBe(copy.timeline.retry)
    expect(retry.closest('.message__actions')).toBeNull()
    expect(container.querySelector('.message__retry')).toBeNull()
    fireEvent.click(retry)
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(onRetry).toHaveBeenCalledWith(failed)
  })

  it('without onRetry, the failed line has no separator and no button', () => {
    const { container, queryByRole } = render(<Timeline messages={[msg('failed')]} usersById={usersById} />)
    expect(queryByRole('button', { name: copy.timeline.retry })).toBeNull()
    expect(container.querySelector('.message__status--send')?.textContent).toBe(copy.timeline.failed)
  })

  it('a pending continuation shows the dot on the gutter, in place of the time', () => {
    const { container } = render(
      <Timeline messages={[msg(undefined, 'a', 'a'), msg('pending', 'b', 'b')]} usersById={usersById} />,
    )
    const rail = container.querySelector('.message--pending .message__time-rail')!
    expect(rail.textContent).toBe(GLYPH.dot)
    expect(rail.getAttribute('aria-hidden')).toBe('true')
  })

  it('a failed continuation shows the hidden glyph on the gutter, in place of the time', () => {
    const { container } = render(
      <Timeline messages={[msg(undefined, 'a', 'a'), msg('failed', 'b', 'b')]} usersById={usersById} />,
    )
    const rail = container.querySelector('.message--failed .message__time-rail')!
    expect(rail.textContent).toBe(GLYPH.failed)
    expect(rail.getAttribute('aria-hidden')).toBe('true')
  })

  it('a group start keeps its avatar: no glyph on the gutter in either state', () => {
    for (const status of ['pending', 'failed'] as const) {
      const { container, unmount } = render(<Timeline messages={[msg(status)]} usersById={usersById} />)
      expect(container.querySelector('.message__time-rail')).toBeNull()
      expect(container.querySelector('.message__avatar button')).toBeTruthy()
      unmount()
    }
  })

  it('the ThreadPanel continuation carries the same gutter states (§10 item 7)', () => {
    const { container } = render(
      <ThreadPanel
        root={msg(undefined, 'root', 'root')}
        messages={[msg(undefined, 'a', 'a'), msg('pending', 'b', 'b'), msg('failed', 'c', 'c')]}
        usersById={usersById}
        onClose={() => {}}
        onSend={() => {}}
      />,
    )
    expect(container.querySelector('.message--pending .message__time-rail')?.textContent).toBe(GLYPH.dot)
    expect(container.querySelector('.message--failed .message__time-rail')?.textContent).toBe(GLYPH.failed)
  })

  it('the flat layout shows the same status, with no gutter', () => {
    const { container, getByRole, getByText } = render(
      <MessageRow message={msg('failed')} usersById={usersById} onRetry={() => {}} />,
    )
    expect(getByText(copy.timeline.failed)).toBeTruthy()
    expect(getByRole('button', { name: copy.timeline.retry })).toBeTruthy()
    expect(container.querySelector('.message__time-rail')).toBeNull()
  })

  it('a settled message shows no status chrome', () => {
    const { container, queryByText } = render(
      <Timeline messages={[msg(undefined)]} usersById={usersById} />,
    )
    expect(queryByText(copy.timeline.sending)).toBeNull()
    expect(queryByText(copy.timeline.failed)).toBeNull()
    expect(container.querySelector('.message--pending')).toBeNull()
  })
})
