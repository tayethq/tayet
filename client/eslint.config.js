// ESLint flat config (ESLint 10 — eslintrc removed; flat config is the only format).
// Versions pinned in package.json; rule APIs follow the official docs of those pinned
// majors (tool-drift guard, PLANO-FASE-1 §3.1). Notable pin: eslint-plugin-import-x (the
// flat-config-native fork) instead of eslint-plugin-import, which does not declare an
// ESLint 10 peer (would fail to install).
//
// The ADR-007 boundary is enforced here, error-level and non-silenceable. The negative
// test in test/boundary.test.ts proves the gate actually fails the build.
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import importX from 'eslint-plugin-import-x'
import comments from '@eslint-community/eslint-plugin-eslint-comments'
import globals from 'globals'

// Boundary rule ids — listed once so the non-silenceable meta-rule and the protected set
// can never drift apart.
const BOUNDARY_RULE_IDS = [
  '@typescript-eslint/no-restricted-imports',
  'import-x/no-restricted-paths',
  'no-restricted-syntax',
]

// Leak-pattern (guardrail, PLANO-FASE-1 §3.1). Honest limitation: a heuristic over string
// LITERALS in template/JSX positions — it catches a hard-coded `@user:server` / `!room:server`,
// but NOT an id assembled at runtime (`@${u}:${s}`), nor plain (non-template) string Literals.
// With ADR-008 Opt 1 the id carries `:`, so it helps partially; it is not a guarantee.
const LEAK_SELECTORS = [
  { selector: 'TemplateElement[value.raw=/@\\w+:/]', message: 'Possible mxid leak (@user:server) in a template literal — domain code must not carry protocol identifiers.' },
  { selector: 'TemplateElement[value.raw=/!.+:/]', message: 'Possible room-id leak (!room:server) in a template literal — domain code must not carry protocol identifiers.' },
  { selector: 'JSXText[value=/@\\w+:/]', message: 'Possible mxid leak (@user:server) in JSX text — P1 forbids protocol identifiers in the UI.' },
  { selector: 'JSXText[value=/!.+:/]', message: 'Possible room-id leak (!room:server) in JSX text — P1 forbids protocol identifiers in the UI.' },
]

// No re-export of the SDK from any module (kills reference laundering via re-export,
// guardrail ii). Regex source matches matrix-js-sdk and its subpaths.
const NO_SDK_REEXPORT_SELECTORS = [
  { selector: "ExportNamedDeclaration[source.value=/^matrix-js-sdk(\\/|$)/]", message: 'Re-exporting matrix-js-sdk is forbidden — the SDK must not cross the ACL boundary.' },
  { selector: "ExportAllDeclaration[source.value=/^matrix-js-sdk(\\/|$)/]", message: 'Re-exporting matrix-js-sdk is forbidden — the SDK must not cross the ACL boundary.' },
]

// Barrel-vocabulary guard (Leitura B, PR #6). The ACL barrel must not export protocol
// vocabulary in identifier NAMES — bootstrap is not an exception (`serverUrl`, not
// `homeserverUrl`). Conservative deny-list: only unambiguous protocol tokens, so it never
// collides with the neutral product terms the barrel legitimately exports (DomainEvent,
// Channel*, Message*, Device*, Role…). Scoped to index.ts below — internal names are free.
// Honest limitations: (1) matches the EXPORTED name on re-export specifiers and on exported
// `const` names — NOT protocol-named FIELDS inside an exported type (the original
// AclOptions.homeserverUrl was a field; review caught it, not this rule); (2) inline
// `export type`/`interface` declarations are not matched, but the barrel re-exports types
// via specifiers (which ARE matched); (3) a name that avoids these tokens yet still smells
// of protocol (e.g. `roomList`) is not caught. The trade is zero false-positives on the
// current surface over broad coverage that breaks a legitimate build.
// Fase 2 (ADR-015 item 3 / PLANO-FASE-2 §4.6): the deny-list is EXTENDED with crypto protocol
// vocabulary — olm/megolm, cross-signing, secret storage, recovery/device keys, 4S/SSSS, and
// `encrypted` in exported names. Same conservative trade as the base set: unambiguous tokens
// only, zero false-positives on the current surface.
// Fatia C2 (PLANO-FASE-2-ESCROW-C2 §3.5): + `escrow` — custody vocabulary is ACL-internal
// (ADR-013/017); no product name on the barrel may carry it.
const BARREL_VOCAB_DENY = String.raw`homeserver|mxid|federation|powerlevel|power_level|roomid|room_id|eventid|event_id|olm|megolm|crosssigning|cross_signing|secretstorage|secret_storage|recoverykey|recovery_key|devicekey|device_key|4s|ssss|encrypted|escrow`
const BARREL_VOCAB_SELECTORS = [
  {
    selector: `ExportSpecifier[exported.name=/${BARREL_VOCAB_DENY}/i]`,
    message:
      'Protocol vocabulary in an exported name is forbidden on the ACL barrel (P1/ADR-007). Use a neutral product term (e.g. serverUrl, not homeserverUrl). Protocol terms live only in acl/internal/.',
  },
  {
    selector: `ExportNamedDeclaration > VariableDeclaration > VariableDeclarator > Identifier[name=/${BARREL_VOCAB_DENY}/i]`,
    message:
      'Protocol vocabulary in an exported name is forbidden on the ACL barrel (P1/ADR-007). Use a neutral product term. Protocol terms live only in acl/internal/.',
  },
]

