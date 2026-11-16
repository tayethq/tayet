// The MCP tools (PLANO-AGENTES §0.3.13 item 4): product names over the core's facades, the same values
// the native API answers (api/contract.ts), in `structuredContent` and as JSON text in `content`.
//
// - Every native value passes the edge scan (api/edge.ts) BEFORE it is serialized; a finding → `isError`
//   with `internal` and a `leak-blocked` line (`where: 'mcp:<tool>'`). The serialized JSON is never what
//   is scanned.
// - A write goes through the native preflight first (edge.ts `scanWriteProbe`): what the edge would
//   withhold after the send is refused before any effect.
// - The facades' errors (ReadError/WriteError) → `isError` with the native code as text; anything else →
//   `internal` and one `mcp-error` line with the error's name only (an SDK message may carry a protocol
//   URL).
import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { parseCompose } from '@tayet/shared'
import { PAGE_MAX, ReadError, type ReadFacade } from '../../core/read'
import { WriteError, type WriteFacade } from '../../core/write'
import { APPROVAL_MAX_OPTIONS } from '../../core/approval-limits'
import { approvalOptionsOf, type ApprovalFacade } from '../../core/approvals'
import { PANEL_TEXT_MAX, type PanelFacade } from '../../core/panels'
import { validateCommands, type CommandsFacade } from '../../core/commands'
import type { ApiApprovalStatus, ApiMessage } from '../contract'
import { logLeaks, scanApprovalProbe, scanCommandsProbe, scanEdge, scanPanelProbe, scanWriteProbe } from '../edge'
import { isEmojiArgument } from '../emoji'
import {
  WAIT_DEFAULT_S,
  WAIT_MAX_S,
  type McpClearCommandsResult,
  type McpClearPanelResult,
  type McpCloseApprovalResult,
  type McpErrorCode,
  type McpSetCommandsResult,
  type McpSetPanelResult,
  type McpToolError,
  type McpWaitForApprovalResult,
  type McpWaitForMentionResult,
} from './contract'
import type { Waits } from './wait'

type Log = (line: Record<string, unknown>) => void

// §0.3.7 item 2: the native POST's text limit (server.ts TEXT_MAX).
const TEXT_MAX = 32 * 1024
const MENTIONS_MAX = 100

export interface ToolDeps {
  read: ReadFacade
  write: WriteFacade
  log: Log
  waits: Waits
  // The approval cards' facade (core/approvals.ts); absent → the three card tools answer `unavailable`.
  approvals?: ApprovalFacade
  // The pinned panel's facade (core/panels.ts); absent → the two panel tools answer `unavailable`.
  panels?: PanelFacade
  // The agent's commands' facade (core/commands.ts); absent → the two command tools answer `unavailable`.
  commands?: CommandsFacade
}

interface ToolResult {
  [k: string]: unknown
  content: Array<{ type: 'text'; text: string }>
  structuredContent?: Record<string, unknown>
  isError?: boolean
}

// A refusal of this layer (an argument), with its native code.
class ToolFail extends Error {
  constructor(readonly code: McpErrorCode) {
    super(code)
    this.name = 'ToolFail'
  }
}

const failed = (code: McpErrorCode, retryAfterMs?: number): ToolResult => {
  const error: McpToolError = { code, ...(retryAfterMs !== undefined && { retryAfterMs: Math.max(retryAfterMs, 0) }) }
  return { isError: true, content: [{ type: 'text', text: code }], structuredContent: { ...error } }
}

// ── Schemas (the descriptions are product words; a test scans them against the deny list) ────────────

const conversation = z.string().min(1).describe('A conversation id (C… or D…), from list_conversations or from a mention.')
const limit = z.number().int().min(1).max(PAGE_MAX).optional().describe(`How many items, 1–${PAGE_MAX} (default 100).`)
const cursor = z.string().min(1).optional().describe('The `next` of the previous page; absent for the first page.')
const ts = (what: string): z.ZodString => z.string().min(1).describe(what)

