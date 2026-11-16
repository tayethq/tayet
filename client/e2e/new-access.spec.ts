import { rmSync, writeFileSync } from 'node:fs'
import { test, expect, type Browser, type BrowserContext, type Locator, type Page, type TestInfo } from '@playwright/test'
import { killSessions } from '../test/support/synapse-admin'
import { HANA } from './fixtures/users'
import { signIn } from './support/login'
import { ForbiddenLines } from './support/console'
import { expectNoProtocolLeak } from './support/assertions'
import { title } from './support/workspace'
import { SESSION } from './support/labels'

// Dogfood ROTEIRO-U2 2.5 (PLANO-RELEASE-PUBLICA §8.23), finding A: a dismissed new-access notice came
// back on the next reload, and went away after more reloads. Browser tier (ADR-060 D1): the scenario
// needs a reload of the same device and more than one browser context of the same account. hana is
// this spec's own user (one user per spec, fixtures/users.ts); her sessions are killed before and
// after, so every run starts from accesses that exist only in this run.
//
// What reproduced (§8.23): not the in-flight write. Step 3 waits for the write to land (PUT 200, the
// server holds the access in the recognized set) and the notice still comes back. The reload is the
// SAME device, and Synapse answers an initial /sync of the same device from its response cache for
// `sync_response_cache_duration` (default 2m): the boot reads the recognized set as it was before the
// dismissal. After the window, a reload gets a fresh initial sync — "goes away after more reloads".
//
// §8.38 (ADR-063, adendo 2): step 2 still failed once in CI (run 39142454464, attempt 2) and the
// artifact could not tell the two windows apart — the dismissal's PUT landing after the next boot's
// server read, or a DevicesUpdated scan announcing before that read. Both are fixed; the second test
// holds the PUT (the first window, 8/8 before the fix). On failure this spec now attaches B1's timeline
// of the recognized set (PUT/GET of the set, notice shown/hidden) and keeps a video of every context.

const SET_PATH = '/account_data/io.tayet.acknowledged_devices'
const notice = (page: Page) => page.getByRole('region', { name: SESSION.notices })
const dismiss = (page: Page) => notice(page).getByRole('button', { name: SESSION.dismiss })

// The new-access scan runs after the first sync, fire-and-forget, so "absent right after the h1" is
// weak. Absence is asserted as "does not show up within the window".
const SETTLE_MS = 10_000
async function expectStaysAbsent(locator: Locator): Promise<void> {
  const appeared = await locator
    .waitFor({ state: 'visible', timeout: SETTLE_MS })
    .then(() => true)
    .catch(() => false)
  expect(appeared, 'the dismissed notice came back').toBe(false)
}

// Explicit budget (PLANO-RELEASE-PUBLICA §8.30). Two fixed SETTLE_MS windows (20 s) plus four Dex
// sign-ins: the spec ran at 26.8–26.9 s against the 30 s default since §8.25, and measured at a
// 27.2 s (main) / 27.1 s (keepalive fix) median, 28.1 s max, over 10 runs each; 4 of 20 earlier
// runs hit the 30 s default. 60 s is about twice the median: the timeout catches a hang, not
// ordinary slowness.
test.setTimeout(60_000)
test.beforeEach(() => killSessions('hana'))

// Evidence for the next failure (§8.38, T5). The contexts are opened by hand, so the config's `video`
// does not reach them: each records into the test's output dir, deleted when the test passes (ADR-060
// D5: video only on failure; still no trace). B1's timeline carries no protocol id: counts, statuses,
// whether the boot read held every dismissed access, and the notice's title.
type TimelineEntry = { ms: number; what: string }
let timeline: { t0: number; entries: TimelineEntry[] } | undefined

async function newContext(browser: Browser, testInfo: TestInfo): Promise<BrowserContext> {
  return browser.newContext({ recordVideo: { dir: testInfo.outputPath('video') } })
}

