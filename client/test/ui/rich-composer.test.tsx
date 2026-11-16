// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { act } from 'react'
import type { Editor } from '@tiptap/react'
import type { User, UserId } from '../../src/acl'
import { RichComposer, shiftEnterSplit } from '../../src/ui/composer/RichComposer'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { copy } from '../support/copy'

const uid = (s: string): UserId => s as unknown as UserId
// The suggestion plugin resolves its candidate items ASYNCHRONOUSLY (a Promise, even at debounce 0),
// so the React picker renders after a microtask flush — jsdom needs an explicit turn of the loop.
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

// RichComposer (ADR-051, PLANO-COMPOSER PR-1): a ilha TipTap monta em jsdom, o send emite TEXTO
// PLANO pelo contrato onSend(text, mentions=[]) e o DOM do editor passa o P1. jsdom não digita de
// verdade num contenteditable — o conteúdo entra pela instância capturada via test-seam onEditor
// (editor.commands.setContent), não por fireEvent.

afterEach(cleanup)

describe('RichComposer (flag-mounted island, PR-1)', () => {
  it('mounts a live contenteditable', () => {
    const { container } = render(<RichComposer onSend={() => {}} />)
    expect(container.querySelector('[contenteditable="true"]')).toBeTruthy()
  })

  it('send emits the ComposeResult (rich when formatted) with empty mentions and clears the editor', () => {
    const spy = vi.fn()
    let editor: Editor | null = null
    const { getByRole } = render(
      <RichComposer onSend={spy} onEditor={(e) => (editor = e)} />,
    )
    expect(editor).toBeTruthy()

    act(() => {
      editor!.commands.setContent('<p>olá <strong>mundo</strong></p>')
    })
    act(() => {
      getByRole('button', { name: 'Enviar' }).click()
    })

    expect(spy).toHaveBeenCalledTimes(1)
    const [body, mentions] = spy.mock.calls[0]!
    // text is the plain fallback (getText, no markdown markers); rich carries the formatting.
    expect(body.text).toBe('olá mundo')
    expect(body.rich).toEqual([
      { t: 'p', children: [{ t: 'text', text: 'olá ' }, { t: 'strong', children: [{ t: 'text', text: 'mundo' }] }] },
    ])
    expect(mentions).toEqual([])
    expect(editor!.isEmpty).toBe(true)
  })

  it('send emits { text } with NO rich for a plain message', () => {
    const spy = vi.fn()
    let editor: Editor | null = null
    const { getByRole } = render(<RichComposer onSend={spy} onEditor={(e) => (editor = e)} />)
    act(() => {
      editor!.commands.setContent('<p>só texto</p>')
    })
    act(() => {
      getByRole('button', { name: 'Enviar' }).click()
    })
    const [body] = spy.mock.calls[0]!
    expect(body).toEqual({ text: 'só texto' })
    expect(body.rich).toBeUndefined()
  })

  it('leaks NO protocol shape in the editor DOM (P1)', () => {
    let editor: Editor | null = null
    const { container } = render(
      <RichComposer onSend={() => {}} onEditor={(e) => (editor = e)} />,
    )
    act(() => {
      editor!.commands.setContent(
        '<p>texto com <strong>negrito</strong>, <em>itálico</em> e <code>código</code></p>',
      )
    })
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  // Toolbar (PR-2): B/I/S/list/code above the editor, mirroring the textarea path's composer__toolbar.
  it('renders the formatting toolbar with the five buttons', () => {
    const { getByRole } = render(<RichComposer onSend={() => {}} />)
    const toolbar = getByRole('toolbar', { name: copy.composer.formatting })
    expect(toolbar).toBeTruthy()
    for (const name of [copy.composer.bold, copy.composer.italic, copy.composer.strike, copy.composer.bulletList, copy.composer.code]) {
      expect(getByRole('button', { name })).toBeTruthy()
    }
  })

  // Clicking a toolbar button toggles the mark on the current selection (in place) and the button
  // reflects the active state via aria-pressed.
  it('Bold button toggles the mark and reflects aria-pressed', () => {
    let editor: Editor | null = null
    const { getByRole } = render(<RichComposer onSend={() => {}} onEditor={(e) => (editor = e)} />)
    act(() => {
      editor!.commands.setContent('<p>mundo</p>')
      editor!.commands.setTextSelection({ from: 1, to: 6 })
      editor!.commands.focus()
    })
    const bold = getByRole('button', { name: copy.composer.bold })
    act(() => {
      bold.click()
    })
    expect(editor!.isActive('bold')).toBe(true)
    expect(bold.getAttribute('aria-pressed')).toBe('true')
  })

  // Placeholder (PR-2): the empty editor's first block carries the data-placeholder text.
  it('shows the placeholder text on an empty editor', () => {
    const { container } = render(<RichComposer onSend={() => {}} />)
    expect(container.querySelector('[data-placeholder="Mensagem"]')).toBeTruthy()
  })

  // P1: mounting the toolbar introduces no protocol shape in the DOM.
  it('leaks NO protocol shape with the toolbar mounted (P1)', () => {
    const { container } = render(<RichComposer onSend={() => {}} />)
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  // Chrome parity (pré-PR-3): the toolbar carries the group separator; the action row carries the
  // attach (+) — only when onSendAttachment is wired — and the mention (@) affordance.
  it('renders the toolbar separator and the +/@ action row', () => {
    const { getByRole, container } = render(
      <RichComposer onSend={() => {}} onSendAttachment={() => {}} />,
    )
    expect(getByRole('separator')).toBeTruthy()
    expect(getByRole('button', { name: copy.composer.mention })).toBeTruthy()
    expect(container.querySelector('.composer__attach input[type="file"]')).toBeTruthy()
  })

  // The attach (+) is shown only when the call-site wires onSendAttachment (mirrors the textarea).
  it('omits the attach affordance without onSendAttachment', () => {
    const { container } = render(<RichComposer onSend={() => {}} />)
    expect(container.querySelector('.composer__attach')).toBeNull()
  })

  // The @ button is a BRIDGE (PR-3 couples the picker): it just inserts the literal "@" character.
  it('mention button inserts a literal "@" into the editor', () => {
    let editor: Editor | null = null
    const { getByRole } = render(<RichComposer onSend={() => {}} onEditor={(e) => (editor = e)} />)
    act(() => {
      getByRole('button', { name: copy.composer.mention }).click()
    })
    expect(editor!.getText()).toContain('@')
  })

  // Compact (thread panel, workspace.md §12 item 6): the same card as full, with an icon-only send
  // and the thread placeholder.
  it('compact variant renders the toolbar, action row and thread placeholder', () => {
    const { getByRole, container } = render(
      <RichComposer onSend={() => {}} onSendAttachment={() => {}} variant="compact" />,
    )
    expect(getByRole('toolbar', { name: copy.composer.formatting })).toBeTruthy()
    expect(getByRole('button', { name: copy.composer.mention })).toBeTruthy()
    expect(getByRole('button', { name: 'Enviar' }).textContent).toBe('')
    expect(container.querySelector('.composer__attach')).toBeTruthy()
    expect(container.querySelector('[data-placeholder="Responder na thread"]')).toBeTruthy()
  })

  // Shift+Enter is context-aware: inside a list it opens the NEXT item; outside it makes a new
  // block (the pre-existing behaviour, now explicit). hardBreak stays out of the schema (ADR-051).
  it('shiftEnterSplit opens the next list item inside a list', () => {
    let editor: Editor | null = null
    render(<RichComposer onSend={() => {}} onEditor={(e) => (editor = e)} />)
    act(() => {
      editor!.commands.setContent('<ul><li><p>a</p></li></ul>')
    })
    act(() => {
      shiftEnterSplit(editor!)
    })
    const items = editor!.getJSON().content?.[0]?.content
    expect(items?.filter((n) => n.type === 'listItem')).toHaveLength(2)
  })

  it('shiftEnterSplit makes a new paragraph outside a list', () => {
    let editor: Editor | null = null
    render(<RichComposer onSend={() => {}} onEditor={(e) => (editor = e)} />)
    act(() => {
      editor!.commands.setContent('<p>a</p>')
    })
    act(() => {
      shiftEnterSplit(editor!)
    })
    const blocks = editor!.getJSON().content
    expect(blocks?.filter((n) => n.type === 'paragraph')).toHaveLength(2)
  })
})

// Mention as an atomic node (ADR-051, PLANO-COMPOSER PR-3, Commit 2). The opaque UserId lives in the
// node's attr and NEVER in the DOM (P1); the chip renders only "@label"; the send collects the ids.
describe('RichComposer mention node (P1, PR-3)', () => {
  // A protocol-shaped id on purpose: if it ever leaked into innerHTML the mxid scanner would catch it.
  const ALICE = uid('@alice:tayet.local')
  const BOB = uid('@bob:tayet.local')

  it('renders the chip as "@label" and leaks NO UserId / data-id / data-label into the DOM (P1)', () => {
    let editor: Editor | null = null
    const { container } = render(
      <RichComposer onSend={() => {}} onEditor={(e) => (editor = e)} />,
    )
    act(() => {
      editor!.commands.insertContent({ type: 'mention', attrs: { id: ALICE, label: 'Alice' } })
    })
    // The visible chip shows the product label.
    expect(container.textContent).toContain('@Alice')
    // The opaque UserId — and the SDK's default DOM attrs — are absent from the rendered HTML.
    expect(container.innerHTML).not.toContain(ALICE)
    expect(container.innerHTML).not.toContain('data-id')
    expect(container.innerHTML).not.toContain('data-label')
    // And the general protocol-shape scanner is clean with a mention mounted.
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  it('collects the mentioned UserIds (deduped) into onSend; the text carries "@label" inline', () => {
    const spy = vi.fn()
    let editor: Editor | null = null
    const { getByRole } = render(<RichComposer onSend={spy} onEditor={(e) => (editor = e)} />)
    act(() => {
      // Two mentions of the same user (repeated) plus a distinct one → deduped to two ids.
      editor!.commands.insertContent({ type: 'mention', attrs: { id: ALICE, label: 'Alice' } })
      editor!.commands.insertContent(' e ')
      editor!.commands.insertContent({ type: 'mention', attrs: { id: BOB, label: 'Bob' } })
      editor!.commands.insertContent(' e ')
      editor!.commands.insertContent({ type: 'mention', attrs: { id: ALICE, label: 'Alice' } })
    })
    act(() => {
      getByRole('button', { name: 'Enviar' }).click()
    })
    expect(spy).toHaveBeenCalledTimes(1)
    const [body, mentions] = spy.mock.calls[0]!
    // The chips degrade to plain "@label" text in the body; the opaque ids ride `mentions` only.
    expect(body.text).toContain('@Alice')
    expect(new Set(mentions)).toEqual(new Set([ALICE, BOB]))
    expect(mentions).toHaveLength(2) // deduped
  })
})

// Mention PICKER (ADR-051, PLANO-COMPOSER PR-3, Commit 3): the @-suggestion mirrors the textarea
// Composer's picker — filter by displayName, ↑↓ navigate, Enter/Tab select (insert the chip, never
// send), Escape close. `users` absent → no picker (parity with the textarea).
describe('RichComposer mention picker (PR-3)', () => {
  const alice: User = { id: uid('@alice:tayet.local'), displayName: 'Alice', kind: 'member' }
  const alan: User = { id: uid('@alan:tayet.local'), displayName: 'Alan', kind: 'member' }
  const bob: User = { id: uid('@bob:tayet.local'), displayName: 'Bob', kind: 'member' }

  // The mention nodes in the top paragraph, typed for the opaque-id attr assertion.
  function mentionNodes(editor: Editor): { attrs?: { id?: UserId } }[] {
    const content = (editor.getJSON().content?.[0]?.content ?? []) as Array<{
      type?: string
      attrs?: { id?: UserId }
    }>
    return content.filter((n) => n.type === 'mention')
  }

  // Insert a trigger and let the async suggestion resolve. Focus first — the suggestion match is
  // computed at the caret.
  async function openWith(editor: Editor, text: string): Promise<void> {
    await act(async () => {
      editor.commands.focus()
      editor.commands.insertContent(text)
      await flush()
    })
  }

  it('filters candidates, ArrowDown moves, Enter selects the chip and does NOT send', async () => {
    const spy = vi.fn()
    let editor: Editor | null = null
    const { container, getByRole } = render(
      <RichComposer onSend={spy} users={[alice, alan, bob]} onEditor={(e) => (editor = e)} />,
    )
    await openWith(editor!, '@al')
    // Picker open, filtered to Alice + Alan (Bob excluded); the first row is active.
    expect(getByRole('listbox', { name: copy.composer.mention })).toBeTruthy()
    // A person's row now carries the Avatar monogram before the name (workspace.md §21.1 item 4).
    expect([...container.querySelectorAll('[role="option"] .composer__suggest-name')].map((o) => o.textContent)).toEqual([
      'Alice',
      'Alan',
    ])
    const dom = container.querySelector('[contenteditable="true"]')!
    await act(async () => {
      fireEvent.keyDown(dom, { key: 'ArrowDown' })
      await flush()
    })
    expect(container.querySelector('.composer__suggest-option--active .composer__suggest-name')?.textContent).toBe('Alan')
    await act(async () => {
      fireEvent.keyDown(dom, { key: 'Enter' })
      await flush()
    })
    // Enter SELECTED (did not send): a mention node for Alan is in the doc, onSend untouched.
    expect(spy).not.toHaveBeenCalled()
    const mentions = mentionNodes(editor!)
    expect(mentions).toHaveLength(1)
    expect(mentions[0]?.attrs?.id).toBe(alan.id)
    // And the opaque id never reaches the DOM (P1).
    expect(container.innerHTML).not.toContain(alan.id)
  })

  it('selects on mouse-down of a row (inserts the chip, no send)', async () => {
    const spy = vi.fn()
    let editor: Editor | null = null
    const { getByText } = render(
      <RichComposer onSend={spy} users={[alice, bob]} onEditor={(e) => (editor = e)} />,
    )
    await openWith(editor!, '@al')
    await act(async () => {
      fireEvent.mouseDown(getByText('Alice'))
      await flush()
    })
    expect(spy).not.toHaveBeenCalled()
    expect(mentionNodes(editor!)[0]?.attrs?.id).toBe(alice.id)
  })

  it('Escape closes the picker without inserting a mention', async () => {
    let editor: Editor | null = null
    const { container, queryByRole } = render(
      <RichComposer onSend={() => {}} users={[alice, bob]} onEditor={(e) => (editor = e)} />,
    )
    await openWith(editor!, '@al')
    expect(queryByRole('listbox', { name: copy.composer.mention })).toBeTruthy()
    const dom = container.querySelector('[contenteditable="true"]')!
    await act(async () => {
      fireEvent.keyDown(dom, { key: 'Escape' })
      await flush()
    })
    expect(queryByRole('listbox', { name: copy.composer.mention })).toBeNull()
    const mentions = editor!.getJSON().content?.[0]?.content?.filter((n) => n.type === 'mention')
    expect(mentions ?? []).toHaveLength(0)
  })

  it('without users, "@" never opens the picker (parity with the textarea)', async () => {
    let editor: Editor | null = null
    const { queryByRole } = render(
      <RichComposer onSend={() => {}} onEditor={(e) => (editor = e)} />,
    )
    await openWith(editor!, '@al')
    expect(queryByRole('listbox', { name: copy.composer.mention })).toBeNull()
  })
})

// Link + URL dialog (ADR-051, PLANO-COMPOSER PR-4). The toolbar Link button (after the B I S | sep)
// opens a Dialog with Texto/URL Fields. Barrier 1 (isSafeHref, on submit) admits only
// http/https/mailto; the schema's `protocols` allowlist is barrier 1b; the ACL's outbound
// sanitizeHref is barrier 2. A rejected scheme shows an inline error and NEVER becomes a live <a>.
describe('RichComposer link dialog (PR-4)', () => {
  it('opens the dialog and pre-fills Texto with the current selection', () => {
    let editor: Editor | null = null
    const { getByRole, getByLabelText } = render(
      <RichComposer onSend={() => {}} onEditor={(e) => (editor = e)} />,
    )
    act(() => {
      editor!.commands.setContent('<p>mundo</p>')
      editor!.commands.setTextSelection({ from: 1, to: 6 })
      editor!.commands.focus()
    })
    act(() => {
      getByRole('button', { name: 'Link' }).click()
    })
    expect(getByRole('dialog')).toBeTruthy()
    expect((getByLabelText('Texto') as HTMLInputElement).value).toBe('mundo')
  })

  // Barrier 1: a dangerous scheme is refused — inline error, no link mark, and the DOM never gets a
  // live <a href="javascript:…">. The protocol-leak scanner stays clean too (P1).
  it('refuses a javascript: URL — inline error, no link created', () => {
    let editor: Editor | null = null
    const { getByRole, getByLabelText, container } = render(
      <RichComposer onSend={() => {}} onEditor={(e) => (editor = e)} />,
    )
    act(() => {
      editor!.commands.setContent('<p>mundo</p>')
      editor!.commands.setTextSelection({ from: 1, to: 6 })
      editor!.commands.focus()
    })
    act(() => {
      getByRole('button', { name: 'Link' }).click()
    })
    act(() => {
      fireEvent.change(getByLabelText('URL'), { target: { value: 'javascript:alert(1)' } })
    })
    act(() => {
      getByRole('button', { name: 'Inserir' }).click()
    })
    // Inline error shown; the mark was never applied; no dangerous <a> in the editor DOM.
    expect(getByRole('alert').textContent).toContain('URL inválida')
    expect(editor!.isActive('link')).toBe(false)
    expect(container.querySelector('.composer__input--rich a')).toBeNull()
    expect(container.querySelector('a[href^="javascript" i]')).toBeNull()
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  it('inserts a link for a safe https URL — mark applied and the <a> carries the href', () => {
    let editor: Editor | null = null
    const { getByRole, getByLabelText, container } = render(
      <RichComposer onSend={() => {}} onEditor={(e) => (editor = e)} />,
    )
    act(() => {
      editor!.commands.setContent('<p>mundo</p>')
      editor!.commands.setTextSelection({ from: 1, to: 6 })
      editor!.commands.focus()
    })
    act(() => {
      getByRole('button', { name: 'Link' }).click()
    })
    act(() => {
      fireEvent.change(getByLabelText('URL'), { target: { value: 'https://x.com' } })
    })
    act(() => {
      getByRole('button', { name: 'Inserir' }).click()
    })
    expect(editor!.isActive('link')).toBe(true)
    const a = container.querySelector('.composer__input--rich a')
    expect(a?.getAttribute('href')).toBe('https://x.com')
    // Dialog closed on success.
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })

  // P1 render-scan: with the dialog open on a normal URL, the DOM leaks no protocol vocabulary.
  it('leaks NO protocol shape with the link dialog open (P1)', () => {
    const { getByRole, getByLabelText, container } = render(<RichComposer onSend={() => {}} />)
    act(() => {
      getByRole('button', { name: 'Link' }).click()
    })
    act(() => {
      fireEvent.change(getByLabelText('URL'), { target: { value: 'https://example.com/path' } })
    })
    expect(getByRole('dialog')).toBeTruthy()
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  it('editing an existing link offers Remover, which unsets the mark', () => {
    let editor: Editor | null = null
    const { getByRole, container } = render(
      <RichComposer onSend={() => {}} onEditor={(e) => (editor = e)} />,
    )
    act(() => {
      editor!.commands.setContent('<p><a href="https://x.com">link</a></p>')
      editor!.commands.setTextSelection({ from: 2, to: 4 })
      editor!.commands.focus()
    })
    expect(editor!.isActive('link')).toBe(true)
    act(() => {
      getByRole('button', { name: 'Link' }).click()
    })
    // The editing dialog offers Remover.
    act(() => {
      getByRole('button', { name: 'Remover' }).click()
    })
    expect(editor!.isActive('link')).toBe(false)
    expect(container.querySelector('.composer__input--rich a')).toBeNull()
  })
})

// Edit mode (ADR-051 PR-5b): onSave/onCancel switch the island into an in-place editor — Save/Cancel
// footer, no send/action-row, no reply banner, no mention picker; the toolbar (incl. Link) stays. The
// editor seeds from initialHTML so a formatted message re-opens WITH its formatting. Enter saves,
// Shift+Enter breaks, Esc cancels.
describe('RichComposer edit mode (PR-5b)', () => {
  const boldSeed = '<p><strong>hi</strong></p>'

  it('renders Save/Cancel + toolbar and hides the send/action-row, reply banner and picker', () => {
    const { getByRole, queryByRole, container } = render(
      <RichComposer
        onSend={() => {}}
        onSave={() => {}}
        onCancel={() => {}}
        initialHTML={boldSeed}
        replyingTo={{ author: 'X', excerpt: 'y' }}
      />,
    )
    expect(container.querySelector('.composer--edit')).toBeTruthy()
    expect(getByRole('toolbar', { name: copy.composer.formatting })).toBeTruthy()
    expect(getByRole('button', { name: 'Link' })).toBeTruthy()
    expect(getByRole('button', { name: copy.composer.editSave })).toBeTruthy()
    expect(getByRole('button', { name: copy.composer.editCancel })).toBeTruthy()
    // No send / action-row / reply banner in edit mode.
    expect(queryByRole('button', { name: 'Enviar' })).toBeNull()
    expect(queryByRole('button', { name: copy.composer.mention })).toBeNull()
    expect(container.querySelector('.composer__actions-left')).toBeNull()
    expect(container.querySelector('.composer__reply')).toBeNull()
  })

  it('seeds the editor from initialHTML (formatting preserved) and Save emits the ComposeResult', () => {
    const onSave = vi.fn()
    const { getByRole, container } = render(
      <RichComposer onSend={() => {}} onSave={onSave} onCancel={() => {}} initialHTML={boldSeed} />,
    )
    // Seeded WITH the bold mark (a live <strong> in the edit surface).
    expect(container.querySelector('.composer--edit strong')?.textContent).toBe('hi')
    act(() => {
      getByRole('button', { name: copy.composer.editSave }).click()
    })
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0]![0]).toEqual({
      text: 'hi',
      rich: [{ t: 'p', children: [{ t: 'strong', children: [{ t: 'text', text: 'hi' }] }] }],
    })
  })

  it('Cancel calls onCancel and never onSave', () => {
    const onSave = vi.fn()
    const onCancel = vi.fn()
    const { getByRole } = render(
      <RichComposer onSend={() => {}} onSave={onSave} onCancel={onCancel} initialHTML={boldSeed} />,
    )
    act(() => {
      getByRole('button', { name: copy.composer.editCancel }).click()
    })
    expect(onCancel).toHaveBeenCalledTimes(1)
    expect(onSave).not.toHaveBeenCalled()
  })

  it('Enter saves (Shift+Enter would break) and Escape cancels', () => {
    const onSave = vi.fn()
    const onCancel = vi.fn()
    const { container } = render(
      <RichComposer onSend={() => {}} onSave={onSave} onCancel={onCancel} initialHTML={boldSeed} />,
    )
    const dom = container.querySelector('[contenteditable="true"]')!
    act(() => {
      fireEvent.keyDown(dom, { key: 'Enter' })
    })
    expect(onSave).toHaveBeenCalledTimes(1)
    act(() => {
      fireEvent.keyDown(dom, { key: 'Escape' })
    })
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('editing via the toolbar changes the rich saved (toggle italic over the selection)', () => {
    const onSave = vi.fn()
    let editor: Editor | null = null
    const { getByRole } = render(
      <RichComposer onSend={() => {}} onSave={onSave} onCancel={() => {}} initialHTML="<p>word</p>" onEditor={(e) => (editor = e)} />,
    )
    act(() => {
      editor!.commands.selectAll()
      editor!.commands.focus()
    })
    act(() => {
      getByRole('button', { name: copy.composer.italic }).click()
    })
    act(() => {
      getByRole('button', { name: copy.composer.editSave }).click()
    })
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(onSave.mock.calls[0]![0]).toEqual({
      text: 'word',
      rich: [{ t: 'p', children: [{ t: 'em', children: [{ t: 'text', text: 'word' }] }] }],
    })
  })

  it('an empty edit is a no-op (Save with no text does not call onSave)', () => {
    const onSave = vi.fn()
    let editor: Editor | null = null
    const { getByRole } = render(
      <RichComposer onSend={() => {}} onSave={onSave} onCancel={() => {}} initialHTML="<p>x</p>" onEditor={(e) => (editor = e)} />,
    )
    act(() => {
      editor!.commands.clearContent()
    })
    act(() => {
      getByRole('button', { name: copy.composer.editSave }).click()
    })
    expect(onSave).not.toHaveBeenCalled()
  })
})
