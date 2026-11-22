import { test, expect, type Locator, type Page } from '@playwright/test'
import { HOMESERVER } from '../test/support/synapse'
import { BIA, CAIO } from './fixtures/users'
import { accountSettings } from './support/account'
import { expectNoProtocolLeak } from './support/assertions'
import { ConsoleLedger, FIRST_LOGIN_404, recognizedSet404 } from './support/console'
import { AGENTS, APPROVAL, FORMS, MANAGE, PEOPLE } from './support/labels'
import { signIn } from './support/login'
import { addMember, createChannel, deleteSharedRooms, openManage } from './support/rooms'
import { channelRow, row } from './support/workspace'

// Phone project (PLANO-MOBILE M8, workspace.md §25.5 item 6), on the mould of agent-forms.spec.ts: bia creates
// the agent through the UI on a wide window and puts it in a public channel with caio; the spec plays the agent
// by raw fetch. caio, at 390×844 with touch, opens the form from the card, meets a field error, keeps what was
// filled across 728 (F3), has the submit over the keyboard (F2), sends, and discards a second form with the
// system's back (F1).
//
// Secrets: the credential is in the DOM while the dialog is open → no trace, video or screenshot.
test.use({ trace: 'off', video: 'off', screenshot: 'off' })

const suffix = Math.random().toString(36).slice(2, 8)
const NAME = `Ajustador ${suffix}`
const CHANNEL = `ajustes-${suffix}`
const SEEN_MS = 60_000
// The product's wire names, literal as in agent-forms.spec.ts (ADR-088 dec. 3).
const APPROVAL_TYPE = 'io.tayet.approval'
const RESPONSE_REL = 'io.tayet.response'
const FORM_TYPE = 'io.tayet.form'
const SUBMISSION_TYPE = 'io.tayet.form.submission'
const RESULT_TYPE = 'io.tayet.form.result'
const FORM_REL = 'io.tayet.form'

const TITLE = 'Ajustar pagamento'
const SUBMIT = 'Enviar ajuste'
const FIELDS = [
  { kind: 'text', id: 'title', label: 'Descrição', minLength: 3, maxLength: 60 },
  { kind: 'radio', id: 'pay', label: 'Forma de pagamento', options: [{ value: 'pix', label: 'Pix' }, { value: 'boleto', label: 'Boleto' }] },
  { kind: 'longText', id: 'notes', label: 'Observação', optional: true },
]

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
  async send(room: string, content: Record<string, unknown>): Promise<string> {
    this.txn += 1
    const path = `v3/rooms/${encodeURIComponent(room)}/send/m.room.message/narrowform${this.txn}_${suffix}`
    return (await this.call<{ event_id: string }>(path, 'PUT', content)).event_id
  }
  async relations(room: string, anchor: string, rel: string): Promise<Raw[]> {
    const path = `v1/rooms/${encodeURIComponent(room)}/relations/${encodeURIComponent(anchor)}/${encodeURIComponent(rel)}?dir=f&limit=100`
    return (await this.call<{ chunk: Raw[] }>(path)).chunk
  }
  card(room: string, text: string): Promise<string> {
    return this.send(room, { msgtype: APPROVAL_TYPE, body: text, [APPROVAL_TYPE]: { options: [{ id: 'edit', label: 'Editar', style: 'primary' }] } })
  }
  definition(room: string, anchor: string, trigger: string): Promise<string> {
    return this.send(room, {
      msgtype: FORM_TYPE,
      body: TITLE,
      [FORM_TYPE]: { trigger, title: TITLE, submitLabel: SUBMIT, fields: FIELDS },
      'm.relates_to': { rel_type: FORM_REL, event_id: anchor },
    })
  }
  result(room: string, anchor: string, submission: string, outcome: Record<string, unknown>): Promise<string> {
    return this.send(room, { msgtype: RESULT_TYPE, body: 'ok', [RESULT_TYPE]: { submission, ...outcome }, 'm.relates_to': { rel_type: FORM_REL, event_id: anchor } })
  }
  async submissions(room: string, anchor: string): Promise<Raw[]> {
    return (await this.relations(room, anchor, FORM_REL)).filter((r) => r.content.msgtype === SUBMISSION_TYPE)
  }
}

async function poll<T>(get: () => Promise<T | undefined>, what: string): Promise<T> {
  let found: T | undefined
  await expect.poll(async () => (found = await get()) !== undefined, { message: what, timeout: SEEN_MS, intervals: [500] }).toBe(true)
  return found!
}

const depth = (page: Page) => page.evaluate(() => (history.state as { depth?: number } | null)?.depth ?? 0)
const card = (page: Page, text: string): Locator => row(page, text).getByRole('group', { name: APPROVAL.title })
const formScreen = (page: Page): Locator => page.getByRole('region', { name: TITLE, exact: true })

