import { test, expect, type Locator, type Page } from '@playwright/test'
import { escapeRegExp, HS_URL } from '../test/support/stack-env'
import { CID, DEB } from './fixtures/users'
import { closeAccount, editProfile, openProfileEditor, openProfileOf, removePhoto, setPhoto, signInAgainSilently, signOutHere } from './support/account'
import { expectNoProtocolLeak, expectReadable, expectReadableWithin } from './support/assertions'
import { AFTER_RELOGIN_404, BACKUP_LOOKUPS_WHY, backupLookupsCap, ConsoleLedger, FIRST_LOGIN_404, recognizedSet404 } from './support/console'
import { ACCOUNT, COMPOSER, LIST, PROFILE, PROFILE_EDITOR, SESSION, THREAD, TIMELINE } from './support/labels'
import { signIn } from './support/login'
import { png } from './support/media'
import { deleteSharedRooms } from './support/rooms'
import { directoryEntry, profileFacts, syncOrgFields } from './support/server-facts'
import { conversations, dmWith, orgChannel, row, send, startDm, threadPanel, unreadOf } from './support/workspace'

// ROTEIRO-U2 2.4, 2.6 and 2.7: the account, end to end (PLANO-RELEASE-PUBLICA §8.55). cid (A) writes and
// looks; deb (B) edits her profile, reads in two browsers, signs out of one and back in — the spec's
// own Dex pair (fixtures/users.ts, one pair per spec).
// - Profile (2.4): deb's nickname, pronouns and note reach cid's "Perfil" of her without a reload; her
//   photo shows there and the server holds an avatar; removed, the monogram is back and the server holds
//   none. The profile persists across local runs, so the test restores what it found.
// - Organization's fields (2.7): the harness writes deb's directory line the way the `up` does (its
//   account is born after the `up`); cid's "Perfil" of her shows Nome and Cargo. Production's writer
//   stays the `up` (ADR-054).
// - Unread and sign-out (2.6 + 2.7): deb in TWO contexts (B1, B2), both in another conversation. cid's
//   three messages and one thread reply (on deb's message, #224) count "4 unread" on the DM row of both (ADR-068: the thread
//   counts); reading in B1 brings B2 down to 1, then to 0 when B1 opens the thread, without a reload,
//   and a reload of B2 keeps 0. B1 signs out ("Sair deste navegador") and lands on the access-ended
//   screen; cid writes twice; "Entrar de novo" brings B1 back WITHOUT a password (ADR-034: the sign-out
//   is of this browser only); B2, which had dismissed what it knew, is told about this one new access.
//   That the two messages are readable in B1 is its own test (#241, ADR-077). A
//   re-login that asks for the password is a red test (ADR-034), never a step to get past.
// The DOM is scanned for protocol ids (P1) at every step.

// Display names as the MAS imported them from the Dex `name` claim (see conversation.spec.ts).
const CID_NAME = 'cid'

// cid, B1 and B2 are new devices from their login on: reading the other side's messages, each may ask the
// key backup for a session whose key has not reached it yet (CI runs 40367280318 for B1, 40371879317 for
// B2, 40375465594 for cid). Its own label, so its count stays apart from AFTER_RELOGIN_404's.
const BACKUP_BEFORE_KEY_404 = {
  url: `${HS_URL}/_matrix/client/v3/room_keys/keys/*/*?version=1 (new device, before the key)`,
  pattern: new RegExp(`^${escapeRegExp(HS_URL)}\\/_matrix\\/client\\/v3\\/room_keys\\/keys\\/[^/?]+\\/[^/?]+\\?version=1$`),
  status: 404,
  max: backupLookupsCap(1),
  per: 'page' as const,
  why: BACKUP_LOOKUPS_WHY(1),
}

// B1's lookups after the re-login (AFTER_RELOGIN_404's pattern), capped by the same ADR-077 formula: one
// unknown session in each test (cid's messages while B1 was out share one Megolm session).
const B1_AFTER_RELOGIN_404 = { ...AFTER_RELOGIN_404[0]!, max: backupLookupsCap(1), why: BACKUP_LOOKUPS_WHY(1) }

const dms = (page: Page) => conversations(page).getByRole('region', { name: LIST.dms })
const notices = (page: Page) => page.getByRole('region', { name: SESSION.notices })