// C6 mecanizado em TS/TSX (ADR-033 dec. 2 via PLANO-GATES §2.2): raw hex color in string
// literals/template chunks. Comments are not AST nodes, so the `#136`-in-a-comment grep
// false-positive class does not exist here. Scoped below to src/ui excluding generated
// tokens/ (the one place hex legitimately lives).
const HEX_LITERAL_SELECTORS = [
  { selector: 'Literal[value=/#[0-9A-Fa-f]{3,6}\\b/]', message: 'Raw hex color in a literal breaks theming (C6, ADR-033 dec. 2) — use the semantic token from src/ui/tokens/ (var(--…)/tokens.ts).' },
  { selector: 'TemplateElement[value.raw=/#[0-9A-Fa-f]{3,6}\\b/]', message: 'Raw hex color in a template literal breaks theming (C6, ADR-033 dec. 2) — use the semantic token from src/ui/tokens/ (var(--…)/tokens.ts).' },
]

// Copy gate (ADR-080 D4): UI copy lives in the catalog (src/ui/i18n/), never as a literal in a
// component. JSX only — text, the attributes that carry copy, and the expressions that feed them
// directly; copy in plain code (maps, `return '…'`) is the parser test's job
// (test/i18n-no-literals.test.ts), which also covers what these selectors miss. A literal with no
// letter (glyph, number, punctuation) passes; brand and lettered glyphs are constants in the catalog,
// not an allowlist here.
// Latin letters; the Latin-1 range skips × and ÷ (U+00D7, U+00F7), which are glyphs.
const LETTER = '/[A-Za-zÀ-ÖØ-öø-ÿ]/'
const COPY_ATTR = 'JSXAttribute[name.name=/^(aria-label|aria-description|aria-valuetext|aria-roledescription|aria-placeholder|title|placeholder|alt|label|hint|[a-z]+Label)$/]'
const COPY_MESSAGE = 'UI copy literal outside src/ui/i18n/ (ADR-080 D4) — add a key to the catalog (src/ui/i18n/pt-BR.ts) and read it with t().'
const COPY_SELECTORS = [
  `JSXText[value=${LETTER}]`,
  `${COPY_ATTR} > Literal[value=${LETTER}]`,
  ...[COPY_ATTR + ' > JSXExpressionContainer', 'JSXElement > JSXExpressionContainer', 'JSXFragment > JSXExpressionContainer'].flatMap((container) => [
    `${container} > Literal[value=${LETTER}]`,
    `${container} > TemplateLiteral > TemplateElement[value.raw=${LETTER}]`,
    `${container} > ConditionalExpression > Literal[value=${LETTER}]`,
    `${container} > LogicalExpression > Literal[value=${LETTER}]`,
  ]),
].map((selector) => ({ selector, message: COPY_MESSAGE }))

