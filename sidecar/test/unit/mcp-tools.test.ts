import { describe, it, expect, afterEach } from 'vitest'
import { WriteError } from '../../src/core/write'
import { ALICE, BOB, GENERAL, ME, SECRET, message } from '../support/slack-world'
import { callTool, idShapeLeaks, startMcp, type Era, type McpHarness, type ToolAnswer } from '../support/mcp-world'

// The MCP tools (S-g1, PLANO-AGENTES §0.3.13 item 4) through the real client: the happy path of each, the
// facades' errors as `isError` with the native code, and the edge scan before serialization.

let h: McpHarness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

const ok = (a: ToolAnswer): Record<string, unknown> => {
  expect(a.isError).not.toBe(true)
  // The text is the JSON of the structured value, no more, no less.
  expect(JSON.parse(a.content[0]?.text ?? 'null')).toEqual(a.structuredContent)
  expect(idShapeLeaks(a.structuredContent)).toEqual([])
  return a.structuredContent as Record<string, unknown>
}
const refused = (a: ToolAnswer): string => {
  expect(a.isError).toBe(true)
  return a.content[0]?.text ?? ''
}
const leakLines = (logs: Array<Record<string, unknown>>, where: string): unknown[] => logs.filter((l) => l.evt === 'leak-blocked' && l.where === where)

describe.each<Era>(['legacy', 'modern'])('MCP tools (%s era)', (era) => {
  it('list_conversations and list_members: the native listings, paged by cursor', async () => {
    h = await startMcp()
    const c = await h.client(era)
    const first = ok(await callTool(c, 'list_conversations', { limit: 2 }))
    expect((first.conversations as Array<{ id: string }>).map((x) => x.id)).toEqual([GENERAL.id, SECRET.id])
    const rest = ok(await callTool(c, 'list_conversations', { cursor: first.next }))
    expect((rest.conversations as unknown[]).length).toBe(1)
    const members = ok(await callTool(c, 'list_members', { conversation: GENERAL.id }))
    expect((members.people as Array<{ id: string }>).map((p) => p.id)).toEqual([ME.id, ALICE.id, BOB.id])
  })

  it('read_messages: newest first; `after` is exclusive; `thread` reads the replies', async () => {
    h = await startMcp()
    const c = await h.client(era)
    const all = ok(await callTool(c, 'read_messages', { conversation: GENERAL.id }))
    expect((all.messages as Array<{ id: string }>).map((m) => m.id)).toEqual(['1730000200.000200', '1730000100.000100'])
    const after = ok(await callTool(c, 'read_messages', { conversation: GENERAL.id, after: '1730000100.000100' }))
    expect((after.messages as Array<{ id: string }>).map((m) => m.id)).toEqual(['1730000200.000200'])
    const thread = ok(await callTool(c, 'read_messages', { conversation: GENERAL.id, thread: '1730000100.000100' }))
    expect((thread.messages as Array<{ id: string }>).map((m) => m.id)).toEqual(['1730000300.000300'])
  })

  it('send_message: posts (thread, mentions) and answers the message', async () => {
    h = await startMcp()
    const c = await h.client(era)
    const m = ok(await callTool(c, 'send_message', { conversation: GENERAL.id, text: 'pronto', thread: '1730000100.000100', mentions: [ALICE.id] }))
    expect(m).toMatchObject({ conversation: GENERAL.id, author: ME.id, text: 'pronto', thread: '1730000100.000100', mentions: [ALICE.id] })
    expect(h.world.calls).toEqual([{ op: 'post', conversation: GENERAL.id, text: 'pronto', thread: '1730000100.000100', mentions: [ALICE.id] }])
  })

  it('send_message renders Markdown by default (S-i); markdown: false sends the text literally', async () => {
    h = await startMcp()
    const c = await h.client(era)
    ok(await callTool(c, 'send_message', { conversation: GENERAL.id, text: '## Feito\n\n- **um**' }))
    ok(await callTool(c, 'send_message', { conversation: GENERAL.id, text: '## Feito', markdown: false }))
    ok(await callTool(c, 'send_message', { conversation: GENERAL.id, text: 'sem formatação' }))
    expect(h.world.calls).toEqual([
      {
        op: 'post',
        conversation: GENERAL.id,
        text: '## Feito\n\n- **um**',
        rich: [
          { t: 'p', children: [{ t: 'strong', children: [{ t: 'text', text: 'Feito' }] }] },
          { t: 'ul', items: [[{ t: 'p', children: [{ t: 'strong', children: [{ t: 'text', text: 'um' }] }] }]] },
        ],
      },
      { op: 'post', conversation: GENERAL.id, text: '## Feito' },
      { op: 'post', conversation: GENERAL.id, text: 'sem formatação' },
    ])
  })

  it('react: idempotent, `changed` says whether it did anything; a :name: is refused', async () => {
    h = await startMcp()
    const c = await h.client(era)
    expect(ok(await callTool(c, 'react', { conversation: GENERAL.id, message: '1730000200.000200', emoji: '🎉' }))).toEqual({ changed: true })
    expect(ok(await callTool(c, 'react', { conversation: GENERAL.id, message: '1730000200.000200', emoji: '🎉' }))).toEqual({ changed: false })
    expect(refused(await callTool(c, 'react', { conversation: GENERAL.id, message: '1730000200.000200', emoji: ':tada:' }))).toBe('invalid_argument')
    expect(h.world.calls.filter((x) => x.op === 'react')).toHaveLength(1)
  })

  it('get_person: the native person', async () => {
    h = await startMcp()
    expect(ok(await callTool(await h.client(era), 'get_person', { id: ALICE.id }))).toEqual(ALICE)
  })
})

