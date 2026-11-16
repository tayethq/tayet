// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, renderHook, waitFor, act } from '@testing-library/react'
import { Timeline } from '../../src/ui/components/Timeline'
import { ThreadPanel } from '../../src/ui/components/ThreadPanel'
import { useChat } from '../../src/ui/useChat'
import type { Acl, AgentCommand, Channel, ChannelId, DomainEvent, Message, MessageId, User, UserId } from '../../src/acl'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { copy, fill } from '../support/copy'

// A4-4 (ADR-093 Proposto, PLANO-AGENTES §0.3.24 items 1, 4, 5 and 7; workspace.md §21.1 item 8): a message
// with Message.command shows the chip in place of the leading "/nome" and the line "comando para {agente}"
// under the body — in the conversation, in a continuation and in the thread; without Message.command,
// "/texto" is text; a command message offers no edit (delete stays). And the chat state: the open
// conversation's commands (listCommands, then commands.changed) and SendOpts.command on both sends.

const cid = (s: string): ChannelId => s as unknown as ChannelId
const uid = (s: string): UserId => s as unknown as UserId
const mid = (s: string): MessageId => s as unknown as MessageId
const tms = (n: number) => n as unknown as Message['sentAt']

const me: User = { id: uid('@me:tayet.local'), displayName: 'Marcela Alves', kind: 'member' }
const publish: User = { id: uid('@publish-bot:tayet.local'), displayName: 'Publicação', kind: 'agent', agentColor: 'ardosia' }
const usersById = { [me.id]: me, [publish.id]: publish }
const CH = cid('!room:tayet.local')
const command = { agent: publish.id, name: 'status' }

function msg(over: Partial<Message> = {}): Message {
  return {
    id: mid('$c1:tayet.local'),
    channelId: CH,
    author: me.id,
    body: { kind: 'text', text: '/status semana' },
    sentAt: tms(1),
    reactions: [],
    mine: true,
    mentionsMe: false,
    status: 'sent',
    command,
    ...over,
  }
}

const line = fill(copy.timeline.commandFor, { agent: 'Publicação' })

afterEach(cleanup)

