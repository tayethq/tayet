import { test, expect, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { HOMESERVER } from '../test/support/synapse'
import { escapeRegExp } from '../test/support/stack-env'
import { CRIS, DUDA } from './fixtures/users'
import { expectNoProtocolLeak } from './support/assertions'
import { ConsoleLedger, FIRST_LOGIN_404, recognizedSet404, type ExpectedMessage } from './support/console'
import { AGENTS, AWAITING, CONNECTION, MANAGE } from './support/labels'
import { closeAdmin, openAdmin } from './support/admin'
import { signIn } from './support/login'
import { addMember, closePicker, createChannel, deleteSharedRooms, openManage } from './support/rooms'
import { channelRow, conversations } from './support/workspace'

// Phone project (ADR-114, Proposto; PLANO-MOBILE §0.23 and §8.26): the connection state on opening and without a
// network. The screen subscribes to the stream after connect resolves, so before ADR-114 the strip stayed on screen
// after a reload until the next sync came back (9 to 30 s, measured on 23/Nov/2026); without a network, it waited for
// the SDK's own deadlines (26 to 31 s). cris creates an agent on a wide window and puts it in a channel with duda; the
// agent leaves one card, so "Aguardando você" has something to show. duda, at 390×844 with touch, reloads with the
// session valid (no message arriving to wake the long poll), then loses the network on the list, in the conversation
// and in "Aguardando você", and gets it back. cris does the same with the sidebar's connection line on the wide window.
//
// Secrets: the agent's credential is in the DOM while the dialog is open → no trace, video or screenshot.
test.use({ trace: 'off', video: 'off', screenshot: 'off' })

const suffix = Math.random().toString(36).slice(2, 8)
const NAME = `Conexão ${suffix}`
const CHANNEL = `conexao-${suffix}`
const SEEN_MS = 60_000
// ADR-114: with the connection good on opening, the strip is gone 3 s after the list is on screen; the browser's
// offline signal puts it up within 3 s.
const OPEN_MS = 3_000
const OFFLINE_MS = 3_000
// Back online, the ACL reports the state the sync has. Measured locally (PLANO-MOBILE §8.26): 103 to 108 ms — the
// request in flight at the cut survives it, and the sync never left 'connected'. The slack covers a cut in which a sync
// request does fail: the SDK's first poke comes 2 to 7 s later and waits 2 s before the next sync (sync.js:1418, 1480).
const ONLINE_MS = 15_000
// The product's wire names, literal as in awaiting.narrow.spec.ts (ADR-088 dec. 3).
const APPROVAL_TYPE = 'io.tayet.approval'

const STATES = new RegExp(`^(${[CONNECTION.connecting, CONNECTION.reconnecting, CONNECTION.offline].map(escapeRegExp).join('|')})$`)
// The connection status inside a screen: the strip (narrow) or the sidebar's line (wide). By role and text.
const connectionIn = (scope: Locator): Locator => scope.getByRole('status').filter({ hasText: STATES })
// The list is the sidebar; on a narrow window it is one of the stack's screens. By its class, as in
// awaiting.narrow.spec.ts: the aside has no accessible name.
const list = (page: Page): Locator => page.locator('aside.sidebar')
const main = (page: Page): Locator => page.getByRole('main')
const awaitingRow = (page: Page): Locator => conversations(page).getByRole('button', { name: new RegExp(`^${AWAITING.title}`) })
const awaitingScreen = (page: Page): Locator => page.getByRole('region', { name: AWAITING.title, exact: true })
const depth = (page: Page) => page.evaluate(() => (history.state as { depth?: number } | null)?.depth ?? 0)

// While the context is offline every request fails without a status; Chromium logs each one. Matched by the exact
// text and by the server's origin, capped per page.
const OFFLINE_MESSAGES: ReadonlyArray<ExpectedMessage> = [
  {
    text: 'Failed to load resource: net::ERR_INTERNET_DISCONNECTED',
    at: new RegExp(`^${escapeRegExp(HOMESERVER)}/`),
    max: 40,
    why: 'requests to the server while the spec holds the context offline',
  },
]

class Agent {
  private txn = 0
  constructor(private readonly token: string) {}
  private async call<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const res = await fetch(`${HOMESERVER}/_matrix/client/${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, ...(body !== undefined && { 'Content-Type': 'application/json' }) },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    })
    if (!res.ok) throw new Error(`agent ${method} ${path.split('/').slice(0, 2).join('/')} -> ${res.status}`)
    return (await res.json()) as T
  }
  async invitedRoom(name: string): Promise<string | undefined> {
    // A nonce in the filter keeps the server's /sync cache from answering an older snapshot.
    const filter = { room: { timeline: { limit: 1 } }, account_data: { not_types: [`nonce.${Math.random().toString(36).slice(2)}`] } }
    const body = await this.call<{ rooms?: { invite?: Record<string, { invite_state?: { events?: Array<{ type: string; content?: { name?: string } }> } }> } }>(
      `v3/sync?timeout=0&filter=${encodeURIComponent(JSON.stringify(filter))}`,
    )
    return Object.entries(body.rooms?.invite ?? {}).find(([, r]) =>
      r.invite_state?.events?.some((e) => e.type === 'm.room.name' && e.content?.name === name),
    )?.[0]
  }
  async join(room: string): Promise<void> {
    await this.call(`v3/join/${encodeURIComponent(room)}`, 'POST', {})
  }
  async card(room: string, text: string): Promise<void> {
    this.txn += 1
    const path = `v3/rooms/${encodeURIComponent(room)}/send/m.room.message/connection${this.txn}_${suffix}`
    const content = {
      msgtype: APPROVAL_TYPE,
      body: text,
      [APPROVAL_TYPE]: { options: [{ id: 'yes', label: 'Aprovar', style: 'primary' }, { id: 'no', label: 'Recusar' }] },
    }
    await this.call(path, 'PUT', content)
  }
}

async function poll<T>(get: () => Promise<T | undefined>, what: string): Promise<T> {
  let found: T | undefined
  await expect.poll(async () => (found = await get()) !== undefined, { message: what, timeout: SEEN_MS, intervals: [500] }).toBe(true)
  return found!
}

// How long until `done` holds, polled every 100 ms, up to `cap`. The number goes to the report (PLANO-MOBILE §8.26).
async function measure(what: string, done: () => Promise<boolean>, cap = 60_000): Promise<number> {
  const t0 = Date.now()
  while (!(await done()) && Date.now() - t0 < cap) await new Promise((r) => setTimeout(r, 100))
  const ms = Date.now() - t0
  console.log(`CONNECTION_MS ${what} ms=${ms}`)
  test.info().annotations.push({ type: 'connection-ms', description: `${what}: ${ms} ms` })
  return ms
}
const gone = (scope: Locator) => async () => (await connectionIn(scope).count()) === 0
const showsOffline = (scope: Locator) => async () => (await connectionIn(scope).allTextContents()).includes(CONNECTION.offline)

const ledgers = { cris: new ConsoleLedger('cris', [...FIRST_LOGIN_404, ...recognizedSet404(2)]), duda: new ConsoleLedger('duda', [...FIRST_LOGIN_404, ...recognizedSet404(2)]) }
const contexts: Record<'cris' | 'duda', BrowserContext | undefined> = { cris: undefined, duda: undefined }
let cris: Page
let duda: Page

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000)
  await deleteSharedRooms('cris', 'duda')
  contexts.cris = await browser.newContext({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 })
  contexts.duda = await browser.newContext()
  cris = await contexts.cris.newPage()
  duda = await contexts.duda.newPage()
  ledgers.cris.watch(cris, 'cris')
  ledgers.duda.watch(duda, 'duda')
  await signIn(duda, DUDA)
  await signIn(cris, CRIS)

  await createChannel(cris, { name: CHANNEL, kind: 'public' })
  await openManage(cris, CHANNEL, 'public')
  await addMember(cris, 'duda')
  await cris.getByRole('button', { name: MANAGE.close }).click()
  await expect(channelRow(duda, CHANNEL)).toBeVisible({ timeout: SEEN_MS })

  // The agent, through the UI as in awaiting.narrow.spec.ts; it joins and leaves one card for duda.
  // Slice 1c: "Pessoas" lives in the Admin, opened from "Sua conta".
  await openAdmin(cris)
  await cris.getByRole('button', { name: AGENTS.add }).click()
  const create = cris.getByRole('dialog', { name: AGENTS.createTitle })
  await create.getByLabel(AGENTS.fieldName).fill(NAME)
  await create.getByRole('button', { name: AGENTS.create }).click()
  const created = cris.getByRole('dialog', { name: AGENTS.createdTitle })
  await expect(created.getByText(AGENTS.credentialOnce)).toBeVisible({ timeout: SEEN_MS })
  const credential = (await created.locator('[data-agent-credential]').textContent())?.trim() ?? ''
  expect(credential.length).toBeGreaterThan(20)
  const agent = new Agent(credential)
  await created.getByRole('button', { name: AGENTS.done }).click()
  await expect(async () => {
    if ((await cris.getByRole('dialog').count()) > 0) await cris.keyboard.press('Escape')
    await expect(cris.getByRole('dialog')).toHaveCount(0, { timeout: 1_000 })
  }).toPass({ timeout: 15_000 })
  // Back from the Admin to the conversations.
  await closeAdmin(cris)
  await openManage(cris, CHANNEL, 'public')
  await cris.getByRole('button', { name: MANAGE.addMember }).click()
  const candidate = cris.getByRole('dialog', { name: MANAGE.addMember }).getByRole('button', { name: new RegExp(NAME) })
  await expect(candidate).toBeVisible({ timeout: 30_000 })
  await candidate.click()
  await closePicker(cris, candidate)
  const room = await poll(() => agent.invitedRoom(CHANNEL), 'the invite reaches the agent')
  await agent.join(room)
  const member = cris.getByRole('region', { name: MANAGE.members }).getByRole('listitem').filter({ hasText: NAME })
  await expect(member).toBeVisible({ timeout: 30_000 })
  await expect(member.getByText(MANAGE.awaiting)).toHaveCount(0, { timeout: SEEN_MS })
  await cris.getByRole('button', { name: MANAGE.close }).click()
  await agent.card(room, `Liberar o acesso ${suffix}?`)
  await expect(awaitingRow(duda)).toBeVisible({ timeout: SEEN_MS })
})

test.afterAll(async () => {
  await contexts.cris?.close()
  await contexts.duda?.close()
  await deleteSharedRooms('cris', 'duda')
})

test('the phone: no strip after a reload; offline on the list, in the conversation and in "Aguardando você"; back online', async () => {
  test.setTimeout(240_000)

  await test.step('1. reload with the session valid: 3 s after the list is on screen, no strip', async () => {
    await duda.reload()
    await expect(channelRow(duda, CHANNEL)).toBeVisible({ timeout: SEEN_MS })
    const ms = await measure('phone open → strip gone', gone(list(duda)))
    expect(ms, 'the strip after the list is on screen').toBeLessThanOrEqual(OPEN_MS)
    await expect(connectionIn(list(duda))).toHaveCount(0)
  })

  await test.step('2. offline: the strip says so within 3 s — on the list, in the conversation, in "Aguardando você"', async () => {
    // The row of "Aguardando você" comes once the reader's first pass after the reload ends, and that pass reads
    // from the server (ADR-099): the network is cut only after it, or the row never comes while offline.
    await expect(awaitingRow(duda)).toBeVisible({ timeout: SEEN_MS })
    ledgers.duda.allow([], OFFLINE_MESSAGES)
    await contexts.duda!.setOffline(true)
    const ms = await measure('phone offline → strip', showsOffline(list(duda)))
    expect(ms, 'the offline strip on the list').toBeLessThanOrEqual(OFFLINE_MS)
    await expect(connectionIn(list(duda))).toHaveText(CONNECTION.offline)

    await channelRow(duda, CHANNEL).click({ timeout: 15_000 })
    await expect.poll(() => depth(duda)).toBe(1)
    await expect(connectionIn(main(duda))).toHaveText(CONNECTION.offline, { timeout: OFFLINE_MS })

    await duda.goBack()
    await expect.poll(() => depth(duda)).toBe(0)
    await awaitingRow(duda).click({ timeout: 15_000 })
    await expect(awaitingScreen(duda)).toBeVisible()
    await expect.poll(() => depth(duda)).toBe(1)
    await expect(connectionIn(awaitingScreen(duda))).toHaveText(CONNECTION.offline, { timeout: OFFLINE_MS })
  })

  await test.step('3. back online: the strip goes', async () => {
    await contexts.duda!.setOffline(false)
    const ms = await measure('phone online → strip gone', gone(awaitingScreen(duda)))
    expect(ms, 'the strip after the network came back').toBeLessThanOrEqual(ONLINE_MS)
    await duda.goBack()
    await expect.poll(() => depth(duda)).toBe(0)
    await expect(connectionIn(list(duda))).toHaveCount(0)
    await expectNoProtocolLeak(duda)
  })

  ledgers.duda.expectClean()
})

test("the wide window: no sidebar line after a reload; offline within 3 s; back online", async () => {
  test.setTimeout(180_000)

  await test.step('1. reload with the session valid: 3 s after the list is on screen, no connection line', async () => {
    await cris.reload()
    await expect(channelRow(cris, CHANNEL)).toBeVisible({ timeout: SEEN_MS })
    const ms = await measure('wide open → line gone', gone(list(cris)))
    expect(ms, 'the sidebar line after the list is on screen').toBeLessThanOrEqual(OPEN_MS)
    await expect(connectionIn(list(cris))).toHaveCount(0)
  })

  await test.step('2. offline: the line says so within 3 s', async () => {
    ledgers.cris.allow([], OFFLINE_MESSAGES)
    await contexts.cris!.setOffline(true)
    const ms = await measure('wide offline → line', showsOffline(list(cris)))
    expect(ms, 'the offline line').toBeLessThanOrEqual(OFFLINE_MS)
    await expect(connectionIn(list(cris))).toHaveText(CONNECTION.offline)
  })

  await test.step('3. back online: the line goes', async () => {
    await contexts.cris!.setOffline(false)
    const ms = await measure('wide online → line gone', gone(list(cris)))
    expect(ms, 'the line after the network came back').toBeLessThanOrEqual(ONLINE_MS)
    await expectNoProtocolLeak(cris)
  })

  ledgers.cris.expectClean()
})
