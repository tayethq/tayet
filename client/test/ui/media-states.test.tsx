// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent, act, waitFor } from '@testing-library/react'
import { Timeline } from '../../src/ui/components/Timeline'
import { MediaProvider } from '../../src/ui/MediaContext'
import type { MediaRef, MediaVariant, Message, MessageId, ResolvedMedia, User, UserId, ChannelId } from '../../src/acl'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { copy } from '../support/copy'
import { saveFile } from '../../src/ui/save-file'

vi.mock('../../src/ui/save-file', () => ({ saveFile: vi.fn() }))

// PLANO-RELEASE-PUBLICA §8.21 (dogfood 2.1; ADR-007 §3 debt): media waiting and media failure are
// DISTINCT on screen. useMedia exposes 'loading' | 'ready' | 'failed' + retry(); FileBody shows a
// neutral "downloading" line, then the link — or a failure line with "Retry"; ImageBody
// keeps the alt placeholder and offers the same retry. release() still runs on unmount (ADR-009).

const uid = (s: string): UserId => s as unknown as UserId
const mid = (s: string): MessageId => s as unknown as MessageId
const tms = (n: number) => n as unknown as Message['sentAt']
// Adversarial (as in render-scan): the ref value is protocol-shaped; it must never reach the DOM.
const REF = 'mxc://tayet.local/secretfile' as unknown as MediaRef

const alice: User = { id: uid('@alice:tayet.local'), displayName: 'Alice Anderson', kind: 'member' }
const usersById = { [alice.id]: alice }

function message(body: Message['body']): Message {
  return {
    id: mid('$m:tayet.local'),
    channelId: '!r:tayet.local' as unknown as ChannelId,
    author: alice.id,
    body,
    sentAt: tms(1),
    reactions: [],
    mine: false,
    mentionsMe: false,
  }
}
const fileMsg = message({ kind: 'file', media: REF, name: 'relatorio.pdf', size: 1024, mimetype: 'application/pdf' })
const imageMsg = message({ kind: 'image', media: REF, alt: 'diagrama' })

// A resolver whose every call is a deferred the test settles by hand.
function deferredResolver() {
  const calls: Array<{ resolve: (m: ResolvedMedia) => void; reject: (e: Error) => void }> = []
  const fn = vi.fn(
    (_ref: MediaRef, _variant?: MediaVariant) =>
      new Promise<ResolvedMedia>((resolve, reject) => calls.push({ resolve, reject })),
  )
  return { fn, calls }
}

function mount(resolve: (ref: MediaRef, variant?: MediaVariant) => Promise<ResolvedMedia>, msg: Message) {
  return render(
    <MediaProvider resolve={resolve}>
      <Timeline messages={[msg]} usersById={usersById} />
    </MediaProvider>,
  )
}

// No technical vocabulary on the new surfaces (copy neutrality, P1 + ADR-015 spirit).
const TECH = ['token', 'sessão', 'sessao', 'session', 'servidor', 'server', 'descriptograf', 'decrypt', 'chave', 'key']
function expectNeutral(container: HTMLElement): void {
  const text = (container.textContent ?? '').toLowerCase()
  for (const term of TECH) expect(text).not.toContain(term)
  expect(findProtocolLeaksInText(container.innerHTML)).toEqual([])
}

afterEach(() => {
  cleanup()
  vi.mocked(saveFile).mockClear()
})

