import { expect, type Locator, type Page } from '@playwright/test'
import { MAS_URL } from '../../test/support/stack-env'
import type { E2eUser } from '../fixtures/users'
import { ACCOUNT, APP, PROFILE, PROFILE_EDITOR, SESSION } from './labels'
import { leaveAppForLogin, loginThroughDex, onApp } from './login'
import { title } from './workspace'

// The account's own session gestures, as the user does them.

// Sign-out from the account dialog (ADR-062 D1: revokes this session at the issuer, wipes the store).
// It lands on the access-ended screen (ADR-034), whose action is "Entrar de novo".
export async function signOutHere(page: Page): Promise<void> {
  await page.getByRole('button', { name: APP.account }).click()
  await page.getByRole('button', { name: SESSION.signOut }).click()
  await expect(page.getByRole('button', { name: SESSION.signInAgain })).toBeVisible()
}

// Back in after a sign-out. The MAS browser session survives the sign-out (D1 revokes the OAuth
// session, not the browser one), so the MAS may send the browser straight back, show the consent, or
// ask for the Dex — all three are handled.
export async function signInAgain(page: Page, user: E2eUser): Promise<void> {
  await leaveAppForLogin(page, page.getByRole('button', { name: SESSION.signInAgain }))
  const dex = page.getByRole('link', { name: 'Continuar com a conta da empresa (local)' })
  for (;;) {
    await page.waitForURL(
      (u) => onApp(u.href) || /\/login$/.test(u.pathname) || /\/consent\//.test(u.pathname) || /\/upstream\/link\//.test(u.pathname),
    )
    const url = new URL(page.url())
    if (onApp(url.href)) break
    if (/\/login$/.test(url.pathname) && (await dex.isVisible())) {
      await loginThroughDex(page, user)
      break
    }
    if (/\/consent\//.test(url.pathname)) await page.getByRole('button', { name: 'Continuar', exact: true }).click()
    else if (/\/upstream\/link\//.test(url.pathname)) await page.getByRole('button', { name: 'Create Account' }).click()
  }
  await expect(title(page)).toBeVisible()
}

// Back in after a sign-out WITHOUT credentials (ADR-034: the sign-out is of this browser only, so the
// issuer's browser session takes it straight back). Every main-frame navigation is recorded: none may
// leave {app, MAS} — the Dex is the credential step — and the password field must never show. The
// MAS consent page ("Continuar", the Tayet template) is acceptable; the MAS login page is not (it is the credential ask).
// Fails loudly instead of logging in: a re-login that asks for the password is the finding, never a
// step to get past.
export async function signInAgainSilently(page: Page): Promise<string[]> {
  const visited: string[] = []
  const record = (frame: { url(): string }) => {
    if (frame === page.mainFrame()) visited.push(frame.url())
  }
  page.on('framenavigated', record)
  const password = page.getByLabel('Password')
  try {
    await leaveAppForLogin(page, page.getByRole('button', { name: SESSION.signInAgain }))
    for (;;) {
      await page.waitForURL((u) => onApp(u.href) || u.origin !== MAS_URL || /\/(login|consent\/[^/]+)$/.test(u.pathname))
      const url = new URL(page.url())
      if (onApp(url.href)) break
      expect(url.origin, `re-login left the app and the MAS: ${url.href}`).toBe(MAS_URL)
      expect(url.pathname, `re-login asked for credentials: ${url.href}`).not.toMatch(/\/login$/)
      expect(await password.count(), `password field on ${url.href}`).toBe(0)
      await page.getByRole('button', { name: 'Continuar', exact: true }).click()
    }
    await expect(title(page)).toBeVisible()
  } finally {
    page.off('framenavigated', record)
  }
  const outside = visited.filter((u) => u !== 'about:blank' && !onApp(u) && new URL(u).origin !== MAS_URL)
  expect(outside, `re-login navigated outside {app, MAS}: ${visited.join(' → ')}`).toEqual([])
  return visited
}

// The account dialog ("Sua conta"), opened from the shell.
export async function accountSettings(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: APP.account }).click()
  const dialog = page.getByRole('dialog', { name: ACCOUNT.dialog })
  await expect(dialog).toBeVisible()
  return dialog
}