async function recordRecognition(ctx: BrowserContext): Promise<void> {
  const t0 = Date.now()
  const entries: TimelineEntry[] = []
  timeline = { t0, entries }
  const log = (what: string, at = Date.now()) => entries.push({ ms: at - t0, what })
  const dismissed = new Set<string>()
  const devicesOf = (body: string | null): string[] => {
    try {
      const d = (JSON.parse(body ?? '{}') as { devices?: unknown }).devices
      return Array.isArray(d) ? d.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  }
  ctx.on('request', (r) => {
    if (r.method() !== 'PUT' || !r.url().includes(SET_PATH)) return
    const devices = devicesOf(r.postData())
    devices.forEach((d) => dismissed.add(d))
    log(`PUT set n=${devices.length}`)
  })
  ctx.on('response', async (r) => {
    if (!r.url().includes(SET_PATH)) return
    if (r.request().method() === 'PUT') {
      log(`PUT set -> ${r.status()}`)
      return
    }
    const at = Date.now() // the response's arrival, before its body is read
    const devices = new Set(r.status() === 200 ? devicesOf(await r.text().catch(() => null)) : [])
    log(`GET set -> ${r.status()} n=${devices.size} holds every dismissed=${[...dismissed].every((d) => devices.has(d))}`, at)
    entries.sort((a, b) => a.ms - b.ms)
  })
  await ctx.exposeFunction('__e2eNotice', (state: string) => log(`notice ${state}`))
  await ctx.addInitScript(() => {
    let shown = ''
    const check = () => {
      const el = document.querySelector('[aria-label="Avisos de segurança da conta"] strong')
      const now = el?.textContent ?? ''
      if (now === shown) return
      shown = now
      ;(window as unknown as { __e2eNotice: (s: string) => void }).__e2eNotice(now ? `shown "${now}"` : 'hidden')
    }
    new MutationObserver(check).observe(document, { subtree: true, childList: true })
  })
}

test.afterEach(async () => {
  const testInfo = test.info()
  killSessions('hana')
  const failed = testInfo.status !== testInfo.expectedStatus
  if (failed && timeline) {
    // A file in the output dir: CI uploads test-results/ on failure, not the report.
    const path = testInfo.outputPath('b1-recognition-timeline.json')
    writeFileSync(path, JSON.stringify(timeline.entries, null, 2))
    await testInfo.attach('b1-recognition-timeline', { path, contentType: 'application/json' })
  }
  timeline = undefined
  if (!failed) rmSync(testInfo.outputPath('video'), { recursive: true, force: true })
})

test('a dismissed new-access notice does not come back on reload, and goes away in the other sessions', async ({ browser }, testInfo) => {
  const ctx1 = await newContext(browser, testInfo)
  const ctx2 = await newContext(browser, testInfo)
  const ctx3 = await newContext(browser, testInfo)
  const ctx4 = await newContext(browser, testInfo)
  await recordRecognition(ctx1)
  try {
    const b1 = await ctx1.newPage()
    const b2 = await ctx2.newPage()
    // Lines forbidden in the whole tier (support/console.ts, ADR-065).
    const forbidden = new ForbiddenLines()
    forbidden.watch(b1, 'B1')
    forbidden.watch(b2, 'B2')

    await test.step('1. hana logs in on B1, then on B2: B1 is told about the new access', async () => {
      await signIn(b1, HANA)
      await signIn(b2, HANA)
      await expect(notice(b1)).toContainText(SESSION.newAccess)
      await expectNoProtocolLeak(b1)
    })

    // "Sem esperar rede": the reload goes out right after the click, while the write of the
    // recognized set may still be in flight.
    await test.step('2. B1 dismisses and reloads at once: the notice does not come back', async () => {
      await dismiss(b1).click()
      await b1.reload()
      await expect(title(b1)).toBeVisible()
      await expectStaysAbsent(notice(b1))
      await expectNoProtocolLeak(b1)
    })

    // Control of step 2: the write has landed before the reload, so a red here is not the race.
    await test.step('3. a third access; B1 dismisses, the write lands, B1 reloads: the notice does not come back', async () => {
      const b3 = await ctx3.newPage()
      forbidden.watch(b3, 'B3')
      await signIn(b3, HANA)
      await expect(notice(b1)).toContainText(SESSION.newAccess)
      const written = b1.waitForResponse((r) => r.request().method() === 'PUT' && r.url().includes('/account_data/'))
      await dismiss(b1).click()
      expect((await written).status()).toBe(200)
      await b1.reload()
      await expect(title(b1)).toBeVisible()
      await expectStaysAbsent(notice(b1))
    })

    // ADR-063: recognition is the account's (ADR-018 §4). B2 first clears what it has, then a fourth
    // access shows on both; dismissing it on B1 takes it off B2, with no reload.
    await test.step('4. a fourth access on B1 and B2; B1 dismisses: it goes away on B2 too', async () => {
      if (await notice(b2).isVisible()) await dismiss(b2).click()
      await expect(notice(b2)).toHaveCount(0)
      const b4 = await ctx4.newPage()
      forbidden.watch(b4, 'B4')
      await signIn(b4, HANA)
      await expect(notice(b1)).toContainText(SESSION.newAccess)
      await expect(notice(b2)).toContainText(SESSION.newAccess)
      await dismiss(b1).click()
      await expect(notice(b1)).toHaveCount(0)
      await expect(notice(b2)).toHaveCount(0)
      await expectNoProtocolLeak(b2)
    })
    forbidden.expectNone()
  } finally {
    await ctx1.close()
    await ctx2.close()
    await ctx3.close()
    await ctx4.close()
  }
})

// §8.38 D2 (T1): the first window of the CI failure, forced. The dismissal's PUT is held 1.5 s, so it
// lands after the reloaded page's server read of the set (8/8 notices back in the §0 probe, before the
// fix). The dismissal waits in the pending list across the reload; the boot writes it again.
test('a dismissal whose write lands after the next boot\'s read does not come back on reload', async ({ browser }, testInfo) => {
  const ctx1 = await newContext(browser, testInfo)
  const ctx2 = await newContext(browser, testInfo)
  await recordRecognition(ctx1)
  try {
    const b1 = await ctx1.newPage()
    const b2 = await ctx2.newPage()
    const forbidden = new ForbiddenLines()
    forbidden.watch(b1, 'B1')
    forbidden.watch(b2, 'B2')
    await signIn(b1, HANA)
    await signIn(b2, HANA)
    await expect(notice(b1)).toContainText(SESSION.newAccess)

    let held = false
    await ctx1.route(`**${SET_PATH}`, async (route) => {
      if (route.request().method() === 'PUT' && !held) {
        held = true
        await new Promise((r) => setTimeout(r, 1_500))
      }
      await route.continue()
    })
    await dismiss(b1).click()
    await b1.reload()
    await expect(title(b1)).toBeVisible()
    await expectStaysAbsent(notice(b1))
    expect(held, 'precondition: the dismissal PUT was held').toBe(true)
    forbidden.expectNone()
  } finally {
    await ctx1.close()
    await ctx2.close()
  }
})
