import { test, expect, type Page } from '@playwright/test'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { OTO, PIA } from './fixtures/users'
import { ConsoleLedger, FIRST_LOGIN_404, recognizedSet404 } from './support/console'
import { signIn } from './support/login'
import { NotificationStub } from './support/notifications'
import { setHidden, VISIBILITY_SHIM } from './support/visibility'
import { conversations, dmWith, messages, orgChannel, send, title } from './support/workspace'
import { expectNoProtocolLeak } from './support/assertions'
import { deleteSharedRooms } from './support/rooms'
import { countedInDirectMessage } from './support/server-facts'
import { COMPOSER, LIST, NEW_CONVERSATION } from './support/labels'

// ADR-073: notifications from the live tab. oto (A) writes; pia (B) is the one notified — the spec's own
// Dex pair (fixtures/users.ts, one pair per spec). The system notification and the browser's prompt are not
// observable headless, so pia's context replaces window.Notification by a stub that owns the permission
// (support/notifications.ts): it starts at `default`, counts requestPermission and answers what the test
// chose, keeps the permission across a reload, reports every construction (title + body) and lets the test
// click one. The permission is asked only from the click on "Ativar notificações" (dec. 6): never at boot,
// never on an incoming message; denied, the prompt goes away with no error and does not come back after a
// reload; cleared and granted, it goes away too. Then the app's decision: a DM to a hidden tab notifies once
// with the name and the text; the click on that notification focuses the window, selects the DM and closes
// the notification (dec. 4); the open DM in a visible and focused tab does not notify, a channel message
// without mention does not, a mention does ("oto em #all") — and the tab title counts what notifies.
// Headless Chromium reports document.hasFocus() === true on every page, so visibility (VISIBILITY_SHIM) is
// the knob of the suppression (dec. 4).

// Display names as the MAS imported them from the Dex `name` claim (see conversation.spec.ts).
const OTO_NAME = 'oto'
const PIA_NAME = 'pia'

// A negative assertion needs the message to have reached pia first (it is on pia's screen), and then a
// beat for a notification that should not exist to have shown up if it were going to.
const SETTLE_MS = 1_000

function expectCleanNotification(n: { title: string; body: string }): void {
  expect(findProtocolLeaksInText(`${n.title}\n${n.body}`)).toEqual([])
  for (const shape of ['@', '!', ':tayet.local']) expect(n.title).not.toContain(shape)
  expect(n.body).not.toContain(':tayet.local')
}

// pia's tab title, with the server's side when it is off (issue #7: once "(3) Tayet" after two messages).
// On failure the message carries what the server counted for pia in the DM with oto, next to what the
// screen shows — shapes only (support/server-facts.ts), never an id or a body.
async function expectPiaTitle(page: Page, expected: string): Promise<void> {
  try {
    await expect(page).toHaveTitle(expected)
  } catch (err) {
    const screen = { title: await page.title(), row: (await dmWith(page, OTO_NAME).innerText().catch(() => '')).replace(/\s+/g, ' ') }
    const server = await countedInDirectMessage('pia', 'oto').catch((e: unknown) => ({ probeFailed: String(e) }))
    throw new Error(`${(err as Error).message}\nscreen: ${JSON.stringify(screen)}\nthe server counted: ${JSON.stringify(server)}`, { cause: err })
  }
}

// Hermetic start: the oto↔pia DM of earlier runs is deleted, so this run creates its own and pia's DM
// unread starts at zero.
test.beforeAll(async () => {
  await deleteSharedRooms('oto', 'pia')
})

