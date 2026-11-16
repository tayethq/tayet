import { describe, it, expect, beforeAll, afterAll } from 'vitest'
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
