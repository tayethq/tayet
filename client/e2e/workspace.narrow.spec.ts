import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { LEV, MAE } from './fixtures/users'
import { signIn } from './support/login'
import { NotificationStub } from './support/notifications'
import { VISIBILITY_SHIM } from './support/visibility'
import { conversations, dmWith, messages, row, startDm, send, threadPanel, unreadOf } from './support/workspace'
import { expectNoProtocolLeak } from './support/assertions'
import { deleteSharedRooms } from './support/rooms'
import { APP, COMPOSER, LANGUAGE, THREAD, TIMELINE } from './support/labels'

// Phone project: the narrow shell as a stack. lev uses the
// app at 390×844 with touch; mae, on a wide window, writes to lev. One screen at a time — the list, the
// conversation, the thread — with back through the browser history, the URL never changing. lev's
// context replaces window.Notification by the stub (granted) to see what notifies, and the visibility
// shim keeps the tab visible and focused (headless reports focus on every page).

const LEV_NAME = 'lev'
const MAE_NAME = 'mae'
const BACK = 'Voltar'
// Long enough to wrap on 390px, so a few of them make the timeline scroll (a burst drains slowly
// through the server's message rate limit).
const FILLER = 10
const filler = (i: number) =>
  `linha ${i} ${ts} — texto comprido o bastante para quebrar em mais de uma linha numa tela estreita de celular, como uma mensagem de verdade`

let ctxLev: BrowserContext
let ctxMae: BrowserContext
let lev: Page
let mae: Page
let stub: NotificationStub
let appUrl: string
const ts = Date.now()
const rootText = `raiz ${ts}`
const replyText = `resposta ${ts}`

const main = (page: Page) => page.getByRole('main')
const dmHeading = (page: Page) => main(page).getByRole('heading', { level: 2, name: MAE_NAME })
const historyDepth = (page: Page) =>
  page.evaluate(() => {
    const s = window.history.state as { depth?: unknown } | null
    return typeof s?.depth === 'number' ? s.depth : 0
  })
const noHorizontalScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
async function expectSameUrl(page: Page): Promise<void> {
  expect(page.url()).toBe(appUrl)
}
async function toList(page: Page): Promise<void> {
  while ((await historyDepth(page)) > 0) await page.goBack()
  await expect(conversations(page)).toBeVisible()
}
async function openDm(page: Page): Promise<void> {
  await dmWith(page, MAE_NAME).click()
  await expect(dmHeading(page)).toBeVisible()
}

async function wideContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 })
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000)
  await deleteSharedRooms(LEV_NAME, MAE_NAME)
  ctxLev = await browser.newContext()
  stub = await NotificationStub.install(ctxLev, 'granted')
  await ctxLev.addInitScript(VISIBILITY_SHIM)
  // Counts the documents this tab starts, to tell a same-document traversal from a reload.
  await ctxLev.addInitScript(() => {
    try {
      sessionStorage.setItem('__e2e.docStarts', String(Number(sessionStorage.getItem('__e2e.docStarts') ?? '0') + 1))
    } catch {
      // Storage blocked: the count is not read.
    }
  })
  ctxMae = await wideContext(browser)
  lev = await ctxLev.newPage()
  mae = await ctxMae.newPage()
  await signIn(lev, LEV)
  await signIn(mae, MAE)
  appUrl = lev.url()
  // mae opens the DM and writes a root with one thread reply, then enough messages for the timeline to scroll.
  await startDm(mae, LEV_NAME)
  await send(mae, rootText)
  const root = row(mae, rootText)
  await root.hover()
  await root.getByRole('button', { name: TIMELINE.replyInThread }).click()
  const panel = threadPanel(mae)
  await panel.getByRole('textbox', { name: COMPOSER.editor, exact: true }).fill(replyText)
  await panel.getByRole('button', { name: COMPOSER.send }).click()
  // The open panel shows the reply to a root sent in this session.
  await expect(panel.getByRole('log', { name: THREAD.replies })).toContainText(replyText)
  // The root's summary counts the reply once the server has it (what lev reads).
  await expect(row(mae, rootText).getByRole('button', { name: TIMELINE.replies(1) })).toBeVisible()
  await panel.getByRole('button', { name: THREAD.close }).click()
  for (let i = 1; i <= FILLER; i++) await send(mae, filler(i))
})

