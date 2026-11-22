import { test, expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { IVY, JOE } from './fixtures/users'
import { signIn } from './support/login'
import { dmWith, mainComposer, messages, row, send, startDm, threadPanel } from './support/workspace'
import { expectNoProtocolLeak } from './support/assertions'
import { deleteSharedRooms } from './support/rooms'
import { COMPOSER, LINK_DIALOG, TIMELINE } from './support/labels'

// Phone project (PLANO-MOBILE §0.15, M5): the narrow composer (workspace.md §23.7). ivy writes at 390×844 with
// touch; joe reads and writes on a wide window. The single line sends; "Aa" opens the formatting band; reply and
// edit come from the action sheet, in the conversation and in the thread, with the system's back cancelling the
// edit (E3 b) and the draft coming back (E2 a); the link sheet inserts and refuses a bad scheme; the mention
// suggestion opens at the screen's width; with a coarse pointer Enter breaks the line and only the button sends
// (N1 b).

const IVY_NAME = 'ivy'
const JOE_NAME = 'joe'
const ts = Date.now()
const first = `primeira ${ts}`
const bold = `forte ${ts}`
const fromJoe = `do joe ${ts}`
const answer = `resposta ${ts}`
const own = `minha ${ts}`
const edited = `editada ${ts}`
const draft = `rascunho ${ts}`
const rootText = `raiz ${ts}`
const threadReply = `no fio ${ts}`
const threadEdited = `fio editado ${ts}`
const linkText = `sitio ${ts}`
const href = 'https://example.test/m5'
const HOLD_MS = 650
const TOUCH_FLOOR = 44

let ctxIvy: BrowserContext
let ctxJoe: BrowserContext
let ivy: Page
let joe: Page

const main = (page: Page) => page.getByRole('main')
const sheet = (page: Page) => page.getByRole('dialog', { name: TIMELINE.actionsSheet })
const depth = (page: Page) => page.evaluate(() => (history.state as { depth?: number } | null)?.depth ?? 0)
const editBand = (scope: Locator) => scope.getByRole('status').filter({ hasText: COMPOSER.editing })

async function longPress(page: Page, at: Locator): Promise<void> {
  const box = (await at.boundingBox())!
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
  await page.waitForTimeout(HOLD_MS)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
}
// A message of one's own offers reply, thread and edit only once it is sent (actionsOf).
const settled = (r: Locator) => expect(r).not.toHaveAttribute('aria-busy', 'true', { timeout: 30_000 })
async function sheetAction(page: Page, on: Locator, action: string): Promise<void> {
  await longPress(page, on)
  await sheet(page).getByRole('button', { name: action, exact: true }).click()
  await expect(sheet(page)).toHaveCount(0)
}

async function wideContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 })
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000)
  await deleteSharedRooms(IVY_NAME, JOE_NAME)
  ctxIvy = await browser.newContext()
  ctxJoe = await wideContext(browser)
  ivy = await ctxIvy.newPage()
  joe = await ctxJoe.newPage()
  await signIn(ivy, IVY)
  await signIn(joe, JOE)
})

test.afterAll(async () => {
  await ctxIvy?.close()
  await ctxJoe?.close()
  await deleteSharedRooms(IVY_NAME, JOE_NAME)
})

