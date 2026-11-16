// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { Timeline } from '../../src/ui/components/Timeline'
import type { Message, User, UserId, MessageId, ChannelId } from '../../src/acl'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'

// ADR-037 M1 render: a message with mentionsMe carries `.message--mentions-me` (accent-wash + barra
// accent). Lido de m.mentionsMe direto (Timeline e ThreadPanel). mentionsMe é booleano — o DOM não
// ganha nenhum identificador de protocolo (P1).

const uid = (s: string): UserId => s as unknown as UserId
const mid = (s: string): MessageId => s as unknown as MessageId
const cid = (s: string): ChannelId => s as unknown as ChannelId
const tms = (n: number) => n as unknown as Message['sentAt']

const them: User = { id: uid('@them:tayet.local'), displayName: 'Them', kind: 'member' }
const usersById: Record<string, User> = { [them.id]: them }

function msg(mentionsMe: boolean): Message {
  return {
    id: mid('txn-mention'),
    channelId: cid('!r:tayet.local'),
    author: them.id,
    body: { kind: 'text', text: 'oi você, dá uma olhada' },
    sentAt: tms(1),
    reactions: [],
    mine: false,
    mentionsMe,
  }
}

afterEach(cleanup)

describe('mention highlight render (ADR-037 M1)', () => {
  it('mentionsMe true → .message--mentions-me present', () => {
    const { container } = render(<Timeline messages={[msg(true)]} usersById={usersById} />)
    expect(container.querySelector('.message--mentions-me')).toBeTruthy()
  })

  it('mentionsMe false → .message--mentions-me absent', () => {
    const { container } = render(<Timeline messages={[msg(false)]} usersById={usersById} />)
    expect(container.querySelector('.message--mentions-me')).toBeNull()
  })

  it('P1: the highlighted DOM carries no protocol shape (mentionsMe is a boolean)', () => {
    const { container } = render(<Timeline messages={[msg(true)]} usersById={usersById} />)
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })
})
