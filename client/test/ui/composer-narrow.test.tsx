// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, within } from '@testing-library/react'
import { act } from 'react'
import type { Editor } from '@tiptap/react'
import type { AgentCommand, User, UserId } from '../../src/acl'
import { RichComposer } from '../../src/ui/composer/RichComposer'
import { copy } from '../support/copy'

// The narrow composer (workspace.md §23.7 items 1, 2 and 5; PLANO-MOBILE §0.15): one line, the bands, "Aa", the
// edit from the bottom composer with its draft put aside and given back (E2 a), the `/` and `@` rules read live
// after the mode flips (the stale `editing` of the `/` rule), and Enter with a coarse pointer (N1 b). jsdom does
// not type into a contenteditable: content enters through the editor instance (onEditor).

const uid = (s: string): UserId => s as unknown as UserId
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const rafael: User = { id: uid('@rafael:tayet.local'), displayName: 'Rafael Souza', kind: 'member' }
const daily: User = { id: uid('@daily-bot:tayet.local'), displayName: 'Relatório diário', kind: 'agent', agentColor: 'argila' }
const users = [rafael, daily]
const commands: AgentCommand[] = [{ agent: daily.id, name: 'resumo', description: 'O que mudou desde ontem' }]

type Props = Partial<Parameters<typeof RichComposer>[0]>
function mount(props: Props = {}) {
  const onSend = vi.fn()
  let editor: Editor | null = null
  const base = { onSend, users, commands, narrow: true, onSendAttachment: () => {}, onEditor: (e: Editor | null) => (editor = e) }
  const view = render(<RichComposer {...base} {...props} />)
  const rerender = (next: Props) => view.rerender(<RichComposer {...base} {...next} />)
  const dom = (): HTMLElement => view.container.querySelector('[contenteditable]') as HTMLElement
  return { ...view, onSend, editor: () => editor!, rerender, dom }
}
async function type(editor: Editor, text: string): Promise<void> {
  await act(async () => {
    editor.commands.focus('end')
    editor.commands.insertContent(text)
    await flush()
  })
}
async function key(dom: HTMLElement, k: string, extra: object = {}): Promise<void> {
  await act(async () => {
    fireEvent.keyDown(dom, { key: k, ...extra })
    await flush()
  })
}
const listbox = (c: HTMLElement) => c.querySelector('[role="listbox"]')
function pointer(coarse: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(pointer: coarse)' ? coarse : q === '(width < 728px)', addEventListener() {}, removeEventListener() {} }))
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('one line (§23.7 items 1 and 5)', () => {
  it.each(['full', 'compact'] as const)('%s: attach · field · "Aa" · send (icon only), in that order; no mention button', (variant) => {
    const { container } = mount({ variant })
    const line = container.querySelector('.composer__line') as HTMLElement
    const parts = [...line.children].map((el) => el.getAttribute('aria-label') ?? (el.classList.contains('composer__field') ? 'field' : '?'))
    expect(parts).toEqual([copy.composer.attach, 'field', copy.composer.formatting, copy.composer.send])
    expect(within(line).getByRole('button', { name: copy.composer.send }).textContent).toBe('')
    expect(within(container).queryByRole('button', { name: copy.composer.mention })).toBeNull()
    expect(container.querySelector('.composer__toolbar')).toBeNull()
  })

  it('the wide composer keeps its rows (nothing changes from 728px)', () => {
    const { container } = mount({ narrow: false })
    expect(container.querySelector('.composer__line')).toBeNull()
    expect(container.querySelector('.composer__toolbar')).not.toBeNull()
    expect(within(container).getByRole('button', { name: copy.composer.mention })).toBeTruthy()
  })
})

describe('"Aa" and the formatting band (§23.7 item 2)', () => {
  it('opens and closes the toolbar as a band, pressed while open; the six buttons in order; closed on a new conversation', () => {
    const { container, getByRole, rerender } = mount({ conversation: 'a' })
    const aa = getByRole('button', { name: copy.composer.formatting })
    expect(aa.getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(aa)
    expect(aa.getAttribute('aria-pressed')).toBe('true')
    const bar = getByRole('toolbar', { name: copy.composer.formatting })
    expect(within(bar).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual([
      copy.composer.bold,
      copy.composer.italic,
      copy.composer.strike,
      copy.composer.link,
      copy.composer.bulletList,
      copy.composer.code,
    ])
    fireEvent.click(aa)
    expect(container.querySelector('.composer__toolbar')).toBeNull()
    fireEvent.click(aa)
    rerender({ conversation: 'b' })
    expect(container.querySelector('.composer__toolbar')).toBeNull()
  })
})

describe('the reply band (§23.7 item 2)', () => {
  it('"Respondendo a {nome}" over the excerpt, with a 44 close named "Cancelar resposta"', () => {
    const onCancelReply = vi.fn()
    const { container, getByRole } = mount({ replyingTo: { author: 'Clara Rocha', excerpt: 'A nota chegou' }, onCancelReply })
    const band = container.querySelector('.composer__band.composer__reply') as HTMLElement
    expect(band.textContent).toContain('Clara Rocha')
    expect(band.textContent).toContain('A nota chegou')
    fireEvent.click(getByRole('button', { name: copy.composer.cancelReply }))
    expect(onCancelReply).toHaveBeenCalled()
  })
})

describe('editing from the bottom composer (§23.7 item 2; E1 b, E2 a)', () => {
  const target = { key: 'm1', html: '<p>A nota foi <strong>paga</strong></p>' }

  it('the band, no attach, "Salvar" in place of send, and the message with its formatting in the live editor', async () => {
    const m = mount()
    m.rerender({ editTarget: target, onSaveEdit: vi.fn(), onCancelEdit: vi.fn() })
    expect(within(m.container).getByRole('status').textContent).toContain(copy.composer.editing)
    expect(m.queryByRole('button', { name: copy.composer.cancelEdit })).not.toBeNull()
    expect(m.container.querySelector('.composer__attach')).toBeNull()
    expect(m.getByRole('button', { name: copy.composer.editSave })).toBeTruthy()
    expect(m.queryByRole('button', { name: copy.composer.send })).toBeNull()
    expect(m.editor().getHTML()).toBe(target.html)
  })

  it('the draft (the document, chip and marks included) is put aside and comes back on cancel and on save', async () => {
    const onSaveEdit = vi.fn()
    const m = mount()
    await type(m.editor(), '/res')
    await key(m.dom(), 'Enter') // picks the command: the chip
    await type(m.editor(), 'hoje')
    const draft = m.editor().getJSON()
    m.rerender({ editTarget: target, onSaveEdit, onCancelEdit: vi.fn() })
    expect(m.editor().getHTML()).toBe(target.html)
    m.rerender({})
    expect(m.editor().getJSON()).toEqual(draft)
    // Save: the body goes to onSaveEdit, never to onSend; the caller leaves the edit and the draft comes back.
    m.rerender({ editTarget: target, onSaveEdit, onCancelEdit: vi.fn() })
    fireEvent.click(m.getByRole('button', { name: copy.composer.editSave }))
    expect(onSaveEdit).toHaveBeenCalledWith(expect.objectContaining({ text: 'A nota foi paga' }))
    expect(m.onSend).not.toHaveBeenCalled()
    m.rerender({})
    expect(m.editor().getJSON()).toEqual(draft)
  })

  it('an empty field does not save; Esc and the band close cancel', async () => {
    const onSaveEdit = vi.fn()
    const onCancelEdit = vi.fn()
    const m = mount()
    m.rerender({ editTarget: target, onSaveEdit, onCancelEdit })
    act(() => void m.editor().commands.clearContent())
    fireEvent.click(m.getByRole('button', { name: copy.composer.editSave }))
    expect(onSaveEdit).not.toHaveBeenCalled()
    await key(m.dom(), 'Escape')
    fireEvent.click(m.getByRole('button', { name: copy.composer.cancelEdit }))
    expect(onCancelEdit).toHaveBeenCalledTimes(2)
  })
})

describe('the `/` and `@` rules read the live mode (the stale `editing`, fixed in M5)', () => {
  it('created in send mode: editing opens no list for `/` nor `@`; back in send mode, `/` opens it again', async () => {
    const m = mount()
    m.rerender({ editTarget: { key: 'm1', html: '<p></p>' }, onSaveEdit: vi.fn(), onCancelEdit: vi.fn() })
    act(() => void m.editor().commands.clearContent())
    await type(m.editor(), '/')
    expect(listbox(m.container)).toBeNull()
    await type(m.editor(), ' @Ra')
    expect(listbox(m.container)).toBeNull()
    m.rerender({})
    act(() => void m.editor().commands.clearContent())
    await type(m.editor(), '/')
    expect(listbox(m.container)?.getAttribute('aria-label')).toBe(copy.composer.commands)
    act(() => void m.editor().commands.clearContent())
    await type(m.editor(), '@Ra')
    expect(listbox(m.container)?.getAttribute('aria-label')).toBe(copy.composer.mention)
  })
})

describe('Enter by pointer (N1 b)', () => {
  it('coarse pointer, narrow: Enter breaks the line and sends nothing; the button sends', async () => {
    pointer(true)
    const m = mount()
    await type(m.editor(), 'linha um')
    await key(m.dom(), 'Enter')
    expect(m.onSend).not.toHaveBeenCalled()
    expect(m.editor().getJSON().content).toHaveLength(2)
    fireEvent.click(m.getByRole('button', { name: copy.composer.send }))
    expect(m.onSend).toHaveBeenCalledTimes(1)
  })

  it('coarse pointer with the suggestion open: Enter still picks the row', async () => {
    pointer(true)
    const m = mount()
    await type(m.editor(), '@Ra')
    await key(m.dom(), 'Enter')
    expect(JSON.stringify(m.editor().getJSON())).toContain('"label":"Rafael Souza"')
    expect(m.onSend).not.toHaveBeenCalled()
  })

  it('fine pointer: Enter sends, in any width; coarse on a wide window: Enter sends', async () => {
    pointer(false)
    const narrow = mount()
    await type(narrow.editor(), 'oi')
    await key(narrow.dom(), 'Enter')
    expect(narrow.onSend).toHaveBeenCalledTimes(1)
    cleanup()
    pointer(true)
    const wide = mount({ narrow: false })
    await type(wide.editor(), 'oi')
    await key(wide.dom(), 'Enter')
    expect(wide.onSend).toHaveBeenCalledTimes(1)
  })
})
