import { describe, it, expect } from 'vitest'
import { ESLint } from 'eslint'

// Negative boundary test (PLANO-FASE-1 §3.2). Proves the ADR-007 gate actually fails the
// build: we lint fixture source *text* against the real eslint.config.js (no fixture files
// touch disk, so the fixtures themselves never trip CI). filePath selects which config
// block applies — `src/domain/*` is outside the ACL, `src/acl/internal/*` is inside it,
// and `src/acl/index.ts` is the barrel (where the vocabulary gate applies).
//
// This is the test that makes the boundary real rather than aspirational. The same gate
// runs in CI with `eslint --max-warnings=0`.

const eslint = new ESLint()

async function ruleIdsFor(code: string, filePath: string): Promise<Array<string | null>> {
  const results = await eslint.lintText(code, { filePath })
  return (results[0]?.messages ?? []).map((m) => m.ruleId)
}

const SDK_VALUE_IMPORT = `import { createClient } from 'matrix-js-sdk'\nexport const x = createClient\n`
const SDK_TYPE_IMPORT = `import type { MatrixClient } from 'matrix-js-sdk'\nexport type X = MatrixClient\n`

describe('ADR-007 boundary gate', () => {
  it('a VALUE import of matrix-js-sdk outside the ACL breaks the build', async () => {
    const ids = await ruleIdsFor(SDK_VALUE_IMPORT, 'src/domain/__fixture__.ts')
    expect(ids).toContain('@typescript-eslint/no-restricted-imports')
  })

  it('a TYPE-ONLY import of matrix-js-sdk outside the ACL breaks the build (the silent vector)', async () => {
    // The base eslint-plugin-import rule does NOT catch `import type`; the @typescript-eslint
    // variant does. This asserts the boundary has no type-only fresta.
    const ids = await ruleIdsFor(SDK_TYPE_IMPORT, 'src/domain/__fixture__.ts')
    expect(ids).toContain('@typescript-eslint/no-restricted-imports')
  })

  it('the SAME SDK import INSIDE acl/internal/ is allowed', async () => {
    const ids = await ruleIdsFor(SDK_VALUE_IMPORT, 'src/acl/internal/__fixture__.ts')
    expect(ids).not.toContain('@typescript-eslint/no-restricted-imports')
  })

  it('re-exporting matrix-js-sdk symbols is forbidden (reference laundering via re-export)', async () => {
    const ids = await ruleIdsFor(`export { createClient } from 'matrix-js-sdk'\n`, 'src/domain/__fixture__.ts')
    expect(ids).toContain('no-restricted-syntax')
  })

  it('deep-importing acl/internal from outside the ACL is forbidden (barrel is the only door)', async () => {
    const ids = await ruleIdsFor(
      `import { MatrixGateway } from '../acl/internal/matrix-client'\nexport const g = MatrixGateway\n`,
      'src/domain/__fixture__.ts',
    )
    expect(ids).toContain('import-x/no-restricted-paths')
  })

  it('a hard-coded protocol id in a template literal is flagged by the leak-pattern', async () => {
    const ids = await ruleIdsFor('export const s = `@alice:server.com`\n', 'src/domain/__fixture__.ts')
    expect(ids).toContain('no-restricted-syntax')
  })

  it('eslint-disable of a boundary rule is itself an error (non-silenceable)', async () => {
    const code = `// eslint-disable-next-line @typescript-eslint/no-restricted-imports\n${SDK_VALUE_IMPORT}`
    const ids = await ruleIdsFor(code, 'src/domain/__fixture__.ts')
    expect(ids).toContain('@eslint-community/eslint-comments/no-restricted-disable')
  })

  it('a bare eslint-disable (disables everything, incl. boundary) is an error', async () => {
    const code = `/* eslint-disable */\n${SDK_VALUE_IMPORT}`
    const ids = await ruleIdsFor(code, 'src/domain/__fixture__.ts')
    expect(ids).toContain('@eslint-community/eslint-comments/no-unlimited-disable')
  })

  it('exporting a protocol-vocabulary NAME from the barrel breaks the build (Leitura B)', async () => {
    // Guards against re-introducing a protocol token as an EXPORTED NAME on the barrel.
    // Note: it catches the exported name (here, the `const`), NOT a protocol-named field
    // inside an exported type — the original AclOptions.homeserverUrl was a field, caught by
    // review, not by this rule (honest limitation documented in eslint.config.js).
    const ids = await ruleIdsFor(`export const homeserverUrl = ''\n`, 'src/acl/index.ts')
    expect(ids).toContain('no-restricted-syntax')
  })

  it('a neutral exported name on the barrel is allowed (no false-positive on product vocab)', async () => {
    // serverUrl / messageId / channelId are the neutral terms the barrel legitimately uses;
    // the conservative deny-list must not trip on them.
    const ids = await ruleIdsFor(`export const serverUrl = ''\n`, 'src/acl/index.ts')
    expect(ids).not.toContain('no-restricted-syntax')
  })

  // ADR-088 dec. 3: the shared package is inside the ACL. Above it, only the barrel.
  it('importing @tayet/shared from src/ui breaks the build (the barrel is the only door)', async () => {
    const ids = await ruleIdsFor(`import { ConnectionError } from '@tayet/shared'\nexport const c = ConnectionError\n`, 'src/ui/__fixture__.ts')
    expect(ids).toContain('@typescript-eslint/no-restricted-imports')
  })

  it('importing @tayet/shared/internal from src/ui breaks the build', async () => {
    const ids = await ruleIdsFor(`import { roomToChannel } from '@tayet/shared/internal'\nexport const r = roomToChannel\n`, 'src/ui/__fixture__.ts')
    expect(ids).toContain('@typescript-eslint/no-restricted-imports')
  })

  it('a type-only import of @tayet/shared from src/ui breaks the build too', async () => {
    const ids = await ruleIdsFor(`import type { Message } from '@tayet/shared'\nexport type M = Message\n`, 'src/ui/__fixture__.ts')
    expect(ids).toContain('@typescript-eslint/no-restricted-imports')
  })

  it('importing @tayet/shared/internal from src/acl outside internal/ breaks the build', async () => {
    const ids = await ruleIdsFor(`import { roomToChannel } from '@tayet/shared/internal'\nexport const r = roomToChannel\n`, 'src/acl/__fixture__.ts')
    expect(ids).toContain('@typescript-eslint/no-restricted-imports')
  })

  it('src/acl outside internal/ still bans matrix-js-sdk (the acl block restates the SDK patterns)', async () => {
    const ids = await ruleIdsFor(SDK_VALUE_IMPORT, 'src/acl/__fixture__.ts')
    expect(ids).toContain('@typescript-eslint/no-restricted-imports')
  })

  it('@tayet/shared is allowed in src/acl (the barrel re-exports from it)', async () => {
    const ids = await ruleIdsFor(`import type { Message } from '@tayet/shared'\nexport type M = Message\n`, 'src/acl/__fixture__.ts')
    expect(ids).not.toContain('@typescript-eslint/no-restricted-imports')
  })

  it('@tayet/shared/internal is allowed in src/acl/internal', async () => {
    const ids = await ruleIdsFor(`import { roomToChannel } from '@tayet/shared/internal'\nexport const r = roomToChannel\n`, 'src/acl/internal/__fixture__.ts')
    expect(ids).not.toContain('@typescript-eslint/no-restricted-imports')
  })

  it('eslint-disable of the shared-package rule is itself an error (non-silenceable)', async () => {
    const code = `// eslint-disable-next-line @typescript-eslint/no-restricted-imports\nimport { roomToChannel } from '@tayet/shared/internal'\nexport const r = roomToChannel\n`
    const ids = await ruleIdsFor(code, 'src/ui/__fixture__.ts')
    expect(ids).toContain('@eslint-community/eslint-comments/no-restricted-disable')
  })

  it('the barrel still bans SDK re-export (vocab block did not drop the laundering guard)', async () => {
    // Guards against the flat-config footgun: redefining no-restricted-syntax for index.ts
    // must keep the re-export selectors, not just the vocab ones.
    const ids = await ruleIdsFor(`export { createClient } from 'matrix-js-sdk'\n`, 'src/acl/index.ts')
    expect(ids).toContain('no-restricted-syntax')
  })

  // ADR-096 (PLANO-EXPORT-DADOS §0.3.5): the export's names on the barrel pass the vocabulary gate, and a
  // protocol-flavoured name for the same thing would not.
  it('the data export names pass the barrel vocabulary gate', async () => {
    const code = `export type { DataExportOptions, DataExportPart } from './types'\n`
    expect(await ruleIdsFor(code, 'src/acl/index.ts')).toEqual([])
  })

  it('a protocol-flavoured export name for the same part breaks the build', async () => {
    // The barrel exports types through specifiers, which the gate matches (eslint.config.js limitation 2).
    const ids = await ruleIdsFor(`export type { DataExportPart as DataExportEventIdPart } from './types'\n`, 'src/acl/index.ts')
    expect(ids).toContain('no-restricted-syntax')
  })

  it('the export engine stays inside the ACL: deep-importing it from the UI is forbidden', async () => {
    const ids = await ruleIdsFor(
      `import { runDataExport } from '../acl/internal/data-export'\nexport const r = runDataExport\n`,
      'src/ui/__fixture__.ts',
    )
    expect(ids).toContain('import-x/no-restricted-paths')
  })
})
// ADR-060 D4: the browser E2E tier imports only test/support. Same lintText technique, with the
// fixture path under e2e/ so the e2e block of eslint.config.js applies.
describe('ADR-060 e2e admission gate', () => {
  const E2E = 'e2e/__fixture__.ts'

  it('importing product code from src/ breaks the build', async () => {
    const ids = await ruleIdsFor(`import { Boot } from '../src/ui/components/Boot'\nexport const b = Boot\n`, E2E)
    expect(ids).toContain('@typescript-eslint/no-restricted-imports')
  })

  it('importing the barrel through the @tayet/client alias breaks the build', async () => {
    const ids = await ruleIdsFor(`import { createAcl } from '@tayet/client'\nexport const c = createAcl\n`, E2E)
    expect(ids).toContain('@typescript-eslint/no-restricted-imports')
  })

  it('importing matrix-js-sdk breaks the build', async () => {
    const ids = await ruleIdsFor(SDK_VALUE_IMPORT, E2E)
    expect(ids).toContain('@typescript-eslint/no-restricted-imports')
  })

  it('importing test/support is allowed', async () => {
    const ids = await ruleIdsFor(
      `import { HS_URL } from '../test/support/stack-env'\nexport const h = HS_URL\n`,
      E2E,
    )
    expect(ids).not.toContain('@typescript-eslint/no-restricted-imports')
  })

  // ADR-088 dec. 3: from the shared package, e2e/ takes only the leak-scan.
  it('importing @tayet/shared/leak-scan is allowed', async () => {
    const ids = await ruleIdsFor(
      `import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'\nexport const f = findProtocolLeaksInText\n`,
      E2E,
    )
    expect(ids).not.toContain('@typescript-eslint/no-restricted-imports')
  })

  it('importing @tayet/shared (domain, errors) breaks the build', async () => {
    const ids = await ruleIdsFor(`import { ConnectionError } from '@tayet/shared'\nexport const c = ConnectionError\n`, E2E)
    expect(ids).toContain('@typescript-eslint/no-restricted-imports')
  })

  it('importing @tayet/shared/internal (translator) breaks the build', async () => {
    const ids = await ruleIdsFor(`import { roomToChannel } from '@tayet/shared/internal'\nexport const r = roomToChannel\n`, E2E)
    expect(ids).toContain('@typescript-eslint/no-restricted-imports')
  })

  it('eslint-disable of the e2e import rule is itself an error (non-silenceable)', async () => {
    const code = `// eslint-disable-next-line @typescript-eslint/no-restricted-imports\n${SDK_VALUE_IMPORT}`
    const ids = await ruleIdsFor(code, E2E)
    expect(ids).toContain('@eslint-community/eslint-comments/no-restricted-disable')
  })
})
