// The approval card's click as Slack's `block_actions` (ADR-087 dec. 6; PLANO-AGENTES §0.3.16 item 14,
// §0.3.17; A3-4). For each `approval.answered` of the bus, one `interactive` envelope to every open socket
// (slack/socket.ts broadcast: one per connection, each with its own ack), through the Slack edge.
//
// - The payload is Slack's, in the fields Bolt 5.1.0 reads (§8.35): `actions` (an action body; `actions[0]`
//   is the listener's payload: `action_id`, `block_id`), `channel.id`, `team.id`, `user.id` (the person who
//   answered), `enterprise: null`, `is_enterprise_install: false`, `response_url` (respond()).
// - `action_id`, `block_id` and `value` come from the layer's own file (slack/cards.ts). A card with no entry
//   there (sent by the native API or the MCP, or an entry lost or evicted): `action_id` = the option's id,
//   `block_id` = `approval`, no `value`, and one `slack-card-unknown` line (no id).
// - A card of a chain (a chat.update with buttons posted it in place of another, slack/cards.ts): the click's
//   `container.message_ts` is the chain's origin, the `ts` the app knows; `message` is the card answered.
// - A socket's ack removes the entry; a response payload in the ack is ignored (`ack-payload-ignored`). No
//   ack after the redeliveries: the dispatcher's drop line, and the entry stays.
// - No socket open → nothing is dispatched: the layer is not a consumer of the bus then, so the bus keeps
//   the event for the next consumer (slack/router.ts, api/bus.ts).
// - With `--slack-actions-url`, `dispatchAnswered` is not used: the same payload (`blockActionsOf`) leaves as a
//   signed HTTP POST (slack/http-actions.ts), whatever the sockets, and no socket gets an `interactive` envelope.
import type { ApiEvent, ApiMe, ApiMessage } from '../contract'
import type { ReadFacade } from '../../core/read'
import type { AckOutcome } from './envelopes'
import type { SlackCards } from './cards'
import type { SlackBlockActions, SlackButtonAction, SlackMessage } from './contract'
import type { ResponseTickets } from './response'
import type { TriggerTable } from './triggers'
import { slackMessage, tsOfMs, type MessageView } from './translate'

type Log = (line: Record<string, unknown>) => void
type Answered = Extract<ApiEvent, { type: 'approval.answered' }>

export const UNKNOWN_BLOCK_ID = 'approval'
export const RESPONSE_PATH = '/slack/response/'

export interface InteractiveOptions {
  read: ReadFacade
  log: Log
  cards: SlackCards
  tickets: ResponseTickets
  // The trigger_ids (slack/triggers.ts): each click's opens one form, from the click itself.
  triggers: TriggerTable
  baseUrl: () => string | null
  // The native edge on every native value before it is translated (slack/router.ts ctx.native).
  native<T>(value: T, where: string): T
  broadcast: (type: 'interactive', payload: Record<string, unknown>) => Array<{ id: string; outcome: Promise<AckOutcome> }>
}

const nameOr = (fn: () => string, fallback = ''): string => {
  try {
    return fn()
  } catch {
    return fallback
  }
}

// The payload of one click (pure but for the read and the ticket).
export async function blockActionsOf(e: Answered, me: ApiMe, bot: string, view: MessageView, opts: Omit<InteractiveOptions, 'broadcast'>): Promise<SlackBlockActions> {
  await opts.cards.load()
  let card: ApiMessage | undefined
  try {
    card = opts.native(await opts.read.message(e.conversation, e.id), 'block_actions')
  } catch {
    card = undefined
  }
  const option = card?.approval?.options.find((o) => o.id === e.option)
  const entry = opts.cards.get(e.conversation, e.id)
  const kept = entry?.actions.find((a) => a.option === e.option)
  if (kept === undefined) opts.log({ evt: 'slack-card-unknown' })
  const action: SlackButtonAction = {
    type: 'button',
    action_id: kept?.action_id ?? e.option,
    block_id: kept !== undefined ? (entry as NonNullable<typeof entry>).block_id : UNKNOWN_BLOCK_ID,
    text: { type: 'plain_text', text: option?.label ?? e.option, emoji: true },
    ...(kept?.value !== undefined && { value: kept.value }),
    ...(option?.style !== undefined && { style: option.style }),
    action_ts: tsOfMs(e.at),
  }
  const message: SlackMessage = card !== undefined ? slackMessage(card, view) : { type: 'message', user: me.id, text: '', ts: e.id }
  const name = nameOr(() => opts.read.person(e.by).name)
  const ticket = opts.tickets.issue({ kind: 'card', conversation: e.conversation, id: e.id })
  return {
    type: 'block_actions',
    token: '',
    api_app_id: bot,
    team: { id: me.workspace, domain: '' },
    enterprise: null,
    is_enterprise_install: false,
    user: { id: e.by, username: name, name, team_id: me.workspace },
    channel: { id: e.conversation, name: nameOr(() => opts.read.conversation(e.conversation).name) },
    container: { type: 'message', message_ts: opts.cards.originOf(e.conversation, e.id), channel_id: e.conversation, is_ephemeral: false },
    message,
    state: { values: {} },
    trigger_id: opts.triggers.issue({ kind: 'card', conversation: e.conversation, card: e.id, person: e.by }, e.at),
    response_url: `${opts.baseUrl() ?? ''}${RESPONSE_PATH}${ticket}`,
    actions: [action],
  }
}

// One click to every open socket; the first ack removes the card's entry.
export async function dispatchAnswered(e: Answered, me: ApiMe, bot: string, view: MessageView, opts: InteractiveOptions): Promise<void> {
  const payload = await blockActionsOf(e, me, bot, view, opts)
  const sent = opts.broadcast('interactive', payload as unknown as Record<string, unknown>)
  for (const { outcome } of sent) {
    void outcome.then(async (o) => {
      if (!o.acked) return
      if (o.payload !== undefined) opts.log({ evt: 'ack-payload-ignored' })
      await opts.cards.remove(e.conversation, e.id)
    })
  }
}
