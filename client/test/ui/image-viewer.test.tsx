// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, act, waitFor, within } from '@testing-library/react'
import { Workspace } from '../../src/ui/components/Workspace'
import { Timeline, timeOf } from '../../src/ui/components/Timeline'
import { MediaProvider } from '../../src/ui/MediaContext'
import type { Channel, ChannelId, MediaRef, MediaVariant, Message, MessageId, ResolvedMedia, User, UserId } from '../../src/acl'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { saveFile } from '../../src/ui/save-file'
import { copy, fill } from '../support/copy'

vi.mock('../../src/ui/save-file', () => ({ saveFile: vi.fn() }))

// The image viewer (manifest workspace.md §25.2, §23.5 item 2; PLANO-MOBILE §0.14 V4 and V5): the ready
// thumbnail is a button named by the image's alt; it opens one viewer for both widths with the full image,
// author and time from the message, loading and failure with "Baixar" disabled, the fit/real toggle on the
// wide window, Esc and a click outside to close, and the focus back on the thumbnail.

const cid = (s: string): ChannelId => s as unknown as ChannelId
const uid = (s: string): UserId => s as unknown as UserId
const mid = (s: string): MessageId => s as unknown as MessageId
const tms = (n: number) => n as unknown as Message['sentAt']
// Adversarial: protocol-shaped refs; they must never reach the DOM.
const REF = 'mxc://tayet.local/printerro' as unknown as MediaRef
const BARE = 'mxc://tayet.local/semnome' as unknown as MediaRef

const helena: User = { id: uid('@helena:tayet.local'), displayName: 'Helena Dias', kind: 'member' }
const usersById: Record<string, User> = { [helena.id]: helena }
const channel: Channel = { id: cid('!fin:tayet.local'), name: '#financeiro', kind: 'public', memberCount: 2, unread: { count: 0, mentions: 0 } }

function message(id: string, body: Message['body'], at = 1_700_000_000_000): Message {
  return { id: mid(id), channelId: channel.id, author: helena.id, body, sentAt: tms(at), reactions: [], mine: false, mentionsMe: false }
}
const named = message('$img:tayet.local', { kind: 'image', media: REF, alt: 'print-erro.png', width: 1600, height: 900 })
const bare = message('$bare:tayet.local', { kind: 'image', media: BARE })

// Thumbnails resolve at once; the full image is a deferred the test settles by hand.
function resolver() {
  const full: Array<{ resolve: (m: ResolvedMedia) => void; reject: (e: Error) => void }> = []
  const fn = vi.fn((_ref: MediaRef, variant?: MediaVariant) =>
    variant === 'thumbnail'
      ? Promise.resolve({ url: 'blob:tayet/thumb', release: () => {} })
      : new Promise<ResolvedMedia>((resolve, reject) => full.push({ resolve, reject })),
  )
  return { fn, full }
}

function mount(msgs: Message[], opts: { narrow?: boolean; thread?: { root: Message; replies: Message[] } } = {}) {
  const r = resolver()
  const view = render(
    <MediaProvider resolve={r.fn}>
      <Workspace
        channels={[channel]}
        selectedChannelId={channel.id}
        messages={msgs}
        usersById={usersById}
        connection="connected"
        onSelectChannel={() => {}}
        onSend={() => {}}
        narrow={opts.narrow}
        threadRoot={opts.thread?.root}
        threadMessages={opts.thread?.replies}
        onCloseThread={opts.thread ? () => {} : undefined}
        onSendThread={opts.thread ? () => {} : undefined}
      />
    </MediaProvider>,
  )
  return { ...view, r }
}

const openName = fill(copy.viewer.open, { name: 'print-erro.png' })
const dialogName = fill(copy.viewer.label, { name: 'print-erro.png' })

async function open(view: ReturnType<typeof mount>, name = openName) {
  const thumb = await view.findByRole('button', { name })
  fireEvent.click(thumb)
  return { thumb, dialog: view.getByRole('dialog', { name: name === openName ? dialogName : copy.timeline.image }) }
}

afterEach(() => {
  cleanup()
  vi.mocked(saveFile).mockClear()
})

