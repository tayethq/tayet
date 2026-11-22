import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { GAEL, IRIS, NOE } from './fixtures/users'
import { expectNoProtocolLeak, expectReadable } from './support/assertions'
import { ConsoleLedger, FIRST_LOGIN_404, recognizedSet404 } from './support/console'
import { GROUP, LIST, MANAGE, NEW_CONVERSATION, PROFILE } from './support/labels'
import { signIn } from './support/login'
import { deleteGroupsOf, deleteSharedRooms } from './support/rooms'
import { conversations, groupWith, mainComposer, row, send } from './support/workspace'

// Phone project (PLANO-MOBILE M8; channel-management.md §11, view-profile.md §8): a group's details and
// someone's profile as screens of the stack. iris opens the group with gael and noe on a wide window. gael, at
// 390×844 with touch, opens the details from the group's ⋯, a profile from a row and from the author, and walks
// back level by level; "Enviar mensagem" settles on list and conversation; the leave sheet, cancelled and
// confirmed. One ledger per person.

const GAEL_NAME = 'gael'
const IRIS_NAME = 'iris'
const NOE_NAME = 'noe'
const BACK = 'Voltar'
const text = `bom dia do grupo ${Date.now()}`

const people = [
  { name: GAEL_NAME, user: GAEL, phone: true },
  { name: IRIS_NAME, user: IRIS, phone: false },
  { name: NOE_NAME, user: NOE, phone: false },
]
const ledgers = people.map((p) => new ConsoleLedger(p.name, [...FIRST_LOGIN_404, ...recognizedSet404(1)]))
const contexts: BrowserContext[] = []
let gael: Page
let iris: Page
let appUrl: string

const depth = (page: Page) => page.evaluate(() => (history.state as { depth?: number } | null)?.depth ?? 0)
const region = (name: string) => gael.getByRole('region', { name, exact: true })
const details = () => region(GROUP.details)
const profile = () => region(PROFILE.screen(IRIS_NAME))
const group = () => groupWith(gael, [IRIS_NAME, NOE_NAME])
const main = () => gael.getByRole('main')

async function toList(): Promise<void> {
  const from = await depth(gael)
  for (let d = from - 1; d >= 0; d--) {
    await gael.goBack()
    await expect.poll(() => depth(gael)).toBe(d)
  }
  await expect(conversations(gael)).toBeVisible()
}
async function openDetails(): Promise<void> {
  await group().click()
  await main().getByRole('button', { name: GROUP.details }).click()
  await expect(details()).toBeVisible()
  await expect.poll(() => depth(gael)).toBe(2)
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000)
  await deleteGroupsOf(GAEL_NAME, IRIS_NAME, NOE_NAME)
  await deleteSharedRooms(GAEL_NAME, IRIS_NAME)
  const pages: Page[] = []
  for (const [i, person] of people.entries()) {
    const ctx = await browser.newContext(
      person.phone ? undefined : { viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 },
    )
    contexts.push(ctx)
    const page = await ctx.newPage()
    ledgers[i]!.watch(page, person.name)
    await signIn(page, person.user)
    pages.push(page)
  }
  gael = pages[0]!
  iris = pages[1]!
  appUrl = gael.url()
  // iris opens the group. The known set is read when the dialog opens: reopened until both are in it.
  const dialog = iris.getByRole('dialog', { name: NEW_CONVERSATION.dialog })
  await expect(async () => {
    if ((await dialog.count()) > 0) await dialog.getByRole('button', { name: NEW_CONVERSATION.cancel }).click()
    await conversations(iris).getByRole('button', { name: LIST.newDm }).click()
    for (const name of [GAEL_NAME, NOE_NAME]) await expect(dialog.getByRole('button', { name, exact: true })).toBeVisible({ timeout: 5_000 })
  }).toPass({ timeout: 60_000 })
  for (const name of [GAEL_NAME, NOE_NAME]) await dialog.getByRole('button', { name, exact: true }).click()
  await dialog.getByRole('button', { name: NEW_CONVERSATION.startConversation }).click()
  await expect(dialog).toHaveCount(0)
  await expect(groupWith(iris, [GAEL_NAME, NOE_NAME])).toHaveAttribute('aria-current', 'true', { timeout: 60_000 })
  await mainComposer(iris).click()
  await send(iris, text)
  await expect(group()).toBeVisible({ timeout: 60_000 })
})

test.afterAll(async () => {
  for (const ctx of contexts) await ctx.close()
  await deleteGroupsOf(GAEL_NAME, IRIS_NAME, NOE_NAME)
  await deleteSharedRooms(GAEL_NAME, IRIS_NAME)
})

