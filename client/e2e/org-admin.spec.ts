import { test, expect } from '@playwright/test'
import { DAVI, IARA, MILA } from './fixtures/users'
import { accountSettings } from './support/account'
import { adminNav, closeAdmin, openAdmin, openAdminOverview, openRowMenu, personRow, rowAction, tableRows } from './support/admin'
import { expectNoProtocolLeak } from './support/assertions'
import { ConsoleLedger, FIRST_LOGIN_404, recognizedSet404 } from './support/console'
import { ACCOUNT, ACCOUNT_PHONE, ADMIN, APP, DATA_EXPORT, PEOPLE } from './support/labels'
import { signIn } from './support/login'
import { protocolUserId, restoreOrgAdmins } from './support/server-facts'
import { orgChannel } from './support/workspace'

// The Admin of the organization, slices 1c and 1d (PLANO-ADMIN §8.6, §8.8; organization-admin.md §2.1–§2.3; ADR-118
// dec. 4 to 6). Slice 1d: the shell opens on the Visão geral, whose cards count the list they open (V1, V2), the
// single-admin warning under a cut role read (V4), and the export dialog on a narrow window with a fine pointer (V8).
// Its own trio (L2): iara is the admin `up` leaves; davi and mila are members, pre-created by `up`. davi signs in, iara promotes
// davi, davi opens the Admin, iara takes her own role away (R6: back to the conversations, the row gone, no
// reload), and davi's own "Deixar de ser admin" is disabled under a one-admin read. The end puts the role back as
// `up` left it.

// The name #all carries changes with the first sign-in (the directory's full name before, the account's name after),
// so the rows are found by the start of the name, any case.
const DAVI_NAME = /davi/i
const IARA_NAME = /iara/i
const MILA_NAME = /mila/i

// The Visão geral's cards (V1, V2): the label's two forms, and the pill each one opens.
const CARDS = [
  [ADMIN.countOrganization, ADMIN.pillOrganization],
  [ADMIN.countGuests, ADMIN.pillGuests],
  [ADMIN.countPending, ADMIN.pillPending],
  [ADMIN.countAgents, ADMIN.pillAgents],
] as const
const cardName = (label: { one: string; other: string }): RegExp =>
  new RegExp(`^(\\d+) (${label.one}|${label.other})${ADMIN.countSeeListSuffix}$`)

