import { describe, expect, it } from 'vitest'
import { authorOf, buildPayload, decide, isAgentSender, MAX_PAYLOAD_BYTES, serialize, type Notification } from '../../src/filter.ts'

const msg = (extra: Partial<Notification> = {}): Notification => ({
  event_id: '$e',
  room_id: '!r:example.org',
  type: 'm.room.message',
  sender_display_name: 'Ana',
  content: { msgtype: 'm.text', body: 'hi' },
  ...extra,
})
const invite = (content: Record<string, unknown>, extra: Partial<Notification> = {}): Notification =>
  msg({ type: 'm.room.member', user_is_target: true, content: { membership: 'invite', ...content }, ...extra })

describe('the filter, one row per case', () => {
  const rows: Array<[string, Notification, Record<string, unknown>, ReturnType<typeof decide>]> = [
    ['no event_id (a read elsewhere)', { room_id: '!r', devices: [] }, {}, undefined],
    ['no event_id, even marked', { room_id: '!r' }, { 'io.tayet.push': 'direct' }, undefined],
    ['direct invite', invite({ is_direct: true }), {}, { kind: 'direct', invite: true }],
    ['direct invite with a room name', invite({ is_direct: true }, { room_name: 'X' }), {}, { kind: 'direct', invite: true }],
    ['invite without is_direct nor room name', invite({}), {}, { kind: 'group', invite: true }],
    ['invite with a room name (added to a channel)', invite({}, { room_name: 'Sales' }), {}, undefined],
    ['invite where the person is not the target', invite({ is_direct: true }, { user_is_target: false }), {}, undefined],
    ['other membership (join)', msg({ type: 'm.room.member', user_is_target: true, content: { membership: 'join' } }), {}, undefined],
    ['membership event even with the mark', msg({ type: 'm.room.member', content: { membership: 'leave' } }), { 'io.tayet.push': 'direct' }, undefined],
    ['mark direct', msg(), { 'io.tayet.push': 'direct' }, { kind: 'direct', invite: false }],
    ['mark group', msg(), { 'io.tayet.push': 'group' }, { kind: 'group', invite: false }],
    ['mark wins over highlight', msg(), { 'io.tayet.push': 'group', highlight: true }, { kind: 'group', invite: false }],
    ['mark with another value', msg(), { 'io.tayet.push': true }, undefined],
    ['highlight', msg(), { highlight: true }, { kind: 'channel', invite: false }],
    ['highlight false', msg(), { highlight: false }, undefined],
    ['plain message, default tweaks', msg(), { sound: 'default' }, undefined],
  ]
  for (const [name, n, tweaks, want] of rows) {
    it(name, () => expect(decide(n, { tweaks })).toEqual(want))
  }
})

