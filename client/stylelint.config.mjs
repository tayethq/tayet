// Gate irmão de ritmo (ADR-033 dec. 3, ativado via PLANO-GATES §2) + C6 mecanizado (CSS).
// Geometria (width/height/inset/min/max-*, largura de borda, offsets/shadow/grid) fica FORA
// por construção — a regra só lista propriedades de ritmo. Sub-4px em propriedade de ritmo
// é constante de composição permitida por classe (threshold no regex; PLANO-GATES §1 fork 3,
// precedente OG-2 do DELTA-workspace). Exceção supra-4 exige stylelint-disable escopado COM
// descrição citando a adjudicação (reportDescriptionlessDisables).

const RHYTHM_PROPS = [
  'padding',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'gap',
  'row-gap',
  'column-gap',
  'font-size',
  'line-height',
  'border-radius',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-right-radius',
  'border-bottom-left-radius',
];

// px ≥ 4 (inteiro ou decimal, unidade em qualquer caixa: `9PX` casa), delimitado à esquerda
// por início/espaço/paren/vírgula; sub-4 (0–3.xx px) e tokens var(--…) não casam.
const RHYTHM_PX_DISALLOWED = /(?:^|[\s(,])-?(?:[4-9]|[1-9][0-9]+)(?:\.[0-9]+)?px/i;

export default {
  ignoreFiles: ['src/ui/tokens/**'],
  reportDescriptionlessDisables: true,
  rules: {
    'declaration-property-value-disallowed-list': [
      // chave regex com `i`: `PADDING:` casa — furo registrado em PLANO-RELEASE-PUBLICA §8.43 F5
      Object.fromEntries(RHYTHM_PROPS.map((prop) => [`/^${prop}$/i`, [RHYTHM_PX_DISALLOWED]])),
      {
        message:
          'Propriedade de ritmo com px ≥ 4: aterrisse no token (var(--space-*), var(--font-*), var(--radius-*)); valor fora da escala é token-delta pro owner, não px cru — PLANO-GATES §2.1 (ADR-033 dec. 3)',
      },
    ],
    'color-no-hex': [
      true,
      {
        message:
          'Hex cru não resolve por tema (C6): use o token semântico var(--…) de tokens/ — PLANO-GATES §2.2 (ADR-033 dec. 2)',
      },
    ],
  },
};
