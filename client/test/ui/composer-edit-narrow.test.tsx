// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, within, act } from '@testing-library/react'
import type { Editor } from '@tiptap/core'
import { Workspace } from '../../src/ui/components/Workspace'
import type { Channel, ChannelId, Message, MessageId, User, UserId } from '../../src/acl'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { copy } from '../support/copy'

// Editing from the bottom composer on the narrow window (workspace.md §23.7 item 2, §23.8 item 5; PLANO-MOBILE
// §0.15 E1 to E3 and the implementation list) and the link sheet (§23.7 item 3), through the Workspace: "Editar
// mensagem" in the sheet takes the composer of the same screen into editing, the draft is given back, the row is
// marked by a flag (never an id), and the edit is cancelled by the message going away, another conversation, the
// thread closing, a wide window or "Responder". The link opens as a BottomSheet, a direct child of `.workspace`.

const cid = (s: string): ChannelId => s as unknown as ChannelId
const uid = (s: string): UserId => s as unknown as UserId
const mid = (s: string): MessageId => s as unknown as MessageId
const me: User = { id: uid('@me:tayet.local'), displayName: 'Me Myself', kind: 'member' }
const alice: User = { id: uid('@alice:tayet.local'), displayName: 'Alice Anderson', kind: 'member' }
const usersById = { [me.id]: me, [alice.id]: alice }
const ENG: Channel = { id: cid('!eng:tayet.local'), name: '#eng', kind: 'public', memberCount: 2, unread: { count: 0, mentions: 0 } }
const OPS: Channel = { id: cid('!ops:tayet.local'), name: '#ops', kind: 'public', memberCount: 2, unread: { count: 0, mentions: 0 } }

function msg(id: string, text: string, over: Partial<Message> = {}): Message {
  return {
    id: mid(`$${id}:tayet.local`),
    channelId: ENG.id,
    author: me.id,
    body: { kind: 'text', text },
    sentAt: 1 as unknown as Message['sentAt'],
    reactions: [],
    mine: true,
    mentionsMe: false,
    ...over,
  }
}
const mine = msg('m1', 'texto original', { body: { kind: 'text', text: 'texto original', rich: [{ t: 'p', children: [{ t: 'strong', children: [{ t: 'text', text: 'texto' }] }, { t: 'text', text: ' original' }] }] } })
const theirs = msg('m2', 'da alice', { author: alice.id, mine: false })

type Props = Parameters<typeof Workspace>[0]
function mount(over: Partial<Props> = {}) {
  const handlers = { onReact: vi.fn(), onReply: vi.fn(), onOpenThread: vi.fn(), onDelete: vi.fn(), onEdit: vi.fn(), onCancelReply: vi.fn(), onSend: vi.fn() }
  const props = (next: Partial<Props>): Props => ({
    narrow: true,
    channels: [ENG, OPS],
    selectedChannelId: ENG.id,
    messages: [theirs, mine],
    usersById,
    connection: 'connected',
    onSelectChannel: () => {},
    onCloseThread: () => {},
    onSendThread: () => {},
    ...handlers,
    ...next,
  })
  const view = render(<Workspace {...props(over)} />)
  return { ...view, ...handlers, rerender: (next: Partial<Props>) => view.rerender(<Workspace {...props({ ...over, ...next })} />) }
}
const editorIn = (scope: HTMLElement): Editor =>
  (scope.querySelector('.composer [contenteditable]') as HTMLElement & { editor: Editor }).editor
const mainOf = (v: ReturnType<typeof mount>) => v.container.querySelector('main') as HTMLElement
function openSheetOn(v: ReturnType<typeof mount>, text: string, scope: HTMLElement = v.container) {
  fireEvent.click(within(within(scope).getByText(text).closest('article')!).getByRole('button', { name: copy.timeline.moreActions }))
  return v.getByRole('dialog', { name: copy.timeline.actionsSheet })
}
function startEdit(v: ReturnType<typeof mount>, text = 'original', scope?: HTMLElement) {
  const sheet = openSheetOn(v, text, scope)
  fireEvent.click(within(sheet).getByRole('button', { name: copy.timeline.editMessage }))
}

