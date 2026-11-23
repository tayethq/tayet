import { test, expect, type Locator, type Page } from '@playwright/test'
import { HOMESERVER } from '../test/support/synapse'
import { LUZ, RUI } from './fixtures/users'
import { accountSettings } from './support/account'
import { expectNoProtocolLeak } from './support/assertions'
import { ConsoleLedger, FIRST_LOGIN_404, recognizedSet404 } from './support/console'
import { AGENTS, APPROVAL, AWAITING, LIST, MANAGE, PEOPLE } from './support/labels'
import { signIn } from './support/login'
import { addMember, createChannel, deleteSharedRooms, openManage } from './support/rooms'
import { channelRow, conversations, highlighted, row } from './support/workspace'

// Phone project (PLANO-MOBILE M9b; workspace.md §23.2 item 5, §23.4), on the mould of agent-forms.spec.ts: luz
// creates the agent through the UI on a wide window and puts it in two public channels with rui; the spec plays
// the agent by raw fetch with the credential the UI showed. rui, at 390×844 with touch, meets the row with two
// cards, opens "Aguardando você", answers one there (it stays, answered; the counts drop), opens the other's
// conversation from its origin with the card marked, comes back through the screen to the list, and answers the
// last one in the conversation: the row goes.
//
// Secrets: the credential is in the DOM while the dialog is open → no trace, video or screenshot.
test.use({ trace: 'off', video: 'off', screenshot: 'off' })

const suffix = Math.random().toString(36).slice(2, 8)
const NAME = `Aprovador ${suffix}`
const CH1 = `aguardando-a-${suffix}`
const CH2 = `aguardando-b-${suffix}`
const SEEN_MS = 60_000
// The product's wire names, literal as in agent-forms.spec.ts (ADR-088 dec. 3).
const APPROVAL_TYPE = 'io.tayet.approval'
const RESPONSE_REL = 'io.tayet.response'

type Raw = { event_id: string; content: Record<string, unknown> }
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
  async card(room: string, text: string): Promise<string> {
    this.txn += 1
    const path = `v3/rooms/${encodeURIComponent(room)}/send/m.room.message/awaiting${this.txn}_${suffix}`
    const content = {
      msgtype: APPROVAL_TYPE,
      body: text,
      [APPROVAL_TYPE]: { options: [{ id: 'yes', label: 'Aprovar', style: 'primary' }, { id: 'no', label: 'Recusar' }] },
    }
    return (await this.call<{ event_id: string }>(path, 'PUT', content)).event_id
  }
  async answers(room: string, anchor: string): Promise<Raw[]> {
    const path = `v1/rooms/${encodeURIComponent(room)}/relations/${encodeURIComponent(anchor)}/${encodeURIComponent(RESPONSE_REL)}?dir=f&limit=100`
    return (await this.call<{ chunk: Raw[] }>(path)).chunk
  }
}

async function poll<T>(get: () => Promise<T | undefined>, what: string): Promise<T> {
  let found: T | undefined
  await expect.poll(async () => (found = await get()) !== undefined, { message: what, timeout: SEEN_MS, intervals: [500] }).toBe(true)
  return found!
}

const depth = (page: Page) => page.evaluate(() => (history.state as { depth?: number } | null)?.depth ?? 0)
const awaitingRow = (page: Page): Locator => conversations(page).getByRole('button', { name: new RegExp(`^${AWAITING.title}`) })
const awaitingScreen = (page: Page): Locator => page.getByRole('region', { name: AWAITING.title, exact: true })
// The count while the list is covered (inert, out of the accessibility tree): by its class.
const coveredCount = (page: Page): Locator => page.locator('.sidebar .awaiting-row__count')
const screenCard = (page: Page, text: string): Locator =>
  awaitingScreen(page).getByRole('group', { name: APPROVAL.title }).filter({ hasText: text })

