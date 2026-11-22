import { createHash, randomBytes } from 'node:crypto'
import { test, expect, type Page } from '@playwright/test'
import { MAS_URL, SPA_CLIENT_ID, SPA_REDIRECT } from '../test/support/stack-env'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { killSessionsOrThrow } from '../test/support/synapse-admin'
import { ADA, BEA, FAL, type E2eUser } from './fixtures/users'
import { MAS_LABELS, pinAppLocale, setAcceptLanguage, type MasLanguage } from './support/login'
import { profileFacts, setDisplayName } from './support/server-facts'

// P4-1 (ADR-084, Conformidade): a escolha de provedor do MAS é o template próprio, não o stock.
// Copy literal do login-onboarding.md §8; o dev-stack tem dois provedores, então a página aparece
// (com um provedor e senha desligada o MAS redireciona direto, PLANO-PESSOAS §0.4). A copy é literal
// nas duas línguas e a língua vem do Accept-Language (ADR-109): "pt…" dá pt-BR, todo o resto dá inglês
// (login-onboarding.md §11); a página de erro que o MAS manda sem idioma escolhe a língua pelo navigator,
// num script na página (ADR-109, decisão 3). Os testes de cima mandam pt-BR, como o browser de um usuário brasileiro; o
// bloco de baixo manda en-US, e dois testes de língua mandam fr e pt-PT. O cabeçalho vai pelo
// `setAcceptLanguage` (support/login.ts), não pelo `extraHTTPHeaders` do `test.use`: na navegação, o `locale`
// do runner (en-US) vence o `extraHTTPHeaders`.

test.beforeEach(async ({ page }) => {
  await setAcceptLanguage(page.context(), 'pt-BR')
})

test('MAS /login is the Tayet page: §8 copy, Google icon only, no protocol identifier', async ({ page }) => {
  await page.goto(`${MAS_URL}/login`)

  await expect(page).toHaveTitle('Tayet')
  await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR')
  await expect(page.getByRole('heading', { name: 'Entre no Tayet', level: 1 })).toBeVisible()
  await expect(page.getByText('Escolha como você entra.')).toBeVisible()
  await expect(page.getByText('Você vai até o provedor e volta para o Tayet automaticamente.')).toBeVisible()

  // Um link por provedor, na ordem do config (§8 item 2): o da casa primeiro, sem ícone; o Google
  // com o asset oficial (§8 item 3).
  const company = page.getByRole('link', { name: 'Continuar com a conta da empresa (local)' })
  const google = page.getByRole('link', { name: 'Continuar com Google (simulado)' })
  await expect(company).toBeVisible()
  await expect(google).toBeVisible()
  await expect(company.locator('svg')).toHaveCount(0)
  await expect(google.locator('svg')).toHaveCount(1)
  const providerLinks = page.getByRole('link', { name: /^Continuar com / })
  await expect(providerLinks.first()).toHaveAccessibleName('Continuar com a conta da empresa (local)')

  // Nada do stock: nem a casca Compound, nem a copy inglesa.
  const html = await page.content()
  expect(html).not.toContain('cpd-button')
  expect(html).not.toContain('Continue with')
  // P1 (§8 item 6): nenhum mxid nem outro identificador de protocolo no HTML inteiro.
  expect(findProtocolLeaksInText(html)).toEqual([])

  // Ícone da marca embutido e a cor do chrome do tema claro, em toda página do MAS.
  await expect(page.locator('head link[rel="icon"]')).toHaveAttribute('href', /^data:image\/svg\+xml;base64,/)
  const bg = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--color-bg').trim(),
  )
  expect(bg).not.toBe('')
  await expect(page.locator('head meta[name="theme-color"]')).toHaveAttribute('content', bg)
})

// P4-2 (ADR-084 dec. 1): consentimento, erro e saída do MAS são templates próprios em pt-BR, sem mxid.
// Copy literal do login-onboarding.md §9 (com as adjudicações do §0-lite, PLANO-PESSOAS §8.6). Uma
// sonda por página (fixtures/users.ts): ada (consentimento), fal (guard, nunca entra), bea (saída).

