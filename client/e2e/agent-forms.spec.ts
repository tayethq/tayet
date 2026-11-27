import { test, expect, type Locator, type Page } from '@playwright/test'
import { HOMESERVER } from '../test/support/synapse'
import { TAI, UGO } from './fixtures/users'
import { adminNav, openAdmin } from './support/admin'
import { expectNoProtocolLeak } from './support/assertions'
import { ConsoleLedger, FIRST_LOGIN_404, recognizedSet404 } from './support/console'
import { ADMIN, AGENTS, APPROVAL, FORMS, MANAGE } from './support/labels'
import { signIn } from './support/login'
import { addMember, closePicker, createChannel, deleteSharedRooms, openManage } from './support/rooms'
import { channelRow, messages, row } from './support/workspace'

// Formulários 1b (ADR-103, Proposto; workspace.md §25.5, §26, §27; fork I6): the agent's form end to end in two
// browsers, with no sidecar. tai creates the agent through the UI and puts it in a PUBLIC channel with ugo (in
// the clear, so the spec reads what the client sends); the spec plays the agent by raw fetch with the
// credential the UI showed — the card, the definition and the result. ugo clicks; only ugo's session opens
// the form, with the mark, the title and the agent's name. An invalid submit shows the copy per field and the
// server gets nothing; the checkbox list stops at its maximum; a valid submit reaches the agent with exactly
// the values typed; the agent's error lands on its field (the hint stays); the agent accepts and the dialog
// closes; both see "… respondeu às {hora}" in the card's footer. A second card with a silent agent: after
// 15 s "{agente} não respondeu" and "Tentar de novo"; closing discards. No row for the three messages; no
// protocol on screen.
//
// Secrets: the credential is in the DOM while the dialog is open → no trace, video or screenshot.
test.use({ trace: 'off', video: 'off', screenshot: 'off' })

// The agent's operator on a line of its own, under the name (channel-management.md §13.1 items 1 and 2).
async function expectTwoLines(line: Locator, operator: string): Promise<void> {
  const sub = line.locator('[data-agent-operator]')
  await expect(sub).toHaveText(operator)
  const name = line.getByText(NAME, { exact: true })
  const [a, b] = [await name.boundingBox(), await sub.boundingBox()]
  expect(b!.y).toBeGreaterThanOrEqual(a!.y + a!.height - 1)
}

const suffix = Math.random().toString(36).slice(2, 8)
const NAME = `Formulador ${suffix}`
const CHANNEL = `formularios-${suffix}`
// ADR-077 ceilings (the tier's): what one client writes reaches another within 60 s.
const SEEN_MS = 60_000
// The product's wire names (ADR-103 dec. 18; ADR-091). The E2E never imports the shared package's internals
// (ADR-088 dec. 3), so they stay literal here.
const APPROVAL_TYPE = 'io.tayet.approval'
const RESPONSE_REL = 'io.tayet.response'
const FORM_TYPE = 'io.tayet.form'
const SUBMISSION_TYPE = 'io.tayet.form.submission'
const RESULT_TYPE = 'io.tayet.form.result'
const FORM_REL = 'io.tayet.form'

const TITLE = 'Ajustar publicação'
const SUBMIT = 'Salvar'
const FIELDS = [
  { kind: 'context', text: 'Mude o que precisar.' },
  { kind: 'text', id: 'title', label: 'Título da página', hint: 'Aparece na aba do navegador.', minLength: 3, maxLength: 60 },
  { kind: 'number', id: 'days', label: 'Dias no ar', min: '1', max: '90' },
  {
    kind: 'select',
    id: 'audience',
    label: 'Público',
    placeholder: 'Escolha',
    groups: [
      { label: 'Pessoas', options: [{ value: 'all', label: 'Todos os membros', description: 'inclui convidados' }] },
      { label: 'Times', options: [{ value: 'product', label: 'Produto' }] },
    ],
  },
  {
    kind: 'radio',
    id: 'when',
    label: 'Quando publicar',
    options: [
      { value: 'now', label: 'Agora', description: 'Sai assim que aprovado' },
      { value: 'date', label: 'Na data escolhida', description: 'Você escolhe o dia' },
    ],
  },
  {
    kind: 'multiSelect',
    id: 'notify',
    label: 'Avisar em',
    maxSelected: 2,
    groups: [
      { label: 'Produto', options: [{ value: 'p1', label: 'Equipe Produto' }, { value: 'p2', label: 'design' }] },
      { label: 'Empresa', options: [{ value: 'e1', label: 'avisos' }] },
    ],
  },
  { kind: 'longText', id: 'notes', label: 'Mensagem de abertura', optional: true },
  { kind: 'date', id: 'due', label: 'Data', optional: true },
]

