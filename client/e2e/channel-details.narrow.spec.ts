import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { TITO, VANI, YARA } from './fixtures/users'
import { expectNoProtocolLeak } from './support/assertions'
import { ConsoleLedger, FIRST_LOGIN_404, recognizedSet404 } from './support/console'
import { LIST, MANAGE, PROFILE } from './support/labels'
import { signIn } from './support/login'
import { addMember, createChannel, deleteSharedRooms, openManage } from './support/rooms'
import { channelFacts, liftSendLimit } from './support/server-facts'
import { channelRow, conversations } from './support/workspace'

// Phone project (channel-management.md §13.2 and §14; PLANO-MOBILE §0.21 and §0.22): a channel's details as screens
// of the stack. tito creates the channel on a wide window, adds vani, and a second channel with yara so she is in his
// known set; then, at 390×844 with touch, he opens the details from the channel's ⋯, renames, changes vani's role
// from her sheet, adds yara through the picker with its filter, removes her with the confirm, and walks back level by
// level. vani, a member on her phone, may neither change roles nor remove (ADR-115): she reads the details and a row
// opens the profile, then she leaves. tito archives.
// One ledger per person.

const TITO_NAME = 'tito'
const VANI_NAME = 'vani'
const YARA_NAME = 'yara'
const BACK = 'Voltar'
const ts = Date.now()
const CHANNEL = `detalhes-${ts}`
const RENAMED = `detalhes-novo-${ts}`
const AUX = `apoio-${ts}`

const people = [
  { name: TITO_NAME, user: TITO, phone: true },
  { name: VANI_NAME, user: VANI, phone: true },
  { name: YARA_NAME, user: YARA, phone: false },
]
const ledgers = people.map((p) => new ConsoleLedger(p.name, [...FIRST_LOGIN_404, ...recognizedSet404(1)]))
const contexts: BrowserContext[] = []
let tito: Page
let vani: Page

const depth = (page: Page) => page.evaluate(() => (history.state as { depth?: number } | null)?.depth ?? 0)
const details = (page: Page) => page.getByRole('region', { name: MANAGE.details, exact: true })
const picker = (page: Page) => page.getByRole('region', { name: MANAGE.addMember, exact: true })
const rowOf = (page: Page, name: string) => details(page).getByRole('listitem').filter({ hasText: name })
const sheetOf = (page: Page, name: string) => page.getByRole('dialog', { name, exact: true })
const main = (page: Page) => page.getByRole('main')

async function toList(page: Page): Promise<void> {
  const from = await depth(page)
  for (let d = from - 1; d >= 0; d--) {
    await page.goBack()
    await expect.poll(() => depth(page)).toBe(d)
  }
  await expect(conversations(page)).toBeVisible()
}
async function openDetails(page: Page, name: string): Promise<void> {
  await channelRow(page, name).click()
  await main(page).getByRole('button', { name: MANAGE.open(`#${name}`) }).click()
  await expect(details(page)).toBeVisible()
  await expect.poll(() => depth(page)).toBe(2)
}
// After a resize, one assertion reads the final state: the narrow width, and the stack holding the conversation the
// wide window had selected (its entry is pushed after the resize), so the walk back to the list counts it.
async function narrow(page: Page, depthInFront: number): Promise<void> {
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(async () => {
    expect(await page.evaluate(() => window.innerWidth)).toBe(390)
    await expect(conversations(page).getByRole('button', { name: LIST.newChannel })).toHaveCount(0, { timeout: 1_000 })
    expect(await depth(page)).toBe(depthInFront)
  }).toPass({ timeout: 15_000 })
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000)
  await deleteSharedRooms(TITO_NAME, VANI_NAME)
  await deleteSharedRooms(TITO_NAME, YARA_NAME)
  const pages: Page[] = []
  for (const [i, person] of people.entries()) {
    const ctx = await browser.newContext(
      person.phone ? undefined : { viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 },
    )
    contexts.push(ctx)
    const page = await ctx.newPage()
    ledgers[i]!.watch(page, person.name)
    if (person.name === TITO_NAME) await page.setViewportSize({ width: 1280, height: 800 })
    await signIn(page, person.user)
    pages.push(page)
  }
  tito = pages[0]!
  vani = pages[1]!
  // The scenario writes more state than the local rc_message burst lets through.
  await liftSendLimit(TITO_NAME)
  await createChannel(tito, { name: AUX, kind: 'public' })
  await openManage(tito, AUX)
  await addMember(tito, YARA_NAME)
  await tito.getByRole('button', { name: MANAGE.close }).click()
  await createChannel(tito, { name: CHANNEL, kind: 'public' })
  await openManage(tito, CHANNEL)
  await addMember(tito, VANI_NAME)
  await tito.getByRole('button', { name: MANAGE.close }).click()
  await expect(channelRow(vani, CHANNEL)).toBeVisible({ timeout: 60_000 })
  // The channel just created is selected: on the narrow window the conversation is in front, one entry deep.
  await narrow(tito, 1)
  await toList(tito)
})

