import { describe, it, expect } from 'vitest'
import stylelint from 'stylelint'
import { fileURLToPath } from 'node:url'

// Negative CSS-gate test (PLANO-GATES §2.3, espelhando test/boundary.test.ts). Proves the
// rhythm gate (ADR-033 dec. 3, ativado) and the mechanized C6 (dec. 2) actually fail the
// build: fixture source *text* is linted against the real stylelint.config.mjs — no fixture
// files touch disk, so the fixtures themselves never trip CI. The same gate runs in CI as
// `npm run lint:css`.

const configFile = fileURLToPath(new URL('../../stylelint.config.mjs', import.meta.url))

async function warningsFor(code: string): Promise<Array<{ rule: string; text: string }>> {
  const { results } = await stylelint.lint({
    code,
    codeFilename: 'src/ui/__fixture__.css',
    configFile,
  })
  const result = results[0]
  if (!result) throw new Error('stylelint returned no result for the fixture')
  return result.warnings.map((w) => ({ rule: w.rule ?? '', text: w.text }))
}

describe('rhythm/C6 CSS gate (ADR-033 via PLANO-GATES §2)', () => {
  it('raw px ≥ 4 on a rhythm property breaks the build', async () => {
    const warnings = await warningsFor('.x { gap: 8px; }\n')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.rule).toBe('declaration-property-value-disallowed-list')
  })

  it('uppercase property does not escape the gate', async () => {
    const warnings = await warningsFor('.x { PADDING: 9px; }\n')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.rule).toBe('declaration-property-value-disallowed-list')
  })

  it('uppercase unit does not escape the gate', async () => {
    const warnings = await warningsFor('.x { padding: 9PX; }\n')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.rule).toBe('declaration-property-value-disallowed-list')
  })

  it('raw hex breaks the build (C6, color-no-hex)', async () => {
    const warnings = await warningsFor('.x { color: #ff0000; }\n')
    expect(warnings.map((w) => w.rule)).toContain('color-no-hex')
  })

  it('a disable WITHOUT a description is itself reported (non-silenceability)', async () => {
    const warnings = await warningsFor(
      '.x {\n  /* stylelint-disable-next-line declaration-property-value-disallowed-list */\n  gap: 8px;\n}\n',
    )
    expect(warnings.map((w) => w.rule)).toContain('--report-descriptionless-disables')
  })

  it('clean fixture passes: tokens, raw-px geometry, and sub-4 rhythm', async () => {
    // width é geometria (fora do gate por construção); gap 2px é a classe sub-4
    // (constante de composição, fork 3 camada ii) — juntas provam a discriminação
    // por propriedade E o threshold.
    const warnings = await warningsFor(
      '.x {\n  padding: var(--space-sm);\n  font-size: var(--font-size-meta);\n  width: 9px;\n  gap: 2px;\n  PADDING: 2px;\n}\n',
    )
    expect(warnings).toHaveLength(0)
  })
})
