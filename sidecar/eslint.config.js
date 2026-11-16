// Lint of the sidecar package — type-aware, molded on the custody agent's. The core (src/** outside
// src/api/) is "inside the ACL": the SDK is free there. The border is the local API (S-c1, PLANO-AGENTES
// §0.3.6 adj. 12), held by two rules that inline comments cannot silence (noInlineConfig):
//   - src/api/** imports neither matrix-js-sdk (nor the crypto wasm) nor @tayet/shared/internal: it sees
//     the core's read facade, which hands out opaque tokens;
//   - src/api/contract.ts carries no protocol word in a property, an exported name or a literal type;
//     src/api/slack/contract.ts neither, minus the closed allowlist SLACK_VOCAB_ALLOW (§0.3.12 item 2);
//     src/api/mcp/contract.ts is under the whole list, no allowlist (§0.3.13; the MCP envelope's names
//     are the SDK's and stay outside the lint).
// The stdio bridge (src/mcp/**, S-g2, §0.3.13 item 7) never opens the store (ADR-087 dec. 5(c)) and loads
// nothing of the daemon: no SDK, no crypto wasm, no classic-level/node-indexeddb, no core, no store, no boot,
// no daemon logger (fd 1 is the protocol's). Its runtime proof is test/unit/mcp-bridge.test.ts.
// Cross-package imports are the CI grep gate (ADR-088 dec. 6). Negative tests: test/unit/lint-boundary.test.ts.
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'
import { CONTRACT_VOCAB_DENY, SLACK_VOCAB_DENY } from './contract-vocabulary.mjs'

const deny = `/${CONTRACT_VOCAB_DENY}/i`
const VOCAB = 'Protocol vocabulary in the local API contract is forbidden (P1, ADR-087 dec. 4, PLANO-AGENTES §0.3.6). Use a product word.'

export const API_IMPORT_PATTERNS = [
  { group: ['matrix-js-sdk', 'matrix-js-sdk/*'], message: 'The local API (src/api/**) never imports the SDK: it uses the core facade (core/read.ts).' },
  { group: ['@matrix-org/*'], message: 'The local API (src/api/**) never imports the crypto wasm.' },
  { group: ['@tayet/shared/internal', '@tayet/shared/internal/*'], message: 'The local API (src/api/**) never imports the shared translator: it uses the core facade (core/read.ts).' },
]

export const BRIDGE_IMPORT_PATTERNS = [
  ...API_IMPORT_PATTERNS.map((p) => ({ ...p, message: p.message.replace('The local API (src/api/**)', 'The stdio bridge (src/mcp/**)') })),
  { group: ['classic-level', 'node-indexeddb', 'node-indexeddb/*'], message: 'The stdio bridge (src/mcp/**) never opens the store (ADR-087 dec. 5(c)).' },
  {
    group: ['../core/*', '../core/**', '../store', '../boot', '../log', '../process-guard', '../api/start', '../api/server'],
    message: 'The stdio bridge (src/mcp/**) loads nothing of the daemon: it talks to its /mcp over HTTP (PLANO-AGENTES §0.3.13 item 7).',
  },
]

// The selectors of a vocabulary rule, for one deny pattern (`/…/i`, an esquery regex).
const vocabSelectors = (pattern) => [
  { selector: `TSPropertySignature > Identifier.key[name=${pattern}]`, message: VOCAB },
  { selector: `TSPropertySignature > Literal.key[value=${pattern}]`, message: VOCAB },
  { selector: `ExportNamedDeclaration > TSInterfaceDeclaration > Identifier.id[name=${pattern}]`, message: VOCAB },
  { selector: `ExportNamedDeclaration > TSTypeAliasDeclaration > Identifier.id[name=${pattern}]`, message: VOCAB },
  { selector: `ExportNamedDeclaration > VariableDeclaration > VariableDeclarator > Identifier[name=${pattern}]`, message: VOCAB },
  { selector: `ExportSpecifier[exported.name=${pattern}]`, message: VOCAB },
  { selector: `TSLiteralType > Literal[value=${pattern}]`, message: VOCAB },
]

export const CONTRACT_VOCAB_SELECTORS = vocabSelectors(deny)
// The Slack layer's contract (PLANO-AGENTES §0.3.12 item 2): the same list minus the closed allowlist.
export const SLACK_CONTRACT_VOCAB_SELECTORS = vocabSelectors(`/${SLACK_VOCAB_DENY}/i`)

export default tseslint.config(
  { ignores: ['node_modules', 'dist', '.smoke'] },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    files: ['src/api/**/*.ts'],
    linterOptions: { noInlineConfig: true },
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', { patterns: API_IMPORT_PATTERNS }],
    },
  },
  {
    files: ['src/mcp/**/*.ts'],
    linterOptions: { noInlineConfig: true },
    rules: {
      '@typescript-eslint/no-restricted-imports': ['error', { patterns: BRIDGE_IMPORT_PATTERNS }],
    },
  },
  {
    files: ['src/api/contract.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...CONTRACT_VOCAB_SELECTORS],
    },
  },
  {
    // The MCP tools' contract (S-g1, PLANO-AGENTES §0.3.13): the native list, whole.
    files: ['src/api/mcp/contract.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...CONTRACT_VOCAB_SELECTORS],
    },
  },
  {
    files: ['src/api/slack/contract.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...SLACK_CONTRACT_VOCAB_SELECTORS],
    },
  },
  {
    files: ['eslint.config.js', 'build.mjs', 'contract-vocabulary.mjs', 'scripts/gen-emoji.mjs', 'test/support/count-hook.mjs', 'test/support/bolt-agent.mjs', 'test/support/bolt-http-agent.mjs', 'test/support/no-execve.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },
)
