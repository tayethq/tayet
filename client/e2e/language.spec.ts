import { test, expect, type Page } from '@playwright/test'
import { LIN } from './fixtures/users'
import { signInAgainSilently } from './support/account'
import { expectNoProtocolLeak } from './support/assertions'
import { ConsoleLedger, FIRST_LOGIN_404, recognizedSet404 } from './support/console'
import { APP, LANGUAGE, LIST, SESSION } from './support/labels'
import { leaveAppForLogin, loginThroughDex, onApp, pinAppLocale } from './support/login'
import { hasCrossSigningMaster } from './support/server-facts'

// The language, end to end, on a device in English (the browser reports en-US and sends it as
// Accept-Language, so the MAS login pages are in English too, and stay so after the account picks
// Português: they follow the browser, not the account, ADR-109). lin's account starts on Automatic.
// 1. The sign-in screen is in English; after the login, the app is too.
// 2. "Your account" names the device's language: English.
// 3. "Português" is written to the account and the page reloads in pt-BR, "Em todos os seus aparelhos".
//    Then the return from the provider: signed out, the device's copy gone (a new device of the account),
//    back in — the app boots in English from the device and reloads into the account's pt-BR.
// 4. "Automático": back to English.
// 5. With the app in English, a PNG of the search field with the scope chip, attached to the result.
// 6. Signed out, the sign-in screen stays in English.
// No request for the account's preferences may 404, here or in any spec: the ledger allows none.

// App boots of the page, each one reading the recognized set once (support/console.ts): the login, the
// reload into pt-BR, the second login, its reload into pt-BR, the reload back to Automatic.
const BOOTS = 5

const footer = (page: Page, name: string) => page.getByRole('button', { name, exact: true })
const title = (page: Page) => page.getByRole('heading', { name: APP.title, level: 1 })

// Open "Your account" / "Sua conta" and hand back the dialog's language row.
async function languageRow(page: Page, account: string, control: string) {
  await footer(page, account).click()
  const dialog = page.getByRole('dialog', { name: account })
  await expect(dialog).toBeVisible()
  const select = dialog.getByRole('combobox', { name: control })
  await expect(select).toBeVisible()
  return { dialog, select }
}

// Pick an option and wait for the reload that follows the server's confirmation.
async function pickAndReload(page: Page, select: ReturnType<Page['getByRole']>, label: string): Promise<void> {
  const reloaded = page.waitForEvent('load')
  await select.selectOption({ label })
  await reloaded
  await expect(title(page)).toBeVisible()
}

