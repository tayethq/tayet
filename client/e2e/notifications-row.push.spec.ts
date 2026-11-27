import { test, expect, type BrowserContext, type Locator, type Page, type Worker } from '@playwright/test'
import { fabricatedSubscription, startPushReceiver, type PushReceiver } from '../test/support/push-subscription'
import { NINA, OMAR } from './fixtures/users'
import { AFTER_RELOGIN_404, BACKUP_LOOKUPS_WHY, backupLookupsCap, ConsoleLedger, FIRST_LOGIN_404, recognizedSet404 } from './support/console'
import { pinAppLocale, signIn } from './support/login'
import { accountSettings, closeAccount, signInAgain } from './support/account'
import { deleteSharedRooms } from './support/rooms'
import { FAKE_PUSH_FLAG, fakePushManager } from './support/push'
import { pushersOf } from './support/server-facts'
import { dmWith, orgChannel, send, startDm, title } from './support/workspace'
import { ACCOUNT, DEVICE_NOTIFICATIONS, LIST, SESSION } from './support/labels'

// ADR-117, addendum of 26/Nov/2026 (PR 5b of the push track): the "Notificações" row of "Sua conta", the list's
// prompt that also subscribes, turning off, and the sign-out that ends the subscription. The push project only
// (playwright.config.ts). omar writes; nina is the device under test.
//
// How the browser is driven:
// - the subscription is fabricated: an init script replaces `subscribe`, `getSubscription` and `unsubscribe` of the
//   PushManager prototype (Phase 0 of this PR: in the Playwright context, `pushManager.subscribe` rejects with
//   `AbortError: Registration failed - permission denied`, and in a persistent context it does not settle in 30 s).
//   Its keys have the browser's shape (test/support/push-subscription.ts) and its endpoint is a receiver in this
//   process, as the push service reaches it from the dev-stack (host.docker.internal, which the dev-stack allows).
//   The fake subscription lives in the page's storage, so it survives a reload as a real one does;
// - the server's list of subscriptions is read by the admin API after each case (support/server-facts.ts);
// - the live tab's notifications are read from the worker's registration (`getNotifications`), as in
//   service-worker.push.spec.ts: a push to the fabricated endpoint never reaches the browser, so every notification
//   there is the live tab's.
//
// Needs (round 2 of the PR): nina and omar in the Dex allowlist and in directory.tsv; a build with
// VITE_PUSH_PUBLIC_KEY (without it the row is hidden, F3).

const NINA_NAME = 'nina'
const OMAR_NAME = 'omar'
// A negative assertion: the message was read on screen, then a beat for a notification that must not exist.
const SETTLE_MS = 1_500
// The worker's store, as src/sw/store.ts writes it (e2e imports nothing from src).
const SW_CACHE = 'tayet-sw'
const PENDING_KEY = '/__tayet-sw/pending'
const LOCALE_KEY = '/__tayet-sw/locale'

type WorkerSelf = { registration: ServiceWorkerRegistration }

async function worker(ctx: BrowserContext): Promise<Worker> {
  const found = ctx.serviceWorkers().find((w) => w.url().endsWith('/sw.js'))
  return found ?? (await ctx.waitForEvent('serviceworker', { predicate: (w) => w.url().endsWith('/sw.js') }))
}

async function shownBy(ctx: BrowserContext): Promise<Array<{ title: string; body: string }>> {
  return (await worker(ctx)).evaluate(async () => {
    const ns = await (self as unknown as WorkerSelf).registration.getNotifications()
    return ns.map((n) => ({ title: n.title, body: n.body }))
  })
}

async function closeAll(ctx: BrowserContext): Promise<void> {
  await (await worker(ctx)).evaluate(async () => {
    for (const n of await (self as unknown as WorkerSelf).registration.getNotifications()) n.close()
  })
}

const fakeSubscribed = (page: Page): Promise<boolean> => page.evaluate((f) => localStorage.getItem(f) !== null, FAKE_PUSH_FLAG)

