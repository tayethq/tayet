import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanSlack } from '../../src/api/slack/edge'
import { ALICE, BOB, GENERAL, ME, SECRET, call, idLeaks, message, refusal, startSlack, type SlackHarness } from '../support/slack-world'

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

  it('the rest stays structural: a deny word in a structural field, or the same field outside block_actions, blocks; the channel’s name takes the id shapes only', () => {
    expect(scanSlack(payload({}, { channel: { id: GENERAL.id, name: 'verificar' } }))).toEqual([])
    expect(scanSlack(payload({}, { channel: { id: GENERAL.id, name: 'u-abcdefghij23' } })).map((l) => l.pattern)).toContain('opaque-localpart')
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

  it('the rest stays structural: the same fields outside slash_commands block; the channel’s and the person’s names take the id shapes only', () => {
    expect(scanSlack(frame({ channel_name: 'verificar' }))).toEqual([])
    expect(scanSlack(frame({ channel_name: '@alice:tayet.local' })).map((l) => l.pattern)).toContain('mxid')
    expect(scanSlack(frame({ user_name: 'verificar' }))).toEqual([])
    expect(scanSlack(frame({ user_name: 'a-abcdefghij23' })).map((l) => l.pattern)).toContain('agent-localpart')
    expect(scanSlack(frame({ command: '/verify' }, 'events_api')).map((l) => l.pattern)).toContain('verify')
  })
})

// A user id in content needs a boundary before its `@`: the address of an scp, a git remote, an rsync target
// and host:port are text a person or an agent writes. A structural field keeps the full set.
describe('the Slack edge — an address is not a user id in content', () => {
  const ADDRESSES = [
    'scp dev@build-host:project/test/goldens/home.png .',
    'git clone git@github.com:org/repo.git',
    'rsync -av user@host:dir/ .',
    'ssh root@10.0.0.1:22',
    'ana@vereda.com:8080',
  ]
  const found = (v: unknown): string[] => scanSlack(v).map((l) => `${l.path} ${l.pattern}`)

  it.each(ADDRESSES)('passes in a message text and a file name: %s', (text) => {
    expect(found({ ok: true, text, message: { type: 'message', ts: '1.000001', text } })).toEqual([])
    expect(found({ ok: true, file: { id: 'FA', name: text, title: text } })).toEqual([])
  })

  it.each(ADDRESSES)('still blocks in a structural field: %s', (text) => {
    expect(found({ ok: true, name: text })).toEqual(['$.name mxid'])
    expect(found({ ok: true, topic: { text } })).toEqual(['$.topic.text mxid'])
  })
})

