import { test, expect } from '@playwright/test'
import { MAS_URL } from '../test/support/stack-env'
import { killSessionsOrThrow } from '../test/support/synapse-admin'
import { ERIN, FRANK } from './fixtures/users'
import {
  AFTER_RELOGIN_404,
  AFTER_REVOCATION_401,
  AFTER_REVOCATION_SDK_MESSAGES,
  BACKUP_LOOKUPS_WHY,
  backupLookupsCap,
  ConsoleLedger,
  FIRST_LOGIN_404,
  recognizedSet404,
} from './support/console'
import { leaveAppForLogin, loginThroughDex, signIn } from './support/login'
import { directMessageFacts, orgChannelFacts } from './support/server-facts'
import { conversations, dmWith, orgChannel, send, title } from './support/workspace'
import { ELSEWHERE, expectNoProtocolLeak, expectReadable, expectReadableWithin } from './support/assertions'
import { deleteSharedRooms } from './support/rooms'
import { LIST, NEW_CONVERSATION, SESSION } from './support/labels'

// Fatias 2d-2/2d-3 (ADR-060): the full §8.5 scenario. Two browser contexts — erin (A) and frank (B),
// each logged in through the Dex upstream — talk in a DM and in the org channel; protocol facts
// (encryption) are asserted by the server, never by the UI (D3). A second tab of erin is neutral (one
// active tab per origin, ADR-065) until she brings the app there ("Usar aqui"); the admin revokes her
// with both tabs open; she signs in again from the tab that ended, finds her history, and the old tab
// takes the new session over. One chained test: each step depends on the previous one, and a failure
// stops at the step that broke.

// Display names as the MAS imported them from the Dex `name` claim (claims_imports.displayname,
// infra/dev-stack/mas/config.yaml) — the org full_name of directory.tsv lives in the profile's org
// block (ADR-054), not in the display name a DM row shows.
const ERIN_NAME = 'erin'
const FRANK_NAME = 'frank'

// The re-login device's per-session backup lookups (AFTER_RELOGIN_404), plus the ones ADR-077 dec. 3
// adds: after each custody consult the ACL asks the SDK to re-decrypt, which redoes the GET per session.
// Two unknown sessions (one per sender of the DM); its own label, apart from AFTER_RELOGIN_404's.
const AFTER_RELOGIN_RECONSULT_404 = {
  ...AFTER_RELOGIN_404[0]!,
  url: `${AFTER_RELOGIN_404[0]!.url} (re-decrypt after each custody consult)`,
  max: backupLookupsCap(2),
  why: BACKUP_LOOKUPS_WHY(2),
}

// Hermetic start (PLANO-RELEASE-PUBLICA §8.24): the DM erin↔frank that earlier local runs left behind is
// deleted before the first login, so step 2 creates it anew and no device of this run ever looks for
// the Megolm sessions of an older one. The console caps stay as they are. On a fresh stack (CI) there
// is nothing to delete.
test.beforeAll(async () => {
  await deleteSharedRooms('erin', 'frank')
})

