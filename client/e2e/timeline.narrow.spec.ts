import { test, expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { NEL, OLI } from './fixtures/users'
import { signIn } from './support/login'
import { VISIBILITY_SHIM } from './support/visibility'
import { channelRow, dmWith, mainComposer, messages, row, send, startDm, threadPanel } from './support/workspace'
import { expectNoProtocolLeak } from './support/assertions'
import { addMember, createChannel, deleteChannelsNamed, deleteSharedRooms, openManage } from './support/rooms'
import { COMPOSER, MANAGE, THREAD, TIMELINE } from './support/labels'

// Phone project (PLANO-MOBILE §0.12.2 R6 and R9, M3a): the narrow timeline at rest (workspace.md §23.3).
// nel reads at 390×844 with touch; oli writes on a wide window. A short conversation sits at the end (T7);
// "Carregar mensagens anteriores", the thread summary, the quote, the reaction line and "Tentar de novo"
// measure 44 high; the page never scrolls sideways. The approval card is measured by the unit render-scan
// and the fidelity PNGs (an agent is out of this pair's reach).

const NEL_NAME = 'nel'
const OLI_NAME = 'oli'
const BACK = 'Voltar'
const ts = Date.now()
const channel = `m3a-${ts}`
const shortText = `curta ${ts}`
const target = `alvo ${ts}`
const quoting = `citando ${ts}`
const threadReply = `no fio ${ts}`
const lost = `perdida ${ts}`
// Enough messages that the first page no longer reaches the room's start (initialSyncLimit 30), so the
// conversation offers "Carregar mensagens anteriores" after a fresh load.
const FILLER = 26
const filler = (i: number) => `enchimento ${i} ${ts}`
// Synapse answers an identical initial /sync from a cache for 2 minutes: a reload inside that window would
// get the snapshot from before the filler. nel's fresh load waits it out.
const SYNC_CACHE_MS = 125_000
const TOUCH_FLOOR = 44

let ctxNel: BrowserContext
let ctxOli: BrowserContext
let nel: Page
let oli: Page
let nelLoadedAt = 0

const main = (page: Page) => page.getByRole('main')
const noHorizontalScroll = async (page: Page) =>
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
const heightOf = async (l: Locator): Promise<number> => (await l.boundingBox())!.height
async function backToList(page: Page): Promise<void> {
  const back = main(page).getByRole('button', { name: BACK })
  if ((await back.count()) > 0) await back.click()
}

async function wideContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 })
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000)
  await deleteSharedRooms(NEL_NAME, OLI_NAME)
  await deleteChannelsNamed('m3a-')
  ctxNel = await browser.newContext()
  await ctxNel.addInitScript(VISIBILITY_SHIM)
  ctxOli = await wideContext(browser)
  nel = await ctxNel.newPage()
  oli = await ctxOli.newPage()
  await signIn(nel, NEL)
  nelLoadedAt = Date.now()
  await signIn(oli, OLI)
})

test.afterAll(async () => {
  await ctxNel?.close()
  await ctxOli?.close()
  await deleteChannelsNamed('m3a-')
})

test('1. a short conversation sits at the end of the timeline; no sideways scroll', async () => {
  test.setTimeout(150_000)
  await createChannel(oli, { name: channel, kind: 'private' })
  await openManage(oli, channel, 'private')
  await addMember(oli, NEL_NAME)
  await oli.getByRole('button', { name: MANAGE.close }).click()
  await send(oli, shortText)

  await expect(channelRow(nel, channel)).toBeVisible({ timeout: 60_000 })
  await channelRow(nel, channel).click()
  const timeline = messages(nel)
  await expect(timeline).toContainText(shortText, { timeout: 60_000 })
  const geometry = await timeline.evaluate((el) => {
    const box = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    const rows = el.querySelectorAll('article')
    const last = rows[rows.length - 1]!.getBoundingClientRect()
    const first = el.querySelector(':scope > :not(.timeline__jump, .timeline__older)')!.getBoundingClientRect()
    return {
      scrolls: el.scrollHeight > el.clientHeight,
      // From the last row's bottom to the timeline's inner bottom edge.
      bottomGap: box.bottom - parseFloat(style.paddingBottom) - last.bottom,
      // From the timeline's inner top edge to the first row.
      topGap: first.top - box.top - parseFloat(style.paddingTop),
    }
  })
  expect(geometry.scrolls).toBe(false)
  expect(Math.abs(geometry.bottomGap)).toBeLessThanOrEqual(2)
  expect(geometry.topGap).toBeGreaterThan(100)
  await noHorizontalScroll(nel)
  await expectNoProtocolLeak(nel)
  await backToList(nel)
})

