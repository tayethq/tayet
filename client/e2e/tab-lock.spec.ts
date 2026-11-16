import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, test, expect, type BrowserContext, type Page, type Worker } from '@playwright/test'
import { APP_URL, HS_URL, hostUrlPattern, MAS_URL } from '../test/support/stack-env'
import { killSessions } from '../test/support/synapse-admin'
import { KAI, LIA } from './fixtures/users'
import { ConsoleLedger, FIRST_LOGIN_404, recognizedSet404, type ExpectedResponse } from './support/console'
import { signIn } from './support/login'
import { ELSEWHERE, expectNoProtocolLeak, expectReadable } from './support/assertions'
import { conversations, dmWith, send, title } from './support/workspace'
import { deleteSharedRooms } from './support/rooms'
import { LIST, NEW_CONVERSATION, SESSION } from './support/labels'

// ADR-065: one active tab per origin. kai (A) is signed in; a second tab of the same browser (B) shows
// the neutral screen and touches nothing — no request to the server, the issuer or the custody, no wasm.
// A real token refresh in A (variant (a) of device-list-staleness: one /sync answered 401, the SDK
// refreshes and repeats) leaves A working and B silent: the defect of PLANO-RELEASE-PUBLICA §8.24 (d)
// was B refreshing the same grant. Then B takes over ("Usar aqui"): A yields by reload and lands on the
// neutral screen, B comes up with the same session and reads and writes the DM. lia is the DM peer.
// Two more tests take the owner away from the conversation (ROTEIRO-U2 rev. 2 item 2.5): an owner that
// does not answer, and an owner discarded by the browser (full Chromium, ADR-072 addendum to dec. 8).

const KAI_NAME = 'kai'
const LIA_NAME = 'lia'
const HS = HS_URL
const STACK_HOSTS = hostUrlPattern(HS_URL, MAS_URL)
const OWNER_SILENT = '[e2e] owner silent'
const DISCARD_EXTENSION = join(import.meta.dirname, 'support/discard-extension')

// The one /sync this spec answers 401 itself, to force the refresh (Chromium logs every 4xx).
const INJECTED_401: ReadonlyArray<ExpectedResponse> = [
  { url: `${HS}/_matrix/client/v3/sync`, status: 401, max: 1, per: 'page', why: 'injected by the spec to force a real refresh' },
]

// Network ledger of a tab while it is neutral: anything to the homeserver, the MAS, the custody (served
// under /escrow by the SPA origin) or a wasm artifact is a violation of ADR-065 D3.
function neutralLedger(page: Page): { hits: string[]; on: boolean } {
  const ledger = { hits: [] as string[], on: true }
  page.on('request', (r) => {
    if (!ledger.on) return
    const u = r.url()
    if (STACK_HOSTS.test(u) || u.includes('/escrow/') || /\.wasm(\?|$)/.test(u)) {
      ledger.hits.push(`${r.method()} ${u.split('?')[0]}`)
    }
  })
  return ledger
}

// Both sign in; kai opens the DM and writes `text`; lia reads it. Known-set picker (ADR-029 dec. 3) via
// #all; lia's session join of #all (ADR-045) may land after her h1, so the dialog is reopened until she
// is in the known set.
async function signInAndWrite(pageA: Page, pageL: Page, text: string): Promise<void> {
  await signIn(pageA, KAI)
  await signIn(pageL, LIA)
  await expect(conversations(pageL).getByRole('button', { name: LIST.orgChannel, exact: true })).toBeVisible()
  const dialog = pageA.getByRole('dialog', { name: NEW_CONVERSATION.dialog })
  const contact = dialog.getByRole('button', { name: LIA_NAME, exact: true })
  await expect(async () => {
    if ((await dialog.count()) > 0) await dialog.getByRole('button', { name: NEW_CONVERSATION.cancel }).click()
    await conversations(pageA).getByRole('button', { name: LIST.newDm }).click()
    await expect(contact).toBeVisible({ timeout: 5_000 })
  }).toPass({ timeout: 60_000 })
  await contact.click()
  await dialog.getByRole('button', { name: NEW_CONVERSATION.startConversation }).click()
  await expect(dialog).toHaveCount(0)
  await dmWith(pageA, LIA_NAME).click()
  await send(pageA, text)
  await dmWith(pageL, KAI_NAME).click()
  await expectReadable(pageL, text)
}

