// ADR-091: reading an approval card and deciding which answer resolves it. Pure — no SDK, no
// network — so the client and the sidecar run the SAME rule over the SAME source (the card's relations
// filtered by the answer's relation type, read forward: the server's order, PLANO-AGENTES §0.3.16 item 4).
import type { ApprovalOption, ApprovalState, Timestamp } from '../domain'
import { APPROVAL_BLOCK, APPROVAL_RESPONSE_BLOCK } from './product-events'
import { brandUserId } from './protocol-ids'

export const APPROVAL_MAX_OPTIONS = 3
export const APPROVAL_LABEL_MAX = 75
// An option's id (§0.3.16 item 12): the sidecar validates the same on write.
export const APPROVAL_OPTION_ID = /^[a-z0-9_-]{1,32}$/

// The reserved agent localpart (ADR-086 dec. 1) — `a-` + 12 of lowercase base32, created only by the
// escrow. The same pattern the client's ACL and the sidecar check.
const AGENT_LOCALPART = /^a-[a-z2-7]{12}$/
const localpartOf = (userId: string): string => userId.slice(1, userId.includes(':') ? userId.indexOf(':') : undefined)

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

// Defensive read of the card's options (§0.3.16 item 12; the sidecar validates the same on write): 1 to
// 3, `id` matching [a-z0-9_-]{1,32} and unique, `label` non-empty with at most 75 characters. An unknown
// `style` is ignored (the option is secondary); a second `primary` is demoted to secondary. Anything
// else → undefined: the card is malformed and the translator degrades it like an unknown type.
export function readApprovalOptions(content: Record<string, unknown>): ApprovalOption[] | undefined {
  const block = content[APPROVAL_BLOCK]
  if (!isRecord(block) || !Array.isArray(block.options)) return undefined
  const raw = block.options
  if (raw.length < 1 || raw.length > APPROVAL_MAX_OPTIONS) return undefined
  const out: ApprovalOption[] = []
  const ids = new Set<string>()
  let primary = false
  for (const item of raw) {
    if (!isRecord(item)) return undefined
    const { id, label, style } = item
    if (typeof id !== 'string' || !APPROVAL_OPTION_ID.test(id) || ids.has(id)) return undefined
    if (typeof label !== 'string' || label.trim() === '' || [...label].length > APPROVAL_LABEL_MAX) return undefined
    ids.add(id)
    const option: ApprovalOption = { id, label }
    if (style === 'danger') option.style = 'danger'
    else if (style === 'primary' && !primary) {
      option.style = 'primary'
      primary = true
    }
    out.push(option)
  }
  return out
}

// Whether this content carries the closing mark. Read on the content the card DISPLAYS — the author's
// latest edit (displayedEdit): an edit by anyone else never applies (PLANO-AGENTES §8.30).
export function approvalClosed(content: Record<string, unknown>): boolean {
  const block = content[APPROVAL_BLOCK]
  return isRecord(block) && block.closed === true
}

// The option an answer's (decrypted) content names, or undefined when it names none.
export function responseOption(content: Record<string, unknown>): string | undefined {
  const block = content[APPROVAL_RESPONSE_BLOCK]
  return isRecord(block) && typeof block.option === 'string' ? block.option : undefined
}

// One answer as the rule needs it: its author and server instant (both in clear), whether it could be
// read and, if so, the option it names. `redacted` answers leave the relations (P-A3-1); one the caller
// still holds is skipped.
export interface ApprovalAnswer {
  sender: string
  ts: number
  decrypted: boolean
  option?: string
  redacted?: boolean
}

// The accounts that never answer besides agents (ADR-091 dec. 3): the custody account and `system`.
export interface ApprovalAccounts {
  custodian?: string | null
  systemAccount?: string | null
}

// Whether an account is an agent: the reserved localpart (ADR-086 dec. 1). Only an agent sends a card
// (ADR-091 dec. 1) — the inverse of the agent half of mayAnswer.
export function isAgentSender(sender: string): boolean {
  return sender.startsWith('@') && AGENT_LOCALPART.test(localpartOf(sender))
}

// Who may answer (ADR-091 dec. 3; PLANO-AGENTES §0.3.16 item 1): a person — member or guest. An agent
// (the reserved prefix), the custody account and `system` never.
export function mayAnswer(sender: string, accounts: ApprovalAccounts): boolean {
  if (sender === '' || !sender.startsWith('@')) return false
  if (isAgentSender(sender)) return false
  return sender !== accounts.custodian && sender !== accounts.systemAccount
}

// ADR-091 dec. 4/6/7/8/9: the card's state from its ORIGINAL options, its answers in the server's order
// and the instant it was closed (undefined while open). That instant is the author's FIRST closing edit —
// the close is permanent, a later edit never moves it (dec. 7); the caller computes it. The first answer that counts resolves it:
// - its author may answer (mayAnswer);
// - it arrived no later than the close (server instants; an answer at the very instant of the close
//   counts — the sidecar's seal follows its answer by milliseconds, PLANO-AGENTES §8.31);
// - it names an option of the card — or it cannot be read yet: an unreadable answer from a person
//   resolves the card without the option (author and instant are in clear) and gains it on decrypt,
//   when this runs again; if it then names no option, the next one takes over.
// No answer counts → 'closed' when closed, else 'open'. A closed card never reopens.
export function resolveApproval(
  options: readonly ApprovalOption[],
  answers: readonly ApprovalAnswer[],
  closedAt: number | undefined,
  accounts: ApprovalAccounts,
): ApprovalState {
  for (const a of answers) {
    if (a.redacted === true || !mayAnswer(a.sender, accounts)) continue
    if (closedAt !== undefined && a.ts > closedAt) continue
    const by = brandUserId(a.sender)
    const at = a.ts as Timestamp
    if (!a.decrypted) return { kind: 'answered', by, at }
    if (a.option !== undefined && options.some((o) => o.id === a.option)) return { kind: 'answered', by, at, option: a.option }
  }
  return closedAt !== undefined ? { kind: 'closed' } : { kind: 'open' }
}
