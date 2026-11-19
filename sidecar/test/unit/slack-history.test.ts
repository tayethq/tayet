import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { ALICE, BOB, DM, GENERAL, GONE, ME, call, idLeaks, message, refusal, startSlack, type SlackHarness } from '../support/slack-world'

// conversations.history / replies through the real @slack/web-api (PLANO-AGENTES §0.3.12 items 3, 7).

let h: SlackHarness
beforeAll(async () => {
  h = await startSlack()
})
afterAll(() => h.close())

const ok = async (method: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const res = await call(h.client(), method, args)
  expect(idLeaks(res)).toEqual([])
  return res
}
const tsList = (res: Record<string, unknown>): string[] => (res.messages as Array<{ ts: string }>).map((m) => m.ts)

describe('conversations.history', () => {
  it('newest first, no thread replies; the Slack message shape', async () => {
    const res = await ok('conversations.history', { channel: GENERAL.id })
    expect(tsList(res)).toEqual(['1730000200.000200', '1730000100.000100'])
    expect(res).toMatchObject({ has_more: false, response_metadata: { next_cursor: '' } })
    const root = (res.messages as Array<Record<string, unknown>>)[1]
    expect(root).toEqual({
      type: 'message',
      user: BOB.id,
      text: 'pergunta do Bob',
      ts: '1730000100.000100',
      thread_ts: '1730000100.000100',
      reply_count: 1,
      latest_reply: '1730000300.000000',
      reactions: [{ name: '+1', count: 2, users: [ME.id] }],
    })
    expect(root).not.toHaveProperty('blocks')
  })

  it('limit + cursor (has_more); oldest/latest/inclusive', async () => {
    const first = await ok('conversations.history', { channel: GENERAL.id, limit: 1 })
    expect(first).toMatchObject({ has_more: true })
    const next = (first.response_metadata as { next_cursor: string }).next_cursor
    expect(tsList(await ok('conversations.history', { channel: GENERAL.id, limit: 1, cursor: next }))).toEqual(['1730000100.000100'])
    expect(tsList(await ok('conversations.history', { channel: GENERAL.id, oldest: '1730000100.000100' }))).toEqual(['1730000200.000200'])
    expect(tsList(await ok('conversations.history', { channel: GENERAL.id, oldest: '1730000100.000100', inclusive: true }))).toEqual([
      '1730000200.000200',
      '1730000100.000100',
    ])
    expect(tsList(await ok('conversations.history', { channel: GENERAL.id, latest: '1730000200.000200' }))).toEqual(['1730000100.000100'])
    // Slack's "from the start" bound.
    expect(tsList(await ok('conversations.history', { channel: GENERAL.id, oldest: '0' }))).toHaveLength(2)
  })

  it('the WebClient helper and its paginator', async () => {
    const res = await h.client().conversations.history({ channel: GENERAL.id })
    expect(res.messages?.map((m) => m.user)).toEqual([GONE.id, BOB.id])
    const seen: string[] = []
    for await (const page of h.client().paginate('conversations.history', { channel: GENERAL.id, limit: 1 })) {
      seen.push(...tsList(page as unknown as Record<string, unknown>))
    }
    expect(seen).toEqual(['1730000200.000200', '1730000100.000100'])
  })

  it('the text is mrkdwn; a mention of the agent is <@U_agent> (§0.3.12 item 4)', async () => {
    h.world.messages.get(DM.id)?.push(
      message({
        id: '1730000400.000400',
        conversation: DM.id,
        text: '@Relatórios veja isto & aquilo',
        rich: [{ t: 'p', children: [{ t: 'text', text: '@Relatórios ' }, { t: 'strong', children: [{ t: 'text', text: 'veja' }] }, { t: 'text', text: ' isto & aquilo' }] }] as unknown as Record<string, unknown>,
        mentions: [ME.id],
        mentionsMe: true,
      }),
    )
    const res = await ok('conversations.history', { channel: DM.id })
    expect(res.messages).toEqual([expect.objectContaining({ user: ALICE.id, text: '<@UAGENTAAAAA> *veja* isto &amp; aquilo' })])
  })

  it('unknown conversation → channel_not_found', async () => {
    expect(await refusal(h.client(), 'conversations.history', { channel: 'CNOTHEREAAA' })).toBe('channel_not_found')
  })
})

