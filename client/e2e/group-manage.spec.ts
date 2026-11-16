import { test, expect, type Page } from '@playwright/test'
import { VAL, WES, XIN } from './fixtures/users'
import { expectNoProtocolLeak, expectReadable } from './support/assertions'
import { ConsoleLedger, FIRST_LOGIN_404, recognizedSet404 } from './support/console'
import { GROUP, LIST, MANAGE, NEW_CONVERSATION } from './support/labels'
import { signIn } from './support/login'
import { deleteChannelsNamed, deleteGroupsOf } from './support/rooms'
import { escapeRegExp } from '../test/support/stack-env'
import { channelRow, conversations, groupWith, mainComposer, send } from './support/workspace'

// PR-5 (PLANO-CONVERSAS §0.3.6 item 4; ADR-094 dec. 9 and 13; manifest channel-management.md §10).
// The trio of group-conversation.spec.ts — val (A), wes (B), xin (C). A opens the group with B and C
// and writes in it. C opens "Detalhes da conversa", leaves and confirms: the conversation leaves C's
// list, and A and B see the block "2" and "2 pessoas". B — who did not open it, admin by birth (PL 50,
// dec. 6) — converts it into a channel with a name: A and B find it in "Canais" with the lock and the
// name, no longer in "Mensagens diretas", with the history; and the channel's panel lists B as admin.
//
// Hermetic: every group of the three and every channel named after this spec is deleted at the start
// and at the end — the converted room is no longer a group, so it goes by its name.

const A_NAME = 'val'
const B_NAME = 'wes'
const C_NAME = 'xin'
const PREFIX = 'grupo-c5-'

async function openGroup(page: Page, picks: string[]): Promise<void> {
  const dialog = page.getByRole('dialog', { name: NEW_CONVERSATION.dialog })
  // The known set is read when the dialog opens; a person's first-login join of the org channel may
  // reach this client a moment later, so the dialog is reopened until every pick is in it.
  await expect(async () => {
    if ((await dialog.count()) > 0) await dialog.getByRole('button', { name: NEW_CONVERSATION.cancel }).click()
    await conversations(page).getByRole('button', { name: LIST.newDm }).click()
    for (const name of picks) await expect(dialog.getByRole('button', { name, exact: true })).toBeVisible({ timeout: 5_000 })
  }).toPass({ timeout: 60_000 })
  for (const name of picks) await dialog.getByRole('button', { name, exact: true }).click()
  await dialog.getByRole('button', { name: NEW_CONVERSATION.startConversation }).click()
  await expect(dialog).toHaveCount(0)
}

const header = (page: Page) => page.getByRole('main').getByRole('heading', { level: 2 })
const dms = (page: Page) => conversations(page).getByRole('region', { name: LIST.dms })

test.beforeAll(async () => {
  await deleteGroupsOf('val', 'wes', 'xin')
  await deleteChannelsNamed(PREFIX)
})

test.afterAll(async () => {
  await deleteGroupsOf('val', 'wes', 'xin')
  await deleteChannelsNamed(PREFIX)
})