describe('MCP tools — the facades’ errors', () => {
  it('each read error → isError with the native code', async () => {
    h = await startMcp()
    const c = await h.client()
    expect(refused(await callTool(c, 'list_members', { conversation: 'CNOPEAAAAAA' }))).toBe('conversation_not_found')
    expect(refused(await callTool(c, 'list_conversations', { cursor: 'cur_unknown' }))).toBe('invalid_cursor')
    expect(refused(await callTool(c, 'read_messages', { conversation: GENERAL.id, thread: '9.000000' }))).toBe('message_not_found')
    expect(refused(await callTool(c, 'get_person', { id: 'UNOPEAAAAAA' }))).toBe('user_not_found')
    expect(refused(await callTool(c, 'react', { conversation: GENERAL.id, message: '9.000000', emoji: '👍' }))).toBe('message_not_found')
  })

  it('rate_limited carries retryAfterMs; nothing was posted', async () => {
    h = await startMcp()
    h.world.failNext.push(new WriteError('rate_limited', 1200))
    const a = await callTool(await h.client(), 'send_message', { conversation: GENERAL.id, text: 'oi' })
    expect(refused(a)).toBe('rate_limited')
    expect(a.structuredContent).toEqual({ code: 'rate_limited', retryAfterMs: 1200 })
    expect(h.world.calls).toEqual([])
  })

  it('a write error → its code (not_member, revoked)', async () => {
    h = await startMcp()
    const c = await h.client()
    h.world.failNext.push(new WriteError('not_member'))
    expect(refused(await callTool(c, 'send_message', { conversation: GENERAL.id, text: 'oi' }))).toBe('not_member')
    h.world.failNext.push(new WriteError('revoked'))
    expect(refused(await callTool(c, 'react', { conversation: GENERAL.id, message: '1730000200.000200', emoji: '👍' }))).toBe('revoked')
  })

  it('an empty text → invalid_argument; over 32 KiB → payload_too_large; nothing posted', async () => {
    h = await startMcp()
    const c = await h.client()
    expect(refused(await callTool(c, 'send_message', { conversation: GENERAL.id, text: '   ' }))).toBe('invalid_argument')
    expect(refused(await callTool(c, 'send_message', { conversation: GENERAL.id, text: 'x'.repeat(32 * 1024 + 1) }))).toBe('payload_too_large')
    expect(h.world.calls).toEqual([])
  })

  it('a crash → internal and one mcp-error line with the name only', async () => {
    h = await startMcp()
    h.world.read.person = () => {
      throw new Error('boom @alice:server.example')
    }
    expect(refused(await callTool(await h.client(), 'get_person', { id: ALICE.id }))).toBe('internal')
    expect(h.logs).toContainEqual({ evt: 'mcp-error', name: 'Error' })
    expect(JSON.stringify(h.logs)).not.toContain('@alice')
  })

  it('a schema violation is the SDK’s refusal, before any facade call', async () => {
    h = await startMcp()
    const a = await callTool(await h.client(), 'list_conversations', { limit: 5000 })
    expect(a.isError).toBe(true)
    expect(h.world.calls).toEqual([])
  })
})

