import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { KIT, LOU } from './fixtures/users'
import { signIn } from './support/login'
import { conversations, dmWith, highlighted, searchResults, send, startDm } from './support/workspace'
import { expectNoProtocolLeak } from './support/assertions'
import { deleteSharedRooms } from './support/rooms'
import { ConsoleLedger, FIRST_LOGIN_404, recognizedSet404 } from './support/console'
import { SEARCH } from './support/labels'

// Phone project (PLANO-MOBILE M6 B1, workspace.md §23.5 item 3): the full-screen search. kit searches at 390×844
// with touch; lou writes to kit on a wide window. The list's "buscar" opens the screen with the field focused; a
// hit opens the conversation with the message marked; back finds the search with its query and results; back
// again finds the list, and the search opens empty.

const KIT_NAME = 'kit'
const LOU_NAME = 'lou'
const ts = Date.now()
const term = `termo${ts}`
const target = `a nota do ${term} chegou`

let ctxKit: BrowserContext
let ctxLou: BrowserContext
let kit: Page
let lou: Page
// One ledger per person: the first-login caps are per browser context.
const ledgers = [new ConsoleLedger('kit', [...FIRST_LOGIN_404, ...recognizedSet404(1)]), new ConsoleLedger('lou', [...FIRST_LOGIN_404, ...recognizedSet404(1)])]

const depth = (page: Page) => page.evaluate(() => (history.state as { depth?: number } | null)?.depth ?? 0)
const screenOf = (page: Page) => page.getByRole('region', { name: SEARCH.field })
const fieldOf = (page: Page) => screenOf(page).getByRole('textbox', { name: SEARCH.field })

async function wideContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 })
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000)
  await deleteSharedRooms(KIT_NAME, LOU_NAME)
  ctxKit = await browser.newContext()
  ctxLou = await wideContext(browser)
  kit = await ctxKit.newPage()
  lou = await ctxLou.newPage()
  ledgers[0]!.watch(kit, 'kit')
  ledgers[1]!.watch(lou, 'lou')
  await signIn(kit, KIT)
  await signIn(lou, LOU)
})

test.afterAll(async () => {
  await ctxKit?.close()
  await ctxLou?.close()
  await deleteSharedRooms(KIT_NAME, LOU_NAME)
})

test('1. open, query, open a hit, back to the results, back to the list without a query', async () => {
  test.setTimeout(150_000)
  await startDm(lou, KIT_NAME)
  await send(lou, target)
  await expect(dmWith(kit, LOU_NAME)).toBeVisible({ timeout: 60_000 })

  // The list's "buscar" is a button, not a field; it opens the screen with the field focused.
  await expect(conversations(kit).getByRole('textbox')).toHaveCount(0)
  await kit.getByRole('button', { name: SEARCH.field }).click()
  await expect(fieldOf(kit)).toBeFocused()
  expect(await depth(kit)).toBe(1)

  // The message reaches kit's index from the stream: the query is retried until the hit shows.
  const hit = searchResults(kit).getByRole('button', { name: `${LOU_NAME}: ${target}` })
  await expect(async () => {
    await fieldOf(kit).fill('')
    await fieldOf(kit).fill(term)
    await expect(hit).toBeVisible({ timeout: 3_000 })
  }).toPass({ timeout: 60_000 })
  await hit.click()
  await expect(kit.getByRole('main')).toBeVisible()
  await expect(highlighted(kit)).toContainText(target, { timeout: 30_000 })
  expect(await depth(kit)).toBe(2)

  await kit.goBack()
  await expect(screenOf(kit)).toBeVisible()
  await expect(fieldOf(kit)).toHaveValue(term)
  await expect(hit).toHaveAttribute('aria-current', 'true')

  await kit.goBack()
  await expect(conversations(kit)).toBeVisible()
  expect(await depth(kit)).toBe(0)
  await kit.getByRole('button', { name: SEARCH.field }).click()
  await expect(fieldOf(kit)).toHaveValue('')
  expect(await kit.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0)
  await expectNoProtocolLeak(kit)
  for (const l of ledgers) l.expectClean()
})
