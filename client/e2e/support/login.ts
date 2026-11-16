import { expect, type Locator, type Page } from '@playwright/test'
import { APP_URL, MAS_URL } from '../../test/support/stack-env'
import type { E2eUser } from '../fixtures/users'

// Login helpers of the browser E2E tier (ADR-060) — tier code, not harness: they drive the real
// pages (app, MAS, Dex) as the user does. Login is always through the Dex upstream, never the MAS
// password form, which production does not have (ADR-048 dec. 4).

export const APP = APP_URL
const MAS = MAS_URL

export const onApp = (url: string): boolean => url === APP || url.startsWith(`${APP}/`)

// Click an SSO entry of the app ("Continuar com Dex (local)", "Entrar de novo") and wait until the
// browser leaves for the MAS. When the stack is down the Boot renders its alert instead (the
// server discovery is the first network touch); racing the two turns "stack down" into an
// immediate, named failure instead of a timeout on a MAS element that never comes. No auto-skip.
export async function leaveAppForLogin(page: Page, ssoEntry: Locator): Promise<void> {
  await ssoEntry.click()
  const bootAlert = page.getByRole('alert')
  await Promise.race([page.waitForURL((u) => u.origin === MAS), bootAlert.waitFor()])
  if (onApp(page.url())) {
    throw new Error(`login never left the app — dev-stack unreachable? Boot shows: "${await bootAlert.innerText()}"`)
  }
}

// Which entry of the MAS login page to take: both providers run on the same Dex (dev-stack README).
// The names are the `human_name` of mas/config.yaml; the page is the Tayet template (ADR-084).
export interface LoginOptions {
  provider?: 'a conta da empresa (local)' | 'Google (simulado)'
}

// MAS /login → "Continuar com a conta da empresa (local)" → Dex password DB → back to MAS → app. On the FIRST login
// of the user, MAS shows the upstream link page and the account is born there ("Create Account",
// ADR-048); later logins skip it. The consent page may or may not show.
export async function loginThroughDex(
  page: Page,
  user: E2eUser,
  { provider = 'a conta da empresa (local)' }: LoginOptions = {},
): Promise<void> {
  await page.getByRole('link', { name: `Continuar com ${provider}` }).click()
  await page.getByLabel('Email Address').fill(user.email)
  await page.getByLabel('Password').fill(user.password)
  await page.getByRole('button', { name: 'Login' }).click()

  const linkPage = /\/upstream\/link\//
  const consentPage = /\/consent\//
  for (;;) {
    await page.waitForURL((u) => onApp(u.href) || linkPage.test(u.pathname) || consentPage.test(u.pathname))
    const url = new URL(page.url())
    if (onApp(url.href)) return
    if (linkPage.test(url.pathname)) await page.getByRole('button', { name: 'Create Account' }).click()
    else await page.getByRole('button', { name: 'Continuar', exact: true }).click()
  }
}

// Pins the APP's locale, not the browser's (ADR-080 D5): `tayet.locale` is the per-device override the
// app reads before navigator.language (D2) — the mechanism a real user has. The browser keeps the
// runner's locale: Playwright's `locale` also sets Accept-Language, which localizes the MAS and Dex
// pages, third-party copy the login helpers above drive in English. Context-wide, so every page of
// the context (and its reloads) boots with it; call it before the context's first navigation.
export async function pinAppLocale(page: Page): Promise<void> {
  await page.context().addInitScript(() => {
    try {
      localStorage.setItem('tayet.locale', 'pt-BR')
    } catch {
      // Storage blocked: the app falls back to navigator.language, then pt-BR.
    }
  })
}

// The whole thing from a fresh page: `/` → SSO entry → Dex → app ready (h1 "Tayet").
export async function signIn(page: Page, user: E2eUser, options: LoginOptions = {}): Promise<void> {
  await pinAppLocale(page)
  await page.goto('/')
  const sso = page.getByRole('button', { name: 'Continuar com Dex (local)' })
  await expect(sso).toBeVisible()
  await leaveAppForLogin(page, sso)
  await loginThroughDex(page, user, options)
  await expect(page.getByRole('heading', { name: 'Tayet', level: 1 })).toBeVisible()
}
