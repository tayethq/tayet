// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, renderHook, waitFor, act } from '@testing-library/react'
import type { Editor } from '@tiptap/core'
import { Workspace } from '../../src/ui/components/Workspace'
import { ThreadPanel } from '../../src/ui/components/ThreadPanel'
import { RichComposer } from '../../src/ui/composer/RichComposer'
import { useChat } from '../../src/ui/useChat'
import { MediaProvider } from '../../src/ui/MediaContext'
import type { Acl, Channel, ChannelId, Message, MessageId, UserId } from '../../src/acl'
import { copy, fill } from '../support/copy'

// Manifest workspace.md §12 on screen: the header cuts name and topic, the composer's placeholder
// names the conversation, Enviar is the tier's Button with the icon after the label, the toolbar's
// pressed state follows the editor, and the thread composer attaches into its thread.

const cid = (s: string): ChannelId => s as unknown as ChannelId
const uid = (s: string): UserId => s as unknown as UserId
const mid = (s: string): MessageId => s as unknown as MessageId

const pub: Channel = {
  id: cid('!design:tayet.local'),
  name: '#design',
  kind: 'public',
  topic: 'Tudo sobre o design',
  memberCount: 3,
  unread: { count: 0, mentions: 0 },
}
const bare: Channel = { ...pub, id: cid('!bare:tayet.local'), name: '#bare', topic: undefined }
const dm: Channel = {
  id: cid('!dmcarol:tayet.local'),
  name: 'Carol Dias',
  kind: 'dm',
  memberCount: 2,
  unread: { count: 0, mentions: 0 },
}
const root: Message = {
  id: mid('$root:tayet.local'),
  channelId: pub.id,
  author: uid('@alice:tayet.local'),
  body: { kind: 'text', text: 'raiz' },
  sentAt: 1 as unknown as Message['sentAt'],
  reactions: [],
  mine: false,
  mentionsMe: false,
}

const workspaceEl = (selected: Channel) => (
  <MediaProvider resolve={async () => ({ url: '', release: () => {} })}>
    <Workspace
      channels={[pub, bare, dm]}
      selectedChannelId={selected.id}
      messages={[]}
      usersById={{}}
      connection="connected"
      onSelectChannel={() => {}}
      onSend={() => {}}
      onManageChannel={() => {}}
    />
  </MediaProvider>
)

afterEach(cleanup)

// The stylesheet is the spec's carrier here: jsdom does not lay out, so the cut is pinned on the rule.
const rule = (selector: string): string => {
  const css = readFileSync(resolve(__dirname, '../../src/ui/styles.css'), 'utf8')
  const i = css.indexOf(`\n${selector}`)
  expect(i).toBeGreaterThanOrEqual(0)
  return css.slice(i, css.indexOf('}', i))
}

describe('channel header (workspace.md §12 item 1)', () => {
  it('name and topic share the rule that cuts instead of wrapping', () => {
    const cut = rule('.channel-header__name,\n.channel-header__topic {')
    for (const decl of ['white-space: nowrap', 'overflow: hidden', 'text-overflow: ellipsis']) {
      expect(cut).toContain(decl)
    }
    const { container } = render(workspaceEl(pub))
    expect(container.querySelector('h2.channel-header__name')?.textContent).toBe('#design')
    expect(container.querySelector('p.channel-header__topic')?.textContent).toBe(pub.topic)
  })

  it('without a topic there is no element', () => {
    const { container } = render(workspaceEl(bare))
    expect(container.querySelector('.channel-header__topic')).toBeNull()
  })

  it('the manage button is titled with its accessible name', () => {
    const { container } = render(workspaceEl(pub))
    const manage = container.querySelector('.channel-header__manage')!
    expect(manage.getAttribute('title')).toBe(manage.getAttribute('aria-label'))
  })
})

describe('composer placeholder (workspace.md §12 item 4)', () => {
  const hint = (c: HTMLElement) => c.querySelector('.composer [data-placeholder]')?.getAttribute('data-placeholder')

  it('channel: the bare name, no mark', () => {
    const { container } = render(workspaceEl(pub))
    expect(hint(container)).toBe(fill(copy.composer.placeholderFor, { name: 'design' }))
  })

  it('DM: the person', () => {
    const { container } = render(workspaceEl(dm))
    expect(hint(container)).toBe(fill(copy.composer.placeholderFor, { name: 'Carol Dias' }))
  })

  it('follows the conversation without a keystroke (the composer is not remounted)', () => {
    const { container, rerender } = render(workspaceEl(pub))
    rerender(workspaceEl(dm))
    expect(hint(container)).toBe(fill(copy.composer.placeholderFor, { name: 'Carol Dias' }))
  })

  it('no conversation-bound hint: "Mensagem" stays the fallback', () => {
    const { container } = render(<RichComposer onSend={() => {}} />)
    expect(hint(container)).toBe(copy.composer.placeholder)
  })
})

