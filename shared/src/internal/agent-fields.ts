// ADR-086 (Proposto): the agent's fields as the ACL reads them. The colours are the ten of the
// manifest (account-access.md §11.1) — the same list the escrow validates (escrow/src/agents.ts); an
// unknown recorded value reads as absent. normalizeName mirrors the escrow's collision rule (dec. 6):
// case, accent and space do not distinguish two names.
import type { AgentColor } from '../domain'

export const AGENT_COLORS: readonly AgentColor[] = [
  'areia',
  'petroleo',
  'turquesa',
  'salvia',
  'ocre',
  'argila',
  'barro',
  'malva',
  'ardosia',
  'grafite',
]

export const isAgentColor = (v: unknown): v is AgentColor =>
  typeof v === 'string' && (AGENT_COLORS as readonly string[]).includes(v)

export function normalizeName(name: string): string {
  return name.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim()
}
