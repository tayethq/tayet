import { test, expect, type Page } from '@playwright/test'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { VAL, WES, XIN } from './fixtures/users'
import { expectNoProtocolLeak, expectReadable } from './support/assertions'
import { ConsoleLedger, FIRST_LOGIN_404, recognizedSet404 } from './support/console'
import { GROUP, LIST, NEW_CONVERSATION, NOTIFICATIONS } from './support/labels'
import { signIn } from './support/login'
import { NotificationStub } from './support/notifications'
import { deleteGroupsOf } from './support/rooms'
import { setHidden, VISIBILITY_SHIM } from './support/visibility'
import { escapeRegExp } from '../test/support/stack-env'
import { channelRow, conversations, groupWith, mainComposer, orgChannel, send } from './support/workspace'

// PR-4 (PLANO-CONVERSAS §0.3.5 item 1; ADR-094 dec. 7, 8 and 11; manifest new-conversation.md §10).
// val (A), wes (B) and xin (C) — the spec's own Dex trio (fixtures/users.ts; the rule holds per trio).
// A opens the group from "Nova conversa" in direct-message mode, picking B and C (two chips); the
// conversation lands in "Mensagens diretas", selected, with the block "3", both names and "3 pessoas"
// in the header, and never in "Canais". B sees it in "Mensagens diretas"; A writes, without a mention, while
// B's tab is hidden and B never opened the group: B gets one notification, "val em conversa em grupo" with
// the text and no id shape, and B's tab title counts it (ADR-094 dec. 10; ADR-073, addendum of 12/Nov) —
// window.Notification is the tier's stub with the permission granted (support/notifications.ts). Then B
// opens the group and reads, and the title is back to "Tayet".
// Opening the same set again, picked in the other order, focuses the existing group (dec. 8).
// C never opens a page: the group is between three, and two browsers are enough to prove it.
//
// Hermetic: the three leave no group behind — every group room any of them is in is deleted at the
// start and at the end (deleteGroupsOf), so the set is never matched across runs.

// Display names as the MAS imported them from the Dex `name` claim (see conversation.spec.ts).
const A_NAME = 'val'
const B_NAME = 'wes'
const C_NAME = 'xin'

async function openGroup(page: Page, picks: string[]): Promise<void> {
  const dialog = page.getByRole('dialog', { name: NEW_CONVERSATION.dialog })
  const last = dialog.getByRole('button', { name: picks[picks.length - 1]!, exact: true })
  // The known set is read when the dialog opens; a person's first-login join of the org channel may
  // reach this client a moment later, so the dialog is reopened until every pick is in it.
  await expect(async () => {
    if ((await dialog.count()) > 0) await dialog.getByRole('button', { name: NEW_CONVERSATION.cancel }).click()
    await conversations(page).getByRole('button', { name: LIST.newDm }).click()
    for (const name of picks) await expect(dialog.getByRole('button', { name, exact: true })).toBeVisible({ timeout: 5_000 })
  }).toPass({ timeout: 60_000 })
  await expect(last).toBeVisible()
  for (const name of picks) {
    const contact = dialog.getByRole('button', { name, exact: true })
    await contact.click()
    await expect(contact).toHaveAttribute('aria-pressed', 'true')
  }
  // One chip per pick, in the order of selection.
  const chips = dialog.getByRole('button', { name: new RegExp(`^${escapeRegExp(NEW_CONVERSATION.remove(''))}`) })
  await expect(chips).toHaveCount(picks.length)
  for (const [i, name] of picks.entries()) await expect(chips.nth(i)).toHaveAccessibleName(NEW_CONVERSATION.remove(name))
  await dialog.getByRole('button', { name: NEW_CONVERSATION.startConversation }).click()
  await expect(dialog).toHaveCount(0)
}

test.beforeAll(async () => {
  await deleteGroupsOf('val', 'wes', 'xin')
})

