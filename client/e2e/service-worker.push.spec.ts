import { test, expect, type BrowserContext, type Page, type Worker } from '@playwright/test'
import { findProtocolLeaksInText } from '@tayet/shared/leak-scan'
import { RAFA, SOFI } from './fixtures/users'
import { ConsoleLedger, FIRST_LOGIN_404, recognizedSet404 } from './support/console'
import { seedNotificationsOn } from './support/notifications'
import { refusePushSubscription } from './support/push'
import { onApp, pinAppLocale, signIn } from './support/login'
import { deleteSharedRooms } from './support/rooms'
import { dmWith, highlighted, messages, orgChannel, row, send, startDm, threadPanel, title } from './support/workspace'
import { expectNoProtocolLeak } from './support/assertions'
import { COMPOSER, THREAD, TIMELINE } from './support/labels'

// ADR-117 (PR 5a of the push track): the service worker — push, the live tab through its registration, and the
// click. The push project only (playwright.config.ts): the full Chromium build, where the context grants the
// notification permission and the worker's notifications exist. sofi writes; rafa is the one notified.
//
// How the browser is driven (PLANO-MOBILE §8.29 and the Phase 0 of this PR):
// - a push is delivered by CDP (`ServiceWorker.deliverPushMessage`) with the JSON the push service sends, built here;
// - what is shown is read from a spy on `showNotification` (the worker's, and the live tab's in rafa's pages), not
//   from `getNotifications` (see the helpers below): the tag replacement is the browser's, out of this spec;
// - a click is a synthetic `notificationclick` (an `ExtendableEvent` carrying a stand-in notification: its data and a
//   recorded close()) dispatched in the worker. Under automation the worker may not open a window from it (Phase 0:
//   `openWindow` refused), so the "app closed" case opens the page itself after the click;
// - the worker sees rafa's app page, once it has loaded, as visible and focused whatever page is in front (measured
//   here: the app page keeps `document.hasFocus()` with another page in front, even with focus emulation off). So
//   "focused" is the app open, and the cases that must show run with the app page closed (no window); the
//   visible-but-unfocused and hidden combinations of the decision are proven in the unit tests.
// - another page of rafa's context (about:blank, not an app window) keeps the context, and carries the CDP session.

const SOFI_NAME = 'sofi'
const RAFA_NAME = 'rafa'
// A negative assertion: the push was delivered, then a beat for a notification that must not exist.
const SETTLE_MS = 1_500
// The pending target's entry, as src/sw/store.ts writes it (e2e imports nothing from src).
const SW_CACHE = 'tayet-sw'
const PENDING_KEY = '/__tayet-sw/pending'

interface Seen {
  title: string
  body: string
  tag: string
  data: { conversation?: string; message?: string; thread?: string } | null
  at: number
}

// On macOS Chromium drops from `getNotifications` what the system notification center no longer shows (issue #7,
// PLANO-CI-INTEGRACAO §8.R14), so the spec reads what was asked to be shown: a spy on `showNotification` in the
// worker (installed in step 1) and in rafa's pages (the live tab, ui/notifier.ts), which still calls through.
interface SpyState {
  id: string
  shown: Seen[]
  closed: string[]
}
type SpySelf = {
  registration: ServiceWorkerRegistration
  __tayetSpy?: SpyState
  ExtendableEvent: new (type: string) => Event
  dispatchEvent(e: Event): boolean
}
interface Spy {
  ctx: BrowserContext
  id: string
  page: Seen[]
}

async function worker(ctx: BrowserContext): Promise<Worker> {
  const found = ctx.serviceWorkers().find((w) => w.url().endsWith('/sw.js'))
  return found ?? (await ctx.waitForEvent('serviceworker', { predicate: (w) => w.url().endsWith('/sw.js') }))
}

