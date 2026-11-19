import { test, expect, type Locator, type Page } from '@playwright/test'
import { HOMESERVER } from '../test/support/synapse'
import { TAI, UGO, YURI } from './fixtures/users'
import { accountSettings } from './support/account'
import { expectNoProtocolLeak } from './support/assertions'
import { ConsoleLedger, FIRST_LOGIN_404, recognizedSet404 } from './support/console'
import { AGENTS, APPROVAL, MANAGE, PEOPLE } from './support/labels'
import { signIn } from './support/login'
import { addMember, createChannel, deleteSharedRooms, openManage } from './support/rooms'
import { channelRow, row } from './support/workspace'

// A card that asks for several answers, end to end in three browsers, with no sidecar. tai creates the agent
// through the UI and puts it in a PUBLIC channel with ugo and yuri; the spec plays the agent by raw fetch
// with the credential the UI showed — the cards and their close. A card asking for 2: all three see the
// buttons and the counter; the first answer shows as "Você" on its author's screen, without buttons, and as
// a line with the buttons and the counter on the others'; the second answer completes it: two lines on every
// screen, no counter, no buttons, no "Pedido encerrado". The agent seals it and nothing changes, not even
// after a reload. A card asking for 3: one answer, then the agent closes it: the line and "Pedido
// encerrado" everywhere, no buttons. No protocol on screen.
//
// Secrets: the credential is in the DOM while the dialog is open → no trace, video or screenshot.
test.use({ trace: 'off', video: 'off', screenshot: 'off' })

const suffix = Math.random().toString(36).slice(2, 8)
const NAME = `Aprovador ${suffix}`
const CHANNEL = `aprovadores-${suffix}`
const SEEN_MS = 60_000
// The product's wire name (the E2E never imports the shared package's internals), literal here.
const APPROVAL_TYPE = 'io.tayet.approval'
const OPTIONS = [
  { id: 'approve', label: 'Aprovar', style: 'primary' },
  { id: 'reject', label: 'Recusar' },
]

const peoplePanel = (page: Page): Locator => page.getByRole('dialog', { name: PEOPLE.title })
const card = (page: Page, text: string): Locator => row(page, text).getByRole('group', { name: APPROVAL.title })
const lines = (c: Locator): Locator => c.locator('.approval__answers > .approval__footer')
const counter = (c: Locator): Locator => c.locator('.approval__count')
const optionButtons = (c: Locator): Locator => c.locator('.approval__options').getByRole('button')
const LINE = /^(Aprovar|Recusar)(.+) às \d{2}:\d{2}$/

async function readCredential(dialog: Locator): Promise<string> {
  await expect(dialog.getByText(AGENTS.credentialOnce)).toBeVisible()
  const credential = (await dialog.locator('[data-agent-credential]').textContent())?.trim() ?? ''
  expect(credential.length).toBeGreaterThan(20)
  return credential
}

async function poll<T>(get: () => Promise<T | undefined>, what: string, timeout = SEEN_MS): Promise<T> {
  let found: T | undefined
  await expect.poll(async () => (found = await get()) !== undefined, { message: what, timeout, intervals: [500] }).toBe(true)
  return found!
}

