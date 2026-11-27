// restore-proof.mjs — the browser half of the restore proof (test/restore-proof.sh). Uses the Playwright of
// the assembled tree's client (<tree>/client/node_modules), like local-login.mjs, with selectors by role and
// text as in the E2E tier (ADR-060; client/e2e/support/workspace.ts and media.ts). One person only: the
// bootstrap admin. Every "new access" is a fresh browser context: no store, a full sign-in through the
// Dex, a new device.
//
//   PHASE=seed    sign in, create the private channel, send M1, attach the file
//   PHASE=before       a new access reads M1 and downloads the file (the custody deposit and the upload
//                      exist before the backup); its browser profile is kept in PROFILE_A
//   PHASE=post-backup  a new access made after the backup; its profile is kept in PROFILE_B
//   PHASE=after        after the restore, in a new access: (i) sign-in works, (ii) M1 reads, (iii) the file
//                      downloads with the sent sha256, (iv) M2 is sent and another new access reads it.
//                      Then two observations, which never fail the proof: what profile A (made before the
//                      backup, its session ended after it) and profile B (made after the backup) show.
//
// Environment: PHASE, TREE, DOMAIN, HTTPS_PORT, ADMIN_EMAIL, PASSWORD_FILE, CHANNEL, M1, M2, FILE (path of the
// file to attach), FILE_SHA256, PROFILE_A, PROFILE_B, and M3 in the same-server round (PHASE=m3 sends it after
// the backup; PHASE=after asserts it is gone). The password is read from the file and only goes into the Dex form field: it
// is never logged. No trace, video or screenshot. Each assertion prints one `assert` line.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, join } from 'node:path'

const env = process.env
const need = ['PHASE', 'TREE', 'DOMAIN', 'HTTPS_PORT', 'ADMIN_EMAIL', 'PASSWORD_FILE', 'CHANNEL', 'M1', 'FILE']
for (const k of need) if (!env[k]) throw new Error(`${k} missing`)
const { PHASE, TREE, DOMAIN, HTTPS_PORT, ADMIN_EMAIL, PASSWORD_FILE, CHANNEL, M1, FILE } = env
const FILE_NAME = basename(FILE)

const require = createRequire(join(TREE, 'client', 'package.json'))
const { chromium } = require('@playwright/test')

const APP = `https://chat.${DOMAIN}`
const AUTH = `https://auth.${DOMAIN}`
const onApp = (url) => url === APP || url.startsWith(`${APP}/`)
const t0 = Date.now()
const log = (msg) => console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)} s] ${msg}`)
// A key that reaches a new access through custody may take a while (ADR-077): generous, not a retry.
const READ_TIMEOUT = 180_000
const PLACEHOLDERS = ['Aguardando a mensagem…', 'Mensagem indisponível']

const browser = await chromium.launch({
  args: [`--host-resolver-rules=MAP ${DOMAIN} 127.0.0.1:${HTTPS_PORT},MAP *.${DOMAIN} 127.0.0.1:${HTTPS_PORT}`],
})
const signInButton = (page) => page.getByRole('button', { name: /^Continuar com/ })

const RESOLVER = `--host-resolver-rules=MAP ${DOMAIN} 127.0.0.1:${HTTPS_PORT},MAP *.${DOMAIN} 127.0.0.1:${HTTPS_PORT}`
async function inPortuguese(context) {
  await context.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR' })
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR'], configurable: true })
    Object.defineProperty(navigator, 'language', { get: () => 'pt-BR', configurable: true })
  })
  return context
}
// A browser profile kept on disk between phases (a plain context lives in memory only).
async function profile(dir) {
  return inPortuguese(await chromium.launchPersistentContext(dir, { args: [RESOLVER], ignoreHTTPSErrors: true }))
}

// A new access: fresh context in pt-BR (or the given empty profile), full sign-in, lands on the workspace.
async function newAccess(label, profileDir) {
  const context = profileDir
    ? await profile(profileDir)
    : await inPortuguese(await browser.newContext({ ignoreHTTPSErrors: true, acceptDownloads: true }))
  const page = context.pages()[0] ?? (await context.newPage())
  page.setDefaultTimeout(30_000)
  await page.goto(`${APP}/`)
  await page.getByRole('button', { name: /^Continuar com/ }).click()
  await page.waitForURL((u) => u.origin === AUTH)
  await page.getByRole('link', { name: 'Continuar com a conta da empresa' }).click()
  await page.waitForURL((u) => u.origin === `https://login.${DOMAIN}`)
  await page.getByLabel('Email Address').fill(ADMIN_EMAIL)
  await page.getByLabel('Password').fill(readFileSync(PASSWORD_FILE, 'utf8').trim())
  await page.getByRole('button', { name: 'Login' }).click()
  const linkPage = /\/upstream\/link\//
  const consentPage = /\/consent\//
  for (let i = 0; i < 6; i++) {
    await page.waitForURL((u) => onApp(u.href) || linkPage.test(u.pathname) || consentPage.test(u.pathname))
    const url = new URL(page.url())
    if (onApp(url.href)) break
    if (linkPage.test(url.pathname)) {
      await page.getByRole('button', { name: /^(Criar Conta|Create Account|Continuar|Continue|Link)/ }).first().click()
    } else {
      await page.getByRole('button', { name: 'Continuar', exact: true }).click()
    }
  }
  await page.getByRole('heading', { name: 'Tayet', level: 1 }).waitFor({ timeout: 60_000 })
  log(`${label}: signed in, workspace up`)
  return { context, page }
}

