import { test, expect } from '@playwright/test'
import { GINA } from './fixtures/users'
import { FIRST_LOGIN_404, ForbiddenLines, recognizedSet404 } from './support/console'
import { leaveAppForLogin, loginThroughDex, onApp, pinAppLocale } from './support/login'
import { expectNoProtocolLeak } from './support/assertions'
import { APP, LIST } from './support/labels'

// Fatia 2d-1 (ADR-060): the minimal browser scenario. Login through the Dex upstream (never the MAS
// password form, which production does not have — ADR-048 dec. 4), UI ready, org channel visible,
// reload keeps the session, and the P1 leak-scan over the real DOM of the app origin. One chained
// test: each step depends on the previous one, and a failure stops at the step that broke.

// Network 404s expected on the first login of a brand-new account, plus the recognized-set read of
// ADR-063 (one per app boot of an account with no set, support/console.ts): 2 boots here, the login
// and the reload — the first goto lands on the sign-in screen, no boot. Matched by exact URL or, for
// paths carrying ids, by pattern.
const EXPECTED_404 = [...FIRST_LOGIN_404, ...recognizedSet404(2)]

const isNetwork404 = (text: string): boolean =>
  text.startsWith('Failed to load resource:') && text.includes('status of 404')

test('login through Dex → org channel → reload keeps the session, with no protocol leak', async ({ page }) => {
  // Console errors on the app origin between "UI ready" and the end of the reload. A clean login
  // that logs an error is a finding even though the console is not the DOM. The allowlisted
  // first-login 404s are counted over the WHOLE test (their cap is the total a first login makes)
  // and are never treated as unexpected; anything else in the window fails.
  const consoleErrors: string[] = []
  const expected404s = new Map<string, number>()
  const forbidden = new ForbiddenLines()
  forbidden.watch(page, 'gina')
  let watchConsole = false
  page.on('console', (msg) => {
    if (msg.type() !== 'error' || !onApp(page.url())) return
    const entry = isNetwork404(msg.text())
      ? EXPECTED_404.find((e) => (e.pattern ? e.pattern.test(msg.location().url) : e.url === msg.location().url))
      : undefined
    if (entry) expected404s.set(entry.url, (expected404s.get(entry.url) ?? 0) + 1)
    else if (watchConsole) consoleErrors.push(`${msg.text()} @ ${msg.location().url}`)
  })

  // 1. No session → the SSO entry (label from VITE_SSO_LABEL; BootMessage no-session variant).
  await pinAppLocale(page)
  await page.goto('/')
  const sso = page.getByRole('button', { name: 'Continuar com Dex (local)' })
  await expect(sso).toBeVisible()

  // 2. The whole OIDC round trip through the Dex upstream (stack down → named failure, no skip).
  await leaveAppForLogin(page, sso)
  await loginThroughDex(page, GINA)

  // 3. UI ready. The callback params are gone from the address bar (scrubCallback).
  const title = page.getByRole('heading', { name: APP.title, level: 1 })
  await expect(title).toBeVisible()
  watchConsole = true
  expect(page.url()).not.toContain('code=')
  expect(page.url()).not.toContain('state=')
  await expectNoProtocolLeak(page)

  // 4. The org channel, auto-joined on connect (ADR-044/045).
  const orgChannel = page
    .getByRole('navigation', { name: LIST.nav })
    .getByRole('region', { name: LIST.channels })
    .getByRole('button', { name: LIST.orgChannel })
  await expect(orgChannel).toBeVisible()
  await expectNoProtocolLeak(page)

  // 5. Reload: the persisted session reconnects; no SSO entry this time.
  await page.reload()
  await expect(title).toBeVisible()
  await expect(orgChannel).toBeVisible()
  await expect(page.getByRole('button', { name: /^Continuar com/ })).toHaveCount(0)
  await expectNoProtocolLeak(page)
  watchConsole = false

  expect(consoleErrors).toEqual([])
  forbidden.expectNone()
  for (const { url, max, why } of EXPECTED_404) {
    const seen = expected404s.get(url) ?? 0
    expect(seen, `${url}: ${seen} × 404, above the cap of ${max} (${why})`).toBeLessThanOrEqual(max)
  }
})

// The brand icon is served from the app root, and the browser chrome takes the floor color of the
// applied theme: a fresh context has no stored theme, so light, read back from the page's own CSS.
test('brand icon served at the root; theme-color is the light --color-bg', async ({ page }) => {
  const svg = await page.request.get('/icon.svg')
  expect(svg.status()).toBe(200)
  expect(svg.headers()['content-type']).toContain('image/svg+xml')
  expect((await page.request.get('/favicon.ico')).status()).toBe(200)
  expect((await page.request.get('/apple-touch-icon.png')).status()).toBe(200)

  await page.goto('/')
  await expect(page.locator('html')).not.toHaveAttribute('data-theme')
  const bg = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim(),
  )
  expect(bg).not.toBe('')
  const meta = page.locator('head meta[name="theme-color"]')
  await expect(meta).toHaveCount(1)
  await expect(meta).toHaveAttribute('content', bg)
})
