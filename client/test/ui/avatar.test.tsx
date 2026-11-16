// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { Avatar } from '../../src/ui/primitives'

// Avatar modo-imagem (ADR-036 addendum dec. 5). The primitive stays protocol-agnostic: it takes a
// plain `label` and an already-resolved `src` string — never a MediaRef. With `src` it renders the
// photo; without (or on a broken img) it falls back to the canonical monogram.

afterEach(cleanup)

describe('Avatar (image mode)', () => {
  it('renders the monogram label and no <img> when src is absent', () => {
    const { container } = render(<Avatar label="AA" />)
    const box = container.querySelector('.ui-avatar')!
    expect(box.textContent).toBe('AA')
    expect(container.querySelector('img')).toBeNull()
    expect(box.getAttribute('data-image')).toBeNull()
  })

  it('renders the <img> at the resolved src and no label text when src is present', () => {
    const { container } = render(<Avatar label="AA" src="blob:tayet/photo" />)
    const box = container.querySelector('.ui-avatar')!
    const img = container.querySelector('img')!
    expect(img.getAttribute('src')).toBe('blob:tayet/photo')
    expect(img.getAttribute('alt')).toBe('') // decorative
    expect(box.getAttribute('data-image')).toBe('true')
    expect(box.textContent).toBe('') // the label is not shown alongside the photo
  })

  it('falls back to the monogram when the img errors', () => {
    const { container } = render(<Avatar label="AA" src="blob:tayet/broken" />)
    const img = container.querySelector('img')!
    fireEvent.error(img)
    const box = container.querySelector('.ui-avatar')!
    expect(container.querySelector('img')).toBeNull()
    expect(box.textContent).toBe('AA')
    expect(box.getAttribute('data-image')).toBeNull()
  })

  it('sets data-image only when a photo is showing', () => {
    const { container, rerender } = render(<Avatar label="AA" />)
    expect(container.querySelector('.ui-avatar')!.getAttribute('data-image')).toBeNull()
    rerender(<Avatar label="AA" src="blob:tayet/photo" />)
    expect(container.querySelector('.ui-avatar')!.getAttribute('data-image')).toBe('true')
  })
})

// Presence prop (ADR-036 addendum; manifests workspace/new-conversation §7). Orthogonal to
// variant/size/src. The load-bearing invariant: WITHOUT the prop the DOM is byte-identical to the
// bare form (no wrapper) — asserted on the exact markup, not just the dot's absence. With it, a
// relative wrapper holds the untouched box plus a sibling dot rendered ONLY when online (away/
// offline keep the wrapper, no dot — stable structure across transitions).

describe('Avatar (presence)', () => {
  it('without presence the DOM is byte-identical to the bare form — no wrapper', () => {
    const { container } = render(<Avatar label="AA" />)
    expect(container.innerHTML).toBe(
      '<span class="ui-avatar" data-variant="greige" data-size="cotidiano" aria-hidden="true">AA</span>',
    )
  })

  it('presence="online" renders the wrapper with the box and a sibling dot', () => {
    const { container } = render(<Avatar label="AA" presence="online" />)
    const wrap = container.querySelector('.ui-avatar-wrap')!
    expect(wrap).not.toBeNull()
    const box = wrap.querySelector('.ui-avatar')!
    const dot = wrap.querySelector('.ui-avatar__dot')!
    expect(box).not.toBeNull()
    expect(dot).not.toBeNull()
    // The dot is the box's SIBLING (the box's overflow:hidden would clip a child), decorative.
    expect(dot.parentElement).toBe(wrap)
    expect(dot.getAttribute('aria-hidden')).toBe('true')
    expect(dot.textContent).toBe('')
    // The box itself is untouched: same attributes as the bare form.
    expect(box.getAttribute('aria-hidden')).toBe('true')
    expect(box.textContent).toBe('AA')
  })

  it.each(['offline', 'away'] as const)('presence="%s" renders the wrapper WITHOUT a dot', (p) => {
    const { container } = render(<Avatar label="AA" presence={p} />)
    expect(container.querySelector('.ui-avatar-wrap')).not.toBeNull()
    expect(container.querySelector('.ui-avatar__dot')).toBeNull()
  })

  it('monogram and photo modes keep working inside the wrapper', () => {
    const { container, rerender } = render(<Avatar label="AA" presence="online" />)
    expect(container.querySelector('.ui-avatar-wrap .ui-avatar')!.textContent).toBe('AA')
    rerender(<Avatar label="AA" src="blob:tayet/photo" presence="online" />)
    const img = container.querySelector('.ui-avatar-wrap .ui-avatar img')!
    expect(img.getAttribute('src')).toBe('blob:tayet/photo')
    fireEvent.error(img)
    expect(container.querySelector('.ui-avatar-wrap .ui-avatar')!.textContent).toBe('AA')
    expect(container.querySelector('.ui-avatar__dot')).not.toBeNull()
  })
})
