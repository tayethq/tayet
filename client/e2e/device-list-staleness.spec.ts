import { test, expect, type Page, type Response } from '@playwright/test'
import { appendFileSync } from 'node:fs'
import { HS_URL, hostUrlPattern, MAS_URL } from '../test/support/stack-env'
import { killSessions } from '../test/support/synapse-admin'
import { IVO, JADE } from './fixtures/users'
import { signIn } from './support/login'
import { currentDeviceIds, protocolUserId } from './support/server-facts'
import { ForbiddenLines } from './support/console'
import { signInAgain, signOutHere } from './support/account'
import { ELSEWHERE, PLACEHOLDERS } from './support/assertions'
import { conversations, dmWith, messages, send, title } from './support/workspace'
import { setHidden, VISIBILITY_SHIM } from './support/visibility'
import { LIST, NEW_CONVERSATION } from './support/labels'

// Dogfood ROTEIRO-U2 2.6 (PLANO-RELEASE-PUBLICA §8.24, P0): a long-lived session stopped applying the
// peer's device-list changes; it kept encrypting for a dead device and never for the new ones, so the
// peer saw "Waiting for message…". Browser tier (ADR-060 D1): the scenario needs a session that lives
// across many logins of the peer, in a real browser with its real IndexedDB crypto store.
//
// ivo (A) is logged in the whole time; jade (B) signs out ("Sair deste navegador", ADR-062 D1) and in
// again every round, which gives her a new device (her store is wiped on sign-out). A writes; B must
// read it within 10 s. Every round also reads A's crypto store (IndexedDB `devices`) and compares it
// with the devices the server holds for B — that says WHERE it broke when it breaks.
//
// Knobs (env):
//   SOAK_ROUNDS            rounds of sign-out/sign-in (default 2: the per-PR regression gate)
//   SOAK_FORCE_REFRESH=0   turns variant (a) off (on by default)
//   SOAK_BACKGROUND=1      turns variant (b) on
//   SOAK_SECOND_TAB=1      turns variant (d) on: A keeps a SECOND tab of the same context open (same
//                          device, same storage). Before ADR-065 both tabs synced on one refresh token
//                          and the second died on the first refresh, wiping the shared session (§8.24,
//                          collateral finding). With the tab lock the second tab is neutral: it must stay
//                          on the neutral screen through every round and make no request to the server,
//                          the issuer or the custody, while A keeps its refreshes (ADR-065 D3).
//   SOAK_HIDDEN_MS         how long A stays hidden in (b) (default 65 s: past the 60 s of the mitigation)
//   SOAK_REQUIRE_TTL_MAX   fail unless the MAS issues tokens of at most this many seconds (the soak
//                          sets 60: proves the stack is up with config.soak.yaml, not the default 3600)
// Variant (c), the real short TTL, is the MAS config of the nightly soak (`npm run e2e:soak`).
//
// Console ledger: this spec does not use the strict ledger of the tier (support/console.ts). It injects
// 401s on purpose, signs B out and in N times (first-login and re-login 404s per round), and its job is
// the device list; A's whole console is written to `console-A.log` in the test output instead (the
// soak uploads it on failure, with the rust-crypto lines that name the devices it encrypts for).

const ROUNDS = Number(process.env.SOAK_ROUNDS ?? 2)
const FORCE_REFRESH = process.env.SOAK_FORCE_REFRESH !== '0'
const BACKGROUND = process.env.SOAK_BACKGROUND === '1'
const SECOND_TAB = process.env.SOAK_SECOND_TAB === '1'
const HIDDEN_MS = Number(process.env.SOAK_HIDDEN_MS ?? 65_000)
const REQUIRE_TTL_MAX = process.env.SOAK_REQUIRE_TTL_MAX ? Number(process.env.SOAK_REQUIRE_TTL_MAX) : undefined
const READ_WITHIN_MS = 10_000

// Rounds are slow (two OIDC logins, escrow recovery on B's new device): budget per round, generous.
test.setTimeout(120_000 + ROUNDS * (BACKGROUND ? 150_000 : 90_000))

const IVO_NAME = 'ivo'
const JADE_NAME = 'jade'

// B reads the text, and from it onward nothing is a placeholder, within the bound.
async function expectReadsWithin(page: Page, text: string, ms: number): Promise<void> {
  await expect
    .poll(
      async () => {
        const all = await messages(page).innerText()
        const at = all.indexOf(text)
        if (at < 0) return 'absent'
        const tail = all.slice(at)
        return PLACEHOLDERS.some((p) => tail.includes(p)) ? 'placeholder' : 'readable'
      },
      { timeout: ms, intervals: [250] },
    )
    .toBe('readable')
}

