import { test, expect, type Locator, type Page } from '@playwright/test'
import { TAI, UGO } from './fixtures/users'
import { accountSettings } from './support/account'
import { expectNoProtocolLeak } from './support/assertions'
import { AFTER_RELOGIN_404, backupLookupsCap, ConsoleLedger, FIRST_LOGIN_404, recognizedSet404 } from './support/console'
import { AGENTS, MANAGE, PANEL, PEOPLE } from './support/labels'
import { signIn } from './support/login'
import { addMember, createChannel, deleteSharedRooms, openManage } from './support/rooms'
import { startSidecar, type SidecarRun } from './support/sidecar'
import { channelRow, messages } from './support/workspace'

// A3-6 (ADR-091, Proposto, dec. 13; PLANO-AGENTES §0.3.16 items 15–17): the pinned panel end to end, from the
// real sidecar to two browsers. tai creates the agent and adds it to a private channel (as
// agent-approval.spec.ts); the agent writes its panel (`PUT …/panel`); tai sees it open, with the title, the
// body and "atualizado às"; a second PUT swaps the content with no new row on the timeline; ugo is added
// AFTER the writes and sees the panel (the sidecar's re-edit on a person's entry: she cannot decrypt what was
// written before she joined); `DELETE` and the panel is gone for both.
//
// The channel is PRIVATE (encrypted, ADR-045). Secrets: the credential is in the DOM while the dialog is
// open → no trace, video or screenshot.
test.use({ trace: 'off', video: 'off', screenshot: 'off' })

const suffix = Math.random().toString(36).slice(2, 8)
const NAME = `Painelista ${suffix}`
const CHANNEL = `painel-${suffix}`
const TITLE = 'Estado do deploy'
// ADR-077 ceilings (the tier's): what one client writes reaches another within 60 s. A panel write goes out
// within 10 s of the PUT (the budget), and the re-edit within 10 s of the entry, plus the budget.
const SEEN_MS = 60_000

// ugo joins after the agent's first writes: the panel's original and those edits are in a Megolm session she
// was never given (§0.3.16 item 16; P-A3-2), and her device asks the backup for it (404) — the same lookup
// pattern as AFTER_RELOGIN_404, capped by the ADR-077 formula for one unknown session. She reads the panel
// through the sidecar's re-edit, never through that session.
const LATE_JOINER_404 = {
  ...AFTER_RELOGIN_404[0]!,
  max: backupLookupsCap(1),
  why: 'panel writes from before the entry (§0.3.16 item 16, P-A3-2): one session never shared; ADR-077 cap',
}

const peoplePanel = (page: Page): Locator => page.getByRole('dialog', { name: PEOPLE.title })
const panel = (page: Page): Locator => page.getByRole('region', { name: PANEL.section(NAME) })

async function readCommand(dialog: Locator): Promise<{ command: string; credential: string }> {
  await expect(dialog.getByText(AGENTS.credentialOnce)).toBeVisible()
  const credential = (await dialog.locator('[data-agent-credential]').textContent())?.trim() ?? ''
  expect(credential.length).toBeGreaterThan(20)
  const command = (await dialog.locator('[data-agent-command]').textContent())?.trim() ?? ''
  return { command, credential }
}

async function accepted(run: SidecarRun, method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const r = await run.call(method, path, body)
  expect(r.status, `${method} ${path} -> ${JSON.stringify(r.json)}`).toBe(202)
  return r.json
}

async function poll<T>(get: () => Promise<T | undefined>, what: string, timeout = SEEN_MS): Promise<T> {
  let found: T | undefined
  await expect.poll(async () => (found = await get()) !== undefined, { message: what, timeout, intervals: [500] }).toBe(true)
  return found!
}

// The open panel: its body shows `text`, the row the title and "atualizado às HH:MM".
async function expectOpenPanel(page: Page, text: string): Promise<void> {
  const section = panel(page)
  await expect(section.getByText(text)).toBeVisible({ timeout: SEEN_MS })
  await expect(section.getByRole('button', { expanded: true })).toBeVisible()
  await expect(section.getByText(TITLE, { exact: true })).toBeVisible()
  await expect(section.getByText(new RegExp(`^${PANEL.updatedAt('\\d{2}:\\d{2}')}$`))).toBeVisible()
}

