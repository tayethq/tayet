// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { Workspace } from '../../src/ui/components/Workspace'
import type { Channel, Message, User, ChannelId, UserId, MessageId, RichDoc } from '../../src/acl'
import type { ComposeResult } from '../../src/ui/compose'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { copy } from '../support/copy'

// Commit 7 (ADR-012): the render-scan extended for RICH content (PLANO §5.2). Mount real rich
// messages and (a) prove the structured RichDoc renders to the allowed DOM tag set, (b) scan the DOM
// for protocol shapes / rich envelope leakage, (c) assert STRUCTURALLY that no renderer uses
// dangerouslySetInnerHTML, and (d) prove a dangerous-href link never reaches the DOM as an <a href>.
// Plus: the edit-own-message affordance.

const cid = (s: string): ChannelId => s as unknown as ChannelId
const uid = (s: string): UserId => s as unknown as UserId
const mid = (s: string): MessageId => s as unknown as MessageId
const tms = (n: number) => n as unknown as Message['sentAt']

afterEach(cleanup)

const channels: Channel[] = [
  { id: cid('!engineering:tayet.local'), name: '#engineering', kind: 'public', memberCount: 2, unread: { count: 0, mentions: 0 } },
]
const alice: User = { id: uid('@alice:tayet.local'), displayName: 'Alice Anderson', kind: 'member' }
const usersById: Record<string, User> = { [alice.id]: alice }

function mount(messages: Message[], extra?: { onEdit?: (m: Message, body: ComposeResult) => void }) {
  return render(
    <Workspace
      channels={channels}
      selectedChannelId={channels[0]!.id}
      messages={messages}
      usersById={usersById}
      connection="connected"
      onSelectChannel={() => {}}
      onSend={() => {}}
      onEdit={extra?.onEdit}
    />,
  )
}

