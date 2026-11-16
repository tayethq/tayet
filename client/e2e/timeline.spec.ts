import { test, expect, type Page } from '@playwright/test'
import { MIA, NOA } from './fixtures/users'
import { expectNoProtocolLeak, PLACEHOLDERS } from './support/assertions'
import { ConsoleLedger, FIRST_LOGIN_404, recognizedSet404 } from './support/console'
import { signIn } from './support/login'
import { setHidden, VISIBILITY_SHIM } from './support/visibility'
import { png } from './support/media'
import { createChannel, deleteSharedRooms } from './support/rooms'
import { channelRow, conversations, dmWith, messages, row, send, threadPanel } from './support/workspace'
import { APP, COMPOSER, LIST, MANAGE, NEW_CONVERSATION, THREAD, TIMELINE } from './support/labels'

// PLANO-RELEASE-PUBLICA §8.27 (ROTEIRO-U2 2.6, achados A e B). Par próprio do tier: mia (A) escreve
// na DM, noa (B) abre e responde em thread.
//  - B: a DM com várias mensagens e uma imagem abre na última mensagem, também depois do reload. A
//    imagem enviada pelo app não leva dimensões (§8.27 §0 item 5), então isto prova a re-ancoragem
//    da Timeline quando a linha cresce, num browser real (layout e load de verdade).
//  - A: a resposta em thread aparece na raiz como "1 reply"; o clique abre a thread pelo mesmo caminho
//    do "Reply in thread" (ADR-066). O marcador "Unread replies" (ADR-067, derivado de recibos) é
//    provado na DM cifrada — visível, visível depois do reload, some ao abrir a thread — e no canal
//    público do par (em claro), com a mesma regra (PLANO §8.28).
//  - ADR-100: a conversa aberta é lida conforme as mensagens chegam. noa abre a DM logo depois do
//    reload, e a linha fica sem não lidas, com o título `Tayet`; a regra vale com ou sem reentrega da
//    história pelo servidor depois do reload (a config do Synapse do repo não reentrega). Com a
//    DM aberta e visível, a mensagem nova de noa não conta para mia; com a aba de mia oculta
//    (VISIBILITY_SHIM), conta (linha com 1, título `(1) Tayet`) e zera sem clique quando a aba volta.

const MIA_NAME = 'mia'
const TAB_TITLE = APP.title
const NOA_NAME = 'noa'

