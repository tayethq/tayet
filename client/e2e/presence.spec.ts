import { test, expect, type Locator, type Page } from '@playwright/test'
import { GUS, HAL } from './fixtures/users'
import { openProfileOf } from './support/account'
import { expectNoProtocolLeak } from './support/assertions'
import { ConsoleLedger, FIRST_LOGIN_404, recognizedSet404 } from './support/console'
import { ACCOUNT, MANAGE, PROFILE } from './support/labels'
import { signIn } from './support/login'
import { addMember, createChannel, deleteSharedRooms, openManage } from './support/rooms'
import { dmWith, startDm } from './support/workspace'

// ROTEIRO-U2 rev. 2 item 2.1: presence through real absence (ADR-056). gus (A) watches; hal is signed
// in on two contexts and closes both. hal's indicator goes off where gus sees it — the DM row, the
// roster of a channel they share and hal's profile — and comes back when hal opens a new context.
// No timeout knob on the stack: the server declares the absence on its own clock, as in production, so
// the ceiling (60 s) is a ceiling, not a measured time. The pair exchanges no message: nothing here
// depends on a new device reading history. The DOM is scanned for protocol ids (P1) at every step.

// Display names as the MAS imported them from the Dex `name` claim (see conversation.spec.ts).
const HAL_NAME = 'hal'
const GUS_NAME = 'gus'
const CEILING_MS = 60_000

// The dot is decorative (aria-hidden, the Avatar primitive): asserted structurally. The profile also
// says it in words, and that line is what a screen reader gets.
const dotIn = (scope: Locator) => scope.locator('[data-presence="online"]')
const rosterRow = (page: Page, name: string) =>
  page.getByRole('region', { name: MANAGE.members }).getByRole('listitem').filter({ hasText: name })

// The three surfaces, in the order gus would go through them. The first wait spends the ceiling; the
// other two follow the same presence map, each on what is left of it.
async function expectPresenceAt(page: Page, channelName: string, online: boolean, since: number): Promise<void> {
  const left = () => Math.max(1_000, CEILING_MS - (Date.now() - since))
  const expectDot = async (scope: Locator) => {
    await expect(scope).toBeVisible() // a surface that is not there has no dot either
    await expect(dotIn(scope)).toHaveCount(online ? 1 : 0, { timeout: left() })
  }

  await expectDot(dmWith(page, HAL_NAME))
  await openManage(page, channelName)
  await expectDot(rosterRow(page, HAL_NAME))
  await expectNoProtocolLeak(page)
  const profile = await openProfileOf(page, HAL_NAME)
  await expect(profile).toContainText(online ? PROFILE.presenceOnline : PROFILE.presenceOffline, { timeout: left() })
  await expectNoProtocolLeak(page)
  await profile.getByRole('button', { name: ACCOUNT.close, exact: true }).click()
  await expect(profile).toHaveCount(0)
  const panel = page.getByRole('button', { name: MANAGE.close })
  if ((await panel.count()) > 0) await panel.click()
}

test.beforeAll(async () => {
  await deleteSharedRooms('gus', 'hal')
})

test('presence: the indicator goes off when every context of hal closes, and comes back when hal returns', async ({ browser }) => {
  test.setTimeout(240_000)
  const channelName = `pres-${Date.now()}`

  const ctxA = await browser.newContext()
  const ctxB1 = await browser.newContext()
  const ctxB2 = await browser.newContext()
  const ctxB3 = await browser.newContext()
  // Boots: one login per page, no reload.
  const consoleA = new ConsoleLedger('gus', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  const consoleB1 = new ConsoleLedger('hal B1', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  const consoleB2 = new ConsoleLedger('hal B2', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  const consoleB3 = new ConsoleLedger('hal B3', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  try {
    const pageA = await ctxA.newPage()
    const b1 = await ctxB1.newPage()
    const b2 = await ctxB2.newPage()
    consoleA.watch(pageA, 'A')
    consoleB1.watch(b1, 'B1')
    consoleB2.watch(b2, 'B2')

    await test.step('1. gus and hal share a DM and a public channel; hal is online on all three surfaces', async () => {
      await signIn(pageA, GUS)
      await signIn(b1, HAL)
      await signIn(b2, HAL)
      await startDm(pageA, HAL_NAME)
      await expect(dmWith(b1, GUS_NAME)).toBeVisible({ timeout: 60_000 })
      await createChannel(pageA, { name: channelName, kind: 'public' })
      await openManage(pageA, channelName)
      await addMember(pageA, HAL_NAME)
      await pageA.getByRole('button', { name: MANAGE.close }).click()
      await expectPresenceAt(pageA, channelName, true, Date.now())
    })

    await test.step('2. hal closes every context: the indicator goes off on all three within the ceiling', async () => {
      await Promise.all([ctxB1.close(), ctxB2.close()])
      const closedAt = Date.now()
      await expectPresenceAt(pageA, channelName, false, closedAt)
      console.log(`[e2e] hal offline at gus ${Date.now() - closedAt} ms after the last context closed`)
    })

    await test.step('3. hal opens a new context: the indicator comes back on all three within the ceiling', async () => {
      const b3 = await ctxB3.newPage()
      consoleB3.watch(b3, 'B3')
      await signIn(b3, HAL)
      const backAt = Date.now()
      await expectPresenceAt(pageA, channelName, true, backAt)
      console.log(`[e2e] hal online at gus ${Date.now() - backAt} ms after the sign-in`)
      await expectNoProtocolLeak(pageA, b3)
    })

    console.log(`[e2e] console A: ${JSON.stringify(consoleA.observed())}`)
    console.log(`[e2e] console B1: ${JSON.stringify(consoleB1.observed())}`)
    console.log(`[e2e] console B2: ${JSON.stringify(consoleB2.observed())}`)
    console.log(`[e2e] console B3: ${JSON.stringify(consoleB3.observed())}`)
    consoleA.expectClean()
    consoleB1.expectClean()
    consoleB2.expectClean()
    consoleB3.expectClean()
  } finally {
    await ctxA.close()
    await ctxB1.close()
    await ctxB2.close()
    await ctxB3.close()
  }
})
