import { test, expect, type BrowserContext, type Page } from '@playwright/test'
import { killSessions } from '../test/support/synapse-admin'
import { ELI, FAY } from './fixtures/users'
import { AFTER_RELOGIN_404, BACKUP_LOOKUPS_WHY, backupLookupsCap, ConsoleLedger, FIRST_LOGIN_404, recognizedSet404 } from './support/console'
import { leaveAppForLogin, loginThroughDex, pinAppLocale, signIn } from './support/login'
import { currentDeviceIds, directMessageFacts } from './support/server-facts'
import { dmWith, send, startDm, title } from './support/workspace'
import { expectNoProtocolLeak, expectReadable, expectReadableWithin } from './support/assertions'
import { deleteSharedRooms } from './support/rooms'
import { SESSION } from './support/labels'

// PRD, Fase 2, as a test: "**Critério de saída:** logar em novo aparelho não quebra
// histórico nem mostra avisos técnicos." Escopo A′ (PLANO-RELEASE-PUBLICA §8.64): a new device is
// another browser on desktop — a fresh browser context, no store. eli and fay are this spec's own pair
// (fixtures/users.ts): they exchange two messages in an encrypted DM, then eli signs in on a new context
// and finds them readable, with no technical notice and no screen between the provider and the chat
// other than the D4 beat (ADR-031 addendum Out/2026: the callback is the first access).

// Display names as the MAS imported them from the Dex `name` claim (see conversation.spec.ts).
const ELI_NAME = 'eli'
const FAY_NAME = 'fay'

const notice = (page: Page) => page.getByRole('region', { name: SESSION.notices })

// The new-access scan runs after the first sync, fire-and-forget: whether the notice shows is decided
// within this window, not right after the h1 (new-access.spec.ts).
const SETTLE_MS = 10_000

// The boot phases each document of the context shows (`data-phase` of the boot surface), in order.
// One entry per document: the app before leaving for the provider, then the one the provider's
// callback lands on. The MAS and Dex pages carry no `data-phase` and record nothing.
type PhaseLog = Map<number, string[]>
async function recordPhases(ctx: BrowserContext): Promise<PhaseLog> {
  const log: PhaseLog = new Map()
  await ctx.exposeFunction('__e2ePhase', (doc: number, phase: string) => {
    const phases = log.get(doc) ?? []
    phases.push(phase)
    log.set(doc, phases)
  })
  await ctx.addInitScript(() => {
    const doc = performance.timeOrigin
    let shown = ''
    const check = () => {
      const now = document.querySelector('[data-phase]')?.getAttribute('data-phase') ?? ''
      if (now === shown) return
      shown = now
      if (now) (window as unknown as { __e2ePhase: (d: number, p: string) => void }).__e2ePhase(doc, now)
    }
    new MutationObserver(check).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-phase'] })
  })
  return log
}

// Hermetic start (PLANO-RELEASE-PUBLICA §8.24): every access of the pair is ended and the rooms of
// earlier local runs are deleted, so each run starts from devices and sessions that exist only in it.
test.beforeEach(async () => {
  killSessions('eli')
  killSessions('fay')
  await deleteSharedRooms('eli', 'fay')
})
test.afterEach(() => {
  killSessions('eli')
  killSessions('fay')
})

// Explicit budget: three Dex sign-ins, the history wait (custody cap, ADR-077: up to 30 s) and the
// SETTLE_MS notice window. Measured locally at 12.8–14.8 s over 3 runs (§8.64); 90 s keeps room for
// the custody cap without turning a hang into a pass.
test.setTimeout(90_000)

