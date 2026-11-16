import { expect, test, type Page } from '@playwright/test'
import { APP_URL, escapeRegExp, HS_URL, MAS_URL } from '../../test/support/stack-env'
import { onApp } from './login'
import { dumpWipeProbe, installWipeProbe } from './wipe-probe'

// Console ledger of the browser E2E tier. Chromium logs every 4xx/5xx response as a console error
// ("Failed to load resource: … status of N"), even when the app handles it. The tier fails on ANY
// console error of the app origin, except named network responses that are expected in a given
// state — each with its reason and a cap; more than the cap is itself a failure.

export interface ExpectedResponse {
  /** origin + pathname of the resource (query ignored: /sync carries since/timeout). For a pattern
   *  entry it is the readable name of the pattern, used in counts and messages. */
  url: string
  /** Optional: match the FULL resource URL (query included) instead of `url`, for paths that carry
   *  ids (room/session). */
  pattern?: RegExp
  status: number
  max: number
  /** Where the cap is counted: over the whole browser context, or per page. */
  per: 'context' | 'page'
  why: string
}

const HS = HS_URL
const HS_RE = escapeRegExp(HS)

// Expected on the FIRST login of a brand-new account (§8.8: CI run 38629914099, reproduced with
// frank). An existing account produces none, so the caps are upper bounds, not expectations.
export const FIRST_LOGIN_404: ReadonlyArray<ExpectedResponse> = [
  {
    // No key backup yet: the SDK asks for the current backup version before creating one.
    url: `${HS}/_matrix/client/v3/room_keys/version`,
    status: 404,
    max: 3,
    per: 'context',
    why: 'no key backup yet on a new account',
  },
  {
    // No secret in the escrow yet: custody is write-once (ADR-017) and the first login deposits it
    // right after this lookup comes back empty.
    url: `${APP_URL}/escrow/v1/secret`,
    status: 404,
    max: 1,
    per: 'context',
    why: 'no secret in the escrow yet on a new account',
  },
]

// ADR-052 + ADR-090 (agents.spec step 6): the agent its operator just added stays `invite` (no process
// runs it), so a viewer who shares no JOINED room with it gets the profile read refused (403); the ACL
// falls back to the room's member name (getUserProfile). One read per open profile.
export const AGENT_PROFILE_403: ReadonlyArray<ExpectedResponse> = [
  {
    url: `${HS}/_matrix/client/v3/profile/<agent>`,
    pattern: new RegExp(`^${HS_RE}\\/_matrix\\/client\\/v3\\/profile\\/%40a-[a-z2-7]{12}%3A[^/?]+$`),
    status: 403,
    max: 1,
    per: 'page',
    why: 'profile of an only-invited agent, no joined room shared (ADR-052)',
  },
]

