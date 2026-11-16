import { test, expect } from '@playwright/test'
import { SOL, TOM } from './fixtures/users'
import { ConsoleLedger, FIRST_LOGIN_404, recognizedSet404 } from './support/console'
import { signIn } from './support/login'
import { conversations, dmWith, messages, row, search, searchResults, send, threadPanel } from './support/workspace'
import { expectNoProtocolLeak } from './support/assertions'
import { deleteSharedRooms } from './support/rooms'
import { APP, COMPOSER, LIST, NEW_CONVERSATION, SEARCH, THREAD, TIMELINE } from './support/labels'

// ADR-075: deleting one's own message, end to end. tom (A) writes and deletes; sol (B) watches — the
// spec's own Dex pair (fixtures/users.ts, one pair per spec). The message vanishes for tom without a
// reload (the removal carries the stable id, §8.52 §0 item 2.1), then for sol; search no longer finds
// it, and a reload does not bring it back. A thread root with a reply offers no delete; tom's own
// message without replies next to it does. The DOM is scanned for protocol ids (P1).

// Display names as the MAS imported them from the Dex `name` claim (see conversation.spec.ts).
const TOM_NAME = 'tom'
const SOL_NAME = 'sol'

// Hermetic start: the tom↔sol DM of earlier runs is deleted, so this run creates its own.
test.beforeAll(async () => {
  await deleteSharedRooms('tom', 'sol')
})

test('delete: own message vanishes for both, leaves search, stays gone on reload; a root with replies keeps it', async ({
  browser,
}) => {
  test.setTimeout(180_000)
  const ts = Date.now()
  const doomed = `mensagem para apagar ${ts}`
  const keeper = `fica ${ts}`
  const rootText = `raiz ${ts}`
  const replyText = `resposta ${ts}`
  const lone = `sozinha ${ts}`

  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  // Boots: tom 2 (login, reload in step 6); sol 1 (login).
  const consoleA = new ConsoleLedger('tom', [...FIRST_LOGIN_404, ...recognizedSet404(2)])
  const consoleB = new ConsoleLedger('sol', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  try {
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()
    consoleA.watch(pageA, 'A')
    consoleB.watch(pageB, 'B')

    await test.step('1. tom and sol log in; tom opens a DM with sol and sends the message to delete', async () => {
      await signIn(pageA, TOM)
      await signIn(pageB, SOL)
      const dialog = pageA.getByRole('dialog', { name: NEW_CONVERSATION.dialog })
      const contact = dialog.getByRole('button', { name: SOL_NAME, exact: true })
      // The contact list is read when the dialog opens; sol's first-login join of the org channel may
      // reach tom's client a moment later, so the dialog is reopened until sol is in it.
      await expect(async () => {
        if ((await dialog.count()) > 0) await dialog.getByRole('button', { name: NEW_CONVERSATION.cancel }).click()
        await conversations(pageA).getByRole('button', { name: LIST.newDm }).click()
        await expect(contact).toBeVisible({ timeout: 5_000 })
      }).toPass({ timeout: 60_000 })
      await contact.click()
      await dialog.getByRole('button', { name: NEW_CONVERSATION.startConversation }).click()
      await expect(dialog).toHaveCount(0)
      await dmWith(pageA, SOL_NAME).click()
      // The invite is auto-joined on sol's side (ADR-044).
      await expect(dmWith(pageB, TOM_NAME)).toBeVisible()
      await send(pageA, keeper)
      await send(pageA, doomed)
    })

    await test.step('2. sol sees the message', async () => {
      await dmWith(pageB, TOM_NAME).click()
      await expect(messages(pageB)).toContainText(doomed, { timeout: 60_000 })
    })

    await test.step('3. tom: hover → "Apagar mensagem" → "Apagar mensagem?" → "Apagar"; it vanishes without a reload', async () => {
      const target = row(pageA, doomed)
      await target.hover()
      await target.getByRole('button', { name: TIMELINE.delete }).click()
      await expect(target).toContainText(TIMELINE.deleteQuestion)
      await target.getByRole('button', { name: TIMELINE.confirmDelete, exact: true }).click()
      await expect(row(pageA, doomed)).toHaveCount(0, { timeout: 30_000 })
      await expect(messages(pageA)).toContainText(keeper)
    })

    await test.step('4. sol: the message vanishes', async () => {
      await expect(row(pageB, doomed)).toHaveCount(0, { timeout: 60_000 })
      await expect(messages(pageB)).toContainText(keeper)
    })

    await test.step('5. tom searches "apagar" (⌘K): nothing found', async () => {
      await search(pageA, 'apagar')
      await expect(searchResults(pageA)).toContainText(SEARCH.nothingFound('apagar'))
      await pageA.getByRole('textbox', { name: SEARCH.field }).press('Escape')
      await expect(searchResults(pageA)).toHaveCount(0)
    })

    await test.step('6. tom reloads: the message is still gone', async () => {
      await pageA.reload()
      await expect(pageA.getByRole('heading', { name: APP.title, level: 1 })).toBeVisible()
      await dmWith(pageA, SOL_NAME).click()
      await expect(messages(pageA)).toContainText(keeper)
      await expect(row(pageA, doomed)).toHaveCount(0)
    })

    await test.step('7. a root with a reply offers no delete; tom\'s own message without replies does', async () => {
      await send(pageA, rootText)
      const solRoot = row(pageB, rootText)
      await expect(solRoot).toBeVisible({ timeout: 60_000 })
      await solRoot.hover()
      await solRoot.getByRole('button', { name: TIMELINE.replyInThread }).click()
      const panel = threadPanel(pageB)
      await panel.getByRole('textbox', { name: COMPOSER.editor, exact: true }).fill(replyText)
      await panel.getByRole('button', { name: COMPOSER.send }).click()
      await expect(panel.getByRole('log', { name: THREAD.replies })).toContainText(replyText)

      const tomRoot = row(pageA, rootText)
      await expect(tomRoot.getByRole('button', { name: TIMELINE.replies(1) })).toBeVisible({ timeout: 60_000 })
      await send(pageA, lone)
      await tomRoot.hover()
      await expect(tomRoot.getByRole('button', { name: TIMELINE.edit })).toBeVisible()
      await expect(tomRoot.getByRole('button', { name: TIMELINE.delete })).toHaveCount(0)
      const loneRow = row(pageA, lone)
      await loneRow.hover()
      await expect(loneRow.getByRole('button', { name: TIMELINE.delete })).toBeVisible()
    })

    await test.step('8. P1 over both pages', async () => {
      await expectNoProtocolLeak(pageA)
      await expectNoProtocolLeak(pageB)
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
