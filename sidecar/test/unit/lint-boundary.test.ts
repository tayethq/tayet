import { describe, it, expect } from 'vitest'
import { ESLint } from 'eslint'
import tseslint from 'typescript-eslint'
import { CONTRACT_VOCAB_DENY, SLACK_VOCAB_ALLOW } from '../../contract-vocabulary.mjs'

// Negative tests of the local API's lint border (eslint.config.js, §0.3.6 adj. 12): fixture TEXT linted
// against the real config (nothing on disk). Type-aware rules are switched off for the virtual files
// (they are not in the TS project); the border rules are not type-aware.
const eslint = new ESLint({ overrideConfig: [tseslint.configs.disableTypeChecked] })

async function ruleIds(code: string, filePath: string): Promise<Array<string | null>> {
  const results = await eslint.lintText(code, { filePath })
  return (results[0]?.messages ?? []).map((m) => m.ruleId)
}

describe('src/api/** imports', () => {
  it.each([
    `import { createClient } from 'matrix-js-sdk'\nexport const x = createClient\n`,
    `import type { MatrixClient } from 'matrix-js-sdk'\nexport type X = MatrixClient\n`,
    `import { EventType } from 'matrix-js-sdk/lib/@types/event.js'\nexport const x = EventType\n`,
    `import { eventToMessage } from '@tayet/shared/internal'\nexport const x = eventToMessage\n`,
    `import { Attachment } from '@matrix-org/matrix-sdk-crypto-wasm'\nexport const x = Attachment\n`,
  ])('forbidden in src/api: %s', async (code) => {
    expect(await ruleIds(code, 'src/api/__fixture__.ts')).toContain('@typescript-eslint/no-restricted-imports')
  })

  it('the same import is free in the core', async () => {
    expect(await ruleIds(`import { createClient } from 'matrix-js-sdk'\nexport const x = createClient\n`, 'src/core/__fixture__.ts')).not.toContain(
      '@typescript-eslint/no-restricted-imports',
    )
  })

  it('the leak-scan and the core facade stay allowed in src/api', async () => {
    const code = `import { scanEdge } from './edge'\nimport { findProtocolLeaks } from '@tayet/shared/leak-scan'\nimport type { ReadFacade } from '../core/read'\nexport const x = [scanEdge, findProtocolLeaks]\nexport type F = ReadFacade\n`
    expect(await ruleIds(code, 'src/api/__fixture__.ts')).not.toContain('@typescript-eslint/no-restricted-imports')
  })

  it('an inline disable does not silence it (noInlineConfig)', async () => {
    const code = `// eslint-disable-next-line @typescript-eslint/no-restricted-imports\nimport { createClient } from 'matrix-js-sdk'\nexport const x = createClient\n`
    expect(await ruleIds(code, 'src/api/__fixture__.ts')).toContain('@typescript-eslint/no-restricted-imports')
  })
})

describe('src/api/contract.ts vocabulary', () => {
  it.each([
    ['a property', `export interface ApiX { roomId: string }\n`],
    ['a quoted property', `export interface ApiX { 'event_id': string }\n`],
    ['an exported interface', `export interface ApiMxid { id: string }\n`],
    ['an exported type', `export type HomeserverInfo = { url: string }\n`],
    ['an exported const', `export const encryptedKinds = 1\n`],
    ['a literal type', `export type K = 'public' | 'encrypted'\n`],
    ['an export specifier', `type A = string\nexport type { A as EscrowA }\n`],
  ])('%s with a protocol word is flagged', async (_what, code) => {
    expect(await ruleIds(code, 'src/api/contract.ts')).toContain('no-restricted-syntax')
  })

  it('product words pass; the rule is scoped to contract.ts', async () => {
    expect(await ruleIds(`export interface ApiX { conversation: string; author: string }\nexport type K = 'public' | 'dm'\n`, 'src/api/contract.ts')).not.toContain(
      'no-restricted-syntax',
    )
    expect(await ruleIds(`export interface X { roomId: string }\n`, 'src/core/__fixture__.ts')).not.toContain('no-restricted-syntax')
  })

  it('an inline disable does not silence it', async () => {
    const code = `// eslint-disable-next-line no-restricted-syntax\nexport interface ApiX { roomId: string }\n`
    expect(await ruleIds(code, 'src/api/contract.ts')).toContain('no-restricted-syntax')
  })

  it('the deny list is the barrel list', () => {
    expect(new RegExp(CONTRACT_VOCAB_DENY, 'i').test('homeserverUrl')).toBe(true)
    expect(new RegExp(CONTRACT_VOCAB_DENY, 'i').test('conversation')).toBe(false)
  })
})