afterEach(cleanup)

describe('"Editar mensagem" from the sheet (E1 b, E2 a)', () => {
  it('the conversation composer edits the message (formatting kept), focused, and the row carries a flag, never an id', async () => {
    const v = mount()
    startEdit(v)
    // TipTap's focus lands on the next frame.
    await act(async () => void (await new Promise((r) => requestAnimationFrame(r))))
    expect(v.queryByRole('dialog', { name: copy.timeline.actionsSheet })).toBeNull()
    const main = mainOf(v)
    expect(within(main).getByRole('status').textContent).toContain(copy.composer.editing)
    expect(editorIn(main).getHTML()).toBe('<p><strong>texto</strong> original</p>')
    expect(main.querySelector('.composer')!.contains(document.activeElement)).toBe(true)
    const marked = main.querySelectorAll('article[data-editing="true"]')
    expect(marked).toHaveLength(1)
    expect(marked[0]!.textContent).toContain('texto original')
    expect(findProtocolLeaksInText(main.outerHTML)).toEqual([])
  })

  it('someone else\'s message offers no edit; a command message neither', () => {
    const v = mount({ messages: [theirs, msg('c', '/resumo x', { command: { agent: alice.id, name: 'resumo' } })] })
    expect(within(openSheetOn(v, 'da alice')).queryByRole('button', { name: copy.timeline.editMessage })).toBeNull()
  })

  it('save sends the edit with no mentions and gives the draft back; cancel too', () => {
    const v = mount()
    const main = mainOf(v)
    act(() => void editorIn(main).commands.setContent('<p>meu rascunho</p>'))
    startEdit(v)
    act(() => void editorIn(main).commands.setContent('<p>texto novo</p>'))
    fireEvent.click(within(main).getByRole('button', { name: copy.composer.editSave }))
    expect(v.onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: mine.id }), { text: 'texto novo' })
    expect(v.onSend).not.toHaveBeenCalled()
    expect(editorIn(main).getText()).toBe('meu rascunho')
    expect(within(main).queryByText(copy.composer.editing)).toBeNull()
    startEdit(v)
    fireEvent.click(within(main).getByRole('button', { name: copy.composer.cancelEdit }))
    expect(editorIn(main).getText()).toBe('meu rascunho')
  })

  it('entering the edit closes the reply band; "Responder" during the edit cancels it', () => {
    const v = mount({ replyTarget: theirs })
    startEdit(v)
    expect(v.onCancelReply).toHaveBeenCalled()
    v.rerender({ replyTarget: undefined })
    const sheet = openSheetOn(v, 'da alice')
    fireEvent.click(within(sheet).getByRole('button', { name: copy.timeline.reply }))
    expect(v.onReply).toHaveBeenCalled()
    expect(within(mainOf(v)).queryByText(copy.composer.editing)).toBeNull()
  })
})

describe('what cancels the edit and gives the draft back', () => {
  it.each([
    ['the message goes away', { messages: [theirs] }],
    ['another conversation', { selectedChannelId: OPS.id, messages: [] }],
    ['a wide window', { narrow: false }],
  ] as const)('%s', (_name, next) => {
    const v = mount()
    const main = mainOf(v)
    act(() => void editorIn(main).commands.setContent('<p>rascunho</p>'))
    startEdit(v)
    v.rerender(next as Partial<Props>)
    expect(v.container.querySelector('[data-editing]')).toBeNull()
    expect(within(mainOf(v)).queryByText(copy.composer.editing)).toBeNull()
    expect(editorIn(mainOf(v)).getText()).toBe('rascunho')
  })
})

describe('in the thread (§32: the thread sheet and composer have the edit)', () => {
  const root = msg('r', 'raiz da thread', { author: alice.id, mine: false })
  const reply = msg('t1', 'minha resposta', { threadParent: root.id })

  it('the thread composer edits the reply; closing the thread cancels', () => {
    const v = mount({ messages: [root], threadRoot: root, threadMessages: [reply] })
    const panel = v.getByRole('complementary', { name: copy.thread.title })
    startEdit(v, 'minha resposta', panel)
    expect(within(panel).getByRole('status').textContent).toContain(copy.composer.editing)
    expect(editorIn(panel).getText()).toBe('minha resposta')
    expect(within(mainOf(v)).queryByText(copy.composer.editing)).toBeNull()
    v.rerender({ threadRoot: undefined, threadMessages: undefined })
    expect(within(mainOf(v)).queryByText(copy.composer.editing)).toBeNull()
  })
})

