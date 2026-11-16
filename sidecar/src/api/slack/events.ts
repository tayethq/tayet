// The bus events as Slack events (ADR-087 dec. 5; PLANO-AGENTES §0.3.12, S-f2; §0.3.17, A3-4). The Slack layer
// takes the EventBus's entries — never the read facade's: the native edge scan of each event already ran
// once before `publish` (api/server.ts), for every transport. The layer is a CONSUMER of the bus
// (`EventBus.open`) only while a socket is open (slack/router.ts): it feeds `push` with the unheard first,
// then every publish. With the clicks over HTTP (`--slack-actions-url`) it is a consumer from the start, but
// pushes only the `approval.answered` while no socket is open. Each mapped event goes to every open socket as an `events_api` envelope
// (slack/socket.ts, slack/envelopes.ts), each envelope through the Slack edge.
//
//   message.received → `message` (channel, channel_type, user, text in mrkdwn, ts, thread_ts, files, event_ts)
//   message.edited   → `message` + `subtype: 'message_changed'`, `message` (the new one), `previous_message: { ts }`
//   message.removed  → `message` + `subtype: 'message_deleted'`, `deleted_ts`
//   mention          → `app_mention` (the core publishes it right after its message.received: the order on
//                      the wire is `message` → `app_mention`)
//   a message with `command` (A4-3, PLANO-AGENTES §0.3.25 item 4: a person's `/` command to this agent, with a
//                      declared name) → NOT an `events_api` event: its message.received and message.edited (the
//                      late decryption) are not sent, and its `mention` becomes a `slash_commands` envelope
//                      (slack/commands.ts). The history still shows it as text.
//   approval.answered → NOT an `events_api` event: a `block_actions` in an `interactive` envelope
//                      (slack/interactive.ts), when the layer has the approval facade.
// Every other bus event has no Slack counterpart in this cut and is not sent.
//
// The agent's own messages go out with its `U…` as `user` (the `user_id` of auth.test: Bolt's ignoreSelf
// drops them) and its `B…` as `bot_id`. The payload: `token: ''`, `team_id` (`T…`), `api_app_id` (`B…`),
// `type: 'event_callback'`, `event_id` (`Ev` + hash of the bus id), `event_time` (seconds), `authorizations`.
import type { BusEntry } from '../bus'
import type { ApiEvent, ApiMe, ApiMessage } from '../contract'
import { slackEventToken } from '../ids'
import type { ReadFacade } from '../../core/read'
import type { SlackChannelType, SlackEvent, SlackEventCallback, SlackMessageEvent } from './contract'
import { nameOf } from './emoji'
import { richToMrkdwn } from './mrkdwn'
import { slackMessage, tsOfMs, type MessageView } from './translate'

type Log = (line: Record<string, unknown>) => void

const CHANNEL_TYPE = { public: 'channel', private: 'group', dm: 'im', group: 'mpim' } as const

export interface SlackEventsOptions {
  read: ReadFacade
  me: () => Promise<ApiMe>
  log: Log
  // The listener's base URL: the files' url_private (S-f3). Absent → the files carry none.
  baseUrl?: () => string | null
  // One envelope to every open socket.
  broadcast: (type: 'events_api', payload: Record<string, unknown>) => void
  // The approval card's click (slack/interactive.ts); absent → `approval.answered` is not sent.
  answered?: (event: Extract<ApiEvent, { type: 'approval.answered' }>, me: ApiMe, bot: string, view: MessageView) => Promise<void>
  // A person's `/` command (slack/commands.ts); absent → the message goes as `message` + `app_mention`.
  command?: (event: Extract<ApiEvent, { type: 'mention' }>, me: ApiMe, bot: string) => void
}

// The message of a bus event, when it carries a command to this agent (§0.3.25 item 4).
const commandOf = (e: ApiEvent): boolean =>
  (e.type === 'message.received' || e.type === 'message.edited' || e.type === 'mention') && e.message.command !== undefined

// What the layer feeds while it is a consumer of the bus.
export interface SlackEvents {
  push(entry: BusEntry): void
  stop(): void
}

