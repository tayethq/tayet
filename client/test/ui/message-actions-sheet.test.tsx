// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, within, act } from '@testing-library/react'
import { Workspace } from '../../src/ui/components/Workspace'
import type { Channel, ChannelId, Message, MessageId, User, UserId } from '../../src/acl'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { copy, fill } from '../support/copy'

// The action sheet on the narrow window (workspace.md §23.8 items 2–7, §29, §30; PLANO-MOBILE §0.12 M3b),
// opened by "Mais ações" (the long press is driven by long-press.test.ts and the phone E2E): the order of
// item 2, each action only where the wide window offers it, "Editar mensagem" on one's own (M5), Delete confirmed inside the
// sheet, the thread's variant with its root gate, and no sheet for a message without any action. Fixtures
// carry protocol-shaped ids; the render-scan proves none reaches the sheet.

const cid = (s: string): ChannelId => s as unknown as ChannelId
const uid = (s: string): UserId => s as unknown as UserId
const mid = (s: string): MessageId => s as unknown as MessageId
const tms = (n: number) => n as unknown as Message['sentAt']

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const me: User = { id: uid('@me:tayet.local'), displayName: 'Me Myself', kind: 'member' }
const alice: User = { id: uid('@alice:tayet.local'), displayName: 'Alice Anderson', kind: 'member' }
const usersById = { [me.id]: me, [alice.id]: alice }
const ENG: Channel = { id: cid('!eng:tayet.local'), name: '#eng', kind: 'public', memberCount: 2, unread: { count: 0, mentions: 0 } }

function msg(over: Partial<Message> = {}): Message {
  return {
    id: mid('$m1:tayet.local'),
    channelId: ENG.id,
    author: alice.id,
    body: { kind: 'text', text: 'hello there' },
    sentAt: tms(1),
    reactions: [],
    mine: false,
    mentionsMe: false,
    ...over,
  }
}

type Props = Parameters<typeof Workspace>[0]
function mount(over: Partial<Props> = {}) {
  const handlers = {
    onReact: vi.fn(),
    onReply: vi.fn(),
    onOpenThread: vi.fn(),
    onDelete: vi.fn(),
    onEdit: vi.fn(),
  }
  const view = render(
    <Workspace
      narrow
      channels={[ENG]}
      selectedChannelId={ENG.id}
      messages={[msg()]}
      usersById={usersById}
      connection="connected"
      onSelectChannel={() => {}}
      onSend={() => {}}
      onCloseThread={() => {}}
      onSendThread={() => {}}
      {...handlers}
      {...over}
    />,
  )
  return { ...view, ...handlers }
}

const more = (scope: HTMLElement) => within(scope).queryAllByRole('button', { name: copy.timeline.moreActions })
function openSheet(view: ReturnType<typeof mount>, text?: string) {
  const row = text ? view.getByText(text).closest('article')! : view.getAllByRole('article')[0]!
  fireEvent.click(within(row).getByRole('button', { name: copy.timeline.moreActions }))
  return view.getByRole('dialog', { name: copy.timeline.actionsSheet })
}
const labels = (sheet: HTMLElement) => within(sheet).getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent)

