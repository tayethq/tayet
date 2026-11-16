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
// roster of both. bel, a member, trying to change ari's role meets the server's honest refusal inline
// (ADR-026: the refusal is correct, not a bug) and nothing changes; her own row offers no mutation
// (ADR-081). Removed, the channel leaves bel's
// list; added again, it comes back and new messages are readable. In a second (public) channel bel
// leaves: it leaves her list and ari's roster. Archiving is archive.spec's. P1 at every step.

// Display names as the MAS imported them from the Dex `name` claim (see conversation.spec.ts).
const ARI_NAME = 'ari'
const BEL_NAME = 'bel'

// A member changing someone's role is refused by the server (power level): Chromium logs the 403 of
// the state write.
const MEMBER_ROLE_CHANGE_403 = {
  url: `${HS_URL}/_matrix/client/v3/rooms/*/state/m.room.power_levels/`,
  pattern: new RegExp(`^${escapeRegExp(HS_URL)}\\/_matrix\\/client\\/v3\\/rooms\\/[^/?]+\\/state\\/m\\.room\\.power_levels\\/?$`),
  status: 403,
  max: 1,
  per: 'page' as const,
  why: "bel (member, PL 0) tries to change ari's role: the server refuses honestly (ADR-026)",
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
      await addMember(pageA, BEL_NAME)
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

    await test.step('3. ari makes bel Admin (PL 50), then Member again (PL 0): the roster of both follows', async () => {
      await openManage(pageB, renamed, 'private')
      await setRole(pageA, BEL_NAME, MANAGE.admin)
      await expect(roleOf(pageA, BEL_NAME)).toHaveValue('admin', { timeout: 30_000 })
      await expect(rowOf(pageB, BEL_NAME)).toContainText(MANAGE.admin, { timeout: 30_000 })
      expect(levelOf(await channelFacts(renamed), 'bel')).toBe(50)
      await expectNoProtocolLeak(pageA, pageB)

      await setRole(pageA, BEL_NAME, MANAGE.member)
      await expect(roleOf(pageA, BEL_NAME)).toHaveValue('member', { timeout: 30_000 })
      await expect(rowOf(pageB, BEL_NAME)).toContainText(MANAGE.member, { timeout: 30_000 })
      expect(levelOf(await channelFacts(renamed), 'bel')).toBe(0)
      await expectNoProtocolLeak(pageA, pageB)
    })

    await test.step("4. bel, a member, tries to change ari's role: refused honestly inline, nothing changes (ADR-026)", async () => {
      const before = await channelFacts(renamed)
      consoleB.allow([MEMBER_ROLE_CHANGE_403])
      // ari created the channel, so she is already Admin: the change that reaches the server is the demotion.
      await setRole(pageB, ARI_NAME, MANAGE.member)
      await expect(roster(pageB).getByRole('alert')).toHaveText(MANAGE.roleRefused, { timeout: 30_000 })
      // The controlled select reverts to the role the server holds.
      await expect(roleOf(pageB, ARI_NAME)).toHaveValue('admin')
      await expect(rowOf(pageA, ARI_NAME)).toContainText(MANAGE.admin)
      expect(await channelFacts(renamed)).toEqual(before)
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

      await openManage(pageB, leaveName)
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
