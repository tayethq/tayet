import { describe, it, expect } from 'vitest'
import { join, sep } from 'node:path'
import { scanUiStrings } from './support/ui-strings'

// ADR-080 D4, the code half of the copy gate. The lint (eslint.config.js, COPY_SELECTORS) catches
// copy in JSX; this catches the rest — maps, `return '…'`, templates in plain code — with the parser
// method of the §0 de idioma (support/ui-strings.ts). Any human-shaped string with a word in it —
// pt, en, mixed, or `indef` (letters, no known word: 'Foo bar') — outside src/ui/i18n/ fails.
// Exceptions are constants of the catalog (APP_NAME, GLYPH, KEY_HINT), never an allowlist here; what
// has no word (glyphs, numbers, `${day} ${month}`) passes as neutral.

const CLIENT = join(__dirname, '..')
const UI = join(CLIENT, 'src', 'ui')
const CATALOG = join(UI, 'i18n')

describe('no UI copy literal outside the catalog (ADR-080 D4)', () => {
  it('src/ui outside i18n/ carries no worded string', () => {
    const { files, strings } = scanUiStrings(CLIENT, UI, (p) => p === CATALOG || p.startsWith(CATALOG + sep))
    const copy = strings.filter((s) => s.lang !== 'neutra')
    // Witness: the scan read the whole UI tree (67 files at the §0, catalog excluded), not an empty dir.
    console.info(`[i18n-no-literals] scanned ${files} files, ${strings.length} strings, ${copy.length} copy`)
    expect(files).toBeGreaterThanOrEqual(67)
    expect(copy.map((s) => `${s.file}:${s.line} [${s.lang}] ${s.text}`)).toEqual([])
  })
})
