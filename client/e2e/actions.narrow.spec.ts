import { test, expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { TED, ULA } from './fixtures/users'
import { signIn } from './support/login'
import { dmWith, mainComposer, messages, row, send, startDm, threadPanel } from './support/workspace'
import { expectNoProtocolLeak } from './support/assertions'
import { deleteSharedRooms } from './support/rooms'
import { COMPOSER, LINK_DIALOG, THREAD, TIMELINE } from './support/labels'

// Phone project (PLANO-MOBILE §0.12.2 R9, M3b): the message's actions by touch (workspace.md §23.8, §29,
// §30). ted acts at 390×844 with touch; ula writes on a wide window. The long press is driven by CDP
// (Input.dispatchTouchEvent, Med-1): it opens the sheet with the row held over the scrim; react, copy, reply,
// reply in thread and delete close it; the system's back closes it and the history depth comes back; a long
// press on a link or a pill neither navigates nor toggles (T5); "Mais ações" by keyboard focus; the thread's
// sheet deletes one's own reply; the reaction line has no "+" and its pills are 44 high.

const TED_NAME = 'ted'
const ULA_NAME = 'ula'
const ts = Date.now()
const target = `alvo ${ts}`
const linkText = `sitio ${ts}`
const href = 'https://example.test/m3b'
const own = `minha ${ts}`
const threadReply = `no fio ${ts}`
const HOLD_MS = 650
const TOUCH_FLOOR = 44

let ctxTed: BrowserContext
let ctxUla: BrowserContext
let ted: Page
let ula: Page

const sheet = (page: Page) => page.getByRole('dialog', { name: TIMELINE.actionsSheet })
const depth = (page: Page) => page.evaluate(() => (history.state as { depth?: number } | null)?.depth ?? 0)

// One touch through CDP at the centre of `target` (or at a point), held for `ms`.
async function touch(page: Page, at: Locator | { x: number; y: number }, ms: number): Promise<void> {
  let point = at as { x: number; y: number }
  if ('boundingBox' in at) {
    const box = (await at.boundingBox())!
    point = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
  }
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] })
  await page.waitForTimeout(ms)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach()
}
const longPress = (page: Page, at: Locator) => touch(page, at, HOLD_MS)

async function wideContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 })
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000)
  await deleteSharedRooms(TED_NAME, ULA_NAME)
  ctxTed = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] })
  ctxUla = await wideContext(browser)
  ted = await ctxTed.newPage()
  ula = await ctxUla.newPage()
  await signIn(ted, TED)
  await signIn(ula, ULA)
})

test.afterAll(async () => {
  await ctxTed?.close()
  await ctxUla?.close()
  await deleteSharedRooms(TED_NAME, ULA_NAME)
})