// The peer's name as cid's list shows it: the accessible name of the only DM row, without the badge.
async function nameOfOnlyDm(page: Page): Promise<string> {
  const only = dms(page).getByRole('button', { name: new RegExp(`^(?!${LIST.newDm}$)`) })
  await expect(only).toHaveCount(1, { timeout: 60_000 })
  const snapshot = await only.ariaSnapshot()
  return (/^- button "(.*)"/m.exec(snapshot)?.[1] ?? '').replace(LIST.unreadSuffix, '').replace(LIST.mentionsSuffix, '')
}

// The silent re-login, with the path it took in the run's log (the 2.7 record: consent or nothing).
async function reloginAndLog(page: Page): Promise<void> {
  const visited = await signInAgainSilently(page)
  console.log(`[e2e] re-login navigations: ${visited.map((u) => new URL(u).origin + new URL(u).pathname).join(' → ')}`)
}

async function closeProfile(dialog: Locator): Promise<void> {
  await dialog.getByRole('button', { name: ACCOUNT.close, exact: true }).click()
  await expect(dialog).toHaveCount(0)
}

// Before EACH test, not once per file (§8.24 hygiene, per test — §8.57): the cid↔deb DM is reused by
// every test (startDm finds it through m.direct), so a new device in a later test would ask the backup
// for an earlier test's session that never reached it (room_keys 404). Each test creates its own DM.
test.beforeEach(async () => {
  await deleteSharedRooms('cid', 'deb')
})