// Expected right after an admin revocation (`kill-sessions`) of a connected session (§8.6, measured
// 3/3 with an idle client): the device deletion wakes /sync through the user's own device list, and
// the crypto fires keys/upload + keys/query alongside the next /sync — each hits the deleted device
// once (401, no retry) before the session-lost signal (ADR-059) tears the client down.
export const AFTER_REVOCATION_401: ReadonlyArray<ExpectedResponse> = [
  { url: `${HS}/_matrix/client/v3/sync`, status: 401, max: 3, per: 'page', why: 'sync on the deleted device' },
  { url: `${HS}/_matrix/client/v3/keys/upload`, status: 401, max: 3, per: 'page', why: 'key upload on the deleted device' },
  { url: `${HS}/_matrix/client/v3/keys/query`, status: 401, max: 3, per: 'page', why: 'key query on the deleted device' },
  {
    // §8.58 (#7, conversation step 8): the js-sdk's backup upload loop (random 0–10 s delay) fires its
    // PUT room_keys/keys?version=1 after the kill-sessions, against the already-deleted device.
    url: `${HS}/_matrix/client/v3/room_keys/keys`,
    status: 401,
    max: 1,
    per: 'page',
    why: 'loop de upload da aba revogada com token morto',
  },
  {
    // ADR-059, normal revocation path (arm A, the one a fresh browser login takes): the SDK answers the
    // 401 with a refresh, and the MAS rejects the revoked grant (invalid_grant, HTTP 400). That
    // rejection is what raises TokenRefreshLogoutError → the session-lost signal.
    url: `${MAS_URL}/oauth2/token`,
    status: 400,
    max: 1,
    per: 'page',
    why: 'refresh of the revoked grant rejected by the MAS',
  },
  {
    // The custody GET of the session keys (key-recovery.ts consultCustody) carries the dead token when it
    // leaves between the revocation and the session-lost flag: once from the first boot's recovery pass
    // (its last call, right after the m.megolm_backup.v1 write that people.spec waits for), and at most
    // CUSTODY_RECONSULT_MAX rounds of the per-session re-consult (custody.ts), which stops on the
    // session-lost flag. The 401 folds into 'unavailable' (a telemetry signal), with no retry of its own.
    url: `${APP_URL}/escrow/v1/sessions`,
    status: 401,
    max: 5,
    per: 'page',
    why: 'custody session-key GET with the revoked token: 1 recovery pass + up to CUSTODY_RECONSULT_MAX (4) re-consult rounds',
  },
]

// Expected on the re-login after a revocation (§8.19, measured on a clean stack): the Megolm sessions
// the killed device had not uploaded to its backup yet (the upload runs in batches, and the kill came
// first). The new device asks the backup for each one (404), then decrypts them through the custody
// (ADR-061) — the history comes out intact. Cap = the two DM sessions of the scenario (one per sender).
export const AFTER_RELOGIN_404: ReadonlyArray<ExpectedResponse> = [
  {
    url: `${HS}/_matrix/client/v3/room_keys/keys/*/*?version=1`,
    pattern: new RegExp(`^${HS_RE}\\/_matrix\\/client\\/v3\\/room_keys\\/keys\\/[^/?]+\\/[^/?]+\\?version=1$`),
    status: 404,
    max: 2,
    per: 'page',
    why: 'session the killed device never backed up; custody covers it (ADR-061)',
  },
]

// ADR-077 dec. 2: how many times the ACL re-consults the custody for an unknown Megolm session. Mirrors
// CUSTODY_RECONSULT_MAX in client/src/acl/internal/custody.ts — e2e/ cannot import src/ (ADR-060 D4).
export const CUSTODY_RECONSULT_MAX = 4

// Per-session backup lookups a device may make before it holds the key (ADR-077 dec. 2–3): the SDK's
// first GET, plus one per re-decrypt the ACL asks for after each custody consult. A cap derived from the
// mechanism, not from what a run happened to show.
export const backupLookupsCap = (unknownSessions: number): number => unknownSessions * (1 + CUSTODY_RECONSULT_MAX)
export const BACKUP_LOOKUPS_WHY = (unknownSessions: number): string =>
  `ADR-077: 1 GET inicial + até CUSTODY_RECONSULT_MAX re-decifragens por sessão desconhecida (${unknownSessions} ${unknownSessions === 1 ? 'sessão' : 'sessões'} neste teste)`

// The recognized-set read (ADR-063, adendo; PLANO-RELEASE-PUBLICA §8.31): every app boot reads the set
// from the SERVER (not the sync cache, §8.23), and an account that never dismissed an access has no set
// and answers 404 — the legitimate "nothing dismissed yet" state, which Chromium always logs. One 404
// per app boot of such an account, so the cap is the number of app boots of the busiest page the
// ledger watches; each spec passes it with the boots named. (Writing an empty set at boot to avoid the
// 404 is ruled out: it would overwrite another browser's first concurrent write.)
export const recognizedSet404 = (bootsPerPage: number): ReadonlyArray<ExpectedResponse> => [
  {
    url: `${HS}/_matrix/client/v3/user/*/account_data/io.tayet.acknowledged_devices`,
    pattern: new RegExp(`^${HS_RE}\\/_matrix\\/client\\/v3\\/user\\/[^/?]+\\/account_data\\/io\\.tayet\\.acknowledged_devices$`),
    status: 404,
    max: bootsPerPage,
    per: 'page',
    why: 'no recognized set yet; one ADR-063 server read per app boot',
  },
]