const card = (page: Page, text: string): Locator => row(page, text).getByRole('group', { name: APPROVAL.title })
const formDialog = (page: Page): Locator => page.getByRole('dialog', { name: TITLE })
const fieldOf = (dialog: Locator, label: string): Locator => dialog.locator('.ui-field').filter({ has: dialog.page().getByText(label, { exact: true }) })
const hhmm = (at: number): string => new Date(at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', hour12: false })

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

// The agent, by raw fetch with the credential shown once. Nothing it reads leaves this file except the values
// the spec compares; no id or token reaches a log line.
type Raw = { event_id: string; sender: string; origin_server_ts: number; content: Record<string, unknown> }
class Agent {
  private txn = 0
  constructor(private readonly token: string) {}
  private auth(json = false): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, ...(json && { 'Content-Type': 'application/json' }) }
  }
  // The conversation it was invited to, by name (the invite's stripped state). A nonce in the filter keeps
  // the server's /sync cache from answering an older snapshot.
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
    const res = await fetch(`${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/form${this.txn}_${suffix}`, {
      method: 'PUT',
      headers: this.auth(true),
      body: JSON.stringify(content),
    })
    if (!res.ok) throw new Error(`agent send -> ${res.status}`)
    return ((await res.json()) as { event_id: string }).event_id
  }
  async relations(roomId: string, anchorId: string, relType: string): Promise<Raw[]> {
    const res = await fetch(
      `${HOMESERVER}/_matrix/client/v1/rooms/${encodeURIComponent(roomId)}/relations/${encodeURIComponent(anchorId)}/${encodeURIComponent(relType)}?dir=f&limit=100`,
      { headers: this.auth() },
    )
    if (!res.ok) throw new Error(`agent relations -> ${res.status}`)
    return ((await res.json()) as { chunk: Raw[] }).chunk
  }
  card(roomId: string, text: string): Promise<string> {
    return this.send(roomId, { msgtype: APPROVAL_TYPE, body: text, [APPROVAL_TYPE]: { options: [{ id: 'edit', label: 'Editar', style: 'primary' }] } })
  }
  definition(roomId: string, anchorId: string, trigger: string): Promise<string> {
    return this.send(roomId, {
      msgtype: FORM_TYPE,
      body: TITLE,
      [FORM_TYPE]: { trigger, title: TITLE, submitLabel: SUBMIT, fields: FIELDS },
      'm.relates_to': { rel_type: FORM_REL, event_id: anchorId },
    })
  }
  result(roomId: string, anchorId: string, submission: string, outcome: Record<string, unknown>): Promise<string> {
    return this.send(roomId, { msgtype: RESULT_TYPE, body: 'ok', [RESULT_TYPE]: { submission, ...outcome }, 'm.relates_to': { rel_type: FORM_REL, event_id: anchorId } })
  }
  async submissions(roomId: string, anchorId: string): Promise<Raw[]> {
    return (await this.relations(roomId, anchorId, FORM_REL)).filter((r) => r.content.msgtype === SUBMISSION_TYPE)
  }
}