test.afterAll(async () => {
  await deleteGroupsOf('val', 'wes', 'xin')
})

test('group conversation: created from the dialog, seen by the others, written and read, reopened without a duplicate', async ({
  browser,
}) => {
  test.setTimeout(240_000)
  const text = `no grupo ${Date.now()}`
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  const stubB = await NotificationStub.install(ctxB, 'granted')
  await ctxB.addInitScript(VISIBILITY_SHIM)
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

    await test.step('1. A opens "Nova conversa" in direct-message mode, picks B and C (two chips) and opens', async () => {
      // The three sign in so each is in the org channel, and so in the others' known set (ADR-029 dec. 3).
      await signIn(pageB, WES)
      await signIn(pageC, XIN)
      await signIn(pageA, VAL)
      await openGroup(pageA, [B_NAME, C_NAME])
    })

    await test.step('2. for A: in "Mensagens diretas", selected, block "3", both names and "3 pessoas"; never in "Canais"', async () => {
      const group = groupWith(pageA, [B_NAME, C_NAME])
      await expect(group).toBeVisible({ timeout: 60_000 })
      await expect(group).toHaveAttribute('aria-current', 'true')
      await expect(group.getByRole('img', { name: GROUP.block(3) })).toBeVisible()
      const header = pageA.getByRole('main').getByRole('heading', { level: 2 })
      await expect(header).toHaveText(`${B_NAME}, ${C_NAME}`)
      await expect(pageA.getByRole('main').getByText(GROUP.people(3), { exact: true })).toBeVisible()
      await expect(channelRow(pageA, `${B_NAME}, ${C_NAME}`)).toHaveCount(0)
      await expect(
        conversations(pageA).getByRole('region', { name: LIST.channels }).getByText(`${B_NAME}, ${C_NAME}`),
      ).toHaveCount(0)
      await expectNoProtocolLeak(pageA)
    })

    await test.step('3. B sees the same conversation in "Mensagens diretas"', async () => {
      await expect(groupWith(pageB, [A_NAME, C_NAME])).toBeVisible({ timeout: 60_000 })
    })

    await test.step('4. B hidden, never opened the group: A writes without a mention; B is notified and the title counts; B reads', async () => {
      await expect(pageB).toHaveTitle('Tayet')
      await setHidden(pageB, true)
      await mainComposer(pageA).click()
      await send(pageA, text)
      await expect.poll(() => stubB.shown.length).toBe(1)
      const [n] = stubB.shown
      expect({ title: n!.title, body: n!.body }).toEqual({ title: NOTIFICATIONS.titleInGroup(A_NAME), body: text })
      expect(findProtocolLeaksInText(`${n!.title}\n${n!.body}`)).toEqual([])
      for (const shape of ['@', '!', ':tayet.local']) expect(`${n!.title}\n${n!.body}`).not.toContain(shape)
      await expect(pageB).toHaveTitle('(1) Tayet')
      await setHidden(pageB, false)
      await groupWith(pageB, [A_NAME, C_NAME]).click()
      await expectReadable(pageB, text)
      await expect(pageB).toHaveTitle('Tayet')
      expect(stubB.shown).toHaveLength(1)
      await expectNoProtocolLeak(pageA, pageB)
    })

    await test.step('5. A opens the same set again, in the other order: the existing group is focused, no new one', async () => {
      // Select something else first, so focusing the group is observable.
      await orgChannel(pageA).click()
      await expect(groupWith(pageA, [B_NAME, C_NAME])).not.toHaveAttribute('aria-current', 'true')
      await openGroup(pageA, [C_NAME, B_NAME])
      await expect(groupWith(pageA, [B_NAME, C_NAME])).toHaveAttribute('aria-current', 'true', { timeout: 30_000 })
      await expect(groupWith(pageA, [B_NAME, C_NAME])).toHaveCount(1)
      await expectReadable(pageA, text)
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
