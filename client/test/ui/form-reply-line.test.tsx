// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { Timeline } from '../../src/ui/components/Timeline'
import { ThreadPanel } from '../../src/ui/components/ThreadPanel'
import type { ChannelId, Message, MessageBody, MessageId, User, UserId } from '../../src/acl'
import { getLocale } from '../../src/ui/i18n'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { copy, fill } from '../support/copy'

// ADR-103 (Proposto), workspace.md §26 item 8 and fork I5: who answered a form the agent opened from a message
// (Message.formReply) — "{nome} respondeu às {hora}", "Você respondeu às {hora}" for the viewer — in the card's
// footer under the answer pill, and under a command message where "comando para {agente}" sits. Never the values.

const uid = (s: string): UserId => s as unknown as UserId
const mid = (s: string): MessageId => s as unknown as MessageId
const cid = (s: string): ChannelId => s as unknown as ChannelId
const tms = (n: number) => n as unknown as Message['sentAt']

const AGENT: User = { id: uid('@a-abcdefghijkl:tayet.local'), displayName: 'Publicação', kind: 'agent', agentColor: 'ardosia' }
const BOB: User = { id: uid('@bob:tayet.local'), displayName: 'Bob Lima', kind: 'member' }
const ME: User = { id: uid('@me:tayet.local'), displayName: 'Marina', kind: 'member' }
const usersById: Record<string, User> = { [AGENT.id]: AGENT, [BOB.id]: BOB, [ME.id]: ME }

const AT = new Date(2026, 10, 17, 9, 5).getTime()
const time = new Date(AT).toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit', hour12: false })

type Approval = Extract<MessageBody, { kind: 'approval' }>
const card = (formReply?: Message['formReply']): Message => ({
  id: mid('$card'),
  channelId: cid('!r:tayet.local'),
  author: AGENT.id,
  body: {
    kind: 'approval',
    text: 'Ajustar a publicação?',
    options: [{ id: 'edit', label: 'Editar', style: 'primary' }],
    state: { kind: 'answered', by: BOB.id, at: tms(AT - 1000), option: 'edit' },
  } as Approval,
  sentAt: tms(AT - 60_000),
  reactions: [],
  mine: false,
  mentionsMe: false,
  ...(formReply && { formReply }),
})
const commandMessage = (formReply?: Message['formReply']): Message => ({
  id: mid('$cmd'),
  channelId: cid('!r:tayet.local'),
  author: BOB.id,
  body: { kind: 'text', text: '/editar' },
  sentAt: tms(AT - 60_000),
  reactions: [],
  mine: false,
  mentionsMe: false,
  command: { agent: AGENT.id, name: 'editar' },
  ...(formReply && { formReply }),
})

afterEach(cleanup)

describe('the line of who answered the form (I5)', () => {
  it('card, someone else: under the pill, in the footer slot', () => {
    const { container } = render(<Timeline messages={[card({ by: BOB.id, at: tms(AT) })]} usersById={usersById} selfId={ME.id} />)
    const slot = container.querySelector('.approval__slot')!
    const lineEl = slot.querySelector('.approval__form-reply')!
    expect(lineEl.textContent).toBe(fill(copy.form.replied, { name: 'Bob Lima', time }))
    // Under the pill's footer row.
    expect(slot.querySelector('.approval__footer')!.compareDocumentPosition(lineEl) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  it('card, the viewer: "Você respondeu às {hora}"', () => {
    const { container } = render(<Timeline messages={[card({ by: ME.id, at: tms(AT) })]} usersById={usersById} selfId={ME.id} />)
    expect(container.querySelector('.approval__form-reply')?.textContent).toBe(fill(copy.form.replied, { name: copy.timeline.you, time }))
  })

  it('card without an answered form: no line', () => {
    const { container } = render(<Timeline messages={[card()]} usersById={usersById} selfId={ME.id} />)
    expect(container.querySelector('.approval__form-reply')).toBeNull()
  })

  it('command, someone else: under "comando para {agente}"', () => {
    const { container } = render(<Timeline messages={[commandMessage({ by: BOB.id, at: tms(AT) })]} usersById={usersById} selfId={ME.id} />)
    const commandLine = container.querySelector('.message__command-line')!
    const reply = container.querySelector('.message__form-reply')!
    expect(reply.textContent).toBe(fill(copy.form.replied, { name: 'Bob Lima', time }))
    expect(commandLine.nextElementSibling).toBe(reply)
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  it('command, the viewer (own command): "Você respondeu às {hora}"; also in the thread', () => {
    const own = { ...commandMessage({ by: ME.id, at: tms(AT) }), author: ME.id, mine: true }
    const { container } = render(<Timeline messages={[own]} usersById={usersById} selfId={ME.id} />)
    expect(container.querySelector('.message__form-reply')?.textContent).toBe(fill(copy.form.replied, { name: copy.timeline.you, time }))
    cleanup()
    const root = card({ by: BOB.id, at: tms(AT) })
    const thread = render(<ThreadPanel root={root} messages={[own]} usersById={usersById} selfId={ME.id} onClose={() => {}} onSend={() => {}} />)
    expect(thread.container.querySelectorAll('.approval__form-reply, .message__form-reply')).toHaveLength(2)
  })

  it('an unknown author: "Alguém"', () => {
    const { container } = render(<Timeline messages={[card({ by: uid('@zed:tayet.local'), at: tms(AT) })]} usersById={usersById} selfId={ME.id} />)
    expect(container.querySelector('.approval__form-reply')?.textContent).toBe(fill(copy.form.replied, { name: copy.timeline.someone, time }))
    expect(findProtocolLeaksInText(container.textContent ?? '')).toEqual([])
  })
})
