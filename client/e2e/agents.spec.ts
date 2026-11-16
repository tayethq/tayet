import { test, expect, type Locator, type Page } from '@playwright/test'
import { RAE, SAM } from './fixtures/users'
import { accountSettings } from './support/account'
import { expectNoProtocolLeak } from './support/assertions'
import { AGENT_PROFILE_403, ConsoleLedger, FIRST_LOGIN_404, recognizedSet404 } from './support/console'
import { ACCOUNT, AGENTS, LIST, MANAGE, NEW_CONVERSATION, PEOPLE, PROFILE } from './support/labels'
import { signIn } from './support/login'
import { addMember, createChannel, deleteSharedRooms, openManage } from './support/rooms'
import { agentCredentialWorks } from './support/server-facts'
import { channelRow, conversations, orgChannel } from './support/workspace'

// ADR-086 (Proposto), fatia 3, ponta a ponta: rae, admin da org, cria o agente pela UI escolhendo uma
// cor, vê a credencial uma vez, a linha aparece em Pessoas com o avatar de agente na cor escolhida;
// Editar troca nome e cor; Reemitir mostra credencial nova (a anterior para de funcionar); Remover tira
// da lista. sam, a pessoa do par, vê o agente marcado onde ele aparece para ela (o seletor do novo DM),
// depois que o agente entra no canal do par com a credencial mostrada — o que o processo do agente
// faria. O agente não envia mensagem aqui (vem com o sidecar). O agente nasce pelo escrow, não pelo
// Dex: não consome par.
// O nome de exibição do par é o username do Dex (`rae`, `sam`): o template do MAS é `user.name`.

const suffix = Math.random().toString(36).slice(2, 8)
const NAME = `Relatórios ${suffix}`
const RENAMED = `Resumos ${suffix}`

const peoplePanel = (page: Page): Locator => page.getByRole('dialog', { name: PEOPLE.title })
const agentRow = (page: Page, name: string): Locator =>
  peoplePanel(page).getByRole('listitem').filter({ hasText: name })

// The credential is shown once, inside the dialog: read it from there, as the admin would copy it. It
// sits inside the whole command (§11.5), whose --server is the page's own origin, and appears exactly
// once in the dialog; "Copiar só a credencial" is beside it.
async function readCredential(dialog: Locator): Promise<string> {
  await expect(dialog.getByText(AGENTS.credentialOnce)).toBeVisible()
  await expect(dialog.getByRole('button', { name: AGENTS.copyCredentialOnly })).toBeVisible()
  const token = (await dialog.locator('[data-agent-credential]').textContent())?.trim() ?? ''
  expect(token.length).toBeGreaterThan(20)
  const origin = new URL(dialog.page().url()).origin
  const command = (await dialog.locator('[data-agent-command]').textContent())?.trim() ?? ''
  expect(command).toBe(`npx tayet-agent --server ${origin} --token ${token}`)
  expect((await dialog.textContent())?.split(token).length).toBe(2)
  return token
}

// Once the dialog is closed the credential is gone from the screen (nothing keeps it).
async function expectCredentialGone(page: Page, token: string): Promise<void> {
  await expect(page.locator('[data-agent-credential]')).toHaveCount(0)
  expect(await page.locator('body').textContent()).not.toContain(token)
}

// A revoked credential stops answering within a short window, not on the very next request: the
// homeserver may still hold the token's introspection for a moment (registered on issue #7 before
// this poll was written). The window is logged for the record; the cap is the assertion.
async function expectRevoked(token: string): Promise<void> {
  const start = Date.now()
  await expect.poll(() => agentCredentialWorks(token), { timeout: 30_000, intervals: [250] }).toBe(false)
  console.log(`[e2e] credential revoked after ${Date.now() - start} ms`)
}

