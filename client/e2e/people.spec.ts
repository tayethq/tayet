import { test, expect, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { MEL, NIC } from './fixtures/users'
import { accountSettings } from './support/account'
import { expectNoProtocolLeak } from './support/assertions'
import {
  AFTER_REVOCATION_401,
  AFTER_REVOCATION_SDK_MESSAGES,
  ConsoleLedger,
  FIRST_LOGIN_404,
  recognizedSet404,
} from './support/console'
import { ACCOUNT, LIST, MANAGE, PEOPLE, SESSION } from './support/labels'
import { APP, signIn } from './support/login'
import { createChannel, openManage } from './support/rooms'
import { channelRow, orgChannel } from './support/workspace'

// ADR-083 ponta a ponta: mel, admin da org, convida pela sub-tela "Pessoas"; nic entra pelo provider
// simulado do dev-stack, que tem o mapeamento do Google (subject = email), e cai na conta que o escrow
// pré-criou, como convidada; gho é o convite cancelado e nunca loga. O email é fixo no Dex: o spec remove
// nic ao fim, e reconvidar exige a conta removida. O teardown é esse remove, nada além.

const NIC_NAME = 'Nic Convidada'
const NIC_EMAIL = 'nic@tayet.local'
const GHO_NAME = 'Gho'
const GHO_EMAIL = 'gho@tayet.local'

// Fails the first time the opaque localpart reaches the document, so it covers every paint of the first
// boot, and not only the moment the assertions look.
async function watchOpaqueLocalpart(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const state = window as unknown as { sawLocalpart?: string }
    new MutationObserver(() => {
      const text = document.documentElement.innerHTML
      state.sawLocalpart ??= /\bu-[a-z2-7]{12}\b/.exec(text)?.[0]
    }).observe(document, { subtree: true, childList: true, characterData: true })
  })
}

const peoplePanel = (page: Page): Locator => page.getByRole('dialog', { name: PEOPLE.title })
const personRow = (page: Page, name: string): Locator =>
  peoplePanel(page).getByRole('listitem').filter({ hasText: name })

async function invite(
  page: Page,
  { name, email, guestIn }: { name: string; email: string; guestIn?: string },
): Promise<Locator> {
  await peoplePanel(page).getByRole('button', { name: PEOPLE.invite }).click()
  const dialog = page.getByRole('dialog', { name: PEOPLE.invite })
  await dialog.getByLabel(PEOPLE.fieldName).fill(name)
  await dialog.getByLabel(PEOPLE.fieldEmail).fill(email)
  if (guestIn) {
    await dialog.getByRole('button', { name: PEOPLE.kindGuest }).click()
    await dialog.getByRole('button', { name: `${LIST.privateMark} ${guestIn}` }).click()
  }
  await dialog.getByRole('button', { name: PEOPLE.submit, exact: true }).click()
  // ~10 s per write once the bucket of `system` runs out (PLANO-PESSOAS §0.3 B).
  await expect(dialog.getByText(PEOPLE.inviteReady)).toBeVisible({ timeout: 60_000 })
  return dialog
}

const closeInvite = (dialog: Locator): Promise<void> =>
  dialog.getByRole('button', { name: ACCOUNT.close }).last().click()