describe('conversations.replies', () => {
  it('the root first (read by its ts), then the replies oldest first', async () => {
    const res = await ok('conversations.replies', { channel: GENERAL.id, ts: '1730000100.000100' })
    expect(tsList(res)).toEqual(['1730000100.000100', '1730000300.000300'])
    expect((res.messages as Array<Record<string, unknown>>)[1]).toMatchObject({ user: ALICE.id, thread_ts: '1730000100.000100', text: 'resposta da Alice' })
  })

  it('a root read without its thread summary gets it from the replies (found against the stack)', async () => {
    const root = h.world.messages.get(GENERAL.id)?.find((m) => m.id === '1730000100.000100')
    const summary = root?.threadSummary
    if (root !== undefined) delete root.threadSummary
    try {
      const res = await ok('conversations.replies', { channel: GENERAL.id, ts: '1730000100.000100' })
      expect((res.messages as Array<Record<string, unknown>>)[0]).toMatchObject({ thread_ts: '1730000100.000100', reply_count: 1, latest_reply: '1730000300.000000' })
    } finally {
      if (root !== undefined && summary !== undefined) root.threadSummary = summary
    }
  })

  it('a reply’s ts names its thread; a message with no replies is a thread of one', async () => {
    expect(tsList(await ok('conversations.replies', { channel: GENERAL.id, ts: '1730000300.000300' }))).toEqual(['1730000100.000100', '1730000300.000300'])
    expect(tsList(await ok('conversations.replies', { channel: GENERAL.id, ts: '1730000200.000200' }))).toEqual(['1730000200.000200'])
  })

  it('limit + cursor; an unknown ts → thread_not_found; no ts → thread_not_found', async () => {
    const first = await ok('conversations.replies', { channel: GENERAL.id, ts: '1730000100.000100', limit: 1 })
    expect(tsList(first)).toEqual(['1730000100.000100'])
    const next = (first.response_metadata as { next_cursor: string }).next_cursor
    expect(tsList(await ok('conversations.replies', { channel: GENERAL.id, ts: '1730000100.000100', limit: 1, cursor: next }))).toEqual(['1730000300.000300'])
    expect(await refusal(h.client(), 'conversations.replies', { channel: GENERAL.id, ts: '1730009999.000999' })).toBe('thread_not_found')
    expect(await refusal(h.client(), 'conversations.replies', { channel: GENERAL.id })).toBe('thread_not_found')
  })
})

