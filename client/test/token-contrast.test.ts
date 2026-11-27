import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Floor of ADR-027 (addendum of 25/Nov/2026): every text and placeholder has 4.5:1 or more against
// the background it sits on, in both appearances. This gate computes the semantic color pairs straight
// from the DTCG sources (client/tokens/), resolving aliases, with the WCAG 2.x contrast formula.
// Unit, no stack.

type Node = { [k: string]: unknown }

const TOKENS = join(__dirname, '..', 'tokens')
const read = (f: string): Node => JSON.parse(readFileSync(join(TOKENS, f), 'utf8')) as Node
const PRIMITIVES = read('primitives.json')
const THEMES: Record<string, Node> = { light: read('theme.light.json'), dark: read('theme.dark.json') }

function at(root: Node, path: string): unknown {
  let n: unknown = root
  for (const k of path.split('.')) n = (n as Node | undefined)?.[k]
  return n
}

// A token's value as hex: `{color.x.y}` resolves first in the theme, then in the primitives.
function resolve(theme: Node, path: string, depth = 0): string {
  if (depth > 8) throw new Error(`alias loop at ${path}`)
  const node = (at(theme, path) ?? at(PRIMITIVES, path)) as Node | undefined
  const value = node?.['$value']
  if (typeof value !== 'string') throw new Error(`no $value at ${path}`)
  const alias = /^\{(.+)\}$/.exec(value)
  if (alias) return resolve(theme, alias[1] as string, depth + 1)
  if (!/^#[0-9A-Fa-f]{6}$/.test(value)) throw new Error(`${path} is not a 6-digit hex: ${value}`)
  return value
}

function luminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const [r, g, b] = ch.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrast(fg: string, bg: string): number {
  const a = luminance(fg)
  const b = luminance(bg)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

const FLOOR = 4.5

const AGENT_COLORS = ['areia', 'petroleo', 'turquesa', 'salvia', 'ocre', 'argila', 'barro', 'malva', 'ardosia', 'grafite']

// [foreground, background] semantic token names, under `color.`.
// `muted` × `highlight-wash` is left out on purpose: on the search-jump row, CSS swaps muted text
// for --color-text (styles.css, `.message[data-highlight]`), so muted never sits on that wash.
const PAIRS: Array<[string, string]> = [
  ...['bg', 'surface', 'surface-raised', 'accent-wash', 'highlight-wash', 'danger-wash'].map((b): [string, string] => ['text', b]),
  ...['bg', 'surface', 'surface-raised', 'accent-wash', 'danger-wash'].map((b): [string, string] => ['muted', b]),
  ...['bg', 'surface', 'surface-raised', 'accent-wash'].map((b): [string, string] => ['accent', b]),
  ...['bg', 'surface', 'surface-raised', 'danger-wash'].map((b): [string, string] => ['danger', b]),
  ...['accent', 'accent-pressed', 'danger'].map((b): [string, string] => ['accent-fg', b]),
  ...['surface', 'surface-raised'].map((b): [string, string] => ['presence-online', b]),
  // organization-admin.md §5 item 1: the "Sem acesso válido" mark (Admin people list) sits on the table and its rows.
  ...['surface', 'surface-raised', 'warning-wash'].map((b): [string, string] => ['warning', b]),
  // organization-admin.md §2.2 item 4: the text of the only-admin warning on its wash (PLANO-ADMIN §8.8 V7).
  ['text', 'warning-wash'],
  ...AGENT_COLORS.map((c): [string, string] => [`agent.${c}.fg`, `agent.${c}.bg`]),
]

describe('token contrast (ADR-027 addendum: text floor 4.5:1)', () => {
  it('the check is not vacuous: the old light muted on bg fails', () => {
    // greige.600 (#88806F) on greige.200 (#EEEBE3), the light muted before 25/Nov/2026.
    expect(contrast('#88806F', '#EEEBE3')).toBeLessThan(FLOOR)
  })

  for (const [name, theme] of Object.entries(THEMES)) {
    describe(name, () => {
      it.each(PAIRS)('%s on %s is 4.5:1 or more', (fg, bg) => {
        const ratio = contrast(resolve(theme, `color.${fg}`), resolve(theme, `color.${bg}`))
        expect(ratio, `${name}: ${fg} × ${bg} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(FLOOR)
      })
    })
  }
})