// The server holds nina's subscription to this run's receiver (and nothing else of the app).
async function serverHolds(endpoint: string): Promise<boolean> {
  const mine = (await pushersOf(NINA_NAME)).filter((p) => p.appId === 'io.tayet.web')
  return mine.length === 1 && mine[0]!.endpoint === endpoint
}
const serverEmpty = async (): Promise<boolean> => (await pushersOf(NINA_NAME)).filter((p) => p.appId === 'io.tayet.web').length === 0

async function section(page: Page): Promise<{ dialog: Locator; state: Locator; turnOn: Locator; turnOff: Locator }> {
  const dialog = await accountSettings(page)
  const region = dialog.locator('section').filter({ has: page.getByRole('heading', { name: DEVICE_NOTIFICATIONS.section }) })
  return {
    dialog,
    state: region.getByRole('status'),
    turnOn: region.getByRole('button', { name: DEVICE_NOTIFICATIONS.turnOn, exact: true }),
    turnOff: region.getByRole('button', { name: DEVICE_NOTIFICATIONS.turnOff, exact: true }),
  }
}

let receiver: PushReceiver

test.beforeAll(async () => {
  await deleteSharedRooms(NINA_NAME, OMAR_NAME)
  receiver = await startPushReceiver()
})

test.afterAll(async () => {
  await receiver?.close()
})

