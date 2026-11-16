import { test, expect, type Page } from '@playwright/test'
import { escapeRegExp, HS_URL } from '../test/support/stack-env'
import { UNA, VIC } from './fixtures/users'
import { ConsoleLedger, FIRST_LOGIN_404, recognizedSet404 } from './support/console'
import { signIn } from './support/login'
import { conversations } from './support/workspace'
import { expectNoProtocolLeak } from './support/assertions'
import { deleteSharedRooms } from './support/rooms'
import { LIST, MANAGE, NEW_CONVERSATION } from './support/labels'

// ADR-076: archive and restore a channel, end to end, with the sidebar's Archived section (manifest
// workspace.md §9). vic (A) creates, archives and restores; una (B) watches — the spec's own Dex pair
// (fixtures/users.ts, one pair per spec). Archiving moves the channel from "Canais" to "Arquivados · 1"
// (collapsed) on both sides without a reload; an expanded row has no control that opens the channel.
// una, a member without the power to restore, gets the honest inline failure (dec. 7). vic restores:
// the row leaves, the channel is back in "Canais" on both sides and the section goes. Whether the section
// is expanded is remembered per origin (dec. 7): una's choice survives a reload and a new page of the
// same context (the old one closed, which frees the tab lock), both ways. The DOM is scanned for
// protocol ids (P1) at every step.

// Display names as the MAS imported them from the Dex `name` claim (see conversation.spec.ts).
const UNA_NAME = 'una'

const archivedSection = (page: Page) => conversations(page).getByRole('region', { name: LIST.archived })

// una's restore is refused by the server (power level): Chromium logs the 403 of the state write.
const RESTORE_FORBIDDEN_403 = {
  url: `${HS_URL}/_matrix/client/v3/rooms/*/state/io.tayet.archived/`,
  pattern: new RegExp(`^${escapeRegExp(HS_URL)}\\/_matrix\\/client\\/v3\\/rooms\\/[^/?]+\\/state\\/io\\.tayet\\.archived\\/?$`),
  status: 403,
  max: 1,
  per: 'page' as const,
  why: 'una (member, PL 0) tries to restore: the server refuses honestly (ADR-076 dec. 7)',
}

// Hermetic start: the una↔vic channels of earlier runs are deleted, so this run creates its own.
test.beforeAll(async () => {
  await deleteSharedRooms('una', 'vic')
})

