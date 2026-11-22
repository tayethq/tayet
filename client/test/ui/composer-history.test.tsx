// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { act } from 'react'
import type { Editor } from '@tiptap/react'
import type { AgentCommand, ChannelId, Message, MessageId, User, UserId } from '../../src/acl'
import { RichComposer } from '../../src/ui/composer/RichComposer'
import { historyOf } from '../../src/ui/composer/history'
import { editorToComposeResult } from '../../src/ui/composer/doc-to-rich'
import { copy } from '../support/copy'

// The ↑/↓ history in the composer (workspace.md §25.6; issue tayethq/tayet #2; PLANO-MOBILE §0.15 H1 c, H2 a):
// what goes in (one's own text messages already loaded, newest first), when ↑ starts, the walk and its end, Esc,
// a command message coming back with its chip rebuilt and leaving again as a command, a command no longer listed
// skipped, and plain text starting with "/" never becoming a command. jsdom does not type: content enters through
// the editor instance.

const uid = (s: string): UserId => s as unknown as UserId
const mid = (s: string): MessageId => s as unknown as MessageId
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const me: User = { id: uid('@me:tayet.local'), displayName: 'Eu', kind: 'member' }
const rafael: User = { id: uid('@rafael:tayet.local'), displayName: 'Rafael Souza', kind: 'member' }
const daily: User = { id: uid('@daily-bot:tayet.local'), displayName: 'Relatório diário', kind: 'agent', agentColor: 'argila' }
const users = [me, rafael, daily]
const commands: AgentCommand[] = [{ agent: daily.id, name: 'resumo', description: 'O que mudou desde ontem', hint: 'período' }]

let n = 0
function msg(over: Partial<Message> & { text?: string } = {}): Message {
  const { text = 'oi', ...rest } = over
  n += 1
  return {
    id: mid(`$m${n}:tayet.local`),
    channelId: '!c:tayet.local' as unknown as ChannelId,
    author: me.id,
    body: { kind: 'text', text },
    sentAt: n as unknown as Message['sentAt'],
    reactions: [],
    mine: true,
    mentionsMe: false,
    ...rest,
  }
}

function mount(messages: Message[], props: Partial<Parameters<typeof RichComposer>[0]> = {}) {
  const onSend = vi.fn()
  let editor: Editor | null = null
  const view = render(
    <RichComposer onSend={onSend} users={users} commands={commands} history={historyOf(messages)} onEditor={(e) => (editor = e)} {...props} />,
  )
  const dom = view.container.querySelector('[contenteditable]') as HTMLElement
  return { ...view, onSend, editor: () => editor!, dom }
}
async function key(dom: HTMLElement, k: string): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(dom, { key: k })
    await flush()
  })
}
async function type(editor: Editor, text: string): Promise<void> {
  await act(async () => {
    editor.commands.focus('end')
    editor.commands.insertContent(text)
    await flush()
  })
}
const text = (e: Editor) => e.getText()
const listbox = (c: HTMLElement) => c.querySelector('[role="listbox"]')

afterEach(cleanup)

describe('historyOf (§25.6 item 1)', () => {
  it("one's own text messages, newest first; out: pending, failed, someone else's and other kinds", () => {
    const list = [
      msg({ text: 'primeira' }),
      msg({ text: 'alheia', mine: false, author: rafael.id }),
      msg({ text: 'pendente', status: 'pending' }),
      msg({ text: 'falhou', status: 'failed' }),
      msg({ body: { kind: 'image', media: 'mr_1' as never, alt: 'foto' } }),
      msg({ text: 'enviada', status: 'sent' }),
      msg({ text: 'última' }),
    ]
    expect(historyOf(list).map((h) => h.html)).toEqual(['<p>última</p>', '<p>enviada</p>', '<p>primeira</p>'])
  })
})

