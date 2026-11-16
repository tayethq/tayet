// The agent's operator, learned from the escrow at boot (PLANO-AGENTES §0.3.10 items 3–4; ADR-087
// dec. 3, step 3b): `GET <account>/v1/people/me` with the agent's own token answers `operator`, the
// mxid the escrow reads from what `system` recorded in #all (which the agent can neither write nor
// read). Only the invite filter (core/join.ts) uses it: it never reaches a log, the local API or a
// file, and the response body is never logged. Cached for the run: the operator is immutable.
import { fetchSettled, type RetryOptions } from './http'

export type OperatorLookup =
  | { kind: 'ok'; operator: string }
  // 401/403: the escrow refused the credential (boot case: 78, no wipe, no sentinel).
  | { kind: 'refused'; status: number }
  // An agent with no live operator recorded (tombstone, missing record, no `operator`): 78
  // `operator-unknown` — only an admin resolves it, by recreating the agent.
  | { kind: 'unknown' }
  // Any other definitive answer (non-2xx, unreadable body, not recognised as an agent): 69.
  | { kind: 'bad-escrow'; status: number }

const MXID = /^@[^:\s]+:\S+$/

export async function lookupOperator(account: string, token: string, opts: RetryOptions): Promise<OperatorLookup> {
  const res = await fetchSettled(`${account}/v1/people/me`, { headers: { Authorization: `Bearer ${token}` } }, opts)
  if (res.status === 401 || res.status === 403) return { kind: 'refused', status: res.status }
  if (!res.ok) return { kind: 'bad-escrow', status: res.status }
  const body = (await res.json().catch(() => null)) as { kind?: unknown; operator?: unknown } | null
  if (body === null || typeof body !== 'object' || body.kind !== 'agent') return { kind: 'bad-escrow', status: res.status }
  return typeof body.operator === 'string' && MXID.test(body.operator)
    ? { kind: 'ok', operator: body.operator }
    : { kind: 'unknown' }
}