test('DM and org channel between two users, encryption by the server, revocation with two tabs, re-login with history', async ({
  browser,
}) => {
  // Default 30 s is the length of the run itself; step 11 may wait up to the custody cap (ADR-077, 30 s).
  test.setTimeout(90_000)
  const ts = Date.now()
  const e2e1 = `e2e-1 ${ts}`
  const e2e2 = `e2e-2 ${ts}`
  const e2e3 = `e2e-3 ${ts}`

  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  // App boots per page (one recognized-set 404 each, support/console.ts): A1 = 3 (login in step 1,
  // reload in step 6, "Usar aqui" in step 12 — the reload just before it lands neutral); A2 = 2
  // ("Usar aqui" in step 7, re-login in step 9); B = 1 (login in step 1).
  const consoleA = new ConsoleLedger('erin', [...FIRST_LOGIN_404, ...recognizedSet404(3)])
  const consoleB = new ConsoleLedger('frank', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  try {
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()
    consoleA.watch(pageA, 'A1')
    consoleB.watch(pageB, 'B')

    await test.step('1. erin and frank log in through Dex', async () => {
      await signIn(pageA, ERIN)
      await signIn(pageB, FRANK)
      await expect(orgChannel(pageA)).toBeVisible()
      await expect(orgChannel(pageB)).toBeVisible()
      await expectNoProtocolLeak(pageA, pageB)
    })

    // Known-set picker (ADR-029 dec. 3): frank is there because both share the org channel.
    await test.step('2. erin opens a DM with frank and writes', async () => {
      await conversations(pageA).getByRole('button', { name: LIST.newDm }).click()
      const dialog = pageA.getByRole('dialog', { name: NEW_CONVERSATION.dialog })
      // The "To" field is a plain label over a list of contact buttons (Field without htmlFor renders a
      // span, not a group), so the contact is scoped by the dialog. exact: the picker is the known set
      // of the org channel, and locally that set holds hundreds of harness users.
      const contact = dialog.getByRole('button', { name: FRANK_NAME, exact: true })
      await contact.click()
      await expect(contact).toHaveAttribute('aria-pressed', 'true')
      await dialog.getByRole('button', { name: NEW_CONVERSATION.startConversation }).click()
      await expect(dialog).toHaveCount(0)
      await dmWith(pageA, FRANK_NAME).click()
      await send(pageA, e2e1)
    })

    // The invite is auto-joined on frank's side (ADR-044).
    await test.step('3. frank reads it and answers; erin reads the answer', async () => {
      await dmWith(pageB, ERIN_NAME).click()
      await expectReadable(pageB, e2e1)
      await send(pageB, e2e2)
      await expectReadable(pageA, e2e1, e2e2)
      await expectNoProtocolLeak(pageA, pageB)
    })

    // Never asserted through the UI (P1): the server says the DM carries m.room.encryption and its
    // last two messages are ciphertext.
    await test.step('4. the DM is encrypted, by the server', async () => {
      const dm = await directMessageFacts('erin', 'frank')
      expect(dm.encrypted).toBe(true)
      expect(dm.lastMessageTypes.slice(0, 2)).toEqual(['m.room.encrypted', 'm.room.encrypted'])
    })

    // The org channel is public, and public channels are in the clear by decision (ADR-045 "public →
    // claro"): the tier asserts what the server says, it does not expect ciphertext here (§8.9).
    await test.step('5. org channel: erin writes, frank reads; the server says it is in the clear', async () => {
      await orgChannel(pageA).click()
      await send(pageA, e2e3)
      await orgChannel(pageB).click()
      await expectReadable(pageB, e2e3)
      const org = await orgChannelFacts()
      expect(org.encrypted).toBe(false)
      expect(org.lastMessageTypes[0]).toBe('m.room.message')
    })

    await test.step('6. reload erin: the session persists and the DM is readable', async () => {
      await pageA.reload()
      await expect(title(pageA)).toBeVisible()
      await dmWith(pageA, FRANK_NAME).click()
      await expectReadable(pageA, e2e1, e2e2)
      await expectNoProtocolLeak(pageA)
    })

    // ADR-065: one active tab per origin. The second tab opens neutral — no app, no login — and "Usar
    // aqui" brings the app there with the same session (shared storage): erin's first tab yields by
    // reload and turns neutral. From here on A2 is erin's active tab.
    const pageA2 = await ctxA.newPage()
    consoleA.watch(pageA2, 'A2')
    await test.step('7. a second tab of erin is neutral; "Usar aqui" moves erin there, same DM', async () => {
      await pageA2.goto('/')
      await expect(pageA2.getByText(ELSEWHERE)).toBeVisible()
      await expect(title(pageA2)).toHaveCount(0)
      await expect(pageA2.getByRole('button', { name: /^Continuar com/ })).toHaveCount(0)
      await expectNoProtocolLeak(pageA, pageA2)
      await pageA2.getByRole('button', { name: SESSION.useHere }).click()
      await expect(title(pageA2)).toBeVisible()
      await expect(pageA.getByText(ELSEWHERE)).toBeVisible()
      await dmWith(pageA2, FRANK_NAME).click()
      await expectReadable(pageA2, e2e1, e2e2)
      await expectNoProtocolLeak(pageA, pageA2)
    })

    // ADR-059: the active tab lands on the access-ended screen; the neutral one holds no session and
    // stays neutral (ADR-065 D3); frank is untouched. From here on erin's console carries the normal
    // revocation path: the deleted device's 401s, the rejected refresh and what the SDK logs about both
    // (named, capped — support/console.ts).
    await test.step('8. admin revokes erin with two tabs open: the active one ends, the neutral one stays', async () => {
      consoleA.allow(AFTER_REVOCATION_401, AFTER_REVOCATION_SDK_MESSAGES)
      const killedAt = Date.now()
      killSessionsOrThrow('erin')
      await expect(pageA2.getByRole('alert')).toContainText(SESSION.ended)
      await expect(pageA2.getByRole('button', { name: SESSION.signInAgain })).toBeVisible()
      console.log(`[e2e] kill-sessions → access-ended screen on the active tab: ${Date.now() - killedAt} ms`)
      await expect(pageA.getByText(ELSEWHERE)).toBeVisible()
      await expect(pageA.getByRole('alert')).toHaveCount(0)
      await expectReadable(pageB, e2e3)
      await expect(pageB.getByRole('alert')).toHaveCount(0)
    })

    // MAS ≥ 1.22 keeps the app's authorization request across the sign-out of the `logged_out` page
    // (stock "Session terminated"; the Tayet template keeps the same `post_logout_action`) (#5843; §8.12–§8.14), so the revoked user comes back to the app. The page
    // itself still exists — it is the interstitial upstream issue element-hq/matrix-authentication-
    // service#6053 asks to remove; when it goes, this step changes. The Dex asks for credentials
    // (the upstream gets prompt=login after a sign-out, §8.12 (c3)).
    await test.step('9. re-login from the tab that ended returns to the app', async () => {
      consoleA.allow([AFTER_RELOGIN_RECONSULT_404])
      const masHome = `${MAS_URL}/`
      const visited: string[] = []
      const onNav = (frame: { url(): string }) => {
        if (frame === pageA2.mainFrame()) visited.push(frame.url())
      }
      pageA2.on('framenavigated', onNav)
      await leaveAppForLogin(pageA2, pageA2.getByRole('button', { name: SESSION.signInAgain }))
      // The `logged_out` page is the Tayet template since P4-2 (login-onboarding.md §9 item 3).
      await expect(pageA2.getByRole('heading', { name: 'Você saiu do Tayet', level: 1 })).toBeVisible()
      const signOutAt = Date.now()
      await pageA2.getByRole('button', { name: 'Sair deste navegador' }).click()
      await loginThroughDex(pageA2, ERIN)
      await expect(title(pageA2)).toBeVisible()
      console.log(`[e2e] "Sair deste navegador" → app ready: ${Date.now() - signOutAt} ms`)
      pageA2.off('framenavigated', onNav)
      expect(pageA2.url()).not.toContain('code=')
      expect(pageA2.url()).not.toContain('state=')
      // Never stranded on the MAS home ("Signed in as …"), the 1.18 behavior of §8.9 finding 1.
      expect(visited.filter((u) => u === masHome)).toEqual([])
      await expectNoProtocolLeak(pageA2)
    })

    // ADR-018: the signal is erin's OWN device list — the re-login minted a new device for her.
    // ADR-018 dec. 3: the new-access signal is erin's OWN device list, and a session never notifies
    // about its own device. kill-sessions deleted every other device of erin, so the re-login device is
    // the only one: there is nothing to announce, and no banner (§8.19: errata of the 2d-3 prompt,
    // which expected one; "tell the user the previous access was ended by an admin" is a product fork
    // registered for dec. 9).
    await test.step('10. no new-access banner after the re-login (ADR-018 dec. 3)', async () => {
      await expect(pageA2.getByRole('region', { name: SESSION.notices })).toHaveCount(0)
    })

    // The account already has a backup and a deposited secret, so the first-login 404s must not come
    // back here (the ledger counts them per context; step 1 already used the caps). The per-session
    // backup lookups of AFTER_RELOGIN_RECONSULT_404 are expected: sessions the killed device never backed
    // up, which the custody covers (ADR-061), looked up again after each custody consult (ADR-077).
    await test.step('11. history intact after the re-login', async () => {
      const before = consoleA.observed()
      await dmWith(pageA2, FRANK_NAME).click()
      // ADR-077: até 30 s pela custódia (no live sibling after an admin revocation; cap + margin).
      const openedAt = Date.now()
      await expectReadableWithin(pageA2, 40_000, e2e1, e2e2) // escrow recovery (ADR-035 dec. 4) + custody (ADR-061)
      console.log(`[e2e] step 11: DM readable ${Date.now() - openedAt} ms after opening it`)
      await orgChannel(pageA2).click()
      await expectReadable(pageA2, e2e3) // org channel in the clear (ADR-045)
      await expectNoProtocolLeak(pageA2)
      // Step 10 again, now that the session has settled (the new-access scan runs after the first sync,
      // so an absence asserted right after the h1 alone would be weak).
      await expect(pageA2.getByRole('region', { name: SESSION.notices })).toHaveCount(0)
      for (const { url } of FIRST_LOGIN_404) {
        const key = `404 ${url} @ context`
        expect(consoleA.observed()[key] ?? 0, `${key} again after the re-login`).toBe(before[key] ?? 0)
      }
    })

    // ADR-065: the old tab never held the revoked session (neutral since step 7), and a reload keeps it
    // neutral while A2 is active. "Usar aqui" takes the NEW session over from the shared storage (same
    // guarantee as step 7); A2 yields.
    await test.step('12. the old tab after the re-login in the other one: neutral, then takes the new session over', async () => {
      await expect(pageA.getByText(ELSEWHERE)).toBeVisible()
      await pageA.reload()
      await expect(pageA.getByText(ELSEWHERE)).toBeVisible()
      await pageA.getByRole('button', { name: SESSION.useHere }).click()
      await expect(title(pageA)).toBeVisible()
      await expect(pageA.getByRole('button', { name: /^Continuar com/ })).toHaveCount(0)
      await expect(pageA2.getByText(ELSEWHERE)).toBeVisible()
      await expectNoProtocolLeak(pageA, pageA2)
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