const conversations = (page) => page.getByRole('navigation', { name: 'Conversas' })
const messages = (page) => page.getByRole('log', { name: 'Mensagens' })
const channelRow = (page) =>
  conversations(page)
    .getByRole('region', { name: 'Canais' })
    .getByRole('button', { name: new RegExp(`^Canal privado ${CHANNEL}(\\s|$)`) })
const fileLink = (page) => messages(page).getByRole('link', { name: `📎 ${FILE_NAME}`, exact: true })

// Sent = the row is on screen AND no row is still "Enviando…": the row shows at once as a local echo, and
// closing the browser before the send finishes drops it (the attachment in the shakedown run; the likely
// cause of the (iv) failures in the first two rounds).
const sending = (page) => messages(page).locator('article').filter({ hasText: 'Enviando…' })
async function send(page, text) {
  await page.getByRole('main').getByRole('textbox', { name: 'Mensagem', exact: true }).fill(text)
  await page.getByRole('main').getByRole('button', { name: 'Enviar' }).click()
  await messages(page).getByText(text).waitFor()
  await sending(page).first().waitFor({ state: 'detached', timeout: 60_000 })
}

// The text is on screen and nothing from the first text of this run onward is a placeholder.
async function expectReadable(page, text, label) {
  await channelRow(page).waitFor({ timeout: 60_000 })
  await channelRow(page).click()
  await messages(page).getByText(text).waitFor({ timeout: READ_TIMEOUT })
  const all = await messages(page).innerText()
  const fromRun = all.slice(all.indexOf(M1))
  for (const p of PLACEHOLDERS) if (fromRun.includes(p)) throw new Error(`${label}: placeholder "${p}" after M1`)
  log(`assert ${label}: "${text}" decrypted, no placeholder`)
}

async function expectDownload(page, label) {
  await fileLink(page).waitFor({ timeout: READ_TIMEOUT })
  const [download] = await Promise.all([page.waitForEvent('download'), fileLink(page).click()])
  if (download.suggestedFilename() !== FILE_NAME) throw new Error(`${label}: download named ${download.suggestedFilename()}`)
  const sha = createHash('sha256').update(readFileSync(await download.path())).digest('hex')
  if (sha !== env.FILE_SHA256) throw new Error(`${label}: sha256 ${sha}, sent ${env.FILE_SHA256}`)
  log(`assert ${label}: ${FILE_NAME} downloaded, sha256 ${sha.slice(0, 12)}… = sent`)
}

