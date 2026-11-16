import { expect, type Page } from '@playwright/test'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { PLACEHOLDER_TEXTS, SESSION } from './labels'
import { onApp } from './login'
import { messages } from './workspace'

// Assertions the specs of the browser E2E tier share.

// What the user sees when a message has not been decrypted yet / could not be (Timeline.tsx).
export const PLACEHOLDERS: ReadonlyArray<string> = PLACEHOLDER_TEXTS

// The neutral screen of a tab that does not hold the tab lock (ADR-065 D3).
export const ELSEWHERE = SESSION.elsewhere

// P1 over the rendered document of each page: no protocol id anywhere (leak-scan), on the APP origin
// only. MAS and Dex pages are third-party surfaces with their own vocabulary ("Matrix ID" on the MAS
// account page) and are out of scope by design.
export async function expectNoProtocolLeak(...pages: Page[]): Promise<void> {
  for (const page of pages) {
    expect(onApp(page.url()), `leak-scan outside the app origin: ${page.url()}`).toBe(true)
    expect(findProtocolLeaksInText(await page.content())).toEqual([])
  }
}

// The given texts are on screen, and nothing from the first of them onward is a placeholder. Earlier
// history is out of scope: locally a conversation may hold what earlier runs wrote.
export async function expectReadable(page: Page, ...texts: string[]): Promise<void> {
  await expectReadableWithin(page, undefined, ...texts)
}

// The same, waiting up to `timeout` ms for each text (a key that arrives late: ADR-077).
export async function expectReadableWithin(page: Page, timeout: number | undefined, ...texts: string[]): Promise<void> {
  for (const t of texts) await expect(messages(page)).toContainText(t, { timeout })
  const all = await messages(page).innerText()
  const fromThisRun = all.slice(all.indexOf(texts[0]!))
  for (const p of PLACEHOLDERS) expect(fromThisRun, `placeholder after "${texts[0]}"`).not.toContain(p)
}