test.afterAll(async () => {
  for (const ctx of contexts) await ctx.close()
  await deleteSharedRooms(TITO_NAME, VANI_NAME)
  await deleteSharedRooms(TITO_NAME, YARA_NAME)
})

test('1. the details from the ⋯ of the channel, and a rename', async () => {
  await openDetails(tito, CHANNEL)
  await expect(details(tito).getByRole('button', { name: BACK })).toBeFocused()
  await expect(main(tito)).toHaveCount(0)
  await expect(tito.getByRole('dialog')).toHaveCount(0)
  const add = (await details(tito).getByRole('button', { name: MANAGE.addMember }).boundingBox())!
  expect(add.height).toBeGreaterThanOrEqual(44)
  const footer = details(tito).locator('.channel-screen__footer').getByRole('button')
  await expect(footer).toHaveText([MANAGE.archive, MANAGE.leave])
  for (const box of [await footer.nth(0).boundingBox(), await footer.nth(1).boundingBox()]) {
    expect(box!.height).toBeGreaterThanOrEqual(44)
    expect(box!.width).toBeGreaterThanOrEqual(390 - 2 * 16 - 1)
  }
  expect(await tito.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  await expectNoProtocolLeak(tito)

  const name = details(tito).getByLabel(MANAGE.name, { exact: true })
  await name.fill(RENAMED)
  await name.press('Enter')
  await expect(details(tito).getByRole('status')).toHaveText(MANAGE.saved, { timeout: 30_000 })
  await expect(channelRow(vani, RENAMED)).toBeVisible({ timeout: 30_000 })
})

test("2. vani's sheet: her role changes on the tap, back and forth; the system's back closes it first", async () => {
  test.setTimeout(120_000)
  await rowOf(tito, VANI_NAME).getByRole('button').click()
  const sheet = sheetOf(tito, VANI_NAME)
  await expect(sheet).toBeVisible()
  await expect.poll(() => depth(tito)).toBe(3)
  await expect(sheet.getByRole('button', { name: MANAGE.openProfile })).toBeVisible()
  const pair = sheet.getByRole('group', { name: MANAGE.role(VANI_NAME) })
  await expect(pair.getByRole('button', { name: MANAGE.member })).toHaveAttribute('aria-pressed', 'true')
  await pair.getByRole('button', { name: MANAGE.admin }).click()
  await expect(pair.getByRole('button', { name: MANAGE.admin })).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 })
  await expect(rowOf(tito, VANI_NAME)).toContainText(MANAGE.admin)
  expect((await channelFacts(RENAMED)).powerLevels['vani']).toBe(50)
  await pair.getByRole('button', { name: MANAGE.member }).click()
  await expect(pair.getByRole('button', { name: MANAGE.member })).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 })
  await expectNoProtocolLeak(tito)

  await tito.goBack()
  await expect(sheet).toHaveCount(0)
  await expect(details(tito)).toBeVisible()
  await expect.poll(() => depth(tito)).toBe(2)

  // A tap outside the sheet, on its scrim over the details, closes it (#508 R1).
  await rowOf(tito, VANI_NAME).getByRole('button').click()
  await expect(sheet).toBeVisible()
  await expect.poll(() => depth(tito)).toBe(3)
  await tito.touchscreen.tap(195, 120)
  await expect(sheet).toHaveCount(0)
  await expect(details(tito)).toBeVisible()
  await expect.poll(() => depth(tito)).toBe(2)
})