describe('the payload', () => {
  it('direct: author, ids, no body', () => {
    expect(buildPayload(msg(), 'direct', false)).toEqual({
      v: 1, kind: 'direct', invite: false, conversation: '!r:example.org', message: '$e', author: 'Ana',
    })
  })

  it('author is empty when the display name is missing; nothing else leaks', () => {
    const p = buildPayload(msg({ sender_display_name: undefined, room_name: 'G' }), 'group', false)
    expect(p.author).toBe('')
    expect(JSON.stringify(p)).not.toContain('G')
    expect(p.channelName).toBeUndefined()
  })

  it('channel: name and text body cut at 300 characters', () => {
    const p = buildPayload(msg({ room_name: 'Sales', content: { msgtype: 'm.notice', body: 'é'.repeat(400) } }), 'channel', false)
    expect(p.channelName).toBe('Sales')
    expect(p.body).toEqual({ type: 'text', text: 'é'.repeat(300) })
  })

  it('the cut never splits a code point', () => {
    const p = buildPayload(msg({ content: { msgtype: 'm.text', body: '😀'.repeat(301) } }), 'channel', false)
    expect(p.body?.text).toBe('😀'.repeat(300))
  })

  it('thread root from m.relates_to', () => {
    const p = buildPayload(msg({ content: { 'm.relates_to': { rel_type: 'm.thread', event_id: '$root' }, ciphertext: 'x' } }), 'group', false)
    expect(p.thread).toBe('$root')
    const q = buildPayload(msg({ content: { 'm.relates_to': { rel_type: 'm.annotation', event_id: '$x' } } }), 'channel', false)
    expect(q.thread).toBeUndefined()
  })

  it('body types', () => {
    const type = (content: Record<string, unknown>): unknown => buildPayload(msg({ content }), 'channel', false).body?.type
    expect(type({ msgtype: 'm.emote', body: 'x' })).toBe('text')
    expect(type({ msgtype: 'm.image', body: 'a.png' })).toBe('image')
    expect(type({ msgtype: 'm.file' })).toBe('file')
    expect(type({ msgtype: 'm.audio' })).toBe('file')
    expect(type({ msgtype: 'm.video' })).toBe('file')
    expect(type({ msgtype: 'm.location' })).toBe('other')
    expect(type({ msgtype: 'm.text', body: 'ok?', 'io.tayet.approval': { id: 1 } })).toBe('approval')
  })

  it('encrypted content in a channel has no body', () => {
    const p = buildPayload(msg({ content: { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: 'abc' } }), 'channel', false)
    expect(p.body).toBeUndefined()
    expect(JSON.stringify(p)).not.toContain('abc')
  })

  it('author: a real display name travels, trimmed; an account name never does', () => {
    const sender = '@ana.souza:example.org'
    expect(buildPayload(msg({ sender, sender_display_name: '  Ana Souza ' }), 'direct', false).author).toBe('Ana Souza')
    expect(buildPayload(msg({ sender, sender_display_name: 'ana.souza' }), 'direct', false).author).toBe('')
    expect(buildPayload(msg({ sender, sender_display_name: ' ana.souza ' }), 'group', false).author).toBe('')
    expect(buildPayload(msg({ sender, sender_display_name: '@ana.souza:example.org' }), 'channel', false).author).toBe('')
    expect(buildPayload(msg({ sender, sender_display_name: undefined }), 'direct', false).author).toBe('')
    expect(buildPayload(msg({ sender, sender_display_name: '' }), 'direct', false).author).toBe('')
    const agent = buildPayload(msg({ sender: '@a-abcdefgh2345:example.org', sender_display_name: 'a-abcdefgh2345' }), 'direct', false)
    expect(agent.author).toBe('')
    expect(JSON.stringify(agent)).not.toContain('a-abcdefgh2345')
  })

  it('authorOf: a name that only resembles the account is kept; without a sender, the name as given', () => {
    expect(authorOf({ sender: '@ana:example.org', sender_display_name: 'Ana' })).toBe('Ana')
    expect(authorOf({ sender: '@ana:example.org', sender_display_name: 'ana:example.org' })).toBe('ana:example.org')
    expect(authorOf({ sender_display_name: 'Ana' })).toBe('Ana')
    expect(authorOf({ sender: '@ana:example.org', sender_display_name: 42 })).toBe('')
  })

  it('agent: true only for an agent sender, and the sender never travels', () => {
    const agent = buildPayload(msg({ sender: '@a-abcdefgh2345:example.org' }), 'direct', false)
    expect(agent.agent).toBe(true)
    expect(JSON.stringify(agent)).not.toContain('a-abcdefgh2345')
    const person = buildPayload(msg({ sender: '@ana:example.org' }), 'channel', false)
    expect(person.agent).toBeUndefined()
    expect('agent' in JSON.parse(JSON.stringify(person))).toBe(false)
    expect(JSON.stringify(person)).not.toContain('@ana')
    expect(buildPayload(invite({ is_direct: true }, { sender: '@a-abcdefgh2345:x' }), 'direct', true).agent).toBe(true)
  })

  it('the agent test is the client\'s: a- and 12 base32 characters in the local part', () => {
    expect(isAgentSender('@a-abcdefgh2345:x')).toBe(true)
    expect(isAgentSender('@a-abcdefgh234:x')).toBe(false)
    expect(isAgentSender('@a-abcdefgh23456:x')).toBe(false)
    expect(isAgentSender('@a-ABCDEFGH2345:x')).toBe(false)
    expect(isAgentSender('@a-abcdefgh2341:x')).toBe(false)
    expect(isAgentSender('@b-abcdefgh2345:x')).toBe(false)
    expect(isAgentSender('a-abcdefgh2345')).toBe(false)
    expect(isAgentSender('@a-abcdefgh2345')).toBe(false)
    expect(isAgentSender(undefined)).toBe(false)
    expect(isAgentSender(42)).toBe(false)
  })

  it('invite payloads carry no body', () => {
    expect(buildPayload(invite({ is_direct: true }), 'direct', true).body).toBeUndefined()
  })

  it('fits 3000 bytes by cutting the text', () => {
    const p = buildPayload(msg({ room_name: 'r'.repeat(2600), content: { msgtype: 'm.text', body: '€'.repeat(300) } }), 'channel', false)
    const out = serialize(p)!
    expect(out.length).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES)
    const back = JSON.parse(out.toString()) as { body: { text: string } }
    expect(back.body.text.length).toBeLessThan(300)
    expect(back.body.text.length).toBeGreaterThan(0)
    expect(Buffer.from(JSON.stringify({ ...p, body: { ...p.body, text: back.body.text + '€' } })).length).toBeGreaterThan(MAX_PAYLOAD_BYTES)
  })

  it('gives up when even an empty text does not fit', () => {
    expect(serialize(buildPayload(msg({ sender_display_name: 'a'.repeat(4000) }), 'direct', false))).toBeUndefined()
  })
})
