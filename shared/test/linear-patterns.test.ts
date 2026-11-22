import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import type { FormField } from '../src'
import { sanitizeExportFileName, trimEndSpacesAndDots, trimSpacesAndDots } from '../src/export/file-name'
import { isEmail, validateFormValues } from '../src/internal/forms'
import { cleanDisplayName, stripDisambiguation } from '../src/internal/translate'

// The linear functions against the backtracking patterns they replaced: exactly the same result on a
// generated corpus of short strings, and a bound on the time of each call on long adversarial input.
// The old patterns only ever see the short strings: on the long ones they take seconds.

const old = {
  email: (s: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s),
  trimBoth: (s: string): string => s.replace(/^[\s.]+|[\s.]+$/g, ''),
  trimEnd: (s: string): string => s.replace(/[\s.]+$/, ''),
  // Both call sites trim the name before they strip the suffix.
  strip: (s: string): string => s.trim().replace(/\s*\(@[^:]+:[^)]+\)\s*$/, ''),
}

const ALPHABET = [' ', '\t', '.', '@', ':', '(', ')', 'a', 'é', ' ']
// Pieces of the shapes the patterns look for, so that the longer strings often match.
const PIECES = ['(@', ':', ')', '(', '@', 'a', ' ', '.']
const RANDOM_STRINGS = 20_000
const RANDOM_MAX_LENGTH = 40
const SEED = 0x7a9e7

function* sequences(parts: readonly string[], max: number, prefix = ''): Generator<string> {
  yield prefix
  if (max === 0) return
  for (const part of parts) yield* sequences(parts, max - 1, prefix + part)
}

// mulberry32: a small generator with a fixed seed, so every run sees the same corpus.
function seeded(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), state | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function* corpus(): Generator<string> {
  // Every string of the alphabet up to length 6.
  yield* sequences(ALPHABET, 6)
  // Every sequence of up to 6 pieces, open and closed by a parenthesis.
  for (const s of sequences(PIECES, 6)) {
    yield s
    yield `${s})`
  }
  const random = seeded(SEED)
  for (const parts of [ALPHABET, PIECES]) {
    for (let i = 0; i < RANDOM_STRINGS; i++) {
      const length = Math.floor(random() * (RANDOM_MAX_LENGTH + 1))
      let s = ''
      while (s.length < length) s += parts[Math.floor(random() * parts.length)]
      yield s.slice(0, RANDOM_MAX_LENGTH)
    }
  }
  // Every UTF-16 code unit where whitespace decides: what counts as whitespace must not drift.
  for (let unit = 0; unit <= 0xffff; unit++) {
    const c = String.fromCharCode(unit)
    yield c
    yield `${c}a${c}`
    yield `a@b${c}.c`
    yield `x${c}(@a:b)`
    yield `x (@a:b)${c}`
  }
}

function compare<T>(before: (s: string) => T, after: (s: string) => T, matched: (s: string, out: T) => boolean) {
  const different: { input: string; before: T; after: T }[] = []
  let matches = 0
  for (const input of corpus()) {
    const a = before(input)
    const b = after(input)
    if (a !== b && different.length < 10) different.push({ input, before: a, after: b })
    if (matched(input, a)) matches++
  }
  return { different, matches }
}

const DIFFERENTIAL_TIMEOUT_MS = 60_000

describe('same result as the pattern it replaced', () => {
  it('isEmail', { timeout: DIFFERENTIAL_TIMEOUT_MS }, () => {
    const { different, matches } = compare(old.email, isEmail, (_, out) => out)
    expect(different).toEqual([])
    expect(matches).toBeGreaterThan(1000) // the corpus reaches the accepting branch
  })

  it('trimSpacesAndDots', { timeout: DIFFERENTIAL_TIMEOUT_MS }, () => {
    const { different, matches } = compare(old.trimBoth, trimSpacesAndDots, (s, out) => out !== s)
    expect(different).toEqual([])
    expect(matches).toBeGreaterThan(1000)
  })

  it('trimEndSpacesAndDots', { timeout: DIFFERENTIAL_TIMEOUT_MS }, () => {
    const { different, matches } = compare(old.trimEnd, trimEndSpacesAndDots, (s, out) => out !== s)
    expect(different).toEqual([])
    expect(matches).toBeGreaterThan(1000)
  })

  it('stripDisambiguation', { timeout: DIFFERENTIAL_TIMEOUT_MS }, () => {
    const { different, matches } = compare(old.strip, (s) => stripDisambiguation(s.trim()), (s, out) => out !== s.trim())
    expect(different).toEqual([])
    expect(matches).toBeGreaterThan(1000)
  })

  it('stripDisambiguation starts at the leftmost qualifying `(@`, not at the last one', () => {
    expect(stripDisambiguation('Ana (@a(@b:c)')).toBe('Ana')
    expect(stripDisambiguation('Ana (@x) (@a:b)')).toBe('Ana')
    // The first colon decides: a later one does not rescue an empty user part or a `)` after it.
    expect(stripDisambiguation('Ana (@::c)')).toBe('Ana (@::c)')
    expect(stripDisambiguation('Ana (@a:b):c)')).toBe('Ana (@a:b):c)')
  })

  it('an email value that is not a string at run time is an issue, not a throw', () => {
    const field: FormField = { kind: 'email', id: 'e', label: 'E', optional: true }
    expect(validateFormValues([field], { e: 1 as unknown as string })).toEqual({ e: { code: 'email' } })
  })
})

const N = 50_000
const LIMIT_MS = 200

function expectFast(call: () => unknown): void {
  const start = performance.now()
  call()
  expect(performance.now() - start).toBeLessThan(LIMIT_MS)
}

describe('linear on long adversarial input', () => {
  it.each([
    ['dots in the domain, then a space', `a@${'a.'.repeat(N / 2)} `],
    ['dots in the domain, then a second @', `!@!.${'!.'.repeat(N / 2)}@`],
    ['only dots in the domain, then a second @', `a@${'.'.repeat(N)}@`],
    ['a long valid address', `a@${'a.'.repeat(N / 2)}a`],
  ])('isEmail: %s', (_, input) => {
    expectFast(() => isEmail(input))
  })

  it.each([
    ['inner spaces, spaces at the ends', `  a${' '.repeat(N)}a  `],
    ['inner tabs', `a${'\t'.repeat(N)}a`],
    ['inner dots', `a${'.'.repeat(N)}a`],
    ['only spaces', ' '.repeat(N)],
  ])('file name: %s', (_, input) => {
    expectFast(() => trimSpacesAndDots(input))
    expectFast(() => trimEndSpacesAndDots(input))
    expectFast(() => sanitizeExportFileName(input))
  })

  it.each([
    ['leading spaces', `${' '.repeat(N)}x`],
    ['inner spaces', `x${' '.repeat(N)}x`],
    ['inner spaces before a suffix', `x${' '.repeat(N)}x (@a:b)`],
    ['repeated openings', '(@'.repeat(N / 2)],
    ['repeated openings with an empty user part', `(@9:${'(@(:'.repeat(N / 4)}`],
    ['repeated openings, closed', `${'(@'.repeat(N / 2)})`],
    ['repeated openings, one suffix', `${'(@'.repeat(N / 2)}:b)`],
    ['repeated colons, closed', `${'(@a:'.repeat(N / 4)})`],
  ])('display name: %s', (_, input) => {
    expectFast(() => stripDisambiguation(input.trim()))
    expectFast(() => cleanDisplayName(input, '@alice:tayet.local'))
  })
})
