// Lint do pacote escrow — type-aware, sem regra de boundary (a fronteira ADR-007 é do
// client). O invariante "nenhum import cruzado client/ ↔ escrow/" é um grep no CI
// (PLANO-FASE-2-ESCROW-C1 §5.1), não regra de eslint: vale nas duas direções e não
// depende de cada pacote lintar o outro.
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'

export default tseslint.config(
  { ignores: ['node_modules'] },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    files: ['eslint.config.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
)
