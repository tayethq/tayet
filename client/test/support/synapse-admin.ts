import { execSync } from 'node:child_process'
import { MAS_CONFIG, MAS_CONTAINER } from './stack-env'
import { HOMESERVER } from './synapse'

// Test-only admin helper for the D3 convergence gate (PLANO-FASE-2-D3-ADMIN-GATE §3.2 / ADR-020).
// Mirrors synapse.ts (`docker exec mas-cli` + a thin REST call). Mints an EPHEMERAL Synapse-admin
// compat token via mas-cli and opens the cross-signing replacement window — the ONLY headless,
// user-attached path to `urn:synapse:admin:*` (client_credentials produces a user-less token the
// Synapse admin API rejects; see ADR-020 §Contexto / PLANO §0.4 for why the obvious path is dead).
//
// Confinement (ADR-020 invariants): admin lives in the per-run token, never in config nor on the
// user (the flag grants admin to the TOKEN — the user needs no `-a`). Helper is test-only; the
// ACL↔Synapse boundary lint bars import from src/, and a CI grep-guard keeps the admin scope out
// of client/src entirely. Same trust class as the harness's mintToken/register-user.
//
// One probe account PER WORKER SLOT (PLANO-CI-INTEGRACAO C3-F9): every consumer ends with
// kill-sessions on the WHOLE account, so two test processes sharing one account kill each other's
// freshly minted admin token mid-read (401). The slot id keeps concurrent processes apart; processes
// that reuse a slot run one after the other, never at the same time.

// Throwaway user that the admin helpers mint probe tokens for (idempotent register, ensureProbeUser).
// Computed at module load, one per worker slot: two processes at the same time (Vitest with
// --fileParallelism, Playwright with more than one worker, or integration and E2E side by side) must
// not share it, because each consumer's teardown runs kill-sessions on the entire account and would
// revoke the token the other process just minted. Vitest sets VITEST_POOL_ID (1..maxWorkers) in its
// worker; Playwright sets TEST_PARALLEL_INDEX in its worker; outside both, the historical name.
export const PROBE_USER = ((): string => {
  const vitestSlot = process.env.VITEST_POOL_ID
  if (vitestSlot) return `d3adminprobe-v${vitestSlot}`
  const playwrightSlot = process.env.TEST_PARALLEL_INDEX
  if (playwrightSlot) return `d3adminprobe-p${playwrightSlot}`
  return 'd3adminprobe'
})()

let probeUserEnsured = false

// Idempotent register of PROBE_USER, once per process ("User already exists" is success). The slot
// accounts are new names, so a consumer that only mints (org-membership.ts) can no longer rely on an
// account some earlier run left behind.
function ensureProbeUser(): void {
  if (probeUserEnsured) return
  try {
    execSync(
      `docker exec ${MAS_CONTAINER} mas-cli manage register-user -c ${MAS_CONFIG} --yes --ignore-password-complexity --password gatepass123 ${PROBE_USER} 2>&1`,
      { encoding: 'utf8' },
    )
  } catch (err) {
    const out = String((err as { stdout?: unknown }).stdout ?? err)
    if (!out.includes('User already exists')) throw err
  }
  probeUserEnsured = true
}

// Mint a Synapse-admin compat token (mct_…) for a username = mintToken + the admin flag. The flag
// grants admin to the TOKEN, so the username need not be admin (register-user without `-a`).
//
// Same bounded exec retry as mintToken (issue #7 M4-token; #150 carry-forward) — exec failure
// ONLY; a clean exec whose output has no mct_ is a real error, not a retry. Unlike mintToken this
// stays SYNC: adminScopeReachable() calls it at collection time (a skipIf gate), so the backoff is
// an execSync'd sleep — ugly and honest for support code. The probeTokenActive activation probe is
// deliberately absent: the collection-time consumer only tests reachability (and does its own
// admin-endpoint check right after), so the probe would force async for no coverage.
export function mintAdminToken(username: string): string {
  if (username === PROBE_USER) ensureProbeUser()
  const out = (() => {
    for (let attempt = 0; ; attempt++) {
      try {
        return execSync(
          `docker exec ${MAS_CONTAINER} mas-cli manage issue-compatibility-token -c ${MAS_CONFIG} ${username} --yes-i-want-to-grant-synapse-admin-privileges 2>&1`,
          { encoding: 'utf8' },
        )
      } catch (err) {
        if (attempt >= 2) {
          const e = err as { stdout?: unknown; stderr?: unknown }
          throw new Error(
            `admin mint exec failed after ${attempt + 1} attempts for ${username}: ` +
              `stdout=${String(e.stdout ?? '')} stderr=${String(e.stderr ?? '')}`,
            { cause: err },
          )
        }
        execSync(`sleep ${attempt === 0 ? '0.5' : '1'}`)
      }
    }
  })()
  const m = /mct_[A-Za-z0-9_]+/.exec(out)
  if (!m) throw new Error(`could not mint admin token for ${username}: ${out}`)
  return m[0]
}