// An owner that does not answer: A's main thread spins, so the release request stays queued in its
// BroadcastChannel until the loop ends (a CDP freeze does not do this: a frozen page still receives the
// message and yields). Resolves once the loop has begun; `done` tells when it ended. Headless Chromium
// never freezes a tab on its own, and a CDP freeze of a background tab of the full Chromium neither stopped
// it nor held the message (PLANO-RELEASE-PUBLICA §8.126): the natural freeze goes to the soak's long
// variant, after the tag (ROTEIRO-U2 §2).
async function silenceOwner(page: Page, holdMs: number): Promise<{ silent: () => boolean; done: Promise<void> }> {
  let silent = true
  const started = page.waitForEvent('console', (m) => m.text() === OWNER_SILENT)
  const end = () => void (silent = false)
  const done = page
    .evaluate(
      ([line, ms]) => {
        console.info(line)
        const until = Date.now() + (ms as number)
        while (Date.now() < until);
      },
      [OWNER_SILENT, holdMs] as const,
    )
    .then(end, end)
  await started
  return { silent: () => silent, done }
}

// Before EACH test, not once per file (as account.spec.ts): a new device of a later test would ask the
// backup for an earlier test's session that never reached it (room_keys 404).
test.beforeEach(async () => {
  killSessions('kai')
  killSessions('lia')
  await deleteSharedRooms('kai', 'lia')
})
test.afterEach(() => {
  killSessions('kai')
  killSessions('lia')
})

test('one active tab per origin: the second tab is neutral, survives a real refresh in the first, and takes over', async ({
  browser,
}) => {
  test.setTimeout(240_000)
  const ts = Date.now()
  const m1 = `tab-lock-1 ${ts}`
  const m2 = `tab-lock-2 ${ts}`
  const m3 = `tab-lock-3 ${ts}`

  const ctxA = await browser.newContext()
  const ctxL = await browser.newContext()
  // App boots per page (one recognized-set 404 each, support/console.ts): A = 1 (login in step 1; it
  // yields in step 4 by reload into the neutral screen, no boot); B = 1 ("Usar aqui" in step 4); L = 1
  // (login in step 1).
  const consoleK = new ConsoleLedger('kai', [...FIRST_LOGIN_404, ...recognizedSet404(1), ...INJECTED_401])
  const consoleL = new ConsoleLedger('lia', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  try {
    const pageA = await ctxA.newPage()
    const pageL = await ctxL.newPage()
    consoleK.watch(pageA, 'A')
    consoleL.watch(pageL, 'L')

    await test.step('1. kai and lia sign in; kai writes in their DM; lia reads', async () => {
      await signInAndWrite(pageA, pageL, m1)
    })

    const pageB = await ctxA.newPage()
    consoleK.watch(pageB, 'B')
    const neutralB = neutralLedger(pageB)

    await test.step('2. a second tab of kai is neutral: no app, no login, no request, no leak', async () => {
      await pageB.goto('/')
      await expect(pageB.getByText(ELSEWHERE)).toBeVisible()
      await expect(pageB.getByRole('button', { name: SESSION.useHere })).toBeVisible()
      await expect(title(pageB)).toHaveCount(0)
      await expect(pageB.getByRole('button', { name: /^Continuar com/ })).toHaveCount(0)
      await expect(title(pageA)).toBeVisible()
      await expectNoProtocolLeak(pageA, pageB)
      expect(neutralB.hits, 'requests of the neutral tab').toEqual([])
    })

    await test.step('3. a real refresh in A: A keeps working, B stays silent', async () => {
      // Variant (a) of device-list-staleness: the next /sync of A is answered 401 M_UNKNOWN_TOKEN once;
      // the SDK does not know the token expiry yet, so it refreshes at the MAS and repeats the /sync.
      let injected = 0
      await pageA.route(/\/_matrix\/client\/v3\/sync\?/, async (route) => {
        if (injected > 0) return route.fallback()
        injected++
        return route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ errcode: 'M_UNKNOWN_TOKEN', error: 'Token is not active', soft_logout: false }),
        })
      })
      const refreshed = pageA.waitForResponse(
        (r) => r.url().endsWith('/oauth2/token') && (r.request().postData() ?? '').includes('grant_type=refresh_token'),
        { timeout: 90_000 },
      )
      expect((await refreshed).status()).toBe(200)
      await pageA.unroute(/\/_matrix\/client\/v3\/sync\?/)
      expect(injected).toBe(1)

      await send(pageA, m2)
      await expectReadable(pageL, m1, m2)
      await expect(pageA.getByRole('alert')).toHaveCount(0)
      await expect(pageB.getByText(ELSEWHERE)).toBeVisible()
      expect(neutralB.hits, 'B made no /sync, no /oauth2/token, nothing').toEqual([])
    })

    await test.step('4. B takes over: A yields by reload into the neutral screen; B reads and writes the DM', async () => {
      neutralB.on = false
      // A's ledger opens when A's reload commits: from then on A is the neutral tab.
      const neutralA = neutralLedger(pageA)
      neutralA.on = false
      pageA.once('framenavigated', () => (neutralA.on = true))
      await pageB.getByRole('button', { name: SESSION.useHere }).click()
      await expect(title(pageB)).toBeVisible({ timeout: 60_000 })
      await expect(pageA.getByText(ELSEWHERE)).toBeVisible()
      expect(neutralA.on, 'A yielded by reload').toBe(true)
      await expect(pageB.getByRole('button', { name: /^Continuar com/ })).toHaveCount(0)
      await dmWith(pageB, LIA_NAME).click()
      await expectReadable(pageB, m1, m2)
      await send(pageB, m3)
      await expectReadable(pageL, m1, m2, m3)
      await expectNoProtocolLeak(pageA, pageB)
      expect(neutralA.hits, 'requests of A after it yielded').toEqual([])
    })

    console.log(`[e2e] console kai: ${JSON.stringify(consoleK.observed())}`)
    console.log(`[e2e] console lia: ${JSON.stringify(consoleL.observed())}`)
    consoleK.expectClean()
    consoleL.expectClean()
  } finally {
    await ctxA.close()
    await ctxL.close()
  }
})

