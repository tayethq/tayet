import { test, expect } from '@playwright/test'
import { IPHONE_SAFARI_UA, ZAK } from './fixtures/users'
import { leaveAppForLogin, loginThroughDex, onApp, pinAppLocale } from './support/login'
import { expectNoProtocolLeak } from './support/assertions'
import { ACCOUNT_PHONE, APP } from './support/labels'

// Phone project: the login completes when the provider's return lands in a fresh browsing context.
// The installed app on a phone can reopen the page instead of the tab that left; a new tab of the same
// browser context reproduces that: empty sessionStorage, shared localStorage. The return is held in the
// tab that left (never touching the provider's pages) and replayed in a new tab.

const COPY_KEY = 'tayet.login-state-copy'
const SDK_STATE_PREFIX = 'mx_oidc_'

test('login completes when the return from the provider opens in a new tab', async ({ page, context }) => {
  await pinAppLocale(page)

  // Hold the return on the app side: when this tab lands back on the app with ?code&state, the app's
  // scripts are refused, so the document loads but the app never runs and this tab never runs the
  // exchange. (A route on the callback itself cannot hold it: the return is a redirect from the
  // provider, and route handlers see only the first hop.) The provider's pages are not touched.
  const isCallbackDoc = (href: string): boolean => {
    const u = new URL(href)
    return onApp(u.href) && u.searchParams.has('code') && u.searchParams.has('state')
  }
  const appScript = (u: URL): boolean => onApp(u.href) && u.pathname.endsWith('.js')
  await page.route(appScript, (route) =>
    isCallbackDoc(route.request().frame().url()) ? route.abort('blockedbyclient') : route.continue(),
  )

  await page.goto('/')
  const sso = page.getByRole('button', { name: 'Continuar com Dex (local)' })
  await expect(sso).toBeVisible()
  await leaveAppForLogin(page, sso)
  await loginThroughDex(page, ZAK)
  // Back on the app with the callback still in the address bar: the app never ran here (it scrubs the
  // callback on success and on failure). The URL is kept, never printed.
  const held = page.url()
  expect(new URL(held).searchParams.has('code')).toBe(true)
  await expect(page.getByRole('heading', { name: APP.title, level: 1 })).toHaveCount(0)
  expect(new URL(page.url()).searchParams.has('code')).toBe(true)
  await page.unroute(appScript)

  // The copy is waiting in the shared storage.
  expect(await page.evaluate((k) => localStorage.getItem(k) !== null, COPY_KEY)).toBe(true)

  // A new tab: it starts with no SDK state of its own (counted at document start, before the app runs).
  const tab = await context.newPage()
  await tab.addInitScript((prefix) => {
    const count = Object.keys(sessionStorage).filter((k) => k.startsWith(prefix)).length
    ;(window as unknown as { __sdkStateAtStart: number }).__sdkStateAtStart = count
  }, SDK_STATE_PREFIX)
  await tab.goto(held)

  await expect(tab.getByRole('heading', { name: APP.title, level: 1 })).toBeVisible()
  expect(await tab.evaluate(() => (window as unknown as { __sdkStateAtStart: number }).__sdkStateAtStart)).toBe(0)
  expect(tab.url()).not.toContain('code=')
  expect(tab.url()).not.toContain('state=')
  // The copy is gone once the return is handled, and so is the SDK state.
  expect(await tab.evaluate((k) => localStorage.getItem(k), COPY_KEY)).toBeNull()
  expect(
    await tab.evaluate((prefix) => Object.keys(sessionStorage).filter((k) => k.startsWith(prefix)).length, SDK_STATE_PREFIX),
  ).toBe(0)
  await expectNoProtocolLeak(tab)
})

test('the app declares its manifest: standalone, named Tayet', async ({ page }) => {
  const index = await page.request.get('/')
  expect(index.status()).toBe(200)
  expect(await index.text()).toMatch(/<link rel="manifest" href="\/site\.webmanifest"\s*\/?>/)

  await page.goto('/')
  await expect(page.locator('head link[rel="manifest"]')).toHaveAttribute('href', '/site.webmanifest')

  const res = await page.request.get('/site.webmanifest')
  expect(res.status()).toBe(200)
  const manifest = (await res.json()) as Record<string, unknown>
  expect(manifest.name).toBe('Tayet')
  expect(manifest.display).toBe('standalone')
})

test.describe("the iPhone's Safari", () => {
  test.use({ userAgent: IPHONE_SAFARI_UA })

  test('no session: the install sheet; "Continuar no navegador" closes it, and a reload does not bring it back', async ({ page }) => {
    await pinAppLocale(page)
    await page.goto('/')
    const sheet = page.getByRole('dialog', { name: ACCOUNT_PHONE.installSheet })
    const entry = page.getByRole('button', { name: 'Continuar com Dex (local)' })
    await expect(sheet).toBeVisible()
    await expectNoProtocolLeak(page)
    await sheet.getByRole('button', { name: ACCOUNT_PHONE.continueInBrowser }).click()
    await expect(sheet).toHaveCount(0)
    await expect(entry).toBeFocused()
    await page.reload()
    await expect(entry).toBeVisible()
    await expect(sheet).toHaveCount(0)
  })
})