test('people: invite, guest through the simulated Google, cancel and remove', async ({ browser }) => {
  test.setTimeout(300_000)
  const channel = `pessoas-${Math.random().toString(36).slice(2, 10)}`
  let keysReady: Promise<unknown> = Promise.resolve()

  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  const consoleA = new ConsoleLedger('mel', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  const consoleB = new ConsoleLedger('nic', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  try {
    await watchOpaqueLocalpart(ctxB)
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()
    consoleA.watch(pageA, 'A')
    consoleB.watch(pageB, 'B')

    await test.step('1. mel enters and creates a private channel', async () => {
      await signIn(pageA, MEL)
      await expect(orgChannel(pageA)).toBeVisible({ timeout: 60_000 })
      await createChannel(pageA, { name: channel, kind: 'private' })
    })

    await test.step('2. Sua conta → Organização → Pessoas', async () => {
      const account = await accountSettings(pageA)
      await expect(account.getByText(PEOPLE.section)).toBeVisible({ timeout: 30_000 })
      await account.getByRole('button', { name: new RegExp(`^${PEOPLE.title}`) }).click()
      await expect(peoplePanel(pageA)).toBeVisible()
    })

    await test.step('3. nic is invited as a guest: the instructions name the host and the email', async () => {
      const dialog = await invite(pageA, { name: NIC_NAME, email: NIC_EMAIL, guestIn: channel })
      await expect(dialog).toContainText(new URL(APP).host)
      await expect(dialog).toContainText(NIC_EMAIL)
      await expect(dialog.getByRole('button', { name: PEOPLE.copyInstructions })).toBeVisible()
      await closeInvite(dialog)
      await expect(personRow(pageA, NIC_NAME)).toContainText(PEOPLE.pending, { timeout: 30_000 })
    })

    await test.step('4. gho is invited and the invite is cancelled', async () => {
      await closeInvite(await invite(pageA, { name: GHO_NAME, email: GHO_EMAIL }))
      await expect(personRow(pageA, GHO_NAME)).toContainText(PEOPLE.pending, { timeout: 30_000 })
      await personRow(pageA, GHO_NAME).getByRole('button', { name: PEOPLE.cancelInviteOf(GHO_NAME) }).click()
      const confirm = pageA.getByRole('alertdialog', { name: PEOPLE.cancelInviteOf(GHO_NAME) })
      await confirm.getByRole('button', { name: PEOPLE.cancelInvite, exact: true }).click()
      await expect(personRow(pageA, GHO_NAME)).toHaveCount(0, { timeout: 30_000 })
    })

    await test.step('5. nic enters by the simulated Google: guest, her name from the first paint', async () => {
      // The last write of the first boot's key setup (key-recovery.ts): step 8 must not land in the middle of it.
      keysReady = pageB.waitForResponse(
        (r) => r.request().method() === 'PUT' && r.url().endsWith('/account_data/m.megolm_backup.v1') && r.ok(),
        { timeout: 60_000 },
      )
      await signIn(pageB, NIC, { provider: 'Google (simulado)' })
      await expect(channelRow(pageB, channel)).toBeVisible({ timeout: 60_000 })
      await expect(orgChannel(pageB)).toHaveCount(0)
      await expect(pageB.getByText(NIC_NAME).first()).toBeVisible()
      await openManage(pageB, channel, 'private')
      const self = pageB.getByRole('region', { name: MANAGE.members }).getByRole('listitem').filter({ hasText: NIC_NAME })
      await expect(self).toContainText(MANAGE.guest, { timeout: 30_000 })
      await pageB.getByRole('button', { name: MANAGE.close }).click()
      expect(await pageB.evaluate(() => (window as unknown as { sawLocalpart?: string }).sawLocalpart)).toBeUndefined()
    })

    await test.step('6. back on A, nic is no longer pending', async () => {
      await expect(personRow(pageA, NIC_NAME)).not.toContainText(PEOPLE.pending, { timeout: 60_000 })
      await expect(personRow(pageA, NIC_NAME)).toContainText(`${NIC_EMAIL} · ${PEOPLE.kindGuest}`)
    })

    await test.step('7. P1: no protocol id on either screen', async () => {
      await expectNoProtocolLeak(pageA, pageB)
    })

    await test.step('8. mel removes nic: her access ends, and she leaves the list', async () => {
      await keysReady
      consoleB.allow(AFTER_REVOCATION_401, [
        ...AFTER_REVOCATION_SDK_MESSAGES,
        {
          // The OIDC client's own line for the same rejected refresh, seen when the account is deactivated.
          text: '[JsonService] postForm: Error from server: {error: invalid_grant, error_description: The provided access grant is invalid, expired, or revoked.}',
          max: 1,
          why: 'refresh of the deactivated account rejected by the MAS (ADR-059)',
        },
      ])
      await personRow(pageA, NIC_NAME).getByRole('button', { name: PEOPLE.remove(NIC_NAME) }).click()
      const confirm = pageA.getByRole('alertdialog', { name: PEOPLE.remove(NIC_NAME) })
      await confirm.getByRole('button', { name: PEOPLE.removeConfirm, exact: true }).click()
      await expect(personRow(pageA, NIC_NAME)).toHaveCount(0, { timeout: 30_000 })
      await expect(pageB.getByText(SESSION.ended)).toBeVisible({ timeout: 60_000 })
    })

    consoleA.expectClean()
    consoleB.expectClean()
  } finally {
    await ctxA.close()
    await ctxB.close()
  }
})