// ROTEIRO-U2 rev. 2 item 2.5, the owner that does not answer (ADR-065 D4/D5). Only the order of events
// is asserted: the wait copy, then the secondary one, then A answers, then B is in. The hold is far
// longer than the copy's delay, and no assertion reads a time.
test('a silent owner: the requester waits, tells so, and gets the tab when the owner answers', async ({ browser }) => {
  test.setTimeout(180_000)
  const ts = Date.now()
  const m1 = `tab-silent-1 ${ts}`
  const m2 = `tab-silent-2 ${ts}`

  const ctxA = await browser.newContext()
  const ctxL = await browser.newContext()
  // Boots as in the test above: A 1, B 1 ("Usar aqui"), L 1.
  const consoleK = new ConsoleLedger('kai', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  const consoleL = new ConsoleLedger('lia', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  try {
    const pageA = await ctxA.newPage()
    const pageL = await ctxL.newPage()
    consoleK.watch(pageA, 'A')
    consoleL.watch(pageL, 'L')
    await signInAndWrite(pageA, pageL, m1)

    const pageB = await ctxA.newPage()
    consoleK.watch(pageB, 'B')
    await pageB.goto('/')
    await expect(pageB.getByText(ELSEWHERE)).toBeVisible()

    const owner = await silenceOwner(pageA, 20_000)
    await test.step('1. "Usar aqui" with A silent: the wait copy, then the secondary one; B does not enter', async () => {
      await pageB.getByRole('button', { name: SESSION.useHere }).click()
      await expect(pageB.getByText(SESSION.takingOver)).toBeVisible()
      await expect(pageB.getByText(SESSION.takeoverStuck)).toBeVisible()
      expect(owner.silent(), 'the secondary copy shows while A is still silent').toBe(true)
      await expect(title(pageB)).toHaveCount(0)
      await expectNoProtocolLeak(pageB)
    })

    await test.step('2. A answers: B enters, A is neutral, and the DM reads and writes', async () => {
      await owner.done
      await expect(title(pageB)).toBeVisible({ timeout: 60_000 })
      await expect(pageA.getByText(ELSEWHERE)).toBeVisible()
      await expect(title(pageA)).toHaveCount(0)
      await dmWith(pageB, LIA_NAME).click()
      await expectReadable(pageB, m1)
      await send(pageB, m2)
      await expectReadable(pageL, m1, m2)
      await expect(pageB.getByRole('alert')).toHaveCount(0)
      await expectNoProtocolLeak(pageA, pageB)
    })

    console.log(`[e2e] console kai: ${JSON.stringify(consoleK.observed())}`)
    console.log(`[e2e] console lia: ${JSON.stringify(consoleL.observed())}`)
    consoleK.expectClean()
    consoleL.expectClean()
  } finally {
    await ctxA.close()
    await ctxL.close()
  }
})

// The full Chromium asks for the favicon; the headless shell of the rest of the tier never does.
const FULL_CHROMIUM_FAVICON: ReadonlyArray<ExpectedResponse> = [
  { url: `${APP_URL}/favicon.ico`, status: 404, max: 1, per: 'page', why: 'the app ships no favicon; only the full Chromium asks' },
]

// The two chrome.tabs verbs the discard uses, evaluated in the extension's worker.
declare const chrome: {
  tabs: {
    query(q: { active: boolean }): Promise<Array<{ id?: number }>>
    discard(id: number): Promise<{ discarded: boolean }>
  }
}

// kai's browser for the discard: a persistent context of the full Chromium with the extension, the only
// way to reach chrome.tabs.discard — the headless shell has no extensions (ADR-072, addendum to dec. 8).
async function launchWithDiscard(baseURL: string, userDataDir: string): Promise<{ context: BrowserContext; worker: Worker }> {
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    baseURL,
    args: [`--disable-extensions-except=${DISCARD_EXTENSION}`, `--load-extension=${DISCARD_EXTENSION}`],
  })
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
  return { context, worker }
}

