import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { ESLint } from 'eslint'

// Negative boundary test for @tayet/shared (ADR-088 dec. 2), same technique as
// client/test/boundary.test.ts: fixture source TEXT linted against the real eslint.config.js, with
// filePath selecting the config block. No fixture touches disk.

const eslint = new ESLint({ cwd: new URL('..', import.meta.url).pathname })

async function messagesFor(code: string, filePath: string) {
  const results = await eslint.lintText(code, { filePath })
  return results[0]?.messages ?? []
}

const INDEX = 'src/index.ts'

describe('ADR-088 clean-index vocabulary gate', () => {
  it('a star export in the clean index breaks the build (it would blind the vocabulary selector)', async () => {
    const msgs = await messagesFor(`export type * from './domain'\n`, INDEX)
    expect(msgs.map((m) => m.ruleId)).toContain('no-restricted-syntax')
    expect(msgs.some((m) => m.message.includes('No `export *`'))).toBe(true)
  })

  it('a protocol-vocabulary name exported by name from the clean index breaks the build', async () => {
    const msgs = await messagesFor(`export type { HomeserverInfo } from './domain'\n`, INDEX)
    expect(msgs.map((m) => m.ruleId)).toContain('no-restricted-syntax')
    expect(msgs.some((m) => m.message.includes('Protocol vocabulary'))).toBe(true)
  })

  it('the real clean index lints with zero messages', async () => {
    const real = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    expect(await messagesFor(real, INDEX)).toEqual([])
  })

  it('eslint-disable of the selector in the clean index is itself an error (non-silenceable)', async () => {
    const msgs = await messagesFor(`// eslint-disable-next-line no-restricted-syntax\nexport type * from './domain'\n`, INDEX)
    expect(msgs.map((m) => m.ruleId)).toContain('@eslint-community/eslint-comments/no-restricted-disable')
  })

  it('src/internal/index.ts keeps `export *` (outside the vocabulary rule on purpose)', async () => {
    const msgs = await messagesFor(`export * from './translate'\n`, 'src/internal/index.ts')
    expect(msgs.map((m) => m.ruleId)).not.toContain('no-restricted-syntax')
  })
})

// ADR-088 addendum 2026-11-09: the markdown parser and the href predicate are clean-side (entry `.`);
// the zone that forbids reaching into src/internal covers them. The opposite direction (internal →
// ../href) is allowed: internal already imports ../domain.
describe('ADR-088 internal zone — markdown.ts and href.ts', () => {
  for (const file of ['src/markdown.ts', 'src/href.ts']) {
    it(`${file} importing from src/internal breaks the build`, async () => {
      const msgs = await messagesFor(`import { htmlToRichDoc } from './internal/rich-text'\nexport const x = htmlToRichDoc\n`, file)
      expect(msgs.map((m) => m.ruleId)).toContain('import-x/no-restricted-paths')
    })
  }

  it('the real markdown.ts and href.ts lint with zero messages', async () => {
    for (const file of ['src/markdown.ts', 'src/href.ts']) {
      const real = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
      expect(await messagesFor(real, file), file).toEqual([])
    }
  })

  it('internal importing ../href is allowed', async () => {
    const msgs = await messagesFor(`import { safeHref } from '../href'\nexport const y = safeHref\n`, 'src/internal/rich-text.ts')
    expect(msgs.map((m) => m.ruleId)).not.toContain('import-x/no-restricted-paths')
  })
})

// ADR-096 (Proposto) dec. 2: the export format is clean-side (entry `.`), in the same zone.
describe('ADR-088 internal zone — src/export', () => {
  it('src/export importing from src/internal breaks the build', async () => {
    const msgs = await messagesFor(`import { htmlToRichDoc } from '../internal/rich-text'\nexport const x = htmlToRichDoc\n`, 'src/export/builder.ts')
    expect(msgs.map((m) => m.ruleId)).toContain('import-x/no-restricted-paths')
  })

  it('src/export importing matrix-js-sdk breaks the build', async () => {
    const msgs = await messagesFor(`import { EventType } from 'matrix-js-sdk'\nexport const x = EventType\n`, 'src/export/types.ts')
    expect(msgs.map((m) => m.ruleId)).toContain('@typescript-eslint/no-restricted-imports')
  })

  it('the real src/export files lint with zero messages', async () => {
    for (const file of ['src/export/index.ts', 'src/export/types.ts', 'src/export/builder.ts', 'src/export/reader.ts', 'src/export/file-name.ts', 'src/export/errors.ts']) {
      const real = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
      expect(await messagesFor(real, file), file).toEqual([])
    }
  })
})