test('1. a long press opens the sheet with the row held over the scrim; no selection, no sideways scroll', async () => {
  test.setTimeout(150_000)
  await startDm(ula, TED_NAME)
  await send(ula, target)
  // A message with a link, through the link dialog (the composer never infers one).
  const composer = mainComposer(ula)
  await composer.click()
  await composer.pressSequentially('ver ')
  await ula.getByRole('main').getByRole('toolbar', { name: COMPOSER.formatting }).getByRole('button', { name: COMPOSER.link, exact: true }).click()
  const dialog = ula.getByRole('dialog', { name: LINK_DIALOG.dialog })
  await dialog.getByLabel(LINK_DIALOG.text, { exact: true }).fill(linkText)
  await dialog.getByLabel(LINK_DIALOG.url, { exact: true }).fill(href)
  await dialog.getByRole('button', { name: LINK_DIALOG.insert, exact: true }).click()
  await ula.getByRole('main').getByRole('button', { name: COMPOSER.send }).click()
  await expect(messages(ula)).toContainText(linkText)

  await expect(dmWith(ted, ULA_NAME)).toBeVisible({ timeout: 60_000 })
  await dmWith(ted, ULA_NAME).click()
  await expect(messages(ted)).toContainText(linkText, { timeout: 60_000 })
  const r = row(ted, target)
  // T4 with the owner's adjustment: a coarse pointer below 728px gives up the selection.
  expect(await r.evaluate((el) => getComputedStyle(el).userSelect)).toBe('none')
  // No bar on the narrow window (T6).
  expect(await ted.locator('.message__actions').evaluateAll((els) => els.every((e) => getComputedStyle(e).display === 'none'))).toBe(true)

  await longPress(ted, r.getByText(target))
  await expect(sheet(ted)).toBeVisible()
  await expect(r).toHaveAttribute('data-held', 'true')
  // The row sits over the scrim (z-index, N6 a): the point at its centre is the row.
  const hit = await r.evaluate((el) => {
    const box = el.getBoundingClientRect()
    const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
    const panel = document.querySelector('.ui-sheet')!.getBoundingClientRect()
    return { held: top?.closest('article') === el, above: box.bottom <= panel.top + 1, gap: panel.top - box.bottom }
  })
  expect(hit.held).toBe(true)
  // Scrolled to sit just above the sheet, in this short conversation too (the room is made, then undone).
  expect(hit.above).toBe(true)
  expect(hit.gap).toBeLessThanOrEqual(2)
  expect(await ted.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  await expectNoProtocolLeak(ted)

  // A tap on the scrim closes; nothing is left on the timeline.
  await touch(ted, { x: 195, y: 120 }, 40)
  await expect(sheet(ted)).toHaveCount(0)
  await expect(r).not.toHaveAttribute('data-held', 'true')
  expect(await messages(ted).evaluate((el) => el.style.paddingBottom)).toBe('')
})

test('2. a reaction from the sheet toggles and closes it; the line has no "+" and the pill is 44', async () => {
  const r = row(ted, target)
  await longPress(ted, r.getByText(target))
  await sheet(ted).getByRole('button', { name: TIMELINE.react('🎉') }).click()
  await expect(sheet(ted)).toHaveCount(0)
  const pill = r.locator('.reaction', { hasText: '🎉' })
  await expect(pill).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 })
  expect((await pill.boundingBox())!.height).toBeGreaterThanOrEqual(TOUCH_FLOOR)
  await expect(r.locator('.reactions').getByRole('button', { name: TIMELINE.reactOpen })).toBeHidden()
})

test('3. a long press on a pill or a link opens the sheet and neither toggles nor navigates (T5)', async () => {
  const r = row(ted, target)
  const pill = r.locator('.reaction', { hasText: '🎉' })
  await longPress(ted, pill)
  await expect(sheet(ted)).toBeVisible()
  await ted.keyboard.press('Escape')
  await expect(sheet(ted)).toHaveCount(0)
  await expect(pill).toHaveAttribute('aria-pressed', 'true')

  const url = ted.url()
  const pages = ctxTed.pages().length
  const link = row(ted, linkText).getByRole('link', { name: linkText })
  await expect(link).toHaveAttribute('href', href)
  await longPress(ted, link)
  await expect(sheet(ted)).toBeVisible()
  await ted.keyboard.press('Escape')
  await expect(sheet(ted)).toHaveCount(0)
  expect(ted.url()).toBe(url)
  expect(ctxTed.pages().length).toBe(pages)
})

test('4. "Copiar texto" writes the message and closes the sheet', async () => {
  await longPress(ted, row(ted, target).getByText(target))
  await sheet(ted).getByRole('button', { name: TIMELINE.copyText }).click()
  await expect(sheet(ted)).toHaveCount(0)
  expect(await ted.evaluate(() => navigator.clipboard.readText())).toBe(target)
})

test('5. "Responder" closes the sheet and opens the reply strip', async () => {
  await longPress(ted, row(ted, target).getByText(target))
  await sheet(ted).getByRole('button', { name: TIMELINE.reply, exact: true }).click()
  await expect(sheet(ted)).toHaveCount(0)
  await expect(ted.getByRole('main').getByText(COMPOSER.replyingTo)).toBeVisible()
  await ted.getByRole('main').getByRole('button', { name: COMPOSER.cancelReply }).click()
})

