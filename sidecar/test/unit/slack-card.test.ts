import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readActions } from '../../src/api/slack/actions'
import { ALICE, GENERAL, ME, call, idLeaks, refusal, refusalData, startSlack, type SlackHarness } from '../support/slack-world'
import { fakeApprovals, type FakeApprovals } from '../support/slack-approvals'

// The approval card on the Slack layer (A3-4; PLANO-AGENTES §0.3.16 item 14, §0.3.17): an `actions` block of
// chat.postMessage becomes a card through the ApprovalFacade; chat.update on a card edits the request and
// closes it when still open. Through the real @slack/web-api.

let h: SlackHarness
let approvals: FakeApprovals
let dir: string
let file: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'slack-card-'))
  file = join(dir, 'slack-cards.json')
  const { createWorld } = await import('../support/slack-world')
  const world = createWorld()
  approvals = fakeApprovals(world)
  h = await startSlack({ world, approvals, cardsFile: file })
})
afterEach(async () => {
  await h.close()
  await rm(dir, { recursive: true, force: true })
})

const button = (label: string, over: Record<string, unknown> = {}) => ({ type: 'button', text: { type: 'plain_text', text: label }, ...over })
const actions = (elements: unknown[], over: Record<string, unknown> = {}) => ({ type: 'actions', elements, ...over })
const post = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const res = await call(h.client(), 'chat.postMessage', { channel: GENERAL.id, ...args })
  expect(idLeaks(res)).toEqual([])
  return res
}
const requests = () => approvals.calls.filter((c) => c.op === 'request')
const saved = async (): Promise<{ cards: Array<Record<string, unknown>> }> => JSON.parse(await readFile(file, 'utf8')) as { cards: Array<Record<string, unknown>> }

describe('readActions — the rules (pure)', () => {
  it('no actions block → no card; the other blocks are the rest', () => {
    const section = { type: 'section', text: { type: 'mrkdwn', text: 'oi' } }
    expect(readActions([section])).toEqual({ rest: [section], present: false, warnings: [] })
  })

  it('every action_id fits the option rule → the ids are the action_ids; style kept', () => {
    const r = readActions([actions([button('Aprovar', { action_id: 'approve', style: 'primary', value: 'v1' }), button('Rejeitar', { action_id: 'reject', style: 'danger' })], { block_id: 'deploy' })])
    expect(r.card).toEqual({
      block_id: 'deploy',
      buttons: [
        { option: { id: 'approve', label: 'Aprovar', style: 'primary' }, action_id: 'approve', value: 'v1' },
        { option: { id: 'reject', label: 'Rejeitar', style: 'danger' }, action_id: 'reject' },
      ],
    })
    expect(r.warnings).toEqual([])
  })

  it('one action_id off the rule (or missing) → ALL positional b1…b3; a missing action_id/block_id is minted', () => {
    const r = readActions([actions([button('Sim', { action_id: 'approve' }), button('Não', { action_id: 'Reject.Now' }), button('Talvez')])])
    expect(r.card?.buttons.map((b) => b.option.id)).toEqual(['b1', 'b2', 'b3'])
    expect(r.card?.buttons.map((b) => b.action_id).slice(0, 2)).toEqual(['approve', 'Reject.Now'])
    expect(r.card?.buttons[2]?.action_id).toMatch(/^[0-9a-f]{8}$/)
    expect(r.card?.block_id).toMatch(/^[0-9a-f]{8}$/)
  })

  it('more than one primary → the first stays, the others secondary, with approval_primary_demoted', () => {
    const r = readActions([actions([button('A', { style: 'primary' }), button('B', { style: 'primary' }), button('C', { style: 'primary' })])])
    expect(r.card?.buttons.map((b) => b.option.style)).toEqual(['primary', undefined, undefined])
    expect(r.warnings).toEqual(['approval_primary_demoted'])
  })

  it('dropped elements and ignored confirm, with their warnings; no button left → no card', () => {
    const r = readActions([actions([button('Abrir', { url: 'https://example.com' }), { type: 'static_select' }, button('Ok', { confirm: { title: {} } })])])
    expect(r.card?.buttons.map((b) => b.option.label)).toEqual(['Ok'])
    expect(r.warnings).toEqual(['blocks_unsupported:button_url', 'blocks_unsupported:static_select', 'blocks_unsupported:confirm'])
    const none = readActions([actions([button('Abrir', { url: 'https://example.com' }), { type: 'datepicker' }])])
    expect(none).toMatchObject({ present: true, warnings: ['blocks_unsupported:button_url', 'blocks_unsupported:datepicker'] })
    expect(none.card).toBeUndefined()
  })

  it.each([
    ['26 buttons', [actions(Array.from({ length: 26 }, (_, i) => button(String(i + 1))))]],
    ['a second actions block', [actions([button('1')]), actions([button('2')])]],
    ['an empty label', [actions([button('  ')])]],
    ['a label over 75 characters', [actions([button('x'.repeat(76))])]],
    ['an action_id over 255', [actions([button('1', { action_id: 'a'.repeat(256) })])]],
    ['a block_id over 255', [actions([button('1')], { block_id: 'b'.repeat(256) })]],
    ['a value over 2,000', [actions([button('1', { value: 'v'.repeat(2001) })])]],
    ['a repeated action_id', [actions([button('1', { action_id: 'same' }), button('2', { action_id: 'same' })])]],
  ])('%s → invalid_blocks', (_what, blocks) => {
    expect(() => readActions(blocks)).toThrow('invalid_blocks')
  })

  it('the limits themselves pass: 75 characters, 255, 2,000, 25 buttons', () => {
    const r = readActions([actions([button('x'.repeat(75), { action_id: 'a'.repeat(255), value: 'v'.repeat(2000) }), ...Array.from({ length: 24 }, (_, i) => button(String(i + 2)))], { block_id: 'b'.repeat(255) })])
    expect(r.card?.buttons).toHaveLength(25)
  })

  it('25 buttons with an action_id off the rule → positional ids b1…b25', () => {
    const r = readActions([actions(Array.from({ length: 25 }, (_, i) => button(`B${i + 1}`, { action_id: `Act.${i + 1}` })))])
    expect(r.card?.buttons.map((b) => b.option.id)).toEqual(Array.from({ length: 25 }, (_, i) => `b${i + 1}`))
    expect(r.card?.buttons.at(-1)?.action_id).toBe('Act.25')
  })
})