describe('composer send and toolbar (workspace.md §12 items 3, 5)', () => {
  function mount() {
    let editor: Editor | null = null
    const view = render(<RichComposer onSend={() => {}} onSendAttachment={() => {}} onEditor={(e) => (editor = e)} />)
    return { ...view, editor: () => editor! }
  }

  it('Enviar is the tier Button, label then icon', () => {
    const { getByRole } = mount()
    const send = getByRole('button', { name: copy.composer.send })
    expect(send.classList.contains('ui-button')).toBe(true)
    expect(send.getAttribute('data-variant')).toBe('fill')
    expect(send.getAttribute('data-size')).toBe('cotidiano')
    expect(send.firstChild?.textContent).toBe(copy.composer.send)
    expect(send.lastElementChild?.tagName.toLowerCase()).toBe('svg')
  })

  it('Enviar is disabled while the field is empty', () => {
    const { getByRole, editor } = mount()
    const send = getByRole('button', { name: copy.composer.send }) as HTMLButtonElement
    expect(send.disabled).toBe(true)
    act(() => {
      editor().commands.setContent('<p>oi</p>')
    })
    expect(send.disabled).toBe(false)
  })

  it('the toolbar is not pressed at rest and is pressed on the active mark', () => {
    const { getByRole, editor } = mount()
    const bold = getByRole('button', { name: copy.composer.bold })
    expect(bold.getAttribute('aria-pressed')).toBe('false')
    expect(bold.getAttribute('title')).toBe(copy.composer.bold)
    act(() => {
      editor().commands.setContent('<p>oi</p>')
      editor().commands.selectAll()
      editor().commands.toggleBold()
    })
    expect(bold.getAttribute('aria-pressed')).toBe('true')
  })
})

describe('thread composer (workspace.md §12 item 6)', () => {
  const panel = (onSendAttachment: (f: File) => void) => (
    <MediaProvider resolve={async () => ({ url: '', release: () => {} })}>
      <ThreadPanel
        root={root}
        messages={[]}
        usersById={{}}
        onClose={() => {}}
        onSend={() => {}}
        onSendAttachment={onSendAttachment}
      />
    </MediaProvider>
  )

  it('the same card as the main composer: toolbar, field, +, @ and an icon-only Enviar', () => {
    const { getByRole, container } = render(panel(() => {}))
    expect(getByRole('toolbar', { name: copy.composer.formatting })).toBeTruthy()
    expect(getByRole('button', { name: copy.composer.mention })).toBeTruthy()
    expect(container.querySelector('.composer__attach')).toBeTruthy()
    expect(container.querySelector('[data-placeholder]')?.getAttribute('data-placeholder')).toBe(
      copy.composer.placeholderThread,
    )
    const send = getByRole('button', { name: copy.composer.send })
    expect(send.getAttribute('data-variant')).toBe('fill')
    expect(send.textContent).toBe('')
  })

  it('+ hands the picked file to onSendAttachment', () => {
    const onSendAttachment = vi.fn()
    const { container } = render(panel(onSendAttachment))
    const file = new File(['x'], 'x.txt', { type: 'text/plain' })
    fireEvent.change(container.querySelector('.composer__attach input[type="file"]')!, { target: { files: [file] } })
    expect(onSendAttachment).toHaveBeenCalledWith(file)
  })
})

describe('useChat — sendThreadAttachment', () => {
  const fakeAcl = () => {
    const sendMessage = vi.fn(async () => mid('txn'))
    const acl = {
      getChannels: async () => [pub],
      getArchivedChannels: async () => [],
      getMembers: async () => [],
      getDevices: async () => [],
      currentUser: async () => ({ id: uid('@me:tayet.local'), displayName: 'Eu' }),
      getThreadUnread: async () => ({ unread: false }),
      getTimeline: async () => ({ items: [], nextCursor: undefined }),
      subscribe: () => () => {},
      subscribeChannel: () => () => {},
      markRead: async () => {},
      sendMessage,
    } as unknown as Acl
    return { acl, sendMessage }
  }

  it('sends the file into the open thread, naming only the root', async () => {
    const { acl, sendMessage } = fakeAcl()
    const { result } = renderHook(() => useChat(acl))
    await waitFor(() => expect(result.current.selectedId).toBe(pub.id))
    act(() => result.current.openThread(root))
    const file = new File(['x'], 'x.txt', { type: 'text/plain' })
    act(() => result.current.sendThreadAttachment(file))
    expect(sendMessage).toHaveBeenCalledWith(pub.id, { kind: 'attachment', file }, { thread: root.id })
  })
})