// Names written by people in the Slack shape: what translates a conversation's name and topic, a person's name and
// the agent's own name gets the id shapes and the two internal identifiers (a person's name also the custody
// account's). An id shape there is still `internal_error`.
describe('the Slack edge — names written by people', () => {
  const VERIFICACAO = { ...GENERAL, name: 'Verificação de contas', topic: 'decrypt e escrow' }
  const VERONICA = { ...ALICE, name: 'Verônica (verificação)' }
  const names = (conversation: typeof GENERAL, person: typeof ALICE, me = ME) => {
    h.world.read.conversations = () => ({ conversations: [conversation, SECRET] })
    h.world.read.conversation = (id) => (id === conversation.id ? conversation : SECRET)
    h.world.read.members = () => ({ people: [me, person, BOB] })
    h.world.read.person = (id) => (id === person.id ? person : id === me.id ? me : BOB)
    h.world.read.me = () => Promise.resolve(me)
  }

  it('conversations.list, conversations.info, conversations.open, users.list, users.info and auth.test answer ok with the vocabulary in the names', async () => {
    names(VERIFICACAO, VERONICA, { ...ME, name: 'Verificador de contas' })
    const list = await ok('conversations.list', {})
    expect((list.channels as Array<Record<string, unknown>>)[0]).toMatchObject({ name: 'Verificação de contas', topic: { value: 'decrypt e escrow' } })
    expect(await ok('conversations.info', { channel: GENERAL.id })).toMatchObject({ channel: { name: 'Verificação de contas', topic: { value: 'decrypt e escrow' } } })
    expect(await ok('conversations.open', { channel: GENERAL.id, return_im: true })).toMatchObject({ channel: { name: 'Verificação de contas' } })
    const users = await ok('users.list', {})
    expect((users.members as Array<Record<string, unknown>>).map((u) => u.name)).toContain('Verônica (verificação)')
    expect(await ok('users.info', { user: ALICE.id })).toMatchObject({ user: { name: 'Verônica (verificação)', real_name: 'Verônica (verificação)', profile: { display_name: 'Verônica (verificação)', real_name: 'Verônica (verificação)' } } })
    expect(await ok('auth.test', {})).toMatchObject({ user: 'Verificador de contas' })
    expect(blocked()).toEqual([])
  })

  it('an id shape in a name is still internal_error', async () => {
    names({ ...GENERAL, name: 'u-abcdefghij23' }, VERONICA)
    expect(await refusal(h.client(), 'conversations.list', {})).toBe('internal_error')
    expect(await refusal(h.client(), 'conversations.info', { channel: GENERAL.id })).toBe('internal_error')
    names(GENERAL, { ...ALICE, name: '@alice:tayet.local' })
    expect(await refusal(h.client(), 'users.info', { user: ALICE.id })).toBe('internal_error')
    expect(await refusal(h.client(), 'users.list', {})).toBe('internal_error')
    expect(JSON.stringify(h.logs)).not.toContain('u-abcdefghij23')
  })

  const channel = { id: GENERAL.id, name: 'geral', is_channel: true, is_group: false, is_im: false, is_mpim: false, is_private: false, is_archived: false, is_member: true, created: 0, topic: { value: '', creator: '', last_set: 0 }, purpose: { value: '', creator: '', last_set: 0 }, num_members: 3 }
  const user = { id: ALICE.id, team_id: ME.workspace, name: 'Alice', real_name: 'Alice', deleted: false, is_bot: false, profile: { display_name: 'Alice', real_name: 'Alice' } }
  const found = (v: unknown): string[] => scanSlack(v).map((l) => `${l.path} ${l.pattern}`)

  it('the scan by shape: a channel’s name and topic, a user’s four names, auth.test’s user', () => {
    expect(found({ ok: true, channel: { ...channel, name: 'cofre', topic: { value: 'verificar', creator: '', last_set: 0 } } })).toEqual([])
    expect(found({ ok: true, user: { ...user, name: 'verificar', real_name: 'decrypt', profile: { display_name: 'escrow', real_name: 'olm' } } })).toEqual([])
    expect(found({ ok: true, url: 'https://chat.example.com/', team: ME.workspace, team_id: ME.workspace, user: 'verificar', user_id: ME.id, bot_id: 'BAGENTAAAAA' })).toEqual([])
    expect(found({ ok: true, user: { ...user, profile: { display_name: 'cofre', real_name: 'Alice' } } })).toEqual(['$.user.profile.display_name custody-identity'])
    expect(found({ ok: true, url: 'https://chat.example.com/', team: ME.workspace, team_id: ME.workspace, user: 'cofre', user_id: ME.id, bot_id: 'BAGENTAAAAA' })).toEqual(['$.user custody-identity'])
    expect(found({ ok: true, channels: [{ ...channel, name: '!r:tayet.local' }] })).toEqual(['$.channels[0].name room-id'])
    expect(found({ ok: true, members: [{ ...user, real_name: 'u-abcdefghij23' }] })).toEqual(['$.members[0].real_name opaque-localpart'])
  })

  it('what does not translate those names stays structural: purpose, the other fields, a user object with another shape', () => {
    expect(found({ ok: true, channel: { ...channel, purpose: { value: 'verificar', creator: '', last_set: 0 } } })).toEqual(['$.channel.purpose.value verify'])
    expect(found({ ok: true, user: { ...user, deleted: 'verified' } })).toEqual(['$.user.deleted verify'])
    expect(found({ ok: true, user: { id: ALICE.id, name: 'verificar' } })).toEqual(['$.user.name verify'])
    expect(found({ ok: true, team: 'verificar' })).toEqual(['$.team verify'])
  })

  it('a view_submission’s user: the names take the id shapes only', () => {
    const submission = (u: Record<string, unknown>) => ({ type: 'view_submission', team: { id: ME.workspace, domain: '' }, user: { id: ALICE.id, team_id: ME.workspace, ...u } })
    expect(found(submission({ username: 'verificar', name: 'cofre verificado' }))).toEqual(['$.user.name custody-identity'])
    expect(found(submission({ username: 'Verônica', name: 'Verônica (verificação)' }))).toEqual([])
    expect(found(submission({ username: 'u-abcdefghij23', name: 'x' }))).toEqual(['$.user.username opaque-localpart'])
  })

  it('a block_actions’ user: the names take the id shapes only', () => {
    const click = (u: Record<string, unknown>) => ({ type: 'block_actions', user: { id: ALICE.id, team_id: ME.workspace, ...u }, actions: [] })
    expect(found(click({ username: 'verificar', name: 'Verônica (verificação)' }))).toEqual([])
    expect(found(click({ username: 'Ana', name: '@ana:tayet.local' }))).toEqual(['$.user.name mxid'])
  })
})