describe('thumbnail', () => {
  it('the ready thumbnail is a button named by the alt; without one, "Abrir imagem"', async () => {
    const view = mount([named, bare])
    expect(await view.findByRole('button', { name: openName })).toBeTruthy()
    expect(view.getByRole('button', { name: copy.viewer.openUnnamed })).toBeTruthy()
    // The image keeps its own name inside the button.
    expect(view.getByRole('img', { name: 'print-erro.png' })).toBeTruthy()
  })

  it('a thumbnail still waiting or failed is not a button', async () => {
    const fn = vi.fn((_r: MediaRef, _v?: MediaVariant) => new Promise<ResolvedMedia>(() => {}))
    const view = render(
      <MediaProvider resolve={fn}>
        <Workspace channels={[channel]} selectedChannelId={channel.id} messages={[named]} usersById={usersById} connection="connected" onSelectChannel={() => {}} onSend={() => {}} />
      </MediaProvider>,
    )
    await act(async () => {})
    expect(view.queryByRole('button', { name: openName })).toBeNull()
  })

  it('outside a Workspace (no viewer) the thumbnail is the plain image', async () => {
    const r = resolver()
    const view = render(
      <MediaProvider resolve={r.fn}>
        <Timeline messages={[named]} usersById={usersById} />
      </MediaProvider>,
    )
    expect(await view.findByRole('img', { name: 'print-erro.png' })).toBeTruthy()
    expect(view.queryByRole('button', { name: openName })).toBeNull()
  })
})

