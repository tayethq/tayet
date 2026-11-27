import { expect, type Locator, type Page } from '@playwright/test'
import { accountSettings } from './account'
import { ADMIN, AGENTS, PEOPLE } from './labels'

// The Admin of the organization (PLANO-ADMIN slices 1c and 1d): "Sua conta" → "Administrar organização" opens the
// shell in place of the workspace, always on the Visão geral; "Pessoas" is the navigation's second page. Each row's
// verbs sit in its ⋯ menu.

export const adminNav = (page: Page): Locator => page.getByRole('navigation', { name: ADMIN.nav })
export const peopleTable = (page: Page): Locator => page.getByRole('table', { name: PEOPLE.title })
// The row whose name cell starts with the name (a whole word, or the self row's "(você)"), never a substring of
// another row's text; an agent's cell starts with its avatar's label. A RegExp is the name's pattern, without anchors.
const AGENT_MARK = AGENTS.mark
const escape = (v: string): string => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const namePattern = (name: string | RegExp): string => (typeof name === 'string' ? escape(name) : name.source.replace(/^\^/, ''))
const nameFlags = (name: string | RegExp): string => (typeof name === 'string' ? '' : name.flags)
export const personRow = (page: Page, name: string | RegExp): Locator =>
  peopleTable(page)
    .getByRole('row')
    .filter({ has: page.getByRole('cell', { name: new RegExp(`^(${escape(AGENT_MARK)} )?${namePattern(name)}(\\s|$)`, nameFlags(name)) }) })
// The ⋯ of a row: its accessible name is "Ações para {name}".
const actionsName = (name: string | RegExp): RegExp =>
  new RegExp(`^${escape(ADMIN.actionsFor(''))}${namePattern(name)}(\\s.*)?$`, nameFlags(name))

// Opens the Admin from "Sua conta" and stays on the Visão geral, where it always opens (V3). The row shows once the
// session knows it is an admin (read once per connect).
export async function openAdminOverview(page: Page): Promise<void> {
  const account = await accountSettings(page)
  await expect(account.getByText(PEOPLE.section, { exact: true })).toBeVisible({ timeout: 30_000 })
  await account.getByRole('button', { name: new RegExp(`^${ADMIN.entry}`) }).click()
  await expect(adminNav(page)).toBeVisible()
  await expect(adminNav(page).getByRole('button', { name: ADMIN.overview })).toHaveAttribute('aria-current', 'page')
}

// Opens the Admin (or uses the open one) and goes to "Pessoas", waiting for the people list.
export async function openAdmin(page: Page): Promise<void> {
  if ((await adminNav(page).count()) === 0) await openAdminOverview(page)
  const people = adminNav(page).getByRole('button', { name: PEOPLE.title })
  if ((await people.getAttribute('aria-current')) !== 'page') await people.click()
  await expect(peopleTable(page)).toBeVisible()
}

// The table's rows, without the header.
export const tableRows = (page: Page): Locator => peopleTable(page).locator('[role="rowgroup"] [role="row"]')

// A row's ⋯ → one of its items.
export async function rowAction(page: Page, name: string | RegExp, item: string): Promise<void> {
  await openRowMenu(page, name)
  await page.getByRole('menu', { name: actionsName(name) }).getByRole('menuitem', { name: item }).click()
}

export async function openRowMenu(page: Page, name: string | RegExp): Promise<Locator> {
  await page.getByRole('button', { name: actionsName(name) }).click()
  const menu = page.getByRole('menu', { name: actionsName(name) })
  await expect(menu).toBeVisible()
  return menu
}

export async function closeAdmin(page: Page): Promise<void> {
  await page.getByRole('button', { name: ADMIN.back }).click()
  await expect(adminNav(page)).toHaveCount(0)
}