test('new device: a fresh browser context keeps the history, shows no technical notice and no intermediate step', async ({
  browser,
}) => {
  const ts = Date.now()
  const m1 = `new-device-1 ${ts}`
  const m2 = `new-device-2 ${ts}`

  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  const ctxNew = await browser.newContext()
  // One app boot per page (login), so one recognized-set read each. eli's new device holds none of the
  // DM's Megolm sessions until the backup or the custody hands them over (ADR-061/077): the SDK asks the
  // backup for each one (two senders) and again after each custody re-consult.
  const consoleA = new ConsoleLedger('eli', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  const consoleB = new ConsoleLedger('fay', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  const consoleNew = new ConsoleLedger('eli (new device)', [
    ...recognizedSet404(1),
    { ...AFTER_RELOGIN_404[0]!, max: backupLookupsCap(2), why: BACKUP_LOOKUPS_WHY(2) },
  ])
  try {
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()
    consoleA.watch(pageA, 'A')
    consoleB.watch(pageB, 'B')

    await test.step('1. eli and fay sign in; eli opens a DM with fay and they exchange two messages', async () => {
      await signIn(pageA, ELI)
      await signIn(pageB, FAY)
      await startDm(pageA, FAY_NAME)
      await send(pageA, m1)
      await dmWith(pageB, ELI_NAME).click()
      await expectReadable(pageB, m1)
      await send(pageB, m2)
      await expectReadable(pageA, m1, m2)
      await expectNoProtocolLeak(pageA, pageB)
    })

    // Never asserted through the UI (P1): the server says the DM is encrypted (conversation.spec step 4).
    await test.step('2. the DM is encrypted, by the server', async () => {
      const dm = await directMessageFacts('eli', 'fay')
      expect(dm.encrypted).toBe(true)
      expect(dm.lastMessageTypes.slice(0, 2)).toEqual(['m.room.encrypted', 'm.room.encrypted'])
    })

    const phases = await recordPhases(ctxNew)
    const pageNew = await ctxNew.newPage()
    consoleNew.watch(pageNew, 'new')

    await test.step('3. eli signs in on a new browser context', async () => {
      await pinAppLocale(pageNew)
      await pageNew.goto('/')
      const sso = pageNew.getByRole('button', { name: 'Continuar com Dex (local)' })
      await expect(sso).toBeVisible()
      await leaveAppForLogin(pageNew, sso)
      await loginThroughDex(pageNew, ELI)
      await expect(title(pageNew)).toBeVisible()
    })

    // ADR-031 addendum Out/2026: between the provider's page and the chat only the D4 beat shows.
    await test.step('4. boot phases: redirecting before the provider, exactly preparing after it', async () => {
      const docs = [...phases.values()]
      console.log(`[e2e] boot phases per document: ${JSON.stringify(docs)}`)
      expect(docs).toHaveLength(2)
      expect(docs[0]!.at(-1)).toBe('redirecting')
      expect(docs[1]).toEqual(['preparing'])
    })

    await test.step('5. the history is readable on the new device', async () => {
      await dmWith(pageNew, FAY_NAME).click()
      // ADR-077: up to 30 s through the custody when the backup does not have the sessions yet (cap +
      // margin; precedent: conversation.spec step 11).
      const openedAt = Date.now()
      await expectReadableWithin(pageNew, 40_000, m1, m2)
      console.log(`[e2e] step 5: DM readable ${Date.now() - openedAt} ms after opening it`)
    })

    // The one notice allowed on the new device is the product's new-access notice. ADR-018 dec. 3: "A
    // ACL emite para **todo** device que apareça no delta da device list do próprio usuário e ainda não
    // esteja no conjunto "reconhecido" (§4), **exceto o próprio device da sessão corrente**". Context 1
    // stays alive on purpose — a new device while the old one is still in use — so eli's previous
    // access is outside the recognized set and the new device may announce it. The notice is not
    // dismissed here. The other shape of the scenario, the old access revoked before the re-login, is
    // conversation.spec step 11. Owner's call (§8.64); the noise on a first access is #261.
    await test.step('6. no technical notice on the new device; the only notice allowed is the new-access one', async () => {
      const shown = await notice(pageNew)
        .waitFor({ state: 'visible', timeout: SETTLE_MS })
        .then(() => true)
        .catch(() => false)
      console.log(`[e2e] step 6: new-access notice on the new device: ${shown}`)
      if (shown) {
        // A single access ("Novo acesso", not "N novos acessos"), and eli has exactly two: this device
        // and the one of context 1 — the notice can only be about the previous access.
        await expect(notice(pageNew).locator('strong')).toHaveText(['Novo acesso à sua conta'])
        expect(await currentDeviceIds('eli')).toHaveLength(2)
      }
      await expectNoProtocolLeak(pageNew) // the whole page, the notice's text included
      await expectReadable(pageNew, m1, m2) // still no placeholder
    })

    console.log(`[e2e] console A: ${JSON.stringify(consoleA.observed())}`)
    console.log(`[e2e] console B: ${JSON.stringify(consoleB.observed())}`)
    console.log(`[e2e] console new: ${JSON.stringify(consoleNew.observed())}`)
    consoleA.expectClean()
    consoleB.expectClean()
    consoleNew.expectClean()
  } finally {
    await ctxA.close()
    await ctxB.close()
    await ctxNew.close()
  }
})