describe('action sheet: content (§23.8 item 2)', () => {
  it("someone else's message: the reactions · Reply · Reply in thread · Copy text, in that order; no Edit nor Delete", () => {
    const view = mount()
    const sheet = openSheet(view)
    expect(labels(sheet)).toEqual([
      fill(copy.timeline.react, { emoji: '👍' }),
      fill(copy.timeline.react, { emoji: '🎉' }),
      fill(copy.timeline.react, { emoji: '❤️' }),
      copy.timeline.reply,
      copy.timeline.replyInThread,
      copy.timeline.copyText,
    ])
    expect(within(sheet).queryByText(copy.timeline.editMessage)).toBeNull()
    // The sheet does not repeat the message (item 7).
    expect(within(sheet).queryByText('hello there')).toBeNull()
  })

  it('one\'s own sent message adds "Editar mensagem" and then "Apagar mensagem" last, in danger (M5, E1 b)', () => {
    const view = mount({ messages: [msg({ author: me.id, mine: true, status: 'sent' })] })
    const sheet = openSheet(view)
    const all = labels(sheet)
    expect(all.slice(-3)).toEqual([copy.timeline.copyText, copy.timeline.editMessage, copy.timeline.deleteMessage])
    expect(within(sheet).getByRole('button', { name: copy.timeline.deleteMessage }).className).toContain('message-sheet__row--danger')
  })

  it('each action only where the wide window offers it', () => {
    // A failed message of one's own: copy text (N4 a), no delete (it never reached the server, ADR-075).
    const failed = mount({ messages: [msg({ author: me.id, mine: true, status: 'failed' })] })
    const failedLabels = labels(openSheet(failed))
    expect(failedLabels).toContain(copy.timeline.copyText)
    expect(failedLabels).not.toContain(copy.timeline.deleteMessage)
    cleanup()
    // An image: no "Copiar texto" (§25.1 item 5).
    const image = mount({ messages: [msg({ body: { kind: 'image', media: 'mr_1' as never, alt: 'foto' } })] })
    expect(labels(openSheet(image))).not.toContain(copy.timeline.copyText)
    cleanup()
    // A root with replies of one's own: no delete (ADR-075 dec. 3).
    const root = mount({ messages: [msg({ author: me.id, mine: true, threadSummary: { replyCount: 1, latestReplyAt: tms(2) } })] })
    expect(labels(openSheet(root))).not.toContain(copy.timeline.deleteMessage)
  })

  it('a message without any action has no "Mais ações" and opens no sheet (a pending one)', () => {
    const view = mount({ messages: [msg({ author: me.id, mine: true, status: 'pending' })] })
    expect(more(view.container)).toHaveLength(0)
    expect(view.queryByRole('dialog')).toBeNull()
  })

  it('the wide window has no "Mais ações" and keeps its bar', () => {
    const view = mount({ narrow: false })
    expect(more(view.container)).toHaveLength(0)
    expect(view.container.querySelector('.message__actions')).not.toBeNull()
  })
})

describe('action sheet: actions (§23.8 items 4–6)', () => {
  it('a reaction toggles and closes the sheet', () => {
    const view = mount()
    const sheet = openSheet(view)
    fireEvent.click(within(sheet).getByRole('button', { name: fill(copy.timeline.react, { emoji: '🎉' }) }))
    expect(view.onReact).toHaveBeenCalledWith(expect.objectContaining({ id: msg().id }), '🎉')
    expect(view.queryByRole('dialog')).toBeNull()
  })

  it('Reply and Reply in thread close the sheet and start their path', () => {
    const view = mount()
    fireEvent.click(within(openSheet(view)).getByRole('button', { name: copy.timeline.reply }))
    expect(view.onReply).toHaveBeenCalledOnce()
    expect(view.queryByRole('dialog')).toBeNull()
    fireEvent.click(within(openSheet(view)).getByRole('button', { name: copy.timeline.replyInThread }))
    expect(view.onOpenThread).toHaveBeenCalledOnce()
    expect(view.queryByRole('dialog')).toBeNull()
  })

  it('Copy text writes the copy rule and closes, also when the clipboard refuses (N8 a)', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const view = mount()
    fireEvent.click(within(openSheet(view)).getByRole('button', { name: copy.timeline.copyText }))
    expect(writeText).toHaveBeenCalledWith('hello there')
    expect(view.queryByRole('dialog')).toBeNull()
    await act(async () => {})
    expect(view.queryByText(copy.timeline.copied)).toBeNull()
  })

  it('Delete asks inside the sheet; "Cancelar" takes the focus; "Apagar" deletes and closes', () => {
    const own = msg({ author: me.id, mine: true, status: 'sent' })
    const view = mount({ messages: [own] })
    const sheet = openSheet(view)
    fireEvent.click(within(sheet).getByRole('button', { name: copy.timeline.deleteMessage }))
    expect(within(sheet).getByText(copy.timeline.deleteQuestion)).toBeTruthy()
    expect(labels(sheet)).toEqual([copy.timeline.delete, copy.timeline.cancel])
    expect(document.activeElement).toBe(within(sheet).getByRole('button', { name: copy.timeline.cancel }))
    expect(view.onDelete).not.toHaveBeenCalled()
    fireEvent.click(within(sheet).getByRole('button', { name: copy.timeline.delete }))
    expect(view.onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: own.id }))
    expect(view.queryByRole('dialog')).toBeNull()
  })

  it('"Cancelar" closes without deleting', () => {
    const view = mount({ messages: [msg({ author: me.id, mine: true, status: 'sent' })] })
    const sheet = openSheet(view)
    fireEvent.click(within(sheet).getByRole('button', { name: copy.timeline.deleteMessage }))
    fireEvent.click(within(sheet).getByRole('button', { name: copy.timeline.cancel }))
    expect(view.onDelete).not.toHaveBeenCalled()
    expect(view.queryByRole('dialog')).toBeNull()
  })

  it('the row is held while the sheet is open, and the focus goes back to its "Mais ações"', () => {
    const view = mount()
    const row = view.getAllByRole('article')[0]!
    const button = within(row).getByRole('button', { name: copy.timeline.moreActions })
    button.focus()
    const sheet = openSheet(view)
    expect(row.getAttribute('data-held')).toBe('true')
    fireEvent.keyDown(sheet, { key: 'Escape' })
    expect(row.hasAttribute('data-held')).toBe(false)
    expect(document.activeElement).toBe(button)
  })

  it('a message that goes away closes its sheet', () => {
    const view = mount()
    openSheet(view)
    view.rerender(
      <Workspace narrow channels={[ENG]} selectedChannelId={ENG.id} messages={[]} usersById={usersById} connection="connected" onSelectChannel={() => {}} onSend={() => {}} />,
    )
    expect(view.queryByRole('dialog')).toBeNull()
  })
})

