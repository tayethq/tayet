import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanSlack } from '../../src/api/slack/edge'
import { GENERAL, call, idLeaks, startSlack, type SlackHarness } from '../support/slack-world'

// The Slack edge (PLANO-AGENTES §0.3.12 item 2) over every answer that carries user text (§8.19 item 18):
// the text a person or the agent wrote is content — id shapes only — wherever the Slack shape puts it
// (a message object's `text`, the top-level `text` of chat.update, the `name`/`title` of files). Prose
// with the deny words goes through every text-bearing method; a structural field does not get the same pass.

// One sentence per word of the adjudicated table: `verificar` is what the `verify` pattern blocks in a
// structural field; `room`, `event`, `device` and `server` are the stems of denied keys (`room_id`,
// `event_ids`, `device_key`, `homeserver`), plain words in a text.
const PROSE = ['vou verificar o backup amanhã', 'a room nova do time', 'o event de ontem foi bom', 'troquei de device hoje', 'o server do cliente caiu']

let h: SlackHarness
let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'slack-edge-'))
  h = await startSlack({ uploadsDir: dir })
})
afterEach(async () => {
  await h.close()
  await rm(dir, { recursive: true, force: true })
})

const ok = async (method: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const res = await call(h.client(), method, args)
  expect(res.ok).toBe(true)
  expect(idLeaks(res)).toEqual([])
  return res
}
const section = (text: string) => JSON.stringify([{ type: 'section', text: { type: 'mrkdwn', text } }])
const textsOf = (res: Record<string, unknown>): string[] => (res.messages as Array<{ text: string }>).map((m) => m.text)
const blocked = () => h.logs.filter((l) => l.evt === 'leak-blocked')

describe('Slack edge — prose in every text-bearing answer is content (§8.19 item 18)', () => {
  it.each(PROSE)('in `text`: postMessage, update, history, replies, delete — %s', async (prose) => {
    const posted = await ok('chat.postMessage', { channel: GENERAL.id, text: 'rascunho' })
    expect(posted.message).toMatchObject({ text: 'rascunho' })
    const again = await ok('chat.postMessage', { channel: GENERAL.id, text: prose })
    expect(again.message).toMatchObject({ text: prose })
    // The top-level `text` of chat.update was scanned as structure: the edit went out, the answer failed.
    const updated = await ok('chat.update', { channel: GENERAL.id, ts: posted.ts, text: prose })
    expect(updated).toMatchObject({ text: prose, message: { text: prose } })
    expect(textsOf(await ok('conversations.history', { channel: GENERAL.id, limit: 2 }))).toEqual([prose, prose])
    expect(textsOf(await ok('conversations.replies', { channel: GENERAL.id, ts: posted.ts }))).toEqual([prose])
    // chat.delete carries no text (already right): { channel, ts }.
    const deleted = await ok('chat.delete', { channel: GENERAL.id, ts: again.ts })
    expect(deleted).toMatchObject({ ok: true, channel: GENERAL.id, ts: again.ts })
    expect(deleted).not.toHaveProperty('text')
    expect(blocked()).toEqual([])
  })

  it.each(PROSE)('in flattened `blocks`: postMessage and update — %s', async (prose) => {
    const posted = await ok('chat.postMessage', { channel: GENERAL.id, blocks: section('rascunho') })
    expect(await ok('chat.postMessage', { channel: GENERAL.id, blocks: section(prose) })).toMatchObject({ message: { text: prose } })
    expect(await ok('chat.update', { channel: GENERAL.id, ts: posted.ts, blocks: section(prose) })).toMatchObject({ text: prose, message: { text: prose } })
    expect(blocked()).toEqual([])
  })

  it.each(PROSE)('in `initial_comment` and a file name/title: files.completeUploadExternal, then the read — %s', async (prose) => {
    const res = await h.client().filesUploadV2({ channel_id: GENERAL.id, initial_comment: prose, file: Buffer.from('x'), filename: 'verificar-device.txt', title: prose })
    expect(res.ok).toBe(true)
    expect(idLeaks(res)).toEqual([])
    const files = (res as unknown as { files: Array<{ files: Array<{ name: string; title: string }> }> }).files[0]?.files
    expect(files).toMatchObject([{ name: 'verificar-device.txt', title: prose }])
    const read = await ok('conversations.history', { channel: GENERAL.id, limit: 2 })
    expect(textsOf(read)).toEqual(['', prose])
    expect((read.messages as Array<{ files?: Array<{ name: string }> }>)[0]?.files).toMatchObject([{ name: 'verificar-device.txt' }])
    expect(blocked()).toEqual([])
  })
})

