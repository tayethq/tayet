// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, within } from '@testing-library/react'
import { Timeline, excerptOf } from '../../src/ui/components/Timeline'
import { ThreadPanel } from '../../src/ui/components/ThreadPanel'
import { previewOf } from '../../src/ui/notifier'
import { searchableText } from '../../src/acl/internal/search-index'
import type { Message, MessageBody, MessageId, ChannelId, User, UserId } from '../../src/acl'
import { getLocale } from '../../src/ui/i18n'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { copy, fill } from '../support/copy'

// ADR-091 (Proposto), A3-1 — the approval card on screen (manifest workspace.md §17.1, §17.3, §17.4, §18):
// pending (disabled until A3-2 wires the answer), answered with and without the option, closed; the
// same in the thread; Edit/Delete never offered on the card's line; and the card in the notification,
// the quoted preview and the search index.

const uid = (s: string): UserId => s as unknown as UserId
const mid = (s: string): MessageId => s as unknown as MessageId
const cid = (s: string): ChannelId => s as unknown as ChannelId
const tms = (n: number) => n as unknown as Message['sentAt']

const AGENT: User = { id: uid('@a-abcdefghijkl:tayet.local'), displayName: 'Publicação', kind: 'agent', agentColor: 'ardosia' }
const BOB: User = { id: uid('@bob:tayet.local'), displayName: 'Bob Lima', kind: 'member' }
const ME: User = { id: uid('@me:tayet.local'), displayName: 'Marina', kind: 'member' }
const usersById: Record<string, User> = { [AGENT.id]: AGENT, [BOB.id]: BOB, [ME.id]: ME }

const AT = new Date(2026, 10, 10, 14, 32).getTime()
const time = new Date(AT).toLocaleTimeString(getLocale(), { hour: '2-digit', minute: '2-digit', hour12: false })

type Approval = Extract<MessageBody, { kind: 'approval' }>
const OPTIONS: Approval['options'] = [
  { id: 'approve', label: 'Aprovar', style: 'primary' },
  { id: 'later', label: 'Depois' },
  { id: 'reject', label: 'Rejeitar', style: 'danger' },
]
const card = (state: Approval['state'], over: Partial<Message> = {}): Message => ({
  id: mid('$card'),
  channelId: cid('!r:tayet.local'),
  author: AGENT.id,
  body: {
    kind: 'approval',
    text: 'Publicar a versão 2.4?\nNotas no canal.',
    request: [{ t: 'p', children: [{ t: 'text', text: 'Publicar a versão 2.4?' }] }] as unknown as Approval['request'],
    options: OPTIONS,
    state,
  },
  sentAt: tms(AT - 60_000),
  reactions: [],
  mine: false,
  mentionsMe: false,
  ...over,
})

afterEach(cleanup)

const mount = (m: Message, selfId?: UserId) =>
  render(<Timeline messages={[m]} usersById={usersById} selfId={selfId} onReact={() => {}} onReply={() => {}} onOpenThread={() => {}} onEdit={() => {}} onDelete={() => {}} />)