test('3. the picker: back in place of the ✕, the filter, and adding keeps it open', async () => {
  test.setTimeout(120_000)
  await details(tito).getByRole('button', { name: MANAGE.addMember }).click()
  await expect(picker(tito)).toBeVisible()
  await expect.poll(() => depth(tito)).toBe(3)
  await expect(details(tito)).toHaveCount(0)
  await expect(picker(tito).getByRole('button', { name: MANAGE.closePicker })).toHaveCount(0)
  const yara = picker(tito).getByRole('button', { name: YARA_NAME, exact: true })
  await expect(yara).toBeVisible({ timeout: 30_000 })
  const filter = picker(tito).getByRole('textbox', { name: MANAGE.filter })
  await filter.fill('zz')
  await expect(picker(tito).getByText(MANAGE.noResults('zz'))).toBeVisible()
  await picker(tito).getByRole('button', { name: MANAGE.clearFilter }).click()
  await filter.fill(YARA_NAME.slice(0, 3))
  await expect(yara).toBeVisible()
  expect((await yara.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  await expectNoProtocolLeak(tito)
  await yara.click()
  await expect(yara).toHaveCount(0, { timeout: 30_000 })
  await expect(picker(tito)).toBeVisible()

  await tito.goBack()
  await expect(picker(tito)).toHaveCount(0)
  await expect(rowOf(tito, YARA_NAME)).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => depth(tito)).toBe(2)
})

test('4. remove yara: the confirm over her sheet; back closes the top one; confirmed, both close', async () => {
  test.setTimeout(120_000)
  await rowOf(tito, YARA_NAME).getByRole('button').click()
  const sheet = sheetOf(tito, YARA_NAME)
  await sheet.getByRole('button', { name: MANAGE.confirmRemove, exact: true }).click()
  const confirm = tito.getByRole('alertdialog', { name: MANAGE.removeTitle })
  await expect(confirm).toBeVisible()
  await expect(confirm.getByRole('button', { name: MANAGE.cancel })).toBeFocused()
  await expect.poll(() => depth(tito)).toBe(4)
  await tito.goBack()
  await expect(confirm).toHaveCount(0)
  await expect(sheet).toBeVisible()
  await expect.poll(() => depth(tito)).toBe(3)

  await sheet.getByRole('button', { name: MANAGE.confirmRemove, exact: true }).click()
  await confirm.getByRole('button', { name: MANAGE.confirmRemove, exact: true }).click()
  await expect(confirm).toHaveCount(0, { timeout: 30_000 })
  await expect(sheet).toHaveCount(0)
  await expect(rowOf(tito, YARA_NAME)).toHaveCount(0, { timeout: 30_000 })
  await expect.poll(() => depth(tito)).toBe(2)
  expect((await channelFacts(RENAMED)).membership['yara']).toBe('leave')
  await expectNoProtocolLeak(tito)
  await toList(tito)
})

// §15 item 2 (ADR-115): a member of a public channel may neither change roles nor remove, so the row opens the
// profile, not the sheet; with no other answer, the details read only.
test('5. vani, a member of a public channel: no answer, so read-only, and the row opens the profile, without a sheet', async () => {
  await openDetails(vani, RENAMED)
  await expect(rowOf(vani, TITO_NAME)).toBeVisible({ timeout: 30_000 })
  await expect(details(vani).getByLabel(MANAGE.name, { exact: true })).toHaveCount(0)
  await expect(details(vani).getByLabel(MANAGE.topic, { exact: true })).toHaveCount(0)
  await expect(details(vani)).toContainText(`#${RENAMED}`)
  await expect(details(vani).getByRole('button', { name: MANAGE.addMember })).toHaveCount(0)
  await expect(details(vani).getByRole('button', { name: MANAGE.archive })).toHaveCount(0)
  await expect(details(vani).getByRole('button', { name: MANAGE.leave })).toBeVisible()
  await rowOf(vani, TITO_NAME).getByRole('button').click()
  await expect(vani.getByRole('region', { name: PROFILE.screen(TITO_NAME) })).toBeVisible({ timeout: 30_000 })
  await expect(vani.getByRole('dialog', { name: TITO_NAME, exact: true })).toHaveCount(0)
  await expect.poll(() => depth(vani)).toBe(3)
  await vani.goBack()
  await expect(details(vani)).toBeVisible()
  await expectNoProtocolLeak(vani)
})

test('6. vani leaves: the danger sheet; the details close and the channel leaves her list', async () => {
  await details(vani).getByRole('button', { name: MANAGE.leave }).click()
  const confirm = vani.getByRole('alertdialog', { name: MANAGE.leave })
  await confirm.getByRole('button', { name: MANAGE.confirmLeave, exact: true }).click()
  await expect(details(vani)).toHaveCount(0, { timeout: 30_000 })
  await expect(channelRow(vani, RENAMED)).toHaveCount(0, { timeout: 30_000 })
  await expect.poll(() => depth(vani)).toBe(0)
})

test('7. tito archives: the primary sheet; the details close and the list comes back', async () => {
  await openDetails(tito, RENAMED)
  await details(tito).getByRole('button', { name: MANAGE.archive }).click()
  const confirm = tito.getByRole('alertdialog', { name: MANAGE.archive })
  await expect(confirm.getByRole('button', { name: MANAGE.confirmArchive, exact: true })).toHaveAttribute('data-variant', 'fill')
  await confirm.getByRole('button', { name: MANAGE.confirmArchive, exact: true }).click()
  await expect(details(tito)).toHaveCount(0, { timeout: 30_000 })
  await expect(conversations(tito)).toBeVisible()
  await expect.poll(() => depth(tito)).toBe(0)
  await expectNoProtocolLeak(tito)
  for (const ledger of ledgers) ledger.expectClean()
})
