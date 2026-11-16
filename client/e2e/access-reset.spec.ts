import { test, expect, type Page, type Response } from '@playwright/test'
import { escapeRegExp, HS_URL, MAS_URL } from '../test/support/stack-env'
import { killSessions } from '../test/support/synapse-admin'
import { IAN, JON } from './fixtures/users'
import { accountSettings, signInAgain } from './support/account'
import { expectNoProtocolLeak, expectReadable, expectReadableWithin } from './support/assertions'
import {
  AFTER_REVOCATION_401,
  AFTER_REVOCATION_SDK_MESSAGES,
  BACKUP_LOOKUPS_WHY,
  backupLookupsCap,
  ConsoleLedger,
  FIRST_LOGIN_404,
  recognizedSet404,
  type ExpectedResponse,
} from './support/console'
import { ACCOUNT, SESSION } from './support/labels'
import { leaveAppForLogin, loginThroughDex, onApp, signIn } from './support/login'
import { deleteSharedRooms } from './support/rooms'
import { currentDeviceIds, directMessageFacts, hasCrossSigningMaster } from './support/server-facts'
import { dmWith, send, startDm, title } from './support/workspace'

// The access reset end to end (ADR-082, #279): the approval on the MAS, giving up without burning
// anything, the other accesses out at the issuer, the origin back in, the conversation readable on
// every side, and a brand-new access free of the stuck `adopt` of the defect. ian and jon are this
// spec's own pair (fixtures/users.ts): a reset contaminates the identity without a visible sign.
// Playwright turns the popup blocker off, so the synchronous window is proven by the unit
// (key-reset.test.ts), not here.

const IAN_NAME = 'ian'
const JON_NAME = 'jon'

const UPLOAD = `${HS_URL}/_matrix/client/v3/keys/device_signing/upload`
// ADR-082 dec. 1: the approval probe, every 2 s while the window is open. 401 = no approval yet, 400 =
// approval in hand. Chromium logs both. The cap covers the two rounds of this spec at the pace below.
const APPROVAL_PROBE: ReadonlyArray<ExpectedResponse> = [
  { url: UPLOAD, status: 401, max: 20, per: 'page', why: 'approval probe: no approval yet (ADR-082 dec. 1)' },
  { url: UPLOAD, status: 400, max: 1, per: 'page', why: 'approval probe: approval in hand (ADR-082 dec. 1)' },
]

// The reset creates a backup version of its own, so AFTER_RELOGIN_404 (`version=1`) does not fit: the
// DM's Megolm sessions (one per sender) the new backup has not received yet, in any version. The custody
// covers them (ADR-061/077).
const AFTER_RESET_LOOKUPS: ExpectedResponse = {
  url: `${HS_URL}/_matrix/client/v3/room_keys/keys/*/*?version=N`,
  pattern: new RegExp(`^${escapeRegExp(HS_URL)}\\/_matrix\\/client\\/v3\\/room_keys\\/keys\\/[^/?]+\\/[^/?]+\\?version=\\d+$`),
  status: 404,
  max: backupLookupsCap(2),
  per: 'page',
  why: BACKUP_LOOKUPS_WHY(2),
}

// resetBackup deletes the old version and the SDK asks for the current one before creating the new.
const RESET_BACKUP_GAP: ExpectedResponse = {
  url: `${HS_URL}/_matrix/client/v3/room_keys/version`,
  status: 404,
  max: 1,
  per: 'page',
  why: 'no backup between the delete and the create of the reset (ADR-082 dec. 5)',
}

const STEP_SETTLE_MS = 3_000
// The boot's attention waits out the claim ceiling (~15 s of backoff) before it speaks, so the "no
// banner" of a new access is only worth something past it.
const ATTENTION_SETTLE_MS = 20_000

// Hermetic start (PLANO-RELEASE-PUBLICA §8.24): every access of the pair is ended and the rooms of
// earlier local runs are deleted.
test.beforeEach(async () => {
  killSessions('ian')
  killSessions('jon')
  await deleteSharedRooms('ian', 'jon')
})
test.afterEach(() => {
  killSessions('ian')
  killSessions('jon')
})

// Five Dex sign-ins, two approvals, the re-entries and the attention window. Ceiling set by the slice.
test.setTimeout(240_000)