describe('rich DOM render-scan (P1 on screen, ADR-012)', () => {
  const richDoc: RichDoc = [
    {
      t: 'p',
      children: [
        { t: 'text', text: 'see ' },
        { t: 'strong', children: [{ t: 'text', text: 'bold' }] },
        { t: 'text', text: ' ' },
        { t: 'link', href: 'https://tayet.example/docs', children: [{ t: 'text', text: 'docs' }] },
      ],
    },
    { t: 'codeblock', text: 'const x = 1', lang: 'ts' },
  ]
  const richMsg: Message = {
    id: mid('$r1:tayet.local'),
    channelId: channels[0]!.id,
    author: alice.id,
    body: { kind: 'text', text: 'see bold docs', rich: richDoc },
    sentAt: tms(1),
    reactions: [],
    mine: false,
    mentionsMe: false,
  }

  it('renders the structured doc and leaks NO protocol shape into the DOM', () => {
    const { container } = mount([richMsg])
    const text = container.textContent ?? ''
    expect(text).toContain('bold')
    expect(text).toContain('docs')
    expect(text).toContain('const x = 1')
    // Structural tags from the rich render are present.
    expect(container.querySelector('strong')).not.toBeNull()
    expect(container.querySelector('pre code')).not.toBeNull()
    const a = container.querySelector('a') as HTMLAnchorElement
    expect(a.getAttribute('href')).toBe('https://tayet.example/docs')
    // P1: no mxid/room-id/mxc/m.room.*/formatted_body/org.matrix.custom.html in the rendered HTML.
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  it('renders only DOM tags within the allowed structural set', () => {
    const { container } = mount([richMsg])
    // The rich render node set + ONLY the tags the in-bubble affordances actually use at rest (the
    // thread/reactions/edit-open affordances render <button>). This message is NOT in edit mode, so the
    // rich editor's own tags never appear here. Layout tags (h1-3, form, nav, main, header, aside,
    // label) are NOT allowed inside a .message bubble — keeping them would let an accidental <h1> slip
    // past this gate.
    const ALLOWED = new Set([
      'DIV', 'SPAN', 'P', 'STRONG', 'EM', 'DEL', 'CODE', 'PRE', 'A', 'UL', 'OL', 'LI', 'BLOCKQUOTE',
      'BR', 'BUTTON',
    ])
    // Scope to the rendered message bubble so we only assert on content tags.
    const bubble = container.querySelector('.message')!
    bubble.querySelectorAll('*').forEach((el) => {
      expect(ALLOWED.has(el.tagName), `unexpected tag <${el.tagName.toLowerCase()}>`).toBe(true)
    })
  })

  it('NO component renderer uses dangerouslySetInnerHTML (glob of the components dir)', () => {
    // Scan the WHOLE components directory (recursive), not a hand-picked pair — so a third renderer
    // added later is covered automatically (ADR-012: rich content is rendered structurally, never
    // via raw HTML injection).
    const dir = resolve(process.cwd(), 'src/ui/components')
    const files = readdirSync(dir, { recursive: true }).filter(
      (f): f is string => typeof f === 'string' && /\.(tsx?|jsx?)$/.test(f),
    )
    expect(files.length).toBeGreaterThan(0)
    for (const rel of files) {
      const src = readFileSync(resolve(dir, rel), 'utf8')
      expect(src, `${rel} must not use dangerouslySetInnerHTML`).not.toContain('dangerouslySetInnerHTML')
    }
  })

  it('a dangerous-href link never reaches the DOM as an <a href> (defense-in-depth)', () => {
    const evil: RichDoc = [
      { t: 'p', children: [{ t: 'link', href: 'javascript:alert(1)', children: [{ t: 'text', text: 'click' }] }] },
    ]
    const { container } = mount([
      { ...richMsg, id: mid('$evil:tayet.local'), body: { kind: 'text', text: 'click', rich: evil } },
    ])
    // The text survives, but there is NO anchor carrying the javascript: scheme.
    expect(container.textContent).toContain('click')
    const anchors = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '')
    expect(anchors.some((h) => /javascript:/i.test(h))).toBe(false)
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })
})

// Edit-own-message affordance, now on the WYSIWYG surface (ADR-051 PR-5b): clicking Edit mounts the
// rich island in edit mode (no <input>), seeded from the message's rich/plain body, and Save routes a
// ComposeResult through onEdit. jsdom can't type into a contenteditable, so the assertions drive the
// seeded editor and the Save button (no fireEvent.change on an input — that path is gone).
describe('edit-own-message affordance (ADR-012 × ADR-051 PR-5b)', () => {
  const boldRich: RichDoc = [
    { t: 'p', children: [{ t: 'strong', children: [{ t: 'text', text: 'mine to edit' }] }] },
  ]
  const own: Message = {
    id: mid('$own:tayet.local'),
    channelId: channels[0]!.id,
    author: alice.id,
    body: { kind: 'text', text: 'mine to edit', rich: boldRich },
    sentAt: tms(1),
    reactions: [],
    mine: true,
    mentionsMe: false,
    status: 'sent',
  }
  const theirs: Message = { ...own, id: mid('$theirs:tayet.local'), body: { kind: 'text', text: 'not mine' }, mine: false }
  const ownPlain: Message = { ...own, id: mid('$plain:tayet.local'), body: { kind: 'text', text: 'plain mine' } }

  it('shows Edit only on my own message', () => {
    const { getAllByLabelText } = mount([own, theirs], { onEdit: vi.fn() })
    expect(getAllByLabelText(copy.timeline.editMessage)).toHaveLength(1)
  })

  it('editing a FORMATTED message re-opens rich and saves a ComposeResult carrying `rich` (no flatten)', () => {
    const onEdit = vi.fn()
    const { getAllByLabelText, getByRole, queryByRole, container } = mount([own], { onEdit })

    fireEvent.click(getAllByLabelText(copy.timeline.editMessage)[0]!)
    // The edit island mounted, seeded WITH the bold formatting (a live <strong> in the edit surface).
    expect(container.querySelector('.composer--edit strong')?.textContent).toBe('mine to edit')

    fireEvent.click(getByRole('button', { name: copy.composer.editSave }))
    expect(onEdit).toHaveBeenCalledTimes(1)
    expect(onEdit.mock.calls[0]![0].id).toBe(own.id)
    const body = onEdit.mock.calls[0]![1] as ComposeResult
    expect(body.text).toBe('mine to edit')
    expect(body.rich).toEqual(boldRich) // formatting preserved through the round trip
    // Edit surface torn down after committing.
    expect(queryByRole('button', { name: copy.composer.editSave })).toBeNull()
  })

  it('editing a PLAIN message saves a plain ComposeResult (no rich synthesized)', () => {
    const onEdit = vi.fn()
    const { getAllByLabelText, getByRole } = mount([ownPlain], { onEdit })
    fireEvent.click(getAllByLabelText(copy.timeline.editMessage)[0]!)
    fireEvent.click(getByRole('button', { name: copy.composer.editSave }))
    expect(onEdit).toHaveBeenCalledTimes(1)
    const body = onEdit.mock.calls[0]![1] as ComposeResult
    expect(body).toEqual({ text: 'plain mine' })
    expect(body.rich).toBeUndefined()
  })

  it('Cancel drops the edit without calling onEdit', () => {
    const onEdit = vi.fn()
    const { getAllByLabelText, getByRole, queryByRole } = mount([own], { onEdit })
    fireEvent.click(getAllByLabelText(copy.timeline.editMessage)[0]!)
    fireEvent.click(getByRole('button', { name: copy.composer.editCancel }))
    expect(onEdit).not.toHaveBeenCalled()
    expect(queryByRole('button', { name: copy.composer.editSave })).toBeNull()
  })

  it('shows no Edit affordance when onEdit is absent', () => {
    const { queryAllByLabelText } = mount([own])
    expect(queryAllByLabelText(copy.timeline.editMessage)).toHaveLength(0)
  })
})
