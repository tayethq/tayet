import { test, expect, type Locator, type Page } from '@playwright/test'
import { TAI } from './fixtures/users'
import { accountSettings } from './support/account'
import { expectNoProtocolLeak } from './support/assertions'
import { ConsoleLedger, FIRST_LOGIN_404, recognizedSet404 } from './support/console'
import { AGENTS, COMMANDS, MANAGE, PEOPLE, TIMELINE } from './support/labels'
import { signIn } from './support/login'
import { createChannel, deleteChannelsNamed, deleteSharedRooms, openManage } from './support/rooms'
import { startSidecar, type SidecarRun } from './support/sidecar'
import { channelRow, mainComposer, messages } from './support/workspace'

// A4-4 (ADR-093, Proposto; PLANO-AGENTES §0.3.24; workspace.md §21): `/` commands end to end, from the real
// sidecar to the browser and back. tai creates the agent and adds it to a private channel (as
// agent-panel.spec.ts); the agent declares two commands (`PUT /v1/commands`); tai types `/` and sees the
// popup, filters, picks with Enter, sees the chip and the hint, types the argument and sends; the timeline
// shows the chip and "comando para {agente}"; the agent reads the message with `command: { name, args }` and
// answers with a plain message; the command message offers no edit.
//
// The channel is PRIVATE (encrypted, ADR-045). Secrets: the credential is in the DOM while the dialog is
// open → no trace, video or screenshot.
test.use({ trace: 'off', video: 'off', screenshot: 'off' })

const suffix = Math.random().toString(36).slice(2, 8)
const NAME = `Comandante ${suffix}`
const PREFIX = 'comandos-'
const CHANNEL = `${PREFIX}${suffix}`
const HINT = 'semana ou data'
// ADR-077 ceilings (the tier's): what one client writes reaches another within 60 s. A manifest write goes out
// within 10 s of the declaration (the panel's budget, ADR-093 dec. 10).
const SEEN_MS = 60_000

const peoplePanel = (page: Page): Locator => page.getByRole('dialog', { name: PEOPLE.title })
const popup = (page: Page): Locator => page.getByRole('listbox', { name: COMMANDS.popup })

async function readCommand(dialog: Locator): Promise<{ command: string; credential: string }> {
  await expect(dialog.getByText(AGENTS.credentialOnce)).toBeVisible()
  const credential = (await dialog.locator('[data-agent-credential]').textContent())?.trim() ?? ''
  expect(credential.length).toBeGreaterThan(20)
  const command = (await dialog.locator('[data-agent-command]').textContent())?.trim() ?? ''
  return { command, credential }
}

async function poll<T>(get: () => Promise<T | undefined>, what: string, timeout = SEEN_MS): Promise<T> {
  let found: T | undefined
  await expect.poll(async () => (found = await get()) !== undefined, { message: what, timeout, intervals: [500] }).toBe(true)
  return found!
}

interface Listed {
  id: string
  name?: string
  text?: string
  command?: { name: string; args: string }
}

