import { test, expect, type Locator, type Page } from '@playwright/test'
import { TAI, UGO } from './fixtures/users'
import { expectNoProtocolLeak, expectReadable } from './support/assertions'
import { ConsoleLedger, FIRST_LOGIN_404, recognizedSet404 } from './support/console'
import { AGENTS, GROUP, LIST, MANAGE, NEW_CONVERSATION } from './support/labels'
import { closeAdmin, openAdmin } from './support/admin'
import { signIn } from './support/login'
import { deleteChannelsNamed, deleteGroupsOf, deleteSharedRooms, openManage, removeMember } from './support/rooms'
import { startSidecar, type SidecarRun } from './support/sidecar'
import { escapeRegExp } from '../test/support/stack-env'
import { channelRow, conversations, groupWith, row } from './support/workspace'

// ROTEIRO-U2 rev. 5 (PLANO-RELEASE-PUBLICA §8.123 D2): the operator's agent goes through the conversion of a
// group into a channel (ADR-094 dec. 7, 9 and 12). tai (A, admin of the org) creates the agent and the command
// shown starts the sidecar (as agent-panel.spec.ts); tai, its operator, opens "Nova conversa" in direct-message
// mode and picks ugo (B) and the agent — two chips, the agent's with the agent avatar: a group of three is born
// and the sidecar accepts the invite. The local API lists it as a group. The agent writes in it; both read,
// with the agent mark. ugo, who does not operate the agent, converts it into a channel with a name from
// "Detalhes da conversa". After the conversion both find the channel in "Canais" with the lock; the agent
// writes again under the SAME conversation id (dec. 12) and both read the new message and the old one; the
// local API lists the conversation as a private channel with that id; the channel's panel lists the agent,
// marked. tai removes the agent from the channel's panel (dec. 7: the way to take an agent out of a group):
// it leaves the member list on both screens. P1 on both screens; console clean.
//
// Hermetic: the pair's shared rooms, their groups and every channel named after this spec are deleted at the
// start and at the end. Secrets: the credential is in the DOM while the dialog is open → no trace, video or
// screenshot; a failure attaches the sidecar output (credential and local token redacted).
test.use({ trace: 'off', video: 'off', screenshot: 'off' })

const suffix = Math.random().toString(36).slice(2, 8)
// Upper case first: the group row lists the others ordered by name, and the agent comes before both people.
const NAME = `Grupista ${suffix}`
const PREFIX = 'agente-grupo-'
const CHANNEL = `${PREFIX}${suffix}`
const SEEN_MS = 60_000

interface Listed {
  id: string
  name?: string
  kind?: string
}

const roster = (page: Page): Locator => page.getByRole('region', { name: MANAGE.members })
const agentInRoster = (page: Page): Locator => roster(page).getByRole('listitem').filter({ hasText: NAME })

async function readCommand(dialog: Locator): Promise<{ command: string; credential: string }> {
  await expect(dialog.getByText(AGENTS.credentialOnce)).toBeVisible()
  const credential = (await dialog.locator('[data-agent-credential]').textContent())?.trim() ?? ''
  expect(credential.length).toBeGreaterThan(20)
  const command = (await dialog.locator('[data-agent-command]').textContent())?.trim() ?? ''
  return { command, credential }
}

async function expectAgentMark(r: Locator): Promise<void> {
  const avatar = r.locator('[data-agent-avatar]')
  await expect(avatar).toHaveCount(1)
  await expect(avatar).toHaveAttribute('aria-label', AGENTS.mark)
}

async function ok(run: SidecarRun, method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const r = await run.call(method, path, body)
  expect(r.status, `${method} ${path} -> ${JSON.stringify(r.json)}`).toBe(200)
  return r.json
}

async function poll<T>(get: () => Promise<T | undefined>, what: string, timeout = SEEN_MS): Promise<T> {
  let found: T | undefined
  await expect.poll(async () => (found = await get()) !== undefined, { message: what, timeout, intervals: [500] }).toBe(true)
  return found!
}

const listed = async (run: SidecarRun): Promise<Listed[]> =>
  ((await run.call('GET', '/v1/conversations')).json.conversations as Listed[] | undefined) ?? []

const hermetic = async (): Promise<void> => {
  await deleteSharedRooms('tai', 'ugo')
  await deleteGroupsOf('tai', 'ugo')
  await deleteChannelsNamed(PREFIX)
}
test.beforeAll(hermetic)
test.afterAll(hermetic)

