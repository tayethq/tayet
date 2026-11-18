// The contract of the sidecar's Slack layer (ADR-087 dec. 6; PLANO-AGENTES §0.3.12 items 1, 2): every
// type that reaches a Slack client over `/slack/api/<method>` is declared here, in Slack's own shape and
// in product vocabulary. The lint of this file denies the protocol words of the native contract minus
// a closed allowlist (contract-vocabulary.mjs `SLACK_VOCAB_ALLOW`: today only `event_id`, a Slack
// envelope field whose value is opaque), and the Slack edge (slack/edge.ts) scans the keys of every
// real answer against the same list.
//
// Ids are the native opaque tokens (api/ids.ts): `C…`/`D…` conversation, `U…` person, `T…` workspace,
// `F…` file, `B…` the agent's bot id; a message is its `ts` inside its conversation.

// The `error` of an `{ ok: false }` answer. Slack's own codes; the router maps the core's errors here.
export type SlackErrorCode =
  | 'channel_not_found'
  | 'user_not_found'
  | 'message_not_found'
  | 'thread_not_found'
  | 'file_not_found'
  | 'restricted_action'
  | 'cant_update_message'
  | 'cant_delete_message'
  // A3-4: an `actions` block the approval card cannot take (limits, a second block, an update).
  | 'invalid_blocks'
  // `markdown_text` with a non-empty `text` or with `blocks` in the same call.
  | 'markdown_text_conflict'
  // views.open (slack/views.ts): the trigger_id is not of the format, unknown or expired, or already used; the
  // definition passes the size limit.
  | 'invalid_trigger_id'
  | 'expired_trigger_id'
  | 'exchanged_trigger_id'
  | 'view_too_large'
  // A3-4: a response_url whose ticket is unknown, expired or spent.
  | 'expired_url'
  | 'invalid_name'
  | 'already_reacted'
  | 'no_reaction'
  | 'file_too_large'
  | 'invalid_arguments'
  | 'invalid_cursor'
  | 'no_text'
  | 'msg_too_long'
  | 'not_in_channel'
  | 'not_authed'
  | 'invalid_auth'
  | 'token_revoked'
  | 'method_deprecated'
  | 'unknown_method'
  | 'ratelimited'
  | 'service_unavailable'
  | 'internal_error'

export interface SlackMetadata {
  next_cursor?: string
  warnings?: string[]
}

export interface SlackFail {
  ok: false
  error: SlackErrorCode
  response_metadata?: SlackMetadata
}

export interface SlackAuthTest {
  ok: true
  url: string
  team: string
  team_id: string
  user: string
  user_id: string
  bot_id: string
}

export interface SlackText {
  value: string
  creator: string
  last_set: number
}

export interface SlackConversation {
  id: string
  name: string
  is_channel: boolean
  is_group: boolean
  is_im: boolean
  is_mpim: boolean
  is_private: boolean
  is_archived: boolean
  is_member: boolean
  created: number
  // The other person of a direct conversation.
  user?: string
  topic?: SlackText
  purpose?: SlackText
  num_members?: number
}

export interface SlackReaction {
  name: string
  count: number
  // The agent alone, when it reacted: the native API carries a count and `mine`, not the people.
  users: string[]
}

export interface SlackFile {
  id: string
  name: string
  title: string
  mimetype: string
  filetype: string
  size: number
  original_w?: number
  original_h?: number
  // On a read (S-f3): `<listener>/slack/files/<F…>`, absolute; downloaded with the local token as Bearer.
  url_private?: string
  url_private_download?: string
}

export interface SlackEdited {
  user: string
  ts: string
}

export interface SlackMessage {
  type: 'message'
  user: string
  text: string
  ts: string
  thread_ts?: string
  reply_count?: number
  latest_reply?: string
  reactions?: SlackReaction[]
  files?: SlackFile[]
  edited?: SlackEdited
  // `file_share` when the message carries files and no text, as Slack marks an upload.
  subtype?: 'file_share'
}

export interface SlackProfile {
  display_name: string
  real_name: string
}

export interface SlackUser {
  id: string
  team_id: string
  name: string
  real_name: string
  deleted: boolean
  is_bot: boolean
  profile: SlackProfile
}

export interface SlackUploadTicket {
  ok: true
  upload_url: string
  file_id: string
}

export interface SlackConnectionsOpen {
  ok: true
  // `ws://<listener>/slack/socket?ticket=<single-use ticket>` (slack/connections.ts).
  url: string
}

// ── The emulated Socket Mode (slack/socket.ts, S-f2): what goes over the WebSocket ─────────────────

export interface SlackSocketDebug {
  host: string
}

// The first frame of every connection (the SDK reads only `type`; the shape is Slack's).
export interface SlackHello {
  type: 'hello'
  num_connections: number
  debug_info: SlackSocketDebug
  connection_info: { app_id: string }
}

// An envelope (slack/envelopes.ts): `events_api` (S-f2), `interactive` (A3-4, the approval card's click),
// `slash_commands` (A4-3, a person's `/` command).
// The client acks with `{ envelope_id, payload? }`.
export interface SlackEnvelope {
  envelope_id: string
  type: string
  payload: Record<string, unknown>
  accepts_response_payload: boolean
  retry_attempt: number
  retry_reason: '' | 'timeout'
}

