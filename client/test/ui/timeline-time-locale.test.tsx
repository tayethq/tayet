// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { Timeline } from '../../src/ui/components/Timeline'
import type { ChannelId, Message, MessageId, User, UserId } from '../../src/acl'

// ADR-080 D3: the message time follows the catalog's locale, 24 h — never the browser's. Before D1 it
// was toLocaleTimeString([]) and read "12:05 PM" in an en-US Chromium, breaking the gutter sized for
// "HH:MM" (§0 de idioma, B3). The runner's locale is en-US here, which is the point.

const uid = (s: string): UserId => s as unknown as UserId
const mid = (s: string): MessageId => s as unknown as MessageId
const at = (h: number, m: number) => new Date(2026, 9, 29, h, m).getTime() as unknown as Message['sentAt']

const alice: User = { id: uid('@alice:tayet.local'), displayName: 'Alice Anderson', kind: 'member' }

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

afterEach(cleanup)

describe('message time (ADR-080 D3)', () => {
  it('HH:MM in 24 h, on the header and on the continuation gutter', () => {
    const { container } = render(
      <Timeline messages={[message('a', at(12, 5)), message('b', at(13, 7))]} usersById={{ [alice.id]: alice }} />,
    )
    expect(container.querySelector('.message__timestamp')?.textContent).toBe('12:05')
    expect(container.querySelector('.message__time-rail')?.textContent).toBe('13:07')
  })
})
