import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { EDU, FLO } from './fixtures/users'
import { expectNoProtocolLeak } from './support/assertions'
import { ConsoleLedger, FIRST_LOGIN_404, recognizedSet404 } from './support/console'
import { COMPOSER, THREAD, TIMELINE } from './support/labels'
import { signIn } from './support/login'
import { NotificationStub } from './support/notifications'
import { deleteSharedRooms } from './support/rooms'
import { setHidden, VISIBILITY_SHIM } from './support/visibility'
import { dmWith, highlighted, row, send, startDm, threadPanel } from './support/workspace'

// Phone project (ADR-073 addendum, 23/Nov/2026; issue #421 B): edu, at 390×844 with touch, is notified of a
// thread reply in the DM with flo and taps the notification: the thread screen opens on the reply, marked. flo
// writes on a wide window. As in notifications.spec.ts, window.Notification is the stub of
// support/notifications.ts (here already `granted`: the gesture is that spec's subject) and the background is
// the VISIBILITY_SHIM. The behaviour of the tap on the installed iOS app is not reproduced here (§0 of the push
// track).

const EDU_NAME = 'edu'
const FLO_NAME = 'flo'
const ts = Date.now()
const rootText = `raiz ${ts}`
const replyText = `no fio ${ts}`

async function wideContext(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 })
}

test('a thread reply\'s notification, tapped on the phone, opens the thread screen on the reply', async ({ browser }) => {
  test.setTimeout(240_000)
  await deleteSharedRooms(EDU_NAME, FLO_NAME)
  const ctxEdu = await browser.newContext()
  const ctxFlo = await wideContext(browser)
  const stub = await NotificationStub.install(ctxEdu, 'granted')
  await ctxEdu.addInitScript(VISIBILITY_SHIM)
  const shown = stub.shown
  const ledgerEdu = new ConsoleLedger('edu', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  const ledgerFlo = new ConsoleLedger('flo', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  try {
    const edu: Page = await ctxEdu.newPage()
    const flo: Page = await ctxFlo.newPage()
    ledgerEdu.watch(edu, 'edu')
    ledgerFlo.watch(flo, 'flo')

    await test.step('1. the pair enters; flo opens the DM; edu, on the list and hidden, is notified of the root', async () => {
      await signIn(edu, EDU)
      await signIn(flo, FLO)
      await startDm(flo, EDU_NAME)
      // The invite is auto-joined on edu's side (ADR-044).
      await expect(dmWith(edu, FLO_NAME)).toBeVisible({ timeout: 60_000 })
      await setHidden(edu, true)
      await send(flo, rootText)
      await expect.poll(() => shown.length, { timeout: 60_000 }).toBe(1)
      expect({ title: shown[0]!.title, body: shown[0]!.body }).toEqual({ title: FLO_NAME, body: rootText })
    })

    await test.step('2. flo replies in a thread of the root; edu is notified of the reply', async () => {
      const root = row(flo, rootText)
      await root.hover()
      await root.getByRole('button', { name: TIMELINE.replyInThread }).click()
      const panel = threadPanel(flo)
      await panel.getByRole('textbox', { name: COMPOSER.editor, exact: true }).fill(replyText)
      await panel.getByRole('button', { name: COMPOSER.send }).click()
      await expect(panel.getByRole('log', { name: THREAD.replies })).toContainText(replyText)
      await expect.poll(() => shown.length, { timeout: 60_000 }).toBe(2)
      expect({ title: shown[1]!.title, body: shown[1]!.body }).toEqual({ title: FLO_NAME, body: replyText })
    })

    await test.step('3. the tap on the reply\'s notification: the window is focused, the thread screen shows the reply marked, the notification closes', async () => {
      const focusesBefore = stub.focuses
      await stub.click(edu, shown[1]!)
      const panel = threadPanel(edu)
      await expect(panel).toBeVisible({ timeout: 30_000 })
      await expect(highlighted(edu)).toContainText(replyText, { timeout: 30_000 })
      await expect(panel.getByRole('log', { name: THREAD.replies })).toContainText(replyText)
      await expect(panel.locator('article').filter({ hasText: replyText })).toBeInViewport()
      expect(stub.focuses).toBe(focusesBefore + 1)
      await expect.poll(() => shown[1]!.closed).toBe(true)
      await setHidden(edu, false)
      await expectNoProtocolLeak(edu)
    })

    console.log(`[e2e] notified: ${JSON.stringify(shown.map((n) => ({ title: n.title, closed: n.closed })))}`)
    ledgerEdu.expectClean()
    ledgerFlo.expectClean()
  } finally {
    await ctxEdu.close()
    await ctxFlo.close()
    await deleteSharedRooms(EDU_NAME, FLO_NAME)
  }
})