const b64url = (b: Buffer): string => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

// /authorize do SPA, como o client pede (PKCE S256). O código nunca é trocado: o spec para no MAS.
function authorizeUrl(): string {
  const challenge = b64url(createHash('sha256').update(b64url(randomBytes(32))).digest())
  const device = b64url(randomBytes(8)).slice(0, 10)
  return `${MAS_URL}/authorize?${new URLSearchParams({
    client_id: SPA_CLIENT_ID,
    response_type: 'code',
    redirect_uri: SPA_REDIRECT,
    scope: `openid urn:matrix:org.matrix.msc2967.client:api:* urn:matrix:org.matrix.msc2967.client:device:${device}`,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state: b64url(randomBytes(8)),
  }).toString()}`
}

async function dexCredentials(page: Page, user: E2eUser): Promise<void> {
  await page.getByLabel('Email Address').fill(user.email)
  await page.getByLabel('Password').fill(user.password)
  await page.getByRole('button', { name: 'Login' }).click()
}

// /authorize → (sem sessão de browser: a página de provedor → Dex → vínculo no 1º login) → /consent/<grant>.
// `lang`: a língua das páginas do MAS, a do Accept-Language do teste.
async function reachConsent(page: Page, user: E2eUser, lang: MasLanguage = 'pt-BR'): Promise<void> {
  const mas = MAS_LABELS[lang]
  await page.goto(authorizeUrl())
  for (;;) {
    await page.waitForURL((u) => u.origin !== MAS_URL || /^\/(login|consent\/[^/]+|upstream\/link\/[^/]+)$/.test(u.pathname))
    const url = new URL(page.url())
    if (url.origin !== MAS_URL) {
      await dexCredentials(page, user)
      continue
    }
    if (/^\/consent\//.test(url.pathname)) return
    if (url.pathname === '/login') await page.getByRole('link', { name: mas.continueWith('a conta da empresa (local)') }).click()
    else await page.getByRole('button', { name: mas.createAccount }).click()
  }
}

const stockError = /Unexpected error|Session terminated|Sessão terminada|cpd-text/

test('MAS consent, comNome: the person by display name, no protocol identifier', async ({ page }) => {
  await reachConsent(page, ADA) // garante a conta (1º login nasce aqui) antes de mexer no perfil
  const original = (await profileFacts('ada')).displayName ?? ''
  try {
    await setDisplayName('ada', 'Ada Sonda')
    await page.reload()

    await expect(page).toHaveTitle('Tayet')
    await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR')
    await expect(page.getByRole('heading', { name: 'Entre no Tayet', level: 1 })).toBeVisible()
    await expect(page.getByText('Confirme a conta que você vai usar.')).toBeVisible()
    await expect(page.getByText('Ada Sonda', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Continuar', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Entrar com outra conta' })).toBeVisible()
    const cancel = page.getByRole('link', { name: 'Cancelar', exact: true })
    await expect(cancel).toBeVisible()
    await expect(cancel).toHaveAttribute('href', /error=access_denied/)
    await expect(page.getByText('Você volta para o Tayet automaticamente.')).toBeVisible()

    const html = await page.content()
    expect(html).not.toMatch(stockError)
    expect(html).not.toContain('Continue to')
    expect(html).not.toMatch(/@[^\s"<]*:/)
    expect(html).not.toMatch(/\bu-[a-z0-9]/i)
    // Nem o username: "ada" só existe dentro de "Ada Sonda".
    const text = await page.locator('body').innerText()
    expect(text.replace(/Ada Sonda/g, '')).not.toMatch(/\bada\b/i)
    expect(findProtocolLeaksInText(html)).toEqual([])
  } finally {
    await setDisplayName('ada', original)
  }
})

test('MAS consent, semNome: "Sua conta", never the username', async ({ page }) => {
  await reachConsent(page, ADA)
  const original = (await profileFacts('ada')).displayName ?? ''
  try {
    await setDisplayName('ada', '')
    await page.reload()

    await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR')
    await expect(page.getByRole('heading', { name: 'Entre no Tayet', level: 1 })).toBeVisible()
    await expect(page.getByText('Sua conta', { exact: true })).toBeVisible()
    const text = await page.locator('body').innerText()
    expect(text).not.toMatch(/\bada\b/i)
    const html = await page.content()
    expect(html).not.toMatch(/@[^\s"<]*:/)
    expect(findProtocolLeaksInText(html)).toEqual([])
  } finally {
    await setDisplayName('ada', original)
  }
})

// Os erros de página abaixo chegam sem idioma mesmo com o cabeçalho pt-BR: o MAS 1.27.0 os monta no
// `GenericError` (crates/axum-utils/src/fancy_error.rs, `build_context`), que cria o `ErrorContext` sem
// `with_language`. Sem idioma, o `error.html` leva as duas línguas e um script na página mostra a que casa
// com o `navigator.languages` (ADR-109, decisão 3); sem JavaScript, as duas, pt-BR primeiro. Por isso estes
// testes fixam o navigator e o cabeçalho juntos (`pinAppLocale`), não só o cabeçalho.
const ERROR_COPY = {
  'pt-BR': {
    guard: [
      'Não conseguimos confirmar seu email',
      'O provedor informou que o email da sua conta ainda não foi confirmado. Confirme o email lá e tente entrar de novo.',
    ],
    generic: [
      'Não foi possível entrar',
      'Algo deu errado ao entrar no Tayet. Tente de novo; se continuar, fale com quem administra sua organização.',
    ],
    retry: 'Tentar de novo',
    details: 'Detalhes técnicos',
  },
  en: {
    guard: [
      "We couldn't confirm your email",
      "The provider reported that your account's email hasn't been confirmed yet. Confirm it there and try signing in again.",
    ],
    generic: [
      "Couldn't sign in",
      'Something went wrong signing in to Tayet. Try again; if it keeps happening, talk to whoever manages your organization.',
    ],
    retry: 'Try again',
    details: 'Technical details',
  },
} as const

type ErrorKind = 'guard' | 'generic'

// The copy of `language` for the page: present once each, in the DOM.
function errorCopy(page: Page, language: MasLanguage, kind: ErrorKind) {
  const c = ERROR_COPY[language]
  const [heading, body] = c[kind]
  return {
    heading: page.getByRole('heading', { name: heading, level: 1, includeHidden: true }),
    body: page.getByText(body, { exact: true }),
    retry: page.getByRole('link', { name: c.retry, exact: true, includeHidden: true }),
    details: page.locator('details summary').getByText(c.details, { exact: true }),
  }
}

// A no-language error page with the script run: `shown` visible, the other language in the HTML but
// hidden, <html lang> set to `shown`, the technical details once and collapsed, and P1.
async function expectErrorIn(page: Page, shown: MasLanguage, kind: ErrorKind, detail: string): Promise<void> {
  const hidden: MasLanguage = shown === 'pt-BR' ? 'en' : 'pt-BR'
  await expect(page).toHaveTitle('Tayet')
  await expect(page.locator('html')).toHaveAttribute('lang', shown)
  const on = errorCopy(page, shown, kind)
  const off = errorCopy(page, hidden, kind)
  for (const l of Object.values(on)) await expect(l).toBeVisible()
  for (const l of Object.values(off)) {
    await expect(l).toHaveCount(1)
    await expect(l).toBeHidden()
  }
  await expect(on.retry).toHaveAttribute('href', '/login')
  const details = page.locator('details')
  await expect(details).toHaveCount(1)
  await expect(details).not.toHaveAttribute('open')
  await expect(details).toContainText(detail)
  await expect(details.locator('div')).toBeHidden()

  const html = await page.content()
  expect(html).not.toMatch(stockError)
  expect(findProtocolLeaksInText(html)).toEqual([])
}

async function reachEmailGuard(page: Page, masLanguage: MasLanguage): Promise<void> {
  await page.goto(`${MAS_URL}/login`)
  await page.getByRole('link', { name: MAS_LABELS[masLanguage].continueWith('Google (simulado)') }).click()
  const callback = page.waitForResponse((r) => r.url().startsWith(`${MAS_URL}/upstream/callback/`))
  await dexCredentials(page, FAL)
  expect((await callback).status()).toBe(400)
}

const CALLBACK_NO_PARAMS = `${MAS_URL}/upstream/callback/01HFS6S2SVAR7Y7QYMZJ53ZG00`

test('MAS error, guard: unverified email, in pt-BR in a pt-BR browser (no language from the MAS), details collapsed', async ({ page }) => {
  await pinAppLocale(page)
  await reachEmailGuard(page, 'pt-BR')
  await expectErrorIn(page, 'pt-BR', 'guard', 'Subject is empty')
})

test('MAS error, generic: callback without parameters, in pt-BR in a pt-BR browser (no language from the MAS)', async ({ page }) => {
  await pinAppLocale(page)
  const res = await page.goto(CALLBACK_NO_PARAMS)
  expect(res?.status()).toBe(400)
  await expectErrorIn(page, 'pt-BR', 'generic', 'Missing query parameters')
})

// Sem JavaScript o script não roda: as duas línguas visíveis, pt-BR primeiro, e os detalhes técnicos uma vez.
// O callback sem parâmetros não passa pelo Dex.
test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false })

  test('MAS error, generic: callback without parameters shows both languages, pt-BR first', async ({ page }) => {
    const res = await page.goto(CALLBACK_NO_PARAMS)
    expect(res?.status()).toBe(400)

    await expect(page.locator('html')).not.toHaveAttribute('data-tayet-lang')
    const pt = errorCopy(page, 'pt-BR', 'generic')
    const en = errorCopy(page, 'en', 'generic')
    for (const l of [...Object.values(pt), ...Object.values(en)]) await expect(l).toBeVisible()
    const ptTop = (await pt.heading.boundingBox())?.y ?? Number.NaN
    const enTop = (await en.heading.boundingBox())?.y ?? Number.NaN
    expect(ptTop).toBeLessThan(enTop)
    await expect(page.locator('details')).toHaveCount(1)
    await expect(page.locator('details summary')).toHaveCount(1)
    await expect(page.locator('details')).not.toHaveAttribute('open')
    await expect(page.locator('details')).toContainText('Missing query parameters')

    const html = await page.content()
    expect(html).not.toMatch(stockError)
    expect(findProtocolLeaksInText(html)).toEqual([])
  })
})