test('archive: the channel moves to Arquivados for both, a member cannot restore, the creator restores it', async ({
  browser,
}) => {
  test.setTimeout(180_000)
  const channelName = `arq-${Date.now()}`
  const channelRow = (page: Page) =>
    conversations(page)
      .getByRole('region', { name: LIST.channels })
      .getByRole('button', { name: new RegExp(`^#${channelName}(\\s|$)`) })
  const archivedRow = (page: Page) => archivedSection(page).getByRole('listitem').filter({ hasText: `#${channelName}` })
  const restoreButton = (page: Page) => archivedSection(page).getByRole('button', { name: `Restaurar #${channelName}` })

  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  // Boots: one login per page; una's first page also reloads once (step 4), and each new page of hers
  // boots once.
  const consoleA = new ConsoleLedger('vic', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  const consoleB = new ConsoleLedger('una', [...FIRST_LOGIN_404, ...recognizedSet404(2)])
  try {
    const pageA = await ctxA.newPage()
    let pageB = await ctxB.newPage()
    consoleA.watch(pageA, 'A')
    consoleB.watch(pageB, 'B')

    await test.step('1. vic and una log in; vic creates a public channel and adds una; both see it in Canais', async () => {
      await signIn(pageA, VIC)
      await signIn(pageB, UNA)
      await conversations(pageA).getByRole('button', { name: LIST.newChannel }).click()
      const create = pageA.getByRole('dialog', { name: NEW_CONVERSATION.dialog })
      await create.getByLabel(NEW_CONVERSATION.name).fill(channelName)
      await create.getByRole('button', { name: NEW_CONVERSATION.public }).click()
      await create.getByRole('button', { name: NEW_CONVERSATION.createChannel }).click()
      await expect(create).toHaveCount(0)
      await channelRow(pageA).click()
      await pageA.getByRole('button', { name: MANAGE.open(`#${channelName}`) }).click()
      // The candidates are read when the dialog opens; una's first-login join of the org channel may
      // reach vic's client a moment later, so the dialog is reopened until una is in it.
      const add = pageA.getByRole('dialog', { name: MANAGE.addMember })
      const contact = add.getByRole('button', { name: UNA_NAME, exact: true })
      await expect(async () => {
        if ((await add.count()) > 0) await pageA.keyboard.press('Escape')
        await pageA.getByRole('button', { name: MANAGE.addMember }).click()
        await expect(contact).toBeVisible({ timeout: 5_000 })
      }).toPass({ timeout: 60_000 })
      await contact.click()
      await expect(pageA.getByRole('region', { name: MANAGE.members })).toContainText(UNA_NAME)
      // The invite is auto-joined on una's side (ADR-044).
      await expect(channelRow(pageB)).toBeVisible({ timeout: 60_000 })
      await expect(archivedSection(pageA)).toHaveCount(0)
      await expect(archivedSection(pageB)).toHaveCount(0)
      await expectNoProtocolLeak(pageA)
      await expectNoProtocolLeak(pageB)
    })

    await test.step('2. vic archives from the panel; without a reload it leaves Canais and "Arquivados · 1" appears, collapsed, on both', async () => {
      await pageA.getByRole('button', { name: MANAGE.archive }).click()
      await pageA.getByRole('button', { name: MANAGE.confirmArchive, exact: true }).click()
      for (const page of [pageA, pageB]) {
        await expect(channelRow(page)).toHaveCount(0, { timeout: 60_000 })
        const toggle = archivedSection(page).getByRole('button', { name: /^Arquivados · 1/ })
        await expect(toggle).toBeVisible()
        await expect(toggle).toHaveAttribute('aria-expanded', 'false')
        await expect(archivedRow(page)).toHaveCount(0)
        await expectNoProtocolLeak(page)
      }
    })

    await test.step('3. una expands: the row has no control that opens the channel; her restore is refused inline', async () => {
      await archivedSection(pageB).getByRole('button', { name: /^Arquivados · 1/ }).click()
      await expect(archivedRow(pageB)).toBeVisible()
      // The toggle and Restaurar are the only buttons of the section.
      await expect(archivedSection(pageB).getByRole('button')).toHaveCount(2)
      consoleB.allow([RESTORE_FORBIDDEN_403])
      await restoreButton(pageB).click()
      await expect(archivedRow(pageB)).toContainText(LIST.restoreFailed, { timeout: 30_000 })
      await expect(restoreButton(pageB)).toHaveText(LIST.restore)
      await expect(restoreButton(pageB)).toBeEnabled()
      await expectNoProtocolLeak(pageB)
    })

    await test.step('4. una\'s expanded section is remembered: after a reload, and on a new page of the same context; collapsed too', async () => {
      const toggle = (page: Page) => archivedSection(page).getByRole('button', { name: /^Arquivados · 1/ })
      // A new page of una's context, after closing the current one (the tab lock goes with it, ADR-065).
      const reopen = async (n: number): Promise<Page> => {
        await pageB.close()
        const page = await ctxB.newPage()
        consoleB.watch(page, `B${n}`)
        await page.goto('/')
        return page
      }
      await expect(toggle(pageB)).toHaveAttribute('aria-expanded', 'true')
      await pageB.reload()
      await expect(toggle(pageB)).toHaveAttribute('aria-expanded', 'true')
      await expect(archivedRow(pageB)).toBeVisible()
      pageB = await reopen(2)
      await expect(toggle(pageB)).toHaveAttribute('aria-expanded', 'true')
      await expect(archivedRow(pageB)).toBeVisible()
      await toggle(pageB).click()
      await expect(toggle(pageB)).toHaveAttribute('aria-expanded', 'false')
      pageB = await reopen(3)
      await expect(toggle(pageB)).toHaveAttribute('aria-expanded', 'false')
      await expect(archivedRow(pageB)).toHaveCount(0)
      await expectNoProtocolLeak(pageB)
    })

    await test.step('5. vic expands and restores: the row leaves, the channel is back in Canais on both, the section goes', async () => {
      await archivedSection(pageA).getByRole('button', { name: /^Arquivados · 1/ }).click()
      await restoreButton(pageA).click()
      for (const page of [pageA, pageB]) {
        await expect(channelRow(page)).toBeVisible({ timeout: 60_000 })
        await expect(archivedSection(page)).toHaveCount(0)
        await expectNoProtocolLeak(page)
      }
    })

    console.log(`[e2e] console A: ${JSON.stringify(consoleA.observed())}`)
    console.log(`[e2e] console B: ${JSON.stringify(consoleB.observed())}`)
    consoleA.expectClean()
    consoleB.expectClean()
  } finally {
    await ctxA.close()
    await ctxB.close()
  }
})
