// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { Timeline } from '../../src/ui/components/Timeline'
import type { Message, Reaction, User, UserId, MessageId, ChannelId } from '../../src/acl'
import { copy, fill } from '../support/copy'

// Commit 9 UI: aggregated reactions render as toggle chips (mine highlighted); clicking a chip
// or a quick-react emoji calls back with (message, emoji). The quick emojis live in the picker the
// `+` and the bar's "Reagir" open (manifest workspace.md §11 items 2–3).

const uid = (s: string): UserId => s as unknown as UserId
const mid = (s: string): MessageId => s as unknown as MessageId
const cid = (s: string): ChannelId => s as unknown as ChannelId
const tms = (n: number) => n as unknown as Message['sentAt']

const me: User = { id: uid('@me:tayet.local'), displayName: 'Me', kind: 'member' }
const usersById: Record<string, User> = { [me.id]: me }

function msg(reactions: Reaction[]): Message {
  return {
    id: mid('$evt:tayet.local'),
    channelId: cid('!r:tayet.local'),
    author: me.id,
    body: { kind: 'text', text: 'hi' },
    sentAt: tms(1),
    reactions,
    mine: true,
    mentionsMe: false,
  }
}

afterEach(cleanup)

describe('reactions UI', () => {
  it('renders aggregate chips with counts and highlights mine', () => {
    const onReact = vi.fn()
    const { getByText, container } = render(
      <Timeline
        messages={[msg([
          { emoji: '👍', count: 2, mine: true },
          { emoji: '🎉', count: 1, mine: false },
        ])]}
        usersById={usersById}
        onReact={onReact}
      />,
    )
    expect(getByText('2')).toBeTruthy()
    expect(getByText('1')).toBeTruthy()
    // the 👍 chip (mine) is highlighted
    expect(container.querySelector('.reaction--mine')).toBeTruthy()
  })

  it('clicking an existing chip calls onReact(message, emoji)', () => {
    const onReact = vi.fn()
    const m = msg([{ emoji: '👍', count: 1, mine: true }])
    const { container } = render(<Timeline messages={[m]} usersById={usersById} onReact={onReact} />)
    const chip = container.querySelector('.reaction--mine') as HTMLElement
    expect(chip).toBeTruthy()
    fireEvent.click(chip)
    expect(onReact).toHaveBeenCalledWith(m, '👍')
  })

  it('renders no reactions line without a reaction (#277)', () => {
    const { container } = render(<Timeline messages={[msg([])]} usersById={usersById} onReact={vi.fn()} />)
    expect(container.querySelector('.reactions')).toBeNull()
    expect(container.querySelector('.reaction-picker')).toBeNull()
  })

  it('the quick emojis are not inline: they wait behind the trigger', () => {
    const { queryByLabelText } = render(
      <Timeline messages={[msg([{ emoji: '👍', count: 1, mine: false }])]} usersById={usersById} onReact={vi.fn()} />,
    )
    expect(queryByLabelText(fill(copy.timeline.react, { emoji: '👍' }))).toBeNull()
  })

  it('the `+` opens the picker; choosing calls onReact, closes it and returns the focus', () => {
    const onReact = vi.fn()
    const m = msg([{ emoji: '👍', count: 1, mine: false }])
    const { container, getByLabelText } = render(<Timeline messages={[m]} usersById={usersById} onReact={onReact} />)
    const plus = container.querySelector('.reaction--add') as HTMLElement
    expect(plus.getAttribute('aria-label')).toBe(copy.timeline.reactOpen)
    expect(plus.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(plus)
    expect(plus.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('.reaction-picker')?.getAttribute('role')).toBe('group')
    fireEvent.click(getByLabelText(fill(copy.timeline.react, { emoji: '🎉' })))
    expect(onReact).toHaveBeenCalledWith(m, '🎉')
    expect(container.querySelector('.reaction-picker')).toBeNull()
    expect(plus.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(plus)
  })

  it('the bar\'s "Reagir" opens the same picker on a message with no reaction', () => {
    const onReact = vi.fn()
    const m = msg([])
    const { container, getByLabelText } = render(<Timeline messages={[m]} usersById={usersById} onReact={onReact} />)
    fireEvent.click(container.querySelector('.message__react-open') as HTMLElement)
    fireEvent.click(getByLabelText(fill(copy.timeline.react, { emoji: '❤️' })))
    expect(onReact).toHaveBeenCalledWith(m, '❤️')
  })

  it('Esc closes the picker and returns the focus to the trigger', () => {
    const { container } = render(<Timeline messages={[msg([])]} usersById={usersById} onReact={vi.fn()} />)
    const trigger = container.querySelector('.message__react-open') as HTMLElement
    fireEvent.click(trigger)
    const picker = container.querySelector('.reaction-picker') as HTMLElement
    expect(picker.contains(document.activeElement)).toBe(true)
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' })
    expect(container.querySelector('.reaction-picker')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('a click outside closes the picker and returns the focus to the trigger', () => {
    const { container } = render(<Timeline messages={[msg([])]} usersById={usersById} onReact={vi.fn()} />)
    const trigger = container.querySelector('.message__react-open') as HTMLElement
    fireEvent.click(trigger)
    fireEvent.click(document.body)
    expect(container.querySelector('.reaction-picker')).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('a pending message offers no "Reagir"', () => {
    const { container } = render(
      <Timeline messages={[{ ...msg([]), status: 'pending' }]} usersById={usersById} onReact={vi.fn()} />,
    )
    expect(container.querySelector('.message__react-open')).toBeNull()
  })
})
