// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, cleanup, fireEvent, act, waitFor } from '@testing-library/react'
import { Timeline } from '../../src/ui/components/Timeline'
import { MediaProvider } from '../../src/ui/MediaContext'
import type { MediaRef, Message, MessageId, ResolvedMedia, User, UserId, ChannelId } from '../../src/acl'

// PLANO §8.27 B: a conversation opens at its latest message, and an image does not push it off.
//  - With the domain's dimensions the <img> carries width/height (and the pending state is a box
//    of the same ratio), so the height is reserved before the bytes load.
//  - Without dimensions the Timeline re-anchors to the bottom when the content grows — ONLY if the
//    reader was at the bottom. jsdom has no layout and no ResizeObserver: a fake observer is fired
//    by hand, and scrollHeight/clientHeight are driven per test.

const uid = (s: string): UserId => s as unknown as UserId
const mid = (s: string): MessageId => s as unknown as MessageId
const tms = (n: number) => n as unknown as Message['sentAt']
const REF = 'mxc://tayet.local/img' as unknown as MediaRef
const alice: User = { id: uid('@alice:tayet.local'), displayName: 'Alice Anderson', kind: 'member' }
const usersById = { [alice.id]: alice }

function msg(id: string, body: Message['body']): Message {
  return {
    id: mid(id),
    channelId: '!dm:tayet.local' as unknown as ChannelId,
    author: alice.id,
    body,
    sentAt: tms(1),
    reactions: [],
    mine: false,
    mentionsMe: false,
  }
}

// The fake ResizeObserver: records observed elements; trigger() fires every observer's callback.
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  observed = new Set<Element>()
  constructor(private readonly cb: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this)
  }
  observe(el: Element): void {
    this.observed.add(el)
  }
  unobserve(el: Element): void {
    this.observed.delete(el)
  }
  disconnect(): void {
    this.observed.clear()
  }
  static trigger(): void {
    for (const o of FakeResizeObserver.instances) o.cb([], o as unknown as ResizeObserver)
  }
}

// Drive the scroller's geometry (jsdom computes none).
function geometry(el: HTMLElement, g: { scrollHeight: number; clientHeight: number }): void {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => g.scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => g.clientHeight })
}

const neverResolves = () => new Promise<ResolvedMedia>(() => {})
const resolvesTo = (url: string) => async () => ({ url, release: () => {} })

beforeEach(() => {
  FakeResizeObserver.instances = []
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver
})
afterEach(() => {
  cleanup()
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
})

describe('ImageBody reserves the box from the domain dimensions', () => {
  it('ready: <img> carries width/height and the ratio', async () => {
    const m = msg('$i:tayet.local', { kind: 'image', media: REF, alt: 'planta', width: 1200, height: 800 })
    const { getByRole } = render(
      <MediaProvider resolve={resolvesTo('blob:ok')}>
        <Timeline messages={[m]} usersById={usersById} />
      </MediaProvider>,
    )
    // The pending box (same role/name) is replaced by the <img> once the bytes resolve.
    await waitFor(() => expect(getByRole('img', { name: 'planta' }).tagName).toBe('IMG'))
    const img = getByRole('img', { name: 'planta' }) as HTMLImageElement
    expect(img.getAttribute('width')).toBe('1200')
    expect(img.getAttribute('height')).toBe('800')
    expect(img.className).toContain('message__image--sized')
    expect(img.style.getPropertyValue('--image-ratio')).toBe('1.5')
  })

  it('pending: a box of the same ratio stands in before the bytes arrive', () => {
    const m = msg('$i:tayet.local', { kind: 'image', media: REF, alt: 'planta', width: 600, height: 900 })
    const { getByRole } = render(
      <MediaProvider resolve={neverResolves}>
        <Timeline messages={[m]} usersById={usersById} />
      </MediaProvider>,
    )
    const box = getByRole('img', { name: 'planta' })
    expect(box.tagName).toBe('SPAN')
    expect(box.className).toContain('message__image--sized')
    expect(Number(box.style.getPropertyValue('--image-ratio'))).toBeCloseTo(600 / 900)
  })

  it('without dimensions: no width/height attributes (the re-anchor covers it)', async () => {
    const m = msg('$i:tayet.local', { kind: 'image', media: REF, alt: 'planta' })
    const { findByRole } = render(
      <MediaProvider resolve={resolvesTo('blob:ok')}>
        <Timeline messages={[m]} usersById={usersById} />
      </MediaProvider>,
    )
    const img = await findByRole('img', { name: 'planta' })
    expect(img.hasAttribute('width')).toBe(false)
    expect(img.hasAttribute('height')).toBe(false)
  })
})

