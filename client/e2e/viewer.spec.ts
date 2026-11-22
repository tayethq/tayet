import { readFile } from 'node:fs/promises'
import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { GIL, HUGO } from './fixtures/users'
import { expectNoProtocolLeak } from './support/assertions'
import { MANAGE, TIMELINE, VIEWER } from './support/labels'
import { signIn } from './support/login'
import { attach, pdf, png } from './support/media'
import { addMember, createChannel, deleteSharedRooms, openManage } from './support/rooms'
import { channelRow, dmWith, messages, startDm } from './support/workspace'

// Desktop project (PLANO-MOBILE §0.14, M4; workspace.md §25.2, §23.3 item 12): the image viewer and the file
// downloaded on the click. hugo sends; gil opens. In their DM (encrypted) and in a public channel the ready
// thumbnail opens the viewer on the full image; the click toggles the real size and back; Esc closes with the
// focus back on the thumbnail; "Baixar" hands over the file under the image's name. The file is not fetched
// until the click; the click downloads it byte for byte, and a second click saves without fetching again.

const GIL_NAME = 'gil'
const HUGO_NAME = 'hugo'
const ts = Date.now()
// Larger than the 1280×800 window, so the fitted image is smaller than the real one.
const big = { name: `print-${ts}.png`, mime: 'image/png', width: 2400, height: 1600, bytes: png(2400, 1600) }
const chImage = { name: `canal-${ts}.png`, mime: 'image/png', bytes: png(120, 90) }
const doc = { name: `nota-${ts}.pdf`, mime: 'application/pdf', bytes: pdf(`hugo para gil ${ts}`) }
const channelName = `vis-${ts}`
const MEDIA_DOWNLOAD = /\/_matrix\/client\/v1\/media\/download\//

let ctxGil: BrowserContext
let ctxHugo: BrowserContext
let gil: Page
let hugo: Page

const viewer = (page: Page, name: string) => page.getByRole('dialog', { name: VIEWER.dialog(name) })
const thumb = (page: Page, name: string) => messages(page).getByRole('button', { name: VIEWER.open(name), exact: true })

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000)
  await deleteSharedRooms(GIL_NAME, HUGO_NAME)
  ctxGil = await browser.newContext()
  ctxHugo = await browser.newContext()
  gil = await ctxGil.newPage()
  hugo = await ctxHugo.newPage()
  await signIn(gil, GIL)
  await signIn(hugo, HUGO)
})

test.afterAll(async () => {
  await ctxGil?.close()
  await ctxHugo?.close()
  await deleteSharedRooms(GIL_NAME, HUGO_NAME)
})

test('1. encrypted DM: the thumbnail opens the viewer on the full image; the click toggles the real size and back', async () => {
  test.setTimeout(180_000)
  await startDm(hugo, GIL_NAME)
  await attach(hugo, big)
  await expect(thumb(hugo, big.name)).toBeVisible({ timeout: 60_000 })

  await expect(dmWith(gil, HUGO_NAME)).toBeVisible({ timeout: 60_000 })
  await dmWith(gil, HUGO_NAME).click()
  await expect(thumb(gil, big.name)).toBeVisible({ timeout: 60_000 })
  await thumb(gil, big.name).click()
  const dialog = viewer(gil, big.name)
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText(HUGO_NAME, { exact: true })).toBeVisible()
  const toggle = dialog.getByRole('button', { name: VIEWER.actualSize, exact: true })
  await expect(toggle).toBeVisible({ timeout: 60_000 })
  // By its class: the toggle's name changes with the state.
  const image = dialog.locator('.image-viewer__image')
  await expect.poll(() => image.evaluate((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth)).toBe(big.width)

  // Fitted: inside the window with the 24 margin, never past the real size.
  const fit = await image.evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { w: r.width, left: r.left, right: window.innerWidth - r.right, bottom: window.innerHeight - r.bottom }
  })
  expect(fit.w).toBeLessThan(big.width)
  expect(Math.min(fit.left, fit.right, fit.bottom)).toBeGreaterThanOrEqual(24 - 1)

  await toggle.click()
  const back = dialog.getByRole('button', { name: VIEWER.fit, exact: true })
  await expect(back).toBeVisible()
  expect(await image.evaluate((el) => el.getBoundingClientRect().width)).toBe(big.width)
  // The real size scrolls inside the viewer.
  expect(await dialog.locator('.image-viewer__body').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
  await back.click()
  await expect(dialog.getByRole('button', { name: VIEWER.actualSize, exact: true })).toBeVisible()
  await expectNoProtocolLeak(gil)
})