test('account: profile round-trip — nickname, pronouns, note and photo reach the other side', async ({ browser }) => {
  test.setTimeout(180_000)
  const ts = Date.now()
  const hello = `oi ${ts}`
  const nick = `Deb ${ts}`
  const pronouns = `ela/dela ${ts}`
  const note = `recado ${ts}`

  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  // Boots: one login per page, no reload.
  const consoleA = new ConsoleLedger('cid', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  const consoleB = new ConsoleLedger('deb', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  let original: { nick: string; pronouns: string; note: string } | undefined
  const pageA = await ctxA.newPage()
  const pageB = await ctxB.newPage()
  try {
    consoleA.watch(pageA, 'A')
    consoleB.watch(pageB, 'B')

    let debName = ''
    await test.step('1. deb opens a DM with cid and writes; cid reads her name as the list shows it', async () => {
      await signIn(pageA, CID)
      await signIn(pageB, DEB)
      await startDm(pageB, CID_NAME)
      await send(pageB, hello)
      debName = await nameOfOnlyDm(pageA)
      await dmWith(pageA, debName).click()
      await expectReadable(pageA, hello)
      await expectNoProtocolLeak(pageA, pageB)
    })

    await test.step('2. deb edits nickname, pronouns and note: cid sees the three on her profile, without a reload', async () => {
      const editor = await openProfileEditor(pageB)
      original = {
        nick: await editor.getByLabel(PROFILE_EDITOR.nickname, { exact: true }).inputValue(),
        pronouns: await editor.getByLabel(PROFILE_EDITOR.pronouns, { exact: true }).inputValue(),
        note: await editor.getByLabel(PROFILE_EDITOR.note, { exact: true }).inputValue(),
      }
      await editProfile(pageB, { nick, pronouns, note })
      await closeAccount(pageB)
      // The author's name on the message follows the new nickname.
      await expect(pageA.getByRole('button', { name: PROFILE.open(nick), exact: true }).first()).toBeVisible({ timeout: 30_000 })
      const profile = await openProfileOf(pageA, nick)
      await expect(profile).toContainText(nick)
      await expect(profile).toContainText(pronouns)
      await expect(profile.getByRole('region', { name: PROFILE.note })).toContainText(note)
      await closeProfile(profile)
      await expectNoProtocolLeak(pageA, pageB)
    })

    await test.step('3. deb adds a photo: it shows on her profile for cid; the server holds an avatar', async () => {
      await openProfileEditor(pageB)
      await setPhoto(pageB, png(32, 32))
      await closeAccount(pageB)
      expect((await profileFacts('deb')).hasAvatar).toBe(true)
      // The avatar box is aria-hidden (decorative next to the name): the photo is asserted structurally.
      await expect(async () => {
        const profile = await openProfileOf(pageA, nick)
        try {
          await expect(profile.locator('img')).toHaveCount(1, { timeout: 5_000 })
        } finally {
          await closeProfile(profile)
        }
      }).toPass({ timeout: 30_000 })
      await expectNoProtocolLeak(pageA, pageB)
    })

    await test.step('4. deb removes it: the monogram is back for cid; the server holds no avatar', async () => {
      await openProfileEditor(pageB)
      await removePhoto(pageB)
      await closeAccount(pageB)
      expect((await profileFacts('deb')).hasAvatar).toBe(false)
      await expect(async () => {
        const profile = await openProfileOf(pageA, nick)
        try {
          await expect(profile.locator('img')).toHaveCount(0, { timeout: 5_000 })
          await expect(profile.locator('[aria-hidden="true"]').first()).toHaveText(/\S/)
        } finally {
          await closeProfile(profile)
        }
      }).toPass({ timeout: 30_000 })
      await expectNoProtocolLeak(pageA, pageB)
    })

    console.log(`[e2e] console A: ${JSON.stringify(consoleA.observed())}`)
    console.log(`[e2e] console B: ${JSON.stringify(consoleB.observed())}`)
    consoleA.expectClean()
    consoleB.expectClean()
  } finally {
    // The profile persists across local runs: put back what was found, and no photo.
    if (original && !pageB.isClosed()) {
      const editor = await openProfileEditor(pageB)
      const remove = editor.getByRole('button', { name: PROFILE_EDITOR.removePhoto, exact: true })
      if (await remove.isVisible()) await removePhoto(pageB)
      const fields = { nick: original.nick, pronouns: original.pronouns, note: original.note }
      const current = {
        nick: await editor.getByLabel(PROFILE_EDITOR.nickname, { exact: true }).inputValue(),
        pronouns: await editor.getByLabel(PROFILE_EDITOR.pronouns, { exact: true }).inputValue(),
        note: await editor.getByLabel(PROFILE_EDITOR.note, { exact: true }).inputValue(),
      }
      if (JSON.stringify(current) !== JSON.stringify(fields)) await editProfile(pageB, fields)
      await closeAccount(pageB)
    }
    await ctxA.close()
    await ctxB.close()
  }
})

test('account: the organization’s fields reach the other side’s profile', async ({ browser }) => {
  test.setTimeout(180_000)
  const hello = `org ${Date.now()}`
  const directory = directoryEntry('deb')

  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  // Boots: one login per page, no reload.
  const consoleA = new ConsoleLedger('cid', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  const consoleB = new ConsoleLedger('deb', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  try {
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()
    consoleA.watch(pageA, 'A')
    consoleB.watch(pageB, 'B')
    await signIn(pageA, CID)
    await signIn(pageB, DEB)
    await startDm(pageB, CID_NAME)
    await send(pageB, hello)
    const debName = await nameOfOnlyDm(pageA)
    await dmWith(pageA, debName).click()
    await expectReadable(pageA, hello)

    await test.step('1. with nothing in the directory, cid sees no organization card', async () => {
      await syncOrgFields('deb', undefined)
      const profile = await openProfileOf(pageA, debName)
      // The name is the discriminator: the profile has loaded, so the missing card is a fact.
      await expect(profile).toContainText(debName)
      await expect(profile.getByRole('region', { name: PROFILE.org })).toHaveCount(0)
      await closeProfile(profile)
    })

    await test.step('2. the directory writes deb’s line: cid sees Nome and Cargo on her profile', async () => {
      await syncOrgFields('deb', directory)
      const profile = await openProfileOf(pageA, debName)
      const org = profile.getByRole('region', { name: PROFILE.org })
      await expect(org).toContainText(`${PROFILE.orgName}${directory.fullName}`)
      await expect(org).toContainText(`${PROFILE.orgJobTitle}${directory.jobTitle}`)
      await closeProfile(profile)
      await expectNoProtocolLeak(pageA, pageB)
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

test('account: unread converges across two browsers; sign-out and silent re-login', async ({ browser }) => {
  test.setTimeout(240_000)
  const ts = Date.now()
  const sent = [`um ${ts}`, `dois ${ts}`, `três ${ts}`]
  const root = `raiz ${ts}`
  const threadReply = `no fio ${ts}`
  const whileOut = [`fora um ${ts}`, `fora dois ${ts}`]

  const ctxA = await browser.newContext()
  const ctxB1 = await browser.newContext()
  const ctxB2 = await browser.newContext()
  // Boots: A one; B1 the login and the re-login; B2 the login and one reload. One ledger per context of
  // deb: the re-login allowance is B1's alone.
  const consoleA = new ConsoleLedger('cid', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  consoleA.allow([BACKUP_BEFORE_KEY_404])
  const consoleB1 = new ConsoleLedger('deb B1', [...FIRST_LOGIN_404, ...recognizedSet404(2), BACKUP_BEFORE_KEY_404])
  const consoleB2 = new ConsoleLedger('deb B2', [...FIRST_LOGIN_404, ...recognizedSet404(2), BACKUP_BEFORE_KEY_404])
  try {
    const pageA = await ctxA.newPage()
    const b1 = await ctxB1.newPage()
    const b2 = await ctxB2.newPage()
    consoleA.watch(pageA, 'A')
    consoleB1.watch(b1, 'B1')
    consoleB2.watch(b2, 'B2')

    let debName = ''
    const dmOf = (page: Page) => dmWith(page, CID_NAME)
    await test.step('1. deb in B1 and B2, both in another conversation; cid writes three messages and a thread reply: "4 unread" on both', async () => {
      await signIn(pageA, CID)
      await signIn(b1, DEB)
      await signIn(b2, DEB)
      // Idempotent: the DM of the profile test when it ran first, a new one otherwise. deb writes the
      // thread's root: a thread on one's own just-sent message is #224, out of this spec's scope.
      await startDm(b1, CID_NAME)
      await send(b1, root)
      for (const page of [b1, b2]) await orgChannel(page).click()
      debName = await nameOfOnlyDm(pageA)
      await dmWith(pageA, debName).click()
      await expectReadable(pageA, root)
      for (const text of sent) await send(pageA, text)
      const rootRow = row(pageA, root)
      await rootRow.hover()
      await rootRow.getByRole('button', { name: TIMELINE.replyInThread }).click()
      const panel = threadPanel(pageA)
      await panel.getByRole('textbox', { name: COMPOSER.editor, exact: true }).fill(threadReply)
      await panel.getByRole('button', { name: COMPOSER.send }).click()
      await expect(panel.getByRole('log', { name: THREAD.replies })).toContainText(threadReply)
      for (const page of [b1, b2]) await expect.poll(() => unreadOf(dmOf(page)), { timeout: 30_000 }).toBe(4)
      await expectNoProtocolLeak(pageA, b1, b2)
    })

    await test.step('2. B1 reads the DM: B2 drops to 1 without a reload; B1 opens the thread: B2 drops to 0; a reload of B2 keeps 0', async () => {
      await dmOf(b1).click()
      await expectReadable(b1, ...sent)
      await expect.poll(() => unreadOf(dmOf(b2)), { timeout: 30_000 }).toBe(1)
      await row(b1, root).getByRole('button', { name: TIMELINE.replies(1) }).click()
      await expect(threadPanel(b1).getByRole('log', { name: THREAD.replies })).toContainText(threadReply)
      await expect.poll(() => unreadOf(dmOf(b2)), { timeout: 30_000 }).toBe(0)
      await b2.reload()
      await expect(orgChannel(b2)).toBeVisible()
      await expect(dmOf(b2)).toBeVisible()
      // Held for a while after the reload: a count stuck in B2 is what 2.6 forbids.
      for (let i = 0; i < 5; i++) {
        expect(await unreadOf(dmOf(b2))).toBe(0)
        await b2.waitForTimeout(1_000)
      }
      await expectNoProtocolLeak(b1, b2)
    })

    await test.step('3. B1 signs out of this browser: the access-ended screen; cid writes twice meanwhile', async () => {
      // B2 has been told about B1 since its own login; it dismisses now, so that what it shows after
      // the re-login is about the re-login alone.
      await notices(b2).getByRole('button', { name: SESSION.dismiss }).click()
      await expect(notices(b2)).toHaveCount(0)
      await signOutHere(b1)
      const ended = b1.getByRole('alert')
      await expect(ended).toContainText(SESSION.ended)
      await expect(ended.getByRole('button', { name: SESSION.signInAgain })).toBeVisible()
      await expectNoProtocolLeak(b1)
      for (const text of whileOut) await send(pageA, text)
    })

    await test.step('4. "Entrar de novo" brings B1 back WITHOUT a password (ADR-034); B2 is told about the new access', async () => {
      // The new device asks the backup for the sessions it lacks (§8.19); custody covers them (ADR-061).
      consoleB1.allow([B1_AFTER_RELOGIN_404])
      await reloginAndLog(b1)
      await dmOf(b1).click()
      await expect(notices(b2)).toContainText(SESSION.newAccess, { timeout: 30_000 })
      await expectNoProtocolLeak(pageA, b1, b2)
    })

    console.log(`[e2e] console A: ${JSON.stringify(consoleA.observed())}`)
    console.log(`[e2e] console B1: ${JSON.stringify(consoleB1.observed())}`)
    console.log(`[e2e] console B2: ${JSON.stringify(consoleB2.observed())}`)
    consoleA.expectClean()
    consoleB1.expectClean()
    consoleB2.expectClean()
  } finally {
    await ctxA.close()
    await ctxB1.close()
    await ctxB2.close()
  }
})

// ROTEIRO-U2 2.7, the rest: what cid wrote while B1 was out is readable in B1 after the silent
// re-login, WITHOUT a reload. The new device asks the backup before B2 has put the key there, and the
// custody before the agent has deposited it (#241); the custody re-consult with backoff and the
// re-decrypt (ADR-077) reach the key once one of them has it. Honest ceiling: ≤ 10 s when the live
// sibling (B2) puts it in the backup, ≤ 30 s through the custody — so 40 s here (cap + margin).
// Same scenario as above, without the unread part.
test('account: messages sent while signed out are readable after the silent re-login', async ({ browser }) => {
  test.setTimeout(180_000)
  const ts = Date.now()
  const hello = `antes ${ts}`
  const whileOut = [`fora um ${ts}`, `fora dois ${ts}`]

  const ctxA = await browser.newContext()
  const ctxB1 = await browser.newContext()
  const ctxB2 = await browser.newContext()
  // Boots: A one; B1 the login and the re-login; B2 one.
  const consoleA = new ConsoleLedger('cid', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  // cid is a new device too (test 2's rule): reading B1's first message it may ask the backup before the
  // key reaches it, and the re-decrypt after each custody consult asks again (ADR-077 dec. 3).
  consoleA.allow([BACKUP_BEFORE_KEY_404])
  // B1 is a new device from its login on (test 2's rule, owner): it may ask the backup before the key
  // arrives. After the re-login, B1_AFTER_RELOGIN_404 (allowed later, so it wins) counts its own lookups.
  const consoleB1 = new ConsoleLedger('deb B1', [...FIRST_LOGIN_404, ...recognizedSet404(2), BACKUP_BEFORE_KEY_404])
  const consoleB2 = new ConsoleLedger('deb B2', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  try {
    const pageA = await ctxA.newPage()
    const b1 = await ctxB1.newPage()
    const b2 = await ctxB2.newPage()
    consoleA.watch(pageA, 'A')
    consoleB1.watch(b1, 'B1')
    consoleB2.watch(b2, 'B2')

    await signIn(pageA, CID)
    await signIn(b1, DEB)
    await signIn(b2, DEB)
    await startDm(b1, CID_NAME)
    // The crypto settles before the sign-out: B1's first key-backup upload has gone out. The repro of the
    // wipe timeout (sign-out 1.6 s after the first send) lives on #247, not here; this test proves the
    // readability after the re-login.
    const sentAt = Date.now()
    const backedUp = b1
      .waitForResponse((r) => r.request().method() === 'PUT' && new URL(r.url()).pathname.endsWith('/room_keys/keys'), {
        timeout: 12_000,
      })
      .then(
        () => `${Date.now() - sentAt} ms`,
        () => 'not seen in 12 s',
      )
    await send(b1, hello)
    await dmWith(pageA, await nameOfOnlyDm(pageA)).click()
    await expectReadable(pageA, hello)
    console.log(`[e2e] B1 first backup upload: ${await backedUp}`)
    await signOutHere(b1)
    for (const text of whileOut) await send(pageA, text)
    consoleB1.allow([B1_AFTER_RELOGIN_404])
    await reloginAndLog(b1)
    const backAt = Date.now()
    await dmWith(b1, CID_NAME).click()
    await expectReadableWithin(b1, 40_000, ...whileOut)
    console.log(`[e2e] B1 readable ${Date.now() - backAt} ms after the re-login`)
    await expectNoProtocolLeak(pageA, b1, b2)

    console.log(`[e2e] console A: ${JSON.stringify(consoleA.observed())}`)
    console.log(`[e2e] console B1: ${JSON.stringify(consoleB1.observed())}`)
    console.log(`[e2e] console B2: ${JSON.stringify(consoleB2.observed())}`)
    consoleA.expectClean()
    consoleB1.expectClean()
    consoleB2.expectClean()
  } finally {
    await ctxA.close()
    await ctxB1.close()
    await ctxB2.close()
  }
})