// The requests of the reset, by page. A real upload carries a key; the probe's body is empty.
function trackReset(page: Page): { seen: Array<{ what: string; status: number }> } {
  const seen: Array<{ what: string; status: number }> = []
  const record = (r: Response): void => {
    const url = r.url()
    if (url.endsWith('/v1/secret/rotate')) seen.push({ what: 'rotate', status: r.status() })
    if (url.endsWith('/v1/account/revoke-others')) seen.push({ what: 'revoke-others', status: r.status() })
    if (url === UPLOAD && !r.request().postData()?.includes('"master_key":{}')) seen.push({ what: 'upload', status: r.status() })
  }
  page.on('response', record)
  return { seen }
}

async function openResetConfirm(page: Page) {
  const dialog = await accountSettings(page)
  await dialog.getByRole('button', { name: ACCOUNT.accesses }).click()
  await page.getByRole('button', { name: ACCOUNT.resetEntry }).click()
  return page.getByRole('dialog', { name: ACCOUNT.resetEntry })
}

async function clickAndCatchWindow(page: Page, button: ReturnType<Page['getByRole']>): Promise<Page> {
  const [popup] = await Promise.all([page.waitForEvent('popup'), button.click()])
  await popup.waitForLoadState()
  return popup
}

// Back in after an admin-side revocation: the browser session is gone but its cookie is not, so the
// MAS stops on its `logged_out` page (the Tayet template since P4-2, "Você saiu do Tayet"), with a
// "Sair deste navegador" to click before the login (ADR-082, Consequências; login-onboarding.md §9 item 3).
async function signInAgainAfterRevocation(page: Page): Promise<void> {
  await leaveAppForLogin(page, page.getByRole('button', { name: SESSION.signInAgain }))
  await expect(page.getByRole('heading', { name: 'Você saiu do Tayet', level: 1 })).toBeVisible()
  await page.getByRole('button', { name: 'Sair deste navegador' }).click()
  await page.waitForURL((u) => u.origin === MAS_URL && /\/login$/.test(u.pathname))
  await loginThroughDex(page, IAN)
  expect(onApp(page.url())).toBe(true)
  await expect(title(page)).toBeVisible()
}

