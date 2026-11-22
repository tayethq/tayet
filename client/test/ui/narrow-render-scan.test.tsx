// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, act, within } from '@testing-library/react'
import { Workspace } from '../../src/ui/components/Workspace'
import type { Channel, ChannelId, MediaRef, MediaVariant, Message, MessageId, ResolvedMedia, User, UserId } from '../../src/acl'
import { MediaProvider } from '../../src/ui/MediaContext'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { copy } from '../support/copy'

// P1 gate for the narrow shell: the Workspace mounted as a stack, on each of
// its three screens — the list, the conversation, the thread — with fixtures whose ids carry real
// protocol shapes, and the whole DOM scanned. The covered screens stay mounted (inert, out of the
// accessibility tree) and are scanned too. The screen headers carry only clean display strings.

const cid = (s: string): ChannelId => s as unknown as ChannelId
const uid = (s: string): UserId => s as unknown as UserId
const mid = (s: string): MessageId => s as unknown as MessageId
const tms = (n: number) => n as unknown as Message['sentAt']

afterEach(cleanup)

const alice: User = { id: uid('@alice:tayet.local'), displayName: 'Alice Anderson', kind: 'member' }
const agent: User = { id: uid('@a-abcdefghijkl:tayet.local'), displayName: 'Relatório', kind: 'agent', agentColor: 'ocre' }
const ENG: Channel = {
  id: cid('!engineering:tayet.local'),
  name: '#engineering',
  kind: 'public',
  topic: 'Where we build things',
  memberCount: 2,
  unread: { count: 0, mentions: 0 },
}
const DM_AGENT: Channel = {
  id: cid('!dm-agent:tayet.local'),
  name: 'Relatório',
  kind: 'dm',
  memberCount: 2,
  unread: { count: 0, mentions: 0 },
  peerAgent: { color: 'ocre', operatorName: 'Alice Anderson' },
}
const GROUP: Channel = {
  id: cid('!group:tayet.local'),
  name: 'Alice Anderson, Relatório',
  kind: 'group',
  memberCount: 3,
  unread: { count: 1, mentions: 0 },
  participants: [alice.id, agent.id],
  participantAgents: 1,
}
const channels = [ENG, DM_AGENT, GROUP]
const root: Message = {
  id: mid('$root:tayet.local'),
  channelId: ENG.id,
  author: alice.id,
  body: { kind: 'text', text: 'Should we ship on Friday?' },
  sentAt: tms(1),
  reactions: [],
  mine: false,
  mentionsMe: false,
  threadSummary: { replyCount: 1, latestReplyAt: tms(2) },
}
const reply: Message = {
  id: mid('$r1:tayet.local'),
  channelId: ENG.id,
  author: alice.id,
  body: { kind: 'text', text: 'Yes, lets do it' },
  sentAt: tms(2),
  reactions: [],
  threadParent: root.id,
  mine: false,
  mentionsMe: false,
}
const usersById: Record<string, User> = { [alice.id]: alice, [agent.id]: agent }

function mount(over: Partial<Parameters<typeof Workspace>[0]> = {}) {
  return render(
    <Workspace
      narrow
      channels={channels}
      messages={[root]}
      usersById={usersById}
      connection="reconnecting"
      onSelectChannel={() => {}}
      onSend={() => {}}
      onCloseThread={() => {}}
      onSendThread={() => {}}
      {...over}
    />,
  )
}

const front = (container: HTMLElement) => container.querySelector('.workspace')!.getAttribute('data-stack')
const covered = (el: Element | null) => el?.hasAttribute('data-stack-covered') && el.hasAttribute('inert')

