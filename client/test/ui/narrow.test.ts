// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, renderHook } from '@testing-library/react'
import { NARROW_QUERY, isCoarseOrNarrow, isNarrowWindow, useNarrowWindow } from '../../src/ui/narrow'

const css = readFileSync(join(__dirname, '..', '..', 'src', 'ui', 'styles.css'), 'utf8')
// The narrow shell's own file: only rules under the width query.
const narrowCss = readFileSync(join(__dirname, '..', '..', 'src', 'ui', 'styles.narrow.css'), 'utf8')
const COARSE_OR_NARROW = `(pointer: coarse), ${NARROW_QUERY}`
const mediaLines = [...css.matchAll(/^@media ([^{]+)\{/gm)].map((m) => m[1]!.trim())

// A matchMedia over a fixed set of true media features; a media list matches when any query does.
function stubDevice(truths: string[]) {
  const listeners = new Set<() => void>()
  let current = truths
  vi.stubGlobal('matchMedia', (q: string) => ({
    get matches() {
      return q.split(',').some((part) => current.includes(part.trim()))
    },
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  }))
  return {
    set(next: string[]) {
      current = next
      for (const fn of listeners) fn()
    },
    listeners,
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('width signal: the CSS and the module use the same query', () => {
  it('the breakpoint literal in styles.css and styles.narrow.css is the module constant', () => {
    const widths = new Set([...`${css}\n${narrowCss}`.matchAll(/\(width\s*[<>]=?\s*(\d+px)\)/g)].map((m) => m[1]))
    expect(NARROW_QUERY).toBe('(width < 728px)')
    expect([...widths]).toEqual(['728px'])
  })

  it('styles.narrow.css holds only rules under the width query, each block the module constant', () => {
    const queries = [...narrowCss.matchAll(/^@media ([^{]+)\{/gm)].map((m) => m[1]!.trim())
    expect(queries.length).toBeGreaterThan(0)
    expect(new Set(queries)).toEqual(new Set([NARROW_QUERY]))
    // Nothing at the top level: every rule of the file is inside one of those blocks.
    let depth = 0
    for (const line of narrowCss.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')) {
      const trimmed = line.trim()
      if (depth === 0 && trimmed !== '') expect(trimmed.startsWith('@media')).toBe(true)
      depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length
    }
    expect(depth).toBe(0)
  })

  it('every pointer query reads the width too, by block kind', () => {
    // Touch floor: coarse pointer or narrow window.
    expect(mediaLines.filter((q) => q === COARSE_OR_NARROW)).toHaveLength(9)
    // Inline buttons that drop the floor: fine pointer and normal width (the media retry since the M4).
    expect(mediaLines.filter((q) => q === '(not (pointer: coarse)) and (width >= 728px)')).toHaveLength(3)
    // Narrow window only.
    expect(mediaLines.filter((q) => q === NARROW_QUERY)).toHaveLength(1)
    // No pointer query left that ignores the width.
    expect(mediaLines.filter((q) => q.includes('pointer') && !q.includes('728px'))).toEqual([])
  })
})

describe('width signal: module', () => {
  it('without matchMedia nothing is narrow', () => {
    vi.stubGlobal('matchMedia', undefined)
    expect(isNarrowWindow()).toBe(false)
    expect(isCoarseOrNarrow()).toBe(false)
  })

  it('narrow window, fine pointer', () => {
    stubDevice(['(width < 728px)'])
    expect(isNarrowWindow()).toBe(true)
    expect(isCoarseOrNarrow()).toBe(true)
  })

  it('wide window, coarse pointer', () => {
    stubDevice(['(pointer: coarse)'])
    expect(isNarrowWindow()).toBe(false)
    expect(isCoarseOrNarrow()).toBe(true)
  })

  it('wide window, fine pointer', () => {
    stubDevice([])
    expect(isNarrowWindow()).toBe(false)
    expect(isCoarseOrNarrow()).toBe(false)
  })

  it('the hook follows the window across the breakpoint and stops listening on unmount', () => {
    const device = stubDevice([])
    const { result, unmount } = renderHook(() => useNarrowWindow())
    expect(result.current).toBe(false)
    act(() => device.set(['(width < 728px)']))
    expect(result.current).toBe(true)
    act(() => device.set([]))
    expect(result.current).toBe(false)
    unmount()
    expect(device.listeners.size).toBe(0)
  })
})