// Console messages the SDK itself logs on the same revocation path (not network responses). Matched by
// the EXACT start of the text — the SDK appends a stack trace after it — with a cap per page.
export interface ExpectedMessage {
  text: string
  /** Optional: the source URL of the console entry must match too (for a network failure with no
   *  HTTP status, e.g. a request the spec aborts — the text alone would match any such failure). */
  at?: RegExp
  max: number
  why: string
}

export const AFTER_REVOCATION_SDK_MESSAGES: ReadonlyArray<ExpectedMessage> = [
  {
    // ADR-059: the refresh of the revoked grant is rejected; the SDK logs the TokenRefreshLogoutError
    // and the ACL turns it into the session-lost signal (the access-ended screen of step 8).
    text: 'Failed to refresh token TokenRefreshLogoutError: The provided access grant is invalid, expired, or revoked.',
    max: 1,
    why: 'refresh rejected → session-lost signal (ADR-059)',
  },
  {
    // ADR-059 (§8.6): the crypto's keys/upload in flight hits the device the kill already deleted; the
    // SDK logs the failed outgoing request once (no retry) before the teardown.
    text: `Failed to process outgoing request 0: M_UNKNOWN_TOKEN: MatrixError: [401] Token is not active (${HS}/_matrix/client/v3/keys/upload)`,
    max: 1,
    why: 'keys/upload against the already-deleted device (ADR-059)',
  },
  {
    // §8.58 (#7): the SDK's own line for the room_keys/keys 401 of AFTER_REVOCATION_401 — same cause,
    // same request (the backup upload loop against the already-deleted device).
    text: `Backup: Error processing backup request for rust crypto-sdk M_UNKNOWN_TOKEN: MatrixError: [401] Token is not active (${HS}/_matrix/client/v3/room_keys/keys?version=1)`,
    max: 1,
    why: 'backup upload against the already-deleted device (§8.58, #7)',
  },
]

// Lines the tier forbids in EVERY spec, at any console level (ADR-065, PLANO-RELEASE-PUBLICA §8.25).
// A wipe that times out means another connection held the crypto store — a second live tab, the defect
// the tab lock removes, or, in a single tab, another holder of the store at close() (#247: the ledger
// then attaches wipe-probe.ts's account of who closed it); a failed sync batch is the §8.24
// hypothesis (4), defended but never expected.
const WIPE_TIMED_OUT = '[acl] store wipe timed out'
export const FORBIDDEN_LINES: ReadonlyArray<string> = [WIPE_TIMED_OUT, '[acl] sync batch failed']
export const isForbiddenLine = (text: string): boolean => FORBIDDEN_LINES.some((l) => text.startsWith(l))

// For the specs that keep their own console accounting (login, new-access, device-list-staleness):
// collects the forbidden lines of each watched page. The ConsoleLedger below does the same itself.
export class ForbiddenLines {
  readonly seen: string[] = []
  watch(page: Page, label: string): void {
    page.on('console', (msg) => {
      if (isForbiddenLine(msg.text())) this.seen.push(`[${label}] ${msg.text()}`)
    })
  }
  expectNone(): void {
    expect(this.seen, 'forbidden console lines (ADR-065)').toEqual([])
  }
}

const NETWORK = /^Failed to load resource: the server responded with a status of (\d{3})/

const resource = (url: string): string => {
  try {
    const u = new URL(url)
    return `${u.origin}${u.pathname}`
  } catch {
    return url
  }
}