// PLANO-AGENTES §0.3.12 item 2: the Slack layer's contract is denied the same list minus a closed
// allowlist (only `event_id`), and only under src/api/slack/**.
describe('src/api/slack/contract.ts vocabulary (allowlist)', () => {
  it('the allowlist is closed: only event_id', () => {
    expect(SLACK_VOCAB_ALLOW).toEqual(['event_id'])
  })

  it('event_id passes in the Slack contract', async () => {
    expect(await ruleIds(`export interface SlackEnvelope { event_id: string; 'event_id'?: string }\n`, 'src/api/slack/contract.ts')).not.toContain('no-restricted-syntax')
  })

  it.each([
    ['another denied word', `export interface SlackX { room_id: string }\n`],
    ['a longer name around the allowed one', `export interface SlackX { event_ids: string[] }\n`],
    ['the camel form', `export interface SlackX { eventId: string }\n`],
    ['an exported name', `export type SlackMxid = string\n`],
    ['a literal type', `export type K = 'event_id' | 'encrypted'\n`],
  ])('%s is still flagged in the Slack contract', async (_what, code) => {
    expect(await ruleIds(code, 'src/api/slack/contract.ts')).toContain('no-restricted-syntax')
  })

  it('outside src/api/slack/** the allowlist does not apply: event_id in the native contract is flagged', async () => {
    expect(await ruleIds(`export interface ApiX { event_id: string }\n`, 'src/api/contract.ts')).toContain('no-restricted-syntax')
  })

  it('the Slack layer is under the src/api/** import border', async () => {
    const code = `import { eventToMessage } from '@tayet/shared/internal'\nexport const x = eventToMessage\n`
    expect(await ruleIds(code, 'src/api/slack/__fixture__.ts')).toContain('@typescript-eslint/no-restricted-imports')
  })
})

// PLANO-AGENTES §0.3.13: the MCP layer is under the src/api/** import border, and its contract under the
// whole deny list (no allowlist: `last_event_id` would be flagged, hence the tools' `after`/`cursor`).
describe('src/api/mcp/** (S-g1)', () => {
  it.each([
    `import { createClient } from 'matrix-js-sdk'\nexport const x = createClient\n`,
    `import type { MatrixClient } from 'matrix-js-sdk'\nexport type X = MatrixClient\n`,
    `import { eventToMessage } from '@tayet/shared/internal'\nexport const x = eventToMessage\n`,
    `import { eventToMessage } from '@tayet/shared/internal/translate'\nexport const x = eventToMessage\n`,
  ])('forbidden in src/api/mcp: %s', async (code) => {
    expect(await ruleIds(code, 'src/api/mcp/__fixture__.ts')).toContain('@typescript-eslint/no-restricted-imports')
  })

  it('the MCP server SDK, zod and the leak-scan stay allowed', async () => {
    const code = `import { McpServer } from '@modelcontextprotocol/server'\nimport { z } from 'zod'\nimport { findProtocolLeaks } from '@tayet/shared/leak-scan'\nexport const x = [McpServer, z, findProtocolLeaks]\n`
    expect(await ruleIds(code, 'src/api/mcp/__fixture__.ts')).not.toContain('@typescript-eslint/no-restricted-imports')
  })

  it.each([
    ['last_event_id (no allowlist here)', `export interface McpWaitArgs { last_event_id?: string }\n`],
    ['event_id', `export interface McpX { event_id: string }\n`],
    ['a camel property', `export interface McpX { roomId: string }\n`],
    ['an exported name', `export type McpHomeserver = string\n`],
    ['a literal type', `export type K = 'mention' | 'encrypted'\n`],
  ])('%s is flagged in the MCP contract', async (_what, code) => {
    expect(await ruleIds(code, 'src/api/mcp/contract.ts')).toContain('no-restricted-syntax')
  })

  it('product words pass in the MCP contract', async () => {
    expect(await ruleIds(`export interface McpWaitArgs { timeout_s?: number; after?: string }\nexport type K = 'mention'\n`, 'src/api/mcp/contract.ts')).not.toContain(
      'no-restricted-syntax',
    )
  })
})

describe('src/mcp/** — the stdio bridge (S-g2)', () => {
  it.each([
    `import { createClient } from 'matrix-js-sdk'\nexport const x = createClient\n`,
    `import { ClassicLevel } from 'classic-level'\nexport const x = ClassicLevel\n`,
    `import 'node-indexeddb/auto'\n`,
    `import { FILES } from '../store'\nexport const x = FILES\n`,
    `import { main } from '../boot'\nexport const x = main\n`,
    `import { log } from '../log'\nexport const x = log\n`,
    `import type { ReadFacade } from '../core/read'\nexport type F = ReadFacade\n`,
    `import { startLocalApi } from '../api/start'\nexport const x = startLocalApi\n`,
  ])('forbidden in src/mcp: %s', async (code) => {
    expect(await ruleIds(code, 'src/mcp/__fixture__.ts')).toContain('@typescript-eslint/no-restricted-imports')
  })

  it('the MCP SDKs, the args, the exit codes and the MCP contract stay allowed', async () => {
    const code = `import { Client } from '@modelcontextprotocol/client'\nimport { Server } from '@modelcontextprotocol/server'\nimport { parseListen } from '../args'\nimport { EXIT } from '../exit-codes'\nimport { WAIT_MAX_S } from '../api/mcp/contract'\nexport const x = [Client, Server, parseListen, EXIT, WAIT_MAX_S]\n`
    expect(await ruleIds(code, 'src/mcp/__fixture__.ts')).not.toContain('@typescript-eslint/no-restricted-imports')
  })

  it('an inline disable does not silence it (noInlineConfig)', async () => {
    const code = `// eslint-disable-next-line @typescript-eslint/no-restricted-imports\nimport { ClassicLevel } from 'classic-level'\nexport const x = ClassicLevel\n`
    expect(await ruleIds(code, 'src/mcp/__fixture__.ts')).toContain('@typescript-eslint/no-restricted-imports')
  })
})