describe('action sheet in the thread (§23.8 item 9, §29 item 1; R7)', () => {
  const root = msg({ id: mid('$root:tayet.local'), author: me.id, mine: true, status: 'sent' })
  const reply = msg({ id: mid('$r1:tayet.local'), author: me.id, mine: true, status: 'sent', threadParent: root.id, body: { kind: 'text', text: 'my reply' } })

  it('a reply of one\'s own: the reactions, Copy text, Edit and Delete; no Reply, no Reply in thread', () => {
    const view = mount({ messages: [root], threadRoot: root, threadMessages: [reply] })
    const panel = view.getByRole('complementary', { name: copy.thread.title })
    fireEvent.click(within(within(panel).getByText('my reply').closest('article')!).getByRole('button', { name: copy.timeline.moreActions }))
    const sheet = view.getByRole('dialog', { name: copy.timeline.actionsSheet })
    expect(labels(sheet)).toEqual([
      fill(copy.timeline.react, { emoji: '👍' }),
      fill(copy.timeline.react, { emoji: '🎉' }),
      fill(copy.timeline.react, { emoji: '❤️' }),
      copy.timeline.copyText,
      copy.timeline.editMessage,
      copy.timeline.deleteMessage,
    ])
    fireEvent.click(within(sheet).getByRole('button', { name: copy.timeline.deleteMessage }))
    fireEvent.click(within(sheet).getByRole('button', { name: copy.timeline.delete }))
    expect(view.onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: reply.id }))
  })

  it('the root with replies on screen offers no delete (the ThreadPanel gate); without replies it does', () => {
    const rootRow = (v: ReturnType<typeof mount>) =>
      within(v.getByRole('complementary', { name: copy.thread.title })).getAllByRole('article')[0]!
    const withReplies = mount({ messages: [root], threadRoot: root, threadMessages: [reply] })
    fireEvent.click(within(rootRow(withReplies)).getByRole('button', { name: copy.timeline.moreActions }))
    expect(labels(withReplies.getByRole('dialog'))).not.toContain(copy.timeline.deleteMessage)
    cleanup()
    const alone = mount({ messages: [root], threadRoot: root, threadMessages: [] })
    fireEvent.click(within(rootRow(alone)).getByRole('button', { name: copy.timeline.moreActions }))
    expect(labels(alone.getByRole('dialog'))).toContain(copy.timeline.deleteMessage)
  })
})

describe('action sheet render-scan (P1)', () => {
  it('the sheet and its delete question carry no protocol shape', () => {
    const view = mount({ messages: [msg({ author: me.id, mine: true, status: 'sent' })] })
    const sheet = openSheet(view)
    expect(findProtocolLeaksInText(sheet.outerHTML)).toEqual([])
    fireEvent.click(within(sheet).getByRole('button', { name: copy.timeline.deleteMessage }))
    expect(findProtocolLeaksInText(sheet.outerHTML)).toEqual([])
    expect(findProtocolLeaksInText(view.container.innerHTML)).toEqual([])
  })
})