describe('the link sheet (§23.7 item 3)', () => {
  function openLink(v: ReturnType<typeof mount>) {
    const main = mainOf(v)
    fireEvent.click(within(main).getByRole('button', { name: copy.composer.formatting }))
    fireEvent.click(within(main).getByRole('button', { name: copy.composer.link }))
    return v.getByRole('dialog', { name: copy.composer.linkInsert })
  }

  it('a BottomSheet with the form padding, a direct child of the workspace; the focus on "Texto"; invalid URL marked', () => {
    const v = mount()
    const sheet = openLink(v)
    expect(sheet.parentElement).toBe(v.container.querySelector('.workspace'))
    expect(sheet.getAttribute('data-padding')).toBe('form')
    expect(document.activeElement).toBe(within(sheet).getByLabelText(copy.composer.linkText))
    expect(within(sheet).getAllByRole('button').map((b) => b.textContent)).toEqual([copy.composer.linkInsertAction, copy.composer.linkCancel])
    fireEvent.change(within(sheet).getByLabelText(copy.composer.linkUrl), { target: { value: 'javascript:alert(1)' } })
    fireEvent.click(within(sheet).getByRole('button', { name: copy.composer.linkInsertAction }))
    expect(within(sheet).getByRole('alert').textContent).toBe(copy.composer.linkInvalid)
    expect(within(sheet).getByLabelText(copy.composer.linkUrl).closest('.ui-field')!.hasAttribute('data-error')).toBe(true)
    expect(editorIn(mainOf(v)).getHTML()).not.toContain('<a')
  })

  it('"Inserir" puts the link in the composer and closes; on a link, "Editar link" offers "Remover"', () => {
    const v = mount()
    let sheet = openLink(v)
    fireEvent.change(within(sheet).getByLabelText(copy.composer.linkText), { target: { value: 'pedido' } })
    fireEvent.change(within(sheet).getByLabelText(copy.composer.linkUrl), { target: { value: 'https://example.com' } })
    fireEvent.click(within(sheet).getByRole('button', { name: copy.composer.linkInsertAction }))
    expect(v.queryByRole('dialog', { name: copy.composer.linkInsert })).toBeNull()
    const editor = editorIn(mainOf(v))
    expect(editor.getHTML()).toContain('href="https://example.com"')
    act(() => void editor.commands.setTextSelection(3))
    fireEvent.click(within(mainOf(v)).getByRole('button', { name: copy.composer.link }))
    sheet = v.getByRole('dialog', { name: copy.composer.linkEdit })
    // A caret (no selection) seeds no text: the Dialog's rule puts the focus on "Texto".
    expect(document.activeElement).toBe(within(sheet).getByLabelText(copy.composer.linkText))
    expect((within(sheet).getByLabelText(copy.composer.linkUrl) as HTMLInputElement).value).toBe('https://example.com')
    fireEvent.click(within(sheet).getByRole('button', { name: copy.composer.linkRemove }))
    expect(editorIn(mainOf(v)).getHTML()).not.toContain('<a')
  })

  it('"Cancelar" closes without a link; the wide window keeps the Dialog', () => {
    const v = mount()
    const sheet = openLink(v)
    fireEvent.click(within(sheet).getByRole('button', { name: copy.composer.linkCancel }))
    expect(v.queryByRole('dialog')).toBeNull()
    cleanup()
    const wide = mount({ narrow: false })
    fireEvent.click(within(mainOf(wide)).getByRole('button', { name: copy.composer.link }))
    const dialog = wide.getByRole('dialog', { name: copy.composer.linkInsert })
    expect(dialog.classList.contains('ui-sheet')).toBe(false)
  })
})