describe('MCP tools — the edge scan (before serialization)', () => {
  it('read_messages: an id in a message text → internal, leak-blocked with where mcp:read_messages', async () => {
    h = await startMcp()
    h.world.messages.get(GENERAL.id)?.unshift(message({ id: '1730000400.000400', text: 'fala com @bob:server.example' }))
    expect(refused(await callTool(await h.client(), 'read_messages', { conversation: GENERAL.id }))).toBe('internal')
    expect(leakLines(h.logs, 'mcp:read_messages')).toHaveLength(1)
    expect(JSON.stringify(h.logs)).not.toContain('@bob')
  })

  it('a protocol word in a structural field (a conversation name) → internal', async () => {
    h = await startMcp()
    h.world.read.conversations = () => ({ conversations: [{ ...GENERAL, name: '!abcdef:server.example' }] })
    expect(refused(await callTool(await h.client(), 'list_conversations'))).toBe('internal')
    expect(leakLines(h.logs, 'mcp:list_conversations').length).toBeGreaterThan(0)
  })

  it('list_members and get_person scan too', async () => {
    h = await startMcp()
    h.world.read.person = () => ({ id: ALICE.id, name: '@alice:server.example', kind: 'member' })
    h.world.read.members = () => ({ people: [{ id: ALICE.id, name: '@alice:server.example', kind: 'member' }] })
    const c = await h.client()
    expect(refused(await callTool(c, 'get_person', { id: ALICE.id }))).toBe('internal')
    expect(refused(await callTool(c, 'list_members', { conversation: GENERAL.id }))).toBe('internal')
    expect(leakLines(h.logs, 'mcp:get_person').length).toBeGreaterThan(0)
    expect(leakLines(h.logs, 'mcp:list_members').length).toBeGreaterThan(0)
  })

  it('send_message: an id in the text is refused BEFORE the send (preflight)', async () => {
    h = await startMcp()
    expect(refused(await callTool(await h.client(), 'send_message', { conversation: GENERAL.id, text: 'oi @bob:server.example' }))).toBe('internal')
    expect(h.world.calls).toEqual([])
    expect(leakLines(h.logs, 'mcp:send_message')).toHaveLength(1)
  })

  it('send_message: an answer the edge withholds after the send → internal (the reply scan)', async () => {
    h = await startMcp()
    const write = h.world.write
    const post = write.post.bind(write)
    write.post = async (conv, req) => ({ ...(await post(conv, req)), author: '@agent:server.example' })
    expect(refused(await callTool(await h.client(), 'send_message', { conversation: GENERAL.id, text: 'oi' }))).toBe('internal')
    expect(leakLines(h.logs, 'mcp:send_message').length).toBeGreaterThan(0)
  })

  it('a person writing protocol words in a message is not a leak (content gets only the id shapes)', async () => {
    h = await startMcp()
    h.world.messages.get(GENERAL.id)?.unshift(message({ id: '1730000400.000400', text: 'pode verificar o cofre e a federation?' }))
    ok(await callTool(await h.client(), 'read_messages', { conversation: GENERAL.id }))
  })
})
