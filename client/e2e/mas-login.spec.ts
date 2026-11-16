import { createHash, randomBytes } from 'node:crypto'
import { test, expect, type Page } from '@playwright/test'
import { MAS_URL, SPA_CLIENT_ID, SPA_REDIRECT } from '../test/support/stack-env'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { killSessionsOrThrow } from '../test/support/synapse-admin'
import { ADA, BEA, FAL, type E2eUser } from './fixtures/users'
import { profileFacts, setDisplayName } from './support/server-facts'

// P4-1 (ADR-084, Conformidade): a escolha de provedor do MAS é o template próprio, não o stock.
// Copy literal do login-onboarding.md §8; o dev-stack tem dois provedores, então a página aparece
// (com um provedor e senha desligada o MAS redireciona direto, PLANO-PESSOAS §0.4). Accept-Language
// pt-BR, como o browser de um usuário brasileiro; a copy é literal, então não depende dele.

test.use({ extraHTTPHeaders: { 'Accept-Language': 'pt-BR' } })

test('MAS /login is the Tayet page: §8 copy, Google icon only, no protocol identifier', async ({ page }) => {
  await page.goto(`${MAS_URL}/login`)

  await expect(page).toHaveTitle('Tayet')
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
async function reachConsent(page: Page, user: E2eUser): Promise<void> {
  await page.goto(authorizeUrl())
  for (;;) {
    await page.waitForURL((u) => u.origin !== MAS_URL || /^\/(login|consent\/[^/]+|upstream\/link\/[^/]+)$/.test(u.pathname))
    const url = new URL(page.url())
    if (url.origin !== MAS_URL) {
      await dexCredentials(page, user)
      continue
    }
    if (/^\/consent\//.test(url.pathname)) return
    if (url.pathname === '/login') await page.getByRole('link', { name: 'Continuar com a conta da empresa (local)' }).click()
    else await page.getByRole('button', { name: 'Create Account' }).click()
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

test('MAS error, guard: unverified email in pt-BR, details collapsed', async ({ page }) => {
  await page.goto(`${MAS_URL}/login`)
  await page.getByRole('link', { name: 'Continuar com Google (simulado)' }).click()
  const callback = page.waitForResponse((r) => r.url().startsWith(`${MAS_URL}/upstream/callback/`))
  await dexCredentials(page, FAL)
  expect((await callback).status()).toBe(400)

  await expect(page).toHaveTitle('Tayet')
  await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR')
  await expect(page.getByRole('heading', { name: 'Não conseguimos confirmar seu email', level: 1 })).toBeVisible()
  await expect(
    page.getByText(
      'O provedor informou que o email da sua conta ainda não foi confirmado. Confirme o email lá e tente entrar de novo.',
      { exact: true },
    ),
  ).toBeVisible()
  await expect(page.getByRole('link', { name: 'Tentar de novo' })).toHaveAttribute('href', '/login')
  const details = page.locator('details')
  await expect(details).toHaveCount(1)
  await expect(details).not.toHaveAttribute('open')
  await expect(details).toContainText('Subject is empty')
  await expect(page.getByText('Subject is empty')).toBeHidden()

  const html = await page.content()
  expect(html).not.toMatch(stockError)
  expect(findProtocolLeaksInText(html)).toEqual([])
})

test('MAS error, generic: callback without parameters', async ({ page }) => {
  const res = await page.goto(`${MAS_URL}/upstream/callback/01HFS6S2SVAR7Y7QYMZJ53ZG00`)
  expect(res?.status()).toBe(400)

  await expect(page.locator('html')).toHaveAttribute('lang', 'pt-BR')
  await expect(page.getByRole('heading', { name: 'Não foi possível entrar', level: 1 })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Tentar de novo' })).toHaveAttribute('href', '/login')
  const details = page.locator('details')
  await expect(details).not.toHaveAttribute('open')
  await expect(details).toContainText('Missing query parameters')

  const html = await page.content()
  expect(html).not.toMatch(stockError)
  expect(findProtocolLeaksInText(html)).toEqual([])
})

test('MAS logged_out: one button that signs this browser out', async ({ page }) => {
  await reachConsent(page, BEA)
  await page.getByRole('button', { name: 'Continuar', exact: true }).click()
  await page.waitForURL((u) => u.origin !== MAS_URL)

  killSessionsOrThrow('bea')
  await page.goto(`${MAS_URL}/login`)

  await expect(page).toHaveTitle('Tayet')
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
