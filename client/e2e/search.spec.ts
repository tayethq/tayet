import { test, expect } from '@playwright/test'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { QUIM, RITA } from './fixtures/users'
import { ConsoleLedger, FIRST_LOGIN_404, recognizedSet404 } from './support/console'
import { signIn } from './support/login'
import { liftSendLimit } from './support/server-facts'
import { conversations, dmWith, highlighted, messages, search, searchResults, send, startDm, threadPanel } from './support/workspace'
import { expectNoProtocolLeak } from './support/assertions'
import { deleteSharedRooms } from './support/rooms'
import { searchStoreFacts } from './support/search-store'
import { APP, COMPOSER, LIST, NEW_CONVERSATION, SEARCH, THREAD, TIMELINE } from './support/labels'
// ADR-074 + manifest workspace.md §8: local message search, end to end. rita (A) writes; quim (B)
// searches and jumps — the spec's own Dex pair (fixtures/users.ts, one pair per spec). The DM has 35
// messages: rita's 34 (the target FIRST, meant to fall outside the initial sync's 30 after quim reloads —
// measured otherwise, see step 3) and quim's 35th, to which rita replies in a thread (as in
// timeline.spec, the reply is on someone else's root); search finds it and the jump opens the thread
// panel. A term without results shows §8 item 6. The DOM is scanned for protocol ids (P1).
// DOM is scanned for protocol ids (P1).

// Display names as the MAS imported them from the Dex `name` claim (see conversation.spec.ts).
const RITA_NAME = 'rita'
const QUIM_NAME = 'quim'
// 35 = the target + 33 fillers (rita) + the thread root (quim).
const FILLERS = 33

// Before EACH test, not once per file (§8.24 hygiene, per test — §8.57): the quim↔rita DM is reused by
// every test (startDm finds it through m.direct), so a new device in a later test would ask the backup
// for an earlier test's session that never reached it (room_keys 404). Each test creates its own DM.
test.beforeEach(async () => {
  await deleteSharedRooms('quim', 'rita')
})