test('agent form on the phone: open from the card, field error, send, and back discards', async ({ browser }) => {
  test.setTimeout(420_000)
  await deleteSharedRooms('bia', 'caio')
  const ctxBia = await browser.newContext({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false, deviceScaleFactor: 1 })
  const ctxCaio = await browser.newContext()
  const ledgerBia = new ConsoleLedger('bia', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  const ledgerCaio = new ConsoleLedger('caio', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  const ask1 = `Ajustar o pagamento ${suffix}?`
  const ask2 = `Ajustar a nota ${suffix}?`
  try {
    const bia = await ctxBia.newPage()
    const caio = await ctxCaio.newPage()
    ledgerBia.watch(bia, 'bia')
    ledgerCaio.watch(caio, 'caio')
    let agent!: Agent
    let roomId = ''

    await test.step('0a. the pair enters; bia creates a public channel and adds caio', async () => {
      await signIn(caio, CAIO)
      await signIn(bia, BIA)
      await createChannel(bia, { name: CHANNEL, kind: 'public' })
      await openManage(bia, CHANNEL, 'public')
      await addMember(bia, 'caio')
      await bia.getByRole('button', { name: MANAGE.close }).click()
      await expect(channelRow(caio, CHANNEL)).toBeVisible({ timeout: SEEN_MS })
    })

    await test.step('0b. bia creates the agent through the UI and adds it to the channel; the agent joins', async () => {
      const account = await accountSettings(bia)
      await expect(account.getByText(PEOPLE.section)).toBeVisible({ timeout: 30_000 })
      await account.getByRole('button', { name: new RegExp(`^${PEOPLE.title}`) }).click()
      await bia.getByRole('dialog', { name: PEOPLE.title }).getByRole('button', { name: AGENTS.add }).click()
      const create = bia.getByRole('dialog', { name: AGENTS.createTitle })
      await create.getByLabel(AGENTS.fieldName).fill(NAME)
      await create.getByRole('button', { name: AGENTS.create }).click()
      const created = bia.getByRole('dialog', { name: AGENTS.createdTitle })
      await expect(created.getByText(AGENTS.credentialOnce)).toBeVisible({ timeout: SEEN_MS })
      const credential = (await created.locator('[data-agent-credential]').textContent())?.trim() ?? ''
      expect(credential.length).toBeGreaterThan(20)
      agent = new Agent(credential)
      await created.getByRole('button', { name: AGENTS.done }).click()
      await expect(async () => {
        if ((await bia.getByRole('dialog').count()) > 0) await bia.keyboard.press('Escape')
        await expect(bia.getByRole('dialog')).toHaveCount(0, { timeout: 1_000 })
      }).toPass({ timeout: 15_000 })
      await openManage(bia, CHANNEL, 'public')
      await bia.getByRole('button', { name: MANAGE.addMember }).click()
      const candidate = bia.getByRole('dialog', { name: MANAGE.addMember }).getByRole('button', { name: new RegExp(NAME) })
      await expect(candidate).toBeVisible({ timeout: 30_000 })
      await candidate.click()
      roomId = await poll(() => agent.invitedRoom(CHANNEL), 'the invite reaches the agent')
      await agent.join(roomId)
      const member = bia.getByRole('region', { name: MANAGE.members }).getByRole('listitem').filter({ hasText: NAME })
      await expect(member).toBeVisible({ timeout: 30_000 })
      await expect(member.getByText(MANAGE.awaiting)).toHaveCount(0, { timeout: SEEN_MS })
      await bia.getByRole('button', { name: MANAGE.close }).click()
      await channelRow(caio, CHANNEL).click()
      await expect.poll(() => depth(caio)).toBe(1)
    })

    // The agent's card, caio's tap on it and the definition it answers with.
    const openForm = async (ask: string): Promise<string> => {
      const anchor = await agent.card(roomId, ask)
      const edit = card(caio, ask).getByRole('button', { name: 'Editar' })
      await expect(edit).toBeVisible({ timeout: SEEN_MS })
      await edit.click()
      const answer = await poll(async () => (await agent.relations(roomId, anchor, RESPONSE_REL))[0], "caio's answer to the card")
      await agent.definition(roomId, anchor, answer.event_id)
      await expect(formScreen(caio)).toBeVisible({ timeout: SEEN_MS })
      await expect.poll(() => depth(caio)).toBe(2)
      return anchor
    }

    let card1 = ''
    await test.step('1. the card opens the screen: the mark, the title, the agent, the focus on the ✕, the submit alone', async () => {
      card1 = await openForm(ask1)
      const screen = formScreen(caio)
      await expect(screen.getByRole('button', { name: FORMS.close })).toBeFocused()
      await expect(screen.getByRole('heading', { name: TITLE })).toBeVisible()
      await expect(screen.getByRole('img', { name: AGENTS.mark })).toBeVisible()
      await expect(screen.getByText(NAME, { exact: true })).toBeVisible()
      await expect(screen.getByRole('button', { name: FORMS.cancel })).toHaveCount(0)
      await expect(caio.getByRole('dialog')).toHaveCount(0)
      await expect(caio.getByRole('main')).toHaveCount(0)
      const field = screen.getByLabel('Descrição')
      expect((await field.boundingBox())!.height).toBeGreaterThanOrEqual(44)
      await expect(field).toHaveCSS('font-size', '16px')
      await expectNoProtocolLeak(caio)
    })

    await test.step('2. a field error: the copy, the focus on the field, nothing sent', async () => {
      const screen = formScreen(caio)
      await screen.getByLabel('Descrição').fill('ab')
      await screen.locator('label', { hasText: 'Pix' }).click()
      await screen.getByRole('button', { name: SUBMIT }).click()
      await expect(screen.getByRole('alert')).toHaveText(FORMS.minLength(3))
      await expect(screen.getByLabel('Descrição')).toBeFocused()
      expect(await agent.submissions(roomId, card1)).toEqual([])
    })

    await test.step('3. across 728 and back, what was filled and the error stay', async () => {
      await caio.setViewportSize({ width: 1024, height: 800 })
      await expect(async () => {
        const dialog = caio.getByRole('dialog', { name: TITLE })
        await expect(dialog.getByLabel('Descrição')).toHaveValue('ab', { timeout: 1_000 })
        await expect(dialog.getByRole('alert')).toHaveText(FORMS.minLength(3), { timeout: 1_000 })
        expect(await depth(caio)).toBe(0)
      }).toPass({ timeout: 15_000 })
      await caio.setViewportSize({ width: 390, height: 844 })
      await expect(async () => {
        const screen = formScreen(caio)
        await expect(screen.getByLabel('Descrição')).toHaveValue('ab', { timeout: 1_000 })
        await expect(screen.getByRole('radio', { name: 'Pix' })).toBeChecked({ timeout: 1_000 })
        await expect(screen.getByRole('alert')).toHaveText(FORMS.minLength(3), { timeout: 1_000 })
        expect(await depth(caio)).toBe(2)
      }).toPass({ timeout: 15_000 })
    })

    await test.step('4. the footer ends over the keyboard', async () => {
      const keyboard = (height: number | null) =>
        caio.evaluate((h) => {
          const vv = window.visualViewport!
          if (h === null) delete (vv as unknown as { height?: number }).height
          else Object.defineProperty(vv, 'height', { configurable: true, get: () => h })
          vv.dispatchEvent(new Event('resize'))
        }, height)
      await keyboard(844 - 336)
      await expect(async () => {
        const box = (await formScreen(caio).getByRole('button', { name: SUBMIT }).boundingBox())!
        expect(box.y + box.height).toBeLessThanOrEqual(844 - 336)
      }).toPass({ timeout: 10_000 })
      await keyboard(null)
    })

    await test.step('5. the send reaches the agent; done closes the screen over the conversation', async () => {
      const screen = formScreen(caio)
      await screen.getByLabel('Descrição').fill('Folders')
      await screen.getByRole('button', { name: SUBMIT }).click()
      const sent = await poll(async () => (await agent.submissions(roomId, card1))[0], 'the submission on the server')
      expect((sent.content[SUBMISSION_TYPE] as { values: Record<string, unknown> }).values).toMatchObject({ title: 'Folders', pay: 'pix' })
      await agent.result(roomId, card1, sent.event_id, { ok: true })
      await expect(screen).toHaveCount(0, { timeout: SEEN_MS })
      await expect(caio.getByRole('main')).toBeVisible()
      await expect.poll(() => depth(caio)).toBe(1)
      await expect(card(caio, ask1).getByText(new RegExp(`^${FORMS.you} respondeu às \\d{2}:\\d{2}$`))).toBeVisible({ timeout: SEEN_MS })
    })

    await test.step("6. a second card: the system's back discards without asking", async () => {
      const card2 = await openForm(ask2)
      await formScreen(caio).getByLabel('Descrição').fill('Nota de dezembro')
      await caio.goBack()
      await expect(formScreen(caio)).toHaveCount(0)
      await expect(caio.getByRole('alertdialog')).toHaveCount(0)
      await expect(caio.getByRole('main')).toBeVisible()
      await expect.poll(() => depth(caio)).toBe(1)
      expect(await agent.submissions(roomId, card2)).toEqual([])
      await expectNoProtocolLeak(caio, bia)
    })

    ledgerBia.expectClean()
    ledgerCaio.expectClean()
  } finally {
    await ctxBia.close()
    await ctxCaio.close()
  }
})