// "Sua conta" → "Editar" → the profile editor, loaded (its fields show once the profile is read).
// Reuses the editor when it is already open. Escape in the editor steps BACK to "Sua conta" (it is a
// drill-in), so the editor is left with closeAccount, never with Escape.
export async function openProfileEditor(page: Page): Promise<Locator> {
  const editor = page.getByRole('dialog', { name: PROFILE_EDITOR.dialog })
  if ((await editor.count()) === 0) {
    const account = page.getByRole('dialog', { name: ACCOUNT.dialog })
    if ((await account.count()) === 0) await accountSettings(page)
    await account.getByRole('button', { name: ACCOUNT.edit, exact: true }).click()
  }
  await expect(editor.getByLabel(PROFILE_EDITOR.nickname, { exact: true })).toBeVisible()
  return editor
}

// Close the account surface, whichever of its views is open ("Fechar" closes them all).
export async function closeAccount(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog')
  if ((await dialog.count()) > 0) await dialog.getByRole('button', { name: ACCOUNT.close, exact: true }).click()
  await expect(dialog).toHaveCount(0)
}

// Edit nickname / pronouns / note and save (explicit "Salvar" → "✓ Salvo"). The editor stays open:
// the photo gestures below act on it.
export async function editProfile(page: Page, fields: { nick?: string; pronouns?: string; note?: string }): Promise<Locator> {
  const editor = await openProfileEditor(page)
  if (fields.nick !== undefined) await editor.getByLabel(PROFILE_EDITOR.nickname, { exact: true }).fill(fields.nick)
  if (fields.pronouns !== undefined) await editor.getByLabel(PROFILE_EDITOR.pronouns, { exact: true }).fill(fields.pronouns)
  if (fields.note !== undefined) await editor.getByLabel(PROFILE_EDITOR.note, { exact: true }).fill(fields.note)
  await editor.getByRole('button', { name: PROFILE_EDITOR.save, exact: true }).click()
  await expect(editor.getByRole('status')).toHaveText(PROFILE_EDITOR.saved)
  return editor
}

// The photo, from the open profile editor: "Adicionar foto"/"Trocar" opens the system file chooser and
// uploads on pick (no "Salvar"); done when the button reads "Trocar" again.
export async function setPhoto(page: Page, bytes: Buffer): Promise<void> {
  const editor = page.getByRole('dialog', { name: PROFILE_EDITOR.dialog })
  const pick = editor.getByRole('button', { name: new RegExp(`^(${PROFILE_EDITOR.addPhoto}|${PROFILE_EDITOR.changePhoto})$`) })
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), pick.click()])
  await chooser.setFiles({ name: 'foto.png', mimeType: 'image/png', buffer: bytes })
  await expect(editor.getByRole('button', { name: PROFILE_EDITOR.changePhoto, exact: true })).toBeEnabled({ timeout: 30_000 })
}

// "Remover" clears it on the spot; done when the button reads "Adicionar foto".
export async function removePhoto(page: Page): Promise<void> {
  const editor = page.getByRole('dialog', { name: PROFILE_EDITOR.dialog })
  await editor.getByRole('button', { name: PROFILE_EDITOR.removePhoto, exact: true }).click()
  await expect(editor.getByRole('button', { name: PROFILE_EDITOR.addPhoto, exact: true })).toBeEnabled({ timeout: 30_000 })
}

// Someone else's profile, from the first "Ver perfil de <name>" on screen (a message's author or a
// roster row). Returns the "Perfil" dialog.
export async function openProfileOf(page: Page, name: string): Promise<Locator> {
  await page.getByRole('button', { name: PROFILE.open(name), exact: true }).first().click()
  const dialog = page.getByRole('dialog', { name: PROFILE.dialog })
  await expect(dialog).toBeVisible()
  return dialog
}
