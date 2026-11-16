// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, fireEvent, findByText as findByTextIn, act } from '@testing-library/react'
import type { Editor } from '@tiptap/react'
import { NewConversationDialog } from '../../src/ui/components/NewConversationDialog'
import { RichComposer } from '../../src/ui/composer/RichComposer'
import { richDocToHTML } from '../../src/ui/composer/rich-to-html'
import type { RichDoc, User, UserId } from '../../src/acl'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { copy } from '../support/copy'

// P1 gate for the compose surface (mirrors manage-render-scan / rich-render-scan). The pools' ids
// deliberately carry a REAL protocol shape (the ADR-008 residual: the runtime id value IS the user
// id); their displayNames are clean. If the dialog OR the composer editor ever rendered an id or any
// protocol vocabulary, the scan over innerHTML (text + attributes) turns red. Since ADR-051 PR-5 the
// composer IS the WYSIWYG island (RichComposer), so the compose-surface scan now runs on the
// contenteditable — the mention chip, the link mark, and pasted/typed protocol-shaped text.

const uid = (s: string): UserId => s as unknown as UserId

// Protocol-shaped ids, clean names.
const contacts: User[] = [
  { id: uid('@carol:tayet.local'), displayName: 'Carol Dias', kind: 'member' },
  { id: uid('@dan:tayet.local'), displayName: 'Dan Prado', kind: 'member' },
]

const noopVerb = () => Promise.resolve()

afterEach(cleanup)

describe('DOM render-scan (P1) — compose dialog (U3)', () => {
  it('leaks NO protocol shape in channel mode nor DM mode', async () => {
    const { container, getByRole } = render(
      <NewConversationDialog
        onCreateChannel={noopVerb}
        onOpenDirectMessage={noopVerb}
        onOpenGroupConversation={noopVerb}
        loadKnownContacts={() => Promise.resolve(contacts)}
        onClose={() => {}}
      />,
    )

    // Channel mode (default): name/visibility/topic — nothing protocol-shaped.
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])

    // Switch to DM mode → the picker loads the protocol-shaped pool; only clean names render.
    fireEvent.click(getByRole('button', { name: copy.newConversation.dm }))
    await findByTextIn(container, 'Carol Dias')
    await findByTextIn(container, 'Dan Prado')
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])

    // Select a contact (id rides the payload, never the DOM) → scan again.
    fireEvent.click(getByRole('button', { name: /Carol Dias/ }))
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })
})