test('the "Notificações" row: on by the row and by the prompt, off, and the sign-out that ends the subscription', async ({ browser }) => {
  test.setTimeout(300_000)
  const ts = Date.now()
  const sub = fabricatedSubscription(receiver.endpoint(`nina-${ts}`))
  const ctxO = await browser.newContext()
  const ctxN = await browser.newContext()
  await ctxN.grantPermissions(['notifications'])
  await ctxN.addInitScript(fakePushManager, sub)
  // Boots: omar 1; nina, on her one page: the login, the reload of case 5, the login after it (3, seen in round 2).
  const consoleO = new ConsoleLedger('omar', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  const consoleN = new ConsoleLedger('nina', [...FIRST_LOGIN_404, ...recognizedSet404(3)])
  const prompt = (page: Page) => page.getByRole('button', { name: LIST.enableNotifications })
  try {
    const pageO = await ctxO.newPage()
    const pageN = await ctxN.newPage()
    consoleO.watch(pageO, 'O')
    consoleN.watch(pageN, 'N')
    await pinAppLocale(pageN)

    await test.step('setup: both in, a DM between them, nina on the org channel', async () => {
      await signIn(pageO, OMAR)
      await signIn(pageN, NINA)
      await startDm(pageO, NINA_NAME)
      await expect(dmWith(pageN, OMAR_NAME)).toBeVisible()
      await orgChannel(pageN).click()
      expect(await serverEmpty()).toBe(true)
    })

    await test.step('3. on by the list prompt (granted, no preference): the server holds the subscription; a DM notifies', async () => {
      await expect(prompt(pageN)).toBeVisible()
      await prompt(pageN).click()
      await expect(prompt(pageN)).toHaveCount(0)
      await expect.poll(() => serverHolds(sub.endpoint)).toBe(true)
      expect(await fakeSubscribed(pageN)).toBe(true)
      // The live tab notifies (the DM is not the selected conversation), and the push reaches the receiver.
      await dmWith(pageO, NINA_NAME).click()
      const text = `on by the prompt ${ts}`
      await send(pageO, text)
      await expect.poll(async () => (await shownBy(ctxN)).some((n) => n.body === text)).toBe(true)
      // The tab's title counts what notifies (ADR-073 dec. 7): the DM's one unread.
      await expect.poll(() => pageN.title()).toBe('(1) Tayet')
      await expect.poll(() => receiver.arrivals.some((p) => p.endsWith(`/nina-${ts}`))).toBe(true)
      await closeAll(ctxN)
      const row = await section(pageN)
      await expect(row.state).toHaveText(DEVICE_NOTIFICATIONS.on)
      await closeAccount(pageN)
    })

    await test.step('2. off by the row: the list is empty and a new DM does not notify the live tab', async () => {
      const row = await section(pageN)
      await row.turnOff.click()
      await expect(row.state).toHaveText(DEVICE_NOTIFICATIONS.off)
      await expect(row.turnOn).toBeVisible()
      await expect.poll(() => serverEmpty()).toBe(true)
      expect(await fakeSubscribed(pageN)).toBe(false)
      await closeAccount(pageN)
      const text = `after off ${ts}`
      await send(pageO, text)
      // Read on nina's side: the title counts the DM's second unread.
      await expect.poll(() => pageN.title()).toBe('(2) Tayet')
      await pageN.waitForTimeout(SETTLE_MS)
      expect(await shownBy(ctxN)).toEqual([])
      // Off is a choice: the prompt does not come back.
      await expect(prompt(pageN)).toHaveCount(0)
    })

    await test.step('1. on by the row: the server holds the subscription again', async () => {
      const row = await section(pageN)
      await row.turnOn.click()
      await expect(row.state).toHaveText(DEVICE_NOTIFICATIONS.on)
      await expect(row.turnOff).toBeVisible()
      await expect.poll(() => serverHolds(sub.endpoint)).toBe(true)
      await closeAccount(pageN)
    })

    await test.step('5. reload with the device on, sign out without opening "Sua conta": the list is empty (F2)', async () => {
      await pageN.reload()
      await expect(title(pageN)).toBeVisible()
      // The opening's check registered the subscription in this page: the ACL's sign-out can remove it. Read once,
      // right on the sign-out screen — the revocation of the access also removes it, a moment later.
      await pageN.getByRole('button', { name: ACCOUNT.dialog }).click()
      await pageN.getByRole('button', { name: SESSION.signOut }).click()
      await expect(pageN.getByRole('button', { name: SESSION.signInAgain })).toBeVisible()
      expect(await serverEmpty()).toBe(true)
      expect(await fakeSubscribed(pageN)).toBe(false)
    })

    await test.step('4. sign out with a pending click target: the list is empty and the target is gone, the language stays', async () => {
      // The login after case 5 is a new access: reading omar's DM it may ask the key backup for the session of his two
      // messages before the key reaches it (one Megolm session; the ADR-077 cap, as account.spec.ts does).
      consoleN.allow([{ ...AFTER_RELOGIN_404[0]!, max: backupLookupsCap(1), why: BACKUP_LOOKUPS_WHY(1) }])
      await signInAgain(pageN, NINA)
      // The preference went with the sign-out: the prompt is back, and turns the device on.
      await expect(prompt(pageN)).toBeVisible()
      await prompt(pageN).click()
      await expect.poll(() => serverHolds(sub.endpoint)).toBe(true)
      await pageN.evaluate(
        async ({ cache, key }) => {
          const c = await caches.open(cache)
          await c.put(key, new Response(JSON.stringify({ target: { conversation: 'pending' }, at: Date.now() })))
        },
        { cache: SW_CACHE, key: PENDING_KEY },
      )
      await pageN.getByRole('button', { name: ACCOUNT.dialog }).click()
      await pageN.getByRole('button', { name: SESSION.signOut }).click()
      await expect(pageN.getByRole('button', { name: SESSION.signInAgain })).toBeVisible()
      await expect.poll(() => serverEmpty()).toBe(true)
      const left = await pageN.evaluate(
        async ({ cache, pending, locale }) => {
          const c = await caches.open(cache)
          return { pending: (await c.match(pending)) !== undefined, locale: (await c.match(locale)) !== undefined }
        },
        { cache: SW_CACHE, pending: PENDING_KEY, locale: LOCALE_KEY },
      )
      expect(left).toEqual({ pending: false, locale: true })
      expect(await fakeSubscribed(pageN)).toBe(false)
    })

    console.log(`[e2e] console O: ${JSON.stringify(consoleO.observed())}`)
    console.log(`[e2e] console N: ${JSON.stringify(consoleN.observed())}`)
    console.log(`[e2e] receiver deliveries to this run's subscription: ${receiver.arrivals.filter((p) => p.endsWith(`/nina-${ts}`)).length}`)
    consoleO.expectClean()
    consoleN.expectClean()
  } finally {
    await ctxO.close()
    await ctxN.close()
  }
})
