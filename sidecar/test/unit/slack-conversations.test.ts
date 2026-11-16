import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ALICE, BOB, BOT, DM, GENERAL, ME, SECRET, call, idLeaks, refusal, startSlack, type SlackHarness } from '../support/slack-world'

// auth.test and conversations.list/info/members through the real @slack/web-api (PLANO-AGENTES §0.3.12
// items 1, 7), over in-memory facades. Every answer goes through the tests' leak-scan.

let h: SlackHarness
beforeAll(async () => {
  h = await startSlack()
})
afterAll(() => h.close())

const ok = async (method: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
  const res = await call(h.client(), method, args)
  expect(idLeaks(res)).toEqual([])
  return res
}

describe('auth.test', () => {
  it('url = the product URL; team = the T… (no workspace name natively); user/user_id; bot_id B…', async () => {
    expect(await ok('auth.test')).toMatchObject({
      ok: true,
      url: 'https://chat.example.com/',
      team: ME.workspace,
      team_id: ME.workspace,
      user: ME.name,
      user_id: ME.id,
      bot_id: BOT,
    })
  })

  it('the WebClient helper works as is', async () => {
    const res = await h.client().auth.test()
    expect(res.user_id).toBe(ME.id)
    expect(res.bot_id).toBe(BOT)
  })
})

describe('conversations.list', () => {
  it('default types = public_channel (Slack’s default)', async () => {
    const res = await ok('conversations.list')
    expect(res.channels).toEqual([expect.objectContaining({ id: GENERAL.id, name: 'geral', is_channel: true, is_private: false, is_im: false, num_members: 3, topic: { value: 'Avisos', creator: '', last_set: 0 } })])
    expect(res.response_metadata).toEqual({ next_cursor: '' })
  })

  it('types filters private_channel and im; an im carries its person; mpim is always empty', async () => {
    const res = await ok('conversations.list', { types: 'public_channel,private_channel,im' })
    expect((res.channels as Array<{ id: string }>).map((c) => c.id)).toEqual([GENERAL.id, SECRET.id, DM.id])
    expect(res.channels).toContainEqual(expect.objectContaining({ id: SECRET.id, is_private: true, is_channel: true }))
    expect(res.channels).toContainEqual(expect.objectContaining({ id: DM.id, is_im: true, is_channel: false, user: ALICE.id }))
    expect((await ok('conversations.list', { types: 'mpim' })).channels).toEqual([])
    expect(await refusal(h.client(), 'conversations.list', { types: 'shared_channel' })).toBe('invalid_arguments')
  })

  it('limit + cursor page through; exclude_archived is accepted; a bad cursor → invalid_cursor', async () => {
    const first = await ok('conversations.list', { types: 'public_channel,private_channel,im', limit: 2, exclude_archived: true })
    expect((first.channels as unknown[]).length).toBe(2)
    const next = (first.response_metadata as { next_cursor: string }).next_cursor
    expect(next).not.toBe('')
    const second = await ok('conversations.list', { types: 'public_channel,private_channel,im', limit: 2, cursor: next })
    expect(second.channels).toEqual([expect.objectContaining({ id: DM.id })])
    expect(second.response_metadata).toEqual({ next_cursor: '' })
    expect(await refusal(h.client(), 'conversations.list', { cursor: 'bogus' })).toBe('invalid_cursor')
  })

  it('the WebClient paginator walks every page', async () => {
    const ids: string[] = []
    for await (const page of h.client().paginate('conversations.list', { types: 'public_channel,private_channel,im', limit: 1 })) {
      ids.push(...((page as unknown as { channels: Array<{ id: string }> }).channels.map((c) => c.id)))
    }
    expect(ids).toEqual([GENERAL.id, SECRET.id, DM.id])
  })
})

describe('conversations.info / members', () => {
  it('info of a conversation of the agent; unknown → channel_not_found; missing → channel_not_found', async () => {
    expect(await ok('conversations.info', { channel: GENERAL.id, include_num_members: true })).toMatchObject({ channel: { id: GENERAL.id, name: 'geral', num_members: 3 } })
    expect(await refusal(h.client(), 'conversations.info', { channel: 'CNOTHEREAAA' })).toBe('channel_not_found')
    expect(await refusal(h.client(), 'conversations.info')).toBe('channel_not_found')
  })

  it('members: U… tokens, paged by limit/cursor', async () => {
    const first = await ok('conversations.members', { channel: GENERAL.id, limit: 2 })
    expect(first.members).toEqual([ME.id, ALICE.id])
    const next = (first.response_metadata as { next_cursor: string }).next_cursor
    const second = await ok('conversations.members', { channel: GENERAL.id, limit: 2, cursor: next })
    expect(second).toMatchObject({ members: [BOB.id], response_metadata: { next_cursor: '' } })
    expect(await refusal(h.client(), 'conversations.members', { channel: 'CNOTHEREAAA' })).toBe('channel_not_found')
  })
})

// conversations.open (S-f3; §0.3.12 item 7, ADR-090): the existing DM with that person, else a refusal; the
// agent never creates a DM.
describe('conversations.open', () => {
  const refused = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    try {
      await h.client().apiCall('conversations.open', args)
    } catch (err) {
      const data = (err as { data?: Record<string, unknown> }).data ?? {}
      expect(idLeaks(data)).toEqual([])
      return data
    }
    throw new Error('not refused')
  }

  it('users = the person of an existing DM → its D…; return_im → the whole object', async () => {
    const before = h.world.calls.length
    expect(await ok('conversations.open', { users: ALICE.id })).toMatchObject({ ok: true, no_op: true, already_open: true, channel: { id: DM.id } })
    const res = await h.client().conversations.open({ users: ALICE.id, return_im: true })
    expect(res.channel).toMatchObject({ id: DM.id, is_im: true, user: ALICE.id, is_member: true })
    expect(idLeaks(res)).toEqual([])
    expect(h.world.calls.length).toBe(before)
  })

  it('a person with no DM → restricted_action + the operator warning; nothing is written', async () => {
    const before = h.world.calls.length
    expect(await refused({ users: BOB.id })).toMatchObject({ ok: false, error: 'restricted_action', response_metadata: { warnings: ['dm_opened_by_operator'] } })
    expect(h.world.calls.length).toBe(before)
  })

  it('an unknown U… → user_not_found; two users (no group DM) → invalid_arguments; the agent itself → invalid_arguments', async () => {
    expect(await refusal(h.client(), 'conversations.open', { users: 'UNOBODYAAAA' })).toBe('user_not_found')
    expect(await refusal(h.client(), 'conversations.open', { users: `${ALICE.id},${BOB.id}` })).toBe('invalid_arguments')
    expect(await refusal(h.client(), 'conversations.open', { users: ME.id })).toBe('invalid_arguments')
    expect(await refusal(h.client(), 'conversations.open', {})).toBe('invalid_arguments')
    expect(await refusal(h.client(), 'conversations.open', { users: ALICE.id, channel: DM.id })).toBe('invalid_arguments')
  })

  it('channel = a conversation of the agent → itself (return_im: the object); unknown → channel_not_found', async () => {
    expect(await ok('conversations.open', { channel: DM.id })).toMatchObject({ channel: { id: DM.id } })
    expect(await ok('conversations.open', { channel: GENERAL.id, return_im: true })).toMatchObject({ channel: { id: GENERAL.id, name: 'geral', is_channel: true } })
    expect(await refusal(h.client(), 'conversations.open', { channel: 'DNOTHEREAAA' })).toBe('channel_not_found')
  })
})