test('agent across the conversion: born in a group with its operator, it stays with the same id in the channel and leaves by the panel', async ({
  browser,
}, testInfo) => {
  test.setTimeout(420_000)
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  const consoleA = new ConsoleLedger('tai', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  const consoleB = new ConsoleLedger('ugo', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  const runs: SidecarRun[] = []
  const t1 = `agente no grupo ${suffix}`
  const t2 = `agente no canal ${suffix}`
  let failed = true
  try {
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()
    consoleA.watch(pageA, 'A')
    consoleB.watch(pageB, 'B')

    let run!: SidecarRun
    await test.step('1. the pair enters; tai creates the agent and the command shown starts the sidecar', async () => {
      await signIn(pageB, UGO)
      await signIn(pageA, TAI)
      // Slice 1c: "Pessoas" lives in the Admin, opened from "Sua conta".
      await openAdmin(pageA)
      await pageA.getByRole('button', { name: AGENTS.add }).click()
      const dialog = pageA.getByRole('dialog', { name: AGENTS.createTitle })
      await dialog.getByLabel(AGENTS.fieldName).fill(NAME)
      await dialog.getByRole('button', { name: AGENTS.create }).click()
      const created = pageA.getByRole('dialog', { name: AGENTS.createdTitle })
      await expect(created).toBeVisible({ timeout: SEEN_MS })
      const { command, credential } = await readCommand(created)
      await created.getByRole('button', { name: AGENTS.done }).click()
      await expect(pageA.locator('[data-agent-credential]')).toHaveCount(0)
      run = await startSidecar(command, [credential])
      runs.push(run)
      // Close what is open (Escape steps back through the dialogs until none is open).
      await expect(async () => {
        if ((await pageA.getByRole('dialog').count()) > 0) await pageA.keyboard.press('Escape')
        await expect(pageA.getByRole('dialog')).toHaveCount(0, { timeout: 1_000 })
      }).toPass({ timeout: 15_000 })
      // Back from the Admin to the conversations.
      await closeAdmin(pageA)
    })

    let conv = ''
    await test.step('2. tai picks ugo and the agent in "Nova conversa" (two chips, the agent marked): a group of three; the sidecar joins', async () => {
      const dialog = pageA.getByRole('dialog', { name: NEW_CONVERSATION.dialog })
      const person = dialog.getByRole('button', { name: 'ugo', exact: true })
      // The row's accessible name opens with the agent mark ("Agente …"), so the name is not anchored.
      const agent = dialog.getByRole('button', { name: new RegExp(escapeRegExp(NAME)) })
      // The known set is read when the dialog opens; reopened until both are in it.
      await expect(async () => {
        if ((await dialog.count()) > 0) await dialog.getByRole('button', { name: NEW_CONVERSATION.cancel }).click()
        await conversations(pageA).getByRole('button', { name: LIST.newDm }).click()
        await expect(person).toBeVisible({ timeout: 5_000 })
        await expect(agent).toBeVisible({ timeout: 5_000 })
      }).toPass({ timeout: SEEN_MS })
      await expect(agent.locator('[data-agent-avatar]')).toHaveCount(1)
      await person.click()
      await agent.click()
      const chips = dialog.getByRole('button', { name: new RegExp(`^${escapeRegExp(NEW_CONVERSATION.remove(''))}`) })
      await expect(chips).toHaveCount(2)
      await expect(chips.nth(0)).toHaveAccessibleName(NEW_CONVERSATION.remove('ugo'))
      await expect(chips.nth(1)).toHaveAccessibleName(NEW_CONVERSATION.remove(NAME))
      // The chip is the remove button's parent: the agent's carries the agent avatar.
      await expect(chips.nth(1).locator('..').locator('[data-agent-avatar]')).toHaveCount(1)
      await expect(chips.nth(0).locator('..').locator('[data-agent-avatar]')).toHaveCount(0)
      await dialog.getByRole('button', { name: NEW_CONVERSATION.startConversation }).click()
      await expect(dialog).toHaveCount(0)

      const group = groupWith(pageA, [NAME, 'ugo'])
      await expect(group).toBeVisible({ timeout: SEEN_MS })
      await expect(group).toHaveAttribute('aria-current', 'true')
      await expect(group.getByRole('img', { name: GROUP.block(3) })).toBeVisible()
      await run.waitFor((l) => l.evt === 'joined', SEEN_MS)
      const found = await poll(async () => (await listed(run)).find((c) => c.kind === 'group'), 'the group in the agent conversations')
      console.log(`[e2e] agent conversations after the join: ${JSON.stringify((await listed(run)).map((c) => ({ kind: c.kind, name: c.name })))}`)
      conv = found.id
      await expectNoProtocolLeak(pageA)
    })

    await test.step('3. the agent writes in the group; tai and ugo read it, with the agent mark', async () => {
      await ok(run, 'POST', `/v1/conversations/${conv}/messages`, { text: t1 })
      await expectReadable(pageA, t1)
      await expectAgentMark(row(pageA, t1))
      const groupB = groupWith(pageB, [NAME, 'tai'])
      await expect(groupB).toBeVisible({ timeout: SEEN_MS })
      await groupB.click()
      await expectReadable(pageB, t1)
      await expectAgentMark(row(pageB, t1))
      await expectNoProtocolLeak(pageA, pageB)
    })

    await test.step('4. ugo, who does not operate the agent, converts the group into a channel with a name', async () => {
      await pageB.getByRole('button', { name: GROUP.details }).click()
      const details = pageB.getByRole('dialog', { name: GROUP.details })
      await details.getByRole('button', { name: GROUP.convert, exact: true }).click()
      const confirm = pageB.getByRole('dialog', { name: GROUP.convert })
      await confirm.getByLabel(GROUP.convertName).fill(CHANNEL)
      await confirm.getByRole('button', { name: GROUP.convert, exact: true }).click()
      await expect(pageB.getByRole('dialog')).toHaveCount(0, { timeout: 30_000 })
    })

    await test.step('5. after the conversion: the channel in "Canais" with the lock; the agent writes under the same id; listed as a private channel; in the panel, marked', async () => {
      for (const page of [pageA, pageB]) {
        const r = channelRow(page, CHANNEL)
        await expect(r).toBeVisible({ timeout: SEEN_MS })
        await expect(r.getByRole('img', { name: LIST.privateMark })).toBeVisible()
        await r.click()
      }
      await ok(run, 'POST', `/v1/conversations/${conv}/messages`, { text: t2 })
      // The grouped timeline puts the avatar on the first row of an author's run: t2 continues the agent's run
      // that t1 opened, so the mark is on t1's row.
      for (const page of [pageA, pageB]) {
        await expectReadable(page, t1, t2)
        await expectAgentMark(row(page, t1))
      }
      const after = await poll(
        async () => (await listed(run)).find((c) => c.id === conv && c.kind === 'private'),
        'the same conversation, listed as a private channel',
      )
      expect(after.name).toBe(CHANNEL)
      expect((await listed(run)).filter((c) => c.kind === 'group')).toEqual([])
      await openManage(pageA, CHANNEL, 'private')
      await expect(agentInRoster(pageA)).toBeVisible({ timeout: 30_000 })
      await expectAgentMark(agentInRoster(pageA))
      await expectNoProtocolLeak(pageA, pageB)
    })

    await test.step('6. tai removes the agent from the channel panel: it leaves the member list on both screens', async () => {
      await removeMember(pageA, NAME)
      await expect(agentInRoster(pageA)).toHaveCount(0, { timeout: 30_000 })
      await expect(roster(pageA)).toContainText('ugo')
      await pageA.getByRole('button', { name: MANAGE.close }).click()
      await openManage(pageB, CHANNEL, 'private')
      await expect(roster(pageB)).toContainText('tai', { timeout: 30_000 })
      await expect(agentInRoster(pageB)).toHaveCount(0, { timeout: 30_000 })
      await pageB.getByRole('button', { name: MANAGE.close }).click()
    })

    await test.step('7. P1 on both screens', async () => {
      await expectNoProtocolLeak(pageA, pageB)
    })

    console.log(`[e2e] console A: ${JSON.stringify(consoleA.observed())}`)
    console.log(`[e2e] console B: ${JSON.stringify(consoleB.observed())}`)
    consoleA.expectClean()
    consoleB.expectClean()
    failed = false
  } finally {
    if (failed) {
      runs.forEach((r, i) => testInfo.attachments.push({ name: `sidecar-${i + 1}.log`, contentType: 'text/plain', body: Buffer.from(r.output()) }))
    }
    for (const r of runs) await r.stop()
    await ctxA.close()
    await ctxB.close()
  }
})
