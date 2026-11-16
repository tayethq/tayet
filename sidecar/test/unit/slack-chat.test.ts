import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ALICE, DM, GENERAL, ME, TOKEN, call, createWorld, idLeaks, refusal, startSlack, type SlackHarness } from '../support/slack-world'
import { fakeApprovals } from '../support/slack-approvals'

// chat.postMessage / update / delete through the real @slack/web-api (PLANO-AGENTES §0.3.12 items 4, 7, 11).

let h: SlackHarness
beforeEach(async () => {
  h = await startSlack()
})
afterEach(() => h.close())

const ok = async (method: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const res = await call(h.client(), method, args)
  expect(idLeaks(res)).toEqual([])
  return res
}
const posts = () => h.world.calls.filter((c) => c.op === 'post')

describe('chat.postMessage', () => {
  it('mrkdwn → rich + mentions; the answer is { channel, ts, message } as a read shows it', async () => {
    const res = await ok('chat.postMessage', { channel: GENERAL.id, text: 'oi <@UALICEAAAAA>, o *deploy* saiu' })
    expect(posts()).toEqual([
      {
        op: 'post',
        conversation: GENERAL.id,
        text: 'oi @Alice Souza, o deploy saiu',
        rich: [{ t: 'p', children: [{ t: 'text', text: 'oi @Alice Souza, o ' }, { t: 'strong', children: [{ t: 'text', text: 'deploy' }] }, { t: 'text', text: ' saiu' }] }],
        mentions: [ALICE.id],
      },
    ])
    expect(res).toMatchObject({ channel: GENERAL.id, ts: expect.stringMatching(/^\d+\.\d{6}$/) as unknown, message: { type: 'message', user: ME.id, text: 'oi <@UALICEAAAAA>, o *deploy* saiu' } })
    expect(res).not.toHaveProperty('response_metadata.warnings')
  })

  it('the WebClient helper; mrkdwn: false sends the text as is (escapes decoded)', async () => {
    const res = await h.client().chat.postMessage({ channel: DM.id, text: '*literal* &amp; <@UALICEAAAAA>', mrkdwn: false })
    expect(res.ok).toBe(true)
    expect(posts()[0]).toEqual({ op: 'post', conversation: DM.id, text: '*literal* & <@UALICEAAAAA>' })
  })

  it('thread_ts → the native thread; an unknown thread → thread_not_found', async () => {
    await ok('chat.postMessage', { channel: GENERAL.id, text: 'na thread', thread_ts: '1730000100.000100' })
    expect(posts()[0]).toMatchObject({ thread: '1730000100.000100' })
    expect(await refusal(h.client(), 'chat.postMessage', { channel: GENERAL.id, text: 'x', thread_ts: '1730009999.000999' })).toBe('thread_not_found')
  })

  it('the ignored arguments come back as warnings (P6: the agent speaks as itself)', async () => {
    const res = await ok('chat.postMessage', { channel: GENERAL.id, text: 'x', username: 'Outro', icon_emoji: ':robot_face:', icon_url: 'https://ex.com/i.png', as_user: true, reply_broadcast: true })
    expect(res.response_metadata).toMatchObject({
      warnings: ['ignored_argument:reply_broadcast', 'ignored_argument:username', 'ignored_argument:icon_url', 'ignored_argument:icon_emoji', 'ignored_argument:as_user'],
    })
  })

  it('blocks with no text are flattened; actions dropped with blocks_unsupported:actions', async () => {
    const res = await ok('chat.postMessage', {
      channel: GENERAL.id,
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: 'Relatório' } },
        { type: 'section', text: { type: 'mrkdwn', text: 'tudo *ok*' } },
        { type: 'divider' },
        { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Aprovar' }, action_id: 'a' }] },
      ],
    })
    expect(posts()[0]).toMatchObject({ text: 'Relatório\n\ntudo ok' })
    expect(res.response_metadata).toMatchObject({ warnings: ['blocks_unsupported:actions'] })
    expect(res.message).not.toHaveProperty('blocks')
  })

  it('text wins over blocks', async () => {
    await ok('chat.postMessage', { channel: GENERAL.id, text: 'o texto', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'o bloco' } }] })
    expect(posts()[0]).toMatchObject({ text: 'o texto' })
  })

  it('refusals: no text → no_text; unknown channel → channel_not_found; too long → msg_too_long; an id in the text → internal_error before any effect', async () => {
    expect(await refusal(h.client(), 'chat.postMessage', { channel: GENERAL.id })).toBe('no_text')
    expect(await refusal(h.client(), 'chat.postMessage', { channel: GENERAL.id, text: '   ' })).toBe('no_text')
    expect(await refusal(h.client(), 'chat.postMessage', { channel: GENERAL.id, blocks: [{ type: 'divider' }] })).toBe('no_text')
    expect(await refusal(h.client(), 'chat.postMessage', { channel: 'CNOTHEREAAA', text: 'x' })).toBe('channel_not_found')
    expect(await refusal(h.client(), 'chat.postMessage', { channel: GENERAL.id, text: 'x'.repeat(33 * 1024) })).toBe('msg_too_long')
    expect(await refusal(h.client(), 'chat.postMessage', { channel: GENERAL.id, text: 'fale com @bob:server.example' })).toBe('internal_error')
    expect(posts()).toEqual([])
  })
})