test('agent forms: open for the one who clicked, validate, agent errors, done, no answer — two browsers, no sidecar', async ({ browser }) => {
  test.setTimeout(480_000)
  await deleteSharedRooms('tai', 'ugo')
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  const consoleA = new ConsoleLedger('tai', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  const consoleB = new ConsoleLedger('ugo', [...FIRST_LOGIN_404, ...recognizedSet404(1)])
  const ask1 = `Ajustar a publicação ${suffix}?`
  const ask2 = `Ajustar o aviso ${suffix}?`
  try {
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()
    consoleA.watch(pageA, 'A')
    consoleB.watch(pageB, 'B')

    await test.step('0a. the pair enters; tai creates a public channel and adds ugo', async () => {
      await signIn(pageB, UGO)
      await signIn(pageA, TAI)
      await createChannel(pageA, { name: CHANNEL, kind: 'public' })
      await openManage(pageA, CHANNEL, 'public')
      await addMember(pageA, 'ugo')
      await pageA.getByRole('button', { name: MANAGE.close }).click()
      await expect(channelRow(pageB, CHANNEL)).toBeVisible({ timeout: SEEN_MS })
    })

    let agent!: Agent
    await test.step('0b. tai creates the agent through the UI; the spec keeps the credential shown once', async () => {
      await openAdmin(pageA)
      await pageA.getByRole('button', { name: AGENTS.add }).click()
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
      // Leave the Admin: back to the conversations.
      await pageA.getByRole('button', { name: ADMIN.back }).click()
      await expect(adminNav(pageA)).toHaveCount(0)
      await openManage(pageA, CHANNEL, 'public')
      const candidate = pageA.getByRole('dialog', { name: MANAGE.addMember }).getByRole('button', { name: new RegExp(NAME) })
      await pageA.getByRole('button', { name: MANAGE.addMember }).click()
      await expect(candidate).toBeVisible({ timeout: 30_000 })
      // channel-management.md §13.1 item 2: the agent in two lines in the picker, its operator (the reader) below.
      await expectTwoLines(candidate, AGENTS.operatedBy('tai'))
      await candidate.click()
      await closePicker(pageA, candidate)
      const member = pageA.getByRole('region', { name: MANAGE.members }).getByRole('listitem').filter({ hasText: NAME })
      await expect(member).toBeVisible({ timeout: 30_000 })
      roomId = await poll(() => agent.invitedRoom(CHANNEL), 'the invite reaches the agent')
      await agent.join(roomId)
      await expect(member.getByText(MANAGE.awaiting)).toHaveCount(0, { timeout: SEEN_MS })
      // §13.1 item 1: and in the channel's list of people, the role on the right.
      await expectTwoLines(member, AGENTS.operatedBy('tai'))
      await expect(member).toContainText(MANAGE.member)
      await pageA.getByRole('button', { name: MANAGE.close }).click()
      await channelRow(pageA, CHANNEL).click()
      await channelRow(pageB, CHANNEL).click()
    })

    let card1 = ''
    let rowsA = 0
    let rowsB = 0
    await test.step('1. the agent publishes a card with one option; both see it', async () => {
      card1 = await agent.card(roomId, ask1)
      for (const page of [pageA, pageB]) await expect(card(page, ask1).getByRole('button', { name: 'Editar' })).toBeVisible({ timeout: SEEN_MS })
      rowsA = await messages(pageA).locator('article').count()
      rowsB = await messages(pageB).locator('article').count()
    })

    let definition1 = ''
    await test.step('2. ugo clicks; the agent publishes the definition; the dialog opens only for ugo, with the mark, the title and the agent', async () => {
      await card(pageB, ask1).getByRole('button', { name: 'Editar' }).click()
      const answer = await poll(async () => (await agent.relations(roomId, card1, RESPONSE_REL))[0], "ugo's answer to the card")
      const sentAt = Date.now()
      definition1 = await agent.definition(roomId, card1, answer.event_id)
      const dialog = formDialog(pageB)
      await expect(dialog).toBeVisible({ timeout: SEEN_MS })
      console.log(`[e2e] form open on ugo ${Date.now() - sentAt} ms after the definition`)
      await expect(dialog.locator('.ui-dialog__title [data-agent-avatar]')).toHaveAttribute('aria-label', AGENTS.mark)
      await expect(dialog.locator('.agent-form__title')).toHaveText(TITLE)
      await expect(dialog.locator('.agent-form__agent')).toHaveText(NAME)
      await expect(dialog.getByLabel('Título da página')).toBeFocused()
      await expect(fieldOf(dialog, 'Título da página').locator('.ui-field__hint')).toHaveText('Aparece na aba do navegador.')
      await expect(dialog.getByText(`Mensagem de abertura ${FORMS.optional}`)).toBeVisible()
      // Only the session that clicked: tai's never opens (a barrier: tai already sees the card's answer).
      await expect(card(pageA, ask1).getByText(/^ugo às \d{2}:\d{2}$/)).toBeVisible({ timeout: SEEN_MS })
      await expect(formDialog(pageA)).toHaveCount(0)
    })

    await test.step('3. an invalid submit: the copy per field, the focus on the first, nothing reaches the server', async () => {
      const dialog = formDialog(pageB)
      await dialog.getByLabel('Título da página').fill('ab')
      await dialog.getByLabel('Dias no ar').fill('120')
      await dialog.getByRole('button', { name: SUBMIT }).click()
      await expect(fieldOf(dialog, 'Título da página').getByRole('alert')).toHaveText(FORMS.minLength(3))
      await expect(fieldOf(dialog, 'Dias no ar').getByRole('alert')).toHaveText(FORMS.between('1', '90'))
      await expect(fieldOf(dialog, 'Público').getByRole('alert')).toHaveText(FORMS.required)
      await expect(fieldOf(dialog, 'Quando publicar').getByRole('alert')).toHaveText(FORMS.required)
      await expect(fieldOf(dialog, 'Avisar em').getByRole('alert')).toHaveText(FORMS.required)
      await expect(fieldOf(dialog, 'Título da página').locator('.ui-field__hint')).toHaveText('Aparece na aba do navegador.')
      await expect(dialog.getByLabel('Título da página')).toBeFocused()
      // A field's error goes when it changes (I3).
      await dialog.getByLabel('Dias no ar').fill('12.5')
      await expect(fieldOf(dialog, 'Dias no ar').getByRole('alert')).toHaveCount(0)
      expect((await agent.relations(roomId, card1, FORM_REL)).map((r) => r.event_id)).toEqual([definition1])
    })

    await test.step('4. the checkbox list stops at 2: the rest disabled, "Até 2"', async () => {
      const dialog = formDialog(pageB)
      const list = fieldOf(dialog, 'Avisar em')
      await list.locator('label', { hasText: 'Equipe Produto' }).click()
      await expect(list.getByText(FORMS.upTo(2))).toHaveCount(0)
      await list.locator('label', { hasText: 'avisos' }).click()
      await expect(list.getByText(FORMS.upTo(2))).toBeVisible()
      await expect(list.getByRole('checkbox', { name: 'design' })).toBeDisabled()
      await expect(list.getByRole('checkbox', { name: 'Equipe Produto' })).toBeChecked()
      await expect(list.getByRole('group', { name: 'Empresa' })).toBeVisible()
    })

    let submission1 = ''
    const values = {
      title: 'Boas-vindas ao Estúdio',
      days: '30',
      audience: 'all',
      when: 'date',
      notify: ['p1', 'e1'],
      notes: 'Comece pelo canal.\nConfira as fixadas.',
      due: '2026-11-18',
    }
    await test.step('5. a valid submit reaches the agent with exactly the values typed; its error lands on the field, the hint stays', async () => {
      const dialog = formDialog(pageB)
      await dialog.getByLabel('Título da página').fill(values.title)
      await dialog.getByLabel('Dias no ar').fill(values.days)
      await expect(dialog.getByLabel('Público').locator('optgroup')).toHaveCount(2)
      await dialog.getByLabel('Público').selectOption({ label: 'Todos os membros — inclui convidados' })
      await fieldOf(dialog, 'Quando publicar').locator('label', { hasText: 'Na data escolhida' }).click()
      await dialog.getByLabel(`Mensagem de abertura ${FORMS.optional}`).fill(values.notes)
      await dialog.getByLabel(`Data ${FORMS.optional}`).fill(values.due)
      await dialog.getByRole('button', { name: SUBMIT }).click()
      const sub = await poll(async () => (await agent.submissions(roomId, card1))[0], 'the submission on the server')
      // Beside the values, the copy of what the person saw: each field's label and the chosen options' labels.
      expect(sub.content[SUBMISSION_TYPE]).toEqual({
        form: definition1,
        values,
        labels: [
          { id: 'title', label: 'Título da página' },
          { id: 'days', label: 'Dias no ar' },
          { id: 'audience', label: 'Público', options: [{ value: 'all', label: 'Todos os membros' }] },
          { id: 'when', label: 'Quando publicar', options: [{ value: 'date', label: 'Na data escolhida' }] },
          { id: 'notify', label: 'Avisar em', options: [{ value: 'p1', label: 'Equipe Produto' }, { value: 'e1', label: 'avisos' }] },
          { id: 'notes', label: 'Mensagem de abertura' },
          { id: 'due', label: 'Data' },
        ],
      })
      expect(sub.content.body).toBe(TITLE)
      submission1 = sub.event_id
      await agent.result(roomId, card1, submission1, { errors: { title: 'Esse título já existe' } })
      await expect(fieldOf(dialog, 'Título da página').getByRole('alert')).toHaveText('Esse título já existe', { timeout: SEEN_MS })
      await expect(fieldOf(dialog, 'Título da página').locator('.ui-field__hint')).toHaveText('Aparece na aba do navegador.')
      await expect(dialog).toBeVisible()
      await expect(dialog.getByLabel('Título da página')).toBeFocused()
    })

    await test.step('6. again; the agent accepts: the dialog closes, and both see the line in the card footer', async () => {
      const dialog = formDialog(pageB)
      await dialog.getByLabel('Título da página').fill('Boas-vindas, de novo')
      await expect(fieldOf(dialog, 'Título da página').getByRole('alert')).toHaveCount(0)
      await dialog.getByRole('button', { name: SUBMIT }).click()
      const sub2 = await poll(async () => (await agent.submissions(roomId, card1)).find((s) => s.event_id !== submission1), 'the second submission')
      expect((sub2.content[SUBMISSION_TYPE] as { values: Record<string, unknown> }).values).toEqual({ ...values, title: 'Boas-vindas, de novo' })
      await agent.result(roomId, card1, sub2.event_id, { ok: true })
      await expect(dialog).toHaveCount(0, { timeout: SEEN_MS })
      const time = hhmm(sub2.origin_server_ts)
      await expect(card(pageB, ask1).getByText(FORMS.replied(FORMS.you, time), { exact: true })).toBeVisible({ timeout: SEEN_MS })
      await expect(card(pageA, ask1).getByText(FORMS.replied('ugo', time), { exact: true })).toBeVisible({ timeout: SEEN_MS })
      await expect(messages(pageA).locator('article')).toHaveCount(rowsA)
      await expect(messages(pageB).locator('article')).toHaveCount(rowsB)
      await expectNoProtocolLeak(pageA, pageB)
    })

    await test.step('7. a second card, the agent silent: after 15 s "{agente} não respondeu" and "Tentar de novo"; closing discards', async () => {
      const card2 = await agent.card(roomId, ask2)
      for (const page of [pageA, pageB]) await expect(card(page, ask2).getByRole('button', { name: 'Editar' })).toBeVisible({ timeout: SEEN_MS })
      rowsA = await messages(pageA).locator('article').count()
      rowsB = await messages(pageB).locator('article').count()
      await card(pageB, ask2).getByRole('button', { name: 'Editar' }).click()
      const answer = await poll(async () => (await agent.relations(roomId, card2, RESPONSE_REL))[0], "ugo's answer to the second card")
      await agent.definition(roomId, card2, answer.event_id)
      const dialog = formDialog(pageB)
      await expect(dialog).toBeVisible({ timeout: SEEN_MS })
      await dialog.getByLabel('Título da página').fill('Aviso da semana')
      await dialog.getByLabel('Dias no ar').fill('7')
      await dialog.getByLabel('Público').selectOption('product')
      await fieldOf(dialog, 'Quando publicar').locator('label', { hasText: 'Agora' }).click()
      await fieldOf(dialog, 'Avisar em').locator('label', { hasText: 'design' }).click()
      await dialog.getByRole('button', { name: SUBMIT }).click()
      await poll(async () => (await agent.submissions(roomId, card2))[0], 'the submission of the second form')
      const accepted = Date.now()
      await expect(dialog.locator('.agent-form__status')).toHaveText(FORMS.noAnswer(NAME), { timeout: 40_000 })
      console.log(`[e2e] "não respondeu" ${Date.now() - accepted} ms after the server held the submission`)
      expect(Date.now() - accepted).toBeGreaterThanOrEqual(13_000)
      await expect(dialog.getByRole('button', { name: FORMS.retry })).toBeEnabled()
      await dialog.getByRole('button', { name: FORMS.cancel }).click()
      await expect(dialog).toHaveCount(0)
      await expect(formDialog(pageA)).toHaveCount(0)
      await expect(messages(pageA).locator('article')).toHaveCount(rowsA)
      await expect(messages(pageB).locator('article')).toHaveCount(rowsB)
    })

    await test.step('8. no protocol on either screen', async () => {
      await expectNoProtocolLeak(pageA, pageB)
    })

    console.log(`[e2e] console A: ${JSON.stringify(consoleA.observed())}`)
    console.log(`[e2e] console B: ${JSON.stringify(consoleB.observed())}`)
    consoleA.expectClean()
    consoleB.expectClean()
  } finally {
    await ctxA.close()
    await ctxB.close()
  }
})