test('MAS logged_out: one button that signs this browser out', async ({ page }) => {
  await reachConsent(page, BEA)
  await page.getByRole('button', { name: 'Continuar', exact: true }).click()
  await page.waitForURL((u) => u.origin !== MAS_URL)

  killSessionsOrThrow('bea')
  await page.goto(`${MAS_URL}/login`)

  await expect(page).toHaveTitle('Tayet')
  await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR')
  await expect(page.getByRole('heading', { name: 'Você saiu do Tayet', level: 1 })).toBeVisible()
  await expect(page.getByText('Depois, entre de novo para voltar ao Tayet.')).toBeVisible()
  await expect(page.getByRole('button')).toHaveCount(1)
  await expect(page.getByRole('link')).toHaveCount(0)
  const signOut = page.getByRole('button', { name: 'Sair deste navegador' })
  await expect(signOut).toBeVisible()

  const html = await page.content()
  expect(html).not.toMatch(stockError)
  expect(html).not.toContain('cpd-button')
  expect(findProtocolLeaksInText(html)).toEqual([])

  const landing = page.waitForResponse((r) => new URL(r.url()).pathname === '/login' && r.request().method() === 'GET')
  await signOut.click()
  expect((await landing).status()).toBe(200)
  await expect(page.getByRole('heading', { name: 'Entre no Tayet', level: 1 })).toBeVisible()
  await expect(page.getByText('Escolha como você entra.')).toBeVisible()
})