test('2. quote, thread summary, reactions and "Tentar de novo" measure 44', async () => {
  test.setTimeout(180_000)
  await startDm(oli, NEL_NAME)
  await send(oli, target)
  // oli answers the message, opens a thread on it and reacts to it from the wide action bar.
  const t = row(oli, target)
  await t.hover()
  await t.getByRole('button', { name: TIMELINE.reply, exact: true }).click()
  await send(oli, quoting)
  await row(oli, target).first().hover()
  await row(oli, target).first().getByRole('button', { name: TIMELINE.replyInThread }).click()
  const panel = threadPanel(oli)
  await panel.getByRole('textbox', { name: COMPOSER.editor, exact: true }).fill(threadReply)
  await panel.getByRole('button', { name: COMPOSER.send }).click()
  await expect(panel.getByRole('log', { name: THREAD.replies })).toContainText(threadReply)
  await panel.getByRole('button', { name: THREAD.close }).click()
  const root = row(oli, target).filter({ hasNot: oli.getByRole('button', { name: TIMELINE.repliedMessage }) })
  await root.hover()
  await root.getByRole('button', { name: TIMELINE.reactOpen }).click()
  await oli.getByRole('button', { name: TIMELINE.react('👍') }).first().click()

  await expect(dmWith(nel, OLI_NAME)).toBeVisible({ timeout: 60_000 })
  await dmWith(nel, OLI_NAME).click()
  const timeline = messages(nel)
  await expect(timeline).toContainText(quoting, { timeout: 60_000 })
  const nelRoot = row(nel, target).filter({ hasNot: nel.getByRole('button', { name: TIMELINE.repliedMessage }) })
  const summary = nelRoot.getByRole('button', { name: TIMELINE.replies(1) })
  await expect(summary).toBeVisible({ timeout: 60_000 })
  expect(await heightOf(summary)).toBeGreaterThanOrEqual(TOUCH_FLOOR)
  // The line itself has no role of its own; its box is what §23.3 item 7 sizes.
  const reactions = nelRoot.locator('.reactions')
  await expect(reactions).toBeVisible({ timeout: 60_000 })
  expect(await heightOf(reactions)).toBeGreaterThanOrEqual(TOUCH_FLOOR)
  // No "+" at the end of the line: reacting is in the action sheet (§23.3 item 7; M3b, the end of N3 a).
  await expect(reactions.getByRole('button', { name: TIMELINE.reactOpen })).toBeHidden()
  const quote = row(nel, quoting).getByRole('button', { name: TIMELINE.repliedMessage })
  expect(await heightOf(quote)).toBeGreaterThanOrEqual(TOUCH_FLOOR)

  // A message that cannot reach the server: "Não enviado · Tentar de novo", the retry on the floor.
  const SEND = /\/_matrix\/client\/v3\/rooms\/[^/]+\/send\//
  await nel.route(SEND, (route) => route.abort())
  await mainComposer(nel).fill(lost)
  await main(nel).getByRole('button', { name: COMPOSER.send }).click()
  const retry = row(nel, lost).getByRole('button', { name: TIMELINE.retry })
  await expect(retry).toBeVisible({ timeout: 60_000 })
  expect(await heightOf(retry)).toBeGreaterThanOrEqual(TOUCH_FLOOR)
  await nel.unroute(SEND)
  await retry.click()
  await expect(row(nel, lost).getByText(TIMELINE.failed)).toHaveCount(0, { timeout: 60_000 })
  await noHorizontalScroll(nel)
  await expectNoProtocolLeak(nel)
  await backToList(nel)
})

test('3. "Carregar mensagens anteriores" on top, 44 high, once the history no longer fits the first page', async () => {
  test.setTimeout(420_000)
  // oli's burst drains through the server's message rate limit.
  for (let i = 1; i <= FILLER; i++) await send(oli, filler(i))
  const wait = SYNC_CACHE_MS - (Date.now() - nelLoadedAt)
  if (wait > 0) await nel.waitForTimeout(wait)
  await nel.reload()
  nelLoadedAt = Date.now()
  await expect(dmWith(nel, OLI_NAME)).toBeVisible({ timeout: 60_000 })
  await dmWith(nel, OLI_NAME).click()
  const timeline = messages(nel)
  await expect(timeline).toContainText(filler(FILLER), { timeout: 120_000 })
  const older = timeline.getByRole('button', { name: TIMELINE.loadOlder })
  await expect(older).toBeAttached()
  await older.scrollIntoViewIfNeeded()
  expect(await heightOf(older)).toBeGreaterThanOrEqual(TOUCH_FLOOR)
  // On top: the button is the timeline's first child (the jump pill aside).
  expect(await timeline.evaluate((el) => el.querySelector(':scope > :not(.timeline__jump)')?.classList.contains('timeline__older'))).toBe(true)
  await noHorizontalScroll(nel)
  await expectNoProtocolLeak(nel)
})
