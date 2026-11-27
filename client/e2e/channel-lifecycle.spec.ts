import { test, expect, type Page } from '@playwright/test'
import { escapeRegExp, HS_URL } from '../test/support/stack-env'
import { ARI, BEL } from './fixtures/users'
import { expectNoProtocolLeak, expectReadable } from './support/assertions'
import { ConsoleLedger, FIRST_LOGIN_404, recognizedSet404 } from './support/console'
import { LIST, MANAGE, PROFILE } from './support/labels'
import { signIn } from './support/login'
import { addMember, createChannel, deleteSharedRooms, leaveChannel, openManage, removeMember, saveChannel, setRole } from './support/rooms'
import { channelFacts, liftSendLimit, syncCarriesStateAfter, type ChannelFacts } from './support/server-facts'
import { channelRow, send } from './support/workspace'

// ROTEIRO-U2 2.3: a channel's whole life, end to end (PLANO-RELEASE-PUBLICA §8.55). ari (A) creates
// and administers; bel (B) is added, promoted, demoted, removed, added again, and leaves on her own —
// the spec's own Dex pair (fixtures/users.ts, one pair per spec). A PRIVATE channel shows the lock
// "Canal privado" instead of the '#' in the list and the header, on both sides; bel never accepts
// anything (ADR-044); the server says it is encrypted, invite-only, with ari at 100 and bel at 0.
// The new name reaches bel without a reload (the topic: its own test, #245). Admin ↔ Member moves the power level (50 / 0) and the
// roster of both. The picker (channel-management.md §9 items 4–6) has the ✕ and the filter, and stays open
// after adding. bel, an admin for a moment (PL 50), is offered no role control — the server refuses every role
// change at PL 50 (ADR-026 addendum, ADR-115) — and, trying to remove ari, the channel's creator, meets the
// server's honest refusal (ADR-115 dec. 3) and nothing changes; back to member of this private channel, she is
// offered only "+ Adicionar" (the server accepts her invite), and her own row offers no mutation (ADR-081).
// Removed, the channel leaves bel's list; added again, it comes back and new messages are readable. In a second
// (public) channel bel, a member, is offered no control, and leaves: it leaves her list and ari's roster.
// Archiving is archive.spec's. P1 at every step.

// Display names as the MAS imported them from the Dex `name` claim (see conversation.spec.ts).
const ARI_NAME = 'ari'
const BEL_NAME = 'bel'

// An admin removing the channel's creator is refused by the server (power level): Chromium logs the 403
// of the kick.
const ADMIN_REMOVES_CREATOR_403 = {
  url: `${HS_URL}/_matrix/client/v3/rooms/*/kick`,
  pattern: new RegExp(`^${escapeRegExp(HS_URL)}\\/_matrix\\/client\\/v3\\/rooms\\/[^/?]+\\/kick$`),
  status: 403,
  max: 1,
  per: 'page' as const,
  why: 'bel (admin, PL 50) tries to remove ari (PL 100), the creator: the server refuses honestly (ADR-115 dec. 3)',
}

// A member's level as the server applies it: the explicit entry, or the room default.
const levelOf = (facts: ChannelFacts, localpart: string): number => facts.powerLevels[localpart] ?? facts.usersDefault

const roster = (page: Page) => page.getByRole('region', { name: MANAGE.members })
const roleOf = (page: Page, name: string) => page.getByRole('combobox', { name: MANAGE.role(name), exact: true })
// The own row has no control (ADR-081): the role reads as text there.
const rowOf = (page: Page, name: string) => roster(page).getByRole('listitem').filter({ hasText: name })
const headerName = (page: Page) => page.getByRole('main').getByRole('heading', { level: 2 })

// Before EACH test, not once per file (§8.57): test 1 leaves its private channel joined by both, and
// the session ari sends after the re-add closes with the context before its backup upload. The topic
// test's new device of ari would ask the backup for it (room_keys 404) — the §8.24 hygiene, per test.
test.beforeEach(async () => {
  await deleteSharedRooms('ari', 'bel')
})