test('2. Esc closes with the focus back on the thumbnail; "Baixar" hands over the image under its name', async () => {
  const dialog = viewer(gil, big.name)
  await gil.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(thumb(gil, big.name)).toBeFocused()

  await thumb(gil, big.name).click()
  const download = dialog.getByRole('button', { name: VIEWER.download, exact: true })
  await expect(download).toBeEnabled({ timeout: 60_000 })
  const [saved] = await Promise.all([gil.waitForEvent('download'), download.click()])
  expect(saved.suggestedFilename()).toBe(big.name)
  expect((await readFile(await saved.path())).equals(big.bytes)).toBe(true)
  await dialog.getByRole('button', { name: VIEWER.close, exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(thumb(gil, big.name)).toBeFocused()
})

test('3. the file is fetched on the click, byte for byte; a second click saves without fetching again', async () => {
  test.setTimeout(120_000)
  const fetches: string[] = []
  gil.on('request', (r) => {
    if (MEDIA_DOWNLOAD.test(r.url())) fetches.push(r.url())
  })
  await attach(hugo, doc)
  const link = messages(gil).getByRole('link', { name: TIMELINE.fileLink(doc.name), exact: true })
  await expect(link).toBeVisible({ timeout: 60_000 })
  // At rest: no download attribute, no waiting line, nothing fetched for it.
  await expect(link).not.toHaveAttribute('download')
  await gil.waitForTimeout(1_000)
  const before = fetches.length

  const [first] = await Promise.all([gil.waitForEvent('download'), link.click()])
  expect(first.suggestedFilename()).toBe(doc.name)
  expect((await readFile(await first.path())).equals(doc.bytes)).toBe(true)
  expect(fetches.length).toBe(before + 1)
  await expect(link).toHaveAttribute('download', doc.name)

  const [second] = await Promise.all([gil.waitForEvent('download'), link.click()])
  expect(second.suggestedFilename()).toBe(doc.name)
  expect((await readFile(await second.path())).equals(doc.bytes)).toBe(true)
  expect(fetches.length).toBe(before + 1)
  await expectNoProtocolLeak(gil)
})

test('4. public channel: the thumbnail opens the viewer by the same rules', async () => {
  test.setTimeout(150_000)
  await createChannel(hugo, { name: channelName, kind: 'public' })
  await openManage(hugo, channelName)
  await addMember(hugo, GIL_NAME)
  await hugo.getByRole('button', { name: MANAGE.close }).click()
  await attach(hugo, chImage)
  await expect(thumb(hugo, chImage.name)).toBeVisible({ timeout: 60_000 })

  await expect(channelRow(gil, channelName)).toBeVisible({ timeout: 60_000 })
  await channelRow(gil, channelName).click()
  await thumb(gil, chImage.name).click()
  const dialog = viewer(gil, chImage.name)
  await expect(dialog.getByRole('button', { name: VIEWER.actualSize, exact: true }).locator('img')).toBeVisible({ timeout: 60_000 })
  // A click outside the image closes.
  await dialog.locator('.image-viewer__body').click({ position: { x: 5, y: 5 } })
  await expect(dialog).toHaveCount(0)
  await expectNoProtocolLeak(gil)
})