describe('chat.update / chat.delete', () => {
  it('update: own message, mrkdwn → rich; someone else’s → cant_update_message', async () => {
    const posted = await ok('chat.postMessage', { channel: GENERAL.id, text: 'rascunho' })
    const res = await ok('chat.update', { channel: GENERAL.id, ts: posted.ts, text: '_final_' })
    expect(res).toMatchObject({ channel: GENERAL.id, ts: posted.ts, text: '_final_', message: { text: '_final_', edited: { user: ME.id } } })
    expect(h.world.calls.find((c) => c.op === 'edit')).toMatchObject({ text: 'final', rich: [{ t: 'p', children: [{ t: 'em', children: [{ t: 'text', text: 'final' }] }] }] })
    expect(await refusal(h.client(), 'chat.update', { channel: GENERAL.id, ts: '1730000100.000100', text: 'x' })).toBe('cant_update_message')
    expect(await refusal(h.client(), 'chat.update', { channel: GENERAL.id, ts: '1730009999.000999', text: 'x' })).toBe('message_not_found')
  })

  it('delete: own message; someone else’s → cant_delete_message; unknown → message_not_found', async () => {
    const posted = await ok('chat.postMessage', { channel: GENERAL.id, text: 'apagar' })
    expect(await ok('chat.delete', { channel: GENERAL.id, ts: posted.ts })).toMatchObject({ ok: true, channel: GENERAL.id, ts: posted.ts })
    expect(h.world.calls.find((c) => c.op === 'remove')).toEqual({ op: 'remove', conversation: GENERAL.id, ts: posted.ts })
    expect(await refusal(h.client(), 'chat.delete', { channel: GENERAL.id, ts: '1730000100.000100' })).toBe('cant_delete_message')
    expect(await refusal(h.client(), 'chat.delete', { channel: GENERAL.id, ts: '1730009999.000999' })).toBe('message_not_found')
  })
})