test('group conversation: one person leaves, the rest see the new count, and one who did not open it converts it into a channel', async ({
  browser,
}) => {
  test.setTimeout(300_000)
  const text = `antes da conversão ${Date.now()}`
  const channelName = `${PREFIX}${Date.now()}`
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  const ctxC = await browser.newContext()
  const consoleA = new ConsoleLedger('val', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  const consoleB = new ConsoleLedger('wes', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  const consoleC = new ConsoleLedger('xin', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  try {
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()
    const pageC = await ctxC.newPage()
    consoleA.watch(pageA, 'A')
    consoleB.watch(pageB, 'B')
    consoleC.watch(pageC, 'C')

    await test.step('1. A opens a group with B and C and writes in it', async () => {
      await signIn(pageB, WES)
      await signIn(pageC, XIN)
      await signIn(pageA, VAL)
      await openGroup(pageA, [B_NAME, C_NAME])
      await expect(groupWith(pageA, [B_NAME, C_NAME])).toHaveAttribute('aria-current', 'true', { timeout: 60_000 })
      await mainComposer(pageA).click()
      await send(pageA, text)
      await expectReadable(pageA, text)
    })

    await test.step('2. C opens the details, leaves and confirms: gone from C; A and B see "2" and "2 pessoas"', async () => {
      const groupC = groupWith(pageC, [A_NAME, B_NAME])
      await expect(groupC).toBeVisible({ timeout: 60_000 })
      await groupC.click()
      await pageC.getByRole('button', { name: GROUP.details }).click()
      const details = pageC.getByRole('dialog', { name: GROUP.details })
      await expect(details).toBeVisible()
      await expectNoProtocolLeak(pageC)
      await details.getByRole('button', { name: GROUP.leave, exact: true }).click()
      const confirm = pageC.getByRole('dialog', { name: GROUP.leave })
      await confirm.getByRole('button', { name: MANAGE.confirmLeave, exact: true }).click()
      await expect(pageC.getByRole('dialog')).toHaveCount(0)
      await expect(dms(pageC).getByRole('button', { name: new RegExp(`^${escapeRegExp(GROUP.block(3))}`) })).toHaveCount(0, {
        timeout: 30_000,
      })

      const groupA = groupWith(pageA, [B_NAME])
      await expect(groupA).toBeVisible({ timeout: 60_000 })
      await expect(groupA.getByRole('img', { name: GROUP.block(2) })).toBeVisible()
      await expect(header(pageA)).toHaveText(B_NAME)
      await expect(pageA.getByRole('main').getByText(GROUP.people(2), { exact: true })).toBeVisible()

      const groupB = groupWith(pageB, [A_NAME])
      await expect(groupB).toBeVisible({ timeout: 60_000 })
      await groupB.click()
      await expect(groupB.getByRole('img', { name: GROUP.block(2) })).toBeVisible()
      await expect(pageB.getByRole('main').getByText(GROUP.people(2), { exact: true })).toBeVisible()
      await expectReadable(pageB, text)
    })

    await test.step('3. B, who did not open the group, opens the details, converts with a name and confirms', async () => {
      await pageB.getByRole('button', { name: GROUP.details }).click()
      const details = pageB.getByRole('dialog', { name: GROUP.details })
      await details.getByRole('button', { name: GROUP.convert, exact: true }).click()
      const confirm = pageB.getByRole('dialog', { name: GROUP.convert })
      await confirm.getByLabel(GROUP.convertName).fill(channelName)
      await expectNoProtocolLeak(pageB)
      await confirm.getByRole('button', { name: GROUP.convert, exact: true }).click()
      await expect(pageB.getByRole('dialog')).toHaveCount(0, { timeout: 30_000 })
    })

    await test.step('4. A and B: in "Canais" with the lock and the name, gone from "Mensagens diretas", history kept', async () => {
      for (const [page, other] of [
        [pageA, B_NAME],
        [pageB, A_NAME],
      ] as const) {
        const row = channelRow(page, channelName)
        await expect(row).toBeVisible({ timeout: 60_000 })
        await expect(row.getByRole('img', { name: LIST.privateMark })).toBeVisible()
        await expect(groupWith(page, [other])).toHaveCount(0)
        await row.click()
        await expectReadable(page, text)
      }
      await expectNoProtocolLeak(pageA, pageB)
    })

    await test.step('5. the channel\'s panel lists B as admin', async () => {
      await pageA.getByRole('button', { name: MANAGE.open(`${LIST.privateMark} ${channelName}`) }).click()
      const roster = pageA.getByRole('region', { name: MANAGE.members })
      await expect(roster).toContainText(B_NAME, { timeout: 30_000 })
      const role = pageA.getByRole('combobox', { name: MANAGE.role(B_NAME), exact: true })
      await expect(role.locator('option:checked')).toHaveText(MANAGE.admin)
      await pageA.getByRole('button', { name: MANAGE.close }).click()
      await expect(pageA.getByRole('dialog')).toHaveCount(0)
    })

    console.log(`[e2e] console A: ${JSON.stringify(consoleA.observed())}`)
    console.log(`[e2e] console B: ${JSON.stringify(consoleB.observed())}`)
    console.log(`[e2e] console C: ${JSON.stringify(consoleC.observed())}`)
    consoleA.expectClean()
    consoleB.expectClean()
    consoleC.expectClean()
  } finally {
    await ctxA.close()
    await ctxB.close()
    await ctxC.close()
  }
})