describe('Slack edge — what stays structural', () => {
  const found = (v: unknown): string[] => scanSlack(v).map((l) => `${l.path} ${l.pattern}`)

  it('the content paths still get the id shapes', () => {
    expect(found({ ok: true, text: 'fale com @bob:server.example', message: { type: 'message', ts: '1.000001', text: 'verificar' } })).toEqual(['$.text mxid'])
  })

  it('a structural key outside the allowlist still fails, next to a text-bearing answer', () => {
    expect(found({ ok: true, channel: 'CGENERALAAA', text: 'verificar', room_id: 'x' })).toEqual(['$.room_id contract-vocabulary'])
    expect(found({ ok: true, text: 'ok', message: { type: 'message', ts: '1.000001', text: 'ok', device_key: 'x' } })).toEqual(['$.message.device_key contract-vocabulary'])
  })

  it('a `text` (or a name) outside the content paths is structural: the deny words block there', () => {
    expect(found({ ok: true, topic: { text: 'verificar' } })).toEqual(['$.topic.text verify'])
    expect(found({ ok: true, messages: [{ type: 'other', ts: '1.000001', text: 'verificar' }] })).toEqual(['$.messages[0].text verify'])
    expect(found({ ok: true, name: 'verificar' })).toEqual(['$.name verify'])
  })
})

// A3-4 (ADR-089 addendum): inside a `block_actions` payload, the agent's own button fields are content.
describe('the Slack edge — block_actions (A3-4)', () => {
  const payload = (action: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
    envelope_id: '00000000-0000-0000-0000-000000000000',
    type: 'interactive',
    payload: {
      type: 'block_actions',
      user: { id: 'UALICEAAAAA', username: 'Alice', name: 'Alice', team_id: 'TWORKSPACEA' },
      channel: { id: GENERAL.id, name: 'geral' },
      actions: [{ type: 'button', action_id: 'a', block_id: 'b', text: { type: 'plain_text', text: 'Ok', emoji: true }, action_ts: '1.000000', ...action }],
      ...over,
    },
  })

  it('a deny word in action_id, block_id, value or the label passes (content)', () => {
    expect(scanSlack(payload({ action_id: 'verify', block_id: 'escrow', value: 'vou verificar o backup', text: { type: 'plain_text', text: 'Verificar', emoji: true } }))).toEqual([])
  })

  it('an id shape in any of them blocks', () => {
    const id = '@u-abcdefghijkl:chat.example.com'
    for (const action of [{ action_id: id }, { block_id: id }, { value: `x ${id}` }, { text: { type: 'plain_text', text: id, emoji: true } }]) {
      expect(scanSlack(payload(action)).length).toBeGreaterThan(0)
    }
  })

  it('the rest stays structural: a deny word in a structural field, or the same field outside block_actions, blocks', () => {
    expect(scanSlack(payload({}, { channel: { id: GENERAL.id, name: 'verificar' } })).map((l) => l.pattern)).toContain('verify')
    expect(scanSlack(payload({ type: 'verified-button' })).map((l) => l.pattern)).toContain('verify')
    expect(scanSlack({ type: 'something_else', actions: [{ value: 'verificar' }] }).map((l) => l.pattern)).toContain('verify')
  })
})

// A4-3 (ADR-089 dec. 1, as `message.command.name`/`args` at the native edge): inside the payload of a
// `slash_commands` envelope, what the person wrote — `command` and `text` — is content.
describe('the Slack edge — slash_commands (A4-3)', () => {
  const frame = (over: Record<string, unknown> = {}, type = 'slash_commands') => ({
    envelope_id: '00000000-0000-0000-0000-000000000000',
    type,
    payload: {
      command: '/deploy',
      text: 'produção',
      channel_id: GENERAL.id,
      channel_name: 'geral',
      user_id: 'UALICEAAAAA',
      user_name: 'Alice',
      team_id: 'TWORKSPACEA',
      api_app_id: 'BAGENTAAAAA',
      trigger_id: '0'.repeat(32),
      response_url: `http://127.0.0.1:7878/slack/response/${'a'.repeat(64)}`,
      message_ts: '1732000600.000100',
      thread_ts: '1732000500.000100',
      ...over,
    },
    accepts_response_payload: true,
    retry_attempt: 0,
    retry_reason: '',
  })

  it('the whole payload passes; a deny word in the command or the args passes (content)', () => {
    expect(scanSlack(frame())).toEqual([])
    expect(scanSlack(frame({ command: '/verify', text: 'decrypt the escrow backup' }))).toEqual([])
  })

  it('an id shape in the command or the args blocks', () => {
    const id = '@u-abcdefghijkl:chat.example.com'
    for (const over of [{ command: `/x ${id}` }, { text: `veja ${id}` }, { text: '$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ' }]) {
      expect(scanSlack(frame(over)).length, JSON.stringify(over)).toBeGreaterThan(0)
    }
  })

  it('the rest stays structural: a deny word in another field, or the same fields outside slash_commands, blocks', () => {
    expect(scanSlack(frame({ channel_name: 'verificar' })).map((l) => l.pattern)).toContain('verify')
    expect(scanSlack(frame({ user_name: 'verificar' })).map((l) => l.pattern)).toContain('verify')
    expect(scanSlack(frame({ command: '/verify' }, 'events_api')).map((l) => l.pattern)).toContain('verify')
  })
})