test('agent commands: declare, pick in the popup, send, the agent receives and answers', async ({ browser }, testInfo) => {
  test.setTimeout(420_000)
  await deleteSharedRooms('tai', 'ugo')
  // The channel holds tai and the agent, never ugo: deleteSharedRooms does not see it, so the spec deletes
  // its own — earlier runs' at the start, this run's at the end (the next spec's first login of tai).
  await deleteChannelsNamed(PREFIX)
  const ctx = await browser.newContext()
  const ledger = new ConsoleLedger('tai', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  const runs: SidecarRun[] = []
  const answer = `Fila da semana: 2 posts ${suffix}`
  let failed = true
  try {
    const page = await ctx.newPage()
    ledger.watch(page, 'A')

    await test.step('0a. tai enters and creates a private channel', async () => {
      await signIn(page, TAI)
      await createChannel(page, { name: CHANNEL, kind: 'private' })
    })

    let run!: SidecarRun
    await test.step('0b. tai creates the agent; the command shown starts the sidecar', async () => {
      const account = await accountSettings(page)
      await expect(account.getByText(PEOPLE.section)).toBeVisible({ timeout: 30_000 })
      await account.getByRole('button', { name: new RegExp(`^${PEOPLE.title}`) }).click()
      await expect(peoplePanel(page)).toBeVisible()
      await peoplePanel(page).getByRole('button', { name: AGENTS.add }).click()
      const dialog = page.getByRole('dialog', { name: AGENTS.createTitle })
      await dialog.getByLabel(AGENTS.fieldName).fill(NAME)
      await dialog.getByRole('button', { name: AGENTS.create }).click()
      const created = page.getByRole('dialog', { name: AGENTS.createdTitle })
      await expect(created).toBeVisible({ timeout: SEEN_MS })
      const { command, credential } = await readCommand(created)
      await created.getByRole('button', { name: AGENTS.done }).click()
      await expect(page.locator('[data-agent-credential]')).toHaveCount(0)
      run = await startSidecar(command, [credential])
      runs.push(run)
    })

    let conv = ''
    await test.step('0c. tai adds the agent through the UI; it enters', async () => {
      await expect(async () => {
        if ((await page.getByRole('dialog').count()) > 0) await page.keyboard.press('Escape')
        await expect(page.getByRole('dialog')).toHaveCount(0, { timeout: 1_000 })
      }).toPass({ timeout: 15_000 })
      await openManage(page, CHANNEL, 'private')
      const candidate = page.getByRole('dialog', { name: MANAGE.addMember }).getByRole('button', { name: new RegExp(NAME) })
      await page.getByRole('button', { name: MANAGE.addMember }).click()
      await expect(candidate).toBeVisible({ timeout: 30_000 })
      await candidate.click()
      const member = page.getByRole('region', { name: MANAGE.members }).getByRole('listitem').filter({ hasText: NAME })
      await expect(member).toBeVisible({ timeout: 30_000 })
      await expect(member.getByText(MANAGE.awaiting)).toHaveCount(0, { timeout: SEEN_MS })
      await run.waitFor((l) => l.evt === 'joined', SEEN_MS)
      await page.getByRole('button', { name: MANAGE.close }).click()
      conv = await poll(async () => {
        const r = await run.call('GET', '/v1/conversations')
        return (r.json.conversations as Listed[] | undefined)?.find((c) => c.name === CHANNEL)?.id
      }, 'the channel in the agent conversations')
      await channelRow(page, CHANNEL).click()
    })

    await test.step('1. the agent declares two commands; the manifest is written', async () => {
      const r = await run.call('PUT', '/v1/commands', {
        commands: [
          { name: 'resumo', description: 'O que mudou desde ontem' },
          { name: 'status', description: 'Entregas da semana', hint: HINT },
        ],
      })
      expect(r.status, JSON.stringify(r.json)).toBe(202)
      await expect.poll(async () => (await run.call('GET', '/v1/commands')).json.pending, { timeout: SEEN_MS }).toBe(0)
    })

    await test.step('2. "/" opens the popup with both; filtering keeps one; Enter picks it: chip and hint', async () => {
      const composer = mainComposer(page)
      // The manifest reaches the client through commands.changed: retype until the popup shows both.
      await expect(async () => {
        await composer.click()
        await page.keyboard.press('ControlOrMeta+a')
        await page.keyboard.press('Backspace')
        await page.keyboard.type('/')
        await expect(popup(page).getByRole('option')).toHaveCount(2, { timeout: 2_000 })
      }).toPass({ timeout: SEEN_MS })
      await expect(popup(page).getByRole('option').first()).toHaveAttribute('aria-selected', 'true')
      await page.keyboard.type('st')
      await expect(popup(page).getByRole('option')).toHaveCount(1)
      await expect(popup(page).getByRole('option')).toContainText('/status')
      await expect(popup(page).getByRole('option')).toContainText(NAME)
      await page.keyboard.press('Enter')
      await expect(popup(page)).toHaveCount(0)
      await expect(composer.locator('.mention--command')).toHaveText('/status')
      await expect(composer.locator('p')).toHaveAttribute('data-command-hint', COMMANDS.placeholderHintFor(HINT, NAME))
    })

    await test.step('3. tai types the argument and sends; the timeline shows the chip and the line', async () => {
      await page.keyboard.type('semana')
      await page.keyboard.press('Enter')
      const row = messages(page).locator('article').filter({ hasText: '/status semana' })
      await expect(row).toHaveCount(1, { timeout: SEEN_MS })
      await expect(row.locator('.message__command')).toHaveText('/status')
      await expect(row.getByText(COMMANDS.lineFor(NAME), { exact: true })).toBeVisible()
      // §0.3.24 item 7: no edit on a command message (delete stays).
      await expect(row.getByRole('button', { name: TIMELINE.edit })).toHaveCount(0)
      await expect(row.getByRole('button', { name: TIMELINE.delete })).toHaveCount(1)
    })

    await test.step('4. the agent reads command { name, args } and answers with a plain message', async () => {
      const received = await poll(async () => {
        const r = await run.call('GET', `/v1/conversations/${conv}/messages`)
        return (r.json.messages as Listed[] | undefined)?.find((m) => m.text === '/status semana')
      }, 'the command message in the agent listing')
      expect(received.command).toEqual({ name: 'status', args: 'semana' })
      const r = await run.call('POST', `/v1/conversations/${conv}/messages`, { text: answer })
      expect(r.status, JSON.stringify(r.json)).toBe(200)
      await expect(messages(page)).toContainText(answer, { timeout: SEEN_MS })
      await expectNoProtocolLeak(page)
    })

    console.log(`[e2e] console: ${JSON.stringify(ledger.observed())}`)
    ledger.expectClean()
    failed = false
  } finally {
    if (failed) {
      runs.forEach((r, i) => testInfo.attachments.push({ name: `sidecar-${i + 1}.log`, contentType: 'text/plain', body: Buffer.from(r.output()) }))
    }
    for (const r of runs) await r.stop()
    await ctx.close()
    await deleteChannelsNamed(CHANNEL)
  }
})
