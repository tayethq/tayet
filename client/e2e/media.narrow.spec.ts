import { readFile } from 'node:fs/promises'
import { test, expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { DAN, EVA } from './fixtures/users'
import { expectNoProtocolLeak } from './support/assertions'
import { TIMELINE, VIEWER } from './support/labels'
import { signIn } from './support/login'
import { attach, pdf, png } from './support/media'
import { deleteSharedRooms } from './support/rooms'
import { dmWith, messages, startDm } from './support/workspace'

// Phone project (PLANO-MOBILE §0.14, M4; workspace.md §23.3 items 12 and 13, §23.5 item 2, §25.2 item 7): dan
// at 390×844 with touch, eva on a wide window. A tap on the thumbnail opens the image screen, an entry of the
// stack: the system's back closes it and the history depth comes back. A long press on the thumbnail opens the
// action sheet, not the image (T5). The file is downloaded on the tap. Touch targets of 44 are measured. Taps
// and the long press are driven by CDP (Input.dispatchTouchEvent, Med-1).

const DAN_NAME = 'dan'
const EVA_NAME = 'eva'
const ts = Date.now()
const photo = { name: `foto-${ts}.png`, mime: 'image/png', bytes: png(800, 600) }
const doc = { name: `nota-${ts}.pdf`, mime: 'application/pdf', bytes: pdf(`eva para dan ${ts}`) }
const HOLD_MS = 650
const TAP_MS = 40
const TOUCH_FLOOR = 44

let ctxDan: BrowserContext
let ctxEva: BrowserContext
let dan: Page
let eva: Page

const depth = (page: Page) => page.evaluate(() => (history.state as { depth?: number } | null)?.depth ?? 0)
const screen = (page: Page) => page.getByRole('dialog', { name: VIEWER.dialog(photo.name) })
const thumb = (page: Page) => messages(page).getByRole('button', { name: VIEWER.open(photo.name), exact: true })

// One touch through CDP at the centre of `at`, held for `ms`.
async function touch(page: Page, at: Locator, ms: number): Promise<void> {
  const box = (await at.boundingBox())!
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
  await page.waitForTimeout(ms)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
}

async function wideContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 })
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000)
  await deleteSharedRooms(DAN_NAME, EVA_NAME)
  ctxDan = await browser.newContext()
  ctxEva = await wideContext(browser)
  dan = await ctxDan.newPage()
  eva = await ctxEva.newPage()
  await signIn(dan, DAN)
  await signIn(eva, EVA)
})

test.afterAll(async () => {
  await ctxDan?.close()
  await ctxEva?.close()
  await deleteSharedRooms(DAN_NAME, EVA_NAME)
})

test("1. a tap on the thumbnail opens the image screen; the system's back closes it and the depth comes back", async () => {
  test.setTimeout(150_000)
  await startDm(eva, DAN_NAME)
  await attach(eva, photo)
  await expect(messages(eva).getByRole('button', { name: VIEWER.open(photo.name), exact: true })).toBeVisible({ timeout: 60_000 })

  await expect(dmWith(dan, EVA_NAME)).toBeVisible({ timeout: 60_000 })
  await dmWith(dan, EVA_NAME).click()
  await expect(thumb(dan)).toBeVisible({ timeout: 60_000 })
  // The thumbnail at 4:3, up to 320 wide (§23.10).
  const box = (await thumb(dan).boundingBox())!
  expect(box.width).toBeLessThanOrEqual(320)
  expect(Math.abs(box.width / box.height - 4 / 3)).toBeLessThan(0.02)

  const before = await depth(dan)
  await touch(dan, thumb(dan), TAP_MS)
  await expect(screen(dan)).toBeVisible()
  await expect.poll(() => depth(dan)).toBe(before + 1)
  // Close and "Baixar" on the touch target; the image across the screen's width.
  for (const name of [VIEWER.close, VIEWER.download]) {
    const b = (await screen(dan).getByRole('button', { name, exact: true }).boundingBox())!
    expect(Math.min(b.width, b.height)).toBeGreaterThanOrEqual(TOUCH_FLOOR)
  }
  const img = screen(dan).locator('img')
  await expect(img).toBeVisible({ timeout: 60_000 })
  expect((await img.boundingBox())!.width).toBeCloseTo(390, 0)
  expect(await screen(dan).getByRole('button', { name: VIEWER.actualSize }).count()).toBe(0) // no zoom
  expect(await dan.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  await expectNoProtocolLeak(dan)

  await dan.goBack()
  await expect(screen(dan)).toHaveCount(0)
  await expect.poll(() => depth(dan)).toBe(before)
  await expect(messages(dan)).toBeVisible()
})

test('2. a long press on the thumbnail opens the action sheet, not the image (T5)', async () => {
  await touch(dan, thumb(dan), HOLD_MS)
  const sheet = dan.getByRole('dialog', { name: TIMELINE.actionsSheet })
  await expect(sheet).toBeVisible()
  await dan.waitForTimeout(500)
  await expect(screen(dan)).toHaveCount(0)
  await dan.keyboard.press('Escape')
  await expect(sheet).toHaveCount(0)
})

test('3. "Baixar" on the image screen hands over the image; the close takes the stack back', async () => {
  const before = await depth(dan)
  await touch(dan, thumb(dan), TAP_MS)
  const download = screen(dan).getByRole('button', { name: VIEWER.download, exact: true })
  await expect(download).toBeEnabled({ timeout: 60_000 })
  const [saved] = await Promise.all([dan.waitForEvent('download'), download.click()])
  expect(saved.suggestedFilename()).toBe(photo.name)
  expect((await readFile(await saved.path())).equals(photo.bytes)).toBe(true)
  await screen(dan).getByRole('button', { name: VIEWER.close, exact: true }).click()
  await expect(screen(dan)).toHaveCount(0)
  await expect.poll(() => depth(dan)).toBe(before)
})

test('4. the file is downloaded on the tap; the link is a 44 target', async () => {
  test.setTimeout(120_000)
  await attach(eva, doc)
  const link = messages(dan).getByRole('link', { name: TIMELINE.fileLink(doc.name), exact: true })
  await expect(link).toBeVisible({ timeout: 60_000 })
  expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(TOUCH_FLOOR)
  await expect(link).not.toHaveAttribute('download')
  const [saved] = await Promise.all([dan.waitForEvent('download'), touch(dan, link, TAP_MS)])
  expect(saved.suggestedFilename()).toBe(doc.name)
  expect((await readFile(await saved.path())).equals(doc.bytes)).toBe(true)
  await expect(link).toHaveAttribute('download', doc.name)
  await expectNoProtocolLeak(dan)
})