test('access reset: approval, giving up without a burn, others out, everyone back in', async ({ browser }) => {
  const ts = Date.now()
  const before = `reset-before ${ts}`
  const afterFromIan = `reset-after-ian ${ts}`
  const afterFromJon = `reset-after-jon ${ts}`

  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  const ctxC = await browser.newContext()
  const ctxD = await browser.newContext()
  // Boots per page: A and B login + re-entry; C login; D login.
  const consoleA = new ConsoleLedger('ian A', [...FIRST_LOGIN_404, ...recognizedSet404(2), ...APPROVAL_PROBE])
  const consoleB = new ConsoleLedger('ian B', [...FIRST_LOGIN_404, ...recognizedSet404(2)])
  const consoleC = new ConsoleLedger('jon C', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  const consoleD = new ConsoleLedger('ian D', recognizedSet404(1))
  try {
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()
    const pageC = await ctxC.newPage()
    consoleA.watch(pageA, 'A')
    consoleB.watch(pageB, 'B')
    consoleC.watch(pageC, 'C')
    const reset = trackReset(pageA)

    await test.step('1. ian on A and B, jon on C; a DM with one message', async () => {
      await signIn(pageA, IAN)
      await signIn(pageB, IAN)
      await signIn(pageC, JON)
      await startDm(pageA, JON_NAME)
      await send(pageA, before)
      await dmWith(pageC, IAN_NAME).click()
      await expectReadable(pageC, before)
      expect((await directMessageFacts('ian', 'jon')).encrypted).toBe(true)
      // On a fresh stack this is ian's first login: the virgin cross-signing bootstrap is an upload on
      // A, not a write of the reset. It has to be over before the reset is judged.
      await expect.poll(() => hasCrossSigningMaster('ian'), { timeout: 30_000 }).toBe(true)
    })

    let retry!: ReturnType<Page['getByRole']>
    await test.step('2. A gives up on the window: nothing rotated, B still in, A at "not done"', async () => {
      reset.seen.length = 0
      const devices = (await currentDeviceIds('ian')).length
      const confirm = await openResetConfirm(pageA)
      const popup = await clickAndCatchWindow(pageA, confirm.getByRole('button', { name: ACCOUNT.reset, exact: true }))
      await expect(confirm.getByRole('status')).toHaveText(ACCOUNT.resetPending)
      await popup.getByRole('link', { name: 'Cancel' }).click()
      await expect(popup.getByText('Identity reset cancelled.')).toBeVisible()
      // The MAS page stays open ("You can close this window"); closing it is what the app can see.
      await popup.close()
      await expect(confirm.getByRole('status')).toHaveText(ACCOUNT.resetNotDone)
      expect(reset.seen).toEqual([])
      await pageB.waitForTimeout(STEP_SETTLE_MS)
      await expect(title(pageB)).toBeVisible()
      expect(await currentDeviceIds('ian')).toHaveLength(devices)
      retry = confirm.getByRole('button', { name: ACCOUNT.resetTryAgain })
    })

    consoleB.allow(AFTER_REVOCATION_401, [
      ...AFTER_REVOCATION_SDK_MESSAGES,
      {
        // The OIDC client's own line for the same rejected refresh of AFTER_REVOCATION_401.
        text: '[JsonService] postForm: Error from server: {error: invalid_grant',
        max: 1,
        why: 'refresh of the revoked grant rejected by the MAS (ADR-059)',
      },
    ])
    consoleA.allow([AFTER_RESET_LOOKUPS, RESET_BACKUP_GAP])
    consoleB.allow([AFTER_RESET_LOOKUPS])

    await test.step('3. A tries again and finishes on the MAS: revocation, rotation and upload, no 401', async () => {
      const popup = await clickAndCatchWindow(pageA, retry)
      await popup.getByRole('button', { name: 'Finish reset' }).click()
      await expect(pageA.getByRole('dialog').getByRole('status')).toHaveText(ACCOUNT.resetDone, { timeout: 30_000 })
      expect(reset.seen.map((s) => `${s.what} ${s.status}`)).toEqual([
        'revoke-others 200',
        'rotate 200',
        'upload 200',
        'revoke-others 200',
      ])
      await expect.poll(() => popup.isClosed()).toBe(true)
    })

    await test.step('4. B falls to the ended screen with no reload; the server keeps only A', async () => {
      await expect(pageB.getByText(SESSION.ended)).toBeVisible({ timeout: 30_000 })
      await expect.poll(() => currentDeviceIds('ian'), { timeout: 15_000 }).toHaveLength(1)
    })

    await test.step('5. A and B enter again; new messages read on A, B and C, both ways', async () => {
      await pageA.getByRole('dialog').getByRole('button', { name: ACCOUNT.resetSignInAgain }).click()
      // The dialog's button carries the same label: the ended screen is what says the sign-out landed.
      await expect(pageA.getByText(SESSION.ended)).toBeVisible()
      await signInAgain(pageA, IAN)
      await signInAgainAfterRevocation(pageB)

      await dmWith(pageA, JON_NAME).click()
      await dmWith(pageB, JON_NAME).click()
      await send(pageA, afterFromIan)
      await expectReadableWithin(pageC, 60_000, afterFromIan)
      await expectReadableWithin(pageB, 60_000, afterFromIan)
      await send(pageC, afterFromJon)
      await expectReadableWithin(pageA, 60_000, afterFromJon)
      await expectReadableWithin(pageB, 60_000, afterFromJon)
    })

    const pageD = await ctxD.newPage()
    consoleD.allow([AFTER_RESET_LOOKUPS])
    consoleD.watch(pageD, 'D')

    await test.step('6. a brand-new access: no stuck recovery, no banner, the history visible', async () => {
      await signIn(pageD, IAN)
      await dmWith(pageD, JON_NAME).click()
      await expectReadableWithin(pageD, 60_000, afterFromIan, afterFromJon)
      await pageD.waitForTimeout(ATTENTION_SETTLE_MS)
      await expect(pageD.getByText(ACCOUNT.resetBannerTitle)).toHaveCount(0)
    })

    await test.step('7. P1 on the app DOM and clean consoles', async () => {
      await expectNoProtocolLeak(pageA, pageB, pageC, pageD)
      console.log('[e2e] console counts', { A: consoleA.observed(), B: consoleB.observed(), D: consoleD.observed() })
      consoleA.expectClean()
      consoleB.expectClean()
      consoleC.expectClean()
      consoleD.expectClean()
    })
  } finally {
    await ctxA.close()
    await ctxB.close()
    await ctxC.close()
    await ctxD.close()
  }
})