test('language: an English device, the account set to Português and back to Automatic', async ({ page }) => {
  test.setTimeout(240_000)
  const ledger = new ConsoleLedger('language', [...FIRST_LOGIN_404, ...recognizedSet404(BOOTS)])
  ledger.watch(page, 'lin')
  await pinAppLocale(page, 'en-US')
  // An account's first login sets up its keys in the background after connect: identity, then the key
  // backup. A reload before the backup exists leaves the setup to a later page that lives long enough
  // to retry it (about 15 s), and every boot until then probes the missing backup. On a new account
  // (CI starts from zero) the spec waits for the backup to be created before it changes the language.
  const newAccount = !(await hasCrossSigningMaster('lin'))
  const backupCreated = newAccount
    ? page.waitForResponse(
        (r) => r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/room_keys/version') && r.ok(),
        { timeout: 120_000 },
      )
    : undefined

  // 1. Sign-in screen and app in English. The account may carry a choice from an earlier local run.
  await page.goto('/')
  await expect(page.getByText(LANGUAGE.en.signInTitle, { exact: true })).toBeVisible()
  const sso = page.getByRole('button', { name: 'Continue with Dex (local)' })
  await expect(sso).toBeVisible()
  await leaveAppForLogin(page, sso)
  await loginThroughDex(page, LIN, { masLanguage: 'en' })
  await expect(title(page)).toBeVisible()
  await expect(footer(page, LANGUAGE.en.account)).toBeVisible()
  await expectNoProtocolLeak(page)

  // 2. Automatic: the subtitle names the device's language.
  const en = await languageRow(page, LANGUAGE.en.account, LANGUAGE.en.control)
  await expect(en.select).toHaveValue('auto')
  await expect(en.dialog.getByText(LANGUAGE.en.device(LANGUAGE.en.english), { exact: true })).toBeVisible()

  // 3. "Português": the account first, then the reload in pt-BR.
  await backupCreated
  await pickAndReload(page, en.select, LANGUAGE.en.portuguese)
  await expect(footer(page, APP.account)).toBeVisible()
  const pt = await languageRow(page, APP.account, LANGUAGE.pt.control)
  await expect(pt.select).toHaveValue('pt-BR')
  await expect(pt.dialog.getByText(LANGUAGE.pt.everywhere, { exact: true })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('tayet.locale'))).toBe('pt-BR')
  await expectNoProtocolLeak(page)

  // 3, the return from the provider: sign out, drop the copy, sign back in. The callback boots in
  // English (no copy, English device) and the reconciliation reloads into the account's pt-BR.
  await pt.dialog.getByRole('button', { name: SESSION.signOut }).click()
  await expect(page.getByRole('button', { name: SESSION.signInAgain })).toBeVisible()
  await page.evaluate(() => localStorage.removeItem('tayet.locale'))
  const backIn = page.waitForEvent('load', { predicate: (p) => onApp(p.url()) && !p.url().includes('code=') })
  await signInAgainSilently(page, 'en')
  await backIn
  await expect(footer(page, APP.account)).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.lang)).toBe('pt-BR')
  expect(await page.evaluate(() => localStorage.getItem('tayet.locale'))).toBe('pt-BR')

  // 4. "Automático": back to English.
  const again = await languageRow(page, APP.account, LANGUAGE.pt.control)
  await pickAndReload(page, again.select, LANGUAGE.pt.auto)
  await expect(footer(page, LANGUAGE.en.account)).toBeVisible()
  const back = await languageRow(page, LANGUAGE.en.account, LANGUAGE.en.control)
  await expect(back.select).toHaveValue('auto')
  await expect(back.dialog.getByText(LANGUAGE.en.device(LANGUAGE.en.english), { exact: true })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('tayet.locale'))).toBeNull()
  await back.dialog.getByRole('button', { name: LANGUAGE.en.close, exact: true }).click()
  await expect(back.dialog).toHaveCount(0)

  // 5. The search field with the scope chip, in English: the chip shows with a conversation open (the
  // org channel; its name comes from the server, not the catalog).
  await page.getByRole('button', { name: new RegExp(`^${LIST.orgChannel}(\\s|$)`) }).click()
  await page.getByRole('textbox', { name: LANGUAGE.en.searchField }).fill('quarterly report')
  await expect(page.getByRole('button', { name: LANGUAGE.en.scoped })).toBeVisible()
  await test.info().attach('search-scope-chip-en', { body: await page.locator('.search').screenshot(), contentType: 'image/png' })
  await page.getByRole('textbox', { name: LANGUAGE.en.searchField }).fill('')
  await expectNoProtocolLeak(page)

  // 6. Signed out, the screens stay in English: the access-ended screen, and the sign-in after a reload.
  await footer(page, LANGUAGE.en.account).click()
  await page.getByRole('button', { name: LANGUAGE.en.signOut }).click()
  await expect(page.getByText(LANGUAGE.en.ended)).toBeVisible()
  await expect(page.getByRole('button', { name: LANGUAGE.en.signInAgain })).toBeVisible()
  await page.reload()
  await expect(page.getByText(LANGUAGE.en.signInTitle, { exact: true })).toBeVisible()

  ledger.expectClean()
  test.info().annotations.push({ type: 'console', description: JSON.stringify(ledger.observed()) })
})
