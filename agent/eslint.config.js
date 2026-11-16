// Lint do pacote do agente de custódia — type-aware, sem regra de boundary: a fronteira
// ACL (ADR-007) é do client. O agente é serviço de infra e fala protocolo por design
// (ADR-057 dec. 5); o invariante "nenhum import cruzado entre pacotes" segue sendo grep
// de CI, não regra de eslint — vale nas duas direções e não depende de cada pacote
// lintar o outro.
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
