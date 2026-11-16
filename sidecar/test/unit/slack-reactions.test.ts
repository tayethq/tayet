import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { GENERAL, ME, call, idLeaks, refusal, startSlack, type SlackHarness } from '../support/slack-world'

// reactions.add / reactions.remove through the real @slack/web-api (ADR-087 dec. 6; PLANO-AGENTES §0.3.12).

let h: SlackHarness
beforeEach(async () => {
  h = await startSlack()
})
afterEach(() => h.close())

const ROOT = '1730000100.000100'
const REPLY = '1730000300.000300'
const effects = () => h.world.calls.filter((c) => c.op === 'react' || c.op === 'unreact')
const ok = async (method: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const res = await call(h.client(), method, args)
  expect(idLeaks(res)).toEqual([])
  return res
}

describe('reactions.add', () => {
  it('a Slack name → the character (the WebClient helper)', async () => {
    const res = await h.client().reactions.add({ channel: GENERAL.id, timestamp: REPLY, name: 'thumbsup' })
    expect(res.ok).toBe(true)
    expect(effects()).toEqual([{ op: 'react', conversation: GENERAL.id, ts: REPLY, emoji: '👍' }])
  })

  it('+1, a skin tone, and the character itself', async () => {
    await ok('reactions.add', { channel: GENERAL.id, timestamp: REPLY, name: '+1' })
    await ok('reactions.add', { channel: GENERAL.id, timestamp: REPLY, name: 'wave::skin-tone-3' })
    await ok('reactions.add', { channel: GENERAL.id, timestamp: REPLY, name: '🎉' })
    expect(effects().map((c) => c.emoji)).toEqual(['👍', '👋\u{1F3FC}', '🎉'])
  })

  it('read back, the reaction carries its Slack name; a skin tone keeps it', async () => {
    await ok('reactions.add', { channel: GENERAL.id, timestamp: REPLY, name: 'wave::skin-tone-3' })
    const replies = await ok('conversations.replies', { channel: GENERAL.id, ts: ROOT })
    const messages = replies.messages as Array<Record<string, unknown>>
    expect(messages[0]).toMatchObject({ reactions: [{ name: '+1', count: 2, users: [ME.id] }] })
    expect(messages[1]).toMatchObject({ reactions: [{ name: 'wave::skin-tone-3', count: 1, users: [ME.id] }] })
  })

  it('unknown name → invalid_name; repeated → already_reacted; unknown message → message_not_found', async () => {
    expect(await refusal(h.client(), 'reactions.add', { channel: GENERAL.id, timestamp: REPLY, name: 'not_an_emoji' })).toBe('invalid_name')
    expect(await refusal(h.client(), 'reactions.add', { channel: GENERAL.id, timestamp: REPLY })).toBe('invalid_name')
    expect(await refusal(h.client(), 'reactions.add', { channel: GENERAL.id, timestamp: ROOT, name: 'thumbsup' })).toBe('already_reacted')
    expect(await refusal(h.client(), 'reactions.add', { channel: GENERAL.id, timestamp: '1730009999.000999', name: 'tada' })).toBe('message_not_found')
    expect(await refusal(h.client(), 'reactions.add', { channel: 'CNOTHEREAAA', timestamp: REPLY, name: 'tada' })).toBe('channel_not_found')
    expect(effects()).toEqual([])
  })
})

describe('reactions.remove', () => {
  it('removes the agent’s own; then again → no_reaction', async () => {
    expect((await h.client().reactions.remove({ channel: GENERAL.id, timestamp: ROOT, name: '+1' })).ok).toBe(true)
    expect(effects()).toEqual([{ op: 'unreact', conversation: GENERAL.id, ts: ROOT, emoji: '👍' }])
    expect(await refusal(h.client(), 'reactions.remove', { channel: GENERAL.id, timestamp: ROOT, name: 'thumbsup' })).toBe('no_reaction')
  })

  it('a reaction that does not exist → no_reaction; unknown name → invalid_name', async () => {
    expect(await refusal(h.client(), 'reactions.remove', { channel: GENERAL.id, timestamp: REPLY, name: 'tada' })).toBe('no_reaction')
    expect(await refusal(h.client(), 'reactions.remove', { channel: GENERAL.id, timestamp: REPLY, name: 'nope_nope' })).toBe('invalid_name')
    expect(effects()).toEqual([])
  })
})
