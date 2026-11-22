import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { MAX, NED } from './fixtures/users'
import { signIn } from './support/login'
import { conversations } from './support/workspace'
import { expectNoProtocolLeak } from './support/assertions'
import { deleteSharedRooms } from './support/rooms'
import { ConsoleLedger, FIRST_LOGIN_404, recognizedSet404 } from './support/console'
import { NEW_CONVERSATION } from './support/labels'

// Phone project (PLANO-MOBILE M6, new-conversation.md §11): "Nova conversa" as a full screen of the stack. max
// opens it at 390×844 with touch from the list's top: the focus on the ✕ (N1); the system's back closes it; a
// direct message opens from it with the creation held back by a route (~3 s): while it runs, Esc and the system's
// back leave the screen in place (N2), and the conversation comes in front at the end. The 10 s cap (T1) is a unit
// test, not here.

const MAX_NAME = 'max'
const NED_NAME = 'ned'

let ctxMax: BrowserContext
let ctxNed: BrowserContext
let max: Page
let ned: Page
// One ledger per person: the first-login caps are per browser context.
const ledgers = [new ConsoleLedger('max', [...FIRST_LOGIN_404, ...recognizedSet404(1)]), new ConsoleLedger('ned', [...FIRST_LOGIN_404, ...recognizedSet404(1)])]

const depth = (page: Page) => page.evaluate(() => (history.state as { depth?: number } | null)?.depth ?? 0)
const screenOf = (page: Page) => page.getByRole('region', { name: NEW_CONVERSATION.dialog })
const openCompose = (page: Page) => page.getByRole('button', { name: NEW_CONVERSATION.dialog, exact: true }).click()

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  test.setTimeout(240_000)
  await deleteSharedRooms(MAX_NAME, NED_NAME)
  ctxMax = await browser.newContext()
  ctxNed = await browser.newContext()
  max = await ctxMax.newPage()
  ned = await ctxNed.newPage()
  ledgers[0]!.watch(max, 'max')
  ledgers[1]!.watch(ned, 'ned')
  // ned signs in so that max finds ned in the known set (the org channel).
  await signIn(ned, NED)
  await signIn(max, MAX)
})

test.afterAll(async () => {
  await ctxMax?.close()
  await ctxNed?.close()
  await deleteSharedRooms(MAX_NAME, NED_NAME)
})

test('1. the screen opens with the focus on its ✕, and the system back closes it', async () => {
  await expect(conversations(max)).toBeVisible()
  await openCompose(max)
  await expect(screenOf(max)).toBeVisible()
  await expect(screenOf(max).getByRole('button', { name: NEW_CONVERSATION.close })).toBeFocused()
  await expect(screenOf(max).getByRole('button', { name: NEW_CONVERSATION.cancel })).toHaveCount(0)
  await expect(conversations(max)).toHaveCount(0)
  expect(await depth(max)).toBe(1)
  await max.goBack()
  await expect(screenOf(max)).toHaveCount(0)
  await expect(conversations(max)).toBeVisible()
  expect(await depth(max)).toBe(0)
})

test('2. a direct message opens from the screen; while the creation runs, Esc and back do not close it; the conversation comes in front', async () => {
  test.setTimeout(150_000)
  const contact = screenOf(max).getByRole('button', { name: NED_NAME, exact: true })
  // The known set is read when the screen opens; ned's join of the org channel may reach max a moment later.
  await expect(async () => {
    if ((await screenOf(max).count()) > 0) await screenOf(max).getByRole('button', { name: NEW_CONVERSATION.close }).click()
    await openCompose(max)
    await screenOf(max).getByRole('button', { name: NEW_CONVERSATION.dm, exact: true }).click()
    await expect(contact).toBeVisible({ timeout: 5_000 })
  }).toPass({ timeout: 60_000 })
  await contact.click()
  await expect(contact).toHaveAttribute('aria-pressed', 'true')
  // The room creation is held back about 3 s, so the send is in flight while the screen is tried.
  let held = 0
  await max.route('**/_matrix/client/v3/createRoom', async (route) => {
    held += 1
    await new Promise((r) => setTimeout(r, 3_000))
    await route.continue()
  })
  await screenOf(max).getByRole('button', { name: NEW_CONVERSATION.startConversation }).click()
  await expect.poll(() => held).toBe(1)
  // Esc from inside the screen (the filter), where the screen listens for it.
  await screenOf(max).locator('input').first().focus()
  await max.keyboard.press('Escape')
  await expect(screenOf(max)).toBeVisible()
  await expect(screenOf(max).getByRole('button', { name: NEW_CONVERSATION.close })).toBeDisabled()
  await max.goBack()
  await expect(screenOf(max)).toBeVisible()
  expect(await depth(max)).toBe(1)
  await expect(screenOf(max)).toHaveCount(0, { timeout: 30_000 })
  await max.unroute('**/_matrix/client/v3/createRoom')
  await expect(max.getByRole('main').getByRole('heading', { level: 2, name: NED_NAME })).toBeVisible({ timeout: 30_000 })
  expect(await depth(max)).toBe(1)
  await expectNoProtocolLeak(max)
  for (const l of ledgers) l.expectClean()
})