export default tseslint.config(
  {
    ignores: ['dist/', 'node_modules/', 'coverage/'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Base language options + general rules.
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      // Allow `_`-prefixed params/vars to be intentionally unused — the surface is stubs in
      // this slice, so many signature params carry the contract without being consumed yet.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },

  // Tooling/config files run in Node.
  {
    files: [
      'eslint.config.js',
      'vitest.config.ts',
      'style-dictionary.config.mjs',
      'scripts/**/*.mjs',
      'test/**/*.ts',
      'e2e/**/*.ts',
      'playwright.config.ts',
    ],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  // ── ADR-060 D4: the browser E2E tier is not an exception to the barrel ─────────────────
  // e2e/ drives the app through the browser and reaches the server only through the Node harness
  // (test/support). It never imports product code (src/, nor the @tayet/client alias that resolves
  // to the barrel) nor the SDK/crypto bindings. Enforced here instead of agreed in prose, and
  // non-silenceable like the src/** gate.
  {
    files: ['e2e/**/*.ts'],
    plugins: { '@eslint-community/eslint-comments': comments },
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/src', '**/src/**', '@tayet/client', '@tayet/client/*'],
              message: 'e2e/ imports only test/support (ADR-060 D4): never product code from src/.',
            },
            {
              // ADR-088 dec. 3: of the shared package, e2e/ takes only the leak-scan (a P1 gate, not
              // product code). Domain/errors (`@tayet/shared`) and the translator (`/internal`) are
              // product code, same as src/. A regex, not a negated group: gitignore semantics cannot
              // re-include `@tayet/shared/leak-scan` once `@tayet/shared` (its "parent") is excluded.
              regex: '^@tayet/shared(?!/leak-scan$)(/.*)?$',
              message: 'e2e/ imports only @tayet/shared/leak-scan from the shared package (ADR-088 dec. 3, ADR-060 D4).',
            },
            {
              group: ['matrix-js-sdk', 'matrix-js-sdk/*', '@matrix-org/*'],
              message: 'e2e/ never imports the SDK or crypto bindings (ADR-060 D4).',
            },
          ],
        },
      ],
      '@eslint-community/eslint-comments/no-restricted-disable': ['error', '@typescript-eslint/no-restricted-imports'],
      '@eslint-community/eslint-comments/no-unlimited-disable': 'error',
    },
  },

  // ── ADR-007 boundary gate ───────────────────────────────────────────────────────────
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: {
      'import-x': importX,
      '@eslint-community/eslint-comments': comments,
    },
    settings: {
      'import-x/resolver': {
        typescript: { project: './tsconfig.json' },
      },
    },
    rules: {
      // (a)+(b) guardrail ii: ban matrix-js-sdk everywhere (overridden only in acl/internal).
      // The @typescript-eslint variant catches `import type` too (the base import rule does
      // NOT) — verified in the negative test.
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['matrix-js-sdk', 'matrix-js-sdk/*'],
              message:
                'matrix-js-sdk may only be imported inside src/acl/internal/. Everything above the ACL uses domain types from the acl barrel (ADR-007).',
            },
            {
              // Fase 2 fatia B (PR #17): the attachment cipher primitive imports the pinned
              // crypto-wasm binding directly (PF-1 fork (a)) — protocol machinery, same
              // confinement as the SDK itself.
              group: ['@matrix-org/matrix-sdk-crypto-wasm', '@matrix-org/matrix-sdk-crypto-wasm/*'],
              message:
                '@matrix-org/matrix-sdk-crypto-wasm may only be imported inside src/acl/internal/ (ADR-007 — same boundary as matrix-js-sdk).',
            },
            {
              // ADR-088 dec. 3: the shared package is "inside the ACL". Above the ACL the only door
              // is the barrel (@tayet/client), never the package the barrel re-exports from —
              // guardrail i by package NAME (the path zone below cannot see a bare specifier).
              group: ['@tayet/shared', '@tayet/shared/*'],
              message:
                '@tayet/shared may only be imported inside src/acl/ (ADR-088 dec. 3). Everything above the ACL imports from the acl barrel (@tayet/client).',
            },
          ],
        },
      ],

      // guardrail i: forbid deep-import into acl/internal from outside the ACL; forces the barrel.
      'import-x/no-restricted-paths': [
        'error',
        {
          zones: [
            {
              // extglob: every src file NOT under src/acl/. The ACL surface (src/acl/*) may
              // reach into internal; everything above the ACL may not. Future top-level dirs
              // (e.g. src/ui) are covered automatically — no per-dir maintenance.
              target: './src/!(acl)/**/*',
              from: './src/acl/internal',
              message:
                'Deep-import into src/acl/internal/ is forbidden outside the ACL. Import from the acl barrel (src/acl).',
            },
          ],
        },
      ],

      // guardrail ii (re-export laundering) + leak-pattern, both via no-restricted-syntax.
      'no-restricted-syntax': ['error', ...NO_SDK_REEXPORT_SELECTORS, ...LEAK_SELECTORS],

      // guardrail iii: the boundary rules are non-silenceable. eslint-disable of any boundary
      // rule id (or of the meta-rules themselves) is itself an error. Combined with
      // no-unlimited-disable (below) this closes the bare-`eslint-disable` bypass too.
      '@eslint-community/eslint-comments/no-restricted-disable': [
        'error',
        ...BOUNDARY_RULE_IDS,
        '@eslint-community/eslint-comments/*',
      ],
      '@eslint-community/eslint-comments/no-unlimited-disable': 'error',
    },
  },

  // ── ACL surface (src/acl/*): may import @tayet/shared, but not its translator ─────────────
  // Redefining the rule REPLACES the src/** options, so the SDK/wasm patterns are restated.
  // `@tayet/shared/internal` (translator, SDK-backed) stays inside src/acl/internal/ — the same
  // line the path zone draws for ./src/acl/internal (ADR-088 dec. 3). acl/internal/** turns the
  // rule off in the next block. Non-silenceable: same rule id, same meta-rule from src/**.
  {
    files: ['src/acl/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['matrix-js-sdk', 'matrix-js-sdk/*'],
              message:
                'matrix-js-sdk may only be imported inside src/acl/internal/. Everything above the ACL uses domain types from the acl barrel (ADR-007).',
            },
            {
              group: ['@matrix-org/matrix-sdk-crypto-wasm', '@matrix-org/matrix-sdk-crypto-wasm/*'],
              message:
                '@matrix-org/matrix-sdk-crypto-wasm may only be imported inside src/acl/internal/ (ADR-007 — same boundary as matrix-js-sdk).',
            },
            {
              group: ['@tayet/shared/internal', '@tayet/shared/internal/*'],
              message:
                '@tayet/shared/internal may only be imported inside src/acl/internal/ (ADR-088 dec. 3) — the translator is protocol machinery.',
            },
          ],
        },
      ],
    },
  },

  // ── ACL internal: the ONLY place matrix-js-sdk (and @tayet/shared/internal) may be imported ─
  {
    files: ['src/acl/internal/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-restricted-imports': 'off',
    },
  },

  // ── Barrel vocabulary gate: only the public surface, only exported NAMES ───────────────
  // Scoped to the single barrel file. Redefining no-restricted-syntax here REPLACES (does
  // not merge with) the src/** block's options, so the SDK-reexport and leak selectors are
  // respread to keep them active on index.ts — see the boundary test that asserts this.
  // Non-silenceability still holds: no-restricted-syntax is in BOUNDARY_RULE_IDS and the
  // no-restricted-disable meta-rule from the src/** block also applies to index.ts.
  {
    files: ['src/acl/index.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...NO_SDK_REEXPORT_SELECTORS,
        ...LEAK_SELECTORS,
        ...BARREL_VOCAB_SELECTORS,
      ],
    },
  },

  // ── C6 mecanizado: no raw hex in UI literals (ADR-033 dec. 2, PLANO-GATES §2.2) ────────
  // Same REPLACE semantics as the barrel block above: redefining no-restricted-syntax here
  // replaces the src/** options for these files, so the SDK-reexport and leak selectors are
  // respread. tokens/ (generated, legitimately carries hex) keeps the src/** block only.
  // Non-silenceability holds: no-restricted-syntax is in BOUNDARY_RULE_IDS.
  {
    files: ['src/ui/**/*.{ts,tsx}'],
    ignores: ['src/ui/tokens/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...NO_SDK_REEXPORT_SELECTORS,
        ...LEAK_SELECTORS,
        ...HEX_LITERAL_SELECTORS,
      ],
    },
  },

  // ── Copy gate: no UI copy literal outside the catalog (ADR-080 D4) ─────────────────────────
  // Same REPLACE semantics as the two blocks above: for these files no-restricted-syntax is
  // redefined, so the SDK-reexport, leak and C6 hex selectors are respread. src/ui/i18n/ (the
  // catalog — where copy legitimately lives) keeps the C6 block; tokens/ keeps the src/** block.
  // Non-silenceability holds: no-restricted-syntax is in BOUNDARY_RULE_IDS.
  {
    files: ['src/ui/**/*.{ts,tsx}'],
    ignores: ['src/ui/i18n/**', 'src/ui/tokens/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...NO_SDK_REEXPORT_SELECTORS,
        ...LEAK_SELECTORS,
        ...HEX_LITERAL_SELECTORS,
        ...COPY_SELECTORS,
      ],
    },
  },
)