function channelType(read: ReadFacade, id: string): SlackChannelType {
  try {
    return CHANNEL_TYPE[read.conversation(id).kind]
  } catch {
    return id.startsWith('D') ? 'im' : 'channel'
  }
}

// The Slack event(s) of one bus entry; [] when it has none.
export function slackEventsOf(entry: BusEntry, me: ApiMe, bot: string, view: MessageView, read: ReadFacade): SlackEvent[] {
  const e = entry.event
  const at = tsOfMs(entry.at)
  const newMessage = (conversation: string, m: ApiMessage): SlackMessageEvent => {
    const s = slackMessage(m, view)
    return {
      type: 'message',
      channel: conversation,
      channel_type: channelType(read, conversation),
      user: s.user,
      text: s.text,
      ts: s.ts,
      ...(m.thread !== undefined && { thread_ts: m.thread }),
      ...(s.files !== undefined && { files: s.files }),
      ...(s.subtype !== undefined && { subtype: s.subtype }),
      ...(m.author === me.id && { bot_id: bot }),
      event_ts: s.ts,
    }
  }
  switch (e.type) {
    case 'message.received':
      return [newMessage(e.conversation, e.message)]
    case 'message.edited':
      return [
        {
          type: 'message',
          subtype: 'message_changed',
          channel: e.conversation,
          channel_type: channelType(read, e.conversation),
          message: slackMessage(e.message, view),
          previous_message: { ts: e.message.id },
          ts: at,
          event_ts: at,
        },
      ]
    case 'message.removed':
      return [{ type: 'message', subtype: 'message_deleted', channel: e.conversation, channel_type: channelType(read, e.conversation), deleted_ts: e.id, ts: at, event_ts: at }]
    case 'mention': {
      const m = e.message
      return [
        {
          type: 'app_mention',
          channel: e.conversation,
          user: m.author,
          text: view.text(m),
          ts: m.id,
          ...(m.thread !== undefined && { thread_ts: m.thread }),
          event_ts: m.id,
        },
      ]
    }
    // approval.answered → `block_actions` (slack/interactive.ts), not an events_api event.
    default:
      return []
  }
}

// The layer's handler of bus entries; the entries are mapped one after the other, in the order pushed.
export function createSlackEvents(opts: SlackEventsOptions): SlackEvents {
  const { read, log } = opts
  const person = (id: string): string | undefined => {
    try {
      return read.person(id).name
    } catch {
      return undefined
    }
  }
  let chain = Promise.resolve()
  let stopped = false
  const handle = async (entry: BusEntry): Promise<void> => {
    if (stopped) return
    const me = await opts.me()
    const bot = read.bot()
    const view: MessageView = { me: me.id, text: (m) => richToMrkdwn(m.text, m.rich, m.mentions ?? [], { person }), reaction: nameOf, base: opts.baseUrl?.() ?? null }
    if (entry.event.type === 'approval.answered') {
      if (opts.answered !== undefined) await opts.answered(entry.event, me, bot, view)
      return
    }
    if (opts.command !== undefined && commandOf(entry.event)) {
      if (entry.event.type === 'mention') opts.command(entry.event, me, bot)
      return
    }
    for (const event of slackEventsOf(entry, me, bot, view, read)) {
      if (stopped) return
      const payload: SlackEventCallback = {
        token: '',
        team_id: me.workspace,
        api_app_id: bot,
        event,
        type: 'event_callback',
        event_id: slackEventToken(entry.id),
        event_time: Math.floor(entry.at / 1000),
        authorizations: [{ team_id: me.workspace, user_id: me.id, is_bot: true }],
      }
      opts.broadcast('events_api', payload as unknown as Record<string, unknown>)
    }
  }
  return {
    push(entry) {
      chain = chain
        .then(() => handle(entry))
        .catch((err: unknown) => {
          // Never the message: it may carry a protocol URL.
          log({ evt: 'api-error', where: 'slack events', name: err instanceof Error ? err.name : typeof err })
        })
    },
    stop() {
      stopped = true
    },
  }
}
