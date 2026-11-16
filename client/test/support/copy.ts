// The UI copy as the tests read it (ADR-080 D5): the catalog's own values, never a literal and never
// t(). A new or changed assert on copy uses `copy.*` — `copy.account.title`, not 'Sua conta' — so a
// copy change moves the catalog and the test together, and a wrong string on screen stays red.
// Interpolated and plural values are templates: compose them with `fill`.
export { ptBR as copy } from '../../src/ui/i18n/pt-BR'

export function fill(template: string, params: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole))
}