test('channel lifecycle: private, rename, roles, honest refusal, remove and re-add, leave', async ({ browser }) => {
  test.setTimeout(240_000)
  const ts = Date.now()
  const channelName = `ciclo-${ts}`
  const renamed = `ciclo-novo-${ts}`
  const topic = `tópico ${ts}`
  const first = `primeira ${ts}`
  const afterReadd = `de volta ${ts}`
  const leaveName = `saida-${ts}`

  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  // Boots: one login per page, no reload.
  const consoleA = new ConsoleLedger('ari', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  const consoleB = new ConsoleLedger('bel', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  try {
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()
    consoleA.watch(pageA, 'A')
    consoleB.watch(pageB, 'B')

    await test.step('1. ari creates a PRIVATE channel and adds bel: the lock on both, nothing to accept, encrypted, readable', async () => {
      await signIn(pageA, ARI)
      await signIn(pageB, BEL)
      // The scenario writes more state than the local rc_message burst lets through (create ×2, invite
      // ×3, rename, topic, roles, kick).
      await liftSendLimit('ari')
      await liftSendLimit('bel')
      await createChannel(pageA, { name: channelName, kind: 'private' })
      await openManage(pageA, channelName, 'private')
      // The picker (§9 items 4–6): the compose casca with the ✕, the filter by name, and adding keeps it open.
      const add = pageA.getByRole('dialog', { name: MANAGE.addMember })
      const bel = add.getByRole('button', { name: BEL_NAME, exact: true })
      await expect(async () => {
        if ((await add.count()) > 0) await pageA.keyboard.press('Escape')
        await pageA.getByRole('button', { name: MANAGE.addMember }).click()
        await expect(bel).toBeVisible({ timeout: 5_000 })
      }).toPass({ timeout: 60_000 })
      await expect(add).toHaveClass(/compose-dialog/)
      const filter = add.getByRole('textbox', { name: MANAGE.filter })
      await filter.fill('zz')
      await expect(add.getByText(MANAGE.noResults('zz'))).toBeVisible()
      await add.getByRole('button', { name: MANAGE.clearFilter }).click()
      await filter.fill(BEL_NAME.slice(0, 2))
      await bel.click()
      await expect(bel).toHaveCount(0, { timeout: 30_000 })
      await expect(add).toBeVisible()
      // The ✕ of the casca goes back to the main view.
      await add.getByRole('button', { name: MANAGE.closePicker }).first().click()
      await expect(add).toHaveCount(0)
      await expect(roster(pageA)).toContainText(BEL_NAME)
      await pageA.getByRole('button', { name: MANAGE.close }).click()
      // The invite is auto-joined on bel's side (ADR-044): the row just appears.
      await expect(channelRow(pageB, channelName)).toBeVisible({ timeout: 60_000 })
      for (const page of [pageA, pageB]) {
        const r = channelRow(page, channelName)
        await expect(r).toHaveAccessibleName(new RegExp(`^${LIST.privateMark} ${escapeRegExp(channelName)}(\\s|$)`))
        await r.click()
        await expect(headerName(page).getByRole('img', { name: LIST.privateMark, exact: true })).toBeVisible()
        await expect(headerName(page)).toContainText(channelName)
        await expect(headerName(page)).not.toContainText('#')
      }
      const facts = await channelFacts(channelName)
      expect(facts.encrypted).toBe(true)
      expect(facts.joinRule).toBe('invite')
      expect(facts.membership).toMatchObject({ ari: 'join', bel: 'join' })
      expect(levelOf(facts, 'ari')).toBe(100)
      expect(levelOf(facts, 'bel')).toBe(0)
      await send(pageA, first)
      await expectReadable(pageB, first)
      await expectNoProtocolLeak(pageA, pageB)
    })

    await test.step('2. ari renames and sets the topic: bel sees the new name without a reload, in the list and the header', async () => {
      await openManage(pageA, channelName, 'private')
      await saveChannel(pageA, { name: renamed, topic })
      await expect(channelRow(pageB, renamed)).toBeVisible({ timeout: 30_000 })
      await expect(channelRow(pageB, channelName)).toHaveCount(0)
      await expect(headerName(pageB)).toContainText(renamed)
      await expectNoProtocolLeak(pageA, pageB)
    })

    await test.step('3. ari makes bel Admin (PL 50): no role control for her; she tries to remove ari, the creator: refused honestly (ADR-115)', async () => {
      await openManage(pageB, renamed, 'private')
      await setRole(pageA, BEL_NAME, MANAGE.admin)
      await expect(roleOf(pageA, BEL_NAME)).toHaveValue('admin', { timeout: 30_000 })
      await expect(rowOf(pageB, BEL_NAME)).toContainText(MANAGE.admin, { timeout: 30_000 })
      expect(levelOf(await channelFacts(renamed), 'bel')).toBe(50)
      await expectNoProtocolLeak(pageA, pageB)

      // ADR-115 dec. 5: bel's panel re-reads the answers on her own member.changed. A promoted admin may rename,
      // add, remove and archive, and never change a role (ADR-026 addendum): no role control on any row.
      await expect(pageB.getByRole('button', { name: MANAGE.remove(ARI_NAME), exact: true })).toBeVisible({ timeout: 30_000 })
      await expect(pageB.getByLabel(MANAGE.name, { exact: true })).toBeVisible()
      await expect(pageB.getByRole('button', { name: MANAGE.addMember })).toBeVisible()
      await expect(pageB.getByRole('button', { name: MANAGE.archive })).toBeVisible()
      await expect(roster(pageB).getByRole('combobox')).toHaveCount(0)
      await expect(rowOf(pageB, ARI_NAME)).toContainText(MANAGE.admin)

      // ari is at 100: the server refuses a kick from 50. The refusal shows where the verb ran, the confirm,
      // which stays open; nothing changes.
      const before = await channelFacts(renamed)
      consoleB.allow([ADMIN_REMOVES_CREATOR_403])
      await pageB.getByRole('button', { name: MANAGE.remove(ARI_NAME), exact: true }).click()
      const confirm = pageB.getByRole('dialog', { name: MANAGE.removeTitle })
      await confirm.getByRole('button', { name: MANAGE.confirmRemove, exact: true }).click()
      await expect(confirm.getByRole('alert')).toHaveText(MANAGE.failed, { timeout: 30_000 })
      await expect(confirm).toBeVisible()
      await confirm.getByRole('button', { name: MANAGE.cancel, exact: true }).click()
      await expect(rowOf(pageB, ARI_NAME)).toBeVisible()
      await expect(rowOf(pageA, ARI_NAME)).toContainText(MANAGE.admin)
      expect(await channelFacts(renamed)).toEqual(before)
      await expectNoProtocolLeak(pageA, pageB)
    })

    await test.step('4. ari makes bel Member again (PL 0): in this private channel bel is offered only "+ Adicionar" (ADR-115)', async () => {
      await setRole(pageA, BEL_NAME, MANAGE.member)
      await expect(roleOf(pageA, BEL_NAME)).toHaveValue('member', { timeout: 30_000 })
      await expect(rowOf(pageB, BEL_NAME)).toContainText(MANAGE.member, { timeout: 30_000 })
      expect(levelOf(await channelFacts(renamed), 'bel')).toBe(0)
      await expect(pageB.getByRole('button', { name: MANAGE.remove(ARI_NAME), exact: true })).toHaveCount(0, { timeout: 30_000 })
      await expect(pageB.getByRole('button', { name: MANAGE.addMember })).toBeVisible()
      await expect(roster(pageB).getByRole('combobox')).toHaveCount(0)
      await expect(pageB.getByRole('button', { name: MANAGE.archive })).toHaveCount(0)
      await expect(pageB.getByLabel(MANAGE.name, { exact: true })).toHaveCount(0)
      await expect(pageB.getByRole('button', { name: MANAGE.leave })).toBeVisible()
      await expect(roster(pageB).getByRole('button', { name: PROFILE.open(ARI_NAME), exact: true })).toBeVisible()
      await expectNoProtocolLeak(pageA, pageB)
    })

    await test.step('4b. bel\'s own row reads "· você" and offers no mutation on herself (ADR-081)', async () => {
      await expect(rowOf(pageB, BEL_NAME)).toContainText(MANAGE.you)
      await expect(roleOf(pageB, BEL_NAME)).toHaveCount(0)
      await expect(pageB.getByRole('button', { name: MANAGE.remove(BEL_NAME), exact: true })).toHaveCount(0)
      await pageB.getByRole('button', { name: MANAGE.close }).click()
    })

    await test.step('5. ari removes bel: the channel leaves her list; added again, it comes back and is readable', async () => {
      expect(await syncCarriesStateAfter(), 'the homeserver answers state_after in /sync (ADR-078, msc4222_enabled)').toBe(true)
      await removeMember(pageA, BEL_NAME)
      await expect(channelRow(pageB, renamed)).toHaveCount(0, { timeout: 60_000 })
      await expect(roster(pageA).getByRole('button', { name: PROFILE.open(BEL_NAME), exact: true })).toHaveCount(0)
      expect((await channelFacts(renamed)).membership['bel']).toBe('leave')
      await expectNoProtocolLeak(pageA, pageB)

      await addMember(pageA, BEL_NAME)
      await pageA.getByRole('button', { name: MANAGE.close }).click()
      // Back in bel's list under the NEW name: the rejoin is a `limited` /sync over a reused Room, and
      // only `state_after` gives the SDK the final state (ADR-078, PLANO-RELEASE-PUBLICA §8.59).
      const back = channelRow(pageB, renamed)
      await expect(back).toBeVisible({ timeout: 60_000 })
      expect((await channelFacts(renamed)).membership['bel']).toBe('join')
      await send(pageA, afterReadd)
      await back.click()
      await expectReadable(pageB, afterReadd)
      await expectNoProtocolLeak(pageA, pageB)
    })

    await test.step('6. in a new public channel bel leaves on her own: it leaves her list and ari\'s roster', async () => {
      await createChannel(pageA, { name: leaveName, kind: 'public' })
      await openManage(pageA, leaveName)
      await addMember(pageA, BEL_NAME)
      await expect(channelRow(pageB, leaveName)).toBeVisible({ timeout: 60_000 })
      expect((await channelFacts(leaveName)).membership['bel']).toBe('join')

      // A member of a public channel is offered no control (ADR-115): name and topic as text, no add, no role
      // control, no Remove, no archive; leaving stays.
      await openManage(pageB, leaveName)
      await expect(roster(pageB).getByRole('button', { name: PROFILE.open(ARI_NAME), exact: true })).toBeVisible({ timeout: 30_000 })
      await expect(pageB.getByRole('button', { name: MANAGE.addMember })).toHaveCount(0)
      await expect(roster(pageB).getByRole('combobox')).toHaveCount(0)
      await expect(pageB.getByRole('button', { name: MANAGE.remove(ARI_NAME), exact: true })).toHaveCount(0)
      await expect(pageB.getByRole('button', { name: MANAGE.archive })).toHaveCount(0)
      await expect(pageB.getByLabel(MANAGE.name, { exact: true })).toHaveCount(0)
      await leaveChannel(pageB)
      await expect(channelRow(pageB, leaveName)).toHaveCount(0, { timeout: 30_000 })
      // ari's panel is still open on the channel: bel's row goes from the roster without a reload.
      await expect(roster(pageA).getByRole('button', { name: PROFILE.open(BEL_NAME), exact: true })).toHaveCount(0, {
        timeout: 30_000,
      })
      await expect(roster(pageA).getByRole('button', { name: PROFILE.open(ARI_NAME), exact: true })).toBeVisible()
      expect((await channelFacts(leaveName)).membership['bel']).toBe('leave')
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

// ROTEIRO-U2 2.3, the topic: a new topic reaches the other member without a reload. A topic-only
// change has its own channel.changed (m.room.topic in onStateEvent, #245), so it no longer waits for
// an incidental emission — 10 s is the bound.
test('channel lifecycle: a new topic reaches the other member without a reload', async ({ browser }) => {
  test.setTimeout(180_000)
  const ts = Date.now()
  const channelName = `topico-${ts}`
  const topic = `tópico novo ${ts}`

  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  const consoleA = new ConsoleLedger('ari', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  const consoleB = new ConsoleLedger('bel', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  try {
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()
    consoleA.watch(pageA, 'A')
    consoleB.watch(pageB, 'B')

    await signIn(pageA, ARI)
    await signIn(pageB, BEL)
    await createChannel(pageA, { name: channelName, kind: 'public' })
    await openManage(pageA, channelName)
    await addMember(pageA, BEL_NAME)
    await expect(channelRow(pageB, channelName)).toBeVisible({ timeout: 60_000 })
    await channelRow(pageB, channelName).click()
    const savedAt = Date.now()
    await saveChannel(pageA, { topic })
    const ackAt = Date.now()
    await expect(pageB.getByRole('main')).toContainText(topic, { timeout: 10_000 })
    const shownAt = Date.now()
    console.log(`[e2e] topic reached bel ${shownAt - savedAt} ms after save (${shownAt - ackAt} ms after ack)`)
    await expectNoProtocolLeak(pageA, pageB)

    consoleA.expectClean()
    consoleB.expectClean()
  } finally {
    await ctxA.close()
    await ctxB.close()
  }
})
