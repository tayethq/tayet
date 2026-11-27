import { beforeAll, describe, it, expect } from 'vitest'
import { ESLint } from 'eslint'

// Negative test of the JSX half of the copy gate (ADR-080 D4), in the molde of boundary.test.ts:
// fixture source TEXT linted against the real eslint.config.js (nothing touches disk). The copy
// block redefines no-restricted-syntax for src/ui/**, so it also asserts the respread: the leak and
// C6 hex selectors still fire there.

const eslint = new ESLint()

async function copyHits(code: string, filePath: string): Promise<{ copy: number; other: string[] }> {
  const [result] = await eslint.lintText(code, { filePath })
  const messages = result?.messages ?? []
  const copy = messages.filter((m) => m.ruleId === 'no-restricted-syntax' && m.message.includes('ADR-080'))
  const other = messages.filter((m) => !copy.includes(m)).map((m) => m.message)
  return { copy: copy.length, other }
}

const UI = 'src/ui/components/__fixture__.tsx'
const CATALOG = 'src/ui/i18n/__fixture__.tsx'

// Warm-up (issue #7, as in shared/test/boundary.test.ts): the first lintText of the process loads
// ESLint, the config and its plugins (0.6 s alone, 2.2 s under load). Paid here, under its own
// deadline, on the first test's filePath, not inside the 5 s deadline of the first test; no assertion
// depends on it.
beforeAll(async () => {
  await eslint.lintText('export {}\n', { filePath: UI })
}, 60_000)

describe('copy gate — JSX (ADR-080 D4)', () => {
  it.each([
    ['text', 'export const A = () => <p>Olá mundo</p>\n'],
    ['copy attribute', 'export const A = () => <button aria-label="Fechar" />\n'],
    ['template in a copy attribute', 'export const A = ({ n }: { n: string }) => <button title={`Ver ${n}`} />\n'],
    ['conditional child', "export const A = ({ b }: { b: boolean }) => <p>{b ? 'Sim' : 'Não'}</p>\n"],
  ])('%s literal in src/ui fails', async (_, code) => {
    expect((await copyHits(code, UI)).copy).toBeGreaterThan(0)
  })

  it('the same literal inside src/ui/i18n passes', async () => {
    expect((await copyHits('export const A = () => <p>Olá mundo</p>\n', CATALOG)).copy).toBe(0)
  })

  it('glyphs and non-copy attributes pass', async () => {
    const code = "export const A = ({ b }: { b: boolean }) => <p className={b ? 'a b' : 'c'}>× · … {'#'}</p>\n"
    expect(await copyHits(code, UI)).toEqual({ copy: 0, other: [] })
  })

  it('the respread keeps the leak and hex selectors on src/ui', async () => {
    const { other } = await copyHits("export const A = () => <p style={{ color: '#ff0000' }}>{`@bob:server`}</p>\n", UI)
    expect(other.some((m) => m.includes('C6'))).toBe(true)
    expect(other.some((m) => m.includes('mxid'))).toBe(true)
  })
})