describe('chat.postMessage with actions → the card', () => {
  it('text + blocks: the text is the request, the buttons the options; the file has the card BEFORE the answer', async () => {
    const res = await post({
      text: 'Publicar a versão *2.1*?',
      blocks: [actions([button('Aprovar', { action_id: 'approve-btn', value: 'release-2.1', style: 'primary' }), button('Rejeitar', { action_id: 'reject-btn', style: 'danger' })], { block_id: 'release' })],
    })
    expect(requests()).toEqual([
      {
        op: 'request',
        conversation: GENERAL.id,
        text: 'Publicar a versão 2.1?',
        rich: [{ t: 'p', children: [{ t: 'text', text: 'Publicar a versão ' }, { t: 'strong', children: [{ t: 'text', text: '2.1' }] }, { t: 'text', text: '?' }] }],
        options: [
          { id: 'approve-btn', label: 'Aprovar', style: 'primary' },
          { id: 'reject-btn', label: 'Rejeitar', style: 'danger' },
        ],
      },
    ])
    expect(res).toMatchObject({ channel: GENERAL.id, ts: expect.stringMatching(/^\d+\.\d{6}$/) as unknown, message: { type: 'message', user: ME.id, text: 'Publicar a versão *2.1*?' } })
    expect(res).not.toHaveProperty('response_metadata.warnings')
    expect(h.world.calls.filter((c) => c.op === 'post')).toEqual([])
    // The answer came after the write: the file already holds the card.
    expect(await saved()).toEqual({
      aliases: [],
      cards: [
        {
          conversation: GENERAL.id,
          id: res.ts,
          block_id: 'release',
          actions: [
            { option: 'approve-btn', action_id: 'approve-btn', value: 'release-2.1' },
            { option: 'reject-btn', action_id: 'reject-btn' },
          ],
          at: expect.any(Number) as number,
        },
      ],
    })
  })

  it('25 buttons: the card carries 25 options, positional up to b25, and the file keeps every action_id', async () => {
    const res = await post({ text: 'Qual ambiente?', blocks: [actions(Array.from({ length: 25 }, (_, i) => button(`Env ${i + 1}`, { action_id: `env.${i + 1}`, value: `v${i + 1}` })))] })
    expect(requests()[0]?.options).toEqual(Array.from({ length: 25 }, (_, i) => ({ id: `b${i + 1}`, label: `Env ${i + 1}` })))
    const entry = (await saved()).cards.find((c) => c.id === res.ts)
    expect(entry?.actions).toHaveLength(25)
    expect((entry?.actions as unknown[] | undefined)?.at(-1)).toEqual({ option: 'b25', action_id: 'env.25', value: 'v25' })
  })

  it('no text: the request is the other blocks flattened; thread_ts and mentions as in a message', async () => {
    const root = (await post({ text: 'raiz' })).ts as string
    const res = await post({
      thread_ts: root,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Posso liberar, <@UALICEAAAAA>?' } }, actions([button('Sim', { action_id: 'Yes!' }), button('Não')])],
    })
    expect(requests()).toEqual([
      {
        op: 'request',
        conversation: GENERAL.id,
        text: 'Posso liberar, @Alice Souza?',
        options: [
          { id: 'b1', label: 'Sim' },
          { id: 'b2', label: 'Não' },
        ],
        mentions: [ALICE.id],
        thread: root,
      },
    ])
    const entry = (await saved()).cards.find((c) => c.id === res.ts)
    expect(entry?.actions).toEqual([
      { option: 'b1', action_id: 'Yes!' },
      { option: 'b2', action_id: expect.stringMatching(/^[0-9a-f]{8}$/) as unknown },
    ])
  })

  it('the warnings come back (demoted primary, dropped elements, ignored confirm)', async () => {
    const res = await post({ text: 'ok?', blocks: [actions([button('A', { style: 'primary' }), button('B', { style: 'primary', confirm: {} }), { type: 'overflow' }])] })
    expect(res.response_metadata).toEqual({ warnings: ['blocks_unsupported:confirm', 'blocks_unsupported:overflow', 'approval_primary_demoted'] })
    expect(requests()[0]?.options).toEqual([{ id: 'b1', label: 'A', style: 'primary' }, { id: 'b2', label: 'B' }])
  })

  it('no button left → an ordinary message, with the warnings', async () => {
    const res = await post({ text: 'veja', blocks: [actions([button('Abrir', { url: 'https://example.com' })])] })
    expect(requests()).toEqual([])
    expect(h.world.calls.filter((c) => c.op === 'post')).toEqual([{ op: 'post', conversation: GENERAL.id, text: 'veja' }])
    expect(res.response_metadata).toEqual({ warnings: ['blocks_unsupported:button_url'] })
  })

  it('refusals before any effect: invalid_blocks; no request → no_text; an unknown thread → thread_not_found', async () => {
    const c = h.client()
    expect(await refusal(c, 'chat.postMessage', { channel: GENERAL.id, text: 'x', blocks: [actions(Array.from({ length: 26 }, (_, i) => button(String(i + 1))))] })).toBe('invalid_blocks')
    expect(await refusal(c, 'chat.postMessage', { channel: GENERAL.id, text: 'x', blocks: [actions([button('1')]), actions([button('2')])] })).toBe('invalid_blocks')
    expect(await refusal(c, 'chat.postMessage', { channel: GENERAL.id, blocks: [actions([button('1')])] })).toBe('no_text')
    expect(await refusal(c, 'chat.postMessage', { channel: GENERAL.id, text: 'x', thread_ts: '1.000000', blocks: [actions([button('1')])] })).toBe('thread_not_found')
    expect(requests()).toEqual([])
  })

  it('preflight: an id shape in the request, a label, an action_id, a value or a block_id → invalid_arguments, nothing sent', async () => {
    const c = h.client()
    const id = '@u-abcdefghijkl:chat.example.com'
    for (const blocks of [
      [actions([button(`ok ${id}`)])],
      [actions([button('ok', { action_id: id })])],
      [actions([button('ok', { value: `x ${id}` })])],
      [actions([button('ok')], { block_id: id })],
    ]) {
      expect(await refusal(c, 'chat.postMessage', { channel: GENERAL.id, text: 'pode?', blocks })).toBe('invalid_arguments')
    }
    expect(await refusal(c, 'chat.postMessage', { channel: GENERAL.id, text: `pode ${id}?`, blocks: [actions([button('ok')])] })).toBe('invalid_arguments')
    const data = await refusalData(c, 'chat.postMessage', { channel: GENERAL.id, text: 'pode?', blocks: [actions([button(`ok ${id}`)])] })
    expect(data).toEqual({ ok: false, error: 'invalid_arguments', response_metadata: { messages: ['[ERROR] content looks like an internal id: user_id'] } })
    expect(JSON.stringify(data)).not.toContain('chat.example.com')
    expect(requests()).toEqual([])
    expect(h.logs.filter((l) => l.evt === 'leak-blocked').length).toBeGreaterThanOrEqual(5)
    // A deny word in the agent's own fields is content, not the product talking.
    await post({ text: 'vou verificar', blocks: [actions([button('Verificar', { action_id: 'verify', value: 'verificar o backup' })], { block_id: 'verify' })] })
    expect(requests()).toHaveLength(1)
  })
})

