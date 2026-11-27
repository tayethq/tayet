import { test, expect, type Locator, type Page } from '@playwright/test'
import { TAI, UGO } from './fixtures/users'
import { expectNoProtocolLeak } from './support/assertions'
import { ConsoleLedger, FIRST_LOGIN_404, recognizedSet404 } from './support/console'
import { AGENTS, APPROVAL, MANAGE, TIMELINE } from './support/labels'
import { closeAdmin, openAdmin } from './support/admin'
import { signIn } from './support/login'
import { addMember, closePicker, createChannel, deleteSharedRooms, openManage } from './support/rooms'
import { agentEditsIn } from './support/server-facts'
import { startSidecar, type SidecarRun } from './support/sidecar'
import { channelRow, messages, row } from './support/workspace'

// A3-3b (ADR-091, Proposto; PLANO-AGENTES §0.3.16 items 3, 6, 7, 12): the approval card end to end, from
// the real sidecar to two browsers. tai creates the agent and adds it to the pair's private channel (as
// agent-sidecar.spec.ts); the agent asks through the native API (`POST …/approvals`); tai and ugo see the
// pending card with the agent mark; ugo answers with one click — her card passes through "Enviando…" and
// lands on "Você às {hora}" with the option; tai sees "ugo às {hora}" with the option, and neither timeline
// gains a row; the sidecar delivers `approval.answered` on its SSE with the option and the person; the GET
// answers `answered` and the card is sealed on the server (an edit of the agent, read by the relation type
// in the clear). A second card: the agent closes it with no answer and both see "Pedido encerrado".
//
// The channel is PRIVATE (encrypted, ADR-045): the card, the answer and the seal travel encrypted.
// Secrets: the credential is in the DOM while the dialog is open → no trace, video or screenshot.
test.use({ trace: 'off', video: 'off', screenshot: 'off' })

const suffix = Math.random().toString(36).slice(2, 8)
const NAME = `Aprovador ${suffix}`
const CHANNEL = `aprovacao-${suffix}`
const OPTIONS = [
  { id: 'approve', label: 'Aprovar', style: 'primary' },
  { id: 'reject', label: 'Rejeitar', style: 'danger' },
]
// ADR-077 ceilings (the tier's): what one client writes reaches another within 60 s.
const SEEN_MS = 60_000

const card = (page: Page, text: string): Locator => row(page, text).getByRole('group', { name: APPROVAL.title })

