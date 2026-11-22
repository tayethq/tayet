import { test, expect, type Page } from '@playwright/test'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { YAN, ZOE } from './fixtures/users'
import { expectNoProtocolLeak } from './support/assertions'
import { ConsoleLedger, FIRST_LOGIN_404, recognizedSet404 } from './support/console'
import { COMPOSER, LINK_DIALOG, MANAGE, THREAD, TIMELINE } from './support/labels'
import { signIn } from './support/login'
import { addMember, createChannel, deleteSharedRooms, openManage } from './support/rooms'
import { channelRow, dmWith, mainComposer, messages, row, send, startDm, threadPanel } from './support/workspace'

// ROTEIRO-U2 2.2: composing, end to end (PLANO-RELEASE-PUBLICA §8.54). yan (A) and zoe (B) — the
// spec's own Dex pair (fixtures/users.ts, one pair per spec). In their DM: rich text from the
// "Formatting" toolbar (bold, italic, link through the "Inserir link" dialog, a bulleted list) renders
// as such on both sides; editing that message keeps its formatting and shows the new text and
// "(edited)"; a reply quotes its target (author
// + excerpt); reactions toggle, with the chip pressed only for who reacted; a thread on someone
// else's root (#224) counts "2 replies" on both and its unread marker clears for zoe once she opens
// it. In a public channel of the pair (never #all) zoe mentions yan through the picker: the message
// carries the NAME and nothing shaped like an id. Whether yan PERCEIVES the mention is not asserted
// here (F1: notifications.spec). The DOM is scanned for protocol ids (P1) at every step. Last, the ↑/↓ history in
// the composer (workspace.md §25.6, issue tayethq/tayet #2): zoe's own messages come back, newest first.

// Display names as the MAS imported them from the Dex `name` claim (see conversation.spec.ts).
const YAN_NAME = 'yan'
const ZOE_NAME = 'zoe'

// A reaction chip: the emoji and its count (Reactions.tsx renders them in two spans, no label).
const chip = (r: ReturnType<typeof row>, emoji: string) =>
  r.getByRole('button', { name: new RegExp(`^${emoji}\\s*\\d+$`, 'u') })

async function toolbar(page: Page, name: string): Promise<void> {
  await page.getByRole('main').getByRole('toolbar', { name: COMPOSER.formatting }).getByRole('button', { name, exact: true }).click()
}

test.beforeAll(async () => {
  await deleteSharedRooms('yan', 'zoe')
})