test.afterAll(async () => {
  await ctxLev?.close()
  await ctxMae?.close()
})

test('1. boot: the list on screen, nothing in front; a conversation opens with its header; back returns the list; the URL never changes', async () => {
  await lev.goto(appUrl)
  await expect(lev.getByRole('heading', { name: APP.title, level: 1 })).toBeVisible()
  await expect(conversations(lev)).toBeVisible()
  // The conversation screen is not on screen (covered: not painted, out of the accessibility tree).
  await expect(main(lev)).toHaveCount(0)
  expect(await historyDepth(lev)).toBe(0)
  await expectSameUrl(lev)

  await openDm(lev)
  await expect(main(lev).getByRole('button', { name: BACK })).toBeFocused()
  await expect(conversations(lev)).toHaveCount(0)
  expect(await historyDepth(lev)).toBe(1)
  await expectSameUrl(lev)

  await lev.goBack()
  await expect(conversations(lev)).toBeVisible()
  await expect(main(lev)).toHaveCount(0)
  expect(await historyDepth(lev)).toBe(0)
  // Focus goes back to the row that opened the conversation.
  await expect(dmWith(lev, MAE_NAME)).toBeFocused()
  await expectSameUrl(lev)
  await expectNoProtocolLeak(lev)
})

test('2. thread: opens from the summary; back returns the conversation at the same scroll; back again returns the list', async () => {
  test.setTimeout(150_000)
  await openDm(lev)
  // mae's burst drains through the server's message rate limit: the last one may take a while.
  await expect(messages(lev)).toContainText(filler(FILLER), { timeout: 120_000 })
  const summary = row(lev, rootText).getByRole('button', { name: TIMELINE.replies(1) })
  await summary.scrollIntoViewIfNeeded()
  const timeline = messages(lev)
  const before = await timeline.evaluate((el) => el.scrollTop)
  expect(await timeline.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
  await summary.click()
  const panel = threadPanel(lev)
  await expect(panel.getByRole('heading', { level: 2, name: THREAD.panel })).toBeVisible()
  await expect(panel.getByRole('log', { name: THREAD.replies })).toContainText(replyText)
  await expect(main(lev)).toHaveCount(0)
  expect(await historyDepth(lev)).toBe(2)

  await lev.goBack()
  await expect(dmHeading(lev)).toBeVisible()
  await expect(threadPanel(lev)).toHaveCount(0)
  expect(await messages(lev).evaluate((el) => el.scrollTop)).toBe(before)
  await expect(summary).toBeFocused()

  await lev.goBack()
  await expect(conversations(lev)).toBeVisible()
  expect(await historyDepth(lev)).toBe(0)
  await expectSameUrl(lev)
  await expectNoProtocolLeak(lev)
})

test('3. reload with the thread on screen: the list, depth zero', async () => {
  await openDm(lev)
  await row(lev, rootText).getByRole('button', { name: TIMELINE.replies(1) }).click()
  await expect(threadPanel(lev).getByRole('log', { name: THREAD.replies })).toContainText(replyText)
  expect(await historyDepth(lev)).toBe(2)
  const docStarts = () => lev.evaluate(() => Number(sessionStorage.getItem('__e2e.docStarts')))
  const before = await docStarts()
  await lev.reload()
  await expect(lev.getByRole('heading', { name: APP.title, level: 1 })).toBeVisible()
  await expect(conversations(lev)).toBeVisible()
  await expect(main(lev)).toHaveCount(0)
  await expect.poll(() => historyDepth(lev)).toBe(0)
  // The entries pushed before the reload are still this document's: going back over them started no
  // new document (only the reload did).
  expect(await docStarts()).toBe(before + 1)
  await expectSameUrl(lev)
  await expectNoProtocolLeak(lev)
})

test('4. list on screen, a direct message arrives: the row stays unread, the title counts, the notification shows', async () => {
  await toList(lev)
  const before = stub.shown.length
  const text = `na lista ${ts}`
  await send(mae, text)
  await expect.poll(() => unreadOf(dmWith(lev, MAE_NAME))).toBeGreaterThan(0)
  await expect(lev).toHaveTitle(/^\(\d+\) Tayet$/)
  await expect.poll(() => stub.shown.slice(before).some((n) => n.body.includes(text))).toBe(true)
  await expectNoProtocolLeak(lev)
})

test('5. thread on screen, a message in the conversation notifies; back to the conversation reads it', async () => {
  await openDm(lev)
  await expect(lev).toHaveTitle(APP.title)
  await row(lev, rootText).getByRole('button', { name: TIMELINE.replies(1) }).click()
  await expect(threadPanel(lev).getByRole('log', { name: THREAD.replies })).toContainText(replyText)
  const before = stub.shown.length
  const text = `com a thread ${ts}`
  await send(mae, text)
  await expect.poll(() => stub.shown.slice(before).some((n) => n.body.includes(text))).toBe(true)
  await expect(lev).toHaveTitle(/^\(\d+\) Tayet$/)
  await lev.goBack()
  await expect(dmHeading(lev)).toBeVisible()
  await expect(messages(lev)).toContainText(text)
  await expect(lev).toHaveTitle(APP.title)
  await expectNoProtocolLeak(lev)
})

test('6. screen: "Sua conta" open, back closes it and the list stays', async () => {
  await toList(lev)
  await lev.getByRole('button', { name: APP.account }).click()
  const account = lev.getByRole('region', { name: APP.account })
  await expect(account).toBeVisible()
  // The language row stacks: its field, on the touch floor, takes the width of the row.
  const language = account.getByRole('combobox', { name: LANGUAGE.pt.control })
  await expect(language).toBeVisible()
  const field = await language.boundingBox()
  const languageRow = await account.locator('section', { has: lev.getByRole('combobox', { name: LANGUAGE.pt.control }) }).boundingBox()
  expect(field!.height).toBeGreaterThanOrEqual(44)
  expect(Math.abs(field!.width - languageRow!.width)).toBeLessThanOrEqual(1)
  expect(await historyDepth(lev)).toBe(1)
  await lev.goBack()
  await expect(account).toHaveCount(0)
  await expect(conversations(lev)).toBeVisible()
  expect(await historyDepth(lev)).toBe(0)
  await expectSameUrl(lev)
  await expectNoProtocolLeak(lev)
})

test('7. width: 390 → 1024 with the list selects the first conversation; 1024 → 390 keeps it and back returns the list', async () => {
  await toList(lev)
  await lev.setViewportSize({ width: 1024, height: 800 })
  await expect(main(lev)).toBeVisible()
  // One read that refuses both states before the selection: the narrow header still mounted (empty title)
  // and the wide one before React selects (no channel). Going back to 390 earlier leaves nothing selected.
  const heading = main(lev).getByRole('heading', { level: 2 })
  let name = ''
  await expect(async () => {
    name = (await heading.innerText()).trim()
    expect(name).not.toBe('')
    expect(name).not.toBe('Selecione um canal')
  }).toPass()
  expect(await historyDepth(lev)).toBe(0)
  await lev.setViewportSize({ width: 390, height: 844 })
  await expect(main(lev).getByRole('heading', { level: 2, name })).toBeVisible()
  await expect(conversations(lev)).toHaveCount(0)
  await expect.poll(() => historyDepth(lev)).toBe(1)
  await lev.goBack()
  await expect(conversations(lev)).toBeVisible()
  await expectSameUrl(lev)
  await expectNoProtocolLeak(lev)
})

test('8. no horizontal scroll at 390 on the list, the conversation and the thread', async () => {
  await toList(lev)
  await noHorizontalScroll(lev)
  await openDm(lev)
  await noHorizontalScroll(lev)
  await row(lev, rootText).getByRole('button', { name: TIMELINE.replies(1) }).click()
  await expect(threadPanel(lev).getByRole('log', { name: THREAD.replies })).toContainText(replyText)
  await noHorizontalScroll(lev)
  await toList(lev)
  await expectNoProtocolLeak(lev)
})
