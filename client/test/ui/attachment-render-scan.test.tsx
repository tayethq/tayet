// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { Workspace } from '../../src/ui/components/Workspace'
import { MediaProvider } from '../../src/ui/MediaContext'
import type { Channel, Message, User, ChannelId, UserId, MessageId, MediaRef } from '../../src/acl'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { saveFile } from '../../src/ui/save-file'

vi.mock('../../src/ui/save-file', () => ({ saveFile: vi.fn() }))

// PLANO-FASE-1-UPLOAD §5.2 (commit 4): the render-scan over the RECEIVED attachment bubble — a new
// P1 surface. Image and file bodies must render via the resolved per-session URL, never the raw
// MediaRef/mxc. The fixture MediaRef is itself protocol-shaped (mxc) to make any leak turn red.

const cid = (s: string): ChannelId => s as unknown as ChannelId
const uid = (s: string): UserId => s as unknown as UserId
const mid = (s: string): MessageId => s as unknown as MessageId
const tms = (n: number) => n as unknown as Message['sentAt']
const ref = (s: string): MediaRef => s as unknown as MediaRef

afterEach(cleanup)

const alice: User = { id: uid('@alice:tayet.local'), displayName: 'Alice Anderson', kind: 'member' }
const usersById: Record<string, User> = { [alice.id]: alice }
const channel: Channel = {
  id: cid('!engineering:tayet.local'),
  name: '#engineering',
  kind: 'public',
  memberCount: 1,
  unread: { count: 0, mentions: 0 },
}

function renderWith(messages: Message[], onSendAttachment?: (f: File) => void) {
  const release = vi.fn()
  const resolve = vi.fn(async () => ({ url: 'blob:tayet/resolved', release }))
  const result = render(
    <MediaProvider resolve={resolve}>
      <Workspace
        channels={[channel]}
        selectedChannelId={channel.id}
        messages={messages}
        usersById={usersById}
        connection="connected"
        onSelectChannel={() => {}}
        onSend={() => {}}
        onSendAttachment={onSendAttachment}
      />
    </MediaProvider>,
  )
  return { ...result, resolve }
}

describe('received attachment render-scan (P1 on screen)', () => {
  it('renders a received IMAGE via the resolved URL, leaking no mxc/MediaRef', async () => {
    const img: Message = {
      id: mid('$img:tayet.local'),
      channelId: channel.id,
      author: alice.id,
      body: { kind: 'image', media: ref('mxc://tayet.local/secret'), alt: 'a diagram' },
      sentAt: tms(1),
      reactions: [],
      mine: false,
      mentionsMe: false,
    }
    const { container, findByRole } = renderWith([img])
    const el = (await findByRole('img')) as HTMLImageElement
    expect(el.getAttribute('src')).toBe('blob:tayet/resolved')
    await waitFor(() => expect(findProtocolLeaksInText(container.innerHTML)).toEqual([]))
  })

  it('renders a received FILE via the resolved download URL, leaking no mxc/MediaRef', async () => {
    const file: Message = {
      id: mid('$file:tayet.local'),
      channelId: channel.id,
      author: alice.id,
      body: { kind: 'file', media: ref('mxc://tayet.local/doc'), name: 'report.pdf', size: 1234, mimetype: 'application/pdf' },
      sentAt: tms(2),
      reactions: [],
      mine: false,
      mentionsMe: false,
    }
    const { container, resolve } = renderWith([file])
    // Fetched on the click, never on render (PLANO-MOBILE §0.14 V2 b).
    expect(resolve).not.toHaveBeenCalled()
    fireEvent.click(container.querySelector('a.message__file')!)
    await waitFor(() => {
      const link = container.querySelector('a.message__file') as HTMLAnchorElement | null
      expect(link?.getAttribute('href')).toBe('blob:tayet/resolved')
    })
    expect(saveFile).toHaveBeenCalledWith('blob:tayet/resolved', 'report.pdf')
    expect(container.textContent).toContain('report.pdf')
    expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
  })

  it('the composer file picker forwards the picked File as user intent', () => {
    const onSendAttachment = vi.fn()
    const { container } = renderWith([], onSendAttachment)
    const input = container.querySelector('.composer__file') as HTMLInputElement
    const file = new File([new Uint8Array([1, 2, 3])], 'pixel.png', { type: 'image/png' })
    fireEvent.change(input, { target: { files: [file] } })
    expect(onSendAttachment).toHaveBeenCalledWith(file)
  })
})