// The `event` of an `events_api` envelope (slack/events.ts): Slack's `message` (new, changed, deleted)
// and `app_mention`. `channel_type`: `channel` (public), `group` (private), `im` (direct), `mpim` (the
// product's group conversation, ADR-094 dec. 12 — Slack's `group` is a private channel, not a group).
export type SlackChannelType = 'channel' | 'group' | 'im' | 'mpim'

export interface SlackMessageEvent {
  type: 'message'
  channel: string
  channel_type: SlackChannelType
  user: string
  text: string
  ts: string
  thread_ts?: string
  files?: SlackFile[]
  subtype?: 'file_share'
  // The agent's own messages (its `B…`, with its `U…` as `user`; Bolt drops them by `user`).
  bot_id?: string
  event_ts: string
}

export interface SlackMessageChanged {
  type: 'message'
  subtype: 'message_changed'
  channel: string
  channel_type: SlackChannelType
  message: SlackMessage
  previous_message: { ts: string }
  ts: string
  event_ts: string
}

export interface SlackMessageDeleted {
  type: 'message'
  subtype: 'message_deleted'
  channel: string
  channel_type: SlackChannelType
  deleted_ts: string
  ts: string
  event_ts: string
}

export interface SlackAppMention {
  type: 'app_mention'
  channel: string
  user: string
  text: string
  ts: string
  thread_ts?: string
  event_ts: string
}

export type SlackEvent = SlackMessageEvent | SlackMessageChanged | SlackMessageDeleted | SlackAppMention

export interface SlackAuthorization {
  team_id: string
  user_id: string
  is_bot: true
}

// The `payload` of an `events_api` envelope.
export interface SlackEventCallback {
  token: ''
  team_id: string
  api_app_id: string
  event: SlackEvent
  type: 'event_callback'
  // `Ev` + a hash of the bus entry's id (api/ids.ts): opaque, never a protocol id (the allowlist).
  event_id: string
  event_time: number
  authorizations: SlackAuthorization[]
}

// Sent before the server closes a socket: `refresh_requested` on a clean shutdown (the SDK reopens with
// a new apps.connections.open), `link_disabled` on the revocation.
export interface SlackDisconnect {
  type: 'disconnect'
  reason: 'refresh_requested' | 'link_disabled'
  debug_info: SlackSocketDebug
}

// ── The approval card's click (A3-4; slack/interactive.ts): the `payload` of an `interactive` envelope ──
// What Bolt 5.1.0 reads (PLANO-AGENTES §8.35): `actions` (an action body; `actions[0]` is the payload),
// `channel.id`, `team.id`, `user.id`, `enterprise`, `is_enterprise_install`, `response_url` (respond()).

export interface SlackActionText {
  type: 'plain_text'
  text: string
  emoji: true
}

export interface SlackButtonAction {
  type: 'button'
  // The agent's own `action_id` and `block_id` (kept in <store>/slack-cards.json), or the option's id and
  // `approval` when the card has no entry there.
  action_id: string
  block_id: string
  text: SlackActionText
  value?: string
  style?: 'primary' | 'danger'
  action_ts: string
}

export interface SlackBlockActions {
  type: 'block_actions'
  token: ''
  api_app_id: string
  team: { id: string; domain: '' }
  enterprise: null
  is_enterprise_install: false
  // The person who answered.
  user: { id: string; username: string; name: string; team_id: string }
  channel: { id: string; name: string }
  container: { type: 'message'; message_ts: string; channel_id: string; is_ephemeral: false }
  message: SlackMessage
  state: { values: Record<string, never> }
  // Opaque, minted per click (slack/triggers.ts): views.open opens one form with it, within 30 s.
  trigger_id: string
  // `<listener>/slack/response/<ticket>` (slack/response.ts): 30 min, 5 uses, `replace_original` only.
  response_url: string
  actions: [SlackButtonAction]
}

// ── A person's `/` command (A4-3; slack/commands.ts): the `payload` of a `slash_commands` envelope ──────────────
// The fields of Slack's payload the sidecar can honor (PLANO-AGENTES §0.3.25 item 5), plus `message_ts` and
// `thread_ts`, which Slack does not have. What Bolt 5.1.0 reads: `command` (app.command matches on it),
// `channel_id`, `team_id`, `user_id`, `response_url` (respond()).
export interface SlackSlashCommand {
  // "/name", lowercase.
  command: string
  // The arguments: the plain text after "/name", without the leading whitespace ('' with none).
  text: string
  channel_id: string
  // The conversation's name; `directmessage` in a direct conversation, as Slack names it.
  channel_name: string
  user_id: string
  user_name: string
  team_id: string
  api_app_id: string
  // Opaque, minted per command (slack/triggers.ts): views.open opens one form with it, within 30 s.
  trigger_id: string
  // `<listener>/slack/response/<ticket>` (slack/response.ts): 30 min, 5 uses; every call a reply in the thread.
  response_url: string
  // The command's message.
  message_ts: string
  // The thread the command was sent in; absent at the top of the conversation.
  thread_ts?: string
}