test('agent pinned panel: write, replace, re-edit on entry, clear — the sidecar and two browsers', async ({ browser }, testInfo) => {
  test.setTimeout(420_000)
  await deleteSharedRooms('tai', 'ugo')
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  const consoleA = new ConsoleLedger('tai', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  const consoleB = new ConsoleLedger('ugo', [...FIRST_LOGIN_404, ...recognizedSet404(1), LATE_JOINER_404])
  const runs: SidecarRun[] = []
  const v1 = `Build verde ${suffix}`
  const v2 = `Deploy em produção ${suffix}`
  let failed = true
  try {
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()
    consoleA.watch(pageA, 'A')
    consoleB.watch(pageB, 'B')

    await test.step('0a. the pair enters; tai creates a private channel (ugo not in it yet)', async () => {
      await signIn(pageB, UGO)
      await signIn(pageA, TAI)
      await createChannel(pageA, { name: CHANNEL, kind: 'private' })
    })

    let run!: SidecarRun
    await test.step('0b. tai creates the agent; the command shown starts the sidecar', async () => {
      const account = await accountSettings(pageA)
      await expect(account.getByText(PEOPLE.section)).toBeVisible({ timeout: 30_000 })
      await account.getByRole('button', { name: new RegExp(`^${PEOPLE.title}`) }).click()
      await expect(peoplePanel(pageA)).toBeVisible()
      await peoplePanel(pageA).getByRole('button', { name: AGENTS.add }).click()
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
    })

    let conv = ''
    await test.step('0c. tai adds the agent through the UI; it enters', async () => {
      await expect(async () => {
        if ((await pageA.getByRole('dialog').count()) > 0) await pageA.keyboard.press('Escape')
        await expect(pageA.getByRole('dialog')).toHaveCount(0, { timeout: 1_000 })
      }).toPass({ timeout: 15_000 })
      await openManage(pageA, CHANNEL, 'private')
      const candidate = pageA.getByRole('dialog', { name: MANAGE.addMember }).getByRole('button', { name: new RegExp(NAME) })
      await pageA.getByRole('button', { name: MANAGE.addMember }).click()
      await expect(candidate).toBeVisible({ timeout: 30_000 })
      await candidate.click()
      const member = pageA.getByRole('region', { name: MANAGE.members }).getByRole('listitem').filter({ hasText: NAME })
      await expect(member).toBeVisible({ timeout: 30_000 })
      await expect(member.getByText(MANAGE.awaiting)).toHaveCount(0, { timeout: SEEN_MS })
      await run.waitFor((l) => l.evt === 'joined', SEEN_MS)
      await pageA.getByRole('button', { name: MANAGE.close }).click()
      conv = await poll(async () => {
        const r = await run.call('GET', '/v1/conversations')
        return (r.json.conversations as Array<{ id: string; name?: string }> | undefined)?.find((c) => c.name === CHANNEL)?.id
      }, 'the channel in the agent conversations')
      await channelRow(pageA, CHANNEL).click()
    })

    const path = (): string => `/v1/conversations/${conv}/panel`
    await test.step('1. the agent writes its panel; tai sees it open with the title, the body and "atualizado às"', async () => {
      const at = Date.now()
      expect(await accepted(run, 'PUT', path(), { text: v1, title: TITLE })).toEqual({ conversation: conv, pending: true })
      await expectOpenPanel(pageA, v1)
      console.log(`[e2e] panel on tai ${Date.now() - at} ms after the PUT`)
    })

    await test.step('2. a second PUT swaps the content, with no new row on the timeline', async () => {
      const rows = await messages(pageA).locator('article').count()
      const at = Date.now()
      await accepted(run, 'PUT', path(), { text: v2, title: TITLE })
      await expectOpenPanel(pageA, v2)
      await expect(panel(pageA).getByText(v1)).toHaveCount(0)
      console.log(`[e2e] new content on tai ${Date.now() - at} ms after the PUT`)
      await expect(messages(pageA).locator('article')).toHaveCount(rows)
      await expect.poll(async () => (await run.call('GET', path())).json.pending, { timeout: SEEN_MS }).toBe(false)
    })

    await test.step('3. ugo is added after the writes and sees the panel (the re-edit on entry)', async () => {
      await openManage(pageA, CHANNEL, 'private')
      await addMember(pageA, 'ugo')
      await pageA.getByRole('button', { name: MANAGE.close }).click()
      const at = Date.now()
      await expect(channelRow(pageB, CHANNEL)).toBeVisible({ timeout: SEEN_MS })
      await channelRow(pageB, CHANNEL).click()
      await expectOpenPanel(pageB, v2)
      console.log(`[e2e] panel on ugo ${Date.now() - at} ms after the entry`)
      await expectNoProtocolLeak(pageA, pageB)
    })

    await test.step('4. DELETE: the panel is gone for both', async () => {
      const at = Date.now()
      await accepted(run, 'DELETE', path())
      for (const page of [pageA, pageB]) await expect(panel(page)).toHaveCount(0, { timeout: SEEN_MS })
      console.log(`[e2e] panel gone on both ${Date.now() - at} ms after the DELETE`)
      await expect.poll(async () => (await run.call('GET', path())).json, { timeout: SEEN_MS }).toEqual({ conversation: conv, panel: null, pending: false })
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
