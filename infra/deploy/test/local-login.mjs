// local-login.mjs — o login no navegador da prova local (test/local-install.sh, PLANO-DEPLOY-DOMINIO
// §0.3.3 item 9). Usa o Playwright do client da árvore montada (<árvore>/client/node_modules), nunca
// fixtures do dev-stack. Seletores por role e texto, como no tier E2E (ADR-060; client/e2e/login.spec.ts).
//
// Ambiente: TREE (<árvore>), DOMAIN, HTTPS_PORT, ADMIN_EMAIL, PASSWORD_FILE. A senha é lida do arquivo
// e só vai para o campo do formulário do Dex: não aparece em log nem em saída. Sem trace, vídeo ou
// screenshot. O Chromium resolve o domínio e os subdomínios para 127.0.0.1:<HTTPS_PORT> e ignora o erro de
// certificado (quem valida a cadeia é o curl do local-install.sh).
//
// Duas passadas. A primeira, com o navegador em pt-BR, faz o login inteiro. A segunda, com o navegador em
// inglês, só vai até a página de login do MAS e confere o nome do provedor da casa em inglês, "your company
// account" (ADR-109, L5): o `human_name` do template de deploy é o padrão "a conta da empresa".
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const { TREE, DOMAIN, HTTPS_PORT, ADMIN_EMAIL, PASSWORD_FILE } = process.env
for (const [k, v] of Object.entries({ TREE, DOMAIN, HTTPS_PORT, ADMIN_EMAIL, PASSWORD_FILE })) {
  if (!v) throw new Error(`${k} ausente`)
}

const require = createRequire(join(TREE, 'client', 'package.json'))
const { chromium } = require('@playwright/test')

const APP = `https://chat.${DOMAIN}`
const AUTH = `https://auth.${DOMAIN}`
const password = readFileSync(PASSWORD_FILE, 'utf8').trim()
const onApp = (url) => url === APP || url.startsWith(`${APP}/`)
const log = (msg) => console.log(`  login: ${msg}`)

const browser = await chromium.launch({
  args: [`--host-resolver-rules=MAP ${DOMAIN} 127.0.0.1:${HTTPS_PORT},MAP *.${DOMAIN} 127.0.0.1:${HTTPS_PORT}`],
})
let ok = false
try {
  const context = await browser.newContext({ ignoreHTTPSErrors: true })
  // The app sees a Portuguese browser and every request says so (Accept-Language), so the MAS login
  // pages come in pt-BR too. The Dex pages are English only.
  await context.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR' })
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR'], configurable: true })
    Object.defineProperty(navigator, 'language', { get: () => 'pt-BR', configurable: true })
  })
  const page = await context.newPage()
  page.setDefaultTimeout(30_000)

  await page.goto(`${APP}/`)
  const sso = page.getByRole('button', { name: /^Continuar com/ })
  await sso.waitFor()
  log(`app em ${APP}/: botão "${(await sso.innerText()).trim()}"`)
  await sso.click()
  await page.waitForURL((u) => u.origin === AUTH)
  log(`MAS em ${AUTH}`)

  await page.getByRole('link', { name: 'Continuar com a conta da empresa' }).click()
  await page.waitForURL((u) => u.origin === `https://login.${DOMAIN}`)
  log(`Dex em https://login.${DOMAIN}`)
  await page.getByLabel('Email Address').fill(ADMIN_EMAIL)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Login' }).click()

  // De volta ao MAS: vínculo do upstream (primeiro login) e consentimento, se aparecerem; depois o app.
  const linkPage = /\/upstream\/link\//
  const consentPage = /\/consent\//
  for (let i = 0; i < 6; i++) {
    await page.waitForURL((u) => onApp(u.href) || linkPage.test(u.pathname) || consentPage.test(u.pathname))
    const url = new URL(page.url())
    if (onApp(url.href)) break
    if (linkPage.test(url.pathname)) {
      log('MAS: página de vínculo do upstream')
      await page.getByRole('button', { name: /^(Criar Conta|Create Account|Continuar|Continue|Link)/ }).first().click()
    } else {
      log('MAS: consentimento')
      await page.getByRole('button', { name: 'Continuar', exact: true }).click()
    }
  }

  const title = page.getByRole('heading', { name: 'Tayet', level: 1 })
  await title.waitFor({ timeout: 60_000 })
  log(`workspace em ${APP}: título "Tayet"`)
  const orgChannel = page
    .getByRole('navigation', { name: 'Conversas' })
    .getByRole('region', { name: 'Canais' })
    .getByRole('button', { name: '#all' })
  await orgChannel.waitFor({ timeout: 60_000 })
  log('canal da organização #all na lista de canais')
  await context.close()

  // Second pass: a browser in English, up to the MAS login page. No credentials.
  const en = await browser.newContext({ ignoreHTTPSErrors: true })
  await en.setExtraHTTPHeaders({ 'Accept-Language': 'en-US' })
  await en.addInitScript(() => {
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US'], configurable: true })
    Object.defineProperty(navigator, 'language', { get: () => 'en-US', configurable: true })
  })
  const pageEn = await en.newPage()
  pageEn.setDefaultTimeout(30_000)
  await pageEn.goto(`${APP}/`)
  const ssoEn = pageEn.getByRole('button', { name: /^Continue with/ })
  await ssoEn.waitFor()
  log(`app em inglês: botão "${(await ssoEn.innerText()).trim()}"`)
  await ssoEn.click()
  await pageEn.waitForURL((u) => u.origin === AUTH)
  const company = pageEn.getByRole('link', { name: 'Continue with your company account', exact: true })
  await company.waitFor()
  const lang = await pageEn.evaluate(() => document.documentElement.lang)
  if (lang !== 'en') throw new Error(`MAS em inglês com <html lang="${lang}">`)
  log(`MAS em inglês: "Continue with your company account", <html lang="en">`)
  ok = true
} catch (err) {
  // Só a mensagem: o Playwright não põe valor de campo nela, e a senha nunca é argumento de log.
  console.error(`  login: FALHOU — ${String(err?.message ?? err).split('\n')[0]}`)
} finally {
  await browser.close()
}
process.exit(ok ? 0 : 1)