describe('ApprovalCard — states', () => {
  it('pending: label, request, one disabled Button per option with the §17.3 variant', () => {
    const { container, getByRole } = mount(card({ kind: 'open' }))
    const group = getByRole('group', { name: copy.approval.title })
    expect(group.querySelector('.approval__label')?.textContent).toBe(copy.approval.title)
    expect(group.textContent).toContain('Publicar a versão 2.4?')
    const buttons = within(group).getAllByRole('button')
    expect(buttons.map((b) => b.textContent)).toEqual(['Aprovar', 'Depois', 'Rejeitar'])
    expect(buttons.map((b) => b.getAttribute('data-variant'))).toEqual(['fill', 'secondary', 'danger'])
    expect(buttons.every((b) => b.getAttribute('data-size') === 'gestao')).toBe(true)
    expect(buttons.every((b) => (b as HTMLButtonElement).disabled)).toBe(true)
    // No invented tooltip or copy for the disabled state.
    expect(buttons.every((b) => !b.hasAttribute('title'))).toBe(true)
    expect(container.querySelector('.approval__pill')).toBeNull()
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  it('answered: the option in a pill + "{nome} às {hora}" from the real author', () => {
    const { container } = mount(card({ kind: 'answered', by: BOB.id, at: tms(AT), option: 'later' }))
    expect(container.querySelector('.approval__pill')?.textContent).toBe('Depois')
    expect(container.querySelector('.approval__by')?.textContent).toBe(fill(copy.approval.answered, { name: 'Bob Lima', time }))
    expect(container.querySelectorAll('.approval button')).toHaveLength(0)
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  it('answered by the viewer: "Você"', () => {
    const { container } = mount(card({ kind: 'answered', by: ME.id, at: tms(AT), option: 'approve' }), ME.id)
    expect(container.querySelector('.approval__by')?.textContent).toBe(fill(copy.approval.answered, { name: copy.timeline.you, time }))
  })

  it('answered without the option (not decrypted yet): "{nome} respondeu às {hora}", no pill, no buttons', () => {
    const { container } = mount(card({ kind: 'answered', by: BOB.id, at: tms(AT) }))
    expect(container.querySelector('.approval__pill')).toBeNull()
    expect(container.querySelector('.approval__by')?.textContent).toBe(fill(copy.approval.answeredNoOption, { name: 'Bob Lima', time }))
    expect(container.querySelectorAll('.approval button')).toHaveLength(0)
  })

  it('an author outside the member map reads "Alguém" — never the id', () => {
    const { container } = mount(card({ kind: 'answered', by: uid('@gone:tayet.local'), at: tms(AT), option: 'approve' }))
    expect(container.querySelector('.approval__by')?.textContent).toBe(fill(copy.approval.answered, { name: copy.timeline.someone, time }))
    expect(container.innerHTML).not.toContain('@gone')
  })

  it('closed: "Pedido encerrado", no buttons, no "(editada)" mark', () => {
    const { container } = mount(card({ kind: 'closed' }, { editedAt: tms(AT) }))
    expect(container.querySelector('.approval__by')?.textContent).toBe(copy.approval.closed)
    expect(container.querySelectorAll('.approval button')).toHaveLength(0)
    expect(container.querySelector('.message__edited')).toBeNull()
  })

  it('the card’s line: React, Reply and Thread stay; Edit and Delete never appear (even on one’s own)', () => {
    const { container } = mount(card({ kind: 'open' }, { mine: true }), AGENT.id)
    expect(container.querySelector('.message__react-open')).not.toBeNull()
    expect(container.querySelector('.message__reply-open')).not.toBeNull()
    expect(container.querySelector('.message__thread-open')).not.toBeNull()
    expect(container.querySelector('.message__edit-open')).toBeNull()
    expect(container.querySelector('.message__delete-open')).toBeNull()
  })

  it('in the thread (same MessageRow): the same card', () => {
    const root = card({ kind: 'answered', by: BOB.id, at: tms(AT), option: 'approve' })
    const reply = card({ kind: 'closed' }, { id: mid('$c2'), threadParent: root.id })
    const { container } = render(
      <ThreadPanel root={root} messages={[reply]} usersById={usersById} onClose={() => {}} onSend={() => {}} />,
    )
    const cards = container.querySelectorAll('.thread-panel .approval')
    expect(cards).toHaveLength(2)
    expect(cards[0]!.querySelector('.approval__pill')?.textContent).toBe('Aprovar')
    expect(cards[1]!.querySelector('.approval__by')?.textContent).toBe(copy.approval.closed)
  })
})

describe('the card outside the timeline', () => {
  const body = card({ kind: 'open' }).body
  it('notification body: "Pede aprovação: {primeira linha}"', () => {
    expect(previewOf(body)).toBe(fill(copy.notifications.approvalRequest, { text: 'Publicar a versão 2.4?' }))
  })
  it('quoted preview: the text of the request', () => {
    expect(excerptOf(body)).toBe('Publicar a versão 2.4? Notas no canal.')
  })
  it('search index: the text of the request', () => {
    expect(searchableText(body)).toBe('Publicar a versão 2.4?\nNotas no canal.')
  })
})