// I2 (ADR-109): as mesmas quatro páginas com o browser em inglês. Copy da coluna `en` do
// login-onboarding.md §11, `html[lang="en"]`, nenhum texto da coluna pt-BR no HTML (menos na página de
// erro, que chega sem idioma: lá a coluna pt-BR está no HTML, escondida) e as mesmas asserções de P1. Mesmas sondas: ada (consentimento), fal (guard), bea (saída).

// A coluna pt-BR do §11, por página. O L5 ("a conta da empresa") fica fora da página de login: o nome do
// provedor do dev-stack é "a conta da empresa (local)", que a regra do L5 não reconhece e que passa como
// está nas duas línguas (a prova do L5 é do infra/deploy/test/local-install.sh).
const PT_LOGIN = [
  'Entre no Tayet',
  'Escolha como você entra.',
  'Entre para vincular',
  'Usuário',
  'Senha',
  'Continuar',
  'Esqueci a senha',
  'Nenhuma forma de entrar está disponível.',
  'Criar conta',
  'Você vai até o provedor e volta para o Tayet automaticamente.',
]
const PT_CONSENT = [
  'Entre no Tayet',
  'Confirme a conta que você vai usar.',
  'Este acesso inclui:',
  'Sua conta',
  'Continuar',
  'Entrar com outra conta',
  'Cancelar',
  'Você volta para o Tayet automaticamente.',
]
const PT_LOGGED_OUT = [
  'Você saiu do Tayet',
  'Este navegador ainda lembra sua conta.',
  'Sair deste navegador',
  'Depois, entre de novo para voltar ao Tayet.',
]