// PLANO-MOBILE §0.14 V2 b (owner, 20/Nov/2026): the file is no longer fetched when it shows up. Nothing
// resolves on render; the click starts the download, which the product saves under the file's name when it
// lands, and the link is then ready: a second click saves at once, without fetching again.
describe('media states — file (download on click: idle/loading/ready/failed + retry)', () => {
  const link = (view: ReturnType<typeof mount>) => view.getByRole('link', { name: `📎 relatorio.pdf` })

  it('nothing resolves on render: the link is at rest, no waiting line', () => {
    const r = deferredResolver()
    const view = mount(r.fn, fileMsg)
    expect(r.fn).not.toHaveBeenCalled()
    expect(link(view).hasAttribute('download')).toBe(false)
    expect(view.queryByText(copy.timeline.downloading)).toBeNull()
    expectNeutral(view.container)
  })

  it('the click starts the download → waiting indicator, no link', () => {
    const r = deferredResolver()
    const view = mount(r.fn, fileMsg)
    fireEvent.click(link(view))
    expect(r.fn).toHaveBeenCalledTimes(1)
    expect(r.fn).toHaveBeenCalledWith(REF, undefined) // the full file, never the thumbnail
    expect(view.getByText(copy.timeline.downloading)).toBeTruthy()
    expect(view.container.textContent).toContain('relatorio.pdf')
    expect(view.queryByRole('link')).toBeNull()
    expect(view.queryByRole('button', { name: copy.timeline.retry })).toBeNull()
    expectNeutral(view.container)
  })

  it('rejection → failure line with retry; retry resolves → saved, and the link is ready', async () => {
    const r = deferredResolver()
    const view = mount(r.fn, fileMsg)
    fireEvent.click(link(view))
    await act(async () => r.calls[0]!.reject(new Error('media fetch failed')))

    expect(view.getByText(copy.timeline.downloadFailed)).toBeTruthy()
    expect(view.queryByText(copy.timeline.downloading)).toBeNull()
    expect(saveFile).not.toHaveBeenCalled()
    expectNeutral(view.container) // the rejection reason never reaches the screen

    fireEvent.click(view.getByRole('button', { name: copy.timeline.retry }))
    expect(r.fn).toHaveBeenCalledTimes(2)
    expect(view.getByText(copy.timeline.downloading)).toBeTruthy() // back to waiting while the retry is in flight

    const release = vi.fn()
    await act(async () => r.calls[1]!.resolve({ url: 'blob:tayet/file', release }))
    const ready = await waitFor(() => link(view))
    expect(ready.getAttribute('href')).toBe('blob:tayet/file')
    expect(ready.getAttribute('download')).toBe('relatorio.pdf')
    expect(saveFile).toHaveBeenCalledTimes(1)
    expect(saveFile).toHaveBeenCalledWith('blob:tayet/file', 'relatorio.pdf')
    expect(view.queryByText(copy.timeline.downloadFailed)).toBeNull()
    expectNeutral(view.container)
  })

  it('a second click saves through the ready link, without fetching again', async () => {
    const resolve = vi.fn(async () => ({ url: 'blob:tayet/file', release: () => {} }))
    const view = mount(resolve, fileMsg)
    fireEvent.click(link(view))
    await waitFor(() => expect(link(view).getAttribute('href')).toBe('blob:tayet/file'))
    // The ready link is the native download: the click is not taken over (no preventDefault).
    const second = new MouseEvent('click', { bubbles: true, cancelable: true })
    link(view).addEventListener('click', (e) => e.preventDefault(), { once: true }) // jsdom does not navigate
    link(view).dispatchEvent(second)
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(saveFile).toHaveBeenCalledTimes(1)
  })

  it('the focus on the link follows to the ready link', async () => {
    const r = deferredResolver()
    const view = mount(r.fn, fileMsg)
    link(view).focus()
    fireEvent.click(link(view))
    await act(async () => r.calls[0]!.resolve({ url: 'blob:tayet/file', release: () => {} }))
    await waitFor(() => expect(document.activeElement).toBe(link(view)))
  })

  it('release() of the object URL still runs on unmount (ADR-009)', async () => {
    const release = vi.fn()
    const view = mount(async () => ({ url: 'blob:tayet/file', release }), fileMsg)
    fireEvent.click(link(view))
    await waitFor(() => expect(link(view).getAttribute('href')).toBe('blob:tayet/file'))
    expect(release).not.toHaveBeenCalled()
    view.unmount()
    expect(release).toHaveBeenCalledTimes(1)
  })
})

describe('media states — image', () => {
  it('pending keeps the alt placeholder; failure adds retry; retry resolves → <img>', async () => {
    const r = deferredResolver()
    const { container, getByRole, queryByRole } = mount(r.fn, imageMsg)
    expect(container.textContent).toContain('diagrama')
    expect(queryByRole('img')).toBeNull()
    expect(queryByRole('button', { name: copy.timeline.retry })).toBeNull()
    expect(r.fn).toHaveBeenCalledWith(REF, 'thumbnail')

    await act(async () => r.calls[0]!.reject(new Error('media unavailable')))
    expect(container.textContent).toContain('diagrama')
    expectNeutral(container)

    fireEvent.click(getByRole('button', { name: copy.timeline.retry }))
    expect(r.fn).toHaveBeenCalledTimes(2)
    await act(async () => r.calls[1]!.resolve({ url: 'blob:tayet/img', release: () => {} }))
    const img = (await waitFor(() => getByRole('img'))) as HTMLImageElement
    expect(img.getAttribute('src')).toBe('blob:tayet/img')
    expect(queryByRole('button', { name: copy.timeline.retry })).toBeNull()
  })
})

// §8.27 B: App hands MediaProvider a NEW resolver function on every render (inline arrow). The
// provider keeps its context value stable, so a re-render never re-resolves (no revoke, no
// placeholder flash, no re-download) — the image row keeps its size.
describe('media — a re-rendered provider does not re-resolve', () => {
  it('a new resolver identity on re-render keeps the ready image and calls resolve once', async () => {
    const release = vi.fn()
    const calls = vi.fn()
    const make = () => (ref: MediaRef, variant?: MediaVariant) => {
      calls(ref, variant)
      return Promise.resolve({ url: 'blob:ready', release })
    }
    const { findByRole, rerender, getByRole } = render(
      <MediaProvider resolve={make()}>
        <Timeline messages={[imageMsg]} usersById={usersById} />
      </MediaProvider>,
    )
    await findByRole('img', { name: 'diagrama' })
    rerender(
      <MediaProvider resolve={make()}>
        <Timeline messages={[imageMsg]} usersById={usersById} />
      </MediaProvider>,
    )
    await act(async () => {})
    expect(calls).toHaveBeenCalledTimes(1)
    expect(release).not.toHaveBeenCalled()
    expect((getByRole('img', { name: 'diagrama' }) as HTMLImageElement).src).toBe('blob:ready')
  })
})