// A's crypto store as the browser holds it: the `devices` object store of the rust crypto IndexedDB.
// The store is not encrypted (no storage key is passed to initRustCrypto): the key is
// `<user>\u001d<device>` and the value is base64 JSON with a `deleted` flag (a device the server
// dropped stays in the store, marked deleted). Returns the entries of one user. Never opens a database
// that does not exist — an open() without version would create an empty one under the rust store's name.
interface StoredDevice {
  device: string
  deleted: boolean
}
async function storedDevicesOf(page: Page, userPrefix: string): Promise<StoredDevice[] | string> {
  return page.evaluate(async (prefix) => {
    const NAME = 'matrix-js-sdk::matrix-sdk-crypto'
    if (!(await indexedDB.databases()).some((d) => d.name === NAME)) return '<no crypto store>'
    const done = <T,>(r: IDBRequest<T>) =>
      new Promise<T>((res, rej) => {
        r.onsuccess = () => res(r.result)
        r.onerror = () => rej(r.error)
      })
    const db = await done(indexedDB.open(NAME))
    try {
      if (!db.objectStoreNames.contains('devices')) return '<no devices store>'
      const st = db.transaction('devices', 'readonly').objectStore('devices')
      const [keys, values] = await Promise.all([done(st.getAllKeys()), done(st.getAll())])
      const out: Array<{ device: string; deleted: boolean }> = []
      keys.forEach((k, i) => {
        const key = String(k)
        if (!key.startsWith(`${prefix}\u001d`)) return
        const v = values[i]
        const json = typeof v === 'string' ? atob(v) : new TextDecoder().decode(v as ArrayBuffer)
        const deleted = (JSON.parse(json) as { deleted?: boolean }).deleted === true
        out.push({ device: key.slice(prefix.length + 1), deleted })
      })
      return out
    } finally {
      db.close()
    }
  }, userPrefix)
}

// Variant (b): A in the background, for a window longer than the 60 s of the mitigation, with no
// interaction (VISIBILITY_SHIM, support/visibility.ts).

const deviceListChanges = (body: unknown): string[] =>
  ((body as { device_lists?: { changed?: string[] } } | null)?.device_lists?.changed ?? []).slice()

test.beforeEach(() => {
  killSessions('ivo')
  killSessions('jade')
})
test.afterEach(() => {
  killSessions('ivo')
  killSessions('jade')
})