// The DM is at its latest message: the last text is inside the scroller's viewport, the image above
// it has loaded (so the layout shift already happened), and nothing of this run is a placeholder.
async function expectOpenedAtLatest(page: Page, imageName: string, lastText: string, firstText: string): Promise<void> {
  const startedAt = Date.now()
  // The tail of the DM reaches B through sync + decrypt; wait for it before judging the scroll.
  await expect(messages(page)).toContainText(lastText, { timeout: 60_000 })
  console.log(`[e2e] DM tail on screen after: ${Date.now() - startedAt} ms`)
  const image = messages(page).getByRole('img', { name: imageName })
  await expect(image).toBeVisible()
  await expect
    .poll(() => image.evaluate((el) => el.tagName === 'IMG' && (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0))
    .toBe(true)
  await expect(row(page, lastText)).toBeInViewport()
  const all = await messages(page).innerText()
  const fromThisRun = all.slice(all.indexOf(firstText))
  for (const p of PLACEHOLDERS) expect(fromThisRun, `placeholder after "${firstText}"`).not.toContain(p)
}

// ADR-100: the DM row has no unread and the tab title is bare — and stays so for a few seconds.
async function expectReadHeld(page: Page, peer: string): Promise<void> {
  await expect(dmWith(page, peer)).not.toHaveAccessibleName(LIST.unreadSuffix, { timeout: 30_000 })
  await expect(page).toHaveTitle(TAB_TITLE)
  for (let i = 0; i < 3; i++) {
    await page.waitForTimeout(1_000)
    await expect(dmWith(page, peer)).not.toHaveAccessibleName(LIST.unreadSuffix, { timeout: 0 })
    await expect(page).toHaveTitle(TAB_TITLE, { timeout: 0 })
  }
}

// Hermetic start (as conversation.spec): the DM mia↔noa of earlier local runs is deleted, so the DM of
// this run is born here. On a fresh stack (CI) there is nothing to delete.
test.beforeAll(async () => {
  await deleteSharedRooms('mia', 'noa')
})

test('a DM with an image opens at its latest message; a thread reply shows on the root and clears when read', async ({
  browser,
}) => {
  test.setTimeout(240_000)
  const ts = Date.now()
  // 4 lines + the image + the last line + the channel root = 7 sends by mia per run: under the local
  // rc_message burst (measured: the 8th send in a burst drew a 429, which the console ledger counts),
  // since the local stack keeps Synapse's defaults (CI is permissive) — and still taller than the
  // DM's viewport: the image row moves the bottom when it loads.
  const texts = Array.from({ length: 4 }, (_, i) => `tl-${ts} message ${i + 1}`)
  const rootText = texts[3]!
  const lastText = `tl-${ts} last`
  const replyText = `tl-${ts} thread reply`
  const imageName = `planta-${ts}.png`

  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  // ADR-100 (step 6): mia's tab goes to the background. Inert until setHidden; headless keeps
  // document.hasFocus() true, so visibility is the knob.
  await ctxA.addInitScript(VISIBILITY_SHIM)
  // App boots per page (one recognized-set 404 each, support/console.ts): A = 2 (login in step 1,
  // reload in step 5); B = 2 (login in step 1, reload in step 3).
  const consoleA = new ConsoleLedger('mia', [...FIRST_LOGIN_404, ...recognizedSet404(2)])
  const consoleB = new ConsoleLedger('noa', [...FIRST_LOGIN_404, ...recognizedSet404(2)])
  try {
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()
    consoleA.watch(pageA, 'A')
    consoleB.watch(pageB, 'B')

    await test.step('1. mia and noa log in through Dex', async () => {
      await signIn(pageA, MIA)
      await signIn(pageB, NOA)
      await expectNoProtocolLeak(pageA, pageB)
    })

    await test.step('2. mia opens a DM with noa and posts messages, an image of known size, and a last line', async () => {
      // Known-set picker (ADR-029 dec. 3) via #all; noa's session join of #all (ADR-045) may land after
      // her h1, so the dialog is reopened until she is in the known set (as tab-lock.spec).
      // Anchored, not exact: #all may carry an unread badge from the other specs ("#all 3 unread").
      await expect(conversations(pageB).getByRole('button', { name: /^#all(\s|$)/ })).toBeVisible()
      const dialog = pageA.getByRole('dialog', { name: NEW_CONVERSATION.dialog })
      const contact = dialog.getByRole('button', { name: NOA_NAME, exact: true })
      await expect(async () => {
        if ((await dialog.count()) > 0) await dialog.getByRole('button', { name: NEW_CONVERSATION.cancel }).click()
        await conversations(pageA).getByRole('button', { name: LIST.newDm }).click()
        await expect(contact).toBeVisible({ timeout: 5_000 })
      }).toPass({ timeout: 60_000 })
      await contact.click()
      await expect(contact).toHaveAttribute('aria-pressed', 'true')
      await dialog.getByRole('button', { name: NEW_CONVERSATION.startConversation }).click()
      await expect(dialog).toHaveCount(0)
      await dmWith(pageA, NOA_NAME).click()
      for (const t of texts) await send(pageA, t)
      await pageA
        .getByRole('main')
        .locator('input[type="file"]')
        .setInputFiles({ name: imageName, mimeType: 'image/png', buffer: png(640, 480) })
      await expect(messages(pageA).getByRole('img', { name: imageName })).toBeVisible()
      await send(pageA, lastText)
    })

    // §8.27 B: the bug opened this DM scrolled to the top. Now it opens at the last line, after the
    // image (decrypted blob, loaded late) has grown its row.
    await test.step('3. noa opens the DM: the last message is in view; reload: same', async () => {
      await dmWith(pageB, MIA_NAME).click()
      await expectOpenedAtLatest(pageB, imageName, lastText, texts[0]!)
      // ADR-080 D3: the message time is HH:MM in the catalog's locale, 24 h — never the runner's
      // en-US "12:05 PM", which broke the gutter (§8.68).
      await expect(row(pageB, texts[0]!)).toContainText(/\d{2}:\d{2}/)
      await expect(row(pageB, texts[0]!)).not.toContainText(/\d{2}:\d{2}\s?[AP]M/)
      await expect(messages(pageB).getByRole('separator', { name: TIMELINE.dayToday })).toBeVisible()
      await pageB.reload()
      await expect(pageB.getByRole('heading', { name: APP.title, level: 1 })).toBeVisible()
      await dmWith(pageB, MIA_NAME).click()
      await expectOpenedAtLatest(pageB, imageName, lastText, texts[0]!)
      // ADR-100: opened right after the reload. The messages that land after the selection's receipt
      // are read as they arrive, whether or not the server re-delivers the history after the reload
      // (the repo's Synapse config turns that replay off). Held for a while: a count stuck after the
      // selection is the defect.
      await expectReadHeld(pageB, MIA_NAME)
      await expectNoProtocolLeak(pageB)
    })

    await test.step('4. noa replies in a thread to one of mia’s messages', async () => {
      const root = row(pageB, rootText)
      await root.scrollIntoViewIfNeeded()
      await root.hover()
      await root.getByRole('button', { name: TIMELINE.replyInThread }).click()
      const panel = threadPanel(pageB)
      await expect(panel).toBeVisible()
      await panel.getByRole('textbox', { name: COMPOSER.editor, exact: true }).fill(replyText)
      await panel.getByRole('button', { name: COMPOSER.send }).click()
      await expect(panel.getByRole('log', { name: THREAD.replies })).toContainText(replyText)
      // noa's own reply: the root shows the summary, and no unread marker for the author.
      await expect(row(pageB, rootText).getByRole('button', { name: TIMELINE.replies(1) })).toBeVisible()
      await expect(row(pageB, rootText).getByLabel(TIMELINE.unreadReplies)).toHaveCount(0)
    })

    // ADR-066/067 in the DM: the root carries "1 reply" and the "Unread replies" dot. mia has never
    // sent a threaded receipt in this DM — the case where the SDK's per-thread count stayed 0 in an
    // encrypted room (§8.27 finding 1); the marker now comes from receipts (§8.28). It survives a
    // reload (initial sync from scratch) and goes away once the summary opens the thread (markRead).
    // The DM's badge in the list counts that reply too (ADR-068: the server's count, as in a cleartext
    // channel; before it, the encrypted DM left thread replies out), and clears with the thread.
    // No new send: it is noa's reply of step 4.
    await test.step('5. mia sees "1 reply", the unread dot and the DM badge, also after reload; opening the thread clears them', async () => {
      const summary = () => row(pageA, rootText).getByRole('button', { name: TIMELINE.replies(1) })
      const dot = () => row(pageA, rootText).getByLabel(TIMELINE.unreadReplies)
      await expect(summary()).toBeVisible()
      await expect(dot()).toBeVisible()
      await pageA.reload()
      await expect(pageA.getByRole('heading', { name: APP.title, level: 1 })).toBeVisible()
      await expect(dmWith(pageA, NOA_NAME)).toHaveAccessibleName(new RegExp(`\\s${LIST.unread(1)}$`), { timeout: 60_000 })
      await dmWith(pageA, NOA_NAME).click()
      await expect(summary()).toBeVisible({ timeout: 60_000 })
      await expect(dot()).toBeVisible()
      await summary().click()
      const panel = threadPanel(pageA)
      await expect(panel.getByRole('log', { name: THREAD.replies })).toContainText(replyText)
      await expect(dot()).toHaveCount(0)
      await expect(dmWith(pageA, NOA_NAME)).not.toHaveAccessibleName(LIST.unreadSuffix)
      await panel.getByRole('button', { name: THREAD.close }).click()
      await expect(dot()).toHaveCount(0)
      await expectNoProtocolLeak(pageA, pageB)
    })

    // ADR-100 dec. 1 and 3, mia reading. noa writes (mia is at the local rc_message burst, see `texts`).
    // mia is on the DM since step 5, its thread closed: noa's message arrives in view and is read on
    // arrival. With mia's tab hidden it counts (row and title) and, back in view, it is read without a
    // click.
    await test.step('6. mia on the open DM: a new message is read as it arrives; hidden it counts, back in view it clears', async () => {
      const inView = `tl-${ts} in view`
      const hidden = `tl-${ts} while hidden`
      await send(pageB, inView)
      await expect(messages(pageA)).toContainText(inView, { timeout: 60_000 })
      await expectReadHeld(pageA, NOA_NAME)

      await setHidden(pageA, true)
      await send(pageB, hidden)
      await expect(messages(pageA)).toContainText(hidden, { timeout: 60_000 })
      await expect(dmWith(pageA, NOA_NAME)).toHaveAccessibleName(new RegExp(`\\s${LIST.unread(1)}$`), { timeout: 30_000 })
      await expect(pageA).toHaveTitle(`(1) ${TAB_TITLE}`)

      await setHidden(pageA, false)
      await expectReadHeld(pageA, NOA_NAME)
      await expectNoProtocolLeak(pageA, pageB)
    })

    // The same marker in a PUBLIC channel, which is in the clear (ADR-045): the rule is the same
    // (receipts, ADR-067), whatever the room's encryption. It is a channel of this pair, created here — never #all, which the whole tier shares
    // (a thread there would leave unread on every other spec's user). noa creates it and adds mia
    // (ADR-044 auto-joins her): one invite per user per run (mia already invites noa to the DM); the
    // dev-stack's rc_invites is burst_count: 100 (homeserver.yaml:74-77), not Synapse's default burst
    // of 5 this comment once cited. mia writes a
    // root, noa replies in its thread; mia sees "1 reply" + the "Unread replies" dot, opens the thread through the
    // summary, and the marker goes away once read.
    await test.step('7. a public channel of the pair: the unread marker shows on the root and clears when read', async () => {
      const channelName = `tl-${ts}`
      const channelRoot = `tl-${ts} channel root`
      const channelReply = `tl-${ts} channel thread reply`

      await createChannel(pageB, { name: channelName, kind: 'public' })
      await channelRow(pageB, channelName).click()
      await pageB.getByRole('button', { name: MANAGE.open(`#${channelName}`) }).click()
      await pageB.getByRole('button', { name: MANAGE.addMember }).click()
      await pageB.getByRole('dialog', { name: MANAGE.addMember }).getByRole('button', { name: MIA_NAME, exact: true }).click()
      await expect(pageB.getByRole('region', { name: MANAGE.members })).toContainText(MIA_NAME)
      await pageB.getByRole('button', { name: MANAGE.close }).click()

      await channelRow(pageA, channelName).click()
      await send(pageA, channelRoot)

      const rootB = row(pageB, channelRoot)
      await expect(rootB).toBeVisible()
      await rootB.hover()
      await rootB.getByRole('button', { name: TIMELINE.replyInThread }).click()
      const panelB = threadPanel(pageB)
      await panelB.getByRole('textbox', { name: COMPOSER.editor, exact: true }).fill(channelReply)
      await panelB.getByRole('button', { name: COMPOSER.send }).click()
      await expect(panelB.getByRole('log', { name: THREAD.replies })).toContainText(channelReply)

      const rootA = row(pageA, channelRoot)
      const summary = rootA.getByRole('button', { name: TIMELINE.replies(1) })
      await expect(summary).toBeVisible()
      await expect(rootA.getByLabel(TIMELINE.unreadReplies)).toBeVisible()
      await summary.click()
      await expect(threadPanel(pageA).getByRole('log', { name: THREAD.replies })).toContainText(channelReply)
      await expect(rootA.getByLabel(TIMELINE.unreadReplies)).toHaveCount(0)
      await expect(rootA.getByRole('button', { name: TIMELINE.replies(1) })).toBeVisible()
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