test('org admin: promote, the promoted opens the Admin, demote oneself, the last admin is locked', async ({ browser }) => {
  test.setTimeout(300_000)
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  const consoleA = new ConsoleLedger('iara', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  // davi boots twice: the sign-in and the reload of step 4.
  const consoleB = new ConsoleLedger('davi', [...FIRST_LOGIN_404, ...recognizedSet404(2)])
  try {
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()
    consoleA.watch(pageA, 'A')
    consoleB.watch(pageB, 'B')

    await test.step('1. davi signs in, so he is a member and not a pending invite', async () => {
      await signIn(pageB, DAVI)
      await expect(orgChannel(pageB)).toBeVisible({ timeout: 60_000 })
    })

    await test.step('2. iara opens the Admin from "Sua conta"; mila, still pending, carries no mark (C4)', async () => {
      await signIn(pageA, IARA)
      await expect(orgChannel(pageA)).toBeVisible({ timeout: 60_000 })
      // V3: it opens on the Visão geral, with the focus on the first title.
      await openAdminOverview(pageA)
      await expect(pageA.getByRole('heading', { level: 2, name: ADMIN.peopleAndAgents })).toBeFocused()
      // The list has arrived once the organization card counts someone.
      const orgCard = pageA.getByRole('button', { name: cardName(ADMIN.countOrganization) })
      await expect(orgCard).not.toHaveAccessibleName(/^0 /, { timeout: 30_000 })
      // V4: the dev stack has more admins than iara, so there is no warning.
      await expect(pageA.getByRole('main').getByRole('alert')).toHaveCount(0)
      // V1, V2: each card's number is the number of rows of the list it opens, on its pill, with no text. The list
      // moves while the other specs run, so a pair read across a change is read again.
      for (const [label, pill] of CARDS) {
        await expect(async () => {
          const overview = adminNav(pageA).getByRole('button', { name: ADMIN.overview })
          if ((await overview.getAttribute('aria-current')) !== 'page') await overview.click()
          const card = pageA.getByRole('button', { name: cardName(label) })
          const n = Number(/^\d+/.exec((await card.getAttribute('aria-label')) ?? '')?.[0])
          await card.click()
          await expect(pageA.getByRole('group', { name: ADMIN.show }).getByRole('button', { name: pill })).toHaveAttribute('aria-pressed', 'true')
          await expect(pageA.getByRole('textbox', { name: PEOPLE.filter })).toHaveValue('')
          expect(await tableRows(pageA).count()).toBe(n)
        }).toPass({ timeout: 60_000 })
      }
      // "Pessoas" from the navigation opens on "Todas" (V2); the card loop left it on "Agentes".
      await adminNav(pageA).getByRole('button', { name: ADMIN.overview }).click()
      await openAdmin(pageA)
      await expect(pageA.getByRole('group', { name: ADMIN.show }).getByRole('button', { name: ADMIN.pillAll })).toHaveAttribute('aria-pressed', 'true')
      await expect(personRow(pageA, IARA_NAME)).toContainText(ADMIN.roleAdmin, { timeout: 30_000 })
      await expect(personRow(pageA, MILA_NAME)).toContainText(PEOPLE.pending)
      await expect(personRow(pageA, MILA_NAME)).not.toContainText(ADMIN.withoutAccess)
      await expect(personRow(pageA, DAVI_NAME)).toContainText(PEOPLE.kindMember, { timeout: 60_000 })
    })

    await test.step('2b. the single-admin warning, under a role read cut to iara; its links open Pessoas', async () => {
      // As in 6b: the server's own read, with the admin list cut, so no account of the other specs is demoted.
      await closeAdmin(pageA)
      await pageA.route('**/v1/org/access', async (route) => {
        const response = await route.fetch()
        const body = (await response.json()) as { admins: string[]; withoutAccess: string[] }
        await route.fulfill({ response, json: { ...body, admins: body.admins.filter((a) => a === protocolUserId('iara')) } })
      })
      await openAdminOverview(pageA)
      const warning = pageA.getByRole('main').getByRole('alert')
      await expect(warning).toContainText(ADMIN.onlyYou, { timeout: 30_000 })
      const admins = pageA.getByRole('main').getByRole('list')
      await expect(admins.getByRole('listitem')).toHaveCount(1)
      await expect(admins.getByRole('listitem')).toContainText(/iara.*\(você\)/i)
      await warning.getByRole('button', { name: ADMIN.addAdmin }).click()
      const pills = pageA.getByRole('group', { name: ADMIN.show })
      await expect(pills.getByRole('button', { name: ADMIN.pillOrganization })).toHaveAttribute('aria-pressed', 'true')
      await expect(pageA.getByRole('alertdialog')).toHaveCount(0)
      await adminNav(pageA).getByRole('button', { name: ADMIN.overview }).click()
      await pageA.getByRole('button', { name: ADMIN.manageInPeople }).click()
      await expect(pills.getByRole('button', { name: ADMIN.pillAdmins })).toHaveAttribute('aria-pressed', 'true')
      await closeAdmin(pageA)
      await pageA.unroute('**/v1/org/access')
      await openAdmin(pageA)
      await expect(personRow(pageA, IARA_NAME)).toContainText(ADMIN.roleAdmin, { timeout: 30_000 })
    })

    await test.step('3. iara promotes davi; the confirm closes when the role is read again; the badge shows', async () => {
      await expect(personRow(pageA, DAVI_NAME)).not.toContainText(ADMIN.roleAdmin)
      await rowAction(pageA, DAVI_NAME, ADMIN.makeAdmin)
      const confirm = pageA.getByRole('alertdialog', { name: /^Tornar davi/i })
      await confirm.getByRole('button', { name: ADMIN.makeAdmin }).click()
      await expect(confirm).toHaveCount(0, { timeout: 30_000 })
      await expect(personRow(pageA, DAVI_NAME)).toContainText(ADMIN.roleAdmin)
    })

    await test.step('4. davi opens the Admin after a reload (the role is read once per connect; no live notice)', async () => {
      await pageB.reload()
      await expect(orgChannel(pageB)).toBeVisible({ timeout: 60_000 })
      await openAdmin(pageB)
      await expect(personRow(pageB, DAVI_NAME)).toContainText(ADMIN.roleAdmin, { timeout: 30_000 })
      await closeAdmin(pageB)
    })

    await test.step('5. iara takes her own role away: back to the conversations, and "Sua conta" has no Organização', async () => {
      await rowAction(pageA, IARA_NAME, ADMIN.dropAdmin)
      const confirm = pageA.getByRole('alertdialog', { name: ADMIN.demoteSelfTitle })
      await confirm.getByRole('button', { name: ADMIN.dropAdmin }).click()
      await expect(adminNav(pageA)).toHaveCount(0, { timeout: 30_000 })
      await expect(orgChannel(pageA)).toBeVisible()
      const account = await accountSettings(pageA)
      await expect(account.getByRole('button', { name: new RegExp(`^${ADMIN.entry}`) })).toHaveCount(0)
      await expect(account.getByText(PEOPLE.section, { exact: true })).toHaveCount(0)
    })

    await test.step('6. davi, with other admins in the organization, may take his own role away (the confirm opens)', async () => {
      // The dev stack has more admins than the trio (alice, mel and the admins of the other specs), so davi is not
      // the last one: his own item counts, and its confirm is the tirarVoce one.
      await openAdmin(pageB)
      await expect(personRow(pageB, IARA_NAME)).not.toContainText(ADMIN.roleAdmin, { timeout: 30_000 })
      await expect(personRow(pageB, DAVI_NAME)).toContainText(ADMIN.roleAdmin)
      await rowAction(pageB, DAVI_NAME, ADMIN.dropAdmin)
      const confirm = pageB.getByRole('alertdialog', { name: ADMIN.demoteSelfTitle })
      await confirm.getByRole('button', { name: ADMIN.cancel }).click()
      await expect(confirm).toHaveCount(0)
      await closeAdmin(pageB)
    })

    await test.step('6b. the last admin: under a role read where davi is the only admin, his own item is disabled', async () => {
      // A real single-admin organization would mean demoting the accounts the other specs and the parallel integration
      // run rely on. The read is the server's own, with the admin list cut to davi (the lock the server enforces is
      // proven by the org gate, 409 last_admin).
      await pageB.route('**/v1/org/access', async (route) => {
        const response = await route.fetch()
        const body = (await response.json()) as { admins: string[]; withoutAccess: string[] }
        await route.fulfill({ response, json: { ...body, admins: body.admins.filter((a) => a === protocolUserId('davi')) } })
      })
      await openAdmin(pageB)
      const menu = await openRowMenu(pageB, DAVI_NAME)
      const item = menu.getByRole('menuitem', { name: ADMIN.dropAdmin })
      await expect(item).toHaveAttribute('aria-disabled', 'true')
      await expect(item).toBeFocused()
      await expect(item).toHaveAccessibleDescription(ADMIN.onlyAdmin)
      // Playwright counts aria-disabled as not enabled; force sends the real click anyway.
      await item.click({ force: true })
      await expect(pageB.getByRole('alertdialog')).toHaveCount(0)
      await pageB.keyboard.press('Escape')
      await expect(menu).toHaveCount(0)
      await pageB.unroute('**/v1/org/access')
    })

    await test.step('6c. V8 (#421 P3 a): on a narrow window with a fine pointer, the export opens as a dialog', async () => {
      // davi's context is the desktop one (no touch). The coarse half (the line pointing at the computer) is
      // account.narrow.spec.ts, on the phone project. "Sua conta" opens while wide: on the narrow window the open
      // conversation is in front of the list, and the account then turns into the narrow screen (H1).
      await closeAdmin(pageB)
      await pageB.getByRole('button', { name: APP.account, exact: true }).click()
      await pageB.setViewportSize({ width: 600, height: 900 })
      const account = pageB.getByRole('region', { name: ACCOUNT.dialog, exact: true })
      await expect(account).toBeVisible()
      await expect(account.getByText(ACCOUNT_PHONE.exportDesktopOnly)).toHaveCount(0)
      await account.getByRole('button', { name: new RegExp(`^${DATA_EXPORT.entry}`) }).click()
      const dialog = pageB.getByRole('dialog', { name: DATA_EXPORT.dialog })
      await expect(dialog).toBeVisible()
      await expect(dialog.getByRole('button', { name: DATA_EXPORT.prepare, exact: true })).toBeFocused()
      // The system's back closes the dialog, and "Sua conta" is in front again.
      await pageB.goBack()
      await expect(dialog).toHaveCount(0)
      await expect(account).toBeVisible()
      await pageB.goBack()
      await expect(account).toHaveCount(0)
      await pageB.setViewportSize({ width: 1280, height: 720 })
    })

    await test.step('7. P1: no protocol id on either screen', async () => {
      await expectNoProtocolLeak(pageA, pageB)
    })

    consoleA.expectClean()
    consoleB.expectClean()
  } finally {
    // A test timeout closes the pages first: the restore below must run anyway.
    await ctxA.close().catch(() => {})
    await ctxB.close().catch(() => {})
    // L2: the trio's role as `up` leaves it, whatever step stopped the run.
    await restoreOrgAdmins({ user: 'iara', password: IARA.password }, [
      { user: 'davi', password: DAVI.password },
      { user: 'mila', password: MILA.password },
    ])
  }
})
