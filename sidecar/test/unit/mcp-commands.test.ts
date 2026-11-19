import { describe, it, expect, afterEach, vi } from 'vitest'
import { WriteError } from '../../src/core/write'
import type { CommandsFacade } from '../../src/core/commands'
import { ALICE, GENERAL, message } from '../support/slack-world'
import { callTool, idShapeLeaks, startMcp, type Era, type McpHarness, type ToolAnswer } from '../support/mcp-world'

// The commands tools (A4-2a; ADR-093, Proposto; PLANO-AGENTES §0.3.22 item 9): set_commands and clear_commands
// over a fake facade — the shapes, the native rules and leak-scan before the facade, the facade's errors, and
// no facade.

function fakeCommands(over: Partial<CommandsFacade> = {}) {
  const calls: unknown[] = []
  let set: unknown[] = []
  const commands: CommandsFacade = {
    set: (c) => {
      calls.push(['set', c])
      set = c as unknown[]
      return Promise.resolve({ pending: 3 })
    },
    clear: () => {
      calls.push(['clear'])
      const had = set.length > 0
      set = []
      return Promise.resolve(had ? { pending: 3 } : null)
    },
    get: () => ({ commands: [], pending: 0 }),
    ...over,
  }
  return { commands, calls }
}

let h: McpHarness | undefined
afterEach(async () => {
  await h?.close()
  h = undefined
})

const ok = (a: ToolAnswer): Record<string, unknown> => {
  expect(a.isError).not.toBe(true)
  expect(JSON.parse(a.content[0]?.text ?? 'null')).toEqual(a.structuredContent)
  expect(idShapeLeaks(a.structuredContent)).toEqual([])
  return a.structuredContent as Record<string, unknown>
}
const refused = (a: ToolAnswer): string => {
  expect(a.isError).toBe(true)
  return a.content[0]?.text ?? ''
}

describe.each<Era>(['legacy', 'modern'])('commands tools (%s era)', (era) => {
  it('set_commands: answers { pending } with the normalized set; a denied word passes', async () => {
    const f = fakeCommands()
    h = await startMcp({ commands: f.commands })
    const c = await h.client(era)
    const set = [{ name: 'verify', description: ' Verificar o cofre ', hint: '<ambiente>' }, { name: 'status', description: 'O estado', hint: '' }]
    expect(ok(await callTool(c, 'set_commands', { commands: set }))).toEqual({ pending: 3 })
    expect(f.calls).toEqual([['set', [{ name: 'verify', description: 'Verificar o cofre', hint: '<ambiente>' }, { name: 'status', description: 'O estado' }]]])
  })

  it('clear_commands: `pending: 0` with nothing to clear, the count once a set was declared', async () => {
    const f = fakeCommands()
    h = await startMcp({ commands: f.commands })
    const c = await h.client(era)
    expect(ok(await callTool(c, 'clear_commands', {}))).toEqual({ pending: 0 })
    ok(await callTool(c, 'set_commands', { commands: [{ name: 'ping', description: 'Pong' }] }))
    expect(ok(await callTool(c, 'clear_commands', {}))).toEqual({ pending: 3 })
  })

  it('the rules, the 8 KiB and the leak-scan before the facade; the facade’s refusals keep their codes', async () => {
    const f = fakeCommands()
    h = await startMcp({ commands: f.commands })
    const c = await h.client(era)
    expect(refused(await callTool(c, 'set_commands', { commands: [{ name: 'Bad', description: 'x' }] }))).toBe('invalid_argument')
    expect(refused(await callTool(c, 'set_commands', { commands: [{ name: 'a', description: 'x' }, { name: 'a', description: 'y' }] }))).toBe('invalid_argument')
    expect(refused(await callTool(c, 'set_commands', { commands: [{ name: 'a', description: 'x', color: 'red' }] }))).toBe('invalid_argument')
    const big = Array.from({ length: 25 }, (_, i) => ({ name: `c${i}`.padEnd(32, 'x'), description: 'é'.repeat(100), hint: 'é'.repeat(60) }))
    expect(refused(await callTool(c, 'set_commands', { commands: big }))).toBe('payload_too_large')
    const leak = await callTool(c, 'set_commands', { commands: [{ name: 'a', description: 'com @alice:tayet.local' }] })
    expect(refused(leak)).toBe('content_refused')
    expect(leak.structuredContent).toEqual({ code: 'content_refused', refused: [{ field: 'commands[0].description', pattern: 'user_id' }] })
    expect(h.logs).toContainEqual({ evt: 'leak-blocked', where: 'mcp:set_commands', path: '$.commands[0].description', pattern: 'mxid' })
    expect(f.calls).toEqual([])
    const down = fakeCommands({ set: () => Promise.reject(new WriteError('unavailable')) })
    await h.close()
    h = await startMcp({ commands: down.commands })
    const c2 = await h.client(era)
    expect(refused(await callTool(c2, 'set_commands', { commands: [] }))).toBe('unavailable')
  })

  it('without the facade both answer `unavailable`', async () => {
    h = await startMcp()
    const c = await h.client(era)
    expect(refused(await callTool(c, 'set_commands', { commands: [] }))).toBe('unavailable')
    expect(refused(await callTool(c, 'clear_commands', {}))).toBe('unavailable')
  })
})

// PLANO-AGENTES §0.3.23 item 7 (A4-2b): the reads and wait_for_mention carry the message's `command` as the
// native API does. No new tool.
describe.each<Era>(['legacy', 'modern'])('a message’s command through MCP (%s era)', (era) => {
  const command = { name: 'verify', args: 'o backup\nno cofre' }

  it('wait_for_mention: the mention carries the command', async () => {
    // A fake clock: the wait is armed (subscribed) once its timer exists.
    const timers: unknown[] = []
    h = await startMcp({ setTimer: (fn) => (timers.push(fn), () => {}) })
    const c = await h.client(era)
    const p = callTool(c, 'wait_for_mention', {})
    await vi.waitFor(() => expect(timers.length).toBe(1))
    h.world.emit({ type: 'mention', conversation: GENERAL.id, message: message({ id: '1730000500.000500', author: ALICE.id, text: '/verify o backup\nno cofre', mentionsMe: true, command }) })
    const v = ok(await p) as { mention: { message: { command?: unknown } } }
    expect(v.mention.message.command).toEqual(command)
  })

  it('read_messages: the listed message carries the command; one without it has none', async () => {
    h = await startMcp()
    const list = h.world.messages.get(GENERAL.id) ?? []
    list.unshift(message({ id: '1730000900.000900', author: ALICE.id, text: '/verify o backup\nno cofre', mentionsMe: true, command }))
    h.world.messages.set(GENERAL.id, list)
    const c = await h.client(era)
    const all = ok(await callTool(c, 'read_messages', { conversation: GENERAL.id })) as { messages: Array<{ id: string; command?: unknown }> }
    expect(all.messages.find((m) => m.id === '1730000900.000900')?.command).toEqual(command)
    expect(all.messages.filter((m) => m.command !== undefined)).toHaveLength(1)
  })
})
