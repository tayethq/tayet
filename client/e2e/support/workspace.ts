import { expect, type Locator, type Page } from '@playwright/test'
import { escapeRegExp } from '../../test/support/stack-env'
import { APP, COMPOSER, GROUP, LIST, NEW_CONVERSATION, SEARCH, THREAD, TIMELINE } from './labels'

// Locators and actions on the Workspace, by role and text as the user sees them (ADR-060 D3).

export const title = (page: Page) => page.getByRole('heading', { name: APP.title, level: 1 })
export const messages = (page: Page) => page.getByRole('log', { name: TIMELINE.log })
export const conversations = (page: Page) => page.getByRole('navigation', { name: LIST.nav })
// The unread badge joins the accessible name, so the name is anchored at the start (as in channelRow).
export const orgChannel = (page: Page) =>
  conversations(page)
    .getByRole('region', { name: LIST.channels })
    .getByRole('button', { name: new RegExp(`^${escapeRegExp(LIST.orgChannel)}(\\s|$)`) })
// A DM row is named by the peer's display name (ChannelList DmRow), followed by the unread badge when
// there is one ("frank 1 unread") — so the name is anchored at the start, not matched exactly.
export const dmWith = (page: Page, peer: string) =>
  conversations(page)
    .getByRole('region', { name: LIST.dms })
    .getByRole('button', { name: new RegExp(`^${peer}(\\s|$)`) })
// A group row of "Mensagens diretas" (ChannelList GroupRow): the block's name ("Conversa em grupo, 3
// participantes"), then the other people's names as the list reads them (ordered by name, comma-separated),
// then the unread badge if any — so the name is anchored at the start.
export const groupWith = (page: Page, others: string[]) =>
  conversations(page)
    .getByRole('region', { name: LIST.dms })
    .getByRole('button', {
      name: new RegExp(`^${escapeRegExp(GROUP.block(others.length + 1))} ${escapeRegExp([...others].sort().join(', '))}(\\s|$)`),
    })
// A channel row of "Canais", by its name without the '#': a public one reads "#name", a private one
// swaps the '#' for the lock named "Canal privado" (ChannelLabel.tsx) — then the unread badge, if any.
export const channelRow = (page: Page, name: string) =>
  conversations(page)
    .getByRole('region', { name: LIST.channels })
    .getByRole('button', { name: new RegExp(`^(#|${LIST.privateMark} )${escapeRegExp(name)}(\\s|$)`) })
// The row of a message, by its text (the <article> of MessageRow).
export const row = (page: Page, text: string) => messages(page).locator('article').filter({ hasText: text })
// The main composer: TipTap's contenteditable with aria-label "Message" and no ARIA role (a
// contenteditable has no implicit one), so it is located by its accessible name, not as a textbox
// (§8.9 finding). Scoped to `main`: with the thread panel open there is a second one.
export const mainComposer = (page: Page) => page.getByRole('main').getByRole('textbox', { name: COMPOSER.editor, exact: true })

export async function send(page: Page, text: string): Promise<void> {
  await mainComposer(page).fill(text)
  await page.getByRole('main').getByRole('button', { name: COMPOSER.send }).click()
  await expect(messages(page)).toContainText(text)
}

// A DM from the known-set picker (ADR-029 dec. 3), then open it. The contact list is read when the
// dialog opens; the peer's first-login join of the org channel (ADR-045) may reach this client a moment
// later, so the dialog is reopened until the peer is in it.
export async function startDm(page: Page, peer: string): Promise<void> {
  const dialog = page.getByRole('dialog', { name: NEW_CONVERSATION.dialog })
  const contact = dialog.getByRole('button', { name: peer, exact: true })
  await expect(async () => {
    if ((await dialog.count()) > 0) await dialog.getByRole('button', { name: NEW_CONVERSATION.cancel }).click()
    await conversations(page).getByRole('button', { name: LIST.newDm }).click()
    await expect(contact).toBeVisible({ timeout: 5_000 })
  }).toPass({ timeout: 60_000 })
  await contact.click()
  await expect(contact).toHaveAttribute('aria-pressed', 'true')
  await dialog.getByRole('button', { name: NEW_CONVERSATION.startConversation }).click()
  await expect(dialog).toHaveCount(0)
  await dmWith(page, peer).click()
}

// Search (manifest workspace.md §8): ⌘K/Ctrl+K focuses the field, the term goes in, and the results
// region takes the place of the list's sections.
export const searchResults = (page: Page) => page.getByRole('region', { name: SEARCH.results })
export const threadPanel = (page: Page) => page.getByRole('complementary', { name: THREAD.panel })
// The row a search jump reached — in the timeline or in the thread — while its highlight lasts.
export const highlighted = (page: Page) => page.locator('article[data-highlight]')

export async function search(page: Page, term: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+k')
  const field = page.getByRole('textbox', { name: SEARCH.field })
  await expect(field).toBeFocused()
  await field.fill(term)
  await expect(searchResults(page)).toBeVisible()
}

// The number a conversation row speaks, read from its accessible name ("cid 4 não lidas", "cid 2
// menções"; no mark, no suffix → 0). Its unread mark is the only place the number is spoken
// (ChannelList.tsx): the dot's label says the unread count, the pill's the mentions (§13 item 5).
export async function unreadOf(row: Locator): Promise<number> {
  const snapshot = await row.ariaSnapshot()
  const name = /^- button "(.*)"/m.exec(snapshot)?.[1] ?? ''
  const m = LIST.unreadSuffix.exec(name) ?? LIST.mentionsSuffix.exec(name)
  return m ? Number(m[1]) : 0
}