// The compose editor surface (ADR-051 PR-5). jsdom can't type into a contenteditable, so content
// enters through the captured editor instance (onEditor seam), exactly like rich-composer.test.tsx.
describe('DOM render-scan (P1) — compose editor surface (ADR-051 PR-5)', () => {
  const members: User[] = [
    { id: uid('@mallory:tayet.local'), displayName: 'Mallory Vance', kind: 'member' },
    { id: uid('@mateus:tayet.local'), displayName: 'Mateus Lima', kind: 'member' },
  ]

  it('a mention chip renders "@label" only — no UserId / data-id in the DOM', () => {
    let editor: Editor | null = null
    const { container } = render(
      <RichComposer onSend={() => {}} users={members} onEditor={(e) => (editor = e)} />,
    )
    act(() => {
      editor!.commands.insertContent({
        type: 'mention',
        attrs: { id: members[0]!.id, label: members[0]!.displayName },
      })
    })
    expect(container.textContent).toContain('@Mallory Vance')
    expect(container.innerHTML).not.toContain(members[0]!.id)
    expect(container.innerHTML).not.toContain('data-id')
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  it('a safe https link renders a live href; the scan stays clean', () => {
    let editor: Editor | null = null
    const { container } = render(<RichComposer onSend={() => {}} onEditor={(e) => (editor = e)} />)
    act(() => {
      editor!.commands.setContent('<p><a href="https://example.com/path">site</a></p>')
    })
    const a = container.querySelector('.composer__input--rich a')
    expect(a?.getAttribute('href')).toBe('https://example.com/path')
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  it('a forbidden scheme never becomes a live <a href> (barrier 1)', () => {
    let editor: Editor | null = null
    const { container, getByRole, getByLabelText } = render(
      <RichComposer onSend={() => {}} onEditor={(e) => (editor = e)} />,
    )
    act(() => {
      editor!.commands.setContent('<p>x</p>')
      editor!.commands.setTextSelection({ from: 1, to: 2 })
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
    expect(container.querySelector('.composer__input--rich a')).toBeNull()
    expect(container.querySelector('a[href^="javascript" i]')).toBeNull()
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  it('protocol-shaped text is inert — no autolink, no mention synthesized by the editor', () => {
    let editor: Editor | null = null
    const { container } = render(
      <RichComposer onSend={() => {}} users={members} onEditor={(e) => (editor = e)} />,
    )
    // A caption a user might paste: an mxc uri, a matrix.to link, and an mxid. The editor must not
    // turn any of it into a live affordance — autolink is off (link only via the dialog), and there
    // is no auto-mention. The literal text is the user's own content; the machinery synthesizes NO
    // href/attr/mention that would round-trip protocol vocabulary.
    act(() => {
      editor!.commands.setContent(
        '<p>see mxc://abc and https://matrix.to/#/@x:srv and @mateus:tayet.local</p>',
      )
    })
    expect(container.querySelector('.composer__input--rich a')).toBeNull()
    const mentionNodes = editor!.getJSON().content?.[0]?.content?.filter((n) => n.type === 'mention')
    expect(mentionNodes ?? []).toHaveLength(0)
  })
})

// The EDIT surface (ADR-051 PR-5b): the same island in edit mode, seeded from a message's rich via
// richDocToHTML. The P1 scan must stay clean on the edit editor too — a re-opened link is a live href
// but carries no protocol vocabulary, a forbidden scheme in the (defensive) rich never becomes a live
// <a>, and pasted protocol-shaped text is inert (no autolink, no mention).
describe('DOM render-scan (P1) — edit editor surface (ADR-051 PR-5b)', () => {
  const editProps = { onSend: () => {}, onSave: () => {}, onCancel: () => {} }

  it('a re-opened safe link is a live href and the scan stays clean', () => {
    const rich: RichDoc = [
      {
        t: 'p',
        children: [
          { t: 'text', text: 'read the ' },
          { t: 'link', href: 'https://example.com/guide', children: [{ t: 'text', text: 'guide' }] },
        ],
      },
    ]
    const { container } = render(<RichComposer {...editProps} initialHTML={richDocToHTML(rich)} />)
    const a = container.querySelector('.composer--edit a')
    expect(a?.getAttribute('href')).toBe('https://example.com/guide')
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  it('a forbidden-scheme link in the rich never becomes a live <a> in the edit editor', () => {
    // Defensive: even if a body.rich carried a dangerous href, richDocToHTML degrades it to text and
    // the schema's protocol allowlist backstops — so no live anchor with the forbidden scheme.
    const evil: RichDoc = [
      { t: 'p', children: [{ t: 'link', href: 'javascript:alert(1)', children: [{ t: 'text', text: 'x' }] }] },
    ]
    const { container } = render(<RichComposer {...editProps} initialHTML={richDocToHTML(evil)} />)
    expect(container.querySelector('.composer--edit a')).toBeNull()
    expect(container.querySelector('a[href^="javascript" i]')).toBeNull()
    expect(container.textContent).toContain('x')
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  it('protocol-shaped text pasted into the edit editor stays inert (no autolink, no mention)', () => {
    // As in the send surface: the literal caption text is the user's own content — the assertion is
    // that the machinery synthesizes NO live href/attr/mention from it (no leak-scan on literal text).
    let editor: Editor | null = null
    const { container } = render(
      <RichComposer {...editProps} initialHTML="<p>seed</p>" onEditor={(e) => (editor = e)} />,
    )
    act(() => {
      editor!.commands.setContent('<p>mxc://abc and https://matrix.to/#/@x:srv and @mateus:tayet.local</p>')
    })
    expect(container.querySelector('.composer--edit a')).toBeNull()
    const mentionNodes = editor!.getJSON().content?.[0]?.content?.filter((n) => n.type === 'mention')
    expect(mentionNodes ?? []).toHaveLength(0)
  })
})