test('web notifications: permission by gesture, denied without error, DM to a hidden tab notifies, its click brings the DM, title counts', async ({
  browser,
}) => {
  test.setTimeout(240_000)
  const ts = Date.now()
  const d1 = `d-1 ${ts}`
  const d2 = `d-2 ${ts}`
  const n1 = `n-1 ${ts}`
  const n2 = `n-2 ${ts}`
  const n3 = `n-3 ${ts}`
  const n4 = `n-4 ${ts}`

  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  const stub = await NotificationStub.install(ctxB, 'default')
  await ctxB.addInitScript(VISIBILITY_SHIM)
  const shown = stub.shown
  // Boots: oto 1 (login); pia 3 (login, the reload after the denial, the reload after the permission is cleared).
  const consoleA = new ConsoleLedger('oto', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  const consoleB = new ConsoleLedger('pia', [...FIRST_LOGIN_404, ...recognizedSet404(3)])
  try {
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()
    consoleA.watch(pageA, 'A')
    consoleB.watch(pageB, 'B')
    const enable = pageB.getByRole('button', { name: LIST.enableNotifications })

    await test.step('1. permission `default`: the prompt shows and nothing asks; a DM to the hidden tab builds nothing; the title counts', async () => {
      await signIn(pageA, OTO)
      await signIn(pageB, PIA)
      await expect(enable).toBeVisible()
      await orgChannel(pageB).click()
      await conversations(pageA).getByRole('button', { name: LIST.newDm }).click()
      const dialog = pageA.getByRole('dialog', { name: NEW_CONVERSATION.dialog })
      const contact = dialog.getByRole('button', { name: PIA_NAME, exact: true })
      await contact.click()
      await dialog.getByRole('button', { name: NEW_CONVERSATION.startConversation }).click()
      await expect(dialog).toHaveCount(0)
      await dmWith(pageA, PIA_NAME).click()
      // The invite is auto-joined on pia's side (ADR-044).
      await expect(dmWith(pageB, OTO_NAME)).toBeVisible()
      await expectPiaTitle(pageB, 'Tayet')

      await setHidden(pageB, true)
      await send(pageA, d1)
      await expectPiaTitle(pageB, '(1) Tayet')
      await pageB.waitForTimeout(SETTLE_MS)
      expect(shown).toEqual([])
      expect(stub.requests, 'requestPermission before any click').toBe(0)
      await setHidden(pageB, false)
    })

    await test.step('2. denied: one request on the click, the prompt goes, no alert; nothing notifies; a reload keeps it gone', async () => {
      await stub.answerRequestsWith(pageB, 'denied')
      await enable.click()
      await expect.poll(() => stub.requests).toBe(1)
      await expect(enable).toHaveCount(0)
      await expect(pageB.getByRole('alert')).toHaveCount(0)
      await setHidden(pageB, true)
      await send(pageA, d2)
      await expectPiaTitle(pageB, '(2) Tayet')
      await pageB.waitForTimeout(SETTLE_MS)
      expect(shown).toEqual([])
      await pageB.reload()
      await expect(title(pageB)).toBeVisible()
      await expect(dmWith(pageB, OTO_NAME)).toBeVisible()
      await expect(enable).toHaveCount(0)
      await expect(pageB.getByRole('alert')).toHaveCount(0)
      expect(stub.requests).toBe(1)
    })

    await test.step('3. cleared and granted: the prompt is back after a reload; one request on the click; pia reads the DM', async () => {
      // The person clears the site's permission in the browser, then reloads.
      await stub.setPermission(pageB, 'default')
      await pageB.reload()
      await expect(title(pageB)).toBeVisible()
      await expect(enable).toBeVisible()
      expect(stub.requests, 'no request at boot').toBe(1)
      await stub.answerRequestsWith(pageB, 'granted')
      await enable.click()
      await expect.poll(() => stub.requests).toBe(2)
      await expect(enable).toHaveCount(0)
      await expect(pageB.getByRole('alert')).toHaveCount(0)
      await dmWith(pageB, OTO_NAME).click()
      await expect(messages(pageB)).toContainText(d2)
      await expectPiaTitle(pageB, 'Tayet')
      await orgChannel(pageB).click()
      expect(shown).toEqual([])
    })

    await test.step('4. pia hidden: a DM from oto notifies once, with the sender name and the text; the title counts it', async () => {
      await setHidden(pageB, true)
      await send(pageA, n1)
      await expect.poll(() => shown.length).toBe(1)
      expect({ title: shown[0]!.title, body: shown[0]!.body }).toEqual({ title: OTO_NAME, body: n1 })
      expectCleanNotification(shown[0]!)
      await expectPiaTitle(pageB, '(1) Tayet')
    })

    await test.step('5. the click on the notification: the window is focused, the DM is selected and on screen, the notification closes', async () => {
      const focusesBefore = stub.focuses
      await stub.click(pageB, shown[0]!)
      await expect(dmWith(pageB, OTO_NAME)).toHaveAttribute('aria-current', 'true')
      await expect(messages(pageB)).toContainText(n1)
      expect(stub.focuses).toBe(focusesBefore + 1)
      await expect.poll(() => shown[0]!.closed).toBe(true)
      await setHidden(pageB, false)
      await expectPiaTitle(pageB, 'Tayet')
    })

    await test.step('6. pia visible, focused, on the DM: another DM does not notify', async () => {
      await send(pageA, n2)
      await expect(messages(pageB)).toContainText(n2)
      await pageB.waitForTimeout(SETTLE_MS)
      expect(shown).toHaveLength(1)
    })

    await test.step('7. pia hidden on the org channel: oto writes there without a mention, no notification', async () => {
      await orgChannel(pageB).click()
      await setHidden(pageB, true)
      await orgChannel(pageA).click()
      await send(pageA, n3)
      await expect(messages(pageB)).toContainText(n3)
      await pageB.waitForTimeout(SETTLE_MS)
      expect(shown).toHaveLength(1)
    })

    await test.step('8. oto mentions pia through the picker in the org channel: it notifies, "oto em #all"', async () => {
      const composer = pageA.getByRole('textbox', { name: COMPOSER.editor, exact: true })
      await composer.click()
      await composer.pressSequentially(`@${PIA_NAME}`)
      await pageA.getByRole('listbox', { name: COMPOSER.mention }).getByRole('option', { name: PIA_NAME, exact: true }).click()
      await composer.pressSequentially(n4)
      await pageA.getByRole('button', { name: COMPOSER.send }).click()
      await expect(messages(pageA)).toContainText(n4)
      await expect.poll(() => shown.length).toBe(2)
      expect(shown[1]!.title).toBe(`${OTO_NAME} em #all`)
      expect(shown[1]!.body).toContain(n4)
      expectCleanNotification(shown[1]!)
      await expectNoProtocolLeak(pageB)
    })

    expect(stub.requests).toBe(2)
    console.log(`[e2e] notified: ${JSON.stringify(shown)}`)
    console.log(`[e2e] console A: ${JSON.stringify(consoleA.observed())}`)
    console.log(`[e2e] console B: ${JSON.stringify(consoleB.observed())}`)
    consoleA.expectClean()
    consoleB.expectClean()
  } finally {
    await ctxA.close()
    await ctxB.close()
  }
})