describe('chat.postMessage without the facade', () => {
  it('actions dropped with blocks_unsupported:actions, as before', async () => {
    const plain = await startSlack()
    try {
      const res = await call(plain.client(), 'chat.postMessage', { channel: GENERAL.id, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'oi' } }, actions([button('Ok')])] })
      expect(res.response_metadata).toEqual({ warnings: ['blocks_unsupported:actions'] })
      expect(plain.world.calls).toEqual([{ op: 'post', conversation: GENERAL.id, text: 'oi' }])
    } finally {
      await plain.close()
    }
  })
})

describe('chat.update on a card', () => {
  const card = async (): Promise<string> => (await post({ text: 'Publicar?', blocks: [actions([button('Sim', { action_id: 'yes' }), button('Não', { action_id: 'no' })])] })).ts as string

  it('open card, no actions → the request edited, then the card closed; its entry leaves the file', async () => {
    const ts = await card()
    const res = await call(h.client(), 'chat.update', { channel: GENERAL.id, ts, text: 'Publicado *por outra via*' })
    expect(res).toMatchObject({ channel: GENERAL.id, ts, text: 'Publicado *por outra via*' })
    expect(h.world.calls.filter((c) => c.op === 'edit')).toEqual([
      { op: 'edit', conversation: GENERAL.id, ts, text: 'Publicado por outra via', rich: [{ t: 'p', children: [{ t: 'text', text: 'Publicado ' }, { t: 'strong', children: [{ t: 'text', text: 'por outra via' }] }] }] },
    ])
    expect(approvals.calls.filter((c) => c.op === 'close')).toEqual([{ op: 'close', conversation: GENERAL.id, ts }])
    expect((await saved()).cards).toEqual([])
  })

  it('sealed card (answered) → only the edit; the entry stays for the click', async () => {
    const ts = await card()
    approvals.answer(GENERAL.id, ts, 'yes', ALICE.id, 1_732_000_000_000)
    await call(h.client(), 'chat.update', { channel: GENERAL.id, ts, text: 'Aprovado' })
    expect(h.world.calls.filter((c) => c.op === 'edit')).toHaveLength(1)
    expect(approvals.calls.filter((c) => c.op === 'close')).toEqual([])
    expect((await saved()).cards.map((c) => c.id)).toEqual([ts])
  })

  it('closed card → only the edit', async () => {
    const ts = await card()
    await approvals.close(GENERAL.id, ts)
    approvals.calls.length = 0
    await call(h.client(), 'chat.update', { channel: GENERAL.id, ts, text: 'Encerrado' })
    expect(h.world.calls.filter((c) => c.op === 'edit')).toHaveLength(1)
    expect(approvals.calls).toEqual([])
  })

  it('an actions block on a message that is not one of the agent\'s cards → invalid_blocks; nothing edited', async () => {
    const plain = (await post({ text: 'comum' })).ts as string
    expect(await refusal(h.client(), 'chat.update', { channel: GENERAL.id, ts: plain, text: 'x', blocks: [actions([button('Sim')])] })).toBe('invalid_blocks')
    // Another person's message: invalid_blocks too, before the ownership error.
    expect(await refusal(h.client(), 'chat.update', { channel: GENERAL.id, ts: '1730000100.000100', text: 'x', blocks: [actions([button('Sim')])] })).toBe('invalid_blocks')
    expect(h.world.calls.filter((c) => c.op === 'edit')).toEqual([])
    expect(requests()).toHaveLength(0)
  })

  it('an ordinary message: as before (edit, no close)', async () => {
    const plain = (await post({ text: 'comum' })).ts as string
    await call(h.client(), 'chat.update', { channel: GENERAL.id, ts: plain, text: 'editada' })
    expect(h.world.calls.filter((c) => c.op === 'edit')).toEqual([{ op: 'edit', conversation: GENERAL.id, ts: plain, text: 'editada' }])
    expect(approvals.calls.filter((c) => c.op === 'close')).toEqual([])
  })
})