export const TOOL_SPECS = {
  list_conversations: {
    description: 'The conversations this agent is a member of (channels and direct conversations), a page at a time.',
    inputSchema: z.object({ limit, cursor }),
  },
  list_members: {
    description: 'The people in a conversation, a page at a time.',
    inputSchema: z.object({ conversation, limit, cursor }),
  },
  read_messages: {
    description: 'Messages of a conversation, newest first, a page at a time; with `thread`, the replies of that thread.',
    inputSchema: z.object({
      conversation,
      after: ts('Only messages after this ts (exclusive).').optional(),
      limit,
      thread: ts('The ts of the first message of a thread: read its replies.').optional(),
      cursor,
    }),
  },
  send_message: {
    description: 'Send a text message to a conversation, or a reply in a thread.',
    inputSchema: z.object({
      conversation,
      text: z.string().describe('The text, rendered as Markdown unless markdown is false (at most 32 KiB).'),
      thread: ts('The ts of the first message of a thread: reply in that thread.').optional(),
      mentions: z.array(z.string().min(1)).max(MENTIONS_MAX).optional().describe('People to mention (U… ids), at most 100.'),
      markdown: z.boolean().optional().describe('Render text as Markdown (default true). Set false to send the text literally.'),
    }),
  },
  react: {
    description: 'Add a reaction to a message. Idempotent: `changed` is false when the agent had already reacted with it.',
    inputSchema: z.object({
      conversation,
      message: ts('The ts of the message.'),
      emoji: z.string().describe('The emoji character itself (for example 👍), not a :name:.'),
    }),
  },
  get_person: {
    description: 'A person by id: name and kind (member, guest or agent).',
    inputSchema: z.object({ id: z.string().min(1).describe('A person id (U…).') }),
  },
  wait_for_mention: {
    description:
      `Wait until someone mentions this agent, then answer with the conversation and the message. Waits up to \`timeout_s\` seconds (default ${WAIT_DEFAULT_S}, at most ${WAIT_MAX_S}). ` +
      'Pass the `cursor` of each answer as `after` in the next call so no mention is missed. `timedOut`: nothing came, call again. ' +
      '`resync`: the cursor is too old or from another run — re-read what you need with read_messages, then continue from the new `cursor`.',
    inputSchema: z.object({
      timeout_s: z.number().min(0).optional().describe(`Seconds to wait (default ${WAIT_DEFAULT_S}; more than ${WAIT_MAX_S} is cut to ${WAIT_MAX_S}).`),
      after: z.string().min(1).optional().describe('The `cursor` of the previous answer; absent: only mentions from now on.'),
    }),
  },
  request_approval: {
    description:
      'Ask the people of a conversation to choose one of 1–25 options (an approval card). Answers the card; its `id` (ts) is what wait_for_approval and close_approval take. ' +
      'Only a person (member or guest) can answer, and only the first valid answer counts; the card then closes by itself.',
    inputSchema: z.object({
      conversation,
      text: z.string().describe('The request, rendered as Markdown unless markdown is false (at most 32 KiB).'),
      options: z
        .array(
          z.object({
            id: z.string().describe('The option id: [a-z0-9_-], 1–32 characters, unique in the card. The answer carries it.'),
            label: z.string().describe('The button text, 1–75 characters.'),
            style: z.enum(['primary', 'danger']).optional().describe('primary (at most one) or danger.'),
          }),
        )
        .min(1)
        .max(APPROVAL_MAX_OPTIONS)
        .describe('The options, 1 to 25.'),
      thread: ts('The ts of the first message of a thread: ask in that thread.').optional(),
      mentions: z.array(z.string().min(1)).max(MENTIONS_MAX).optional().describe('People to mention (U… ids), at most 100.'),
      markdown: z.boolean().optional().describe('Render text as Markdown (default true). Set false to send the text literally.'),
    }),
  },
  wait_for_approval: {
    description:
      `Wait until an approval card of this agent is answered or closed. Waits up to \`timeout_s\` seconds (default ${WAIT_DEFAULT_S}, at most ${WAIT_MAX_S}); a card already answered or closed answers at once. ` +
      '`answered`: `answer` carries `option`, `by` (U…) and `at`. `closed`: closed with no answer. `timedOut`: still open, call again.',
    inputSchema: z.object({
      conversation,
      id: ts('The card’s ts (the `id` request_approval answered).'),
      timeout_s: z.number().min(0).optional().describe(`Seconds to wait (default ${WAIT_DEFAULT_S}; more than ${WAIT_MAX_S} is cut to ${WAIT_MAX_S}).`),
    }),
  },
  close_approval: {
    description:
      'Close an approval card of this agent without waiting for an answer (no one can answer after it). Answers the final state: `closed`, or `answered` when a person answered first.',
    inputSchema: z.object({
      conversation,
      id: ts('The card’s ts.'),
      text: z.string().optional().describe('A new text for the request (absent: the request stays). Markdown unless markdown is false.'),
      markdown: z.boolean().optional().describe('Render text as Markdown (default true).'),
    }),
  },
  set_panel: {
    description:
      'Set this agent’s pinned panel in a conversation: a board the agent keeps up to date, shown above the conversation. ' +
      'It notifies no one and adds nothing to the conversation; each call replaces the content. Answers at once; the write goes out within 10 s.',
    inputSchema: z.object({
      conversation,
      text: z.string().describe('The panel’s content, rendered as Markdown unless markdown is false (at most 8 KiB).'),
      title: z.string().optional().describe('A title: plain text, one line, at most 75 characters.'),
      markdown: z.boolean().optional().describe('Render text as Markdown (default true).'),
    }),
  },
  clear_panel: {
    description: 'Clear this agent’s pinned panel in a conversation (it stops showing; set_panel shows it again). Notifies no one; goes out within 10 s.',
    inputSchema: z.object({ conversation }),
  },
  set_commands: {
    description:
      'Declare this agent’s `/` commands: the whole set, offered to the people of every conversation the agent is a member of (and of those it joins later). ' +
      'Each call replaces the set; an empty list clears it. Answers at once with how many conversations are still to update (one every 10 s).',
    inputSchema: z.object({
      commands: z
        .array(
          z.looseObject({
            name: z.string().describe('The name without the slash: lowercase letters, digits, - and _, at most 32, starting with a letter or digit.'),
            description: z.string().describe('What the command does: one line, 1–100 characters.'),
            hint: z.string().optional().describe('The arguments it takes, shown as a hint: one line, at most 60 characters.'),
          }),
        )
        .describe('At most 25 commands, each name once; the whole set at most 8 KiB.'),
    }),
  },
  clear_commands: {
    description: 'Clear this agent’s `/` commands in every conversation (set_commands declares them again). Notifies no one.',
    inputSchema: z.object({}),
  },
} as const