test('compose: formatting, edit, reply, reactions, thread and mention between two users', async ({ browser }) => {
  test.setTimeout(240_000)
  const ts = Date.now()
  const bold = `forte${ts}`
  const italic = `leve${ts}`
  const linkText = `o site ${ts}`
  const href = `https://example.org/aurora-${ts}`
  const items = [`item um ${ts}`, `item dois ${ts}`]
  const revised = ` revisto ${ts}`
  const answer = `resposta ${ts}`
  const threadReplies = [`fio um ${ts}`, `fio dois ${ts}`]
  const mentionText = ` olha isto ${ts}`
  const channelName = `cmp-${ts}`

  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  // Boots: one login per page, no reload.
  const consoleA = new ConsoleLedger('yan', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  const consoleB = new ConsoleLedger('zoe', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  try {
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()
    consoleA.watch(pageA, 'A')
    consoleB.watch(pageB, 'B')

    await test.step('1. DM: yan writes bold, italic, a link and a bulleted list from the toolbar; zoe sees them as such', async () => {
      await signIn(pageA, YAN)
      await signIn(pageB, ZOE)
      await startDm(pageA, ZOE_NAME)
      await expect(dmWith(pageB, YAN_NAME)).toBeVisible({ timeout: 60_000 })

      const composer = mainComposer(pageA)
      await composer.click()
      await toolbar(pageA, COMPOSER.bold)
      await composer.pressSequentially(bold)
      await toolbar(pageA, COMPOSER.bold)
      await composer.pressSequentially(' e ')
      await toolbar(pageA, COMPOSER.italic)
      await composer.pressSequentially(italic)
      await toolbar(pageA, COMPOSER.italic)
      await composer.pressSequentially(' com ')
      await toolbar(pageA, COMPOSER.link)
      const dialog = pageA.getByRole('dialog', { name: LINK_DIALOG.dialog })
      await dialog.getByLabel(LINK_DIALOG.text, { exact: true }).fill(linkText)
      await dialog.getByLabel(LINK_DIALOG.url, { exact: true }).fill(href)
      await dialog.getByRole('button', { name: LINK_DIALOG.insert, exact: true }).click()
      await expect(dialog).toHaveCount(0)
      // Shift+Enter: a new block (Enter sends).
      await composer.press('Shift+Enter')
      await toolbar(pageA, COMPOSER.bulletedList)
      await composer.pressSequentially(items[0]!)
      await composer.press('Shift+Enter')
      await composer.pressSequentially(items[1]!)
      await pageA.getByRole('main').getByRole('button', { name: COMPOSER.send }).click()

      await dmWith(pageB, YAN_NAME).click()
      for (const page of [pageA, pageB]) {
        const r = row(page, bold)
        await expect(r).toBeVisible({ timeout: 60_000 })
        await expect(r.locator('strong')).toHaveText(bold)
        await expect(r.locator('em')).toHaveText(italic)
        await expect(r.getByRole('link', { name: linkText, exact: true })).toHaveAttribute('href', href)
        await expect(r.getByRole('listitem')).toHaveText(items)
      }
      await expectNoProtocolLeak(pageA, pageB)
    })

    // ROTEIRO-U2 2.2: the edit is of the formatted message itself. It re-opens WITH its formatting
    // (ADR-051 PR-5b); text appended at its end lands in the last list item, and the rest survives.
    await test.step('2. yan edits the formatted message: the new text, the formatting and "(edited)" on both', async () => {
      const r = row(pageA, bold)
      await r.hover()
      await r.getByRole('button', { name: TIMELINE.edit }).click()
      // The row's editor is the only one inside the timeline.
      const editor = messages(pageA).getByRole('textbox', { name: COMPOSER.editor, exact: true })
      await expect(editor.locator('strong')).toHaveText(bold)
      // The caret opens at the start; a click at the right edge of the last list item puts it at the end
      // of that line on any platform (End / Cmd+End differ between macOS and Linux).
      const last = editor.getByRole('listitem').last()
      const box = (await last.boundingBox())!
      await last.click({ position: { x: box.width - 2, y: box.height / 2 } })
      await editor.pressSequentially(revised)
      await messages(pageA).getByRole('button', { name: COMPOSER.save, exact: true }).click()
      await expect(editor).toHaveCount(0)
      for (const page of [pageA, pageB]) {
        const edited = row(page, bold)
        await expect(edited).toContainText(revised, { timeout: 60_000 })
        await expect(edited).toContainText(TIMELINE.edited)
        await expect(edited.locator('strong')).toHaveText(bold)
        await expect(edited.locator('em')).toHaveText(italic)
        await expect(edited.getByRole('link', { name: linkText, exact: true })).toHaveAttribute('href', href)
        await expect(edited.getByRole('listitem')).toHaveText([items[0]!, `${items[1]}${revised}`])
      }
      await expectNoProtocolLeak(pageA, pageB)
    })

    await test.step('3. zoe replies to it: the banner names yan; the new row quotes author and excerpt, on both', async () => {
      const target = row(pageB, bold)
      await target.hover()
      await target.getByRole('button', { name: TIMELINE.reply, exact: true }).click()
      const banner = pageB.getByRole('main').getByRole('status').filter({ hasText: COMPOSER.replyingTo })
      await expect(banner).toContainText(YAN_NAME)
      await send(pageB, answer)
      await expect(banner).toHaveCount(0)
      for (const page of [pageA, pageB]) {
        const quote = row(page, answer).getByRole('button', { name: TIMELINE.repliedMessage })
        await expect(quote).toBeVisible({ timeout: 60_000 })
        await expect(quote).toContainText(YAN_NAME)
        await expect(quote).toContainText(bold)
      }
      await expectNoProtocolLeak(pageA, pageB)
    })

    await test.step('4. zoe reacts 👍 and 🎉 to yan’s message; the chips are pressed only for her; she takes 🎉 back', async () => {
      // The edited message's row: the reply's row also quotes its text, so it is excluded.
      const target = (page: Page) => row(page, bold).filter({ hasNot: page.getByRole('button', { name: TIMELINE.repliedMessage }) })
      // The first through the bar's "Reagir", the second through the `+` of the line it opened
      // (the same picker, manifest workspace.md §11 item 3).
      const react = async (emoji: string) => {
        await target(pageB).hover()
        await target(pageB).getByRole('button', { name: TIMELINE.reactOpen, exact: true }).first().click()
        await target(pageB).getByRole('button', { name: TIMELINE.react(emoji) }).click()
      }
      await react('👍')
      await expect(chip(target(pageB), '👍')).toBeVisible()
      await react('🎉')
      for (const [page, mine] of [
        [pageB, 'true'],
        [pageA, 'false'],
      ] as const) {
        for (const e of ['👍', '🎉']) {
          await expect(chip(target(page), e)).toHaveText(new RegExp(`${e}\\s*1`, 'u'), { timeout: 60_000 })
          await expect(chip(target(page), e)).toHaveAttribute('aria-pressed', mine)
        }
      }
      await chip(target(pageB), '🎉').click()
      for (const page of [pageB, pageA]) {
        await expect(chip(target(page), '🎉')).toHaveCount(0, { timeout: 60_000 })
        await expect(chip(target(page), '👍')).toBeVisible()
      }
      await expectNoProtocolLeak(pageA, pageB)
    })

    await test.step('5. yan opens a thread on zoe’s message and replies twice: "2 replies" on both; zoe’s unread marker clears when she opens it', async () => {
      const root = row(pageA, answer)
      await root.hover()
      await root.getByRole('button', { name: TIMELINE.replyInThread }).click()
      const panel = threadPanel(pageA)
      for (const t of threadReplies) {
        await panel.getByRole('textbox', { name: COMPOSER.editor, exact: true }).fill(t)
        await panel.getByRole('button', { name: COMPOSER.send }).click()
        await expect(panel.getByRole('log', { name: THREAD.replies })).toContainText(t)
      }
      await panel.getByRole('button', { name: THREAD.close }).click()
      for (const page of [pageA, pageB]) {
        await expect(row(page, answer).getByRole('button', { name: new RegExp(TIMELINE.replies(2)) })).toBeVisible({ timeout: 60_000 })
      }
      const dot = row(pageB, answer).getByLabel(TIMELINE.unreadReplies)
      await expect(dot).toBeVisible()
      await row(pageB, answer).getByRole('button', { name: new RegExp(TIMELINE.replies(2)) }).click()
      await expect(threadPanel(pageB).getByRole('log', { name: THREAD.replies })).toContainText(threadReplies[1]!)
      await expect(dot).toHaveCount(0)
      await threadPanel(pageB).getByRole('button', { name: THREAD.close }).click()
      await expectNoProtocolLeak(pageA, pageB)
    })

    await test.step('6. a public channel of the pair: zoe mentions yan from the picker; the message carries the name, no id', async () => {
      await createChannel(pageA, { name: channelName, kind: 'public' })
      await openManage(pageA, channelName)
      await addMember(pageA, ZOE_NAME)
      await pageA.getByRole('button', { name: MANAGE.close }).click()
      await expect(channelRow(pageB, channelName)).toBeVisible({ timeout: 60_000 })
      await channelRow(pageB, channelName).click()

      const composer = mainComposer(pageB)
      await composer.click()
      await composer.pressSequentially(`@${YAN_NAME}`)
      await pageB.getByRole('listbox', { name: COMPOSER.mention }).getByRole('option', { name: YAN_NAME, exact: true }).click()
      await composer.pressSequentially(mentionText)
      await pageB.getByRole('main').getByRole('button', { name: COMPOSER.send }).click()
      for (const page of [pageB, pageA]) {
        const r = row(page, mentionText.trim())
        await expect(r).toBeVisible({ timeout: 60_000 })
        await expect(r).toContainText(`${YAN_NAME}${mentionText}`)
        const text = (await r.textContent()) ?? ''
        expect(findProtocolLeaksInText(text), `mention row: ${text}`).toEqual([])
        expect(findProtocolLeaksInText(await r.innerHTML())).toEqual([])
      }
      await expectNoProtocolLeak(pageA, pageB)
    })

    await test.step('7. ↑/↓ history (§25.6): ↑ on an empty composer brings zoe’s own messages, newest first; ↓ and Esc empty it', async () => {
      const second = `de novo ${ts}`
      const composer = mainComposer(pageB)
      await send(pageB, second)
      // A pending message is not in the history (§25.6): wait until it is sent.
      await expect(row(pageB, second)).not.toHaveAttribute('aria-busy', 'true', { timeout: 30_000 })
      await composer.click()
      await pageB.keyboard.press('ArrowUp')
      await expect(composer).toHaveText(second)
      await pageB.keyboard.press('ArrowUp')
      // The mention comes back as its text (H2 a), with no picker over it.
      await expect(composer).toHaveText(`@${YAN_NAME}${mentionText}`)
      await expect(pageB.getByRole('listbox', { name: COMPOSER.mention })).toHaveCount(0)
      await pageB.keyboard.press('ArrowDown')
      await expect(composer).toHaveText(second)
      await pageB.keyboard.press('ArrowDown')
      await expect(composer).toHaveText('')
      await pageB.keyboard.press('ArrowUp')
      await pageB.keyboard.press('Escape')
      await expect(composer).toHaveText('')
      // Sent again, it is a new message, not an edit.
      await pageB.keyboard.press('ArrowUp')
      await pageB.keyboard.press('Enter')
      await expect(messages(pageB).locator('article').filter({ hasText: second })).toHaveCount(2, { timeout: 60_000 })
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