describe('the walk (§25.6 item 2)', () => {
  it('nothing to bring: ↑ leaves the field empty', async () => {
    const m = mount([])
    await key(m.dom, 'ArrowUp')
    expect(m.editor().isEmpty).toBe(true)
  })

  it('↑ on an empty field brings the newest, ↑ the older, ↓ the newer, ↓ past the newest empties', async () => {
    const m = mount([msg({ text: 'um' }), msg({ text: 'dois' }), msg({ text: 'três' })])
    await key(m.dom, 'ArrowUp')
    expect(text(m.editor())).toBe('três')
    await key(m.dom, 'ArrowUp')
    expect(text(m.editor())).toBe('dois')
    await key(m.dom, 'ArrowUp')
    await key(m.dom, 'ArrowUp') // past the oldest: stays
    expect(text(m.editor())).toBe('um')
    await key(m.dom, 'ArrowDown')
    expect(text(m.editor())).toBe('dois')
    await key(m.dom, 'ArrowDown')
    await key(m.dom, 'ArrowDown')
    expect(m.editor().isEmpty).toBe(true)
  })

  it('a formatted message comes back with its formatting; a mention comes back as "@nome" text (H2 a)', async () => {
    const m = mount([
      msg({ text: 'pago @Rafael Souza', body: { kind: 'text', text: 'pago @Rafael Souza', rich: [{ t: 'p', children: [{ t: 'strong', children: [{ t: 'text', text: 'pago' }] }, { t: 'text', text: ' @Rafael Souza' }] }] } }),
    ])
    await key(m.dom, 'ArrowUp')
    expect(m.editor().getHTML()).toBe('<p><strong>pago</strong> @Rafael Souza</p>')
    expect(JSON.stringify(m.editor().getJSON())).not.toContain('"type":"mention"')
    // No mention list over the text the history brought.
    expect(listbox(m.container)).toBeNull()
  })

  it('↑ does not start with text in the field, in edit mode, nor with the suggestion open', async () => {
    const list = [msg({ text: 'antiga' })]
    const typed = mount(list)
    await type(typed.editor(), 'rascunho')
    await key(typed.dom, 'ArrowUp')
    expect(text(typed.editor())).toBe('rascunho')
    cleanup()
    const editing = mount(list, { editTarget: { key: 'x', html: '<p></p>' }, onSaveEdit: vi.fn(), onCancelEdit: vi.fn() })
    act(() => void editing.editor().commands.clearContent())
    await key(editing.dom, 'ArrowUp')
    expect(editing.editor().isEmpty).toBe(true)
    cleanup()
    const open = mount(list)
    await type(open.editor(), '@Ra')
    await key(open.dom, 'ArrowUp')
    expect(text(open.editor())).toBe('@Ra')
  })

  it('editing the text brought ends the walk: ↑ and ↓ move the caret again', async () => {
    const m = mount([msg({ text: 'um' }), msg({ text: 'dois' })])
    await key(m.dom, 'ArrowUp')
    await type(m.editor(), ' mais')
    await key(m.dom, 'ArrowUp')
    expect(text(m.editor())).toBe('dois mais')
    await key(m.dom, 'ArrowDown')
    expect(text(m.editor())).toBe('dois mais')
  })

  it('Esc empties the field the history filled', async () => {
    const m = mount([msg({ text: 'um' })])
    await key(m.dom, 'ArrowUp')
    await key(m.dom, 'Escape')
    expect(m.editor().isEmpty).toBe(true)
  })

  it('sending what came back is a new message (no edit)', async () => {
    const onSaveEdit = vi.fn()
    const m = mount([msg({ text: 'de novo' })], { onSaveEdit: undefined })
    await key(m.dom, 'ArrowUp')
    await key(m.dom, 'Enter')
    expect(m.onSend).toHaveBeenCalledWith({ text: 'de novo' }, [])
    expect(onSaveEdit).not.toHaveBeenCalled()
  })
})

describe('commands in the history (H1 c)', () => {
  // The form found (hypothesis of the prompt, checked): Message.command = { agent, name }, and the message's
  // text and rich start with "/name" followed by nothing or a blank — the composer's own output.
  it('the message a picked command leaves starts with "/name" then a blank', async () => {
    const m = mount([])
    await type(m.editor(), '/res')
    await key(m.dom, 'Enter')
    await type(m.editor(), 'da semana')
    const body = editorToComposeResult(m.editor())
    expect(body.text).toBe('/resumo da semana')
  })

  it('comes back with the chip rebuilt from the live list and the arguments; sent again, it leaves as a command', async () => {
    const m = mount([msg({ text: '/resumo da semana', command: { agent: daily.id, name: 'resumo' } })])
    await key(m.dom, 'ArrowUp')
    const first = m.editor().getJSON().content?.[0]?.content?.[0]
    expect(first).toMatchObject({ type: 'mention', attrs: { id: daily.id, label: daily.displayName, command: 'resumo', hint: 'período' } })
    expect(text(m.editor())).toBe('/resumo da semana')
    await key(m.dom, 'Enter')
    expect(m.onSend).toHaveBeenCalledWith({ text: '/resumo da semana' }, [], { agent: daily.id, name: 'resumo' })
  })

  it('a command alone comes back as the chip with its hint, and leaves as a command', async () => {
    const m = mount([msg({ text: '/resumo', command: { agent: daily.id, name: 'resumo' } })])
    await key(m.dom, 'ArrowUp')
    expect(m.container.querySelector('[data-command-hint]')?.getAttribute('data-command-hint')).toContain('período')
    fireEvent.click(m.getByRole('button', { name: copy.composer.send }))
    expect(m.onSend).toHaveBeenCalledWith({ text: '/resumo' }, [], { agent: daily.id, name: 'resumo' })
  })

  it('a command no longer listed, or whose agent left, is skipped', async () => {
    const m = mount(
      [
        msg({ text: 'comum' }),
        msg({ text: '/velho x', command: { agent: daily.id, name: 'velho' } }),
        msg({ text: '/resumo y', command: { agent: rafael.id, name: 'resumo' } }),
      ],
      { users: [me, daily] },
    )
    await key(m.dom, 'ArrowUp')
    expect(text(m.editor())).toBe('comum')
  })

  it('plain text starting with "/" comes back as text: no list, and it leaves without a command', async () => {
    const m = mount([msg({ text: '/resumo sem escolher' })])
    await key(m.dom, 'ArrowUp')
    expect(listbox(m.container)).toBeNull()
    await key(m.dom, 'Enter')
    expect(m.onSend).toHaveBeenCalledWith({ text: '/resumo sem escolher' }, [])
  })
})
