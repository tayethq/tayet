import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { PAT, ROS } from './fixtures/users'
import { signIn } from './support/login'
import { dmWith, mainComposer, messages, row, send, startDm } from './support/workspace'
import { expectNoProtocolLeak } from './support/assertions'
import { deleteSharedRooms } from './support/rooms'
import { COMPOSER, TIMELINE } from './support/labels'

// Desktop project (PLANO-MOBILE §0.12.2 R9, M3a): "Copiar texto" on the wide action bar
// (workspace.md §25.1). ros writes pat a formatted message from the toolbar; pat copies it from the bar
// and the clipboard holds its Markdown, with the mention as "@nome" and no protocol id; "Copiado" stands
// in for the button and goes back. Then the wide timeline without the narrow anchoring: a short
// conversation still starts at the top (T7 is narrow only). pat's context grants the clipboard.

const PAT_NAME = 'pat'
const ROS_NAME = 'ros'
const ts = Date.now()
const bold = `forte${ts}`
const italic = `leve${ts}`
const plain = `curta ${ts}`

let ctxPat: BrowserContext
let ctxRos: BrowserContext
let pat: Page
let ros: Page

async function toolbar(page: Page, name: string): Promise<void> {
  await page.getByRole('main').getByRole('toolbar', { name: COMPOSER.formatting }).getByRole('button', { name, exact: true }).click()
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000)
  await deleteSharedRooms(PAT_NAME, ROS_NAME)
  ctxPat = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
  ctxRos = await browser.newContext()
  pat = await ctxPat.newPage()
  ros = await ctxRos.newPage()
  await signIn(pat, PAT)
  await signIn(ros, ROS)
})

test.afterAll(async () => {
  await ctxPat?.close()
  await ctxRos?.close()
})

test('1. a short conversation on the wide window starts at the top (no narrow anchoring)', async () => {
  await startDm(ros, PAT_NAME)
  await send(ros, plain)
  await expect(dmWith(pat, ROS_NAME)).toBeVisible({ timeout: 60_000 })
  await dmWith(pat, ROS_NAME).click()
  const timeline = messages(pat)
  await expect(timeline).toContainText(plain)
  // The first row hugs the top padding; the free space stays under the last one.
  const gap = await timeline.evaluate((el) => {
    const first = el.querySelector(':scope > :not(.timeline__jump, .timeline__older)') as HTMLElement
    const top = parseFloat(getComputedStyle(el).paddingTop)
    return { offset: first.getBoundingClientRect().top - el.getBoundingClientRect().top - top, margin: getComputedStyle(first).marginTop, scrolls: el.scrollHeight > el.clientHeight }
  })
  expect(gap.scrolls).toBe(false)
  expect(gap.margin).toBe('0px')
  expect(Math.abs(gap.offset)).toBeLessThanOrEqual(1)
})

test('2. copy a formatted message from the bar: Markdown on the clipboard, "Copiado" and back', async () => {
  const composer = mainComposer(ros)
  await composer.click()
  await composer.pressSequentially('oi ')
  await toolbar(ros, COMPOSER.bold)
  await composer.pressSequentially(bold)
  await toolbar(ros, COMPOSER.bold)
  await composer.pressSequentially(' e ')
  await toolbar(ros, COMPOSER.italic)
  await composer.pressSequentially(italic)
  await toolbar(ros, COMPOSER.italic)
  await ros.getByRole('main').getByRole('button', { name: COMPOSER.send }).click()

  const r = row(pat, bold)
  await expect(r.locator('strong')).toHaveText(bold, { timeout: 60_000 })
  await r.hover()
  const button = r.getByRole('button', { name: TIMELINE.copyText, exact: true })
  await expect(button).toBeVisible()
  await button.click()
  await expect(r.getByRole('status')).toHaveText(TIMELINE.copied)
  await expect(button).toHaveCount(0)
  const clip = await pat.evaluate(() => navigator.clipboard.readText())
  expect(clip).toBe(`oi **${bold}** e *${italic}*`)
  expect(clip).not.toMatch(/[@!$#][^\s:]+:[^\s]+/)
  // Back after about 1.5 s.
  await expect(r.getByRole('status')).toHaveCount(0, { timeout: 5_000 })
  await r.hover()
  await expect(r.getByRole('button', { name: TIMELINE.copyText, exact: true })).toBeVisible()
  await expectNoProtocolLeak(pat)
})