test('agents: create with a colour, credential once, edit, reissue, remove; the pair sees the mark', async ({ browser }) => {
  test.setTimeout(300_000)
  const channel = `agentes-${suffix}`
  await deleteSharedRooms('rae', 'sam')

  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  const consoleA = new ConsoleLedger('rae', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  const consoleB = new ConsoleLedger('sam', [...FIRST_LOGIN_404, ...recognizedSet404(1), ...AGENT_PROFILE_403])
  try {
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()
    consoleA.watch(pageA, 'A')
    consoleB.watch(pageB, 'B')

    await test.step('1. the pair enters; rae creates a public channel and adds sam', async () => {
      await signIn(pageB, SAM)
      await expect(orgChannel(pageB)).toBeVisible({ timeout: 60_000 })
      await signIn(pageA, RAE)
      await expect(orgChannel(pageA)).toBeVisible({ timeout: 60_000 })
      await createChannel(pageA, { name: channel, kind: 'public' })
      await openManage(pageA, channel)
      await addMember(pageA, 'sam')
      await pageA.getByRole('button', { name: MANAGE.close }).click()
      await expect(channelRow(pageB, channel)).toBeVisible({ timeout: 60_000 })
    })

    const openPeople = async (): Promise<void> => {
      const account = await accountSettings(pageA)
      await expect(account.getByText(PEOPLE.section)).toBeVisible({ timeout: 30_000 })
      await account.getByRole('button', { name: new RegExp(`^${PEOPLE.title}`) }).click()
      await expect(peoplePanel(pageA)).toBeVisible()
    }

    let first = ''
    await test.step('2. rae creates the agent choosing Malva; the credential shows once', async () => {
      await openPeople()
      await peoplePanel(pageA).getByRole('button', { name: AGENTS.add }).click()
      const dialog = pageA.getByRole('dialog', { name: AGENTS.createTitle })
      await expect(dialog.locator('.agent-dialog__body')).toHaveClass(/(^|\s)compose-dialog__fields(\s|$)/)
      await dialog.getByLabel(AGENTS.fieldName).fill(NAME)
      const colours = dialog.getByRole('radiogroup', { name: AGENTS.fieldColor })
      await expect(colours.getByRole('radio')).toHaveCount(10)
      await colours.getByRole('radio', { name: AGENTS.colors.malva }).click()
      await expect(colours.getByRole('radio', { name: AGENTS.colors.malva })).toHaveAttribute('aria-checked', 'true')
      await dialog.getByRole('button', { name: AGENTS.create }).click()
      const created = pageA.getByRole('dialog', { name: AGENTS.createdTitle })
      await expect(created).toBeVisible({ timeout: 60_000 })
      // The credential step's body gets the dialog body padding, like the form states (§8.N).
      await expect(created.locator('.agent-dialog__body')).toHaveClass(/(^|\s)compose-dialog__fields(\s|$)/)
      first = await readCredential(created)
      expect(await agentCredentialWorks(first)).toBe(true)
      await created.getByRole('button', { name: AGENTS.done }).click()
      await expectCredentialGone(pageA, first)
    })

    await test.step('3. the line: agent avatar in malva, "operado por", no email', async () => {
      const row = agentRow(pageA, NAME)
      await expect(row).toHaveCount(1, { timeout: 60_000 })
      const avatar = row.locator('[data-agent-avatar]')
      await expect(avatar).toHaveAttribute('data-agent-color', 'malva')
      await expect(avatar).toHaveAttribute('role', 'img')
      await expect(avatar).toHaveAttribute('aria-label', AGENTS.mark)
      await expect(avatar.locator('[data-agent-mark]')).toHaveCount(1)
      await expect(row).toContainText(AGENTS.operatedBy('rae'))
      await expect(row).not.toContainText('@')
    })

    await test.step('4. Editar changes the name and the colour', async () => {
      await agentRow(pageA, NAME).getByRole('button', { name: AGENTS.edit(NAME) }).click()
      const dialog = pageA.getByRole('dialog', { name: AGENTS.editTitle })
      await dialog.getByLabel(AGENTS.fieldName).fill(RENAMED)
      await dialog.getByRole('radio', { name: AGENTS.colors.ardosia }).click()
      await dialog.getByRole('button', { name: AGENTS.save }).click()
      await expect(dialog).toHaveCount(0, { timeout: 60_000 })
      const row = agentRow(pageA, RENAMED)
      await expect(row).toHaveCount(1, { timeout: 60_000 })
      await expect(row.locator('[data-agent-avatar]')).toHaveAttribute('data-agent-color', 'ardosia')
      await expect(agentRow(pageA, NAME)).toHaveCount(0)
    })

    let second = ''
    await test.step('5. Reemitir shows a new credential; the previous one stops working', async () => {
      await agentRow(pageA, RENAMED).getByRole('button', { name: AGENTS.edit(RENAMED) }).click()
      await pageA.getByRole('dialog', { name: AGENTS.editTitle }).getByRole('button', { name: AGENTS.reissueCredential }).click()
      await pageA.getByRole('alertdialog').getByRole('button', { name: AGENTS.reissue, exact: true }).click()
      const reissued = pageA.getByRole('dialog', { name: AGENTS.reissuedTitle })
      await expect(reissued).toBeVisible({ timeout: 60_000 })
      second = await readCredential(reissued)
      expect(second).not.toBe(first)
      await expectRevoked(first)
      expect(await agentCredentialWorks(second)).toBe(true)
      await reissued.getByRole('button', { name: AGENTS.done }).click()
      await expectCredentialGone(pageA, second)
    })

    await test.step('6. rae adds the agent through the UI; only rae, its operator, is offered it', async () => {
      // Leave the People panel and "Sua conta" (Escape steps back through the drill-in until none is open).
      await expect(async () => {
        if ((await pageA.getByRole('dialog').count()) > 0) await pageA.keyboard.press('Escape')
        await expect(pageA.getByRole('dialog')).toHaveCount(0, { timeout: 1_000 })
      }).toPass({ timeout: 15_000 })
      // ADR-090: rae operates the agent, so it is among her candidates, marked; added the way sam was
      // in step 1. The agent stays `invite` (no process here), which the roster lists.
      await openManage(pageA, channel)
      const add = pageA.getByRole('dialog', { name: MANAGE.addMember })
      const candidate = add.getByRole('button', { name: new RegExp(RENAMED) })
      await pageA.getByRole('button', { name: MANAGE.addMember }).click()
      await expect(candidate).toBeVisible({ timeout: 30_000 })
      await expect(candidate.locator('[data-agent-avatar]')).toHaveCount(1)
      await candidate.click()
      await expect(pageA.getByRole('region', { name: MANAGE.members })).toContainText(RENAMED, { timeout: 30_000 })
      await pageA.getByRole('button', { name: MANAGE.close }).click()

      const pickerOf = (page: Page) => page.getByRole('dialog', { name: NEW_CONVERSATION.dialog })
      const reopenPicker = async (page: Page, until: Locator): Promise<void> => {
        await expect(async () => {
          if ((await pickerOf(page).count()) > 0) await pickerOf(page).getByRole('button', { name: NEW_CONVERSATION.cancel }).click()
          await conversations(page).getByRole('button', { name: LIST.newDm }).click()
          await expect(until).toBeVisible({ timeout: 5_000 })
        }).toPass({ timeout: 60_000 })
      }

      // sam is not the operator: the agent is a member of the channel they share, yet it is not
      // offered. The absence is asserted only once rae is seen in the list (no empty negative).
      await expect(channelRow(pageB, channel)).toBeVisible()
      await openManage(pageB, channel)
      await expect(pageB.getByRole('region', { name: MANAGE.members })).toContainText(RENAMED, { timeout: 60_000 })
      // …and the agent's profile, opened by sam from the roster, has no DM button.
      await pageB.getByRole('button', { name: PROFILE.open(RENAMED) }).click()
      const profile = pageB.getByRole('dialog', { name: PROFILE.dialog })
      await expect(profile).toContainText(RENAMED, { timeout: 30_000 })
      await expect(profile.getByRole('button', { name: PROFILE.sendMessage })).toHaveCount(0)
      await profile.getByRole('button', { name: ACCOUNT.close, exact: true }).click()
      await expect(profile).toHaveCount(0)
      await pageB.getByRole('button', { name: MANAGE.close }).click()
      await expect(pageB.getByRole('dialog')).toHaveCount(0)
      await reopenPicker(pageB, pickerOf(pageB).getByRole('button', { name: /^rae/ }))
      await expect(pickerOf(pageB).getByRole('button', { name: new RegExp(RENAMED) })).toHaveCount(0)
      await pickerOf(pageB).getByRole('button', { name: NEW_CONVERSATION.cancel }).click()

      // rae, the operator: her new-DM picker shows the agent with the mark.
      const option = pickerOf(pageA).getByRole('button', { name: new RegExp(RENAMED) })
      await reopenPicker(pageA, option)
      const avatar = option.locator('[data-agent-avatar]')
      await expect(avatar).toHaveAttribute('aria-label', AGENTS.mark)
      await expect(avatar).toHaveAttribute('data-agent-color', 'ardosia')
      await expect(avatar.locator('[data-agent-mark]')).toHaveCount(1)
      // The person sam, beside it, carries no agent avatar.
      await expect(pickerOf(pageA).getByRole('button', { name: /^sam/ }).locator('[data-agent-avatar]')).toHaveCount(0)
      await pickerOf(pageA).getByRole('button', { name: NEW_CONVERSATION.cancel }).click()
    })

    await test.step('7. P1: no protocol id on either screen', async () => {
      await expectNoProtocolLeak(pageA, pageB)
    })

    await test.step('8. Remover takes the agent out of the list; its credential stops working', async () => {
      await openPeople()
      // ADR-086; account-access.md §11: the agent rae added in step 6 is still `invite` (no process joins it
      // here), and its line still reads "operado por" and "Remover" — an agent's line is never pending.
      const row = agentRow(pageA, RENAMED)
      await expect(row).toContainText(AGENTS.operatedBy('rae'), { timeout: 30_000 })
      await expect(row).not.toContainText(PEOPLE.pending)
      await agentRow(pageA, RENAMED).getByRole('button', { name: AGENTS.remove(RENAMED) }).click()
      await pageA.getByRole('alertdialog').getByRole('button', { name: AGENTS.removeConfirm, exact: true }).click()
      await expect(agentRow(pageA, RENAMED)).toHaveCount(0, { timeout: 60_000 })
      await expectRevoked(second)
    })

    consoleA.expectClean()
    consoleB.expectClean()
  } finally {
    await ctxA.close()
    await ctxB.close()
  }
})
