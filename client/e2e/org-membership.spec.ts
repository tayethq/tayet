import { test, expect } from '@playwright/test'
import { KIM, LUA } from './fixtures/users'
import { expectNoProtocolLeak } from './support/assertions'
import { ConsoleLedger, FIRST_LOGIN_404, recognizedSet404 } from './support/console'
import { LIST, MANAGE, NEW_CONVERSATION } from './support/labels'
import { signIn } from './support/login'
import { deleteSharedRooms, openManage } from './support/rooms'
import { placeInPrivateChannel } from './support/server-facts'
import { channelRow, conversations, orgChannel } from './support/workspace'

// ADR-083 Conformidade: quem é da organização é estado do servidor. kim (A) está na allowlist e entra em
// #all pelo convite no boot, nascendo no primeiro login como membro. lua (B) está na allowlist para logar
// e fora de #all (ORG_GUESTS do dev-stack): vê só o canal em que foi colocada, aparece como "Convidado"
// no roster e só enxerga quem compartilha canal com ela. Colocá-la no canal é do admin da P2/P3; aqui o
// harness faz esse papel antes do primeiro login dela, que é exatamente quando o convite do admin chega.

// Display names as the MAS imported them from the Dex `name` claim (see conversation.spec.ts).
const KIM_NAME = 'kim'
const LUA_NAME = 'lua'
// Outro usuário da organização: lua não pode vê-lo, kim sim (alice e bob vivem em #all).
const ORG_PEER_NAME = 'alice'

test.beforeEach(async () => {
  await deleteSharedRooms('kim', 'lua')
})

test('org membership: member enters #all by invite, guest sees only her channel', async ({ browser }) => {
  test.setTimeout(240_000)
  const channelName = `pessoas-${Date.now()}`
  await placeInPrivateChannel(channelName, ['kim', 'lua'])

  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  const consoleA = new ConsoleLedger('kim', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  const consoleB = new ConsoleLedger('lua', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  try {
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()
    consoleA.watch(pageA, 'A')
    consoleB.watch(pageB, 'B')

    await test.step('1. kim logs in: #all arrives by the pending invite, and the channel too', async () => {
      await signIn(pageA, KIM)
      await expect(orgChannel(pageA)).toBeVisible({ timeout: 60_000 })
      await expect(channelRow(pageA, channelName)).toBeVisible({ timeout: 60_000 })
    })

    await test.step('2. lua logs in: her channel, and no #all', async () => {
      await signIn(pageB, LUA)
      await expect(channelRow(pageB, channelName)).toBeVisible({ timeout: 60_000 })
      await expect(orgChannel(pageB)).toHaveCount(0)
    })

    await test.step('3. the roster shows lua as a guest', async () => {
      await openManage(pageA, channelName, 'private')
      const row = pageA.getByRole('region', { name: MANAGE.members }).getByRole('listitem').filter({ hasText: LUA_NAME })
      await expect(row).toContainText(MANAGE.guest, { timeout: 30_000 })
      await pageA.getByRole('button', { name: MANAGE.close }).click()

      // In lua's own session she knows only herself: kim is not labelled a guest.
      await openManage(pageB, channelName, 'private')
      const rowOfKim = pageB.getByRole('region', { name: MANAGE.members }).getByRole('listitem').filter({ hasText: KIM_NAME })
      await expect(rowOfKim).toBeVisible({ timeout: 30_000 })
      await expect(rowOfKim).not.toContainText(MANAGE.guest)
      await pageB.getByRole('button', { name: MANAGE.close }).click()
    })

    await test.step('4. kim, a member, finds lua in the known set', async () => {
      await conversations(pageA).getByRole('button', { name: LIST.newDm }).click()
      const dialog = pageA.getByRole('dialog', { name: NEW_CONVERSATION.dialog })
      await expect(dialog.getByRole('button', { name: LUA_NAME, exact: true })).toBeVisible({ timeout: 30_000 })
      await expect(dialog.getByRole('button', { name: ORG_PEER_NAME, exact: true })).toBeVisible()
      await dialog.getByRole('button', { name: NEW_CONVERSATION.cancel }).click()
    })

    await test.step('5. lua sees only kim: not the organization behind her', async () => {
      await conversations(pageB).getByRole('button', { name: LIST.newDm }).click()
      const dialog = pageB.getByRole('dialog', { name: NEW_CONVERSATION.dialog })
      await expect(dialog.getByRole('button', { name: KIM_NAME, exact: true })).toBeVisible({ timeout: 30_000 })
      await expect(dialog.getByRole('button', { name: ORG_PEER_NAME, exact: true })).toHaveCount(0)
      await expect(dialog.getByRole('list').getByRole('button')).toHaveCount(1)
      await dialog.getByRole('button', { name: NEW_CONVERSATION.cancel }).click()
    })

    await test.step('6. P1: no protocol id on either screen', async () => {
      await expectNoProtocolLeak(pageA, pageB)
    })

    consoleA.expectClean()
    consoleB.expectClean()
  } finally {
    await ctxA.close()
    await ctxB.close()
  }
})
