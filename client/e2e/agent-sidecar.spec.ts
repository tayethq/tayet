import { test, expect, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { TAI, UGO } from './fixtures/users'
import { adminNav, openAdmin, personRow, rowAction } from './support/admin'
import { expectNoProtocolLeak, expectReadableWithin } from './support/assertions'
import { BACKUP_LOOKUPS_WHY, backupLookupsCap, AFTER_RELOGIN_404, ConsoleLedger, FIRST_LOGIN_404, recognizedSet404 } from './support/console'
import { ADMIN, AGENTS, LIST, MANAGE, NEW_CONVERSATION, THREAD, TIMELINE } from './support/labels'
import { signIn } from './support/login'
import { addMember, closePicker, createChannel, deleteSharedRooms, openManage } from './support/rooms'
import { EXIT_REVOKED, startSidecar, type SidecarRun } from './support/sidecar'
import { channelRow, conversations, messages, row, send, threadPanel } from './support/workspace'

// S-e (PLANO-AGENTES §0.3.9; the promotion criterion of ADR-087): "um comando e um token", end to end.
// tai, admin of the org, creates the agent in the UI; the spec runs the command the dialog shows (the
// launcher swapped for the built sidecar, plus a throwaway store and an ephemeral port — support/sidecar.ts);
// tai, its operator, adds the agent to the pair's private channel through the UI and the sidecar accepts
// the invite because it comes from the operator (ADR-087 dec. 12, ADR-090); ugo, who is not the operator,
// is never offered the agent in the new-DM picker. Through the sidecar's local API the agent posts a text,
// a mention of ugo and a reply in a thread to ugo's message; ugo sees the three with the agent mark
// (timeline and ThreadPanel) and the mention for her; ugo, on a new device, reads the agent's old message
// (custody, S6.1); Reemitir ends the old process with 78 and the new command posts again; Remover ends it
// with 78 and the history keeps the name and the mark (Message.authorAt, §0.3.11). Attachments are out
// (covered by the S-c2 integration).
//
// The channel is PRIVATE on purpose: a public channel is in the clear (ADR-045), and the custody proof
// needs encrypted history. In the grouped timeline only the first row of an author's run carries the
// avatar, so ugo speaks between the agent's timeline messages (each one then opens its own run).
//
// Secrets: the credential is in the DOM while the dialog is open, so this spec keeps no trace, video or
// screenshot (a failure attaches the sidecar output instead, credential and local token redacted).
test.use({ trace: 'off', video: 'off', screenshot: 'off' })

const suffix = Math.random().toString(36).slice(2, 8)
const NAME = `Assistente ${suffix}`
const CHANNEL = `sidecar-${suffix}`

const agentRow = (page: Page): Locator => personRow(page, NAME)

// The whole command, read from the dialog as the admin would copy it (agents.spec.ts readCredential):
// `npx tayet-agent --server <the page's origin> --token <credential>`, the credential shown once.
async function readCommand(dialog: Locator): Promise<{ command: string; credential: string }> {
  await expect(dialog.getByText(AGENTS.credentialOnce)).toBeVisible()
  const credential = (await dialog.locator('[data-agent-credential]').textContent())?.trim() ?? ''
  expect(credential.length).toBeGreaterThan(20)
  const origin = new URL(dialog.page().url()).origin
  const command = (await dialog.locator('[data-agent-command]').textContent())?.trim() ?? ''
  expect(command === `npx tayet-agent --server ${origin} --token ${credential}`, 'the command shown is the whole one').toBe(true)
  return { command, credential }
}

async function expectAgentMark(r: Locator): Promise<void> {
  const avatar = r.locator('[data-agent-avatar]')
  await expect(avatar).toHaveCount(1)
  await expect(avatar).toHaveAttribute('aria-label', AGENTS.mark)
  await expect(avatar.locator('[data-agent-mark]')).toHaveCount(1)
}

// The local API answers 200 or the spec stops with the code (never a token: bodies carry none).
async function ok(run: SidecarRun, method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  const r = await run.call(method, path, body)
  expect(r.status, `${method} ${path} -> ${JSON.stringify(r.json)}`).toBe(200)
  return r.json
}

async function poll<T>(get: () => Promise<T | undefined>, what: string, timeout = 60_000): Promise<T> {
  let found: T | undefined
  await expect.poll(async () => (found = await get()) !== undefined, { message: what, timeout, intervals: [500] }).toBe(true)
  return found!
}

interface Listed {
  id: string
  name?: string
  text?: string
}
const conversationOf = (run: SidecarRun): Promise<string> =>
  poll(async () => {
    const r = await run.call('GET', '/v1/conversations')
    return (r.json.conversations as Listed[] | undefined)?.find((c) => c.name === CHANNEL)?.id
  }, 'the channel in the agent conversations')
const messageTs = (run: SidecarRun, conv: string, text: string): Promise<string> =>
  poll(async () => {
    const r = await run.call('GET', `/v1/conversations/${conv}/messages`)
    return (r.json.messages as Listed[] | undefined)?.find((m) => m.text === text)?.id
  }, 'the message in the agent listing')

test('agent sidecar: one command and one token, end to end', async ({ browser }, testInfo) => {
  test.setTimeout(420_000)
  await deleteSharedRooms('tai', 'ugo')
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  let ctxNew: BrowserContext | undefined
  const consoleA = new ConsoleLedger('tai', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  const consoleB = new ConsoleLedger('ugo', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  // ugo's new device holds none of the channel's Megolm sessions (ugo's own and the agent's) until the
  // backup or the custody hands them over (ADR-061/077) — new-device.spec.ts.
  const consoleNew = new ConsoleLedger('ugo (new device)', [
    ...recognizedSet404(1),
    { ...AFTER_RELOGIN_404[0]!, max: backupLookupsCap(2), why: BACKUP_LOOKUPS_WHY(2) },
  ])
  const runs: SidecarRun[] = []
  const t1 = `agente fala ${suffix}`
  const t2 = `agente menciona ${suffix}`
  const t3 = `agente responde na thread ${suffix}`
  const t4 = `agente depois da reemissão ${suffix}`
  const root = `ugo pergunta ${suffix}`
  let failed = true
  try {
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()
    consoleA.watch(pageA, 'A')
    consoleB.watch(pageB, 'B')

    await test.step('1. the pair enters; tai creates a private channel and adds ugo', async () => {
      await signIn(pageB, UGO)
      await signIn(pageA, TAI)
      await createChannel(pageA, { name: CHANNEL, kind: 'private' })
      await openManage(pageA, CHANNEL, 'private')
      await addMember(pageA, 'ugo')
      await pageA.getByRole('button', { name: MANAGE.close }).click()
      await expect(channelRow(pageB, CHANNEL)).toBeVisible({ timeout: 60_000 })
    })

    // Slice 1c: "Pessoas" lives in the Admin, opened from "Sua conta".
    const openPeople = (): Promise<void> => openAdmin(pageA)

    let first = { command: '', credential: '' }
    await test.step('2. tai creates the agent; the dialog shows the whole command once', async () => {
      await openPeople()
      await pageA.getByRole('button', { name: AGENTS.add }).click()
      const dialog = pageA.getByRole('dialog', { name: AGENTS.createTitle })
      await dialog.getByLabel(AGENTS.fieldName).fill(NAME)
      await dialog.getByRole('button', { name: AGENTS.create }).click()
      const created = pageA.getByRole('dialog', { name: AGENTS.createdTitle })
      await expect(created).toBeVisible({ timeout: 60_000 })
      first = await readCommand(created)
      await created.getByRole('button', { name: AGENTS.done }).click()
      await expect(pageA.locator('[data-agent-credential]')).toHaveCount(0)
    })

    let run!: SidecarRun
    await test.step('3. the command shown starts the sidecar (discovery by the page origin)', async () => {
      const startedAt = Date.now()
      run = await startSidecar(first.command, [first.credential])
      runs.push(run)
      await run.waitFor((l) => l.evt === 'discovered' && l.via === 'well-known')
      console.log(`[e2e] sidecar up (api-listening) in ${Date.now() - startedAt} ms`)
    })

    let conv = ''
    await test.step('4. tai, the operator, adds the agent through the UI; it enters; ugo is not offered it', async () => {
      // Leave the Admin: back to the conversations.
      await pageA.getByRole('button', { name: ADMIN.back }).click()
      await expect(adminNav(pageA)).toHaveCount(0)
      // ADR-090: tai operates the agent, so it is among her candidates, marked (agents.spec.ts step 6).
      await openManage(pageA, CHANNEL, 'private')
      const add = pageA.getByRole('dialog', { name: MANAGE.addMember })
      const candidate = add.getByRole('button', { name: new RegExp(NAME) })
      await pageA.getByRole('button', { name: MANAGE.addMember }).click()
      await expect(candidate).toBeVisible({ timeout: 30_000 })
      await expect(candidate.locator('[data-agent-avatar]')).toHaveCount(1)
      const clicked = Date.now()
      await candidate.click()
      await closePicker(pageA, candidate)
      // The real sidecar accepts (the invite is the operator's): the roster row loses the "awaiting the
      // first connection" chip — joined, not only invited. The row is seen first (no empty negative).
      const member = pageA.getByRole('region', { name: MANAGE.members }).getByRole('listitem').filter({ hasText: NAME })
      await expect(member).toBeVisible({ timeout: 30_000 })
      await expect(member.getByText(MANAGE.awaiting)).toHaveCount(0, { timeout: 60_000 })
      const enteredUi = Date.now() - clicked
      await run.waitFor((l) => l.evt === 'joined', 60_000)
      console.log(`[e2e] added through the UI -> entered: roster ${enteredUi} ms, sidecar joined by ${Date.now() - clicked} ms`)
      await pageA.getByRole('button', { name: MANAGE.close }).click()
      conv = await conversationOf(run)

      // ugo is not the operator: her new-DM picker never offers the agent. The absence is asserted only
      // once tai is seen in the list (agents.spec.ts step 6).
      const picker = pageB.getByRole('dialog', { name: NEW_CONVERSATION.dialog })
      await expect(async () => {
        if ((await picker.count()) > 0) await picker.getByRole('button', { name: NEW_CONVERSATION.cancel }).click()
        await conversations(pageB).getByRole('button', { name: LIST.newDm }).click()
        await expect(picker.getByRole('button', { name: /^tai/ })).toBeVisible({ timeout: 5_000 })
      }).toPass({ timeout: 60_000 })
      await expect(picker.getByRole('button', { name: new RegExp(NAME) })).toHaveCount(0)
      await picker.getByRole('button', { name: NEW_CONVERSATION.cancel }).click()
    })

    let ugoId = ''
    await test.step('5. through the local API: a text, then (ugo speaks) a mention of ugo and a reply in her thread', async () => {
      ugoId = await poll(async () => {
        const r = await run.call('GET', `/v1/conversations/${conv}/members`)
        return (r.json.people as Listed[] | undefined)?.find((p) => p.name === 'ugo')?.id
      }, 'ugo among the members')
      expect(ugoId).toMatch(/^U/)
      await ok(run, 'POST', `/v1/conversations/${conv}/messages`, { text: t1 })
      await channelRow(pageB, CHANNEL).click()
      await expectReadableWithin(pageB, 60_000, t1)
      await send(pageB, root)
      const rootTs = await messageTs(run, conv, root)
      const mention = await ok(run, 'POST', `/v1/conversations/${conv}/messages`, { text: t2, mentions: [ugoId] })
      expect(mention.mentions).toEqual([ugoId])
      const reply = await ok(run, 'POST', `/v1/conversations/${conv}/messages`, { text: t3, thread: rootTs })
      expect(reply.thread).toBe(rootTs)
    })

    await test.step('6. ugo sees the three with the agent mark, and the mention for her', async () => {
      await expectReadableWithin(pageB, 60_000, t1, root, t2)
      await expectAgentMark(row(pageB, t1))
      await expectAgentMark(row(pageB, t2))
      await expect(row(pageB, t2).getByText(TIMELINE.mentionsYou)).toBeVisible()
      await expect(row(pageB, t1).getByText(TIMELINE.mentionsYou)).toHaveCount(0)
      await row(pageB, root).getByRole('button', { name: new RegExp(TIMELINE.replies(1)) }).click({ timeout: 60_000 })
      const replies = threadPanel(pageB).getByRole('log', { name: THREAD.replies })
      await expect(replies).toContainText(t3, { timeout: 60_000 })
      await expectAgentMark(replies.locator('article').filter({ hasText: t3 }))
      await threadPanel(pageB).getByRole('button', { name: THREAD.close }).click()
      await expectNoProtocolLeak(pageA, pageB)
    })

    let pageNew: Page | undefined
    await test.step('7. custody: ugo on a new device reads the agent\'s old message', async () => {
      ctxNew = await browser.newContext()
      pageNew = await ctxNew.newPage()
      consoleNew.watch(pageNew, 'new')
      await signIn(pageNew, UGO)
      await channelRow(pageNew, CHANNEL).click()
      const openedAt = Date.now()
      // ADR-077: up to 30 s through the custody (cap + margin, new-device.spec.ts step 5). Only the
      // agent's message here: the text on screen is its decryption (a pending one shows a placeholder).
      await expect(messages(pageNew)).toContainText(t1, { timeout: 40_000 })
      console.log(`[e2e] new device: the agent's message readable ${Date.now() - openedAt} ms after opening`)
      await expectAgentMark(row(pageNew, t1))
      await expectNoProtocolLeak(pageNew)
    })

    // ugo's own message (step 5, sent by her old device) is a second Megolm session, which the new
    // device lacks as it lacks the agent's. The old device uploads it to the backup 0–10 s after
    // creating it (ADR-077, Contexto: the SDK's random delay), so the new device may open before it is
    // there; ADR-077 dec. 2/3 re-consults the custody and re-decrypts (re-asking the backup) for up to
    // 30 s, without a reload. Same cap + margin as step 7; nothing from the agent's message onward may
    // be left as a placeholder.
    await test.step('7b. ugo on the new device reads her own old message, sent from her old device', async () => {
      const startedAt = Date.now()
      await expectReadableWithin(pageNew!, 40_000, t1, root, t2)
      console.log(`[e2e] new device: ugo's own message readable ${Date.now() - startedAt} ms after the agent's`)
    })

    let second = { command: '', credential: '' }
    await test.step('8. Reemitir: the old process exits 78; the new command posts again; ugo sees it', async () => {
      await openPeople()
      await rowAction(pageA, NAME, AGENTS.editItem)
      await pageA.getByRole('dialog', { name: AGENTS.editTitle }).getByRole('button', { name: AGENTS.reissueCredential }).click()
      const clicked = Date.now()
      await pageA.getByRole('alertdialog').getByRole('button', { name: AGENTS.reissue, exact: true }).click()
      const reissued = pageA.getByRole('dialog', { name: AGENTS.reissuedTitle })
      await expect(reissued).toBeVisible({ timeout: 60_000 })
      second = await readCommand(reissued)
      expect(second.credential === first.credential).toBe(false)
      await reissued.getByRole('button', { name: AGENTS.done }).click()
      const exit = await Promise.race([run.exited, new Promise<never>((_, no) => setTimeout(() => no(new Error('old sidecar still running 60 s after the reissue')), 60_000))])
      expect(exit.code).toBe(EXIT_REVOKED)
      const revokedLine = run.output().includes('"evt":"revoked"')
      console.log(`[e2e] reissue: old sidecar exited ${exit.code} ${exit.at - clicked} ms after the confirm (revoked line: ${revokedLine})`)
      await run.stop()

      run = await startSidecar(second.command, [first.credential, second.credential])
      runs.push(run)
      conv = await conversationOf(run)
      await send(pageB, `ugo de novo ${suffix}`)
      await ok(run, 'POST', `/v1/conversations/${conv}/messages`, { text: t4 })
      await expectReadableWithin(pageB, 60_000, t4)
      await expectAgentMark(row(pageB, t4))
    })

    await test.step('9. Remover: the process exits 78; the history stays, with the name and the mark', async () => {
      await rowAction(pageA, NAME, AGENTS.removeItem)
      const clicked = Date.now()
      await pageA.getByRole('alertdialog').getByRole('button', { name: AGENTS.removeConfirm, exact: true }).click()
      await expect(agentRow(pageA)).toHaveCount(0, { timeout: 60_000 })
      const exit = await Promise.race([run.exited, new Promise<never>((_, no) => setTimeout(() => no(new Error('sidecar still running 60 s after the removal')), 60_000))])
      expect(exit.code).toBe(EXIT_REVOKED)
      const revokedLine = run.output().includes('"evt":"revoked"')
      console.log(`[e2e] remove: sidecar exited ${exit.code} ${exit.at - clicked} ms after the confirm (revoked line: ${revokedLine})`)
      // P6 / ADR-086 dec. 2: a removed agent's history keeps who wrote it — the mark and the name, never
      // the "someone" fallback. Each of these rows opens its own run, so it carries the header.
      for (const text of [t1, t2, t4]) {
        await expect(row(pageB, text)).toBeVisible()
        await expectAgentMark(row(pageB, text))
        await expect(row(pageB, text)).toContainText(NAME)
      }
      await expectNoProtocolLeak(pageA, pageB)
    })

    console.log(`[e2e] console A: ${JSON.stringify(consoleA.observed())}`)
    console.log(`[e2e] console B: ${JSON.stringify(consoleB.observed())}`)
    console.log(`[e2e] console new: ${JSON.stringify(consoleNew.observed())}`)
    consoleA.expectClean()
    consoleB.expectClean()
    consoleNew.expectClean()
    failed = false
  } finally {
    if (failed) {
      runs.forEach((r, i) => testInfo.attachments.push({ name: `sidecar-${i + 1}.log`, contentType: 'text/plain', body: Buffer.from(r.output()) }))
    }
    for (const r of runs) await r.stop()
    await ctxA.close()
    await ctxB.close()
    await ctxNew?.close()
  }
})
