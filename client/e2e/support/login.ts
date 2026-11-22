import { expect, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { APP_URL, HS_URL, MAS_URL } from '../../test/support/stack-env'
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

// The language of the MAS pages: the Tayet templates follow the browser's Accept-Language, pt-BR for
// "pt…" and English for anything else (ADR-109). `pinAppLocale` sets that header, so a context pinned
// to pt-BR gets the pt-BR pages and one pinned to en-US the English ones. The stock upstream link page
// is translated by the MAS itself ("Criar Conta" is its pt-BR); the Dex pages are English only.
export type MasLanguage = 'pt-BR' | 'en'

export const MAS_LABELS: Record<MasLanguage, { continueWith: (name: string) => string; continue: string; createAccount: string }> = {
  'pt-BR': { continueWith: (name) => `Continuar com ${name}`, continue: 'Continuar', createAccount: 'Criar Conta' },
  en: { continueWith: (name) => `Continue with ${name}`, continue: 'Continue', createAccount: 'Create Account' },
}

// Which entry of the MAS login page to take: both providers run on the same Dex (dev-stack README).
// The names are the `human_name` of mas/config.yaml; the page is the Tayet template (ADR-084). The
// test stack's names are shown as written in both languages. `masLanguage` is the language the MAS
// pages come in, pt-BR by default (the default of `pinAppLocale`).
export interface LoginOptions {
  provider?: 'a conta da empresa (local)' | 'Google (simulado)'
  masLanguage?: MasLanguage
}

// MAS /login → "Continuar com a conta da empresa (local)" → Dex password DB → back to MAS → app. On the FIRST login
// of the user, MAS shows the upstream link page and the account is born there ("Criar Conta",
// ADR-048); later logins skip it. The consent page may or may not show.
export async function loginThroughDex(
  page: Page,
  user: E2eUser,
  { provider = 'a conta da empresa (local)', masLanguage = 'pt-BR' }: LoginOptions = {},
): Promise<void> {
  const mas = MAS_LABELS[masLanguage]
  await page.getByRole('link', { name: mas.continueWith(provider) }).click()
  await page.getByLabel('Email Address').fill(user.email)
  await page.getByLabel('Password').fill(user.password)
  await page.getByRole('button', { name: 'Login' }).click()

  const linkPage = /\/upstream\/link\//
  const consentPage = /\/consent\//
  for (;;) {
    await page.waitForURL((u) => onApp(u.href) || linkPage.test(u.pathname) || consentPage.test(u.pathname))
    const url = new URL(page.url())
    if (onApp(url.href)) return
    if (linkPage.test(url.pathname)) await page.getByRole('button', { name: mas.createAccount }).click()
    else await page.getByRole('button', { name: mas.continue, exact: true }).click()
  }
}

// Every request of the context carries `language` as Accept-Language. The extra headers alone are not
// enough: the test runner emulates its own `locale` (en-US by default), and on navigations that wins
// over the extra headers, so the MAS pages, which pick their language from it (ADR-109), would get
// en-US. So the login requests also get the header by route: every origin but the app's and the
// homeserver's (the MAS, and the Dex, whose redirects back to the MAS keep the header they were sent
// with). `route.fallback` keeps any route a spec adds. The route is registered once per context and
// sends the language set last, so calling this again (a nested beforeEach) changes the language.
const contextLanguage = new WeakMap<BrowserContext, string>()
const UNROUTED = new Set([new URL(APP).origin, new URL(HS_URL).origin])

export async function setAcceptLanguage(context: BrowserContext, language: string): Promise<void> {
  await context.setExtraHTTPHeaders({ 'Accept-Language': language })
  const routed = contextLanguage.has(context)
  contextLanguage.set(context, language)
  if (routed) return
  await context.route(
    (url) => !UNROUTED.has(url.origin),
    (route) =>
      route.fallback({ headers: { ...route.request().headers(), 'accept-language': contextLanguage.get(context) ?? language } }),
  )
}

// Pins the language of the context: navigator.languages and navigator.language report `language` on
// every page of the context (and its reloads), so the app resolves it as a browser in that language
// would, and every request carries it as Accept-Language (setAcceptLanguage), so the MAS login pages
// come in it too (ADR-109; pass the matching `masLanguage` to the helpers above). Playwright's `locale`
// option is not used. Nothing is written to the app's storage. Call it before the context's first
// navigation.
export async function pinAppLocale(page: Page, language = 'pt-BR'): Promise<void> {
  await setAcceptLanguage(page.context(), language)
  await page.context().addInitScript((tag: string) => {
    Object.defineProperty(navigator, 'languages', { get: () => [tag], configurable: true })
    Object.defineProperty(navigator, 'language', { get: () => tag, configurable: true })
  }, language)
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