describe('command message on the timeline (§21.1 item 8)', () => {
  it('draws the chip in place of "/nome", the arguments as text, and the line under the body', () => {
    const { container, getByText } = render(<Timeline messages={[msg()]} usersById={usersById} />)
    const body = container.querySelector('.message__body')!
    expect(body.querySelector('.message__command')?.textContent).toBe('/status')
    expect(body.textContent).toBe('/status semana')
    expect(getByText(line).className).toBe('message__command-line')
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  it('a rich command message keeps the chip at the start of its first paragraph', () => {
    const rich = msg({
      body: {
        kind: 'text',
        text: '/status hoje',
        rich: [{ t: 'p', children: [{ t: 'text', text: '/status' }, { t: 'text', text: ' ' }, { t: 'strong', children: [{ t: 'text', text: 'hoje' }] }] }],
      },
    })
    const { container } = render(<Timeline messages={[rich]} usersById={usersById} />)
    const p = container.querySelector('.rich__p')!
    expect(p.firstElementChild?.className).toBe('message__command')
    expect(p.textContent).toBe('/status hoje')
    expect(p.querySelector('strong')?.textContent).toBe('hoje')
  })

  it('a continuation shows the chip and the line too', () => {
    const first = msg({ id: mid('$c0:tayet.local'), body: { kind: 'text', text: 'antes' }, command: undefined })
    const second = msg({ sentAt: tms(2) })
    const { container } = render(<Timeline messages={[first, second]} usersById={usersById} />)
    const cont = container.querySelector('.message--cont')!
    expect(cont.querySelector('.message__command')?.textContent).toBe('/status')
    expect(cont.querySelector('.message__command-line')?.textContent).toBe(line)
  })

  it('the thread shows the chip and the line on the root and on a reply', () => {
    const root = msg({ id: mid('$root:tayet.local'), command: undefined, body: { kind: 'text', text: 'raiz' } })
    const reply = msg({ id: mid('$r1:tayet.local'), threadParent: root.id })
    const { container } = render(
      <ThreadPanel root={root} messages={[reply]} usersById={usersById} onClose={() => {}} onSend={() => {}} />,
    )
    expect(container.querySelectorAll('.message__command')).toHaveLength(1)
    expect(container.querySelector('.message__command-line')?.textContent).toBe(line)
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  it('without Message.command, "/texto" is text: no chip, no line', () => {
    const { container } = render(<Timeline messages={[msg({ command: undefined })]} usersById={usersById} />)
    expect(container.querySelector('.message__command')).toBeNull()
    expect(container.querySelector('.message__command-line')).toBeNull()
    expect(container.querySelector('.message__body')?.textContent).toBe('/status semana')
  })

  it('an agent that left: the line reads "Alguém" — never the id', () => {
    const { container } = render(<Timeline messages={[msg()]} usersById={{ [me.id]: me }} />)
    expect(container.querySelector('.message__command-line')?.textContent).toBe(
      fill(copy.timeline.commandFor, { agent: copy.timeline.someone }),
    )
    expect(container.innerHTML).not.toContain(publish.id)
  })
})

describe('a command message offers no edit (§0.3.24 item 7)', () => {
  it('no "Editar mensagem"; "Apagar mensagem" stays', () => {
    const { queryByLabelText } = render(
      <Timeline messages={[msg()]} usersById={usersById} onEdit={() => {}} onDelete={() => {}} />,
    )
    expect(queryByLabelText(copy.timeline.editMessage)).toBeNull()
    expect(queryByLabelText(copy.timeline.deleteMessage)).not.toBeNull()
  })

  it('control: the same message without the command offers edit', () => {
    const { queryByLabelText } = render(
      <Timeline messages={[msg({ command: undefined })]} usersById={usersById} onEdit={() => {}} />,
    )
    expect(queryByLabelText(copy.timeline.editMessage)).not.toBeNull()
  })
})

describe('chat state: commands and SendOpts.command (§0.3.24 items 1 and 4)', () => {
  const channel: Channel = { id: CH, name: '#r', kind: 'public', memberCount: 2, unread: { count: 0, mentions: 0 } }
  const listed: AgentCommand[] = [{ agent: publish.id, name: 'status', description: 'Fila de publicação' }]

  function fakeAcl() {
    const handlers = new Set<(e: DomainEvent) => void>()
    const sendMessage = vi.fn(async () => {})
    const listCommands = vi.fn(async () => listed)
    const acl = {
      getChannels: async () => [channel],
      getArchivedChannels: async () => [],
      getChannel: async () => channel,
      getMembers: async () => [],
      getDevices: async () => [],
      currentUser: async () => ({ id: me.id, displayName: me.displayName }),
      getThreadUnread: async () => ({ unread: false }),
      getTimeline: async () => ({ items: [] }),
      getPresence: () => 'offline' as const,
      listPanels: async () => [],
      listCommands,
      sendMessage,
      subscribe: () => () => {},
      subscribeChannel: (_id: ChannelId, h: (e: DomainEvent) => void) => {
        handlers.add(h)
        return () => handlers.delete(h)
      },
      markRead: async () => {},
      acknowledgeAccess: () => {},
      connect: async () => {},
      disconnect: async () => {},
    } as unknown as Acl
    const emit = (e: DomainEvent): void => act(() => [...handlers].forEach((h) => h(e)))
    return { acl, emit, sendMessage, listCommands }
  }

  it('reads the open conversation\'s commands, then follows commands.changed', async () => {
    const fake = fakeAcl()
    const { result } = renderHook(() => useChat(fake.acl))
    act(() => result.current.select(CH))
    await waitFor(() => expect(result.current.commands).toEqual(listed))
    expect(fake.listCommands).toHaveBeenCalledWith(CH)
    fake.emit({ t: 'commands.changed', channelId: CH, commands: [] })
    expect(result.current.commands).toEqual([])
  })

  it('send and sendThread carry the command (with the mentions and the thread)', async () => {
    const fake = fakeAcl()
    const { result } = renderHook(() => useChat(fake.acl))
    act(() => result.current.select(CH))
    await waitFor(() => expect(fake.listCommands).toHaveBeenCalled())
    act(() => result.current.send({ text: '/status semana' }, [me.id], command))
    expect(fake.sendMessage).toHaveBeenLastCalledWith(
      CH,
      { kind: 'text', text: '/status semana' },
      { mentions: [me.id], command },
    )
    const root = msg({ id: mid('$root:tayet.local'), command: undefined })
    act(() => result.current.openThread(root))
    act(() => result.current.sendThread({ text: '/status' }, [], command))
    expect(fake.sendMessage).toHaveBeenLastCalledWith(CH, { kind: 'text', text: '/status' }, { thread: root.id, command })
  })
})
