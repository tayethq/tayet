import { test, expect, type Page } from '@playwright/test'
import { IPHONE_SAFARI_UA, IRA } from './fixtures/users'
import { signIn } from './support/login'
import { conversations } from './support/workspace'
import { expectNoProtocolLeak } from './support/assertions'
import { ConsoleLedger, FIRST_LOGIN_404, recognizedSet404 } from './support/console'
import { ACCOUNT, ACCOUNT_PHONE, APP, DATA_EXPORT, PROFILE_EDITOR } from './support/labels'

// Phone project (PLANO-MOBILE M7, account-access.md §13.2, edit-profile.md §9): "Sua conta" as screens of the
// stack. ira walks it level by level with the system's back, opens the reset and cancels (it never resets),
// saves a nickname and puts the old one back; with the iPhone Safari's user agent, the install row and sheet.

const depth = (page: Page) => page.evaluate(() => (history.state as { depth?: number } | null)?.depth ?? 0)
const region = (page: Page, name: string) => page.getByRole('region', { name, exact: true })

async function openAccount(page: Page) {
  await page.getByRole('button', { name: APP.account, exact: true }).click()
  const account = region(page, ACCOUNT.dialog)
  await expect(account).toBeVisible()
  await expect.poll(() => depth(page)).toBe(1)
  return account
}

test('account, accesses, reset and back, level by level; the nickname saves', async ({ page }) => {
  test.setTimeout(150_000)
  const ledger = new ConsoleLedger('ira', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  ledger.watch(page, 'ira')
  await signIn(page, IRA)
  await expect(conversations(page)).toBeVisible()
  const appUrl = page.url()
  // A reset opens a window and asks the escrow to end the other accesses: neither may happen here.
  let resets = 0
  page.on('popup', () => (resets += 1))
  page.on('request', (r) => {
    if (r.url().includes('/account/revoke-others')) resets += 1
  })

  const account = await openAccount(page)
  await expect(conversations(page)).toHaveCount(0)
  await expect(account.getByText(ACCOUNT_PHONE.exportDesktopOnly)).toBeVisible()
  await expect(account.getByRole('button', { name: new RegExp(DATA_EXPORT.entry) })).toHaveCount(0)
  await expect(account.getByRole('button', { name: new RegExp(`^${ACCOUNT_PHONE.openOnPhone}`) })).toHaveCount(0)
  // This is not the iPhone's Safari.
  await expect(account.getByRole('button', { name: new RegExp(`^${ACCOUNT_PHONE.installRow}`) })).toHaveCount(0)
  await expectNoProtocolLeak(page)

  await account.getByRole('button', { name: new RegExp(`^${ACCOUNT.accesses}`) }).click()
  const accesses = region(page, ACCOUNT.accesses)
  await expect(accesses).toBeVisible()
  await expect.poll(() => depth(page)).toBe(2)
  const box = accesses.getByRole('button', { name: new RegExp(`^${ACCOUNT.resetEntry}`) })
  await box.click()
  const sheet = page.getByRole('alertdialog', { name: ACCOUNT.resetEntry })
  await expect(sheet).toBeVisible()
  await expect(sheet.getByRole('button', { name: ACCOUNT_PHONE.cancel })).toBeFocused()
  await expect.poll(() => depth(page)).toBe(3)
  await expectNoProtocolLeak(page)
  await sheet.getByRole('button', { name: ACCOUNT_PHONE.cancel }).click()
  await expect(sheet).toHaveCount(0)
  await expect.poll(() => depth(page)).toBe(2)

  // Again, and out with the system's back, one level at a time.
  await box.click()
  await expect(sheet).toBeVisible()
  await expect.poll(() => depth(page)).toBe(3)
  await page.goBack()
  await expect(sheet).toHaveCount(0)
  await expect(accesses).toBeVisible()
  await expect.poll(() => depth(page)).toBe(2)
  await page.goBack()
  await expect(accesses).toHaveCount(0)
  await expect(account).toBeVisible()
  await expect.poll(() => depth(page)).toBe(1)

  await account.getByRole('button', { name: ACCOUNT.edit, exact: true }).click()
  const editor = region(page, PROFILE_EDITOR.dialog)
  const nickname = editor.getByLabel(PROFILE_EDITOR.nickname, { exact: true })
  await expect(nickname).toBeVisible()
  await expect.poll(() => depth(page)).toBe(2)
  const before = await nickname.inputValue()
  const save = editor.getByRole('button', { name: PROFILE_EDITOR.save, exact: true })
  await expect(save).toBeDisabled()
  const saved = editor.getByRole('status').filter({ hasText: PROFILE_EDITOR.saved })
  await nickname.fill(`Ira ${Date.now()}`)
  await save.click()
  await expect(saved).toBeVisible()
  await expectNoProtocolLeak(page)
  // The profile persists across local runs: put back what was found.
  await nickname.fill(before)
  await save.click()
  await expect(saved).toBeVisible()

  await page.goBack()
  await expect(editor).toHaveCount(0)
  await expect(account).toBeVisible()
  await expect.poll(() => depth(page)).toBe(1)
  await page.goBack()
  await expect(account).toHaveCount(0)
  await expect(conversations(page)).toBeVisible()
  await expect.poll(() => depth(page)).toBe(0)
  expect(page.url()).toBe(appUrl)
  expect(resets).toBe(0)
  ledger.expectClean()
})

test.describe("the iPhone's Safari", () => {
  test.use({ userAgent: IPHONE_SAFARI_UA })

  test('the install row opens the sheet, and "Agora não" closes it', async ({ page }) => {
    test.setTimeout(120_000)
    await page.addInitScript(() => localStorage.setItem('tayet.install-dismissed', '1'))
    await signIn(page, IRA)
    const account = await openAccount(page)
    const row = account.getByRole('button', { name: new RegExp(`^${ACCOUNT_PHONE.installRow}`) })
    await row.click()
    const sheet = page.getByRole('dialog', { name: ACCOUNT_PHONE.installSheet })
    await expect(sheet).toBeVisible()
    await expect.poll(() => depth(page)).toBe(2)
    await expectNoProtocolLeak(page)
    await sheet.getByRole('button', { name: ACCOUNT_PHONE.notNow }).click()
    await expect(sheet).toHaveCount(0)
    await expect(row).toBeFocused()
    await expect.poll(() => depth(page)).toBe(1)
  })
})