describe('Timeline bottom anchoring', () => {
  const text = (id: string, t: string) => msg(id, { kind: 'text', text: t })

  it('opens at the bottom, and re-anchors when content grows while the reader is there', () => {
    const { getByRole, rerender } = render(<Timeline messages={[text('$a:x', 'one')]} usersById={usersById} />)
    const log = getByRole('log')
    expect(FakeResizeObserver.instances[0]!.observed.has(log)).toBe(true)

    // A new message while at the bottom → anchored before paint.
    geometry(log, { scrollHeight: 1000, clientHeight: 400 })
    rerender(<Timeline messages={[text('$a:x', 'one'), text('$b:x', 'two')]} usersById={usersById} />)
    expect(log.scrollTop).toBe(1000)

    // An image without dimensions loads → the row grows → the observer re-anchors.
    geometry(log, { scrollHeight: 1600, clientHeight: 400 })
    act(() => FakeResizeObserver.trigger())
    expect(log.scrollTop).toBe(1600)
  })

  it('a reader who scrolled up to read history is not moved', () => {
    const { getByRole, rerender } = render(<Timeline messages={[text('$a:x', 'one')]} usersById={usersById} />)
    const log = getByRole('log')
    geometry(log, { scrollHeight: 1000, clientHeight: 400 })
    act(() => FakeResizeObserver.trigger())
    expect(log.scrollTop).toBe(1000)

    // The reader scrolls up: 300 + 400 is far from 1000.
    log.scrollTop = 300
    fireEvent.scroll(log)

    geometry(log, { scrollHeight: 1600, clientHeight: 400 })
    act(() => FakeResizeObserver.trigger())
    expect(log.scrollTop).toBe(300)
    rerender(<Timeline messages={[text('$a:x', 'one'), text('$b:x', 'two')]} usersById={usersById} />)
    expect(log.scrollTop).toBe(300)

    // Back to the bottom by their own scroll → anchoring resumes.
    log.scrollTop = 1200
    fireEvent.scroll(log)
    geometry(log, { scrollHeight: 2000, clientHeight: 400 })
    act(() => FakeResizeObserver.trigger())
    expect(log.scrollTop).toBe(2000)
  })

  it('content growing before our own scroll event lands does not let go of the bottom (reload race)', () => {
    const { getByRole } = render(<Timeline messages={[text('$a:x', 'one')]} usersById={usersById} />)
    const log = getByRole('log')
    geometry(log, { scrollHeight: 1000, clientHeight: 400 })
    act(() => FakeResizeObserver.trigger())
    expect(log.scrollTop).toBe(1000)

    // The image row grows; the scroll event of the anchoring above is dispatched only now, when the
    // distance to the bottom already reads 600 — growth, not the reader moving.
    geometry(log, { scrollHeight: 1600, clientHeight: 400 })
    fireEvent.scroll(log)
    act(() => FakeResizeObserver.trigger())
    expect(log.scrollTop).toBe(1600)
  })

  it('observes each row group, so a growing image row is seen', () => {
    const { getByRole } = render(<Timeline messages={[text('$a:x', 'one')]} usersById={usersById} />)
    const group = getByRole('log').querySelector('.message__group')!
    expect(FakeResizeObserver.instances[0]!.observed.has(group)).toBe(true)
  })
})