test('search: find a message, jump to it from another conversation; a thread reply opens its thread', async ({ browser }) => {
  test.setTimeout(240_000)
  const ts = Date.now()
  const target = `alvo${ts} a primeira mensagem da conversa`
  const rootText = `raiz${ts} a última mensagem`
  const replyText = `fio${ts} resposta em thread`

  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  // Boots: rita 1 (login); quim 2 (login, reload in step 3).
  const consoleA = new ConsoleLedger('rita', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  const consoleB = new ConsoleLedger('quim', [...FIRST_LOGIN_404, ...recognizedSet404(2)])
  try {
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()
    consoleA.watch(pageA, 'A')
    consoleB.watch(pageB, 'B')

    await test.step('1. rita and quim log in; rita opens a DM with quim', async () => {
      await signIn(pageA, RITA)
      await signIn(pageB, QUIM)
      // 35 sends in a row exceed the local rc_message burst; rita's account exists now.
      await liftSendLimit('rita')
      await conversations(pageA).getByRole('button', { name: LIST.newDm }).click()
      const dialog = pageA.getByRole('dialog', { name: NEW_CONVERSATION.dialog })
      await dialog.getByRole('button', { name: QUIM_NAME, exact: true }).click()
      await dialog.getByRole('button', { name: NEW_CONVERSATION.startConversation }).click()
      await expect(dialog).toHaveCount(0)
      await dmWith(pageA, QUIM_NAME).click()
      // The invite is auto-joined on quim's side (ADR-044).
      await expect(dmWith(pageB, RITA_NAME)).toBeVisible()
    })

    await test.step('2. rita sends 34 messages, the target first', async () => {
      await send(pageA, target)
      for (let i = 1; i <= FILLERS; i++) await send(pageA, `enchimento ${i} ${ts}`)
    })

    await test.step('3. quim writes the 35th; rita replies to it in a thread; quim sees it and reloads', async () => {
      await dmWith(pageB, RITA_NAME).click()
      // send() only waits for the text on the sender's own screen, so rita's last sends may still be on
      // their way to the server. The root must reach the server after all of them, or it can fall outside
      // the window quim gets after the reload.
      await expect(messages(pageB)).toContainText(`enchimento ${FILLERS} ${ts}`, { timeout: 60_000 })
      await send(pageB, rootText)
      const root = messages(pageA).locator('article').filter({ hasText: rootText })
      await expect(root).toBeVisible({ timeout: 60_000 })
      await root.hover()
      await root.getByRole('button', { name: TIMELINE.replyInThread }).click()
      const panel = threadPanel(pageA)
      await panel.getByRole('textbox', { name: COMPOSER.editor, exact: true }).fill(replyText)
      await panel.getByRole('button', { name: COMPOSER.send }).click()
      await expect(panel.getByRole('log', { name: THREAD.replies })).toContainText(replyText)
      await expect(messages(pageB).getByRole('button', { name: TIMELINE.replies(1) })).toBeVisible({ timeout: 60_000 })
      await pageB.reload()
      await expect(pageB.getByRole('heading', { name: APP.title, level: 1 })).toBeVisible()
      await dmWith(pageB, RITA_NAME).click()
      await expect(messages(pageB)).toContainText(rootText)
      // Measured, not asserted (PLANO-RELEASE-PUBLICA §8.45): the initial /sync brings 30 events (limited),
      // yet the DM's window after the reload varies run to run (29–35 rows here, 70 of 70 in a longer DM) —
      // so whether this jump walks older pages is not deterministic. The bounded walk is proven in
      // test/ui/search-jump.test.tsx.
      console.log(`[e2e] quim's DM window after reload: ${await messages(pageB).locator('article').count()} rows`)
      // Start the jump from another conversation.
      await conversations(pageB).getByRole('region', { name: LIST.channels }).getByRole('button', { name: LIST.orgChannel, exact: true }).click()
    })

    await test.step('4. ⌘K, the term: one hit (author, the term marked; no conversation label on the peer\'s DM hit); the jump highlights it', async () => {
      await search(pageB, `alvo${ts}`)
      const results = searchResults(pageB)
      await expect(results.getByRole('heading', { name: '1 resultado' })).toBeVisible()
      const hit = results.getByRole('button', { name: `${RITA_NAME}: ${target}` })
      // DM: a mensagem do interlocutor omite a conversa (manifest workspace.md §4.7, PR #228)
      await expect(hit).not.toContainText('·')
      await expect(hit.locator('mark')).toHaveText(`alvo${ts}`)
      await hit.click()
      await expect(highlighted(pageB)).toContainText(target, { timeout: 30_000 })
      await expect(highlighted(pageB)).toBeInViewport()
      // The highlight is a pulse: the attribute drops when it ends; the hit stays selected.
      await expect(highlighted(pageB)).toHaveCount(0, { timeout: 10_000 })
      await expect(hit).toHaveAttribute('aria-current', 'true')
      await expect(messages(pageB)).toContainText(target)
    })

    await test.step('5. a thread reply: "em thread"; the jump opens the thread panel, the reply highlighted', async () => {
      await search(pageB, `fio${ts}`)
      const hit = searchResults(pageB).getByRole('button', { name: `${RITA_NAME}: ${replyText}` })
      await expect(hit).toContainText('em thread')
      await hit.click()
      const panel = threadPanel(pageB)
      await expect(panel).toBeVisible({ timeout: 30_000 })
      await expect(panel.locator('article[data-highlight]')).toContainText(replyText)
    })

    await test.step('6. a term without results; P1 over the results and the page', async () => {
      await search(pageB, `nadaaqui${ts}`)
      await expect(searchResults(pageB)).toContainText(`Nada encontrado para “nadaaqui${ts}”`)
      await expect(searchResults(pageB)).toContainText(SEARCH.partial)
      await search(pageB, `alvo${ts}`)
      await expect(searchResults(pageB).getByRole('heading', { name: '1 resultado' })).toBeVisible()
      expect(findProtocolLeaksInText(await searchResults(pageB).innerText())).toEqual([])
      expect(findProtocolLeaksInText(await searchResults(pageB).innerHTML())).toEqual([])
      await expectNoProtocolLeak(pageB)
      // Esc clears and the list comes back.
      await pageB.getByRole('textbox', { name: SEARCH.field }).press('Escape')
      await expect(searchResults(pageB)).toHaveCount(0)
      await expect(conversations(pageB).getByRole('region', { name: LIST.dms })).toBeVisible()
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

// ADR-074 D3: the index persists in the browser's IndexedDB. The discriminating assertion is the read
// of the store (step 2), not the search after the reload: the post-reload window brings recent messages
// back by itself (29–35 rows in a DM of 35, ADR-074 addendum 2026-10-23), so a reload proves nothing
// about persistence — with one message in the DM the target is re-indexed from the sync. Step 3 then
// proves the answer survives a reload in which no history can reach the server (/messages and /context
// aborted). Without step 2's wait the reload raced the write: the #240 probe (28/Oct) measured the CI
// reload 41–67 ms after the target's commit (addendum 2026-10-28; PLANO-RELEASE-PUBLICA §8.63).
test('search index survives a reload with history blocked (ADR-074 D3)', async ({ browser }) => {
  test.setTimeout(180_000)
  await deleteSharedRooms('quim', 'rita')
  const ts = Date.now()
  const target = `alvo${ts} persiste no dispositivo`
  const HISTORY = /\/_matrix\/client\/v3\/rooms\/[^/]+\/(messages|context\/)/

  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  // Boots: rita 1 (login); quim 2 (login, the reload).
  const consoleA = new ConsoleLedger('rita', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  const consoleB = new ConsoleLedger('quim', [...FIRST_LOGIN_404, ...recognizedSet404(2)])
  try {
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()
    consoleA.watch(pageA, 'A')
    consoleB.watch(pageB, 'B')

    await test.step('1. rita writes the target in a DM; quim finds it (it is in the index)', async () => {
      await signIn(pageA, RITA)
      await signIn(pageB, QUIM)
      await startDm(pageA, QUIM_NAME)
      await send(pageA, target)
      await expect(dmWith(pageB, RITA_NAME)).toBeVisible({ timeout: 60_000 })
      // The observable signal that the entry is in the in-memory index: search finds it. The open results
      // list does not re-run its query when a matching message is indexed, and filling the same term
      // again changes nothing, so a first query that ran before the target was indexed would stay empty
      // for every attempt. Each attempt clears the field first: the term goes from empty to the target
      // and the query runs again.
      await expect(async () => {
        await pageB.getByRole('textbox', { name: SEARCH.field }).fill('')
        await search(pageB, `alvo${ts}`)
        await expect(searchResults(pageB).getByRole('heading', { name: '1 resultado' })).toBeVisible({ timeout: 2_000 })
      }).toPass({ timeout: 30_000 })
    })

    await test.step('2. the target is in the device store (IndexedDB), not only in memory', async () => {
      const found = Date.now()
      await expect.poll(async () => (await searchStoreFacts(pageB, `alvo${ts}`)).hit, { timeout: 10_000 }).toBe(true)
      console.log(`[e2e] target in the store ${Date.now() - found} ms after the in-memory hit`)
    })

    await test.step('3. history blocked, quim reloads: the target is still found', async () => {
      // Chromium logs each aborted request as a console error with no HTTP status. The cap comes from
      // the backfill (client/src/acl/internal/search-backfill.ts): a failed history request that is not
      // a rate limit ends that conversation until the next boot, with no retry, so there is at most one
      // aborted request per conversation still pending. quim has two conversations here (the org
      // channel and the DM): 1 when the first boot's backfill already finished the DM before the
      // reload, 2 when it had not.
      const CONVERSATIONS = 2
      consoleB.allow(
        [],
        [{ text: 'Failed to load resource: net::ERR_FAILED', at: HISTORY, max: CONVERSATIONS, why: 'history request aborted by the spec' }],
      )
      // Aborted requests per conversation, keyed by the conversation's path segment (kept in memory only).
      const blocked = new Map<string, number>()
      await pageB.route(HISTORY, (route) => {
        const key = new URL(route.request().url()).pathname.split('/')[5] ?? ''
        blocked.set(key, (blocked.get(key) ?? 0) + 1)
        return route.abort()
      })
      await pageB.reload()
      await expect(pageB.getByRole('heading', { name: APP.title, level: 1 })).toBeVisible()
      await search(pageB, `alvo${ts}`)
      const results = searchResults(pageB)
      await expect(results.getByRole('heading', { name: '1 resultado' })).toBeVisible({ timeout: 30_000 })
      await expect(results.getByRole('button', { name: `${RITA_NAME}: ${target}` })).toBeVisible()
      await expectNoProtocolLeak(pageB)
      await pageB.unroute(HISTORY)
      const counts = [...blocked.values()]
      const total = counts.reduce((a, b) => a + b, 0)
      console.log(`[e2e] history requests aborted after the reload: ${total} in ${counts.length} conversation(s)`)
      // The client does not retry a failed history request, and only quim's conversations ask for history.
      expect(Math.max(0, ...counts), `aborted requests per conversation: ${JSON.stringify(counts)}`).toBeLessThanOrEqual(1)
      expect(counts.length, `conversations with an aborted request: ${counts.length}`).toBeLessThanOrEqual(CONVERSATIONS)
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