// A message whose content carries an id shape goes out withheld in a read (the shape of an unavailable message:
// no text), and the rest of the page comes back. A fresh world per test: these mutate it.
describe('a read withholds only the message whose content carries an id shape', () => {
  let s: SlackHarness | undefined
  afterEach(async () => {
    await s?.close()
    s = undefined
  })
  const leakLines = (logs: Array<Record<string, unknown>>) => logs.filter((l) => l.evt === 'leak-blocked')
  const plain = async (method: string, args: Record<string, unknown>) => {
    const res = await call((s as SlackHarness).client(), method, args)
    expect(idLeaks(res)).toEqual([])
    return res.messages as Array<Record<string, unknown>>
  }

  it('conversations.history: ok, the message withheld, its neighbours with their text', async () => {
    s = await startSlack()
    s.world.messages.get(GENERAL.id)?.splice(2, 0, message({ id: '1730000150.000150', author: BOB.id, text: 'fala com @alice:server.example', reactions: [{ emoji: '👍', count: 1, mine: false }] }))
    const messages = await plain('conversations.history', { channel: GENERAL.id })
    expect(messages.map((m) => m.ts)).toEqual(['1730000200.000200', '1730000150.000150', '1730000100.000100'])
    expect(messages[1]).toEqual({ type: 'message', user: BOB.id, text: '', ts: '1730000150.000150' })
    expect(messages[0]).toMatchObject({ text: 'mensagem de quem saiu' })
    expect(messages[2]).toMatchObject({ text: 'pergunta do Bob' })
    expect(leakLines(s.logs)).toEqual([{ evt: 'leak-blocked', where: 'slack conversations.history', path: '$.messages[1].text', pattern: 'mxid' }])
    expect(JSON.stringify(s.logs)).not.toContain('@alice')
  })

  it('conversations.replies: a reply withheld in the page; the root keeps its text', async () => {
    s = await startSlack()
    s.world.messages.get(GENERAL.id)?.unshift(message({ id: '1730000400.000400', author: BOB.id, text: 'e @alice:server.example', thread: '1730000100.000100' }))
    const messages = await plain('conversations.replies', { channel: GENERAL.id, ts: '1730000100.000100' })
    expect(messages.map((m) => [m.ts, m.text])).toEqual([
      ['1730000100.000100', 'pergunta do Bob'],
      ['1730000300.000300', 'resposta da Alice'],
      ['1730000400.000400', ''],
    ])
    expect(messages[2]).toEqual({ type: 'message', user: BOB.id, text: '', ts: '1730000400.000400', thread_ts: '1730000100.000100' })
    expect(leakLines(s.logs)).toEqual([{ evt: 'leak-blocked', where: 'slack conversations.replies', path: '$.messages[0].text', pattern: 'mxid' }])
  })

  it('conversations.replies: the root withheld (read by its ts, and by a reply’s ts); the replies keep their text, the root its place in the thread', async () => {
    s = await startSlack()
    const root = s.world.messages.get(GENERAL.id)?.find((m) => m.id === '1730000100.000100')
    if (root !== undefined) root.text = 'pergunta para @alice:server.example'
    for (const ts of ['1730000100.000100', '1730000300.000300']) {
      const messages = await plain('conversations.replies', { channel: GENERAL.id, ts })
      expect(messages[0]).toEqual({ type: 'message', user: BOB.id, text: '', ts: '1730000100.000100', thread_ts: '1730000100.000100', reply_count: 1, latest_reply: '1730000300.000000' })
      expect(messages.slice(1).map((m) => [m.ts, m.text, m.thread_ts])).toEqual([['1730000300.000300', 'resposta da Alice', '1730000100.000100']])
    }
    expect(leakLines(s.logs).map((l) => [l.where, l.path, l.pattern])).toEqual([
      ['slack conversations.replies', '$.text', 'mxid'],
      ['slack conversations.replies', '$.text', 'mxid'],
    ])
    expect(JSON.stringify(s.logs)).not.toContain('@alice')
  })

  it('a structural finding in a listed message (a raw id in user) stays internal_error', async () => {
    s = await startSlack()
    s.world.messages.get(GENERAL.id)?.splice(2, 0, message({ id: '1730000150.000150', author: '@alice:server.example' }))
    expect(await refusal(s.client(), 'conversations.history', { channel: GENERAL.id })).toBe('internal_error')
    expect(leakLines(s.logs)).toContainEqual({ evt: 'leak-blocked', where: 'slack conversations.history', path: '$.messages[1].author', pattern: 'mxid' })
  })

  it('what does not change: a write’s answer withheld after the write stays internal_error', async () => {
    s = await startSlack()
    const write = s.world.write
    const post = write.post.bind(write)
    write.post = async (conv, req) => ({ ...(await post(conv, req)), text: 'ver @alice:server.example' })
    expect(await refusal(s.client(), 'chat.postMessage', { channel: GENERAL.id, text: 'oi' })).toBe('internal_error')
    expect(s.world.calls).toHaveLength(1)
    expect(leakLines(s.logs)).toContainEqual({ evt: 'leak-blocked', where: 'slack chat.postMessage', path: '$.text', pattern: 'mxid' })
  })
})