function expectNoPortuguese(html: string, column: string[]): void {
  expect(column.filter((t) => html.includes(t))).toEqual([])
}

test.describe('browser in English', () => {
  test.beforeEach(async ({ page }) => {
    await setAcceptLanguage(page.context(), 'en-US')
  })

  test('MAS /login in English: §11 copy, lang="en", no protocol identifier', async ({ page }) => {
    await page.goto(`${MAS_URL}/login`)

    await expect(page).toHaveTitle('Tayet')
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await expect(page.getByRole('heading', { name: 'Sign in to Tayet', level: 1 })).toBeVisible()
    await expect(page.getByText('Choose how you sign in.', { exact: true })).toBeVisible()
    await expect(page.getByText("You'll go to the provider and come back to Tayet automatically.", { exact: true })).toBeVisible()
    // O formulário de senha só existe no dev-stack (features.password_login).
    await expect(page.getByLabel('Username', { exact: true })).toBeVisible()
    await expect(page.getByLabel('Password', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeVisible()

    const providerLinks = page.getByRole('link', { name: /^Continue with / })
    await expect(providerLinks).toHaveCount(2)
    await expect(providerLinks.first()).toHaveAccessibleName('Continue with a conta da empresa (local)')
    await expect(providerLinks.nth(1)).toHaveAccessibleName('Continue with Google (simulado)')

    const html = await page.content()
    expect(html).not.toContain('cpd-button')
    expectNoPortuguese(html, PT_LOGIN)
    expect(findProtocolLeaksInText(html)).toEqual([])
  })

  test('MAS consent in English, semNome: "Your account", never the username', async ({ page }) => {
    await reachConsent(page, ADA, 'en')
    const original = (await profileFacts('ada')).displayName ?? ''
    try {
      await setDisplayName('ada', '')
      await page.reload()

      await expect(page).toHaveTitle('Tayet')
      await expect(page.locator('html')).toHaveAttribute('lang', 'en')
      await expect(page.getByRole('heading', { name: 'Sign in to Tayet', level: 1 })).toBeVisible()
      await expect(page.getByText("Confirm the account you'll use.", { exact: true })).toBeVisible()
      await expect(page.getByText('Your account', { exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeVisible()
      await expect(page.getByRole('button', { name: 'Sign in with another account' })).toBeVisible()
      const cancel = page.getByRole('link', { name: 'Cancel', exact: true })
      await expect(cancel).toBeVisible()
      await expect(cancel).toHaveAttribute('href', /error=access_denied/)
      await expect(page.getByText("You'll come back to Tayet automatically.", { exact: true })).toBeVisible()

      const text = await page.locator('body').innerText()
      expect(text).not.toMatch(/\bada\b/i)
      const html = await page.content()
      expect(html).not.toMatch(stockError)
      expect(html).not.toMatch(/@[^\s"<]*:/)
      expect(html).not.toMatch(/\bu-[a-z0-9]/i)
      expectNoPortuguese(html, PT_CONSENT)
      expect(findProtocolLeaksInText(html)).toEqual([])
    } finally {
      await setDisplayName('ada', original)
    }
  })

  // Sem idioma do MAS: a página leva as duas línguas e o script escolhe o inglês pelo navigator.
  test('MAS error in English, guard: unverified email, details collapsed', async ({ page }) => {
    await pinAppLocale(page, 'en-US')
    await reachEmailGuard(page, 'en')
    await expectErrorIn(page, 'en', 'guard', 'Subject is empty')
  })

  test('MAS error in English, generic: callback without parameters', async ({ page }) => {
    await pinAppLocale(page, 'en-US')
    const res = await page.goto(CALLBACK_NO_PARAMS)
    expect(res?.status()).toBe(400)
    await expectErrorIn(page, 'en', 'generic', 'Missing query parameters')
  })

  test('MAS logged_out in English: one button that signs this browser out', async ({ page }) => {
    await reachConsent(page, BEA, 'en')
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await page.waitForURL((u) => u.origin !== MAS_URL)

    killSessionsOrThrow('bea')
    await page.goto(`${MAS_URL}/login`)

    await expect(page).toHaveTitle('Tayet')
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await expect(page.getByRole('heading', { name: 'You signed out of Tayet', level: 1 })).toBeVisible()
    await expect(
      page.getByText('This browser still remembers your account. On a shared computer, sign out of it too.', { exact: true }),
    ).toBeVisible()
    await expect(page.getByText('Then sign in again to get back to Tayet.', { exact: true })).toBeVisible()
    await expect(page.getByRole('button')).toHaveCount(1)
    const signOut = page.getByRole('button', { name: 'Sign out of this browser' })
    await expect(signOut).toBeVisible()

    const html = await page.content()
    expect(html).not.toMatch(stockError)
    expectNoPortuguese(html, PT_LOGGED_OUT)
    expect(findProtocolLeaksInText(html)).toEqual([])

    await signOut.click()
    await expect(page.getByRole('heading', { name: 'Sign in to Tayet', level: 1 })).toBeVisible()
  })
})

// L2: só "pt…" recebe pt-BR. Uma língua que o MAS tem e o Tayet não (fr) cai em inglês; pt-PT, que o
// MAS entrega como "pt", recebe pt-BR.
test.describe('browser in French', () => {
  test.beforeEach(async ({ page }) => {
    await setAcceptLanguage(page.context(), 'fr')
  })

  test('MAS /login falls back to English', async ({ page }) => {
    await page.goto(`${MAS_URL}/login`)
    await expect(page.locator('html')).toHaveAttribute('lang', 'en')
    await expect(page.getByRole('heading', { name: 'Sign in to Tayet', level: 1 })).toBeVisible()
    await expect(page.getByText('Choose how you sign in.', { exact: true })).toBeVisible()
  })
})

test.describe('browser in European Portuguese', () => {
  test.beforeEach(async ({ page }) => {
    await setAcceptLanguage(page.context(), 'pt-PT')
  })

  test('MAS /login is in pt-BR', async ({ page }) => {
    await page.goto(`${MAS_URL}/login`)
    await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR')
    await expect(page.getByRole('heading', { name: 'Entre no Tayet', level: 1 })).toBeVisible()
    await expect(page.getByText('Escolha como você entra.', { exact: true })).toBeVisible()
  })
})