// The time as the card shows it (HH:MM, 24 h, the catalog's locale; same machine, same zone).
const hhmm = (at: number): string => new Date(at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', hour12: false })

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

// Records, from before the click, every text the card's row shows (a MutationObserver in the page): the
// transient "Enviando…" may last less than one poll of an expect.
async function recordRow(page: Page, text: string): Promise<() => Promise<string[]>> {
  await page.evaluate(
    ({ text, log }) => {
      const w = window as unknown as { __rowTexts?: string[] }
      w.__rowTexts = []
      const root = document.querySelector(`[role="log"][aria-label="${log}"]`)!
      const look = (): void => {
        for (const a of root.querySelectorAll('article')) {
          const t = a.textContent ?? ''
          if (t.includes(text) && w.__rowTexts!.at(-1) !== t) w.__rowTexts!.push(t)
        }
      }
      look()
      new MutationObserver(look).observe(root, { subtree: true, childList: true, characterData: true, attributes: true })
    },
    { text, log: TIMELINE.log },
  )
  return () => page.evaluate(() => (window as unknown as { __rowTexts?: string[] }).__rowTexts ?? [])
}

test('agent approval card: ask, answer, seal, close — the sidecar and two browsers', async ({ browser }, testInfo) => {
  test.setTimeout(420_000)
  await deleteSharedRooms('tai', 'ugo')
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  const consoleA = new ConsoleLedger('tai', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  const consoleB = new ConsoleLedger('ugo', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  const runs: SidecarRun[] = []
  let stream: ReturnType<SidecarRun['events']> | undefined
  const ask1 = `Publicar a versão ${suffix}?`
  const ask2 = `Rodar a migração ${suffix}?`
  let failed = true
  try {
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()
    consoleA.watch(pageA, 'A')
    consoleB.watch(pageB, 'B')

    await test.step('0a. the pair enters; tai creates a private channel and adds ugo', async () => {
      await signIn(pageB, UGO)
      await signIn(pageA, TAI)
      await createChannel(pageA, { name: CHANNEL, kind: 'private' })
      await openManage(pageA, CHANNEL, 'private')
      await addMember(pageA, 'ugo')
      await pageA.getByRole('button', { name: MANAGE.close }).click()
      await expect(channelRow(pageB, CHANNEL)).toBeVisible({ timeout: SEEN_MS })
    })

    let run!: SidecarRun
    await test.step('0b. tai creates the agent; the command shown starts the sidecar', async () => {
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
    })

    let conv = ''
    let ugoId = ''
    await test.step('0c. tai adds the agent through the UI; it enters', async () => {
      await expect(async () => {
        if ((await pageA.getByRole('dialog').count()) > 0) await pageA.keyboard.press('Escape')
        await expect(pageA.getByRole('dialog')).toHaveCount(0, { timeout: 1_000 })
      }).toPass({ timeout: 15_000 })
      // Back from the Admin to the conversations.
      await closeAdmin(pageA)
      await openManage(pageA, CHANNEL, 'private')
      const candidate = pageA.getByRole('dialog', { name: MANAGE.addMember }).getByRole('button', { name: new RegExp(NAME) })
      await pageA.getByRole('button', { name: MANAGE.addMember }).click()
      await expect(candidate).toBeVisible({ timeout: 30_000 })
      await candidate.click()
      await closePicker(pageA, candidate)
      const member = pageA.getByRole('region', { name: MANAGE.members }).getByRole('listitem').filter({ hasText: NAME })
      await expect(member).toBeVisible({ timeout: 30_000 })
      await expect(member.getByText(MANAGE.awaiting)).toHaveCount(0, { timeout: SEEN_MS })
      await run.waitFor((l) => l.evt === 'joined', SEEN_MS)
      await pageA.getByRole('button', { name: MANAGE.close }).click()
      conv = await poll(async () => {
        const r = await run.call('GET', '/v1/conversations')
        return (r.json.conversations as Array<{ id: string; name?: string }> | undefined)?.find((c) => c.name === CHANNEL)?.id
      }, 'the channel in the agent conversations')
      ugoId = await poll(async () => {
        const r = await run.call('GET', `/v1/conversations/${conv}/members`)
        return (r.json.people as Array<{ id: string; name?: string }> | undefined)?.find((p) => p.name === 'ugo')?.id
      }, 'ugo among the members')
      expect(ugoId).toMatch(/^U/)
      stream = run.events()
      await channelRow(pageA, CHANNEL).click()
      await channelRow(pageB, CHANNEL).click()
    })

    let ts1 = ''
    let askedAt = 0
    await test.step('1. the agent asks for approval through the native API', async () => {
      askedAt = Date.now()
      const m = await ok(run, 'POST', `/v1/conversations/${conv}/approvals`, { text: ask1, options: OPTIONS })
      expect(m).toMatchObject({ conversation: conv, text: ask1, approval: { options: OPTIONS, state: 'open' } })
      ts1 = m.id as string
    })

    await test.step('2. both see the pending card with the agent mark', async () => {
      for (const page of [pageA, pageB]) {
        await expect(card(page, ask1).getByRole('button', { name: 'Aprovar' })).toBeVisible({ timeout: SEEN_MS })
        await expect(card(page, ask1).getByRole('button', { name: 'Rejeitar' })).toBeVisible()
        await expectAgentMark(row(page, ask1))
      }
      console.log(`[e2e] card pending on both ${Date.now() - askedAt} ms after the POST`)
    })

    let rowsA = 0
    let rowsB = 0
    let mine = ''
    let clickedAt = 0
    await test.step('3. ugo answers: her card passes through sending and lands on "Você às {hora}" with the option', async () => {
      rowsA = await messages(pageA).locator('article').count()
      rowsB = await messages(pageB).locator('article').count()
      const texts = await recordRow(pageB, ask1)
      clickedAt = Date.now()
      await card(pageB, ask1).getByRole('button', { name: 'Aprovar' }).click()
      const answeredLine = card(pageB, ask1).getByText(new RegExp(`^${APPROVAL.you} às \\d{2}:\\d{2}$`))
      await expect(answeredLine).toBeVisible({ timeout: SEEN_MS })
      console.log(`[e2e] ugo's card answered ${Date.now() - clickedAt} ms after the click`)
      await expect(card(pageB, ask1).getByText('Aprovar', { exact: true })).toBeVisible()
      await expect(card(pageB, ask1).getByRole('button')).toHaveCount(0)
      mine = (await answeredLine.textContent()) ?? ''
      const seen = await texts()
      const sendingAt = seen.findIndex((t) => t.includes(TIMELINE.sending))
      const answeredAt = seen.findIndex((t) => t.includes(mine))
      expect(sendingAt, `row texts: ${JSON.stringify(seen.map((t) => t.replace(ask1, '…')))}`).toBeGreaterThanOrEqual(0)
      expect(answeredAt).toBeGreaterThan(sendingAt)
    })

    await test.step('4. tai sees "ugo às {hora}" with the option; no new row on either timeline', async () => {
      const line = card(pageA, ask1).getByText(new RegExp(`^ugo às \\d{2}:\\d{2}$`))
      await expect(line).toBeVisible({ timeout: SEEN_MS })
      console.log(`[e2e] tai sees the answer ${Date.now() - clickedAt} ms after the click`)
      await expect(card(pageA, ask1).getByText('Aprovar', { exact: true })).toBeVisible()
      await expect(card(pageA, ask1).getByRole('button')).toHaveCount(0)
      expect((await line.textContent())?.replace('ugo', APPROVAL.you)).toBe(mine)
      await expect(messages(pageA).locator('article')).toHaveCount(rowsA)
      await expect(messages(pageB).locator('article')).toHaveCount(rowsB)
    })

    let at = 0
    await test.step('5. the sidecar delivers approval.answered on the SSE, with the option and the person', async () => {
      const frame = await poll(async () => stream!.frames.find((f) => f.event === 'approval.answered' && f.data.id === ts1), 'approval.answered on the stream')
      expect(frame.data).toEqual({ type: 'approval.answered', conversation: conv, id: ts1, option: 'approve', by: ugoId, at: expect.any(Number) as unknown as number })
      at = frame.data.at as number
      expect(mine).toBe(APPROVAL.answered(APPROVAL.you, hhmm(at)))
      console.log(`[e2e] approval.answered on the SSE ${Date.now() - clickedAt} ms after the click`)
    })

    await test.step('6. the GET answers `answered` and the card is sealed on the server', async () => {
      const state = await ok(run, 'GET', `/v1/conversations/${conv}/approvals/${ts1}`)
      expect(state).toEqual({ conversation: conv, id: ts1, approval: { options: OPTIONS, state: 'answered', answer: { option: 'approve', by: ugoId, at } } })
      await expect.poll(() => agentEditsIn(CHANNEL), { message: 'the seal on the server', timeout: SEEN_MS, intervals: [1_000] }).toEqual({ edits: 1, targets: 1 })
      console.log(`[e2e] sealed on the server ${Date.now() - clickedAt} ms after the click`)
      // The seal is an edit: still no row, still the answer (never "Pedido encerrado").
      for (const page of [pageA, pageB]) await expect(card(page, ask1).getByText(APPROVAL.closed)).toHaveCount(0)
      await expect(messages(pageA).locator('article')).toHaveCount(rowsA)
      await expect(messages(pageB).locator('article')).toHaveCount(rowsB)
      expect(stream!.frames.filter((f) => f.event === 'approval.answered')).toHaveLength(1)
      await expectNoProtocolLeak(pageA, pageB)
    })

    await test.step('7. a second card: the agent closes it with no answer; both see "Pedido encerrado"', async () => {
      const m = await ok(run, 'POST', `/v1/conversations/${conv}/approvals`, { text: ask2, options: OPTIONS })
      const ts2 = m.id as string
      for (const page of [pageA, pageB]) await expect(card(page, ask2).getByRole('button', { name: 'Aprovar' })).toBeVisible({ timeout: SEEN_MS })
      const closedAt = Date.now()
      const closed = await ok(run, 'POST', `/v1/conversations/${conv}/approvals/${ts2}/close`, {})
      expect(closed).toMatchObject({ id: ts2, approval: { options: OPTIONS, state: 'closed' } })
      for (const page of [pageA, pageB]) {
        await expect(card(page, ask2).getByText(APPROVAL.closed)).toBeVisible({ timeout: SEEN_MS })
        await expect(card(page, ask2).getByRole('button')).toHaveCount(0)
      }
      console.log(`[e2e] "Pedido encerrado" on both ${Date.now() - closedAt} ms after the close`)
      expect(await ok(run, 'GET', `/v1/conversations/${conv}/approvals/${ts2}`)).toEqual({ conversation: conv, id: ts2, approval: { options: OPTIONS, state: 'closed' } })
      await expect.poll(() => agentEditsIn(CHANNEL), { message: 'the close on the server', timeout: SEEN_MS, intervals: [1_000] }).toEqual({ edits: 2, targets: 2 })
      expect(stream!.frames.filter((f) => f.event === 'approval.answered')).toHaveLength(1)
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
    stream?.close()
    for (const r of runs) await r.stop()
    await ctxA.close()
    await ctxB.close()
  }
})