describe('narrow render-scan (P1 on screen)', () => {
  it('the list on screen: nothing selected, the others covered, connection strip, no protocol shape', () => {
    const { container } = mount()
    expect(front(container)).toBe('list')
    expect(covered(container.querySelector('.sidebar'))).toBe(false)
    expect(covered(container.querySelector('.main'))).toBe(true)
    // The strip under the list's top, in place of the sidebar's connection line.
    expect(container.querySelector('.sidebar .connection-strip')?.textContent).toBe(copy.shell.reconnecting)
    expect(container.querySelector('.sidebar__brand .connection')).toBeNull()
    expect(container.textContent).toContain('#engineering')
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  it('the conversation on screen: the screen header with back, title and topic; the list covered', () => {
    const { container, getAllByRole } = mount({ selectedChannelId: ENG.id })
    expect(front(container)).toBe('chat')
    expect(covered(container.querySelector('.sidebar'))).toBe(true)
    const header = container.querySelector('.main > .ui-screen-header')!
    expect(header.querySelector('.ui-screen-header__title')?.textContent).toContain('engineering')
    expect(header.querySelector('.ui-screen-header__subtitle')?.textContent).toBe('Where we build things')
    // A channel has no "⋯" on the narrow window.
    expect(header.querySelector('.ui-screen-header__action')).toBeNull()
    expect(container.querySelector('.channel-header')).toBeNull()
    // The strip sits right under the header.
    expect(header.nextElementSibling?.classList.contains('connection-strip')).toBe(true)
    expect(getAllByRole('button', { name: copy.dialog.back }).length).toBeGreaterThan(0)
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  it('a DM with an agent and a group: the 30 block before the name; the group keeps its "⋯"', () => {
    const onManage = vi.fn()
    const dm = mount({ selectedChannelId: DM_AGENT.id, messages: [] })
    const dmHeader = dm.container.querySelector('.main > .ui-screen-header')!
    expect(dmHeader.querySelector(':scope > .channel-header__agent [data-agent-avatar]')).not.toBeNull()
    expect(dmHeader.querySelector('[data-agent-operator]')?.textContent).toContain('Alice Anderson')
    expect(findProtocolLeaksInText(dm.container.innerHTML)).toEqual([])
    cleanup()
    const group = mount({ selectedChannelId: GROUP.id, messages: [], onManageChannel: onManage })
    const groupHeader = group.container.querySelector('.main > .ui-screen-header')!
    expect(groupHeader.querySelector(':scope > [data-group-block]')).not.toBeNull()
    const more = groupHeader.querySelector('.ui-screen-header__action')!
    fireEvent.click(more)
    expect(onManage).toHaveBeenCalledWith(GROUP)
    expect(findProtocolLeaksInText(group.container.innerHTML)).toEqual([])
  })

  it('the thread on screen: "Thread" over the channel, back in place of the close; the conversation covered', () => {
    const { container } = mount({ selectedChannelId: ENG.id, threadRoot: root, threadMessages: [reply] })
    expect(front(container)).toBe('thread')
    expect(covered(container.querySelector('.main'))).toBe(true)
    const panel = container.querySelector('.thread-panel')!
    expect(covered(panel)).toBe(false)
    const header = panel.querySelector(':scope > .ui-screen-header')!
    expect(header.querySelector('.ui-screen-header__title')?.textContent).toBe(copy.thread.title)
    expect(header.querySelector('.ui-screen-header__subtitle')?.textContent).toContain('engineering')
    expect(panel.querySelector('.thread-panel__close')).toBeNull()
    expect(panel.textContent).toContain('Yes, lets do it')
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  // M3a (PLANO-MOBILE §0.12.2 R6 and R9): the conversation at rest with the rows the narrow sheet now
  // sizes — "Carregar mensagens anteriores", reactions, the thread summary, a quote, a message not sent
  // with "Tentar de novo", a single-answer card not sent and a card with several approvers — and the copy
  // button still on the hover bar until M3b. No protocol shape anywhere.
  it('the conversation at rest with the M3a rows: every row on screen, no protocol shape', () => {
    const quoting: Message = {
      ...reply,
      id: mid('$q1:tayet.local'),
      threadParent: undefined,
      replyTo: root.id,
      reactions: [{ emoji: '👍', count: 2, mine: true }],
      body: { kind: 'text', text: 'Agreed' },
      sentAt: tms(3),
    }
    const failed: Message = {
      ...reply,
      id: mid('$f1:tayet.local'),
      threadParent: undefined,
      author: alice.id,
      mine: true,
      status: 'failed',
      body: { kind: 'text', text: 'Did not go' },
      sentAt: tms(4),
    }
    const card: Message = {
      ...reply,
      id: mid('$card:tayet.local'),
      threadParent: undefined,
      author: agent.id,
      body: {
        kind: 'approval',
        text: 'Publish the report?',
        options: [{ id: 'ok', label: 'Publish', style: 'primary' }, { id: 'no', label: 'Hold' }],
        state: { kind: 'failed', option: 'ok' },
      },
      sentAt: tms(5),
    }
    const multi: Message = {
      ...card,
      id: mid('$multi:tayet.local'),
      body: {
        kind: 'approval',
        text: 'Two sign-offs?',
        options: [{ id: 'ok', label: 'Approve' }],
        state: { kind: 'multi', needed: 2, closed: false, answers: [], own: { status: 'failed', option: 'ok' } },
      } as Message['body'],
      sentAt: tms(6),
    }
    const { container } = mount({
      selectedChannelId: ENG.id,
      messages: [root, quoting, failed, card, multi],
      onLoadOlder: () => {},
      onRetry: () => {},
      onAnswerApproval: () => {},
      onReact: () => {},
      onOpenThread: () => {},
    })
    const timeline = container.querySelector('.main .timeline')!
    expect(timeline.querySelector(':scope > .timeline__older')).not.toBeNull()
    expect(timeline.querySelector('.reactions')).not.toBeNull()
    expect(timeline.querySelector('.reaction--add')).not.toBeNull()
    expect(timeline.querySelector('.message__thread-summary')).not.toBeNull()
    expect(timeline.querySelector('button.message__quote')).not.toBeNull()
    expect(timeline.querySelectorAll('.message__retry-inline').length).toBeGreaterThanOrEqual(3)
    expect(timeline.querySelector('.approval__options')).toBeNull()
    expect(timeline.querySelector('.approval__answers .message__status--failed')).not.toBeNull()
    expect(timeline.querySelectorAll('.message__copy-open').length).toBeGreaterThan(0)
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  it('the M4 media: the file at rest, downloading and failed, and the image screen loading, failed and ready', async () => {
    // Protocol-shaped refs: neither the rows nor the image screen may surface them (P1).
    const fileRef = 'mxc://tayet.local/notasecret' as unknown as MediaRef
    const imageRef = 'mxc://tayet.local/fotosecret' as unknown as MediaRef
    const file: Message = { ...reply, id: mid('$file:tayet.local'), threadParent: undefined, body: { kind: 'file', media: fileRef, name: 'nota.pdf', size: 10, mimetype: 'application/pdf' }, sentAt: tms(3) }
    const image: Message = { ...reply, id: mid('$pic:tayet.local'), threadParent: undefined, body: { kind: 'image', media: imageRef, alt: 'foto.png' }, sentAt: tms(4) }
    const settle: Array<{ resolve: (m: ResolvedMedia) => void; reject: (e: Error) => void }> = []
    const resolve = (_ref: MediaRef, variant?: MediaVariant) =>
      variant === 'thumbnail'
        ? Promise.resolve({ url: 'blob:tayet/thumb', release: () => {} })
        : new Promise<ResolvedMedia>((ok, fail) => settle.push({ resolve: ok, reject: fail }))
    const { container, getByRole, findByRole } = render(
      <MediaProvider resolve={resolve}>
        <Workspace narrow channels={channels} selectedChannelId={ENG.id} messages={[file, image]} usersById={usersById} connection="connected" onSelectChannel={() => {}} onSend={() => {}} />
      </MediaProvider>,
    )
    const scan = (): void => {
      expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
      expect(container.innerHTML).not.toMatch(/notasecret|fotosecret/)
    }
    // The file at rest, then downloading, then failed.
    scan()
    fireEvent.click(getByRole('link', { name: /nota\.pdf/ }))
    expect(container.querySelector('.message__file-state--loading')).not.toBeNull()
    scan()
    await act(async () => settle[0]!.reject(new Error('media fetch failed: M_UNKNOWN_TOKEN')))
    expect(container.querySelector('.message__file-state--failed .message__retry')).not.toBeNull()
    scan()
    // The image screen: loading, failed, then ready after the retry.
    fireEvent.click(await findByRole('button', { name: /foto\.png/ }))
    expect(container.querySelector('.image-viewer [role="status"]')).not.toBeNull()
    scan()
    await act(async () => settle[1]!.reject(new Error('media unavailable')))
    expect(container.querySelector('.image-viewer [role="alert"]')).not.toBeNull()
    scan()
    fireEvent.click(container.querySelector('.image-viewer__retry')!)
    await act(async () => settle[2]!.resolve({ url: 'blob:tayet/full', release: () => {} }))
    expect(container.querySelector('.image-viewer img')).not.toBeNull()
    scan()
  })

  it('the M5 composer: the line, the reply, formatting and edit bands, the marked row, the link sheet and the suggestion', async () => {
    const mine: Message = { ...reply, id: mid('$mine:tayet.local'), threadParent: undefined, author: uid('@me:tayet.local'), mine: true, body: { kind: 'text', text: 'Minha mensagem' }, sentAt: tms(5) }
    const commands = [{ agent: agent.id, name: 'resumo', description: 'O que mudou', hint: 'período' }]
    const { container, getByRole } = mount({ selectedChannelId: ENG.id, messages: [root, mine], replyTarget: root, onReply: () => {}, onCancelReply: () => {}, onEdit: () => {}, commands })
    const scan = (): void => expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
    const main = container.querySelector('main')!
    expect(main.querySelector('.composer--narrow .composer__line')).not.toBeNull()
    expect(main.querySelector('.composer__band.composer__reply')).not.toBeNull()
    fireEvent.click(getByRole('button', { name: copy.composer.formatting }))
    expect(main.querySelector('.composer__toolbar')).not.toBeNull()
    scan()
    // The suggestion: mention and command.
    const editor = (main.querySelector('[contenteditable]') as HTMLElement & { editor: import('@tiptap/core').Editor }).editor
    const typed = async (text: string) =>
      act(async () => {
        editor.commands.clearContent()
        editor.commands.focus()
        editor.commands.insertContent(text)
        await new Promise((r) => setTimeout(r, 0))
      })
    await typed('@Ali')
    expect(main.querySelector('[role="listbox"]')).not.toBeNull()
    scan()
    await typed('/res')
    expect(main.querySelector('.composer__suggest-lines')).not.toBeNull()
    scan()
    await typed('')
    // The link sheet.
    fireEvent.click(getByRole('button', { name: copy.composer.link }))
    expect(getByRole('dialog', { name: copy.composer.linkInsert })).not.toBeNull()
    scan()
    fireEvent.click(getByRole('button', { name: copy.composer.linkCancel }))
    // The edit band and the marked row.
    const row = [...main.querySelectorAll('article')].find((a) => a.textContent?.includes('Minha mensagem'))!
    fireEvent.click(row.querySelector(`[aria-label="${copy.timeline.moreActions}"]`)!)
    const sheet = getByRole('dialog', { name: copy.timeline.actionsSheet })
    fireEvent.click(within(sheet).getByRole('button', { name: copy.timeline.editMessage }))
    expect(main.querySelector('.composer__band--edit')).not.toBeNull()
    expect(main.querySelector('article[data-editing="true"]')).not.toBeNull()
    scan()
  })

  // M6 (workspace.md §23.5 item 3; new-conversation.md §11): the search screen with results, preparing,
  // nothing found and a failed jump; "Nova conversa" as a full screen over the others.
  it('the M6 search screen: the field, the strip, the hits, preparing, partial and the failed jump', () => {
    const hit = { hit: { message: reply, channel: ENG.id, excerpt: { before: 'Yes, ', match: 'lets', after: ' do it' } }, author: 'Alice Anderson' }
    const search = {
      query: 'lets', onQuery: () => {}, scoped: false, onClear: () => {}, active: true, hits: [hit], searched: 'lets',
      preparing: true, partial: true, failed: reply.id, selected: reply.id, onPick: () => {}, open: true, onOpen: () => {},
    }
    const { container, rerender } = mount({ search })
    expect(front(container)).toBe('search')
    const s = container.querySelector('.search-screen')!
    expect(covered(s)).toBe(false)
    expect(covered(container.querySelector('.sidebar'))).toBe(true)
    expect(s.querySelector('.connection-strip')?.textContent).toBe(copy.shell.reconnecting)
    expect(s.textContent).toContain(copy.search.preparing)
    expect(s.textContent).toContain(copy.search.openFailed)
    expect(s.textContent).toContain(copy.search.inThread)
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
    rerender(
      <Workspace narrow channels={channels} messages={[root]} usersById={usersById} connection="connected" onSelectChannel={() => {}} onSend={() => {}}
        search={{ ...search, hits: [], searched: 'zzz', preparing: false, failed: undefined }} />,
    )
    expect(container.querySelector('.search-screen')!.textContent).toContain(copy.search.partial)
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  it('the M6 "Nova conversa" screen covers the list; the list keeps the search button', async () => {
    const contacts = [alice, agent]
    const { container, findByText } = mount({
      search: { query: '', onQuery: () => {}, scoped: false, onClear: () => {}, active: false, hits: [], searched: '', preparing: false, partial: false, onPick: () => {}, open: false, onOpen: () => {} },
      onCreateChannel: async () => {},
      onOpenDirectMessage: async () => {},
      onOpenGroupConversation: async () => {},
      loadKnownContacts: async () => contacts,
    })
    expect(container.querySelector('.sidebar .search__open')?.textContent).toBe(copy.search.placeholder)
    fireEvent.click(container.querySelector('.sidebar__compose')!)
    const s = container.querySelector('.compose-screen')!
    expect(s.parentElement).toBe(container.querySelector('.workspace'))
    expect(covered(container.querySelector('.sidebar'))).toBe(true)
    expect(covered(container.querySelector('.search-screen'))).toBe(true)
    await findByText('Alice Anderson')
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  it('without a history stack the header back closes by itself', () => {
    const onBackToList = vi.fn()
    const onCloseThread = vi.fn()
    const { container } = mount({ selectedChannelId: ENG.id, threadRoot: root, onBackToList, onCloseThread })
    fireEvent.click(container.querySelector('.thread-panel .ui-screen-header__back')!)
    expect(onCloseThread).toHaveBeenCalledTimes(1)
    fireEvent.click(container.querySelector('.main .ui-screen-header__back')!)
    expect(onBackToList).toHaveBeenCalledTimes(1)
  })
})