const activeTabId = (worker: Worker): Promise<number> =>
  worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true })
    return tab!.id!
  })

// A real discard: the browser drops the tab's document. Resolves with what the browser says about the
// tab afterwards, from the call's own result: a discard replaces the tab's id.
const discardTab = (worker: Worker, tabId: number): Promise<boolean> =>
  worker.evaluate(async (id) => (await chrome.tabs.discard(id)).discarded, tabId)

// ROTEIRO-U2 rev. 2 item 2.5, the variant: the owner is discarded while it cannot answer. The lock falls
// with the document, and B, waiting, enters by itself: nobody clicks anything after "Usar aqui".
test('a discarded owner: the lock falls with the tab and the waiting tab enters alone', async ({ browser, baseURL }) => {
  test.setTimeout(180_000)
  const ts = Date.now()
  const m1 = `tab-discard-1 ${ts}`
  const m2 = `tab-discard-2 ${ts}`

  const userDataDir = await mkdtemp(join(tmpdir(), 'tayet-e2e-discard-'))
  const { context: ctxA, worker } = await launchWithDiscard(baseURL!, userDataDir)
  const ctxL = await browser.newContext()
  // Boots: A 1 (login); B 1 (when the lock falls); L 1.
  const consoleK = new ConsoleLedger('kai', [...FIRST_LOGIN_404, ...recognizedSet404(1), ...FULL_CHROMIUM_FAVICON])
  const consoleL = new ConsoleLedger('lia', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  try {
    const pageA = ctxA.pages()[0] ?? (await ctxA.newPage())
    const pageL = await ctxL.newPage()
    consoleK.watch(pageA, 'A')
    consoleL.watch(pageL, 'L')
    await signInAndWrite(pageA, pageL, m1)

    await pageA.bringToFront()
    const tabA = await activeTabId(worker)
    const pageB = await ctxA.newPage()
    consoleK.watch(pageB, 'B')
    await pageB.goto('/')
    await expect(pageB.getByText(ELSEWHERE)).toBeVisible()
    await pageB.bringToFront()
    expect(await activeTabId(worker), 'the tab to discard is not the active one').not.toBe(tabA)

    await test.step('1. "Usar aqui" with A silent: B waits and tells so', async () => {
      await silenceOwner(pageA, 60_000)
      await pageB.getByRole('button', { name: SESSION.useHere }).click()
      await expect(pageB.getByText(SESSION.takeoverStuck)).toBeVisible()
      await expect(title(pageB)).toHaveCount(0)
    })

    await test.step('2. the browser discards A: B enters by itself and the DM reads and writes', async () => {
      expect(await discardTab(worker, tabA), 'the browser reports the tab discarded').toBe(true)
      await expect(title(pageB)).toBeVisible({ timeout: 30_000 })
      await dmWith(pageB, LIA_NAME).click()
      await expectReadable(pageB, m1)
      await send(pageB, m2)
      await expectReadable(pageL, m1, m2)
      await expect(pageB.getByRole('alert')).toHaveCount(0)
      await expectNoProtocolLeak(pageB)
    })

    console.log(`[e2e] console kai: ${JSON.stringify(consoleK.observed())}`)
    console.log(`[e2e] console lia: ${JSON.stringify(consoleL.observed())}`)
    consoleK.expectClean()
    consoleL.expectClean()
  } finally {
    await ctxA.close()
    await ctxL.close()
    await rm(userDataDir, { recursive: true, force: true })
  }
})