test('1. the single line sends: attach · field · "Aa" · send, on the touch floor; no mention button', async () => {
  test.setTimeout(150_000)
  await startDm(joe, IVY_NAME)
  await send(joe, fromJoe)
  await expect(dmWith(ivy, JOE_NAME)).toBeVisible({ timeout: 60_000 })
  await dmWith(ivy, JOE_NAME).click()
  await expect(messages(ivy)).toContainText(fromJoe, { timeout: 60_000 })

  const line = main(ivy).locator('.composer__line')
  for (const name of [COMPOSER.attach, COMPOSER.formatting, COMPOSER.send]) {
    expect((await line.getByLabel(name, { exact: true }).boundingBox())!.height).toBeGreaterThanOrEqual(TOUCH_FLOOR)
  }
  expect((await mainComposer(ivy).boundingBox())!.height).toBeGreaterThan(0)
  expect(await mainComposer(ivy).evaluate((el) => getComputedStyle(el).fontSize)).toBe('16px')
  await expect(main(ivy).getByRole('button', { name: COMPOSER.mention })).toHaveCount(0)
  await expect(main(ivy).getByRole('toolbar', { name: COMPOSER.formatting })).toHaveCount(0)
  await send(ivy, first)
  await expect(messages(joe)).toContainText(first, { timeout: 60_000 })
  expect(await ivy.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  await expectNoProtocolLeak(ivy)
})

test('2. "Aa" opens the formatting band, pressed; bold goes out bold', async () => {
  const aa = main(ivy).getByRole('button', { name: COMPOSER.formatting })
  await aa.click()
  await expect(aa).toHaveAttribute('aria-pressed', 'true')
  const bar = main(ivy).getByRole('toolbar', { name: COMPOSER.formatting })
  await expect(bar).toBeVisible()
  expect((await bar.getByRole('button', { name: COMPOSER.bold }).boundingBox())!.height).toBeGreaterThanOrEqual(TOUCH_FLOOR)
  await mainComposer(ivy).click()
  await bar.getByRole('button', { name: COMPOSER.bold }).click()
  await mainComposer(ivy).pressSequentially(bold)
  await main(ivy).getByRole('button', { name: COMPOSER.send }).click()
  await expect(row(joe, bold).locator('strong')).toHaveText(bold, { timeout: 60_000 })
  await aa.click()
  await expect(bar).toHaveCount(0)
})

test('3. "Responder" from the sheet opens the reply band; the reply goes out quoting', async () => {
  await sheetAction(ivy, row(ivy, fromJoe).getByText(fromJoe), TIMELINE.reply)
  const band = main(ivy).locator('.composer__band.composer__reply')
  await expect(band).toContainText(COMPOSER.replyingTo)
  expect((await band.getByRole('button', { name: COMPOSER.cancelReply }).boundingBox())!.height).toBeGreaterThanOrEqual(TOUCH_FLOOR)
  await send(ivy, answer)
  await expect(band).toHaveCount(0)
  await expect(row(joe, answer).locator('.message__quote')).toContainText(fromJoe, { timeout: 60_000 })
})

test("4. editing from the conversation's composer: the band, the marked row, save; the system's back cancels and gives the draft back", async () => {
  await send(ivy, own)
  await settled(row(ivy, own))
  await sheetAction(ivy, row(ivy, own).getByText(own), TIMELINE.edit)
  await expect(editBand(main(ivy))).toBeVisible()
  await expect(row(ivy, own)).toHaveAttribute('data-editing', 'true')
  await expect(mainComposer(ivy)).toHaveText(own)
  await expect(main(ivy).getByRole('button', { name: COMPOSER.attach })).toHaveCount(0)
  await mainComposer(ivy).fill(edited)
  await main(ivy).getByRole('button', { name: COMPOSER.save }).click()
  await expect(editBand(main(ivy))).toHaveCount(0)
  await expect(row(joe, edited)).toContainText(TIMELINE.edited, { timeout: 60_000 })

  // The draft is put aside and comes back when the system's back cancels the edit.
  await settled(row(ivy, edited))
  await mainComposer(ivy).fill(draft)
  const before = await depth(ivy)
  await sheetAction(ivy, row(ivy, edited).getByText(edited), TIMELINE.edit)
  await expect(editBand(main(ivy))).toBeVisible()
  await expect.poll(() => depth(ivy)).toBe(before + 1)
  await ivy.goBack()
  await expect(editBand(main(ivy))).toHaveCount(0)
  await expect.poll(() => depth(ivy)).toBe(before)
  await expect(mainComposer(ivy)).toHaveText(draft)
  await expect(messages(ivy)).toBeVisible()
  await mainComposer(ivy).fill('')
})

test('5. editing in the thread: the thread composer takes the band; save, then back cancels', async () => {
  test.setTimeout(120_000)
  await send(ivy, rootText)
  await settled(row(ivy, rootText))
  await sheetAction(ivy, row(ivy, rootText).getByText(rootText), TIMELINE.replyInThread)
  const panel = threadPanel(ivy)
  await expect(panel).toBeVisible()
  await panel.getByRole('textbox', { name: COMPOSER.editor, exact: true }).fill(threadReply)
  await panel.getByRole('button', { name: COMPOSER.send }).click()
  const reply = panel.locator('article').filter({ hasText: threadReply })
  await expect(reply).toBeVisible()
  await settled(reply)
  await sheetAction(ivy, reply.getByText(threadReply), TIMELINE.edit)
  await expect(editBand(panel)).toBeVisible()
  await panel.getByRole('textbox', { name: COMPOSER.editor, exact: true }).fill(threadEdited)
  await panel.getByRole('button', { name: COMPOSER.save }).click()
  await expect(panel.locator('article').filter({ hasText: threadEdited })).toBeVisible({ timeout: 30_000 })
  await sheetAction(ivy, panel.locator('article').filter({ hasText: threadEdited }).getByText(threadEdited), TIMELINE.edit)
  await expect(editBand(panel)).toBeVisible()
  await ivy.goBack()
  await expect(editBand(panel)).toHaveCount(0)
  await expect(panel).toBeVisible()
  await ivy.goBack()
  await expect(panel).toBeHidden()
})

test('6. the link sheet: a bad scheme is refused in place; "Inserir" puts the link in', async () => {
  await main(ivy).getByRole('button', { name: COMPOSER.formatting }).click()
  await mainComposer(ivy).click()
  await mainComposer(ivy).pressSequentially('ver ')
  await main(ivy).getByRole('toolbar', { name: COMPOSER.formatting }).getByRole('button', { name: COMPOSER.link, exact: true }).click()
  const linkSheet = ivy.getByRole('dialog', { name: LINK_DIALOG.dialog })
  await expect(linkSheet).toBeVisible()
  expect(await linkSheet.evaluate((el) => el.classList.contains('ui-sheet'))).toBe(true)
  const text = linkSheet.getByLabel(LINK_DIALOG.text, { exact: true })
  await expect(text).toBeFocused()
  expect((await text.boundingBox())!.height).toBeGreaterThanOrEqual(TOUCH_FLOOR)
  await text.fill(linkText)
  await linkSheet.getByLabel(LINK_DIALOG.url, { exact: true }).fill('javascript:alert(1)')
  await linkSheet.getByRole('button', { name: LINK_DIALOG.insert, exact: true }).click()
  await expect(linkSheet.getByRole('alert')).toHaveText(LINK_DIALOG.invalid)
  await linkSheet.getByLabel(LINK_DIALOG.url, { exact: true }).fill(href)
  await linkSheet.getByRole('button', { name: LINK_DIALOG.insert, exact: true }).click()
  await expect(linkSheet).toHaveCount(0)
  await main(ivy).getByRole('button', { name: COMPOSER.send }).click()
  await expect(row(joe, linkText).getByRole('link', { name: linkText })).toHaveAttribute('href', href, { timeout: 60_000 })
  await main(ivy).getByRole('button', { name: COMPOSER.formatting }).click()
})

test('7. the mention suggestion opens above the composer at the screen width, rows on the touch floor', async () => {
  await mainComposer(ivy).click()
  await mainComposer(ivy).pressSequentially('@jo')
  const list = main(ivy).getByRole('listbox', { name: COMPOSER.mention })
  await expect(list).toBeVisible()
  const box = (await list.boundingBox())!
  expect(box.x).toBeLessThanOrEqual(0.5)
  expect(Math.round(box.width)).toBe(ivy.viewportSize()!.width)
  expect((await list.getByRole('option').first().boundingBox())!.height).toBeGreaterThanOrEqual(TOUCH_FLOOR)
  await ivy.keyboard.press('Enter')
  await expect(list).toHaveCount(0)
  await mainComposer(ivy).fill('')
})

test('8. a coarse pointer: Enter breaks the line, only the button sends (N1 b)', async () => {
  // The phone project (hasTouch, isMobile) matches the coarse pointer the composer reads at the key press.
  expect(await ivy.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true)
  const lineA = `linha a ${ts}`
  const lineB = `linha b ${ts}`
  await mainComposer(ivy).click()
  await mainComposer(ivy).pressSequentially(lineA)
  await ivy.keyboard.press('Enter')
  await mainComposer(ivy).pressSequentially(lineB)
  await expect(mainComposer(ivy).locator('p')).toHaveCount(2)
  await expect(messages(ivy)).not.toContainText(lineA)
  await main(ivy).getByRole('button', { name: COMPOSER.send }).click()
  await expect(row(joe, lineA)).toContainText(lineB, { timeout: 60_000 })
})
