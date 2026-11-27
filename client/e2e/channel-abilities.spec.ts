import { test, expect, type Page } from '@playwright/test'
import { BETO, CIRO, ENZO } from './fixtures/users'
import { expectNoProtocolLeak } from './support/assertions'
import { ConsoleLedger, FIRST_LOGIN_404, recognizedSet404 } from './support/console'
import { MANAGE } from './support/labels'
import { signIn } from './support/login'
import { addMember, createChannel, deleteChannelsNamed, deleteSharedRooms, openManage, saveChannel } from './support/rooms'
import { channelFacts, placeInPrivateChannel } from './support/server-facts'
import { channelRow } from './support/workspace'

// ADR-115 (Proposto): the management screen offers what the server accepts, verb by verb, and not by the role of the
// reader's own row. Two cases the role hid, end to end on the real server:
//   - an ordinary member of a PRIVATE channel is offered "+ Adicionar", and the server takes the invite: beto creates
//     the channel and adds ciro (level 0); ciro adds enzo, who shares another channel with him;
//   - a guest who created a channel (level 100, read as a guest, ADR-083 dec. 4) manages it: enzo creates his own
//     channel, his row reads "Convidado", and he renames it and archives it.
// The trio is the spec's own (fixtures/users.ts); enzo is in ORG_GUESTS (outside #all). The system account puts ciro
// and enzo in a private channel before their first login, standing in for the admin of ADR-083 P2/P3, so enzo is in
// ciro's known set (ADR-029 dec. 3). P1 at every step.

const BETO_NAME = 'beto'
const CIRO_NAME = 'ciro'
const ENZO_NAME = 'enzo'
const ts = Date.now()
const PRIVATE = `privado-${ts}`
const AUX = `apoio-abilities-${ts}`
const OWN = `convidado-${ts}`
const OWN_RENAMED = `convidado-novo-${ts}`

const roster = (page: Page) => page.getByRole('region', { name: MANAGE.members })
const rowOf = (page: Page, name: string) => roster(page).getByRole('listitem').filter({ hasText: name })

test.beforeEach(async () => {
  await deleteSharedRooms(BETO_NAME, CIRO_NAME)
  await deleteSharedRooms(CIRO_NAME, ENZO_NAME)
  await deleteChannelsNamed('convidado-')
})

test.afterEach(async () => {
  await deleteSharedRooms(BETO_NAME, CIRO_NAME)
  await deleteSharedRooms(CIRO_NAME, ENZO_NAME)
  await deleteChannelsNamed('convidado-')
})

test('channel abilities: a member of a private channel adds a person; a guest who created a channel manages it', async ({ browser }) => {
  test.setTimeout(240_000)
  await placeInPrivateChannel(AUX, [CIRO_NAME, ENZO_NAME])

  const people = [
    { name: BETO_NAME, user: BETO },
    { name: CIRO_NAME, user: CIRO },
    { name: ENZO_NAME, user: ENZO },
  ]
  const ledgers = people.map((p) => new ConsoleLedger(p.name, [...FIRST_LOGIN_404, ...recognizedSet404(1)]))
  const contexts = await Promise.all(people.map(() => browser.newContext()))
  try {
    const [beto, ciro, enzo] = await Promise.all(contexts.map((c) => c.newPage()))
    const pages = [beto!, ciro!, enzo!]
    pages.forEach((page, i) => ledgers[i]!.watch(page, people[i]!.name))
    for (const [i, page] of pages.entries()) await signIn(page, people[i]!.user)
    await expect(channelRow(ciro!, AUX)).toBeVisible({ timeout: 60_000 })
    await expect(channelRow(enzo!, AUX)).toBeVisible({ timeout: 60_000 })

    await test.step('1. beto creates a private channel and adds ciro, a member (level 0)', async () => {
      await createChannel(beto!, { name: PRIVATE, kind: 'private' })
      await openManage(beto!, PRIVATE, 'private')
      await addMember(beto!, CIRO_NAME)
      await beto!.getByRole('button', { name: MANAGE.close }).click()
      await expect(channelRow(ciro!, PRIVATE)).toBeVisible({ timeout: 60_000 })
      const facts = await channelFacts(PRIVATE)
      expect(facts.joinRule).toBe('invite')
      expect(facts.powerLevels['beto']).toBe(100)
      expect(facts.powerLevels['ciro'] ?? facts.usersDefault).toBe(0)
    })

    await test.step('2. ciro, a member of the private channel, is offered "+ Adicionar" and nothing else, and adds enzo', async () => {
      await openManage(ciro!, PRIVATE, 'private')
      await expect(rowOf(ciro!, BETO_NAME)).toContainText(MANAGE.admin, { timeout: 30_000 })
      await expect(ciro!.getByRole('button', { name: MANAGE.addMember })).toBeVisible()
      await expect(roster(ciro!).getByRole('combobox')).toHaveCount(0)
      await expect(ciro!.getByRole('button', { name: MANAGE.remove(BETO_NAME), exact: true })).toHaveCount(0)
      await expect(ciro!.getByRole('button', { name: MANAGE.archive })).toHaveCount(0)
      await expect(ciro!.getByLabel(MANAGE.name, { exact: true })).toHaveCount(0)
      await expect(rowOf(ciro!, CIRO_NAME)).toContainText(MANAGE.member)
      await addMember(ciro!, ENZO_NAME)
      await expect.poll(async () => (await channelFacts(PRIVATE)).membership['enzo'], { timeout: 60_000 }).toBe('join')
      await expect(channelRow(enzo!, PRIVATE)).toBeVisible({ timeout: 60_000 })
      await expectNoProtocolLeak(...pages)
      await ciro!.getByRole('button', { name: MANAGE.close }).click()
    })

    await test.step('3. enzo, a guest, creates his own channel: his row reads "Convidado" and he manages it', async () => {
      await createChannel(enzo!, { name: OWN, kind: 'public' })
      await openManage(enzo!, OWN)
      await expect(rowOf(enzo!, ENZO_NAME)).toContainText(MANAGE.guest, { timeout: 30_000 })
      await expect(rowOf(enzo!, ENZO_NAME)).toContainText(MANAGE.you)
      expect((await channelFacts(OWN)).powerLevels['enzo']).toBe(100)
      await expect(enzo!.getByRole('button', { name: MANAGE.addMember })).toBeVisible()
      await saveChannel(enzo!, { name: OWN_RENAMED })
      await expect(channelRow(enzo!, OWN_RENAMED)).toBeVisible({ timeout: 30_000 })
      await expectNoProtocolLeak(enzo!)
    })

    await test.step('4. enzo archives his channel: the confirm, the panel closes and the channel leaves his list', async () => {
      await enzo!.getByRole('button', { name: MANAGE.archive }).click()
      const dialog = enzo!.getByRole('dialog')
      await dialog.getByRole('button', { name: MANAGE.confirmArchive, exact: true }).click()
      await expect(dialog).toHaveCount(0, { timeout: 30_000 })
      await expect(channelRow(enzo!, OWN_RENAMED)).toHaveCount(0, { timeout: 30_000 })
      await expectNoProtocolLeak(enzo!)
    })

    for (const ledger of ledgers) ledger.expectClean()
  } finally {
    for (const ctx of contexts) await ctx.close()
  }
})