export class ConsoleLedger {
  private readonly allowed: ExpectedResponse[] = []
  private readonly allowedMessages: ExpectedMessage[] = []
  private readonly messageCounts = new Map<string, number>()
  private readonly counts = new Map<string, number>()
  // #247 (§8.62): the pages whose wipe timed out, with their label — expectClean attaches the probe.
  private readonly wipeTimedOut = new Map<string, Page>()
  readonly unexpected: string[] = []

  constructor(
    private readonly label: string,
    allowed: ReadonlyArray<ExpectedResponse> = [],
  ) {
    this.allowed.push(...allowed)
  }

  /** Start accepting more expected responses (e.g. the 401s once the revocation is fired). */
  allow(more: ReadonlyArray<ExpectedResponse>, messages: ReadonlyArray<ExpectedMessage> = []): void {
    this.allowed.push(...more)
    this.allowedMessages.push(...messages)
  }

  watch(page: Page, pageLabel: string): void {
    installWipeProbe(page)
    page.on('console', (msg) => {
      if (isForbiddenLine(msg.text())) {
        this.unexpected.push(`[${pageLabel}] forbidden: ${msg.text()}`)
        if (msg.text().startsWith(WIPE_TIMED_OUT)) this.wipeTimedOut.set(pageLabel, page)
        return
      }
      if (msg.type() !== 'error' || !onApp(page.url())) return
      const sdk = this.allowedMessages.find((m) => msg.text().startsWith(m.text) && (!m.at || m.at.test(msg.location().url)))
      if (sdk) {
        const key = `${sdk.text} @ ${pageLabel}`
        this.messageCounts.set(key, (this.messageCounts.get(key) ?? 0) + 1)
        return
      }
      const status = NETWORK.exec(msg.text())?.[1]
      const url = resource(msg.location().url)
      // The most recent allowance wins: a spec may allow the same response twice, in different phases
      // and with different caps (account.spec: before and after the re-login).
      const rule = status
        ? [...this.allowed].reverse().find(
            (r) => r.status === Number(status) && (r.pattern ? r.pattern.test(msg.location().url) : r.url === url),
          )
        : undefined
      if (!rule) {
        this.unexpected.push(`[${pageLabel}] ${msg.text()} @ ${msg.location().url}`)
        return
      }
      const key = `${rule.status} ${rule.url} @ ${rule.per === 'page' ? pageLabel : 'context'}`
      this.counts.set(key, (this.counts.get(key) ?? 0) + 1)
    })
  }

  /** Observed counts of the allowlisted responses, for the execution report. */
  observed(): Record<string, number> {
    return Object.fromEntries([...this.counts, ...this.messageCounts])
  }

  expectClean(): void {
    // A wipe timeout carries the probe's account of the rust store (who closed it, when, from where).
    const probes = [...this.wipeTimedOut].map(([pageLabel, page]) => `[${pageLabel}] ${dumpWipeProbe(page)}`)
    for (const body of probes) test.info().attachments.push({ name: 'wipe-probe', contentType: 'text/plain', body: Buffer.from(body) })
    const why = [`${this.label}: unexpected console errors`, ...probes].join('\n')
    expect(this.unexpected, why).toEqual([])
    for (const [key, seen] of this.counts) {
      const rule = this.allowed.find((r) => key.startsWith(`${r.status} ${r.url} @`))!
      expect(seen, `${this.label}: ${key} seen ${seen}×, above the cap of ${rule.max} (${rule.why})`).toBeLessThanOrEqual(
        rule.max,
      )
    }
    for (const [key, seen] of this.messageCounts) {
      const rule = this.allowedMessages.find((m) => key.startsWith(`${m.text} @`))!
      expect(seen, `${this.label}: "${key}" seen ${seen}×, above the cap of ${rule.max} (${rule.why})`).toBeLessThanOrEqual(
        rule.max,
      )
    }
  }
}