// Open the Synapse window that lets a cross-signing identity be REPLACED without interactive UIA
// (MSC3967). Requires a `urn:synapse:admin:*` token (mintAdminToken). The window auto-expires
// (~10 min, Synapse default) and is reusable — no explicit close needed (PLANO §8.3). Body is `{}`.
export async function allowCrossSigningReplacementWithoutUia(adminToken: string, userId: string): Promise<void> {
  const path = `/_synapse/admin/v1/users/${encodeURIComponent(userId)}/_allow_cross_signing_replacement_without_uia`
  const res = await fetch(`${HOMESERVER}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `admin scope rejected opening the cross-signing window (${res.status}) — token lacks ` +
        `urn:synapse:admin:* or the window endpoint is gated: ${await res.text()}`,
    )
  }
  // 404 "no master cross-signing key" means the user never did E2E — a setup error, not auth.
  if (!res.ok) throw new Error(`open cross-signing window -> ${res.status} ${await res.text()}`)
}

// Lift the message rate limit of ONE user (Synapse admin API `override_ratelimit`; 0/0 is the API's
// "no limit", not a tuning value). For a scenario that needs more timeline events than the local
// Synapse's default rc_message lets a user send in a burst — e.g. pushing a root out of the initial
// sync window (ADR-067, paginated root). Per user and persisted; the suites use fresh per-run users.
export async function liftMessageRatelimit(adminToken: string, userId: string): Promise<void> {
  const path = `/_synapse/admin/v1/users/${encodeURIComponent(userId)}/override_ratelimit`
  const res = await fetch(`${HOMESERVER}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages_per_second: 0, burst_count: 0 }),
  })
  if (!res.ok) throw new Error(`override_ratelimit -> ${res.status} ${await res.text()}`)
}

// Synchronous gate probe (style of synapseReachable): can we mint an admin token AND have Synapse
// accept it on an admin-only endpoint? Evaluated at collection time to decide the un-skip. Mints a
// throwaway probe token for the per-slot idempotently-registered user and hits an admin-only,
// param-less endpoint expecting 200. Any failure (stack down, MAS down, scope refused) → false →
// the convergence leg auto-skips honestly.
export function adminScopeReachable(): boolean {
  try {
    ensureProbeUser()
    try {
      const token = mintAdminToken(PROBE_USER)
      const code = execSync(
        `curl -s -m 5 -o /dev/null -w "%{http_code}" -H "Authorization: Bearer ${token}" ${HOMESERVER}/_synapse/admin/v1/background_updates/status`,
        { encoding: 'utf8' },
      )
      return code.trim() === '200'
    } finally {
      // The probe mints a fresh admin compat session each collection; kill it so PROBE_USER's
      // sessions/devices don't accumulate across runs (the local-determinism hygiene of #25).
      killSessions(PROBE_USER)
    }
  } catch {
    return false
  }
}

// Kill all sessions for a throwaway d3* user — the `finally` of the convergence gate. The ephemeral
// admin token dies with it; the auto-expiring window needs no explicit close (PLANO §3.3 / §8.3).
export function killSessions(username: string): void {
  try {
    execSync(`docker exec ${MAS_CONTAINER} mas-cli manage kill-sessions -c ${MAS_CONFIG} ${username} 2>&1`, {
      encoding: 'utf8',
    })
  } catch {
    /* best-effort teardown — never fail the suite */
  }
}

// The revocation itself as the ACT under test (ADR-060, browser E2E tier): same mas-cli command as
// killSessions, but a failure is LOUD. A swallowed failure there would turn "the access-ended screen
// never appeared" into a red for the wrong reason. mas-cli exits non-zero on an unknown user
// ("User not found") or a dead container, so execSync throws; the stdout is returned so the caller
// can log what was revoked. killSessions above stays the best-effort teardown of the suites.
export function killSessionsOrThrow(username: string): string {
  try {
    return execSync(`docker exec ${MAS_CONTAINER} mas-cli manage kill-sessions -c ${MAS_CONFIG} ${username} 2>&1`, {
      encoding: 'utf8',
    })
  } catch (err) {
    const e = err as { stdout?: unknown; status?: unknown }
    throw new Error(`kill-sessions failed for ${username} (exit ${String(e.status)}): ${String(e.stdout ?? '')}`, {
      cause: err,
    })
  }
}