describe('the markdown block and markdown_text', () => {
  const MD = '**bold** and\n- one\n- two'
  const RICH = [
    { t: 'p', children: [{ t: 'strong', children: [{ t: 'text', text: 'bold' }] }, { t: 'text', text: ' and' }] },
    { t: 'ul', items: [[{ t: 'p', children: [{ t: 'text', text: 'one' }] }], [{ t: 'p', children: [{ t: 'text', text: 'two' }] }]] },
  ]
  const SENT = { text: 'bold and\n\n- one\n- two', rich: RICH }

  it('blocks with a markdown block: standard Markdown, no warning', async () => {
    const res = await ok('chat.postMessage', { channel: GENERAL.id, blocks: [{ type: 'markdown', text: MD }] })
    expect(posts()).toEqual([{ op: 'post', conversation: GENERAL.id, ...SENT }])
    expect(res).not.toHaveProperty('response_metadata.warnings')
  })

  it('text + a markdown block: the block is the content', async () => {
    await ok('chat.postMessage', { channel: GENERAL.id, text: 'the fallback', blocks: [{ type: 'markdown', text: MD }] })
    expect(posts()).toEqual([{ op: 'post', conversation: GENERAL.id, ...SENT }])
  })

  it('text + a section block, no markdown block: the text wins, as before', async () => {
    await ok('chat.postMessage', { channel: GENERAL.id, text: 'the *text*', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'the block' } }] })
    expect(posts()[0]).toMatchObject({ text: 'the text' })
  })

  it('a mention outside code is resolved into mentions; inside backticks it stays literal', async () => {
    await ok('chat.postMessage', { channel: GENERAL.id, blocks: [{ type: 'markdown', text: 'hi <@UALICEAAAAA>, see `<@UALICEAAAAA>`' }] })
    expect(posts()).toEqual([
      { op: 'post', conversation: GENERAL.id, text: 'hi @Alice Souza, see <@UALICEAAAAA>', rich: [{ t: 'p', children: [{ t: 'text', text: 'hi @Alice Souza, see ' }, { t: 'code', text: '<@UALICEAAAAA>' }] }], mentions: [ALICE.id] },
    ])
  })

  it('a markdown block with an empty text as the only content → no_text', async () => {
    expect(await refusal(h.client(), 'chat.postMessage', { channel: GENERAL.id, blocks: [{ type: 'markdown', text: '' }] })).toBe('no_text')
    expect(await refusal(h.client(), 'chat.postMessage', { channel: GENERAL.id, text: 'x', blocks: [{ type: 'markdown', text: '  ' }] })).toBe('no_text')
    expect(posts()).toEqual([])
  })

  it('markdown_text alone: the same content as one markdown block, on chat.postMessage and chat.update', async () => {
    const posted = await ok('chat.postMessage', { channel: GENERAL.id, markdown_text: MD })
    expect(posts()).toEqual([{ op: 'post', conversation: GENERAL.id, ...SENT }])
    await ok('chat.update', { channel: GENERAL.id, ts: posted.ts, markdown_text: MD })
    expect(h.world.calls.filter((c) => c.op === 'edit')).toEqual([{ op: 'edit', conversation: GENERAL.id, ts: posted.ts, ...SENT }])
  })

  it('markdown_text with text or with blocks → markdown_text_conflict; not a string → invalid_arguments; nothing sent', async () => {
    expect(await refusal(h.client(), 'chat.postMessage', { channel: GENERAL.id, markdown_text: MD, text: 'x' })).toBe('markdown_text_conflict')
    expect(await refusal(h.client(), 'chat.postMessage', { channel: GENERAL.id, markdown_text: MD, blocks: [{ type: 'divider' }] })).toBe('markdown_text_conflict')
    // A non-string only exists in a JSON body (the WebClient's form body turns any value into a string).
    const json = async (body: Record<string, unknown>) =>
      (await (await fetch(`${h.url}/slack/api/chat.postMessage`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()) as Record<string, unknown>
    expect(await json({ channel: GENERAL.id, markdown_text: 42 })).toEqual({ ok: false, error: 'invalid_arguments' })
    expect(await json({ channel: GENERAL.id, markdown_text: { text: MD } })).toEqual({ ok: false, error: 'invalid_arguments' })
    const posted = await ok('chat.postMessage', { channel: GENERAL.id, text: 'draft' })
    expect(await refusal(h.client(), 'chat.update', { channel: GENERAL.id, ts: posted.ts, markdown_text: MD, text: 'x' })).toBe('markdown_text_conflict')
    expect(posts()).toHaveLength(1)
    expect(h.world.calls.filter((c) => c.op === 'edit')).toEqual([])
  })
})

describe('the markdown block on an approval card', () => {
  let dir: string
  let card: SlackHarness
  afterEach(async () => {
    await card.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('text + an actions block + a markdown block: the card request comes from the blocks, not from the text', async () => {
    dir = await mkdtemp(join(tmpdir(), 'slack-chat-md-'))
    const world = createWorld()
    const approvals = fakeApprovals(world)
    card = await startSlack({ world, approvals, cardsFile: join(dir, 'slack-cards.json') })
    await call(card.client(), 'chat.postMessage', {
      channel: GENERAL.id,
      text: 'the fallback',
      blocks: [
        { type: 'markdown', text: 'Ship **2.1**?' },
        { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Yes' }, action_id: 'yes' }, { type: 'button', text: { type: 'plain_text', text: 'No' }, action_id: 'no' }] },
      ],
    })
    expect(approvals.calls.filter((c) => c.op === 'request')).toEqual([
      {
        op: 'request',
        conversation: GENERAL.id,
        text: 'Ship 2.1?',
        rich: [{ t: 'p', children: [{ t: 'text', text: 'Ship ' }, { t: 'strong', children: [{ t: 'text', text: '2.1' }] }, { t: 'text', text: '?' }] }],
        options: [
          { id: 'yes', label: 'Yes' },
          { id: 'no', label: 'No' },
        ],
      },
    ])
  })
})
