import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Repo shape of the brand icon. Every surface serves byte-for-byte copies of one source; the tags
// that point at them are in each page's head. The parts that read design/ or site/ skip in a tree
// without them (the public source has neither).

const REPO = join(__dirname, '..', '..')
const CLIENT_PUBLIC = join(REPO, 'client', 'public')
const BRAND_PUBLIC = join(REPO, 'design', 'brand', 'icon', 'public')
const SITE = join(REPO, 'site')
const ICONS = ['favicon.ico', 'icon.svg', 'apple-touch-icon.png'] as const

const read = (p: string) => readFileSync(p)
const text = (p: string) => readFileSync(p, 'utf8')

// The value of a custom property in the first `:root { … }` block, following var() to the end.
function resolveRootVar(css: string, name: string): string {
  const root = /:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? ''
  const decls = new Map([...root.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2]!.trim()]))
  let value = decls.get(name)
  for (let hops = 0; value !== undefined && hops < 10; hops++) {
    const ref = /^var\(--([a-z0-9-]+)\)$/.exec(value)
    if (ref === null) return value
    value = decls.get(ref[1]!)
  }
  throw new Error(`--${name} does not resolve in :root`)
}

describe('brand icon: client', () => {
  const html = text(join(REPO, 'client', 'index.html'))

  it('index.html links the three icons, with no theme-color or manifest in the markup', () => {
    expect(html).toContain('<link rel="icon" href="/favicon.ico" sizes="48x48" />')
    expect(html).toContain('<link rel="icon" href="/icon.svg" type="image/svg+xml" />')
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />')
    expect(html).not.toContain('theme-color')
    expect(html).not.toContain('rel="manifest"')
  })

  it('client/public has the three icons', () => {
    for (const f of ICONS) expect(existsSync(join(CLIENT_PUBLIC, f)), f).toBe(true)
  })

  it.skipIf(!existsSync(BRAND_PUBLIC))('client/public icons are byte-for-byte the brand source', () => {
    for (const f of ICONS) expect(read(join(CLIENT_PUBLIC, f)).equals(read(join(BRAND_PUBLIC, f))), f).toBe(true)
  })
})

describe.skipIf(!existsSync(SITE))('brand icon: site', () => {
  it('site root has the three icons, byte-for-byte the client ones', () => {
    for (const f of ICONS) expect(read(join(SITE, f)).equals(read(join(CLIENT_PUBLIC, f))), f).toBe(true)
  })

  it('every page links the three icons and sets theme-color to the light --color-bg', () => {
    const bg = resolveRootVar(text(join(SITE, 'assets', 'tokens.css')), 'color-bg')
    expect(bg).toMatch(/^#[0-9A-Fa-f]{6}$/)
    const pages = readdirSync(SITE).filter((f) => f.endsWith('.html'))
    expect(pages.length).toBeGreaterThan(0)
    for (const page of pages) {
      const head = text(join(SITE, page)).split('</head>')[0] ?? ''
      expect(head, page).toContain('<link rel="icon" href="/favicon.ico" sizes="48x48">')
      expect(head, page).toContain('<link rel="icon" href="/icon.svg" type="image/svg+xml">')
      expect(head, page).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png">')
      expect(head, page).toContain(`<meta name="theme-color" content="${bg}">`)
      expect(head.match(/name="theme-color"/g), page).toHaveLength(1)
    }
  })
})