test("6. the system's back closes the sheet and the history depth comes back", async () => {
  const before = await depth(ted)
  await longPress(ted, row(ted, target).getByText(target))
  await expect(sheet(ted)).toBeVisible()
  await expect.poll(() => depth(ted)).toBe(before + 1)
  await ted.goBack()
  await expect(sheet(ted)).toHaveCount(0)
  await expect.poll(() => depth(ted)).toBe(before)
  await expect(messages(ted)).toBeVisible()
})

test('7. "Mais ações" under keyboard focus opens the same sheet and takes the focus back', async () => {
  const more = row(ted, target).getByRole('button', { name: TIMELINE.moreActions })
  await ted.keyboard.press('Shift')
  await more.focus()
  await expect.poll(() => more.evaluate((el) => getComputedStyle(el).opacity)).toBe('1')
  expect((await more.boundingBox())!.height).toBeGreaterThanOrEqual(TOUCH_FLOOR)
  await ted.keyboard.press('Enter')
  await expect(sheet(ted)).toBeVisible()
  await ted.keyboard.press('Escape')
  await expect(sheet(ted)).toHaveCount(0)
  expect(await ted.evaluate(() => document.activeElement?.getAttribute('aria-label'))).toBe(TIMELINE.moreActions)
})

test('8. "Responder na thread" opens the thread; its sheet deletes one\'s own reply after the question', async () => {
  test.setTimeout(120_000)
  const before = await depth(ted)
  await longPress(ted, row(ted, target).getByText(target))
  await sheet(ted).getByRole('button', { name: TIMELINE.replyInThread }).click()
  await expect(sheet(ted)).toHaveCount(0)
  const panel = threadPanel(ted)
  await expect(panel).toBeVisible()
  await expect.poll(() => depth(ted)).toBe(before + 1)

  await panel.getByRole('textbox', { name: COMPOSER.editor, exact: true }).fill(threadReply)
  await panel.getByRole('button', { name: COMPOSER.send }).click()
  const replies = panel.getByRole('log', { name: THREAD.replies })
  await expect(replies).toContainText(threadReply)
  const mine = replies.locator('article').filter({ hasText: threadReply })
  await expect(mine).not.toHaveAttribute('aria-busy', 'true', { timeout: 30_000 })
  // Deleted right after the send, no reload: the reply this session sent, by the id the send returned
  // (#421, PLANO-MOBILE §8.16).
  await longPress(ted, mine.getByText(threadReply))
  const s = sheet(ted)
  await expect(s.getByRole('button', { name: TIMELINE.reply, exact: true })).toHaveCount(0)
  await expect(s.getByRole('button', { name: TIMELINE.replyInThread })).toHaveCount(0)
  await s.getByRole('button', { name: TIMELINE.delete }).click()
  await expect(s.getByText(TIMELINE.deleteQuestion)).toBeVisible()
  await s.getByRole('button', { name: TIMELINE.confirmDelete, exact: true }).click()
  await expect(sheet(ted)).toHaveCount(0)
  await expect(replies).not.toContainText(threadReply, { timeout: 30_000 })
  await ted.goBack()
  await expect(panel).toBeHidden()
  await expect(messages(ted)).toBeVisible()
})

test('9. one\'s own message: "Apagar mensagem" asks inside the sheet, "Cancelar" keeps it, "Apagar" removes it', async () => {
  await send(ted, own)
  const r = row(ted, own)
  await expect(r).not.toHaveAttribute('aria-busy', 'true', { timeout: 30_000 })
  await longPress(ted, r.getByText(own))
  await sheet(ted).getByRole('button', { name: TIMELINE.delete }).click()
  await sheet(ted).getByRole('button', { name: TIMELINE.cancel }).click()
  await expect(sheet(ted)).toHaveCount(0)
  await expect(r).toBeVisible()

  await longPress(ted, r.getByText(own))
  await sheet(ted).getByRole('button', { name: TIMELINE.delete }).click()
  await sheet(ted).getByRole('button', { name: TIMELINE.confirmDelete, exact: true }).click()
  await expect(sheet(ted)).toHaveCount(0)
  await expect(messages(ted)).not.toContainText(own, { timeout: 30_000 })
  await expect(messages(ula)).not.toContainText(own, { timeout: 60_000 })
})
