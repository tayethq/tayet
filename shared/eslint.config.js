// ESLint flat config for @tayet/shared (ADR-088). The shared package is "inside the ACL" in the
// ADR-007 sense: it is the one other place matrix-js-sdk may be imported (src/internal/**), and
// its public entry (src/index.ts) is held to the same barrel-vocabulary rule as client
// src/acl/index.ts. Rules are error-level and non-silenceable, as in the client.
//
// The selector sets below are copies of the client's (client/eslint.config.js): each package lints
// itself and imports nothing from another (cross-import gate in CI), so the copy is deliberate.
// A change to one set is a change to both.
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import importX from 'eslint-plugin-import-x'
import comments from '@eslint-community/eslint-plugin-eslint-comments'
import globals from 'globals'

const BOUNDARY_RULE_IDS = [
  '@typescript-eslint/no-restricted-imports',
  'import-x/no-restricted-paths',
  'no-restricted-syntax',
]

// Leak-pattern heuristic over template literals (same honest limitation as the client's).
const LEAK_SELECTORS = [
  { selector: 'TemplateElement[value.raw=/@\\w+:/]', message: 'Possible mxid leak (@user:server) in a template literal — domain code must not carry protocol identifiers.' },
  { selector: 'TemplateElement[value.raw=/!.+:/]', message: 'Possible room-id leak (!room:server) in a template literal — domain code must not carry protocol identifiers.' },
]

// No re-export of the SDK from any module (reference laundering, ADR-007 guardrail ii).
const NO_SDK_REEXPORT_SELECTORS = [
  { selector: "ExportNamedDeclaration[source.value=/^matrix-js-sdk(\\/|$)/]", message: 'Re-exporting matrix-js-sdk is forbidden — the SDK must not cross the ACL boundary.' },
  { selector: "ExportAllDeclaration[source.value=/^matrix-js-sdk(\\/|$)/]", message: 'Re-exporting matrix-js-sdk is forbidden — the SDK must not cross the ACL boundary.' },
]

// Barrel vocabulary (PR #6 + Fase 2 + C2 extensions): no protocol token in an exported NAME of the
// public entry. Scoped to src/index.ts; src/internal/index.ts is free (it exports e.g.
// encryptedUnreadMentions and is only reachable from client src/acl/internal/**).
const BARREL_VOCAB_DENY = String.raw`homeserver|mxid|federation|powerlevel|power_level|roomid|room_id|eventid|event_id|olm|megolm|crosssigning|cross_signing|secretstorage|secret_storage|recoverykey|recovery_key|devicekey|device_key|4s|ssss|encrypted|escrow`
const BARREL_VOCAB_SELECTORS = [
  {
    selector: `ExportSpecifier[exported.name=/${BARREL_VOCAB_DENY}/i]`,
    message: 'Protocol vocabulary in an exported name is forbidden on the @tayet/shared entry (P1/ADR-007/ADR-088). Protocol terms live only in src/internal/.',
  },
  {
    selector: `ExportNamedDeclaration > VariableDeclaration > VariableDeclarator > Identifier[name=/${BARREL_VOCAB_DENY}/i]`,
    message: 'Protocol vocabulary in an exported name is forbidden on the @tayet/shared entry (P1/ADR-007/ADR-088). Protocol terms live only in src/internal/.',
  },
  // `export * from` / `export type * from` carry no specifier names, so the two selectors above
  // would be inert on them. The clean entry exports by name; every star export is forbidden here
  // (src/internal/index.ts keeps `export *` on purpose: it is outside the vocabulary rule).
  {
    selector: 'ExportAllDeclaration',
    message: 'No `export *` in the @tayet/shared entry (ADR-088 dec. 2): the clean index exports by name so the vocabulary selector can see every exported name.',
  },
]

export default tseslint.config(
  { ignores: ['node_modules/', 'coverage/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.ts', '**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },

  // ── Boundary gate (ADR-007 via ADR-088) ─────────────────────────────────────────────────
  {
    files: ['src/**/*.ts'],
    plugins: { 'import-x': importX, '@eslint-community/eslint-comments': comments },
    settings: { 'import-x/resolver': { typescript: { project: './tsconfig.json' } } },
    rules: {
      // guardrail ii: the SDK and the crypto binding only in src/internal/ (override below).
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['matrix-js-sdk', 'matrix-js-sdk/*'],
              message: 'matrix-js-sdk may only be imported inside src/internal/ (ADR-088 dec. 2). Domain, errors and ACL types stay SDK-free.',
            },
            {
              group: ['@matrix-org/matrix-sdk-crypto-wasm', '@matrix-org/matrix-sdk-crypto-wasm/*'],
              message: '@matrix-org/matrix-sdk-crypto-wasm may only be imported inside src/internal/ (ADR-088 dec. 2).',
            },
          ],
        },
      ],
      // guardrail i: nothing outside src/internal/ reaches into it.
      'import-x/no-restricted-paths': [
        'error',
        {
          zones: [
            {
              target: ['./src/domain', './src/index.ts', './src/errors.ts', './src/acl-types.ts', './src/leak-scan.ts', './src/markdown.ts', './src/href.ts', './src/export'],
              from: './src/internal',
              message: 'src/internal/ is reachable only through @tayet/shared/internal (ADR-088 dec. 2); the domain, the errors, the ACL types, the leak-scan, the markdown parser, the href predicate and the export format never import from it.',
            },
          ],
        },
      ],
      'no-restricted-syntax': ['error', ...NO_SDK_REEXPORT_SELECTORS, ...LEAK_SELECTORS],
      // guardrail iii: non-silenceable.
      '@eslint-community/eslint-comments/no-restricted-disable': ['error', ...BOUNDARY_RULE_IDS, '@eslint-community/eslint-comments/*'],
      '@eslint-community/eslint-comments/no-unlimited-disable': 'error',
    },
  },

  {
    files: ['src/internal/**/*.ts'],
    rules: { '@typescript-eslint/no-restricted-imports': 'off' },
  },

  // REPLACE semantics (as in the client): the SDK-reexport and leak selectors are respread.
  {
    files: ['src/index.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...NO_SDK_REEXPORT_SELECTORS, ...LEAK_SELECTORS, ...BARREL_VOCAB_SELECTORS],
    },
  },
)