// The agent, by raw fetch with the credential shown once. No id or token reaches a log line.
class Agent {
  private txn = 0
  constructor(private readonly token: string) {}
  private auth(json = false): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, ...(json && { 'Content-Type': 'application/json' }) }
  }
  async invitedRoom(name: string): Promise<string | undefined> {
    const filter = { room: { timeline: { limit: 1 } }, account_data: { not_types: [`nonce.${Math.random().toString(36).slice(2)}`] } }
    const res = await fetch(`${HOMESERVER}/_matrix/client/v3/sync?timeout=0&filter=${encodeURIComponent(JSON.stringify(filter))}`, { headers: this.auth() })
    if (!res.ok) throw new Error(`agent sync -> ${res.status}`)
    const body = (await res.json()) as { rooms?: { invite?: Record<string, { invite_state?: { events?: Array<{ type: string; content?: { name?: string } }> } }> } }
    for (const [id, r] of Object.entries(body.rooms?.invite ?? {})) {
      if (r.invite_state?.events?.some((e) => e.type === 'm.room.name' && e.content?.name === name)) return id
    }
    return undefined
  }
  async join(roomId: string): Promise<void> {
    const res = await fetch(`${HOMESERVER}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, { method: 'POST', headers: this.auth(true), body: '{}' })
    if (!res.ok) throw new Error(`agent join -> ${res.status}`)
  }
  async send(roomId: string, content: Record<string, unknown>): Promise<string> {
    this.txn += 1
    const res = await fetch(`${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/appr${this.txn}_${suffix}`, {
      method: 'PUT',
      headers: this.auth(true),
      body: JSON.stringify(content),
    })
    if (!res.ok) throw new Error(`agent send -> ${res.status}`)
    return ((await res.json()) as { event_id: string }).event_id
  }
  card(roomId: string, text: string, needed: number): Promise<string> {
    return this.send(roomId, { msgtype: APPROVAL_TYPE, body: text, [APPROVAL_TYPE]: { options: OPTIONS, needed } })
  }
  // The close: an edit of the card carrying the closing mark.
  close(roomId: string, cardId: string, text: string, needed: number): Promise<string> {
    return this.send(roomId, {
      msgtype: APPROVAL_TYPE,
      body: `* ${text}`,
      'm.new_content': { msgtype: APPROVAL_TYPE, body: text, [APPROVAL_TYPE]: { options: OPTIONS, needed, closed: true } },
      'm.relates_to': { rel_type: 'm.replace', event_id: cardId },
    })
  }
}

test('several approvers: one line per answer, the counter, buttons only for who has not answered — three browsers, no sidecar', async ({ browser }) => {
  test.setTimeout(480_000)
  await deleteSharedRooms('tai', 'ugo')
  await deleteSharedRooms('tai', 'yuri')
  const ctx = [await browser.newContext(), await browser.newContext(), await browser.newContext()]
  const ledgers = [
    new ConsoleLedger('tai', [...FIRST_LOGIN_404, ...recognizedSet404(1)]),
    new ConsoleLedger('ugo', [...FIRST_LOGIN_404, ...recognizedSet404(1)]),
    // yuri's page boots twice (the reload in step 4): one read of the recognized set per boot.
    new ConsoleLedger('yuri', [...FIRST_LOGIN_404, ...recognizedSet404(2)]),
  ]
  const ask1 = `Publicar o layout novo ${suffix}?`
  const ask2 = `Renovar o contrato ${suffix}?`
  try {
    const pages = await Promise.all(ctx.map((c) => c.newPage()))
    const [pageA, pageB, pageC] = pages as [Page, Page, Page]
    ledgers.forEach((l, i) => l.watch(pages[i]!, 'ABC'[i]!))

    await test.step('0a. the three enter; tai creates a public channel and adds ugo and yuri', async () => {
      await signIn(pageC, YURI)
      await signIn(pageB, UGO)
      await signIn(pageA, TAI)
      await createChannel(pageA, { name: CHANNEL, kind: 'public' })
      await openManage(pageA, CHANNEL, 'public')
      await addMember(pageA, 'ugo')
      await addMember(pageA, 'yuri')
      await pageA.getByRole('button', { name: MANAGE.close }).click()
      for (const page of [pageB, pageC]) await expect(channelRow(page, CHANNEL)).toBeVisible({ timeout: SEEN_MS })
    })

    let agent!: Agent
    await test.step('0b. tai creates the agent through the UI; the spec keeps the credential shown once', async () => {
      const account = await accountSettings(pageA)
      await expect(account.getByText(PEOPLE.section)).toBeVisible({ timeout: 30_000 })
      await account.getByRole('button', { name: new RegExp(`^${PEOPLE.title}`) }).click()
      await expect(peoplePanel(pageA)).toBeVisible()
      await peoplePanel(pageA).getByRole('button', { name: AGENTS.add }).click()
      const dialog = pageA.getByRole('dialog', { name: AGENTS.createTitle })
      await dialog.getByLabel(AGENTS.fieldName).fill(NAME)
      await dialog.getByRole('button', { name: AGENTS.create }).click()
      const created = pageA.getByRole('dialog', { name: AGENTS.createdTitle })
      await expect(created).toBeVisible({ timeout: SEEN_MS })
      agent = new Agent(await readCredential(created))
      await created.getByRole('button', { name: AGENTS.done }).click()
      await expect(pageA.locator('[data-agent-credential]')).toHaveCount(0)
    })

    let roomId = ''
    await test.step('0c. tai adds the agent to the channel through the UI; the agent joins', async () => {
      await expect(async () => {
        if ((await pageA.getByRole('dialog').count()) > 0) await pageA.keyboard.press('Escape')
        await expect(pageA.getByRole('dialog')).toHaveCount(0, { timeout: 1_000 })
      }).toPass({ timeout: 15_000 })
      await openManage(pageA, CHANNEL, 'public')
      const candidate = pageA.getByRole('dialog', { name: MANAGE.addMember }).getByRole('button', { name: new RegExp(NAME) })
      await pageA.getByRole('button', { name: MANAGE.addMember }).click()
      await expect(candidate).toBeVisible({ timeout: 30_000 })
      await candidate.click()
      const member = pageA.getByRole('region', { name: MANAGE.members }).getByRole('listitem').filter({ hasText: NAME })
      await expect(member).toBeVisible({ timeout: 30_000 })
      roomId = await poll(() => agent.invitedRoom(CHANNEL), 'the invite reaches the agent')
      await agent.join(roomId)
      await expect(member.getByText(MANAGE.awaiting)).toHaveCount(0, { timeout: SEEN_MS })
      await pageA.getByRole('button', { name: MANAGE.close }).click()
      for (const page of pages) await channelRow(page, CHANNEL).click()
    })

    let card1 = ''
    await test.step('1. a card asking for 2: the three see the buttons and the counter with zero answers', async () => {
      card1 = await agent.card(roomId, ask1, 2)
      for (const page of pages) {
        const c = card(page, ask1)
        await expect(optionButtons(c)).toHaveText(['Aprovar', 'Recusar'], { timeout: SEEN_MS })
        await expect(counter(c)).toHaveText(APPROVAL.needs(2))
        await expect(lines(c)).toHaveCount(0)
      }
    })

    await test.step('2. ugo answers: "Você" on ugo’s screen, no buttons; the others see ugo’s line, the buttons and the counter', async () => {
      await card(pageB, ask1).getByRole('button', { name: 'Aprovar' }).click()
      const own = card(pageB, ask1)
      await expect(lines(own)).toHaveText([new RegExp(`^Aprovar${APPROVAL.you} às \\d{2}:\\d{2}$`)], { timeout: SEEN_MS })
      await expect(optionButtons(own)).toHaveCount(0)
      await expect(counter(own)).toHaveText(APPROVAL.progress(1, 2))
      for (const page of [pageA, pageC]) {
        const c = card(page, ask1)
        await expect(lines(c)).toHaveText([/^Aprovarugo às \d{2}:\d{2}$/], { timeout: SEEN_MS })
        await expect(optionButtons(c)).toHaveCount(2)
        await expect(counter(c)).toHaveText(APPROVAL.progress(1, 2))
      }
    })

    await test.step('3. yuri answers: two lines on every screen, no counter, no buttons, no "Pedido encerrado"', async () => {
      await card(pageC, ask1).getByRole('button', { name: 'Recusar' }).click()
      for (const [page, ugo, yuri] of [
        [pageA, 'ugo', 'yuri'],
        [pageB, APPROVAL.you, 'yuri'],
        [pageC, 'ugo', APPROVAL.you],
      ] as const) {
        const c = card(page, ask1)
        await expect(lines(c)).toHaveText([new RegExp(`^Aprovar${ugo} às \\d{2}:\\d{2}$`), new RegExp(`^Recusar${yuri} às \\d{2}:\\d{2}$`)], { timeout: SEEN_MS })
        await expect(counter(c)).toHaveCount(0)
        await expect(optionButtons(c)).toHaveCount(0)
        await expect(c.getByText(APPROVAL.closed)).toHaveCount(0)
      }
    })

    await test.step('4. the agent seals the card: nothing changes; after a reload yuri’s card is the same', async () => {
      const before = await Promise.all(pages.map((p) => lines(card(p, ask1)).allTextContents()))
      await agent.close(roomId, card1, ask1, 2)
      // A barrier: a second card reaches everyone after the seal.
      const barrier = `Barreira ${suffix}`
      await agent.card(roomId, barrier, 2)
      for (const page of pages) await expect(card(page, barrier)).toBeVisible({ timeout: SEEN_MS })
      for (let i = 0; i < pages.length; i++) {
        const c = card(pages[i]!, ask1)
        await expect(lines(c)).toHaveText(before[i]!)
        await expect(counter(c)).toHaveCount(0)
        await expect(c.getByText(APPROVAL.closed)).toHaveCount(0)
      }
      await pageC.reload()
      await channelRow(pageC, CHANNEL).click()
      const c = card(pageC, ask1)
      await expect(lines(c)).toHaveText(before[2]!, { timeout: SEEN_MS })
      await expect(counter(c)).toHaveCount(0)
      await expect(optionButtons(c)).toHaveCount(0)
      await expect(c.getByText(APPROVAL.closed)).toHaveCount(0)
    })

    await test.step('5. a card asking for 3: tai answers, the agent closes it; the line and "Pedido encerrado" everywhere, no buttons', async () => {
      const card2 = await agent.card(roomId, ask2, 3)
      for (const page of pages) await expect(counter(card(page, ask2))).toHaveText(APPROVAL.needs(3), { timeout: SEEN_MS })
      await card(pageA, ask2).getByRole('button', { name: 'Recusar' }).click()
      for (const page of pages) await expect(counter(card(page, ask2))).toHaveText(APPROVAL.progress(1, 3), { timeout: SEEN_MS })
      await agent.close(roomId, card2, ask2, 3)
      for (const [page, tai] of [
        [pageA, APPROVAL.you],
        [pageB, 'tai'],
        [pageC, 'tai'],
      ] as const) {
        const c = card(page, ask2)
        await expect(counter(c)).toHaveText(APPROVAL.closed, { timeout: SEEN_MS })
        await expect(lines(c)).toHaveText([new RegExp(`^Recusar${tai} às \\d{2}:\\d{2}$`)])
        await expect(optionButtons(c)).toHaveCount(0)
      }
      for (const page of pages) await expect(lines(card(page, ask2)).first()).toHaveText(LINE)
    })

    await test.step('6. no protocol on any screen', async () => {
      await expectNoProtocolLeak(...pages)
    })

    ledgers.forEach((l, i) => console.log(`[e2e] console ${'ABC'[i]}: ${JSON.stringify(l.observed())}`))
    for (const l of ledgers) l.expectClean()
  } finally {
    for (const c of ctx) await c.close()
  }
})
