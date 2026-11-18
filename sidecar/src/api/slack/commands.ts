// A person's `/` command as Slack's `slash_commands` envelope (ADR-093; ADR-087 dec. 6; PLANO-AGENTES §0.3.25,
// A4-3). The core gives a message `command: { name, args }` only for a command to THIS agent with a name in the set
// declared now (core/read.ts); the layer turns the `mention` that carries it into one `slash_commands` envelope to
// every open socket, in place of the `message` and the `app_mention` of that message (slack/events.ts).
//
// - The payload (item 5): `command` ("/name"), `text` (the args), `channel_id`, `channel_name`, `user_id`,
//   `user_name`, `team_id`, `api_app_id`, `trigger_id` (opens one form with views.open, slack/triggers.ts) and `response_url`;
//   two fields Slack does not have: `message_ts` (the command's message) and `thread_ts` (only when the command was
//   sent in a thread).
// - The response (item 6): the payload of the ack and every call to the `response_url` become an ordinary reply in
//   the command's thread — the thread it was sent in, or a new thread under the command's message — by the
//   chat.postMessage path, with one line without content. `response_type` (ephemeral or in_channel) makes no
//   difference; `replace_original` and `delete_original` have no original to apply to and are ignored with a line;
//   a response with no `text` and no `blocks` (an empty ack among them) writes nothing. With several sockets open,
//   only the first ack counts.
// - The `response_url` (item 7): one ticket per command (slack/response.ts), bound to the conversation, the message
//   and the thread of the command.
// Lines never carry the command's name, its args or the response's text.
import type { ApiEvent, ApiMe } from '../contract'
import type { ReadFacade } from '../../core/read'
import type { AckOutcome } from './envelopes'
import type { SlackSlashCommand } from './contract'
import { RESPONSE_PATH } from './interactive'
import type { CommandTarget, ResponseTickets } from './response'
import type { TriggerTable } from './triggers'
import { parseTs } from '../ids'
import type { SlackArgs } from './router'

type Log = (line: Record<string, unknown>) => void
type Mention = Extract<ApiEvent, { type: 'mention' }>

export type ResponseVia = 'ack' | 'response_url'

export interface CommandOptions {
  read: ReadFacade
  log: Log
  tickets: ResponseTickets
  // The trigger_ids (slack/triggers.ts): each command's opens one form, from the command itself.
  triggers: TriggerTable
  baseUrl: () => string | null
  // The native edge on every native value before it is translated (slack/router.ts ctx.native).
  native<T>(value: T, where: string): T
  broadcast: (type: 'slash_commands', payload: Record<string, unknown>) => Array<{ id: string; outcome: Promise<AckOutcome> }>
  // A response written in the command's thread (slack/router.ts: the chat.postMessage path).
  reply(target: CommandTarget, body: Record<string, unknown>, via: ResponseVia): Promise<void>
}

const nameOr = (fn: () => string, fallback = ''): string => {
  try {
    return fn()
  } catch {
    return fallback
  }
}

// The payload of one command (pure but for the reads and the ticket).
export function slashCommandOf(e: Mention, me: ApiMe, bot: string, opts: Pick<CommandOptions, 'read' | 'tickets' | 'triggers' | 'baseUrl' | 'native'>): SlackSlashCommand {
  const m = opts.native(e.message, 'slash_commands')
  const command = m.command
  if (command === undefined) throw new Error('not a command')
  const ticket = opts.tickets.issue({ kind: 'command', conversation: e.conversation, id: m.id, thread: m.thread ?? m.id })
  const channel = nameOr(() => {
    const c = opts.read.conversation(e.conversation)
    return c.kind === 'dm' ? 'directmessage' : c.name
  })
  return {
    command: `/${command.name}`,
    text: command.args,
    channel_id: e.conversation,
    channel_name: channel,
    user_id: m.author,
    user_name: nameOr(() => opts.read.person(m.author).name),
    team_id: me.workspace,
    api_app_id: bot,
    trigger_id: opts.triggers.issue({ kind: 'command', conversation: e.conversation, message: m.id, person: m.author }, parseTs(m.id)?.ms ?? 0),
    response_url: `${opts.baseUrl() ?? ''}${RESPONSE_PATH}${ticket}`,
    message_ts: m.id,
    ...(m.thread !== undefined && { thread_ts: m.thread }),
  }
}

// One command to every open socket; the first ack's response payload, if any, is the reply.
export function dispatchCommand(e: Mention, me: ApiMe, bot: string, opts: CommandOptions): void {
  const payload = slashCommandOf(e, me, bot, opts)
  const target: CommandTarget = { kind: 'command', conversation: e.conversation, id: payload.message_ts, thread: payload.thread_ts ?? payload.message_ts }
  const sent = opts.broadcast('slash_commands', payload as unknown as Record<string, unknown>)
  opts.log({ evt: 'slash-command', sockets: sent.length })
  let answered = false
  for (const { outcome } of sent) {
    void outcome.then(async (o) => {
      if (!o.acked) return
      if (answered) {
        if (o.payload !== undefined) opts.log({ evt: 'ack-payload-ignored', reason: 'acked' })
        return
      }
      answered = true
      if (o.payload === undefined) return
      try {
        await opts.reply(target, o.payload, 'ack')
      } catch (err) {
        opts.log({ evt: 'api-error', where: 'slack command ack', name: err instanceof Error ? err.name : typeof err })
      }
    })
  }
}

const IGNORED_FLAGS = ['replace_original', 'delete_original'] as const
const yes = (v: unknown): boolean => v === true || v === 'true'

// A response body (ack payload or response_url call) → the chat.postMessage arguments of the reply in the command's
// thread; null when it carries nothing to write. The flags with no original are ignored with one line.
export function replyArgsOf(target: CommandTarget, body: Record<string, unknown>, log: Log): SlackArgs | null {
  for (const flag of IGNORED_FLAGS) if (yes(body[flag])) log({ evt: 'slash-response-flag-ignored', flag })
  const empty = (v: unknown): boolean => v === undefined || v === null || v === ''
  if (empty(body.text) && empty(body.blocks)) return null
  const args: SlackArgs = { channel: target.conversation, thread_ts: target.thread }
  for (const k of ['text', 'blocks', 'mrkdwn'] as const) if (!empty(body[k])) args[k] = body[k]
  return args
}