test('"Aguardando você" on the phone: the row, the screen, an answer that stays, the origin and the way back', async ({ browser }) => {
  test.setTimeout(480_000)
  await deleteSharedRooms('luz', 'rui')
  const ctxLuz = await browser.newContext({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 })
  const ctxRui = await browser.newContext()
  const ledgerLuz = new ConsoleLedger('luz', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  const ledgerRui = new ConsoleLedger('rui', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  const ask1 = `Pagar a nota ${suffix}?`
  const ask2 = `Enviar o resumo ${suffix}?`
  try {
    const luz = await ctxLuz.newPage()
    const rui = await ctxRui.newPage()
    ledgerLuz.watch(luz, 'luz')
    ledgerRui.watch(rui, 'rui')
    let agent!: Agent
    const rooms: Record<string, string> = {}

    await test.step('0a. the pair enters; luz creates two public channels and adds rui to both', async () => {
      await signIn(rui, RUI)
      await signIn(luz, LUZ)
      for (const name of [CH1, CH2]) {
        await createChannel(luz, { name, kind: 'public' })
        await openManage(luz, name, 'public')
        await addMember(luz, 'rui')
        await luz.getByRole('button', { name: MANAGE.close }).click()
        await expect(channelRow(rui, name)).toBeVisible({ timeout: SEEN_MS })
      }
    })

    await test.step('0b. luz creates the agent through the UI and adds it to both channels; the agent joins', async () => {
      const account = await accountSettings(luz)
      await expect(account.getByText(PEOPLE.section)).toBeVisible({ timeout: 30_000 })
      await account.getByRole('button', { name: new RegExp(`^${PEOPLE.title}`) }).click()
      await luz.getByRole('dialog', { name: PEOPLE.title }).getByRole('button', { name: AGENTS.add }).click()
      const create = luz.getByRole('dialog', { name: AGENTS.createTitle })
      await create.getByLabel(AGENTS.fieldName).fill(NAME)
      await create.getByRole('button', { name: AGENTS.create }).click()
      const created = luz.getByRole('dialog', { name: AGENTS.createdTitle })
      await expect(created.getByText(AGENTS.credentialOnce)).toBeVisible({ timeout: SEEN_MS })
      const credential = (await created.locator('[data-agent-credential]').textContent())?.trim() ?? ''
      expect(credential.length).toBeGreaterThan(20)
      agent = new Agent(credential)
      await created.getByRole('button', { name: AGENTS.done }).click()
      await expect(async () => {
        if ((await luz.getByRole('dialog').count()) > 0) await luz.keyboard.press('Escape')
        await expect(luz.getByRole('dialog')).toHaveCount(0, { timeout: 1_000 })
      }).toPass({ timeout: 15_000 })
      for (const name of [CH1, CH2]) {
        await openManage(luz, name, 'public')
        await luz.getByRole('button', { name: MANAGE.addMember }).click()
        const candidate = luz.getByRole('dialog', { name: MANAGE.addMember }).getByRole('button', { name: new RegExp(NAME) })
        await expect(candidate).toBeVisible({ timeout: 30_000 })
        await candidate.click()
        rooms[name] = await poll(() => agent.invitedRoom(name), `the invite to ${name} reaches the agent`)
        await agent.join(rooms[name]!)
        const member = luz.getByRole('region', { name: MANAGE.members }).getByRole('listitem').filter({ hasText: NAME })
        await expect(member).toBeVisible({ timeout: 30_000 })
        await expect(member.getByText(MANAGE.awaiting)).toHaveCount(0, { timeout: SEEN_MS })
        await luz.getByRole('button', { name: MANAGE.close }).click()
      }
    })

    let card1 = ''
    let card2 = ''
    await test.step('1. two cards in two conversations: the row shows 2 and the summary', async () => {
      card1 = await agent.card(rooms[CH1]!, ask1)
      card2 = await agent.card(rooms[CH2]!, ask2)
      expect(await depth(rui)).toBe(0)
      await expect(awaitingRow(rui)).toBeVisible({ timeout: SEEN_MS })
      await expect(awaitingRow(rui).locator('.awaiting-row__count')).toHaveText('2', { timeout: SEEN_MS })
      await expect(awaitingRow(rui)).toContainText(AWAITING.summary(2, NAME))
      expect((await awaitingRow(rui).boundingBox())!.height).toBeGreaterThanOrEqual(56)
    })

    await test.step('2. the row opens the screen, the focus on its back, the newest card first', async () => {
      await awaitingRow(rui).click()
      await expect(awaitingScreen(rui)).toBeVisible()
      await expect.poll(() => depth(rui)).toBe(1)
      await expect(awaitingScreen(rui).getByRole('button', { name: 'Voltar' })).toBeFocused()
      await expect(awaitingScreen(rui).locator('.ui-screen-header__subtitle')).toHaveText(AWAITING.summary(2, NAME))
      const cards = awaitingScreen(rui).getByRole('group', { name: APPROVAL.title })
      await expect(cards).toHaveCount(2)
      await expect(cards.first()).toContainText(ask2)
      await expect(cards.first().locator('.awaiting-origin')).toContainText(AWAITING.inChannel(`#${CH2}`))
      await expectNoProtocolLeak(rui)
    })

    await test.step('3. answering one there: the card stays, answered; the subtitle and the count drop to 1', async () => {
      await screenCard(rui, ask2).getByRole('button', { name: 'Aprovar' }).click()
      await poll(async () => (await agent.answers(rooms[CH2]!, card2))[0], "rui's answer on the server")
      await expect(screenCard(rui, ask2).getByText(new RegExp(`^${APPROVAL.you} às \\d{2}:\\d{2}$`))).toBeVisible({ timeout: SEEN_MS })
      await expect(screenCard(rui, ask2).getByRole('button', { name: 'Aprovar' })).toHaveCount(0)
      await expect(awaitingScreen(rui).locator('.ui-screen-header__subtitle')).toHaveText(AWAITING.summary(1, NAME), { timeout: SEEN_MS })
      await expect(coveredCount(rui)).toHaveText('1')
      await expect(awaitingScreen(rui).getByRole('group', { name: APPROVAL.title })).toHaveCount(2)
    })

    await test.step("4. the other card's origin opens its conversation with the card marked", async () => {
      await screenCard(rui, ask1).locator('.awaiting-origin').click()
      await expect(rui.getByRole('main')).toBeVisible({ timeout: SEEN_MS })
      await expect(highlighted(rui)).toContainText(ask1, { timeout: 30_000 })
      await expect.poll(() => depth(rui)).toBe(2)
    })

    await test.step('5. back finds the screen with both cards; back again the list, with the row at 1', async () => {
      await rui.goBack()
      await expect(awaitingScreen(rui)).toBeVisible()
      await expect.poll(() => depth(rui)).toBe(1)
      await expect(awaitingScreen(rui).getByRole('group', { name: APPROVAL.title })).toHaveCount(2)
      await rui.goBack()
      await expect(awaitingScreen(rui)).toHaveCount(0)
      await expect.poll(() => depth(rui)).toBe(0)
      await expect(awaitingRow(rui).locator('.awaiting-row__count')).toHaveText('1')
      await expect(awaitingRow(rui)).toContainText(AWAITING.summary(1, NAME))
      await expect(awaitingRow(rui)).toBeFocused()
    })

    await test.step('6. answering the last one in its conversation: the row goes', async () => {
      await channelRow(rui, CH1).click()
      await expect.poll(() => depth(rui)).toBe(1)
      const inChat = row(rui, ask1).getByRole('group', { name: APPROVAL.title })
      await inChat.getByRole('button', { name: 'Recusar' }).click()
      await poll(async () => (await agent.answers(rooms[CH1]!, card1))[0], "rui's second answer on the server")
      await expect(inChat.getByText(new RegExp(`^${APPROVAL.you} às \\d{2}:\\d{2}$`))).toBeVisible({ timeout: SEEN_MS })
      await rui.goBack()
      await expect.poll(() => depth(rui)).toBe(0)
      await expect(conversations(rui).getByRole('region', { name: LIST.channels })).toBeVisible()
      await expect(awaitingRow(rui)).toHaveCount(0, { timeout: SEEN_MS })
      await expectNoProtocolLeak(rui, luz)
    })

    ledgerLuz.expectClean()
    ledgerRui.expectClean()
  } finally {
    await ctxLuz.close()
    await ctxRui.close()
    await deleteSharedRooms('luz', 'rui')
  }
})