// Opens a kept profile and reports what it shows within 90 s: the sign-in screen, or the workspace with M1
// readable and no sign-in screen. An observation: printed, never thrown.
async function observe(name, dir, what) {
  if (!dir) return
  let context
  try {
    context = await profile(dir)
    const page = context.pages()[0] ?? (await context.newPage())
    page.setDefaultTimeout(30_000)
    await page.goto(`${APP}/`)
    const deadline = Date.now() + 90_000
    let outcome = 'neither the workspace nor the sign-in screen within 90 s'
    while (Date.now() < deadline) {
      if (await signInButton(page).isVisible().catch(() => false)) {
        outcome = 'signed out: the sign-in screen'
        break
      }
      // The revoked variant of the boot screen (BootMessage.tsx, boot.endedTitle / boot.signInAgain).
      if (await page.getByText('Seu acesso foi encerrado').isVisible().catch(() => false)) {
        const again = await page.getByRole('button', { name: 'Entrar de novo' }).isVisible().catch(() => false)
        outcome = `access ended: "Seu acesso foi encerrado"${again ? ' with the button "Entrar de novo"' : ''}`
        break
      }
      const inWorkspace = await page.getByRole('heading', { name: 'Tayet', level: 1 }).isVisible().catch(() => false)
      if (inWorkspace && (await channelRow(page).isVisible().catch(() => false))) {
        await channelRow(page).click()
        const read = await messages(page).getByText(M1).waitFor({ timeout: 30_000 }).then(() => true, () => false)
        await page.waitForTimeout(20_000)
        const out = await signInButton(page).isVisible().catch(() => false)
        outcome = out ? 'signed out after the workspace showed' : `still signed in: workspace, M1 ${read ? 'readable' : 'not shown'}, sync 20 s later without a sign-in screen`
        break
      }
      await page.waitForTimeout(1_000)
    }
    if (outcome.startsWith('neither')) {
      // What is on screen instead: only alert texts and heading names (no ids are rendered there, P1).
      const alerts = await page.getByRole('alert').allInnerTexts().catch(() => [])
      const headings = await page.getByRole('heading').allInnerTexts().catch(() => [])
      outcome += `; alerts [${alerts.map((t) => t.replace(/\s+/g, ' ').trim()).join(' | ')}], headings [${headings.join(' | ')}]`
    }
    log(`observe profile ${name} (${what}): ${outcome}`)
  } catch (err) {
    log(`observe profile ${name} (${what}): error — ${String(err?.message ?? err).split('\n')[0]}`)
  } finally {
    await context?.close().catch(() => undefined)
  }
}

let ok = false
try {
  if (PHASE === 'seed') {
    const { context, page } = await newAccess('seed')
    await conversations(page).getByRole('button', { name: 'Novo canal' }).click()
    const create = page.getByRole('dialog', { name: 'Nova conversa' })
    await create.getByLabel('Nome do canal').fill(CHANNEL)
    await create.getByRole('button', { name: 'Privado' }).click()
    await create.getByRole('button', { name: 'Criar canal' }).click()
    await create.waitFor({ state: 'detached' })
    await channelRow(page).click()
    log(`private channel ${CHANNEL} created`)
    await send(page, M1)
    log('M1 sent')
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.getByRole('main').getByLabel('Anexar', { exact: true }).click(),
    ])
    await chooser.setFiles(FILE)
    await fileLink(page).waitFor({ timeout: 60_000 })
    // The row shows at once as a local echo; the upload is done when no row says "Enviando…". Closing the
    // context before that drops the upload (the first shakedown run did).
    await sending(page).first().waitFor({ state: 'detached', timeout: 60_000 })
    log(`${FILE_NAME} sent (no row "Enviando…")`)
    await context.close()
  } else if (PHASE === 'before') {
    const { context, page } = await newAccess('new access before the backup (profile A)', env.PROFILE_A)
    await expectReadable(page, M1, 'before backup, M1')
    await expectDownload(page, 'before backup, file')
    await context.close()
  } else if (PHASE === 'post-backup') {
    const { context } = await newAccess('new access after the backup (profile B)', env.PROFILE_B)
    await context.close()
  } else if (PHASE === 'm3') {
    if (!env.M3) throw new Error('M3 required')
    const { context, page } = await newAccess('new access after the backup sends M3')
    await channelRow(page).waitFor({ timeout: 60_000 })
    await channelRow(page).click()
    await send(page, env.M3)
    log('M3 sent (no row "Enviando…")')
    await context.close()
  } else if (PHASE === 'after') {
    if (!env.M2 || !env.FILE_SHA256) throw new Error('M2 and FILE_SHA256 required')
    const a = await newAccess('new access after the restore')
    log('assert (i): sign-in works after the restore')
    await expectReadable(a.page, M1, '(ii) M1')
    await expectDownload(a.page, '(iii) file')
    if (env.M3) {
      const all = await messages(a.page).innerText()
      if (all.includes(env.M3)) throw new Error('M3 (sent after the backup) is in the channel after the restore')
      log('assert M3 absent: the message sent after the backup is not in the channel')
    }
    await send(a.page, env.M2)
    log('M2 sent (no row "Enviando…")')
    await a.context.close()
    const b = await newAccess('second new access after the restore')
    await expectReadable(b.page, env.M2, '(iv) M2 in another new access')
    await b.context.close()
    await observe('A', env.PROFILE_A, 'made before the backup, its session ended after it')
    await observe('B', env.PROFILE_B, 'made after the backup')
  } else {
    throw new Error(`unknown PHASE ${PHASE}`)
  }
  ok = true
} catch (err) {
  // The message only: Playwright puts no field value in it, and the password is never a log argument.
  console.error(`  FAILED (${PHASE}): ${String(err?.message ?? err).split('\n')[0]}`)
} finally {
  await browser.close()
}
process.exit(ok ? 0 : 1)