// A reaction's name in the Slack shape (`reactions[].name` of a message) is user content: the id shapes only.
describe('the Slack edge — a reaction’s name is content', () => {
  const found = (v: unknown): string[] => scanSlack(v).map((l) => `${l.path} ${l.pattern}`)
  const withReaction = (name: string) => ({ ok: true, messages: [{ type: 'message', user: ALICE.id, text: 'ok', ts: '1.000001', reactions: [{ name, count: 1, users: [] }] }] })

  it('the vocabulary passes; an id shape flags', () => {
    expect(found(withReaction('verificado'))).toEqual([])
    expect(found(withReaction('@alice:tayet.local'))).toEqual(['$.messages[0].reactions[0].name mxid'])
  })

  it('outside a message object, a reaction-like `name` stays structural', () => {
    expect(found({ ok: true, reactions: [{ name: 'verificado', count: 1 }] })).toEqual(['$.reactions[0].name verify'])
  })

  it('conversations.history: a reaction with the vocabulary reads back; one with an id shape withholds only its message', async () => {
    h.world.messages.get(GENERAL.id)?.unshift(
      message({ id: '1730000500.000500', text: 'ok', reactions: [{ emoji: 'verificado', count: 1, mine: false }] }),
      message({ id: '1730000400.000400', text: 'ok', reactions: [{ emoji: '@bob:server.example', count: 1, mine: false }] }),
    )
    const res = await ok('conversations.history', { channel: GENERAL.id, limit: 2 })
    const messages = res.messages as Array<Record<string, unknown>>
    expect(messages[0]).toMatchObject({ ts: '1730000500.000500', text: 'ok', reactions: [{ name: 'verificado', count: 1, users: [] }] })
    expect(messages[1]).toEqual({ type: 'message', user: ALICE.id, text: '', ts: '1730000400.000400' })
    expect(blocked()).toEqual([{ evt: 'leak-blocked', where: 'slack conversations.history', path: '$.messages[1].reactions[0].emoji', pattern: 'mxid' }])
  })

  it('conversations.replies: the withheld reply carries its thread_ts', async () => {
    h.world.messages.get(GENERAL.id)?.unshift(message({ id: '1730000400.000400', author: BOB.id, text: 'e @alice:server.example', thread: '1730000100.000100' }))
    const res = await ok('conversations.replies', { channel: GENERAL.id, ts: '1730000100.000100' })
    expect((res.messages as Array<Record<string, unknown>>).at(-1)).toEqual({ type: 'message', user: BOB.id, text: '', ts: '1730000400.000400', thread_ts: '1730000100.000100' })
  })
})