test("1. the details from the ⋯, a profile from a row, and the system's back level by level", async () => {
  await openDetails()
  await expect(details().getByRole('button', { name: BACK })).toBeFocused()
  await expect(main()).toHaveCount(0)
  await expect(gael.getByRole('dialog')).toHaveCount(0)
  await expect(details().getByRole('button', { name: GROUP.convert })).toHaveCount(0)
  const line = details().getByRole('button', { name: PROFILE.open(IRIS_NAME) })
  expect((await line.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  const leave = (await details().getByRole('button', { name: GROUP.leave, exact: true }).boundingBox())!
  expect(leave.height).toBeGreaterThanOrEqual(44)
  expect(leave.y + leave.height).toBeLessThanOrEqual(844)
  expect(leave.width).toBeGreaterThanOrEqual(390 - 2 * 16 - 1)
  await expectNoProtocolLeak(gael)

  await line.click()
  await expect(profile()).toBeVisible()
  await expect.poll(() => depth(gael)).toBe(3)
  await expect(details()).toHaveCount(0)
  await expect(profile().getByRole('button', { name: PROFILE.sendMessage })).toBeVisible()
  expect(await gael.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  await expectNoProtocolLeak(gael)

  await gael.goBack()
  await expect(profile()).toHaveCount(0)
  await expect(details()).toBeVisible()
  await expect(line).toBeFocused()
  await expect.poll(() => depth(gael)).toBe(2)
  await gael.goBack()
  await expect(details()).toHaveCount(0)
  await expect(main()).toBeVisible()
  await expect.poll(() => depth(gael)).toBe(1)
  await gael.goBack()
  await expect(conversations(gael)).toBeVisible()
  await expect.poll(() => depth(gael)).toBe(0)
  expect(gael.url()).toBe(appUrl)
})

test('2. the author opens the profile, and back returns the conversation', async () => {
  await toList()
  await group().click()
  await expectReadable(gael, text)
  await row(gael, text).getByRole('button', { name: PROFILE.open(IRIS_NAME) }).last().click()
  await expect(profile()).toBeVisible()
  await expect.poll(() => depth(gael)).toBe(2)
  await gael.goBack()
  await expect(profile()).toHaveCount(0)
  await expect(main()).toBeVisible()
})

test('3. "Enviar mensagem" closes the profile and the details, and the stack settles on list and conversation', async () => {
  test.setTimeout(120_000)
  await toList()
  await openDetails()
  await details().getByRole('button', { name: PROFILE.open(IRIS_NAME) }).click()
  await profile().getByRole('button', { name: PROFILE.sendMessage }).click()
  await expect(main().getByRole('heading', { level: 2, name: IRIS_NAME, exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(profile()).toHaveCount(0)
  await expect(details()).toHaveCount(0)
  await expect.poll(() => depth(gael)).toBe(1)
  await gael.goBack()
  await expect(conversations(gael)).toBeVisible()
  await expect.poll(() => depth(gael)).toBe(0)
  expect(gael.url()).toBe(appUrl)
})

test('4. the leave sheet: cancelled, closed by back first, then confirmed', async () => {
  test.setTimeout(120_000)
  await toList()
  await openDetails()
  const open = details().getByRole('button', { name: GROUP.leave, exact: true })
  const sheet = gael.getByRole('alertdialog', { name: GROUP.leave })
  await open.click()
  await expect(sheet).toBeVisible()
  await expect(sheet.getByRole('button', { name: NEW_CONVERSATION.cancel })).toBeFocused()
  await expect.poll(() => depth(gael)).toBe(3)
  await expectNoProtocolLeak(gael)
  await sheet.getByRole('button', { name: NEW_CONVERSATION.cancel }).click()
  await expect(sheet).toHaveCount(0)
  await expect.poll(() => depth(gael)).toBe(2)

  await open.click()
  await expect.poll(() => depth(gael)).toBe(3)
  await gael.goBack()
  await expect(sheet).toHaveCount(0)
  await expect(details()).toBeVisible()
  await expect.poll(() => depth(gael)).toBe(2)

  await open.click()
  await expect.poll(() => depth(gael)).toBe(3)
  await sheet.getByRole('button', { name: MANAGE.confirmLeave, exact: true }).click()
  await expect(conversations(gael)).toBeVisible({ timeout: 30_000 })
  await expect(sheet).toHaveCount(0)
  await expect(details()).toHaveCount(0)
  await expect(group()).toHaveCount(0)
  await expect.poll(() => depth(gael)).toBe(0)
  expect(gael.url()).toBe(appUrl)
  await expectNoProtocolLeak(gael)
  for (const ledger of ledgers) ledger.expectClean()
})