test('a long-lived session keeps applying the peer device-list changes across sign-out/sign-in rounds', async ({
  browser,
}, testInfo) => {
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  const netA = testInfo.outputPath('network-A.log')
  const note = (file: string, line: string) => appendFileSync(file, `${new Date().toISOString()} ${line}\n`)
  console.log(
    `[e2e] device-list staleness: rounds=${ROUNDS} forceRefresh=${FORCE_REFRESH} background=${BACKGROUND} secondTab=${SECOND_TAB}` +
      (BACKGROUND ? ` hiddenMs=${HIDDEN_MS}` : ''),
  )

  // ── Variant (a): forced refresh. ──
  // The SDK refreshes on a 401 M_UNKNOWN_TOKEN only when it does not know the token expiry yet or the
  // expiry is less than 60 s away (REFRESH_ON_ERROR_IF_TOKEN_EXPIRES_WITHIN_MS, http-api/refresh.js);
  // otherwise the 401 is a logout. On the dev-stack TTL (3600 s) only the first round would qualify,
  // so A's refresh responses are rewritten to expires_in 59 — the SDK then believes, as with the short
  // TTL of production, that every 401 is an expiry. The server token itself keeps its real TTL.
  let armed = false
  const issuedByServer: number[] = []
  let injected = 0
  if (FORCE_REFRESH) {
    await ctxA.route('**/oauth2/token', async (route) => {
      const res = await route.fetch().catch(() => null)
      if (!res) return route.abort().catch(() => {})
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
      if (!body || typeof body['expires_in'] !== 'number' || !route.request().postData()?.includes('grant_type=refresh_token')) {
        return route.fulfill({ response: res })
      }
      issuedByServer.push(body['expires_in'])
      note(netA, `token refresh: expires_in ${body['expires_in']} → 59`)
      return route.fulfill({ response: res, json: { ...body, expires_in: 59 } })
    })
    // While armed (from B's sign-out until B is back in), every /sync response that carries a
    // device-list change is swallowed ONCE per `since` and answered 401: the SDK refreshes and repeats
    // the request with the same `since`, so it is the REPEATED /sync that carries device_lists.changed —
    // the production path of §8.24. Once per `since`, or the repeat would be swallowed forever.
    const swallowed = new Set<string>()
    await ctxA.route(/\/_matrix\/client\/v3\/sync\?/, async (route) => {
      // A failed fetch (context closing) is swallowed: Playwright's error would print the request,
      // bearer and cookies included, into the log.
      const res = await route.fetch().catch(() => null)
      if (!res) return route.abort().catch(() => {})
      if (!armed) return route.fulfill({ response: res })
      const since = new URL(route.request().url()).searchParams.get('since') ?? '<initial>'
      const changed = deviceListChanges(await res.json().catch(() => null))
      if (changed.length === 0 || swallowed.has(since)) return route.fulfill({ response: res })
      swallowed.add(since)
      injected++
      note(netA, `INJECTED 401 on the /sync (since ${since}) carrying device_lists.changed=${JSON.stringify(changed)}`)
      return route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ errcode: 'M_UNKNOWN_TOKEN', error: 'Token is not active', soft_logout: false }),
      })
    })
  }
  if (BACKGROUND) await ctxA.addInitScript(VISIBILITY_SHIM)
  // The TTL the MAS really issues (before any rewrite of variant (a)): every token response of A.
  const issuedTtls: number[] = []
  ctxA.on('response', (r) => {
    if (!r.url().endsWith('/oauth2/token') || r.status() !== 200) return
    r.json()
      .then((b: { expires_in?: unknown }) => {
        if (typeof b.expires_in === 'number') issuedTtls.push(b.expires_in)
      })
      .catch(() => {})
  })

  try {
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()
    // A /sync batch whose processing throws is logged as "Caught /sync error" and its device_lists are
    // never applied: the sync token already moved on (sync.js:756 before :766; device_lists last, :1394).
    let syncErrors = 0
    // Lines forbidden in the whole tier (support/console.ts, ADR-065).
    const forbidden = new ForbiddenLines()
    // Per tab of A: the whole console (console-<tab>.log, with the rust-crypto lines), and on the shared
    // trail (network-A.log, tagged by tab) /sync responses with device_lists, keys/query (who was asked,
    // what came back), keys/claim and to-device sends. Diagnosis (§8.24 phase 2), not assertion.
    const watchTab = (page: Page, tab: string): void => {
      forbidden.watch(page, tab)
      const log = testInfo.outputPath(`console-${tab}.log`)
      page.on('console', (m) => {
        if (m.text().includes('Caught /sync error')) syncErrors++
        note(log, `[${m.type()}] ${m.text()}`)
      })
      page.on('response', async (r: Response) => {
        const u = r.url()
        try {
          if (u.includes('/_matrix/client/v3/sync?')) {
            if (r.status() !== 200) return note(netA, `[${tab}] /sync ${r.status()}`)
            const changed = deviceListChanges(await r.json())
            if (changed.length) note(netA, `[${tab}] /sync 200 device_lists.changed=${JSON.stringify(changed)}`)
          } else if (u.includes('/keys/query')) {
            const asked = Object.keys((r.request().postDataJSON() as { device_keys?: object })?.device_keys ?? {})
            const keys = ((await r.json()) as { device_keys?: Record<string, object> }).device_keys ?? {}
            const got = Object.fromEntries(Object.entries(keys).map(([user, devs]) => [user, Object.keys(devs)]))
            note(netA, `[${tab}] keys/query ${r.status()} asked=${JSON.stringify(asked)} got=${JSON.stringify(got)}`)
          } else if (u.includes('/keys/claim')) {
            note(netA, `[${tab}] keys/claim ${r.status()} ${r.request().postData() ?? ''}`)
          } else if (u.includes('/sendToDevice/')) {
            note(netA, `[${tab}] sendToDevice ${r.status()} ${u.split('/sendToDevice/')[1]?.split('/')[0] ?? ''}`)
          }
        } catch {
          // a body that is gone (navigation) is not a diagnosis
        }
      })
    }
    watchTab(pageA, 'A')

    await test.step('0. ivo and jade sign in; they share a DM', async () => {
      await signIn(pageA, IVO)
      await signIn(pageB, JADE)
      // The pair is this spec's own (fixtures/users.ts), so locally the DM survives across runs: it is
      // created only when ivo does not have it yet. Known-set picker (ADR-029 dec. 3) via #all.
      // The picker is a snapshot taken when the dialog opens, and jade's session join of #all
      // (ADR-045) may land after her h1: the dialog is reopened until she is in the known set.
      await expect(conversations(pageB).getByRole('button', { name: LIST.orgChannel, exact: true })).toBeVisible()
      if ((await dmWith(pageA, JADE_NAME).count()) === 0) {
        const dialog = pageA.getByRole('dialog', { name: NEW_CONVERSATION.dialog })
        const contact = dialog.getByRole('button', { name: JADE_NAME, exact: true })
        await expect(async () => {
          if ((await dialog.count()) > 0) await dialog.getByRole('button', { name: NEW_CONVERSATION.cancel }).click()
          await conversations(pageA).getByRole('button', { name: LIST.newDm }).click()
          await expect(contact).toBeVisible({ timeout: 5_000 })
        }).toPass({ timeout: 60_000 })
        await contact.click()
        await dialog.getByRole('button', { name: NEW_CONVERSATION.startConversation }).click()
        await expect(dialog).toHaveCount(0)
      }
      await dmWith(pageA, JADE_NAME).click()
      const hello = `staleness-0 ${Date.now()}`
      await send(pageA, hello)
      await dmWith(pageB, IVO_NAME).click()
      await expectReadsWithin(pageB, hello, 30_000)
    })

    // Variant (d): a second tab of A, same context — same device, same storage. One active tab per
    // origin (ADR-065): it opens on the neutral screen and stays there; it never syncs, refreshes or
    // touches the custody, so A's refreshes no longer race it for the grant.
    let pageA2: Page | undefined
    const a2Requests: string[] = []
    if (SECOND_TAB) {
      await test.step('0b. ivo opens a second tab (same browser): neutral, silent', async () => {
        pageA2 = await ctxA.newPage()
        watchTab(pageA2, 'A2')
        pageA2.on('request', (r) => {
          const u = r.url()
          if (hostUrlPattern(HS_URL, MAS_URL).test(u) || u.includes('/escrow/')) a2Requests.push(`${r.method()} ${u.split('?')[0]}`)
        })
        await pageA2.goto('/')
        await expect(pageA2.getByText(ELSEWHERE)).toBeVisible()
        await expect(title(pageA2)).toHaveCount(0)
      })
    }

    for (let round = 1; round <= ROUNDS; round++) {
      await test.step(`round ${round}/${ROUNDS}: jade signs out and in; ivo writes; jade reads within 10 s`, async () => {
        note(netA, `── round ${round} ──`)
        if (BACKGROUND) await setHidden(pageA, true)
        const hiddenAt = Date.now()

        armed = FORCE_REFRESH
        await signOutHere(pageB)
        await signInAgain(pageB, JADE)
        const bDevices = await currentDeviceIds('jade')
        note(netA, `server devices of jade: ${JSON.stringify(bDevices)}`)

        if (BACKGROUND) {
          const left = HIDDEN_MS - (Date.now() - hiddenAt)
          if (left > 0) await pageB.waitForTimeout(left)
          await setHidden(pageA, false)
        }

        // Where it breaks: A's crypto store must hold every device the server holds for B, live, and
        // no B device the server no longer has may be live in it (the §8.24 symptom: encrypting for
        // yesterday's dead device, never for the new ones). Soft, so the delivery below still runs and
        // the round reports both.
        armed = false
        let stored: StoredDevice[] | string = []
        await expect
          .soft(async () => {
            stored = await storedDevicesOf(pageA, protocolUserId('jade'))
            expect(typeof stored, `ivo's crypto store: ${String(stored)}`).toBe('object')
            const list = stored as StoredDevice[]
            const live = list.filter((d) => !d.deleted).map((d) => d.device).sort()
            expect(live, `round ${round}: jade's live devices in ivo's crypto store = the server's`).toEqual([...bDevices].sort())
          })
          .toPass({ timeout: 20_000, intervals: [500] })
        note(netA, `ivo's crypto store, jade's devices (round ${round}): ${JSON.stringify(stored)}`)

        await dmWith(pageB, IVO_NAME).click()
        const text = `staleness-${round} ${Date.now()}`
        await send(pageA, text)
        await expectReadsWithin(pageB, text, READ_WITHIN_MS)
        if (FORCE_REFRESH) note(netA, `round ${round}: injected 401s so far ${injected}`)
        if (pageA2) {
          await expect(pageA2.getByText(ELSEWHERE)).toBeVisible()
          expect(a2Requests, `round ${round}: requests of the neutral second tab`).toEqual([])
        }
      })
    }

    if (FORCE_REFRESH) expect(injected, 'variant (a) injected at least one 401 on a device-list /sync').toBeGreaterThan(0)
    expect.soft(syncErrors, 'a /sync batch threw on ivo (its device_lists were dropped)').toBe(0)
    forbidden.expectNone()
    // Refresh responses are rewritten by (a): the server's own TTL is what the route saw before the
    // rewrite; the login exchange is not rewritten and reaches the context listener as issued.
    const ttls = [...issuedByServer, ...issuedTtls.filter((t) => t !== 59)]
    console.log(`[e2e] TTLs issued by the MAS to ivo: ${JSON.stringify(ttls)}; refreshes: ${issuedByServer.length}`)
    if (REQUIRE_TTL_MAX !== undefined) {
      expect(ttls.length, 'no token response observed').toBeGreaterThan(0)
      expect(Math.max(...ttls), `the MAS TTL is short (stack up with config.soak.yaml)`).toBeLessThanOrEqual(REQUIRE_TTL_MAX)
    }
  } finally {
    await ctxA.unrouteAll({ behavior: 'ignoreErrors' })
    await ctxA.close()
    await ctxB.close()
  }
})