export type ToolName = keyof typeof TOOL_SPECS

export function registerTools(server: McpServer, deps: ToolDeps): void {
  const { read, write, log, waits } = deps
  const boards = (): PanelFacade => {
    if (deps.panels === undefined) throw new ToolFail('unavailable')
    return deps.panels
  }
  const commandSet = (): CommandsFacade => {
    if (deps.commands === undefined) throw new ToolFail('unavailable')
    return deps.commands
  }
  const cards = (): ApprovalFacade => {
    if (deps.approvals === undefined) throw new ToolFail('unavailable')
    return deps.approvals
  }
  // Markdown by default (S-i): the formatted version only when there is formatting.
  const richOf = (text: string, markdown: boolean | undefined) => (markdown === false ? undefined : parseCompose(text).rich)
  const textOk = (text: string): void => {
    if (text.trim() === '') throw new ToolFail('invalid_argument')
    if (Buffer.byteLength(text, 'utf8') > TEXT_MAX) throw new ToolFail('payload_too_large')
  }

  // A native value → the tool's answer, through the edge first.
  const answer = (tool: ToolName, value: object): ToolResult => {
    const leaks = scanEdge(value)
    if (leaks.length > 0) {
      logLeaks(log, `mcp:${tool}`, leaks)
      return failed('internal')
    }
    return { structuredContent: value as Record<string, unknown>, content: [{ type: 'text', text: JSON.stringify(value) }] }
  }

  const run = async (tool: ToolName, fn: () => Promise<object> | object): Promise<ToolResult> => {
    let value: object
    try {
      value = await fn()
    } catch (err) {
      if (err instanceof ToolFail || err instanceof ReadError) return failed(err.code)
      if (err instanceof WriteError) return failed(err.code, err.code === 'rate_limited' ? (err.retryAfterMs ?? 0) : undefined)
      log({ evt: 'mcp-error', name: err instanceof Error ? err.name : typeof err })
      return failed('internal')
    }
    return answer(tool, value)
  }

  const preflight = (tool: ToolName, conv: string, text: string): void => {
    const leaks = scanWriteProbe(conv, text)
    if (leaks.length > 0) {
      logLeaks(log, `mcp:${tool}`, leaks)
      throw new ToolFail('internal')
    }
  }

  server.registerTool('list_conversations', TOOL_SPECS.list_conversations, (a) => run('list_conversations', () => read.conversations({ limit: a.limit, cursor: a.cursor })))

  server.registerTool('list_members', TOOL_SPECS.list_members, (a) => run('list_members', () => read.members(a.conversation, { limit: a.limit, cursor: a.cursor })))

  server.registerTool('read_messages', TOOL_SPECS.read_messages, (a) =>
    run('read_messages', () =>
      read.messages(a.conversation, {
        limit: a.limit,
        cursor: a.cursor,
        thread: a.thread,
        ...(a.after !== undefined && { oldest: a.after, inclusive: false }),
      }),
    ),
  )

  server.registerTool('send_message', TOOL_SPECS.send_message, (a) =>
    run('send_message', () => {
      textOk(a.text)
      preflight('send_message', a.conversation, a.text)
      // S-i (§0.3.15 item 2): default true — whoever speaks MCP is an LLM, and an LLM writes Markdown.
      // The formatted version goes only when there is formatting; the text stays the plain fallback.
      const rich = richOf(a.text, a.markdown)
      return write.post(a.conversation, {
        text: a.text,
        ...(rich !== undefined && { rich }),
        ...(a.thread !== undefined && { thread: a.thread }),
        ...(a.mentions !== undefined && { mentions: a.mentions }),
      })
    }),
  )

  server.registerTool('react', TOOL_SPECS.react, (a) =>
    run('react', async () => {
      if (!isEmojiArgument(a.emoji)) throw new ToolFail('invalid_argument')
      return { changed: await write.react(a.conversation, a.message, a.emoji) }
    }),
  )

  server.registerTool('get_person', TOOL_SPECS.get_person, (a) => run('get_person', () => read.person(a.id)))

  server.registerTool('wait_for_mention', TOOL_SPECS.wait_for_mention, async (a, ctx) => {
    const seconds = Math.min(a.timeout_s ?? WAIT_DEFAULT_S, WAIT_MAX_S)
    const out = await waits.wait(a.after, seconds * 1000, ctx.mcpReq.signal)
    let value: McpWaitForMentionResult
    switch (out.kind) {
      case 'revoked':
        return failed('revoked')
      case 'closed':
        return failed('unavailable')
      case 'mention':
        value = { mention: { conversation: out.conversation, message: out.message }, cursor: out.cursor }
        break
      case 'timedOut':
        value = { timedOut: true, cursor: out.cursor }
        break
      case 'resync':
        value = { resync: true, cursor: out.cursor }
        break
    }
    return answer('wait_for_mention', value)
  })

  // ── Approval cards (A3-3b): the facade of the native routes, the same rules and the same preflight ──

  server.registerTool('request_approval', TOOL_SPECS.request_approval, (a) =>
    run('request_approval', (): Promise<ApiMessage> => {
      const facade = cards()
      textOk(a.text)
      // The native rules (unique ids, the id shape, at most one primary, label length) → invalid_argument.
      const options = approvalOptionsOf(a.options)
      const leaks = scanApprovalProbe(a.conversation, a.text, options)
      if (leaks.length > 0) {
        logLeaks(log, 'mcp:request_approval', leaks)
        throw new ToolFail('internal')
      }
      const rich = richOf(a.text, a.markdown)
      return facade.request(a.conversation, {
        text: a.text,
        options,
        ...(rich !== undefined && { rich }),
        ...(a.thread !== undefined && { thread: a.thread }),
        ...(a.mentions !== undefined && { mentions: a.mentions }),
      })
    }),
  )

  server.registerTool('wait_for_approval', TOOL_SPECS.wait_for_approval, async (a, ctx) => {
    let facade: ApprovalFacade
    try {
      facade = cards()
    } catch (err) {
      return failed((err as ToolFail).code)
    }
    const seconds = Math.min(a.timeout_s ?? WAIT_DEFAULT_S, WAIT_MAX_S)
    return run('wait_for_approval', async (): Promise<McpWaitForApprovalResult> => {
      const out = await waits.approval({ conversation: a.conversation, id: a.id }, () => facade.state(a.conversation, a.id), seconds * 1000, ctx.mcpReq.signal)
      switch (out.kind) {
        case 'revoked':
          throw new ToolFail('revoked')
        case 'closed':
          throw new ToolFail('unavailable')
        case 'timedOut':
          return { conversation: a.conversation, id: a.id, timedOut: true }
        case 'settled':
          return out.status
      }
    })
  })

  server.registerTool('close_approval', TOOL_SPECS.close_approval, (a) =>
    run('close_approval', async (): Promise<McpCloseApprovalResult> => {
      const facade = cards()
      let rich: ReturnType<typeof richOf>
      if (a.text !== undefined) {
        textOk(a.text)
        preflight('close_approval', a.conversation, a.text)
        rich = richOf(a.text, a.markdown)
      }
      const m = await facade.close(a.conversation, a.id, a.text, rich)
      const status: ApiApprovalStatus = { conversation: m.conversation, id: m.id, approval: m.approval ?? { options: [] } }
      return status
    }),
  )

  server.registerTool('set_panel', TOOL_SPECS.set_panel, (a) =>
    run('set_panel', (): Promise<McpSetPanelResult> => {
      const facade = boards()
      if (a.text.trim() === '') throw new ToolFail('invalid_argument')
      if (Buffer.byteLength(a.text, 'utf8') > PANEL_TEXT_MAX) throw new ToolFail('payload_too_large')
      const leaks = scanPanelProbe(a.conversation, a.text, a.title)
      if (leaks.length > 0) {
        logLeaks(log, 'mcp:set_panel', leaks)
        throw new ToolFail('internal')
      }
      const rich = richOf(a.text, a.markdown)
      return facade.set(a.conversation, { text: a.text, ...(rich !== undefined && { rich }), ...(a.title !== undefined && { title: a.title }) })
    }),
  )

  server.registerTool('clear_panel', TOOL_SPECS.clear_panel, (a) =>
    run('clear_panel', async (): Promise<McpClearPanelResult> => {
      const out = await boards().clear(a.conversation)
      return { conversation: out.conversation, pending: out.pending }
    }),
  )

  server.registerTool('set_commands', TOOL_SPECS.set_commands, (a) =>
    run('set_commands', (): Promise<McpSetCommandsResult> => {
      const facade = commandSet()
      // The native rules and leak-scan, before the facade.
      const set = validateCommands(a.commands)
      const leaks = scanCommandsProbe(set)
      if (leaks.length > 0) {
        logLeaks(log, 'mcp:set_commands', leaks)
        throw new ToolFail('internal')
      }
      return facade.set(set)
    }),
  )

  server.registerTool('clear_commands', TOOL_SPECS.clear_commands, () =>
    run('clear_commands', async (): Promise<McpClearCommandsResult> => (await commandSet().clear()) ?? { pending: 0 }),
  )
}
