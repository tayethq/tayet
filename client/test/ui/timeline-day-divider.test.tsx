// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { Timeline, dayLabelOf } from '../../src/ui/components/Timeline'
import { ThreadPanel } from '../../src/ui/components/ThreadPanel'
import type { ChannelId, Message, MessageId, User, UserId } from '../../src/acl'
import { copy } from '../support/copy'

// Manifest workspace.md §10 items 1–3: the day divider is the main timeline's, it cuts a group, and
// "day" is the device's local day. Fixed clock: Friday, 30 Oct 2026, 12:00 local.

const NOW = new Date(2026, 9, 30, 12, 0)
const at = (y: number, mo: number, d: number, h = 12, mi = 0) => new Date(y, mo, d, h, mi).getTime() as unknown as Message['sentAt']

const uid = (s: string): UserId => s as unknown as UserId
const mid = (s: string): MessageId => s as unknown as MessageId
const alice: User = { id: uid('@alice:tayet.local'), displayName: 'Alice Anderson', kind: 'member' }
const usersById = { [alice.id]: alice }

function message(id: string, sentAt: Message['sentAt']): Message {
  return {
    id: mid(`$${id}:tayet.local`),
    channelId: '!c:tayet.local' as unknown as ChannelId,
    author: alice.id,
    body: { kind: 'text', text: id },
    sentAt,
    reactions: [],
    mine: false,
    mentionsMe: false,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => {
  cleanup()
  // The unmount scheduled the editor's destroy on the fake clock (@tiptap/react, 1 ms timer): run it
  // before the real timers come back, or the editor is never destroyed.
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
})

describe('day label (§10 item 2)', () => {
  it('today, yesterday, this year, another year', () => {
    expect(dayLabelOf(at(2026, 9, 30, 0, 1))).toBe(copy.timeline.dayToday)
    expect(dayLabelOf(at(2026, 9, 29, 23, 59))).toBe(copy.timeline.dayYesterday)
    expect(dayLabelOf(at(2026, 9, 28))).toBe('quarta-feira, 28 de outubro')
    expect(dayLabelOf(at(2025, 9, 28))).toBe('terça-feira, 28 de outubro de 2025')
  })

  it('a day is the local calendar day, not a 24 h difference', () => {
    // Two minutes apart, across midnight: yesterday.
    const now = new Date(2026, 9, 30, 0, 1).getTime()
    expect(dayLabelOf(at(2026, 9, 29, 23, 59), now)).toBe(copy.timeline.dayYesterday)
    // Under 25 h apart, two midnights crossed: a date, not yesterday.
    expect(dayLabelOf(at(2026, 9, 28, 23, 59), now)).toBe('quarta-feira, 28 de outubro')
  })

  it('yesterday crosses a year boundary', () => {
    expect(dayLabelOf(at(2025, 11, 31), new Date(2026, 0, 1, 9).getTime())).toBe(copy.timeline.dayYesterday)
  })
})

describe('day divider (§10 items 1 and 3)', () => {
  it('sits before the first message and at every day change, with an accessible name', () => {
    const { getAllByRole, getByRole } = render(
      <Timeline messages={[message('a', at(2026, 9, 29)), message('b', at(2026, 9, 30))]} usersById={usersById} />,
    )
    expect(getAllByRole('separator')).toHaveLength(2)
    expect(getByRole('separator', { name: copy.timeline.dayYesterday })).toBeTruthy()
    expect(getByRole('separator', { name: copy.timeline.dayToday })).toBeTruthy()
  })

  it('one day, one divider', () => {
    const { getAllByRole } = render(
      <Timeline messages={[message('a', at(2026, 9, 30, 9)), message('b', at(2026, 9, 30, 10))]} usersById={usersById} />,
    )
    expect(getAllByRole('separator')).toHaveLength(1)
  })

  it('the same author across days makes two groups, each with its header', () => {
    const { container } = render(
      <Timeline messages={[message('a', at(2026, 9, 29)), message('b', at(2026, 9, 30))]} usersById={usersById} />,
    )
    expect(container.querySelectorAll('.message__group')).toHaveLength(2)
    expect(container.querySelectorAll('.message__meta')).toHaveLength(2)
  })

  it('goes inert with the rows during a search jump', () => {
    const { container } = render(<Timeline messages={[message('a', at(2026, 9, 30))]} usersById={usersById} jumping />)
    expect(container.querySelector('.timeline__day')?.hasAttribute('inert')).toBe(true)
  })

  it('a day that comes back keeps the keys unique', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { getAllByRole } = render(
      <Timeline
        messages={[message('a', at(2026, 9, 29)), message('b', at(2026, 9, 30)), message('c', at(2026, 9, 29))]}
        usersById={usersById}
      />,
    )
    expect(getAllByRole('separator')).toHaveLength(3)
    expect(error).not.toHaveBeenCalled()
    error.mockRestore()
  })

  it('the ThreadPanel has no divider (§10 item 7)', () => {
    const { container } = render(
      <ThreadPanel
        root={message('root', at(2026, 9, 28))}
        messages={[message('a', at(2026, 9, 29)), message('b', at(2026, 9, 30))]}
        usersById={usersById}
        onClose={() => {}}
        onSend={() => {}}
      />,
    )
    expect(container.querySelector('.timeline__day')).toBeNull()
  })
})