describe('viewer, wide', () => {
  it('opens on the full image, named by the alt, with the author and the time; the focus on close', async () => {
    const view = mount([named])
    const { dialog } = await open(view)
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(view.r.fn).toHaveBeenCalledWith(REF, undefined) // the full variant, never the thumbnail
    expect(within(dialog).getByText('Helena Dias')).toBeTruthy()
    expect(within(dialog).getByText(timeOf(named.sentAt))).toBeTruthy()
    expect(within(dialog).queryByText('print-erro.png')).toBeNull() // the file name is not in the header
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: copy.dialog.close }))
  })

  it('loading: "Carregando…" as a status and "Baixar" disabled', async () => {
    const view = mount([named])
    const { dialog } = await open(view)
    expect(within(dialog).getByRole('status').textContent).toBe(copy.viewer.loading)
    expect((within(dialog).getByRole('button', { name: copy.viewer.download }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('failure: the danger line and "Tentar de novo", "Baixar" disabled; the retry loads it', async () => {
    const view = mount([named])
    const { dialog } = await open(view)
    await act(async () => view.r.full[0]!.reject(new Error('media fetch failed: M_UNKNOWN_TOKEN')))
    const alert = within(dialog).getByRole('alert')
    expect(alert.textContent).toContain(copy.viewer.failed)
    expect((within(dialog).getByRole('button', { name: copy.viewer.download }) as HTMLButtonElement).disabled).toBe(true)
    expect(findProtocolLeaksInText(view.container.innerHTML)).toEqual([])
    fireEvent.click(within(alert).getByRole('button', { name: copy.timeline.retry }))
    await act(async () => view.r.full[1]!.resolve({ url: 'blob:tayet/full', release: () => {} }))
    expect(within(dialog).getByRole('button', { name: copy.viewer.actualSize })).toBeTruthy()
    expect((within(dialog).getByRole('button', { name: copy.viewer.download }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('the click toggles the real size and back; the focus stays on the image', async () => {
    const view = mount([named])
    const { dialog } = await open(view)
    await act(async () => view.r.full[0]!.resolve({ url: 'blob:tayet/full', release: () => {} }))
    const toggle = within(dialog).getByRole('button', { name: copy.viewer.actualSize })
    expect(toggle.querySelector('img')?.getAttribute('src')).toBe('blob:tayet/full')
    toggle.focus()
    fireEvent.click(toggle)
    expect(dialog.getAttribute('data-real')).toBe('true')
    expect(toggle.getAttribute('aria-label')).toBe(copy.viewer.fit)
    expect(document.activeElement).toBe(toggle)
    fireEvent.click(toggle)
    expect(dialog.hasAttribute('data-real')).toBe(false)
    expect(toggle.getAttribute('aria-label')).toBe(copy.viewer.actualSize)
    expect(view.queryByRole('dialog')).not.toBeNull() // a click on the image never closes
  })

  it('"Baixar" saves the image under its alt; without one, under the generic name', async () => {
    const view = mount([named, bare])
    let { dialog } = await open(view)
    await act(async () => view.r.full[0]!.resolve({ url: 'blob:tayet/full', release: () => {} }))
    fireEvent.click(within(dialog).getByRole('button', { name: copy.viewer.download }))
    expect(saveFile).toHaveBeenCalledWith('blob:tayet/full', 'print-erro.png')
    fireEvent.click(within(dialog).getByRole('button', { name: copy.dialog.close }))
    ;({ dialog } = await open(view, copy.viewer.openUnnamed))
    await act(async () => view.r.full[1]!.resolve({ url: 'blob:tayet/bare', release: () => {} }))
    fireEvent.click(within(dialog).getByRole('button', { name: copy.viewer.download }))
    expect(saveFile).toHaveBeenLastCalledWith('blob:tayet/bare', copy.timeline.imageAlt)
  })

  it('Esc closes and the focus goes back to the thumbnail', async () => {
    const view = mount([named])
    const { thumb, dialog } = await open(view)
    fireEvent.keyDown(within(dialog).getByRole('button', { name: copy.dialog.close }), { key: 'Escape' })
    expect(view.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(thumb)
  })

  it('a click outside the image closes; so does the close button', async () => {
    const view = mount([named])
    let { dialog } = await open(view)
    await act(async () => view.r.full[0]!.resolve({ url: 'blob:tayet/full', release: () => {} }))
    fireEvent.click(dialog.querySelector('.image-viewer__body')!)
    expect(view.queryByRole('dialog')).toBeNull()
    ;({ dialog } = await open(view))
    const { thumb } = { thumb: view.getByRole('button', { name: openName }) }
    fireEvent.click(within(dialog).getByRole('button', { name: copy.dialog.close }))
    expect(view.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(thumb)
  })

  it('an image inside the thread opens the viewer by the same rules', async () => {
    const root = message('$root:tayet.local', { kind: 'text', text: 'Olha o erro' })
    const reply = { ...named, id: mid('$reply:tayet.local'), threadParent: root.id }
    const view = mount([root], { thread: { root, replies: [reply] } })
    const { dialog } = await open(view)
    expect(dialog).toBeTruthy()
  })

  it('render-scan: no protocol shape and no technical copy in the viewer', async () => {
    const view = mount([named])
    await open(view)
    await act(async () => view.r.full[0]!.resolve({ url: 'blob:tayet/full', release: () => {} }))
    const html = view.container.innerHTML
    expect(findProtocolLeaksInText(html)).toEqual([])
    expect(html).not.toContain('printerro')
    for (const term of ['token', 'server', 'servidor', 'decrypt', 'chave', 'key']) {
      expect((view.container.textContent ?? '').toLowerCase()).not.toContain(term)
    }
  })
})

describe('viewer, narrow', () => {
  it('close · author and time · "Baixar", the image without the toggle', async () => {
    const view = mount([named], { narrow: true })
    const { dialog } = await open(view)
    await act(async () => view.r.full[0]!.resolve({ url: 'blob:tayet/full', release: () => {} }))
    const header = dialog.querySelector('header')!
    const order = [...header.children].map((el) => el.getAttribute('aria-label') ?? el.textContent)
    expect(order).toEqual([copy.dialog.close, `Helena Dias${timeOf(named.sentAt)}`, copy.viewer.download])
    expect(within(dialog).queryByRole('button', { name: copy.viewer.actualSize })).toBeNull()
    expect(dialog.querySelector('img')?.getAttribute('src')).toBe('blob:tayet/full')
    // No click-outside close on the narrow screen: only close, Esc and the system's back.
    fireEvent.click(dialog.querySelector('.image-viewer__body')!)
    expect(view.queryByRole('dialog')).not.toBeNull()
  })

  it('failure in a column: the text and "Tentar de novo", "Baixar" disabled', async () => {
    const view = mount([named], { narrow: true })
    const { dialog } = await open(view)
    await act(async () => view.r.full[0]!.reject(new Error('media unavailable')))
    expect(within(dialog).getByRole('alert').textContent).toContain(copy.viewer.failed)
    await waitFor(() => expect((within(dialog).getByRole('button', { name: copy.viewer.download }) as HTMLButtonElement).disabled).toBe(true))
  })
})
