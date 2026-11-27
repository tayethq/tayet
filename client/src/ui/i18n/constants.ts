// O que não muda com a língua (ADR-080 D4): a marca e os glifos. Vivem aqui, e não como literal no
// componente, para que o gate de copy não precise de allowlist — fora de src/ui/i18n/ só passa
// literal sem letra.
export const APP_NAME = 'Tayet'
// O wordmark do boot (login-onboarding §7: `tayet`, caixa baixa).
export const APP_WORDMARK = 'tayet'

export const GLYPH = {
  hash: '#',
  dot: '·',
  failed: '!',
  ellipsis: '…',
  close: '×',
  clear: '✕',
  back: '‹',
  // "← Voltar às conversas" of the Admin shell (organization-admin.md §2.1 item 1).
  arrowBack: '←',
  chevron: '›',
  plus: '+',
  check: '✓',
  image: '🖼️',
  file: '📎',
  // Toolbar do composer: a letra É o glifo do botão (o nome acessível vem do catálogo).
  bold: 'B',
  italic: 'I',
  strike: 'S',
  // The narrow composer's formatting toggle (workspace.md §23.7 item 1).
  formatToggle: 'Aa',
} as const

// Atalho da busca, por plataforma.
export const KEY_HINT = { mac: '⌘K', other: 'Ctrl K' } as const

// The data export's file name, `tayet-export-AAAA-MM-DD.zip` with the local date (PLANO-EXPORT-DADOS
// §0.3.6 item 5): the same in every language, so it is a constant and not copy.
export const EXPORT_FILE = { prefix: 'tayet-export-', extension: '.zip' } as const