// Before any page of the context: the live tab's calls reach `spy.page` through a binding.
async function spyOnPages(ctx: BrowserContext): Promise<Spy> {
  const spy: Spy = { ctx, id: `spy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, page: [] }
  await ctx.exposeBinding('__tayetShown', (_source, seen: Seen) => {
    spy.page.push(seen)
  })
  await ctx.addInitScript(() => {
    const proto = ServiceWorkerRegistration.prototype
    const original = proto.showNotification
    proto.showNotification = function (title: string, options: NotificationOptions = {}) {
      const report = (window as unknown as { __tayetShown?: (s: unknown) => void }).__tayetShown
      report?.({ title, body: options.body ?? '', tag: options.tag ?? '', data: (options.data as unknown) ?? null, at: Date.now() })
      return original.call(this, title, options)
    }
  })
  return spy
}

// The worker's spy, once it is registered. A worker restarted after this has no spy: every read checks the id.
async function spyOnWorker(spy: Spy): Promise<void> {
  const problem = await (await worker(spy.ctx)).evaluate((id) => {
    const scope = self as unknown as SpySelf
    try {
      new scope.ExtendableEvent('notificationclick')
    } catch (err) {
      return `ExtendableEvent is not constructible in the worker: ${String(err)}`
    }
    const state: SpyState = { id, shown: [], closed: [] }
    scope.__tayetSpy = state
    const registration = scope.registration
    const original = registration.showNotification.bind(registration)
    registration.showNotification = (title: string, options: NotificationOptions = {}) => {
      state.shown.push({ title, body: options.body ?? '', tag: options.tag ?? '', data: (options.data as Seen['data']) ?? null, at: Date.now() })
      return original(title, options)
    }
    return null
  }, spy.id)
  if (problem !== null) throw new Error(problem)
}

async function workerSpy(spy: Spy): Promise<SpyState> {
  const state = await (await worker(spy.ctx)).evaluate(() => (self as unknown as SpySelf).__tayetSpy ?? null)
  if (state === null || state.id !== spy.id) throw new Error('the service worker restarted after step 1: its showNotification spy is gone')
  return state
}

// Every showNotification since the last closeAll, the worker's and the live tab's, in order.
async function shownBy(spy: Spy): Promise<Seen[]> {
  return [...(await workerSpy(spy)).shown, ...spy.page].sort((a, b) => a.at - b.at)
}

async function closeAll(spy: Spy): Promise<void> {
  await workerSpy(spy)
  await (await worker(spy.ctx)).evaluate(() => {
    const state = (self as unknown as SpySelf).__tayetSpy!
    state.shown.length = 0
    state.closed.length = 0
  })
  spy.page.length = 0
}

// The tags of the stand-in notifications the worker closed (its notificationclick closes the clicked one).
async function closedBy(spy: Spy): Promise<string[]> {
  return (await workerSpy(spy)).closed
}

// The person clicks the notification of `message` (the worker's notificationclick, on a stand-in notification).
async function clickOn(spy: Spy, message: string): Promise<void> {
  const seen = (await shownBy(spy)).filter((n) => n.data?.message === message).at(-1)
  if (!seen) throw new Error('no notification for that message')
  await (await worker(spy.ctx)).evaluate(
    ({ tag, data }) => {
      const scope = self as unknown as SpySelf
      const notification = { tag, data, close: () => void scope.__tayetSpy?.closed.push(tag) }
      const event = new scope.ExtendableEvent('notificationclick')
      Object.defineProperty(event, 'notification', { value: notification })
      scope.dispatchEvent(event)
    },
    { tag: seen.tag, data: seen.data },
  )
}

// The push vendor's delivery, by CDP on the session of `page` (any page of the context).
async function pusher(page: Page): Promise<(payload: unknown) => Promise<void>> {
  const cdp = await page.context().newCDPSession(page)
  const registrations = new Map<string, string>()
  cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations: rs }) => {
    for (const r of rs) if (!r.isDeleted) registrations.set(r.scopeURL, r.registrationId)
  })
  await cdp.send('ServiceWorker.enable')
  await expect.poll(() => registrations.size).toBeGreaterThan(0)
  return async (payload) => {
    const [scope, registrationId] = [...registrations][0]!
    await cdp.send('ServiceWorker.deliverPushMessage', { origin: new URL(scope).origin, registrationId, data: JSON.stringify(payload) })
  }
}

function expectClean(n: { title: string; body: string }): void {
  expect(findProtocolLeaksInText(`${n.title}\n${n.body}`)).toEqual([])
  for (const shape of ['@', '!', ':tayet.local', 'conv-', 'msg-']) expect(`${n.title}${n.body}`).not.toContain(shape)
}

let seq = 0
const base = (over: Record<string, unknown>) => ({ v: 1, invite: false, conversation: `conv-${++seq}`, message: `msg-${seq}`, author: 'Ana', ...over })

// Case 2: one row per kind, both languages; the payload is the push service's (push/src/filter.ts).
const ROWS: Array<{ name: string; payload: Record<string, unknown>; pt: [string, string]; en: [string, string] }> = [
  { name: 'direct', payload: { kind: 'direct' }, pt: ['Ana', 'Nova mensagem'], en: ['Ana', 'New message'] },
  { name: 'direct, agent', payload: { kind: 'direct', agent: true }, pt: ['Ana (agente)', 'Nova mensagem'], en: ['Ana (agent)', 'New message'] },
  { name: 'group', payload: { kind: 'group' }, pt: ['Ana em conversa em grupo', 'Nova mensagem'], en: ['Ana in a group conversation', 'New message'] },
  {
    name: 'group, agent',
    payload: { kind: 'group', agent: true },
    pt: ['Ana (agente) em conversa em grupo', 'Nova mensagem'],
    en: ['Ana (agent) in a group conversation', 'New message'],
  },
  {
    name: 'channel, text',
    payload: { kind: 'channel', channelName: 'vendas', body: { type: 'text', text: 'Bom dia, time' } },
    pt: ['Ana em vendas', 'Bom dia, time'],
    en: ['Ana in vendas', 'Bom dia, time'],
  },
  {
    name: 'channel, text, agent',
    payload: { kind: 'channel', channelName: 'vendas', agent: true, body: { type: 'text', text: 'Relatório pronto' } },
    pt: ['Ana (agente) em vendas', 'Relatório pronto'],
    en: ['Ana (agent) in vendas', 'Relatório pronto'],
  },
  {
    name: 'channel, card',
    payload: { kind: 'channel', channelName: 'vendas', agent: true, body: { type: 'approval', text: 'Pagar a nota?\nValor: 10' } },
    pt: ['Ana (agente) em vendas', 'Pede aprovação: Pagar a nota?'],
    en: ['Ana (agent) in vendas', 'Asks for approval: Pagar a nota?'],
  },
  { name: 'direct invite', payload: { kind: 'direct', invite: true }, pt: ['Ana', 'Nova mensagem'], en: ['Ana', 'New message'] },
  {
    name: 'group invite, agent',
    payload: { kind: 'group', invite: true, agent: true },
    pt: ['Ana (agente) em conversa em grupo', 'Nova mensagem'],
    en: ['Ana (agent) in a group conversation', 'New message'],
  },
]

async function expectRows(spy: Spy, push: (p: unknown) => Promise<void>, language: 'pt' | 'en'): Promise<void> {
  for (const r of ROWS) {
    const payload = base(r.payload)
    await push(payload)
    await expect.poll(async () => (await shownBy(spy)).find((n) => n.tag === payload.conversation), { message: r.name }).toBeDefined()
    const n = (await shownBy(spy)).find((x) => x.tag === payload.conversation)!
    expect([n.title, n.body], `${r.name} (${language})`).toEqual(r[language])
    expect(n.data).toEqual({ conversation: payload.conversation, message: payload.message })
    expectClean(n)
  }
  await closeAll(spy)
}

test.beforeAll(async () => {
  await deleteSharedRooms('sofi', 'rafa')
})

test('service worker: registered; push titles in both languages; the live tab through the registration; focus; the click, open and closed', async ({
  browser,
}) => {
  test.setTimeout(300_000)
  const ts = Date.now()
  const ctxS = await browser.newContext()
  const ctxR = await browser.newContext()
  await ctxR.grantPermissions(['notifications'])
  // Granted and turned on before (the live tab notifies only with the device's preference on; PR 5b, F4).
  await ctxR.addInitScript(seedNotificationsOn)
  // With the preference on, the app's opening check subscribes: the subscription is not this spec's subject, and the
  // off-the-record context would log Chrome's refusal (support/push.ts).
  await ctxR.addInitScript(refusePushSubscription)
  const spyR = await spyOnPages(ctxR)
  // Boots: sofi 1 (login); rafa, per page: the login page 1, the page of the click 1, the page opened after the
  // click 3 (its boot, the reload with the expired target, the reload into English).
  const consoleS = new ConsoleLedger('sofi', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  const consoleR = new ConsoleLedger('rafa', [...FIRST_LOGIN_404, ...recognizedSet404(3)])
  try {
    const pageS = await ctxS.newPage()
    let pageR = await ctxR.newPage()
    consoleS.watch(pageS, 'S')
    consoleR.watch(pageR, 'R1')
    // Not an app window: it keeps rafa's context (and its worker) while the app page is closed.
    const elsewhere = await ctxR.newPage()
    let push: (p: unknown) => Promise<void> = async () => {}
    // Rafa's app, opened again in a new page (the session is the context's), on the org channel.
    const openApp = async (label: string): Promise<Page> => {
      const page = await ctxR.newPage()
      consoleR.watch(page, label)
      await pinAppLocale(page)
      await page.goto('/')
      await expect(title(page)).toBeVisible()
      return page
    }

    await test.step('1. /sw.js is registered and controls the app; the app works', async () => {
      await signIn(pageS, SOFI)
      await signIn(pageR, RAFA)
      const script = await pageR.evaluate(async () => (await navigator.serviceWorker.ready).active?.scriptURL)
      expect(new URL(script!).pathname).toBe('/sw.js')
      await expect.poll(() => pageR.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true)
      await startDm(pageS, RAFA_NAME)
      await expect(dmWith(pageR, SOFI_NAME)).toBeVisible()
      await orgChannel(pageR).click()
      push = await pusher(elsewhere)
      await spyOnWorker(spyR)
    })

    await test.step('5. the app open (visible and focused for the worker): a push shows nothing', async () => {
      const payload = base({ kind: 'direct' })
      await push(payload)
      await pageR.waitForTimeout(SETTLE_MS)
      expect((await shownBy(spyR)).filter((n) => n.tag === payload.conversation)).toEqual([])
    })

    let live: Seen
    await test.step('4. sofi\'s DM notifies through the registration, with the content; app closed, another message replaces it', async () => {
      const m1 = `m-1 ${ts}`
      await send(pageS, m1)
      await expect.poll(async () => (await shownBy(spyR)).length).toBe(1)
      live = (await shownBy(spyR))[0]!
      expect({ title: live.title, body: live.body }).toEqual({ title: SOFI_NAME, body: m1 })
      expect(live.tag).toBe(live.data?.conversation)
      expect(live.data?.message).toBeTruthy()
      expect(live.data?.thread).toBeUndefined()
      expectClean(live)
      await pageR.close()

      const other = `msg-other-${ts}`
      await push({ v: 1, kind: 'direct', invite: false, conversation: live.data!.conversation, message: other, author: SOFI_NAME })
      await expect.poll(async () => (await shownBy(spyR)).find((n) => n.data?.message === other)).toBeDefined()
      const replaced = (await shownBy(spyR)).find((n) => n.data?.message === other)!
      expect({ title: replaced.title, body: replaced.body, tag: replaced.tag }).toEqual({ title: SOFI_NAME, body: 'Nova mensagem', tag: live.tag })
    })

    await test.step('2 and 3. titles and bodies, pt-BR (the language the page wrote), no protocol identifier', async () => {
      await expectRows(spyR, push, 'pt')
    })

    await test.step('6. the click with the app open on another conversation: the DM is selected; the URL gains nothing', async () => {
      const other = `msg-click-${ts}`
      await push({ v: 1, kind: 'direct', invite: false, conversation: live.data!.conversation, message: other, author: SOFI_NAME })
      await expect.poll(async () => (await shownBy(spyR)).map((n) => n.data?.message)).toEqual([other])
      pageR = await openApp('R2')
      await orgChannel(pageR).click()
      const before = pageR.url()
      await clickOn(spyR, other)
      await expect(dmWith(pageR, SOFI_NAME)).toHaveAttribute('aria-current', 'true')
      expect(pageR.url()).toBe(before)
      await expect.poll(async () => await closedBy(spyR)).toEqual([live.tag])
      await orgChannel(pageR).click()
    })

    await test.step('7. the click on a thread reply opens the thread on the reply', async () => {
      const t1 = `t-1 ${ts}`
      const t2 = `t-2 ${ts}`
      await send(pageS, t1)
      const root = row(pageS, t1)
      await root.hover()
      await root.getByRole('button', { name: TIMELINE.replyInThread }).click()
      const panelS = threadPanel(pageS)
      await panelS.getByRole('textbox', { name: COMPOSER.editor, exact: true }).fill(t2)
      await panelS.getByRole('button', { name: COMPOSER.send }).click()
      await expect(panelS.getByRole('log', { name: THREAD.replies })).toContainText(t2)
      await expect.poll(async () => (await shownBy(spyR)).find((n) => n.body === t2)?.data?.thread).toBeTruthy()
      const reply = (await shownBy(spyR)).find((n) => n.body === t2)!
      expectClean(reply)
      await clickOn(spyR, reply.data!.message!)
      await expect(dmWith(pageR, SOFI_NAME)).toHaveAttribute('aria-current', 'true')
      const panelR = threadPanel(pageR)
      await expect(panelR).toBeVisible({ timeout: 30_000 })
      await expect(highlighted(pageR)).toContainText(t2, { timeout: 30_000 })
      await expectNoProtocolLeak(pageR)
      await orgChannel(pageR).click()
      await closeAll(spyR)
    })

    await test.step('8. the app closed: the click leaves the target, and the app opens on the DM; a target older than 5 minutes is ignored', async () => {
      const m3 = `m-3 ${ts}`
      await send(pageS, m3)
      await expect.poll(async () => (await shownBy(spyR)).find((n) => n.body === m3)).toBeDefined()
      const target = (await shownBy(spyR)).find((n) => n.body === m3)!.data!
      await pageR.close()
      await clickOn(spyR, target.message!)
      // Phase 0: under automation the worker may not open the window; the test opens it when it did not.
      await elsewhere.waitForTimeout(SETTLE_MS)
      const opened = ctxR.pages().find((p) => onApp(p.url()))
      console.log(`[e2e] the worker opened the app window on the click: ${opened ? 'yes' : 'no'}`)
      if (opened) {
        pageR = opened
        consoleR.watch(pageR, 'R3')
      } else {
        pageR = await openApp('R3')
      }
      await expect(dmWith(pageR, SOFI_NAME)).toHaveAttribute('aria-current', 'true', { timeout: 30_000 })
      await expect(messages(pageR)).toContainText(m3)
      expect(new URL(pageR.url()).pathname).toBe('/')
      expect(new URL(pageR.url()).search).toBe('')

      await orgChannel(pageR).click()
      await pageR.evaluate(
        async ({ cache, key, target: t }) => {
          const c = await caches.open(cache)
          await c.put(key, new Response(JSON.stringify({ target: t, at: Date.now() - 6 * 60_000 })))
        },
        { cache: SW_CACHE, key: PENDING_KEY, target },
      )
      await pageR.reload()
      await expect(title(pageR)).toBeVisible()
      await expect(orgChannel(pageR)).toHaveAttribute('aria-current', 'true')
      await pageR.waitForTimeout(SETTLE_MS)
      await expect(dmWith(pageR, SOFI_NAME)).not.toHaveAttribute('aria-current', 'true')
      expect(await pageR.evaluate(async ({ cache, key }) => (await (await caches.open(cache)).match(key)) === undefined, { cache: SW_CACHE, key: PENDING_KEY })).toBe(true)
    })

    await test.step('2 and 3, English: the device speaks English, the page applies it, the worker writes in it', async () => {
      await pinAppLocale(pageR, 'en-US')
      await pageR.reload()
      await expect(pageR.locator('html')).toHaveAttribute('lang', 'en')
      await pageR.close()
      await expectRows(spyR, push, 'en')
    })

    console.log(`[e2e] console S: ${JSON.stringify(consoleS.observed())}`)
    console.log(`[e2e] console R: ${JSON.stringify(consoleR.observed())}`)
    consoleS.expectClean()
    consoleR.expectClean()
  } finally {
    await ctxS.close()
    await ctxR.close()
  }
})