describe('chat.update with buttons on a card (chains)', () => {
  // Positional ids (action_ids off the option rule): new action_ids keep the same options.
  const yesNo = (n: number, over: Record<string, unknown> = {}) => [actions([button('Sim', { action_id: `Yes.${n}`, value: `y${n}` }), button('Não', { action_id: `No.${n}` })], over)]
  const origin = async (extra: Record<string, unknown> = {}): Promise<string> => (await post({ text: 'Publicar?', blocks: yesNo(1, { block_id: 'release' }), ...extra })).ts as string
  const update = (ts: string, args: Record<string, unknown>) => call(h.client(), 'chat.update', { channel: GENERAL.id, ts, ...args })
  const stateOf = async (ts: string) => (await approvals.state(GENERAL.id, ts)).approval.state
  const aliases = async () => (JSON.parse(await readFile(file, 'utf8')) as { aliases: Array<Record<string, unknown>> }).aliases

  it('open card, same options → the request edited in place, the card stays open; new action_id/value/block_id swap its entry', async () => {
    const ts = await origin()
    const res = await update(ts, { text: 'Publicar *já*?', blocks: yesNo(2, { block_id: 'release-2' }) })
    expect(idLeaks(res)).toEqual([])
    expect(res).toMatchObject({ channel: GENERAL.id, ts, message: { ts, text: 'Publicar *já*?' } })
    expect(h.world.calls.filter((c) => c.op === 'edit')).toEqual([expect.objectContaining({ op: 'edit', conversation: GENERAL.id, ts, text: 'Publicar já?' })])
    expect(requests()).toHaveLength(1)
    expect(approvals.calls.filter((c) => c.op === 'close')).toEqual([])
    expect(await stateOf(ts)).toBe('open')
    const entry = (await saved()).cards.find((c) => c.id === ts)
    expect(entry).toMatchObject({ block_id: 'release-2', actions: [{ option: 'b1', action_id: 'Yes.2', value: 'y2' }, { option: 'b2', action_id: 'No.2' }] })
    expect(await aliases()).toEqual([])
  })

  it('open card, other options → closed, and a new card in its place; the answer keeps the ts passed, the new card in message', async () => {
    const ts = await origin()
    const res = await update(ts, { text: 'E agora?', blocks: [actions([button('Agora', { action_id: 'now' }), button('Depois', { action_id: 'later' })])] })
    expect(idLeaks(res)).toEqual([])
    expect(approvals.calls.filter((c) => c.op === 'close')).toEqual([{ op: 'close', conversation: GENERAL.id, ts }])
    expect(requests()).toHaveLength(2)
    const second = requests()[1]
    expect(second).toEqual({ op: 'request', conversation: GENERAL.id, text: 'E agora?', options: [{ id: 'now', label: 'Agora' }, { id: 'later', label: 'Depois' }] })
    const live = (res.message as { ts: string }).ts
    expect(res).toMatchObject({ channel: GENERAL.id, ts, text: 'E agora?' })
    expect(live).not.toBe(ts)
    // The old card is not edited; its entry left with the layer's close; the new one is in the file.
    expect(h.world.calls.filter((c) => c.op === 'edit')).toEqual([])
    expect((await saved()).cards.map((c) => c.id)).toEqual([live])
    expect(await aliases()).toEqual([{ conversation: GENERAL.id, origin: ts, live, at: expect.any(Number) as number }])
  })

  it('answered card, same options → no close, a new card; the answered entry stays for its click', async () => {
    const ts = await origin()
    approvals.answer(GENERAL.id, ts, 'b1', ALICE.id, 1_732_000_000_000)
    const res = await update(ts, { text: 'Segunda aprovação?', blocks: yesNo(1, { block_id: 'release' }) })
    expect(approvals.calls.filter((c) => c.op === 'close')).toEqual([])
    expect(requests()).toHaveLength(2)
    const live = (res.message as { ts: string }).ts
    expect((await saved()).cards.map((c) => c.id).sort()).toEqual([ts, live].sort())
    expect(await stateOf(ts)).toBe('answered')
    expect(await stateOf(live)).toBe('open')
  })

  it('closed card with no answer → no close, a new card', async () => {
    const ts = await origin()
    await approvals.close(GENERAL.id, ts)
    approvals.calls.length = 0
    const res = await update(ts, { text: 'De novo?', blocks: yesNo(1) })
    expect(approvals.calls.filter((c) => c.op === 'close')).toEqual([])
    expect(requests()).toHaveLength(1)
    expect((res.message as { ts: string }).ts).not.toBe(ts)
  })

  it('a card in a thread → the new card in the same thread', async () => {
    const root = (await post({ text: 'raiz' })).ts as string
    const ts = await origin({ thread_ts: root })
    approvals.answer(GENERAL.id, ts, 'b1', ALICE.id, 1_732_000_000_000)
    await update(ts, { text: 'De novo?', blocks: yesNo(1) })
    expect(requests()[1]).toMatchObject({ thread: root })
  })

  it('a chain of three (origin → 2nd → 3rd): chat.update on the origin or on the 2nd acts on the live card; text only closes it', async () => {
    const ts = await origin()
    approvals.answer(GENERAL.id, ts, 'b1', ALICE.id, 1_732_000_000_000)
    const second = ((await update(ts, { text: 'Segunda?', blocks: yesNo(1) })).message as { ts: string }).ts
    approvals.answer(GENERAL.id, second, 'b2', ALICE.id, 1_732_000_000_001)
    // Through the 2nd card (any card of the chain): a 3rd card, in the origin's place.
    const third = ((await update(second, { text: 'Terceira?', blocks: yesNo(1) })).message as { ts: string }).ts
    expect(new Set([ts, second, third]).size).toBe(3)
    expect((await aliases()).map((a) => [a.origin, a.live])).toEqual([
      [ts, second],
      [ts, third],
    ])
    // Through the origin, no actions: the live card is edited and closed.
    const res = await update(ts, { text: 'Encerrado' })
    expect(res).toMatchObject({ ts, message: { ts: third, text: 'Encerrado' } })
    expect(h.world.calls.filter((c) => c.op === 'edit')).toEqual([expect.objectContaining({ ts: third, text: 'Encerrado' })])
    expect(approvals.calls.filter((c) => c.op === 'close')).toEqual([{ op: 'close', conversation: GENERAL.id, ts: third }])
    expect(await stateOf(ts)).toBe('answered')
    expect(await stateOf(second)).toBe('answered')
  })

  it('chat.delete on the origin acts on the literal ts; the chain still answers on it', async () => {
    const ts = await origin()
    approvals.answer(GENERAL.id, ts, 'b1', ALICE.id, 1_732_000_000_000)
    const live = ((await update(ts, { text: 'Segunda?', blocks: yesNo(1) })).message as { ts: string }).ts
    await call(h.client(), 'chat.delete', { channel: GENERAL.id, ts })
    expect(h.world.calls.filter((c) => c.op === 'remove')).toEqual([{ op: 'remove', conversation: GENERAL.id, ts }])
    // The live card is untouched; the origin's ts still reaches it (the thread comes from the live card).
    await update(ts, { text: 'Encerrado' })
    expect(h.world.calls.filter((c) => c.op === 'edit')).toEqual([expect.objectContaining({ ts: live })])
  })

  it('preflight before any effect: an id shape in a new value → invalid_arguments, nothing closed or sent', async () => {
    const ts = await origin()
    const id = '@u-abcdefghijkl:chat.example.com'
    const data = await refusalData(h.client(), 'chat.update', { channel: GENERAL.id, ts, text: 'x', blocks: [actions([button('Ok', { value: id })])] })
    expect(data).toEqual({ ok: false, error: 'invalid_arguments', response_metadata: { messages: ['[ERROR] content looks like an internal id: user_id'] } })
    expect(approvals.calls.filter((c) => c.op === 'close')).toEqual([])
    expect(requests()).toHaveLength(1)
    expect(h.world.calls.filter((c) => c.op === 'edit')).toEqual([])
  })

  it('the chain is read back from the file after the layer restarts', async () => {
    const ts = await origin()
    approvals.answer(GENERAL.id, ts, 'b1', ALICE.id, 1_732_000_000_000)
    const live = ((await update(ts, { text: 'Segunda?', blocks: yesNo(1) })).message as { ts: string }).ts
    const world = h.world
    await h.close()
    h = await startSlack({ world, approvals, cardsFile: file })
    const res = await update(ts, { text: 'Encerrado' })
    expect(res).toMatchObject({ ts, message: { ts: live } })
    expect(world.calls.filter((c) => c.op === 'edit')).toEqual([expect.objectContaining({ ts: live })])
  })
})
